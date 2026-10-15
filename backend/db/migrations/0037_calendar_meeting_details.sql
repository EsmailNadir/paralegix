-- migration-mode: expand
-- Precondition: imported events omit meeting details and their source zone;
--   firm events have only internal notes and no persisted event zone.
-- Postcondition: provider details are stored as an external provider snapshot;
--   both event kinds can retain their zone, and firm events have separate
--   optional client-facing copy. Existing sharing defaults remain off.

alter table calendar_events add column if not exists start_time_zone text;
alter table calendar_events add column if not exists provider_details jsonb not null default '{}';
alter table events add column if not exists time_zone text;
alter table events add column if not exists client_description text;
