-- migration-mode: expand
--
-- Durable folder archives.
--
-- A folder download is an archive streamed out of the API today: the request
-- opens a read stream per document and pipes all of them into one response, so
-- one person downloading a large matter holds an instance for the length of the
-- transfer, and an instance that dies partway leaves nothing recording that the
-- archive was ever owed. A truncated archive is also indistinguishable from a
-- complete one to whoever opens it on the other end.
--
-- These two tables make the archive a row: what to archive, who asked, where
-- the finished object landed, and when it is swept. The lease columns are the
-- part that is easy to leave out and expensive to leave out. Without the token
-- a stalled worker and its replacement both publish, and the firm pays for two
-- archives of one folder while the row points at one of them.

-- =====================================================================
-- FILE EXPORT JOBS (durable folder archives)
-- =====================================================================

-- A folder download used to be an archive streamed out of the API: the request
-- opened a read stream per document and piped all of them into one response, so
-- one person downloading a large matter held an instance for as long as the
-- transfer took and nothing recorded what was owed if it died partway. A
-- truncated archive is also indistinguishable from a complete one to whoever
-- opens it on the other end.
--
-- A row here is the promise that an archive is owed. It survives the process, it
-- names exactly what to archive, and any instance can pick it up.
--
-- The lease is what makes that safe, and it is the part that is easy to leave
-- out. A worker claims the job by writing a token and an expiry, and every write
-- afterwards re-checks that token. A worker that stalls past its expiry loses
-- the job, and its later writes are refused rather than landing on top of its
-- replacement's. Without the token both workers publish, and the firm is charged
-- for two archives of the same folder while the row points at one of them.
create table if not exists file_export_jobs (
  id                uuid primary key default gen_random_uuid(),
  law_firm_id       uuid not null references law_firms(id) on delete cascade,
  -- The folder the archive is rooted at. Entry paths come out relative to it,
  -- so this is also what makes an archive's contents reproducible.
  root_file_id      uuid not null,
  -- Who asked. The finished archive is handed back to this user and nobody
  -- else: the job carried their access, not the firm's.
  requested_by      text not null references users(id) on delete cascade,
  -- Which selection this job covers, so two clicks on the same download return
  -- one job instead of archiving the folder twice. A whole-subtree export uses
  -- a fixed marker; a multi-select uses a digest of its source ids.
  selection_digest  text not null,
  status            text not null default 'queued'
                      check (status in ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
  attempt           int not null default 0,
  next_attempt_at   timestamptz not null default now(),
  lease_owner       text,
  lease_token       uuid,
  lease_expires_at  timestamptz,
  -- Where the finished archive landed and the exact version of it this job
  -- produced. The generation is pinned into every read URL minted from here, so
  -- a retry that rewrote the object cannot be served against a URL authorized
  -- for the previous attempt.
  object_path       text,
  object_generation text,
  entry_count       int,
  size_bytes        bigint check (size_bytes is null or size_bytes >= 0),
  -- The last phase whose output is durable, and what it produced. An
  -- interrupted job resumes from here instead of starting over.
  phase             text,
  phase_state       jsonb,
  failure_code      text,
  failure_detail    text,
  -- When the temporary archive object is swept and this row stops minting URLs.
  expires_at        timestamptz not null default now() + interval '24 hours',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (law_firm_id, id),
  foreign key (law_firm_id, root_file_id)
    references files (law_firm_id, id) on delete cascade
);

drop trigger if exists set_updated_at on file_export_jobs;
create trigger set_updated_at before update on file_export_jobs
  for each row execute function set_updated_at();

-- One live job per person per selection. The conflict target for the enqueue,
-- so a second request returns the first job rather than a rival that would
-- archive the same folder again and charge the transfer twice.
create unique index if not exists file_export_jobs_live_idx
  on file_export_jobs (law_firm_id, requested_by, root_file_id, selection_digest)
  where status in ('queued', 'leased');

create index if not exists file_export_jobs_ready_idx
  on file_export_jobs (next_attempt_at) where status = 'queued';
create index if not exists file_export_jobs_lease_idx
  on file_export_jobs (lease_expires_at) where status = 'leased';
create index if not exists file_export_jobs_firm_idx
  on file_export_jobs (law_firm_id, requested_by, created_at desc);
-- The TTL sweep's work queue: archives that still have an object to remove.
create index if not exists file_export_jobs_expiry_idx
  on file_export_jobs (expires_at) where object_path is not null;
create index if not exists file_export_jobs_root_idx
  on file_export_jobs (law_firm_id, root_file_id);
create index if not exists file_export_jobs_requested_by_idx
  on file_export_jobs (requested_by);

-- What a multi-select export was asked for, one row per selected file or
-- folder. No rows means the whole subtree under `root_file_id`.
--
-- A table rather than a uuid array on the job: an array cannot carry a foreign
-- key, so a selected document deleted before the worker reaches it would leave
-- an id pointing at nothing and the archive would decide what to do about it at
-- read time.
create table if not exists file_export_job_sources (
  law_firm_id uuid not null references law_firms(id) on delete cascade,
  job_id      uuid not null,
  file_id     uuid not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (law_firm_id, job_id, file_id),
  foreign key (law_firm_id, job_id)
    references file_export_jobs (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, file_id)
    references files (law_firm_id, id) on delete cascade
);

drop trigger if exists set_updated_at on file_export_job_sources;
create trigger set_updated_at before update on file_export_job_sources
  for each row execute function set_updated_at();

create index if not exists file_export_job_sources_job_idx
  on file_export_job_sources (law_firm_id, job_id);
create index if not exists file_export_job_sources_file_idx
  on file_export_job_sources (law_firm_id, file_id);
