# Fail Fast on a Missing MYSQL_PASSWORD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `MYSQL_PASSWORD` is empty, say so in plain language at the point the database is actually needed, instead of surfacing `Access denied for user 'app' (using password: NO)` from deep inside mysql2.

**Architecture:** One tiny pure function, `dbPasswordProblem(password)`, returns a plain-language message or `undefined`. Two callers use it: the migration CLI (always requires a password) and the server's startup (requires it everywhere except development and test, where it only warns). `config.ts` stays permissive on purpose.

**Tech Stack:** TypeScript 7, Vitest 5, Node 24. No new dependencies.

**Spec:** None written. Requirement from the conversation of 2026-10-11: "Empty password is still allowed. Without MYSQL_PASSWORD you get Access denied (using password: NO) from deep inside mysql2. Decide whether to fail fast with a clear message at startup." The decision is below.

## Status (refreshed 2026-11-02)

Planned, **not implemented**: `src/config.ts` still reads `process.env.MYSQL_PASSWORD || ''`, and `src/server.ts` / `src/db/migrate.ts` have no password check. Both files are still in the shape this plan expects. Test baseline is now 150 unit tests, so the suite ends at 158 (see Task 3 Step 4). The QA/production migration jobs mentioned below do not exist in `.github/workflows/ci.yml` yet; the note only matters once they do.

**Reviewer asked (2026-11-02) for the check to live in `config.ts`, at least for `NODE_ENV=production`.** That variant was not measured in October (Option A threw for every environment). It would work if `config.ts` threw only when `nodeEnv` is not `development` or `test`: unit tests run with `NODE_ENV=test` and the CI smoke test with it unset, so neither would break. The plan keeps Option B because the check then sits where a database is actually needed (the migration CLI needs one in every environment, which a config-level check cannot express) and `config.ts` stays free of side effects on import. The observable result the reviewer wants is the same: in production a blank password stops startup with a plain message. If you prefer the config-level check, replace Task 3's `server.ts` block with that throw and keep Tasks 1 and 2.

## Decision

**Yes, fail fast, but not in `config.ts` and not unconditionally.**

Two options were built in a scratch copy and run:

| | A. `config.ts` throws when the password is blank | B. Targeted check (this plan) |
|---|---|---|
| Unit tests (vitest loads no `.env`) | **14 fail** across 5 files | all pass |
| CI smoke test (`server` with no database env) | **fails, exit 1** | passes (prints a warning) |
| `/health` while the database is unconfigured | breaks: the process cannot start | still 200 |
| Clear message when a password is genuinely needed | yes | yes |

Option A is rejected: the server is designed to run without a database (`/health` is a pure liveness check and CI's smoke test deliberately has no database), and importing the config must stay side-effect free for tests.

Option B puts the check where a database is actually required:

- **Migration CLI:** always needs a database, so a blank password exits 1 with the message, before any connection attempt.
- **Server startup:** in `development` and `test` it only warns (the server runs fine without a database; only `/health/db` reports down). In any other `NODE_ENV` (`production`, `qa`, ...) a blank password is a deployment mistake, so it prints `Refusing to start: ...` and exits 1.

CI is unaffected: the smoke test runs with `NODE_ENV` unset, which `config.ts` treats as `development`, and the QA/production migration jobs pass `MYSQL_PASSWORD` from their environment secrets.

## Global Constraints

- `src/config.ts` is the only file that reads `process.env`; it is **not modified** by this plan.
- Tests never touch a real database or open a real port.
- Relative imports end in `.js`; formatting by Prettier (`pnpm format:check` must pass).
- End every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (user preference since 2026-11-02; earlier commits are not rewritten).
- A password that is only spaces counts as set (a space can be a valid password); only an empty value is a problem.

## Review Focus

1. `NODE_ENV=production` and `qa` with a blank password must exit 1 at startup. Pinned in Task 3.
2. `development` and `test` with a blank password must start and warn, so `/health` and CI keep working. Pinned in Task 3.
3. The migration CLI must exit 1 with the message and never reach mysql2. Task 2, real-process step.
4. A set password changes nothing: no warning, no exit. Pinned in Task 3.
5. The CI smoke test with no database env still exits 0. Task 3, real-process step.

## File Structure

| File | Responsibility |
|---|---|
| `src/db/preflight.ts` (create) | `dbPasswordProblem`: the message, in one place. |
| `src/db/preflight.test.ts` (create) | Unit tests for it. |
| `src/db/migrate.ts` (replace) | Check before touching the database. |
| `src/server.ts` (modify) | Check before `app.listen`. |
| `src/server.test.ts` (modify) | Five new tests for the startup behavior. |
| `scripts/README.md` (modify) | One troubleshooting row. |

---

### Task 1: The check, as a pure function (TDD)

**Files:**
- Create: `src/db/preflight.ts`, `src/db/preflight.test.ts`

**Interfaces:**
- Produces: `dbPasswordProblem(password: string): string | undefined`. Returns the message `MYSQL_PASSWORD is not set. Add it to .env (see .env.example) or the environment.` for an empty string, otherwise `undefined`.

- [ ] **Step 1: Write the failing test.** Create `src/db/preflight.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dbPasswordProblem } from './preflight.js';

describe('dbPasswordProblem', () => {
  it('reports a missing password in plain language', () => {
    expect(dbPasswordProblem('')).toMatch(/MYSQL_PASSWORD is not set/);
  });

  it('names where to set it', () => {
    expect(dbPasswordProblem('')).toMatch(/\.env/);
  });

  it('reports nothing when a password is present', () => {
    expect(dbPasswordProblem('s3cret')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run src/db/preflight.test.ts`
Expected: FAIL, `./preflight.js` cannot be resolved.

- [ ] **Step 3: Implement.** Create `src/db/preflight.ts`:

```ts
// A missing password otherwise surfaces as "Access denied (using password: NO)" from deep inside
// mysql2. Returns a plain-language problem, or undefined when the settings look usable.
export function dbPasswordProblem(password: string): string | undefined {
  return password
    ? undefined
    : 'MYSQL_PASSWORD is not set. Add it to .env (see .env.example) or the environment.';
}
```

- [ ] **Step 4: Run, typecheck, format**

Run: `pnpm format && pnpm vitest run src/db/preflight.test.ts && pnpm typecheck && pnpm format:check`
Expected: `3 passed`; clean typecheck and format.

- [ ] **Step 5: Mutation check.** In `preflight.ts` change `password ?` to `true ?`, run the test file. Expected: FAIL. Restore.

- [ ] **Step 6: Commit**
```bash
git add src/db/preflight.ts src/db/preflight.test.ts
git commit -m "feat: add dbPasswordProblem for a clear missing-password message"
```

---

### Task 2: The migration CLI

**Files:**
- Replace: `src/db/migrate.ts`

**Interfaces:**
- Consumes: `dbPasswordProblem` (Task 1), `config.db.password` (existing).

- [ ] **Step 1: Reproduce the current behavior** (MySQL running, `pnpm build` not needed).

Run: `MYSQL_PASSWORD= pnpm exec tsx --env-file=.env src/db/migrate.ts pending`
Expected (the problem): `Error: Access denied for user 'app'@'...' (using password: NO)`.

- [ ] **Step 2: Replace `src/db/migrate.ts`** with:

```ts
import { config } from '../config.js';
import { dbPasswordProblem } from './preflight.js';
import { migrator } from './migrator.js';
import { sequelize } from './sequelize.js';

const problem = dbPasswordProblem(config.db.password);
if (problem) {
  console.error(problem);
  process.exit(1);
}

try {
  await migrator.runAsCLI();
} finally {
  await sequelize.close();
}
```
(If the QA/production plan's guard has been added to this file by then, keep its `assertMigrationAllowed(...)` call inside the `try`, and put the password check above it.)

- [ ] **Step 3: Verify with real processes**

Run: `pnpm format && pnpm typecheck && pnpm build`
Then:
```bash
MYSQL_PASSWORD= node --env-file=.env dist/db/migrate.js pending; echo "exit code: $?"
node --env-file=.env dist/db/migrate.js pending; echo "exit code: $?"
```
Expected: the first prints `MYSQL_PASSWORD is not set. Add it to .env (see .env.example) or the environment.` and `exit code: 1` immediately (no `Access denied`); the second behaves as before (prints nothing pending, `exit code: 0`).

- [ ] **Step 4: Commit**
```bash
git add src/db/migrate.ts
git commit -m "fix: exit with a clear message when the migration CLI has no MYSQL_PASSWORD"
```

---

### Task 3: Server startup

**Files:**
- Modify: `src/server.ts`, `src/server.test.ts`, `scripts/README.md`

**Interfaces:**
- Consumes: `dbPasswordProblem` (Task 1), `config.nodeEnv`, `config.db.password`.

- [ ] **Step 1: Update the test helper and add tests.** In `src/server.test.ts`, change the `startWith` signature and body as shown (three small edits), and append a new `describe` block.

(a) Signature and env stubbing. Replace
```ts
async function startWith(outcome: Error | undefined) {
  vi.stubEnv('PORT', '4321');
```
with
```ts
async function startWith(outcome: Error | undefined, env: Record<string, string> = {}) {
  vi.stubEnv('PORT', '4321');
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
```
(b) Capture warnings so they do not clutter test output. After the line that spies `console.error`, add:
```ts
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
```
(c) In the helper's `return`, add `warn` (e.g. `return { log, error, warn, exit };`; if the shutdown plan has been applied the return also has `handlers, server, closePool`, keep those and add `warn`).

(d) Append at the end of the file:
```ts
describe('server database settings', () => {
  it.each(['production', 'qa'])('refuses to start in %s without MYSQL_PASSWORD', async (nodeEnv) => {
    const { error, exit } = await startWith(undefined, { NODE_ENV: nodeEnv, MYSQL_PASSWORD: '' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Refusing to start'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('MYSQL_PASSWORD'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it.each(['development', 'test'])(
    'only warns in %s without MYSQL_PASSWORD, and still starts',
    async (nodeEnv) => {
      const { warn, exit, log } = await startWith(undefined, {
        NODE_ENV: nodeEnv,
        MYSQL_PASSWORD: '',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('MYSQL_PASSWORD'));
      expect(exit).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Server is running'));
    },
  );

  it('starts quietly in production when MYSQL_PASSWORD is set', async () => {
    const { warn, error, exit } = await startWith(undefined, {
      NODE_ENV: 'production',
      MYSQL_PASSWORD: 's3cret',
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm vitest run src/server.test.ts`
Expected: the new production/qa and development/test tests FAIL (4 failures); the "set password" test and all earlier tests pass.

- [ ] **Step 3: Implement.** In `src/server.ts`, add the import next to the others:
```ts
import { dbPasswordProblem } from './db/preflight.js';
```
and insert this block **immediately before** the `app.listen(...)` call (before `const server = app.listen(...)` if the shutdown plan has been applied):
```ts
// The server can run without a database (/health stays up), so only development and test
// tolerate a missing password; anywhere else it is a deployment mistake worth failing on.
const dbProblem = dbPasswordProblem(config.db.password);
if (dbProblem) {
  if (config.nodeEnv === 'development' || config.nodeEnv === 'test') {
    console.warn(`Warning: ${dbProblem} /health/db will report the database as down.`);
  } else {
    console.error(`Refusing to start: ${dbProblem}`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run, typecheck, format**

Run: `pnpm format && pnpm test && pnpm typecheck && pnpm format:check`
Expected: all pass (the suite grows by 8: 3 from Task 1 and 5 here; from today's 150 tests that is 158); clean typecheck and format.

- [ ] **Step 5: Mutation checks.** In `src/server.ts`, one at a time, run `pnpm vitest run src/server.test.ts`, expect FAIL, restore:
(a) replace the condition `config.nodeEnv === 'development' || config.nodeEnv === 'test'` with `true`;
(b) replace it with `config.nodeEnv !== 'production'` (qa slips through).

- [ ] **Step 6: Verify with real processes** (MySQL running; `pnpm build` first; use free ports):
```bash
# production, no password: refuses
NODE_ENV=production MYSQL_PASSWORD= PORT=3210 node --env-file=.env dist/server.js; echo "exit code: $?"
# qa, no password: refuses
NODE_ENV=qa MYSQL_PASSWORD= PORT=3211 node --env-file=.env dist/server.js; echo "exit code: $?"
# development, no password: starts and warns
MYSQL_PASSWORD= PORT=3212 node --env-file=.env dist/server.js &
sleep 1.5; curl -s localhost:3212/health; curl -s -o /dev/null -w ' /health/db -> HTTP %{http_code}\n' localhost:3212/health/db; kill %1
# production with the password from .env: normal
NODE_ENV=production PORT=3213 node --env-file=.env dist/server.js &
sleep 1.5; curl -s -o /dev/null -w '/health/db -> HTTP %{http_code}\n' localhost:3213/health/db; kill %1
# CI smoke test with no database env at all
env -u MYSQL_PASSWORD PORT=3214 bash scripts/smoke.sh; echo "smoke exit code: $?"
```
Expected, in order: `Refusing to start: MYSQL_PASSWORD is not set. ...` and `exit code: 1`; the same for qa; a `Warning: ...` line, `{"status":"ok"}`, `/health/db -> HTTP 503`; `/health/db -> HTTP 200`; `health: {"status":"ok"}` and `smoke exit code: 0`.

- [ ] **Step 7: Document it.** Add this row to the Troubleshooting table in `scripts/README.md`:
```
| `MYSQL_PASSWORD is not set` (migration CLI or server startup) | The variable is empty or missing. Set it in `.env` (see `.env.example`) or the environment. Only `NODE_ENV` `development` and `test` let the server start without it. |
```

- [ ] **Step 8: Commit**
```bash
git add src/server.ts src/server.test.ts scripts/README.md
git commit -m "fix: refuse to start outside development without MYSQL_PASSWORD"
```

---

## Evidence behind the decision (scratch copy of the project, 2026-10-11)

- **Problem reproduced against MySQL:** the migration CLI printed `Access denied for user 'app'@'...' (using password: NO)`. The server started normally; `/health` was 200 and `/health/db` was 503 with the same message only in the log.
- **Option A (rejected):** 14 of 32 tests failed in 5 files, and `scripts/smoke.sh` exited 1.
- **Option B (this plan):**
  - Existing suite untouched and green; 58 tests with the new ones; typecheck and format clean; build exit 0.
  - Real processes: migration CLI with an empty password prints the message and exits 1 (before any connection); the server exits 1 for `production` and `qa`; development starts, warns, `/health` 200, `/health/db` 503; production with the password works; the smoke test with no database env exits 0.
  - Run against the original `server.ts`, the 4 refusal/warn tests fail. Mutation (a) fails 2 tests and mutation (b) fails 1.

## Interactions with other pending plans

- **Graceful shutdown plan** (`2026-10-10-...`) also edits `src/server.ts` and `src/server.test.ts`. Both changes are small insertions; apply them in either order and re-run the suite. The password block belongs before the `app.listen` call; the shutdown handlers after it.
- **QA/production plan:** its migration guard in `migrate.ts` and this plan's password check coexist (see Task 2 note). Its deploy jobs already provide `MYSQL_PASSWORD` from environment secrets, so they pass the new check.

## Left out on purpose

- A hint inside `checkDatabase` (`/health/db` log) when the password is empty. The startup warning already says it; add it if people still miss it.
- Password strength rules, and checks for the other `MYSQL_*` variables (they have sensible defaults).
- An escape hatch such as `MYSQL_ALLOW_EMPTY_PASSWORD=1`. MySQL does allow passwordless users, and this plan makes the migration CLI refuse them. Add the flag if someone needs a passwordless local database; the project's own compose file always sets a password.

## Self-Review

- **Coverage:** the decision (with evidence), the clear message in both places that need a database, and CI/test behavior preserved.
- **Placeholders:** none; code is complete or given as exact insertions.
- **Consistency:** `dbPasswordProblem` has one signature and message across Tasks 1 to 3.
- **Verified:** the code in Tasks 1 to 3 was built and run in a scratch copy (results above). The test-file edits in Task 3 steps (a) to (d) were applied to the current `server.test.ts` in the scratch copy; the plan's `scripts/README.md` row was not rendered or committed anywhere.
- **Not verified:** the interplay with the unimplemented shutdown plan (two plans touching `server.ts`), and behavior with a real passwordless MySQL user.
