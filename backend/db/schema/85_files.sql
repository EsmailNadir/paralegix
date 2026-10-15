-- =====================================================================
-- TEMPLATES
-- =====================================================================

create table if not exists template_folders (
  id                  uuid primary key default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  name                text not null,
  color               text,
  parent_folder_id    uuid references template_folders(id) on delete set null,
  sort_order          int,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
-- non-unique sibling-name index. Promote to UNIQUE once duplicate sibling
-- folder names are de-duplicated in existing data.
create index if not exists template_folders_sibling_name_idx on template_folders (law_firm_id, parent_folder_id, lower(name));

create table if not exists templates (
  id                        uuid primary key default gen_random_uuid(),
  law_firm_id               uuid not null references law_firms(id) on delete cascade,
  name                      text not null,
  type                      text not null default 'html' check (type in ('html','docx','overlay')),
  fields                    text[] not null default '{}',
  repeaters                 jsonb not null default '[]',
  folder_id                 uuid references template_folders(id) on delete set null,
  html_object_path          text,
  docx_object_path          text,
  -- overlay type: overlay_pdf_object_path is the rendered editor canvas (equal to the
  -- upload if it was already a PDF, otherwise a one-time LibreOffice-converted copy);
  -- overlay_source_object_path is the original upload, kept for reference/re-conversion.
  overlay_pdf_object_path   text,
  overlay_source_object_path text,
  assets                    jsonb not null default '[]',   -- inline asset array (service-managed)
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index if not exists templates_firm_folder_idx on templates (law_firm_id, folder_id);

-- The Word-first template library (migration 0048). Separate from `templates`:
-- an uploaded .docx or fillable PDF is stored byte for byte and filled in
-- place, and an html template keeps its body in storage. A row points at its
-- body or its source file, never both.
create table if not exists word_templates (
  id                   uuid not null default gen_random_uuid(),
  law_firm_id          uuid not null references law_firms(id) on delete cascade,
  name                 text not null check (length(btrim(name)) between 1 and 200),
  type                 text not null check (type in ('html', 'docx', 'pdf-form')),
  -- Storage object holding an html template's body.
  html_object_path     text,
  -- Storage object holding a docx or pdf-form template's original file.
  source_object_path   text,
  original_file_name   text check (original_file_name is null or length(original_file_name) <= 255),
  fields               text[] not null default '{}',
  repeaters            jsonb not null default '[]',
  -- Images embedded in an html template: [{ id, object_path, mime_type, file_name }].
  assets               jsonb not null default '[]',
  created_by           text references users(id) on delete restrict,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  constraint word_templates_body_present check (
    (type = 'html' and html_object_path is not null and source_object_path is null)
    or (type in ('docx', 'pdf-form') and source_object_path is not null and html_object_path is null)
  )
);
-- The library lists one firm's templates by name.
create index if not exists word_templates_firm_name_idx
  on word_templates (law_firm_id, name);
-- Same-name detection on upload, and the guarantee behind it: two concurrent
-- uploads of one name cannot both create a row.
create unique index if not exists word_templates_firm_type_name_key
  on word_templates (law_firm_id, type, lower(name))
  where type in ('docx', 'pdf-form');
create index if not exists word_templates_created_by_idx
  on word_templates (created_by);
comment on table word_templates is 'Word-first template library: an uploaded .docx or fillable PDF filled in place, or an HTML template whose body lives in storage.';
comment on column word_templates.source_object_path is 'Storage object of the original .docx or .pdf. Replaced by writing a new versioned object, repointing this column, then deleting the old one.';

-- Page-relative overlay boxes for overlay-type templates, one row per field (or per
-- repeater column on its authored row). Position is percent-of-page, mirroring
-- signature_fields. templates.fields/templates.repeaters remain the source of truth for
-- "what fields exist"; this table is "where they sit on the page".
create table if not exists template_field_placements (
  id                 uuid primary key default gen_random_uuid(),
  law_firm_id        uuid not null references law_firms(id) on delete cascade,
  template_id        uuid not null references templates(id) on delete cascade,
  field_name         text not null,
  field_type         text not null default 'text'
    check (field_type in ('text', 'date', 'checkbox', 'textbox', 'image')),
  page               int not null,
  x_percent          numeric not null,
  y_percent          numeric not null,
  width_percent      numeric not null,
  height_percent     numeric not null,
  repeater_name      text,
  repeater_row_index int,
  sort_order         int not null default 0,
  -- Literal text for a textbox placement, stamped as-is on every filled
  -- document. Null for other field types.
  text_content       text,
  -- GCS object path + MIME type of an uploaded image placement. Null for
  -- other field types.
  image_object_path  text,
  image_mime_type    text,
  -- Text styling (text/date/textbox placements; checkbox/image ignore it).
  -- font_size null keeps the historical auto-fit-to-box behavior. helvetica/
  -- times/courier are pdf-lib's built-in fonts; calibri/cambria/pt-serif/
  -- pt-sans are real TTFs fontkit-embedded by the stamping path (see
  -- backend/src/modules/templates/fonts).
  font_size          numeric,
  font_family        text not null default 'times'
    check (font_family in ('helvetica', 'times', 'courier', 'calibri', 'cambria', 'pt-serif', 'pt-sans')),
  bold               boolean not null default false,
  italic             boolean not null default false,
  color              text not null default '#000000',
  text_align         text not null default 'left'
    check (text_align in ('left', 'center', 'right')),
  -- Each non-blank line gets a bullet prefix before layout (text/date/textbox
  -- only; a plain boolean since the content is a single string, not markup).
  bullet_list        boolean not null default false,
  -- Mixed-formatting rich text for a 'textbox' placement: an array of
  -- paragraph blocks, each an array of styled runs (bold/italic/color per
  -- run, plus an optional fieldName making the run a merge-field chip
  -- resolved at fill time). Null keeps the placement on the flat
  -- text_content/bullet_list rendering path above unchanged; text_content/
  -- bullet_list are kept as a plain-text mirror of rich_text when it's set.
  rich_text          jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists template_field_placements_template_id_idx
  on template_field_placements (template_id);

-- =====================================================================
-- FILES (metadata; bytes in GCS)
-- =====================================================================

-- One row per file or folder. The tree is `parent_id`; the object under
-- `lawfirmids/{law_firm_id}/objects/{id}` is written once and never moves, so a
-- rename or a move is an update here rather than a copy of every byte beneath a
-- prefix. Every scope (a matter, a task, a client, the firm's general area) owns
-- exactly one root folder, which is what lets one index and one query serve the
-- root and every subfolder alike.
create table if not exists files (
  id                  uuid primary key default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  kind                text not null default 'file' check (kind in ('file', 'folder')),
  name                text not null,
  -- Null only on a scope root. Everything else hangs off one.
  parent_id           uuid,
  -- Which tree this row belongs to. A root names its scope through the id
  -- columns below; every descendant carries the same values so a listing can
  -- filter without walking to the root.
  scope               text not null check (scope in ('matter', 'task', 'client', 'firm')),
  matter_id           uuid,
  -- A matter-linked task's document carries BOTH ids: it belongs to the task,
  -- and the matter listing excludes it on that basis.
  task_id             uuid,
  client_id           uuid,
  -- The storage key, assigned at insert and never changed. A folder has none.
  object_path         text,
  mime_type           text,
  size_bytes          bigint check (size_bytes is null or size_bytes >= 0),
  -- An upload is a row before it is bytes: the row is inserted to claim the
  -- name, then the browser writes the object, then this is stamped. A row that
  -- never gets here is an abandoned upload and the sweeper collects it with its
  -- object. Only finalized rows count toward a firm's usage or appear in a list.
  finalized_at        timestamptz,
  uploaded_by         text references users(id) on delete restrict,
  -- The signing session that filed this document, when one did. It makes filing
  -- retry-safe: the terminal 'completed' write can fail after the bytes land,
  -- and the recovery pass has to re-use the same row rather than file a second
  -- copy of the same executed document beside the first.
  signed_via_session  text,
  -- Shared into the client portal. A folder shares everything beneath it; see
  -- `file_client_visibility` for the per-client narrowing.
  client_visible      boolean not null default false,
  folder_color        text,
  -- Soft delete. The row and its object survive a retention window so a delete
  -- is recoverable and a legal hold still has something to hold; the sweeper
  -- destroys both afterwards.
  deleted_at          timestamptz,
  deleted_by          text references users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (law_firm_id, id),
  foreign key (law_firm_id, parent_id) references files (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, matter_id) references matters (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, task_id) references tasks (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, client_id) references clients (law_firm_id, id) on delete cascade,
  -- What a filesystem allows in one name, and what a download's
  -- Content-Disposition header can carry. The object path no longer grows with
  -- the name, so this is about the name being usable, not about storage: it is
  -- rendered in a listing, sent as a download filename, and written as a zip
  -- entry. A scope root is the exception: nothing renders it, so it has no name.
  constraint files_name_length check (
    char_length(name) <= 255 and (parent_id is null or char_length(name) >= 1)
  ),
  constraint files_folder_has_no_object check (kind = 'file' or object_path is null),
  constraint files_file_has_object check (kind = 'folder' or object_path is not null),
  -- A root has to name the scope it serves, or it is a tree nothing can find.
  constraint files_root_names_scope check (
    parent_id is not null or (
      (scope = 'matter' and matter_id is not null and task_id is null and client_id is null) or
      (scope = 'task' and task_id is not null and client_id is null) or
      (scope = 'client' and client_id is not null and matter_id is null and task_id is null) or
      (scope = 'firm' and matter_id is null and task_id is null and client_id is null)
    )
  )
);

-- A name is unique among its live siblings, case-insensitively: two documents
-- whose names differ only in case are the same document to a person, and cannot
-- both be saved by a case-insensitive client. Soft-deleted rows are excluded so
-- deleting a file and uploading a replacement under its name works.
create unique index if not exists files_sibling_name_uidx
  on files (law_firm_id, parent_id, lower(name)) where parent_id is not null and deleted_at is null;

-- One root per scope. `ensureScopeRoot` inserts on conflict against these, so
-- two concurrent first writes to a matter cannot build two trees for it.
create unique index if not exists files_matter_root_uidx
  on files (law_firm_id, matter_id) where parent_id is null and scope = 'matter';
create unique index if not exists files_task_root_uidx
  on files (law_firm_id, task_id) where parent_id is null and scope = 'task';
create unique index if not exists files_client_root_uidx
  on files (law_firm_id, client_id) where parent_id is null and scope = 'client';
create unique index if not exists files_firm_root_uidx
  on files (law_firm_id) where parent_id is null and scope = 'firm';

create index if not exists files_parent_idx on files (law_firm_id, parent_id) where deleted_at is null;
create index if not exists files_firm_matter_idx on files (law_firm_id, matter_id);
create index if not exists files_firm_client_idx on files (law_firm_id, client_id);
create index if not exists files_firm_task_idx on files (law_firm_id, task_id);
-- The sweeper's two work queues.
create index if not exists files_deleted_idx on files (deleted_at) where deleted_at is not null;
create index if not exists files_deleted_by_idx on files (deleted_by) where deleted_by is not null;
create unique index if not exists files_signed_via_session_uidx
  on files (law_firm_id, signed_via_session) where signed_via_session is not null;
create index if not exists files_unfinalized_idx
  on files (created_at) where kind = 'file' and finalized_at is null;
create unique index if not exists files_object_path_uidx on files (object_path) where object_path is not null;

-- Narrows a shared file or folder to named clients. `client_visible` with no
-- rows here means every client on the scope; with rows, only those clients.
-- Replaces the `visibleClientIds` key that used to live on the object metadata,
-- where no SQL read could enforce it.
create table if not exists file_client_visibility (
  law_firm_id uuid not null references law_firms(id) on delete cascade,
  file_id     uuid not null,
  client_id   uuid not null,
  -- No `updated_at`: `setVisibility` replaces the whole set for a file, so a row
  -- is created and destroyed but never updated.
  created_at  timestamptz not null default now(),
  primary key (law_firm_id, file_id, client_id),
  foreign key (law_firm_id, file_id) references files (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, client_id) references clients (law_firm_id, id) on delete cascade
);
create index if not exists file_client_visibility_client_idx
  on file_client_visibility (law_firm_id, client_id);

-- Buffer of not-yet-notified document shares, one row per (client, object). A
-- trailing-edge debounce flushes all of a client's unsent rows into a single
-- digest, so a burst of shares becomes one email + one bell item instead of one
-- per file (see modules/files/shareNotifications.service.js). Migration 0108.

-- =====================================================================
-- FILE CLIENT ACCESS (unified access ledger from migration 0236)
-- =====================================================================

create table if not exists file_client_access (
  id                  uuid primary key default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  file_id             uuid not null references files(id) on delete cascade,
  client_user_id      text not null references users(id) on delete cascade,
  is_folder           boolean not null default false,
  is_email_enabled    boolean not null default true,
  shared_by           text references users(id) on delete restrict,
  shared_at           timestamptz not null default now(),
  notified_at         timestamptz,
  first_seen_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (law_firm_id, id),
  foreign key (law_firm_id, file_id) references files(law_firm_id, id) on delete cascade
);

drop trigger if exists set_updated_at on file_client_access;
create trigger set_updated_at before update on file_client_access
  for each row execute function set_updated_at();

create unique index if not exists file_client_access_firm_user_file_uq on file_client_access (law_firm_id, client_user_id, file_id);
create index if not exists file_client_access_pending_idx on file_client_access (law_firm_id, client_user_id) where notified_at is null;
create index if not exists file_client_access_client_user_id_idx on file_client_access (client_user_id);
create index if not exists file_client_access_shared_by_idx on file_client_access (shared_by) where shared_by is not null;
create index if not exists file_client_access_firm_file_idx on file_client_access (law_firm_id, file_id) where file_id is not null;
create index if not exists file_client_access_file_id_idx on file_client_access (file_id) where file_id is not null;

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

-- Only the file arm needs its own index. The job arm leads the primary key
-- already, so a second index on it would be one the planner never picks and one
-- more structure every insert has to maintain. The file arm is a foreign key
-- that leads no other index, so without one a cascade delete of a document
-- scans the whole table.
create index if not exists file_export_job_sources_file_idx
  on file_export_job_sources (law_firm_id, file_id);

-- =====================================================================
-- STORAGE RESERVATIONS (quota held by uploads still in flight)
-- =====================================================================

-- One row per file an upload-init opened, holding its declared size against the
-- firm's quota until finalize charges what landed and deletes the row, a cancel
-- deletes it, or it expires. `law_firms.storage_used_bytes` counts SAVED files
-- only; admission counts that plus every live row here, under a lock on the
-- firm row so two concurrent uploads cannot both slip past a hard limit.
--
-- The expiry is what makes an abandoned upload harmless: a crashed tab or a
-- failed browser upload frees its quota when the row lapses, without anyone
-- acting. A lapsed row is ignored by the sum and purged by the next reservation
-- or recount. See shared/utils/storageUsage.ts.
--
-- Rows are inserted and deleted, never updated, so there is no `updated_at`.
create table if not exists storage_reservations (
  id           uuid not null default gen_random_uuid(),
  law_firm_id  uuid not null references law_firms(id) on delete cascade,
  -- The uploader. Only they may release it early, so one member cannot free
  -- quota another member is holding for an upload still in flight.
  created_by   text not null references users(id) on delete cascade,
  bytes        bigint not null check (bytes >= 0),
  created_at   timestamptz not null default now(),
  -- After this the reservation no longer counts, whether or not anyone
  -- released it.
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




create table if not exists document_requests (
  id           uuid not null default gen_random_uuid(),
  law_firm_id  uuid not null references law_firms(id) on delete cascade,
  matter_id    uuid,
  -- The client the request is addressed to (must be a client on the matter,
  -- or any client of the firm when matter_id is null).
  client_id    uuid not null,
  title        text not null,
  note         text,
  status       text not null default 'open'
               check (status in ('open','completed','cancelled')),
  due_date     date,
  created_by   text references users(id) on delete restrict,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  foreign key (law_firm_id, matter_id) references matters (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, client_id) references clients (law_firm_id, id) on delete cascade
);
create index if not exists document_requests_firm_client_idx on document_requests (law_firm_id, client_id);

-- One requested document. 'received' once at least one file is uploaded against
-- it; 'waived' if the firm decides it is no longer needed.
create table if not exists document_request_items (
  id           uuid not null default gen_random_uuid(),
  law_firm_id  uuid not null references law_firms(id) on delete cascade,
  request_id   uuid not null references document_requests(id) on delete cascade,
  label        text not null,
  -- Optional detail shown to the client alongside the label, explaining what
  -- exactly is needed for this item. Migration 0163.
  description  text,
  status       text not null default 'pending'
               check (status in ('pending','received','waived')),
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id)
);
create index if not exists document_request_items_request_idx on document_request_items (request_id, sort_order);

-- Persist upload sessions so a lost init response can be retried safely.
create table if not exists document_request_uploads (
  id uuid primary key default gen_random_uuid(),
  law_firm_id uuid not null references law_firms(id) on delete cascade,
  item_id uuid not null,
  created_by text not null references users(id) on delete restrict,
  action_key uuid not null,
  position integer not null check (position >= 0),
  request_hash text not null,
  file_id uuid not null,
  upload_url text not null,
  reservation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (law_firm_id, id),
  unique (law_firm_id, item_id, created_by, action_key, position),
  foreign key (law_firm_id, item_id) references document_request_items(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, file_id) references files(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, reservation_id) references storage_reservations(law_firm_id, id) on delete set null (reservation_id)
);
create index if not exists document_request_uploads_item_idx on document_request_uploads (item_id);
create index if not exists document_request_uploads_creator_idx on document_request_uploads (created_by);
create index if not exists document_request_uploads_file_idx on document_request_uploads (file_id);
create index if not exists document_request_uploads_reservation_idx on document_request_uploads (reservation_id);
create index if not exists document_request_uploads_firm_file_idx on document_request_uploads (law_firm_id, file_id);
create index if not exists document_request_uploads_firm_reservation_idx on document_request_uploads (law_firm_id, reservation_id);

-- Links an item to the file(s) that answered it, through the `attachments`
-- table's `document_request_item_id` arm. The file itself is a `files` row like
-- any other, so a rename or a move leaves the link intact.

create table if not exists document_request_templates (
  id             uuid not null default gen_random_uuid(),
  law_firm_id    uuid not null references law_firms(id) on delete cascade,
  name           text not null,
  default_title  text not null,
  default_note   text,
  items          jsonb not null default '[]',
  archived       boolean not null default false,
  created_by     text references users(id) on delete restrict,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id)
);
create index if not exists document_request_templates_firm_idx on document_request_templates (law_firm_id, archived, name);

-- Secure external file share links: expiring, optionally password-protected links
-- to a file, or to several files and folders, for parties without a portal account (opposing counsel, experts,
-- courts). The token is the credential; a PUBLIC route resolves it to a short-lived
-- signed URL and never exposes the object path. SQL-authoritative. Migration 0118.
--
-- The token is the primary key. `file_id` and `revoked_at` (migration 0236) are the
-- first half of the D1 cutover: the link is being repointed from `object_path` onto
-- the `files` row, and `revoked` is being replaced by a timestamp. Both old columns
-- are still authoritative for readers, so both pairs are kept in step by
-- `file_share_links_sync_revoked` below until the second half retires them.
create table if not exists file_share_links (
  token          text primary key,
  law_firm_id    uuid not null references law_firms(id) on delete cascade,
  -- `set null`, not `cascade`: a destroyed document REVOKES its links (the
  -- sweeper writes that) and the row survives, so the public route can answer
  -- "revoked" rather than "no such link". A soft-deleted file keeps its id, so
  -- an ordinary delete leaves this pointing at the row it always did.
  file_id        uuid references files(id) on delete set null,
  display_name   text not null,
  mime_type      text,
  -- 'view' forces inline disposition; 'download' forces attachment.
  permission     text not null default 'download'
                 check (permission in ('view','download')),
  -- scrypt hash (never the plaintext); null = no password required.
  password_hash  text,
  expires_at     timestamptz not null,
  -- Null means live. There is no separate boolean: two columns for one fact is
  -- how they came to disagree.
  revoked_at     timestamptz,
  access_count   integer not null default 0,
  last_accessed_at timestamptz,
  created_by     text references users(id) on delete restrict,
  created_at     timestamptz not null default now(),
  -- What `file_share_link_items` points at, so an item cannot name a link in
  -- another firm. Migration 0014.
  unique (law_firm_id, token),
  foreign key (law_firm_id, file_id) references files(law_firm_id, id) on delete set null (file_id)
);

create index if not exists file_share_links_firm_file_idx on file_share_links (law_firm_id, file_id) where file_id is not null;
create index if not exists file_share_links_file_id_idx on file_share_links (file_id) where file_id is not null;

-- The files and folders a multi-item share link names (migration 0014). A link
-- with rows here carries a null `file_id`; a link without rows is the
-- single-file shape above. A folder shares what is inside it when the link is
-- opened, not what was inside it when the link was made. Written once with the
-- link and never updated: revoking acts on the link, and a deleted item drops
-- out of what the link resolves to at read time.
create table if not exists file_share_link_items (
  law_firm_id uuid not null references law_firms(id) on delete cascade,
  token       text not null,
  file_id     uuid not null,
  created_at  timestamptz not null default now(),
  primary key (law_firm_id, token, file_id),
  foreign key (law_firm_id, token) references file_share_links (law_firm_id, token) on delete cascade,
  foreign key (law_firm_id, file_id) references files (law_firm_id, id) on delete cascade
);
create index if not exists file_share_link_items_file_idx
  on file_share_link_items (law_firm_id, file_id);

-- Column comments. These were written by earlier migrations and never carried
-- into the domain files, so a database built from schema.sql lacked them while
-- a migrated one had them. They are the reference for what each column means.
comment on column document_requests.matter_id is 'Matter this request targets. Null means a client-level "General" request not tied to any matter.';
comment on column template_field_placements.font_size is 'User-chosen point size. Null keeps the historical auto-fit-to-box behavior (text/date placements created before this column existed).';
comment on column template_field_placements.image_mime_type is 'MIME type of image_object_path''s bytes. Null for other types.';
comment on column template_field_placements.image_object_path is 'GCS object path of the uploaded image for an image placement (field_type = image). Null for other types.';
comment on column template_field_placements.text_content is 'Literal text for a textbox placement (field_type = textbox), stamped as-is on every filled document. Null for other types.';
comment on column templates.overlay_pdf_object_path is 'GCS object path of the PDF rendered as the overlay editor canvas. Equal to the uploaded file when it was already a PDF, otherwise a one-time LibreOffice-converted copy made at upload.';
comment on column templates.overlay_source_object_path is 'GCS object path of the original uploaded file for an overlay-type template (PDF or a convertible format), kept for reference/re-conversion.';
