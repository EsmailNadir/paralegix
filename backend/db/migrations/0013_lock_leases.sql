-- migration-mode: expand
--
-- Lease rows for `withLock` / `tryLock` (`src/shared/database/advisoryLock.ts`).
--
-- Pre-condition: no `lock_leases` table. The lock helpers take a
-- transaction-scoped `pg_advisory_xact_lock` and keep that pool connection and
-- its open transaction for the whole locked callback, which for cron passes,
-- calendar syncs and the Stripe reversal spans minutes of remote API calls.
--
-- Post-condition: `lock_leases` exists, keyed by (domain, lock_key). A lock is
-- one short upsert that takes the row only when it is absent or its
-- `locked_until` has passed, and a release is a delete matching the owner's
-- token, so no connection is held between the two. Nothing reads this table
-- until the code that uses it ships, so the currently deployed code is
-- unaffected.
--
-- Not tenant-owned: a lock key names a platform-wide thing (a cron pass, a
-- payment intent, a user's calendar), exactly like `rate_limits` and
-- `cron_pass_state`.

create table if not exists lock_leases (
  domain       text        not null,
  lock_key     text        not null,
  owner_token  uuid        not null,
  locked_until timestamptz not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (domain, lock_key)
);

drop trigger if exists set_updated_at on lock_leases;
create trigger set_updated_at before update on lock_leases
  for each row execute function set_updated_at();
