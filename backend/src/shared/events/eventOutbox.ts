/**
 * Durable event outbox: a DURABILITY BACKSTOP for the in-process event bus.
 *
 * The live, primary dispatch path is and stays the synchronous EventEmitter in
 * `eventBus.js`. This module is a SECONDARY safety net: every emitted event is
 * ALSO persisted to the `event_outbox` table (a durable record of the event),
 * and a worker re-dispatches any rows whose async listeners may have been lost
 * to a crash / transient error between the DB commit and the listener running.
 * At-least-once retry with capped attempts + backoff; rows that exhaust attempts
 * stay `status = 'failed'` (dead-letter) for inspection.
 *
 * PERSISTENCE IS TIED TO THE WORKER (`EVENT_OUTBOX_WORKER === 'true'`):
 *   - The worker is the ONLY thing that drains rows (re-dispatch) AND the only
 *     thing that prunes them (the retention sweep). So persistence and the worker
 *     are gated by the SAME flag: with the worker OFF there is no consumer and no
 *     pruner, and writing a durable row nobody reads or sweeps is pure
 *     write-amplification with unbounded `pending` growth. A queue with no
 *     reader. The eventBus shim therefore skips enqueue entirely when the worker
 *     is off, and the live in-process emit is the sole dispatch path (the original
 *     behavior, zero write-amp).
 *   - With the worker ON, every emit is persisted (one cheap INSERT, fire-and-
 *     forget so it adds no request latency), the worker re-dispatches lost rows
 *     for at-least-once RETRY, and the retention sweep keeps the table bounded.
 *
 * DOUBLE-DISPATCH / DEDUPE INTERACTION: when the worker IS on, a row is dispatched
 * twice: once by the in-process emit (live) and again by the worker re-dispatch.
 * The notification insert is idempotent (atomic dedupe in
 * notifications.repository#create), so the worker's re-dispatch collapses to the
 * existing notification rather than creating a duplicate.
 *
 * TWO CORRECTIONS TO WHAT THIS COMMENT USED TO SAY, both load-bearing.
 *
 * It claimed the worker "only re-dispatches on a failed live listener, so a
 * fully-successful live emit never gets re-run". It does not. Every emit
 * enqueues a `pending` row and the claim's first branch is a bare
 * `status = 'pending'`; nothing records whether the live listeners succeeded, so
 * the worker cannot condition on it. With the worker on, EVERY event is
 * dispatched at least twice, always. Idempotency is a universal requirement
 * here, not a rare-path one.
 *
 * It also said the calendar listeners are not idempotent by construction. They
 * were, and are no longer: the create paths in google.service and
 * outlook.service resolve an existing mapping before posting, so a re-dispatch
 * is a no-op rather than a second calendar entry. Coverage is in
 * tests/calendar/calendarEventListeners.test.ts, and the delete cascades were
 * audited for the same property in tests/events/deleteCascades.test.ts.
 */

const { infrastructureRootSql, infrastructureSql, withDrizzleTransaction } = require('../database/infrastructureQuery');
const { runWithConcurrency } = require('../utils/runWithConcurrency');

// Gates the WORKER (dispatch/retry/sweep) AND, via the eventBus shim, enqueue:
// persistence is tied to the worker because the worker is the only consumer and
// the only pruner. Off => no outbox writes at all (the live emit is the sole
// dispatch path); on => persist + retry + bounded retention.
const FLAG_ENABLED = () => process.env.EVENT_OUTBOX_WORKER === 'true';

// Marker placed on payloads re-dispatched by the worker so the eventBus emit
// shim does NOT re-enqueue them (which would create an infinite outbox loop).
export const FROM_OUTBOX = Symbol.for('paralegix.eventOutbox.fromOutbox');

// Worker tunables (env-overridable, with safe defaults).
const POLL_INTERVAL_MS = Number(process.env.EVENT_OUTBOX_POLL_MS || 30000);
const CLAIM_BATCH_SIZE = Number(process.env.EVENT_OUTBOX_BATCH || 20);
// Rows dispatched at once from one claimed batch. Each runs real listeners that
// query the database themselves, so this is bounded against the per-instance pool.
// A row runs its own listeners in sequence (see `dispatchRow`), so this value is
// also the peak number of listener chains the worker has in flight.
const DISPATCH_CONCURRENCY = Number(process.env.EVENT_OUTBOX_DISPATCH_CONCURRENCY || 4);
const MAX_ATTEMPTS = Number(process.env.EVENT_OUTBOX_MAX_ATTEMPTS || 5);
const BASE_BACKOFF_MS = Number(process.env.EVENT_OUTBOX_BACKOFF_MS || 30000);
// Lease timeout: a row stuck in 'processing' this long (because the worker that
// claimed it crashed mid-dispatch, before flipping it to done/failed) is
// considered abandoned and reclaimed by the next claim cycle. `processed_at` is
// stamped at claim time and serves as the lease start.
const PROCESSING_LEASE_MS = Number(process.env.EVENT_OUTBOX_LEASE_MS || 5 * 60 * 1000);
// Retention: 'done' rows older than this are pruned by a periodic sweep so the
// table doesn't grow unbounded once the worker is enabled. Default 7 days.
const DONE_RETENTION_MS = Number(process.env.EVENT_OUTBOX_RETENTION_MS || 7 * 24 * 60 * 60 * 1000);
// Longer retention for terminal/stale non-'done' rows: dead-lettered 'failed'
// rows (attempts exhausted) plus any 'pending'/'processing' rows old enough that
// they can never become eligible again. A separate, longer window than the 'done'
// one keeps the table bounded even with a steady dead-letter trickle, while still
// giving operators a generous inspection window for failures. Default 30 days.
const FAILED_RETENTION_MS = Number(process.env.EVENT_OUTBOX_FAILED_RETENTION_MS || 30 * 24 * 60 * 60 * 1000);
// How often the retention/dead-letter sweep runs (much rarer than the dispatch
// tick. It's housekeeping, not latency-sensitive). Default 1 hour.
const CLEANUP_INTERVAL_MS = Number(process.env.EVENT_OUTBOX_CLEANUP_MS || 60 * 60 * 1000);

/**
 * Persist an outbox row. The fire-and-forget caller (the eventBus shim) only
 * invokes this when the worker is enabled, so in normal operation persistence
 * tracks the worker. Best-effort by design. Callers in the live emit path MUST
 * NOT let an outbox failure break the request, so this swallows its own errors
 * and never throws when called fire-and-forget.
 *
 * The optional `client` arg is an explicit, deliberate opt-in: a producer can
 * write the outbox row inside its own transaction for a true transactional
 * outbox. That path is honored regardless of the flag (the caller has opted in)
 * and lets errors propagate so the producer's txn can roll back consistently.
 *
 * @param {string} eventType  event constant value (e.g. 'task.created')
 * @param {object} payload    the emitted event payload
 * @param {object} [client]   optional pg client for an in-transaction enqueue.
 *                            When passed, errors propagate; when omitted, errors
 *                            are swallowed (fire-and-forget).
 */
export async function enqueue(eventType: string, payload: unknown, client?: any) {
  const lawFirmId = payload && typeof payload === 'object' ? (payload as { lawFirmId?: string }).lawFirmId ?? null : null;
  // Strip the worker marker (a Symbol) before persisting. JSON.stringify drops
  // it anyway, but this keeps the stored payload clean.
  const safePayload = sanitizePayload(payload);

  const text = `insert into event_outbox (law_firm_id, event_type, payload)
                values ($1, $2, $3::jsonb)`;
  const params: unknown[] = [lawFirmId, eventType, JSON.stringify(safePayload ?? {})];

  if (client) {
    // In-transaction enqueue: let errors propagate so the producer txn is atomic.
    await infrastructureSql(client, text, params);
    return;
  }

  // Fire-and-forget enqueue: never throw into the live emit path.
  try {
    await infrastructureRootSql(text, params);
  } catch (err: any) {
    console.error('[eventOutbox] enqueue failed (non-fatal):', err.message);
  }
}

function sanitizePayload(payload: any) {
  if (!payload || typeof payload !== 'object') return payload;
  if (!payload[FROM_OUTBOX]) return payload;
  const clone = { ...payload };
  delete clone[FROM_OUTBOX];
  return clone;
}

let workerStarted = false;
let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerRunning = false;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
// The in-flight tick, so shutdown can await a batch that is mid-dispatch.
let currentTick: Promise<unknown> | null = null;
let cleanupRunning = false;

/**
 * Count outbox rows by health bucket: dead-letter ('failed' at/over
 * MAX_ATTEMPTS), 'failed'-but-still-retryable, 'processing', and 'pending'.
 * Read-only: usable by the worker's periodic log AND by the admin diagnostics
 * route. NOT flag-gated, so the route still works with the worker off (it just
 * reports zeros plus `workerEnabled:false`, since persistence is off too). When
 * the worker is on, a rising `deadLetter`/`pending` count signals a backlog.
 *
 * @returns {Promise<{deadLetter:number, retryable:number, processing:number, pending:number, workerEnabled:boolean}>}
 */
export async function getOutboxHealth() {
  const { rows } = await infrastructureRootSql(
    `select
        count(*) filter (where status = 'failed' and attempts >= $1)::int as dead_letter,
        count(*) filter (where status = 'failed' and attempts <  $1)::int as retryable,
        count(*) filter (where status = 'processing')::int               as processing,
        count(*) filter (where status = 'pending')::int                  as pending
       from event_outbox`,
    [MAX_ATTEMPTS]
  );
  const r = rows[0] || {};
  return {
    deadLetter: r.dead_letter || 0,
    retryable: r.retryable || 0,
    processing: r.processing || 0,
    pending: r.pending || 0,
    workerEnabled: FLAG_ENABLED(),
  };
}

/**
 * Periodic housekeeping: prune old 'done' rows (retention) and surface the
 * dead-letter backlog as a structured log line for observability. Gated on the
 * same flag as the worker, so it's off by default. Best-effort: never throws.
 */
export async function runCleanupSweep() {
  if (!FLAG_ENABLED()) return;
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    // Retention: delete 'done' rows whose processed_at is older than the window.
    const { rowCount } = await infrastructureRootSql(
      `delete from event_outbox
         where status = 'done'
           and processed_at is not null
           and processed_at < now() - ($1::bigint * interval '1 millisecond')`,
      [DONE_RETENTION_MS]
    );
    if (rowCount > 0) {
      console.log(`[eventOutbox] retention sweep pruned ${rowCount} done row(s) older than ${DONE_RETENTION_MS}ms`);
    }

    // Bound the non-'done' tail too, so a steady dead-letter trickle can't grow
    // the table without limit. Prune, on the longer FAILED_RETENTION_MS window:
    //  - dead-lettered 'failed' rows (attempts exhausted, will never retry);
    //  - stale 'pending'/'processing' rows old enough to be terminal.
    // CRITICAL: never prune a row still eligible for retry. A 'failed' row under
    // MAX_ATTEMPTS can still be reclaimed (the claim query's backoff branch), and a
    // 'processing' row under MAX_ATTEMPTS can still be reclaimed once its lease
    // expires. Both are gated on `attempts < MAX_ATTEMPTS`, so we only prune the
    // retry-eligible statuses when attempts are exhausted. 'pending' rows have no
    // retry gate (always eligible), so age alone makes them safe to drop here.
    // Any 'pending' row this old means the worker never drained it (e.g. left over
    // from a disabled period), and the long window guarantees it's truly stale.
    const { rowCount: staleCount } = await infrastructureRootSql(
      `delete from event_outbox
         where status <> 'done'
           and coalesce(processed_at, created_at) is not null
           and coalesce(processed_at, created_at) < now() - ($1::bigint * interval '1 millisecond')
           and (
             status = 'pending'
             or (status in ('failed', 'processing') and attempts >= $2)
           )`,
      [FAILED_RETENTION_MS, MAX_ATTEMPTS]
    );
    if (staleCount > 0) {
      console.log(`[eventOutbox] retention sweep pruned ${staleCount} stale non-done row(s) (dead-letter/pending/processing) older than ${FAILED_RETENTION_MS}ms`);
    }

    // Dead-letter observability: log when failed rows have exhausted retries.
    const health = await getOutboxHealth();
    if (health.deadLetter > 0) {
      console.error(`[eventOutbox] DEAD-LETTER: ${health.deadLetter} row(s) failed and exhausted ${MAX_ATTEMPTS} attempts (retryable=${health.retryable}, processing=${health.processing}). Inspect: select * from event_outbox where status='failed' and attempts>=${MAX_ATTEMPTS}`);
    }
  } catch (err: any) {
    console.error('[eventOutbox] cleanup sweep failed (non-fatal):', err.message);
  } finally {
    cleanupRunning = false;
  }
}

/**
 * Start the outbox worker loop. No-op unless EVENT_OUTBOX_WORKER === 'true'.
 * Idempotent: safe to call once at startup.
 */
export function startOutboxWorker() {
  if (!FLAG_ENABLED()) return;
  if (workerStarted) return;
  workerStarted = true;

  // Lazy require to avoid a require cycle (eventBus -> eventOutbox -> eventBus).
  const bus = require('./eventBus');

  const tick = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      await processBatch(bus);
    } catch (err: any) {
      console.error('[eventOutbox] worker tick failed:', err.message);
    } finally {
      workerRunning = false;
    }
  };

  // Held so shutdown can wait for a batch that is mid-dispatch.
  currentTick = null;
  const trackedTick = () => { currentTick = tick().finally(() => { currentTick = null; }); return currentTick; };

  // unref so the loop never keeps the process alive on its own.
  workerTimer = setInterval(trackedTick, POLL_INTERVAL_MS);
  if (workerTimer.unref) workerTimer.unref();

  // Housekeeping sweep: retention pruning of 'done' rows + dead-letter logging.
  // Runs far less often than the dispatch tick (it's not latency-sensitive).
  // The retention sweep moved to POST /api/cron/housekeeping: as a setInterval
  // it was subject to the same CPU starvation as every other background timer
  // here, so "hourly" meant "whenever traffic happens to keep an instance warm".
  // CLEANUP_INTERVAL_MS is kept only for the startup log line below.

  console.log(`[eventOutbox] worker started (poll=${POLL_INTERVAL_MS}ms, batch=${CLAIM_BATCH_SIZE}, maxAttempts=${MAX_ATTEMPTS}, retention=${DONE_RETENTION_MS}ms, cleanupEvery=${CLEANUP_INTERVAL_MS}ms)`);
}

/**
 * Stop the worker and wait for any batch already in flight.
 *
 * Must run BEFORE `pool.end()`. Without it, shutdown tears the pool out from
 * under a dispatching batch, and the damage is not just a lost batch: rows
 * already flipped to 'processing' are abandoned mid-dispatch, and — worse — a
 * row whose listeners DID run can fail its terminal 'done' write against the
 * ended pool, so after the lease expires it is claimed again and every listener
 * runs a second time. The at-least-once contract holds, but it does strictly
 * more work than it needs to, on every single deploy.
 */
export async function stopOutboxWorker() {
  if (workerTimer) { clearInterval(workerTimer); workerTimer = null; }
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
  workerStarted = false;
  if (currentTick) {
    try { await currentTick; } catch { /* the tick logs its own failures */ }
  }
}

// Registered here rather than in server.js so the hook exists exactly when the
// worker does, and stays next to the reasoning above.
require('../utils/shutdownHooks').onShutdown('event-outbox-worker', stopOutboxWorker);

/**
 * Claim and process one batch of pending rows. Each claimed row is re-dispatched
 * through the existing eventBus so the normal listeners handle it, then marked
 * done/failed with attempts++ and backoff scheduling.
 */
async function processBatch(bus: any) {
  // Cheap existence probe before taking a dedicated client. The claim below
  // needs `pool.connect()` because it runs in an explicit transaction, and on an
  // idle instance that meant checking out a connection every POLL_INTERVAL_MS to
  // discover there was nothing to do — which matters more once the per-instance
  // pool is sized down by the connection budget.
  //
  // The predicate MUST stay a superset of the claim's eligibility below. A probe
  // narrower than the claim is not an optimisation, it is a silent drop: rows the
  // claim would have taken are never looked at. That is exactly what happened to
  // the retry branch, which the probe omitted entirely, so a row whose listener
  // threw was only ever retried when some unrelated 'pending' row happened to
  // share the same tick. On an idle instance nothing was retried at all, and the
  // stranded rows are invisible to the retention sweep too (it only prunes
  // 'failed' rows with attempts exhausted). Keep the three branches here in step
  // with the three branches in the claim.
  const { rows: probe } = await infrastructureRootSql(
    `select 1 from event_outbox
      where status = 'pending'
         or (status = 'failed'
             and attempts < $2
             and processed_at is not null
             and processed_at < now() - ($3::bigint * power(2, least(attempts, 16))) * interval '1 millisecond')
         or (status = 'processing'
             and attempts < $2
             and processed_at is not null
             and processed_at < now() - make_interval(secs => $1::float8))
      limit 1`,
    [PROCESSING_LEASE_MS / 1000, MAX_ATTEMPTS, BASE_BACKOFF_MS]
  );
  if (probe.length === 0) return;

  // The claim runs in its own short transaction and the connection goes back to
  // the pool before any dispatching starts. Holding it across `dispatchRow`
  // would pin one of a deliberately small number of connections for the whole
  // batch, and the listeners themselves need connections to do their work.
  const claimed = await withDrizzleTransaction(async (client: any) => {
    // Claim eligible rows and stamp `processed_at = now()` as the lease start.
    // Eligible:
    //  - 'pending'
    //  - 'failed' rows still under MAX_ATTEMPTS whose backoff window has elapsed
    //    (processed_at here is the time of the last failure = backoff anchor).
    //  - 'processing' rows whose lease has expired (i.e. a worker crashed
    //    mid-dispatch and left the row stuck. Reclaim once it's older than
    //    PROCESSING_LEASE_MS and still under MAX_ATTEMPTS so it can't be lost.
    const res = await infrastructureSql(client,
      `update event_outbox
          set status = 'processing', processed_at = now()
        where id in (
          select id from event_outbox
           where (
             status = 'pending'
             or (status = 'failed'
                 and attempts < $1
                 and processed_at is not null
                 and processed_at < now() - ($2::bigint * power(2, least(attempts, 16))) * interval '1 millisecond')
             or (status = 'processing'
                 and attempts < $1
                 and processed_at is not null
                 and processed_at < now() - ($4::bigint * interval '1 millisecond'))
           )
           -- id tiebreaks equal timestamps so ordering is deterministic;
           -- without it two workers can disagree about which rows come first.
           order by created_at, id
           for update skip locked
           limit $3
        )
        returning *, xmin::text as lease_token`,
      [MAX_ATTEMPTS, BASE_BACKOFF_MS, CLAIM_BATCH_SIZE, PROCESSING_LEASE_MS]
    );
    return res.rows;
  });

  if (!claimed || claimed.length === 0) return;

  // Bounded parallelism rather than the old strictly-sequential loop. One slow
  // listener used to stall the entire batch inside the 5-minute lease, and a
  // batch that outlives its lease gets reclaimed and re-dispatched by another
  // worker — so slowness turned into duplicate work. Parallelising is legal
  // here because the listener contract is explicitly at-least-once and
  // idempotent (see the note in `dispatchRow`); rows in one batch are unrelated
  // to each other, so there is no ordering to preserve between them.
  //
  // Bounded rather than unbounded because each dispatch runs real listeners that
  // hit the database themselves, and the per-instance pool is small.
  await runWithConcurrency(
    claimed.map((row: any) => () => dispatchRow(bus, row)),
    DISPATCH_CONCURRENCY,
  );
}

async function dispatchRow(bus: any, row: any) {
  try {
    // `law_firm_id` is the durable routing copy captured alongside the JSON
    // payload. Do not replay a corrupt row by guessing which tenant to trust:
    // tenant-bound rows must agree with their payload before any listener sees
    // them. Rows with neither value are supported for genuinely user-global
    // events such as USER_NAME_UPDATED.
    if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
      throw new Error('outbox payload must be an object');
    }
    const rowLawFirmId = row.law_firm_id ?? null;
    const payloadLawFirmId = row.payload.lawFirmId ?? null;
    if (rowLawFirmId !== null || payloadLawFirmId !== null) {
      if (typeof payloadLawFirmId !== 'string' || rowLawFirmId !== payloadLawFirmId) {
        throw new Error('outbox tenant mismatch between row and payload');
      }
    }

    const payload = { ...row.payload, [FROM_OUTBOX]: true };
    // Re-dispatch through the live bus listeners. We intentionally invoke the
    // registered listeners here (rather than bus.emitAsync, which uses
    // Promise.allSettled and never surfaces a rejection) so the worker can tell
    // whether a listener actually failed and retry/dead-letter accordingly. The
    // FROM_OUTBOX marker prevents the emit shim from re-enqueuing this event
    // (no infinite loop); listener behavior itself is unchanged.
    //
    // IDEMPOTENCY CONTRACT (at-least-once): if ANY listener throws, the row is
    // marked 'failed' and the WHOLE row is retried later. This re-runs every
    // listener for the event, including ones that already succeeded. Listeners
    // MUST therefore be idempotent. Today's notification listener is made safe
    // by a recent-duplicate guard in notifications.repository#create (so a retry
    // does not create a second identical notification). Keep this idempotency
    // contract in mind when adding new listeners with non-idempotent side effects.
    //
    // DISPATCH WIDTH: a row's listeners run ONE AFTER ANOTHER, not in parallel.
    // `processBatch` already runs DISPATCH_CONCURRENCY rows at once, and most
    // listeners take a pool connection. Fanning each row's listeners out as well
    // multiplied the peak (4 rows x up to 4 listeners on e.g. CLIENT_DELETED was
    // about 16 chains against a 12-connection pool). Sequential listeners bound
    // the peak by the row width alone. Each listener is still isolated in its own
    // try, so one that throws (synchronously or not) does not stop the rest, and
    // the row's fate stays binary: any failure => retry the whole row.
    const listeners = bus.listeners(row.event_type);
    if (listeners.length === 0) {
      throw new Error(`No registered listener for ${row.event_type}`);
    }
    const failures: unknown[] = [];
    for (const listener of listeners) {
      try {
        await listener(payload);
      } catch (listenerErr) {
        failures.push(listenerErr);
      }
    }
    if (failures.length > 0) {
      // Surface every listener failure (not just the first) for the dead-letter
      // record. The first in registration order is the one recorded on the row.
      const reason: any = failures[0];
      if (failures.length > 1) {
        console.error(`[eventOutbox] ${failures.length} listeners failed for ${row.event_type} (id=${row.id}); first surfaced, rest:`,
          failures.slice(1).map((f: any) => (f && f.message) || String(f)).join('; '));
      }
      throw reason instanceof Error ? reason : new Error(String(reason));
    }
    // Terminal write. Deliberately on the pool rather than on the claiming
    // client: the claim transaction has long since committed, and parallel
    // dispatch needs independent connections anyway (a pg client cannot
    // multiplex). What makes that safe is the shutdown hook, which stops the
    // worker and awaits the in-flight batch BEFORE the pool closes — without it,
    // a row whose listeners had already run could fail this write against an
    // ended pool, sit until its lease expired, and then re-run every listener.
    //
    // LEASE FENCING: the `xmin = $2::text::xid` predicate ties this write to the
    // exact row version this call claimed (`lease_token`, captured from the
    // claim's `returning`). `xmin` is Postgres's own per-tuple version stamp and
    // changes on every UPDATE, so if another worker reclaimed this row (its lease
    // expired while this dispatch was still in flight) and has already recorded
    // its own outcome, the row's current `xmin` no longer matches and this write
    // touches zero rows instead of clobbering the newer attempt's result. Without
    // this, a worker that resolves very late after being reclaimed would apply
    // its terminal write unconditionally, double-incrementing `attempts` (success
    // path) or overwriting a newer attempt's higher `attempts`/`last_error` with
    // its own stale, lower snapshot (failure path), silently defeating the
    // MAX_ATTEMPTS cap the retry loop depends on.
    const { rowCount } = await infrastructureRootSql(
      `update event_outbox
          set status = 'done', attempts = attempts + 1, processed_at = now(), last_error = null
        where id = $1 and xmin = $2::text::xid`,
      [row.id, row.lease_token]
    );
    if (rowCount === 0) {
      console.warn(`[eventOutbox] stale dispatch dropped for ${row.event_type} (id=${row.id}): row was reclaimed by a newer lease before this worker's success could be recorded`);
    }
  } catch (err: any) {
    const attempts = (row.attempts || 0) + 1;
    // Dead-letter once attempts are exhausted: stays 'failed', no more retries.
    // Fenced the same way as the success path above, and for the same reason:
    // `attempts` here is computed from THIS call's claim-time snapshot, so an
    // unfenced write could roll a newer, higher attempts count backward.
    const { rowCount } = await infrastructureRootSql(
      `update event_outbox
          set status = 'failed', attempts = $2, processed_at = now(), last_error = $3
        where id = $1 and xmin = $4::text::xid`,
      [row.id, attempts, String(err && err.message ? err.message : err).slice(0, 2000), row.lease_token]
    );
    if (rowCount === 0) {
      console.warn(`[eventOutbox] stale dispatch dropped for ${row.event_type} (id=${row.id}): row was reclaimed by a newer lease before this worker's failure could be recorded`);
    } else {
      console.error(`[eventOutbox] dispatch failed for ${row.event_type} (id=${row.id}, attempts=${attempts}/${MAX_ATTEMPTS}):`, err.message);
    }
  }
}

export const _processBatch = processBatch;
export const _dispatchRow = dispatchRow;
