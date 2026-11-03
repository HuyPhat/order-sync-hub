# Graceful Shutdown and Error Handling Implementation Plan

> **Note (2026-10-14):** Task 1 (error-handling middleware) was done by the orders-HTTP-routes work as src/error-handler.ts. Only the graceful-shutdown tasks remain. Its 500 body is the same.
>
> **Refreshed 2026-11-02 against branch `feature/orders-routes` (PR #4):**
> - **Skip Task 1 entirely. Do NOT run its "Replace `src/app.ts`" step**: today's `app.ts` also has the JSON 404/405 handlers, `x-powered-by` disabled and `/orders`; replacing it would delete them. `src/error-handler.ts` already exists and is richer (zod, 4xx, 503).
> - `server.ts` and `server.test.ts` are still in the shape Task 3 expects (verified: `app.listen` callback with the EADDRINUSE branch, three startup tests, no signal handlers).
> - Expected test counts below were recomputed from today's baseline of 150 unit tests: Task 2 gives 158, Task 3 gives 162.
> - If the fail-fast plan (`2026-10-11-fail-fast-db-password.md`) is applied first, the password block sits before `app.listen` and the handlers after it; see its "Interactions" section. Recommended order: fail-fast first (small), then this plan.
> - This plan already satisfies "`server.close()`, then `sequelize.close()`, with a timeout" (10 s; 2 s after a fatal error).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server stop cleanly on Ctrl+C / `SIGTERM` (finish in-flight requests, close the database pool, exit 0), answer unexpected request errors with a safe JSON 500, and exit 1 after fatal process-level errors.

**Architecture:** A small `createShutdown` function (`src/shutdown.ts`) owns the shutdown sequence and is injectable for tests. `src/server.ts` keeps the handle returned by `app.listen` and registers four process handlers that call it. A last Express middleware (`src/error-handler.ts`) turns thrown or rejected route errors into a JSON 500 and logs the detail server-side.

**Tech Stack:** Node 24, Express 5, Sequelize 6, Vitest 5, supertest.

**Spec:** None written. The design was agreed in conversation on 2026-10-10 (question: "how would you handle graceful shutdown and errors that happen after startup?"). It was prototyped and measured in a scratch copy; the numbers are in the Evidence section.

## Status

Planned, **not implemented** (Task 1 is already done elsewhere, so start at Task 2). The working tree must be clean first (`git status --short` prints nothing).

## Global Constraints

- `src/config.ts` is the only file that reads `process.env`.
- Tests never touch a real database or open a real port, and never register real signal handlers in the test process.
- Relative imports end in `.js`; type-only imports use the inline `type` modifier.
- Code is formatted by Prettier: run `pnpm format` after pasting code, and `pnpm format:check` must pass.
- End every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (user preference since 2026-11-02; earlier commits are not rewritten).
- Exit codes: `0` for a clean shutdown; `1` for a cleanup error, a timeout, a second forced signal, or a fatal error.
- Normal shutdown limit: `10_000` ms. After `uncaughtException` / `unhandledRejection`: `2_000` ms.

## Review Focus

1. A request in flight when `SIGTERM` arrives must finish, not be dropped. Pinned by the order test (Task 2) and by manual step 3.5.
2. The database pool must be closed on shutdown. Pinned by the "closes the server and the database pool" test (Task 3).
3. A second Ctrl+C must force an immediate exit 1 instead of waiting. Pinned in Task 2.
4. A hanging request must not hold the process forever: the timeout forces exit 1. Pinned in Task 2.
5. After a fatal error the process must exit 1 within seconds, even if a request never finishes. Pinned in Tasks 2 and 3.
6. No error message or stack trace may reach the client (Express's default page leaks both in development). Pinned in Task 1.
7. `/health` and `/health/db` keep working unchanged. Covered by the existing app tests, which must still pass.

## File Structure

| File | Responsibility |
|---|---|
| `src/error-handler.ts` (create) | Last Express middleware: log detail, answer JSON 500. |
| `src/error-handler.test.ts` (create) | Unit tests against a tiny throw-away Express app. |
| `src/app.errors.test.ts` (create) | Proves the middleware is mounted on the real app. |
| `src/app.ts` (replace) | Same routes, plus `app.use(errorHandler)` last. |
| `src/shutdown.ts` (create) | `createShutdown`: the shutdown sequence, timeout, double-signal guard. |
| `src/shutdown.test.ts` (create) | Unit tests with a fake server and fake timers. |
| `src/server.ts` (replace) | Keep the server handle, register the four process handlers. |
| `src/server.test.ts` (replace) | Existing startup tests plus shutdown wiring tests. |

---

### Task 1: Error-handling middleware

**Files:**
- Create: `src/error-handler.ts`, `src/error-handler.test.ts`, `src/app.errors.test.ts`
- Replace: `src/app.ts`

**Interfaces:**
- Produces: `export const errorHandler: ErrorRequestHandler` from `src/error-handler.ts`.

- [ ] **Step 1: Write the failing tests.**

**Create `src/error-handler.test.ts`:**
```ts
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from './error-handler.js';

// A tiny app: routes that fail in different ways, then the real error handler.
function appWith(route: (app: express.Express) => void) {
  const app = express();
  route(app);
  app.use(errorHandler);
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('errorHandler', () => {
  it('answers a synchronous throw with a JSON 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = appWith((a) =>
      a.get('/x', () => {
        throw new Error('sync detail');
      }),
    );
    const res = await request(app).get('/x');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ status: 'error', message: 'Internal Server Error' });
  });

  it('answers an async rejection with a JSON 500 (Express 5 forwards it)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = appWith((a) =>
      a.get('/x', async () => {
        throw new Error('async detail');
      }),
    );
    const res = await request(app).get('/x');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ status: 'error', message: 'Internal Server Error' });
  });

  it('logs the real error but never sends it to the client', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = appWith((a) =>
      a.get('/x', () => {
        throw new Error('secret detail');
      }),
    );
    const res = await request(app).get('/x');
    expect(logged).toHaveBeenCalledWith('Unhandled request error:', expect.any(Error));
    expect(res.text).not.toMatch(/secret detail|at .*\.(ts|js)/);
  });

  it('delegates to Express when the response has already started', () => {
    const next = vi.fn();
    const error = new Error('late');
    const res = { headersSent: true } as unknown as express.Response;
    errorHandler(error, {} as express.Request, res, next);
    expect(next).toHaveBeenCalledWith(error);
  });
});
```

**Create `src/app.errors.test.ts`:**
```ts
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Own file because vi.mock replaces the module for the whole file.
vi.mock('./db/check.js', () => ({
  checkDatabase: () => Promise.reject(new Error('unexpected failure with secret detail')),
}));

import app from './app.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('app error handling', () => {
  it('turns an unexpected error in a real route into a JSON 500 without leaking it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/health/db');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ status: 'error', message: 'Internal Server Error' });
    expect(res.text).not.toMatch(/secret detail/);
    expect(logged).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run src/error-handler.test.ts src/app.errors.test.ts`
Expected: `error-handler.test.ts` fails to load (`./error-handler.js` not found); `app.errors.test.ts` fails because Express's default handler answers with HTML, not JSON.

- [ ] **Step 3: Implement.**

**Create `src/error-handler.ts`:**
```ts
import type { ErrorRequestHandler } from 'express';

// Last middleware: anything that reached here threw. Log the detail, answer without leaking it.
export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('Unhandled request error:', error);
  res.status(500).json({ status: 'error', message: 'Internal Server Error' });
};
```

**Replace `src/app.ts`:**
```ts
import express, { type Express } from 'express';
import { checkDatabase } from './db/check.js';
import { errorHandler } from './error-handler.js';
const app: Express = express();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Readiness: can we reach MySQL? Kept apart from /health so a database outage
// doesn't fail liveness checks (and the CI smoke test, which runs without a database).
app.get('/health/db', async (_req, res) => {
  const up = await checkDatabase();
  res
    .status(up ? 200 : 503)
    .json(up ? { status: 'ok', db: 'up' } : { status: 'error', db: 'down' });
});

// Must stay last: Express only sends errors to middleware registered after the failing route.
app.use(errorHandler);

export default app;
```

- [ ] **Step 4: Run the whole suite, typecheck and format**

Run: `pnpm format && pnpm test && pnpm typecheck && pnpm format:check`
Expected: all tests pass (40 existing + 5 new = 45); `tsc` prints nothing; `All matched files use Prettier code style!`.

- [ ] **Step 5: Mutation checks.**
(a) In `src/app.ts` delete `app.use(errorHandler);`, run `pnpm vitest run src/app.errors.test.ts`. Expected: FAIL. Restore.
(b) In `src/error-handler.ts` change `message: 'Internal Server Error'` to `message: String(error)`, run `pnpm vitest run src/error-handler.test.ts`. Expected: 3 FAIL. Restore.

- [ ] **Step 6: Commit**
```bash
git add src/error-handler.ts src/error-handler.test.ts src/app.errors.test.ts src/app.ts
git commit -m "feat: answer unexpected request errors with a JSON 500"
```

---

### Task 2: The shutdown sequence

**Files:**
- Create: `src/shutdown.ts`, `src/shutdown.test.ts`

**Interfaces:**
- Produces: `createShutdown({ server, cleanups, timeoutMs?, exit? })` returning `shutdown(reason: string, exitCode?: number, graceMs?: number): Promise<void>`. `server` needs only a `close(cb)` method; `cleanups` is an array of `() => Promise<unknown>`; `exit` defaults to `process.exit` and is injected in tests.

- [ ] **Step 1: Write the failing tests.**

**Create `src/shutdown.test.ts`:**
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShutdown } from './shutdown.js';

// A fake http.Server whose close() calls back at once, or with an error, or never.
function fakeServer(behavior: 'ok' | 'error' | 'hang' = 'ok') {
  return {
    close: vi.fn((cb?: (error?: Error) => void) => {
      if (behavior === 'ok') cb?.();
      if (behavior === 'error') cb?.(new Error('close failed'));
      return undefined as never;
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createShutdown', () => {
  it('closes the server, then runs cleanups, then exits 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const order: string[] = [];
    const server = fakeServer();
    server.close.mockImplementation((cb?: (error?: Error) => void) => {
      order.push('server.close');
      cb?.();
      return undefined as never;
    });
    const exit = vi.fn(() => order.push('exit'));
    const shutdown = createShutdown({
      server,
      cleanups: [async () => void order.push('cleanup')],
      exit,
    });

    await shutdown('SIGTERM');

    expect(order).toEqual(['server.close', 'cleanup', 'exit']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when a cleanup fails, and still exits', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.fn();
    const shutdown = createShutdown({
      server: fakeServer(),
      cleanups: [() => Promise.reject(new Error('pool close failed'))],
      exit,
    });

    await shutdown('SIGTERM');

    expect(logged).toHaveBeenCalledWith('Error during shutdown:', expect.any(Error));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when server.close reports an error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.fn();
    await createShutdown({ server: fakeServer('error'), cleanups: [], exit })('SIGTERM');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('keeps the requested exit code (1 for a fatal error) when shutdown succeeds', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = vi.fn();
    await createShutdown({ server: fakeServer(), cleanups: [], exit })('uncaughtException', 1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('forces exit 1 after the timeout if the server never finishes closing', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.fn();
    const shutdown = createShutdown({
      server: fakeServer('hang'),
      cleanups: [],
      timeoutMs: 10_000,
      exit,
    });

    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('uses a per-call grace period instead of the default timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.fn();
    const shutdown = createShutdown({
      server: fakeServer('hang'),
      cleanups: [],
      timeoutMs: 10_000,
      exit,
    });

    void shutdown('uncaughtException', 1, 2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('forces an immediate exit 1 when called a second time', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = fakeServer('hang');
    const exit = vi.fn();
    const shutdown = createShutdown({ server, cleanups: [], exit });

    void shutdown('SIGINT');
    await shutdown('SIGINT');

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('does not leave a pending timer behind after a clean shutdown', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createShutdown({ server: fakeServer(), cleanups: [], exit: vi.fn() })('SIGTERM');
    expect(vi.getTimerCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run src/shutdown.test.ts`
Expected: FAIL, `./shutdown.js` not found.

- [ ] **Step 3: Implement.**

**Create `src/shutdown.ts`:**
```ts
import type { Server } from 'node:http';

interface ShutdownOptions {
  server: Pick<Server, 'close'>;
  cleanups: Array<() => Promise<unknown>>;
  timeoutMs?: number;
  exit?: (code: number) => void;
}

// Returns a function that stops accepting connections, lets in-flight requests finish, runs the
// cleanups (e.g. close the database pool), then exits. Calling it a second time forces an exit.
export function createShutdown({
  server,
  cleanups,
  timeoutMs = 10_000,
  exit = process.exit,
}: ShutdownOptions) {
  let started = false;

  return async function shutdown(
    reason: string,
    exitCode = 0,
    graceMs = timeoutMs,
  ): Promise<void> {
    if (started) {
      console.error(`${reason}: already shutting down, forcing exit`);
      exit(1);
      return;
    }
    started = true;
    console.log(`${reason}: shutting down`);

    const timer = setTimeout(() => {
      console.error(`Shutdown did not finish in ${graceMs}ms, forcing exit`);
      exit(1);
    }, graceMs);
    timer.unref();

    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all(cleanups.map((cleanup) => cleanup()));
    } catch (error) {
      console.error('Error during shutdown:', error);
      exitCode = 1;
    }

    clearTimeout(timer);
    exit(exitCode);
  };
}
```

- [ ] **Step 4: Run, typecheck, format**

Run: `pnpm format && pnpm test && pnpm typecheck && pnpm format:check`
Expected: `158 passed` (150 existing + 8 new; the plan's original 53 predates the orders work); clean typecheck and format.

- [ ] **Step 5: Mutation checks.** Apply one at a time to `src/shutdown.ts`, run `pnpm vitest run src/shutdown.test.ts`, expect FAIL, then restore:
(a) change `if (started) {` to `if (false) {`;
(b) delete `clearTimeout(timer);`;
(c) delete `exitCode = 1;`;
(d) change `}, graceMs);` to `}, timeoutMs);`.

- [ ] **Step 6: Commit**
```bash
git add src/shutdown.ts src/shutdown.test.ts
git commit -m "feat: add createShutdown for graceful server shutdown"
```

---

### Task 3: Wire it into the server

**Files:**
- Replace: `src/server.ts`, `src/server.test.ts`

**Interfaces:**
- Consumes: `createShutdown` (Task 2), `sequelize` from `src/db/sequelize.js` (existing), `app` (Task 1 version, unchanged exports).

- [ ] **Step 1: Write the failing tests.** **Replace `src/server.test.ts`** with the existing three startup tests (unchanged in behavior) plus four shutdown tests. `startWith` now also captures `process.on` registrations so no real signal handler is installed in the test process:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

type Handler = (...args: unknown[]) => void;

// Imports server.ts with app.listen mocked to report `outcome` to its callback, the way
// Express 5 does: no argument when listening works, the error when it fails. process.on is
// captured (not registered) so tests never install real signal handlers.
async function startWith(outcome: Error | undefined) {
  vi.stubEnv('PORT', '4321');
  vi.resetModules();
  const { default: app } = await import('./app.js');
  const { sequelize } = await import('./db/sequelize.js');
  const server = { close: vi.fn((cb?: (error?: Error) => void) => cb?.()) };
  vi.spyOn(app, 'listen').mockImplementation(((_port: number, cb: (e?: Error) => void) => {
    cb(outcome);
    return server;
  }) as never);
  const handlers = new Map<string, Handler>();
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: Handler) => {
    handlers.set(event, handler);
    return process;
  }) as never);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const closePool = vi.spyOn(sequelize, 'close').mockResolvedValue(undefined);
  await import('./server.js');
  return { log, error, exit, handlers, server, closePool };
}

describe('server startup', () => {
  it('logs success and does not exit when listening works', async () => {
    const { log, error, exit } = await startWith(undefined);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('4321'));
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('reports a busy port, exits 1 and never claims success', async () => {
    const busy = Object.assign(new Error('listen EADDRINUSE: address already in use :::4321'), {
      code: 'EADDRINUSE',
    });
    const { log, error, exit } = await startWith(busy);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('port 4321 is already in use'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('exits 1 with the error message for any other listen failure', async () => {
    const denied = Object.assign(new Error('listen EACCES: permission denied'), {
      code: 'EACCES',
    });
    const { log, error, exit } = await startWith(denied);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('server shutdown', () => {
  it('registers handlers for both signals and both fatal-error events', async () => {
    const { handlers } = await startWith(undefined);
    expect([...handlers.keys()].sort()).toEqual([
      'SIGINT',
      'SIGTERM',
      'uncaughtException',
      'unhandledRejection',
    ]);
  });

  it('on SIGTERM closes the server and the database pool, then exits 0', async () => {
    const { handlers, server, closePool, exit } = await startWith(undefined);
    handlers.get('SIGTERM')?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(closePool).toHaveBeenCalledTimes(1);
  });

  it('on an uncaught exception logs it and exits 1', async () => {
    const { handlers, error, exit } = await startWith(undefined);
    handlers.get('uncaughtException')?.(new Error('boom'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(error).toHaveBeenCalledWith('Uncaught exception:', expect.any(Error));
  });

  it('on an unhandled rejection logs it and exits 1', async () => {
    const { handlers, error, exit } = await startWith(undefined);
    handlers.get('unhandledRejection')?.(new Error('nope'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(error).toHaveBeenCalledWith('Unhandled rejection:', expect.any(Error));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run src/server.test.ts`
Expected: the 3 startup tests pass; the 4 shutdown tests FAIL (no handlers are registered yet).

- [ ] **Step 3: Implement.** **Replace `src/server.ts`:**
```ts
import app from './app.js';
import { config } from './config.js';
import { sequelize } from './db/sequelize.js';
import { createShutdown } from './shutdown.js';

// Express 5 also calls this callback when listening fails, passing the error.
const server = app.listen(config.port, (error?: Error) => {
  if (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `port ${config.port} is already in use`
        : error.message;
    console.error(`Failed to start server: ${reason}`);
    process.exit(1);
  } else {
    console.log(`Server is running on port ${config.port} (${config.nodeEnv})`);
  }
});

// After a fatal error the process state is unreliable: give in-flight work a short grace, then go.
const FATAL_GRACE_MS = 2_000;
const shutdown = createShutdown({ server, cleanups: [() => sequelize.close()] });

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  void shutdown('uncaughtException', 1, FATAL_GRACE_MS);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  void shutdown('unhandledRejection', 1, FATAL_GRACE_MS);
});
```
The handlers are registered right after `app.listen` returns, not inside its callback: with a synchronous mock the callback would run before `server` is assigned.

- [ ] **Step 4: Run, typecheck, format, build**

Run: `pnpm format && pnpm test && pnpm typecheck && pnpm format:check && rm -rf dist && pnpm build && echo build-ok`
Expected: `Tests  162 passed (162)` (158 + 4 new shutdown tests; the three startup tests are kept); clean typecheck and format; `build-ok`.

- [ ] **Step 5: Mutation checks.** Apply one at a time, run `pnpm vitest run src/server.test.ts`, expect FAIL, restore:
(a) in `src/server.ts` change `cleanups: [() => sequelize.close()]` to `cleanups: []`;
(b) change `void shutdown('uncaughtException', 1, FATAL_GRACE_MS);` to use exit code `0`.

- [ ] **Step 6: Verify with real processes** (needs MySQL running; `pnpm build` done). Use the free ports shown, and check there are no stray servers afterwards (`pgrep -fl dist/server.js`).

3.1 **Normal start and Ctrl+C.** Run `node --env-file=.env dist/server.js`, press Ctrl+C. Expected output: `Server is running ...`, `SIGINT: shutting down`, the prompt returns at once; `echo $?` prints `0`.

3.2 **A request in flight survives SIGTERM.** A host that drops packets makes `/health/db` take 2 s, which gives a real in-flight request without any test-only route:
```bash
MYSQL_HOST=192.0.2.1 PORT=3170 node --env-file=.env dist/server.js &
SERVER=$!; sleep 1.5
curl -s -o /dev/null -w 'in-flight: HTTP %{http_code} after %{time_total}s\n' localhost:3170/health/db &
sleep 0.5; kill -TERM $SERVER
wait $SERVER; echo "server exit code: $?"; wait
```
Expected: `in-flight: HTTP 503 after 2.0...s` (a real answer, not `HTTP 000`), `server exit code: 0`, and the server log shows `SIGTERM: shutting down`.

3.3 **Fatal error exits 1.** A one-off script imports the server, then throws outside any request:
```bash
PORT=3171 node --env-file=.env --input-type=module -e "import './dist/server.js'; setTimeout(() => { throw new Error('test crash'); }, 1500)"; echo "exit code: $?"
```
Expected: `Uncaught exception: Error: test crash`, `uncaughtException: shutting down`, `exit code: 1`.

3.4 **Port conflict still fails fast** (previous fix): start two servers with the same `PORT`; the second prints `Failed to start server: port ... is already in use` and exits 1.

3.5 **Second Ctrl+C forces exit.** Repeat 3.2 but send `kill -INT $SERVER` twice, 0.3 s apart. Expected: `SIGINT: already shutting down, forcing exit`, exit code 1, well under 2 s.

- [ ] **Step 7: Run the project checks the CI runs, then commit**

Run: `pnpm typecheck && pnpm format:check && pnpm test && bash scripts/smoke.sh` (smoke needs `pnpm build` first).
Expected: all pass; `health: {"status":"ok"}`.
```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: shut down gracefully on SIGINT/SIGTERM and exit 1 on fatal errors"
```

---

## Evidence behind the design (prototype, 2026-10-10)

Measured in a scratch copy against a real server and your MySQL container:

| Scenario | Before (committed code) | Prototype |
|---|---|---|
| `SIGTERM` during an in-flight request | killed, exit 143, request dropped (`HTTP 000`) | request completes `HTTP 200`, exit 0 after 2.57 s |
| New request while draining | n/a | refused |
| Ctrl+C with an idle keep-alive connection | n/a | exit 0 in 35 ms |
| Second Ctrl+C while draining | n/a | forced exit 1 after 365 ms |
| Route throws, sync or async | HTML page; in development it contains the stack trace and file paths | JSON 500, server stays alive, detail only in the log |
| Uncaught exception with a request left hanging | process dies with a stack trace | exit 1 after 2.05 s |
| Ctrl+C under `pnpm dev` (`tsx watch`) | n/a | exit 0 in 38 ms, port freed |

One flaw the prototype exposed and the design fixes: with a single 10 s limit, a crash while a request never finishes held the process open for the full 10 s. Fatal errors therefore use a separate 2 s grace period.

## Follow-ups (not in this plan)

- **Drain readiness first.** Flip `/health/db` to 503 as soon as shutdown starts so a load balancer stops routing before the server stops accepting. Needs a small shared "draining" flag; matters once a load balancer exists.
- **Docker:** run `CMD ["node", "dist/server.js"]` directly, not via `pnpm start`, or `SIGTERM` reaches pnpm instead of Node. Untested: the app does not run in Docker yet.
- **Configurable limits** (`SHUTDOWN_TIMEOUT_MS` in `src/config.ts`) if 10 s / 2 s prove wrong.
- **Request timeouts** (`server.requestTimeout`, `headersTimeout`) and structured logging.
- **Dev note:** under `tsx watch`, tsx also force-kills the child ("Previous process hasn't exited yet"), so the graceful path is cut short in development. Harmless.
- Not measured: whether MySQL's own log shows a difference between a closed and an abandoned pool connection.

## Self-Review

- **Coverage:** graceful shutdown (Tasks 2 and 3), errors after startup in requests (Task 1) and in the process (Task 3 handlers), plus manual proofs (3.1 to 3.5).
- **Placeholders:** none; every file is given in full.
- **Consistency:** `createShutdown` options and the `shutdown(reason, exitCode, graceMs)` signature are identical in Tasks 2 and 3; `errorHandler` is imported by name in `app.ts`.
- **Plan verification (2026-10-10):** the code blocks in this file were extracted mechanically into a fresh scratch copy of the project, task by task. Results: Task 1 gives 45 tests, Task 2 gives 53, Task 3 gives 57, each with a clean typecheck and format check, and the build exits 0. Eight mutations (dropping the pool cleanup, removing the double-signal guard, never clearing the timer, swallowing errors, ignoring the per-call grace, fatal errors exiting 0, not mounting the error handler, leaking the error message) were each caught by a test.
- **Real-process steps, run against MySQL on 2026-10-10:** 3.1 Ctrl+C exits 0 with `SIGINT: shutting down`; 3.2 the in-flight request returns `HTTP 503 after 2.01s` and the server exits 0; 3.3 `uncaughtException: shutting down`, exit 1; 3.4 `Failed to start server: port ... is already in use`, exit 1; 3.5 second SIGINT forces exit 1 after 361 ms. `scripts/smoke.sh` still passes (its server now also logs `SIGTERM: shutting down` when the script stops it, which is harmless).
- **Not verified:** the Docker behavior in the follow-ups, and whether MySQL's own log distinguishes a closed pool from an abandoned one.
