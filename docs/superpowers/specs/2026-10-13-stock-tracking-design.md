# Stock Tracking: Ledger, Balance Counter, Reservation and Cancel — Design

**Status:** Design approved in conversation 2026-10-13; this document awaits the owner's review. **Not implemented, and not to be implemented yet**: this is a design for later.
**Next step after approval:** an implementation plan (`superpowers:writing-plans`).
**Prerequisite:** the orders work (branch `feature/orders`: `orders`, `order_items`, `createOrder`) is merged to `main` first; this design extends it.

## 1. Goal

Know how many units of each product can be sold, and never sell more than exist, even when many orders arrive at the same moment. Keep a permanent, auditable history of every change to stock.

## 2. Decisions

| # | Decision | Chosen by | Reason |
|---|---|---|---|
| D1 | **Stock movement ledger** is the source of truth: an append-only table of signed changes. | Owner | Full audit trail: every unit that entered or left is explained. |
| D2 | A **balance counter** table holds the current quantity per product and is the fast guard against overselling. Ledger and balance are always written in the same transaction. | Owner | A ledger alone cannot stop two simultaneous orders from overselling; an atomic conditional `UPDATE` on one counter row can. |
| D3 | **Reserve at order creation, restore on cancel.** `createOrder` removes the stock immediately; `cancelOrder` returns it. | Owner | No overselling window; cancelled orders stop holding inventory. |
| D4 | **No backorders:** stock can never go below zero. | Proposed, approved | Simplest correct rule; the unsigned column is a second safety net. |
| D5 | `cancelOrder` is allowed **only from `pending`**. | Proposed, approved | Cancelling paid orders involves refunds, out of scope. |
| D6 | **Existing products start at a balance of 0.** | Proposed, approved | Nothing is assumed to be in stock until a restock is recorded. |
| D7 | **`adjustStock` is the only way to add or correct stock** for now. | Proposed, approved | One audited path; no HTTP surface yet. |

## 3. Scope

**In scope:** a migration for two tables; two typed models and their associations; `createOrder` extended to reserve stock; new `cancelOrder` and `adjustStock` services; new error classes; integration tests with real concurrency; an invariant helper that checks ledger against balance.

**Out of scope:** expiring unpaid orders (a `pending` order holds its stock until it is cancelled), reserved-versus-on-hand split, multiple warehouses, cancelling paid orders and refunds, low-stock alerts, HTTP routes, a scheduled reconciliation job (the invariant check exists as a test helper only).

## 4. Data model

**Two migrations, one table each** (both generated with `pnpm db:create`; `create-stock-balances` first, then `create-stock-movements`). MySQL commits every DDL statement immediately and cannot roll it back, even inside a transaction, so a migration that creates two tables is not atomic: if the second statement failed, the first table would stay behind. One table per migration means a failure leaves a clean state, and umzug simply retries the missing migration. (This corrects an earlier draft of this spec that put both tables in one migration.) Column names are camelCase, like the existing tables.

**`stock_balances`**: one row per product.

| Column | Type | Notes |
|---|---|---|
| `productId` | INT UNSIGNED, PK, FK to `products.id`, `ON DELETE RESTRICT` | |
| `quantity` | INT UNSIGNED, NOT NULL | Units available to sell; cannot go below zero |
| `updatedAt` | DATETIME, NOT NULL | |

**`stock_movements`**: append-only; rows are never updated or deleted.

| Column | Type | Notes |
|---|---|---|
| `id` | INT UNSIGNED, PK, auto-increment | |
| `productId` | INT UNSIGNED, NOT NULL, FK to `products.id`, `ON DELETE RESTRICT` | |
| `delta` | INT, NOT NULL | Signed: `-2` for an order of 2, `+50` for a restock |
| `reason` | ENUM(`restock`,`order`,`cancel`,`adjustment`), NOT NULL | |
| `orderId` | INT UNSIGNED, NULL, FK to `orders.id`, `ON DELETE SET NULL` | Set for `order` and `cancel`; history survives if an order row is ever removed |
| `note` | VARCHAR(255), NULL | Free text for adjustments |
| `createdAt` | DATETIME, NOT NULL | No `updatedAt`: rows do not change |

Index on `(productId, createdAt)` for history queries. Existing products get no balance row; a missing row is treated as a balance of 0 (D6). Each migration's `down` drops its own table; because `stock_movements` has a foreign key to `products` only (not to `stock_balances`), the two can be rolled back independently, newest first.

**Invariant:** for every product, the sum of `delta` over its movements equals its `stock_balances.quantity` (a missing balance row equals a sum of 0).

## 5. Models and associations

- `StockBalance` and `StockMovement` follow the `Product` pattern: `declare` fields, `CreationOptional` for database-filled columns, plain `number` for foreign keys (not Sequelize's `ForeignKey<>`, which makes them optional on creation), explicit `tableName`.
- `StockMovement.reason` has a TypeScript union matching the ENUM.
- Associations are registered in `src/models/index.ts`, the only place that imports models together:
  - `Product.hasOne(StockBalance, { foreignKey: 'productId', as: 'stock' })`
  - `StockBalance.belongsTo(Product, { foreignKey: 'productId', as: 'product' })`
  - `StockMovement.belongsTo(Product, { foreignKey: 'productId', as: 'product' })`
  - `StockMovement.belongsTo(Order, { foreignKey: 'orderId', as: 'order' })`
- Every alias is written `as: 'x' satisfies keyof Model`, so a mismatch between the alias and the `declare`d property is a compile error. `Product` gains `declare stock?: NonAttribute<StockBalance>` and `omit: 'stock'` in its `InferAttributes` / `InferCreationAttributes`; the `Product` attribute list is unchanged.

## 6. Services

New errors, all extending `Error` with `name` set: `InsufficientStockError` (carries `productId`, `requested`, `available`), `OrderNotFoundError`, `OrderNotCancellableError` (carries the current status).

### 6.1 `createOrder(lines)` — extended

Validation and merging are unchanged. Then, in one managed transaction:

1. Load the products with `LOCK IN SHARE MODE` (prices), as today; throw `ProductNotFoundError` for unknown ids.
2. **Reserve stock**, visiting the lines in **ascending `productId`** order. For each line run the atomic statement `UPDATE stock_balances SET quantity = quantity - n WHERE productId = ? AND quantity >= n`. If zero rows are affected, read the current balance (0 if the row is missing) and throw `InsufficientStockError`; the whole transaction rolls back. The first failing line, in id order, is reported.
3. Create the order and its items, with the price snapshot and the total (limits from the orders work unchanged).
4. Append one `-n` movement per line (`reason: 'order'`, `orderId`).
5. Return the order reloaded with its items.

Anything that throws rolls back the balances, the movements, the order and the items together.

### 6.2 `cancelOrder(orderId)` — new

In one transaction:

1. `UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'`. If zero rows are affected, load the order: missing means `OrderNotFoundError`; any other status means `OrderNotCancellableError`. Because this update is conditional, two simultaneous cancels cannot both proceed.
2. Load the order's items in ascending `productId` order.
3. For each item: `UPDATE stock_balances SET quantity = quantity + n WHERE productId = ?` and append a `+n` movement (`reason: 'cancel'`, `orderId`). If a balance row is missing here, the invariant is broken: throw an `Error` and roll back.
4. Return the order reloaded with its items.

### 6.3 `adjustStock(productId, delta, reason, note?)` — new

- `delta` must be a non-zero safe integer; `reason` must be `restock` or `adjustment`; otherwise `InvalidStockAdjustmentError`.
- The product must exist (`ProductNotFoundError`).
- Ensure the balance row exists (insert with 0 if missing, ignoring a duplicate), then apply the delta with a conditional update: a negative delta requires `quantity >= |delta|` (else `InsufficientStockError`), and a positive delta requires `quantity <= 4294967295 - delta` (else `InvalidStockAdjustmentError`, so a non-strict `sql_mode` can never clamp silently).
- Append the movement (`delta`, `reason`, `note`) in the same transaction and return the new balance.

## 7. Concurrency and correctness

- **No lock upgrade.** Prices keep the shared lock on `products`; the stock decrement is an atomic update on a different table's row. Locking the same row first shared and then exclusive (which deadlocks two simultaneous orders) never happens.
- **Ordered locking.** Balance rows are always updated in ascending `productId`, so two multi-item orders cannot wait on each other in a cycle. Both `createOrder` and `cancelOrder` follow the rule.
- **No oversell.** The condition `quantity >= n` is evaluated while the row is locked by the update itself; there is no read-then-write gap.
- **Single restore.** The conditional status update in `cancelOrder` guarantees stock is returned once per order.
- **Lock waits:** orders for the same product queue briefly on its balance row; MySQL's lock wait timeout (50 s by default) applies. Acceptable at this scale.

## 8. Testing strategy

Integration tests (`*.integration.test.ts`, test database, real MySQL) carry the evidence; offline tests cover validation and model shapes. After every integration scenario a helper `expectLedgerMatchesBalances()` asserts the invariant from section 4.

| Test | What it proves |
|---|---|
| order reserves stock and writes `-n` movements | Happy path; balance and ledger agree |
| order for more than the balance throws `InsufficientStockError` and changes nothing | Guard works; error carries product, requested, available |
| product with no balance row behaves as 0 | D6 |
| two simultaneous orders for the last unit | Exactly one succeeds, one gets `InsufficientStockError`, final balance 0 |
| 20 simultaneous orders of 1 against a balance of 5 | Exactly 5 succeed (the connection pool limits true parallelism to its size; the result is still exact) |
| simultaneous orders with lines in opposite id order | Both complete, no deadlock |
| failure after the decrement rolls back balance and movement | Real rollback proof for the new writes |
| `cancelOrder` restores stock and writes `+n` movements | D3 |
| two simultaneous cancels of one order | Stock restored exactly once; one call gets `OrderNotCancellableError` |
| cancel of a missing / already cancelled / paid order | `OrderNotFoundError` / `OrderNotCancellableError`, nothing changed |
| `adjustStock` restock, correction, and overflow / underflow | Section 6.3 rules |
| compile-time checks for new models | `@ts-expect-error` as for the existing models |

Planned mutation checks (each must make a named test fail): replace the conditional update with read-then-write (last-unit race fails); remove the ascending sort (opposite-order test fails, possibly needing repeats because deadlocks are timing-dependent); skip the movement insert (invariant helper fails); remove the status condition in `cancelOrder` (double-cancel test fails).

## 9. Migration and rollout

1. Merge the orders work to `main`.
2. Add the migration and models, then the services, test-first.
3. Run the migration on the dev database. With no balance rows, every product has 0 stock, so any `createOrder` fails with `InsufficientStockError` until `adjustStock` records a restock. This is intended (D6) and must be stated in the release notes.
4. Existing `pending` orders (created before stock tracking) hold no reserved stock; cancelling one would add stock that was never removed. The plan must handle this explicitly (for example by recording an initial `adjustment` per existing pending order, or by documenting that no such orders exist at rollout).

## 10. File list

| File | Action |
|---|---|
| `src/db/migrations/<timestamp>.create-stock-balances.ts`, `<timestamp>.create-stock-movements.ts` | Create (via `pnpm db:create`, one table per migration) |
| `src/models/stock-balance.ts`, `stock-movement.ts` | Create |
| `src/models/index.ts`, `src/models/product.ts` | Modify (associations; `stock` property on `Product`) |
| `src/models/stock-balance.test.ts`, `stock-movement.test.ts`, `associations.test.ts` | Create / modify |
| `src/services/orders.ts` | Modify (`createOrder` reserves stock; new `cancelOrder` lives here too, since this module owns the order lifecycle) |
| `src/services/stock.ts` | Create (`adjustStock`, error classes) |
| `src/services/orders.integration.test.ts`, `stock.integration.test.ts` | Modify / create |
| `test/` helper | `expectLedgerMatchesBalances()` |

## 11. Verification status

**Verified:** Sequelize can generate the guard statement for MySQL: `UPDATE products SET price=price - 2 WHERE id = ? AND price >= 2` (checked with `Product.price` standing in for the balance column).

**Not verified (needs MySQL, which was stopped):** every concurrency claim in sections 7 and 8, including the deadlock analysis, the last-unit race, the double-cancel guarantee, and that the 0-rows-affected signal is reliable for the conditional update (the decrement always changes the value, so zero must mean the condition failed, but this must be observed). The plan verifies each by running it.

## 12. Risks and open points

- **Stuck reservations:** an order that is never paid or cancelled holds stock forever. Needs an expiry job (follow-up).
- **Two sources of truth:** ledger and balance can drift if someone edits the balance table directly. The invariant helper catches drift in tests; a production reconciliation job is a follow-up.
- **Backfill of in-flight orders:** see section 9, point 4.
- **DDL is not atomic in MySQL:** the one-table-per-migration rule in section 4 is deliberate. Statements that are not idempotent (`addColumn`, `addIndex`) must also be one per migration, because re-running them after a partial failure would fail with "duplicate column". `createTable` is safe to re-run (Sequelize sends `CREATE TABLE IF NOT EXISTS`, verified), `addColumn` is not.
- **Ledger growth:** unbounded; reads use the balance, not `SUM`, so growth only affects history queries (indexed by product and date).
- **Pool-limited parallelism in tests:** the default pool allows 5 simultaneous connections, so "20 simultaneous orders" run in waves of 5. The assertions stay exact; the contention is lower than a busy server.
