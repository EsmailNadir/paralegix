# Notifications

## Summary

In-app notifications (the bell badge + dropdown feed) are a consumer of one backbone: a single in-process **event bus**. Domain modules emit named events when they mutate data; `notifications.events.ts` subscribes and turns them into rows in the `notifications` table, which the frontend bell reads (Supabase Realtime push, with a slow poll as backstop). The feature has no dispatch loop of its own: it is just a set of `eventBus.on(...)` handlers wired up at app startup (`backend/src/app.ts`).

> **Producers.** `notifications.events.ts` listens for `TASK_CREATED` / `TASK_UPDATED` (assignment), `MESSAGE_SENT` (mentions + new client messages), `MESSAGES_READ` (clears bell items), `MATTER_CREATED` and `MATTER_MEMBERS_UPDATED` (matter membership), `INVOICE_PAYMENT_RECEIVED`, `SIGNING_COMPLETED`, `SIGNING_DECLINED`, `SIGNING_PARTICIPANT_REMOVED`, `MEMBER_ROLE_CHANGED`, `MATTER_DELETED` / `TASK_DELETED` (cleanup), and the matter/task/client note-created and note-reply events (`notifications.events.ts:133-664`). Other modules call `createNotifications()` from their own listeners: leads, document requests, signing, subscriptions and trust (`leads.events.ts:34`, `documentRequests.events.ts:169`, `signingNotifications.ts:692,714`, `subscriptions.events.ts:82,111`, `trust.events.ts:123,168`). Callers pass a `category` (e.g. `taskAssigned`, `mention`, `message`, `matterAdded`, `invoicePaid`, `signingCompleted`, `roleChanged`), and `createNotifications()` runs `filterByPreference(userIds, category)` first: a recipient who muted that category under `preferences.notifications.inApp.<category>` (Settings > Notifications, see the Settings feature doc) is dropped before the row is written (`notifications.service.ts:11-20,140-156`). A call with no category is never filtered.
>
> **The Daily Digest is a separate, sibling consumer**, not part of the event-bus notification path described in this doc. It runs on its own cron (`backend/src/modules/notifications/digest`), independently reading each user's tasks/events/invoices/statute dates and mailing a summary at their configured hour, gated by `preferences.notifications.digest`. It doesn't write `notifications` rows and isn't deduped by the mechanism below. See the Automation guide's Reminders and Alerts page for the user-facing behavior.

All domain producers emit with the **same detached fire-and-forget model**: `eventBus.emit(...)` returns immediately and the HTTP response does not wait for the notification (or calendar) fan-out. A **durable event outbox** sits behind the bus as a secondary backstop, but **persistence and re-dispatch alike are gated on `EVENT_OUTBOX_WORKER=true`, which is OFF by default**. `backstopEnqueue` returns immediately when the flag is unset (`eventBus.ts:63-67`), because the worker is the only thing that drains rows and its sweep the only thing that prunes them. The practical consequence: in the default deployment the live in-process emit is the sole dispatch path and a listener that fails leaves no durable trace. An admin-only `GET /api/admin/outbox-health` route surfaces the backlog when the worker is on (`admin.routes.ts:51-62`).

With the worker on, every event is dispatched at least twice (live, then again by the worker, which claims every `pending` row), so every listener must be idempotent. The calendar listeners were the named blocker and are now idempotent (their create paths resolve an existing mapping first; see the note at `eventBus.ts:36-56`), but enabling the worker is still a deliberate, watched change. See *What Can Be Improved* #1.

## Key Takeaways

- **One shared bus drives the feature.** `backend/src/shared/events/eventBus.ts` wraps a Node `EventEmitter` (max 50 listeners, `:17-18`). Event-name constants live in `backend/src/shared/events/eventTypes.ts`. The canonical payload shape (`entityData` / `previousData`) is documented in the bus header (`eventBus.ts:3-16`) and all task producers honor it, including bulk, recurrence, and cascade paths.
- **Emit is detached and uniform.** Every notification producer calls plain `eventBus.emit(...)`, which fans out synchronously and returns without awaiting the async listeners. The task writes emit detached (`tasks.service.ts:219,329,350`; bulk at `:518,539,572`). `emitAsync` still exists (`eventBus.ts:91-98`) but no notification producer uses it.
- **Subscribers register by import side effect.** `app.ts:140-157` `require()`s every `*.events.ts` file once; each calls `eventBus.on(...)` at module top level. Registration *is* the import; there is no registry. `notifications.events.ts` is required at `app.ts:156`; the worker is started at `app.ts:161`.
- **Everything outbox-related is gated on `EVENT_OUTBOX_WORKER === 'true'`, including persistence.** `backstopEnqueue` short-circuits when the flag is off (`eventBus.ts:67`), as do `startOutboxWorker` (`eventOutbox.ts:243-244`) and `runCleanupSweep` (`:183-184`). `getOutboxHealth` (`:158-175`) is un-gated and reports `workerEnabled` so the admin route can say why the counts are zero. **With the flag off, the default, nothing is written, nothing is retried, and the live emit is the only dispatch.**
- **At-least-once retry is made safe by a hash-keyed atomic dedupe.** Each notification gets a `dedupe_hash`: md5 of its visible payload (type, title, body, entity type and id), or of an explicit `dedupeKey` when the caller wants coarser collapsing (`notifications.repository.ts:71-91`). `createMany` (`:169-217`) runs a 60s sliding-window pre-check on that hash (`findRecentDuplicatesForUsers`, `:119-131`), one multi-row `insert ... on conflict do nothing` against the partial unique index `notifications_dedupe_uq (law_firm_id, user_id, dedupe_hash, dedupe_bucket)`, and a recovery select for any row the index suppressed (`:139-150`). A retry re-sends a byte-identical payload and collapses; two genuinely different notifications about one entity both land. Message notifications pass the conversation as `dedupeKey`, so a burst stays one bell item; mentions do not.
- **`create()` is the batched path with one recipient.** It calls `createMany(lawFirmId, [userId], data)` and returns `row || null` (`notifications.repository.ts:219-224`); the recovery step means a real row always comes back.
- **The badge and dropdown are pushed over Supabase Realtime.** `useNotificationsRealtime` keeps one refcounted channel per user subscribed to `postgres_changes` on `notifications` filtered `user_id=eq.<uid>` and invalidates the count and feed caches on a short debounce (`useNotificationsRealtime.ts:72-74,105-112`). RLS (`notifications_realtime_select`, `90_platform.sql:49-57`) limits the stream to the user's own rows; the JWT comes from `GET /api/messaging/realtime-token` (`messaging.routes.ts:698-715`). The `/count` and `/feed` React Query polls remain as a 10-minute, foreground-only backstop (`useNotifications.ts:18-19,44-45`). `markRead`/`markAllRead` apply optimistic cache updates with rollback (`useNotifications.ts:54`).
- **Two other writers insert rows directly.** The client file-share digest (`files/shareNotifications.service.ts:130`) and a document-request listener (`documentRequests.events.ts:67`) call `notificationsRepo.create` for portal clients, read back through the client-portal bell endpoints. They share the table and the dedupe; see the Files and Clients feature docs.
- **Rows age out.** `purgeOld` deletes read notifications older than 90 days and anything older than 365 days, in 5000-row batches (`notifications.repository.ts:372-389`), from the reminders cron pass (`app.ts:598-602`).

---

## How It Works

### Entry Points

**Backend HTTP routes** (all under `/api/lawfirms/:lawFirmId/...`):

| Method/Path | Handler | File:line |
|---|---|---|
| `GET /notifications` | list, cursor-paged via `?before=` / `beforeId`, filterable by `unreadOnly` and `types` | `notifications.routes.ts:20` |
| `GET /notifications/count` | unread count | `notifications.routes.ts:36` |
| `GET /notifications/feed` | list + unread count in one call | `notifications.routes.ts:46` |
| `POST /notifications/mark-all-read` | mark all read | `notifications.routes.ts:60` |
| `POST /notifications/:notificationId/read` | mark one read | `notifications.routes.ts:70` |
| `POST /notifications/:notificationId/unread` | mark one unread | `notifications.routes.ts:82` |
| `DELETE /notifications/:notificationId` | delete one | `notifications.routes.ts:94` |

Every route runs `verifyToken` then `requireFirmMembership` (`notifications.routes.ts:14-17`).

**Event-bus entry points** (how the feature actually runs, not via HTTP):

- Notification listeners: `notifications.events.ts:133` (TASK_CREATED), `:162` (TASK_UPDATED), then the message, matter, invoice, signing, role and note listeners through `:664`.
- Outbox worker: `eventOutbox.ts:243` `startOutboxWorker()`, invoked once at boot (`app.ts:161`).
- Admin diagnostics: `GET /api/admin/outbox-health` (`admin.routes.ts:59`, admin-only through the router's `requireIsAdmin`) → `getOutboxHealth()`.

**Frontend entry points:**

- Query hooks (`frontend/src/hooks/notificationHooks/useNotifications.ts`): `:11` (`useNotificationsFeed`, `/feed`), `:35` (`useUnreadCount`, `/count`), `:54` (`useNotificationActions`).
- Realtime: `frontend/src/hooks/notificationHooks/useNotificationsRealtime.ts` (Supabase channel, cache invalidation, new-row listeners for the toaster).
- Service: `frontend/src/services/notifications.service.ts` (`list:70`, `getUnreadCount:87`, `getFeed:94`, `markRead:105`, `markUnread:115`, `markAllRead:125`, `remove:135`).

### The Event Bus

`backend/src/shared/events/eventBus.ts`. A Node `EventEmitter` with `setMaxListeners(50)` (`:17-18`). The native `emit` is preserved and wrapped so the live synchronous fan-out happens **first and unchanged**, then `backstopEnqueue` is called (`:84-89`). `backstopEnqueue` (`:63-81`) returns immediately unless `EVENT_OUTBOX_WORKER === 'true'`, skips payloads carrying the `FROM_OUTBOX` marker (`:61`), lazily `require`s `eventOutbox`, and fire-and-forgets `enqueue(...)`. An `emitAsync` variant (awaits all listeners via `Promise.allSettled`, then enqueues) still exists (`:91-98`) but is not used by any notification producer.

**How subscribers register.** Each `*.events.ts` module calls `eventBus.on(EVENT, handler)` at the top level; they are activated only because `app.ts:140-157` imports them once at boot. A module never `require()`d never subscribes. The bus is a singleton (Node module cache), so every producer and listener shares one emitter.

**Detached emit (the consistent model).** All notification producers call plain `eventBus.emit(name, payload)`:

- Single task create/update/delete: `tasks.service.ts:219,329,350`. Create emits only when the task has a due date or assignees and `skipCalendarEvent` is not set (`:212-214`).
- Bulk task writes: `tasks.service.ts:518,539,572`.
- Matter-delete → task cascade: `tasks.events.ts:37`.
- Recurrence: `taskRecurrence.service.ts:208`.

**Consequence of detached emit:** the request returns before listeners run, so a notification insert that throws is invisible to the caller (each handler self-logs and swallows). With the worker flag off, the default, no outbox row exists, so the event is not recoverable either. See *What Can Be Improved* #3.

**Error isolation.** Every listener body is wrapped in its own `try/catch` that only logs (e.g. `notifications.events.ts:155-157`), so one failing handler never breaks another or the emitting request.

**Payload-key consistency.** Every task producer passes the full post-write entity as `entityData` and, on updates, a `previousData: { assignedTo }` snapshot for the assignee diff, including the bulk, recurrence and cascade paths.

### The Outbox Durability Backstop (worker-gated, OFF by default)

`backend/src/shared/events/eventOutbox.ts` plus the shim in `eventBus.ts`. The live in-process emitter stays the primary path; the outbox exists only when `EVENT_OUTBOX_WORKER === 'true'` (`FLAG_ENABLED`, `eventOutbox.ts:56`). Its header (`:1-47`) records two corrections to earlier claims: the worker re-dispatches every row, not only failures, and the calendar listeners are now idempotent.

**Enqueue path.** `enqueue` (`eventOutbox.ts:108-130`) inserts `(law_firm_id, event_type, payload)` with the marker stripped (`sanitizePayload`, `:132-138`) and logs rather than throws on failure. It can run inside a caller-supplied transaction, but no producer passes one, so the row is written after the producer's own commit.

**Worker.** `startOutboxWorker` (`:243`) is a no-op with the flag off; otherwise it polls on a `setInterval` (default 30s, `EVENT_OUTBOX_POLL_MS`, `:63,268`) and registers a shutdown hook. `processBatch` (`:310-399`) first runs a cheap existence probe whose predicate is kept a superset of the claim, then claims up to `CLAIM_BATCH_SIZE` (20) rows in a short transaction with `for update skip locked`, flipping them to `processing` and stamping `processed_at` as the lease start. Eligible rows:
- `pending`;
- `failed` under `MAX_ATTEMPTS` (5) whose exponential backoff (`EVENT_OUTBOX_BACKOFF_MS × 2^attempts`) has elapsed;
- `processing` whose lease (`PROCESSING_LEASE_MS`, 5 min, `:76`) has expired, i.e. abandoned by a crashed worker.

The connection is released before dispatch, and rows are dispatched with bounded concurrency (`EVENT_OUTBOX_DISPATCH_CONCURRENCY`, default 4, `:69`). Within one row the listeners run in sequence, so that value is also the peak number of listener chains in flight.

**Dispatch.** `dispatchRow` (`:401`) refuses a row whose `law_firm_id` disagrees with its payload, re-invokes every listener for the event one after another with the `FROM_OUTBOX` marker set (a throwing listener does not stop the rest), and marks the row `done` or `failed` (`attempts++`, `last_error` truncated to 2000 chars). The terminal write is fenced on the claim's `xmin` lease token, so a worker whose lease was reclaimed cannot overwrite a newer attempt. Rows that exhaust `MAX_ATTEMPTS` stay `failed` as dead-letter.

**Loop prevention.** The marker is `Symbol.for('paralegix.eventOutbox.fromOutbox')` in both files (`eventBus.ts:61`, `eventOutbox.ts:60`), so a re-dispatch never re-enqueues.

**Housekeeping.** `runCleanupSweep` (`:181-235`) is flag-gated and called from `POST /api/cron/housekeeping` (`app.ts:751`); the old hourly timer was removed because Cloud Run gives a background timer no CPU. It deletes `done` rows older than `DONE_RETENTION_MS` (7 days) and stale `pending` / `processing` / exhausted `failed` rows older than `FAILED_RETENTION_MS` (30 days), then logs a `DEAD-LETTER` line with an inspection query when any rows are exhausted. `getOutboxHealth` (`:158-175`) is un-gated and returns `{ deadLetter, retryable, processing, pending, workerEnabled }`.

### Data Flow: Event → Notification → Badge

Concrete path for "assign a teammate to a task" (single update):

1. `PATCH` task → `tasks.service.ts:329` emits (detached) `TASK_UPDATED` with `entityData: updated` and `previousData: { assignedTo }`. The response returns immediately.
2. The bus invokes the listener at `notifications.events.ts:162`. Guard: skip if no `entityData`/`lawFirmId`.
3. `notifyNewAssignees` (`notifications.events.ts:116-128`) normalizes the new and previous assignee arrays, drops the acting user and anyone already assigned, and calls `createNotifications` once for all remaining recipients with the payload from `buildPayload()`.
4. `createNotifications` (`notifications.service.ts:140-156`) drops recipients who muted `taskAssigned` (one batched preferences read via `settingsService.getNotificationPrefsForUsers`), then `notificationsRepo.createMany` (`notifications.repository.ts:169-217`) hashes the payload, skips anyone with an identical row in the last 60s, inserts the rest in one statement with `on conflict do nothing`, and recovers any row the index suppressed. Non-UUID `entityId`/`matterId` are coerced to `null` (`:198-199`).
5. Frontend: the Realtime `INSERT` reaches the assignee's open tabs and, after the debounce, the count and feed queries refetch (`useNotificationsRealtime.ts:72-74,105-112`). Without Realtime, the 10-minute poll catches up.
6. Clicking an item calls `markRead`, which optimistically flips the item read in both the feed and count caches (with rollback on error) before invalidating to reconcile (`useNotifications.ts:54`).

### The `buildPayload()` callback

`notifyNewAssignees` (`notifications.events.ts:116-128`) calls `buildPayload()` **once, with no arguments**, and passes the result to a single batched `createNotifications` for every new assignee; each caller supplies a zero-arg arrow (`:142`, `:171`). The comment above it (`:100-115`) states the payload is identical for every recipient today and that a per-recipient variant would take the assignee id.

### Data Model

**`notifications`** (`backend/db/schema/90_platform.sql:5-24`):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `law_firm_id` | uuid FK → law_firms | tenant scope, `on delete cascade` |
| `user_id` | text FK → users | recipient (Firebase UID), `on delete cascade` |
| `type` | text | e.g. `task_assigned`, `mention`, `message`, `matter_added`, `invoice_paid`, `signing_completed`, `member_role_changed` (free-form) |
| `title`, `body` | text | display strings |
| `read` | boolean | default false |
| `entity_type` | text | CHECK `'task' \| 'matter' \| 'invoice' \| 'message' \| 'note' \| 'file'`; the event listeners emit `task`, `message`, `matter`, `invoice` (or null), and the file-share digest emits `file` |
| `entity_id`, `matter_id` | uuid | nullable; deep-link targets |
| `action_url` | text | absolute URL built from `FRONTEND_URL` |
| `created_by` | text FK → users | actor, `on delete restrict` |
| `created_at` | timestamptz | default now(); the list cursor renders it with microseconds |
| `dedupe_bucket` | bigint | unix-minute written at insert |
| `dedupe_hash` | text | md5 of the visible payload or the caller's `dedupeKey` (`notifications.repository.ts:84-91`) |

Indexes: `notifications_unread_idx on (user_id, created_at desc) where not read`; `notifications_user_idx on (law_firm_id, user_id, created_at desc)` (covers `findForUser`); the partial unique **`notifications_dedupe_uq`** on `(law_firm_id, user_id, dedupe_hash, dedupe_bucket) where dedupe_hash is not null` (`:37-39`); `notifications_entity_idx` for entity-delete cleanup; `notifications_created_at_idx` for the retention purge (`:25-44`). The table has RLS enabled with a uid-match select policy for the `authenticated` Realtime role, `replica identity full` so deletes sync, and is added to the `supabase_realtime` publication (`:49-64`). The backend writes as `postgres` and bypasses RLS.

**`event_outbox`** (`backend/db/schema/90_platform.sql:360-379`):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `law_firm_id` | uuid | nullable (denormalized from payload, **no FK by design**) |
| `event_type` | text | bus constant value, e.g. `task.created` |
| `payload` | jsonb | the emitted payload (Symbol marker stripped) |
| `status` | text | CHECK `in ('pending','processing','done','failed')` |
| `attempts` | int | default 0 |
| `last_error` | text | last dispatch error (truncated to 2000 chars) |
| `created_at` | timestamptz | |
| `processed_at` | timestamptz | doubles as backoff anchor, processing-lease start, and retention key |

Indexes: `event_outbox_status_created_idx on (status, created_at)` (claim query); `event_outbox_status_processed_idx on (status, processed_at)` (retention sweep); `event_outbox_law_firm_idx on (law_firm_id)` (per-firm inspection) (`90_platform.sql:373-381`).

### Key Logic & Rules

- **Events consumed:** `notifications.events.ts` consumes `TASK_CREATED`, `TASK_UPDATED`, `TASK_DELETED`, `MATTER_CREATED`, `MATTER_DELETED`, `MATTER_MEMBERS_UPDATED`, `MESSAGE_SENT`, `MESSAGES_READ`, `INVOICE_PAYMENT_RECEIVED`, `SIGNING_COMPLETED`, `SIGNING_DECLINED`, `SIGNING_PARTICIPANT_REMOVED`, `MEMBER_ROLE_CHANGED`, and the matter/task/client note-created and note-reply-added events, each gated through `filterByPreference` on its own category. Other modules' listeners (leads, document requests, signing, subscriptions, trust) call `createNotifications` themselves.
- **Direct writers bypass the listeners.** The client file-share digest (`FILE_SHARED` → `files.events.ts` → `shareNotifications.service.ts:130`) and a document-request listener (`documentRequests.events.ts:67`) call `notificationsRepo.create` directly for a **portal client's** uid, read back through the client-portal bell endpoints (see the Files and Clients feature docs). The hash dedupe protects these writes too.
- **TASK_CREATED fires for assignee-bearing tasks even without a due date.** The guard is `(created.dueDate || hasAssignees) && !skipCalendarEvent` (`tasks.service.ts:212-214`); the calendar listener no-ops on a task with no due date.
- **Dedupe has two layers.** (1) The new-assignee diff in `notifyNewAssignees` suppresses re-notifying users already in `previousData.assignedTo`. (2) The repository's hash dedupe (see Key Takeaways): a sequential retry is caught by the 60s pre-check whatever minute it lands in, and concurrent retries in the same minute collapse on the unique index. A legitimately new notification with different text always lands.
- **Read-state:** boolean `read` flag; `markRead`, `markUnread`, `markAllRead` (firm-wide for that user), `markReadForConversation` (on `MESSAGES_READ`), and `remove` (`notifications.repository.ts:280,288,319,305,327`). Entity and matter deletes clean up through `removeForEntity` / `removeForMatter` (`:342,356`). No "seen" vs "read" distinction.
- **Tenancy:** every notification query is scoped by `law_firm_id AND user_id`. The router checks membership before any handler (`notifications.routes.ts:14-17`) and the service asserts it again (`notifications.service.ts:53,84,90,106,112,118,124`).
- **Permissions:** notifications require only membership, no RBAC permission code.
- **UUID coercion:** inserts drop non-UUID `entityId`/`matterId` (`notifications.repository.ts:198-199`), and `markRead`/`markUnread` treat a malformed `notificationId` as a no-op rather than an error (`:281,289`).

### Dependencies

- Node core `events.EventEmitter` (the bus).
- Postgres through the audited Drizzle contexts (`systemQuery`, `scopedInsertManyOnConflictDoNothing`) for notifications, and `infrastructureRootSql` / `withDrizzleTransaction` for the outbox (`eventOutbox.ts:48`).
- `assertLawFirmMembership` (`shared/utils/membership.ts`); `settingsService.getNotificationPrefsForUsers` for category muting.
- Supabase Realtime for the push path (frontend `lib/supabase/realtimeClient.ts`; backend `SUPABASE_JWT_SECRET` signs the token).
- Frontend: React Query (`@tanstack/react-query`), `apiFetch` (token refresh).
- Env vars: `FRONTEND_URL` (`notifications.service.ts:5`) for `actionUrl`; `EVENT_OUTBOX_WORKER` (gates enqueue, the worker and the sweep) and tunables `EVENT_OUTBOX_POLL_MS` (30000), `EVENT_OUTBOX_BATCH` (20), `EVENT_OUTBOX_DISPATCH_CONCURRENCY` (4), `EVENT_OUTBOX_MAX_ATTEMPTS` (5), `EVENT_OUTBOX_BACKOFF_MS` (30000), `EVENT_OUTBOX_LEASE_MS` (5 min), `EVENT_OUTBOX_RETENTION_MS` (7 days), `EVENT_OUTBOX_FAILED_RETENTION_MS` (30 days), `EVENT_OUTBOX_CLEANUP_MS` (`eventOutbox.ts:63-88`).

### Example: A Concrete Event → Notification

Assigning a teammate to a task:

1. `PATCH` task with a new `assignedTo` → `tasks.service.ts:329` emits (detached) `TASK_UPDATED` with `entityData: updated` and `previousData: { assignedTo }`. With the worker on, an `event_outbox` row is also persisted.
2. `notifications.events.ts:162` fires; `notifyNewAssignees` skips the prior assignees and the actor and inserts one row per newly added user in one statement:
   ```
   type: 'task_assigned'
   title: 'Task assigned to you'
   body: 'You were assigned to "Draft retainer letter"'
   entity_type: 'task', matter_id: <matterId>
   action_url: http://localhost:3000/lawfirm/<firm>/tasks/<taskId>
   ```
3. The Realtime `INSERT` reaches the assignee's open tabs and the bell refetches `/count` after a short debounce (or at the next 10-minute poll without Realtime); clicking the item optimistically marks it read and navigates to the deep link.

---

## What Can Be Improved

Ordered by impact. Fixed and dropped: the `emit`/`emitAsync` inconsistency; the non-atomic dedupe; outbox retention; the dead-letter HTTP surface; unbounded `pending` growth from un-gated enqueue; polling-only badge latency (Supabase Realtime now pushes inserts); non-idempotent calendar listeners as the outbox blocker; `file_shared` digests with different content collapsing into one bell row (the dedupe key is now the payload hash, not the entity).

1. **Enabling the outbox worker double-dispatches every event, so every listener must be idempotent, including ones that send email.** The claim selects every `pending` row and every emit enqueues one (`eventOutbox.ts:310-399`), so with `EVENT_OUTBOX_WORKER=true` each event runs live and then again from the worker. Notifications absorb it (hash dedupe) and the calendar create paths now resolve an existing mapping first, but a listener with an external side effect repeats it: for example the subscription payment-failed and trial-ending listeners email the firm's admins (`subscriptions.events.ts:73-125`), and a re-dispatch would send the email again. *Fix:* audit every listener with an external side effect before enabling the worker, or mark rows whose live dispatch fully succeeded so the worker skips them.

2. **`enqueue` runs fire-and-forget after the producer's commit, not inside its transaction.** `backstopEnqueue` enqueues after the live emit, which is after the producer's write committed (`eventBus.ts:63-81`). `enqueue` accepts an in-transaction `client` (`eventOutbox.ts:108-130`) but no producer passes one, so a crash between commit and enqueue loses the row. Only matters once the worker is on.

3. **With the worker off, the default, a failed listener is lost without a durable trace.** `backstopEnqueue` persists nothing when `EVENT_OUTBOX_WORKER !== 'true'` (`eventBus.ts:67`). The notification listeners wrap their bodies in try/catch and log, so their failures are at least visible in logs; a listener elsewhere without its own try/catch surfaces as an unhandled rejection. *Fix:* catch and log listener rejections centrally at the bus.

4. **Concurrent duplicates that straddle a minute boundary can both insert.** The unique index keys on `dedupe_bucket`, and the recovery select only looks in the current bucket (`notifications.repository.ts:139-150,190-203`). A sequential retry is caught by the 60s pre-check, but two concurrent inserts of the same payload landing either side of a minute boundary both pass the pre-check and fall in different buckets. The prior-bucket probe that once covered this went away with the move to hash keys. Low impact; only reachable with the worker on.

5. **`event_outbox.law_firm_id` has no FK, so a deleted firm's outbox rows aren't cascaded.** Intentional (the column is a denormalized copy of the payload's firm id), and the sweep ages rows out after 30 days when the worker is running. In a worker-off deployment nothing is written, so this is theoretical today.

6. **The notifications Realtime token lives in the messaging module.** The bell depends on `GET /api/messaging/realtime-token` (`messaging.routes.ts:698-715`), whose comments describe only messaging RLS. It is identity-scoped and works, but a shared realtime route (or at least a comment naming the notifications policy) would stop a messaging refactor from breaking the bell.
