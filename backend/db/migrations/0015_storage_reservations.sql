-- migration-mode: expand
--
-- Per-upload storage reservations that lapse on their own.
--
-- Pre-condition: no `storage_reservations` table. An upload's declared size is
-- added to `law_firms.storage_used_bytes` (and to `storage_reserved_bytes`) at
-- upload-init and only an upload-finalize gives it back, so an upload that is
-- cancelled, fails before finalize, or dies with a closed tab keeps its bytes
-- counted as used until an admin recount.
--
-- Post-condition: `storage_reservations` exists. An in-flight upload holds one
-- row per file with an `expires_at`; admission counts
-- `storage_used_bytes + sum(live reservations)`, and a reservation past its
-- expiry is simply not counted. `storage_used_bytes` then means bytes of SAVED
-- files only.
--
-- Expand only. `law_firms.storage_reserved_bytes` stays: the code that ships
-- with this table stops adding to it, but the currently deployed code still
-- writes it, so dropping it is a later contract migration. That same migration
-- folds any balance still standing out of `storage_used_bytes`, which rewrites
-- data and so needs its own authorization. The recount keeps zeroing the column
-- in the meantime so that fold stays accurate.
--
-- Nothing reads this table until the code that uses it ships, so the currently
-- deployed code is unaffected.

create table if not exists storage_reservations (
  id           uuid not null default gen_random_uuid(),
  law_firm_id  uuid not null references law_firms(id) on delete cascade,
  -- The uploader. Only they may release it early, so one member cannot free
  -- quota another member is holding for an upload still in flight.
  created_by   text not null references users(id) on delete cascade,
  bytes        bigint not null check (bytes >= 0),
  created_at   timestamptz not null default now(),
  -- After this the reservation no longer counts, whether or not anyone
  -- released it. A crashed tab frees its quota without anyone acting.
  expires_at   timestamptz not null,
  primary key (id),
  unique (law_firm_id, id),
  constraint storage_reservations_expiry_after_creation check (expires_at > created_at)
);

-- The admission sum and the purge both read one firm's rows by expiry.
create index if not exists storage_reservations_firm_expiry_idx
  on storage_reservations (law_firm_id, expires_at);
create index if not exists storage_reservations_created_by_idx
  on storage_reservations (created_by);

comment on column law_firms.storage_reserved_bytes is 'Retired. Upload reservations live in storage_reservations; nothing adds to this column any more. The recount still zeroes it until a contract migration folds any remaining balance out of storage_used_bytes and drops it.';
