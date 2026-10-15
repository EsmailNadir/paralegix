-- migration-mode: expand
--
-- A finalization names the session it finalizes.
--
-- `0011` dropped `signature_processing_jobs_target_check` because half of what
-- it said became a column constraint: `source_id` is NOT NULL now, so
-- "a preparation names a source" is enforced without it.
--
-- The other half was not about the source. A finalize job with no session is a
-- job that cannot say which session's artifacts it is producing, and it would
-- sit in the queue failing for a reason no column states. That half is restored
-- here on its own terms.

alter table signature_processing_jobs
  drop constraint if exists signature_processing_jobs_finalize_names_session;

alter table signature_processing_jobs
  add constraint signature_processing_jobs_finalize_names_session check (
    kind <> 'finalize' or session_id is not null
  );
