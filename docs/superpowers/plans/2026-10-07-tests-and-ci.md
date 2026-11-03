# Tests (supertest) and GitHub CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get `order-sync-hub` compiling and running, cover every `src/*.ts` file with tests (HTTP tests via supertest), and add a GitHub Actions pipeline: typecheck -> test -> build -> deploy -> run `dist/server.js`.

**Architecture:** Source is ESM TypeScript with extensionless imports (tsconfig `moduleResolution: bundler`). `tsc` only type-checks (`noEmit`); `tsup` (esbuild) bundles `src/server.ts` into `dist/server.js`. Tests are co-located `src/*.test.ts` files run by Vitest. CI is one workflow with five chained jobs; "deploy" assembles a release bundle artifact and "run" proves that bundle boots with production dependencies only.

**Tech Stack:** Node 24, pnpm 12.4.2, TypeScript 7, Express 5, Vitest 5, supertest 7, tsup 8, GitHub Actions.

**Spec:** No spec document. Requirements come from the conversation of 2026-10-07: (1) use supertest to write tests, (2) write tests for `*.ts`, (3) GitHub CI for typecheck -> test -> build -> deploy -> run `dist/server.js`. Earlier in the same conversation the user asked to see "option B" (bundler resolution + tsup) and has not yet rejected it; this plan assumes B.

## Revisions (supersede anything below that conflicts)

- **Option A, not B.** Imports keep `.js` (`'./app.js'`), `tsconfig` stays `module: nodenext`, build is `tsc`. No `tsup`, no bundler resolution.
- **Task 1 was mostly done by the user** (source fixes, `config.ts` with `as const`, `typecheck`/`build` scripts, `types: ["node"]`). Executed remainder only: `.gitignore` (`dist`, `.codegraph`), `packageManager`, test deps, and `tsconfig.build.json` (excludes `src/**/*.test.ts` from `dist`; `build` = `tsc -p tsconfig.build.json`).
- **Task 4 (`server.test.ts`) is left to the user** to write themselves.
- **Task 3 adapted** to the user's `config.ts`: no `Object.isFrozen` test, error message has no quotes around the value, `.js` import.
- **Push deferred.** Commits are local; `origin/main` already holds the user's `322791b`.

## Global Constraints

- Package manager is pnpm; lockfile is `pnpm-lock.yaml` (lockfileVersion 9.0). CI installs with `--frozen-lockfile`.
- Node 24 everywhere (local is v24.20.0).
- `package.json` keeps `"type": "module"`.
- tsconfig keeps `strict`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Type-only imports must use the inline `type` modifier.
- Relative imports are extensionless (`'./app'`, not `'./app.js'`).
- `src/config.ts` is the only file allowed to read `process.env`.
- Tests live next to source as `src/<name>.test.ts`.
- Test files must never bind a real TCP port (supertest uses an ephemeral port internally; `server.ts` is tested with `listen` mocked).
- CI job order is fixed: `typecheck` -> `test` -> `build` -> `deploy` -> `run`.
- `deploy` runs only on `push` to `main`, never on pull requests.

## Review Focus

1. `PORT=""` (empty) must fall back to 3000, not bind a random port. Pinned in Task 3.
2. Invalid `PORT` values (`abc`, `99999`, `-1`, `30.5`, `Infinity`) must fail at startup with `Invalid PORT`. Pinned in Task 3.
3. Unknown routes and wrong methods on `/health` return 404, not a crash or 200. Pinned in Task 2.
4. Importing `server.ts` in tests must not open a real socket (it would leak a handle or collide on a port). Pinned in Task 4.
5. The `run` job must work with production dependencies only. `tsup`/`vitest` missing at runtime must not break boot. Pinned in Task 5 (`pnpm install --prod`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/app.ts` | Express app, `/health` route. Exports `app` as default. No `listen`. |
| `src/config.ts` | Parses and validates env (`PORT`, `NODE_ENV`). Exports frozen `config`. |
| `src/server.ts` | Entry point: imports `app` + `config`, calls `listen`. |
| `src/app.test.ts` | supertest HTTP tests for `app`. |
| `src/config.test.ts` | Env parsing/validation tests. |
| `src/server.test.ts` | Verifies `server.ts` wires `config.port` into `app.listen`. |
| `scripts/smoke.sh` | Boots `dist/server.js`, polls `/health`, asserts body. Used by CI `run` job. |
| `.github/workflows/ci.yml` | The pipeline. |
| `tsconfig.json`, `package.json`, `.gitignore` | Build/test configuration (modified). |

---

### Task 1: Fix the source and move to bundler resolution (option B)

The current `app.ts`/`server.ts` contain `require 'express'` (invalid syntax) in an ESM project. This task makes the project compile and run. Nothing else can start until it does.

**Files:**
- Modify: `src/app.ts`, `src/server.ts`, `tsconfig.json`, `package.json`, `.gitignore`
- Create: `src/config.ts`

**Interfaces:**
- Produces: `default export app: Express` from `src/app.ts`; `export const config: Readonly<{ port: number; nodeEnv: string }>` from `src/config.ts`. Later tasks import these exactly.

- [ ] **Step 1: Replace `src/app.ts`**

```ts
import express from 'express';

const app = express();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

export default app;
```

- [ ] **Step 2: Create `src/config.ts`**

```ts
function parsePort(raw: string | undefined, fallback: number): number {
  const port = Number(raw || fallback);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: "${raw}" (expected an integer between 0 and 65535)`);
  }
  return port;
}

export const config = Object.freeze({
  port: parsePort(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
});
```

- [ ] **Step 3: Replace `src/server.ts`**

```ts
import app from './app';
import { config } from './config';

app.listen(config.port, () => {
  console.log(`Server is running on port ${config.port} (${config.nodeEnv})`);
});
```

- [ ] **Step 4: Replace `tsconfig.json`** (drops emit options, switches to bundler resolution, restricts to `src`)

```json
{
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "es2022",
    "types": ["node"],
    "noEmit": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "strict": true,
    "jsx": "react-jsx",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noUncheckedSideEffectImports": true,
    "moduleDetection": "force",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Add dev dependencies**

Run: `pnpm add -D tsup vitest supertest @types/supertest`
Expected: installs succeed; `pnpm-lock.yaml` updated.

- [ ] **Step 6: Edit `package.json`**: replace the `scripts` block and add `packageManager` (required by `pnpm/action-setup` in CI)

```json
  "packageManager": "pnpm@12.4.2",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "typecheck": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "tsup src/server.ts --format esm --platform node --sourcemap --clean",
    "start": "node dist/server.js"
  },
```

- [ ] **Step 7: Make `.gitignore` ignore build output.** It currently contains `node_modules` with no trailing newline. Replace its content with:

```
node_modules
dist
```

- [ ] **Step 8: Verify typecheck, build, run**

Run: `pnpm typecheck && pnpm build && (PORT=3099 node dist/server.js & P=$!; sleep 1.5; curl -s localhost:3099/health; echo; kill $P)`
Expected: `tsc` prints nothing and exits 0; tsup prints `Build success`; curl prints `{"status":"ok"}`.

- [ ] **Step 9: Commit**

```bash
git add .gitignore package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json src
git commit -m "fix: valid ESM sources, config module, tsup build"
```

---

### Task 2: HTTP tests for `app.ts` with supertest

**Files:**
- Create: `src/app.test.ts`

**Interfaces:**
- Consumes: `default export app` from `src/app.ts` (Task 1).

- [ ] **Step 1: Write the tests**

```ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from './app';

describe('GET /health', () => {
  it('returns 200 and { status: "ok" }', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns a JSON content type', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });

  it('returns 404 for POST /health (only GET is defined)', async () => {
    const res = await request(app).post('/health');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run and confirm pass**

Run: `pnpm vitest run src/app.test.ts`
Expected: `4 passed`.

- [ ] **Step 3: Prove the tests can fail (mutation check)**

Temporarily change `status: 'ok'` to `status: 'bad'` in `src/app.ts`, then run `pnpm vitest run src/app.test.ts`.
Expected: `returns 200 and { status: "ok" }` FAILS. Revert the change and re-run; expected `4 passed`.

- [ ] **Step 4: Typecheck, then commit**

Run: `pnpm typecheck`
Expected: exit 0.

```bash
git add src/app.test.ts
git commit -m "test: supertest coverage for /health"
```

---

### Task 3: Tests for `config.ts`

`config` runs `parsePort` at import time, so each test must re-import the module with a fresh environment (`vi.resetModules()` + `vi.stubEnv`).

**Files:**
- Create: `src/config.test.ts`

**Interfaces:**
- Consumes: `export const config` from `src/config.ts` (Task 1).

- [ ] **Step 1: Write the tests**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadConfig() {
  vi.resetModules();
  return (await import('./config')).config;
}

describe('config', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to port 3000 and development when env is empty', async () => {
    vi.stubEnv('PORT', '');
    vi.stubEnv('NODE_ENV', '');
    const config = await loadConfig();
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe('development');
  });

  it('parses a numeric PORT string into a number', async () => {
    vi.stubEnv('PORT', '8080');
    const config = await loadConfig();
    expect(config.port).toBe(8080);
    expect(typeof config.port).toBe('number');
  });

  it('accepts the upper boundary 65535', async () => {
    vi.stubEnv('PORT', '65535');
    expect((await loadConfig()).port).toBe(65535);
  });

  it.each(['abc', '99999', '-1', '30.5', 'Infinity'])(
    'throws for invalid PORT %s',
    async (bad) => {
      vi.stubEnv('PORT', bad);
      await expect(loadConfig()).rejects.toThrow(/Invalid PORT/);
    },
  );

  it('uses NODE_ENV when provided', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await loadConfig()).nodeEnv).toBe('production');
  });

  it('is frozen', async () => {
    expect(Object.isFrozen(await loadConfig())).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm pass**

Run: `pnpm vitest run src/config.test.ts`
Expected: `10 passed`.

- [ ] **Step 3: Mutation check**

In `src/config.ts` change `Number(raw || fallback)` to `Number(raw ?? fallback)`, run `pnpm vitest run src/config.test.ts`.
Expected: `defaults to port 3000...` FAILS (empty string becomes 0). Revert and re-run; expected `10 passed`.

- [ ] **Step 4: Typecheck, then commit**

Run: `pnpm typecheck`
Expected: exit 0.

```bash
git add src/config.test.ts
git commit -m "test: config parsing and validation"
```

---

### Task 4: Test for `server.ts`

`server.ts` calls `app.listen` on import. The test mocks `listen` so no socket is opened, then asserts the wiring: `config.port` is passed through and the startup message is logged.

**Files:**
- Create: `src/server.test.ts`

**Interfaces:**
- Consumes: `default export app` (`src/app.ts`), `src/server.ts` side effect, `config.port` (Task 1).

- [ ] **Step 1: Write the test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('server', () => {
  it('listens on config.port and logs on startup', async () => {
    vi.stubEnv('PORT', '4321');
    vi.resetModules();
    const { default: app } = await import('./app');
    const listen = vi.spyOn(app, 'listen').mockImplementation(((_port: number, cb?: () => void) => {
      cb?.();
      return {} as never;
    }) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await import('./server');

    expect(listen).toHaveBeenCalledWith(4321, expect.any(Function));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('4321'));
  });
});
```

- [ ] **Step 2: Run the whole suite**

Run: `pnpm test`
Expected: `Test Files  3 passed (3)`, `Tests  15 passed (15)`.

- [ ] **Step 3: Mutation check**

In `src/server.ts` change `config.port` in the `listen` call to `3000`, run `pnpm vitest run src/server.test.ts`.
Expected: FAILS (`listen` called with 3000, not 4321). Revert and re-run; expected pass.

- [ ] **Step 4: Typecheck, then commit**

Run: `pnpm typecheck`
Expected: exit 0.

```bash
git add src/server.test.ts
git commit -m "test: server wires config.port into listen"
```

---

### Task 5: Smoke script and GitHub Actions pipeline

**Files:**
- Create: `scripts/smoke.sh`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: scripts `typecheck`, `test`, `build` (Task 1); `dist/server.js` output; `packageManager` field (Task 1).
- Produces: workflow artifacts `dist` (from `build`) and `release` (from `deploy`).

**Assumption to confirm with the user:** "deploy" has no named target yet. This plan defines it as assembling a release bundle (`dist/` + `package.json` + lockfile) and uploading it as an artifact; the `run` job then proves that bundle boots. Swapping in a real target (Fly.io, Render, Vercel, SSH, container registry) means replacing the body of the `deploy` job only.

- [ ] **Step 1: Create `scripts/smoke.sh`**

```bash
#!/usr/bin/env bash
# Starts the built server (dist/server.js) and verifies /health responds.
set -euo pipefail

PORT="${PORT:-3100}"
export PORT

node dist/server.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do
  if body=$(curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null); then
    echo "health: $body"
    [ "$body" = '{"status":"ok"}' ] || { echo "unexpected body: $body" >&2; exit 1; }
    exit 0
  fi
  sleep 0.5
done

echo "server did not become healthy on port ${PORT}" >&2
exit 1
```

Then run: `chmod +x scripts/smoke.sh`

- [ ] **Step 2: Verify the smoke script locally**

Run: `pnpm build && bash scripts/smoke.sh`
Expected: prints `Server is running on port 3100 (development)` and `health: {"status":"ok"}`, exit 0.

- [ ] **Step 3: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck

  test:
    needs: typecheck
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test

  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist
          if-no-files-found: error

  deploy:
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
    needs: deploy
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
```

- [ ] **Step 4: Validate the workflow locally**

Run: `python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print({k: v.get('needs') for k, v in d['jobs'].items()})"`
Expected: `{'typecheck': None, 'test': 'typecheck', 'build': 'test', 'deploy': 'build', 'run': 'deploy'}`

- [ ] **Step 5: Simulate the `deploy` + `run` jobs locally**

Run:
```bash
pnpm build
R=$(mktemp -d) && mkdir "$R/release" "$R/scripts"
cp -R dist "$R/release/dist"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$R/release/"
cp scripts/smoke.sh "$R/scripts/"
(cd "$R/release" && pnpm install --prod --frozen-lockfile && bash ../scripts/smoke.sh)
```
Expected: only `express` installed, then `health: {"status":"ok"}`, exit 0. This proves the bundle needs no dev dependencies.

- [ ] **Step 6: Commit and push to see it run on GitHub**

```bash
git add scripts/smoke.sh .github/workflows/ci.yml
git commit -m "ci: typecheck -> test -> build -> deploy -> run pipeline"
```
Pushing needs a GitHub remote (none is configured today: `git remote -v` is empty). After `git push -u origin main`, check the Actions tab: expected five green jobs in order. Open a test PR and confirm `deploy` and `run` are skipped.

---

## Self-Review

- **Spec coverage:** supertest tests (Task 2); tests for every `*.ts` file: `app.ts` (2), `config.ts` (3), `server.ts` (4); the CI order typecheck -> test -> build -> deploy -> run (5). The prerequisite source fix is Task 1.
- **Placeholders:** none. All code is complete. The `deploy` target is defined concretely and flagged as an assumption.
- **Type consistency:** `app` (default export), `config.port`, `config.nodeEnv` are used identically in every task. Script names `typecheck`/`test`/`build` match the workflow.
- **Verified in a scratch copy before writing:** typecheck exit 0; 15 tests pass (4 + 10 + 1); a mutation on `/health` fails the suite; `tsup` build produces `dist/server.js`; the prod-only release simulation prints `health: {"status":"ok"}`; workflow YAML parses with the expected `needs` chain.
- **Not verified:** the workflow has not run on GitHub (no remote), so action versions (`checkout@v4`, `pnpm/action-setup@v4`, `setup-node@v4`, `upload/download-artifact@v4`) and `pnpm/action-setup` reading `packageManager` are untested there.
