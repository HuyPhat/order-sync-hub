# Split the Orders Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single migration that creates both `orders` and `order_items` with two migrations, one table each, so a failure partway never leaves a half-applied change that the migration history does not know about.

**Architecture:** MySQL commits every DDL statement immediately and cannot roll it back, even inside a transaction. Umzug records a migration only after its `up` finishes. So a migration with two `createTable` calls can leave the first table behind with no history entry. The fix is structural: one table per migration. The resulting schema must be byte-for-byte equivalent to today's; only the migration files change.

**Tech Stack:** umzug 3, Sequelize 6, MySQL 8.4 (Docker), tsx, Vitest.

**Spec:** None written. Rationale and evidence are in the conversation of 2026-10-13 ("two createTable calls in one migration are not atomic"). The rule is also recorded in `docs/superpowers/specs/2026-10-13-stock-tracking-design.md` section 4.

## Why replacing a merged migration is acceptable here

The rule is "never edit a migration that has been applied beyond your own machine". The old migration (`2026.10.11T08.52.44.create-orders`) is merged to `main` (PR #2), but it has been applied only to the owner's **dev** database and **test** database. CI does not migrate, and QA/production do not exist yet. So it is replaced, not patched, and both local databases are rolled back first. Nobody else has to do anything unless they applied the old migration (see Task 2, step 5).

## Global Constraints

- Work on a new branch `fix/split-orders-migration`, never on `main`.
- Start state: on `main`, clean tree, MySQL running and healthy, `pnpm test` shows 77 passing tests, `pnpm test:integration` shows 13 passing.
- Migration filenames come from `pnpm db:create` (the tool makes the timestamp prefix). The two new files must be created at least one second apart, orders first.
- `pnpm db:rollback` reverts the **latest** applied migration; `pnpm db:rollback --to 0` reverts everything in the database named by `MYSQL_DATABASE` (a variable set on the command line beats `.env`).
- The resulting `orders` and `order_items` tables must be identical to today's (same columns, types, defaults, constraints, engine).
- Code is formatted by Prettier (`pnpm format:check` must pass).
- No `Co-Authored-By` line in commit messages. Nothing is pushed by this plan; pushing and opening the PR are the owner's call.

## Review Focus

1. **No data loss in dev.** Rolling back drops both tables, so the plan stops unless both are empty. Pinned in Task 1, step 2.
2. **Orphaned tables in the test database.** The test database also holds the old tables and records the old migration. If the old file is deleted first, no migration can drop those tables any more, and the integration setup fails with `Cannot drop table 'products' referenced by a foreign key constraint`. Pinned in Task 1, step 4.
3. **Same schema before and after.** Pinned by a saved `SHOW CREATE TABLE` diff in Task 1, steps 3 and 11.
4. **Correct order.** `create-orders` must sort before `create-order-items` (the foreign key needs `orders` first). Pinned by the pending list in Task 1, step 9.
5. **Clean partial failure.** If the second migration fails, `orders` exists, `order_items` does not, the history lists only the first, and a re-run completes the job. Pinned in Task 2, step 1.
6. **Each `down` drops only its own table**, and rollback goes newest-first. Pinned in Task 1, step 12.
7. **Anyone who already applied the old migration** must roll it back before pulling. Pinned by the PR note in Task 2, step 5.

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrations/<timestamp>.create-orders.ts` (create) | Creates the `orders` table; `down` drops it. |
| `src/db/migrations/<timestamp>.create-order-items.ts` (create) | Creates `order_items` with its two foreign keys; `down` drops it. |
| `src/db/migrations/2026.10.11T08.52.44.create-orders.ts` (delete) | The old two-table migration. |

No application code, models or tests change.

---

### Task 1: Replace one migration with two

**Files:**
- Create: the two new migration files above
- Delete: `src/db/migrations/2026.10.11T08.52.44.create-orders.ts`

**Interfaces:**
- Consumes: the existing `Migration` type from `src/db/migrator.ts`.
- Produces: migrations whose combined effect equals the old one's (tables `orders`, then `order_items`), recorded in `SequelizeMeta` under their own two names.

- [ ] **Step 1: Branch and check the starting state**

Run:
```bash
git switch -c fix/split-orders-migration
git status --short                      # expect: nothing
docker compose ps                       # expect: mysql "(healthy)"
pnpm test 2>&1 | grep -E "Tests "       # expect: Tests  77 passed (77)
pnpm test:integration 2>&1 | grep -E "Tests "   # expect: Tests  13 passed (13)
```

- [ ] **Step 2: Safety check: the dev tables must be empty**

Run:
```bash
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" "$MYSQL_DATABASE" -N -e "SELECT (SELECT COUNT(*) FROM orders), (SELECT COUNT(*) FROM order_items)"'
pnpm exec tsx --env-file=.env src/db/migrate.ts executed 2>&1 | grep -E "create-"
```
Expected: `0	0` and two executed migrations, with `...create-orders` the last one. **If either count is not 0, stop.** Rolling back would delete that data; ask the owner.

- [ ] **Step 3: Save the current table definitions** (to prove the schema is unchanged later)

Run:
```bash
mkdir -p /tmp/orders-split
for t in orders order_items; do
  docker compose exec -T mysql sh -c "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysql -u\"\$MYSQL_USER\" \"\$MYSQL_DATABASE\" -N -e \"SHOW CREATE TABLE $t\\G\"" | sed 's/ AUTO_INCREMENT=[0-9]*//' > /tmp/orders-split/$t.before.sql
done
wc -l /tmp/orders-split/*.before.sql
```
Expected: two files, each with several lines (the `CREATE TABLE` text).

- [ ] **Step 4: Clear the TEST database's history first**

The test database also holds the old tables and records the old migration. Revert it now, while the old file still exists: once the file is deleted, nothing can drop those tables, and the integration setup would fail on `DROP TABLE products` because `order_items` still references it.
```bash
MYSQL_DATABASE=order_sync_hub_test pnpm db:rollback --to 0 2>&1 | grep -E "reverted|Error"
```
Expected: `reverted 2 migrations.` and no error.

- [ ] **Step 5: Roll back the DEV database's orders migration**

Run:
```bash
pnpm db:rollback 2>&1 | grep -E "reverted|Error"
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" "$MYSQL_DATABASE" -N -e "SHOW TABLES"' | tr '\n' ' '
```
Expected: `reverted 1 migrations.` and the tables `SequelizeMeta products` only.

- [ ] **Step 6: Generate the two new migration files, orders first**

Run:
```bash
pnpm db:create create-orders.ts 2>&1 | grep -E "created|Error"
sleep 1.2
pnpm db:create create-order-items.ts 2>&1 | grep -E "created|Error"
ls src/db/migrations
```
Expected: `event: 'created'` twice; the listing shows the products migration, the old `2026.10.11T08.52.44.create-orders.ts`, and the two new files with `create-orders` sorting before `create-order-items` (the pause gives them different timestamps).

- [ ] **Step 7: Fill in the two files.** Use the generated filenames.

**Replace `src/db/migrations/<timestamp>.create-orders.ts`** with:
```ts
import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator.js';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('orders', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    status: {
      type: DataTypes.ENUM('pending', 'paid', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending',
    },
    total: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('orders');
};
```

**Replace `src/db/migrations/<timestamp>.create-order-items.ts`** with:
```ts
import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator.js';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('order_items', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    orderId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'orders', key: 'id' },
      onDelete: 'CASCADE',
    },
    productId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'products', key: 'id' },
      onDelete: 'RESTRICT',
    },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    unitPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('order_items');
};
```

- [ ] **Step 8: Delete the old migration file**

Run: `git rm src/db/migrations/2026.10.11T08.52.44.create-orders.ts`
Expected: `rm 'src/db/migrations/2026.10.11T08.52.44.create-orders.ts'`.

- [ ] **Step 9: Typecheck, format, and look at the pending list**

Run:
```bash
pnpm format && pnpm typecheck && pnpm format:check
pnpm db:status 2>&1 | grep -E "create-"
```
Expected: no errors; `db:status` lists exactly two pending migrations, `...create-orders` first and `...create-order-items` second.

- [ ] **Step 10: Apply to the dev database**

Run: `pnpm db:migrate 2>&1 | grep -E "applied|Error"`
Expected: `applied 2 migrations.`

- [ ] **Step 11: Prove the schema is unchanged**

Run:
```bash
for t in orders order_items; do
  docker compose exec -T mysql sh -c "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysql -u\"\$MYSQL_USER\" \"\$MYSQL_DATABASE\" -N -e \"SHOW CREATE TABLE $t\\G\"" | sed 's/ AUTO_INCREMENT=[0-9]*//' > /tmp/orders-split/$t.after.sql
  diff /tmp/orders-split/$t.before.sql /tmp/orders-split/$t.after.sql && echo "$t: identical"
done
```
Expected: `orders: identical` and `order_items: identical`, with no diff output.

- [ ] **Step 12: Prove each `down` drops only its own table, newest first**

Run:
```bash
pnpm db:rollback 2>&1 | grep -E "reverted|Error"; docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" "$MYSQL_DATABASE" -N -e "SHOW TABLES"' | tr '\n' ' '; echo
pnpm db:rollback 2>&1 | grep -E "reverted|Error"; docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" "$MYSQL_DATABASE" -N -e "SHOW TABLES"' | tr '\n' ' '; echo
pnpm db:migrate 2>&1 | grep -E "applied|Error"
```
Expected: after the first rollback the tables are `SequelizeMeta orders products` (only `order_items` gone); after the second, `SequelizeMeta products`; the final `db:migrate` prints `applied 2 migrations.`

- [ ] **Step 13: Commit**
```bash
git add src/db/migrations
git commit -m "refactor: create orders and order_items in separate migrations

MySQL commits each DDL statement immediately, so a migration that creates two tables
is not atomic: if the second statement failed, the first table would stay behind
without a history entry. One table per migration leaves a clean, retryable state.
The resulting schema is unchanged."
```
(`git add src/db/migrations` records both the two new files and the deletion.)

---

### Task 2: Prove the benefit, run the full checks, and prepare the PR

**Files:** none changed permanently.

- [ ] **Step 1: Prove that a failure of the second migration now leaves a clean, recoverable state**

This uses the TEST database, which Task 1 step 4 emptied of migrations and which every integration run resets anyway.
```bash
F=$(ls src/db/migrations/*create-order-items.ts)
sed -i '' "s/model: 'orders'/model: 'orders_missing'/" "$F"          # make the second migration fail
MYSQL_DATABASE=order_sync_hub_test pnpm db:migrate 2>&1 | grep -E "applied|Error" | cut -c1-140
echo "executed: $(MYSQL_DATABASE=order_sync_hub_test pnpm exec tsx --env-file=.env src/db/migrate.ts executed 2>&1 | grep -E 'create-' | tr '\n' ' ')"
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" order_sync_hub_test -N -e "SHOW TABLES"' | tr '\n' ' '; echo
```
Expected: an `Error:` line for the order-items migration; `executed:` lists the products and the `create-orders` migrations only (the failed one is not recorded); the tables are `SequelizeMeta orders products`: `orders` exists, `order_items` does not.

Now fix it and re-run:
```bash
git checkout -- "$F"
MYSQL_DATABASE=order_sync_hub_test pnpm db:migrate 2>&1 | grep -E "applied|Error"
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" order_sync_hub_test -N -e "SHOW TABLES"' | tr '\n' ' '; echo
git status --short
```
Expected: `applied 1 migrations.`; tables `SequelizeMeta order_items orders products`; `git status` shows nothing (the temporary edit is gone).

- [ ] **Step 2: Run the full checks**

Run:
```bash
pnpm format:check && pnpm typecheck
pnpm test 2>&1 | grep -E "Tests |FAIL"                  # expect: Tests  77 passed (77)
pnpm test:integration 2>&1 | grep -E "Tests |FAIL"      # expect: Tests  13 passed (13)
pnpm build > /dev/null && echo build-ok
```
Expected as shown. `pnpm build` does not delete old compiled files: if `dist/db/migrations/` still holds a compiled copy of the deleted `2026.10.11T08.52.44.create-orders`, remove those four files (`.js`, `.js.map`, `.d.ts`, `.d.ts.map`), because the dist migrator would treat it as a live migration. Check with `node --env-file=.env dist/db/migrate.js pending` (expected: nothing pending). The integration run resets the test database with the new migrations (`down` to nothing, then `up`), which also proves the integration setup works with the new files.

- [ ] **Step 3: Confirm the dev database ended in the right state**

Run:
```bash
pnpm exec tsx --env-file=.env src/db/migrate.ts executed 2>&1 | grep -E "create-"
pnpm db:status 2>&1 | grep -E "create-" || echo "nothing pending"
```
Expected: three executed migrations (products, orders, order-items) and `nothing pending`.

- [ ] **Step 4: Update the local notes (optional, not committed; `docs/` is git-ignored)**

In `docs/superpowers/specs/2026-10-11-orders-design.md` section 4, change "One migration (generated with `pnpm db:create`) creates both tables" to say that it is two migrations, one table each, and add "(split on 2026-10-13: MySQL DDL is not atomic)".

- [ ] **Step 5: Push and open the PR (the owner's call)**

```bash
git push -u origin fix/split-orders-migration
```
Put this in the PR description: "The `create-orders` migration is split in two. The schema is unchanged. **Anyone who already applied the old `2026.10.11T08.52.44.create-orders` migration must run `pnpm db:rollback` BEFORE pulling this change**, otherwise their old tables are orphaned (no migration can drop them), `down --to 0` and the integration setup fail with `Cannot drop table 'products' referenced by a foreign key constraint`, and `SequelizeMeta` keeps a row for a file that no longer exists. To recover a database with no data to lose, run:

```sql
DELETE FROM SequelizeMeta WHERE name = '2026.10.11T08.52.44.create-orders';
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
```

Note for reviewers: git shows the change as a rename of the old file to `create-order-items.ts` (66% similar); `order_items` never created `orders`, that part moved to the new `create-orders` file. If you run migrations from `dist/`, delete stale compiled files first (`pnpm build` does not clean `dist`). CI and any shared database are unaffected, because none of them migrates yet."

---

## If something goes wrong

- **A step 2 count is not 0:** stop. Nothing has been changed yet.
- **Step 4 or 5 fails:** the old file is still in place, so nothing is lost; read the error and fix it before continuing.
- **Someone skipped step 4 (or pulled this change with the old migration applied) and the integration setup fails with `Cannot drop table 'products' referenced by a foreign key constraint`:** the old tables are orphaned. In a database with **no data to lose** (the test database, or an empty dev database), run:
  ```sql
  DELETE FROM SequelizeMeta WHERE name = '2026.10.11T08.52.44.create-orders';
  DROP TABLE IF EXISTS order_items;
  DROP TABLE IF EXISTS orders;
  ```
  then re-run `pnpm test:integration` (or `pnpm db:migrate` for a dev database). If the tables hold data, stop and ask the owner.
- **After step 8, `db:migrate` fails:** the old file is deleted but the new ones are not applied. Dev and test are both empty of the orders tables, so fix the new file and re-run `pnpm db:migrate`. To restore the old state entirely: `git checkout main -- src/db/migrations` and `pnpm db:migrate`.

## Self-Review

- **Coverage:** the split (Task 1), the proof that the schema is unchanged (steps 3 and 11), the proof of the benefit (Task 2 step 1), the hazard with the test database's history (step 4), the data-loss guard (step 2), and the communication to other developers (PR note).
- **Placeholders:** none; both new files are given in full and every command has its expected output.
- **Consistency:** the migration file names, table names and the `Migration` type are the same everywhere; 77 unit and 13 integration tests are the baseline and the end state.

### Plan verification (2026-10-13)

The commands in this plan were run for real, in a git clone of the repository against two throwaway databases that started in the owner's exact state (the old migration applied in both). The owner's real dev and test databases were not touched, and the throwaway databases were dropped afterwards.

**Verified:**
- Baseline 77 unit and 13 integration tests; Task 1 steps 1 to 13 produce the expected output at every step, including: `pnpm db:rollback --to 0` forwards the flag (`reverted 2 migrations.`); the pending list shows `create-orders` then `create-order-items`; `applied 2 migrations.`; **`SHOW CREATE TABLE` for both tables is identical before and after** (the plan's own diff); the first rollback leaves `orders` and `products`, the second leaves only `products`; git records the change as one rename plus one new file.
- Task 2: with the second migration forced to fail (`Failed to open the referenced table 'orders_missing'`), the history lists only the products and `create-orders` migrations, the tables are `SequelizeMeta orders products`, and after the fix `db:migrate` prints `applied 1 migrations.` and all tables exist. The final checks give 77 and 13 passing, a clean typecheck and format, and a successful build; the dev database ends with three executed migrations and nothing pending.
- The hazard behind step 4, reproduced: with the old tables and history row present and the old file deleted, the integration setup fails with `Migration ...create-products (down) failed: Cannot drop table 'products' referenced by a foreign key constraint 'order_items_ibfk_2'`. The recovery recipe in "If something goes wrong" was run and the suite passed 13 of 13 afterwards.

**Corrected during verification:** an earlier draft said the hazard was umzug failing with `Couldn't find migration to apply with name ...`. That is wrong for this flow: umzug ignores a history row whose file is gone (a stale row alone left the suite green). The real failure is the orphaned tables above. A first verification run also failed for an unrelated reason (my helper script was missing), which the plan's own schema diff in step 11 caught immediately: it reported `Table ... doesn't exist`.

**Not verified:** the push and PR steps (the owner's call), and the optional note in the local orders spec (step 4 of Task 2).

