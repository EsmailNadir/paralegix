---
paths:
  - "backend/src/**/*.events.ts"
  - "backend/src/shared/events/**"
---

## Event Bus

```js
// Emit from service:
eventBus.emit(X_CREATED, { lawFirmId, entityId: created.id, entityData: created, userId, timeZone: timezone });

// Listen in *.events.ts — always async, always try-catch:
eventBus.on(X_DELETED, async ({ lawFirmId, entityId }) => {
  try { /* cascade logic */ }
  catch (err) { console.error('domain.events X_DELETED failed:', err); }
});
```

Event constants in `backend/src/shared/events/eventTypes.ts`. Format: `MODULE_ACTION` (e.g. `TASK_DELETED`).

**Durable outbox backstop.** The synchronous in-process `EventEmitter` is and stays the primary
dispatch path. When `EVENT_OUTBOX_WORKER === 'true'`, `shared/events/eventOutbox.ts` ALSO
persists every emit to the `event_outbox` table (fire-and-forget, so it adds no request
latency) and a worker dispatches those rows, with capped attempts and exponential backoff;
rows past `MAX_ATTEMPTS` stay `status = 'failed'` as a dead letter. With the flag off there is
no enqueue, no worker, and no retention sweep, so the live emit is the only path. The worker is
tuned by the `EVENT_OUTBOX_*` env vars.

**The worker re-dispatches EVERY enqueued event, not only the ones that failed.** Every emit
enqueues a fresh `pending` row and the claim's first branch is a bare `status = 'pending'`;
nothing records whether the live listeners succeeded, so the worker cannot condition on it.
With the worker on, each event is therefore dispatched AT LEAST TWICE, always, not just after
a failure. A re-dispatch also re-runs ALL listeners for that event, not the one that threw.

That makes listener idempotency a universal requirement rather than a rare-path concern. The
same warning, with the same reasoning, is at the top of `shared/events/eventBus.ts`.

**Dispatch width.** The worker runs `EVENT_OUTBOX_DISPATCH_CONCURRENCY` (4) rows at once, and
`dispatchRow` runs one row's listeners **in sequence**, each in its own `try`. Do not turn that
back into `Promise.allSettled`: rows times listeners (e.g. 4 x 4 on `CLIENT_DELETED`) oversubscribes
the per-instance pool (`PG_POOL_MAX`, sized in `backend/src/shared/database/connectionBudget.ts`). A throwing listener still does not stop the rest, and the
first failure in registration order is the row's `last_error`. Coverage is the "dispatch width"
describe block in `backend/tests/events/eventOutbox.test.ts`.

**With the flag off, nothing is persisted.** `backstopEnqueue` returns before the insert
(`eventBus.ts:67`), `startOutboxWorker` and `runCleanupSweep` return early, and no producer in
`src/` calls `enqueue` with a transaction client. So the outbox is not a record of every emit,
and a cron route cannot drain it as a backstop unless the flag is on.

**Lease fencing on the terminal write.** A claimed row's `processing` lease can be reclaimed by
another worker once `PROCESSING_LEASE_MS` elapses (the crash-recovery path). If the original
worker was merely slow rather than dead, its terminal write can still land after the reclaim.
`dispatchRow`'s two terminal writes are fenced against this with `xmin`, Postgres's own per-tuple
version stamp: the claim's `returning` captures `xmin::text as lease_token`, and both the success
and failure writes require `xmin = $n::text::xid` to match. A write that loses the race (the row
was reclaimed and already completed by someone else) matches zero rows, logs a warning, and does
nothing further, instead of double-incrementing `attempts` or rolling it backward below a newer
failure and silently un-dead-lettering a row that had genuinely exhausted `MAX_ATTEMPTS`. Coverage
is the "lease fencing" describe block in `backend/tests/events/eventOutbox.test.ts`.

The calendar listeners were the named blocker on enabling the worker and no longer are: the
create paths resolve an existing mapping before posting, so a re-dispatch is a no-op rather than
a second calendar entry. Coverage lives in `backend/tests/events/eventOutbox.test.ts` (the worker's own
retry, backoff and dead-letter contract), `backend/tests/events/deleteCascades.test.ts` (the cascades
under a re-emit) and `backend/tests/calendar/calendarEventListeners.test.ts` (the calendar create paths).
Enabling the flag is still a deliberate, watched change rather than a default.

