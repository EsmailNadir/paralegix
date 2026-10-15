-- migration-mode: expand
-- Precondition: tasks has no ends_at column.
-- Postcondition: tasks.ends_at is a nullable timestamptz that, when set, comes
-- after the task's start: its due_at when timed, else its due day's noon-UTC
-- anchor. An all-day task's end is the exclusive day after its last day,
-- anchored at noon UTC, the same shape events.ends_at uses.
-- Nullable with no default, so currently deployed code is unaffected.
alter table tasks add column if not exists ends_at timestamptz;

alter table tasks add constraint tasks_ends_after_start check (
  ends_at is null
  or (
    due_date is not null
    and ends_at > coalesce(due_at, (due_date + time '12:00') at time zone 'UTC')
  )
);
