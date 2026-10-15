/**
 * Durable event outbox: the flag, the enqueue shape, and the worker's retry,
 * backoff, dead-letter, lease, concurrency and retention machinery.
 *
 * `src/shared/events/eventOutbox.ts` is 429 lines of retry machinery that nothing
 * exercised. Everything it does is invisible on screen: a lost backoff turns into
 * a hot retry loop, a lost attempts cap turns into an infinite one, a lost
 * `attempts >= MAX_ATTEMPTS` guard in the retention sweep silently deletes rows
 * that were still owed a retry, and a re-dispatch that skipped the listeners that
 * already succeeded would quietly break the at-least-once contract the notification
 * dedupe is built on.
 *
 * TWO HALVES, DRIVEN DIFFERENTLY:
 *   - The ENQUEUE half is driven through a real `eventBus.emit`, because the flag
 *     gate lives in the bus shim (`backstopEnqueue`), not in `enqueue` itself. It
 *     is fire-and-forget, so these specs poll for the row rather than awaiting it.
 *   - The WORKER half is driven by seeding `event_outbox` rows in plain SQL through
 *     `testPool` and calling the exported `_processBatch(bus)` directly. Seeding by
 *     hand is the point: a fixture built by the enqueue path could not fail when
 *     the enqueue path is wrong, and it is the only way to place a row at an
 *     arbitrary status/attempts/age without sleeping through a 30-second backoff.
 *
 * The tunables are read into module-level consts at import time, so these specs
 * pin the DEFAULTS: MAX_ATTEMPTS 5, BASE_BACKOFF_MS 30000 (doubling per attempt),
 * PROCESSING_LEASE_MS 5 minutes, DONE_RETENTION_MS 7 days, FAILED_RETENTION_MS
 * 30 days. Changing one of those should turn a spec here red on purpose.
 *
 * Every age is expressed as a Postgres interval evaluated against `now()` inside
 * the insert, never as a JS timestamp, so nothing here depends on the node clock
 * agreeing with the database clock at second resolution.
 */
import { randomUUID } from 'crypto';
import { testPool, drainEvents } from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';

const eventBus = require('../../src/shared/events/eventBus');
const {
  _processBatch,
  _dispatchRow,
  runCleanupSweep,
  getOutboxHealth,
  FROM_OUTBOX,
} = require('../../src/shared/events/eventOutbox');

// The defaults these specs pin. Named so a failure reads as "the cap moved",
// not as a bare number that no longer matches.
const MAX_ATTEMPTS = 5;
const FLAG = 'EVENT_OUTBOX_WORKER';

type OutboxRow = {
  id: string;
  law_firm_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  processed_at: Date | null;
};

// ---------------------------------------------------------------------------
// Fixtures and helpers. All SQL, all through the test pool.
// ---------------------------------------------------------------------------

/**
 * Seed one outbox row directly. Ages are Postgres interval strings ('61 seconds',
 * '8 days') resolved against the database's own `now()`.
 *
 * `law_firm_id` carries no foreign key by design (it is a denormalised copy of
 * `payload.lawFirmId`), so a bare uuid is a valid tenant here and no firm fixture
 * is needed.
 */
async function seedRow(overrides: {
  eventType?: string;
  payload?: Record<string, unknown>;
  lawFirmId?: string | null;
  status?: string;
  attempts?: number;
  createdAgo?: string | null;
  processedAgo?: string | null;
  lastError?: string | null;
} = {}): Promise<string> {
  const {
    eventType = 'outboxspec.seeded',
    payload = {},
    lawFirmId: requestedLawFirmId,
    status = 'pending',
    attempts = 0,
    createdAgo = null,
    processedAgo = null,
    lastError = null,
  } = overrides;

  // Real enqueues copy the payload tenant into `law_firm_id`. Keep ordinary
  // fixtures on that valid path unless a spec explicitly supplies conflicting
  // metadata (as the tenant-corruption test below does).
  const payloadLawFirmId = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload.lawFirmId
    : undefined;
  const lawFirmId = requestedLawFirmId === undefined
    ? (typeof payloadLawFirmId === 'string' ? payloadLawFirmId : null)
    : requestedLawFirmId;
  const persistedPayload = lawFirmId !== null
    && payload && typeof payload === 'object' && !Array.isArray(payload)
    && payloadLawFirmId === undefined
    ? { ...payload, lawFirmId }
    : payload;

  const { rows } = await testPool.query<{ id: string }>(
    `insert into event_outbox
       (law_firm_id, event_type, payload, status, attempts, last_error, created_at, processed_at)
     values ($1, $2, $3::jsonb, $4, $5, $6,
             case when $7::text is null then now() else now() - $7::interval end,
             case when $8::text is null then null  else now() - $8::interval end)
     returning id`,
    [lawFirmId, eventType, JSON.stringify(persistedPayload), status, attempts, lastError, createdAgo, processedAgo],
  );
  return rows[0].id;
}

async function allRows(): Promise<OutboxRow[]> {
  const { rows } = await testPool.query<OutboxRow>(
    'select * from event_outbox order by created_at, id',
  );
  return rows;
}

async function rowById(id: string): Promise<OutboxRow> {
  const { rows } = await testPool.query<OutboxRow>('select * from event_outbox where id = $1', [id]);
  return rows[0];
}

/**
 * The exact shape `dispatchRow` receives from a real claim: row columns plus
 * `xmin::text as lease_token`, the version stamp the claim observed. Used to
 * hand-build "what a worker's own claim looked like a while ago" without
 * duplicating the claim SQL - the row is seeded directly into 'processing'
 * (same convention `seedRow` + the crash-lease specs already use for "a worker
 * already claimed this and is now stuck"), and this just reads back the token.
 */
async function claimSnapshot(id: string): Promise<{ id: string; event_type: string; payload: Record<string, unknown>; attempts: number; lease_token: string }> {
  const { rows } = await testPool.query(
    'select id, event_type, payload, attempts, xmin::text as lease_token from event_outbox where id = $1',
    [id],
  );
  return rows[0];
}

/** Push a row's backoff/lease anchor far enough into the past that it is due. */
async function makeDue(id: string, ago = '1 day'): Promise<void> {
  await testPool.query(
    'update event_outbox set processed_at = now() - $2::interval where id = $1',
    [id, ago],
  );
}

/**
 * Wait for the fire-and-forget enqueue to land.
 *
 * Used by the negative case too, deliberately: the flag-off spec waits the FULL
 * window and still finds nothing, while the flag-on spec finds its row in a few
 * milliseconds. Asserting an absence after a token `await` would prove nothing.
 */
async function waitForRows(count: number, timeoutMs = 2000): Promise<OutboxRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await allRows();
    if (rows.length >= count) return rows;
    if (Date.now() >= deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Listeners registered by a spec MUST come off the singleton bus, or they run
// again inside every later spec in this worker.
const registered: Array<[string, (payload: unknown) => unknown]> = [];
function listen(event: string, fn: (payload: any) => unknown) {
  eventBus.on(event, fn);
  registered.push([event, fn]);
  return fn;
}

let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env[FLAG];
  delete process.env[FLAG];
});

afterEach(async () => {
  // Settle before unregistering, so a listener still in flight is not torn out
  // from under the assertion of the next spec.
  await drainEvents();
  while (registered.length) {
    const [event, fn] = registered.pop()!;
    eventBus.off(event, fn);
  }
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

// ---------------------------------------------------------------------------

describe('the flag governs persistence', () => {
  // RED WHEN: the `process.env.EVENT_OUTBOX_WORKER !== 'true'` guard in
  // eventBus#backstopEnqueue is removed or inverted. The listener assertion is
  // what stops "nothing enqueued" from silently meaning "nothing happened".
  it.each([
    ['unset', undefined],
    ['false', 'false'],
    ['1', '1'],
  ])('with EVENT_OUTBOX_WORKER %s, a real emit dispatches listeners and enqueues nothing', async (_label, value) => {
    if (value === undefined) delete process.env[FLAG];
    else process.env[FLAG] = value;

    const EVENT = 'outboxspec.flag-off';
    const seen: any[] = [];
    listen(EVENT, async (payload: any) => { seen.push(payload); });

    eventBus.emit(EVENT, { lawFirmId: randomUUID(), note: 'live only' });
    await drainEvents();

    // The live in-process dispatch really ran...
    expect(seen).toHaveLength(1);
    expect(seen[0].note).toBe('live only');
    // ...and nothing was persisted, after a full wait window.
    expect(await waitForRows(1)).toHaveLength(0);
  });

  // RED WHEN: the enqueue call is dropped from the emit shim, or `enqueue` stops
  // writing. This is the other half of the pair above: same emit, flag flipped.
  it('with EVENT_OUTBOX_WORKER=true, the same emit persists a row', async () => {
    process.env[FLAG] = 'true';

    const EVENT = 'outboxspec.flag-on';
    const seen: any[] = [];
    listen(EVENT, async (payload: any) => { seen.push(payload); });

    eventBus.emit(EVENT, { lawFirmId: randomUUID(), note: 'live and durable' });
    await drainEvents();

    const rows = await waitForRows(1);
    expect(seen).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe(EVENT);
  });
});

describe('enqueue shape', () => {
  // RED WHEN: a column stops being written (event type, tenant copy), the initial
  // status/attempts change, or jsonb round-tripping mangles the payload. The
  // worker re-dispatches from `payload` alone, so an inexact round-trip is a
  // silently wrong redelivery.
  it('persists the event type, the tenant copy, and a payload that round-trips exactly', async () => {
    process.env[FLAG] = 'true';

    const lawFirmId = randomUUID();
    const EVENT = 'outboxspec.shape';
    const payload = {
      lawFirmId,
      taskId: randomUUID(),
      entityData: { title: 'Draft motion', tags: ['a', 'b'], nested: { deep: { count: 0, flag: false } } },
      previousData: null,
      assignedTo: null,
      userId: 'system',
      timeZone: 'America/New_York',
    };

    listen(EVENT, async () => {});
    eventBus.emit(EVENT, payload);
    await drainEvents();

    const rows = await waitForRows(1);
    expect(rows).toHaveLength(1);
    const [row] = rows;

    expect(row.event_type).toBe(EVENT);
    expect(row.law_firm_id).toBe(lawFirmId);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBeNull();
    expect(row.processed_at).toBeNull();
    expect(row.created_at).toBeInstanceOf(Date);
    // Exact, not a subset: nested objects, arrays, `false`, `0` and explicit
    // nulls all have to survive the jsonb round trip untouched.
    expect(row.payload).toEqual(payload);
  });

  // RED WHEN: the FROM_OUTBOX guard in backstopEnqueue is removed. Without it the
  // worker's own re-dispatch enqueues a fresh pending row, which the next pass
  // claims, which enqueues another: an unbounded outbox loop that no other spec
  // in this file would notice.
  it('does not enqueue a payload already marked as coming from the outbox', async () => {
    process.env[FLAG] = 'true';

    const EVENT = 'outboxspec.loop-guard';
    let calls = 0;
    listen(EVENT, async () => { calls += 1; });

    eventBus.emit(EVENT, { lawFirmId: randomUUID(), [FROM_OUTBOX]: true });
    await drainEvents();

    expect(calls).toBe(1);
    expect(await waitForRows(1)).toHaveLength(0);
  });

  // RED WHEN: the same guard is removed, observed end to end rather than through
  // the shim: a worker pass with persistence ON must not grow the table.
  it('a worker re-dispatch with persistence on does not create a second row', async () => {
    process.env[FLAG] = 'true';

    const EVENT = 'outboxspec.loop-guard-worker';
    listen(EVENT, async () => {});
    const id = await seedRow({ eventType: EVENT, payload: { lawFirmId: randomUUID() } });

    await _processBatch(eventBus);
    // Give any stray fire-and-forget enqueue the same window it gets elsewhere.
    const rows = await waitForRows(2);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].status).toBe('done');
  });
});

describe('claiming', () => {
  // RED WHEN: the claim stops flipping status to 'processing' or stops stamping
  // `processed_at` as the lease start. Both are load-bearing: the status flip is
  // what stops a second pass re-claiming a row already being dispatched, and the
  // stamp is the lease anchor the crash-recovery branch measures against.
  it('flips a row to processing and stamps its lease BEFORE the listeners run', async () => {
    const EVENT = 'outboxspec.claim-visible';
    const observed: Array<{ status: string; leased: boolean }> = [];

    listen(EVENT, async () => {
      const { rows } = await testPool.query<OutboxRow>(
        'select status, processed_at from event_outbox where event_type = $1',
        [EVENT],
      );
      observed.push({ status: rows[0].status, leased: rows[0].processed_at !== null });
    });

    await seedRow({ eventType: EVENT });
    await _processBatch(eventBus);

    expect(observed).toEqual([{ status: 'processing', leased: true }]);
  });

  // RED WHEN: two concurrent passes ever hand the same row to the listeners twice
  // (the claim loses SKIP LOCKED *and* its status flip, or the claim stops running
  // in a transaction). Six rows, two passes racing, exactly six dispatches.
  it('two concurrent worker passes dispatch each row exactly once', async () => {
    const EVENT = 'outboxspec.concurrent';
    const dispatched: number[] = [];

    listen(EVENT, async (payload: any) => {
      // A real listener does database work; the delay widens the window in which
      // the second pass is running against rows the first has in hand.
      await new Promise((resolve) => setTimeout(resolve, 25));
      dispatched.push(payload.n);
    });

    for (let n = 0; n < 6; n += 1) {
      await seedRow({ eventType: EVENT, payload: { lawFirmId: randomUUID(), n } });
    }

    await Promise.all([_processBatch(eventBus), _processBatch(eventBus)]);

    expect(dispatched.slice().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    const rows = await allRows();
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.status === 'done' && r.attempts === 1)).toBe(true);
  });
});

describe('the success path', () => {
  // RED WHEN: the terminal write is dropped (row would sit in 'processing' until
  // its lease expired and then re-run every listener), changes status, stops
  // counting the attempt, or starts DELETING the row instead of marking it. The
  // retention sweep, not the dispatcher, is what removes rows.
  it('marks a fully successful row done, keeps it, counts the attempt and clears last_error', async () => {
    const EVENT = 'outboxspec.success';
    const seen: any[] = [];
    listen(EVENT, async (payload: any) => { seen.push(payload); });

    const lawFirmId = randomUUID();
    const id = await seedRow({
      eventType: EVENT,
      lawFirmId,
      payload: { lawFirmId, taskId: 'abc' },
      lastError: 'a stale error from an earlier attempt',
    });

    await _processBatch(eventBus);

    const row = await rowById(id);
    expect(row).toBeDefined();               // marked, not deleted
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(1);
    expect(row.processed_at).not.toBeNull();
    expect(row.last_error).toBeNull();

    expect(seen).toHaveLength(1);
    expect(seen[0].taskId).toBe('abc');
    // The worker marks its own re-dispatch so the emit shim cannot re-enqueue it.
    expect(seen[0][FROM_OUTBOX]).toBe(true);
  });

  // RED WHEN: a 'done' row becomes claimable again. At-least-once is the contract;
  // at-every-poll is not.
  it('does not pick a done row up again', async () => {
    const EVENT = 'outboxspec.done-settled';
    let calls = 0;
    listen(EVENT, async () => { calls += 1; });

    const id = await seedRow({ eventType: EVENT, status: 'done', attempts: 1, processedAgo: '1 day' });
    await _processBatch(eventBus);

    expect(calls).toBe(0);
    expect((await rowById(id)).attempts).toBe(1);
  });
});

describe('retry', () => {
  // RED WHEN: a throwing listener no longer marks the row 'failed', the error text
  // is not recorded, a failed row is never reclaimed, or the successful retry does
  // not clear the stale error.
  it('marks a throwing row failed with the error, then settles it on the retry', async () => {
    const EVENT = 'outboxspec.retry';
    let calls = 0;
    listen(EVENT, async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient-boom');
    });

    const id = await seedRow({ eventType: EVENT, payload: { lawFirmId: randomUUID() } });

    await _processBatch(eventBus);
    let row = await rowById(id);
    expect(calls).toBe(1);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('transient-boom');

    await makeDue(id);
    await _processBatch(eventBus);
    row = await rowById(id);
    expect(calls).toBe(2);
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(2);
    expect(row.last_error).toBeNull();
  });

  // RED WHEN: dispatchRow re-runs only the listener that threw instead of the whole
  // event. This is the property that makes listener idempotency load-bearing, and
  // it is invisible everywhere else: the first listener runs TWICE for one event.
  it('re-runs EVERY listener on retry, including the ones that already succeeded', async () => {
    const EVENT = 'outboxspec.rerun-all';
    let firstCalls = 0;
    let secondCalls = 0;

    listen(EVENT, async () => { firstCalls += 1; });
    listen(EVENT, async () => {
      secondCalls += 1;
      if (secondCalls === 1) throw new Error('second listener failed once');
    });

    const id = await seedRow({ eventType: EVENT, payload: { lawFirmId: randomUUID() } });

    await _processBatch(eventBus);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    expect((await rowById(id)).status).toBe('failed');

    await makeDue(id);
    await _processBatch(eventBus);

    // The whole row is retried, so the listener that already succeeded runs again.
    expect(firstCalls).toBe(2);
    expect(secondCalls).toBe(2);
    const row = await rowById(id);
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(2);
  });

  // B08.3: a poison event must not monopolise the batch. The worker processes
  // rows independently, so one listener failure should leave that row
  // retryable while allowing unrelated work in the same claimed batch to
  // complete.
  //
  // RED WHEN: batch processing returns or rejects on the first dispatch error,
  // instead of containing the failure in that row's terminal state.
  it('isolates a poison event so a healthy row in the same batch still completes', async () => {
    const POISON = 'outboxspec.poison';
    const HEALTHY = 'outboxspec.healthy';
    let healthyCalls = 0;

    listen(POISON, async () => {
      throw new Error('poison listener');
    });
    listen(HEALTHY, async () => {
      healthyCalls += 1;
    });

    const poisonId = await seedRow({
      eventType: POISON,
      lawFirmId: randomUUID(),
      createdAgo: '2 seconds',
    });
    const healthyId = await seedRow({
      eventType: HEALTHY,
      lawFirmId: randomUUID(),
      createdAgo: '1 second',
    });

    await expect(_processBatch(eventBus)).resolves.toBeUndefined();

    const poison = await rowById(poisonId);
    const healthy = await rowById(healthyId);
    expect(healthyCalls).toBe(1);
    expect(healthy.status).toBe('done');
    expect(healthy.attempts).toBe(1);
    expect(poison.status).toBe('failed');
    expect(poison.attempts).toBe(1);
    expect(poison.last_error).toContain('poison listener');
  });

  it('keeps an event without a registered listener recoverable and records the reason', async () => {
    const id = await seedRow({ eventType: 'outboxspec.no-listener', lawFirmId: randomUUID() });
    await expect(_processBatch(eventBus)).resolves.toBeUndefined();
    const row = await rowById(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('No registered listener');
  });
});

describe('dispatch width: one row runs its listeners one after another', () => {
  // The worker already runs several rows at once. If each row ALSO fans its
  // listeners out in parallel, the peak is rows x listeners chains, each wanting
  // a pool connection. Running a row's listeners in sequence bounds the peak by
  // the row width alone.
  //
  // RED WHEN: dispatchRow starts a row's listeners concurrently again
  // (`maxActive` climbs past 1 and the start/end log interleaves), or when the
  // sequential loop stops at the first throwing listener (C and D never run),
  // or when the failure stops being recorded as it is today: row 'failed',
  // attempts 1, `last_error` naming the FIRST failing listener in registration
  // order.
  it('never overlaps two listeners of one row, and a throwing listener does not stop the ones after it', async () => {
    const EVENT = 'outboxspec.sequential-listeners';
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;

    const slow = (name: string, failWith?: string) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      log.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      log.push(`${name}:end`);
      active -= 1;
      if (failWith) throw new Error(failWith);
    };

    listen(EVENT, slow('A'));
    listen(EVENT, slow('B', 'listener-b-boom'));
    listen(EVENT, slow('C'));
    listen(EVENT, slow('D', 'listener-d-boom'));

    const id = await seedRow({ eventType: EVENT, payload: { lawFirmId: randomUUID() } });

    await expect(_processBatch(eventBus)).resolves.toBeUndefined();

    expect(log).toEqual([
      'A:start', 'A:end',
      'B:start', 'B:end',
      'C:start', 'C:end',
      'D:start', 'D:end',
    ]);
    expect(maxActive).toBe(1);

    const row = await rowById(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('listener-b-boom');
  });

  // A listener that throws synchronously (not an async function) was isolated by
  // the old `Promise.resolve().then(...)` wrapper. RED WHEN: the sequential loop
  // calls a listener outside its try, so a synchronous throw escapes and the
  // listener after it never runs.
  it('isolates a synchronously throwing listener the same way', async () => {
    const EVENT = 'outboxspec.sequential-sync-throw';
    let afterCalls = 0;

    listen(EVENT, () => { throw new Error('sync-boom'); });
    listen(EVENT, async () => { afterCalls += 1; });

    const id = await seedRow({ eventType: EVENT, payload: { lawFirmId: randomUUID() } });

    await expect(_processBatch(eventBus)).resolves.toBeUndefined();

    expect(afterCalls).toBe(1);
    const row = await rowById(id);
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('sync-boom');
  });
});

describe('backoff', () => {
  // BASE_BACKOFF_MS * 2^attempts. attempts=1 => 60s, attempts=2 => 120s.
  // RED WHEN: the backoff term is removed from the claim predicate (a permanently
  // failing row would then be retried on every single poll, five times in the first
  // second), or the base/exponent changes.
  it('skips a failed row 59 seconds after its first failure and claims it at 61 (60s window)', async () => {
    const EVENT = 'outboxspec.backoff-1';
    let calls = 0;
    listen(EVENT, async () => { calls += 1; });

    const id = await seedRow({
      eventType: EVENT, status: 'failed', attempts: 1, processedAgo: '59 seconds', lastError: 'boom',
    });

    await _processBatch(eventBus);
    expect(calls).toBe(0);
    let row = await rowById(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);

    await testPool.query(
      "update event_outbox set processed_at = now() - interval '61 seconds' where id = $1", [id],
    );
    await _processBatch(eventBus);
    expect(calls).toBe(1);
    row = await rowById(id);
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(2);
  });

  // RED WHEN: the backoff stops doubling (a fixed delay would claim this at 61s).
  it('doubles the window with each attempt: attempts=2 is skipped at 119 seconds and claimed at 121', async () => {
    const EVENT = 'outboxspec.backoff-2';
    let calls = 0;
    listen(EVENT, async () => { calls += 1; });

    const id = await seedRow({
      eventType: EVENT, status: 'failed', attempts: 2, processedAgo: '119 seconds', lastError: 'boom',
    });

    await _processBatch(eventBus);
    expect(calls).toBe(0);

    await testPool.query(
      "update event_outbox set processed_at = now() - interval '121 seconds' where id = $1", [id],
    );
    await _processBatch(eventBus);
    expect(calls).toBe(1);
    expect((await rowById(id)).attempts).toBe(3);
  });
});

describe('the crash lease', () => {
  // RED WHEN: the 'processing' reclaim branch is removed (a worker that died
  // mid-dispatch would strand the row forever) or the 5-minute lease changes.
  it('leaves a processing row alone inside its 5 minute lease and reclaims it after', async () => {
    const EVENT = 'outboxspec.lease';
    let calls = 0;
    listen(EVENT, async () => { calls += 1; });

    const id = await seedRow({
      eventType: EVENT, status: 'processing', attempts: 1, processedAgo: '4 minutes',
    });

    await _processBatch(eventBus);
    expect(calls).toBe(0);
    expect((await rowById(id)).status).toBe('processing');

    await testPool.query(
      "update event_outbox set processed_at = now() - interval '6 minutes' where id = $1", [id],
    );
    await _processBatch(eventBus);
    expect(calls).toBe(1);
    expect((await rowById(id)).status).toBe('done');
  });

  // RED WHEN: the `attempts < MAX_ATTEMPTS` guard is dropped from the 'processing'
  // reclaim branch, which would let an exhausted row loop forever via the lease.
  it('does not reclaim an expired processing row that has exhausted its attempts', async () => {
    const EVENT = 'outboxspec.lease-exhausted';
    let calls = 0;
    listen(EVENT, async () => { calls += 1; });

    const id = await seedRow({
      eventType: EVENT, status: 'processing', attempts: MAX_ATTEMPTS, processedAgo: '1 day',
    });

    await _processBatch(eventBus);
    expect(calls).toBe(0);
    expect((await rowById(id)).status).toBe('processing');
  });
});

describe('lease fencing: a reclaimed lease must not let a stale worker overwrite the newer attempt', () => {
  // B08.3: "stale worker acknowledgement after lease reassignment cannot overwrite
  // the newer attempt's result if lease fencing is part of the design." This proves
  // it with a REAL overlapping claim, not an inference from reading the SQL: worker
  // A claims the row and is paused (via the gate) inside its listener call, exactly
  // like a worker that has hung or is about to crash. While it is stuck there, its
  // lease is pushed past PROCESSING_LEASE_MS and a second, completely normal
  // `_processBatch` pass (worker B) reclaims the SAME row and starts its own
  // dispatch, which pauses on the identical gate too (`gate.arrived(2)` is the
  // overlap proof: both dispatches are inside the listener at the same time).
  // Releasing both and letting them finish in either order must leave exactly ONE
  // terminal write in effect: worker B's, since it holds the current lease, not
  // two, and not a bookkeeping value stitched from both.
  //
  // RED WHEN: the terminal writes in `dispatchRow` have no fencing predicate tying
  // them to the lease a worker actually claimed (today: `where id = $1`, full stop).
  // Without it, both terminal writes apply unconditionally and `attempts` is
  // double-incremented by worker A's late, superseded write.
  it('a stale worker\'s late terminal write is a no-op once the row has already been reclaimed and completed', async () => {
    const EVENT = 'outboxspec.stale-lease-race';
    const listenerHost = { async run(): Promise<void> { /* no-op success */ } };
    const gate: Gate = gateMethod(listenerHost, 'run');
    listen(EVENT, (payload: unknown) => listenerHost.run());

    try {
      const id = await seedRow({ eventType: EVENT, attempts: 3 });

      // Worker A: claims the row (pending -> processing, attempts stays 3) and
      // starts dispatching. Its listener call pauses at the gate.
      const passA = _processBatch(eventBus);
      await gate.arrived(1);
      expect((await rowById(id)).status).toBe('processing');

      // Worker A is now indistinguishable from a hung/crashing worker: push its
      // lease stamp past PROCESSING_LEASE_MS so the row is reclaimable, exactly as
      // if five real minutes had passed while A sat inside the listener call.
      await testPool.query(
        "update event_outbox set processed_at = now() - interval '6 minutes' where id = $1",
        [id],
      );

      // Worker B: a completely independent pass reclaims the same row (bumping its
      // lease) and starts its OWN dispatch, which pauses on the same gate.
      const passB = _processBatch(eventBus);
      await gate.arrived(2); // PROOF: both dispatches are inside the listener at once.

      // Let both listener calls resolve. Whichever terminal write lands first, the
      // other must find the row's lease already moved on and do nothing.
      gate.open();
      await Promise.all([passA, passB]);

      const row = await rowById(id);
      expect(row.status).toBe('done');
      // Exactly one real completion happened. If the stale worker's terminal write
      // is not fenced to the lease it actually claimed, this becomes 5 (both writes
      // apply `attempts = attempts + 1` unconditionally) instead of 4.
      expect(row.attempts).toBe(4);
    } finally {
      gate.restore();
    }
  });

  // The success-path race above proves the fencing predicate exists at all, but
  // both racers there compute the SAME target attempts value (a plain `+1` on a
  // shared base), so it cannot tell a fenced write from an unfenced one that
  // merely repeats the same number. The failure path uses a caller-computed
  // `attempts = $2` instead, which is where a truly stale write does visible
  // damage: it can roll the counter back BELOW a newer failure that already
  // landed, un-dead-lettering a row that had genuinely exhausted its retries.
  //
  // RED WHEN: the failure branch's terminal write loses its `xmin` predicate
  // (today: `where id = $1`, full stop).
  it('a stale worker\'s late FAILURE write cannot roll attempts backward below a newer failure that already landed', async () => {
    const EVENT = 'outboxspec.stale-lease-failure-race';
    listen(EVENT, async () => { throw new Error('always fails'); });

    // Worker A claimed this row a while ago (attempts=3 at claim time) and has
    // been stuck ever since - same "already claimed and stuck" convention the
    // crash-lease specs above use, just captured so we can replay it later.
    const id = await seedRow({
      eventType: EVENT, status: 'processing', attempts: 3, processedAgo: '6 minutes',
    });
    const staleClaim = await claimSnapshot(id);
    expect(staleClaim.attempts).toBe(3);

    // Meanwhile, for real, the row is reclaimed and fails TWICE more (it looks
    // abandoned, because it is), reaching the dead letter at exactly 5.
    await _processBatch(eventBus);
    expect((await rowById(id)).attempts).toBe(4);
    await makeDue(id);
    await _processBatch(eventBus);
    const deadLettered = await rowById(id);
    expect(deadLettered.attempts).toBe(5);
    expect(deadLettered.status).toBe('failed');

    // Worker A's ancient dispatch finally settles - and fails, same as ever.
    // Its terminal write is computed from its stale attempts=3 snapshot
    // (3 + 1 = 4), which is LOWER than the 5 already recorded. Unfenced, this
    // would silently un-dead-letter the row.
    await _dispatchRow(eventBus, staleClaim);

    const row = await rowById(id);
    expect(row.attempts).toBe(5);
    expect(row.status).toBe('failed');
  });
});

describe('the attempt cap and the dead letter', () => {
  // RED WHEN: MAX_ATTEMPTS moves, or the `attempts < $1` gate leaves the claim
  // predicate. Without the gate this loop never terminates in production.
  it('stops retrying a permanently failing row after exactly 5 attempts and dead-letters it', async () => {
    const EVENT = 'outboxspec.dead-letter';
    let calls = 0;
    listen(EVENT, async () => {
      calls += 1;
      throw new Error(`always fails (call ${calls})`);
    });

    const id = await seedRow({ eventType: EVENT, payload: { lawFirmId: randomUUID() } });

    // Force the row due before each pass, so the backoff (which reaches 16 minutes
    // by the last attempt) does not have to be waited out.
    for (let pass = 1; pass <= MAX_ATTEMPTS; pass += 1) {
      await _processBatch(eventBus);
      const row = await rowById(id);
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(pass);
      expect(calls).toBe(pass);
      await makeDue(id);
    }

    // A sixth pass, with the row long past any backoff window, must do nothing.
    await _processBatch(eventBus);
    const settled = await rowById(id);
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(settled.status).toBe('failed');
    expect(settled.attempts).toBe(MAX_ATTEMPTS);
    expect(settled.last_error).toContain('always fails (call 5)');
  });

  // RED WHEN: a dead letter becomes claimable again. Kept separate from the loop
  // above so it fails on its own terms rather than as a fifth-order consequence.
  it('never picks a dead-lettered row up again', async () => {
    const EVENT = 'outboxspec.dead-letter-stays';
    let calls = 0;
    listen(EVENT, async () => { calls += 1; });

    const id = await seedRow({
      eventType: EVENT, status: 'failed', attempts: MAX_ATTEMPTS, processedAgo: '30 days', lastError: 'gone',
    });

    await _processBatch(eventBus);
    await _processBatch(eventBus);

    expect(calls).toBe(0);
    const row = await rowById(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(MAX_ATTEMPTS);
  });
});

describe('getOutboxHealth', () => {
  // RED WHEN: a bucket's predicate changes, in particular the attempts threshold
  // that separates a dead letter from a row still owed a retry. This is what the
  // admin diagnostics route and the sweep's dead-letter alarm both read.
  it('separates dead letters from still-retryable failures, and counts pending and processing', async () => {
    const EVENT = 'outboxspec.health';
    await seedRow({ eventType: EVENT, status: 'failed', attempts: MAX_ATTEMPTS, processedAgo: '1 day' });
    await seedRow({ eventType: EVENT, status: 'failed', attempts: MAX_ATTEMPTS + 3, processedAgo: '1 day' });
    await seedRow({ eventType: EVENT, status: 'failed', attempts: 2, processedAgo: '1 day' });
    await seedRow({ eventType: EVENT, status: 'processing', attempts: 1, processedAgo: '1 minute' });
    await seedRow({ eventType: EVENT, status: 'pending' });
    await seedRow({ eventType: EVENT, status: 'pending' });
    await seedRow({ eventType: EVENT, status: 'done', attempts: 1, processedAgo: '1 day' });

    process.env[FLAG] = 'true';
    expect(await getOutboxHealth()).toEqual({
      deadLetter: 2, retryable: 1, processing: 1, pending: 2, workerEnabled: true,
    });

    // Read-only and NOT flag-gated, so the diagnostics route still answers with
    // the worker off; only `workerEnabled` changes.
    delete process.env[FLAG];
    expect(await getOutboxHealth()).toEqual({
      deadLetter: 2, retryable: 1, processing: 1, pending: 2, workerEnabled: false,
    });
  });
});

describe('the retention sweep', () => {
  // RED WHEN: the sweep loses its flag gate. With the worker off nothing writes
  // rows, so a sweep that still ran would be deleting rows some other operator
  // put there by hand for inspection.
  it('is a no-op with the flag off', async () => {
    const id = await seedRow({ status: 'done', attempts: 1, processedAgo: '30 days' });

    delete process.env[FLAG];
    await runCleanupSweep();

    expect(await rowById(id)).toBeDefined();
  });

  // RED WHEN: the 7-day 'done' retention window changes, or the sweep starts
  // pruning by created_at instead of processed_at.
  it('prunes done rows past the 7 day window and keeps recent ones', async () => {
    process.env[FLAG] = 'true';
    const old = await seedRow({ status: 'done', attempts: 1, createdAgo: '9 days', processedAgo: '8 days' });
    const recent = await seedRow({ status: 'done', attempts: 1, createdAgo: '2 days', processedAgo: '1 day' });

    await runCleanupSweep();

    expect(await rowById(old)).toBeUndefined();
    expect(await rowById(recent)).toBeDefined();
  });

  // RED WHEN: the `attempts >= MAX_ATTEMPTS` guard leaves the non-done branch.
  // Dropping it deletes rows that were still owed a retry, which is silent
  // permanent event loss: the strongest reason this file exists.
  it('prunes exhausted dead letters and stale pending rows but keeps anything still retryable', async () => {
    process.env[FLAG] = 'true';

    const exhaustedFailed = await seedRow({ status: 'failed', attempts: MAX_ATTEMPTS, createdAgo: '40 days', processedAgo: '31 days' });
    const retryableFailed = await seedRow({ status: 'failed', attempts: 2, createdAgo: '40 days', processedAgo: '31 days' });
    const exhaustedProcessing = await seedRow({ status: 'processing', attempts: MAX_ATTEMPTS, createdAgo: '40 days', processedAgo: '31 days' });
    const reclaimableProcessing = await seedRow({ status: 'processing', attempts: 1, createdAgo: '40 days', processedAgo: '31 days' });
    const stalePending = await seedRow({ status: 'pending', createdAgo: '31 days' });
    const recentPending = await seedRow({ status: 'pending', createdAgo: '1 day' });
    const recentDeadLetter = await seedRow({ status: 'failed', attempts: MAX_ATTEMPTS, createdAgo: '3 days', processedAgo: '2 days' });

    await runCleanupSweep();

    // Terminal and past the 30 day window: gone.
    expect(await rowById(exhaustedFailed)).toBeUndefined();
    expect(await rowById(exhaustedProcessing)).toBeUndefined();
    expect(await rowById(stalePending)).toBeUndefined();

    // Still eligible for a retry, or not old enough: kept.
    expect(await rowById(retryableFailed)).toBeDefined();
    expect(await rowById(reclaimableProcessing)).toBeDefined();
    expect(await rowById(recentPending)).toBeDefined();
    expect(await rowById(recentDeadLetter)).toBeDefined();
  });
});

describe('tenancy', () => {
  // B08.3: `law_firm_id` is a denormalised tenant copy, but it is the only
  // durable routing boundary available before a listener receives a historical
  // payload. A mismatch must never be "resolved" by trusting the payload: that
  // would let a corrupted row replay Firm B's work through a row belonging to
  // Firm A. The row stays observable and retryable instead of dispatching under
  // either guessed tenant.
  //
  // RED WHEN: dispatchRow invokes listeners without checking that a tenant-bound
  // row's payload agrees with its stored tenant copy.
  it('rejects a tenant-mismatched persisted payload before any listener can receive it', async () => {
    const EVENT = 'outboxspec.tenant-mismatch';
    const rowFirmId = randomUUID();
    const payloadFirmId = randomUUID();
    let calls = 0;

    listen(EVENT, async () => { calls += 1; });
    const id = await seedRow({
      eventType: EVENT,
      lawFirmId: rowFirmId,
      payload: { lawFirmId: payloadFirmId, marker: 'corrupt tenant copy' },
    });

    await _processBatch(eventBus);

    expect(calls).toBe(0);
    const row = await rowById(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('tenant mismatch');
  });

  // RED WHEN: dispatchRow stops building the payload from each claimed row (for
  // example reusing one row's payload across the batch, which bounded-parallel
  // dispatch makes an easy mistake). Every listener in this app scopes its work by
  // `payload.lawFirmId`, so a payload swapped between two rows in one batch writes
  // one firm's data into another firm's tenant.
  it('gives each dispatch its own row payload, so one firm event never arrives under another firm id', async () => {
    const EVENT = 'outboxspec.tenancy';
    const firmA = randomUUID();
    const firmB = randomUUID();
    const delivered: Array<{ lawFirmId: string; marker: string }> = [];

    listen(EVENT, async (payload: any) => {
      delivered.push({ lawFirmId: payload.lawFirmId, marker: payload.marker });
    });

    await seedRow({ eventType: EVENT, lawFirmId: firmA, payload: { lawFirmId: firmA, marker: 'a' } });
    await seedRow({ eventType: EVENT, lawFirmId: firmB, payload: { lawFirmId: firmB, marker: 'b' } });

    await _processBatch(eventBus);

    expect(delivered).toHaveLength(2);
    const byMarker = new Map(delivered.map((d) => [d.marker, d.lawFirmId]));
    expect(byMarker.get('a')).toBe(firmA);
    expect(byMarker.get('b')).toBe(firmB);

    // And the denormalised column agrees with the payload it was copied from.
    for (const row of await allRows()) {
      expect(row.law_firm_id).toBe(row.payload.lawFirmId);
    }
  });
});

describe('CHARACTERIZATION: the worker re-dispatches every row, not only failures', () => {
  /**
   * Every emit enqueues a row at status 'pending', and the claim predicate's
   * first branch is a bare `status = 'pending'`. There is no record anywhere of
   * whether the LIVE listeners succeeded, so the worker cannot condition on it.
   * With the worker on, every event is dispatched at least twice: once live,
   * once by the worker.
   *
   * This comment used to say that `backend/AGENTS.md` and the `eventOutbox.ts`
   * header both claimed the opposite. BOTH HAVE SINCE BEEN CORRECTED and now
   * state the double dispatch plainly, so that reading is no longer a warning
   * about stale prose. It is left as a note only so the next reader does not go
   * looking for a contradiction that has been resolved.
   *
   * The DOUBLE-DISPATCH WARNING in eventBus.ts states this, the eventOutbox.ts
   * header states it, and the calendar-sync caveat depends on it being true.
   * This test is what keeps all three honest.
   *
   * RED WHEN: enqueue becomes conditional on a live-listener failure, or the claim
   * stops taking 'pending' rows. Either would be the change that makes the prose
   * true, and it should be made deliberately.
   */
  it('re-dispatches a row whose live listeners all succeeded', async () => {
    process.env[FLAG] = 'true';

    const EVENT = 'outboxspec.double-dispatch';
    let calls = 0;
    listen(EVENT, async () => { calls += 1; });

    eventBus.emit(EVENT, { lawFirmId: randomUUID(), note: 'succeeds live' });
    await drainEvents();

    const rows = await waitForRows(1);
    expect(rows).toHaveLength(1);
    expect(calls).toBe(1); // the live dispatch

    await _processBatch(eventBus);

    expect(calls).toBe(2); // the worker ran the same listener a second time
    const row = await rowById(rows[0].id);
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(1);
  });
});

describe('malformed and tenant-absent persisted payloads (B08.3)', () => {
  // The existing 'tenancy' block above proves the row/payload tenant COPIES can
  // disagree. These specs cover the shapes that never come from `enqueue()` at
  // all - a row could only end up like this via a hand-written insert, a bad
  // migration, or a producer in another language - so dispatchRow's own object
  // guard, not the JS-level shape of a real emit, is what has to reject them.
  // None of this may guess a tenant or a listener outcome: a malformed row must
  // fail loudly and stay retryable, never be silently marked 'done'.

  // RED WHEN: the `Array.isArray(row.payload)` branch of dispatchRow's guard is
  // removed. Postgres jsonb accepts a top-level array happily; nothing about the
  // column stops it.
  it('rejects a persisted payload that is a JSON array, not an object, and does not touch a healthy row in the same batch', async () => {
    const ARRAY_EVENT = 'outboxspec.malformed-array';
    const HEALTHY_EVENT = 'outboxspec.malformed-array-healthy';
    let healthyCalls = 0;
    listen(ARRAY_EVENT, async () => { throw new Error('should never be called'); });
    listen(HEALTHY_EVENT, async () => { healthyCalls += 1; });

    const arrayId = await seedRow({ eventType: ARRAY_EVENT, payload: [1, 2, 3] as any });
    const healthyId = await seedRow({ eventType: HEALTHY_EVENT, lawFirmId: randomUUID() });

    await _processBatch(eventBus);

    const arrayRow = await rowById(arrayId);
    expect(arrayRow.status).toBe('failed');
    expect(arrayRow.attempts).toBe(1);
    expect(arrayRow.last_error).toContain('outbox payload must be an object');

    const healthyRow = await rowById(healthyId);
    expect(healthyCalls).toBe(1);
    expect(healthyRow.status).toBe('done');
  });

  // RED WHEN: the `typeof row.payload !== 'object'` branch is removed. A scalar
  // jsonb value (a bare string or number) round-trips through `pg` as that same
  // JS primitive, not an object, so `row.payload.lawFirmId` would throw a raw
  // TypeError instead of the intended, retryable rejection.
  it('rejects a persisted payload that is a scalar value', async () => {
    const id = await seedRow({ eventType: 'outboxspec.malformed-scalar', payload: 'not-an-object' as any });

    await _processBatch(eventBus);

    const row = await rowById(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('outbox payload must be an object');
  });

  // RED WHEN: the `!row.payload` branch is removed. `typeof null === 'object'` in
  // JS, so this shape specifically needs the truthiness check, not just a typeof
  // check, or `row.payload.lawFirmId` below it would throw reading a property of
  // null instead of surfacing the intended message.
  it('rejects a null persisted payload', async () => {
    const id = await seedRow({ eventType: 'outboxspec.malformed-null', payload: null as any });

    await _processBatch(eventBus);

    const row = await rowById(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('outbox payload must be an object');
  });

  // A row's `law_firm_id` column is set (this row IS tenant-scoped) but the
  // payload carries no `lawFirmId` key at all - distinct from the existing
  // "corrupt tenant copy" test above, where both sides are present but disagree.
  // `enqueue()` itself can never produce this (it derives the row's law_firm_id
  // FROM `payload.lawFirmId`), so this can only be hand-inserted corruption or a
  // producer that forgot the field. The guard must still refuse to guess: an
  // absent payload tenant is not treated as "same as the row's tenant".
  it('rejects a tenant-scoped row whose payload carries no tenant metadata at all', async () => {
    const rowFirmId = randomUUID();
    const { rows } = await testPool.query<{ id: string }>(
      `insert into event_outbox (law_firm_id, event_type, payload, status, attempts)
       values ($1, $2, $3::jsonb, 'pending', 0)
       returning id`,
      [rowFirmId, 'outboxspec.malformed-no-tenant-in-payload', JSON.stringify({ marker: 'tenant key missing' })],
    );
    const id = rows[0].id;
    let calls = 0;
    listen('outboxspec.malformed-no-tenant-in-payload', async () => { calls += 1; });

    await _processBatch(eventBus);

    expect(calls).toBe(0);
    const row = await rowById(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('outbox tenant mismatch');
  });
});

describe('listener registration timing while rows are pending or already dispatched (B08.3)', () => {
  // Listeners are looked up fresh inside dispatchRow (`bus.listeners(row.event_type)`),
  // not captured at claim time or at enqueue time. This is what lets a rolling
  // deploy that adds a handler for an event type already emitted pick up rows the
  // OLD code left `pending`. Pin it as a positive control, not just infer it from
  // the missing-consumer recovery below.
  //
  // RED WHEN: a future refactor resolves `bus.listeners(...)` once per batch (or
  // caches it across worker ticks) instead of once per row inside dispatchRow -
  // that would freeze the listener set at claim time and this row would go on
  // being marked 'done' with nothing having run, identical to the no-listener case.
  it('a listener registered after a row was enqueued still receives it on the next dispatch', async () => {
    const EVENT = 'outboxspec.listener-added-after-enqueue';
    const id = await seedRow({ eventType: EVENT, lawFirmId: randomUUID(), payload: { marker: 'late listener' } as any });

    // No listener exists yet. Deliberately do NOT process the batch here - the
    // row must still be 'pending' when the listener below gets registered, the
    // same shape a rolling deploy produces (old code enqueues, new code adds the
    // handler before the backstop worker's next poll).
    let calls = 0;
    listen(EVENT, async (payload: any) => { calls += 1; expect(payload.marker).toBe('late listener'); });

    await _processBatch(eventBus);

    expect(calls).toBe(1);
    const row = await rowById(id);
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(1);
  });

  // Failed rows stay available when a later deployment supplies their consumer.
  it('retries a missing-consumer event once its listener becomes available', async () => {
    const EVENT = 'outboxspec.listener-added-after-failure';
    const id = await seedRow({ eventType: EVENT, lawFirmId: randomUUID() });
    await _processBatch(eventBus);
    expect((await rowById(id)).status).toBe('failed');
    await testPool.query("update event_outbox set processed_at = now() - interval '1 hour' where id = $1", [id]);
    let calls = 0;
    listen(EVENT, async () => { calls += 1; });
    await _processBatch(eventBus);
    expect(calls).toBe(1);
    expect((await rowById(id)).status).toBe('done');
  });
});
