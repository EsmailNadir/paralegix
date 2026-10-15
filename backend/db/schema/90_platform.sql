-- =====================================================================
-- NOTIFICATIONS
-- =====================================================================

create table if not exists notifications (
  id                  uuid primary key default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  user_id             text not null references users(id) on delete cascade,
  type                text not null,
  title               text not null,
  body                text not null,
  read                boolean not null default false,
  entity_type         text check (entity_type in ('task','matter','invoice','message','note','file')),
  entity_id           uuid,
  matter_id             uuid,
  action_url          text,
  created_by          text references users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  -- unix-minute time bucket written by the repository at insert (floor(epoch/60));
  -- backs the atomic dedupe unique index below (see migration 0057).
  dedupe_bucket       bigint,
  -- md5 of the caller-declared dedupe key, or (by default) of the whole visible
  -- payload. Written by the repository at insert; see migration 0128.
  dedupe_hash         text
);
create index if not exists notifications_unread_idx on notifications (user_id, created_at desc) where not read;
create index if not exists notifications_user_idx on notifications (law_firm_id, user_id, created_at desc);
-- Atomic dedupe (migrations 0057, 0128): an event-outbox retry re-runs the
-- notification listener; this partial unique index + `insert ... on conflict do
-- nothing` makes the insert atomic so concurrent retries in the same minute
-- bucket can't double-insert.
--
-- The key is the payload hash, NOT (type, entity). Keying on the entity made two
-- notifications that shared a type and entity but differed in text collide, and
-- `on conflict do nothing` swallowed the second with no error. It also had to
-- disagree with the repository's pre-check, which matched `title`. Hashing what
-- the user actually sees makes the two agree: a retry re-sends a byte-identical
-- payload and collapses, while two genuinely different notifications both land.
create unique index if not exists notifications_dedupe_uq
  on notifications (law_firm_id, user_id, dedupe_hash, dedupe_bucket)
  where dedupe_hash is not null;
-- Cascade deletes when the entity a notification points at is deleted.
create index if not exists notifications_entity_idx
  on notifications (law_firm_id, entity_type, entity_id);
-- Retention sweep: delete read notifications older than the cutoff.
create index if not exists notifications_created_at_idx on notifications (created_at);

-- ── notifications RLS (migration 0074): Realtime reads via a Firebase-uid JWT ──
-- A notification belongs to one user, so the policy is a direct uid match (no
-- membership join). Backend writes as `postgres` (bypasses RLS); the Realtime
-- client connects as `authenticated` and only sees its own rows.
alter table notifications enable row level security;
drop policy if exists notifications_realtime_select on notifications;
create policy notifications_realtime_select on notifications for select using (
  (auth.jwt() ->> 'sub') = user_id
);
grant usage on schema public to authenticated;
grant select on notifications to authenticated;
-- REPLICA IDENTITY FULL (migration 0078): DELETE realtime events otherwise carry
-- only the PK, so the client's `user_id=eq.<uid>` filter can't evaluate and
-- deletions never sync across tabs/devices. FULL puts the whole old row in the
-- WAL so RLS + the client filter can match `user_id` on DELETE.
alter table notifications replica identity full;
do $$
begin
  begin execute 'alter publication supabase_realtime add table notifications'; exception when others then null; end;
end $$;

-- =====================================================================
-- INVITATIONS (unified)
-- =====================================================================

create table if not exists invitations (
  id                  uuid primary key default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  email               citext not null,
  invite_type         text not null check (invite_type in ('member','client')),
  role_id             uuid,
  token               text not null unique,
  status              text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  matter_ids            uuid[],
  invited_by          text references users(id) on delete restrict,
  invited_at          timestamptz,
  invitation_sent_at  timestamptz,
  invitation_email    citext,
  invitation_failed   boolean not null default false,
  invitation_resend_count integer not null default 0,
  -- NOT NULL with a default (migration 0223). A null here meant an invitation
  -- that never expired, which was never a considered choice: it is what a writer
  -- that did not think about expiry produced.
  expires_at          timestamptz not null default now() + interval '7 days',
  accepted_at         timestamptz,
  accepted_by         text references users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Targeted invitations (organization-clients plan). Single-column FKs,
  -- matching the court_id/practice_area_id pattern: a composite tenant FK to
  -- clients(law_firm_id, id) can't ON DELETE SET NULL without nulling
  -- law_firm_id too, which would force ON DELETE CASCADE and silently drop
  -- invitation audit history whenever a client is deleted. Firm/client/link
  -- agreement is checked in the service layer.
  client_id           uuid references clients(id) on delete set null,
  contact_client_id   uuid references contact_clients(id) on delete set null,
  -- Single column, for the same reason as the client keys above and as
  -- members.role_id: a composite ON DELETE SET NULL would null law_firm_id too
  -- (migration 0186).
  constraint invitations_role_fk foreign key (role_id) references roles(id) on delete set null,
  -- Member invites carry no client identity.
  constraint invitations_member_no_client_check check (invite_type = 'client' or (client_id is null and contact_client_id is null)),
  -- A roster-link target implies its owning client is also set.
  constraint invitations_roster_requires_client_check check (contact_client_id is null or client_id is not null)
);
create index if not exists invitations_email_type_pending_idx on invitations (email, invite_type) where status = 'pending';
create index if not exists invitations_client_idx on invitations (law_firm_id, client_id) where client_id is not null;
create index if not exists invitations_contact_client_idx on invitations (law_firm_id, contact_client_id) where contact_client_id is not null;
-- Serves the on-delete walk of invitations_client_id_fkey (migration 0225).
create index if not exists invitations_client_id_idx on invitations (client_id);

-- One live pending invite per (firm, email), scoped to member invites.
create unique index if not exists invitations_member_pending_idx
  on invitations (law_firm_id, email)
  where invite_type = 'member' and status = 'pending';
-- One live pending invite per (firm, client) for person-client invites.
-- Legacy rows (and any invite issued before client_id is resolved) carry
-- client_id = null, which this partial unique index does not deduplicate
-- (Postgres never treats two NULLs as equal) - the application's pre-create
-- existence check is the operative safeguard for those.
create unique index if not exists invitations_person_client_pending_idx
  on invitations (law_firm_id, client_id)
  where invite_type = 'client' and contact_client_id is null and status = 'pending';
-- One live pending invite per (firm, roster link) for company roster
-- invites, so the same email can hold independent pending invites for two
-- different companies at once.
create unique index if not exists invitations_company_roster_pending_idx
  on invitations (law_firm_id, contact_client_id)
  where invite_type = 'client' and contact_client_id is not null and status = 'pending';

-- =====================================================================
-- COMPLIANCE: audit log, conflict-check records, legal holds
-- =====================================================================

-- Append-only security/data-access audit log. UPDATE is blocked by a trigger;
-- DELETE is allowed so the on-delete cascade from law_firms can purge a deleted
-- firm's rows. law_firm_id is nullable (some actions have no firm context).
create table if not exists audit_events (
  id            uuid primary key default gen_random_uuid(),
  law_firm_id   uuid references law_firms(id) on delete cascade,
  actor_uid     text,
  actor_email   text,
  action        text not null,
  resource_type text,
  resource_id   text,
  method        text,
  path          text,
  status_code   integer,
  ip            text,
  user_agent    text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists audit_events_firm_time_idx on audit_events (law_firm_id, created_at desc);
create index if not exists audit_events_actor_idx on audit_events (actor_uid, created_at desc);

create or replace function audit_events_immutable() returns trigger as $$
begin
  raise exception 'audit_events are append-only: rows cannot be updated (id=%)', old.id;
end;
$$ language plpgsql;

drop trigger if exists audit_events_immutable on audit_events;
create trigger audit_events_immutable before update on audit_events
  for each row execute function audit_events_immutable();

-- Persisted conflict-of-interest checks performed at intake, so the firm can show
-- a check was run, by whom, against what, and what it returned.
create table if not exists conflict_check_records (
  id                 uuid primary key default gen_random_uuid(),
  law_firm_id        uuid not null references law_firms(id) on delete cascade,
  performed_by       text references users(id) on delete restrict,
  matter_id          uuid,
  query_name         text,
  query_email        text,
  query_organization text,
  result_count       integer not null default 0,
  results            jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now()
);
create index if not exists conflict_check_firm_time_idx on conflict_check_records (law_firm_id, created_at desc);

-- activities.source_event_id is declared above, but `events` is created after
-- activities, so its FK has to be attached here. ON DELETE SET NULL: deleting
-- the event must not delete the billable time recorded against it.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'activities_source_event_fk') then
    alter table activities
      add constraint activities_source_event_fk
      foreign key (source_event_id) references events (id) on delete set null;
  end if;
end $$;

-- A legal hold is a ROW in `legal_holds`, not four columns copied onto three
-- tables (migration 0221). A `before delete` trigger on `matters` and `clients`
-- refuses while an unreleased hold exists, so a delete path that forgets to
-- check cannot quietly destroy preserved evidence.
--
-- The `files` arm exists and has no rows: nothing in the application ever set
-- `files.legal_hold`, so a hold placed there could never be lifted, and the
-- matter's hold governs its documents instead. The arm is there so the retention
-- work can use it deliberately.
create table if not exists legal_holds (
  id            uuid primary key default gen_random_uuid(),
  law_firm_id   uuid not null references law_firms(id) on delete cascade,
  matter_id     uuid,
  client_id     uuid,
  file_id       uuid,
  reason        text,
  placed_by     text references users(id) on delete restrict,
  placed_at     timestamptz not null default now(),
  -- A released hold is KEPT: which evidence was held, by whom and for how long
  -- is itself the record a hold exists to produce.
  released_by   text references users(id) on delete restrict,
  released_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (law_firm_id, id),
  constraint legal_holds_one_subject check (num_nonnulls(matter_id, client_id, file_id) = 1),
  foreign key (law_firm_id, matter_id) references matters (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, file_id)   references files   (law_firm_id, id) on delete cascade
);
-- One partial index per arm, restricted to LIVE holds: the only question the
-- trigger asks.
create index if not exists legal_holds_matter_idx
  on legal_holds (law_firm_id, matter_id) where matter_id is not null and released_at is null;
create index if not exists legal_holds_client_idx
  on legal_holds (law_firm_id, client_id) where client_id is not null and released_at is null;
create index if not exists legal_holds_file_idx
  on legal_holds (law_firm_id, file_id) where file_id is not null and released_at is null;

create or replace function legal_hold_blocks_delete() returns trigger
  language plpgsql as $$
declare
  held boolean;
begin
  select exists (
    select 1 from legal_holds h
     where h.released_at is null
       and h.law_firm_id = old.law_firm_id
       and ((tg_argv[0] = 'matter' and h.matter_id = old.id)
         or (tg_argv[0] = 'client' and h.client_id = old.id))
  ) into held;
  if held then
    raise exception 'record is under legal hold and cannot be deleted'
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists matters_legal_hold_delete_guard on matters;
create trigger matters_legal_hold_delete_guard before delete on matters
  for each row execute function legal_hold_blocks_delete('matter');

drop trigger if exists clients_legal_hold_delete_guard on clients;
create trigger clients_legal_hold_delete_guard before delete on clients
  for each row execute function legal_hold_blocks_delete('client');

-- =====================================================================
-- REMINDERS (unified reminder table from migration 0238)
-- =====================================================================

create table if not exists task_reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  law_firm_id uuid not null references law_firms(id) on delete cascade,
  task_id uuid not null,
  recipient_key text not null,
  last_sent_at timestamptz,
  sent_count int not null default 0 check (sent_count >= 0),
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (law_firm_id, id),
  unique (law_firm_id, task_id, recipient_key),
  foreign key (law_firm_id, task_id) references tasks(law_firm_id, id) on delete cascade,
  check ((claim_token is null) = (claim_expires_at is null))
);

create table if not exists reminders (
  id                        uuid primary key default gen_random_uuid(),
  law_firm_id               uuid not null references law_firms(id) on delete cascade,
  invoice_id                uuid,
  task_id                   uuid,
  event_id                  uuid,
  signature_participant_id  text,
  last_sent_at              timestamptz,
  sent_count                int not null default 0 check (sent_count >= 0),
  is_opted_out              boolean not null default false,
  pre_due_days              int check (pre_due_days is null or pre_due_days >= 0),
  pre_due_sent_at           timestamptz,
  recent_manual_sends       timestamptz[] not null default '{}',
  next_run_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (law_firm_id, id),
  constraint reminders_parent_ck check (
    num_nonnulls(invoice_id, task_id, event_id, signature_participant_id) = 1
  ),
  foreign key (law_firm_id, invoice_id) references invoices(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, task_id) references tasks(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, event_id) references events(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, signature_participant_id) references signature_participants(law_firm_id, id) on delete cascade
);


create unique index if not exists reminders_invoice_uq on reminders (law_firm_id, invoice_id) where invoice_id is not null;
create unique index if not exists reminders_task_uq on reminders (law_firm_id, task_id) where task_id is not null;
create unique index if not exists reminders_event_uq on reminders (law_firm_id, event_id) where event_id is not null;
create unique index if not exists reminders_participant_uq on reminders (law_firm_id, signature_participant_id) where signature_participant_id is not null;
-- Each read joins on one arm, so each arm needs an index leading with it. The
-- uniques above lead with law_firm_id and cannot serve that.
create index if not exists reminders_invoice_idx on reminders (invoice_id) where invoice_id is not null;
create index if not exists reminders_task_idx on reminders (task_id) where task_id is not null;
create index if not exists reminders_event_idx on reminders (event_id) where event_id is not null;
create index if not exists reminders_participant_idx on reminders (signature_participant_id) where signature_participant_id is not null;
create index if not exists reminders_next_run_idx on reminders (law_firm_id, next_run_at) where next_run_at is not null;


-- =====================================================================
-- EVENT OUTBOX (durability backstop for the in-process event bus)
-- =====================================================================
-- The live primary dispatch path stays the synchronous EventEmitter in
-- `eventBus.js`; this table is a SECONDARY safety net so a crash/transient
-- error between a DB commit and an async listener does not silently drop a
-- notification. A worker (gated by EVENT_OUTBOX_WORKER) claims rows
-- with FOR UPDATE SKIP LOCKED and re-dispatches them through the same bus with
-- at-least-once retry. Additive only: nothing touches this table unless the
-- worker is enabled.
-- Resume point for the per-firm passes of the daily reminder cron. Each pass
-- walks every firm inside one scheduler request; this records the last firm each
-- pass finished so the next run starts after it and wraps around. Without it a
-- pass cut short by the request timeout would restart from the same end of an
-- arbitrary ordering every day, and the firms past the cut-off would never be
-- reached. No FK on `last_firm_id`: a deleted firm should just fail to match and
-- restart the rotation, not delete the resume point.
create table if not exists cron_pass_state (
  pass_name    text primary key,
  last_firm_id uuid,
  updated_at   timestamptz not null default now()
);

-- Lease rows behind `withLock` / `tryLock` (`shared/database/advisoryLock.ts`,
-- migration 0013). Acquiring is one upsert that takes the row only when it is
-- absent or `locked_until` has passed; releasing deletes it only when
-- `owner_token` still matches, so an owner whose lease expired never deletes
-- the next owner's. No pool connection is held while the locked work runs.
-- Not tenant-owned: a key names a platform-wide thing (a cron pass, a payment
-- intent, a user's calendar).
create table if not exists lock_leases (
  domain       text        not null,
  lock_key     text        not null,
  owner_token  uuid        not null,
  locked_until timestamptz not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (domain, lock_key)
);

-- Send-once-per-local-day record for the daily digest.
--
-- The digest cron runs hourly (it has to: recipients pick a delivery hour in
-- their own timezone, so a single daily fire cannot serve every zone). The
-- primary key is the idempotency mechanism: a claim is an
-- `insert ... on conflict do nothing returning *`, and only the run that gets a
-- row back sends. That makes a double-fire, a manual re-trigger, and a retry
-- after a partial failure all safe without any advisory lock.
--
-- `sent_on` is the recipient's LOCAL date, not a UTC date - two recipients in
-- different zones legitimately roll over to a new digest day at different UTC
-- instants.
create table if not exists digest_sends (
  law_firm_id uuid    not null references law_firms(id) on delete cascade,
  user_id     text    not null references users(id) on delete cascade,
  sent_on     date    not null,
  item_count  integer not null default 0,
  created_at  timestamptz not null default now(),
  primary key (law_firm_id, user_id, sent_on)
);

create index if not exists digest_sends_sent_on_idx on digest_sends (sent_on);
-- Serves the on-delete walk of digest_sends_user_id_fkey (migration 0224).
create index if not exists digest_sends_user_id_idx on digest_sends (user_id);

create table if not exists event_outbox (
  id            uuid primary key default gen_random_uuid(),
  law_firm_id   uuid,
  event_type    text not null,
  payload       jsonb not null,
  status        text not null default 'pending'
                  check (status in ('pending','processing','done','failed')),
  attempts      int not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  processed_at  timestamptz
);

create index if not exists event_outbox_status_created_idx
  on event_outbox (status, created_at);
-- Supports the worker's retention sweep (delete 'done' rows by processed_at) and
-- dead-letter inspection by status (migration 0057). law_firm_id has no FK by
-- design -- it's a denormalized, nullable copy from the payload.
create index if not exists event_outbox_status_processed_idx
  on event_outbox (status, processed_at);
create index if not exists event_outbox_law_firm_idx
  on event_outbox (law_firm_id);

-- Column comments. These were written by earlier migrations and never carried
-- into the domain files, so a database built from schema.sql lacked them while
-- a migrated one had them. They are the reference for what each column means.
comment on column invitations.client_id is 'The clients.id this invitation was issued for. Set for both person-client invites and company roster invites (see contact_client_id); null for member invites and for legacy client invites issued before this column existed.';
comment on column invitations.contact_client_id is 'The contact_clients.id (roster link) a company invite targets. Null for person-client invites (client_id alone identifies the target) and for member invites.';
