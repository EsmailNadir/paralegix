-- migration-mode: expand
--
-- Two foreign key columns with no leading index.
--
-- `signature_sources.uploaded_by` points at `users(id)` with `on delete
-- restrict`, so deleting an account has to look for rows naming it. Without an
-- index that look is a scan of every source the platform has ever admitted, on
-- a path that already holds a transaction.
--
-- `signature_processing_jobs.session_id` is half of the composite key the
-- cascade behind a session delete uses, so the index has to lead with
-- `(law_firm_id, session_id)` in that order. The firm index leads with
-- `law_firm_id` and then `source_id`, which does not serve it.

create index if not exists signature_sources_uploaded_by_idx
  on signature_sources (uploaded_by);

create index if not exists signature_processing_jobs_session_idx
  on signature_processing_jobs (law_firm_id, session_id);
