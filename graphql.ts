// The GraphQL v4 surface at POST /api/graphql: a small executor over gqlparser.ts's AST and
// the forge store, answering the document shapes gh and github-mcp-server send (the kit's
// checks-graphql.ts enumerates them). Global ids are the store's opaque base64 ids, stable
// across reads; an unknown field is a 200 with an `errors` array naming the field, as GitHub
// answers; an unknown repository is data.repository = null with no errors; two operation
// documents in one JSON-array body answer as a batch, in order.

import {
  VIEWER,
  branchTip,
  globalId,
  mergeWouldConflict,
  parseGlobalId,
  performMerge,
  pullRequestDiffs,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { parseGraphql, resolveValue, type FieldNode, type OperationNode, type SelectionNode } from './gqlparser.ts';
import { HttpError, readBody, sendJson, type Ctx } from './http.ts';

// ------------------------------------------------------------------ wrapped values

type Wrapped = { __type: string } & Record<string, unknown>;

function wrap(type: string, fields: Record<string, unknown>): Wrapped {
  return { __type: type, ...fields };
}

class FieldError extends Error {}

interface Exec {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
}

function repoByDbId(forge: Forge, dbId: number): RepoRec | null {
  return forge.viewerRepos().find((repo) => repo.dbId === dbId) ?? null;
}

function issueSource(repo: RepoRec, issue: IssueRec): Wrapped {
  return wrap('Issue', { repo, issue });
}

function pullSource(repo: RepoRec, pull: PullRec): Wrapped {
  return wrap('PullRequest', { repo, pull });
}

// ------------------------------------------------------------------ connections

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface Page<T> {
  items: T[];
  hasNextPage: boolean;
  endCursor: string | null;
  totalCount: number;
}

/** Slice a pre-sorted list by the connection arguments (first/after), numbering by `numberOf`. */
function paginate<T>(list: readonly T[], args: Record<string, unknown>, numberOf: (item: T) => number): Page<T> {
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const number = numberFromCursor(after);
    if (number !== null) {
      const index = list.findIndex((item) => numberOf(item) === number);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : list.length;
  const items = list.slice(start, start + first);
  return {
    items,
    hasNextPage: start + items.length < list.length,
    endCursor: items.length > 0 ? cursorOf(numberOf(items[items.length - 1]!)) : null,
    totalCount: list.length,
  };
}

// ------------------------------------------------------------------ field resolution

function argsOf(exec: Exec, field: FieldNode): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of field.args) args[key] = resolveValue(value, exec.variables);
  return args;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new FieldError(`Argument "${key}" must be a string`);
  return value;
}

function resolveNode(exec: Exec, id: string): Wrapped | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'User') return Number(parsed.key) === VIEWER.id ? wrap('User', {}) : null;
  if (parsed.type === 'Repository') {
    const repo = repoByDbId(exec.forge, Number(parsed.key));
    return repo === null ? null : wrap('Repository', { repo });
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const [dbIdRaw, numberRaw] = parsed.key.split(':');
    const repo = repoByDbId(exec.forge, Number(dbIdRaw));
    if (repo === null) return null;
    const number = Number(numberRaw);
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueSource(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullSource(repo, pull);
  }
  return null;
}

function resolveQuery(exec: Exec, field: string, args: Record<string, unknown>): unknown {
  switch (field) {
    case 'viewer':
      return wrap('User', {});
    case 'repository': {
      const owner = stringArg(args, 'owner');
      const name = stringArg(args, 'name');
      const repo = exec.forge.repo(owner, name);
      return repo === null ? null : wrap('Repository', { repo });
    }
    case 'node': {
      const id = args.id;
      return typeof id === 'string' ? resolveNode(exec, id) : null;
    }
    case '__type': {
      const name = args.name;
      if (typeof name !== 'string' || TYPE_TABLE[name] === undefined) return null;
      return wrap('__Type', { name });
    }
    case '__schema':
      return wrap('__Schema', {});
    case 'rateLimit':
      return wrap('RateLimit', {});
    default:
      throw new FieldError(`Field '${field}' doesn't exist on type 'Query'`);
  }
}

function resolveRepository(exec: Exec, source: Wrapped, field: string, args: Record<string, unknown>): unknown {
  const repo = source.repo as RepoRec;
  const forge = exec.forge;
  switch (field) {
    case 'id':
      return globalId('Repository', String(repo.dbId));
    case 'databaseId':
      return repo.dbId;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.isPrivate;
    case 'isFork':
      return false;
    case 'isArchived':
      return false;
    case 'createdAt':
      return forge.iso(repo.createdSec);
    case 'updatedAt':
      return forge.iso(repo.updatedSec);
    case 'url':
    case 'resourcePath':
      return '';
    case 'owner':
      return wrap('User', {});
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'hasWikiEnabled':
    case 'hasProjectsEnabled':
      return false;
    case 'defaultBranchRef': {
      const tip = branchTip(repo, repo.defaultBranch);
      return tip === null ? null : wrap('Ref', { repo, name: repo.defaultBranch, oid: tip });
    }
    case 'issue': {
      const number = Number(args.number);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      return issue === undefined ? null : issueSource(repo, issue);
    }
    case 'issues': {
      let list = [...repo.issues.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const orderField = orderBy?.field ?? 'CREATED_AT';
      const descending = (orderBy?.direction ?? 'DESC') !== 'ASC';
      list.sort((a, b) => {
        let key: number;
        if (orderField === 'UPDATED_AT') key = a.updatedSec - b.updatedSec || a.number - b.number;
        else if (orderField === 'COMMENTS') key = a.comments.length - b.comments.length || a.number - b.number;
        else key = a.number - b.number;
        return descending ? -key : key;
      });
      const page = paginate(list, args, (issue) => issue.number);
      return wrap('IssueConnection', {
        repo,
        nodes: page.items,
        pageInfo: wrap('PageInfo', { hasNextPage: page.hasNextPage, endCursor: page.endCursor }),
        totalCount: page.totalCount,
      });
    }
    case 'pullRequest': {
      const number = Number(args.number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      return pull === undefined ? null : pullSource(repo, pull);
    }
    case 'pullRequests': {
      let list = [...repo.pulls.values()];
      const states = args.states;
      const wanted = new Set((Array.isArray(states) && states.length > 0 ? states : ['OPEN']).map((state) => String(state)));
      list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      list.sort((a, b) => b.number - a.number);
      const page = paginate(list, args, (pull) => pull.number);
      return wrap('PullRequestConnection', {
        repo,
        nodes: page.items,
        pageInfo: wrap('PageInfo', { hasNextPage: page.hasNextPage, endCursor: page.endCursor }),
        totalCount: page.totalCount,
      });
    }
    default:
      throw new FieldError(`Field '${field}' doesn't exist on type 'Repository'`);
  }
}

function resolveIssue(exec: Exec, source: Wrapped, field: string): unknown {
  const repo = source.repo as RepoRec;
  const issue = source.issue as IssueRec;
  const forge = exec.forge;
  switch (field) {
    case 'id':
      return globalId('Issue', `${repo.dbId}:${issue.number}`);
    case 'databaseId':
      return issue.gid;
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
    case 'bodyHTML':
    case 'bodyText':
      return issue.body;
    case 'state':
      return issue.state.toUpperCase();
    case 'createdAt':
      return forge.iso(issue.createdSec);
    case 'updatedAt':
      return forge.iso(issue.updatedSec);
    case 'closedAt':
      return issue.closedSec === null ? null : forge.iso(issue.closedSec);
    case 'closed':
      return issue.state === 'closed';
    case 'locked':
      return false;
    case 'url':
    case 'resourcePath':
      return '';
    case 'author':
      return wrap('User', {});
    case 'repository':
      return wrap('Repository', { repo });
    case 'labels':
      return wrap('LabelConnection', {
        nodes: issue.labels
          .map((name) => repo.labels.get(name))
          .filter((label) => label !== undefined)
          .map((label) => wrap('Label', { repo, label: label! })),
      });
    case 'comments':
      return wrap('IssueCommentConnection', {
        nodes: issue.comments.map((comment) => wrap('IssueComment', { repo, comment, number: issue.number })),
      });
    default:
      throw new FieldError(`Field '${field}' doesn't exist on type 'Issue'`);
  }
}

function resolvePullRequest(exec: Exec, source: Wrapped, field: string, args: Record<string, unknown>): unknown {
  const repo = source.repo as RepoRec;
  const pull = source.pull as PullRec;
  const forge = exec.forge;
  switch (field) {
    case 'id':
      return globalId('PullRequest', `${repo.dbId}:${pull.number}`);
    case 'databaseId':
      return pull.gid;
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
    case 'bodyHTML':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    case 'merged':
      return pull.merged;
    case 'mergedAt':
      return pull.mergedSec === null ? null : forge.iso(pull.mergedSec);
    case 'closedAt':
      return pull.closedSec === null ? null : forge.iso(pull.closedSec);
    case 'closed':
      return pull.state === 'closed';
    case 'createdAt':
      return forge.iso(pull.createdSec);
    case 'updatedAt':
      return forge.iso(pull.updatedSec);
    case 'isDraft':
      return false;
    case 'locked':
      return false;
    case 'url':
    case 'resourcePath':
      return '';
    case 'author':
      return wrap('User', {});
    case 'repository':
      return wrap('Repository', { repo });
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'headRef': {
      const tip = branchTip(repo, pull.headRef);
      return tip === null ? null : wrap('Ref', { repo, name: pull.headRef, oid: tip });
    }
    case 'baseRef': {
      const tip = branchTip(repo, pull.baseRef);
      return tip === null ? null : wrap('Ref', { repo, name: pull.baseRef, oid: tip });
    }
    case 'mergeable': {
      if (pull.state !== 'open') return 'UNKNOWN';
      const headTip = branchTip(repo, pull.headRef);
      const baseTip = branchTip(repo, pull.baseRef);
      if (headTip === null || baseTip === null) return 'UNKNOWN';
      return mergeWouldConflict(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
    }
    case 'mergeCommit':
      return pull.mergeCommitSha === null ? null : wrap('Commit', { oid: pull.mergeCommitSha });
    case 'files': {
      const diffs = pullRequestDiffs(repo, pull);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : diffs.length;
      return wrap('PullRequestChangedFileConnection', { diffs: diffs.slice(0, first), totalCount: diffs.length });
    }
    case 'additions':
      return pullRequestDiffs(repo, pull).reduce((sum, diff) => sum + diff.additions, 0);
    case 'deletions':
      return pullRequestDiffs(repo, pull).reduce((sum, diff) => sum + diff.deletions, 0);
    case 'changedFiles':
      return pullRequestDiffs(repo, pull).length;
    case 'comments':
      return wrap('IssueCommentConnection', {
        nodes: pull.comments.map((comment) => wrap('IssueComment', { repo, comment, number: pull.number })),
      });
    default:
      throw new FieldError(`Field '${field}' doesn't exist on type 'PullRequest'`);
  }
}

function resolveMutation(exec: Exec, field: string, args: Record<string, unknown>): unknown {
  const forge = exec.forge;
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field) {
    case 'createIssue': {
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.type === 'Repository' ? repoByDbId(forge, Number(parsed.key)) : null;
      if (repo === null) throw new FieldError('createIssue: the repository does not exist');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new FieldError('createIssue: a title is required');
      const sec = forge.tick();
      const issue: IssueRec = {
        number: repo.nextIssueNumber,
        gid: forge.allocIssueGid(),
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSec: sec,
        updatedSec: sec,
        closedSec: null,
        version: 1,
      };
      repo.nextIssueNumber += 1;
      repo.issues.set(issue.number, issue);
      return wrap('CreateIssuePayload', { issue: issueSource(repo, issue) });
    }
    case 'closeIssue': {
      const target = typeof input.issueId === 'string' ? resolveNode(exec, input.issueId) : null;
      if (target === null || target.__type !== 'Issue') throw new FieldError('closeIssue: the issue does not exist');
      const issue = target.issue as IssueRec;
      if (issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closedSec = forge.tick();
        issue.updatedSec = forge.nowSec();
        issue.version += 1;
      }
      return wrap('CloseIssuePayload', { issue: target });
    }
    case 'createPullRequest': {
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.type === 'Repository' ? repoByDbId(forge, Number(parsed.key)) : null;
      if (repo === null) throw new FieldError('createPullRequest: the repository does not exist');
      const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headTip = branchTip(repo, headRefName);
      const baseTip = branchTip(repo, baseRefName);
      if (headTip === null) throw new FieldError(`createPullRequest: the head branch ${headRefName} does not exist`);
      if (baseTip === null) throw new FieldError(`createPullRequest: the base branch ${baseRefName} does not exist`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === headRefName && existing.baseRef === baseRefName) {
          return wrap('CreatePullRequestPayload', { pullRequest: pullSource(repo, existing) });
        }
      }
      const sec = forge.tick();
      const pull: PullRec = {
        number: repo.nextPullNumber,
        gid: forge.allocPullGid(),
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        headRef: headRefName,
        baseRef: baseRefName,
        mergeCommitSha: null,
        createdSec: sec,
        updatedSec: sec,
        closedSec: null,
        mergedSec: null,
        comments: [],
      };
      repo.nextPullNumber += 1;
      repo.pulls.set(pull.number, pull);
      return wrap('CreatePullRequestPayload', { pullRequest: pullSource(repo, pull) });
    }
    case 'mergePullRequest': {
      const target = typeof input.pullRequestId === 'string' ? resolveNode(exec, input.pullRequestId) : null;
      if (target === null || target.__type !== 'PullRequest') throw new FieldError('mergePullRequest: the pull request does not exist');
      const repo = target.repo as RepoRec;
      const pull = target.pull as PullRec;
      if (pull.state !== 'open' || pull.merged) throw new FieldError('mergePullRequest: the pull request is not open');
      const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
      const method = methodRaw === 'SQUASH' ? 'squash' : methodRaw === 'REBASE' ? 'rebase' : 'merge';
      const headline = typeof input.commitHeadline === 'string' && input.commitHeadline !== '' ? input.commitHeadline : pull.title;
      const bodyText = typeof input.commitBody === 'string' ? input.commitBody : pull.body;
      const message = method === 'squash' ? `${headline}\n\n${bodyText}` : headline;
      const sha = performMerge(forge, repo, pull.baseRef, pull.headRef, method, message);
      if (sha === null) throw new FieldError('mergePullRequest: the pull request is not mergeable');
      const sec = forge.tick();
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedSec = sec;
      pull.closedSec = sec;
      pull.updatedSec = sec;
      pull.mergeCommitSha = sha;
      return wrap('MergePullRequestPayload', { pullRequest: target });
    }
    case 'addComment': {
      const target = typeof input.subjectId === 'string' ? resolveNode(exec, input.subjectId) : null;
      if (target === null || (target.__type !== 'Issue' && target.__type !== 'PullRequest')) {
        throw new FieldError('addComment: the subject does not exist');
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const record = (target.__type === 'Issue' ? target.issue : target.pull) as IssueRec | PullRec;
      const comment = { id: forge.allocCommentId(), body, createdSec: forge.tick() };
      record.comments.push(comment);
      const repo = target.repo as RepoRec;
      const number = (record as IssueRec).number;
      return wrap('AddCommentPayload', {
        commentEdge: wrap('IssueCommentEdge', { node: wrap('IssueComment', { repo, comment, number }) }),
      });
    }
    default:
      throw new FieldError(`Field '${field}' doesn't exist on type 'Mutation'`);
  }
}

// ------------------------------------------------------------------ the type table (introspection)

const TYPE_TABLE: Readonly<Record<string, { kind: string; fields?: readonly string[]; enumValues?: readonly string[] }>> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'user', 'organization', 'search', 'rateLimit', 'meta'] },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'reopenIssue', 'updateIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'createRepository'],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url', 'resourcePath', 'isViewer', 'bio', 'company', 'location', 'createdAt', 'updatedAt', 'repositories', 'issues', 'pullRequests'],
  },
  Organization: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'url', 'resourcePath', 'repositories'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'hasWikiEnabled', 'hasProjectsEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
      'isPrivate', 'isFork', 'isArchived', 'isEmpty', 'url', 'resourcePath', 'createdAt', 'updatedAt', 'pushedAt',
      'stargazerCount', 'forkCount', 'labels', 'refs', 'ref', 'object', 'collaborators', 'viewerHasStarred',
      'viewerCanAdminister', 'primaryLanguage', 'forks', 'stargazers', 'watchers', 'mentionableUsers', 'assignableUsers',
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'number', 'title', 'titleHTML', 'body', 'bodyHTML', 'bodyText', 'state', 'stateReason',
      'author', 'editor', 'repository', 'labels', 'comments', 'assignees', 'participants', 'milestone',
      'createdAt', 'updatedAt', 'closedAt', 'closed', 'locked', 'activeLockReason', 'url', 'resourcePath',
      'viewerDidAuthor', 'viewerCanUpdate', 'viewerCanClose', 'viewerCanReopen', 'viewerCanComment', 'reactions', 'timelineItems',
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'number', 'title', 'body', 'bodyHTML', 'state', 'merged', 'mergedAt', 'mergeable',
      'headRefName', 'baseRefName', 'headRef', 'baseRef', 'headRepository', 'baseRepository', 'author', 'repository',
      'files', 'commits', 'comments', 'reviews', 'labels', 'assignees', 'participants', 'milestone',
      'createdAt', 'updatedAt', 'closedAt', 'closed', 'url', 'resourcePath', 'additions', 'deletions', 'changedFiles',
      'isDraft', 'mergeCommit', 'mergeStateStatus', 'locked', 'activeLockReason', 'viewerCanUpdate', 'viewerDidAuthor', 'maintainerCanModify',
    ],
  },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'bodyHTML', 'author', 'createdAt', 'updatedAt', 'url', 'resourcePath', 'issue', 'pullRequest'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description', 'url', 'resourcePath'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'prefix', 'target', 'repository'] },
  Commit: { kind: 'OBJECT', fields: ['oid', 'message', 'messageHeadline', 'author', 'committer', 'tree', 'parents', 'committedDate', 'authoredDate', 'url'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  Node: { kind: 'INTERFACE', fields: ['id'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
};

function resolveTypeField(source: Wrapped, field: string): unknown {
  const name = source.name as string;
  const entry = TYPE_TABLE[name];
  switch (field) {
    case 'name':
      return name;
    case 'kind':
      return entry?.kind ?? 'OBJECT';
    case 'description':
      return null;
    case 'fields':
      return entry?.fields === undefined ? null : entry.fields.map((fieldName) => wrap('__Field', { name: fieldName }));
    case 'enumValues':
      return entry?.enumValues === undefined ? null : entry.enumValues.map((value) => wrap('__EnumValue', { name: value }));
    case 'possibleTypes':
      return null;
    case 'inputFields':
      return null;
    case 'ofType':
      return null;
    case 'interfaces':
      return [];
    default:
      throw new FieldError(`Field '${field}' doesn't exist on type '__Type'`);
  }
}

function resolveField(exec: Exec, source: Wrapped, field: FieldNode): unknown {
  const type = source.__type;
  const args = argsOf(exec, field);
  const name = field.name;
  if (name === '__typename') return type;
  switch (type) {
    case 'Query':
      return resolveQuery(exec, name, args);
    case 'Mutation':
      return resolveMutation(exec, name, args);
    case 'User':
      switch (name) {
        case 'login':
          return VIEWER.login;
        case 'id':
          return globalId('User', String(VIEWER.id));
        case 'databaseId':
          return VIEWER.id;
        case 'name':
          return VIEWER.name;
        case 'email':
          return VIEWER.email;
        case 'url':
        case 'resourcePath':
        case 'avatarUrl':
          return '';
        case 'isViewer':
          return true;
        default:
          throw new FieldError(`Field '${name}' doesn't exist on type 'User'`);
      }
    case 'Repository':
      return resolveRepository(exec, source, name, args);
    case 'Issue':
      return resolveIssue(exec, source, name);
    case 'PullRequest':
      return resolvePullRequest(exec, source, name, args);
    case 'Ref':
      switch (name) {
        case 'name':
          return source.name;
        case 'prefix':
          return 'refs/heads/';
        case 'target':
          return wrap('Commit', { oid: source.oid });
        case 'repository':
          return wrap('Repository', { repo: source.repo });
        default:
          throw new FieldError(`Field '${name}' doesn't exist on type 'Ref'`);
      }
    case 'Commit':
      if (name === 'oid') return source.oid;
      throw new FieldError(`Field '${name}' doesn't exist on type 'Commit'`);
    case 'IssueConnection':
    case 'PullRequestConnection':
      switch (name) {
        case 'nodes':
          return (source.nodes as (IssueRec | PullRec)[]).map((item) =>
            type === 'IssueConnection' ? issueSource(source.repo as RepoRec, item as IssueRec) : pullSource(source.repo as RepoRec, item as PullRec),
          );
        case 'edges':
          return (source.nodes as (IssueRec | PullRec)[]).map((item) =>
            wrap('Edge', {
              cursor: cursorOf(item.number),
              node:
                type === 'IssueConnection'
                  ? issueSource(source.repo as RepoRec, item as IssueRec)
                  : pullSource(source.repo as RepoRec, item as PullRec),
            }),
          );
        case 'pageInfo':
          return source.pageInfo;
        case 'totalCount':
          return source.totalCount;
        default:
          throw new FieldError(`Field '${name}' doesn't exist on type '${type}'`);
      }
    case 'PullRequestChangedFileConnection':
      switch (name) {
        case 'nodes':
          return (source.diffs as ReturnType<typeof pullRequestDiffs>).map((diff) => wrap('PullRequestChangedFile', { diff }));
        case 'totalCount':
          return source.totalCount;
        default:
          throw new FieldError(`Field '${name}' doesn't exist on type 'PullRequestChangedFileConnection'`);
      }
    case 'PullRequestChangedFile': {
      const diff = source.diff as ReturnType<typeof pullRequestDiffs>[number];
      switch (name) {
        case 'path':
          return diff.filename;
        case 'additions':
          return diff.additions;
        case 'deletions':
          return diff.deletions;
        case 'changeType':
          return diff.status === 'added' ? 'ADDED' : diff.status === 'removed' ? 'DELETED' : 'MODIFIED';
        default:
          throw new FieldError(`Field '${name}' doesn't exist on type 'PullRequestChangedFile'`);
      }
    }
    case 'LabelConnection':
      if (name === 'nodes') return source.nodes;
      throw new FieldError(`Field '${name}' doesn't exist on type 'LabelConnection'`);
    case 'Label': {
      const label = source.label as { id: number; name: string; color: string; description: string | null };
      switch (name) {
        case 'id':
          return globalId('Label', String(label.id));
        case 'name':
          return label.name;
        case 'color':
          return label.color;
        case 'description':
          return label.description;
        case 'url':
        case 'resourcePath':
          return '';
        default:
          throw new FieldError(`Field '${name}' doesn't exist on type 'Label'`);
      }
    }
    case 'IssueCommentConnection':
      if (name === 'nodes') return source.nodes;
      if (name === 'totalCount') return (source.nodes as unknown[]).length;
      throw new FieldError(`Field '${name}' doesn't exist on type 'IssueCommentConnection'`);
    case 'IssueComment': {
      const comment = source.comment as { id: number; body: string; createdSec: number };
      switch (name) {
        case 'id':
          return globalId('IssueComment', String(comment.id));
        case 'databaseId':
          return comment.id;
        case 'body':
          return comment.body;
        case 'createdAt':
          return exec.forge.iso(comment.createdSec);
        case 'updatedAt':
          return exec.forge.iso(comment.createdSec);
        case 'author':
          return wrap('User', {});
        case 'url':
        case 'resourcePath':
          return '';
        default:
          throw new FieldError(`Field '${name}' doesn't exist on type 'IssueComment'`);
      }
    }
    case 'PageInfo':
      switch (name) {
        case 'hasNextPage':
          return source.hasNextPage;
        case 'hasPreviousPage':
          return false;
        case 'startCursor':
          return source.endCursor;
        case 'endCursor':
          return source.endCursor;
        default:
          throw new FieldError(`Field '${name}' doesn't exist on type 'PageInfo'`);
      }
    case '__Type':
      return resolveTypeField(source, name);
    case '__Field':
      if (name === 'name') return source.name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      throw new FieldError(`Field '${name}' doesn't exist on type '__Field'`);
    case '__EnumValue':
      if (name === 'name') return source.name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      throw new FieldError(`Field '${name}' doesn't exist on type '__EnumValue'`);
    case '__Schema':
      if (name === 'queryType') return wrap('__Type', { name: 'Query' });
      if (name === 'mutationType') return wrap('__Type', { name: 'Mutation' });
      if (name === 'types') return Object.keys(TYPE_TABLE).map((typeName) => wrap('__Type', { name: typeName }));
      if (name === 'directives') return [];
      throw new FieldError(`Field '${name}' doesn't exist on type '__Schema'`);
    case 'RateLimit':
      if (name === 'limit') return 5000;
      if (name === 'remaining') return 5000;
      if (name === 'used') return 0;
      if (name === 'resetAt') return exec.forge.iso(exec.forge.nowSec());
      throw new FieldError(`Field '${name}' doesn't exist on type 'RateLimit'`);
    case 'CreateIssuePayload':
      if (name === 'issue') return source.issue;
      if (name === 'clientMutationId') return null;
      throw new FieldError(`Field '${name}' doesn't exist on type 'CreateIssuePayload'`);
    case 'CloseIssuePayload':
      if (name === 'issue') return source.issue;
      if (name === 'clientMutationId') return null;
      throw new FieldError(`Field '${name}' doesn't exist on type 'CloseIssuePayload'`);
    case 'CreatePullRequestPayload':
      if (name === 'pullRequest') return source.pullRequest;
      if (name === 'clientMutationId') return null;
      throw new FieldError(`Field '${name}' doesn't exist on type 'CreatePullRequestPayload'`);
    case 'MergePullRequestPayload':
      if (name === 'pullRequest') return source.pullRequest;
      if (name === 'clientMutationId') return null;
      throw new FieldError(`Field '${name}' doesn't exist on type 'MergePullRequestPayload'`);
    case 'AddCommentPayload':
      if (name === 'commentEdge') return source.commentEdge;
      if (name === 'subject') return null;
      if (name === 'clientMutationId') return null;
      throw new FieldError(`Field '${name}' doesn't exist on type 'AddCommentPayload'`);
    case 'IssueCommentEdge':
      if (name === 'node') return source.node;
      if (name === 'cursor') return cursorOf(0);
      throw new FieldError(`Field '${name}' doesn't exist on type 'IssueCommentEdge'`);
    case 'Edge':
      if (name === 'node') return source.node;
      if (name === 'cursor') return source.cursor;
      throw new FieldError(`Field '${name}' doesn't exist on type 'Edge'`);
    default:
      throw new FieldError(`Field '${name}' doesn't exist on type '${type}'`);
  }
}

// ------------------------------------------------------------------ execution

function completeValue(exec: Exec, value: unknown, selection: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(exec, item, selection));
  if (typeof value === 'object') {
    const wrapped = value as Wrapped;
    if (typeof wrapped.__type !== 'string') return value;
    if (selection === null) return null;
    const out: Record<string, unknown> = {};
    applySelections(exec, wrapped, selection, out);
    return out;
  }
  return value;
}

function applySelections(exec: Exec, source: Wrapped, selections: readonly SelectionNode[], out: Record<string, unknown>): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      let value: unknown;
      try {
        value = resolveField(exec, source, selection);
      } catch (err) {
        exec.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[key] = null;
        continue;
      }
      out[key] = completeValue(exec, value, selection.selection);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === source.__type || selection.typeCondition === 'Node') {
        applySelections(exec, source, selection.selection, out);
      }
    } else {
      const fragment = exec.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === source.__type || fragment.typeCondition === 'Node')) {
        applySelections(exec, source, fragment.selection, out);
      }
    }
  }
}

function executeOperation(
  forge: Forge,
  operation: OperationNode,
  fragments: Exec['fragments'],
  variablesIn: Record<string, unknown>,
): { data: Record<string, unknown>; errors: { message: string }[] } {
  const variables: Record<string, unknown> = {};
  for (const [name, defaultValue] of operation.varDefaults) {
    variables[name] = resolveValue(defaultValue, variablesIn);
  }
  Object.assign(variables, variablesIn);
  const exec: Exec = { forge, variables, errors: [], fragments };
  const root = wrap(operation.type === 'mutation' ? 'Mutation' : 'Query', {});
  const data: Record<string, unknown> = {};
  applySelections(exec, root, operation.selection, data);
  return { data, errors: exec.errors };
}

// ------------------------------------------------------------------ the HTTP endpoint

interface OperationRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function runOne(forge: Forge, request: OperationRequest): { data: unknown; errors?: { message: string }[] } {
  if (typeof request.query !== 'string') {
    return { data: null, errors: [{ message: 'A query string is required' }] };
  }
  let document;
  try {
    document = parseGraphql(request.query);
  } catch (err) {
    return { data: null, errors: [{ message: `Syntax Error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'The document holds no operation' }] };
  }
  const variables = (request.variables ?? {}) as Record<string, unknown>;
  let operation = document.operations[0]!;
  if (typeof request.operationName === 'string') {
    operation = document.operations.find((candidate) => candidate.name === request.operationName) ?? operation;
  } else if (document.operations.length > 1) {
    // No operationName with several operations: GitHub errors; the suite always names or sends one.
    const named = document.operations.find((candidate) => candidate.name !== null);
    if (named !== undefined) operation = named;
  }
  const { data, errors } = executeOperation(forge, operation, document.fragments, variables);
  return errors.length > 0 ? { data, errors } : { data };
}

/** Handle POST /api/graphql (single operation or a batched JSON array of them). */
export async function handleGraphql(ctx: Ctx): Promise<void> {
  if (ctx.method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
  if (!ctx.authed) throw new HttpError(401, 'Requires authentication');
  const raw = await readBody(ctx.req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => runOne(ctx.forge, (entry ?? {}) as OperationRequest));
    sendJson(ctx.res, 200, results);
    return;
  }
  const result = runOne(ctx.forge, (body ?? {}) as OperationRequest);
  sendJson(ctx.res, 200, result);
}
