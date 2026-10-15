/**
 * The firm rotation every cron pass walks, and why it must not load the list.
 *
 * `forEachFirm` selected every firm with its `settings` jsonb before visiting
 * any of them, and six passes call it on every cron cycle. That cost grows with
 * the customer base rather than with the work, on the same 512 MiB instance
 * that signs documents, and it grows even on a cycle where no firm needs
 * anything done.
 *
 * Paging it is easy to get subtly wrong, so the guarantees the old index
 * arithmetic gave are pinned here first:
 *
 *   Every firm is visited exactly once per pass. Not most; a firm skipped by a
 *   paging bug silently stops receiving reminders and nothing reports it.
 *
 *   A truncated pass resumes AFTER the firm it finished, and the rotation wraps,
 *   so the firms at the end of the id order are not permanently starved by a
 *   budget that always runs out before reaching them.
 *
 *   `firmsTotal` still counts every firm, because the pass reports coverage.
 */
import { createFirm, testPool } from '../support/setupInProcess';

const { forEachFirm } = require('../../src/shared/utils/reminderHelpers');

/** Firm ids in the order the rotation walks them, which is by id. */
async function firmIdsInOrder(): Promise<string[]> {
  const { rows } = await testPool.query('select id from law_firms order by id');
  return rows.map((r: any) => r.id);
}

/** Clear any persisted rotation cursor so each case starts from the top. */
async function resetCursor(passName: string): Promise<void> {
  await testPool.query('delete from cron_pass_state where pass_name = $1', [passName]);
}

beforeEach(async () => {
  await testPool.query('delete from law_firms');
});

it('visits every firm exactly once', async () => {
  for (let i = 0; i < 7; i += 1) await createFirm({ name: `Firm ${i}` });
  const expected = await firmIdsInOrder();
  await resetCursor('pagingAll');
  const seen: string[] = [];

  const result = await forEachFirm('pagingAll', async (firm: any) => { seen.push(firm.id); });

  expect(seen.slice().sort()).toEqual(expected.slice().sort());
  expect(new Set(seen).size).toBe(seen.length);
  expect(result.firmsProcessed).toBe(7);
  expect(result.firmsTotal).toBe(7);
  expect(result.truncated).toBe(false);
});

it('hands the handler the fields it needs, not just an id', async () => {
  await createFirm({ name: 'Hale & Co' });
  await resetCursor('pagingShape');
  const seen: any[] = [];

  await forEachFirm('pagingShape', async (firm: any) => { seen.push(firm); });

  // Callers read `settings` to decide whether a pass applies to this firm, so
  // paging must not reduce the row to an id and force a second query per firm.
  expect(seen[0].name).toBe('Hale & Co');
  expect(seen[0].settings).toBeDefined();
  expect(typeof seen[0].id).toBe('string');
});

it('resumes after the last firm it finished, and wraps around', async () => {
  for (let i = 0; i < 6; i += 1) await createFirm({ name: `Firm ${i}` });
  const order = await firmIdsInOrder();
  await resetCursor('pagingResume');

  // A budget that expires after three firms.
  const firstRun: string[] = [];
  let visited = 0;
  await forEachFirm('pagingResume', async (firm: any) => { firstRun.push(firm.id); visited += 1; },
    { deadline: { valueOf: () => (visited >= 3 ? -Infinity : Infinity) } as unknown as number });

  const secondRun: string[] = [];
  await forEachFirm('pagingResume', async (firm: any) => { secondRun.push(firm.id); });

  // Whatever the first run reached, the second must start after it and cover
  // every remaining firm. Restarting at the top would starve the tail forever.
  expect(firstRun.length).toBeGreaterThan(0);
  expect(secondRun[0]).toBe(order[(order.indexOf(firstRun[firstRun.length - 1]) + 1) % order.length]);
  expect(new Set([...firstRun, ...secondRun]).size).toBe(6);
});

it('walks correctly when the page is far smaller than the table', async () => {
  for (let i = 0; i < 12; i += 1) await createFirm({ name: `Firm ${i}` });
  const expected = await firmIdsInOrder();
  await resetCursor('pagingBounded');
  const seen: string[] = [];

  // A page size of one forces a page boundary between every firm. If the
  // keyset were an offset, or the boundary were computed from a stale list,
  // this is where a firm would be skipped or visited twice.
  await forEachFirm('pagingBounded', async (firm: any) => { seen.push(firm.id); }, { pageSize: 1 });

  expect(seen.slice().sort()).toEqual(expected.slice().sort());
  expect(new Set(seen).size).toBe(12);
});

it('does not skip or repeat a firm when one is created mid-pass', async () => {
  for (let i = 0; i < 6; i += 1) await createFirm({ name: `Firm ${i}` });
  await resetCursor('pagingConcurrent');
  const seen: string[] = [];
  let inserted = false;

  await forEachFirm('pagingConcurrent', async (firm: any) => {
    seen.push(firm.id);
    // Insert once, partway through, which is what an offset-based page would
    // mishandle: every later page would shift by one and skip a firm.
    if (!inserted && seen.length === 2) {
      inserted = true;
      await createFirm({ name: 'Arrived Midway' });
    }
  }, { pageSize: 2 });

  // Whatever the pass covered, it visited nothing twice. The new firm may or
  // may not appear depending on where its id sorts, and either is correct; the
  // rotation reaches it on the next run.
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.length).toBeGreaterThanOrEqual(6);
});

it('still handles a single named firm without touching the rotation', async () => {
  const firm = await createFirm({ name: 'Only This One' });
  await createFirm({ name: 'Not This One' });
  const seen: string[] = [];

  const result = await forEachFirm('pagingSingle', async (f: any) => { seen.push(f.id); },
    { lawFirmId: firm.id });

  expect(seen).toEqual([firm.id]);
  expect(result.firmsTotal).toBe(1);
});

it('reports no work when there are no firms', async () => {
  await resetCursor('pagingEmpty');

  const result = await forEachFirm('pagingEmpty', async () => {
    throw new Error('handler must not run');
  });

  expect(result).toEqual({ firmsProcessed: 0, firmsTotal: 0, truncated: false });
});
