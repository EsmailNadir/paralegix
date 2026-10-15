---
name: handling-dates-and-times
description: Storing, comparing, computing or displaying a date or time: due dates, reminder eligibility, overdue checks, form defaults, email dates.
user-invocable: false
---

# Handling Dates and Times

## Overview

Two mistakes cause every real date bug found in this codebase: mixing up a `date`-only Postgres
column with a `timestamptz` one, and reading a date back through the wrong time zone — usually an
AMBIENT zone (the server process's OS setting, or UTC-by-convenience) standing in for a value
that should be recipient-specific or explicitly anchored. Both are silent. Neither throws. They
just show or compute the wrong day.

## General principles (this codebase already follows these)

- **Store instants in UTC, display in the viewer's zone.** `timestamptz` columns are always UTC;
  conversion to a human-readable day happens at the read/display boundary, never at rest. This is
  the standard industry default for exactly the reason it avoids: the backend "receiving,
  storing, and responding in UTC" removes an entire class of ambiguity from every other layer.
- **One deliberate deviation from that default, and it's load-bearing.** A stateless REST API can
  get away with pure UTC in, UTC out, and let the browser convert. This app can't fully: cron jobs
  (reminders, digests, late fees) run with no browser and no request, so the BACKEND itself has to
  resolve each recipient's own IANA zone at send time. That's why `shared/utils/time.ts` and
  `localTime.ts` exist as an explicit-zone layer instead of leaving conversion to the frontend
  alone.
- **Store the IANA zone name (`America/New_York`), never a raw UTC offset.** An offset is a
  snapshot; it can't tell Tokyo (UTC+9, no DST) from Seoul (UTC+9, no DST since 1988) apart, and it
  can't predict a future DST transition the way an IANA name's full rule history can. `user_settings.timezone`
  already stores IANA text for this reason — never "fix" it to a numeric offset.
- **A day-only value is a calendar label, not an instant.** `'2026-03-15'` has no time-of-day and
  no time zone to convert. The bug shape in this file is almost always: something ROUND-TRIPPED a
  day-only value through an instant it never needed to be.

## The one question to ask first

Is the value a `date` column (day-only: `due_date`, `invoice_date`, `close_date`,
`statute_of_limitations_date`...) or a `timestamptz` column (a real instant: `created_at`, an
event's `date`, `paid_date`...)?

- **`date` column** — no time-of-day, no time zone. `'2026-03-15'` means March 15th everywhere.
  Never round-trip it through a UTC instant and read the calendar day back off that instant; an
  offset can push it across midnight onto a different day.
- **`timestamptz` column** — a real, unambiguous UTC instant. "Which day" it falls on DOES depend
  on a time zone. Use the recipient's, not whichever zone the process happens to run in.

## Quick reference

| Need | Backend (`shared/utils/`) | Frontend (`lib/utils/dateUtils.ts`) |
|---|---|---|
| Parse a day-only string safely | `toDateOnlyOrNull` (time.ts) | `toLocalDate` |
| Parse local input into a UTC instant | `localInputToUtcDate` (time.ts) | n/a |
| Format an instant for a recipient's zone | `formatForClient` (time.ts) | `formatDate` |
| Format a day-only value for display | — (build on `toDateOnlyOrNull` + explicit UTC) | `formatDateOnly` |
| Get a value's calendar day, zone-aware | `zonedDayString` (time.ts) | n/a |
| "Is this before today" | compare `zonedDayString` values | `isBeforeToday` |
| Today's date, viewer-local | n/a | `todayLocalDate` |
| Cron/reminder recipient local day/hour | `localDateFor` / `localHourFor` (localTime.ts) | n/a |
| "Today" for a person (a default date on something they record) | `personalToday({ timeZone: req.tz, userId })` (personalDay.ts) | `todayLocalDate` |
| "Today" for a firm (webhooks, nightly passes, the firm's books) | `localDateFor(await firmZone(lawFirmId))` (personalDay.ts) | n/a |
| A route that needs the caller's day only for a default | `optionalTimezone` middleware (sets `req.tz`, never rejects) | n/a |
| A day-only value as an instant | `dayAnchor` / `toInstant` (time.ts): noon UTC, never midnight | n/a |
| Instant to/from a zone's wall clock | `zonedWallClock` / `wallClockToUtc` (time.ts) | n/a |
| When a task is due | `taskDueInstant` (tasks/taskDue.ts) | n/a |
| An event's span pushed to Google or Outlook | `timedEnd` / `allDaySpan` (`modules/calendar/shared/calendarTime.ts`; all-day end is EXCLUSIVE); Google's timed body uses `zonedWallClockWithOffset` (time.ts) | n/a |
| Outlook's Windows zone names and date-times | `toGraphTimeZone` / `parseOutlookDateTime` (`modules/calendar/outlook/outlookTime.ts`) | n/a |
| Agenda / relative-day labels | n/a | `formatAgendaWhen`, `formatRelativeDay` |
| Past due beyond a grace period | n/a | `isPastDueBeyond` |
| Shift a day-only string by N days | `addDays` (localTime.ts) | n/a |
| Validate a calendar date is real | `isValidCalendarDateString` / `hasValidCalendarDatePrefix` (`shared/validation/calendarDate.ts`) | n/a |

Full detail: backend `AGENTS.md`'s "Timestamps & Dates" section.

## The backend/frontend asymmetry — easy to get backwards

- **Backend anchors a day-only value in UTC.** `toDateOnlyOrNull('2026-03-15')` keeps the
  literal string. `new Date('2026-03-15')` is UTC midnight, by spec.
- **Frontend anchors a day-only value in LOCAL time.** `toLocalDate` deliberately builds it with
  the 3-arg local constructor (`new Date(year, month-1, day)`), never `new Date('2026-03-15')`.
  Why: the frontend's ambient zone IS the browser — the viewer's own zone — so local-anchoring
  shows the right day. The backend's ambient zone is the SERVER, unrelated to anyone.
- **`dayjs()` on the frontend parses a bare day-only string as LOCAL midnight**, unlike native
  `Date` — confirmed empirically, not assumed. That makes plain `dayjs('2026-03-15')` safe by
  default; it's `new Date('2026-03-15')` specifically that isn't.

Using the backend's instinct on the frontend, or the reverse, produces a date exactly one day
off — visible only in a timezone behind UTC (backend-style mistake on either side) or when a
column carries a time component nobody expected (frontend-style mistake).

## DST

A day-only value has no DST exposure — it is a calendar label, not an instant. Real exposure:

- A cron/reminder job comparing "now" against a recipient's local day or hour. `localDateFor` /
  `localHourFor` already handle this correctly via `Intl.DateTimeFormat`.
- Any "days until X" built on `Date`'s LOCAL getters instead of an explicit zone or UTC anchor —
  exactly what the lint rule below catches, DST or not.
- Remember some of the less obvious "falsehoods" this class of bug runs into: a day is not always
  24 hours (DST makes it 23 or 25), a UTC offset is not always a whole number of quarter-hours,
  and a zone that has never observed DST can start (or a country can abolish it) — never hardcode
  a transition date or a fixed offset for a "future" comparison.

`time.ts`'s `zonedDateTimeToUtcDate` documents the fold/gap policy for the one place a wall-clock
string genuinely resolves across a real transition (see its doc comment).

## Enforcement

`backend/eslint.config.mjs`'s `paralegix/explicit-date-timezone` rule (`src/**/*.ts`) fails the
build on a local `Date` getter (`getFullYear`, `getMonth`, `getDate`, `getHours`, `getMinutes`,
`getDay`) anywhere in `src/`, and on `toLocaleDateString`/`toLocaleTimeString` with no `timeZone`
option.

It will NOT catch using `toTimestampOrNull` where `toDateOnlyOrNull` was needed, or the reverse,
or a frontend `new Date(dayOnlyString)` bypassing `toLocalDate` — those are judgment calls about
which value and which zone, not syntax patterns. That's what this skill is for. The frontend has
no equivalent lint rule: the risky pattern there needs tracing a value back to its source field to
tell a genuine instant from a day-only one, which a syntax-only rule can't do reliably.

## Common mistakes (all found live in this codebase)

- **Wrong helper for the column type.** `syncDueDateToLastInstallment` called `toTimestampOrNull`
  on a payment-plan `dueDate` (a `date` column); a full-ISO input with a negative offset near
  midnight landed one day late.
- **Ignoring an available `tz` parameter.** `firmBilling.service.ts`'s "due soon" bucket had a
  `tz` param, used it for the overdue count one line above, then computed its own boundary with a
  local-getter `startOfDay` that ignored `tz` entirely.
- **Formatting with no zone in a backend email.** `stripe.service.ts`'s payment-request email
  formatted a due date with `toLocaleDateString('en-US')` and no `timeZone` — correct only by
  luck of whichever zone the server happens to run in.
- **A dead-but-loaded fallback branch, frontend.** `EditTaskModal.tsx` had its own hand-rolled
  reimplementation of a due-date derivation the codebase already had a correct, shared version of
  (`deriveDueDateInput`) — with LOCAL getters instead of that version's UTC ones. Unreachable
  under the current API contract, reachable the moment that contract's assumptions change. Prefer
  delegating to the one correct implementation over re-deriving it.
- **UTC-today standing in for local-today, frontend.** `InvoiceDetailView.tsx` gated a button on
  `new Date().toISOString().slice(0, 10)` (UTC today) instead of the viewer's actual today, and
  six form defaults across the client/trust screens did the same — one of them (`ClientDetail.tsx`'s
  payment recorder) with no user-editable field to catch the wrong date before it reached the API.

## Further reading

- [Falsehoods programmers believe about time zones](https://www.zainrizvi.io/blog/falsehoods-programmers-believe-about-time-zones/)
- [Why IANA time zones, not offsets](https://medium.com/@rongalinaidu/why-we-should-use-iana-time-zones-not-just-offsets-b3e19d005cc7)

## Two guards enforce this, one per package

- **Backend**: the `paralegix/explicit-date-timezone` ESLint rule (local getters AND local setters such as `setHours`).
- **Frontend**: `frontend/scripts/check-date-helpers.mjs`, run by `npm run ci:checks`. It forbids
  inline date comparison and day-only parsing, so every one goes through `lib/utils/dateUtils.ts`.
  The frontend cannot reuse the backend rule, because the risky pattern here depends on the value.
