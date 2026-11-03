# Clean up the old migration name in `SequelizeMeta`

Status: open, operational only (no code change). PR #3 split the single orders migration into
`create-orders` and `create-order-items`, and migration names now drop the `.ts`/`.js` extension
(`src/db/migration-name.ts`). A database migrated before those changes can hold names in
`SequelizeMeta` that no longer match a file, so `pnpm db:status` / `up` may try to re-run
`create-orders` against tables that already exist (error 1050), or list unknown rows.

Local databases were checked and are clean. This applies only to any shared or remote database that was
migrated before #3.

## Procedure (per affected database)
1. **Back up first**: `mysqldump order_sync_hub SequelizeMeta orders order_items > backup.sql`.
2. **Inspect**: `SELECT name FROM SequelizeMeta ORDER BY name;`
   Expected current names, no extension:
   - `2026.10.09T03.45.02.create-products`
   - `2026.10.13T09.21.08.create-orders`
   - `2026.10.13T09.21.10.create-order-items`
3. **Decide per row**
   - Row has a `.ts` / `.js` suffix of a current migration: `UPDATE SequelizeMeta SET name = REPLACE(REPLACE(name,'.ts',''),'.js','') WHERE name LIKE '%.ts' OR name LIKE '%.js';`
   - Row is the old combined orders migration (a name that matches no file) and `orders` plus `order_items` already exist: delete it and insert the two new names, so no table is dropped or recreated.
     `DELETE FROM SequelizeMeta WHERE name = '<old name>';`
     `INSERT INTO SequelizeMeta (name) VALUES ('2026.10.13T09.21.08.create-orders'),('2026.10.13T09.21.10.create-order-items');`
   - Tables do not exist: just delete the old row and run `pnpm db:migrate`.
4. **Verify**: `pnpm db:status` reports no pending migrations and no unknown rows; `pnpm test:integration` against a `_test` copy if available.

## Caution
Never edit `SequelizeMeta` on a database whose tables you have not compared to the migration files. Run in a transaction where possible (DML only; MySQL DDL auto-commits).
