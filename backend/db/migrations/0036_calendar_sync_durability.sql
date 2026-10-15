-- migration-mode: expand
-- Precondition: calendar_sync_failures.kind accepts only 'webhook' and 'stop_channel';
--   calendar_mappings records no version of the event Paralegix last pushed; imported
--   calendar_events are looked up by provider id within a firm only.
-- Postcondition: calendar_sync_failures.kind also accepts 'notification' (an inbound push
--   persisted before it is processed) and 'outbound' (a provider write that failed
--   transiently and is replayed by the calendar-watch cron); calendar_mappings carries
--   pushed_version / pushed_modified_at, the version the provider reported for this
--   member's copy after Paralegix last wrote it; calendar_events has an owner-scoped
--   index for the per-member Google id lookup. No existing row is rewritten.

alter table calendar_sync_failures drop constraint if exists calendar_sync_failures_kind_check;
alter table calendar_sync_failures add constraint calendar_sync_failures_kind_check
  check (kind in ('webhook', 'stop_channel', 'notification', 'outbound'));

alter table calendar_mappings add column if not exists pushed_version text;
alter table calendar_mappings add column if not exists pushed_modified_at timestamptz;

create index if not exists calendar_events_owner_google_idx
  on calendar_events (law_firm_id, created_by, google_event_id) where google_event_id is not null;
