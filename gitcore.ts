// The git object model, implemented from the format itself on Node's standard library only:
// SHA-1 object ids (node:crypto), zlib streams for pack entries (node:zlib), tree/commit/tag
// codecs, pack v2 read (with OFS/REF delta resolution) and pack v2 write (plain objects).
// No git binary is ever spawned: this module is the whole storage engine's bottom layer.

import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_TO_NUM: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TO_TYPE: Readonly<Record<number, ObjType | undefined>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The object id of a typed payload: SHA-1 of `"<type> <size>\0" || data`. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree order: entries sort by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  /** Committer timestamp, seconds (0 when the header does not carry one). */
  time: number;
  message: string;
}

function parseIdentTime(line: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(line);
  return match ? Number(match[1]) : 0;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, time: parseIdentTime(committer), message };
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${input.timestamp} +0000`);
  lines.push(`committer ${input.committer} ${input.timestamp} +0000`);
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Follow tag objects until a non-tag object; returns the final oid and its type. */
export function peel(objects: ReadonlyMap<string, GitObj>, oid: string): { oid: string; type: ObjType } | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = objects.get(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return { oid: current, type: object.type };
    current = parseTag(object.data).object;
  }
  return null;
}

/** The commit a ref ultimately names (through any tag chain), or null. */
export function peelToCommit(objects: ReadonlyMap<string, GitObj>, oid: string): string | null {
  const peeled = peel(objects, oid);
  return peeled !== null && peeled.type === 'commit' ? peeled.oid : null;
}

// ------------------------------------------------------------------ pack write

function packEntryHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_TO_NUM[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack of plain (never delta) objects, with its SHA-1 trailer. */
export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(zlib.deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ------------------------------------------------------------------ pack read

/** Inflate the zlib stream starting at `offset`; reports how many input bytes it consumed. */
function inflateAt(buffer: Buffer, offset: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const stream = zlib.createInflate();
    const chunks: Buffer[] = [];
    let settled = false;
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    stream.on('end', () => {
      if (!settled) {
        settled = true;
        // The zlib engine stops consuming at its stream's end: bytesWritten is the exact
        // number of input bytes this entry used, which is where the next entry begins.
        const consumed = (stream as unknown as { bytesWritten?: number }).bytesWritten ?? 0;
        resolve({ data: Buffer.concat(chunks), consumed });
      }
    });
    stream.end(buffer.subarray(offset));
  });
}

/** Git's delta application: copy/insert opcodes against the base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      if (byte === undefined) throw new Error('delta is truncated');
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op === undefined) break;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          copyOffset |= (delta[offset] ?? 0) << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          copySize |= (delta[offset] ?? 0) << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  offset: number;
  type: ObjType | 'ofs-delta' | 'ref-delta';
  data?: Buffer;
  baseOffset?: number;
  baseOid?: string;
  oid?: string;
}

/**
 * Read a whole pack into an oid -> object map. `external` resolves REF-delta bases the pack does
 * not carry (thin packs). Throws on any structural problem; callers turn that into a protocol error.
 */
export async function readPack(
  buffer: Buffer,
  external?: (oid: string) => GitObj | undefined,
): Promise<Map<string, GitObj>> {
  if (buffer.length < 12 + 20) throw new Error('pack is too short');
  if (buffer.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack header is missing');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = buffer.readUInt32BE(8);
  const trailer = buffer.subarray(buffer.length - 20);
  const digest = createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack trailer checksum mismatch');

  const entries: PackEntry[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = buffer[offset];
    offset += 1;
    if (byte === undefined) throw new Error('pack ends inside an entry header');
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buffer[offset];
      offset += 1;
      if (byte === undefined) throw new Error('pack ends inside an entry header');
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: PackEntry['type'];
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeNum === 6) {
      type = 'ofs-delta';
      let back = buffer[offset];
      offset += 1;
      if (back === undefined) throw new Error('pack ends inside an ofs-delta header');
      let distance = back & 0x7f;
      while ((back & 0x80) !== 0) {
        back = buffer[offset];
        offset += 1;
        if (back === undefined) throw new Error('pack ends inside an ofs-delta header');
        distance = ((distance + 1) << 7) | (back & 0x7f);
      }
      baseOffset = entryOffset - distance;
    } else if (typeNum === 7) {
      type = 'ref-delta';
      baseOid = buffer.toString('hex', offset, offset + 20);
      offset += 20;
    } else {
      const plain = NUM_TO_TYPE[typeNum];
      if (plain === undefined || typeNum >= 6) throw new Error(`pack entry type ${typeNum} is invalid`);
      type = plain;
    }
    const inflated = await inflateAt(buffer, offset);
    offset += inflated.consumed;
    if (type === 'ofs-delta' || type === 'ref-delta') {
      entries.push({ offset: entryOffset, type, data: inflated.data, baseOffset, baseOid });
    } else {
      if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
      entries.push({ offset: entryOffset, type, data: inflated.data });
    }
  }

  const byOffset = new Map<number, GitObj>();
  const byOid = new Map<string, GitObj>();
  const pending = [...entries];
  let guard = pending.length * pending.length + 16;
  while (pending.length > 0) {
    guard -= 1;
    if (guard < 0) throw new Error('pack deltas do not resolve');
    const entry = pending.shift()!;
    let resolved: GitObj | null = null;
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      resolved = { type: entry.type, data: entry.data! };
    } else {
      let base: GitObj | undefined;
      if (entry.type === 'ofs-delta') base = entry.baseOffset !== undefined ? byOffset.get(entry.baseOffset) : undefined;
      else base = entry.baseOid !== undefined ? (byOid.get(entry.baseOid) ?? external?.(entry.baseOid)) : undefined;
      if (base !== undefined) {
        resolved = { type: base.type, data: applyDelta(base.data, entry.data!) };
      }
    }
    if (resolved === null) {
      pending.push(entry);
      continue;
    }
    const oid = hashObject(resolved.type, resolved.data);
    entry.oid = oid;
    byOffset.set(entry.offset, resolved);
    byOid.set(oid, resolved);
  }
  return byOid;
}

// ------------------------------------------------------------------ traversal

/** Every object reachable from `tips` (commits walk parents and trees; tags walk their target). */
export function collectClosure(objects: ReadonlyMap<string, GitObj>, tips: Iterable<string>, stopCommits?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (stopCommits === undefined || !stopCommits.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** All ancestors of a commit (including itself), with BFS distance from the tip. */
export function commitAncestors(objects: ReadonlyMap<string, GitObj>, tip: string): Map<string, number> {
  const distances = new Map<string, number>();
  let frontier: string[] = [tip];
  let distance = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (distances.has(oid)) continue;
      const object = objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      distances.set(oid, distance);
      for (const parent of parseCommit(object.data).parents) next.push(parent);
    }
    frontier = next;
    distance += 1;
  }
  return distances;
}

/** The best common ancestor of two commits, or null when their histories are disjoint. */
export function mergeBase(objects: ReadonlyMap<string, GitObj>, a: string, b: string): string | null {
  const fromA = commitAncestors(objects, a);
  const fromB = commitAncestors(objects, b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, distA] of fromA) {
    const distB = fromB.get(oid);
    if (distB === undefined) continue;
    const score = distA + distB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** Whether `ancestor` is `tip` itself or one of its ancestors. */
export function isAncestor(objects: ReadonlyMap<string, GitObj>, ancestor: string, tip: string): boolean {
  return commitAncestors(objects, tip).has(ancestor);
}
