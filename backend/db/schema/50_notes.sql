create table if not exists note_types (
  id           uuid not null default gen_random_uuid(),
  law_firm_id  uuid not null references law_firms(id) on delete cascade,
  value        text not null,
  label        text not null,
  color        text,
  created_by   text references users(id) on delete restrict,
  created_at   timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  unique (law_firm_id, value)
);

create table if not exists note_templates (
  id            uuid not null default gen_random_uuid(),
  law_firm_id   uuid not null references law_firms(id) on delete cascade,
  label         text not null,
  note_type     text not null default 'general',
  subject       text not null default '',
  content_html  text not null default '',
  created_by    text references users(id) on delete restrict,
  created_at    timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id)
);

create index if not exists note_types_law_firm_idx on note_types (law_firm_id, label);
create index if not exists note_templates_law_firm_idx on note_templates (law_firm_id, label);

-- Firm-wide contact directory: the canonical record for every non-client person
-- or organization the firm deals with (opposing counsel, judges, experts,
-- adjusters, court reporters). Matters link to these through `matter_contacts`

-- =====================================================================
-- NOTES (matter, task and client, in one table)
-- =====================================================================
-- One `notes` table replaces `matter_notes`, `task_notes` and `client_notes`,
-- one `note_versions` replaces their three version tables, and one
-- `note_replies` replaces their three reply tables. Ten tables became four
-- (migration 0202).
--
-- The three were already ONE implementation: `shared/notes/notesEngine.ts`,
-- `notesRepository.ts`, `noteRepliesRepository.ts` and `notesRouter.ts` are
-- parameterized by table and by which column names the parent, and the fourteen
-- REST endpoints are generated from that factory. Only the storage was
-- triplicated, and the copies had already drifted: `matter_notes` grew four
-- columns the other two never got.
--
-- THE PARENT IS THREE NULLABLE FOREIGN KEYS, NOT A (parent_type, parent_id)
-- PAIR. That is the whole design decision here, and it is deliberate:
--
--   * A polymorphic `parent_id` can carry no foreign key, so deleting a matter
--     would leave its notes behind instead of cascading. Every note table today
--     cascades from its parent, and the app has no sweep that would replace it.
--   * The CHECK below makes "exactly one parent" a database rule rather than a
--     convention, which a polymorphic column cannot express either.
--   * The shared factories take a `parentColumn` name already, so pointing them
--     at one table is a smaller change than a discriminator would have been.
--
-- The clients foreign key is declared and kept. It used to be removed by the
-- SOFT-REFERENCE sweep, which migrations 0224 and 0225 retired, so deleting a
-- client now has to go through `clients.service.removeClient`, which deletes
-- the children itself in one transaction.

create table if not exists notes (
  id                  uuid primary key default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  -- Exactly one of these three is set; see notes_one_parent below.
  matter_id           uuid,
  -- Composite, like the matter arm: a single-column link would let a note name
  -- a task in another firm (migration 0213).
  task_id             uuid,
  client_id           uuid,
  content             text not null default '',
  content_html        text,
  subject             text,
  note_type           text default 'general',
  mentions            jsonb not null default '[]',
  created_by          text references users(id) on delete restrict,
  edited_by           text references users(id) on delete restrict,
  edited_at           timestamptz,
  -- The date the work happened, set by the author. Separate from created_at,
  -- which is when the row was saved; a note written up on Friday about
  -- Tuesday's call belongs to Tuesday.
  note_date           date default current_date,
  pinned_at           timestamptz,
  pinned_by           text references users(id) on delete restrict,
  -- A note is retracted, never hard-deleted: it is a record of work performed,
  -- and its time entries and links point at it from the billing and task tables.
  retracted_at        timestamptz,
  retracted_by        text references users(id) on delete restrict,
  retraction_reason   text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (law_firm_id, id),
  foreign key (law_firm_id, task_id) references tasks (law_firm_id, id) on delete cascade,
  constraint notes_one_parent check (
    (matter_id is not null)::int + (task_id is not null)::int + (client_id is not null)::int = 1
  ),
  foreign key (law_firm_id, matter_id) references matters (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, client_id) references clients (law_firm_id, id) on delete cascade
);
create index if not exists notes_matter_date_idx
  on notes (matter_id, note_date desc, created_at desc) where matter_id is not null;
create index if not exists notes_task_date_idx
  on notes (task_id, note_date desc, created_at desc) where task_id is not null;
create index if not exists notes_client_date_idx
  on notes (client_id, note_date desc, created_at desc) where client_id is not null;
create index if not exists notes_pinned_idx
  on notes (law_firm_id, pinned_at desc) where pinned_at is not null;
-- The firm-wide notes list orders by note_date across every matter in the firm.
-- Serves the composite foreign key to `tasks` added by migration 0213.
create index if not exists notes_firm_task_idx on notes (law_firm_id, task_id);
create index if not exists notes_firm_date_idx
  on notes (law_firm_id, note_date desc, created_at desc);
create index if not exists notes_author_idx
  on notes (law_firm_id, created_by) where created_by is not null;
create index if not exists notes_firm_matter_created_idx
  on notes (law_firm_id, matter_id, created_at desc, id desc) where matter_id is not null;
create index if not exists notes_firm_task_created_idx
  on notes (law_firm_id, task_id, created_at desc, id desc) where task_id is not null;
create index if not exists notes_firm_client_created_idx
  on notes (law_firm_id, client_id, created_at desc, id desc) where client_id is not null;

-- Append-only history of a note's prior states. Version N holds the content
-- that version N+1 replaced, written immediately before the update lands.
-- Scoped by note_id alone: the note already pins the parent.
create table if not exists note_versions (
  id              uuid primary key default gen_random_uuid(),
  law_firm_id     uuid not null references law_firms(id) on delete cascade,
  -- Composite: a single-column link guarantees the note exists but not that the
  -- version belongs to the same firm as the note it versions (migration 0213).
  note_id         uuid not null,
  version         integer not null,
  content         text not null default '',
  content_html    text,
  subject         text,
  note_type       text,
  note_date       date,
  edited_by       text references users(id) on delete restrict,
  created_at      timestamptz not null default now(),
  unique (note_id, version),
  unique (law_firm_id, id),
  foreign key (law_firm_id, note_id) references notes (law_firm_id, id) on delete cascade
);
create index if not exists note_versions_firm_note_idx on note_versions (law_firm_id, note_id);

-- Replies under a note: the note stays the work product, the conversation about
-- it lives here. The parent columns mirror `notes`, so a reply cascades with its
-- parent entity as well as with its note.
create table if not exists note_replies (
  id              uuid primary key default gen_random_uuid(),
  law_firm_id     uuid not null references law_firms(id) on delete cascade,
  -- A reply's parent is its note, and nothing else. It carried copies of the
  -- note's matter_id / task_id / client_id until migration 0207: written on
  -- every insert, never read back, and free to disagree with the note.
  note_id         uuid not null,
  content         text not null default '',
  content_html    text,
  mentions        jsonb not null default '[]',
  created_by      text references users(id) on delete restrict,
  edited_at       timestamptz,
  retracted_at    timestamptz,
  retracted_by    text references users(id) on delete restrict,
  retraction_reason text,
  parent_reply_id uuid references note_replies(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (law_firm_id, id),
  foreign key (law_firm_id, note_id) references notes (law_firm_id, id) on delete cascade
);
create index if not exists note_replies_note_idx on note_replies (note_id, created_at);
create index if not exists note_replies_firm_note_idx on note_replies (law_firm_id, note_id);
create index if not exists note_replies_parent_idx on note_replies (parent_reply_id);

-- Connections out of a note: to a task, or to a document. One row per
-- connection, discriminated by link_type. file_id carries no foreign key on
-- purpose: `files` is a best-effort mirror of GCS written outside the request
-- transaction, so a mirror gap must not be able to reject a link the user can
-- plainly see in the file browser. Matter notes are the only kind that links
-- today; the table is parent-agnostic because the note already names the parent.
create table if not exists note_links (
  id            uuid primary key default gen_random_uuid(),
  law_firm_id   uuid not null references law_firms(id) on delete cascade,
  note_id       uuid not null,
  link_type     text not null check (link_type in ('task', 'file')),
  -- The FK to tasks is added in DEFERRED CROSS-TABLE FOREIGN KEYS below, since
  -- `tasks` is created after this table.
  task_id       uuid,
  file_id       uuid,
  -- Set when the link was made from a reply rather than the note itself.
  reply_id      uuid references note_replies(id) on delete set null,
  -- True when the linked record was created from the note rather than picked
  -- from a list. Drives the "Created from this note" label.
  created_from_note boolean not null default false,
  created_by    text references users(id) on delete restrict,
  created_at    timestamptz not null default now(),
  -- Exactly one target, matching link_type. Added by migration 0202; a link
  -- row that names neither a task nor a file has no meaning, and one that
  -- names both is ambiguous to every reader.
  constraint note_links_target_ck check (
    (link_type = 'task' and task_id is not null and file_id is null) or
    (link_type = 'file' and file_id is not null and task_id is null)
  ),
  unique (law_firm_id, id),
  foreign key (law_firm_id, note_id) references notes (law_firm_id, id) on delete cascade
);
-- Partial uniques rather than one composite unique: Postgres treats nulls as
-- distinct, so a composite key over two nullable target columns would let the
-- same link be inserted twice.
create unique index if not exists note_links_task_uniq
  on note_links (note_id, task_id) where task_id is not null;
create unique index if not exists note_links_file_uniq
  on note_links (note_id, file_id) where file_id is not null;
create index if not exists note_links_note_idx on note_links (note_id);
create index if not exists note_links_firm_note_idx on note_links (law_firm_id, note_id);
create index if not exists note_links_firm_task_idx on note_links (law_firm_id, task_id);
create index if not exists note_links_task_idx
  on note_links (law_firm_id, task_id) where task_id is not null;
create index if not exists note_links_file_idx
  on note_links (law_firm_id, file_id) where file_id is not null;

-- Append-only chronological activity feed for a matter (also an audit trail).
-- One activity feed for all three parents, not a matter-only one (migration
-- 0214). The client and task arms are empty today and exist so the feed is not
-- built a second and third time, which is what happened to notes and events.
create table if not exists activity_log (
  id                uuid not null default gen_random_uuid(),
  law_firm_id       uuid not null,
  -- Exactly one parent; see activity_log_one_parent below.
  matter_id         uuid,
  client_id         uuid,
  task_id           uuid,
  activity_type     text not null,
  actor_user_id     text references users(id) on delete restrict,
  actor_name        text,
  summary           text not null,
  metadata          jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  constraint activity_log_one_parent check (num_nonnulls(matter_id, client_id, task_id) = 1),
  foreign key (law_firm_id, matter_id) references matters (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, task_id) references tasks (law_firm_id, id) on delete cascade
);
-- listForMatter filters (law_firm_id, matter_id) and orders by (created_at
-- desc, id desc), optionally narrowing by activity_type. Both indexes carry the
-- tenant column first and the full sort key, so the paged read needs no sort
-- step (migration 0206). They differ at the third column, so neither is a
-- redundant prefix of the other.
create index if not exists activity_log_firm_matter_time_idx
  on activity_log (law_firm_id, matter_id, created_at desc, id desc);
-- Supports the timeline's "Notes only" filter without scanning the matter's
-- whole history.
create index if not exists activity_log_firm_matter_type_time_idx
  on activity_log (law_firm_id, matter_id, activity_type, created_at desc);
-- One partial index per arm, so a feed read seeks rather than scanning a column
-- that is null for almost every row (migration 0214).
create index if not exists activity_log_firm_client_time_idx
  on activity_log (law_firm_id, client_id, created_at desc, id desc)
  where client_id is not null;
create index if not exists activity_log_firm_task_time_idx
  on activity_log (law_firm_id, task_id, created_at desc, id desc)
  where task_id is not null;
