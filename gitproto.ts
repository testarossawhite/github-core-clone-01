// Git smart HTTP: the /{owner}/{repo}.git routes.
//
//   GET  info/refs?service=git-upload-pack    protocol v2 advertisement when the request carries
//                                             `Git-Protocol: version=2`, the v0 advertisement else
//   GET  info/refs?service=git-receive-pack   the v0 advertisement (receive-pack is v0-only)
//   POST git-upload-pack                      v2 ls-refs / fetch commands, or the v0 fetch dialogue
//   POST git-receive-pack                     v0 command list + pack, answered with report-status
//
// The object store is the repo's own map in store.ts; packs are plain-object pack v2 (never
// delta-compressed), which every conformance reader accepts. Fetch planning implements haves
// exclusion, shallow depth with boundary reporting, deepen and deepen-since/not approximately
// the way git shapes them, because the suite's fetch checks judge exactly those edges.

import {
  collectClosure,
  isAncestor,
  parseCommit,
  parseTree,
  peel,
  readPack,
  writePack,
  ZERO_OID,
  type GitObj,
} from './gitcore.ts';
import type { RepoRec } from './store.ts';
import { errorBody, readBody, sendBuffer, sendJson, type Ctx } from './http.ts';

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V0 = `side-band-64k ofs-delta thin-pack shallow agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

// ------------------------------------------------------------------ pkt-line codec

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Decode pkt-lines in `buffer`; throws on a malformed frame. With `stopAtFlush`, decoding
 * stops after the first flush packet and `rest` is what follows it (a receive-pack body);
 * otherwise every packet is decoded (an upload-pack body is all packets). */
export function decodePackets(buffer: Buffer, stopAtFlush = true): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) return { packets, rest: buffer.subarray(offset) };
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2 || length === 3) {
      // Response-end / error markers: treat as flush for parsing purposes.
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) return { packets, rest: buffer.subarray(offset) };
      continue;
    }
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

function sidebandPackets(data: Buffer, band: number): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32_000;
  if (data.length === 0) return packets;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return packets;
}

// ------------------------------------------------------------------ advertisements

/** Sorted ref names (branches and tags), the order every advertisement and ls-refs uses. */
function sortedRefNames(repo: RepoRec): string[] {
  return [...repo.refs.keys()].sort();
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The v0 first-line capabilities for a service, with the HEAD symref appended. */
function v0Caps(repo: RepoRec, service: string): string {
  const base = service === 'git-receive-pack' ? RECEIVE_CAPS : UPLOAD_CAPS_V0;
  return `${base} symref=HEAD:${headTarget(repo)}`;
}

function v0Advertisement(repo: RepoRec, service: string): Buffer {
  const parts: Buffer[] = [];
  const caps = v0Caps(repo, service);
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return Buffer.concat(parts);
  }
  const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
  parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    parts.push(pktLine(`${oid} ${name}\n`));
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peel(repo.objects, oid);
      if (peeled !== null && peeled.type === 'commit') parts.push(pktLine(`${peeled.oid} ${name}^{}\n`));
    }
  }
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

function sendAdvertisement(ctx: Ctx, repo: RepoRec, service: string): void {
  const wantsV2 = service === 'git-upload-pack' && (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
  const body = Buffer.concat([
    pktLine(`# service=${service}\n`),
    PKT_FLUSH,
    wantsV2 ? v2Advertisement() : v0Advertisement(repo, service),
  ]);
  sendBuffer(ctx.res, 200, body, `application/x-${service}-advertisement`);
}

// ------------------------------------------------------------------ ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsLines(repo: RepoRec, args: LsRefsArgs): Buffer[] {
  const lines: Buffer[] = [];
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  const headWanted = args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headWanted) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (args.symrefs) line += ` symref-target:${target}`;
      lines.push(pktLine(`${line}\n`));
    } else if (args.unborn) {
      let line = 'unborn HEAD';
      if (args.symrefs) line += ` symref-target:${target}`;
      lines.push(pktLine(`${line}\n`));
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peel(repo.objects, oid);
        if (peeled !== null && peeled.type === 'commit') line += ` peeled:${peeled.oid}`;
      }
    }
    lines.push(pktLine(`${line}\n`));
  }
  return lines;
}

// ------------------------------------------------------------------ fetch planning

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

interface FetchPlan {
  send: GitObj[];
  boundary: string[];
  unshallow: string[];
  commonHaves: string[];
}

function planFetch(repo: RepoRec, request: FetchRequest): FetchPlan {
  const objects = repo.objects;
  const shallowSet = new Set(request.shallow);

  // What the client already holds: the closure of its haves, not descending past the shallow
  // boundary it declared (it does not hold those ancestors), plus deepen-not closures.
  const excluded = collectClosure(objects, request.haves, shallowSet);
  for (const notRef of request.deepenNot) {
    const tip = resolveRef(repo, notRef);
    if (tip !== null) for (const oid of collectClosure(objects, [tip])) excluded.add(oid);
  }

  // Breadth-first walk over commits from the wants, honouring the depth budget.
  const depthOf = new Map<string, number>();
  const extraObjects = new Set<string>(); // tag objects naming a want, and their chains
  let frontier: { oid: string; depth: number }[] = [];
  for (const want of request.wants) {
    const object = objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      let current = want;
      for (let hops = 0; hops < 16; hops += 1) {
        const currentObject = objects.get(current);
        if (currentObject === undefined) break;
        extraObjects.add(current);
        if (currentObject.type !== 'tag') break;
        const match = /^object ([0-9a-f]{40})$/m.exec(currentObject.data.toString('utf8'));
        if (match === null) break;
        current = match[1]!;
      }
      const peeled = peel(objects, want);
      if (peeled !== null && peeled.type === 'commit') frontier.push({ oid: peeled.oid, depth: 1 });
    } else if (object.type === 'commit') {
      frontier.push({ oid: want, depth: 1 });
    }
  }
  const boundary = new Set<string>();
  const includedCommits = new Set<string>();
  while (frontier.length > 0) {
    const next: { oid: string; depth: number }[] = [];
    for (const { oid, depth } of frontier) {
      const known = depthOf.get(oid);
      if (known !== undefined && known <= depth) continue;
      depthOf.set(oid, depth);
      const object = objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      includedCommits.add(oid);
      const commit = parseCommit(object.data);
      const cutByDepth = request.depth !== null && depth >= request.depth;
      const cutByTime = request.deepenSince !== null && commit.time < request.deepenSince;
      if (cutByDepth || cutByTime) {
        if (commit.parents.length > 0) boundary.add(oid);
        continue;
      }
      if (request.depth === null && request.deepenSince === null && shallowSet.has(oid)) {
        // No deepen asked: the client's declared boundary stays the boundary.
        boundary.add(oid);
        continue;
      }
      for (const parent of commit.parents) next.push({ oid: parent, depth: depth + 1 });
    }
    frontier = next;
  }

  // The unshallow set: declared boundary commits that are now interior (or fully included).
  const unshallow: string[] = [];
  for (const oid of shallowSet) {
    if (includedCommits.has(oid) && !boundary.has(oid)) unshallow.push(oid);
  }

  // Pack contents: each included commit with its own tree closure (trees and blobs only —
  // ancestor commits enter through the BFS above, or not at all when the budget cuts them),
  // plus want tag objects, minus everything the client already holds.
  const sendOids = new Set<string>();
  for (const oid of extraObjects) if (!excluded.has(oid)) sendOids.add(oid);
  for (const oid of includedCommits) {
    if (excluded.has(oid)) continue;
    sendOids.add(oid);
    const tree = parseCommit(objects.get(oid)!.data).tree;
    const stack: string[] = [tree];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (sendOids.has(current) || excluded.has(current)) continue;
      const object = objects.get(current);
      if (object === undefined) continue;
      sendOids.add(current);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
  }
  const rank = (object: GitObj): number => (object.type === 'commit' ? 0 : object.type === 'tree' ? 1 : object.type === 'blob' ? 2 : 3);
  const send = [...sendOids]
    .map((oid) => ({ oid, object: objects.get(oid)! }))
    .filter((entry) => entry.object !== undefined)
    .sort((a, b) => rank(a.object) - rank(b.object) || (a.oid < b.oid ? -1 : 1))
    .map((entry) => entry.object);

  const commonHaves = request.haves.filter((oid) => objects.has(oid));
  return { send, boundary: [...boundary].sort(), unshallow: unshallow.sort(), commonHaves };
}

function resolveRef(repo: RepoRec, value: string): string | null {
  if (repo.refs.has(value)) return repo.refs.get(value)!;
  const branch = repo.refs.get(`refs/heads/${value}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${value}`);
  return tag ?? null;
}

// ------------------------------------------------------------------ upload-pack

function fetchResponseV2(repo: RepoRec, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (request.done) {
    if (plan.commonHaves.length > 0) {
      for (const oid of plan.commonHaves) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
  } else {
    if (plan.commonHaves.length > 0) {
      for (const oid of plan.commonHaves) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  parts.push(PKT_DELIM);
  if (plan.boundary.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack(plan.send);
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: RepoRec, request: FetchRequest, sideband: boolean): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (plan.commonHaves.length > 0) parts.push(pktLine(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const oid of plan.boundary) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = writePack(plan.send);
  if (sideband) {
    for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
    parts.push(PKT_FLUSH);
  } else {
    parts.push(PKT_FLUSH);
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

/** Split a v2 command body into capability lines and argument lines at the delim packet. */
function splitV2Sections(packets: Packet[]): { capabilities: string[]; args: string[] } {
  const capabilities: string[] = [];
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) capabilities.push(line);
    else args.push(line);
  }
  return { capabilities, args };
}

async function handleUploadPack(ctx: Ctx, repo: RepoRec): Promise<void> {
  const body = await readBody(ctx.req);
  let decoded: { packets: Packet[]; rest: Buffer };
  try {
    decoded = decodePackets(body, false);
  } catch {
    sendJson(ctx.res, 400, errorBody('Bad Request'));
    return;
  }
  const wantsV2 = (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
  if (wantsV2) {
    const { capabilities, args } = splitV2Sections(decoded.packets);
    const command = (capabilities[0] ?? '').replace(/^command=/, '');
    if (command === 'ls-refs') {
      const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const arg of args) {
        if (arg === 'peel') lsArgs.peel = true;
        else if (arg === 'symrefs') lsArgs.symrefs = true;
        else if (arg === 'unborn') lsArgs.unborn = true;
        else if (arg.startsWith('ref-prefix ')) lsArgs.prefixes.push(arg.slice('ref-prefix '.length));
      }
      const lines = lsRefsLines(repo, lsArgs);
      sendBuffer(ctx.res, 200, Buffer.concat([...lines, PKT_FLUSH]), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
      for (const arg of args) {
        if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) request.depth = Number(arg.slice(7).trim());
        else if (arg.startsWith('deepen-since ')) request.deepenSince = Number(arg.slice(13).trim());
        else if (arg.startsWith('deepen-not ')) request.deepenNot.push(arg.slice(11).trim());
        else if (arg === 'done') request.done = true;
      }
      sendBuffer(ctx.res, 200, fetchResponseV2(repo, request), 'application/x-git-upload-pack-result');
      return;
    }
    sendJson(ctx.res, 400, errorBody('Bad Request'));
    return;
  }

  // v0: section one is wants and deepen lines, section two is haves and done.
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  let sideband = false;
  let section = 1;
  for (const packet of decoded.packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 1) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        const oid = space < 0 ? rest : rest.slice(0, space);
        request.wants.push(oid.trim());
        if (space >= 0 && rest.slice(space + 1).includes('side-band-64k')) sideband = true;
      } else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
      else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13).trim());
      else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
    } else {
      if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line === 'done') request.done = true;
    }
  }
  sendBuffer(ctx.res, 200, fetchResponseV0(repo, request, sideband), 'application/x-git-upload-pack-result');
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceivePack(ctx: Ctx, repo: RepoRec): Promise<void> {
  const body = await readBody(ctx.req);
  let decoded: { packets: Packet[]; rest: Buffer };
  try {
    decoded = decodePackets(body);
  } catch {
    sendJson(ctx.res, 400, errorBody('Bad Request'));
    return;
  }
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      for (const cap of line.slice(nul + 1).replace(/\n$/, '').split(' ')) if (cap !== '') capabilities.add(cap);
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }

  const reportStatus = capabilities.has('report-status') || capabilities.has('report-status-v2');
  const sideband = capabilities.has('side-band-64k');
  const reportLines: string[] = [];

  // Unpack first (git's order): the objects land in the store even when a ref update is refused.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const pack = decoded.rest;
  if (pack.length > 0) {
    try {
      const objects = await readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}`);

  for (const command of commands) {
    const reason = unpackOk ? applyPushCommand(repo, command) : 'unpack failed';
    reportLines.push(reason === null ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
  }

  let responseBody: Buffer;
  if (reportStatus) {
    const inner = reportLines.map((line) => pktLine(`${line}\n`));
    if (sideband) {
      const wrapped = inner.map((packet) => pktLine(Buffer.concat([Buffer.from([1]), packet])));
      responseBody = Buffer.concat([...wrapped, PKT_FLUSH]);
    } else {
      responseBody = Buffer.concat([...inner, PKT_FLUSH]);
    }
  } else {
    responseBody = Buffer.alloc(0);
  }
  sendBuffer(ctx.res, 200, responseBody, 'application/x-git-receive-pack-result');
}

/** Apply one ref update; returns the refusal reason, or null when the update went through. */
function applyPushCommand(repo: RepoRec, command: PushCommand): string | null {
  if (!command.ref.startsWith('refs/')) return 'funny refname';
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.oldOid !== current) return 'stale info';
  if (command.newOid === ZERO_OID) {
    repo.refs.delete(command.ref);
    return null;
  }
  const object = repo.objects.get(command.newOid);
  if (object === undefined) return 'not a valid object';
  if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') return 'not a commit';
  if (command.oldOid !== ZERO_OID && command.oldOid !== command.newOid) {
    if (object.type === 'commit') {
      const currentObject = repo.objects.get(command.oldOid);
      if (currentObject !== undefined && currentObject.type === 'commit') {
        if (!isAncestor(repo.objects, command.oldOid, command.newOid)) return 'non-fast-forward';
      }
    } else if (command.ref.startsWith('refs/tags/')) {
      return 'already exists';
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}

// ------------------------------------------------------------------ routing

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Handle a git smart-HTTP route; returns false when the path is not one. */
export async function handleGit(ctx: Ctx): Promise<boolean> {
  const match = GIT_ROUTE.exec(ctx.path);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1]!);
  const name = decodeURIComponent(match[2]!);
  const route = match[3]!;
  const repo = ctx.forge.repo(owner, name);
  if (repo === null) {
    sendJson(ctx.res, 404, errorBody('Not Found'));
    return true;
  }
  if (route === 'info/refs') {
    if (ctx.method !== 'GET') {
      sendJson(ctx.res, 405, errorBody('Method Not Allowed'));
      return true;
    }
    const service = ctx.query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(ctx.res, 400, errorBody('Bad Request'));
      return true;
    }
    sendAdvertisement(ctx, repo, service);
    return true;
  }
  if (ctx.method !== 'POST') {
    sendJson(ctx.res, 405, errorBody('Method Not Allowed'));
    return true;
  }
  if (route === 'git-upload-pack') {
    await handleUploadPack(ctx, repo);
    return true;
  }
  await handleReceivePack(ctx, repo);
  return true;
}
