# Idempotent `POST /orders` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client that retries `POST /orders` with the same `Idempotency-Key` gets the original order back instead of a duplicate.

**Architecture:** A new `idempotency_keys` table maps a key to the order it created and to a hash of the request. The key row is inserted in the same transaction as the order, so the primary key is what guarantees one order per key even under concurrent retries. The existing `createOrder(lines)` is untouched; a new `createOrderOnce(key, lines)` wraps the same insert logic and the route picks one or the other by whether the header is present.

**Tech Stack:** Express 5, Sequelize 6 (MySQL 8.4, InnoDB), Umzug migrations, zod, Vitest, supertest.

**Spec:** this document. Today a retry after a timeout creates a second order, because nothing recognises a repeat. Current code: `src/services/orders.ts` (`createOrder`), `src/routes/orders.ts`, `src/error-handler.ts`.

## Global Constraints

- Header name: `Idempotency-Key`. Optional. Without it, behaviour is exactly as today (201, new order every time).
- Key format: 1 to 64 characters, printable ASCII only (`/^[\x21-\x7e]{1,64}$/`). Anything else: 400 through the existing zod error path.
- Keys are case-sensitive (`utf8mb4_bin` column): `A1` and `a1` are different keys.
- Responses: new key -> `201` with `Location: /orders/<id>`; replay (same key, same request) -> `200`, same body, same `Location`; same key with a different request -> `422` with message `Idempotency-Key was already used with a different request`.
- "Same request" means the same set of `{productId, quantity}` after merging repeated products, regardless of line order.
- A request that fails (400 validation, 422 unknown product, 5xx) must not consume its key.
- Response bodies of `Order` are unchanged: no key or hash fields appear in them.
- Table name `idempotency_keys`; the key column is named `idempotencyKey` because `key` is reserved in MySQL.
- ESM with `.js` import suffixes; `pnpm typecheck`, `pnpm format:check`, `pnpm test` and `pnpm test:integration` (needs MySQL) must pass.

## Review Focus

- Two identical requests with one key arriving at the same moment: exactly one order row; one caller gets 201, the other 200 with the same order id (tested in Task 2).
- Same key, different items: 422 and no new order row (Task 2, Task 3).
- Same key, same items reordered or split into repeated lines (`[{3,1},{3,2}]` vs `[{3,3}]`): treated as a replay, not a conflict (Task 2).
- Keys differing only in case, or an empty / 65-character / non-ASCII key: case is distinct (Task 1, Task 2); bad keys get 400 (Task 3).
- A failed first attempt (unknown product, invalid quantity) followed by a corrected retry with the same key: the retry creates the order (Task 2).

## File Structure

- Create `src/db/migrations/<timestamp>.create-idempotency-keys.ts` (generate with `pnpm db:create --name create-idempotency-keys`; keep the generated timestamp).
- Create `src/models/idempotency-key.ts` and `src/models/idempotency-key.test.ts`; export from `src/models/index.ts`.
- Create `src/services/idempotency.ts` and `src/services/idempotency.test.ts`: pure request hashing only.
- Modify `src/services/orders.ts` (+ `orders.test.ts` if it covers the changed exports, `orders.integration.test.ts`).
- Modify `src/routes/orders.ts`, `src/routes/orders.test.ts`, `src/routes/orders.integration.test.ts`.
- Modify `src/error-handler.ts` and `src/error-handler.test.ts`.
- Modify `src/models/schema.integration.test.ts` to cover the new table.

---

### Task 1: `idempotency_keys` table and model

**Files:**
- Create: migration `create-idempotency-keys`, `src/models/idempotency-key.ts`, `src/models/idempotency-key.test.ts`
- Modify: `src/models/index.ts`, `src/models/schema.integration.test.ts`

**Interfaces:**
- Produces: `class IdempotencyKey extends Model` with attributes `idempotencyKey: string` (primary key), `requestHash: string`, `orderId: number`, `createdAt`. Exported from `src/models/index.ts`.
- Table: `idempotencyKey VARCHAR(64) PRIMARY KEY` with `collate: 'utf8mb4_bin'`; `requestHash CHAR(64) NOT NULL`; `orderId INTEGER UNSIGNED NOT NULL UNIQUE` with a foreign key to `orders.id` `ON DELETE CASCADE`; `createdAt DATETIME NOT NULL`. No `updatedAt` (rows are never updated): the model sets `updatedAt: false`.

- [ ] **Step 1: Write the failing tests.**
  - `idempotency-key.test.ts` (no database): `maps to the idempotency_keys table`; `declares exactly the migration columns` (`createdAt, idempotencyKey, orderId, requestHash`); `idempotencyKey is the primary key`; `requires requestHash and orderId`.
  - `schema.integration.test.ts`: `idempotency_keys exists after migrating up`; `keys that differ only in case are distinct rows` (create an order, insert keys `Ab` and `ab` for two orders, expect both to succeed); `a duplicate key is rejected` (second insert of `Ab` throws `UniqueConstraintError`); `one order cannot have two keys` (same `orderId` twice throws); `deleting an order deletes its key`.
- [ ] **Step 2: Run to verify they fail.** `pnpm vitest run src/models/idempotency-key.test.ts` -> FAIL (module missing); `pnpm test:integration -t idempotency` -> FAIL.
- [ ] **Step 3: Create the migration and model.** `up` creates the table as specified above; `down` drops it. Follow the style of `2026.10.13T09.21.10.create-order-items.ts` for the foreign key. Model follows `src/models/order.ts` (`InferAttributes`, `tableName: 'idempotency_keys'`, `updatedAt: false`).
- [ ] **Step 4: Run to verify they pass.** `pnpm test && pnpm test:integration` -> PASS (integration needs MySQL; `pnpm db:migrate` is not required, the integration setup rebuilds the test schema).
- [ ] **Step 5: Commit** `git add src && git commit -m "feat: add idempotency_keys table and model"`.

---

### Task 2: `createOrderOnce` service

**Files:**
- Create: `src/services/idempotency.ts`, `src/services/idempotency.test.ts`
- Modify: `src/services/orders.ts`, `src/services/orders.integration.test.ts`

**Interfaces:**
- Consumes: `IdempotencyKey` (Task 1).
- Produces, in `src/services/idempotency.ts`: `hashOrderLines(lines: OrderLine[]): string` - SHA-256 hex (64 chars) of the lines sorted by `productId`, serialised as JSON. Expects already-merged lines (the output of `normalizeLines`).
- Produces, in `src/services/orders.ts`:
  - `class IdempotencyKeyReusedError extends Error` (`name = 'IdempotencyKeyReusedError'`, message `Idempotency-Key was already used with a different request`).
  - `createOrderOnce(idempotencyKey: string, lines: OrderLine[]): Promise<{ order: Order; created: boolean }>`.
  - `createOrder(lines: OrderLine[]): Promise<Order>` keeps its exact signature and behaviour.

- [ ] **Step 1: Write the failing tests.**
  - `idempotency.test.ts`: `returns 64 hex characters`; `ignores line order` (`[{1,2},{3,1}]` equals `[{3,1},{1,2}]`); `differs when a quantity differs`; `differs when a product differs`.
  - `orders.integration.test.ts`, new `describe('createOrderOnce')` (uses the file's existing product setup):
    - `creates the order and reports created: true`;
    - `a repeat with the same key and lines returns the same order id, created: false, and no new rows` (`counts()` unchanged on the second call);
    - `a repeat whose lines are reordered or split into repeated lines is still a replay` (`[{p,1},{p,2}]` then `[{p,3}]`);
    - `the same key with different lines throws IdempotencyKeyReusedError and creates nothing`;
    - `keys that differ only in case are different keys` (`'Ab'` and `'ab'` create two orders);
    - `two concurrent identical calls create exactly one order` (`Promise.all` of two calls; results share one `order.id`, exactly one has `created: true`, `Order.count()` is 1);
    - `a failed first attempt does not consume the key` (unknown product -> `ProductNotFoundError`; then the corrected call with the same key returns `created: true`; `IdempotencyKey.count()` is 1);
    - `invalid lines are rejected before any lookup` (`InvalidOrderError`, no key row).
- [ ] **Step 2: Run to verify they fail.** `pnpm vitest run src/services/idempotency.test.ts` and `pnpm test:integration -t createOrderOnce` -> FAIL.
- [ ] **Step 3: Implement.**
  - `hashOrderLines` in `idempotency.ts` with `node:crypto`.
  - In `orders.ts`, extract the body of the existing transaction callback into `insertOrder(wanted: OrderLine[], transaction: Transaction): Promise<Order>` (not exported) and have `createOrder` call it, so there is one copy of the pricing/insert logic.
  - `createOrderOnce`: `normalizeLines` first (invalid input never touches the key table); compute the hash; `findReplay(key, hash)` (internal) returns the existing order via `getOrder(row.orderId)` when the hash matches, throws `IdempotencyKeyReusedError` when it differs, and returns `undefined` when no row exists. If a replay is found return `{ order, created: false }`. Otherwise run one transaction that calls `insertOrder` then `IdempotencyKey.create({ idempotencyKey, requestHash, orderId: order.id }, { transaction })`, and return `{ order, created: true }`. Catch `UniqueConstraintError` from that transaction (a concurrent winner committed the same key): call `findReplay` again and return its order as a replay; if it finds nothing, rethrow. The primary key, not the pre-check, is what prevents duplicates.
- [ ] **Step 4: Run to verify they pass.** `pnpm typecheck && pnpm format:check && pnpm test && pnpm test:integration` -> PASS; the existing `createOrder` tests must still pass unchanged.
- [ ] **Step 5: Commit** `git add src && git commit -m "feat: createOrderOnce with idempotency keys"`.

---

### Task 3: Route, error mapping, and docs

**Files:**
- Modify: `src/routes/orders.ts`, `src/routes/orders.test.ts`, `src/routes/orders.integration.test.ts`, `src/error-handler.ts`, `src/error-handler.test.ts`

**Interfaces:**
- Consumes: `createOrderOnce`, `IdempotencyKeyReusedError` (Task 2).
- Produces: HTTP behaviour in Global Constraints.

- [ ] **Step 1: Write the failing tests.**
  - `error-handler.test.ts`: `maps IdempotencyKeyReusedError to 422 with its message`.
  - `routes/orders.test.ts` (service mocked; add `createOrderOnce: vi.fn()` to the existing `vi.mock`):
    - `without the header it calls createOrder and never createOrderOnce`;
    - `with a key and created: true it answers 201 with Location` (also asserts `createOrderOnce` called with `('key-1', items)`);
    - `with a key and created: false it answers 200 with the same body and Location`;
    - `answers 422 when createOrderOnce throws IdempotencyKeyReusedError`;
    - `it.each` of `''`, 65 `a`s, `'has space'`, `'café'` -> 400 and no service call (an empty header is sent as `''`).
  - `routes/orders.integration.test.ts`: `a retry with the same key returns 200, the same order and one row`; `the same key with different items returns 422`; `bodies never contain idempotencyKey or requestHash`.
- [ ] **Step 2: Run to verify they fail.** `pnpm vitest run src/routes/orders.test.ts src/error-handler.test.ts` -> FAIL.
- [ ] **Step 3: Implement.** In `routes/orders.ts` add a zod schema `idempotencyKey = z.string().regex(/^[\x21-\x7e]{1,64}$/).optional()` parsed from `req.get('Idempotency-Key')`; with a key call `createOrderOnce` and answer `created ? 201 : 200`, both with the same `Location`; without one the handler is unchanged. In `error-handler.ts` add `if (err instanceof IdempotencyKeyReusedError) return send(422, err.message);` next to the other 422.
- [ ] **Step 4: Run everything.** `pnpm typecheck && pnpm format:check && pnpm test && pnpm test:integration` -> PASS.
- [ ] **Step 5: Document the header** in the orders design notes if a README or API section exists (`grep -ril "POST /orders" --include=*.md .`); if none exists, skip this step and say so in the report.
- [ ] **Step 6: Commit** `git add src && git commit -m "feat: Idempotency-Key header on POST /orders"`.

---

## Self-Review

- Coverage: every Global Constraint has a test (header optional -> Task 3 no-header test; format -> Task 3 `it.each`; case sensitivity -> Tasks 1 and 2; 201/200/422 -> Tasks 2 and 3; hash semantics -> Task 2; failed requests keep the key -> Task 2; bodies unchanged -> Task 3).
- Type consistency: `createOrderOnce(idempotencyKey, lines) -> { order, created }`, `IdempotencyKeyReusedError`, `hashOrderLines`, `IdempotencyKey` are named the same in every task.
- Out of scope: key expiry or cleanup (rows are tiny; add a job if the table grows), per-client key scoping (no authentication yet), and an `Idempotent-Replayed` response header.
