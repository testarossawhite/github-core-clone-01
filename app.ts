// The forge's HTTP server: one process serving the health probe, git smart HTTP, the REST v3
// API under /api/v3, GraphQL at /api/graphql and MCP at /mcp. main.ts owns the entry<->env
// lifecycle (register, poll /done); this file is only the request surface.
//
// Every response — success or error, on every surface — carries a non-empty
// X-GitHub-Request-Id header (a deterministic per-process counter, never a clock or random
// value, so nothing about it can leak into a replay difference).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { errorBody, hasAuth, HttpError, sendEmpty, sendJson, type Ctx } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './gitproto.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  let requestCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    res.setHeader('x-github-request-id', `forge-${requestCounter}`);
    void dispatch(forge, req, res).catch((err: unknown) => {
      // A handler bug must never take the process down mid-trial: answer 500 and keep serving.
      try {
        if (!res.headersSent) {
          if (err instanceof HttpError) sendJson(res, err.status, errorBody(err.message));
          else sendJson(res, 500, errorBody('Internal Server Error'));
        } else if (!res.writableEnded) {
          res.end();
        }
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
  // Long-lived keep-alive sockets are the benchmark's shape; idle ones must not linger forever.
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}

async function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const method = req.method ?? 'GET';
  const ctx: Ctx = {
    forge,
    req,
    res,
    method,
    path,
    query: url.searchParams,
    authed: hasAuth(req),
    host: req.headers.host ?? 'localhost',
  };

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/graphql') {
    await handleGraphql(ctx);
    return;
  }
  if (path === '/mcp') {
    await handleMcp(ctx);
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(ctx, path === '/api/v3' ? '/' : path.slice('/api/v3'.length));
    return;
  }
  if (await handleGit(ctx)) return;

  if (method === 'DELETE') {
    sendEmpty(res, 404);
    return;
  }
  sendJson(res, 404, errorBody('Not Found'));
}
