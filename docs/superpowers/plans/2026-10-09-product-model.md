# Product Model Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Product` Sequelize model for the existing `products` table, with TypeScript types that catch wrong shapes at compile time and a model that exactly matches the migration.

**Architecture:** One class `Product` in `src/models/product.ts`, extending `Model<InferAttributes<Product>, InferCreationAttributes<Product>>`. Fields are declared with `declare` (so they are types only and do not shadow Sequelize's getters), and `Product.init` repeats the column definitions from the migration. The schema stays owned by migrations; the model never calls `sync()`.

**Tech Stack:** Sequelize 6.37 (TypeScript helper types `InferAttributes`, `InferCreationAttributes`, `CreationOptional`), TypeScript 7, Vitest, MySQL 8.4.

**Spec:** None written. Requirement from the conversation of 2026-10-09: "plan writing a Product model typed properly." The table is defined by `src/db/migrations/2026.10.09T03.45.02.create-products.ts`.

## Decisions

- **`price` is typed `string`, not `number`.** MySQL `DECIMAL` is returned to JavaScript as a string (verified below: `"19.99"`, `typeof` is `string`), so that no floating-point rounding appears. Typing it as `string` makes the compiler reject `price: 19.99` on create, which is the safe behavior for money. Cost if wrong: callers must pass `'19.99'`; if numbers are wanted later, add a conversion layer rather than loosening this type.
- **`declare` on every field.** The project targets `es2022`, where plain class fields are defined on the instance and hide Sequelize's attribute getters. Without `declare`, `product.sku` is `undefined` (verified: removing `declare` made the build test fail with `expected undefined to be 'SKU-1'` and `tsc` report `TS2564`).
- **`createdAt` / `updatedAt` as `CreationOptional<Date>`.** Sequelize fills them; callers must not have to pass them. They match the migration's column names, so no `underscored` option is needed.
- **No validators, hooks, associations or `sync()`.** The database already enforces `NOT NULL` and `UNIQUE`. Add validators when a requirement asks for them.
- **Model is not imported by `server.ts` yet.** No route uses it; wiring belongs with the first endpoint.

## Global Constraints

- `src/config.ts` is the only file that reads `process.env`.
- Tests never touch a real database.
- Relative imports end in `.js`; type-only imports use the inline `type` modifier.
- Code is formatted by Prettier (`pnpm format:check` must pass).
- `tsconfig.json` has `"include": ["src"]`; the model and its test live under `src/models/`.
- The schema is changed only through migrations, never through the model.

## Review Focus

1. Instance fields must be readable (`product.sku` is not `undefined`). Pinned by the "builds an instance" test.
2. `price` passed as a number must be a compile error. Pinned by `@ts-expect-error` in the "rejects wrong shapes" test, enforced by `pnpm typecheck`.
3. A missing required field (`sku`) or an unknown field must be a compile error. Same test.
4. The model must list exactly the migration's columns (drift). Pinned by the "declares exactly the migration columns" test; the live table comparison is Task 1 step 9.
5. Importing the model must not open a database connection, so unit tests run with MySQL down. Verified by running the suite with `MYSQL_PORT=1`.
6. A duplicate `sku` surfaces as `SequelizeUniqueConstraintError`. Verified against the real table in Task 1 step 9.

## File Structure

| File | Responsibility |
|---|---|
| `src/models/product.ts` (create) | The `Product` class and its `init` call. |
| `src/models/product.test.ts` (create) | Offline tests: table name, columns, constraints, DECIMAL type, typed `build`, compile-time shape checks. |

---

### Task 1: The `Product` model

**Files:**
- Create: `src/models/product.ts`, `src/models/product.test.ts`

**Interfaces:**
- Consumes: `sequelize` from `src/db/sequelize.js` (existing, exported as a named `Sequelize` instance).
- Produces: `export class Product` with fields `id: number`, `sku: string`, `name: string`, `price: string`, `createdAt: Date`, `updatedAt: Date`. Creation attributes: `sku`, `name`, `price` required; `id`, `createdAt`, `updatedAt` optional.

- [ ] **Step 1: Write the failing test.** Create `src/models/product.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Product } from './product.js';

describe('Product model', () => {
  it('maps to the products table', () => {
    expect(Product.tableName).toBe('products');
  });

  it('declares exactly the migration columns', () => {
    expect(Object.keys(Product.getAttributes()).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'price',
      'sku',
      'updatedAt',
    ]);
  });

  it('requires sku, name and price, and makes sku unique', () => {
    const attrs = Product.getAttributes();
    expect(attrs.sku?.allowNull).toBe(false);
    expect(attrs.sku?.unique).toBe(true);
    expect(attrs.name?.allowNull).toBe(false);
    expect(attrs.price?.allowNull).toBe(false);
  });

  it('uses DECIMAL(10,2) for price', () => {
    expect(String(Product.getAttributes().price?.type)).toBe('DECIMAL(10,2)');
  });

  it('builds an instance with typed fields, without touching the database', () => {
    const product = Product.build({ sku: 'SKU-1', name: 'Widget', price: '19.99' });
    expect(product.sku).toBe('SKU-1');
    expect(product.name).toBe('Widget');
    expect(product.price).toBe('19.99');
  });

  it('rejects wrong shapes at compile time', () => {
    // Checked by `pnpm typecheck`: each @ts-expect-error fails the typecheck
    // if the line below it stops being an error.
    // @ts-expect-error sku is required
    Product.build({ name: 'Widget', price: '19.99' });
    // @ts-expect-error price is a string, not a number
    Product.build({ sku: 'SKU-1', name: 'Widget', price: 19.99 });
    // @ts-expect-error unknown field
    Product.build({ sku: 'SKU-1', name: 'Widget', price: '19.99', color: 'red' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run src/models/product.test.ts`
Expected: FAIL, with an error that `./product.js` cannot be resolved.

- [ ] **Step 3: Implement the model.** Create `src/models/product.ts`:

```ts
import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export class Product extends Model<InferAttributes<Product>, InferCreationAttributes<Product>> {
  declare id: CreationOptional<number>;
  declare sku: string;
  declare name: string;
  // DECIMAL is a string on purpose: MySQL returns it as text so no float rounding sneaks in.
  declare price: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Product.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    sku: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'products' },
);
```

- [ ] **Step 4: Run tests, typecheck, formatting**

Run: `pnpm test && pnpm typecheck && pnpm format:check`
Expected: `Tests  23 passed (23)` (17 existing + 6 new); `tsc` prints nothing; `All matched files use Prettier code style!`. A passing typecheck proves all three `@ts-expect-error` lines really are errors.

- [ ] **Step 5: Mutation check on the types.** In `src/models/product.ts` change `declare price: string;` to `declare price: number;` and run `pnpm typecheck`.
Expected: errors (the second `@ts-expect-error` becomes "unused", and the string `'19.99'` no longer fits). Revert and re-run; expected clean.

- [ ] **Step 6: Mutation check on `declare`.** Remove the word `declare ` from the `sku` line only and run `pnpm test`.
Expected: the "builds an instance" test FAILS with `expected undefined to be 'SKU-1'`. Revert and re-run; expected pass.

- [ ] **Step 7: Confirm no connection happens on import.** Run: `MYSQL_PORT=1 pnpm test`
Expected: still `23 passed`, with no `ECONNREFUSED`.

- [ ] **Step 8: Build check.** Run: `pnpm build && ls dist/models`
Expected: exit 0; `product.js` is listed and there is no `product.test.js`.

- [ ] **Step 9: Verify against the real table (needs MySQL running).** Create a temporary `verify-product.ts` in the project root:

```ts
import { sequelize } from './src/db/sequelize.js';
import { Product } from './src/models/product.js';

const t = await sequelize.transaction();
try {
  const created = await Product.create(
    { sku: 'VERIFY-1', name: 'Verify', price: '19.99' },
    { transaction: t },
  );
  const found = await Product.findOne({ where: { sku: 'VERIFY-1' }, transaction: t });
  console.log('id is number:', typeof created.id === 'number', '| createdAt is Date:', created.createdAt instanceof Date);
  console.log('price read back:', JSON.stringify(found?.price), '| typeof:', typeof found?.price);
  const columns = Object.keys(await sequelize.getQueryInterface().describeTable('products')).sort();
  const attrs = Object.keys(Product.getAttributes()).sort();
  console.log('model matches table columns:', JSON.stringify(columns) === JSON.stringify(attrs));
  try {
    await Product.create({ sku: 'VERIFY-1', name: 'Dup', price: '1.00' }, { transaction: t });
  } catch (e) {
    console.log('duplicate sku ->', (e as Error).name);
  }
} finally {
  await t.rollback();
  await sequelize.close();
}
```

Run: `pnpm exec tsx --env-file=.env verify-product.ts`
Expected, in this order:
```
id is number: true | createdAt is Date: true
price read back: "19.99" | typeof: string
model matches table columns: true
duplicate sku -> SequelizeUniqueConstraintError
```
Everything runs inside a transaction that is rolled back, so no rows remain. Then delete the script: `rm verify-product.ts`.

- [ ] **Step 10: Commit**

```bash
git add src/models
git commit -m "feat: typed Product model for the products table"
```

---

## Out of scope (add when a feature needs them)

- Using the model: routes, controllers, a service layer (the empty `src/controllers`, `src/routes`, `src/services` folders exist already).
- Validation rules (non-negative price, SKU format). The database enforces `NOT NULL` and `UNIQUE` today.
- Money handling beyond the string type (a decimal library for arithmetic).
- A model registry (`src/models/index.ts`) and associations, once there is a second model.
- Automated drift detection between model and database (needs a test database).

## Self-Review

- **Coverage:** a Product model (class and `init`), typed properly (inferred attribute types, creation-optional fields, `declare`, string `price`, compile-time shape tests), matching the migration (column test and live comparison).
- **Placeholders:** none; every step has complete code or a command with expected output.
- **Type consistency:** field names and types are identical across the interface block, the test and the model; the test's expected column list matches the migration.
- **Verified in a scratch copy of the project against the real MySQL container, 2026-10-09:**
  - Typecheck clean, including the three `@ts-expect-error` lines.
  - 23 tests pass (17 existing + 6 new).
  - `pnpm format:check` clean and `pnpm build` exit 0 with `dist/models/product.js` present and no test file.
  - The suite passes with `MYSQL_PORT=1`, so importing the model opens no connection.
  - Removing `declare` makes the instance test fail (`expected undefined to be 'SKU-1'`) and `tsc` report `TS2564`.
  - The round-trip script printed exactly the four lines in step 9, and a count query afterwards found 0 `VERIFY%` rows.
- **Not verified:** steps 5 and 6 (the two mutation checks) were done in a different form (only the `declare` removal was run, for all fields at once; the `price: number` mutation was not run). The plan's `pnpm test` count of 23 assumes the current 17 tests are unchanged.
