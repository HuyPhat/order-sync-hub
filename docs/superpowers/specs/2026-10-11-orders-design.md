# Orders: Migration, Models, Associations and `createOrder` — Design

**Status:** Approved in conversation 2026-10-11; this document awaits the owner's review. No code has been written.
**Next step after approval:** an implementation plan (`superpowers:writing-plans`).

## 1. Goal

An exercise that adds the first multi-table domain feature to `order-sync-hub`:

1. A migration creating `orders` (status, total, timestamps) and `order_items` (orderId foreign key, productId, quantity, unitPrice).
2. Two Sequelize models, typed the same way as `Product`.
3. Associations between `Order`, `OrderItem` and `Product`.
4. A service function `createOrder(items)` that loads the products, snapshots prices, and creates the order and its items in one transaction.
5. A test showing that when an item fails, nothing is saved.

## 2. Decisions

| # | Decision | Chosen by | Reason |
|---|---|---|---|
| D1 | The rollback test runs against a **separate test database** `order_sync_hub_test`. | Owner | Real dev data is never touched; the test can wipe tables freely. |
| D2 | Order totals use the **decimal.js** library. | Owner | Exact decimal arithmetic by construction. |
| D3 | The plan records the **"Integer cents in JS"** approach as a reference for later research (section 11). | Owner | Dependency-free alternative worth comparing. |
| D4 | Repeated products in one request are **merged** into a single line (quantities add up). | Proposed, approved | Simplest for callers; one line per product. |
| D5 | `status` is a MySQL ENUM of `pending`, `paid`, `cancelled`, default `pending`. | Proposed, approved | Database-level validation; the TypeScript type is a matching union. |
| D6 | `order_items.orderId` is `ON DELETE CASCADE`; `order_items.productId` is `ON DELETE RESTRICT`. | Proposed, approved | Deleting an order deletes its lines; a product that was ordered cannot be deleted. |

## 3. Scope

**In scope:** everything in section 1, plus the integration-test infrastructure it needs (section 8).

**Out of scope:** HTTP routes or controllers for orders; stock levels; status transitions; tax or discounts; running integration tests in CI (CI has no database today).

## 4. Data model

Two migrations, one table each (`create-orders` then `create-order-items`, generated with `pnpm db:create`, so the timestamp prefixes are tool-made). They were first written as one migration; they were split on 2026-10-13 because MySQL DDL is not atomic, so a migration creating two tables could leave the first behind if the second failed. Column names are camelCase to match `products`.

**`orders`**

| Column | Type | Notes |
|---|---|---|
| `id` | INT UNSIGNED, PK, auto-increment | |
| `status` | ENUM(`pending`,`paid`,`cancelled`), NOT NULL, default `pending` | D5 |
| `total` | DECIMAL(12,2), NOT NULL | Sum of line totals at creation time |
| `createdAt`, `updatedAt` | DATETIME, NOT NULL | |

**`order_items`**

| Column | Type | Notes |
|---|---|---|
| `id` | INT UNSIGNED, PK, auto-increment | |
| `orderId` | INT UNSIGNED, NOT NULL, FK to `orders.id`, `ON DELETE CASCADE` | D6 |
| `productId` | INT UNSIGNED, NOT NULL, FK to `products.id`, `ON DELETE RESTRICT` | D6 |
| `quantity` | INT UNSIGNED, NOT NULL | Positive; enforced by the service |
| `unitPrice` | DECIMAL(10,2), NOT NULL | **Snapshot** of `products.price` when the order was made |
| `createdAt`, `updatedAt` | DATETIME, NOT NULL | |

`down` drops `order_items` first, then `orders`. Both tables are InnoDB (required for transactions and foreign keys).

## 5. Models and associations

- `src/models/order.ts` and `src/models/order-item.ts` follow the `Product` pattern: `declare` fields (so class fields do not shadow Sequelize getters), `CreationOptional` for database-filled columns, money as `string`, and `Model.init(..., { sequelize, tableName })`.
- `Order` exports `type OrderStatus = 'pending' | 'paid' | 'cancelled'`.
- Association properties use `NonAttribute` and are listed in the `omit` option of `InferAttributes` / `InferCreationAttributes` (avoids circular-type problems): `Order.items`, `OrderItem.order`, `OrderItem.product`.
- Foreign-key attributes on `OrderItem` (`orderId`, `productId`) are plain `number`, **not** the `ForeignKey<...>` helper: a compile probe showed the helper makes them optional when creating an item, so a missing foreign key would compile and only fail in MySQL. A `@ts-expect-error` test pins this.
- `src/models/index.ts` declares the associations in one place and re-exports `Order`, `OrderItem`, `Product`:
  - `Order.hasMany(OrderItem, { foreignKey: 'orderId', as: 'items' })`
  - `OrderItem.belongsTo(Order, { foreignKey: 'orderId', as: 'order' })`
  - `OrderItem.belongsTo(Product, { foreignKey: 'productId', as: 'product' })`
- Rule: code that needs associations imports models from `src/models/index.js`, never from the individual files. Tables are created only by migrations; the models never call `sync()`.

## 6. `createOrder` behavior

Signature: `createOrder(lines: { productId: number; quantity: number }[]): Promise<Order>`, in `src/services/orders.ts`.

1. **Validate** (before opening a transaction): the array is not empty; every `productId` and `quantity` is a positive integer. Otherwise throw `InvalidOrderError`. Merge repeated `productId`s by summing quantities (D4).
2. **Open one managed transaction** (`sequelize.transaction(async (transaction) => ...)`); any throw rolls everything back.
3. **Load the products** for the requested ids with `lock: transaction.LOCK.SHARE`, so no price can change until the transaction ends.
4. **Unknown products:** if any requested id is missing, throw `ProductNotFoundError` carrying the missing ids.
5. **Snapshot and total:** each item's `unitPrice` is the product's current `price`; `total` is the sum of `unitPrice × quantity` computed with decimal.js and formatted with two decimals (D2).
6. **Write:** `Order.create({ status: 'pending', total })`, then `OrderItem.bulkCreate(items with orderId)`, both with `{ transaction }`.
7. **Return** the order reloaded with `include: 'items'` inside the same transaction.

Errors: `InvalidOrderError` and `ProductNotFoundError` (both extend `Error`, with `name` set). Any other error (for example a MySQL error) propagates unchanged after the rollback.

**decimal.js import:** use the named import `import { Decimal } from 'decimal.js'`. The default import runs but fails `tsc` under `module: nodenext` ("no construct signatures").

## 7. Testing strategy

**Offline unit tests** (run by `pnpm test`, no database): `createOrder` rejects an empty order, quantity `0`, negative, fractional, `NaN`, and invalid `productId` values with `InvalidOrderError`, and never opens a transaction (spy on `sequelize.transaction`).

**Integration tests** (`*.integration.test.ts`, run by `pnpm test:integration`, test database). Each test starts from empty `order_items`, `orders`, `products` tables.

| Test | What it proves |
|---|---|
| saves order and items, prices snapshotted, total computed | Happy path; for 2 × 19.99 + 3 × 0.10 the total is exactly `40.28`; row counts are 1 / 2 / 2 |
| keeps the price it saw after the product price changes | The snapshot is a copy, not a reference |
| merges a product that appears twice | D4: one line, summed quantity, correct total |
| saves nothing when one product is unknown | Behavior check (see note below) |
| rolls the order row back when saving items fails afterwards | **Real rollback proof 1:** `OrderItem.bulkCreate` is made to reject after `Order.create` has run; the test asserts `Order.create` was called and that all counts are unchanged |
| rolls everything back when MySQL itself rejects an item | **Real rollback proof 2:** a quantity of 4294967296 passes validation but overflows `INT UNSIGNED`; counts are unchanged |

**Note on "unknown product":** the service detects it before writing anything, so that test passes even if the transaction is removed. It documents behavior, but it is not the rollback proof. In the prototype, removing `{ transaction }` from `Order.create` left that test green while both real rollback tests failed. This is why the two tests above exist.

## 8. Integration-test infrastructure

- `vitest.config.ts` (default, used by `pnpm test`): excludes `**/*.integration.test.ts` using `configDefaults.exclude`.
- `vitest.integration.config.ts`: includes `src/**/*.integration.test.ts`; loads `.env` with `process.loadEnvFile('.env')` (wrapped in try/catch); sets `MYSQL_DATABASE` to the test database for the test workers; `fileParallelism: false` (all files share one database); registers the global setup.
- `test/integration-setup.ts` (global setup, runs once per run): sets `MYSQL_DATABASE` for its own process, then **refuses to continue unless the configured database name ends in `_test`** (it is about to revert every migration, which drops all tables), runs `migrator.down({ to: 0 })` then `migrator.up()`, and returns a teardown that closes the Sequelize pool.
- The database name lives in one place, a small shared module (`test/test-database.ts`), imported by both the config and the setup.
- `scripts/create-test-db.sh` (idempotent, run once by the owner): creates `order_sync_hub_test` and grants `ALL PRIVILEGES` on it to the `app` user, using the root password from inside the MySQL container (`docker compose exec -T mysql`). The `app` user cannot create databases itself.
- `package.json` gets `"test:integration": "vitest run --config vitest.integration.config.ts"`.
- The `test/` folder and the two config files are outside `src/`, so `tsc` does not type-check them.
- Documentation: a short section in `scripts/README.md` for `create-test-db.sh` and the integration command.

## 9. File list

| File | Action |
|---|---|
| `src/db/migrations/<timestamp>.create-orders.ts` | Create (via `pnpm db:create`) |
| `src/models/order.ts`, `src/models/order-item.ts`, `src/models/index.ts` | Create |
| `src/models/order.test.ts`, `src/models/order-item.test.ts` | Create (offline, like `product.test.ts`) |
| `src/services/orders.ts` | Create |
| `src/services/orders.test.ts` | Create (offline validation) |
| `src/services/orders.integration.test.ts` | Create |
| `vitest.config.ts`, `vitest.integration.config.ts` | Create |
| `test/integration-setup.ts`, `test/test-database.ts` | Create |
| `scripts/create-test-db.sh`, `scripts/README.md` | Create / modify |
| `package.json`, `pnpm-lock.yaml` | Modify (`decimal.js`, script) |

## 10. Verification already done (scratch copy, real MySQL, throwaway database dropped afterwards)

- The migration applied, and `SHOW CREATE TABLE order_items` shows both foreign keys (`CASCADE` and `RESTRICT`) and InnoDB.
- Typecheck is clean with the typed models and associations; 57 offline tests pass (the existing 50 plus 7 validation cases); the integration suite passed 6 of 6, twice in a row (the setup resets cleanly).
- Mutations: removing `{ transaction }` from `Order.create` failed both real rollback tests and not the unknown-product test; removing it from `bulkCreate` failed the whole integration file.
- The owner's dev database `order_sync_hub` was verified untouched (`SequelizeMeta`, `products` only); the throwaway database and its grant were removed.

Not yet verified: the `scripts/create-test-db.sh` script, the `_test` name guard in the setup, and the model offline tests (these are specified here but were not part of the prototype).

## 11. Reference for later research: "Integer cents in JS"

A dependency-free alternative to decimal.js, to compare later:

```ts
// '19.99' -> 1999n ; assumes exactly two decimals, which DECIMAL(10,2) guarantees
const toCents = (price: string): bigint => BigInt(price.replace('.', ''));
const fromCents = (cents: bigint): string => {
  const s = cents.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
};
const total = items.reduce((sum, i) => sum + toCents(i.unitPrice) * BigInt(i.quantity), 0n);
fromCents(total); // '40.28'
```

| | decimal.js (chosen) | Integer cents |
|---|---|---|
| Dependency | one package | none |
| Test | integration or unit | fast offline unit test of the total |
| Flexibility | any precision, tax rates, division | fixed at two decimals; needs care for negatives and larger scales |
| Risk | import quirk under `nodenext` (named import needed) | hand-rolled parsing must be tested well |

Honest note: with two-decimal prices, a float sum followed by `toFixed(2)` usually gives the same string, so the tests cannot distinguish decimal.js from floats. The value of the library (or of integer cents) is correctness by construction, not something these tests demonstrate.

## 12. Risks and open points

- **Shared locks** (`LOCK IN SHARE MODE`) can make a concurrent product price update wait until an order transaction ends. Acceptable at this scale; revisit under heavy write load.
- **Integration database lifecycle:** the global setup drops and re-creates all tables on every run, which is safe only on the `_test` database; the name guard enforces it.
- **`order_items` has no CHECK constraint on `quantity > 0`;** the service enforces it. A database-level constraint could be added in a later migration.
- **Integration tests are not run in CI.** Adding a MySQL service container to the workflow is a follow-up.
- **Plans overlapping `src/server.ts`:** none; this feature touches no server startup code.
