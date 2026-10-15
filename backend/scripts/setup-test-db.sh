#!/usr/bin/env bash
#
# Builds the databases the in-process Jest suite runs against.
#
# ONE DATABASE PER JEST WORKER. Jest runs spec files in parallel, and the suite
# empties every table between files, so a single shared database would let one worker wipe
# another mid-test. Each worker connects to paralegix_test_$JEST_WORKER_ID
# (tests/support/db.ts), so the databases are built to match.
#
# The schema comes from db/schema.sql, which is the schema authority and is kept
# current with the numbered migrations (including the trust-trigger change in
# migration 0183). No
# staging data is cloned: every spec seeds its own fixtures, so no test depends
# on a row someone else edited.
#
# Safe to re-run. Each database has its public schema dropped and rebuilt, so a
# stale local database can never make a test pass that would fail on staging.
#
# Usage:
#   ./scripts/setup-test-db.sh              # one per worker, scaled to this machine
#   TEST_DB_COUNT=4 ./scripts/setup-test-db.sh
set -euo pipefail

# Prefer Podman locally while preserving the Docker-based CI setup. An explicit
# override selects one engine; never fall back after a failed health check.
CONTAINER_ENGINE="${CONTAINER_ENGINE:-}"
if [[ -z "$CONTAINER_ENGINE" ]]; then
  if [[ "${CI:-}" != "true" ]] && command -v podman >/dev/null 2>&1; then
    CONTAINER_ENGINE=podman
  else
    CONTAINER_ENGINE=docker
  fi
fi

CONTAINER="${TEST_PG_CONTAINER:-paralegix-pg}"
DB_PREFIX="${TEST_PG_DATABASE:-paralegix_test}"
# One database per Jest worker, plus headroom.
#
# This tracks `maxWorkers` in jest.config.js (4) rather than the cpu count. Each
# worker connects to its own database and carries its own relcache for all 110
# tables, so unused databases are not free to BUILD (a few seconds each) even
# though they cost nothing at rest. If you raise maxWorkers after giving the
# container more memory, raise this to match or a worker starts with no database
# and fails with a bare "database paralegix_test_N does not exist".
COUNT="${TEST_DB_COUNT:-6}"

# This script drops and recreates each database's public schema. Refuse an
# override that could point at a development, staging, or production database.
if [[ ! "$DB_PREFIX" =~ ^paralegix_test([_-][A-Za-z0-9_-]+)?$ ]]; then
  echo "[setup-test-db] Refusing unsafe test database prefix '$DB_PREFIX'. Use a name beginning with paralegix_test." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Container-side paths (`-f /tmp/schema.sql`) must reach psql verbatim. Under Git
# Bash on Windows, MSYS rewrites any argument that looks like a Unix path into a
# Windows one, so `-f /tmp/schema.sql` arrives as `C:/.../Temp/schema.sql` and
# psql fails with "No such file or directory". Setting MSYS_NO_PATHCONV for the
# exec calls only; container copies still need the HOST path translated normally.
dexec() {
  MSYS_NO_PATHCONV=1 "$CONTAINER_ENGINE" exec "$@"
}

if ! dexec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
  echo "[setup-test-db] Postgres container '$CONTAINER' is not accepting connections." >&2
  echo "[setup-test-db] Start it with: $CONTAINER_ENGINE start $CONTAINER" >&2
  exit 1
fi

# Copy the SQL in once rather than per database.
"$CONTAINER_ENGINE" cp "$REPO_ROOT/backend/scripts/test-db-shim.sql" "$CONTAINER:/tmp/test-db-shim.sql"
"$CONTAINER_ENGINE" cp "$REPO_ROOT/backend/db/schema.sql" "$CONTAINER:/tmp/schema.sql"

# ONE strict pass, deliberately.
#
# This used to loop, because schema.sql could not be applied to an empty database
# at all: it declared matter_note_links.task_id as `references tasks(id)` sixty
# lines before `tasks` existed. Looping was a bad workaround. It hid a second and
# larger defect, which is that the two whole-schema sweeps at the end of the file
# only affect tables that exist when they run. Applying the file twice re-ran
# those sweeps after everything existed and quietly produced a different schema
# than one pass did.
#
# Both defects are fixed in schema.sql itself: the forward reference moved into
# the DEFERRED CROSS-TABLE FOREIGN KEYS block, and the sweeps moved to the end of
# the file. A single pass now produces a schema byte-identical to what the old
# two-pass build produced.
#
# Keeping this strict is the point. It makes every test-database build a
# regression check on schema.sql's ordering: a new forward reference fails here,
# loudly, instead of being papered over by a retry.
apply_schema() {
  local db="$1"
  dexec "$CONTAINER" psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -q -f /tmp/schema.sql
}

build_one() {
  local db="$1"

  # `create database` cannot run inside the implicit transaction psql wraps a
  # multi-statement -c in, hence the separate existence check.
  if ! dexec "$CONTAINER" psql -U postgres -d postgres -tAc \
      "select 1 from pg_database where datname='$db'" | grep -q 1; then
    dexec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
      -c "create database $db"
  fi

  dexec "$CONTAINER" psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -q \
    -c "drop schema if exists public cascade; create schema public;"
  dexec "$CONTAINER" psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -q \
    -f /tmp/test-db-shim.sql

  apply_schema "$db"

  local tables
  tables=$(dexec "$CONTAINER" psql -U postgres -d "$db" -tAc \
    "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")
  echo "[setup-test-db] $db ready ($tables tables)"
}

for i in $(seq 1 "$COUNT"); do
  build_one "${DB_PREFIX}_${i}"
done

echo "[setup-test-db] built $COUNT database(s) from db/schema.sql"
