/**
 * Event outbox: worker shutdown mid-batch and crash lease recovery.
 *
 * B08.3 requirement:
 * "Worker shutdown during a batch; already completed rows stay done;
 *  uncompleted rows become recoverable after lease rules."
 *
 * Covers:
 * 1. Graceful worker shutdown (`stopOutboxWorker`):
 *    - When `stopOutboxWorker()` is called while a batch is in flight, it awaits the
 *      active dispatch tick before resolving.
 *    - In-flight rows complete cleanly to 'done' rather than being severed mid-flight
 *      or left abandoned in 'processing'.
 * 2. Abrupt worker crash mid-batch:
 *    - In a batch of multiple claimed rows, Row A finishes and flips to 'done'.
 *    - The worker crashes before Row B and Row C can finish, leaving them in 'processing'.
 *    - Immediate recovery pass leaves Row B and Row C untouched (active lease).
 *    - Once the lease expires (`processed_at < now() - lease_ms`), the recovery worker
 *      reclaims Row B and Row C and drives them to 'done'.
 *    - Already completed Row A stays 'done' throughout and is never re-dispatched.
 */
import { randomUUID } from 'crypto';

import { testPool, drainEvents } from '../support/setupInProcess';
import {
  _processBatch,
  startOutboxWorker,
  stopOutboxWorker,
} from '../../src/shared/events/eventOutbox';

const eventBus = require('../../src/shared/events/eventBus');

const FLAG = 'EVENT_OUTBOX_WORKER';

let previousFlag: string | undefined;
const registeredListeners: Array<{ event: string; listener: (...args: any[]) => any }> = [];

function listen(event: string, listener: (...args: any[]) => any): void {
  eventBus.on(event, listener);
  registeredListeners.push({ event, listener });
}

async function seedRow(overrides: {
  eventType?: string;
  payload?: Record<string, unknown>;
  lawFirmId?: string | null;
  status?: string;
  attempts?: number;
  createdAgo?: string | null;
  processedAgo?: string | null;
} = {}): Promise<string> {
  const {
    eventType = 'outboxspec.shutdown',
    payload = {},
    lawFirmId: requestedLawFirmId,
    status = 'pending',
    attempts = 0,
    createdAgo = null,
    processedAgo = null,
  } = overrides;

  const lawFirmId = requestedLawFirmId ?? randomUUID();
  const persistedPayload = { ...payload, lawFirmId };

  const { rows } = await testPool.query<{ id: string }>(
    `insert into event_outbox
       (law_firm_id, event_type, payload, status, attempts, created_at, processed_at)
     values ($1, $2, $3::jsonb, $4, $5,
             case when $6::text is null then now() else now() - $6::interval end,
             case when $7::text is null then null  else now() - $7::interval end)
     returning id`,
    [lawFirmId, eventType, JSON.stringify(persistedPayload), status, attempts, createdAgo, processedAgo],
  );
  return rows[0].id;
}

async function rowById(id: string) {
  const { rows } = await testPool.query('select * from event_outbox where id = $1', [id]);
  return rows[0] || null;
}

async function makeDue(id: string, ago = '6 minutes') {
  await testPool.query(
    'update event_outbox set processed_at = now() - $2::interval where id = $1',
    [id, ago],
  );
}

beforeAll(() => {
  previousFlag = process.env[FLAG];
  process.env[FLAG] = 'true';
});

afterAll(() => {
  if (previousFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = previousFlag;
});

beforeEach(async () => {
  await drainEvents();
});

afterEach(async () => {
  await stopOutboxWorker();
  for (const { event, listener } of registeredListeners) {
    eventBus.removeListener(event, listener);
  }
  registeredListeners.length = 0;
});

describe('B08.3: outbox worker shutdown mid-batch and lease recovery', () => {
  it('graceful batch completion: in-flight rows complete to done and stopOutboxWorker tears down cleanly', async () => {
    const EVENT = 'outboxspec.shutdown.graceful';
    const completedRows: string[] = [];

    let resolveSlowListener: (() => void) | null = null;
    const slowListenerStarted = new Promise<void>((resolve) => {
      listen(EVENT, async (payload: any) => {
        if (payload.item === 'slow') {
          resolve();
          await new Promise<void>((r) => { resolveSlowListener = r; });
        }
        completedRows.push(payload.item);
      });
    });

    const fastRowId = await seedRow({ eventType: EVENT, payload: { item: 'fast' } });
    const slowRowId = await seedRow({ eventType: EVENT, payload: { item: 'slow' } });

    // Start batch execution
    const batchPromise = _processBatch(eventBus);

    // Wait until the slow listener is mid-dispatch
    await slowListenerStarted;

    // While slow row is suspended mid-dispatch, its status is 'processing'
    expect((await rowById(slowRowId)).status).toBe('processing');

    // Worker shutdown is initiated
    const stopPromise = stopOutboxWorker();

    // Release the in-flight slow listener
    expect(resolveSlowListener).not.toBeNull();
    resolveSlowListener!();

    await batchPromise;
    await stopPromise;

    // Both rows must be completed to 'done' with zero rows abandoned in 'processing'
    expect((await rowById(fastRowId)).status).toBe('done');
    expect((await rowById(slowRowId)).status).toBe('done');
    expect(completedRows).toContain('fast');
    expect(completedRows).toContain('slow');
  });

  it('abrupt crash mid-batch: completed rows stay done, uncompleted rows recover after lease expiry', async () => {
    const EVENT = 'outboxspec.shutdown.abrupt';
    const executed: string[] = [];

    listen(EVENT, async (payload: any) => {
      executed.push(payload.item);
    });

    // 1. Row A completed before the worker crashed
    const rowA = await seedRow({
      eventType: EVENT,
      payload: { item: 'rowA' },
      status: 'done',
      attempts: 1,
      processedAgo: '4 minutes',
    });

    // 2. Row B and Row C were claimed and flipped to 'processing', but worker crashed mid-dispatch
    const rowB = await seedRow({
      eventType: EVENT,
      payload: { item: 'rowB' },
      status: 'processing',
      attempts: 0,
      processedAgo: '2 minutes', // within the 5-minute lease
    });

    const rowC = await seedRow({
      eventType: EVENT,
      payload: { item: 'rowC' },
      status: 'processing',
      attempts: 0,
      processedAgo: '2 minutes', // within the 5-minute lease
    });

    // Immediate recovery pass: within lease window, nothing should be reclaimed
    await _processBatch(eventBus);

    expect(executed).toEqual([]);
    expect((await rowById(rowA)).status).toBe('done');
    expect((await rowById(rowB)).status).toBe('processing');
    expect((await rowById(rowC)).status).toBe('processing');

    // Age the lease past the 5-minute window for Row B and Row C
    await makeDue(rowB, '6 minutes');
    await makeDue(rowC, '6 minutes');

    // Next worker pass: reclaims expired processing rows
    await _processBatch(eventBus);

    // Row B and Row C are now executed and marked 'done'
    expect(executed).toContain('rowB');
    expect(executed).toContain('rowC');
    expect((await rowById(rowB)).status).toBe('done');
    expect((await rowById(rowC)).status).toBe('done');
    expect((await rowById(rowB)).attempts).toBe(1);
    expect((await rowById(rowC)).attempts).toBe(1);

    // Row A was ALREADY done and was NEVER re-dispatched
    expect(executed).not.toContain('rowA');
    expect((await rowById(rowA)).status).toBe('done');
    expect((await rowById(rowA)).attempts).toBe(1);
  });
});
