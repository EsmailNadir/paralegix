# Matters

## Summary

Matters are the central work unit in Paralegix: a legal matter that aggregates members (firm users), clients, notes, events/deadlines, related contacts, a configurable stage pipeline, per-firm custom fields, an activity feed, and (by reference) tasks, time entries, and invoices. The backend module lives in `backend/src/modules/matters/` and exposes RESTful routes under `/api/lawfirms/:lawFirmId/matters`. The data was migrated off Firestore to Postgres: the old denormalized matter document (embedded `members[]`, `clientNames[]`, name copies) is now reconstructed at read time from junction tables (`matter_members`, `matter_clients`) via JOIN-heavy projections, while writes persist normalized rows. Every query is tenant-scoped by `law_firm_id`, and every route is gated by a firm-level RBAC permission plus, on detail and mutation paths, a service-level matter access check (owners and firm admins may read and edit any matter record; the work product on it stays with the matter's members).

This doc reflects the codebase after the Drizzle cut-over and the schema consolidation (`backend/db/schema/*.sql`, generated into `schema.sql`): create is one transaction covering the matter row, its members and its clients; the practice-area updates (bulk, single, and a practice area changed through Edit Matter) copy the area onto the matter's tasks in the same transaction, while a status change never touches a task (task status is its own vocabulary); delete is refused for a matter under legal hold or carrying trust or billing history; owners and firm admins can read and edit any matter record, while notes, events, files and tasks stay behind strict matter membership; stages belong to named pipelines; a legal hold is a row in `legal_holds`; conflict checks are recorded as evidence; and matter notes live in the shared `notes` table.

## Key Takeaways

- The matter entity is denormalized **on read** via lateral-JOIN projections (`matters.repository.ts:130` `MATTER_SELECT` for detail, `LIST_MATTER_COLUMNS` + `LIST_MATTER_JOINS` at `:233`/`:255` for lists); nothing denormalized is stored, so member/client/lead/stage names never go stale.
- Authorization is layered: `requirePermission('matters.*')` on every route, then a service-level matter check. **Reading or editing the matter record** uses `assertMatterReadAccess` / `assertMatterWriteAccess` (`shared/utils/membership.ts:132,152`): owners and firm admins pass on any matter in the firm, everyone else must be a member. **Work product on the matter** (notes, events, files, tasks, delete, deadline-set apply) stays on strict `assertMatterMembership` (`membership.ts:60`), with one exception: the firm owner may write events on a matter they are walled off from (`assertEventWriteAccess`, `matterEvents.service.ts`). The matter **lead** is an accountability label, not an access gate. Staffing needs `matters.manageMembers`; linking clients needs `matters.manageClients`.
- Route mounting order matters: `mattersModuleRoutes` is mounted **last** in the array at `app.ts:856` so the sibling routers (categories, notes, members, clients, contacts) resolve their paths before `matters.routes.ts`'s `/:matterId` wildcard.
- The list path is lighter: the list projection drops the per-member time grouped scan (list members always report `totalHours: 0`), and `listMattersPaged` (`matters.repository.ts:1010`) counts and pages over bare `matters` in a CTE before the lateral enrichment runs, so only the page's rows are enriched.
- **Create is one transaction.** `createMatterWithMembersTx` (`matters.repository.ts:744`) writes the matter row, every lead plus the creator as members, and the find-or-create + link of clients together, with a locked re-check of the `maxMatters` plan limit inside the transaction (`matters.service.ts:415-418`).
- **Transactions with task propagation:** `updateMatterAndTasksTx` (`matters.repository.ts:916`) wraps a matter-row update and its task propagation in one transaction. Used by both bulk ops (`matters.service.ts:865,920`) and the single-matter `updatePracticeArea` (`:945`).
- **Invalid court and practice-area ids are a 400 on every write.** Create and update both refuse an id that is not one of the firm's rows (`Invalid courtId / practiceAreaId for this law firm`) instead of silently storing null; tasks always did. Pinned for matters and tasks together in `tests/crosscutting/referenceIdParity.test.ts`.
- **Removing a member from a matter takes their work with them.** `POST /:matterId/members/remove` runs the membership delete and `pruneMemberAssignments` (`members/memberAssignments.ts`) in one transaction: the removed user's task assignees, task reminder recipients and event assignees on that matter are dropped, or with an optional `reassignTo` (who must stay on the matter) moved to that member. `POST /:matterId/members/remove/preview` reports per user the open tasks, upcoming events and reminder slots the removal would touch, writing nothing. The firm-level removal handler (`matters.events.ts`) runs the same steps with no matter scope.
- **Select-all matches the list.** `GET /ids` widens a person `clientId` across the organizations they belong to, exactly as the list does.
- **Delete is guarded, bulk delete is per item.** `assertMatterIsDeletable` (`matters.service.ts:720`) refuses a matter under legal hold, with trust ledger entries, or with billing records, on both the single and bulk paths; a `before delete` trigger on `matters` backs up the hold rule (`db/schema/90_platform.sql:260-262`). `bulkDelete` runs each item in its own `deleteMatterTx` (`matters.repository.ts:903`); partial success is by design.
- Conflict-of-interest checks: `POST /matters/conflict-check` → `findConflicts` (`matters.repository.ts:2270`) searches firm clients (including people linked to a company through `client_company_links`) and the contacts directory by name/email/organization. Creating a matter, and `POST /:matterId/conflict-checks/run`, persist the result in `conflict_check_records` as evidence.
- Matter lifecycle is event-driven: `MATTER_CREATED`/`MATTER_UPDATED`/`MATTER_DELETED`/`MATTER_MEMBERS_UPDATED`/`MATTER_CLIENTS_UPDATED` fan out to billing plans, calendar, tasks, files, and clients modules.
- **Stages are a tree inside a named pipeline.** A firm defines `matter_stage_pipelines` (optionally per practice area, one default per scope); `matter_stages.pipeline_id` + `parent_stage_id` make each pipeline a tree, so terminal outcomes render as parallel endings. A matter points at a pipeline (`stage_pipeline_id`) and a stage (`stage_id`), and a stage must belong to the matter's pipeline (`matters.service.ts:123-125`). Viewing needs `matters.view`, editing pipelines needs `settings.manageFirm`.
- **Custom fields are defined per firm and validated per write.** Definitions live in `matter_field_defs` (typed, optionally practice-area-scoped, archived not deleted); values live in `matters.custom_fields` jsonb keyed by definition id, and `validateCustomFields` (`matters.service.ts:50`) drops unknown/archived keys and type-checks the rest.
- **Billing preferences and key dates are first-class columns**, not jsonb: billing method / budget / contingency and `open_date`/`close_date`/`statute_of_limitations_date`. Legal hold is not a column: it is a row in `legal_holds`, surfaced on the matter by a join.
- **The activity feed never fails a request.** `recordActivity` swallows its own errors (`activity/matterActivity.service.ts:24`); the feed records work, it isn't part of it.

---

## How It Works

### Transaction boundaries

Category create, move, rename and delete serialize on the firm row. Ancestor and sibling checks run on the same executor as their writes, including duplicate names on moves and missing or foreign parents. Moving or renaming a category recursively rewrites paths and levels for its entire descendant tree, and updates the firm's matters that reference those paths, in that transaction.

Event creation and editing commit their row, assignee junctions and attendee junctions together. Create, edit and delete serialize on the matter row so dependency validation and graph writes cannot race. Event and recurrence-group deletion remove deleted ids from dependent JSON arrays with scoped SQL updates, then delete the events in the same transaction. Cleanup preserves every other dependency. Creating a task from a note writes the task, its junctions and the note backlink in the task-creation transaction; task and link events follow commit.

Every occurrence in a recurring event series receives the selected assignees and attendees before commit. Cancellation and postponement also lock the matter and reread the event, so overlapping postponements preserve the complete history and a second cancellation sees the first cancellation.


### Entry Points

#### Frontend pages & hooks

| Path | File | Purpose |
|---|---|---|
| `/lawfirm/[lawFirmId]/matters` | `frontend/src/app/lawfirm/[lawFirmId]/matters/page.tsx` | Matters list: `RequirePermission permission="matters.view"` |
| `/lawfirm/[lawFirmId]/matters/[matterId]` | `frontend/src/app/lawfirm/[lawFirmId]/matters/[matterId]/page.tsx` | Matter detail (`loadMatter`, `:338`). Tabs (`MATTER_TABS`, `:61-73`): overview, tasks, events, clients, contacts, messages, team, notes, time-tracking, billing, documents |
| list hook | `frontend/src/hooks/matterHooks/useMattersTable.ts` | Server-paginated: `useServerTable` + `usePagedMatters` (`matterHooks/useMatters.ts:99`) → `MattersService.getMattersPaged`. |
| API client | `frontend/src/services/matters.service.ts` | one class: matter, matter-client, member, category, lookup, conflict-check and legal-hold calls |

#### Backend routes (`backend/src/modules/matters/matters.routes.ts`)

All require `verifyToken` + `requirePermission(...)`. Mounted at `app.ts:856`.

| Method | Path | Permission | Handler | Line | Timezone? |
|---|---|---|---|---|---|
| GET | `/` | `matters.view` | `listLawFirmMatters` (filters, search, sort, optional paging) | `:37` | yes |
| GET | `/ids` | `matters.view` | `listMatterIds` (every id behind the filters, capped at 5000, for "select all") | `:65` | no |
| GET | `/lookup` | `matters.view` | `lookupMatters` (typeahead, `{ items, hasMore }`) | `:88` | no |
| POST | `/` | `matters.create` | `createMatter` | `:105` | yes |
| POST | `/bulk-delete` | `matters.delete` | `bulkDelete` | `:119` | no |
| POST | `/bulk-update-status` | `matters.update` | `bulkUpdateStatus` | `:132` | no |
| POST | `/bulk-update-practice-area` | `matters.update` | `bulkUpdatePracticeArea` | `:146` | no |
| POST | `/conflict-check` | `matters.view` | `checkConflicts` (read-only) | `:160` | no |
| GET | `/events` | `matters.view` | `listAllMatterEvents` (calendar, `from`/`to` range) | `:175` | yes |
| GET | `/:matterId` | `matters.view` | `getMatter` | `:191` | yes |
| PUT | `/:matterId` | `matters.update` | `updateMatter` | `:204` | yes |
| DELETE | `/:matterId` | `matters.delete` | `deleteMatter` | `:220` | no |
| PATCH | `/:matterId/legal-hold` | `matters.update` | `setLegalHold` | `:232` | yes |
| POST | `/:matterId/update-practice-area` | `matters.update` | `updatePracticeArea` | `:249` | no |
| GET | `/:matterId/activity` | `matters.view` | `listActivity` (`limit` ≤ 200, `offset`, repeatable `type`) | `:263` | no |
| GET | `/:matterId/conflict-checks` | `matters.view` | `listConflictChecks` (recorded checks) | `:287` | no |
| POST | `/:matterId/conflict-checks/run` | `matters.update` | `rerunConflictCheck` | `:298` | no |
| GET | `/:matterId/events/graph` | `matters.view` | `listMatterEventGraph` (dependency graph) | `:313` | yes |
| GET/POST | `/:matterId/events` | `matters.view` / `matters.update` | list / create matter event | `:326`, `:344` | yes |
| POST | `/:matterId/deadline-sets/:templateId/apply` | `matters.update` | `applyDeadlineSet` | `:369` | yes |
| DELETE | `/:matterId/events/recurrence/:groupId` | `matters.update` | `deleteRecurrenceGroup` | `:385` | no |
| POST | `/:matterId/events/:eventId/cancel` / `/postpone` | `matters.update` | cancel / postpone an event | `:397`, `:413` | yes |
| PUT/DELETE | `/:matterId/events/:eventId` | `matters.update` | update / delete an event | `:430`, `:451` | PUT only |

The name-array client endpoints (`add-client-names` / `remove-client-names`) and the no-op `generate-reference-ids` are gone; clients attach only through the matter-clients sub-API.

**Sibling routers** mounted on the same `/matters` base (`app.ts:856`):
- `matterCategoriesModuleRoutes`: `/categories*` (`categories/matterCategories.routes.ts`)
- `matterNotesModuleRoutes`: `/:matterId/notes*`, built by the shared notes router (see [Notes](#notes))
- `matterMembersModuleRoutes`: `/bulk-add-member/preview`, `/bulk-add-member`, `/:matterId/members`, `/members/remove/preview`, `/members/remove`, `/members/hourly-rate`, all `matters.manageMembers` (`members/matterMembers.routes.ts:22-106`)
- `matterClientsModuleRoutes`: `/clients` (the batched read across several matters) and `/:matterId/clients*`; both `GET`s need `matters.view`, add / remove / `billing-portions` need `matters.manageClients`; editing the client's own fields also needs `clients.manage`, because it writes the shared client record (`clients/matterClients.routes.ts:24-103`)
- `matterContactsModuleRoutes`: `/:matterId/contacts*` (see [Related Contacts](#related-contacts))

Firm-level matter configuration mounts separately: `/notes` (firm-wide notes list, `app.ts:857`), `/matter-field-defs` (`:858`), `/matter-stages` (`:859`), `/matter-stage-pipelines` (`:860`), `/deadline-sets` (`:861`), all under `/api/lawfirms/:lawFirmId`.

### Data Flow: `GET /api/lawfirms/:lawFirmId/matters/:matterId` (view one matter, end-to-end)

1. **UI**: `loadMatter()` (`[matterId]/page.tsx:338`) runs `Promise.allSettled([getMatterById, ...])` for the matter, its tasks and its clients in one wave (`:351-352`). The matter read is critical; task/client rejections degrade gracefully.
2. **Service (FE)**: `getMatterById` (`frontend/src/services/matters.service.ts:307`) GETs `.../matters/{matterId}` with the `X-Timezone` header.
3. **Route**: matches `GET /:matterId` after the string-literal routes (`matters.routes.ts:191`). Chain: `verifyToken` → `requirePermission('matters.view')` → `requireTimezone`.
4. **Service (BE)**: `getMatter` (`matters.service.ts:573`):
   - `assertMatterReadAccess(...)`: owners/firm admins pass after an existence check; everyone else goes through the combined firm+matter membership query.
   - issues `findByIdRaw` + `countMatterNotes` **in parallel** (`:569-572`). Notes no longer travel with the matter: only the count comes back, for the tab badge, and the notes tab reads its own page from the notes list endpoint.
   - throws 404 if `findByIdRaw` returns null.
5. **Repository → Postgres**: `findByIdRaw` (`matters.repository.ts:561`) runs `MATTER_SELECT`: base row + LEFT JOIN `practice_areas` / `courts` / `users` (lead) / `matter_stages` / `matter_stage_pipelines` / the live `legal_holds` row; a LATERAL over `matter_members` → `json_agg` of members with per-member `totalHours` from one grouped scan of `activities where kind = 'time'`; a LATERAL over `matter_clients` JOIN `clients` → `client_names[]` / `client_user_ids[]` / `client_details` / `client_count` (ordered by name so `clientNames[0]` is stable); and two invoice LATERALs for `outstanding_balance_cents` and `billed_total_cents`.
6. **Hydrate**: `hydrate(row)` (`matters.repository.ts:305`) maps snake_case to camelCase and converts cents columns (member `hourlyRate`, `budget`) to dollars.
7. **Time fields**: `withTimeFields` (`matters.service.ts:278`) adds ISO + tz-local display strings.
8. **Response**: `200 { ...matter, totalNotes }`.

### Data Flow: `POST /api/lawfirms/:lawFirmId/matters` (create, abridged)

1. FE `createMatter` POSTs the body with the `X-Timezone` header.
2. Route: `requirePermission('matters.create')` → `requireTimezone` → `validate(createMatterSchema)` (`matters.routes.ts:105-109`).
3. `createMatter` (`matters.service.ts:297`):
   - `enforceCountLimit(lawFirmId, 'maxMatters', …)` as a cheap, unlocked fast-fail.
   - Naming anyone other than the creator as a lead requires `matters.manageMembers` (`:316-318`); supplying clients requires `matters.manageClients` (`:323-325`), so create is not a side door around either permission. Leads default to the creator.
   - Invalid `practiceAreaId` / `courtId` are coerced to `null` (`:330-340`). The pipeline is the explicit `stagePipelineId` or `resolveDefault` (the practice area's default pipeline, else the firm-wide default, `:345-353`).
   - `generateUniqueMatterReferenceId` (`matters.repository.ts:779`) picks a random `CP-XXXXXX` with up to 20 uniqueness checks; the insert retries on a reference-id unique violation (`_insertMatterRow`, `:644`).
   - `buildMatterAttributePatch` (`matters.service.ts:114`) validates stage, billing preferences, key dates and custom fields.
   - `createMatterWithMembersTx` (`matters.repository.ts:744`) writes the matter, member rows (every lead, plus the creator as a plain member) and the find-or-create + link of clients in **one transaction**. Its `beforeInsert` hook locks the firm row and re-runs the `maxMatters` count on the transaction's own connection, so two concurrent creates cannot both take the last slot (`matters.service.ts:415-418`).
   - `recordConflictCheckForMatter` (`:214`, best-effort), then `MATTER_CREATED` (`:428`) and a `matter.created` activity entry (`:430`).
4. Response `201 { message, matterId }`.

### Data Flow: `POST /api/lawfirms/:lawFirmId/matters/bulk-update-status` (transactional bulk, abridged)

1. FE `bulkUpdateStatus` POSTs `{ matterIds, status }`.
2. `bulkUpdateStatus` (`matters.service.ts:918`) runs `runBulk` (`:857`) over de-duped ids; per item: `assertMatterWriteAccess` → `updateMatter(lawFirmId, matterId, { status })`.
3. Only the `matters` row changes. Task status (`open`/`in_progress`/`completed`/`blocked`) is a different vocabulary tracking each task's own progress, so it is never copied from the matter (copying it broke the tasks status CHECK for `closed`). `updateMatterAndTasksTx` still exists for the practice-area operations, where `_applyTaskUpdate` propagates `practiceAreaId` only.
4. Each item then emits `MATTER_UPDATED` (so closing still ends retainer plans) and records a `status.changed` activity entry on a real transition (`matters.service.ts:870-878`).
5. Response `{ message, requested, updated, failed, errors }`. No transaction spans multiple items; partial success is intended.

### Data Flow: `POST /api/lawfirms/:lawFirmId/matters/conflict-check` (read-only)

1. FE `checkConflicts` POSTs `{ names?, emails?, organizations?, excludeClientIds? }`.
2. Route validates with `conflictCheckSchema` (`matters.validation.ts:211`), which `.refine`s that at least one search array is non-empty.
3. `checkConflicts` (`matters.service.ts:1015`): `assertLawFirmMembership`, then `findConflicts`.
4. `findConflicts` (`matters.repository.ts:2270`) normalizes inputs and unions one pass per source: firm `clients` (name, email, the person's own organization, a company client by name, or a person linked to a matching company through `client_company_links`) and directory `contacts` (joined to `matter_contacts`). Each hit is tagged `source` = `matter_client` / `firm_client` / `matter_contact` / `firm_contact` (`:2297-2299`) and emits at most one organization line per party. The `clients` `lower()` expression indexes back the match (`db/schema/20_parties.sql:71-74`).
5. Response `200 { hasConflicts, conflicts }`.

**Recorded checks.** Separately from this read-only lookup, creating a matter and `POST /:matterId/conflict-checks/run` (`matters.service.ts:788`) run the same search against the matter's linked clients, excluding those clients themselves, and store the query and results in `conflict_check_records` (`db/schema/90_platform.sql:176`). `GET /:matterId/conflict-checks` returns them, filtering out self-matches from records written before self-exclusion existed (`withoutLinkedClientSelfMatches`, `matters.service.ts:260`).

### Data Model

Schema: `backend/db/schema/30_matters.sql` (generated into `backend/db/schema.sql`).

#### `matters` (`30_matters.sql:60`)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `law_firm_id` | uuid NOT NULL | FK → `law_firms`, cascade |
| `name` | text NOT NULL | |
| `matter_number` | text | |
| `matter_reference_id` | text NOT NULL | `CP-XXXXXX`, `unique (law_firm_id, matter_reference_id)` |
| `description` | text | |
| `status` | text NOT NULL default `'active'` | DB CHECK over the same 7 values as `VALID_MATTER_STATUSES` (`:67-68`) |
| `payment_ongoing` | boolean NOT NULL default false | manual override; the effective flag also counts an outstanding invoice balance on a terminal-status matter |
| `category` | text | |
| `practice_area_id` | uuid | FK → `practice_areas`, set null (single-column so set-null cannot null the tenant id) |
| `court_id` | uuid | FK → `courts`, set null |
| `lead_user_id` | text | FK → `users(id)`, restrict |
| `custom_fields` | jsonb NOT NULL default `'{}'` | |
| `stage_pipeline_id` / `stage_id` | uuid | added in the deferred block after the stage tables exist; set null |
| billing + key-date columns | | see [Key Dates & Billing Preferences](#key-dates-billing-preferences-legal-hold) |
| `created_by`, `created_at`, `updated_at` | | |

Constraints: PK `(id)`, `unique (law_firm_id, id)` (the target of the composite child FKs). Indexes: `matters_firm_status_idx` (`30_matters.sql:105`), plus `matters_firm_stage_idx`, `matters_firm_sol_idx`, and trigram GIN indexes on `name` / `matter_number` / `description` for search (`95_deferred_fks.sql:49-92`). There is no generated `search` tsvector column.

#### Junctions / children

| Table | Key | FK / cascade |
|---|---|---|
| `matter_members` (`30_matters.sql:107`) | `(matter_id, user_id)` | `(law_firm_id, matter_id)` → matters cascade; `role check in ('lead','member')`; `hourly_rate_cents` |
| `matter_clients` (`:129`) | `(matter_id, client_id)` | composite FKs to matters and clients, cascade; `billing_portion_bp` (0-10000) for split billing |
| `matter_contacts` (`:189`) | `(law_firm_id, id)` | composite FKs to matters and to the `contacts` directory, cascade; `role` CHECK across 11 values |
| `activity_log` (`50_notes.sql:236`) | `(law_firm_id, id)` | one append-only feed table for matter, client and task parents (exactly one set); only the matter arm is written today |
| `legal_holds` (`90_platform.sql:211`) | `id` | one row per hold on a matter, client or file; a released hold is kept |
| `conflict_check_records` (`90_platform.sql:176`) | `id` | evidentiary record of each recorded conflict check |

#### Firm-level matter configuration (not per-matter)

| Table | Key | Notes |
|---|---|---|
| `matter_stage_pipelines` (`30_matters.sql:21`) | `(law_firm_id, id)` | named pipeline; `practice_area_id` null = firm-wide; `is_default` with at most one default per (firm, scope) (`:34-36`) |
| `matter_stages` (`:43`) | `(law_firm_id, id)` | `pipeline_id` (cascade) + `parent_stage_id` self-FK (set null) make each pipeline a tree; `is_closed` marks an ending |
| `matter_field_defs` (`:158`) | `(law_firm_id, id)` | custom-field definitions; `field_type` CHECK across 11 types; `archived` instead of delete |

The `clients` `lower(name|email|organization)` expression indexes used by the conflict check live in `20_parties.sql:71-74`.

### Notes

Note reply notification previews require current parent read access for every recipient, including the original note author and the parent reply author. Historic authors who have lost access receive no preview. This applies to matter, task and client notes.

Matter notes are rows in the shared `notes` table (`db/schema/50_notes.sql:65`), which holds matter, task and client notes with exactly one of `matter_id` / `task_id` / `client_id` set (`notes_one_parent`). Notes are pinned (`pinned_at`/`pinned_by`) and retracted, never hard-deleted (`retracted_at`/`retraction_reason`). Edit history is `note_versions`, threaded discussion is `note_replies`, and `client_visible`, `activity_name`, `activity_description` and `is_billable` are matter-only columns. Firm-configurable note types and templates apply across all three parents.

The routes come from the shared `createNotesRouter` (`backend/src/shared/notes/notesRouter.ts:48`): list, get, versions, create, update, pin, retract, note time entries, and replies. `matterNotes.routes.ts:23-35` configures it with `matters.view` / `matters.update`, and time entries on a matter note answer to `billing.manageTimeEntries`, as does posting a note that carries a `timeEntries` array (the shared notes engine asserts it). Retracting a note needs `matters.update`. Matter-only routes sit on top (`matterNotes.routes.ts:41-112`): create a task from a note (`tasks.create`), link a task or file, remove a link, and send the note to the client as an update (`messaging.send`). A firm-wide notes list is mounted separately at `/api/lawfirms/:lawFirmId/notes` (`notes/firmNotes.routes.ts:15`).

Links are rows in `note_links` (`50_notes.sql:191`): one per connection to a `task_id` or a `file_id`, discriminated by `link_type` with a check that exactly one target is set, optionally made from a reply (`reply_id`), and `created_from_note` separating "created from this note" from "linked to an existing record". `file_id` has no FK on purpose, because `files` is a best-effort mirror of GCS. Only matter notes link today; the table is parent-agnostic.

The frontend is one shared `NotesSection.tsx` parametrized by `parentType`/`parentId`, with `NoteReplies.tsx`, `NoteVersionHistoryModal.tsx`, `NoteLinksRow.tsx` and `NoteLinkTaskModal.tsx` (all in `frontend/src/components/notesComp/`).

**Relationships**: a matter has many members (M:N via `matter_members`, the membership source of truth), many clients (M:N via `matter_clients`), many notes and events; one optional practice area, court, pipeline and stage; and zero or more leads (`matter_members.role = 'lead'`, with `lead_user_id` holding the primary). Tasks, activities (time entries) and invoices reference `matter_id` with `(law_firm_id, matter_id)` composite FKs.

### Key Logic & Rules

- **Tenancy**: every repository query is scoped by `law_firm_id` through the tenant-scoped Drizzle helpers. The backend connects as `postgres` and bypasses RLS, so scoping is the app's responsibility. A malformed `matterId` is answered as 404 before it reaches a uuid column.
- **Authorization layers**:
  1. Firm RBAC via `requirePermission` on every route.
  2. Matter record reads and edits (`getMatter`, `updateMatter`, `setLegalHold`, practice-area and bulk status/practice-area updates, `listConflictChecks`, `listActivity`) use `assertMatterReadAccess` / `assertMatterWriteAccess` (`membership.ts:132,152`): firm owners and admins (the owner flag or the `members.changeRole` permission, `isFirmOwnerOrAdmin`, `membership.ts:226`) pass on any matter in the firm; everyone else must be a matter member.
  3. Work product and destructive actions (`deleteMatter`, `bulkDelete`, `rerunConflictCheck`, notes, events, deadline-set apply) use strict `assertMatterMembership` (event writes let the firm owner through on any matter, `assertEventWriteAccess`) (`membership.ts:60`): one combined firm+matter query, with a slow path on failure that distinguishes "not a firm member", "no such matter" and "not a matter member".
  4. The lead is not an access gate.
- **List visibility**: owners/admins see every matter (`seeAll`); everyone else sees only matters they are a member of, carried into SQL by `listMattersPaged` (`matters.repository.ts:1010`). Filters (`status`, `paymentOngoing`, `practiceAreaId`, `leadUserId`, `clientId`, `category`, `search`) and the sort model apply to the whole visible set before the page is cut. Paging is opt-in: without `limit` the response is `{ matters }`, with it `{ matters, totalItems }`. The sort is mapped through a `SORT_COLUMNS` whitelist (`:944`), never interpolated. A `clientId` filter is widened to every company that client is linked to (`matters.service.ts:481-483`).
- **Status vocabulary**: `VALID_MATTER_STATUSES` (`matters.validation.ts:5`) is `active, pending, on_hold, completed, blocked, closed, archived`, and the DB CHECK (`30_matters.sql:68`) repeats it. `shared/constants/matterStatus.ts` classifies a subset of it (`CLOSED_MATTER_STATUSES`, `TERMINAL_MATTER_STATUSES`) for the dashboard and the payment-ongoing flag.
- **FK validation**: on create, invalid `practiceAreaId`/`courtId` are coerced to `null` (`matters.service.ts:330-340`); on update, an invalid `practiceAreaId` is a 400 (`:629-633`) while an invalid `courtId` is coerced to null (`:642-644`). The bulk and single practice-area updates validate the practice area against the firm first (`:909-914`, `:937-942`), because the single-column FK would accept another firm's id.
- **Reference ID**: `CP-` + 6 random chars, up to 20 uniqueness checks (`matters.repository.ts:723-740`); the insert also retries on a unique violation (`_insertMatterRow`, `:644`).
- **Leads (multiple, decoupled from access)**: stored as `matter_members.role = 'lead'`; `matters.lead_user_id` holds the primary (first) lead. The API accepts `leadUserIds[]` on create and update; an empty array clears all leads. Replacing the lead set on update requires `matters.manageMembers` (`matters.service.ts:660`) and every lead must **already be a member of the matter** (`assertLeadsAreMatterMembers`, `:199`), so `matters.update` cannot grant membership. `syncMatterLeads` (`matters.repository.ts:1529`) promotes the set and demotes prior leads; `reconcileLeadColumn` (`:1440`) re-points `lead_user_id` after a member removal.
- **Clients**: the `/:matterId/clients` sub-API finds-or-creates a backing firm `clients` row and links it via `matter_clients`. `addClient` resolves a `userId` from email via `resolveUserIdByEmail`: a users-table query, falling back to Firebase Auth (`matterClients.service.ts:12-23`). Removing a client only unlinks the junction. `billing-portions` sets each client's `billing_portion_bp` for split billing (`matterClients.service.ts:204`).
- **Clients for several matters at once**: `GET /matters/clients?matterIds=a,b,c` answers `{ clientsByMatterId: { [matterId]: [client, ...] } }` with the same rows, `billingPortionBp` included, that the per-matter route returns (`listClientsForMatters`, `matterClients.service.ts:87`). A page holding a list of matters (the invoice run, which covers every unbilled matter) would otherwise call the per-matter route once per matter and take most of an instance's 12-connection pool by itself. `matterIds` is comma-separated and capped at `MAX_BATCH_MATTER_IDS` (100, `matterClients.validation.ts:24`), enforced by the validation middleware so an over-cap request is a 400 that reads nothing; a caller with more matters pages the read rather than losing ids silently. Access is `assertMatterWriteAccess`'s rule answered for a set instead of one matter: `isFirmOwnerOrAdmin` plus `filterExistingMatterIds` for an owner or firm admin, `getAccessibleMatterIds` for everyone else (`matterClients.service.ts:70`). A matter the caller cannot read is absent from the map rather than an error, since a batch names matters the caller merely holds a list of; a readable matter with no clients is present and empty. The read itself is one statement for every id (`listMatterClientsForMatters`, `matters.repository.ts:1366`), sharing its projection and row shaping with `listMatterClients` so the two cannot drift. `tests/matters/matterClientsBatch.test.ts` pins the access rule, the equality with three single calls, the constant connection cost and the cap.
- **Bulk ops**: `runBulk` (`matters.service.ts:857`) de-dupes ids and runs each item sequentially in its own try/catch. No transaction spans the whole batch.
- **Bulk id cap**: `MAX_BULK_MATTER_IDS` (`matters.validation.ts`) caps `matterIds` at 5000 on `bulk-delete`, `bulk-update-status`, `bulk-update-practice-area` and `bulk-add-member`; over the cap the request is a 400 and nothing is written. `MAX_SELECTABLE_IDS`, the ceiling `GET /ids` applies, is that same constant, so the grid's select-all answer is always exactly what the bulk routes accept.
- **Bulk event fan-out**: the per-item loops collect their event payloads instead of emitting inside the loop, then deliver them through `runWithConcurrency` at `BULK_EVENT_CONCURRENCY` (3) with `eventBus.emitAsync`. `emit` does not await its listeners, so emitting per item left one detached listener chain per matter in flight against a 12-connection instance pool. `emitAsync` settles every listener and `runWithConcurrency` never rejects, so a failing listener still cannot change the route's result. `bulkAddMember` bounds `MATTER_MEMBERS_UPDATED` the same way (`members/matterMembers.service.ts`).
- **Member ops (batched)**: `addMembers` does one multi-row `upsertMembers`; `bulkAddMember` (with a `/preview` dry run) validates, inserts and reads back with one query each. `addMembers` and `removeMembers` enforce an ethical wall (`assertCanManageMatterMembers`, `members/matterMembers.service.ts:40`): the actor must be a member of the matter or a firm owner/admin.
- **Delete**: `assertMatterIsDeletable` (`matters.service.ts:720`) refuses a matter under legal hold (403), with trust transactions (409), or with invoices, time entries or expenses (409); close or archive it instead. Then `deleteMatter` (`:720`) best-effort purges external calendar rows and matter events, snapshots tasks and files, deletes the `matters` row (DB cascades the children), removes the stored file objects inside the request (`removeCascadeObjects`, `:735`), and emits `MATTER_DELETED`.
- **Select all and lookup**: `GET /ids` returns every visible id behind the current filters, capped at `MAX_BULK_MATTER_IDS` (5000) with a `truncated` flag, and reports the cap as `limit` (`matters.service.ts:515-535`). `GET /lookup` is the picker typeahead: same visibility, `limit` ≤ 50, `{ items, hasMore }` from a limit+1 fetch, optional `clientId` restriction and `full` rows (`matters.repository.ts:1109`).

### Matter Stages (branching pipeline)

A **stage** is where a matter sits in its lifecycle, distinct from the coarse `status` badge. Stages are firm configuration, not per-matter data.

**Stages belong to named pipelines.** A firm defines `matter_stage_pipelines` rows, each optionally scoped to a practice area (`practice_area_id` null = firm-wide) and at most one `is_default` per (firm, scope) (`30_matters.sql:21-36`). Every `matter_stages` row belongs to exactly one pipeline (`pipeline_id`, cascade). A matter records its pipeline explicitly in `matters.stage_pipeline_id` and its position in `matters.stage_id` (both `on delete set null`). On create the pipeline is either the one the caller picked or `resolveDefault` (`pipelines/matterStagePipelines.repository.ts:44`): the practice area's default, else the firm-wide default (`matters.service.ts:345-353`). A `stageId` on create or update must belong to the matter's effective pipeline (`:123-125`).

**Stages form a tree, not a list.** `matter_stages.parent_stage_id` is a self-FK, which lets terminal outcomes render as parallel endings: a trunk of `Intake → Discovery → Negotiation` can fork into `Won` / `Lost` / `Settled`, all three children of `Negotiation`. A chain is a tree where every node has one child.

Tree guards (`stages/matterStages.service.ts`):

- **A stage's parent must be in the same pipeline.** `assertValidParent` (`:11`) rejects a stage as its own parent (`:14`), a parent from another pipeline (`:19-20`), and a parent chain that would create a cycle (`:33`).
- **Nothing follows an ending.** Adding a child to a stage with `is_closed = true` throws (`:23`), and marking a stage as an ending fails if it already has children (`:68`).
- **Deleting a stage reparents its children** rather than orphaning them (`deleteWithReparent`, `stages/matterStages.repository.ts:91`, in one transaction).

Creating a pipeline takes the whole tree in one payload: `orderStages` (`pipelines/matterStagePipelines.service.ts:31`) resolves each stage's parent by a client-side id, rejects unknown parents, cycles, disconnected stages and endings with children, and inserts in topological order.

**Routes**: `/api/lawfirms/:lawFirmId/matter-stage-pipelines` (`app.ts:860`): `GET /` (`matters.view`) returns every pipeline with its stages nested (`matterStagePipelines.service.ts:13-28`); `POST` / `PUT /:pipelineId` / `DELETE /:pipelineId` need `settings.manageFirm` (`matterStagePipelines.routes.ts:16-53`). Individual stages are edited at `/api/lawfirms/:lawFirmId/matter-stages` (`app.ts:859`): `POST /`, `PUT /:stageId`, `DELETE /:stageId`, all `settings.manageFirm` (`stages/matterStages.routes.ts:16-43`). There is no stage `GET` or reorder route; stages are read through the pipelines list. An ordinary member can see and advance stages but cannot redefine a pipeline.

**Two surfaces render the same tree:**

| Surface | Component | What it does |
|---|---|---|
| Matter overview | `MatterStageBar.tsx` | Shows the path taken in the matter's pipeline and offers the next step |
| Settings + setup modal | `StagePipelineEditor.tsx` | Shared flowchart editor (tidy-tree layout + SVG connectors) |

The matters list is list-only, as are the leads and tasks lists.

Layout is derived, not stored. `frontend/src/lib/matterStages/stageTree.ts` exports pure `buildForest` (`:27`), `layoutForest` (`:70`), and `topoOrder` (`:92`); the editor and the bar both consume them.

The stage bar loads the firm's pipelines (`useMatterPipelines`) and takes the stages of the pipeline whose id is `matter.stagePipelineId` (`MatterStageBar.tsx:82-93`). It derives **the path taken** by walking `parentStageId` up from the current stage (`:98-106`). **Next options** are the current stage's children; a non-ending stage with no children falls back to its siblings so a flat pipeline still advances, and an ending stage returns none so the bar shows "Completed" (`:194-205`).

Landing on an ending stage does **not** close the matter. It prompts (`:236-244`), and the prompt checks for unbilled work first so closing does not bury it: closing ends retainer plans and drops the matter out of open counts. Moving off an ending stage while the matter is still Closed/Completed offers to reopen it (`:214-220`). `is_closed` is informational about the *stage*, not a lifecycle trigger.

### Matter Custom Fields

Per-firm custom fields are defined once in `matter_field_defs` and stored per matter in the `matters.custom_fields` jsonb, keyed by definition id.

Definitions carry a `field_type` constrained by the DB to `text`, `textarea`, `number`, `currency`, `date`, `select`, `multiselect`, `checkbox`, `url`, `email`, `phone`, plus `options` (jsonb, for the select types), `help_text`, `required`, `sort_order`, and `archived`. Like stages, a definition is either scoped to a practice area or firm-wide (`practice_area_id` null), and definitions are **archived, never hard-deleted**, so a matter that already carries a value for a retired field doesn't lose it.

Values are validated server-side against the definitions on every write. `validateCustomFields` (`matters.service.ts:50`) loads the applicable defs for the matter's effective practice area and then, per submitted key:

- **Drops unknown, non-applicable, or archived definitions** (`:60`), so the payload can't smuggle arbitrary jsonb into the column.
- **Drops empty values** (`:61`), so clearing a field removes the key.
- **Coerces and checks by type** (`:63-99`): numbers and currency must be finite, dates must be `YYYY-MM-DD`, and `select` / `multiselect` values must be among the definition's declared options.

The stored jsonb replaces the column wholesale, so callers send the full set of values. Reading defs needs `matters.view`, managing them needs `settings.manageFirm` (`fields/matterFields.routes.ts:17-55`, mounted at `/matter-field-defs`, `app.ts:858`). The frontend surface is `MatterCustomFieldsCard.tsx` on the overview tab.

### Key Dates, Billing Preferences & Legal Hold

These are first-class columns on `matters` (`30_matters.sql:85-93`) rather than `custom_fields` entries, because they are queried and enforced:

| Column | Type | Notes |
|---|---|---|
| `billing_method` | text NOT NULL default `'hourly'` | CHECK `in ('hourly','flat','contingency','pro_bono')` |
| `is_billable` | boolean NOT NULL default true | |
| `budget_cents` | bigint | CHECK null or `>= 0`; the API takes and returns dollars (`matters.service.ts:132`) |
| `budget_includes_expenses` | boolean NOT NULL default true | whether expenses count against the budget |
| `contingency_percent` | numeric | CHECK null or 0-100; only meaningful when `billing_method = 'contingency'` |
| `open_date` / `close_date` | date | day-only, no timezone shift |
| `statute_of_limitations_date` | date | the SOL deadline, indexed (`matters_firm_sol_idx`) |

The date columns are `date`, not `timestamptz`, so they come back as raw `'YYYY-MM-DD'` strings and must not be wrapped in `new Date()` on either end. The Zod schema rejects impossible days such as `2026-02-30` (`matters.validation.ts:13-17`).

**Legal hold is a row, not a column.** `legal_holds` (`db/schema/90_platform.sql:211`) holds one row per hold on exactly one of a matter, client or file. Releasing stamps `released_at` / `released_by` and keeps the row as the record of what was held. The matter projections join the unreleased row and expose `legalHold`, `legalHoldReason`, `legalHoldAt`, `legalHoldBy`. `PATCH /:matterId/legal-hold` (`matters.routes.ts:232`) → `setLegalHold` (`matters.service.ts:761`) inserts or updates the live row, or releases it (`matters.repository.ts:779`), then emits `MATTER_UPDATED` and a `legal_hold.changed` activity entry. A `before delete` trigger on `matters` and `clients` refuses a delete while a live hold exists (`90_platform.sql:240-266`), in addition to the service guard.

`MatterBudgetCard.tsx` renders the budget and billing preferences with spend warnings, using `billed_total_cents` from the detail projection; `ConflictCheckBanner.tsx` surfaces conflict state on the overview tab. No component currently calls `setLegalHold`; see What Can Be Improved.

### Related Contacts

`matter_contacts` links a directory contact to a matter with a per-matter `role`: `opposing_counsel`, `opposing_party`, `co_counsel`, `judge`, `witness`, `expert`, `adjuster`, `court_clerk`, `mediator`, `guardian_ad_litem`, `other` (`30_matters.sql:189-209`). The person lives once in the firm-wide `contacts` directory (see [Contacts](contacts.md)); the junction carries only the role, notes and order. Both FKs are composite `(law_firm_id, …)` with cascade.

Routes hang off the matter (`contacts/matterContacts.routes.ts:13-55`, mounted with the other `/matters` sibling routers at `app.ts:856`): reading needs `matters.view`, writing needs `matters.update`. Frontend: `MatterContactsTab.tsx` + `LinkContactModal.tsx`.

### Matter Activity Feed

The feed is the matter arm of the shared `activity_log` table (`db/schema/50_notes.sql:236`): `activity_type`, `summary`, `actor_user_id` + `actor_name` (snapshotted so the feed survives a rename or removal), and a `metadata` jsonb. The table has `client_id` and `task_id` arms too, which nothing writes yet.

**Recording is best-effort and never fails the request.** `recordActivity` (`activity/matterActivity.service.ts:10`) wraps its insert in a try/catch that logs and swallows (`:24`), so a feed write never rolls back the change it describes. Producers call it directly: `matters.service.ts` at `:430` (created), `:678` / `:685` (status, stage), `:760` (legal hold), `:791` (conflict check re-run), `:873` (bulk status); `contacts/matterContacts.service.ts:96,152`; and seven note listeners in `notes/matterNotes.events.ts:34-131`.

`GET /:matterId/activity` (`matters.routes.ts:263`) → `listActivity` (`activity/matterActivity.service.ts:34`) returns `{ activity, totalItems }` under `assertMatterReadAccess`, with `limit` clamped to 1-200, `offset`, and a repeatable `type` filter for the timeline's "Notes only" style views. `MatterActivityFeed.tsx` renders it.

### Deadline Sets

A **deadline set** is a firm-defined template that turns one trigger (anchor) date into a cascade of matter events. An admin defines a set once (e.g. "Civil Complaint Filed" → Answer +30d, Discovery cutoff +90d, Mediation +120d); applying it to a matter with a chosen anchor date materializes each item as a normal matter event, so the created events inherit calendar sync, reminders, and portal visibility exactly like hand-entered events. Templates are managed in firm settings. The submodule lives in `backend/src/modules/matters/deadlineSets/`; the default sets a new firm is seeded with are covered in [Reference Data](reference-data.md).

#### Entry points

Templates are configured under **Settings → Matter Config → Deadline Sets**: `settings/matter-config/page.tsx` renders the `DeadlineSetsPage` default export of `settings/deadline-sets/page.tsx` as a sub-tab (`matter-config/page.tsx:10,71`). The editor is `deadlineSetsComp/DeadlineSetEditorModal.tsx`. Applying a set happens from a matter's Events tab: `MatterEventsTab.tsx:1454` renders the "Apply Deadline Set" button, which opens `matterComp/ApplyDeadlineSetModal.tsx` (`MatterEventsTab.tsx:1609`). The API client is `frontend/src/services/deadlineSets.service.ts` (types in `frontend/src/types/deadlineSet.ts`).

#### Backend routes

Template CRUD is its own router mounted at `app.ts:861` on `/api/lawfirms/:lawFirmId/deadline-sets`; the apply action lives on the matters router.

| Method | Path | Permission | Handler | Line |
|---|---|---|---|---|
| GET | `/deadline-sets` | `matters.view` | `listDeadlineSets` | `deadlineSets.routes.ts:16` |
| GET | `/deadline-sets/:templateId` | `matters.view` | `getDeadlineSet` | `deadlineSets.routes.ts:26` |
| POST | `/deadline-sets` | `settings.manageFirm` | `createDeadlineSet` | `deadlineSets.routes.ts:37` |
| PUT | `/deadline-sets/:templateId` | `settings.manageFirm` | `updateDeadlineSet` | `deadlineSets.routes.ts:49` |
| DELETE | `/deadline-sets/:templateId` | `settings.manageFirm` | `deleteDeadlineSet` | `deadlineSets.routes.ts:62` |
| POST | `/matters/:matterId/deadline-sets/:templateId/apply` | `matters.update` | `applyDeadlineSet` | `matters.routes.ts:369` |

Reading sets requires only `matters.view` (so the apply flow can list them), while creating, editing or deleting a template requires `settings.manageFirm`. Apply is gated by `matters.update` plus `requireTimezone` (`matters.routes.ts:369-373`).

#### Data flow: apply a set to a matter

1. **UI**: `ApplyDeadlineSetModal` loads the firm's sets, the user picks a set and a **trigger date**, and a client-side preview (`computeDeadlineDate`, `ApplyDeadlineSetModal.tsx:30`, chaining `relativeTo: 'previous'` items at `:93-97`) shows the resulting dates before applying.
2. **Service (FE)**: `deadlineSetsService.apply` POSTs `{ anchorDate }` to `.../matters/{matterId}/deadline-sets/{templateId}/apply` (`deadlineSets.service.ts:42-44`).
3. **Route**: `verifyToken` → `requirePermission('matters.update')` → `validate(applyDeadlineSetSchema)` → `requireTimezone` (`matters.routes.ts:369-373`).
4. **Service (BE)**: `applyDeadlineSet` (`deadlineSets/deadlineSets.service.ts:141`) runs `assertLawFirmMembership`, loads the template (404 if missing), validates the anchor is `YYYY-MM-DD` (`:146-149`), and asserts matter membership (`:151`). It then computes every item's date up front, with no I/O (`:155-163`): an item with `relativeTo: 'previous'` is offset from the date computed for the item before it, otherwise from the anchor.
5. **One transaction**: all events are written inside one `withDrizzleTransaction` via `matterEventsService._createMatterEventTx` (`:165-183`, `matterEvents.service.ts:351`), so a failure partway through rolls back every event this call wrote.
6. **Result**: only after the commit does each created event emit `MATTER_EVENT_CREATED` (`:185-194`), so calendar sync and reminders never see an event a rollback removed. Response `201 { message, created, events[] }` (`:196-200`).

#### Date math (`computeDeadlineDate`, `deadlineSets/deadlineSets.service.ts:53`)

Offsets are **plain calendar days** computed in UTC so they never drift across DST. `offsetDirection` (`'before' | 'after'`) chooses the sign of `offsetDays` relative to the base date (the anchor, or the previous item's date for `relativeTo: 'previous'`). When `adjustForWeekends` is true, a computed Saturday rolls forward two days and a Sunday one day (both land on Monday). There is **no court-holiday awareness**. The frontend duplicates this logic for its preview (`ApplyDeadlineSetModal.tsx:30`).

#### Data model: `deadline_set_templates` (`db/schema/60_calendar.sql:308`)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `law_firm_id` | uuid NOT NULL | FK → `law_firms`, cascade |
| `name` | text NOT NULL | |
| `description` | text | optional |
| `adjust_for_weekends` | boolean NOT NULL default `false` | roll Sat/Sun computed dates to Monday |
| `items` | jsonb NOT NULL default `'[]'` | ordered array of deadline items |
| `created_by` | text | acting user id |
| `created_at`/`updated_at` | timestamptz | `set_updated_at` trigger |

Each `items[]` entry is `{ title, type, offsetDays, offsetDirection, relativeTo, clientVisible, notes }`, where `type` is a matter-event type and `relativeTo` is `'trigger'` (default) or `'previous'`. The repository is a plain tenant-scoped `DrizzleRepository` (`deadlineSets.repository.ts:12`). Validation caps a set at 1-50 items, `offsetDays` at an integer 0-3650, `name` ≤ 200 chars, `description` ≤ 1000, item `title` ≤ 300, and `notes` ≤ 2000 (`deadlineSets.validation.ts:8-34`).

#### Key rules

- **Templates are decoupled from applied events.** Applying materializes independent matter-event rows with no stored link back to the template. Editing a set later does **not** change events already created from it, and deleting a set does **not** remove them (the delete confirm copy says so, `settings/deadline-sets/page.tsx:220`).
- **Apply is all-or-nothing but not idempotent.** The whole set commits or none of it does, but nothing records that a set was applied, so applying the same set to the same matter twice creates duplicate events.
- **Chained offsets.** A `relativeTo: 'previous'` item is offset from the previous item's computed (and weekend-adjusted) date, so the first item is always effectively relative to the trigger.

### Dependencies

- **Events**: `MATTER_CREATED` (`matters.service.ts:428`), `MATTER_UPDATED` (`:674`, `:758`, `:870`), `MATTER_DELETED` (`:737`, `:844`), `MATTER_MEMBERS_UPDATED` (`members/matterMembers.service.ts:79,128`, and `matters.events.ts:102` when a firm member is removed), `MATTER_CLIENTS_UPDATED` (`clients/matterClients.service.ts:37`). Applying a deadline set fans out one `MATTER_EVENT_CREATED` per item after commit.
- **Plan enforcement**: `enforceCountLimit('maxMatters', ...)` on create, twice (fast-fail, then locked inside the transaction).
- **Trust and billing**: `trustTxnRepo.countByMatterId` and `countBillingRecords` in the delete guard; `invoicesService.emitCalendarDeletesForInvoicesInContext` on delete.
- **Files**: `filesRepo.scopeSnapshot` + `removeCascadeObjects` remove a deleted matter's stored objects (`matters.service.ts:731-735`); `matters.repository.ts:121-122` opens the GCS bucket handle for attachment cleanup.
- **Firebase**: Auth only (`auth.getUserByEmail` as the email-resolution fallback, `matterClients.service.ts:23`).
- **Reference data**: practice areas, courts, note types and note templates are covered in [Reference Data](reference-data.md).

### Example

`GET /api/lawfirms/3f.../matters/9a2c...` with `X-Timezone: America/New_York` returns the `hydrate` + `withTimeFields` shape: `{ id, name, matterReferenceId, status, practiceAreaName, courtName, leadUserName, stagePipelineId, stageId, stageName, stageColor, legalHold, budget, billedTotal..., members[] (with hourlyRate/totalHours), memberUserIds[], clientNames[], clientDetails[], clientCount, customFields, createdAt + createdAtLocalDisplay, totalNotes }`.

> On the **list** endpoint the same shape is returned without the billed total, and each member's `totalHours` is always `0`.

---

## What Can Be Improved

Fixed since the last pass and dropped: the overlapping name-array client endpoints (removed; clients attach only through `/:matterId/clients`); the missing `status` CHECK (now `30_matters.sql:68`); notes travelling with every matter read (now only `totalNotes`, `matters.service.ts:569-577`); the non-atomic create (now `createMatterWithMembersTx`, `matters.repository.ts:688`); and the non-transactional deadline-set apply (now one transaction, `deadlineSets.service.ts:165`).

1. **The status vocabulary is written out in several places.** `VALID_MATTER_STATUSES` (`matters.validation.ts:5`), the DB CHECK (`db/schema/30_matters.sql:68`), the closed/terminal classification in `shared/constants/matterStatus.ts`, and the frontend `matterStatusConfig` must all be edited together when a status is added. Nothing enforces that they agree; a test asserting the Zod list equals the CHECK and that every terminal status is valid would catch drift.

2. **Legal hold has no UI.** The backend supports placing and lifting a hold (`PATCH /:matterId/legal-hold`, `matters.routes.ts:232`) and the delete paths enforce it, and `MattersService.setLegalHold` exists (`frontend/src/services/matters.service.ts:1085`), but no component calls it. A firm cannot place a hold from the app, so the delete refusal it enables can only be triggered from the API.

3. **Applying a deadline set is not idempotent.** Nothing records that a set was applied to a matter, so a retry or a second click duplicates every event (`deadlineSets/deadlineSets.service.ts:141-201`). Recording applications (template id, matter id, anchor date) would let the flow warn, dedup, or offer an undo.

4. **The deadline-set editor's drag handle is decorative.** `deadlineSetsComp/DeadlineSetEditorModal.tsx:197` renders a `GripVertical` icon per item but wires no drag-and-drop, so item order is fixed to insertion order. That matters more now that `relativeTo: 'previous'` makes order change the computed dates. Wire up dnd-kit reordering or drop the handle.

5. **Weekend roll-forward has no court-holiday awareness.** `computeDeadlineDate` (`deadlineSets/deadlineSets.service.ts:53`) only rolls Saturday/Sunday to Monday; a deadline landing on a court holiday is left as-is.

6. **A matter can exist with no recorded conflict check.** `recordConflictCheckForMatter` runs after the create transaction commits and swallows every error (`matters.service.ts:214-252`, called at `:426`). The firm treats the record as evidence that a check was performed, but a failure leaves no record and no signal beyond a log line. Consider surfacing the failure in the create response or retrying through the outbox.

7. **Re-running a conflict check is stricter than reading one.** `listConflictChecks` uses `assertMatterReadAccess` (`matters.service.ts:776`) but `rerunConflictCheck` uses strict `assertMatterMembership` (`:789`), so an owner or admin who is not on the matter can see the recorded checks but gets a 403 re-running one. Decide which rule is intended and align them.

8. **The activity route validates its query inline.** `GET /:matterId/activity` parses `limit`, `offset` and `type` by hand in the router (`matters.routes.ts:267-273`) while every other list route uses a Zod schema through `validate()`. A malformed `type` value reaches the repository unchecked.
