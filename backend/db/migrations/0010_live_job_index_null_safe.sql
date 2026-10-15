-- migration-mode: expand
--
-- The live-job index treated two nulls as distinct.
--
-- `signature_processing_jobs_live_idx` exists so that one logical operation has
-- at most one live job: two finalize jobs for one session would each seal,
-- publish and notify, and the session would end with two artifact sets, two
-- quota charges and two completion emails.
--
-- Postgres treats NULLs as distinct in a unique index, and `source_id` became
-- nullable in `0009`. So the index held for every job that named both a source
-- and a session, and silently did not hold for the two cases that carry a null:
-- a preparation, which has no session, and a finalization of a session recorded
-- before the admission boundary existed, which has no source. The guarantee was
-- absent from exactly the rows it was written for.
--
-- Coalescing both columns to a sentinel makes the key total.

drop index if exists signature_processing_jobs_live_idx;

create unique index if not exists signature_processing_jobs_live_idx
  on signature_processing_jobs (
    law_firm_id, kind,
    coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status in ('queued', 'leased');
