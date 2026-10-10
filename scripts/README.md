# Checking `/health/db`

The API has two health endpoints. They answer different questions, so they are kept apart.

| Endpoint | Question | Touches MySQL? | Healthy | Unhealthy |
|---|---|---|---|---|
| `GET /health` | Is the process alive? | No | `200 {"status":"ok"}` | (process is down) |
| `GET /health/db` | Can it reach the database? | Yes (`sequelize.authenticate()`) | `200 {"status":"ok","db":"up"}` | `503 {"status":"error","db":"down"}` |

`/health` must never depend on the database: CI smoke tests and restart policies use it, and
restarting the app does not fix a database outage. Use `/health/db` for readiness or debugging.

The 503 body says only that the database is down. The real reason (wrong password, refused
connection, timeout) is written to the server log, so the response never leaks hosts or usernames.
`/health/db` gives up after 2 seconds: a host that silently drops packets would otherwise block
for about 10 seconds, longer than most probes wait.

## Quick check

```bash
docker compose up -d                       # MySQL, wait for "(healthy)" in `docker compose ps`
pnpm build && node --env-file=.env dist/server.js

# in another terminal
curl -s -w '\n-> HTTP %{http_code} in %{time_total}s\n' localhost:3000/health/db
```

Expected: `{"status":"ok","db":"up"}` and HTTP 200. The first request after the server starts takes
around 30-40 ms because it opens the database connection; later ones take a few milliseconds.

## Automated check: `scripts/check-health-db.sh`

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
- It is not part of CI, because CI has no database. `scripts/smoke.sh` covers CI and only calls `/health`.
- On a network that rejects `192.0.2.1` immediately instead of dropping packets, the last scenario
  passes faster than 2 s. That is fine; it just does not exercise the timeout.

## Trying a failure by hand

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

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `dist/server.js not found` | Run `pnpm build`. |
| `.env not found` | Copy `.env.example` to `.env` and set the passwords. |
| `Something is already listening on port ...` | Another server uses that port. Use `PORT=3191 bash scripts/check-health-db.sh`. |
| Control scenario returns 503 | MySQL is not running or not healthy yet: `docker compose ps`. Check `MYSQL_PASSWORD` in `.env` matches the one the database volume was created with. |
| Control scenario is slow (over 1 s) | First connection on a cold machine; rerun. |
