-- migration-mode: expand
--
-- Record whether a completed signing session's copies have been delivered.
--
-- Pre-condition: `signature_sessions` has no delivery columns. Completion
-- emails are sent once, by whichever worker wins the guarded completion write,
-- in the same process. A crash between that write and the send loses the
-- emails for good: a retry finds the session already completed and stops.
--
-- Post-condition: four columns on `signature_sessions`:
--   delivery_owed_at           set by the completion write; null means this
--                              mechanism owes nothing (every row that existed
--                              before this migration, so none is re-sent).
--   delivery_lease_expires_at  a delivery claim. A worker takes it before
--                              sending; a crash mid-send lets it lapse and
--                              the drain sends again (at-least-once).
--   delivery_attempts          claims taken so far; the drain stops at a cap.
--   delivered_at               set after the send. Never sent twice once set.
-- `delivered_at` requires `delivery_owed_at`, and a partial index serves the
-- drain's "owed and not delivered" pick.
--
-- Expand: nullable columns plus one defaulted int. No existing row is
-- rewritten (the defaulted int is a catalog-only default), and the deployed
-- code neither reads nor writes any of them.

alter table signature_sessions add column if not exists delivery_owed_at timestamptz;
alter table signature_sessions add column if not exists delivery_lease_expires_at timestamptz;
alter table signature_sessions add column if not exists delivery_attempts int not null default 0;
alter table signature_sessions add column if not exists delivered_at timestamptz;

alter table signature_sessions drop constraint if exists signature_sessions_delivered_requires_owed;
alter table signature_sessions add constraint signature_sessions_delivered_requires_owed
  check (delivered_at is null or delivery_owed_at is not null);

create index if not exists signature_sessions_delivery_owed_idx
  on signature_sessions (delivery_owed_at)
  where delivery_owed_at is not null and delivered_at is null;
