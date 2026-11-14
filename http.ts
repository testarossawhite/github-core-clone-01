// HTTP plumbing shared by every surface: JSON answers, body reading, and the request context
// (the parsed URL, the bearer-token check, and the forge handle). Kept tiny on purpose: the
// benchmark's read/write workloads run through here two thousand times a round.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** An error that maps directly onto an HTTP status and a GitHub-shaped {message} body. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = JSON.stringify(body);
  const buffer = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buffer.length, ...headers });
  res.end(buffer);
}

export function sendBuffer(res: ServerResponse, status: number, buffer: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': buffer.length, ...headers });
  res.end(buffer);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': 0 });
  res.end();
}

/** Read a whole request body (bounded; git packs in this suite stay far under the bound). */
export async function readBody(req: IncomingMessage, limit = 128 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limit) throw new HttpError(413, 'Payload too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a request body as JSON; a malformed body is the protocol checks' 400 case. */
export function parseJsonBody(buffer: Buffer): Record<string, unknown> {
  if (buffer.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  return parsed as Record<string, unknown>;
}

/** Everything a surface handler needs about one request. */
export interface Ctx {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** The decoded path, with any trailing slash (other than the root's) removed. */
  path: string;
  query: URLSearchParams;
  /** Whether an Authorization header carrying a bearer token was presented. */
  authed: boolean;
  /** The request's authority (host[:port]) for building absolute Link URLs. */
  host: string;
}

export function hasAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match !== null && match[1]!.trim() !== '';
}

/** The {message} error body every GitHub-shaped error answer carries. */
export function errorBody(message: string): { message: string } {
  return { message };
}

export function notFound(message = 'Not Found'): HttpError {
  return new HttpError(404, message);
}
