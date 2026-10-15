# Event Bus & Durable Outbox

How domain events flow through the in-process bus, how listeners are wired, and the
opt-in durable outbox that backstops them.

## Summary

Paralegix decouples side effects from the write that triggers them with a
lightweight **in-process event bus** (`backend/src/shared/events/eventBus.ts`, a
Node `EventEmitter`). A service finishes its write, then calls
`eventBus.emit(TYPE, { lawFirmId, ... })`; listeners registered in each module's
`*.events.ts` react — creating notifications, syncing calendars, invalidating the
permission cache, cascading deletes.

The primary dispatch path is **synchronous and in-process**: emit runs the
listeners immediately, in the same process, and this is the default everywhere. On
top of that sits an **opt-in durable outbox** (`event_outbox` table +
`eventOutbox.ts` worker) that persists every emitted event and re-dispatches rows
whose listeners may have been lost to a crash. The outbox is **off unless the
worker is enabled** (`EVENT_OUTBOX_WORKER === 'true'`), which keeps default
behavior byte-identical to a pure in-process bus.

## Key Takeaways

- **Emit in the service, listen in `*.events.ts`.** Producers call
  `eventBus.emit(TYPE, payload)`; consumers register `eventBus.on(TYPE, async
  handler)`. Listeners are **always** `async` and **always** wrapped in
  `try/catch`, because an unhandled throw would be an unhandled rejection.
- **Event constants live in one file.** `eventTypes.ts` defines every `MODULE_ACTION`
  constant (e.g. `TASK_CREATED = 'task.created'`). Never emit a raw string.
- **Payload shape is a contract.** All `*_CREATED/UPDATED/DELETED` events carry
  `lawFirmId`, an `entityId`, `entityData`, optional `previousData`, `userId`,
  optional `matterId`, and `timeZone`. Producers and listeners must agree on
  `entityData`/`previousData` or listeners silently no-op.
- **Persistence is tied to the worker.** With the worker off there is no consumer
  and no pruner, so nothing is enqueued (a queue with no reader). With it on, every
  emit is persisted, retried at-least-once, and swept for retention.
- **The outbox is a backstop, not the path.** The live in-process emit runs first
  and unchanged; the outbox enqueue is fire-and-forget and can never break a live
  emit.
- **Listeners must be idempotent.** With the worker on, every event is dispatched
  at least twice (live, then by the worker), not only the ones that failed.

## The in-process bus

`eventBus.ts` exports a single shared `EventEmitter` (max listeners raised to 50).
A service emits after its write succeeds:

```js
eventBus.emit(TASK_CREATED, {
  lawFirmId, taskId: created.id, entityData: created, userId, timeZone: timezone,
});
```

A module wires listeners in `<domain>.events.ts`, which is `require`d once at
startup in `backend/src/app.ts` (`app.ts:140`):

```js
eventBus.on(TASK_DELETED, async ({ lawFirmId, entityId }) => {
  try { /* cascade / side effect */ }
  catch (err) { console.error('domain.events TASK_DELETED failed:', err); }
});
```

The `try/catch` is mandatory: the emitter dispatches synchronously and does not
await your `async` listener, so a rejection with no local catch becomes an
unhandled promise rejection. `emit` returns after firing the native listeners; a
separate `emitAsync(TYPE, payload)` awaits all listeners via `Promise.allSettled`
when a caller genuinely needs to wait.

### Payload contract

The canonical shape is documented at the top of `eventBus.ts` (`eventBus.ts:4`):
`lawFirmId` (tenant scope, always present), the affected row's `<entity>Id`,
`entityData` (the full post-write entity — what listeners read), `previousData`
(UPDATE only, for diffing), `userId` (or `'system'`), optional `matterId`, and
`timeZone`. Do not invent ad-hoc per-domain keys (`taskData`,
`previousAssignedTo`) — a listener reading `entityData` would silently see
`undefined` and no-op.

## The durable outbox

The outbox (`backend/src/shared/events/eventOutbox.ts`) is a **durability
backstop** for the in-process bus. When enabled, each `emit` also persists the
event to the `event_outbox` table, and a worker re-dispatches rows whose async
listeners may have been lost between the DB commit and the listener running —
at-least-once retry with capped attempts and exponential backoff; rows that exhaust
attempts stay `status = 'failed'` (dead-letter) for inspection.

### Persistence is gated on the worker

Enqueue and the worker share **one flag**, `EVENT_OUTBOX_WORKER === 'true'`
(`eventOutbox.ts:56`). The reasoning: the worker is the only thing that drains rows
(re-dispatch) **and** the only thing that prunes them (retention sweep). With the
worker off, persisting rows nobody reads or sweeps is pure write-amplification with
unbounded `pending` growth — a queue with no reader. So the `eventBus` shim skips
enqueue entirely when the flag is off (`eventBus.ts:67`), and the live in-process
emit is the sole dispatch path — the original, zero-write-amp behavior. Operators
turn the worker on in production to get durable retry.

### How enqueue and dispatch work

- **Enqueue** (`eventOutbox.ts:108`) is one cheap `INSERT` into `event_outbox`
  (`law_firm_id`, `event_type`, `payload` jsonb), fired **after** the live emit and
  **fire-and-forget** so it adds no request latency and swallows its own errors.
- **The worker** (`startOutboxWorker`, `eventOutbox.ts:243`) is a no-op unless the
  flag is set. When on, it polls on an interval (`EVENT_OUTBOX_POLL_MS`, default
  30s), claims a batch (`EVENT_OUTBOX_BATCH`, default 20) of eligible rows with
  `for update skip locked`, flips them to `processing` (stamping `processed_at` as
  a lease start, `EVENT_OUTBOX_LEASE_MS`, default 5 minutes), and re-dispatches
  them through the live bus listeners, up to `EVENT_OUTBOX_DISPATCH_CONCURRENCY`
  (default 4) rows at once. A row is eligible if it is `pending`, a `failed` row under
  `MAX_ATTEMPTS` (`EVENT_OUTBOX_MAX_ATTEMPTS`, default 5) past its exponential
  backoff window, or a `processing` row whose lease expired (a crashed worker's
  abandoned claim).
- **Re-dispatch** (`dispatchRow`, `eventOutbox.ts:401`) first refuses a row whose
  `law_firm_id` disagrees with its payload's `lawFirmId`, then invokes the
  registered listeners directly, **one after another**, each in its own `try`, so
  the worker can tell whether a listener actually threw (unlike `emitAsync`, which
  never surfaces rejections). A throwing listener does not stop the ones after it.
  Any listener failure marks the whole row `failed` for retry, with the first
  failure in registration order as `last_error`; all-success marks it `done`.
  Running a row's listeners in sequence keeps the worker's peak at
  `EVENT_OUTBOX_DISPATCH_CONCURRENCY` listener chains rather than rows times
  listeners, which matters against a 12-connection per-instance pool.
- **Lease fencing:** the terminal `done`/`failed` write matches on the row's
  `xmin` captured at claim time, so a slow worker whose lease was reclaimed cannot
  overwrite the newer attempt's outcome or roll `attempts` backward.
- **Shutdown:** `stopOutboxWorker` is registered as a shutdown hook and waits for
  the in-flight batch before the pool closes, so a deploy does not abandon claimed
  rows mid-dispatch.
- **Loop guard:** re-dispatched payloads carry a `FROM_OUTBOX` `Symbol` marker so
  the emit shim does not re-enqueue them, preventing an infinite outbox loop
  (`eventOutbox.ts:60`).

### Retention sweep

`runCleanupSweep()` (`eventOutbox.ts:183`) prunes the table so it stays bounded:
`done` rows older than `EVENT_OUTBOX_RETENTION_MS` (default 7 days), plus terminal
non-`done` rows (dead-lettered `failed` rows whose attempts are exhausted, and stale
`pending`/`processing` rows) on the longer `EVENT_OUTBOX_FAILED_RETENTION_MS`
window (default 30 days). It never prunes a row still eligible for retry, and it
logs the dead-letter backlog for observability.

It runs as one step of the `POST /api/cron/housekeeping` pass (`app.ts:751`), not
on a timer: as a `setInterval` it only fired while traffic kept an instance warm.
`CLEANUP_INTERVAL_MS` survives only in the worker's startup log line.
`getOutboxHealth()` (`eventOutbox.ts:158`) reports counts by bucket and powers
`GET /api/admin/outbox-health`; it works even with the worker off (reporting
zeros plus `workerEnabled:false`).

## Trade-offs and cautions

- **In-process by default, durable by choice.** The default path has zero extra DB
  writes and the simplest possible semantics. Durability is opt-in per environment
  and additive — turning the worker on never changes what the live emit does.
- **DOUBLE-DISPATCH when the worker is on.** Every emit enqueues a `pending` row
  and nothing records whether the live listeners succeeded, so the worker
  re-dispatches **every** event, not just failed ones: each event runs at least
  twice. The notification insert is idempotent (the `dedupe_hash` check in
  `notifications.repository#create`), so a retry collapses onto the existing row.
  The calendar listeners, once the named blocker, are now idempotent too: the
  create paths in the Google and Outlook services resolve an existing mapping
  before posting (`tests/calendar/calendarEventListeners.test.ts`), and the delete
  cascades were audited for the same property
  (`tests/events/deleteCascades.test.ts`). Enabling the worker is still a
  deliberate, watched change (`eventBus.ts:37`, `eventOutbox.ts:25`). Any new
  listener with side effects must respect this at-least-once contract.
- **Transactional outbox (opt-in).** `enqueue(eventType, payload, client)` accepts
  an optional `pg` client so a producer can write the outbox row **inside its own
  transaction** for a true transactional outbox. On that path errors propagate (so
  the producer's txn can roll back atomically), regardless of the worker flag — the
  caller has explicitly opted in (`eventOutbox.ts:108`). No producer passes a
  client today.

## Adding an event

1. Add the constant to `backend/src/shared/events/eventTypes.ts` (`MODULE_ACTION`
   format).
2. Emit it from the service with the canonical payload shape.
3. Register an `async` + `try/catch` listener in the consuming module's
   `*.events.ts`, and ensure that module is `require`d in `app.ts`.
4. Make the listener idempotent: with the worker on it runs at least twice for
   every event.

## Source

- `backend/src/shared/events/eventBus.ts`: the `EventEmitter`, emit shim, payload contract
- `backend/src/shared/events/eventTypes.ts`: event constant definitions
- `backend/src/shared/events/eventOutbox.ts`: `enqueue`, worker, retry, retention sweep, health
- `backend/src/app.ts`: `*.events.ts` listener registration, `startOutboxWorker()`, and the housekeeping cron that runs the retention sweep
- `backend/src/modules/admin/admin.routes.ts`: `GET /api/admin/outbox-health`
- `backend/tests/events/eventOutbox.test.ts`: retry, backoff and dead-letter coverage
- `backend/AGENTS.md`: event bus emit/listen conventions
