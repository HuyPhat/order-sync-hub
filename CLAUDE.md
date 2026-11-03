# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is pnpm; CI runs Node 24. Source is ESM TypeScript: relative imports need the `.js` suffix (`import { x } from './x.js'`).

```bash
pnpm dev                      # tsx watch src/server.ts (PORT defaults to 3000)
pnpm typecheck                # tsc --noEmit
pnpm format / format:check    # prettier on src (single quotes, width 100)
pnpm build / start            # tsc -p tsconfig.build.json -> dist/, node dist/server.js

pnpm test                     # unit tests, no database needed
pnpm vitest run src/routes/orders.test.ts            # one file
pnpm vitest run src/shutdown.test.ts -t "exits 1"    # one test by name
pnpm test:integration         # real MySQL; same flags work (-t, file path)

pnpm db:migrate | db:rollback | db:status            # load .env via --env-file
pnpm db:create <name>.ts      # new migration file; pass the extension, e.g. add-x.ts
```

CI (`.github/workflows/ci.yml`) runs `typecheck` (typecheck + format:check) -> `test` and `integration` (MySQL 8.4 service) -> `build` -> `deploy`/`run` (main only, smoke-tests the built bundle with prod deps).

### Local database

`docker compose up -d` starts MySQL 8.4; copy `.env.example` to `.env` first (`MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD` are required). MySQL reads those passwords only when the data volume is first created, so changing `.env` later does not change the existing database's passwords. Integration tests use a separate database, `order_sync_hub_test`, created once with `bash scripts/create-test-db.sh` (the app user cannot create databases). `scripts/README.md` documents the other helper scripts.

## Architecture

Express 5 app over Sequelize 6 / MySQL, split into layers that each own one decision:

- `src/app.ts` builds the Express app (exported, no `listen`); `src/server.ts` starts it. Route order matters: routers, then `notFound`, then `errorHandler` last.
- `src/routes/orders.ts` only validates shape (zod) and picks a service call. `express.json()` is mounted on `/orders` only, so `/health` never fails on a bad body.
- `src/services/orders.ts` holds the business rules: merging repeated products, quantity/total ceilings matching the column types, price snapshotting, and writing an order with its items in **one transaction** (products read with `LOCK IN SHARE MODE`). Money is `DECIMAL` handled as strings and summed with `decimal.js`, never JS numbers.
- `src/error-handler.ts` is the single place that maps errors to HTTP: zod -> 400, `InvalidOrderError` -> 400, `ProductNotFoundError` / `IdempotencyKeyReusedError` -> 422, `OrderNotFoundError` -> 404, body-parser 4xx pass through with fixed messages, an *unreachable* database -> 503 + `Retry-After`. Everything else is a 500 that never leaks the message. A connection lost mid-query is deliberately a 500, not 503, because the write may have committed and a retry could duplicate the order.
- `src/models/index.ts` is where associations are declared; import models from there, not from the individual files, so they are associated.
- `src/shutdown.ts` + `server.ts`: on SIGTERM/SIGINT stop accepting connections, sweep idle keep-alive sockets, close Sequelize, exit 0; a 10 s deadline exits 1. Handlers use `process.once` on purpose (a second identical signal force-quits).

### Idempotent `POST /orders`

Optional `Idempotency-Key` header (1-64 printable ASCII, case-sensitive). `createOrderOnce` inserts a row in `idempotency_keys` in the same transaction as the order, so the primary key guarantees one order per key under concurrent retries; the loser catches `UniqueConstraintError` and re-reads outside the failed transaction. Same key + same request (compared by a hash of the merged, sorted lines) replays the order with 200; different request -> 422. Without the header `createOrder` runs unchanged.

### Database and migrations

- Umzug runs `src/db/migrations/*.ts`. Migration names are stored **without** the `.ts`/`.js` extension (`migration-name.ts`) so `tsx` and the compiled `dist/` share one `SequelizeMeta` history.
- Sequelize's `collate` column option is not applied on MySQL; use a raw `ALTER TABLE ... MODIFY ... COLLATE utf8mb4_bin` (see the `idempotency_keys` migration).
- `/health` is liveness and needs no database; `/health/db` is readiness and returns 503 when MySQL is down. The server refuses to start without `MYSQL_PASSWORD` outside `development`/`test` (it only warns there), and the migrate CLI always refuses.
- The sequelize connect timeout is 3 s so the 503 reaches the client before mysql2's default ~10 s hang.

## Testing conventions

- `*.test.ts` run under `pnpm test` (`vitest.config.ts` excludes `*.integration.test.ts`). Route tests mock the service module but keep its real error classes (`importOriginal` spread), because the error handler uses `instanceof`.
- Integration tests (`vitest.integration.config.ts`) run files serially against `order_sync_hub_test`. Global setup reverts **every** migration and re-applies them, and refuses to run unless the database name ends in `_test`. The test database name lives in `test/test-database.ts`; keep it in sync with `scripts/create-test-db.sh`.
- Shutdown and timer logic is tested with injected fakes and Vitest fake timers; `server.test.ts` mocks `app.listen` and captures `process.once` handlers instead of sending real signals.
- `tsconfig.json` is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; test files are excluded from the build config but still typechecked.

## Plans

Design and implementation plans live in `docs/superpowers/plans/` (dated, task-by-task). Read the relevant one before changing the area it covers.
