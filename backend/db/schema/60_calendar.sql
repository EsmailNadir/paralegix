-- =====================================================================
-- CALENDAR
-- =====================================================================

create table if not exists calendar_events (
  id                    uuid primary key default gen_random_uuid(),
  stable_id             text,
  law_firm_id           uuid not null references law_firms(id) on delete cascade,
  title                 text not null,
  description           text,
  notes                 text,
  location              text,
  starts_at             timestamptz,
  ends_at               timestamptz,
  all_day               boolean not null default false,
  provider              text check (provider in ('google','outlook')),
  source                text,
  external_event_id     text,
  google_event_id       text,
  outlook_id            text,
  outlook_change_key    text,
  calendar_id           text,
  start_time_zone       text,
  -- Provider-owned meeting snapshot. These people need not have local records.
  provider_details      jsonb not null default '{}',
  last_synced_to_google timestamptz,
  last_synced_to_outlook timestamptz,
  google_last_modified  timestamptz,
  outlook_last_modified timestamptz,
  -- (migration 0016) the invitation's iCalendar UID, the same on Google and
  -- Outlook, and the provider id of the series this row is an occurrence of.
  ical_uid              text,
  series_event_id       text,
  created_by            text references users(id) on delete restrict,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists calendar_events_google_idx on calendar_events (law_firm_id, google_event_id) where google_event_id is not null;
create index if not exists calendar_events_outlook_idx on calendar_events (law_firm_id, outlook_id) where outlook_id is not null;
create index if not exists calendar_events_stable_id_idx on calendar_events (law_firm_id, stable_id);
-- (migration 0125): the calendar reads external events for a firm over the date
-- range it is drawing, which the firm-only indexes cannot narrow.
create index if not exists calendar_events_firm_start_idx on calendar_events (law_firm_id, starts_at);
create index if not exists calendar_events_ical_uid_idx
  on calendar_events (law_firm_id, created_by, ical_uid) where ical_uid is not null;
create index if not exists calendar_events_series_idx
  on calendar_events (law_firm_id, created_by, series_event_id) where series_event_id is not null;
-- (migration 0036) every member imports their own copy of a shared Google
-- meeting, which carries the same event id on every attendee's calendar, so the
-- inbound lookup is per owner.
create index if not exists calendar_events_owner_google_idx
  on calendar_events (law_firm_id, created_by, google_event_id) where google_event_id is not null;

-- Calendar sync ENGINE bookkeeping (relational, migration 0031; formerly jsonb
-- kv tables, now real columns). Provider event id -> source Paralegix entity is
-- resolved via entity_type/entity_id/scope_id.
create table if not exists calendar_mappings (
  provider          text not null check (provider in ('google','outlook')),
  external_event_id text not null,
  calendar_id       text,
  user_id           text references users(id) on delete restrict,
  law_firm_id       uuid references law_firms(id) on delete cascade,
  entity_type       text
    check (entity_type is null or entity_type in
      ('task', 'matterEvent', 'clientEvent', 'externalEvent', 'invoiceBilling')),
  entity_id         text,
  scope_id          text,           -- matterId / clientId / lawFirmId for nested entities
  item_key          text,
  -- (migration 0036) the version the provider reported for this member's copy
  -- right after Paralegix last wrote it (Google etag, Outlook changeKey) and its
  -- modified time, so an inbound echo of that write is recognised per copy.
  pushed_version    text,
  pushed_modified_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (provider, external_event_id)
);
create index if not exists calendar_mappings_entity_idx on calendar_mappings (entity_type, entity_id);
create index if not exists calendar_mappings_user_idx on calendar_mappings (user_id);

-- One row per provider push subscription. Google calls it a watch channel and
-- Outlook calls it a subscription; they carry the same seven facts, so they are
-- one table discriminated by `provider` (migration 0203). The two
-- provider-specific names are generalized:
--
--   google  resource_id -> resource, token        -> secret
--   outlook resource    -> resource, client_state -> secret
--
-- `calendarSync.repository` keeps returning each provider's own key names, so
-- no caller of that module learns about this.
create table if not exists calendar_subscriptions (
  id                    text primary key,   -- Google channel id / Graph subscription id
  provider              text not null check (provider in ('google','outlook')),
  user_id               text references users(id) on delete restrict,   -- auth uid (soft-referenced; may have no app users row)
  law_firm_id           uuid references law_firms(id) on delete cascade,
  calendar_id           text,
  -- Google: the resource id its channel watches. Outlook: the Graph resource path.
  resource              text,
  -- The shared secret echoed back on a push, so a notification can be
  -- authenticated. Google's channel token; Outlook's clientState.
  secret                text,
  expiration            timestamptz,
  last_outbound_push_at timestamptz,
  created_at            timestamptz not null default now()
);
create index if not exists calendar_subscriptions_user_idx
  on calendar_subscriptions (provider, user_id);
create index if not exists calendar_subscriptions_expiration_idx
  on calendar_subscriptions (provider, expiration);
create index if not exists calendar_subscriptions_firm_idx
  on calendar_subscriptions (law_firm_id);

-- One durable retry / dead-letter queue for two kinds of failed calendar work
-- (migration 0215 merged `calendar_webhook_failures` and
-- `google_watch_channel_stop_failures`).
--
--   webhook       A push notification that failed to process. Retrying means
--                 re-running the user's incremental sync, which is idempotent,
--                 so repeated failures for one (provider, user) coalesce onto a
--                 single row rather than queueing per event.
--   stop_channel  A Google watch channel this backend failed to stop. The
--                 calendar_subscriptions row is deleted after every stop attempt
--                 and holds the only copy of the id + resource id that
--                 channels/stop needs, so an unstopped channel is written here
--                 first; otherwise Google keeps pushing to a channel nothing can
--                 address.
--
-- NOT a union of the two old column lists, which would have left five columns
-- permanently null per kind and needed a partial unique per kind so each could
-- match its own `on conflict` target. The two queues differ only in what makes a
-- row unique, the retry budget, and whether a row can go stale on its own, so
-- `dedupe_key` holds whatever identifies the item for its kind, `payload` holds
-- the arguments to re-run it, and the budget stays in code.
create table if not exists calendar_sync_failures (
  id              uuid primary key default gen_random_uuid(),
  -- Nullable, and no foreign key: a webhook failure is recorded from the
  -- provider's push before the firm has been resolved. Nothing cascades these,
  -- which is why deleteWebhookFailuresForLawFirm exists.
  law_firm_id     uuid,
  -- 'webhook' is also an inbound push persisted before it is processed (a
  -- pending row); 'outbound' (migration 0036) is a provider write that failed
  -- transiently.
  kind            text not null check (kind in ('webhook', 'stop_channel', 'outbound')),
  -- Unique WITHIN its kind: 'google:<uid>' for a webhook, the channel id for a
  -- stop. Coalescing on it stops a storm of failures becoming a storm of rows.
  dedupe_key      text not null,
  provider        text check (provider is null or provider in ('google', 'outlook')),
  user_id         text references users(id) on delete restrict,
  -- The arguments needed to re-run the work: changeType / eventId / resource for
  -- a webhook, resourceId for a stop. Job arguments, not a relation.
  payload         jsonb not null default '{}',
  -- Past this the row is pointless rather than merely overdue. Only a channel
  -- sets it, from its own 7-day expiry at Google.
  expires_at      timestamptz,
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (kind, dedupe_key)
);
create index if not exists calendar_sync_failures_due_idx
  on calendar_sync_failures (kind, next_attempt_at);
create index if not exists calendar_sync_failures_firm_idx
  on calendar_sync_failures (law_firm_id)
  where law_firm_id is not null;

-- Events are relational (migration 0027). Hybrid: columns for queryable,
-- scoping and sync fields, jsonb for irregular nested data.
--
-- ONE TABLE FOR BOTH PARENTS (migration 0205). This was `matter_events` and
-- `client_events`, two tables sharing 26 identically-typed columns -- the whole
-- core plus every provider-sync column -- and two repositories whose methods
-- differed only in which column named the parent. The parent is now two nullable
-- foreign keys with a CHECK rather than a (parent_type, parent_id) pair, for the
-- reason migration 0202 gives for notes: a polymorphic parent id can carry no
-- foreign key, and both halves cascade from their parent today.
--
-- `calendar_events` is deliberately NOT part of this. It holds events synced
-- INTO Paralegix from Google and Outlook; these are the firm's own records,
-- which sync OUT. Opposite directions, different lifecycles.
create table if not exists events (
  id                     uuid primary key default gen_random_uuid(),
  law_firm_id            uuid not null references law_firms(id) on delete cascade,

  -- Exactly one of these is set; see events_parent_ck below. The FK to `clients`
  -- is declared and kept: the SOFT-REFERENCE sweep that used to drop it was
  -- retired by migrations 0224 and 0225, and clients.service does the cleanup.
  matter_id              uuid references matters(id) on delete cascade,
  client_id              uuid references clients(id) on delete cascade,

  -- ---- shared by both parents ----
  type                   text
    check (type is null or type in (
      'court_date', 'hearing', 'deposition', 'filing_deadline', 'discovery_cutoff',
      'mediation', 'arbitration', 'trial', 'appeal_deadline',
      'statute_of_limitations', 'meeting', 'other')),
  title                  text not null,
  notes                  text,
  location_name          text,
  location               text,
  status                 text not null default 'upcoming'
    check (status in ('upcoming', 'completed', 'cancelled')),
  date                   timestamptz,
  -- The event's end, so it syncs with its real duration. Nullable because an end
  -- is genuinely optional: a filing deadline is an instant, not a span, and the
  -- sync engine falls back to a one-hour block for those (migration 0220).
  ends_at                timestamptz,
  all_day                boolean not null default false,   -- all-day vs timed, captured from provider sync (migration 0099)
  created_by             text references users(id) on delete restrict,
  client_visible         boolean not null default false,   -- surfaces in the client portal agenda
  -- [{ fileId, name, size, contentType, scope, scopeId, linkedBy, linkedAt }]
  -- `fileId` is the link; the rest is a snapshot the calendar renders without a
  -- join. It was the object path, which a rename or a move rewrote.
  linked_files           jsonb not null default '[]',
  google_event_id        text,
  outlook_id             text,
  outlook_change_key     text,
  google_calendar_id     text,
  calendar_sync          jsonb not null default '{}',
  last_synced_to_google  timestamptz,
  last_synced_to_outlook timestamptz,
  google_last_modified   timestamptz,
  outlook_last_modified  timestamptz,

  -- ---- matter events only; left at their defaults on a client event ----
  -- These are per-parent FEATURES, not drift: a standalone client event has
  -- never had recurrence, dependencies, cancellation lineage, postponement
  -- history or reminder state.
  depends_on             jsonb not null default '[]',
  recurrence             jsonb,
  time_zone              text,
  client_description     text,
  recurrence_group_id    text,
  recurrence_index       int,
  is_recurrence_parent   boolean not null default false,
  cancellation_reason    text,
  cancelled_by           text references users(id) on delete restrict,
  cancelled_at           timestamptz,
  postponement_count     int not null default 0,
  postponement_history   jsonb not null default '[]',

  -- ---- client events only; null on a matter event, whose MATTER carries one ----
  -- Single-column FK, matching matters.court_id and contacts.court_id: an
  -- ON DELETE SET NULL on a composite (law_firm_id, court_id) key would null the
  -- NOT NULL tenant column too. Tenant agreement is the service's job.
  -- The court's NAME is read by joining `courts`, the way matters.repository,
  -- tasks.repository and contacts.repository all read it; the denormalized
  -- court_name copy client_events carried was dropped with the merge.
  court_id               uuid references courts (id) on delete set null,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  unique (law_firm_id, id),
  -- An end before its start is a data error, not a short event: the engine only
  -- honours an end strictly after the start and would silently discard it.
  constraint events_ends_after_start check (ends_at is null or date is null or ends_at > date),
  constraint events_parent_ck check (
    (matter_id is not null and client_id is null) or
    (client_id is not null and matter_id is null)
  )
);
-- Serves the on-delete walk of events_client_id_fkey (migration 0225).
create index if not exists events_client_id_idx on events (client_id);
-- Partial on the parent so a scan for one kind of event does not walk the other.
create index if not exists events_matter_fk_idx
  on events (matter_id) where matter_id is not null;
create index if not exists events_firm_matter_date_idx
  on events (law_firm_id, matter_id, date) where matter_id is not null;
create index if not exists events_firm_client_date_idx
  on events (law_firm_id, client_id, date) where client_id is not null;
-- (migration 0125, now covering both parents): the calendar reads events
-- firm-wide over the date range it is drawing, which neither per-parent index
-- above can narrow.
create index if not exists events_firm_date_idx on events (law_firm_id, date);
create index if not exists events_firm_status_date_idx on events (law_firm_id, status, date);
create index if not exists events_google_idx on events (google_event_id) where google_event_id is not null;
create index if not exists events_outlook_idx on events (outlook_id) where outlook_id is not null;
create index if not exists events_recur_idx on events (recurrence_group_id) where recurrence_group_id is not null;
create index if not exists events_client_visible_idx
  on events (law_firm_id, matter_id, date) where client_visible and status <> 'cancelled';
create index if not exists events_court_idx on events (court_id) where court_id is not null;
-- Named `set_updated_at`, which is also what the whole-schema trigger sweep at
-- the foot of schema.sql creates. A differently-named trigger here would leave a
-- schema.sql-built database carrying TWO of them and a migrated one carrying a
-- different single trigger, which is the drift migration 0202 avoided the same way.
drop trigger if exists set_updated_at on events;
create trigger set_updated_at before update on events
  for each row execute function set_updated_at();

-- Attendees who are not firm members. `event_assignees` covers the firm's own
-- people; a deposition or mediation also involves opposing counsel, a court
-- reporter and an expert, and those are directory contacts.
-- (migrations 0136 and 0178, merged into one table by 0205.)
-- Assignees are ROWS, not a jsonb array (migration 0218), mirroring
-- task_assignees. The array held a list of ids the application joined on,
-- which nothing could constrain: no key to users, so a removed member was
-- pruned by a listener rather than a cascade, and the digest's containment
-- test had no index to use. Names are joined from users at read.
create table if not exists event_assignees (
  law_firm_id uuid not null references law_firms(id) on delete cascade,
  event_id    uuid not null,
  user_id     text not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (event_id, user_id),
  foreign key (law_firm_id, event_id) references events (law_firm_id, id) on delete cascade
);
create index if not exists event_assignees_firm_event_idx on event_assignees (law_firm_id, event_id);
-- "My calendar" without scanning events, the shape task_assignees has for tasks.
create index if not exists event_assignees_firm_user_idx on event_assignees (law_firm_id, user_id);
-- Serves the on-delete walk of event_assignees_user_id_fkey (migration 0224).
create index if not exists event_assignees_user_id_idx on event_assignees (user_id);

create table if not exists event_contacts (
  id            uuid primary key default gen_random_uuid(),
  law_firm_id   uuid not null references law_firms(id) on delete cascade,
  event_id      uuid not null references events(id) on delete cascade,
  contact_id    uuid not null,
  created_at    timestamptz not null default now(),
  unique (law_firm_id, id),
  constraint event_contacts_unique_link unique (law_firm_id, event_id, contact_id),
  foreign key (law_firm_id, contact_id) references contacts (law_firm_id, id) on delete cascade
);
create index if not exists event_contacts_contact_idx on event_contacts (law_firm_id, contact_id);

-- Deadline Set templates (migration 0112). A firm-defined recipe that turns one
-- trigger/anchor date into a cascade of matter events. `items` is jsonb: an
-- ordered array of { title, type, offsetDays, offsetDirection, relativeTo,
-- clientVisible, notes } where `type` is a matter-event type,
-- `offsetDirection` is 'before' | 'after', and `relativeTo` is
-- 'trigger' | 'previous' (the date computed for the item before it in the
-- array; always 'trigger' for the first item).
create table if not exists deadline_set_templates (
  id                   uuid not null default gen_random_uuid(),
  law_firm_id          uuid not null references law_firms(id) on delete cascade,
  name                 text not null,
  description          text,
  adjust_for_weekends  boolean not null default false,
  items                jsonb not null default '[]',
  created_by           text references users(id) on delete restrict,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id)
);
