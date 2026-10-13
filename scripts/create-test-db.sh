#!/usr/bin/env bash
# One-time setup for the integration tests: creates the test database and lets the app user use it.
# The app user cannot create databases, so this runs as root inside the MySQL container.
# Safe to run again. Keep DB in sync with test/test-database.ts.
set -euo pipefail

cd "$(dirname "$0")/.."

DB="order_sync_hub_test"

docker compose exec -T mysql sh -c "MYSQL_PWD=\"\$MYSQL_ROOT_PASSWORD\" mysql -uroot -e \"CREATE DATABASE IF NOT EXISTS ${DB}; GRANT ALL PRIVILEGES ON ${DB}.* TO \\\`\$MYSQL_USER\\\`@\\\`%\\\`;\""

echo "Test database ${DB} is ready."
