# QA + Production Migrations Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply database migrations safely to two environments, QA then production, from the same build artifact in CI, with a guard against accidental rollback in production.

**Architecture:** Same code and migration files for every environment; only the injected `MYSQL_*` environment variables differ. CI builds once, then migrates QA, then (after approval) production, each as a job bound to a GitHub Environment that holds its own secrets. Migrations run from the compiled bundle with `node dist/db/migrate.js up`, never with `tsx` or a `.env` file. A small pure function blocks `down` when `NODE_ENV=production`.

**Tech Stack:** umzug 3 + Sequelize 6 + mysql2 (already installed), Vitest, GitHub Actions + GitHub Environments.

**Spec:** None written. Requirements come from the conversation of 2026-10-08: "if I have 2 environments: QA and prod, how would you handle migration?" followed by "yes" to turning the four proposed changes into a plan.

## Scope and an open question

**In scope:** migrating the QA and production *databases* in CI; the production rollback guard; documenting the secrets.

**Out of scope until hosting is chosen:** starting or restarting the app on a host after migrating. The user has not said where QA and prod will run, so the `deploy-*` jobs only migrate. When hosting is chosen, an extra step is added at the end of each `deploy-*` job.

**Assumption to confirm:** GitHub-hosted runners must be able to reach each database over the network. A database on a private network (private VPC, home server) is not reachable from them. In that case use a self-hosted runner, a VPN/SSH tunnel, or run migrations from the host itself. The workflow below is correct either way; only where the job runs changes.

## Global Constraints

- Branch: continue on `setup/mysql-+-Sequelize` unless the user says otherwise.
- `src/config.ts` is the only file that reads `process.env`.
- Tests never touch a real database. The guard is a pure function, tested without MySQL.
- Never commit secrets or `.env`. CI gets secrets only from GitHub Environments.
- CI job chain is fixed: `typecheck` -> `test` -> `build` -> `package` -> `run` -> `deploy-qa` -> `deploy-prod`.
- `deploy-qa` and `deploy-prod` run only on `push` to `main`, never on pull requests.
- Migrations on servers run via `node dist/db/migrate.js up`, not `tsx`.
- Existing applied migration files are never edited.

## Review Focus

1. `down` in production must be refused with a non-zero exit and must not touch the database. Pinned in Task 1.
2. `up`, `pending`, `executed`, `create` and a missing command must stay allowed in production. Pinned in Task 1.
3. An empty `MYSQL_PORT` secret must fall back to 3306, not crash. Already guaranteed by `parsePort` using `||`; confirmed by the existing config tests.
4. Two overlapping pushes must not run two production migrations at once. Pinned in Task 2 via job `concurrency` with `cancel-in-progress: false`.
5. A failed QA migration must stop production from migrating. Guaranteed by `needs: deploy-qa`; checked in Task 2.

## File Structure

| File | Responsibility |
|---|---|
| `src/db/guard.ts` (create) | Pure function `assertMigrationAllowed`; the only place the production-rollback rule lives. |
| `src/db/guard.test.ts` (create) | Unit tests for the guard. |
| `src/config.ts` (modify) | Adds `allowProdRollback` (from `ALLOW_PROD_ROLLBACK === '1'`). |
| `src/config.test.ts` (modify) | Two tests for `allowProdRollback`. |
| `src/db/migrate.ts` (modify) | Calls the guard before running the CLI. |
| `.github/workflows/ci.yml` (modify) | Renames `deploy` to `package`; adds `deploy-qa` and `deploy-prod`. |

---

### Task 1: Production rollback guard (TDD)

**Files:**
- Create: `src/db/guard.ts`, `src/db/guard.test.ts`
- Modify: `src/config.ts`, `src/config.test.ts`, `src/db/migrate.ts`

**Interfaces:**
- Produces: `assertMigrationAllowed(command: string | undefined, nodeEnv: string, allowProdRollback: boolean): void` (throws `Error` when `command === 'down'`, `nodeEnv === 'production'` and `allowProdRollback` is false); `config.allowProdRollback: boolean`.
- Consumes: `config.nodeEnv` (existing).

- [ ] **Step 1: Write the failing tests.** Create `src/db/guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertMigrationAllowed } from './guard.js';

describe('assertMigrationAllowed', () => {
  it('blocks "down" in production', () => {
    expect(() => assertMigrationAllowed('down', 'production', false)).toThrow(/Refusing to run "down"/);
  });

  it('allows "down" in production with the explicit override', () => {
    expect(() => assertMigrationAllowed('down', 'production', true)).not.toThrow();
  });

  it.each(['development', 'qa', 'test'])('allows "down" in %s', (env) => {
    expect(() => assertMigrationAllowed('down', env, false)).not.toThrow();
  });

  it.each(['up', 'pending', 'executed', 'create', undefined])(
    'allows %s in production',
    (command) => {
      expect(() => assertMigrationAllowed(command, 'production', false)).not.toThrow();
    },
  );
});
```

Add these two tests inside the `describe('config', ...)` block of `src/config.test.ts`, after the last existing `it`:

```ts
  it('defaults allowProdRollback to false', async () => {
    vi.stubEnv('ALLOW_PROD_ROLLBACK', '');
    expect((await loadConfig()).allowProdRollback).toBe(false);
  });

  it('enables allowProdRollback only for the exact value "1"', async () => {
    vi.stubEnv('ALLOW_PROD_ROLLBACK', 'true');
    expect((await loadConfig()).allowProdRollback).toBe(false);
    vi.stubEnv('ALLOW_PROD_ROLLBACK', '1');
    expect((await loadConfig()).allowProdRollback).toBe(true);
  });
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm vitest run src/db/guard.test.ts src/config.test.ts`
Expected: `guard.test.ts` fails to load (`./guard.js` does not exist); the two new config tests fail.

- [ ] **Step 3: Implement the guard.** Create `src/db/guard.ts`:

```ts
export function assertMigrationAllowed(
  command: string | undefined,
  nodeEnv: string,
  allowProdRollback: boolean,
): void {
  if (command === 'down' && nodeEnv === 'production' && !allowProdRollback) {
    throw new Error(
      'Refusing to run "down" in production. Write a new forward migration instead, ' +
        'or set ALLOW_PROD_ROLLBACK=1 for a deliberate emergency rollback.',
    );
  }
}
```

- [ ] **Step 4: Add the config flag.** In `src/config.ts`, directly after the `nodeEnv:` line, add:

```ts
    // Escape hatch for a deliberate emergency `down` in production (see src/db/guard.ts).
    allowProdRollback: process.env.ALLOW_PROD_ROLLBACK === '1',
```

- [ ] **Step 5: Wire the guard.** Replace `src/db/migrate.ts` with:

```ts
import { config } from '../config.js';
import { assertMigrationAllowed } from './guard.js';
import { migrator } from './migrator.js';
import { sequelize } from './sequelize.js';

try {
  assertMigrationAllowed(process.argv[2], config.nodeEnv, config.allowProdRollback);
  await migrator.runAsCLI();
} finally {
  await sequelize.close();
}
```

The guard runs inside the `try`, so the connection is still closed when it throws.

- [ ] **Step 6: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass (29 in total: the existing 17, the guard's 10, and the 2 new config tests); `tsc` exits 0.

- [ ] **Step 7: Mutation check.** In `src/db/guard.ts` delete `command === 'down' && ` from the condition and run `pnpm vitest run src/db/guard.test.ts`.
Expected: FAIL (the "allows up/pending/... in production" cases break). Revert and re-run; expected pass.

- [ ] **Step 8: Verify the built command refuses `down` in production, without a database**

Run: `pnpm build && NODE_ENV=production node dist/db/migrate.js down; echo "exit=$?"`
Expected: output contains `Refusing to run "down" in production`; `exit=1`. (This needs no running MySQL, because the guard throws before any query.)

- [ ] **Step 9: Verify it is allowed elsewhere (needs MySQL running)**

Run: `docker compose up -d` and wait for `(healthy)`, then `NODE_ENV=production node --env-file=.env dist/db/migrate.js pending` and `NODE_ENV=qa node --env-file=.env dist/db/migrate.js down`.
Expected: the first prints no error and exits 0; the second prints `reverted 0 migrations.` if nothing is applied. Neither prints `Refusing`.

- [ ] **Step 10: Commit**

```bash
git add src/db/guard.ts src/db/guard.test.ts src/db/migrate.ts src/config.ts src/config.test.ts
git commit -m "feat: refuse migration rollback in production"
```

---

### Task 2: CI jobs that migrate QA then production

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `release` artifact produced by the (renamed) `package` job: `dist/`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`; the command `node dist/db/migrate.js up` (existing); GitHub Environments `qa` and `production` with secrets (Task 3).
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Replace everything in `ci.yml` from the line `  deploy:` to the end of the file** with the jobs below. The jobs above it (`typecheck`, `test`, `build`) stay unchanged.

```yaml
  package:
    needs: build
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: dist
          path: dist
      - name: Assemble release bundle
        run: |
          mkdir release
          cp -R dist release/dist
          cp package.json pnpm-lock.yaml pnpm-workspace.yaml release/
      - uses: actions/upload-artifact@v4
        with:
          name: release
          path: release
          if-no-files-found: error

  run:
    needs: package
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          sparse-checkout: scripts
      - uses: actions/download-artifact@v4
        with:
          name: release
          path: release
      - uses: pnpm/action-setup@v4
        with:
          package_json_file: release/package.json
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Install production dependencies only
        working-directory: release
        run: pnpm install --prod --frozen-lockfile
      - name: Run dist/server.js and check /health
        working-directory: release
        run: bash ../scripts/smoke.sh

  deploy-qa:
    needs: run
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: qa
    concurrency:
      group: deploy-qa
      cancel-in-progress: false
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: release
          path: release
      - uses: pnpm/action-setup@v4
        with:
          package_json_file: release/package.json
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Install production dependencies only
        working-directory: release
        run: pnpm install --prod --frozen-lockfile
      - name: Migrate QA database
        working-directory: release
        run: node dist/db/migrate.js up
        env:
          NODE_ENV: qa
          MYSQL_HOST: ${{ secrets.MYSQL_HOST }}
          MYSQL_PORT: ${{ secrets.MYSQL_PORT }}
          MYSQL_DATABASE: ${{ secrets.MYSQL_DATABASE }}
          MYSQL_USER: ${{ secrets.MYSQL_USER }}
          MYSQL_PASSWORD: ${{ secrets.MYSQL_PASSWORD }}

  deploy-prod:
    needs: deploy-qa
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production
    concurrency:
      group: deploy-prod
      cancel-in-progress: false
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: release
          path: release
      - uses: pnpm/action-setup@v4
        with:
          package_json_file: release/package.json
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Install production dependencies only
        working-directory: release
        run: pnpm install --prod --frozen-lockfile
      - name: Migrate production database
        working-directory: release
        run: node dist/db/migrate.js up
        env:
          NODE_ENV: production
          MYSQL_HOST: ${{ secrets.MYSQL_HOST }}
          MYSQL_PORT: ${{ secrets.MYSQL_PORT }}
          MYSQL_DATABASE: ${{ secrets.MYSQL_DATABASE }}
          MYSQL_USER: ${{ secrets.MYSQL_USER }}
          MYSQL_PASSWORD: ${{ secrets.MYSQL_PASSWORD }}
```

Why these choices: `package` is the old `deploy` job renamed, because it only assembles a bundle and "deploy" now means a real environment. `concurrency` with `cancel-in-progress: false` queues a second run instead of cancelling a migration halfway through. The `if` lines are a second guard; skipped `needs` already skip dependents on pull requests.

- [ ] **Step 2: Validate the workflow structure locally**

Run: `python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print({k: (v.get('needs'), v.get('environment')) for k, v in d['jobs'].items()})"`
Expected: `{'typecheck': (None, None), 'test': ('typecheck', None), 'build': ('test', None), 'package': ('build', None), 'run': ('package', None), 'deploy-qa': ('run', 'qa'), 'deploy-prod': ('deploy-qa', 'production')}`

- [ ] **Step 3: Simulate a deploy job locally.** This is the exact bundle and command CI uses, with the environment injected and no `.env` file in the bundle. Requires MySQL running.

```bash
pnpm build
R=$(mktemp -d) && mkdir "$R/release"
cp -R dist "$R/release/dist"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$R/release/"
cd "$R/release" && pnpm install --prod --frozen-lockfile
ls -a | grep -c '^\.env$'      # expect 0
set -a; . /path/to/project/.env; set +a      # inject env into this shell only
NODE_ENV=qa node dist/db/migrate.js pending
```
Expected: install lists `express`, `mysql2`, `sequelize`, `umzug` (no `tsx`/`vitest`); the `ls` count prints `0`; `pending` exits 0 and prints no error. Replace `/path/to/project` with the real path.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: migrate qa then production from the release bundle"
```

---

### Task 3: GitHub setup (manual, done by the user in the GitHub UI)

No code. Without this, `deploy-qa` and `deploy-prod` fail on the first push to `main` with empty secrets.

- [ ] **Step 1:** Repo -> Settings -> Environments -> New environment: create `qa` and `production`.
- [ ] **Step 2:** In **each** environment, add these secrets with that environment's own database values: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`. Use a dedicated DB user per environment with only the rights migrations need (`CREATE`, `ALTER`, `DROP`, `INDEX`, `SELECT`, `INSERT`, `UPDATE`, `DELETE` on that one database).
- [ ] **Step 3:** In the `production` environment, enable **Required reviewers** and add yourself. This is the manual approval gate between QA and production.
- [ ] **Step 4:** Optionally restrict `production` to deploy only from the `main` branch (Deployment branches -> Selected branches).
- [ ] **Step 5:** After merging, push to `main` and watch Actions. Expected: QA migrates automatically; `deploy-prod` waits for your approval, then runs.

---

## Self-Review

- **Coverage of the four proposed changes:** (1) per-environment config via GitHub Environments secrets (Tasks 2 and 3); (2) run the built code with real environment variables (Task 2 step 1, simulated in step 3); (3) production `down` guard (Task 1); (4) CI shape `deploy-qa` then `deploy-prod` (Task 2).
- **Placeholders:** none. The only deliberate omission is starting the app on a host, declared out of scope because hosting is undecided.
- **Type consistency:** `assertMigrationAllowed` has the same three-parameter signature in Task 1's tests, implementation and `migrate.ts`; `config.allowProdRollback` and `config.nodeEnv` are used by those names throughout.

**Verified in a scratch copy of the project, 2026-10-08:**
- The guard tests: 10 pass; with the `command === 'down'` check removed 5 fail (so the tests can fail).
- Whole suite after wiring the guard (before the two new config tests, which are written but not yet run): 27/27 pass; `tsc --noEmit` clean.
- A production-only install from the release bundle (no `.env`, no `tsx`) loads sequelize, umzug and mysql2 and reads the injected `MYSQL_*` variables (it tried the configured host and port).
- `NODE_ENV=production node dist/db/migrate.js down` printed `Refusing to run "down" in production...` and exited 1.
- The new workflow parses with the expected `needs` chain and environments `qa` / `production`.

**Not verified:**
- Anything touching MySQL on 2026-10-08: Docker Desktop was not running, so Task 1 step 9 and Task 2 step 3 were not re-run today. The same commands (`node --env-file=.env dist/db/migrate.js up/down`) were verified against the real container on 2026-10-07.
- The workflow has not run on GitHub. In particular: environment secrets reaching the job, the approval gate, `concurrency` queuing, and network reachability from GitHub runners to the databases.
- `pnpm/action-setup` reading the `packageManager` field from `release/package.json`.
