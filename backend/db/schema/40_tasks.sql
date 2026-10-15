-- =====================================================================
-- TASKS (+ junctions, notes)
-- =====================================================================

create table if not exists tasks (
  id                  uuid not null default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  title               text not null,
  description         text,
  location            text,
  status              text not null default 'open'
    check (status in ('open', 'in_progress', 'completed', 'blocked')),
  priority            text not null default 'medium',   -- app-managed vocabulary
  due_date            date,
  due_date_timezone   text,
  due_at              timestamptz,                       -- time-precision companion for calendar sync (migration 0021)
  -- Optional end (migration 0039). Timed: an instant after due_at. All-day:
  -- the exclusive day after the last day, at noon UTC, as events.ends_at.
  ends_at             timestamptz,
  all_day             boolean not null default false,    -- all-day vs timed, captured from provider sync (migration 0099)
  source              text,
  matter_id             uuid,
  practice_area_id    uuid,
  court_id            uuid,
  -- calendar sync state (migration 0021): per-user provider event-id map + sync/modified stamps
  calendar_sync          jsonb,
  google_event_id        text,
  outlook_id             text,
  outlook_change_key     text,
  google_calendar_id     text,
  last_synced_to_google  timestamptz,
  last_synced_to_outlook timestamptz,
  google_last_modified   timestamptz,
  outlook_last_modified  timestamptz,
  recurrence             jsonb,
  reminder_recipient_ids text[] not null default '{}',
  send_reminder_early    boolean not null default false,
  created_by          text references users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  foreign key (law_firm_id, matter_id)          references matters (law_firm_id, id) on delete cascade,
  foreign key (practice_area_id) references practice_areas (id) on delete set null,
  foreign key (court_id)         references courts (id) on delete set null,
  constraint tasks_ends_after_start check (
    ends_at is null
    or (
      due_date is not null
      and ends_at > coalesce(due_at, (due_date + time '12:00') at time zone 'UTC')
    )
  )
);
create index if not exists tasks_firm_matter_idx on tasks (law_firm_id, matter_id);
create index if not exists tasks_firm_status_idx on tasks (law_firm_id, status);
-- FK probe support (see migration 0130): deleting a practice area, court or user.
create index if not exists tasks_practice_area_idx
  on tasks (practice_area_id) where practice_area_id is not null;
create index if not exists tasks_court_idx
  on tasks (court_id) where court_id is not null;
create index if not exists tasks_created_by_idx
  on tasks (created_by) where created_by is not null;
create index if not exists tasks_firm_due_idx on tasks (law_firm_id, due_date);

-- The three task junctions carry law_firm_id and a COMPOSITE foreign key to the
-- task (migration 0208). tasks.repository.ts guards each of these in the service
-- against a cross-firm write, with a comment on each saying the foreign key is
-- not firm-scoped; the composite key is what makes that a guarantee rather than
-- a convention a fourth writer could skip.
create table if not exists task_assignees (
  law_firm_id uuid not null references law_firms(id) on delete cascade,
  task_id uuid not null,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id),
  foreign key (law_firm_id, task_id) references tasks (law_firm_id, id) on delete cascade
);
create index if not exists task_assignees_user_idx on task_assignees (user_id);
-- Serves the composite foreign key's cascade; the primary key does not lead
-- with law_firm_id.
create index if not exists task_assignees_firm_task_idx on task_assignees (law_firm_id, task_id);
-- "My tasks" without scanning `tasks`: the assignee list is the selective side.
create index if not exists task_assignees_firm_user_idx on task_assignees (law_firm_id, user_id);

create table if not exists task_clients (
  law_firm_id uuid not null references law_firms(id) on delete cascade,
  task_id   uuid not null,
  -- Single-column, unlike the composite key the tenancy convention asks for.
  -- It predates the retirement of the SOFT-REFERENCE sweep (migrations 0224
  -- and 0225), which used to drop every key pointing at `clients`.
  client_id uuid not null references clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, client_id),
  foreign key (law_firm_id, task_id) references tasks (law_firm_id, id) on delete cascade
);
create index if not exists task_clients_firm_task_idx on task_clients (law_firm_id, task_id);
-- client-id-keyed cleanup (clients.repository deletes by client_id on client removal)
create index if not exists task_clients_client_idx on task_clients (client_id);

create table if not exists task_dependencies (
  law_firm_id        uuid not null references law_firms(id) on delete cascade,
  task_id            uuid not null,
  -- Both arms are firm-scoped. The second is the one the repository's cycle
  -- guard calls out as global, and the path a cross-tenant edge would take.
  depends_on_task_id uuid not null,
  created_at         timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id),
  foreign key (law_firm_id, task_id) references tasks (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, depends_on_task_id) references tasks (law_firm_id, id) on delete cascade
);
create index if not exists task_dependencies_depends_on_idx on task_dependencies (depends_on_task_id);
create index if not exists task_dependencies_firm_task_idx on task_dependencies (law_firm_id, task_id);
create index if not exists task_dependencies_firm_depends_on_idx on task_dependencies (law_firm_id, depends_on_task_id);

-- Lightweight checklist / subtask items under a task.
create table if not exists task_subtasks (
  id                uuid not null default gen_random_uuid(),
  law_firm_id       uuid not null,
  task_id           uuid not null references tasks(id) on delete cascade,
  title             text not null,
  is_completed      boolean not null default false,
  assignee_user_id  text references users(id) on delete set null,
  sort_order        integer not null default 0,
  created_by        text references users(id) on delete restrict,
  completed_at      timestamptz,
  completed_by      text references users(id) on delete restrict,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id)
);
create index if not exists task_subtasks_task_idx on task_subtasks (task_id, sort_order);
-- Serves the on-delete walk of task_subtasks_assignee_user_id_fkey (migration 0224).
create index if not exists task_subtasks_assignee_user_id_idx on task_subtasks (assignee_user_id);
