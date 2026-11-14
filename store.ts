// The forge's whole state: one in-memory store for users, repositories, git objects, issues,
// pull requests, labels and comments. Nothing is persisted; a trial starts from an empty forge.
//
// Determinism is a hard requirement (a replay must reach byte-identical exports), so this module
// never reads the wall clock or a random source: timestamps come from a logical clock seeded at
// the fixture epoch and advanced by one second per mutation, and every id comes from a counter.

import {
  buildCommit,
  buildTree,
  hashObject,
  mergeBase,
  parseCommit,
  parseTree,
  type GitObj,
  type ObjType,
} from './gitcore.ts';

/** The one user the trial token belongs to (wire.ts's seeded scenario viewer). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

/** The identity forge-created commits (contents API, merges) are authored with. */
export const FORGE_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

/** 2025-01-01T00:00:00Z: the fixture epoch the suite's own git fixture commits at. */
const CLOCK_SEED_SEC = 1_735_689_600;

export interface CommentRec {
  id: number;
  body: string;
  createdSec: number;
}

export interface IssueRec {
  number: number;
  gid: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSec: number;
  updatedSec: number;
  closedSec: number | null;
  version: number;
}

export interface PullRec {
  number: number;
  gid: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  mergeCommitSha: string | null;
  createdSec: number;
  updatedSec: number;
  closedSec: number | null;
  mergedSec: number | null;
  comments: CommentRec[];
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface RepoRec {
  dbId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  nextIssueNumber: number;
  pulls: Map<number, PullRec>;
  nextPullNumber: number;
  createdSec: number;
  updatedSec: number;
}

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  private clockSec = CLOCK_SEED_SEC;
  private nextRepoDbId = 5000;
  private nextIssueGid = 100_000;
  private nextPullGid = 200_000;
  private nextCommentId = 300_000;
  private nextLabelId = 400_000;

  /** Advance the logical clock and answer the new reading, in epoch seconds. */
  tick(): number {
    this.clockSec += 1;
    return this.clockSec;
  }

  nowSec(): number {
    return this.clockSec;
  }

  iso(sec: number): string {
    return new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
  }

  allocRepoDbId(): number {
    const id = this.nextRepoDbId;
    this.nextRepoDbId += 1;
    return id;
  }

  allocIssueGid(): number {
    const id = this.nextIssueGid;
    this.nextIssueGid += 1;
    return id;
  }

  allocPullGid(): number {
    const id = this.nextPullGid;
    this.nextPullGid += 1;
    return id;
  }

  allocCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  allocLabelId(): number {
    const id = this.nextLabelId;
    this.nextLabelId += 1;
    return id;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
    const sec = this.tick();
    const repo: RepoRec = {
      dbId: this.allocRepoDbId(),
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextIssueNumber: 1,
      pulls: new Map(),
      nextPullNumber: 1,
      createdSec: sec,
      updatedSec: sec,
    };
    this.repos.set(repoKey(owner, name), repo);
    return repo;
  }

  /** A repository visible to the token: only the viewer's own repositories exist for callers. */
  repo(owner: string, name: string): RepoRec | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(repoKey(owner, name)) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(repoKey(owner, name));
  }

  viewerRepos(): RepoRec[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === VIEWER.login)
      .sort((a, b) => a.dbId - b.dbId);
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

// ------------------------------------------------------------------ global (Relay) ids

/** An opaque global id for a forge object: base64 of `Type:key`, never the plain numeric id. */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

/** Decode a global id back into its type and key; null when the value is not one of ours. */
export function parseGlobalId(id: string): { type: string; key: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  return { type: text.slice(0, colon), key: text.slice(colon + 1) };
}

// ------------------------------------------------------------------ object store helpers

export function putObject(repo: RepoRec, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function refTip(repo: RepoRec, ref: string): string | null {
  return repo.refs.get(ref) ?? null;
}

export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Resolve a user-supplied ref-ish (full ref, branch name, tag name, or commit oid) to a commit oid. */
export function resolveToCommit(repo: RepoRec, value: string): string | null {
  const candidates: string[] = [];
  if (value.startsWith('refs/')) candidates.push(value);
  candidates.push(`refs/heads/${value}`, `refs/tags/${value}`);
  for (const ref of candidates) {
    const tip = repo.refs.get(ref);
    if (tip !== undefined) {
      const object = repo.objects.get(tip);
      if (object !== undefined) {
        if (object.type === 'commit') return tip;
        if (object.type === 'tag') {
          // One tag hop is all the suite builds; peel fully anyway.
          let current = tip;
          for (let hops = 0; hops < 16; hops += 1) {
            const currentObject = repo.objects.get(current);
            if (currentObject === undefined) return null;
            if (currentObject.type === 'commit') return current;
            if (currentObject.type !== 'tag') return null;
            const header = currentObject.data.toString('utf8');
            const match = /^object ([0-9a-f]{40})$/m.exec(header);
            if (match === null) return null;
            current = match[1]!;
          }
          return null;
        }
      }
    }
  }
  const direct = repo.objects.get(value);
  if (direct !== undefined && direct.type === 'commit') return value;
  return null;
}

/** A commit's tree oid, or null. */
export function commitTreeOid(repo: RepoRec, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

// ------------------------------------------------------------------ flattened trees

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** A commit's (or tree's) whole file set as path -> {blob oid, mode}. Empty map for a null tree. */
export function flattenTree(repo: RepoRec, treeOid: string | null): Map<string, FlatEntry> {
  const flat = new Map<string, FlatEntry>();
  if (treeOid === null) return flat;
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else flat.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return flat;
}

/** Write a flattened file set back into the store as nested trees; answers the root tree oid. */
export function buildTreeFromFlat(repo: RepoRec, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      if (!node.dirs.has(name)) node.dirs.set(name, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

// ------------------------------------------------------------------ file commits (contents API)

/**
 * Commit one file change (create/update when `content` is a Buffer, delete when null) on a branch,
 * creating the branch from the default branch's tip when it does not exist yet and the repository
 * already has one. Answers the new commit oid and the file's blob oid (null for a delete).
 */
export function commitFileChange(
  forge: Forge,
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitOid: string; blobOid: string | null } {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref) ?? null;
  if (tip === null && branch !== repo.defaultBranch) {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const tipTree = tip === null ? null : commitTreeOid(repo, tip);
  const flat = flattenTree(repo, tipTree);
  let blobOid: string | null = null;
  if (content === null) {
    flat.delete(path);
  } else {
    blobOid = putObject(repo, 'blob', content);
    const existing = flat.get(path);
    flat.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  }
  const treeOid = buildTreeFromFlat(repo, flat);
  const commitData = buildCommit({
    tree: treeOid,
    parents: tip === null ? [] : [tip],
    message,
    author: FORGE_IDENTITY,
    committer: FORGE_IDENTITY,
    timestamp: forge.tick(),
  });
  const commitOid = putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitOid);
  repo.updatedSec = forge.nowSec();
  return { commitOid, blobOid };
}

// ------------------------------------------------------------------ merges

export interface MergeOutcome {
  ok: boolean;
  /** The merged flat file set, when ok. */
  flat?: Map<string, FlatEntry>;
  /** The merge-base commit the comparison ran against (null for unrelated histories). */
  base?: string | null;
}

/** A per-path three-way merge of head into base, from their merge-base. */
export function threeWayMerge(repo: RepoRec, baseTip: string, headTip: string): MergeOutcome {
  const base = mergeBase(repo.objects, baseTip, headTip);
  const baseFlat = base === null ? new Map<string, FlatEntry>() : flattenTree(repo, commitTreeOid(repo, base));
  const baseSideFlat = flattenTree(repo, commitTreeOid(repo, baseTip));
  const headFlat = flattenTree(repo, commitTreeOid(repo, headTip));
  const merged = new Map<string, FlatEntry>();
  const paths = new Set<string>([...baseFlat.keys(), ...baseSideFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const atBase = baseFlat.get(path);
    const atBaseSide = baseSideFlat.get(path);
    const atHead = headFlat.get(path);
    const same = (x?: FlatEntry, y?: FlatEntry): boolean => x?.oid === y?.oid && x?.mode === y?.mode;
    if (same(atHead, atBase)) {
      // The head side did not change the path: the base side's version stands.
      if (atBaseSide !== undefined) merged.set(path, atBaseSide);
    } else if (same(atBaseSide, atBase)) {
      // The base side did not change the path: take the head side's version.
      if (atHead !== undefined) merged.set(path, atHead);
    } else if (same(atHead, atBaseSide)) {
      if (atHead !== undefined) merged.set(path, atHead);
    } else {
      return { ok: false, base };
    }
  }
  return { ok: true, flat: merged, base };
}

/** Whether a merge of head into base would conflict (or is a no-op GitHub refuses). */
export function mergeWouldConflict(repo: RepoRec, baseTip: string, headTip: string): boolean {
  const base = mergeBase(repo.objects, baseTip, headTip);
  if (base === null) return true;
  if (base === headTip) return true; // nothing to merge: the head is already contained
  return !threeWayMerge(repo, baseTip, headTip).ok;
}

/**
 * Perform a merge of `headRef` into `baseRef` with the requested method, moving the base ref.
 * Answers the resulting tip commit oid (the merge/squash commit, or the rebased head tip),
 * or null when the merge conflicts or there is nothing to merge.
 */
export function performMerge(
  forge: Forge,
  repo: RepoRec,
  baseRef: string,
  headRef: string,
  method: 'merge' | 'squash' | 'rebase',
  message: string,
): string | null {
  const baseTip = branchTip(repo, baseRef);
  const headTip = branchTip(repo, headRef);
  if (baseTip === null || headTip === null) return null;
  const base = mergeBase(repo.objects, baseTip, headTip);
  if (base === null || base === headTip) return null;
  const outcome = threeWayMerge(repo, baseTip, headTip);
  if (!outcome.ok || outcome.flat === undefined) return null;
  const treeOid = buildTreeFromFlat(repo, outcome.flat);
  const baseBranchRef = `refs/heads/${baseRef}`;
  if (method === 'squash') {
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      timestamp: forge.tick(),
    });
    const commitOid = putObject(repo, 'commit', commitData);
    repo.refs.set(baseBranchRef, commitOid);
    return commitOid;
  }
  if (method === 'merge') {
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip, headTip],
      message,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      timestamp: forge.tick(),
    });
    const commitOid = putObject(repo, 'commit', commitData);
    repo.refs.set(baseBranchRef, commitOid);
    return commitOid;
  }
  // rebase: replay the head side's own commits (oldest first) onto the base tip.
  const headAncestors = new Map<string, number>();
  {
    let frontier: string[] = [headTip];
    let distance = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (headAncestors.has(oid)) continue;
        const object = repo.objects.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        headAncestors.set(oid, distance);
        for (const parent of parseCommit(object.data).parents) next.push(parent);
      }
      frontier = next;
      distance += 1;
    }
  }
  const replay = [...headAncestors.entries()]
    .filter(([oid]) => {
      // Commits unique to the head side: not ancestors of the merge-base.
      if (oid === base) return false;
      return !isReachableFrom(repo, base, oid);
    })
    .sort((a, b) => b[1] - a[1])
    .map(([oid]) => oid);
  let newTip = baseTip;
  for (const oldOid of replay) {
    const oldObject = repo.objects.get(oldOid);
    if (oldObject === undefined || oldObject.type !== 'commit') return null;
    const info = parseCommit(oldObject.data);
    newTip = buildRebasedCommit(repo, info, newTip, forge.tick());
  }
  repo.refs.set(baseBranchRef, newTip);
  return newTip;
}

function buildRebasedCommit(
  repo: RepoRec,
  info: { tree: string; message: string; author: string },
  parent: string,
  timestamp: number,
): string {
  const authorName = info.author.replace(/ \d+ [+-]\d{4}$/, '');
  const lines = [`tree ${info.tree}`, `parent ${parent}`, `author ${authorName} ${timestamp} +0000`, `committer ${FORGE_IDENTITY} ${timestamp} +0000`];
  const message = info.message.endsWith('\n') ? info.message : `${info.message}\n`;
  return putObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8'));
}

function isReachableFrom(repo: RepoRec, from: string, target: string): boolean {
  const stack: string[] = [from];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === target) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

// ------------------------------------------------------------------ line diffs (PR files)

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  sha: string | null;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < data.length; index += 1) if (data[index] === 0x0a) lines += 1;
  return data[data.length - 1] === 0x0a ? lines : lines + 1;
}

/** Line-level addition/deletion counts between two blob versions (LCS, with a size guard). */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData === null) return { additions: newData === null ? 0 : countLines(newData), deletions: 0 };
  if (newData === null) return { additions: 0, deletions: countLines(oldData) };
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  if (oldLines.length > 4000 || newLines.length > 4000) {
    return { additions: countLines(newData), deletions: countLines(oldData) };
  }
  const m = oldLines.length;
  const n = newLines.length;
  const dp: Uint32Array = new Uint32Array((m + 1) * (n + 1));
  const at = (i: number, j: number): number => dp[i * (n + 1) + j]!;
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const common = at(0, 0);
  return { additions: n - common, deletions: m - common };
}

/** The changed files between two commits (merge-base semantics are the caller's job). */
export function diffCommits(repo: RepoRec, fromCommit: string | null, toCommit: string): FileDiff[] {
  const fromFlat = fromCommit === null ? new Map<string, FlatEntry>() : flattenTree(repo, commitTreeOid(repo, fromCommit));
  const toFlat = flattenTree(repo, commitTreeOid(repo, toCommit));
  const diffs: FileDiff[] = [];
  const paths = [...new Set([...fromFlat.keys(), ...toFlat.keys()])].sort();
  for (const path of paths) {
    const before = fromFlat.get(path);
    const after = toFlat.get(path);
    if (before?.oid === after?.oid) continue;
    const oldData = before === undefined ? null : (repo.objects.get(before.oid)?.data ?? null);
    const newData = after === undefined ? null : (repo.objects.get(after.oid)?.data ?? null);
    const counts = lineDiff(oldData, newData);
    diffs.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      sha: after?.oid ?? null,
    });
  }
  return diffs;
}

/** The files a pull request changes: merge-base of head/base, compared to the head tip. */
export function pullRequestDiffs(repo: RepoRec, pull: PullRec): FileDiff[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null) return [];
  const base = baseTip === null ? null : mergeBase(repo.objects, baseTip, headTip);
  return diffCommits(repo, base, headTip);
}
