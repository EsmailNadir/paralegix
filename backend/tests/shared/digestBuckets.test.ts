/**
 * Unit coverage for the daily digest's pure assembly: bucketing, capping and
 * link building. No server, no database — run offline with
 * `__TEST_TOKEN__=offline npx jest tests/shared/digestBuckets.test.js`.
 */

const {
  bucketItems,
  applyCaps,
  itemUrl,
  bucketUrl,
  DIGEST_CAPS,
} = require('../../src/modules/notifications/digest/digestBuckets');

const TODAY = '2026-03-10'; // a Tuesday
const TOMORROW = '2026-03-11';

const task = (id: any, day: any, extra = {}) => ({ kind: 'task', id, title: `Task ${id}`, day, ...extra });

describe('bucketItems', () => {
  it('splits items into overdue / today / tomorrow / week', () => {
    const buckets = bucketItems(
      [
        task('a', '2026-03-08'),
        task('b', TODAY),
        task('c', TOMORROW),
        task('d', '2026-03-15'),
      ],
      TODAY
    );

    expect(buckets.overdue.map((i: any) => i.id)).toEqual(['a']);
    expect(buckets.today.map((i: any) => i.id)).toEqual(['b']);
    expect(buckets.tomorrow.map((i: any) => i.id)).toEqual(['c']);
    expect(buckets.week.map((i: any) => i.id)).toEqual(['d']);
    expect(buckets.critical).toEqual([]);
  });

  it('sorts overdue oldest-first', () => {
    const buckets = bucketItems(
      [task('newest', '2026-03-09'), task('oldest', '2026-02-20'), task('middle', '2026-03-01')],
      TODAY
    );
    expect(buckets.overdue.map((i: any) => i.id)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('sorts the lookahead buckets soonest-first', () => {
    const buckets = bucketItems(
      [task('far', '2026-03-17'), task('near', '2026-03-12'), task('mid', '2026-03-14')],
      TODAY
    );
    expect(buckets.week.map((i: any) => i.id)).toEqual(['near', 'mid', 'far']);
  });

  it('ignores items with no day', () => {
    const buckets = bucketItems(
      [task('none', null), task('blank', ''), { kind: 'task', id: 'missing' }, task('kept', TODAY)],
      TODAY
    );
    expect(buckets.today.map((i: any) => i.id)).toEqual(['kept']);
    expect(buckets.overdue).toEqual([]);
    expect(buckets.week).toEqual([]);
  });

  it('tolerates a full timestamp in `day` by comparing the date portion only', () => {
    const buckets = bucketItems([task('ts', `${TODAY}T18:30:00.000Z`)], TODAY);
    expect(buckets.today.map((i: any) => i.id)).toEqual(['ts']);
  });

  it('places a critical item in BOTH critical and its own day bucket', () => {
    const statute = {
      kind: 'statute',
      id: 'm1',
      title: 'Statute of limitations',
      day: TOMORROW,
      critical: true,
      matterId: 'm1',
    };
    const buckets = bucketItems([statute], TODAY);

    expect(buckets.critical.map((i: any) => i.id)).toEqual(['m1']);
    expect(buckets.tomorrow.map((i: any) => i.id)).toEqual(['m1']);
    expect(buckets.today).toEqual([]);
  });

  it('returns empty buckets when today is missing or items is not an array', () => {
    expect(bucketItems([task('a', TODAY)], null).today).toEqual([]);
    expect(bucketItems(null, TODAY).today).toEqual([]);
  });
});

describe('applyCaps', () => {
  it('truncates a bucket over its cap and reports the overflow', () => {
    const over = DIGEST_CAPS.today + 5;
    const items = Array.from({ length: over }, (_, i) => task(`t${i}`, TODAY));
    const capped = applyCaps(bucketItems(items, TODAY));

    expect(capped.today.shown).toHaveLength(DIGEST_CAPS.today);
    expect(capped.today.more).toBe(5);
    expect(capped.today.total).toBe(over);
  });

  it('reports more: 0 for an under-cap bucket', () => {
    const items = Array.from({ length: DIGEST_CAPS.tomorrow - 1 }, (_, i) => task(`t${i}`, TOMORROW));
    const capped = applyCaps(bucketItems(items, TODAY));

    expect(capped.tomorrow.shown).toHaveLength(DIGEST_CAPS.tomorrow - 1);
    expect(capped.tomorrow.more).toBe(0);
    expect(capped.tomorrow.total).toBe(DIGEST_CAPS.tomorrow - 1);
  });

  it('never truncates critical items', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      kind: 'statute',
      id: `m${i}`,
      title: 'Statute of limitations',
      day: TODAY,
      critical: true,
      matterId: `m${i}`,
    }));
    const capped = applyCaps(bucketItems(items, TODAY));

    expect(capped.critical.shown).toHaveLength(20);
    expect(capped.critical.more).toBe(0);
    expect(capped.critical.total).toBe(20);
    // The same items still obey the day-bucket cap.
    expect(capped.today.shown).toHaveLength(DIGEST_CAPS.today);
  });

  it('counts totalItems pre-truncation and does not double-count critical items', () => {
    const items = [
      ...Array.from({ length: DIGEST_CAPS.overdue + 3 }, (_, i) => task(`o${i}`, '2026-03-01')),
      { kind: 'statute', id: 'm1', title: 'Statute', day: TODAY, critical: true, matterId: 'm1' },
      task('t1', TOMORROW),
    ];
    const capped = applyCaps(bucketItems(items, TODAY));

    // overdue (cap + 3) + today (the critical statute) + tomorrow (1)
    expect(capped.totalItems).toBe(DIGEST_CAPS.overdue + 3 + 1 + 1);
    expect(capped.overdue.shown).toHaveLength(DIGEST_CAPS.overdue);
    expect(capped.critical.total).toBe(1);
  });

  it('handles missing buckets without throwing', () => {
    const capped = applyCaps({});
    expect(capped.totalItems).toBe(0);
    expect(capped.critical).toEqual({ shown: [], more: 0, total: 0 });
    expect(capped.week).toEqual({ shown: [], more: 0, total: 0, overflowKinds: [] });
  });
});

describe('itemUrl', () => {
  const FIRM = 'firm-1';
  const base = () => `${process.env.FRONTEND_URL || 'http://localhost:3000'}/lawfirm/${FIRM}`;

  it('links a task to the task detail page', () => {
    expect(itemUrl(FIRM, { kind: 'task', id: 'task-9' })).toBe(`${base()}/tasks/task-9`);
  });

  it('links an event to its matter events tab', () => {
    expect(itemUrl(FIRM, { kind: 'event', id: 'e1', matterId: 'm7' })).toBe(
      `${base()}/matters/m7?tab=events`
    );
  });

  it('links a statute to its matter', () => {
    expect(itemUrl(FIRM, { kind: 'statute', id: 'm7', matterId: 'm7' })).toBe(`${base()}/matters/m7`);
  });

  it('links a matter invoice under its matter', () => {
    expect(itemUrl(FIRM, { kind: 'invoice', id: 'inv-1', matterId: 'm7' })).toBe(
      `${base()}/matters/m7/invoices/inv-1`
    );
  });

  it('falls back to the client when an invoice has no matter', () => {
    expect(itemUrl(FIRM, { kind: 'invoice', id: 'inv-2', matterId: null, clientContextId: 'c3' })).toBe(
      `${base()}/clients/c3/invoices/inv-2`
    );
  });

  it('falls back to the billing list when an invoice has neither matter nor client', () => {
    expect(itemUrl(FIRM, { kind: 'invoice', id: 'inv-3' })).toBe(`${base()}/billing`);
  });

  it('returns an absolute url honoring FRONTEND_URL', () => {
    const previous = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://app.example.com/';
    try {
      expect(itemUrl(FIRM, { kind: 'task', id: 't1' })).toBe(
        'https://app.example.com/lawfirm/firm-1/tasks/t1'
      );
    } finally {
      if (previous === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = previous;
    }
  });
});

describe('bucketUrl', () => {
  const base = () => process.env.FRONTEND_URL || 'http://localhost:3000';

  it('links to the filtered task list, scoped to the recipient, when the hidden items are all tasks', () => {
    // The list applies no assignee predicate of its own, so without the filter an
    // owner would land on every task in the firm rather than on their own.
    expect(bucketUrl('firm-1', 'overdue', ['task'], 'user-9'))
      .toBe(`${base()}/lawfirm/firm-1/tasks?due=overdue&assignedTo=user-9`);
  });

  it('escapes a recipient id that is not url-safe', () => {
    expect(bucketUrl('firm-1', 'today', ['task'], 'user id/1'))
      .toBe(`${base()}/lawfirm/firm-1/tasks?due=today&assignedTo=user%20id%2F1`);
  });

  it('omits the assignee filter when no recipient is supplied', () => {
    expect(bucketUrl('firm-1', 'overdue', ['task']))
      .toBe(`${base()}/lawfirm/firm-1/tasks?due=overdue`);
  });

  it('falls back to the dashboard when the overflow is not tasks', () => {
    // The task list cannot render an invoice or an event, and it sits behind
    // `tasks.view` - sending someone there to find one shows the wrong thing.
    expect(bucketUrl('firm-1', 'week', ['invoice'], 'user-9')).toBe(`${base()}/lawfirm/firm-1`);
    expect(bucketUrl('firm-1', 'week', ['event'], 'user-9')).toBe(`${base()}/lawfirm/firm-1`);
  });

  it('falls back to the dashboard for a mixed overflow', () => {
    expect(bucketUrl('firm-1', 'week', ['task', 'invoice'], 'user-9')).toBe(`${base()}/lawfirm/firm-1`);
  });

  it('falls back to the dashboard when the overflow is unknown', () => {
    expect(bucketUrl('firm-1', 'overdue', [], 'user-9')).toBe(`${base()}/lawfirm/firm-1`);
    expect(bucketUrl('firm-1', 'overdue')).toBe(`${base()}/lawfirm/firm-1`);
  });
});

describe('applyCaps overflow reporting', () => {
  const item = (kind: any, day: any, id: any) => ({ kind, id, title: id, day });

  it('reports only the kinds that were truncated, not the kinds shown', () => {
    // 8 tasks fill the overdue cap, so the two hidden rows are both invoices -
    // the link must not claim the task list covers them.
    const overdue = [];
    for (let i = 0; i < 8; i += 1) overdue.push(item('task', '2026-07-20', `t${i}`));
    overdue.push(item('invoice', '2026-07-21', 'i1'));
    overdue.push(item('invoice', '2026-07-22', 'i2'));

    const capped = applyCaps({ overdue, today: [], tomorrow: [], week: [], critical: [] });
    expect(capped.overdue.more).toBe(2);
    expect(capped.overdue.overflowKinds).toEqual(['invoice']);
  });

  it('reports an empty overflow when nothing was truncated', () => {
    const capped = applyCaps({
      overdue: [item('task', '2026-07-20', 't1')],
      today: [], tomorrow: [], week: [], critical: [],
    });
    expect(capped.overdue.more).toBe(0);
    expect(capped.overdue.overflowKinds).toEqual([]);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
