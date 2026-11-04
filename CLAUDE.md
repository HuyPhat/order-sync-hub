# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Order Sync Hub is a backend portfolio project imitating the internal order-processing system of a small cross-border e-commerce business (print-on-demand products sold on Amazon). It receives orders, stores them reliably, and (planned) syncs them to other systems through a queue. The author is a senior frontend engineer moving into fullstack roles; the project exists to show real backend skills: REST API, relational DB, transactions, auth, background jobs, caching, rate-limited external APIs, tests and CI.

| Step | Area | Status |
| --- | --- | --- |
| 1-4 | Express/TS skeleton, MySQL + Sequelize + migrations, transactional orders, HTTP API | Done |
| 5 | Authentication and roles | Planned (no design yet) |
| 6 | Queue (BullMQ + Redis), mock Amazon polling | Planned |
| 7 | Redis cache-aside | Planned |
| 8 | Rate-limited external API (OpenAI-style, 429 backoff) | Planned |
| 9 | React frontend | Planned |
| 10 | Deploy (CI with a MySQL service already runs) | Partly done |

Stack: Node 22+, TypeScript 7, Express 5.2 (async handler errors reach the error middleware automatically), Sequelize 6 + mysql2, umzug, MySQL 8.4, zod 4, decimal.js, Vitest 5 + supertest, Prettier, tsx.

## Commands

Package manager is pnpm; CI runs Node 24. Source is ESM TypeScript: relative imports need the `.js` suffix (`import { x } from './x.js'`).

```bash
pnpm dev                      # tsx watch with --env-file=.env (needs .env; PORT defaults to 3000)
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

Environment variables: `PORT`, `MYSQL_HOST` (default `127.0.0.1`), `MYSQL_PORT` (3306), `MYSQL_DATABASE` (`order_sync_hub`), `MYSQL_USER` (`app`), `MYSQL_PASSWORD` (required outside `development`/`test`).

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

### Conventions

- Strict TypeScript also sets `verbatimModuleSyntax` and `module: nodenext`.
- Use `import express, { type Express } from 'express'` and annotate exported values (`export const app: Express = express()`); pnpm's strict resolution otherwise gives TS2883 on inferred types.
- Money is `DECIMAL(10,2)`, a string in JSON, computed with `Decimal`. Never `number` or `FLOAT`.
- Every query inside a transaction must receive `{ transaction }`.
- One shared Sequelize instance per process (`src/db/sequelize.ts`).
- `X-Powered-By` is disabled.

### Data model

- `products`: `id`, `sku` (unique), `name`, `price DECIMAL(10,2)`, timestamps.
- `orders`: `id`, `status` (default `pending`), `total DECIMAL`, timestamps.
- `order_items`: `id`, `orderId` (FK, `ON DELETE CASCADE`), `productId` (FK, `ON DELETE RESTRICT`), `quantity`, `unitPrice` (snapshot of the product price at order time), timestamps.
- `idempotency_keys`: see below.

`orders` and `order_items` are separate migrations because MySQL DDL auto-commits, so a multi-statement migration cannot be atomic.

### HTTP API

- `GET /health` -> `200 {"status":"ok"}`, no database. `GET /health/db` -> `200 {"status":"ok","db":"up"}` or `503 {"status":"error","db":"down"}`.
- `POST /orders`: strict body `{ "items": [{ "productId": 1, "quantity": 2 }] }` (extra keys rejected), 1-100 lines, positive integers, same-product lines merged. Success: `201`, `Location: /orders/:id`, body is the order with `items`.
- `GET /orders/:id` -> order with items sorted by id, or `404`.
- Validation errors return `400` with `issues: [{path, message}]`; malformed JSON -> 400 "Invalid JSON"; body too large -> 413; unknown route -> 404 JSON; wrong method on a known route -> 405 JSON with `Allow` (OPTIONS -> 204); database unreachable -> 503 with `Retry-After: 5`; anything else -> 500 "Internal Server Error", logged.

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
- Two rollback integration tests prove a mid-transaction failure leaves no partial order; they fail if `{ transaction }` is removed.
- Shutdown and timer logic is tested with injected fakes and Vitest fake timers; `server.test.ts` mocks `app.listen` and captures `process.once` handlers instead of sending real signals.
- `tsconfig.json` is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; test files are excluded from the build config but still typechecked.

## Working style

This project uses the Karpathy guidelines skill (`andrej-karpathy-skills:karpathy-guidelines`, installed as a Claude Code plugin); it loads automatically when writing, reviewing or refactoring code. In short:

1. **Think before coding:** state assumptions, surface alternatives, ask when unclear.
2. **Simplicity first:** the minimum code that solves the request; no speculative features or abstractions.
3. **Surgical changes:** touch only what the request needs, match existing style, mention unrelated dead code instead of deleting it.
4. **Goal-driven execution:** turn a task into a verifiable goal (a failing test first for bugs), then loop until `pnpm typecheck`, `pnpm format:check`, `pnpm test` and (for DB changes) `pnpm test:integration` pass.

The Ponytail plugin is also installed and runs on top of these: pick the smallest solution that works (reuse existing helpers, stdlib, installed dependencies before new code) and mark a deliberate shortcut with a `ponytail:` comment naming its ceiling. Use `/ponytail-review` on a diff before merging, `/ponytail-audit` for a whole-repo pass, and `/ponytail-debt` to list open shortcuts before starting a roadmap step. It never overrides validation, `Decimal` money handling, transactions or data-loss error handling; keep those complete.

The superpowers plugin is no longer used, so there is no brainstorm -> spec -> plan workflow to follow. For a multi-step change, state a short plan with a verify step per item in the conversation; write a file under `docs/` only when asked.

## Plans

Design specs live in `docs/superpowers/specs/` and implementation plans in `docs/superpowers/plans/` (dated, task-by-task). The directory name is historical, from when the superpowers plugin generated them; they are kept in place so existing cross-references still resolve. Read the relevant one before changing the area it covers.

### Known gaps

- Dev databases that applied the old single orders migration still have the old name in `SequelizeMeta`.

### Planned work

- **Auth (step 5):** `users` and `refresh_tokens` tables; argon2id or bcrypt; short-lived JWT access token plus hashed, rotating refresh token with reuse detection; RBAC (401 not authenticated, 403 not allowed); login rate limit.
- **Queue and sync (step 6):** mock "Amazon" API polled every N seconds with a `lastUpdatedAfter` cursor; BullMQ + Redis with retries, exponential backoff and a dead-letter queue; unique `amazonOrderId` so a repeated order is stored once; `OrderCreated` event with independent consumers (e.g. Lark-style webhook, inventory update).
- **Cache (step 7):** Redis cache-aside on read-heavy endpoints with explicit invalidation.
- **External API (step 8):** OpenAI-style call with 429 handling: backoff with jitter and a token bucket.
- **Frontend (step 9):** React + Vite + TanStack Query + Ant Design for orders and sync status.
