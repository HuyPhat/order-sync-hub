# Graceful Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On SIGTERM or SIGINT the server stops accepting connections, lets in-flight requests finish, closes the Sequelize pool, then exits 0 (or exits 1 after a 10 s deadline).

**Architecture:** A small pure module `src/shutdown.ts` builds a `shutdown(signal)` function from injected dependencies (server, closeDb, exit, log, timeout), so it is unit-testable with fake timers. `src/server.ts` keeps the `http.Server` returned by `app.listen` and registers the signal handlers.

**Tech Stack:** Node 24 `http.Server`, Express 5, Sequelize 6, Vitest.

**Spec:** this document. Today `src/server.ts` calls `app.listen(...)`, discards the returned server and never closes Sequelize, so a SIGTERM (deploy, container stop) cuts requests off and drops MySQL connections.

## Global Constraints

- Signals handled: `SIGTERM` and `SIGINT`.
- Deadline: `10_000` ms (`SHUTDOWN_TIMEOUT_MS`), then exit code `1`.
- Clean shutdown exits `0`; any error while closing exits `1`.
- ESM with `.js` import suffixes; `pnpm typecheck`, `pnpm format:check` (prettier on `src`) and `pnpm test` must pass.
- `/health` must keep working with no database configured, so the Sequelize import stays lazy.

## Review Focus

- A second signal during shutdown: a second signal of a *different* kind is ignored by the `shuttingDown` guard (no second close); a second identical signal is deliberately not intercepted (`process.once`), so it force-quits via Node's default - conventional for double Ctrl-C.
- Idle keep-alive sockets: must not hold the process open until the deadline (`closeIdleConnections`).
- `server.close` reporting an error (e.g. server was not running): DB still closed, exit `1`.
- `sequelize.close()` rejecting: logged, exit `1`, never hangs.
- Shutdown finishing normally must not leave the 10 s timer pending (timer is `unref`'d and cleared).

## File Structure

- Create `src/shutdown.ts`: `createShutdown`, `SHUTDOWN_TIMEOUT_MS`. One responsibility: the shutdown sequence.
- Create `src/shutdown.test.ts`: unit tests with fakes and fake timers.
- Modify `src/server.ts`: keep the server handle, register handlers.
- Modify `src/server.test.ts`: the `listen` mock returns `{}`; it must return a fake server, and add wiring tests.

---

### Task 1: `createShutdown`

**Files:**
- Create: `src/shutdown.ts`
- Test: `src/shutdown.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SHUTDOWN_TIMEOUT_MS = 10_000;
  export interface ShutdownDeps {
    server: Pick<import('node:http').Server, 'close' | 'closeIdleConnections'>;
    closeDb: () => Promise<void>;
    exit: (code: number) => void;
    log: (message: string) => void;
    timeoutMs?: number; // default SHUTDOWN_TIMEOUT_MS
  }
  export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests** in `src/shutdown.test.ts` (`vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in `afterEach`). A `makeDeps()` helper returns a fake server whose `close(cb)` calls `cb()` (overridable to call `cb(new Error('not running'))` or never call back), plus `vi.fn()` for `closeDb`, `exit`, `log`. Tests, with assertions:
  - `closes the server, then the database, then exits 0`: after `await shutdown('SIGTERM')`, `close` called once, `closeIdleConnections` called once, `closeDb` called once, `exit` called once with `0`; call order server-close → closeDb checked via `mock.invocationCallOrder`.
  - `waits for in-flight requests before closing the database`: `close` callback held; after `shutdown()` is started, `closeDb` not called; after invoking the held callback and awaiting, `closeDb` called.
  - `ignores a second signal while shutting down`: call `shutdown('SIGINT')` twice; `close` and `closeDb` each called once, `exit` once.
  - `exits 1 when the server does not finish closing within the timeout`: `close` never calls back; `vi.advanceTimersByTimeAsync(10_000)`; `exit` called with `1` and not before 10_000 ms.
  - `honours a custom timeoutMs`: `timeoutMs: 50`, advance 50, `exit(1)`.
  - `still closes the database and exits 1 when server.close errors`: `closeDb` called once, `exit` called once with `1`.
  - `exits 1 when closing the database fails`: `closeDb` rejects; `exit(1)`; the error message is passed to `log`.
  - `does not leave a pending timer after a clean shutdown`: `vi.getTimerCount()` is `0` after `await shutdown('SIGTERM')`.

- [ ] **Step 2: Run to verify it fails.**
  Run: `pnpm vitest run src/shutdown.test.ts`
  Expected: FAIL, cannot resolve `./shutdown.js`.

- [ ] **Step 3: Implement `createShutdown`** in `src/shutdown.ts`. Keep a `shuttingDown` flag (second call returns immediately). Log `Received <signal>, shutting down...`. Start `setTimeout(() => { log('Shutdown timed out'); exit(1); }, timeoutMs)` and `.unref()` it. Wrap `server.close(cb)` in a Promise that resolves with the callback's error (not rejecting), call `server.closeIdleConnections()` right after `close`, then keep sweeping with `setInterval(() => server.closeIdleConnections(), 100)` (unref'd, cleared when the close callback fires or on any other exit path) so keep-alive sockets that go idle during the drain do not wait for keepAliveTimeout. Then `await closeDb()` in try/catch (log the message, remember failure). `clearTimeout`, then `exit(failed ? 1 : 0)`. Ensure `exit` is called at most once (the timeout path and the normal path must not both fire: guard with a `done` flag).

- [ ] **Step 4: Run to verify it passes.**
  Run: `pnpm vitest run src/shutdown.test.ts`
  Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**
  ```bash
  git add src/shutdown.ts src/shutdown.test.ts
  git commit -m "feat: add createShutdown sequence with deadline"
  ```

---

### Task 2: Wire into `src/server.ts`

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

**Interfaces:**
- Consumes: `createShutdown`, `SHUTDOWN_TIMEOUT_MS` (Task 1).
- Produces: nothing new; behaviour only.

- [ ] **Step 1: Update the test helper and write failing tests** in `src/server.test.ts`.
  - In `startWith`, make the `listen` mock return a fake server `{ close: vi.fn((cb) => cb()), closeIdleConnections: vi.fn() }` instead of `{}`, and return it from `startWith` as `server`. Also spy `process.once` is not needed; use `vi.spyOn(process, 'once')` to capture handlers into `handlers: Record<string, () => void>` and return it, so listeners never accumulate across `vi.resetModules()` imports.
  - New `describe('server shutdown')` tests:
    - `registers SIGTERM and SIGINT handlers`: `Object.keys(handlers)` contains both.
    - `SIGTERM closes the server and exits 0`: invoke `handlers.SIGTERM()`, `await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))`, `server.close` called once.
    - `does not register handlers when listening fails`: with the EADDRINUSE outcome, `exit` called with `1` only, and `server.close` never called.

- [ ] **Step 2: Run to verify the new tests fail.**
  Run: `pnpm vitest run src/server.test.ts`
  Expected: FAIL on the three new tests; the existing tests still pass.

- [ ] **Step 3: Modify `src/server.ts`.** Assign `const server = app.listen(...)`. After the existing `listen` callback logic, build `const shutdown = createShutdown({ server, closeDb: async () => { const { sequelize } = await import('./db/sequelize.js'); await sequelize.close(); }, exit: process.exit, log: console.log })` and register `process.once('SIGTERM', () => void shutdown('SIGTERM'))` and the same for `SIGINT`. Registration happens only on the success path of the `listen` callback (so a failed listen never installs handlers). `exit` must be passed as `(code) => process.exit(code)` so the test's `process.exit` spy is honoured.

- [ ] **Step 4: Run the full fast checks.**
  Run: `pnpm typecheck && pnpm format:check && pnpm test`
  Expected: all pass. If `format:check` fails, run `pnpm format` and re-run.

- [ ] **Step 5: Manual check against a real process.**
  Run: `PORT=3999 pnpm dev` in one shell; in another: `curl -s localhost:3999/health` then `kill -TERM <pid>` (use `pgrep -f "src/server.ts"`).
  Expected: log shows `Received SIGTERM, shutting down...`, the process exits with status 0 within a second (idle keep-alive connection from curl must not delay it).

- [ ] **Step 6: Commit**
  ```bash
  git add src/server.ts src/server.test.ts
  git commit -m "feat: shut down gracefully on SIGTERM and SIGINT"
  ```

---

## Self-Review

- Coverage: sequence (Task 1), wiring (Task 2), every Review Focus line has a test (second signal, idle sockets via manual check + `closeIdleConnections` assertion, close error, DB error, timer cleanup).
- Types: `ShutdownDeps`/`createShutdown`/`SHUTDOWN_TIMEOUT_MS` named identically in both tasks.
- Out of scope: `/health` returning 503 while draining (only needed behind a readiness-checking load balancer).
