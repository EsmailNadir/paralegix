# Tasks

## Summary

Tasks are firm-scoped or matter-scoped work items with assignees, reminder recipients, clients, dependencies, recurrence, reminders, attachments, notes, and a subtask checklist. Relationships live in junction tables (`task_assignees`, `task_clients`, `task_dependencies`), notes in the shared `notes` table, attachments in `attachments` joined to `files`, and reminder state in the shared `reminders` table; **everything else is derived at read time** by JOINs and `LATERAL` subqueries in the enriched projection, split into `TASK_COLUMNS` and `TASK_JOINS` so the paged read can page before it enriches (`backend/src/modules/tasks/tasks.repository.ts:109,130,199`). Every query is tenant-scoped by `law_firm_id`. Matter-scoped tasks gate visibility on the parent matter's `matter_members` and derive their client list from `matter_clients`; firm-scoped tasks are visible to all firm members and use the manual `task_clients` junction. Owners and firm admins see every task. Calendar sync, notifications, and attachment cleanup happen via the event bus (`TASK_CREATED` / `TASK_UPDATED` / `TASK_DELETED`).

## Key Takeaways

- **Entry point:** routes mount at `/api/lawfirms/:lawFirmId/tasks` as `[taskNotesModuleRoutes, taskSubtasksModuleRoutes, tasksModuleRoutes]` (`backend/src/app.ts:855`); the firm task list page is `frontend/src/app/lawfirm/[lawFirmId]/tasks/page.tsx` → `TasksGrid`.
- **The firm list endpoint is server-paged on request.** `GET /tasks` takes `page`/`limit`/`status`/`assignee`/`matterId`/`clientId`/`priority`/`search`/`sortBy`/`order`/`sort`; any of them selects `findVisibleToUserPaged` (`tasks.service.ts:416-426`, `tasks.repository.ts:486`), which counts and pages in a CTE over bare `tasks` and only then runs the enrichment joins, returning `{ tasks, totalTasks }`. With none of them it falls back to the unbounded `findVisibleToUser` (`tasks.repository.ts:460`), which the calendar (bounded by `dueFrom`/`dueTo`, which deliberately do not trigger paging) and the client portal use.
- **`useTasksTable` is server-driven.** Paging, sort and filters come from `useServerTable` (`useTasksTable.ts:45`) and flow into `useLawfirmTasks` (`useTasks.ts:234`); nothing is filtered or sorted in memory.
- **Analytics is a SQL aggregate, not a hydrate.** `getTaskAnalytics` (`tasks.service.ts:703`) calls `getAnalyticsAggregates` (`tasks.repository.ts:733`): status/priority counts via `FILTER`, overdue and average completion in SQL, a per-assignee rollup, and a daily created/completed trend, with the `dateRange` cutoff pushed into `where created_at >= cutoff`.
- **`TASK_*` emits are detached.** The service uses `eventBus.emit`, synchronous in-process dispatch that is not awaited, with the canonical `entityData`/`previousData` payload keys (`tasks.service.ts:219`, `:329`, `:350`). The three bulk routes go through `emitBulkDetached` instead (`:531`): still not awaited, but at most `BULK_EVENT_FANOUT` (3) of a batch's listener chains run at once, so a "select all" selection cannot start thousands of listener chains at once against the 12-connection pool. The `event_outbox` backstop writes nothing unless `EVENT_OUTBOX_WORKER === 'true'` (`eventBus.ts:63-67`). See *What Can Be Improved* #1.
- **Bulk ops batch their work.** `bulkDelete` / `bulkStatus` / `bulkMatter` resolve matter access for the whole batch in one query (`_markInaccessibleMatters` → `getAccessibleMatterIds`, `tasks.service.ts:544-553`), emit events detached and bounded (`emitBulkDetached`, `:531`), and remove deleted tasks' stored files with `removeCascadeObjects` inside the request. `bulkDelete` snapshots every task's documents in one query (`filesRepo.scopeSnapshotsForTasks`), so the connections it takes do not grow with the selection. `bulkMatter` resolves the destination matter's roster for every assignee and reminder recipient across the whole batch in one query too (`resolveMatterMembers`, `:611`), and only a task that actually carries an outsider costs a further round trip, to build the message naming them.
- **Select-all equals the list.** `GET /ids` applies the same filters as `GET /` including the `dueFrom`/`dueTo` window and the person-to-organization `clientId` widening, so a bulk action acts on exactly the tasks the grid showed (`tests/tasks/taskSelectAllParity.test.ts`).
- **A task on a matter under legal hold cannot be deleted or moved off that matter.** `deleteTask` and `updateTask` answer 403; `bulkDelete` and `bulkMatter` record per-id failures. This prevents moving a task before deleting its documents. Editing other fields or moving a task onto a held matter remains allowed. The hold lookup is batched (`findHeldMatterIds`).
- **Owners and admins see all of a matter's tasks.** `GET /matter/:matterId` and `GET /analytics` use the same see-all branch as the firm list; a plain member still needs matter membership.
- **A recurring task keeps its due date.** `updateTask` validates the recurrence it will end up with (the body's, else the stored one), so `dueDate: null` on a recurring task is a 400.
- **Denormalized fields are derived, not stored.** `assignedTo`, `assignedToName`, `clientIds`, `clientNames`, `dependencies`, `dependents`, `hasIncompleteDependencies`, subtask counts, `visibleToUserIds`, `matterName` and `attachments` are computed in the projection and assembled by `hydrate()` (`tasks.repository.ts:203`).
- **Writes are transactional with replace-set junction sync; dependency cycles are blocked on write** by a recursive-CTE reachability check throwing `ValidationError('Dependency would create a cycle')` (`tasks.repository.ts:1354-1383`).
- **Matter work stays on the matter's team.** On a matter-scoped task, writes require matter membership (`assertMatterMembership`, `tasks.service.ts:143,241,342`), reads accept owners/admins too (`assertMatterReadAccess`, `:378,492,652`), and every assignee and reminder recipient must be a member of the matter (`assertMatterMemberships`, `:156-159`, `:308-309`).
- **Shared form state.** `useCreateTask` and `useEditTask` both drive the `useTaskForm` reducer (`useTaskForm.ts:157`).
- **Optional ends are validated before writes.** Task, matter-event and client-event ends accept ISO dates or datetimes with valid calendar and clock ranges. Null clears an end; malformed strings are refused. A flag-only all-day toggle uses the stored day, clears an incompatible end, and defaults to noon in the caller's zone when becoming timed. Calendar reads opt into overlapping all-day spans with `includeSpanning=true`; ordinary due-date filters remain start-only.

---

## How It Works

### Entry Points

| Layer | Location |
|---|---|
| List page | `frontend/src/app/lawfirm/[lawFirmId]/tasks/page.tsx` → `TasksGrid` |
| Detail page | `frontend/src/app/lawfirm/[lawFirmId]/tasks/[taskId]/page.tsx` |
| Analytics page | `frontend/src/app/lawfirm/[lawFirmId]/tasks/analytics/page.tsx` |
| Create/edit form state | `frontend/src/hooks/taskHooks/useTaskForm.ts` (shared reducer); `useTasks.ts:35` (`useCreateTask`), `:116` (`useEditTask`) |
| List query (React Query) | `frontend/src/hooks/taskHooks/useTasks.ts:234` (`useLawfirmTasks`) |
| Table filtering/sort/paging | `frontend/src/hooks/taskHooks/useTasksTable.ts` (on `useServerTable`) |
| Bulk ops | `frontend/src/hooks/taskHooks/useTasks.ts:322` (`useBulkTasks`) |
| API client | `frontend/src/services/tasks.service.ts:94` (`TasksService`); paged list at `:253` |
| Route mount | `backend/src/app.ts:855` (`/api/lawfirms/:lawFirmId/tasks`) |
| Routes | `backend/src/modules/tasks/tasks.routes.ts`; notes via the shared notes router in `notes/taskNotes.routes.ts`; subtasks in `subtasks/taskSubtasks.routes.ts` |
| Service | `backend/src/modules/tasks/tasks.service.ts` |
| Repository | `backend/src/modules/tasks/tasks.repository.ts` |
| Validation | `backend/src/modules/tasks/tasks.validation.ts` |
| Events | `backend/src/modules/tasks/tasks.events.ts` |
| Recurrence cron | `backend/src/modules/tasks/taskRecurrence.service.ts` |
| Reminder cron | `backend/src/modules/tasks/taskReminders.service.ts` |

**Routes** (`tasks.routes.ts`; the list routes are declared before the `/:taskId` wildcard): `GET /` (`:24`), `GET /ids` (every id behind the filters, for "select all", `:49`), `GET /status-counts` (`:69`), `GET /lookup` (typeahead, `:85`), `GET /matter/:matterId` (`:102`), `GET /my-assignments` (`:115`), `GET /analytics` (`:127`), `POST /bulk-delete` / `bulk-status` / `bulk-matter` (`:142-169`), `POST /` (`:186`), `GET /:taskId` (`:210`), `GET /:taskId/dependencies` (`:223`), `PUT /:taskId` (`:236`), `DELETE /:taskId` (`:257`). All use `tasks.view` / `tasks.create` / `tasks.update` / `tasks.delete`.

Task notes (`/:taskId/notes*`) come from the shared `createNotesRouter` configured in `notes/taskNotes.routes.ts` with `tasks.view` to read, `tasks.update` to write, reply and retract, and `billing.manageTimeEntries` to log time (also required to post a note carrying `timeEntries`), the same rule matter and client notes follow.

### Data Flow: Create a Task (UI → Postgres → back)

1. User fills the create form; state lives in the shared `useTaskForm` reducer driven by `useCreateTask` (`useTasks.ts:35`). `submit()` (`:41`) validates the title, then calls `TasksService.createTask(...)` (`:58`) with recurrence built by `buildRecurrencePayload` (`useTaskForm.ts:109`).
2. `TasksService.createTask` (`frontend/src/services/tasks.service.ts:174`) POSTs to `/api/lawfirms/:lawFirmId/tasks` with the `X-Timezone` header and no deduplication.
3. Express matches `POST /` (`tasks.routes.ts:186`): `verifyToken` → `requirePermission('tasks.create')` → timezone and `createTaskSchema` validation.
4. `createTask` (`tasks.service.ts:124`): matter membership when `matterId` is set (`:143`), `normalizeStatus` (`:145`), `toAssigneeArray` for assignees and reminder recipients (`:147-148`), both of which must be matter members on a matter task (`:156-159`), recurrence consistency (`:171`), and `clientIds` forced to `[]` when matter-scoped (`:189`).
5. `tasksRepo.createTask` (`tasks.repository.ts:1034`) opens a transaction, inserts the `tasks` row, then rebuilds junctions: `syncAssignees`, `syncDependencies` (`:1062-1063`) and `syncTaskClients` **only when firm-scoped** (`:1065`). After commit it re-reads the hydrated task via `oneById`.
6. Unless `skipCalendarEvent` is set, the service emits `TASK_CREATED` whenever the task has **a due date or any assignees** (`tasks.service.ts:214-219`). The calendar adapter returns no items for a task without a due date, so the emit is harmless for notification-only cases.
7. The service returns `{ message, taskId, task }`, with `task` passed through `formatTaskForResponse` (`:108`) for localized due-date display fields (`:222`). The hook invalidates the `['tasks', lawFirmId]` query key and resets the form.

### Data Flow: List Firm Tasks (the hot read path)

There are two modes, selected in the service by whether any paging, filter or sort param is present (`tasks.service.ts:416-418`). Owners and firm admins get `seeAll` (`isFirmOwnerOrAdmin`) in both; a `clientId` filter is widened to every company the client is linked to.

**Paged mode** (the table UI):
1. `useTasksTable` holds paging, sort and the table-owned `assigneeFilter` / `firmLevelOnly` controls on top of `useServerTable` (`useTasksTable.ts:45`); `firmLevelOnly` maps to the backend `matterId='none'` sentinel.
2. `useLawfirmTasks` (`useTasks.ts:234`) keys the query on those params and calls `TasksService.listLawFirmTasksPaged` (`tasks.service.ts:253`).
3. Route `GET /` (`tasks.routes.ts:24`) validates `listTasksSchema` (`tasks.validation.ts:54`, `.passthrough()`, sort fields whitelisted at `:29`) and calls `listLawFirmTasks` (`tasks.service.ts:408`).
4. `findVisibleToUserPaged` (`tasks.repository.ts:487`) builds the visibility predicate and filters with `buildTaskListWhere` (`:297`), maps the sort through a `SORT_COLUMNS` whitelist (`:496`), clamps `limit` at 200 (`:522`), and pages in a CTE that selects `t.id, count(*) over()` from bare `tasks` before the enrichment joins run (`:528-545`), so only the page's rows are enriched.
5. Returns `{ tasks, totalTasks }`; the table renders the server page directly.

**Full-set mode** (calendar feed, client portal, `listLawFirmTasks` with no paging params):
1. `findVisibleToUser` (`tasks.repository.ts:460`) runs the enriched projection with the visibility predicate plus optional `status` / `dueFrom` / `dueTo`, ordered `created_at desc`, **with no `LIMIT`**. The calendar bounds it with `dueFrom`/`dueTo`, which deliberately do not switch to paged mode.
2. Each row is mapped through `formatTaskForResponse` and its attachment URLs re-signed (`tasks.service.ts:428-431`).

### Data Flow: Analytics (SQL aggregate)

1. `getTaskAnalytics` (`tasks.service.ts:703`) maps `dateRange` (`7d`/`30d`/`90d`/`all`) to a `cutoff` date.
2. `getAnalyticsAggregates` (`tasks.repository.ts:733`) runs three queries over the same visibility-scoped `where` (+ optional `created_at >= cutoff`): a summary with `count(*) FILTER (...)` for status/priority/overdue and average completion time; a per-assignee rollup through `task_assignees`; and a created/completed daily trend.
3. The service reshapes the rows and converts average completion seconds to days. The enriched projection is never run.

### Data Model

Schema source: `backend/db/schema/40_tasks.sql` (generated into `schema.sql`). Money/date conventions per project `AGENTS.md`.

| Table | Key columns | Notes |
|---|---|---|
| `tasks` (`40_tasks.sql:5`) | `id uuid` PK, `law_firm_id`, `matter_id`, `title`, `description`, `location`, `status`, `priority`, `due_date date`, `due_date_timezone`, `due_at timestamptz`, `ends_at timestamptz` (optional end, migration 0039), `all_day`, `source`, `practice_area_id`, `court_id`, calendar-sync columns, `recurrence` jsonb, `reminder_recipient_ids text[]`, `send_reminder_early`, `created_by`, timestamps | `status` CHECK `open / in_progress / completed / blocked` (`:11-12`); `priority` is app-managed. `tasks_ends_after_start` requires an end to have a due date and come after it: a timed end is an instant after `due_at`, an all-day end is the exclusive day after the last day, at noon UTC. `unique (law_firm_id, id)`. **FK `(law_firm_id, matter_id) → matters ON DELETE CASCADE` (`:40`)**; `practice_area_id` / `court_id` set null (`:41-42`). Legacy reminder counters are read from `reminders`; active delivery state is tracked per recipient in `task_reminder_deliveries` (`db/schema/90_platform.sql`). Attachments are rows in `attachments` joined to `files`. |
| `task_assignees` (`:60`) | `(law_firm_id, task_id)` composite FK to tasks, `user_id` FK to users, both cascade | Indexes on `user_id` and `(law_firm_id, task_id|user_id)`. |
| `task_clients` (`:75`) | composite FK to tasks, `client_id` FK to clients, both cascade | Used **only for firm-scoped tasks**. `task_clients_client_idx (client_id)` serves client-keyed cleanup. |
| `task_dependencies` (`:90`) | both sides composite FKs to tasks, `check (task_id <> depends_on_task_id)` | Self-reference both ways = `dependencies` and `dependents`. |
| `task_subtasks` (`:107`) | see [Subtasks](#subtasks) | |

**Indexes on `tasks`** (`40_tasks.sql:44-53`): `tasks_firm_matter_idx`, `tasks_firm_status_idx`, `tasks_firm_due_idx`, plus practice-area, court and created-by indexes. The status/due indexes back the paged `status` filter and `dueDate` sort.

### Notes

Task notes are rows in the shared `notes` table with `task_id` set (`db/schema/50_notes.sql:65`, composite FK to `tasks`, cascade), with edit history in `note_versions` and threaded replies in `note_replies`, the same model as matter and client notes. Only matter notes link out to tasks and files today (`note_links`). The frontend reuses `NotesSection.tsx` with `parentType="task"`; see [Matters » Notes](matters.md#notes).

> Note: there is **no** `task_visibility` table: visibility is derived entirely from `matter_members` (matter-scoped) / `members` (firm-scoped) at read time.

**Relationships / derivation** (assembled in `TASK_COLUMNS` + `TASK_JOINS`, `tasks.repository.ts:109-198`):

- `fm` is a LATERAL `array_agg(user_id)` over the firm's `members` (`:184`) and `cmv` the same over the matter's `matter_members` (`:178`); `visible_to_user_ids` picks `cmv` for a matter task, else `fm`.
- `client_ids` / `client_names` come from `matter_clients JOIN clients` for a matter task, else `task_clients JOIN clients` (`:187-191`).
- `assigned_to_ids` / `assigned_to_names` come from `task_assignees JOIN users`; `dependencies` / `dependents` from forward and reverse `task_dependencies` LATERALs; `has_incomplete_dependencies` and the subtask counts from their own LATERALs; `attachments` from `attachments JOIN files`.
- `matter_name`, `practice_area_name`, `court_name`, `created_by_name`, and the reminder columns come from plain LEFT JOINs.

### Key Logic & Rules

- **Validation** (`tasks.validation.ts`): `title` 1-500 chars, `description` ≤ 5000, `dependencies` ≤ 20 entries (`:91-117`), `status`/`priority` enums, recurrence shape constrained (interval 1-365, `daysOfWeek` 0-6, `dayOfMonth` 1-31, `maxOccurrences` 1-1000, `:17-22`). The list schema validates the paged query params through the shared `listQuery` helpers (`limit ≤ 200`, a whitelisted sort-field enum) and uses `.passthrough()` so other params survive. Bulk schemas require `taskIds.min(1)` and cap `taskIds` at `MAX_BULK_TASK_IDS`, imported from `tasks.service.ts:461` rather than restated, so all three bulk routes and the ceiling `GET /ids` applies to "select all" are literally the same number (5000). A full selection is accepted and one id more is a 400, with nothing written.
- **Shared coercion** (`tasks.service.ts:14-31`): `normalizeStatus` (trim + validate against `VALID_STATUSES`, throws 400) and `toAssigneeArray` (array | scalar | undefined → clean `string[]`) are used across create, update and bulk.
- **Permissions**: route-level `requirePermission('tasks.view'|'create'|'update'|'delete')`. Task notes use `tasks.update` for writes and retraction, and `billing.manageTimeEntries` for note time.
- **Tenancy**: every repository query is scoped by `law_firm_id` and validates UUIDs via `isUuid` guards. The backend connects as `postgres` and bypasses RLS, so tenancy is the app's responsibility. The junction-sync writes are firm-scoped too: `syncAssignees` (`tasks.repository.ts:1351`) only inserts members of the task's firm, `syncDependencies` (`:1354`) only links tasks in the same firm, and `syncTaskClients` (`:1403`) only links the firm's clients, so a caller cannot persist a cross-tenant assignee or dependency edge, or probe arbitrary ids through an FK error.
- **Matter visibility & access**: every list read carries the visibility predicate `matter_id is null or exists (matter_members …)` (`buildTaskListWhere`, `tasks.repository.ts:297-316`) unless the caller is an owner or firm admin. Single-task reads call `assertMatterReadAccess`, mutations `assertMatterMembership`. Bulk ops resolve membership for the whole batch in one query via `getAccessibleMatterIds` (`tasks.service.ts:544-553`), and `bulkMatter` resolves the destination matter's roster for the whole batch with `resolveMatterMembers` (`membership.ts`) before deciding per task.
- **Paged sort safety**: `sortBy` / `sort` are mapped through a `SORT_COLUMNS` whitelist to real expressions (`tasks.repository.ts:496`), never interpolated; `limit` is clamped to 200 (`:522`).
- **Clients scope rule**: matter-scoped tasks ignore manual `clientIds` (forced to `[]` on create, cleared in bulk-matter). On a matter→firm transition, `updateTask` always rewrites `task_clients` (to the supplied `clientIds` or `[]`) rather than leaving stale rows (`tasks.repository.ts:1122-1129`).
- **Managing standalone task clients requires `clients.manage`.** Creating a task with clients or changing its client set checks this permission in addition to the task route's write permission. Resubmitting the same client set while editing task fields does not require it. Task detail controls and the shared task form picker follow this rule.
- **Dependencies & cycle prevention**: replace-set on each write. `syncDependencies` de-dupes, drops self-refs and non-UUIDs, then runs a **recursive-CTE reachability check** and throws `ValidationError('Dependency would create a cycle')` (`tasks.repository.ts:1354-1383`). The DB `check` constraint guards self-edges. Deleting a task cascades both dependency directions via FK.
- **Recurrence**: stored as jsonb and validated by `assertRecurrenceConsistent` on create/update. `processRecurringTasks` finds completed recurring tasks, computes the next due date, and checks the occurrence/end-date limits. A conditional `disableRecurrence` claim and the successor task plus its junctions share one transaction. The claim checks the PostgreSQL row version captured by the sweep and requires the task to remain completed, so a concurrent edit is skipped and reconsidered on the next sweep. Overlapping workers create one successor; a failed insert restores the claim for retry. `TASK_CREATED` follows commit.
- **Reminders**: the cron resolves eligible recipients and claims each independently in `task_reminder_deliveries`. A five-minute token lease prevents overlapping sends and expires after a worker crash. Provider acceptance completes only that recipient's 24-hour window; refusal releases only that claim. Completion and release require the current token, so an expired worker cannot overwrite its successor. Stable provider idempotency keys protect retries of unchanged content. Existing notification preferences and digest exclusions still apply.
- **`updateTask` scope resolution**: the service loads the task once and passes `opts.currentMatterId` down so the repo reuses it instead of a redundant `select matter_id` (`tasks.repository.ts:1110-1120`).
- **Edge cases**: `dueDate` is handled at noon UTC so display never rolls back a day (`taskDueInstant`, `tasks/taskDue.ts`, which falls back to the day's `dayAnchor`); attachment URLs are re-signed on read; deleting a task removes its stored files inside the request (`removeCascadeObjects`, `:362`); on `MATTER_DELETED`, `tasks.events.ts:22` uses the pre-delete task snapshot the matters service passes, emits `TASK_DELETED` per task and batch-deletes whatever the FK cascade left.

### Subtasks

A **subtask** is a checklist item inside one task: a title, a done flag, an optional assignee, and a manual order. They live in `task_subtasks` (`db/schema/40_tasks.sql:107`) and are deliberately *not* tasks: no due date, no recurrence, no reminders, no calendar sync, no dependencies. They exist so a task can carry its own steps without polluting the firm task list.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | plus `unique (law_firm_id, id)` |
| `task_id` | uuid NOT NULL | FK → `tasks(id)` **cascade**: deleting a task deletes its checklist |
| `title` | text NOT NULL | |
| `is_completed` | boolean NOT NULL default false | |
| `assignee_user_id` | text | FK → `users(id)` set null |
| `sort_order` | integer NOT NULL default 0 | manual ordering |
| `completed_at` / `completed_by` | timestamptz / text | stamped on completion, cleared on reopen |
| `created_by`, `created_at`, `updated_at` | | |

**Access control inherits the parent task's ethical wall.** Every subtask read and write first runs `assertTaskInFirm` (`subtasks/taskSubtasks.service.ts:13`), which asserts firm membership and then, when the parent task belongs to a matter, asserts matter access too (`:18`): `assertMatterReadAccess` for reads, strict `assertMatterMembership` for writes. Without that second check a member walled off from a confidential matter could read or mutate its checklist through the subtask routes, which only carry a `taskId`. `resolveAssignee` (`:27`) requires an assignee to be a firm member and, on a matter task, a member of the matter (`:32`); an empty string is normalized to `null`.

Routes are mounted with the other task sub-routers at `/api/lawfirms/:lawFirmId/tasks` (`app.ts:855`), so the paths are `/:taskId/subtasks*`: `GET` (`tasks.view`), `POST /reorder`, `POST`, `PUT /:subtaskId`, `DELETE /:subtaskId` (all `tasks.update`) (`subtasks/taskSubtasks.routes.ts:15-73`).

**Completion is stamped, not just flagged.** Setting `isCompleted: true` writes `completed_at = now()` and `completed_by = <acting user>` in the same UPDATE; setting it back to false nulls both (`subtasks/taskSubtasks.repository.ts:102-105`).

**Reorder is one statement, not a loop.** `reorder` (`:130`) applies the whole ordering in a single statement scoped by `law_firm_id` and `task_id`.

The task projection carries only `subtask_count` / `incomplete_subtask_count`; the items themselves are fetched by their own endpoint when the task detail view opens. Frontend: `taskComp/TaskSubtasks.tsx`.

### Dashboard / dependency / analytics reads

- `getMyAssignments` (`tasks.service.ts:677`) returns the user's non-completed assigned tasks (`findAssignedToUser`, `tasks.repository.ts:876`), with the same matter-membership wall as every other feed, so being assigned to a task on a matter the user is walled off from does not leak it.
- The dashboard consumes `findUpcomingForUser` (`tasks.repository.ts:820`), `findOverdueForUser` (`:836`) and `countAssignedToUser` (`:904`), all timezone-aware and walled the same way.
- The dependency graph endpoint (`getTaskDependencyGraph`, `tasks.service.ts:649`) fetches dependency and dependent tasks through `findByIdsVisibleToUser` (`tasks.repository.ts:1286`), so a neighbour the user cannot see is left out.

### Dependencies

- **Event bus** (`shared/events/eventBus`): `eventBus.emit` is synchronous in-process dispatch, not awaited; the `event_outbox` enqueue runs only when `EVENT_OUTBOX_WORKER === 'true'` (`eventBus.ts:63-67,85-89`). `TASK_*` is consumed by calendar sync, notifications, and file listeners; `MATTER_DELETED` by `tasks.events.ts`.
- **Calendar sync** (`modules/calendar/shared/calendarSync.repository`) via `applyCalendarSync` / `setSyncFields` / provider-id columns (`tasks.repository.ts:1144-1175`).
- **Files**: `removeCascadeObjects` (`modules/files/cascadeSweep`) removes a deleted task's stored objects.
- **Membership util** (`shared/utils/membership`: `assertMatterMembership`, `assertMatterMemberships`, `assertMatterReadAccess`, `getAccessibleMatterIds`, `isFirmOwnerOrAdmin`).
- **Reminder/recurrence helpers**, **email service**, **time util** (`formatForClient`), **Firebase Auth** (`verifyToken`), **React Query** + `useServerTable` (frontend).

### Example

Create a firm-scoped task with two assignees, a dependency, and weekly recurrence:

```
POST /api/lawfirms/<firmId>/tasks
X-Timezone: America/New_York
{
  "title": "File motion",
  "priority": "high",
  "dueDate": "2026-06-20",
  "assignedTo": ["uid_a", "uid_b"],
  "dependencies": ["<taskId-X>"],
  "clientIds": ["<clientId-1>"],
  "recurrence": { "enabled": true, "pattern": "weekly", "interval": 1 }
}
```

Result: one `tasks` row + two `task_assignees` rows + one `task_dependencies` row + one `task_clients` row (firm-scoped), all written inside one transaction (`tasks.repository.ts:1034-1068`). The dependency is accepted only if it does not close a cycle. The response re-reads the enriched projection and includes derived `assignedToName`, `clientNames`, `dependents`, `visibleToUserIds` plus `dueDateLocalDisplay`. A `TASK_CREATED` event fires (detached), since this task has both a due date and assignees.

A paged list request:

```
GET /api/lawfirms/<firmId>/tasks?page=1&limit=10&status=open&sortBy=dueDate&order=asc
X-Timezone: America/New_York
→ { "tasks": [ ...≤10 ], "totalTasks": 137 }
```

---

## What Can Be Improved

Ordered by impact. Resolved since the last pass and dropped: the calendar listeners that made enabling the outbox worker unsafe are now idempotent, because the create paths resolve an existing mapping before posting (`eventBus.ts:44-48`).

1. **A failed async listener is lost in the default deployment.** `eventBus.emit` calls the native emitter and does not await or observe the promises async listeners return (`eventBus.ts:85-89`), so a listener that rejects without its own try/catch surfaces as an unhandled rejection and nothing else happens. The three bulk routes are the exception: `emitBulkDetached` goes through `emitAsync`, which settles listeners with `allSettled`, so a rejection there is absorbed rather than unhandled (it is still not logged per listener). The `event_outbox` backstop is written only when `EVENT_OUTBOX_WORKER === 'true'` (`eventBus.ts:63-67`), which is off by default, so there is no durable record and no retry. The named blocker to turning the worker on is gone (see above), but the worker re-dispatches every enqueued event, not only failed ones, so every listener must stay idempotent and enabling it should be a deliberate, watched change (`eventBus.ts:38-55`). Wrapping the live dispatch so rejections are caught and logged would help either way.

2. **The paged list and the full-set read intentionally diverge on default ordering.** `findVisibleToUser` orders by `created_at desc` (`tasks.repository.ts:459-466`); the paged path defaults to `sortBy = 'title'` to match the table UI (`:486`). This is deliberate and commented (`tasks.service.ts:399-403`), but the table's initial title sort is not shown to the user; consider indicating the active sort in the column header.

3. **The full-set read path is unbounded.** `findVisibleToUser` (`tasks.repository.ts:460`) runs the enriched projection with no `LIMIT`, and `listLawFirmTasks` falls back to it whenever no paging param is present (`tasks.service.ts:428`). The calendar bounds it with `dueFrom`/`dueTo`; the client portal does not. For a firm with thousands of tasks that hydrates the entire visible set on every such load. Worth a hard cap or a bounded query if either consumer grows.
