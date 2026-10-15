-- migration-mode: contract
--
-- A session names its source; a job names its source.
--
-- Both columns were made nullable in `0009` for sessions recorded before the
-- admission boundary existed, and `0010` then had to coalesce both keys in the
-- live-job index, because Postgres treats NULLs as distinct in a unique index
-- and the guarantee was therefore absent from exactly the rows it was written
-- for.
--
-- There are no such sessions: the product has no users. Every creation path now
-- admits a source before the session exists, the claim-at-finalize path is
-- deleted, and finalization no longer falls back to streaming a raw upload. So
-- the constraint can be stated plainly again, and the index key with it.
--
-- `session_id` stays nullable. A preparation job runs before any session
-- exists, which is a different thing from a job that forgot to say what it is
-- for, and the partial index below still keys on it.

delete from signature_processing_jobs where source_id is null;
delete from signature_sessions where source_id is null;

alter table signature_sessions alter column source_id set not null;
alter table signature_processing_jobs alter column source_id set not null;

-- `signature_processing_jobs_target_check` allowed a row to carry a session and
-- no source. That combination cannot exist now.
alter table signature_processing_jobs
  drop constraint if exists signature_processing_jobs_target_check;

drop index if exists signature_processing_jobs_live_idx;

create unique index if not exists signature_processing_jobs_live_idx
  on signature_processing_jobs (
    law_firm_id, kind, source_id,
    coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status in ('queued', 'leased');
