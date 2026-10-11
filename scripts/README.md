# Scripts

Small helper scripts for checking that the app and its database behave. None of them is part of
the app itself.

| Script | What it checks | Needs MySQL? | Run by |
|---|---|---|---|
| [`smoke.sh`](#smokesh) | The built server boots and `/health` answers | No | CI (`run` job), by hand |
| [`verify-product.ts`](#verify-productts) | The `Product` model works against the real `products` table | Yes | By hand |
| [`check-health-db.sh`](#check-health-dbsh) | `/health/db` returns the right status when the database is broken in four ways | Yes (2 of 4 scenarios) | By hand |

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

## verify-product.ts

Round-trips a `Product` through the real database and compares the model with the table. Use it
after changing the model or a migration, to catch the two drifting apart. Unit tests cannot do
this because they never touch MySQL.

```bash
docker compose up -d
pnpm exec tsx --env-file=.env scripts/verify-product.ts
```

Expected output:

```
id is number: true | createdAt is Date: true
price read back: "19.99" | typeof: string
table columns: ["createdAt","id","name","price","sku","updatedAt"]
model attributes: ["createdAt","id","name","price","sku","updatedAt"]
model matches table columns: true
duplicate sku -> SequelizeUniqueConstraintError
```

What each line proves:

- **`id` and `createdAt` types:** the database and Sequelize fill them in, and they come back as a
  number and a `Date`.
- **`price` is a string:** MySQL returns `DECIMAL` as text so no floating-point rounding appears.
  Keep money as strings (or use a decimal library), never `Number()`.
- **Columns match:** the model's attributes equal the table's columns. `false` means the model and
  the migration disagree.
- **Duplicate SKU:** the `UNIQUE` constraint on `sku` is enforced by the database.

It runs everything inside a transaction that is **rolled back**, so no rows are left behind. It
needs the `products` table to exist: run `pnpm db:migrate` first if it fails with
a "Table ... doesn't exist" error. It is not type-checked by `pnpm typecheck` (that only covers
`src/`), so run it after editing it.

---

## check-health-db.sh

Checks `GET /health/db`. First, why there are two health endpoints:

| Endpoint | Question | Touches MySQL? | Healthy | Unhealthy |
|---|---|---|---|---|
| `GET /health` | Is the process alive? | No | `200 {"status":"ok"}` | (process is down) |
| `GET /health/db` | Can it reach the database? | Yes (`sequelize.authenticate()`) | `200 {"status":"ok","db":"up"}` | `503 {"status":"error","db":"down"}` |

`/health` must never depend on the database: `smoke.sh` and restart policies use it, and
restarting the app does not fix a database outage. Use `/health/db` for readiness or debugging.

The 503 body says only that the database is down. The real reason (wrong password, refused
connection, timeout) is written to the server log, so the response never leaks hosts or usernames.
`/health/db` gives up after 2 seconds: a host that silently drops packets would otherwise block
for about 10 seconds, longer than most probes wait.

### Quick check

```bash
docker compose up -d
pnpm build && node --env-file=.env dist/server.js

# in another terminal
curl -s -w '\n-> HTTP %{http_code} in %{time_total}s\n' localhost:3000/health/db
```

Expected: `{"status":"ok","db":"up"}` and HTTP 200. The first request after the server starts takes
around 30-40 ms because it opens the database connection; later ones take a few milliseconds.

### Automated check

Starts the built server four times, each time with the database broken in a different way, and
checks the status code and response time.

```bash
pnpm build
docker compose up -d
bash scripts/check-health-db.sh
```

| Scenario | How it is broken | Expected |
|---|---|---|
| control: database healthy | nothing | `200` within 1 s |
| wrong password | `MYSQL_PASSWORD=definitely-wrong` | `503` within 1 s |
| nothing listening (refused) | `MYSQL_PORT=1` | `503` within 1 s |
| host drops packets | `MYSQL_HOST=192.0.2.1` (reserved address, never answers) | `503` within 3 s (the 2 s cap plus slack) |

Example output:

```
PASS  control: database healthy          HTTP 200 in 0.023s
PASS  wrong password                     HTTP 503 in 0.019s
PASS  nothing listening (refused)        HTTP 503 in 0.004s
PASS  host drops packets (2s cap)        HTTP 503 in 2.007s

All scenarios passed.
```

Exit codes: `0` all passed, `1` at least one scenario failed, `2` the script could not start
(no `dist/server.js`, no `.env`, or the port is already in use).

Notes:

- It needs MySQL running for the first two scenarios. If the control scenario fails, fix that
  first: the other results mean nothing without a working baseline.
- The overrides apply to one server process only. `node --env-file` never overrides variables that
  are already set, so your `.env` file and your database are untouched.
- It uses port `3190` so it does not clash with a dev server on 3000. Use `PORT=<free port>` to
  change it.
- It is not part of CI, because CI has no database.
- On a network that rejects `192.0.2.1` immediately instead of dropping packets, the last scenario
  passes faster than 2 s. That is fine; it just does not exercise the timeout.

### Trying a failure by hand

```bash
# Wrong password
MYSQL_PASSWORD=wrong PORT=3100 node --env-file=.env dist/server.js

# Real outage
docker compose stop mysql
curl -i localhost:3000/health/db      # 503
docker compose start mysql            # the next call may be slow while the pool reconnects
```

Server-side logs show the cause, for example:

```
database health check failed: AccessDeniedError [SequelizeAccessDeniedError]: Access denied for user 'app'...
database health check failed: Error: database check timed out after 2000ms
```

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `dist/server.js not found` (check-health-db) | Run `pnpm build`. |
| `smoke.sh` ends with `server did not become healthy` | The build is missing or broken: run `pnpm build`, then start `node dist/server.js` by hand to see the error. |
| `.env not found` | Copy `.env.example` to `.env` and set the passwords. |
| `Something is already listening on port ...` | Another server uses that port. Use `PORT=3191 bash scripts/check-health-db.sh`. |
| `verify-product.ts`: "Table ... doesn't exist" | Run `pnpm db:migrate`. |
| `verify-product.ts` or the control scenario cannot connect | MySQL is not running or not healthy yet: `docker compose ps`. Check `MYSQL_PASSWORD` in `.env` matches the one the database volume was created with. |
| Control scenario is slow (over 1 s) | First connection on a cold machine; rerun. |
