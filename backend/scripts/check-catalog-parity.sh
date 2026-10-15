#!/usr/bin/env bash
#
# Prove that the two ways to reach the current schema agree.
#
#   BUILT     a fresh database created from db/schema.sql in one pass.
#   MIGRATED  a database created from the baseline ref's db/schema.sql, then
#             upgraded by every numbered migration the baseline does not have.
#
# A deployed environment takes the MIGRATED path. A new test database, a new
# local database and CI all take the BUILT path. When the two disagree, the
# tests run against a schema no deployed database will ever have, and nothing
# else notices: db:drift introspects one database, so it agrees with whichever
# path built that one.
#
# This is the check migration 0204 existed to perform by hand, and the gate the
# schema redesign ran at the end of every phase.
#
# Usage:
#   ./scripts/check-catalog-parity.sh                # baseline origin/staging
#   PARITY_BASE_REF=origin/main ./scripts/check-catalog-parity.sh
#   PARITY_KEEP=1 ./scripts/check-catalog-parity.sh  # keep the two databases
#
# Requires the local Postgres container (see the local-database skill). It
# creates and drops two scratch databases and touches nothing else.
set -euo pipefail

BASE_REF="${PARITY_BASE_REF:-origin/staging}"
CONTAINER="${TEST_PG_CONTAINER:-paralegix-pg}"
BUILT_DB="${PARITY_BUILT_DB:-paralegix_parity_built}"
MIGRATED_DB="${PARITY_MIGRATED_DB:-paralegix_parity_migrated}"

# Same engine selection as setup-test-db.sh: Podman locally, Docker in CI.
CONTAINER_ENGINE="${CONTAINER_ENGINE:-}"
if [[ -z "$CONTAINER_ENGINE" ]]; then
  if [[ "${CI:-}" != "true" ]] && command -v podman >/dev/null 2>&1; then
    CONTAINER_ENGINE=podman
  else
    CONTAINER_ENGINE=docker
  fi
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK"
  if [[ "${PARITY_KEEP:-}" != "1" ]]; then
    dsql postgres -qc "drop database if exists $BUILT_DB" >/dev/null 2>&1 || true
    dsql postgres -qc "drop database if exists $MIGRATED_DB" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# MSYS_NO_PATHCONV: see the note in setup-test-db.sh. Container paths passed to
# exec must not be rewritten into Windows paths under Git Bash.
dexec() {
  MSYS_NO_PATHCONV=1 "$CONTAINER_ENGINE" exec "$@"
}
dsql() {
  local db="$1"; shift
  dexec "$CONTAINER" psql -U postgres -d "$db" "$@"
}

if ! dexec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
  echo "[catalog-parity] Postgres container '$CONTAINER' is not accepting connections." >&2
  echo "[catalog-parity] Start it with: $CONTAINER_ENGINE start $CONTAINER" >&2
  exit 1
fi

if ! git -C "$REPO_ROOT" rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "[catalog-parity] Baseline ref '$BASE_REF' not found. Fetch it first:" >&2
  echo "[catalog-parity]   git fetch origin staging" >&2
  exit 1
fi

# ---------------------------------------------------------------- inputs ----
git -C "$REPO_ROOT" show "$BASE_REF:backend/db/schema.sql" > "$WORK/baseline_schema.sql"
cp "$REPO_ROOT/backend/db/schema.sql" "$WORK/current_schema.sql"
cp "$REPO_ROOT/backend/scripts/test-db-shim.sql" "$WORK/shim.sql"
cp "$REPO_ROOT/backend/db/catalog-snapshot.sql" "$WORK/snapshot.sql"

# Every migration the baseline does not already carry, in name order. The
# numbering is the apply order, which is why a plain sort is correct here.
# `|| true` on both greps: an empty chain is the normal state right after a
# collapse, and `grep` exits 1 on no match, which under `pipefail` killed this
# script before it printed anything at all.
git -C "$REPO_ROOT" ls-tree --name-only "$BASE_REF" backend/db/migrations/ \
  | { grep '\.sql$' || true; } | xargs -n1 basename 2>/dev/null | sort > "$WORK/baseline_migrations.txt"
{ ls "$REPO_ROOT/backend/db/migrations" 2>/dev/null | grep '\.sql$' || true; } \
  | sort > "$WORK/current_migrations.txt"
comm -13 "$WORK/baseline_migrations.txt" "$WORK/current_migrations.txt" > "$WORK/pending.txt"

PENDING_COUNT=$(wc -l < "$WORK/pending.txt" | tr -d ' ')
echo "[catalog-parity] baseline $BASE_REF, $PENDING_COUNT migration(s) to apply on top."

: > "$WORK/pending.sql"
while read -r migration; do
  [[ -z "$migration" ]] && continue
  {
    echo "-- >>> $migration"
    cat "$REPO_ROOT/backend/db/migrations/$migration"
    echo
  } >> "$WORK/pending.sql"
done < "$WORK/pending.txt"

for file in baseline_schema.sql current_schema.sql shim.sql pending.sql snapshot.sql; do
  "$CONTAINER_ENGINE" cp "$WORK/$file" "$CONTAINER:/tmp/parity_$file"
done

# ---------------------------------------------------------------- build -----
recreate() {
  local db="$1"
  dsql postgres -v ON_ERROR_STOP=1 -qc "drop database if exists $db"
  dsql postgres -v ON_ERROR_STOP=1 -qc "create database $db"
  dsql "$db" -v ON_ERROR_STOP=1 -q -f /tmp/parity_shim.sql
}

echo "[catalog-parity] building $BUILT_DB from db/schema.sql (one pass)."
recreate "$BUILT_DB"
dsql "$BUILT_DB" -v ON_ERROR_STOP=1 -q -f /tmp/parity_current_schema.sql

echo "[catalog-parity] building $MIGRATED_DB from the baseline plus $PENDING_COUNT migration(s)."
recreate "$MIGRATED_DB"
dsql "$MIGRATED_DB" -v ON_ERROR_STOP=1 -q -f /tmp/parity_baseline_schema.sql
dsql "$MIGRATED_DB" -v ON_ERROR_STOP=1 -q -f /tmp/parity_pending.sql

# ---------------------------------------------------------------- compare ---
# db/catalog-snapshot.sql emits one sorted line per catalog fact, so the
# comparison sees objects rather than DDL text and is blind to the order the
# objects were created in. Physical column order is excluded on purpose; see the
# header of that file.
dump() {
  dsql "$1" -v ON_ERROR_STOP=1 -q -f /tmp/parity_snapshot.sql | sed 's/[[:space:]]*$//' | grep -v '^$'
}

dump "$BUILT_DB" > "$WORK/built.dump"
dump "$MIGRATED_DB" > "$WORK/migrated.dump"

count_tables() {
  dsql "$1" -tAc "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'" | tr -d ' \r'
}
echo "[catalog-parity] $BUILT_DB: $(count_tables "$BUILT_DB") tables, $(wc -l < "$WORK/built.dump" | tr -d ' ') catalog facts."
echo "[catalog-parity] $MIGRATED_DB: $(count_tables "$MIGRATED_DB") tables, $(wc -l < "$WORK/migrated.dump" | tr -d ' ') catalog facts."

if diff -u "$WORK/migrated.dump" "$WORK/built.dump" > "$WORK/catalog.diff"; then
  echo "[catalog-parity] OK: a database built from db/schema.sql matches one migrated from $BASE_REF."
  exit 0
fi

REPORT="${PARITY_REPORT:-$REPO_ROOT/backend/catalog-parity.diff}"
cp "$WORK/catalog.diff" "$REPORT"
echo "[catalog-parity] FAIL: the two build paths disagree." >&2
echo "[catalog-parity] $(grep -c '^[+-]' "$WORK/catalog.diff") changed line(s); full diff written to $REPORT" >&2
echo "[catalog-parity] '-' is the migrated database, '+' is the one built from db/schema.sql." >&2
echo "[catalog-parity] Fix db/schema/*.sql to match the migrations, or write a migration for the intended change." >&2
sed -n '1,60p' "$WORK/catalog.diff" >&2
exit 1
