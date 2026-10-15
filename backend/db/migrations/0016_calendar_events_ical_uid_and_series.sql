-- migration-mode: expand
--
-- Two provider identifiers on imported calendar events.
--
-- Pre-condition: `calendar_events` has no `ical_uid` or `series_event_id`.
-- A meeting invitation sent to both of a member's calendars (Google and
-- Outlook) is imported once from each, and each copy is then pushed to the
-- other calendar, so it shows twice everywhere. An Outlook series deleted
-- in the provider leaves its imported occurrences until the next full poll,
-- because an Outlook occurrence id does not name its series.
--
-- Post-condition: both columns exist, nullable, with no default.
--   `ical_uid`        the invitation's iCalendar UID (Google `iCalUID`,
--                     Outlook `iCalUId`), the same on both providers, so an
--                     incoming event can be matched to the import that
--                     already holds the other provider's copy.
--   `series_event_id` the provider id of the repeating event this row is an
--                     occurrence of (Google `recurringEventId`, Outlook
--                     `seriesMasterId`), so a deleted or edited series finds
--                     its occurrences.
-- Each gets a partial index matching the lookup the sync engine makes: one
-- member's imports in one firm, by that value.
--
-- Expand only: existing rows keep null, which every reader treats as "not
-- known", and the currently deployed code never reads or writes either column.

alter table calendar_events add column if not exists ical_uid text;
alter table calendar_events add column if not exists series_event_id text;

create index if not exists calendar_events_ical_uid_idx
  on calendar_events (law_firm_id, created_by, ical_uid) where ical_uid is not null;
create index if not exists calendar_events_series_idx
  on calendar_events (law_firm_id, created_by, series_event_id) where series_event_id is not null;
