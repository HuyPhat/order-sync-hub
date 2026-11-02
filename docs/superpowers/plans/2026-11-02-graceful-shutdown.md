# Graceful shutdown (SIGTERM / SIGINT)

Status: open. Verified against `src/server.ts`: it calls `app.listen(...)` and discards the
returned `http.Server`, and nothing closes Sequelize. A SIGTERM (deploy, container stop) kills the
process mid-request and drops open MySQL connections.

## Goal
On SIGTERM or SIGINT: stop accepting connections, let in-flight requests finish, close the
Sequelize pool, then exit 0. If that takes longer than 10 s, exit 1.

## Steps
1. **Extract the logic** into `src/shutdown.ts`, a pure function that is easy to test:
   `createShutdown({ server, closeDb, timeoutMs, exit, log })` returns an async `shutdown(signal)`.
   - Idempotent: a second signal while shutting down is ignored (log once).
   - `server.close()` wrapped in a promise; call `server.closeIdleConnections()` right after so
     keep-alive sockets don't hold the process open (Node 19+; we run Node 24).
   - Then `await closeDb()` (`sequelize.close()`).
   - A `setTimeout(timeoutMs).unref()` fallback calls `exit(1)`; success calls `exit(0)`.
2. **Wire it in `src/server.ts`**: keep the `listen` return value (`const server = app.listen(...)`),
   register `process.once('SIGTERM', ...)` and `process.once('SIGINT', ...)`.
   Import `sequelize` lazily (inside `closeDb`) so `/health` startup is unchanged when no DB is configured.
3. **Tests** (`src/shutdown.test.ts`, vitest, fake timers, fake server/closeDb):
   - closes server then DB, exits 0;
   - second signal is ignored;
   - exits 1 when the server never finishes closing within `timeoutMs`;
   - still closes the DB / exits 1 if `server.close` reports an error.
4. **Manual check**: `pnpm dev`, start a slow request, send `kill -TERM <pid>`; the request completes, the process exits 0.

## Out of scope
- `/health` flipping to 503 while draining (only needed behind a load balancer with readiness checks).

## Done when
`pnpm typecheck && pnpm format:check && pnpm test` pass and the manual check behaves as above.
