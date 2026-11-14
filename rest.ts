// The REST v3 surface under /api/v3: repositories, contents, branches and commits, labels,
// issues and comments, pull requests and merges — the exact routes and statuses the suite's
// contract names (see the kit's checks-rest.ts header). Shapes are GitHub's: error bodies are
// always {message}, creates answer 201, a stale contents sha is 409, an unknown label is 422,
// a conflicted merge is 405, and repositories are visible only to the login that owns them
// (another owner is a 404, never a 403; no token at all is a 401).

import { commitAncestors, mergeBase, parseCommit, parseTree, type GitObj } from './gitcore.ts';
import {
  VIEWER,
  branchTip,
  commitFileChange,
  commitTreeOid,
  diffCommits,
  flattenTree,
  globalId,
  mergeWouldConflict,
  performMerge,
  putObject,
  resolveToCommit,
  type CommentRec,
  type Forge,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { HttpError, errorBody, notFound, parseJsonBody, readBody, sendEmpty, sendJson, type Ctx } from './http.ts';

// ------------------------------------------------------------------ JSON shapes

export function userJson() {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', String(VIEWER.id)),
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    site_admin: false,
    avatar_url: '',
    url: '/api/v3/user',
    html_url: '',
  };
}

export function repoJson(forge: Forge, repo: RepoRec) {
  return {
    id: repo.dbId,
    node_id: globalId('Repository', String(repo.dbId)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: forge.iso(repo.createdSec),
    updated_at: forge.iso(repo.updatedSec),
    pushed_at: forge.iso(repo.updatedSec),
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: '',
    git_url: '',
    ssh_url: '',
    clone_url: '',
  };
}

export function labelJson(label: LabelRec) {
  return {
    id: label.id,
    node_id: globalId('Label', String(label.id)),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

export function commentJson(forge: Forge, comment: CommentRec) {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', String(comment.id)),
    body: comment.body,
    user: userJson(),
    created_at: forge.iso(comment.createdSec),
    updated_at: forge.iso(comment.createdSec),
    url: '',
    html_url: '',
  };
}

export function issueJson(forge: Forge, repo: RepoRec, issue: IssueRec) {
  return {
    id: issue.gid,
    node_id: globalId('Issue', `${repo.dbId}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label) => label !== undefined)
      .map((label) => labelJson(label!)),
    user: userJson(),
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    locked: false,
    created_at: forge.iso(issue.createdSec),
    updated_at: forge.iso(issue.updatedSec),
    closed_at: issue.closedSec === null ? null : forge.iso(issue.closedSec),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: '',
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec) {
  const headSha = branchTip(repo, pull.headRef) ?? pull.mergeCommitSha;
  const baseSha = branchTip(repo, pull.baseRef);
  const side = (ref: string, sha: string | null) => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(forge, repo),
  });
  return {
    id: pull.gid,
    node_id: globalId('PullRequest', `${repo.dbId}:${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    labels: [],
    draft: false,
    head: side(pull.headRef, headSha),
    base: side(pull.baseRef, baseSha),
    merged: pull.merged,
    mergeable: null as boolean | null,
    merged_at: pull.mergedSec === null ? null : forge.iso(pull.mergedSec),
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: pull.closedSec === null ? null : forge.iso(pull.closedSec),
    created_at: forge.iso(pull.createdSec),
    updated_at: forge.iso(pull.updatedSec),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: '',
  };
}

/** pullJson with the mergeability computed (the single-PR reads carry it; lists stay cheap). */
export function pullJsonMerged(forge: Forge, repo: RepoRec, pull: PullRec) {
  const json = pullJson(forge, repo, pull);
  if (pull.state === 'open') {
    const headTip = branchTip(repo, pull.headRef);
    const baseTip = branchTip(repo, pull.baseRef);
    json.mergeable = headTip !== null && baseTip !== null ? !mergeWouldConflict(repo, baseTip, headTip) : null;
  }
  return json;
}

// ------------------------------------------------------------------ small helpers

function requireAuth(ctx: Ctx): void {
  if (!ctx.authed) throw new HttpError(401, 'Requires authentication');
}

function requireRepo(ctx: Ctx, owner: string, name: string): RepoRec {
  const repo = ctx.forge.repo(owner, name);
  if (repo === null) throw notFound();
  return repo;
}

interface Page {
  items: unknown[];
  link: string | null;
}

/** Apply page/per_page to a list and build the Link header value for the next page, if any. */
function paginate(ctx: Ctx, all: readonly unknown[]): Page {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < all.length) {
    const params = new URLSearchParams(ctx.query);
    params.set('page', String(page + 1));
    params.set('per_page', String(perPage));
    link = `<http://${ctx.host}${ctx.path}?${params.toString()}>; rel="next"`;
  }
  return { items, link };
}

function sendList(ctx: Ctx, all: readonly unknown[]): void {
  const page = paginate(ctx, all);
  sendJson(ctx.res, 200, page.items, page.link === null ? {} : { link: page.link });
}

function bodyString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' ? value : null;
}

// ------------------------------------------------------------------ repositories

async function createRepoRoute(ctx: Ctx): Promise<void> {
  requireAuth(ctx);
  const body = parseJsonBody(await readBody(ctx.req));
  const name = bodyString(body, 'name');
  if (name === null || name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new HttpError(422, 'Repository creation failed: the name is invalid');
  }
  if (ctx.forge.repo(VIEWER.login, name) !== null) {
    throw new HttpError(422, 'name already exists on this account');
  }
  const description = bodyString(body, 'description') ?? '';
  const isPrivate = body.private === true;
  const repo = ctx.forge.createRepo(VIEWER.login, name, description, isPrivate);
  sendJson(ctx.res, 201, repoJson(ctx.forge, repo));
}

function listViewerRepos(ctx: Ctx): void {
  requireAuth(ctx);
  sendList(ctx, ctx.forge.viewerRepos().map((repo) => repoJson(ctx.forge, repo)));
}

async function patchRepoRoute(ctx: Ctx, repo: RepoRec): Promise<void> {
  const body = parseJsonBody(await readBody(ctx.req));
  const description = bodyString(body, 'description');
  if (description !== null) repo.description = description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  const defaultBranch = bodyString(body, 'default_branch');
  if (defaultBranch !== null && defaultBranch !== '') repo.defaultBranch = defaultBranch;
  const name = bodyString(body, 'name');
  if (name !== null && name !== '' && name !== repo.name && /^[A-Za-z0-9._-]+$/.test(name)) {
    ctx.forge.repos.delete(`${repo.owner}/${repo.name}`);
    repo.name = name;
    ctx.forge.repos.set(`${repo.owner}/${repo.name}`, repo);
  }
  repo.updatedSec = ctx.forge.tick();
  sendJson(ctx.res, 200, repoJson(ctx.forge, repo));
}

// ------------------------------------------------------------------ git refs and branches

async function createRefRoute(ctx: Ctx, repo: RepoRec): Promise<void> {
  const body = parseJsonBody(await readBody(ctx.req));
  const ref = bodyString(body, 'ref');
  const sha = bodyString(body, 'sha');
  if (ref === null || !ref.startsWith('refs/') || sha === null) {
    throw new HttpError(422, 'Invalid ref or sha');
  }
  const object: GitObj | undefined = repo.objects.get(sha);
  if (object === undefined) throw new HttpError(422, 'Object does not exist');
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') throw new HttpError(422, 'Object is not a commit');
  if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  sendJson(ctx.res, 201, { ref, node_id: globalId('Ref', `${repo.dbId}:${ref}`), object: { type: object.type, sha } });
}

function getRefRoute(ctx: Ctx, repo: RepoRec, remainder: string): void {
  const ref = remainder.startsWith('refs/') ? remainder : `refs/${remainder}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) throw notFound();
  const object = repo.objects.get(sha);
  sendJson(ctx.res, 200, { ref, node_id: globalId('Ref', `${repo.dbId}:${ref}`), object: { type: object?.type ?? 'commit', sha } });
}

function listBranches(ctx: Ctx, repo: RepoRec): void {
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  sendJson(ctx.res, 200, branches);
}

function getBranch(ctx: Ctx, repo: RepoRec, branch: string): void {
  const sha = branchTip(repo, branch);
  if (sha === null) throw notFound();
  sendJson(ctx.res, 200, { name: branch, commit: { sha }, protected: false });
}

// ------------------------------------------------------------------ commits

function identJson(line: string, forge: Forge, time: number) {
  const match = /^(.*?) <(.*?)>$/.exec(line.replace(/ \d+ [+-]\d{4}$/, ''));
  return {
    name: match?.[1] ?? '',
    email: match?.[2] ?? '',
    date: forge.iso(time),
  };
}

function listCommits(ctx: Ctx, repo: RepoRec): void {
  const shaParam = ctx.query.get('sha');
  const start = shaParam !== null && shaParam !== '' ? resolveToCommit(repo, shaParam) : branchTip(repo, repo.defaultBranch);
  if (start === null) throw new HttpError(409, 'Git Repository is empty.');
  const distances = commitAncestors(repo.objects, start);
  const entries = [...distances.entries()].map(([oid, distance]) => {
    const object = repo.objects.get(oid)!;
    const info = parseCommit(object.data);
    return { oid, distance, info };
  });
  entries.sort((a, b) => b.info.time - a.info.time || a.distance - b.distance || (a.oid < b.oid ? -1 : 1));
  const forge = ctx.forge;
  const all = entries.map(({ oid, info }) => ({
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: {
      author: identJson(info.author, forge, info.time),
      committer: identJson(info.committer, forge, info.time),
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree },
      comment_count: 0,
    },
    author: info.author.includes(VIEWER.email) ? userJson() : null,
    committer: info.committer.includes(VIEWER.email) ? userJson() : null,
    parents: info.parents.map((parent) => ({ sha: parent })),
  }));
  sendList(ctx, all);
}

// ------------------------------------------------------------------ contents

function fileEntryJson(repo: RepoRec, path: string, blobOid: string, withContent: boolean) {
  const data = repo.objects.get(blobOid)?.data ?? Buffer.alloc(0);
  const base = {
    name: path.split('/').pop() ?? path,
    path,
    sha: blobOid,
    size: data.length,
    type: 'file',
    encoding: 'base64',
  };
  return withContent ? { ...base, content: data.toString('base64') } : base;
}

function commitJson(forge: Forge, repo: RepoRec, commitOid: string) {
  const object = repo.objects.get(commitOid);
  if (object === undefined) return { sha: commitOid };
  const info = parseCommit(object.data);
  return {
    sha: commitOid,
    message: info.message.replace(/\n$/, ''),
    author: identJson(info.author, forge, info.time),
    committer: identJson(info.committer, forge, info.time),
    tree: { sha: info.tree },
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

/** Navigate to a tree/blob by path inside a commit's tree; null when absent. */
function navigateTree(repo: RepoRec, treeOid: string, path: string): { kind: 'tree' | 'blob'; oid: string } | null {
  if (path === '') return { kind: 'tree', oid: treeOid };
  let current = treeOid;
  const segments = path.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'tree', oid: entry.oid } : { kind: 'blob', oid: entry.oid };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

async function putContents(ctx: Ctx, repo: RepoRec, path: string): Promise<void> {
  if (path === '') throw new HttpError(422, 'Invalid path');
  const body = parseJsonBody(await readBody(ctx.req));
  const contentB64 = bodyString(body, 'content');
  if (contentB64 === null) throw new HttpError(422, 'content is required');
  const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch);
  const flat = flattenTree(repo, tip === null ? null : commitTreeOid(repo, tip));
  const existing = flat.get(path);
  const shaGiven = bodyString(body, 'sha');
  if (existing !== undefined) {
    if (shaGiven === null) throw new HttpError(422, '"sha" wasn\'t supplied');
    if (shaGiven !== existing.oid) throw new HttpError(409, 'The sha provided does not match the sha of the file');
  }
  const message = bodyString(body, 'message') ?? (existing === undefined ? `Create ${path}` : `Update ${path}`);
  const { commitOid, blobOid } = commitFileChange(ctx.forge, repo, branch, path, content, message);
  const status = existing === undefined ? 201 : 200;
  sendJson(ctx.res, status, {
    content: fileEntryJson(repo, path, blobOid!, false),
    commit: commitJson(ctx.forge, repo, commitOid),
  });
}

function getContents(ctx: Ctx, repo: RepoRec, path: string): void {
  const refParam = ctx.query.get('ref');
  const commitOid = refParam !== null && refParam !== '' ? resolveToCommit(repo, refParam) : branchTip(repo, repo.defaultBranch);
  if (commitOid === null) throw notFound();
  const treeOid = commitTreeOid(repo, commitOid);
  if (treeOid === null) throw notFound();
  const found = navigateTree(repo, treeOid, path);
  if (found === null) throw notFound();
  if (found.kind === 'blob') {
    sendJson(ctx.res, 200, fileEntryJson(repo, path, found.oid, true));
    return;
  }
  const treeObject = repo.objects.get(found.oid);
  if (treeObject === undefined) throw notFound();
  const entries = parseTree(treeObject.data).map((entry) => {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    if (entry.mode === '40000') {
      return { name: entry.name, path: childPath, sha: entry.oid, size: 0, type: 'dir' };
    }
    const blob = repo.objects.get(entry.oid);
    return {
      name: entry.name,
      path: childPath,
      sha: entry.oid,
      size: blob?.data.length ?? 0,
      type: 'file',
      encoding: 'base64',
    };
  });
  sendJson(ctx.res, 200, entries);
}

async function deleteContents(ctx: Ctx, repo: RepoRec, path: string): Promise<void> {
  const body = parseJsonBody(await readBody(ctx.req));
  const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  const flat = flattenTree(repo, tip === null ? null : commitTreeOid(repo, tip));
  const existing = flat.get(path);
  if (existing === undefined) throw notFound();
  const shaGiven = bodyString(body, 'sha');
  if (shaGiven !== null && shaGiven !== existing.oid) throw new HttpError(409, 'The sha provided does not match the sha of the file');
  const message = bodyString(body, 'message') ?? `Delete ${path}`;
  const { commitOid } = commitFileChange(ctx.forge, repo, branch, path, null, message);
  sendJson(ctx.res, 200, { content: null, commit: commitJson(ctx.forge, repo, commitOid) });
}

// ------------------------------------------------------------------ labels and issues

async function createLabel(ctx: Ctx, repo: RepoRec): Promise<void> {
  const body = parseJsonBody(await readBody(ctx.req));
  const name = bodyString(body, 'name');
  if (name === null || name === '') throw new HttpError(422, 'Validation Failed: a label needs a name');
  if (repo.labels.has(name)) throw new HttpError(422, 'Validation Failed: the label already exists');
  const label: LabelRec = {
    id: ctx.forge.allocLabelId(),
    name,
    color: (bodyString(body, 'color') ?? 'ededed').replace(/^#/, ''),
    description: bodyString(body, 'description'),
  };
  repo.labels.set(name, label);
  sendJson(ctx.res, 201, labelJson(label));
}

function validateLabels(repo: RepoRec, body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(422, 'Validation Failed: labels must be an array');
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? bodyString(entry as Record<string, unknown>, 'name') : null;
    if (name === null || !repo.labels.has(name)) throw new HttpError(422, 'Validation Failed: a label does not exist');
    names.push(name);
  }
  return names;
}

async function createIssue(ctx: Ctx, repo: RepoRec): Promise<IssueRec> {
  const body = parseJsonBody(await readBody(ctx.req));
  const title = bodyString(body, 'title');
  if (title === null || title === '') throw new HttpError(422, 'Validation Failed: a title is required');
  const labels = validateLabels(repo, body);
  const sec = ctx.forge.tick();
  const issue: IssueRec = {
    number: repo.nextIssueNumber,
    gid: ctx.forge.allocIssueGid(),
    title,
    body: bodyString(body, 'body') ?? '',
    state: 'open',
    labels,
    comments: [],
    createdSec: sec,
    updatedSec: sec,
    closedSec: null,
    version: 1,
  };
  repo.nextIssueNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function listIssues(ctx: Ctx, repo: RepoRec): void {
  const state = ctx.query.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  else if (state !== 'all') issues = issues.filter((issue) => issue.state === 'open');
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  issues.sort((a, b) => {
    const key = sort === 'updated' ? a.updatedSec - b.updatedSec || a.number - b.number : a.number - b.number;
    return direction === 'asc' ? key : -key;
  });
  sendList(ctx, issues.map((issue) => issueJson(ctx.forge, repo, issue)));
}

async function patchIssue(ctx: Ctx, repo: RepoRec, issue: IssueRec): Promise<void> {
  const body = parseJsonBody(await readBody(ctx.req));
  const title = bodyString(body, 'title');
  if (title !== null) issue.title = title;
  const text = bodyString(body, 'body');
  if (text !== null) issue.body = text;
  if (body.labels !== undefined) issue.labels = validateLabels(repo, body);
  const state = bodyString(body, 'state');
  if (state === 'closed' || state === 'open') {
    if (state !== issue.state) {
      issue.state = state;
      issue.closedSec = state === 'closed' ? ctx.forge.tick() : null;
    }
  } else if (state !== null) {
    throw new HttpError(422, 'Validation Failed: state must be open or closed');
  }
  issue.updatedSec = ctx.forge.tick();
  issue.version += 1;
  sendJson(ctx.res, 200, issueJson(ctx.forge, repo, issue));
}

/** The record a comment thread hangs on: an issue, or a pull request under the same number. */
function threadOf(repo: RepoRec, number: number): { comments: CommentRec[] } | null {
  return repo.issues.get(number) ?? repo.pulls.get(number) ?? null;
}

async function createComment(ctx: Ctx, repo: RepoRec, number: number): Promise<void> {
  const thread = threadOf(repo, number);
  if (thread === null) throw notFound();
  const body = parseJsonBody(await readBody(ctx.req));
  const text = bodyString(body, 'body');
  if (text === null) throw new HttpError(422, 'Validation Failed: a body is required');
  const comment: CommentRec = { id: ctx.forge.allocCommentId(), body: text, createdSec: ctx.forge.tick() };
  thread.comments.push(comment);
  const issue = repo.issues.get(number);
  if (issue !== undefined) {
    issue.updatedSec = ctx.forge.nowSec();
    issue.version += 1;
  }
  sendJson(ctx.res, 201, commentJson(ctx.forge, comment));
}

// ------------------------------------------------------------------ pull requests

function stripOwnerPrefix(repo: RepoRec, value: string): string {
  const colon = value.indexOf(':');
  if (colon > 0) {
    const maybeOwner = value.slice(0, colon);
    if (maybeOwner === repo.owner) return value.slice(colon + 1);
  }
  return value;
}

async function createPull(ctx: Ctx, repo: RepoRec): Promise<PullRec> {
  const body = parseJsonBody(await readBody(ctx.req));
  const title = bodyString(body, 'title');
  if (title === null || title === '') throw new HttpError(422, 'Validation Failed: a title is required');
  const headRaw = bodyString(body, 'head');
  const baseRaw = bodyString(body, 'base');
  if (headRaw === null || baseRaw === null) throw new HttpError(422, 'Validation Failed: head and base are required');
  const head = stripOwnerPrefix(repo, headRaw);
  const base = stripOwnerPrefix(repo, baseRaw);
  const headTip = branchTip(repo, head);
  const baseTip = branchTip(repo, base);
  if (headTip === null) throw new HttpError(422, `Invalid head: ${headRaw}`);
  if (baseTip === null) throw new HttpError(422, `Invalid base: ${baseRaw}`);
  const baseOfHead = mergeBase(repo.objects, baseTip, headTip);
  if (baseOfHead === headTip) throw new HttpError(422, 'No commits between base and head');
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      throw new HttpError(422, 'A pull request already exists for this head and base');
    }
  }
  const sec = ctx.forge.tick();
  const pull: PullRec = {
    number: repo.nextPullNumber,
    gid: ctx.forge.allocPullGid(),
    title,
    body: bodyString(body, 'body') ?? '',
    state: 'open',
    merged: false,
    headRef: head,
    baseRef: base,
    mergeCommitSha: null,
    createdSec: sec,
    updatedSec: sec,
    closedSec: null,
    mergedSec: null,
    comments: [],
  };
  repo.nextPullNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

function listPulls(ctx: Ctx, repo: RepoRec): void {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  const direction = ctx.query.get('direction') ?? 'desc';
  pulls.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  sendList(ctx, pulls.map((pull) => pullJson(ctx.forge, repo, pull)));
}

function pullFiles(ctx: Ctx, repo: RepoRec, pull: PullRec): void {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) {
    sendJson(ctx.res, 200, []);
    return;
  }
  const base = mergeBase(repo.objects, baseTip, headTip);
  const diffs = diffCommits(repo, base, headTip);
  sendJson(
    ctx.res,
    200,
    diffs.map((diff) => ({
      filename: diff.filename,
      sha: diff.sha,
      status: diff.status,
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
    })),
  );
}

async function mergePull(ctx: Ctx, repo: RepoRec, pull: PullRec): Promise<void> {
  const body = parseJsonBody(await readBody(ctx.req));
  if (pull.state !== 'open' || pull.merged) throw new HttpError(405, 'Pull Request is not mergeable');
  const methodRaw = bodyString(body, 'merge_method') ?? 'merge';
  const method = methodRaw === 'squash' || methodRaw === 'rebase' ? methodRaw : 'merge';
  const title = bodyString(body, 'commit_title') ?? pull.title;
  const message = bodyString(body, 'commit_message');
  const commitMessage = method === 'squash' ? (message === null ? `${title}\n\n${pull.body}` : `${title}\n\n${message}`) : title;
  const sha = performMerge(ctx.forge, repo, pull.baseRef, pull.headRef, method, commitMessage);
  if (sha === null) throw new HttpError(405, 'Pull Request is not mergeable');
  const sec = ctx.forge.tick();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSec = sec;
  pull.closedSec = sec;
  pull.updatedSec = sec;
  pull.mergeCommitSha = sha;
  sendJson(ctx.res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// ------------------------------------------------------------------ routing

/** Handle one /api/v3 request; `restPath` is the path after the prefix ('/' for the root). */
export async function handleRest(ctx: Ctx, restPath: string): Promise<void> {
  const res = ctx.res;
  const method = ctx.method;

  if (restPath === '/' || restPath === '') {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_url: '/api/v3/repos/{owner}/{repo}/issues/{number}',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  if (restPath === '/meta') {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }
  if (restPath === '/user') {
    requireAuth(ctx);
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    sendJson(res, 200, userJson());
    return;
  }
  if (restPath === '/user/repos') {
    if (method === 'POST') return createRepoRoute(ctx);
    if (method === 'GET') return listViewerRepos(ctx);
    throw new HttpError(404, 'Not Found');
  }

  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(restPath);
  if (repoMatch === null) throw new HttpError(404, 'Not Found');
  requireAuth(ctx);
  const owner = decodeURIComponent(repoMatch[1]!);
  const name = decodeURIComponent(repoMatch[2]!);
  const tail = repoMatch[3] ?? '';
  const repo = requireRepo(ctx, owner, name);

  if (tail === '') {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(ctx.forge, repo));
      return;
    }
    if (method === 'PATCH') return patchRepoRoute(ctx, repo);
    if (method === 'DELETE') {
      ctx.forge.deleteRepo(owner, name);
      sendEmpty(res, 204);
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  if (tail === '/git/refs' && method === 'POST') return createRefRoute(ctx, repo);
  if (tail.startsWith('/git/refs/') && method === 'GET') return getRefRoute(ctx, repo, tail.slice('/git/refs/'.length));
  if (tail === '/branches' && method === 'GET') return listBranches(ctx, repo);
  if (tail.startsWith('/branches/') && method === 'GET') return getBranch(ctx, repo, tail.slice('/branches/'.length));
  if (tail === '/commits' && method === 'GET') return listCommits(ctx, repo);
  if (tail === '/labels' && method === 'POST') return createLabel(ctx, repo);
  if (tail === '/labels' && method === 'GET') {
    sendJson(res, 200, [...repo.labels.values()].map(labelJson));
    return;
  }

  if (tail === '/contents' || tail.startsWith('/contents/')) {
    const path = tail === '/contents' ? '' : tail.slice('/contents/'.length);
    if (method === 'PUT') return putContents(ctx, repo, path);
    if (method === 'GET') return getContents(ctx, repo, path);
    if (method === 'DELETE') return deleteContents(ctx, repo, path);
    throw new HttpError(404, 'Not Found');
  }

  if (tail === '/issues') {
    if (method === 'POST') {
      const issue = await createIssue(ctx, repo);
      sendJson(res, 201, issueJson(ctx.forge, repo, issue));
      return;
    }
    if (method === 'GET') return listIssues(ctx, repo);
    throw new HttpError(404, 'Not Found');
  }
  const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(tail);
  if (issueMatch !== null) {
    const number = Number(issueMatch[1]);
    if (issueMatch[2] === '/comments') {
      if (method === 'POST') return createComment(ctx, repo, number);
      if (method === 'GET') {
        const thread = threadOf(repo, number);
        if (thread === null) throw notFound();
        sendJson(res, 200, thread.comments.map((comment) => commentJson(ctx.forge, comment)));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    const issue = repo.issues.get(number);
    if (issue === undefined) throw notFound();
    if (method === 'GET') {
      sendJson(res, 200, issueJson(ctx.forge, repo, issue));
      return;
    }
    if (method === 'PATCH') return patchIssue(ctx, repo, issue);
    throw new HttpError(404, 'Not Found');
  }

  if (tail === '/pulls') {
    if (method === 'POST') {
      const pull = await createPull(ctx, repo);
      sendJson(res, 201, pullJson(ctx.forge, repo, pull));
      return;
    }
    if (method === 'GET') return listPulls(ctx, repo);
    throw new HttpError(404, 'Not Found');
  }
  const pullMatch = /^\/pulls\/(\d+)(\/files|\/merge)?$/.exec(tail);
  if (pullMatch !== null) {
    const number = Number(pullMatch[1]);
    const pull = repo.pulls.get(number);
    if (pullMatch[2] === '/merge') {
      if (pull === undefined) throw notFound();
      if (method === 'PUT') return mergePull(ctx, repo, pull);
      throw new HttpError(404, 'Not Found');
    }
    if (pull === undefined) throw notFound();
    if (pullMatch[2] === '/files') {
      if (method === 'GET') return pullFiles(ctx, repo, pull);
      throw new HttpError(404, 'Not Found');
    }
    if (method === 'GET') {
      sendJson(res, 200, pullJsonMerged(ctx.forge, repo, pull));
      return;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody(await readBody(ctx.req));
      const title = bodyString(body, 'title');
      if (title !== null) pull.title = title;
      const text = bodyString(body, 'body');
      if (text !== null) pull.body = text;
      const state = bodyString(body, 'state');
      if (state === 'closed' || state === 'open') {
        pull.state = state;
        pull.closedSec = state === 'closed' ? ctx.forge.tick() : null;
      }
      pull.updatedSec = ctx.forge.tick();
      sendJson(res, 200, pullJson(ctx.forge, repo, pull));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  throw new HttpError(404, 'Not Found');
}
