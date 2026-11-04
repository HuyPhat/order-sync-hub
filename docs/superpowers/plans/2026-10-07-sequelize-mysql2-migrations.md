# Sequelize + mysql2 + Migrations Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install Sequelize with the `mysql2` driver and a migration tool, wired to the MySQL 8.4 container from `docker-compose.yml`, so schema changes are versioned files you can apply and roll back with one command.

**Architecture:** `config.ts` (the only file that reads `process.env`) gains a `db` block that reuses the same `MYSQL_*` variable names as `docker-compose.yml`. `src/db/sequelize.ts` exports one `Sequelize` instance. `src/db/migrator.ts` configures an `Umzug` migrator on top of it (applied-migration history stored in a `SequelizeMeta` table). `src/db/migrate.ts` is a tiny CLI wrapper exposed through `pnpm db:*` scripts. No domain tables are created in this plan.

**Tech Stack:** Sequelize 6.37 (`latest` on npm; v7 is still alpha), mysql2 3.24, umzug 3.8, tsx (already installed), Node 24, MySQL 8.4 via Docker Compose.

**Spec:** None written. Requirements come from the conversation of 2026-10-07: "install sequelize, mysql2, and a migration tool". Branch: `setup/mysql-+-Sequelize`.

## Decision: umzug, not sequelize-cli

`sequelize-cli` is the tool most tutorials show, but it is CommonJS-first, driven by a `.sequelizerc` file and a JSON/JS config, and does not run TypeScript. This project is ESM + TypeScript. `umzug` is what the Sequelize docs themselves recommend for programmatic migrations: migrations are plain `.ts` files typed against `QueryInterface`, run with the `tsx` you already have, and share the app's `config.ts`. Cost if wrong: you write 40 lines of wiring (this plan) instead of running `sequelize-cli init`.

## Global Constraints

- pnpm only; lockfile `pnpm-lock.yaml`; Node 24; `"type": "module"`.
- `tsconfig` stays `module: nodenext` with `verbatimModuleSyntax`; relative imports end in `.js`; type-only imports use the inline `type` modifier.
- `src/config.ts` is the only file that reads `process.env`.
- DB variable names are exactly the ones in `docker-compose.yml` / `.env.example`: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD` (host and port are new and optional).
- The database is reachable only via `127.0.0.1:3306` (compose binds loopback). Do not change that.
- Tests never touch a real database. Migration behavior is verified by hand against the compose MySQL (Task 2).
- `.env` is git-ignored and must never be committed or printed in logs.

## Review Focus

1. Wrong or missing `MYSQL_PASSWORD` must fail with MySQL's `Access denied` message, not hang or crash obscurely. Verified in Task 2.
2. Running `db:migrate` twice must apply nothing the second time (idempotent). Pinned in Task 2.
3. `db:rollback` reverts exactly one migration (the latest), not all. Pinned in Task 2.
4. The compiled build (`node dist/db/migrate.js`) must work, not just `tsx`. `declaration: true` emits `*.d.ts` files into `dist/db/migrations/`; the glob must ignore them. Pinned in Task 2.
5. An invalid `MYSQL_PORT` (`abc`, `99999`) must fail at startup with `Invalid MYSQL_PORT`. Pinned in Task 1.

## File Structure

| File | Responsibility |
|---|---|
| `src/config.ts` (modify) | Adds `config.db`; `parsePort` gets a `name` parameter for error messages. |
| `src/config.test.ts` (modify) | Three new tests for `config.db`. |
| `src/db/sequelize.ts` (create) | The single `Sequelize` instance. |
| `src/db/migrator.ts` (create) | `Umzug` setup, migration template, exported `Migration` type. |
| `src/db/migrate.ts` (create) | CLI entry: runs the umzug CLI, then closes the connection. |
| `src/db/migrations/` (create, empty) | Where migration files live. |
| `package.json` (modify) | Dependencies and `db:*` scripts. |
| `.env.example` (modify) | Documents the two new optional variables. |

---

### Task 1: Install dependencies and add `config.db` (TDD)

**Files:**
- Modify: `package.json` (via pnpm), `src/config.ts`, `src/config.test.ts`

**Interfaces:**
- Produces: `config.db: { host: string; port: number; name: string; user: string; password: string }`, readonly via `as const`. Task 2 consumes it exactly.

- [ ] **Step 1: Install runtime dependencies**

Run: `pnpm add sequelize mysql2 umzug`
Expected: `+ sequelize 6.37.x`, `+ mysql2 3.x`, `+ umzug 3.x`; lockfile updated.

- [ ] **Step 2: Write the failing tests.** In `src/config.test.ts`, add these three tests inside the existing `describe('config', ...)` block, after the last existing `it`:

```ts
  it('defaults db settings to the docker-compose values', async () => {
    for (const key of ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD']) {
      vi.stubEnv(key, '');
    }
    expect((await loadConfig()).db).toEqual({
      host: '127.0.0.1',
      port: 3306,
      name: 'order_sync_hub',
      user: 'app',
      password: '',
    });
  });

  it('reads db settings from MYSQL_* env vars', async () => {
    vi.stubEnv('MYSQL_HOST', 'db.internal');
    vi.stubEnv('MYSQL_PORT', '3399');
    vi.stubEnv('MYSQL_DATABASE', 'orders');
    vi.stubEnv('MYSQL_USER', 'svc');
    vi.stubEnv('MYSQL_PASSWORD', 's3cret');
    expect((await loadConfig()).db).toEqual({
      host: 'db.internal',
      port: 3399,
      name: 'orders',
      user: 'svc',
      password: 's3cret',
    });
  });

  it('throws for an invalid MYSQL_PORT', async () => {
    vi.stubEnv('MYSQL_PORT', 'abc');
    await expect(loadConfig()).rejects.toThrow(/Invalid MYSQL_PORT/);
  });
```

- [ ] **Step 3: Run and confirm they fail**

Run: `pnpm vitest run src/config.test.ts`
Expected: `3 failed | 10 passed` (the three new tests fail because `config.db` does not exist yet).

- [ ] **Step 4: Implement.** Replace `src/config.ts` with:

```ts
function parsePort(raw: string | undefined, fallback: number, name = 'PORT'): number {
    const port = Number(raw || fallback);

    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid ${name}: ${raw} (expected an integer between 0 and 65535)`);
    }

    return port;
}

export const config = {
    port: parsePort(process.env.PORT, 3000),
    nodeEnv: process.env.NODE_ENV || 'development',
    // Same variable names docker-compose.yml uses, so .env is the single source.
    db: {
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: parsePort(process.env.MYSQL_PORT, 3306, 'MYSQL_PORT'),
        name: process.env.MYSQL_DATABASE || 'order_sync_hub',
        user: process.env.MYSQL_USER || 'app',
        password: process.env.MYSQL_PASSWORD || '',
    },
} as const;
```

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: `Tests  17 passed (17)`; `tsc` prints nothing and exits 0. The existing `Invalid PORT` tests still pass because `name` defaults to `'PORT'`.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/config.ts src/config.test.ts
git commit -m "feat: add sequelize, mysql2, umzug and config.db"
```

---

### Task 2: Sequelize instance, migrator, CLI and scripts

Verified by running against a real MySQL, because migration tooling has no meaningful unit test without a database.

**Files:**
- Create: `src/db/sequelize.ts`, `src/db/migrator.ts`, `src/db/migrate.ts`, `src/db/migrations/.gitkeep`
- Modify: `package.json` (scripts), `.env.example`

**Interfaces:**
- Consumes: `config.db` (Task 1).
- Produces: `sequelize: Sequelize` from `src/db/sequelize.ts`; `migrator: Umzug<QueryInterface>` and `type Migration` from `src/db/migrator.ts`.

- [ ] **Step 1: Create `src/db/sequelize.ts`**

```ts
import { Sequelize } from 'sequelize';
import { config } from '../config.js';

export const sequelize = new Sequelize(config.db.name, config.db.user, config.db.password, {
  host: config.db.host,
  port: config.db.port,
  dialect: 'mysql',
  logging: false,
});
```

- [ ] **Step 2: Create `src/db/migrator.ts`**

```ts
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SequelizeStorage, Umzug } from 'umzug';
import { sequelize } from './sequelize.js';

const migrationsDir = join(import.meta.dirname, 'migrations');

export const migrator = new Umzug({
  migrations: {
    // ignore *.d.ts: `declaration: true` emits them next to compiled migrations in dist/
    glob: ['*.{ts,js}', { cwd: migrationsDir, ignore: ['*.d.ts'] }],
    // Load with import() so ESM migrations work (umzug's default uses require()).
    resolve: ({ name, path, context }) => ({
      name,
      up: async () => (await import(pathToFileURL(path!).href)).up({ context }),
      down: async () => (await import(pathToFileURL(path!).href)).down({ context }),
    }),
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger: console,
  create: {
    folder: migrationsDir,
    template: (filepath) => [
      [
        filepath,
        [
          "import type { Migration } from '../migrator.js';",
          '',
          'export const up: Migration = async ({ context: queryInterface }) => {};',
          '',
          'export const down: Migration = async ({ context: queryInterface }) => {};',
          '',
        ].join('\n'),
      ],
    ],
  },
});

export type Migration = typeof migrator._types.migration;
```

- [ ] **Step 3: Create `src/db/migrate.ts`**

```ts
import { migrator } from './migrator.js';
import { sequelize } from './sequelize.js';

try {
  await migrator.runAsCLI();
} finally {
  await sequelize.close();
}
```

- [ ] **Step 4: Create the migrations folder and add scripts**

Run: `mkdir -p src/db/migrations && touch src/db/migrations/.gitkeep`

In `package.json`, add these to `scripts` (keep the existing ones):

```json
    "db:migrate": "tsx --env-file=.env src/db/migrate.ts up",
    "db:rollback": "tsx --env-file=.env src/db/migrate.ts down",
    "db:status": "tsx --env-file=.env src/db/migrate.ts pending",
    "db:create": "tsx --env-file=.env src/db/migrate.ts create --name"
```

`--env-file=.env` loads your `.env` so the scripts see the same `MYSQL_*` values as Compose. Usage: `pnpm db:create add-orders.ts` (the `.ts` extension is part of the name).

- [ ] **Step 5: Document the optional variables.** Append to `.env.example`:

```
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
```

(Both are optional; defaults shown. The existing `# optional, defaults shown` comment already covers them.)

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0, no output.

- [ ] **Step 7: Start MySQL and wait for healthy**

Run: `docker compose up -d && until [ "$(docker inspect -f '{{.State.Health.Status}}' order-sync-hub-mysql-1)" = healthy ]; do sleep 3; done; echo healthy`
Expected: prints `healthy` within about 30 seconds. (Container name is `<folder>-mysql-1`; check `docker compose ps` if your folder name differs. Your `.env` must define `MYSQL_ROOT_PASSWORD` and `MYSQL_PASSWORD`.)

- [ ] **Step 8: Create a throwaway migration and give it a body**

Run: `pnpm db:create create-widgets.ts`
Expected: prints `event: 'created'` and a path like `src/db/migrations/2026.10.07T07.42.42.create-widgets.ts`.

Replace that new file's content with:

```ts
import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator.js';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('widgets', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('widgets');
};
```

Run: `pnpm typecheck`
Expected: exits 0 (the generated template and your edit type-check against `QueryInterface`).

- [ ] **Step 9: Apply, check, re-apply, roll back**

Run each and compare:

| Command | Expected |
|---|---|
| `pnpm db:status` | lists the one pending migration file name |
| `pnpm db:migrate` | `applied 1 migrations.` |
| `docker compose exec mysql sh -c 'mysql -uapp -p"$MYSQL_PASSWORD" order_sync_hub -e "SHOW TABLES"'` | shows `SequelizeMeta` and `widgets` |
| `pnpm db:migrate` (again) | `applied 0 migrations.` (idempotent) |
| `pnpm db:rollback` | `reverted 1 migrations.` |
| the `SHOW TABLES` command again | only `SequelizeMeta` remains |

- [ ] **Step 10: Verify the compiled build (not just tsx)**

Run: `pnpm build && node --env-file=.env dist/db/migrate.js up && node --env-file=.env dist/db/migrate.js down`
Expected: `applied 1 migrations.` then `reverted 1 migrations.`. If you see `up is not a function` for a `.d.ts` file, the `ignore: ['*.d.ts']` in `migrator.ts` is missing.

- [ ] **Step 11: Verify a wrong password fails clearly**

Run: `MYSQL_PASSWORD=wrong node --env-file=.env dist/db/migrate.js pending`
Expected: an error containing `Access denied for user 'app'`. Process exits non-zero.

- [ ] **Step 12: Remove the throwaway migration and commit**

Run: `rm src/db/migrations/*create-widgets.ts`

```bash
git add src/db package.json .env.example
git commit -m "feat: sequelize instance and umzug migration runner"
```

---

## Out of scope (say so if you want them)

- Domain tables/models (orders, etc.): the tool is ready; the first real migration is a separate task.
- Running migrations in CI or on deploy: CI has no database today. Add a MySQL service container and a `db:migrate` step later.
- A connection check on server startup (`sequelize.authenticate()` in `server.ts`).
- Seeders (test data). A second `Umzug` instance with its own folder and storage table would cover it.

## Self-Review

- **Coverage:** install sequelize + mysql2 + a migration tool (Task 1 step 1, Task 2); config wiring (Task 1); runnable commands (Task 2 step 4).
- **Placeholders:** none. All code is complete.
- **Type consistency:** `config.db` fields (`host`, `port`, `name`, `user`, `password`) are identical in Task 1's tests, implementation, and Task 2's `sequelize.ts`. `Migration` is exported from `migrator.ts` and imported by the template and the example migration.
- **Verified in a scratch copy against a real MySQL 8.4 container (isolated project `dbverify`, port 3399, removed afterwards):** typecheck clean; `create`, `pending`, `up`, second `up` (0 applied), `down` all behaved as in Task 2's tables; `SHOW TABLES` confirmed `widgets` created and dropped; the built `node dist/db/migrate.js` path works after adding `ignore: ['*.d.ts']` (it failed without it, which is how that line was found); a wrong password produced `Access denied`; the new config tests are red (3 failed) on the current `config.ts` and green (17 passed) on the new one; the existing 14 tests still pass.
- **Not verified:** the exact container name in Task 2 step 7 on your machine (depends on your folder name); behavior of `pnpm db:*` with an `.env` that lacks `MYSQL_PASSWORD`.
