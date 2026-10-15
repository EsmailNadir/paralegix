-- migration-mode: expand
--
-- A finalization job does not need a source.
--
-- `signature_processing_jobs.source_id` was NOT NULL because the first job kind,
-- preparation, is entirely about a source. Finalization is about a SESSION: the
-- source is how preparation names its work, not how finalizing names its own. A
-- session recorded before the admission boundary existed has no source row at
-- all, and requiring one here means such a session can never be finalized.
--
-- The CHECK keeps each kind naming the thing it acts on. A preparation with no
-- source has nothing to prepare and a finalization with no session has nothing
-- to finalize; either would sit in the queue failing for a reason no column
-- states.

alter table signature_processing_jobs alter column source_id drop not null;

alter table signature_processing_jobs
  drop constraint if exists signature_processing_jobs_target_check;
alter table signature_processing_jobs
  add constraint signature_processing_jobs_target_check check (
    (kind = 'prepare' and source_id is not null)
    or (kind = 'finalize' and session_id is not null)
  );
