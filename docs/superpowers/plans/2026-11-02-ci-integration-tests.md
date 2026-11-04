# Run the Integration Tests in CI Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitHub Actions run `pnpm test:integration` against a real MySQL 8.4, so a broken migration `down`, a model/table mismatch or a non-atomic `createOrder` fails CI instead of passing silently.

**Architecture:** One new job, `integration`, with a `services: mysql` block. It runs in parallel with `test` after `typecheck`, and `build` waits for both. No application code changes.

**Tech Stack:** GitHub Actions, `mysql:8.4` service container, pnpm 12.4.2, Node 24, Vitest 5.

**Spec:** None written. Requirement from the review of 2026-11-02: "CI has no MySQL service, so integration tests don't run there. Add a `services: mysql:8.4` block and a `test:integration` step."

## Status

Planned, **not implemented**. Verified locally by simulation (see Evidence). Not yet run on GitHub.

## Global Constraints

- Job order stays `typecheck` -> (`test`, `integration`) -> `build` -> `deploy` -> `run`; `deploy` still runs only on `push` to `main`.
- The service image is `mysql:8.4`, the same as `docker-compose.yml`.
- The integration tests only run against a database whose name ends in `_test` (`test/integration-setup.ts` refuses otherwise). The CI database is `order_sync_hub_test`.
- Credentials in the workflow are throwaway values for an ephemeral container, not secrets. No real password enters the workflow file.
- Variables the app reads (`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`) are set as job `env`; `.env` does not exist in CI (`vitest.integration.config.ts` tolerates that).
- End every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (user preference since 2026-11-02; earlier commits are not rewritten).

## Review Focus

1. If MySQL is unreachable the job must **fail**, not skip or pass. Pinned by Task 1 Step 4 (wrong port).
2. `build` must not start unless `integration` passed. Pinned by the `needs` check in Task 1 Step 2.
3. A migration whose `down` is broken must fail the job. Pinned by Task 1 Step 5 (mutation).
4. The tests must never run against anything but `order_sync_hub_test`. Already enforced by `test/integration-setup.ts`; Step 5 confirms the job relies on it.
5. A slow MySQL start must not cause a flaky failure. The health check allows 60 s (12 x 5 s); GitHub waits for `healthy` before running steps.

## File Structure

| File | Responsibility |
|---|---|
| `.github/workflows/ci.yml` (modify) | Add the `integration` job; make `build` need `[test, integration]`. |

---

### Task 1: Add the `integration` job

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: script `test:integration` (exists: `vitest run --config vitest.integration.config.ts`); `packageManager` field for `pnpm/action-setup`.
- Produces: a required-looking check named `integration` on every PR and push to `main`.

- [ ] **Step 1: Add the job** after the `test` job, and change `build`'s `needs`:

```yaml
  integration:
    needs: typecheck
    runs-on: ubuntu-latest
    services:
      mysql:
        image: mysql:8.4
        env:
          MYSQL_ROOT_PASSWORD: ci-root-password
          MYSQL_DATABASE: order_sync_hub_test
          MYSQL_USER: app
          MYSQL_PASSWORD: ci-app-password
        ports:
          - 3306:3306
        options: >-
          --health-cmd="mysqladmin ping -h 127.0.0.1 --silent"
          --health-interval=5s
          --health-timeout=5s
          --health-retries=12
    env:
      # Throwaway credentials for the service container above.
      MYSQL_HOST: 127.0.0.1
      MYSQL_PORT: 3306
      MYSQL_USER: app
      MYSQL_PASSWORD: ci-app-password
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:integration
```

In the `build` job change `needs: test` to `needs: [test, integration]`. Touch nothing else.

- [ ] **Step 2: Validate the workflow structure locally**

Run: `python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print({k: v.get('needs') for k, v in d['jobs'].items()})"`
Expected: `{'typecheck': None, 'test': 'typecheck', 'integration': 'typecheck', 'build': ['test', 'integration'], 'deploy': 'build', 'run': 'deploy'}`

- [ ] **Step 3: Prove the service block works, by simulation.** GitHub Actions cannot run locally, so start the same image with the same env on a spare port and run the job's command with the job's env:

```bash
docker run -d --name ci-mysql-sim -p 127.0.0.1:3307:3306 \
  -e MYSQL_ROOT_PASSWORD=ci-root-password -e MYSQL_DATABASE=order_sync_hub_test \
  -e MYSQL_USER=app -e MYSQL_PASSWORD=ci-app-password \
  --health-cmd="mysqladmin ping -h 127.0.0.1 --silent" --health-interval=5s \
  --health-timeout=5s --health-retries=12 mysql:8.4
until [ "$(docker inspect -f '{{.State.Health.Status}}' ci-mysql-sim)" = healthy ]; do sleep 3; done
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3307 MYSQL_USER=app MYSQL_PASSWORD=ci-app-password pnpm test:integration
```
Expected: `Test Files  3 passed (3)`, `Tests  20 passed (20)`. Leave the container running for Steps 4 and 5.

- [ ] **Step 4: Prove it fails when MySQL is unreachable** (Review Focus 1)

Run: `MYSQL_HOST=127.0.0.1 MYSQL_PORT=3399 MYSQL_USER=app MYSQL_PASSWORD=ci-app-password pnpm test:integration; echo "exit: $?"`
Expected: `ECONNREFUSED` in the output and `exit: 1`.

- [ ] **Step 5: Mutation check on rollback** (Review Focus 3 and 4). In `src/db/migrations/*create-order-items.ts` temporarily make `down` throw `new Error('mutation')`, then re-run the Step 3 command.
Expected: the run fails in the global setup (`migrator.down({ to: 0 })`), exit 1. Revert the file (`git checkout src/db/migrations`), re-run, expect `20 passed`. Then remove the container: `docker rm -f ci-mysql-sim`.

- [ ] **Step 6: Commit, push, and watch the run**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the integration tests against a mysql:8.4 service"
git push
```
Open (or update) a PR and check the Actions tab: expected jobs `typecheck`, then `test` and `integration` in parallel, then `build`; `deploy` and `run` skipped on a PR. If `integration` is red because the service is not ready, raise `--health-retries`, do not add a `sleep`.

---

## Evidence (2026-11-02)

- Steps 2 to 4 were run with exactly the values in this plan: the new job merged into `ci.yml` parses with the expected `needs` chain; a throwaway `mysql:8.4` container reached `healthy`; `pnpm test:integration` against it passed (3 files, 20 tests); with the wrong port it failed with `ECONNREFUSED` and exit 1. The container was removed afterwards.
- Step 5 (the broken-`down` mutation) was **not** run.
- What a green `integration` job proves: `test/integration-setup.ts` runs `migrator.down({ to: 0 })` then `migrator.up()` on every run (every migration's `down` and `up` execute), `schema.integration.test.ts` checks the models against the real tables, and `orders.integration.test.ts` proves `createOrder` is atomic.

## Not verified

- The workflow has not run on GitHub: the `services:` `options` quoting and the `mysqladmin ping` health check are tested only through the equivalent `docker run`.
- `mysqladmin ping` reports healthy even when authentication fails, which is fine here (it only needs the server up); a wrong `MYSQL_PASSWORD` would show up as a test failure, not a health failure.

## Self-Review

- **Coverage:** the service block and the `test:integration` step (Task 1 Step 1), ordering (Step 2), reachability and rollback proofs (Steps 3 to 5).
- **Placeholders:** none; the YAML is complete.
- **Consistency:** database `order_sync_hub_test` matches `test/test-database.ts`; env names match `src/config.ts`.
