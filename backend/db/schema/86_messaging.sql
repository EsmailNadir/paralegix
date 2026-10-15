-- =====================================================================
-- MESSAGING (RLS on)
-- =====================================================================

create table if not exists conversations (
  id                   uuid not null default gen_random_uuid(),
  law_firm_id          uuid references law_firms(id) on delete cascade,
  client_id            text references users(id) on delete set null,
  last_message_at      timestamptz,
  last_sender_user_id  text references users(id) on delete restrict,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  last_notification_email_at timestamptz,
  conversation_type    text not null default 'direct'
                         check (conversation_type in ('direct','group')),   -- migration 0102
  title                text,                                                 -- group title (migration 0102)
  matter_id            uuid,                                                 -- group confidentiality scope (migration 0102)
  created_by           text references users(id) on delete restrict,                                                 -- migration 0102
  hide_client_names    boolean not null default false,                       -- per-conversation client-name masking (migration 0106)
  archived_at          timestamptz,                                          -- firm-side archive; null = active (migration 0109)
  archived_by          text references users(id) on delete restrict,                                                 -- who archived it (migration 0109)
  -- The clients.id this group conversation is the canonical company thread
  -- for (organization-clients plan). Null for direct (person) conversations
  -- and for ordinary group threads with no company binding. client_id above
  -- stays the PERSON direct-thread identity (a Firebase UID); this is the
  -- separate company identity. No ON DELETE SET NULL (would null law_firm_id
  -- too on this composite FK) and no ON DELETE CASCADE (a client delete must
  -- not silently destroy message history) - the default RESTRICT blocks
  -- deleting a company client with a live canonical conversation.
  client_record_id     uuid,
  primary key (id),
  unique (law_firm_id, id),
  -- Direct threads dedupe by (firm, client). Group threads set client_id = NULL;
  -- Postgres treats NULLs as distinct here, so unlimited groups coexist.
  unique (law_firm_id, client_id),
  -- restrict on purpose: a client with a conversation cannot be deleted out
  -- from under it. It was the one key the retired SOFT-REFERENCE sweep spared.
  foreign key (law_firm_id, client_record_id) references clients (law_firm_id, id) on delete restrict
);
create index if not exists conversations_firm_idx on conversations (law_firm_id, last_message_at desc);
create index if not exists conversations_client_idx on conversations (client_id, last_message_at desc);
create index if not exists conversations_archived_idx on conversations (law_firm_id, archived_at);
-- One canonical (non-archived) company conversation per (firm, client). The
-- archived_at exclusion matters: without it, archiving a company's canonical
-- thread would permanently block creating or finding a replacement, because
-- the index would still reject the new insert.
create unique index if not exists conversations_client_record_active_idx
  on conversations (law_firm_id, client_record_id)
  where client_record_id is not null and archived_at is null;

-- Group-conversation membership (migration 0102). Direct threads do NOT use this
-- table; they keep the client_id column + read_by_firm/read_by_client flags.

-- =====================================================================
-- CONVERSATION PARTICIPANTS (merged from migration 0234)
-- =====================================================================

create table if not exists conversation_participants (
  id                  uuid not null default gen_random_uuid(),
  conversation_id     uuid not null references conversations(id) on delete cascade,
  participant_user_id text references users(id) on delete restrict,
  client_id           uuid references clients(id) on delete cascade,
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  participant_type    text not null check (participant_type in ('client', 'firm_member')),
  added_by            text references users(id) on delete restrict,
  added_at            timestamptz not null default now(),
  removed_at          timestamptz,
  last_read_at        timestamptz,
  history_visible_from timestamptz,
  primary key (id),
  unique (law_firm_id, id),
  foreign key (law_firm_id, client_id) references clients(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, conversation_id) references conversations(law_firm_id, id) on delete cascade,
  constraint conversation_participants_actor_ck check (participant_user_id is not null or client_id is not null)
);

create unique index if not exists conv_participants_conv_user_idx
  on conversation_participants (conversation_id, participant_user_id);

create unique index if not exists conv_participants_conv_client_idx
  on conversation_participants (conversation_id, client_id);

create index if not exists conv_participants_client_idx
  on conversation_participants (client_id)
  where client_id is not null;

create index if not exists conv_participants_firm_client_idx
  on conversation_participants (law_firm_id, client_id)
  where client_id is not null;

create index if not exists conv_participants_firm_conv_idx
  on conversation_participants (law_firm_id, conversation_id);

create index if not exists conv_participants_user_idx
  on conversation_participants (participant_user_id) where removed_at is null;

create index if not exists conv_participants_conv_idx
  on conversation_participants (conversation_id) where removed_at is null;


create table if not exists conversation_matters (
  conversation_id uuid not null references conversations(id) on delete cascade,
  law_firm_id     uuid not null references law_firms(id) on delete cascade,
  matter_id       uuid not null,
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  primary key (conversation_id, matter_id),
  foreign key (law_firm_id, matter_id) references matters (law_firm_id, id) on delete cascade
);
create index if not exists conversation_matters_matter_idx
  on conversation_matters (law_firm_id, matter_id);

create table if not exists messages (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references conversations(id) on delete cascade,
  law_firm_id         uuid references law_firms(id) on delete cascade,
  sender_user_id      text references users(id) on delete restrict,
  content             text not null default '',
  attachments         jsonb,
  mentions            jsonb not null default '[]',
  -- NULL is a real value: recordParticipantEvent writes system rows for inline
  -- participant add and remove events, which have no sender.
  sender_type         text
    check (sender_type is null or sender_type in ('client', 'firm_member')),
  -- Who spoke, as THIS FIRM recorded it. Not a cache of users.name: a firm that
  -- erases a client tombstones this copy (anonymizeParticipantIdentity) even
  -- when the person is still a live client of another firm, whose threads keep
  -- the name. A join has one value platform-wide and cannot express that.
  sender_name         text,
  sent_as_firm        boolean not null default false,                          -- "send as firm" snapshot (migration 0107)
  read                boolean not null default false,
  read_by_firm        boolean not null default false,
  read_by_client      boolean not null default false,
  read_at             timestamptz,
  matter_id           uuid,
  status              text default 'sent',
  edited_at           timestamptz,                                            -- set when the sender edits (marker only; original text not retained) (migration 0110)
  deleted_at          timestamptz,                                            -- soft delete: row retained, content masked on read (migration 0110)
  deleted_by          text references users(id) on delete restrict,                              -- who soft-deleted the message (migration 0110)
  kind                text not null default 'user'
                        check (kind in ('user','system')),                    -- 'system' = inline participant add/remove event (migration 0114)
  system_event        jsonb,                                                  -- structured payload for kind='system' rows (migration 0114)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz
);
create index if not exists messages_conversation_created_idx on messages (conversation_id, created_at desc) include (content);
-- Unread counts. `CONV_JOINS` counts per conversation with `filter (where
-- sender_type = ... and read_by_... = false)`, and the two firm-wide unread
-- counters and the mark-read update filter the same way. Each partial holds
-- only the rows still unread on that side, so the count is a tiny index scan
-- rather than a walk of every message the conversation ever had.
create index if not exists messages_client_unread_idx on messages (conversation_id)
  where sender_type = 'firm_member' and read_by_client = false;
create index if not exists messages_firm_unread_idx on messages (conversation_id)
  where sender_type = 'client' and read_by_firm = false;
-- FK probe support (see migration 0130): messages had no law_firm_id index, so
-- deleting a firm scanned the whole table.
create index if not exists messages_firm_idx
  on messages (law_firm_id);
create index if not exists messages_deleted_by_idx
  on messages (deleted_by) where deleted_by is not null;

-- ── messaging RLS (migration 0025): Realtime reads via a Firebase-uid JWT ──
-- Backend writes as `postgres` (bypasses RLS); the Realtime client connects as
-- `authenticated` (sub = firebase uid) and only sees its own rows.
create or replace function public.rls_is_firm_member(p_firm uuid, p_uid text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from members m where m.law_firm_id = p_firm and m.user_id = p_uid)
$$;
revoke all on function public.rls_is_firm_member(uuid, text) from public;
grant execute on function public.rls_is_firm_member(uuid, text) to authenticated;

create or replace function public.rls_is_conversation_client(p_conversation uuid, p_uid text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from conversations c
     where c.id = p_conversation and c.client_id = p_uid
  )
$$;
revoke all on function public.rls_is_conversation_client(uuid, text) from public;
grant execute on function public.rls_is_conversation_client(uuid, text) to authenticated;

-- Group conversations are visible only to their participants (migration 0103);
-- direct threads keep firm-wide + client-owner visibility.
create or replace function public.rls_is_conversation_participant(p_conversation uuid, p_uid text)
returns boolean language sql security definer stable set search_path = public, pg_catalog as $$
  select exists (
    select 1 from conversation_participants cp
     where cp.conversation_id = p_conversation
       and cp.participant_user_id = p_uid
       and cp.removed_at is null
  )
$$;
revoke all on function public.rls_is_conversation_participant(uuid, text) from public;
grant execute on function public.rls_is_conversation_participant(uuid, text) to authenticated;

alter table conversations enable row level security;
drop policy if exists conversations_realtime_select on conversations;
create policy conversations_realtime_select on conversations for select using (
  case when conversation_type = 'group'
    then public.rls_is_conversation_participant(id, auth.jwt() ->> 'sub')
    else ((auth.jwt() ->> 'sub') = client_id
          or public.rls_is_firm_member(law_firm_id, auth.jwt() ->> 'sub'))
  end
);

-- consolidated messages access helper (migration 0072): folds the client-
-- participant and firm-member checks into one SECURITY DEFINER call so the
-- messages policy is a single cheap function call instead of a per-row
-- correlated subquery. Returns true when the uid is the conversation's client
-- OR a member of the conversation's firm. search_path is pinned to block the
-- classic SECURITY DEFINER search_path hijack.
create or replace function public.messaging_can_access_conversation(p_conversation uuid, p_uid text)
returns boolean language sql security definer stable set search_path = public, pg_catalog as $$
  select exists (
    select 1 from conversations c
     where c.id = p_conversation
       and (
         case when c.conversation_type = 'group'
           then exists (select 1 from conversation_participants cp
                         where cp.conversation_id = c.id
                           and cp.participant_user_id = p_uid
                           and cp.removed_at is null)
           else (c.client_id = p_uid
                 or exists (select 1 from members m where m.law_firm_id = c.law_firm_id and m.user_id = p_uid))
         end
       )
  )
$$;
revoke all on function public.messaging_can_access_conversation(uuid, text) from public;
grant execute on function public.messaging_can_access_conversation(uuid, text) to authenticated;

-- Realtime MESSAGE-row access (migrations 0105 and 0040). Firm members only.
-- A raw messages row is unmasked: it carries the plaintext sender_name and
-- sender_user_id of a "send as firm" message, a co-client's real name in a
-- group, and the retained content of a soft-deleted message in an UPDATE
-- payload. So no client may stream message rows, in a group or a direct
-- thread. Clients get live updates by watching their conversations row (and
-- the content-free group broadcast) and refetching through the masked REST
-- reads. A group still needs the member to be an active participant.
create or replace function public.messaging_realtime_message_access(p_conversation uuid, p_uid text)
returns boolean language sql security definer stable set search_path = public, pg_catalog as $$
  select exists (
    select 1 from conversations c
     where c.id = p_conversation
       and exists (select 1 from members m
                    where m.law_firm_id = c.law_firm_id and m.user_id = p_uid)
       and (c.conversation_type <> 'group'
            or exists (select 1 from conversation_participants cp
                        where cp.conversation_id = c.id
                          and cp.participant_user_id = p_uid
                          and cp.removed_at is null))
  )
$$;
revoke all on function public.messaging_realtime_message_access(uuid, text) from public;
grant execute on function public.messaging_realtime_message_access(uuid, text) to authenticated;

alter table messages enable row level security;
drop policy if exists messages_realtime_select on messages;
create policy messages_realtime_select on messages for select using (
  public.messaging_realtime_message_access(messages.conversation_id, auth.jwt() ->> 'sub')
);

-- Participant rows (migration 0040): a firm member with access to the thread
-- sees the whole roster; anyone else (a client) sees only their own row, so a
-- client cannot read lawyers' last_read_at, co-clients' history_visible_from,
-- or a pending recipient's client_id. Clients read the masked roster over REST.
alter table conversation_participants enable row level security;
drop policy if exists conversation_participants_select on conversation_participants;
create policy conversation_participants_select on conversation_participants for select using (
  public.messaging_can_access_conversation(conversation_id, auth.jwt() ->> 'sub')
  and (participant_user_id = (auth.jwt() ->> 'sub')
       or public.rls_is_firm_member(law_firm_id, auth.jwt() ->> 'sub'))
);

grant usage on schema public to authenticated;
grant select on conversations to authenticated;
grant select on messages to authenticated;
grant select on conversation_participants to authenticated;
do $$
begin
  begin execute 'alter publication supabase_realtime add table conversations'; exception when others then null; end;
  begin execute 'alter publication supabase_realtime add table messages'; exception when others then null; end;
  begin execute 'alter publication supabase_realtime add table conversation_participants'; exception when others then null; end;
end $$;

-- =====================================================================
-- ATTACHMENTS (polymorphic attachment ledger from migration 0236)
-- =====================================================================

create table if not exists attachments (
  id                        uuid primary key default gen_random_uuid(),
  law_firm_id               uuid not null references law_firms(id) on delete cascade,
  file_id                   uuid not null references files(id) on delete cascade,
  note_id                   uuid,
  note_reply_id             uuid,
  message_id                uuid references messages(id) on delete cascade,
  task_id                   uuid,
  event_id                  uuid,
  activity_id               uuid,
  document_request_item_id  uuid,
  -- Who attached the file. For a document request this is what separates a
  -- client's own upload from one a firm member attached on their behalf, which
  -- the portal delete path asks before it lets a client remove a row.
  created_by                text references users(id) on delete restrict,
  -- Position within the parent record, 0-based. `created_at` cannot serve: it
  -- defaults to now(), the TRANSACTION timestamp, so every row one save writes
  -- carries the same value. Only the three arcs that replaced an ordered jsonb
  -- array in migration 0260 write it; it is null everywhere else.
  sort_order                int,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (law_firm_id, id),
  foreign key (law_firm_id, file_id) references files(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, note_id) references notes(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, note_reply_id) references note_replies(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, task_id) references tasks(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, event_id) references events(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, activity_id) references activities(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, document_request_item_id) references document_request_items(law_firm_id, id) on delete cascade,
  check (num_nonnulls(note_id, note_reply_id, message_id, task_id, event_id, activity_id, document_request_item_id) = 1)
);

drop trigger if exists set_updated_at on attachments;
create trigger set_updated_at before update on attachments
  for each row execute function set_updated_at();

comment on column attachments.sort_order is 'Position within the parent record, 0-based. Written by the note, note reply and task arcs, which replaced an ordered jsonb array in migration 0260; null on every other arc, which orders by its own key.';

create index if not exists attachments_file_id_idx on attachments (file_id);
create index if not exists attachments_created_by_idx on attachments (created_by) where created_by is not null;
create index if not exists attachments_firm_file_idx on attachments (law_firm_id, file_id);
create index if not exists attachments_firm_note_idx on attachments (law_firm_id, note_id) where note_id is not null;
create index if not exists attachments_firm_note_reply_idx on attachments (law_firm_id, note_reply_id) where note_reply_id is not null;
create index if not exists attachments_message_idx on attachments (message_id) where message_id is not null;
create index if not exists attachments_firm_task_idx on attachments (law_firm_id, task_id) where task_id is not null;
create index if not exists attachments_firm_event_idx on attachments (law_firm_id, event_id) where event_id is not null;
create index if not exists attachments_firm_activity_idx on attachments (law_firm_id, activity_id) where activity_id is not null;
create index if not exists attachments_firm_doc_req_item_idx on attachments (law_firm_id, document_request_item_id) where document_request_item_id is not null;


-- =====================================================================
-- RLS for messaging (policies added in the Realtime phase)
-- =====================================================================
alter table conversations enable row level security;
alter table messages      enable row level security;

-- Column comments. These were written by earlier migrations and never carried
-- into the domain files, so a database built from schema.sql lacked them while
-- a migrated one had them. They are the reference for what each column means.
comment on column conversations.client_record_id is 'The clients.id this group conversation is the canonical company thread for. Null for direct (person) conversations and for ordinary group threads with no company binding.';
