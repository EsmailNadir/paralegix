-- migration-mode: expand
--
-- The admission boundary for documents sent for signature.
--
-- Today each upload route decides for itself whether the bytes it just received
-- can be signed, and the three routes disagree. `/signing/upload-finalize`
-- checks the leading bytes and the stored size. `/signature-links/prepare`
-- trusts a file the firm already owns. The template routes check neither, so a
-- template saved from an encrypted or already-signed PDF fails much later, at
-- the point a signer has already been invited and emailed.
--
-- `signature_sources` makes the check a row rather than a code path. A session
-- or template names a source, a source has a status, and nothing may put bytes
-- in front of a signer until that status is `ready`. A new entry point cannot
-- skip it, because there is nothing else to point a session at.
--
-- The digest columns are what make a large document signable at all. Preparation
-- hashes the prepared source once and saves the SHA-256 state at the end of it,
-- so sealing resumes that state over the appended suffix instead of reading the
-- document a second time. The state is 116 bytes and is useless on its own: the
-- algorithm, the library version, the byte length and the generation it covers
-- are stored beside it, because a state resumed over different bytes yields a
-- digest of a byte sequence that was never in any file, and that digest signs
-- without complaint. It is held as base64 text: the value is opaque either way,
-- and `bytea` is mapped to the wrong column type by the Drizzle introspection
-- this repo checks its schema against.

create table if not exists signature_sources (
  id                      uuid primary key default gen_random_uuid(),
  law_firm_id             uuid not null references law_firms(id) on delete cascade,
  uploaded_by             text references users(id) on delete restrict,
  object_path             text not null,
  object_generation       text,
  size_bytes              bigint,
  document_hash           text,
  profile_version         int not null default 1,
  status                  text not null default 'pending'
                            check (status in ('pending','preparing','ready','failed')),
  failure_code            text
                            check (failure_code is null or failure_code in (
                              'PDF_INVALID','PDF_ENCRYPTED','PDF_EXISTING_SIGNATURE',
                              'PDF_UNSUPPORTED_FORM','PDF_RESOURCE_LIMIT',
                              'FILE_TOO_LARGE','SOURCE_CHANGED')),
  failure_detail          text,
  prepared_object_path    text,
  prepared_generation     text,
  prepared_size_bytes     bigint,
  prepared_hash           text,
  page_count              int,
  digest_algorithm        text,
  digest_library_version  text,
  digest_state            text,
  digest_state_bytes      bigint,
  digest_state_generation text,
  operation_id            uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (law_firm_id, id),
  unique (law_firm_id, object_path)
);

create index if not exists signature_sources_firm_status_idx
  on signature_sources (law_firm_id, status, created_at desc);
create index if not exists signature_sources_preparing_idx
  on signature_sources (status, updated_at)
  where status in ('pending', 'preparing');

alter table signature_sources enable row level security;
drop policy if exists signature_sources_select on signature_sources;
create policy signature_sources_select on signature_sources for select to authenticated
  using (public.rls_is_firm_member(law_firm_id, auth.jwt()->>'sub'));

drop trigger if exists set_updated_at on signature_sources;
create trigger set_updated_at before update on signature_sources
  for each row execute function set_updated_at();

-- Nullable on purpose. Sessions and templates that predate the boundary keep
-- working and are never retro-admitted: nobody inspected those bytes, and a row
-- claiming otherwise would be a lie the seal later rests on.
alter table signature_sessions  add column if not exists source_id uuid;
alter table signature_templates add column if not exists source_id uuid;

alter table signature_sessions  drop constraint if exists signature_sessions_source_fkey;
alter table signature_sessions  add constraint signature_sessions_source_fkey
  foreign key (law_firm_id, source_id)
  references signature_sources (law_firm_id, id) on delete restrict;

alter table signature_templates drop constraint if exists signature_templates_source_fkey;
alter table signature_templates add constraint signature_templates_source_fkey
  foreign key (law_firm_id, source_id)
  references signature_sources (law_firm_id, id) on delete restrict;

create index if not exists signature_sessions_source_idx
  on signature_sessions (law_firm_id, source_id);
create index if not exists signature_templates_source_idx
  on signature_templates (law_firm_id, source_id);
