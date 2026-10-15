-- migration-mode: expand
-- Precondition: users.deleted_at records SQL anonymization but not provider completion.
-- Postcondition: pending erasures remain identifiable until all identity cleanup succeeds.
alter table users add column if not exists identity_erased_at timestamptz;
comment on column users.identity_erased_at is
  'Set only after privacy identity cleanup, including Firebase deletion, completes. A deleted_at tombstone with this null remains queued for recovery.';
create index if not exists users_pending_erasure_idx on users (deleted_at)
  where deleted_at is not null and identity_erased_at is null;
