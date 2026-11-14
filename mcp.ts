// The MCP endpoint at POST /mcp: JSON-RPC 2.0 over the streamable-HTTP shape the suite's
// client speaks. The modern era (2026-07-28) is served statelessly — `server/discover`
// answers identity, capabilities and supported versions in one request, and no session is
// ever issued — and the legacy handshake (`initialize` + `notifications/initialized`) is
// answered too, echoing any of the legacy revisions the client offers. The tools are
// github-mcp-server's six repository tools plus list/get helpers, all executed against the
// same store the REST surface serves, so an object created over MCP is the same object
// over REST (the rest-parity check judges exactly that).

import { VIEWER, branchTip, performMerge, type Forge, type RepoRec } from './store.ts';
import { mergeBase } from './gitcore.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { HttpError, readBody, sendEmpty, sendJson, type Ctx } from './http.ts';

const SERVER_INFO = Object.freeze({ name: 'github-core-clone', version: '1.0.0' });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

// ------------------------------------------------------------------ tool definitions

function objectSchema(properties: Record<string, unknown>, required: readonly string[]) {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}

function stringProp(description: string) {
  return { type: 'string', description };
}

const OWNER_REPO = {
  owner: stringProp('The repository owner (the token user)'),
  repo: stringProp('The repository name'),
};

/** The tool list: one constant array, so two tools/list answers are byte-identical. */
const TOOLS = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the token user',
    inputSchema: objectSchema(
      {
        name: stringProp('The repository name'),
        description: stringProp('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: objectSchema({ ...OWNER_REPO }, ['owner', 'repo']),
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the token user',
    inputSchema: objectSchema({ owner: stringProp('The repository owner (defaults to the token user)') }, []),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: objectSchema(
      { ...OWNER_REPO, title: stringProp('The issue title'), body: stringProp('The issue body') },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state',
    inputSchema: objectSchema(
      { ...OWNER_REPO, state: stringProp('Issue state filter: open, closed or all') },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number',
    inputSchema: objectSchema(
      { ...OWNER_REPO, issue_number: { type: 'number', description: 'The issue number' } },
      ['owner', 'repo', 'issue_number'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch',
    inputSchema: objectSchema(
      {
        ...OWNER_REPO,
        title: stringProp('The pull request title'),
        body: stringProp('The pull request body'),
        head: stringProp('The head branch name'),
        base: stringProp('The base branch name'),
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number',
    inputSchema: objectSchema(
      {
        ...OWNER_REPO,
        pull_number: { type: 'number', description: 'The pull request number' },
        merge_method: stringProp('The merge method: merge, squash or rebase'),
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
]);

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

// ------------------------------------------------------------------ tool execution

type ToolOutcome = { ok: true; value: unknown } | { ok: false; message: string };

function toolRepo(forge: Forge, args: Record<string, unknown>): RepoRec | null {
  const owner = args.owner;
  const repo = args.repo;
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  return forge.repo(owner, repo);
}

function runTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name;
      if (typeof repoName !== 'string' || repoName === '') return { ok: false, message: 'create_repo: a name is required' };
      if (forge.repo(VIEWER.login, repoName) !== null) return { ok: false, message: `create_repo: ${repoName} already exists` };
      const repo = forge.createRepo(
        VIEWER.login,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return { ok: true, value: repoJson(forge, repo) };
    }
    case 'get_repo': {
      const repo = toolRepo(forge, args);
      if (repo === null) return { ok: false, message: 'get_repo: the repository does not exist' };
      return { ok: true, value: repoJson(forge, repo) };
    }
    case 'list_repos': {
      return { ok: true, value: forge.viewerRepos().map((repo) => repoJson(forge, repo)) };
    }
    case 'create_issue': {
      const repo = toolRepo(forge, args);
      if (repo === null) return { ok: false, message: 'create_issue: the repository does not exist' };
      const title = args.title;
      if (typeof title !== 'string' || title === '') return { ok: false, message: 'create_issue: a title is required' };
      const sec = forge.tick();
      const issue = {
        number: repo.nextIssueNumber,
        gid: forge.allocIssueGid(),
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [],
        createdSec: sec,
        updatedSec: sec,
        closedSec: null,
        version: 1,
      };
      repo.nextIssueNumber += 1;
      repo.issues.set(issue.number, issue);
      return { ok: true, value: issueJson(forge, repo, issue) };
    }
    case 'list_issues': {
      const repo = toolRepo(forge, args);
      if (repo === null) return { ok: false, message: 'list_issues: the repository does not exist' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      return { ok: true, value: issues.map((issue) => issueJson(forge, repo, issue)) };
    }
    case 'get_issue': {
      const repo = toolRepo(forge, args);
      if (repo === null) return { ok: false, message: 'get_issue: the repository does not exist' };
      const number = Number(args.issue_number);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (issue === undefined) return { ok: false, message: 'get_issue: the issue does not exist' };
      return { ok: true, value: issueJson(forge, repo, issue) };
    }
    case 'create_pull_request': {
      const repo = toolRepo(forge, args);
      if (repo === null) return { ok: false, message: 'create_pull_request: the repository does not exist' };
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const headTip = branchTip(repo, head);
      const baseTip = branchTip(repo, base);
      if (headTip === null) return { ok: false, message: `create_pull_request: the head branch ${head} does not exist` };
      if (baseTip === null) return { ok: false, message: `create_pull_request: the base branch ${base} does not exist` };
      if (mergeBase(repo.objects, baseTip, headTip) === headTip) {
        return { ok: false, message: 'create_pull_request: there are no commits between base and head' };
      }
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return { ok: true, value: pullJson(forge, repo, existing) };
        }
      }
      const sec = forge.tick();
      const pull = {
        number: repo.nextPullNumber,
        gid: forge.allocPullGid(),
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
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
      return { ok: true, value: pullJson(forge, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = toolRepo(forge, args);
      if (repo === null) return { ok: false, message: 'merge_pull_request: the repository does not exist' };
      const number = Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return { ok: false, message: 'merge_pull_request: the pull request does not exist' };
      if (pull.state !== 'open' || pull.merged) return { ok: false, message: 'merge_pull_request: the pull request is not open' };
      const methodRaw = typeof args.merge_method === 'string' ? args.merge_method : 'merge';
      const method = methodRaw === 'squash' || methodRaw === 'rebase' ? methodRaw : 'merge';
      const message = method === 'squash' ? `${pull.title}\n\n${pull.body}` : pull.title;
      const sha = performMerge(forge, repo, pull.baseRef, pull.headRef, method, message);
      if (sha === null) return { ok: false, message: 'merge_pull_request: the pull request is not mergeable' };
      const sec = forge.tick();
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedSec = sec;
      pull.closedSec = sec;
      pull.updatedSec = sec;
      pull.mergeCommitSha = sha;
      return { ok: true, value: pullJson(forge, repo, pull) };
    }
    default:
      return { ok: false, message: `Unknown tool: ${name}` };
  }
}

/** A required-argument check against the tool's own schema; returns the missing names. */
function missingRequired(name: string, args: Record<string, unknown>): string[] {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return [];
  const required = (tool.inputSchema as { required?: string[] }).required ?? [];
  return required.filter((key) => args[key] === undefined || args[key] === null);
}

// ------------------------------------------------------------------ JSON-RPC handling

interface RpcOutcome {
  status: number;
  body: Record<string, unknown> | null; // null: answer with no body (a notification)
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id as string | number | null, result } };
}

function rpcError(id: unknown, code: number, message: string): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id as string | number | null, error: { code, message } } };
}

function handleRpc(forge: Forge, message: Record<string, unknown>): RpcOutcome {
  const method = message.method;
  const id = message.id;
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (id === undefined || id === null) {
    // A notification (notifications/initialized and friends): accepted, never answered.
    return { status: 202, body: null };
  }
  if (typeof method !== 'string') return rpcError(id, METHOD_NOT_FOUND, 'Method not found');
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests, driven by tools.',
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-06-18';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !TOOL_NAMES.has(name)) {
        return rpcError(id, INVALID_PARAMS, `Unknown tool: ${typeof name === 'string' ? name : ''}`);
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const missing = missingRequired(name, args);
      if (missing.length > 0) return rpcError(id, INVALID_PARAMS, `Missing required argument(s): ${missing.join(', ')}`);
      const outcome = runTool(forge, name, args);
      if (!outcome.ok) {
        return rpcResult(id, { content: [{ type: 'text', text: outcome.message }], isError: true });
      }
      const text = JSON.stringify(outcome.value);
      return rpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.value,
        isError: false,
      });
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** Handle one request to /mcp (any method; POST carries the JSON-RPC traffic). */
export async function handleMcp(ctx: Ctx): Promise<void> {
  if (ctx.method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
  if (!ctx.authed) throw new HttpError(401, 'Unauthorized');
  const raw = await readBody(ctx.req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(ctx.res, 400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(body)) {
    const answers: Record<string, unknown>[] = [];
    for (const entry of body) {
      if (entry !== null && typeof entry === 'object') {
        const outcome = handleRpc(ctx.forge, entry as Record<string, unknown>);
        if (outcome.body !== null) answers.push(outcome.body);
      }
    }
    sendJson(ctx.res, 200, answers);
    return;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(ctx.res, 400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
    return;
  }
  const outcome = handleRpc(ctx.forge, body as Record<string, unknown>);
  if (outcome.body === null) {
    sendEmpty(ctx.res, outcome.status);
    return;
  }
  sendJson(ctx.res, outcome.status, outcome.body);
}
