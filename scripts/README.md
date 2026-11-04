# Scripts

Small helper scripts for checking that the app and its database behave. None of them is part of
the app itself.

| Script | What it checks | Needs MySQL? | Run by |
|---|---|---|---|
| [`smoke.sh`](#smokesh) | The built server boots and `/health` answers | No | CI (`run` job), by hand |
| [`create-test-db.sh`](#create-test-dbsh) | Creates the `order_sync_hub_test` database used by `pnpm test:integration` | Yes | Once, by hand |

Most of them need the project built first (`pnpm build`) and, where noted, MySQL running
(`docker compose up -d`, then wait for `(healthy)` in `docker compose ps`).

---

## smoke.sh

Starts `node dist/server.js`, polls `GET /health` for up to 10 seconds, and checks that the body is
exactly `{"status":"ok"}`. This is the proof that a build actually boots.

```bash
pnpm build
bash scripts/smoke.sh                 # port 3100
PORT=3120 bash scripts/smoke.sh       # another port
```

Expected output, exit code `0`:

```
Server is running on port 3100 (development)
health: {"status":"ok"}
```

- Exit `1` if the server never answers, or answers with a different body.
- It does **not** load `.env` and does **not** need a database. That is why CI can run it:
  it only calls `/health`, never `/health/db`.
- In CI (the `run` job in `.github/workflows/ci.yml`) it runs against the release bundle with
  production dependencies only, so it also catches a dependency that is wrongly listed under
  `devDependencies`.
- It stops the server when it finishes, even on failure.

---

## create-test-db.sh

Creates the database `order_sync_hub_test` and grants the app user access to it. Run it once; it is safe to run again. The app user cannot create databases itself, so the script runs as root inside the MySQL container.

```bash
docker compose up -d
bash scripts/create-test-db.sh
pnpm test:integration
```

`pnpm test:integration` runs every `src/**/*.integration.test.ts` file against that database. Before each run it reverts and re-applies all migrations, so the database always starts clean. It refuses to run unless the database name ends in `_test`. `pnpm test` never runs these files and needs no database.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `smoke.sh` ends with `server did not become healthy` | The build is missing or broken: run `pnpm build`, then start `node dist/server.js` by hand to see the error. |
| `MYSQL_PASSWORD is not set` (migration CLI or server startup) | The variable is empty or missing. Set it in `.env` (see `.env.example`) or the environment. Only `NODE_ENV` `development` and `test` let the server start without it (an unset `NODE_ENV` counts as `development`, so set it in deployments). |
