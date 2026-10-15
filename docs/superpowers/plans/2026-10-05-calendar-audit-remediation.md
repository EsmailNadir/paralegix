# Calendar audit remediation

All items below were authorized on 2026-10-05. Work stays uncommitted, with no browser verification or staging deployment.

## Approved product behavior

- Private calendar copies go to event assignees rather than the matter roster. Sync never invites clients.
- Imported events store organizer, attendees, RSVP, join links, provider links and privacy. Guests use read-only details; organizer edits require notification confirmation.
- Client sharing defaults off and uses a separate optional portal description, never internal notes.
- Keep a dedicated Paralegix calendar; disconnect offers removal of Paralegix copies. Completing a task removes its provider entries.

## Implementation checklist

- [x] Isolate colleagues' imported Google meetings by owner.
- [x] Persist verified webhook work before acknowledging delivery; commit Google cursors only after processing succeeds.
- [x] Renew channels before retiring old ones; recover expired cursors safely and handle page limits without data loss.
- [x] Replace time-based echo suppression so genuine edits after a push are imported.
- [x] Propagate inbound edits to colleagues; retry rate limits and outbound failures; preserve edits waiting for locks.
- [x] Keep cancellations cancelled; fan out client events consistently; reconcile moved tasks and revoked access.
- [x] Finish calendar switching, avoid rewriting whole-calendar time zones, catch up on reconnect and identify dedicated calendars by stored identity.
- [x] Exclude cancelled, completed and past items from sync-existing.
- [x] Enforce imported meeting edit rights, surface provider failures, preserve Teams bodies and suppress Google guest email unless confirmed.
- [x] Convert Google HTML descriptions in every inbound builder; round-trip locations and event zones.
- [x] Include spanning events in views and preserve New Zealand all-day dates.
- [x] Page reminder reads; remove recurrence truncation, validate blank ends and preserve wall times across daylight saving.
- [x] Secure client portal events and descriptions; honor reminder email settings/formatting; stop overdue mail for past events.
- [x] Enforce owner rights on walled matters; return cancellation details; correct deadline weekend rules and timed tasks near midnight.
- [x] Correct all-day and multi-day display in portal, dashboard and popup.
- [x] Linkify shared event tabs and portal; show court names and event zone labels. A matter event reads its matter's court at request time and shows it as its own Court field on proceedings and court deadlines, never in place of the location; times show the viewer's zone plus the event's own local time and city.
- [x] Refresh after sync/delete; support series deletion; scroll to now; pause hidden-tab sync; reject blank recurrence ends.
- [x] Add imported meeting metadata and UI, privacy, RSVP and organizer confirmation.
- [x] Add disconnect removal option and completed-task takedown.
- [x] Resolve the existing client-summary discrepancy with a failing regression.
- [x] Run related tests, package lint/typecheck/build and schema parity; update durable feature documentation.

## Verification carried forward

Before starting this remediation, 493 related backend tests and 209 related frontend tests passed, as did backend typecheck/lint/build and frontend ci:checks/build. Frontend lint reported 58 warnings and no errors. This is a baseline, not completion evidence for the changes above.

## Completion evidence (2026-10-05)

Backend typecheck, lint, build and catalog parity pass. 93 related backend suites (calendar, matter and client events, deadline sets, reminders, clients, billing analytics/aggregation, lazy cloud init, invoice status, schema) pass on test slot 5: 1259 tests. Frontend `ci:checks` passes with 0 errors and 58 warnings; `test:unit` passed 6724 of 6725, the one failure being `AdminSearchRace`, untouched here and green three times in isolation. `invitationAcceptRace` and the `firmFlatFees` connection-count test fail on a clean HEAD checkout as well and are outside this plan.

## Follow-up review (2026-10-05)

The follow-up reviewed the tracked changes and new files across OAuth, sync durability, tenant access, court and zone display, event editing, accessibility, test infrastructure and migrations. It fixed additional gaps:

- Source meeting edits no longer create ownership mappings that disconnect cleanup could delete.
- Both linked providers are queued before dispatch; retried external deletion clears provider ids and removes the local event.
- Ownership reads and inbound queue failures remain retryable. Replaying a committed inbound edit queues its saved state, and sibling updates/deletions use durable work.
- Dispatch checks saved assignments so stale creates cannot recreate removed assignee copies.
- Matching a matter's court in the client tab preserves the event's venue.
- Unchanged schedules preserve the event's source zone; postponement records the zone of the new date.
- Connection lifecycle leases order token exchanges and delayed revocation. Connection completion rechecks identity under the refresh lock.

Regression tests failed on the unfixed code before passing. Frontend `npm run ci:checks` passes with 0 errors and 58 warnings; `TZ=America/Los_Angeles npm run test:unit -- --detectOpenHandles` passes 624 suites and 6,765 tests with a clean exit and no reported open handles. Both code packages' builds pass, as do backend `npm run typecheck`, `npm run lint`, `npm run db:catalog-parity` and the internal docs build (`DOCS_INCLUDE_DEV=true npm run build`). Local test database 1 carried an obsolete constraint accepting unused `notification` work; applying migration 0036 aligned it with the verified schema before the final backend tests.

The final backend command selected all 41 changed `.test.ts` files from `git diff --name-only HEAD` plus untracked files, then ran `npx jest --runInBand --silent <those files> tests/schema`: 55 suites and 900 tests passed. The full backend suite was not run. All changes remain uncommitted.
