-- =====================================================================
-- SIGNATURES  (native relational; session PK is the text token. See 0029.)
-- =====================================================================

-- =====================================================================
-- SIGNATURE SOURCES
-- =====================================================================
-- The admission boundary. Every document that reaches a signer passes through a
-- row here first, whichever route uploaded it, and nothing downstream may read
-- bytes that this row does not vouch for.
--
-- The row exists because "the caller uploaded it" is not the same fact as "this
-- is a document we can sign". The upload routes could each check the bytes
-- themselves, and did, in three places that drifted: one checked the leading
-- bytes, one trusted the declared size, and the template route checked neither.
-- A single record with a status is the only shape where a new entry point
-- cannot quietly skip the check, because there is nothing else to point a
-- session at.
--
-- `object_generation` is TEXT, not a number. A GCS generation is a 64-bit value
-- and a JS number rounds past 2^53, so two different versions of an object
-- would compare equal and a document replaced mid-signing would be signed half
-- from one version and half from the next.
create table if not exists signature_sources (
  id                      uuid primary key default gen_random_uuid(),
  law_firm_id             uuid not null references law_firms(id) on delete cascade,
  uploaded_by             text references users(id) on delete restrict,
  -- The immutable object the signer's document is read from, pinned to the
  -- exact version that was inspected.
  object_path             text not null,
  object_generation       text,
  size_bytes              bigint,
  -- SHA-256 of the bytes as uploaded, before any preparation.
  document_hash           text,
  -- Which admission policy accepted this. A source admitted under an older
  -- policy is not silently re-admitted under a newer one.
  profile_version         int not null default 1,
  status                  text not null default 'pending'
                            check (status in ('pending','preparing','ready','failed')),
  -- One of the stable refusal codes the routes return. Parser internals never
  -- reach a user; this is what the copy is chosen from.
  failure_code            text
                            check (failure_code is null or failure_code in (
                              'PDF_INVALID','PDF_ENCRYPTED','PDF_EXISTING_SIGNATURE',
                              'PDF_UNSUPPORTED_FORM','PDF_RESOURCE_LIMIT',
                              'FILE_TOO_LARGE','SOURCE_CHANGED')),
  failure_detail          text,
  -- What the signer actually views: the source after forms are flattened. It is
  -- a separate object, because the completed PDF must retain these bytes
  -- exactly and the original upload has to stay untouched as evidence.
  prepared_object_path    text,
  prepared_generation     text,
  prepared_size_bytes     bigint,
  prepared_hash           text,
  page_count              int,
  -- The saved SHA-256 state over the prepared source, so sealing never reads
  -- those bytes again. It is meaningless without the three columns beside it:
  -- resumed over a different object, a different version, or a different
  -- length, it produces a digest of a byte sequence that was never in any file,
  -- and that digest signs cleanly.
  digest_algorithm        text,
  digest_library_version  text,
  -- Base64, not bytea. The state is 116 opaque bytes, and text keeps it
  -- readable in a psql session and correctly typed by the generated Drizzle
  -- schema, which maps bytea to the wrong column type.
  digest_state            text,
  digest_state_bytes      bigint,
  digest_state_generation text,
  -- The durable preparation operation, for polling readiness. Hashing 2 GB does
  -- not fit inside an interactive request.
  operation_id            uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (law_firm_id, id),
  -- One source per stored object. A second admission of the same bytes would be
  -- a second opinion on whether they are signable.
  unique (law_firm_id, object_path)
);

create index if not exists signature_sources_firm_status_idx
  on signature_sources (law_firm_id, status, created_at desc);
-- The delete of a user is `restrict`, so it has to look for rows naming that
-- account. Without a leading index that look is a scan of every source the
-- platform has ever admitted.
create index if not exists signature_sources_uploaded_by_idx
  on signature_sources (uploaded_by);
-- Drives the drain that finishes interrupted preparations.
create index if not exists signature_sources_preparing_idx
  on signature_sources (status, updated_at)
  where status in ('pending', 'preparing');

alter table signature_sources enable row level security;
drop policy if exists signature_sources_select on signature_sources;
create policy signature_sources_select on signature_sources for select to authenticated
  using (public.rls_is_firm_member(law_firm_id, auth.jwt()->>'sub'));

create table if not exists signature_sessions (
  id                      uuid not null default gen_random_uuid(),
  token                   text not null unique,
  law_firm_id             uuid not null references law_firms(id) on delete cascade,
  created_by              text references users(id) on delete restrict,
  routing_mode            text not null default 'sequential'
                            check (routing_mode in ('sequential','parallel')),
  -- The admitted source these bytes came from. A session with no source has not
  -- passed the admission boundary and must not reach a signer.
  -- The admitted source this session was built from. Recorded when the session
  -- is created, so finalization reads the PREPARED copy and the hash state
  -- saved over it rather than pinning an upload and streaming it again.
  source_id               uuid not null,
  object_path             text,
  working_object_path     text,
  final_object_path       text,
  signed_object_path      text,
  file_name               text,
  -- The folder the executed copy is filed into. A folder ROW, not a path: the
  -- session outlives what it points at, and a path could name a folder that a
  -- matter delete already swept, filing an executed document where nothing
  -- lists it. The FK makes that impossible; the cascade is `set null`, which
  -- the filing code reads as "file it into General Files instead".
  destination_folder_id   uuid,
  destination_label       text,
  status                  text not null default 'pending'
                            check (status in ('pending','in_progress','completed','cancelled','expired')),
  current_signer_order    int,
  document_hash           text,
  -- A completed session seals TWO PDFs: the copy filed in the firm's documents,
  -- which carries the appended Signature Certificate page (signed_document_hash),
  -- and the copy emailed to signers and posted into the portal, which does not
  -- (delivery_document_hash). Sealing makes their bytes differ, so /signing/verify
  -- has to recognise both or it rejects the very PDF the signer was sent.
  signed_document_hash    text,
  delivery_document_hash  text,
  notify_email            citext,
  notify_name             text,
  email_signers_on_complete boolean not null default false,
  started_at              timestamptz,
  completed_at            timestamptz,
  -- The last time the sealed artifacts were re-read from storage and checked
  -- against what this row says they are, and what that check found.
  --
  -- Production verification resumes the same saved hash state it signed with,
  -- so a defect in the resume path is invisible to it: the same wrong answer
  -- twice agrees with itself. This audit is the only reader that does not
  -- share that assumption, because it streams every byte back out of storage.
  audited_at              timestamptz,
  audit_result            text
                            check (audit_result is null or audit_result in ('ok', 'mismatch', 'unreadable')),
  audit_detail            text,
  -- Delivery of the executed copies, recorded so a crash between completing a
  -- session and emailing its signers cannot lose the emails (migration 0018).
  -- `delivery_owed_at` is stamped by the completion write; null means nothing
  -- is owed through this mechanism, which is every session completed before it
  -- existed. A worker claims by taking `delivery_lease_expires_at` BEFORE it
  -- sends and stamps `delivered_at` AFTER, so a crash mid-send is re-sent once
  -- the lease lapses: at least once, never lost, never re-sent once stamped.
  delivery_owed_at          timestamptz,
  delivery_lease_expires_at timestamptz,
  delivery_attempts         int not null default 0,
  delivered_at              timestamptz,
  -- NOT NULL with a default (migration 0223); see invitations.expires_at.
  expires_at              timestamptz not null default now() + interval '30 days',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  foreign key (law_firm_id, destination_folder_id)
    references files (law_firm_id, id) on delete set null,
  -- Restrict, not cascade. A source is the evidence of what was signed, so it
  -- outlives nothing: deleting one out from under a live session would leave
  -- the session unable to say what it put in front of the signer.
  constraint signature_sessions_source_fkey foreign key (law_firm_id, source_id)
    references signature_sources (law_firm_id, id) on delete restrict,
  constraint signature_sessions_delivered_requires_owed
    check (delivered_at is null or delivery_owed_at is not null)
);
-- The drain's pick of completed sessions whose copies are still owed. Partial,
-- because a delivered session never matches again.
create index if not exists signature_sessions_delivery_owed_idx
  on signature_sessions (delivery_owed_at)
  where delivery_owed_at is not null and delivered_at is null;
-- Without this the cascade behind a folder delete scans every session row.
create index if not exists signature_sessions_destination_idx
  on signature_sessions (law_firm_id, destination_folder_id);
create index if not exists signature_sessions_status_idx on signature_sessions (status);
-- The audit's pick: least recently checked first, never checked before that.
-- Partial, because the audit only ever looks at completed sessions and those
-- are a minority of the table for a busy firm.
create index if not exists signature_sessions_audit_idx
  on signature_sessions (audited_at nulls first, completed_at)
  where status = 'completed';
create index if not exists signature_sessions_signed_hash_idx on signature_sessions (signed_document_hash);
create index if not exists signature_sessions_delivery_hash_idx on signature_sessions (delivery_document_hash);
create index if not exists signature_sessions_firm_created_idx on signature_sessions (law_firm_id, created_at desc);
-- Drives the "sessions I sent that are still open" half of pending-for-user.
-- Partial on the open statuses: settled sessions are the bulk of the table and
-- that read never wants them.
create index if not exists signature_sessions_creator_open_idx
  on signature_sessions (law_firm_id, created_by, created_at desc)
  where status in ('pending', 'in_progress');

alter table signature_sessions enable row level security;
drop policy if exists signature_sessions_select on signature_sessions;
create policy signature_sessions_select on signature_sessions for select to authenticated
  using (public.rls_is_firm_member(law_firm_id, auth.jwt()->>'sub'));

-- =====================================================================
-- SIGNATURE PARTICIPANTS & TOKENS (normalized from migration 0235)
-- =====================================================================

create table if not exists signature_participants (
  id                       text primary key default gen_random_uuid()::text,
  session_id               uuid not null references signature_sessions(id) on delete cascade,
  law_firm_id              uuid not null references law_firms(id) on delete cascade,
  role_label               text,
  signing_order            int,
  delivery_method          text,
  name                     text,
  email                    citext,
  member_user_id           text references users(id) on delete restrict,
  client_user_id           text references users(id) on delete restrict,
  status                   text not null default 'waiting'
                             check (status in ('active','waiting','completed','declined','cancelled','expired')),
  requires_verification    boolean not null default false,
  -- The one-time code's outcome, kept here rather than on its challenge row:
  -- passing that gate verifies the PERSON's email address, which outlives any
  -- one code. The access code's outcome is per-code and lives on its row.
  email_verified           boolean not null default false,
  started_at               timestamptz,
  completed_at             timestamptz,
  consent                  jsonb,
  signer_uid               text,
  signer_name              text,
  signer_ip                text,
  facilitated_by           text references users(id) on delete restrict,
  field_values             jsonb,
  working_object_path      text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (law_firm_id, id),
  foreign key (law_firm_id, session_id) references signature_sessions(law_firm_id, id) on delete cascade
);

create index if not exists signature_participants_firm_session_idx on signature_participants (law_firm_id, session_id);
create index if not exists signature_participants_firm_status_idx on signature_participants (law_firm_id, status);
create index if not exists signature_participants_session_order_idx on signature_participants (session_id, signing_order);
create index if not exists signature_participants_member_idx on signature_participants (member_user_id);
create index if not exists signature_participants_client_idx on signature_participants (client_user_id);

alter table signature_participants enable row level security;
drop policy if exists signature_participants_select on signature_participants;
create policy signature_participants_select on signature_participants for select to authenticated
  using (
    client_user_id = auth.jwt()->>'sub'
    or member_user_id = auth.jwt()->>'sub'
    or public.rls_is_firm_member(law_firm_id, auth.jwt()->>'sub')
  );

create table if not exists signature_participant_tokens (
  token           text primary key,
  participant_id  text not null,
  session_id      uuid not null references signature_sessions(id) on delete cascade,
  law_firm_id     uuid not null references law_firms(id) on delete cascade,
  delivery_method text,
  created_at      timestamptz not null default now(),
  consumed_at     timestamptz,
  foreign key (law_firm_id, session_id) references signature_sessions(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, participant_id) references signature_participants(law_firm_id, id) on delete cascade
);
create index if not exists signature_participant_tokens_session_id_idx on signature_participant_tokens (session_id);
create index if not exists signature_participant_tokens_participant_idx on signature_participant_tokens (participant_id);
create index if not exists signature_participant_tokens_firm_session_idx on signature_participant_tokens (law_firm_id, session_id);
create index if not exists signature_participant_tokens_firm_part_idx on signature_participant_tokens (law_firm_id, participant_id);


-- =====================================================================
-- SIGNATURE FIELDS (normalized from migration 0235)
-- =====================================================================

-- A field id is the client's name for the field, unique only within its
-- session: sessions sent from one signing template reuse the template's ids.
-- Nothing references a field row, so the tenant boundary is the composite
-- foreign key to the session rather than a `unique (law_firm_id, id)`.
create table if not exists signature_fields (
  id              text not null default gen_random_uuid()::text,
  session_id      uuid not null references signature_sessions(id) on delete cascade,
  law_firm_id     uuid not null references law_firms(id) on delete cascade,
  signer_id       text,
  page            int,
  x_percent       numeric,
  y_percent       numeric,
  width_percent   numeric,
  height_percent  numeric,
  field_type      text
    check (field_type is null or field_type in
      ('signature', 'initials', 'date', 'text', 'checkbox')),
  label           text,
  required        boolean,
  style           text,
  sort_order      int,
  config          jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint signature_fields_pkey primary key (session_id, id),
  foreign key (law_firm_id, session_id) references signature_sessions(law_firm_id, id) on delete cascade
);
create index if not exists signature_fields_firm_session_idx on signature_fields (law_firm_id, session_id);


-- =====================================================================
-- SIGNATURE CHALLENGES (from migration 0235)
-- =====================================================================

create table if not exists signature_challenges (
  id                  uuid primary key default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  session_id          uuid not null references signature_sessions(id) on delete cascade,
  participant_id      text not null references signature_participants(id) on delete cascade,
  kind                text not null check (kind in ('otp', 'access_code')),
  secret_hash         text,
  expires_at          timestamptz,
  attempts            int not null default 0,
  lifetime_attempts   int not null default 0,
  locked_until        timestamptz,
  verified_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (law_firm_id, id),
  foreign key (law_firm_id, session_id) references signature_sessions(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, participant_id) references signature_participants(law_firm_id, id) on delete cascade
);
-- One row per participant per gate. The repository upserts on this key.
create unique index if not exists signature_challenges_participant_kind_uq
  on signature_challenges (participant_id, kind);
create index if not exists signature_challenges_firm_session_idx on signature_challenges (law_firm_id, session_id);
-- Leads with session_id, which the single-column foreign key to
-- signature_sessions(id) needs for its cascade. `(participant_id)` alone is
-- deliberately absent: it is a strict prefix of the unique gate key above.
create index if not exists signature_challenges_session_idx on signature_challenges (session_id);
create index if not exists signature_challenges_firm_part_idx on signature_challenges (law_firm_id, participant_id);


create table if not exists signature_templates (
  id               uuid primary key default gen_random_uuid(),
  law_firm_id      uuid not null references law_firms(id) on delete cascade,
  name             text,
  description      text,
  fields           jsonb,
  signer_roles     jsonb,
  source_file_name text,
  source_object_path text,
  -- The admitted source. Saving or applying a template requires one.
  source_id        uuid,
  routing_mode     text,
  created_by       text references users(id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (law_firm_id, id),
  constraint signature_templates_source_fkey foreign key (law_firm_id, source_id)
    references signature_sources (law_firm_id, id) on delete restrict
);
-- signature_templates_firm_idx covered by unique (law_firm_id, id)
create index if not exists signature_sessions_source_idx
  on signature_sessions (law_firm_id, source_id);
create index if not exists signature_templates_source_idx
  on signature_templates (law_firm_id, source_id);

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
  -- The source the work reads. A preparation and a finalization both name one:
  -- every session records its source when it is created.
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
  -- Each kind names the thing it acts on. A preparation with no source has
  -- nothing to prepare, and a finalization with no session has nothing to
  -- finalize; both would sit in the queue failing for a reason no column states.
  -- A finalization names the session whose artifacts it produces. Without this
  -- such a job sits in the queue failing for a reason no column states. The
  -- other half of the old check, "a preparation names a source", is the NOT
  -- NULL on `source_id` above.
  constraint signature_processing_jobs_finalize_names_session check (
    kind <> 'finalize' or session_id is not null
  ),
  foreign key (law_firm_id, source_id)
    references signature_sources (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, session_id)
    references signature_sessions (law_firm_id, id) on delete cascade
);

-- One LIVE job per logical operation. Two finalize jobs for one session would
-- each seal, publish and notify, and the session would end with two artifact
-- sets. Settled rows are excluded so a retry after a failure is still possible.
--
-- BOTH nullable columns are coalesced, and that is not cosmetic. Postgres treats
-- two NULLs as distinct in a unique index, so leaving either bare would let two
-- live jobs exist for exactly the rows that carry a null there: a preparation
-- has no session, and a finalization of a session admitted before the boundary
-- existed has no source. The guarantee would hold everywhere except the cases
-- it was written for.
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
-- The cascade behind a session delete finds this table's rows through the
-- composite key (law_firm_id, session_id), so the index has to lead with those
-- two in that order. The firm index above leads with law_firm_id and then
-- source_id, which does not serve it.
create index if not exists signature_processing_jobs_session_idx
  on signature_processing_jobs (law_firm_id, session_id);

alter table signature_processing_jobs enable row level security;
drop policy if exists signature_processing_jobs_select on signature_processing_jobs;
create policy signature_processing_jobs_select on signature_processing_jobs for select to authenticated
  using (public.rls_is_firm_member(law_firm_id, auth.jwt()->>'sub'));

-- =====================================================================
-- SIGNATURE AUDIT EVENTS (normalized from migration 0235)
-- =====================================================================

-- `participant_id` deliberately carries NO foreign key. The immutability trigger
-- below blocks every UPDATE on this table, so an `on delete set null` key would
-- turn deleting a participant into an aborted transaction rather than a cascade.
create table if not exists signature_audit_events (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references signature_sessions(id) on delete cascade,
  law_firm_id     uuid not null references law_firms(id) on delete cascade,
  participant_id  text,
  -- The AUDIT_EVENTS constant in signatures/audit.ts. All write sites pass the
  -- constant rather than a literal.
  event_type      text
    check (event_type is null or event_type in (
      'session.created', 'session.viewed', 'document.viewed', 'consent.given',
      'session.completed', 'session.expired', 'session.cancelled',
      'participant.declined', 'participant.removed', 'email.sent',
      'reminder.sent', 'accesscode.verified', 'accesscode.failed')),
  ip              text,
  user_agent      text,
  actor_uid       text,
  metadata        jsonb,
  created_at      timestamptz not null default now(),
  unique (law_firm_id, id),
  foreign key (law_firm_id, session_id) references signature_sessions(law_firm_id, id) on delete cascade
);

create index if not exists signature_audit_events_session_id_idx on signature_audit_events (session_id, created_at);
create index if not exists signature_audit_events_firm_session_idx on signature_audit_events (law_firm_id, session_id);


-- =====================================================================
-- SIGNATURE AUDIT IMMUTABILITY
-- =====================================================================
-- Append-only audit trail. Blocks UPDATE only (tamper-prevention). DELETE is
-- intentionally allowed so the `on delete cascade` from signature_sessions (and
-- the session cleanup job) can purge audit rows; a blanket delete-block would
-- abort session deletion. Rows remain un-editable in place.
create or replace function signature_audit_immutable() returns trigger as $$
begin
  raise exception 'signature_audit_events are append-only: rows cannot be updated (id=%)', old.id;
end;
$$ language plpgsql;

drop trigger if exists signature_audit_immutable on signature_audit_events;
create trigger signature_audit_immutable before update on signature_audit_events
  for each row execute function signature_audit_immutable();

-- Realtime reads these two through the `authenticated` role. Without the grant
-- the policies above never get a chance to run: every read answers "permission
-- denied for table" instead of returning the rows the policy allows.
grant usage on schema public to authenticated;
grant select on signature_sessions     to authenticated;
grant select on signature_participants to authenticated;

do $$
begin
  begin execute 'alter publication supabase_realtime add table signature_sessions'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table signature_participants'; exception when duplicate_object then null; end;
end $$;
