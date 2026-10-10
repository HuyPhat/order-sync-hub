#!/usr/bin/env bash
# Manual check for GET /health/db. Starts the built server (dist/server.js) several times,
# each time with the database deliberately broken in a different way, and verifies the
# endpoint answers with the right status code within a time limit.
#
# Needs: `pnpm build` done, a .env file, and MySQL running (`docker compose up -d`)
# for the first two scenarios. Not part of CI: CI has no database.
set -uo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3190}"
URL="http://127.0.0.1:${PORT}"

[ -f dist/server.js ] || { echo "dist/server.js not found. Run: pnpm build" >&2; exit 2; }
[ -f .env ] || { echo ".env not found. Copy .env.example to .env first." >&2; exit 2; }
if curl -s -o /dev/null "${URL}/health" 2>/dev/null; then
  echo "Something is already listening on port ${PORT}. Set PORT=<free port> and retry." >&2
  exit 2
fi

SERVER_PID=""
failures=0
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null' EXIT

# scenario "<label>" <expected HTTP code> <max seconds> [VAR=value ...]
# Variables given after the third argument override .env for this one server only
# (node --env-file never overrides variables that are already set).
scenario() {
  local label=$1 expected=$2 max=$3
  shift 3

  env "$@" PORT="$PORT" node --env-file=.env dist/server.js >/dev/null 2>&1 &
  SERVER_PID=$!

  # Wait until the process answers. /health needs no database, so this works in every scenario.
  local up=""
  for _ in $(seq 1 30); do
    if curl -s -o /dev/null "${URL}/health" 2>/dev/null; then up=1; break; fi
    sleep 0.2
  done

  local code="" secs="" ok=1
  if [ -z "$up" ]; then
    ok=0
    code="server did not start"
    secs="-"
  else
    local out
    out=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' "${URL}/health/db")
    code=${out% *}
    secs=${out#* }
    [ "$code" = "$expected" ] || ok=0
    awk -v s="$secs" -v m="$max" 'BEGIN { exit !(s <= m) }' || ok=0
  fi

  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  SERVER_PID=""

  if [ "$ok" = 1 ]; then
    printf 'PASS  %-34s HTTP %s in %ss\n' "$label" "$code" "$secs"
  else
    printf 'FAIL  %-34s got HTTP %s in %ss (expected %s within %ss)\n' \
      "$label" "$code" "$secs" "$expected" "$max"
    failures=$((failures + 1))
  fi
}

scenario "control: database healthy"        200 1
scenario "wrong password"                   503 1 MYSQL_PASSWORD=definitely-wrong
scenario "nothing listening (refused)"      503 1 MYSQL_PORT=1
# 192.0.2.1 is reserved for documentation and never answers, like a firewall dropping
# packets. The endpoint must give up after its own 2s cap, not hang for mysql2's ~10s.
# (On a network that rejects this address instantly it will pass faster than 2s.)
scenario "host drops packets (2s cap)"      503 3 MYSQL_HOST=192.0.2.1

echo
if [ "$failures" = 0 ]; then
  echo "All scenarios passed."
else
  echo "${failures} scenario(s) failed." >&2
  exit 1
fi
