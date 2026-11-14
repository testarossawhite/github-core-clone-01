import { createApp } from './app.ts';

// Trial entrypoint: host the forge, tell the harness where it is listening,
// then remain alive until the harness reports that the trial has ended.
const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 250;
const LAST_RETRY_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffAfter(attempt: number): number {
  return Math.min(LAST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(attempt, 8));
}

async function announcePort(port: number): Promise<void> {
  // A 409 is a successful outcome for us: an earlier process registered
  // first. Bad-request style replies are contract errors and stop the entry.
  for (let attempt = 0; ; attempt += 1) {
    let retry = false;
    try {
      const reply = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`registration refused with HTTP ${reply.status}: ${await reply.text()}`);
      }
      retry = true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('registration refused with HTTP ')) throw error;
      retry = true;
    }
    if (retry) await delay(backoffAfter(attempt));
  }
}

async function awaitCompletion(): Promise<void> {
  // Polling is deliberate: the harness replies at once, with done=false
  // while the trial is still running.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Unreachable or timed-out harness means "not done", never "stop".
    }
    await delay(backoffAfter(attempt));
  }
}

async function serve(): Promise<void> {
  if (envUrl === '') {
    throw new Error('MAKEFUN_ENV_URL is not set, so there is no harness to register with');
  }
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind to a TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);
  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the harness to finish\n');
  await awaitCompletion();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await serve();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
}
