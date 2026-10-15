-- migration-mode: expand
--
-- Durable work for the two signing operations that cannot fit in a request.
--
-- Preparation hashes a whole document and finalization seals two artifacts.
-- Both run inside the request that triggers them today, so the work exists only
-- in one process's memory: kill the instance and the session is left half
-- processed with nothing recording that anything is owed. Cloud Run also stops
-- scheduling CPU once a response is sent, so "return early and finish in the
-- background" does not finish.
--
-- The lease token is the part that is easy to leave out and expensive to leave
-- out. A worker that stalls past its expiry loses the job, and its later writes
-- have to be refused rather than landing on top of the replacement's. Without
-- that check both workers publish, and the session ends with two artifact sets
-- and two completion emails.

-- =====================================================================
-- SIGNATURE PROCESSING JOBS
-- =====================================================================
-- Durable work for the two operations that cannot fit in a request.
--
-- Preparation hashes a whole document and finalization seals two artifacts.
-- Both used to run inside the request that triggered them, which means the work
-- existed only in one process's memory: kill the instance and the session was
-- left half-processed with nothing recording that anything was owed. Cloud Run
-- also stops scheduling CPU once a response is sent, so "return early and
-- finish in the background" does not finish.
--
-- A row here is the promise that the work is owed. It survives the process, it
-- names exactly what to do, and it can be picked up by a different instance.
--
-- The lease is what makes that safe. A worker claims a job by writing a token
-- and an expiry, and every checkpoint and every publish re-checks that token.
-- A worker that stalls past its expiry loses the job to someone else, and when
-- it wakes up its writes are refused rather than landing on top of the new
-- worker's. Without the token, a slow worker and its replacement both publish,
-- and the session ends up with two artifact sets and two completion emails.
create table if not exists signature_processing_jobs (
  id                uuid primary key default gen_random_uuid(),
  law_firm_id       uuid not null references law_firms(id) on delete cascade,
  source_id         uuid not null,
  -- Null for a preparation, which happens before any session exists.
  session_id        uuid,
  kind              text not null check (kind in ('prepare', 'finalize')),
  status            text not null default 'queued'
                      check (status in ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
  -- What the job was committed FOR: the source generation, or the field-layout
  -- revision the signer saw. A job that wakes up against a different revision
  -- refuses rather than applying old coordinates to a new document.
  input_revision    text,
  attempt           int not null default 0,
  next_attempt_at   timestamptz not null default now(),
  lease_owner       text,
  lease_token       uuid,
  lease_expires_at  timestamptz,
  -- The last phase whose output is durable, and the artifact generations it
  -- produced. An interrupted job resumes from here instead of starting over.
  phase             text,
  phase_state       jsonb,
  failure_code      text,
  failure_detail    text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (law_firm_id, id),
  foreign key (law_firm_id, source_id)
    references signature_sources (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, session_id)
    references signature_sessions (law_firm_id, id) on delete cascade
);

-- One LIVE job per logical operation. Two finalize jobs for one session would
-- each seal, publish and notify, and the session would end with two artifact
-- sets. Settled rows are excluded so a retry after a failure is still possible.
-- The coalesce gives a preparation, which has no session, a stable key.
create unique index if not exists signature_processing_jobs_live_idx
  on signature_processing_jobs (
    law_firm_id, kind, source_id,
    coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status in ('queued', 'leased');

-- The drain's poll. Partial, because settled jobs are the bulk of the table and
-- this read never wants them.
create index if not exists signature_processing_jobs_ready_idx
  on signature_processing_jobs (next_attempt_at)
  where status = 'queued';

-- Reclaiming a job whose worker died. Same reason for the partial.
create index if not exists signature_processing_jobs_lease_idx
  on signature_processing_jobs (lease_expires_at)
  where status = 'leased';

create index if not exists signature_processing_jobs_firm_idx
  on signature_processing_jobs (law_firm_id, source_id, created_at desc);

alter table signature_processing_jobs enable row level security;
drop policy if exists signature_processing_jobs_select on signature_processing_jobs;
create policy signature_processing_jobs_select on signature_processing_jobs for select to authenticated
  using (public.rls_is_firm_member(law_firm_id, auth.jwt()->>'sub'));


drop trigger if exists set_updated_at on signature_processing_jobs;
create trigger set_updated_at before update on signature_processing_jobs
  for each row execute function set_updated_at();
