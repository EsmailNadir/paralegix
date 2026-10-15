const EventEmitter = require('events');

/**
 * Canonical domain-event payload shape (all *_CREATED / *_UPDATED / *_DELETED events):
 *   {
 *     lawFirmId,            // tenant scope (always present)
 *     <entity>Id,           // e.g. taskId (the affected row's id)
 *     entityData,           // the full current entity (post-write); listeners read this
 *     previousData,         // (UPDATE only) prior entity snapshot for diffing (e.g. { assignedTo })
 *     userId,               // the acting user (or 'system')
 *     matterId,               // (when matter-scoped)
 *     timeZone,             // acting user's tz, for time-aware listeners
 *   }
 * Producers and listeners MUST agree on `entityData`/`previousData`. Do not use ad-hoc
 * per-domain keys (e.g. `taskData`/`previousAssignedTo`) or listeners silently no-op.
 */
const bus = new EventEmitter();
bus.setMaxListeners(50);

// --- Durability backstop (additive) -------------------------------------------
// When the outbox WORKER is enabled, every emit is ALSO persisted to the
// event_outbox table so a durable, replayable record exists and the worker can
// re-dispatch any rows whose async listeners were lost to a crash/transient
// error. This is best-effort and fire-and-forget: the synchronous in-process
// dispatch below happens FIRST and unchanged, and an outbox failure never breaks
// the live emit.
//
// PERSISTENCE IS TIED TO THE WORKER (EVENT_OUTBOX_WORKER === 'true'): the worker
// is the only thing that drains rows (re-dispatch) AND the only thing that prunes
// them (the retention sweep). With the flag OFF there is no consumer and no
// pruner, so persisting would be pure write-amplification with unbounded `pending`
// growth and no replay benefit. A queue with no reader. So enqueue is skipped
// entirely when the worker is off, and the live in-process emit is the sole
// dispatch path (the original behavior). Operators enable the worker in prod to
// turn on durable at-least-once retry.
//
// DOUBLE-DISPATCH WARNING (read before enabling the worker): the worker claims
// every `pending` row, and every emit enqueues a fresh `pending` row. So the
// worker re-dispatches EVERY enqueued event, not just the ones whose listeners
// failed. Combined with the live in-process emit, that means each event is
// dispatched AT LEAST TWICE whenever the worker is on. Listeners must therefore
// be idempotent, always, not merely on a retry path.
//
// The calendar listeners were the named blocker and no longer are: the create
// paths in google.service and outlook.service now resolve an existing mapping
// before posting, so a re-dispatch is a no-op rather than a second calendar
// entry (tests/calendar/calendarEventListeners.test.ts). The delete-cascade
// listeners were audited for the same property in
// tests/events/deleteCascades.test.ts.
//
// That removes the reason this warning said the worker must stay off. It does
// not by itself mean the flag is safe to flip: the outbox worker's own retry,
// backoff and dead-letter behaviour is covered by
// tests/events/eventOutbox.test.ts, and enabling it should still be a
// deliberate, watched change.
//
// eventOutbox is required lazily (inside the helper) to avoid a require cycle
// (eventOutbox requires the db layer which is heavy, and the worker requires this
// bus back). The Symbol marker on worker-redispatched payloads makes those
// re-emits skip enqueue so the worker can't create an infinite outbox loop.
const FROM_OUTBOX = Symbol.for('paralegix.eventOutbox.fromOutbox');

function backstopEnqueue(eventName: any, payload: any) {
  // No worker => no consumer and no pruner; skip persistence entirely so we don't
  // write rows nobody drains and nobody sweeps (avoids unbounded `pending` growth
  // and per-emit write-amplification). Enabling the worker turns durability on.
  if (process.env.EVENT_OUTBOX_WORKER !== 'true') return;
  // Worker-originated re-dispatch must NOT be re-enqueued (infinite loop guard).
  if (payload && typeof payload === 'object' && payload[FROM_OUTBOX]) return;
  try {
    // Lazy require: breaks the eventBus <-> eventOutbox cycle.
    const { enqueue } = require('./eventOutbox');
    // Fire-and-forget: do not await, do not add latency to the request path.
    Promise.resolve()
      .then(() => enqueue(eventName, payload))
      .catch((err) => console.error('[eventBus] outbox enqueue failed (non-fatal):', err.message));
  } catch (err: any) {
    // Never let the backstop break a live emit.
    console.error('[eventBus] outbox backstop error (non-fatal):', err.message);
  }
}

// Preserve the native synchronous emit exactly, then best-effort enqueue.
const nativeEmit = bus.emit.bind(bus);
(bus as any).emit = function emit(eventName: string, payload: unknown) {
  const result = nativeEmit(eventName, payload); // live path: unchanged, first
  backstopEnqueue(eventName, payload);
  return result;
};

(bus as any).emitAsync = async function emitAsync(this: any, eventName: string, payload: unknown) {
  const listeners = this.listeners(eventName);
  await Promise.allSettled(
    listeners.map((listener: any) => Promise.resolve().then(() => listener(payload)))
  );
  // Live awaiting semantics above are unchanged; enqueue after, fire-and-forget.
  backstopEnqueue(eventName, payload);
};

// `export =` rather than a named export: the module's value IS the singleton,
// and every consumer does `const eventBus = require('.../eventBus')`.
export = bus;
