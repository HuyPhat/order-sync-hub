#!/usr/bin/env bash
# Starts the built server (dist/server.js) and verifies /health responds.
set -euo pipefail

PORT="${PORT:-3100}"
export PORT
# The server refuses to start without a signing secret; this one is only for the smoke test.
export JWT_SECRET="${JWT_SECRET:-smoke-test-secret-at-least-32-characters}"

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
