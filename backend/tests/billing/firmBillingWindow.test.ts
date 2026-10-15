/**
 * Firm billing list filtering / ordering / windowing - pure unit tests.
 *
 * Unlike the rest of this suite these hit no server and no database: the module
 * under test is pure functions over already-derived billing records. They are
 * here because these predicates decide which invoices a firm sees under
 * "overdue", "due within 30 days" and each due bucket, and which time entries
 * count as still needing an invoice. A quiet change to any of them shows up as a
 * money figure that is wrong rather than as a crash.
 *
 * The suite's globalSetup still demands the integration auth env even though
 * nothing here uses it, so to run this file alone set any value for the
 * pre-fetched token, which short-circuits the Firebase sign-in:
 *
 *   __TEST_TOKEN__=offline npx jest tests/billing/firmBillingWindow.test.js
 */

const w = require('../../src/modules/billing/shared/firmBillingWindow');

// A fixed "today" so the calendar-day rules are asserted against a known day
// rather than whenever the suite happens to run.
const TODAY = '2026-07-26';

/** An invoice record in the shape listFirmInvoices produces. */
const inv = (id: any, overrides = {}) => ({
  id,
  totalAmount: 100,
  amountPaid: 0,
  totalWrittenOff: 0,
  isPaid: false,
  remainingBalance: 100,
  invoiceDate: '2026-07-01',
  dueDate: null,
  nextPaymentDate: null,
  paymentPlan: null,
  matterId: null,
  clientId: null,
  matterName: null,
  clientName: null,
  matterClientNames: [],
  invoiceName: null,
  invoiceNumber: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  ...overrides,
});

/** A time-entry record in the shape listFirmTimeEntries produces. */
const entry = (id: any, overrides = {}) => ({
  id,
  contextType: 'matter',
  matterId: 'm1',
  clientId: null,
  matterClientId: null,
  matterClientIds: [],
  userId: 'u1',
  userName: 'Ann',
  chargeCodeId: null,
  billingStatus: 'unbilled',
  date: '2026-07-10',
  name: '',
  description: '',
  matterName: 'Acme v. Globex',
  clientName: null,
  clientNames: [],
  sourceTaskTitle: null,
  sourceEventTitle: null,
  hours: 1,
  ...overrides,
});

const ids = (records: any) => records.map((r: any) => r.id);

describe('invoiceStatusKey', () => {
  test('is overdue once the due day is behind the viewer\'s today', () => {
    expect(w.invoiceStatusKey(inv('a', { dueDate: '2026-07-25' }), TODAY)).toBe('overdue');
  });

  test('is not overdue on the due day itself', () => {
    expect(w.invoiceStatusKey(inv('a', { dueDate: TODAY }), TODAY)).toBe('outstanding');
  });

  test('reports a part-paid invoice as partially_paid even when it is past due', () => {
    const record = inv('a', { amountPaid: 40, remainingBalance: 60, dueDate: '2026-07-01' });
    expect(w.invoiceStatusKey(record, TODAY)).toBe('partially_paid');
  });

  test('calls a written-off balance credited, not paid', () => {
    // Collecting nothing and forgiving the rest is not the firm being paid.
    const record = inv('a', { totalWrittenOff: 100, remainingBalance: 0, isPaid: false });
    expect(w.invoiceStatusKey(record, TODAY)).toBe('credited');
    expect(w.invoiceStatusKey(inv('b', { amountPaid: 100, remainingBalance: 0, isPaid: true }), TODAY))
      .toBe('paid');
  });

  test('leaves a zero-total invoice outstanding rather than paid', () => {
    expect(w.invoiceStatusKey(inv('a', { totalAmount: 0, remainingBalance: 0 }), TODAY))
      .toBe('outstanding');
  });

  test('reads a zero-total invoice paid once it is marked paid, and never awaiting payment', () => {
    const marked = inv('a', { totalAmount: 0, remainingBalance: 0, isPaid: true, dueDate: '2026-07-01' });
    expect(w.invoiceStatusKey(marked, TODAY)).toBe('paid');
    expect(w.isAwaitingPayment(marked, TODAY)).toBe(false);
  });

  test('takes the due day from the payment plan\'s next pending installment', () => {
    const record = inv('a', {
      dueDate: '2026-12-31',
      paymentPlan: {
        enabled: true,
        expectedPayments: [
          { status: 'paid', dueDate: '2026-06-01' },
          { status: 'pending', dueDate: '2026-07-20' },
        ],
      },
    });
    expect(w.invoiceStatusKey(record, TODAY)).toBe('overdue');
  });
});

describe('isAwaitingPayment', () => {
  test('excludes invoices with nothing left to collect', () => {
    expect(w.isAwaitingPayment(inv('a', { totalAmount: 0, remainingBalance: 0 }), TODAY)).toBe(false);
    expect(w.isAwaitingPayment(inv('b', { amountPaid: 100, remainingBalance: 0, isPaid: true }), TODAY)).toBe(false);
    expect(w.isAwaitingPayment(inv('c', { totalWrittenOff: 100, remainingBalance: 0 }), TODAY)).toBe(false);
  });

  test('includes a partly paid invoice for its remaining balance', () => {
    expect(w.isAwaitingPayment(inv('a', { amountPaid: 40, remainingBalance: 60 }), TODAY)).toBe(true);
  });
});

describe('filterInvoices', () => {
  const dueSet = [
    inv('yesterday', { dueDate: '2026-07-25' }),
    inv('today', { dueDate: TODAY }),
    inv('in30', { dueDate: '2026-08-25' }),
    inv('in31', { dueDate: '2026-08-26' }),
    inv('nodate'),
    inv('paid', { dueDate: '2026-08-10', amountPaid: 100, remainingBalance: 0, isPaid: true }),
    inv('partial', { dueDate: '2026-08-05', amountPaid: 40, remainingBalance: 60 }),
    inv('empty', { dueDate: '2026-08-05', totalAmount: 0, remainingBalance: 0 }),
  ];

  test('due_soon spans today through 30 days out, and skips settled invoices', () => {
    expect(ids(w.filterInvoices(dueSet, { status: 'due_soon', todayDay: TODAY })))
      .toEqual(['today', 'in30', 'partial']);
  });

  test('unpaid covers every invoice still owing money', () => {
    expect(ids(w.filterInvoices(dueSet, { status: 'unpaid', todayDay: TODAY })))
      .toEqual(['yesterday', 'today', 'in30', 'in31', 'nodate', 'partial']);
  });

  test('overdue includes a partially paid invoice whose due day has passed', () => {
    const records = [
      inv('partialOverdue', { dueDate: '2026-07-01', amountPaid: 40, remainingBalance: 60 }),
      inv('partialFuture', { dueDate: '2026-08-01', amountPaid: 40, remainingBalance: 60 }),
    ];
    expect(ids(w.filterInvoices(records, { status: 'overdue', todayDay: TODAY })))
      .toEqual(['partialOverdue']);
  });

  test('date bounds compare calendar days and include both ends', () => {
    const dated = [
      inv('jun30', { invoiceDate: '2026-06-30' }),
      inv('jul01', { invoiceDate: '2026-07-01' }),
      inv('jul31', { invoiceDate: '2026-07-31' }),
      inv('aug01', { invoiceDate: '2026-08-01' }),
      inv('none', { invoiceDate: null }),
    ];
    expect(ids(w.filterInvoices(dated, { dateFrom: '2026-07-01', dateTo: '2026-07-31' })))
      .toEqual(['jul01', 'jul31']);
  });

  test('search covers the invoice name, number, matter and clients', () => {
    const searchable = [
      inv('byName', { invoiceName: 'Acme retainer' }),
      inv('byNumber', { invoiceNumber: 'INV-2026-0042' }),
      inv('byMatter', { matterName: 'Acme v. Globex' }),
      inv('byClient', { clientName: 'Acme Holdings' }),
      inv('byCoClient', { matterClientNames: ['Someone', 'Acme Sub'] }),
      inv('miss', { invoiceName: 'Unrelated' }),
    ];
    expect(ids(w.filterInvoices(searchable, { search: 'acme' })))
      .toEqual(['byName', 'byMatter', 'byClient', 'byCoClient']);
    expect(ids(w.filterInvoices(searchable, { search: '0042' }))).toEqual(['byNumber']);
  });

  test('the client filter matches only the client billed, never a co-client', () => {
    const records = [inv('a', { clientId: 'c1' }), inv('b', { clientId: 'c2' }), inv('c')];
    expect(ids(w.filterInvoices(records, { clientId: 'c1' }))).toEqual(['a']);
  });

  test('awaitingOnly drops every invoice with nothing left to collect', () => {
    // The upcoming-payment tiles total this set; a settled invoice in it is a
    // payment the firm is told to expect that will never arrive.
    expect(ids(w.filterInvoices(dueSet, { awaitingOnly: true, todayDay: TODAY })))
      .toEqual(['yesterday', 'today', 'in30', 'in31', 'nodate', 'partial']);
  });

  test('a plain status key selects that derived status only', () => {
    const records = [
      ...dueSet,
      inv('writtenOff', { totalWrittenOff: 100, remainingBalance: 0 }),
    ];
    expect(ids(w.filterInvoices(records, { status: 'partially_paid', todayDay: TODAY }))).toEqual(['partial']);
    expect(ids(w.filterInvoices(records, { status: 'credited', todayDay: TODAY }))).toEqual(['writtenOff']);
    expect(ids(w.filterInvoices(records, { status: 'paid', todayDay: TODAY }))).toEqual(['paid']);
  });

  test('the matter filter keeps that matter\'s invoices and drops direct ones', () => {
    const records = [inv('m1a', { matterId: 'm1' }), inv('m2', { matterId: 'm2' }), inv('direct')];
    expect(ids(w.filterInvoices(records, { matterId: 'm1' }))).toEqual(['m1a']);
  });

  test('the due-date range bounds the next payment day, inclusive, and drops undated invoices', () => {
    expect(ids(w.filterInvoices(dueSet, { dueDateFrom: TODAY, dueDateTo: '2026-08-25', todayDay: TODAY })))
      .toEqual(['today', 'in30', 'paid', 'partial', 'empty']);
  });

  test('the related-client filter includes direct and linked-matter invoices', () => {
    const records = [
      inv('direct', { contextType: 'client', entityId: 'c1', clientId: 'c1' }),
      inv('linkedMatter', { contextType: 'matter', entityId: 'm1', relatedClientIds: ['c1', 'c2'] }),
      inv('otherMatter', { contextType: 'matter', entityId: 'm2', relatedClientIds: ['c2'] }),
    ];
    expect(ids(w.filterInvoices(records, { relatedClientId: 'c1' })))
      .toEqual(['direct', 'linkedMatter']);
  });
});

describe('summarizeOwnedInvoices', () => {
  test('sums only the invoices this client owns, in whole cents', () => {
    // 0.10 + 0.20 is 0.30000000000000004 in floats. Summed as dollars this
    // reports a billed total a hair off, and every outstanding figure after it.
    const records = [
      inv('a', { billingRelation: 'owned', totalAmount: 0.1, amountPaid: 0.05 }),
      inv('b', { billingRelation: 'owned', totalAmount: 0.2, amountPaid: 0 }),
      inv('c', { billingRelation: 'other_client', totalAmount: 500, amountPaid: 0 }),
      inv('d', { billingRelation: 'shared_unassigned', totalAmount: 75, amountPaid: 0 }),
    ];
    expect(w.summarizeOwnedInvoices(records)).toEqual({
      ownedCount: 2, totalBilled: 0.3, totalPaid: 0.05, totalOutstanding: 0.25,
    });
  });

  test('never reports a negative outstanding when more was paid than billed', () => {
    const records = [inv('over', { billingRelation: 'owned', totalAmount: 100, amountPaid: 120 })];
    expect(w.summarizeOwnedInvoices(records)).toEqual({
      ownedCount: 1, totalBilled: 100, totalPaid: 120, totalOutstanding: 0,
    });
  });

  test('subtracts what was written off, invoice by invoice', () => {
    const records = [inv('w', { billingRelation: 'owned', totalAmount: 100, amountPaid: 0, totalWrittenOff: 40 })];
    expect(w.summarizeOwnedInvoices(records)).toEqual({
      ownedCount: 1, totalBilled: 100, totalPaid: 0, totalOutstanding: 60,
    });
  });

  test('does not let one over-settled invoice cancel another invoice that is still owed', () => {
    // 120 paid on a 100 invoice is 20 of credit on THAT invoice. The 50 owed on
    // the other one is still owed; a single clamp over the sums reported 30.
    const records = [
      inv('over', { billingRelation: 'owned', totalAmount: 100, amountPaid: 120 }),
      inv('owed', { billingRelation: 'owned', totalAmount: 50, amountPaid: 0 }),
    ];
    expect(w.summarizeOwnedInvoices(records)).toEqual({
      ownedCount: 2, totalBilled: 150, totalPaid: 120, totalOutstanding: 50,
    });
  });

  test('leaves a voided invoice out entirely', () => {
    const records = [
      inv('v', { billingRelation: 'owned', status: 'voided', totalAmount: 900, amountPaid: 0 }),
      inv('live', { billingRelation: 'owned', totalAmount: 100, amountPaid: 25 }),
    ];
    expect(w.summarizeOwnedInvoices(records)).toEqual({
      ownedCount: 1, totalBilled: 100, totalPaid: 25, totalOutstanding: 75,
    });
  });
});

describe('a voided invoice', () => {
  // Due long ago with its whole balance still on paper: every rule that reads
  // the amounts alone would call this overdue and owed.
  const voided = () => inv('v', { status: 'voided', dueDate: '2026-07-01' });

  test('reports its own status key rather than one derived from the balance', () => {
    expect(w.invoiceStatusKey(voided(), TODAY)).toBe('voided');
  });

  test('is not awaiting payment and is not past due', () => {
    expect(w.isAwaitingPayment(voided(), TODAY)).toBe(false);
    expect(w.isPastDue(voided(), TODAY)).toBe(false);
  });

  test('counts under its own chip and never under overdue', () => {
    expect(w.countInvoiceStatuses([voided(), inv('live', { dueDate: '2026-07-01' })], TODAY))
      .toEqual({ all: 2, overdue: 1, voided: 1 });
  });

  test('is selected by the voided filter and by none of the money filters', () => {
    const records = [voided(), inv('live', { dueDate: '2026-07-01' })];
    expect(ids(w.filterInvoices(records, { status: 'voided', todayDay: TODAY }))).toEqual(['v']);
    expect(ids(w.filterInvoices(records, { status: 'unpaid', todayDay: TODAY }))).toEqual(['live']);
    expect(ids(w.filterInvoices(records, { status: 'overdue', todayDay: TODAY }))).toEqual(['live']);
    expect(ids(w.filterInvoices(records, { awaitingOnly: true, todayDay: TODAY }))).toEqual(['live']);
  });

  test('sorts with the settled invoices, after everything still owed', () => {
    const records = [voided(), inv('later', { dueDate: '2026-09-01' })];
    const cmp = w.resolveComparator('paymentPriority:asc', w.INVOICE_COMPARATORS, TODAY);
    expect(ids([...records].sort(cmp))).toEqual(['later', 'v']);
  });
});

describe('due buckets', () => {
  const groupSet = [
    inv('overdue', { dueDate: '2026-07-25' }),
    inv('week7', { dueDate: '2026-08-02' }),
    inv('month8', { dueDate: '2026-08-03' }),
    inv('month30', { dueDate: '2026-08-25' }),
    inv('later31', { dueDate: '2026-08-26' }),
    inv('nodate'),
  ];

  test('bucket a next-payment day by how far out it is', () => {
    expect(groupSet.map((r) => w.dueGroupForDay(w.invoiceNextPaymentDay(r), TODAY)))
      .toEqual(['overdue', 'this_week', 'this_month', 'this_month', 'later', 'no_date']);
  });

  test('the bucket filter selects exactly that bucket', () => {
    expect(ids(w.filterInvoices(groupSet, { dueGroup: 'this_month', todayDay: TODAY })))
      .toEqual(['month8', 'month30']);
  });

  test('bucket totals sum every matching invoice, plus an all-buckets total', () => {
    expect(w.dueGroupTotals(groupSet, TODAY)).toEqual({
      all: { count: 6, amount: 600 },
      overdue: { count: 1, amount: 100 },
      this_week: { count: 1, amount: 100 },
      this_month: { count: 2, amount: 200 },
      later: { count: 1, amount: 100 },
      no_date: { count: 1, amount: 100 },
    });
  });
});

describe('ordering', () => {
  test('paymentPriority puts what is owed first, soonest due first', () => {
    const records = [
      inv('paidOld', { amountPaid: 100, remainingBalance: 0, isPaid: true, dueDate: '2026-01-01' }),
      inv('dueLater', { dueDate: '2026-09-01' }),
      inv('dueSoon', { dueDate: '2026-07-27' }),
    ];
    const cmp = w.resolveComparator('paymentPriority:asc', w.INVOICE_COMPARATORS, TODAY);
    expect(ids([...records].sort(cmp))).toEqual(['dueSoon', 'dueLater', 'paidOld']);
  });

  test('dueGroup orders by bucket then due day, undated last', () => {
    const records = [
      inv('nodate'),
      inv('later', { dueDate: '2026-09-30' }),
      inv('overdue', { dueDate: '2026-07-01' }),
      inv('week', { dueDate: '2026-07-28' }),
    ];
    const cmp = w.resolveComparator('dueGroup:asc', w.INVOICE_COMPARATORS, TODAY);
    expect(ids([...records].sort(cmp))).toEqual(['overdue', 'week', 'later', 'nodate']);
  });

  test('createdAt honors conventional ascending and descending directions', () => {
    const records = [
      inv('newer', { createdAt: '2026-07-20T00:00:00.000Z' }),
      inv('older', { createdAt: '2026-07-10T00:00:00.000Z' }),
    ];
    const asc = w.resolveComparator('createdAt:asc', w.INVOICE_COMPARATORS, TODAY);
    const desc = w.resolveComparator('createdAt:desc', w.INVOICE_COMPARATORS, TODAY);
    expect(ids([...records].sort(asc))).toEqual(['older', 'newer']);
    expect(ids([...records].sort(desc))).toEqual(['newer', 'older']);
  });

  test('time-entry date descending puts the newest work first', () => {
    const records = [
      entry('older', { date: '2026-07-10' }),
      entry('newer', { date: '2026-07-20' }),
    ];
    const desc = w.resolveComparator('date:desc', w.TIME_ENTRY_COMPARATORS, TODAY);
    expect(ids([...records].sort(desc))).toEqual(['newer', 'older']);
  });

  test('paymentPriority falls back to the invoice date, and puts an undated invoice after a dated one', () => {
    const records = [
      inv('undated', { invoiceDate: null }),
      inv('issuedOnly', { invoiceDate: '2026-07-02' }),
      inv('alsoUndated', { invoiceDate: null }),
    ];
    const cmp = w.resolveComparator('paymentPriority:asc', w.INVOICE_COMPARATORS, TODAY);
    expect(ids([...records].sort(cmp))).toEqual(['issuedOnly', 'undated', 'alsoUndated']);
  });

  test('dueGroup keeps two undated invoices in their original order', () => {
    const records = [inv('first'), inv('second'), inv('dated', { dueDate: '2026-07-30' })];
    const cmp = w.resolveComparator('dueGroup:asc', w.INVOICE_COMPARATORS, TODAY);
    expect(ids([...records].sort(cmp))).toEqual(['dated', 'first', 'second']);
  });

  test('time entries sort by member, hours and amount, with an unpriced entry as zero', () => {
    const records = [
      entry('ann', { userName: 'Ann', hours: 2.5, amount: 250 }),
      entry('unpriced', { userName: null, hours: 0.1, amount: null }),
      entry('bob', { userName: 'Bob', hours: 1, amount: 100.01 }),
    ];
    const sortBy = (model: string) =>
      ids([...records].sort(w.resolveComparator(model, w.TIME_ENTRY_COMPARATORS, TODAY)));
    expect(sortBy('member:asc')).toEqual(['unpriced', 'ann', 'bob']);
    expect(sortBy('hours:desc')).toEqual(['ann', 'bob', 'unpriced']);
    expect(sortBy('amount:asc')).toEqual(['unpriced', 'bob', 'ann']);
  });

  test('an unrecognized sort field resolves to no comparator, leaving the default', () => {
    expect(w.resolveComparator('nope:asc', w.INVOICE_COMPARATORS, TODAY)).toBeNull();
  });
});

describe('filterTimeEntries', () => {
  const entries = [
    entry('matterNamed', { matterClientIds: ['c1'] }),
    entry('matterOther', { matterClientIds: ['c2'] }),
    entry('matterNone'),
    entry('clientDirect', { contextType: 'client', matterId: null, clientId: 'c1' }),
  ];

  test('the client filter finds work billed to that client, on a matter or directly', () => {
    // Matter work with no client named is billed to nobody in particular, so it
    // must not be charged to whoever the filter picked.
    expect(ids(w.filterTimeEntries(entries, { clientId: 'c1' })))
      .toEqual(['matterNamed', 'clientDirect']);
  });

  test('the context filter separates matter work from direct client work', () => {
    expect(ids(w.filterTimeEntries(entries, { context: 'client' }))).toEqual(['clientDirect']);
  });

  test('billingStatus accepts a set, so "not yet invoiced" is one request', () => {
    const mixed = [
      entry('a', { billingStatus: 'unbilled' }),
      entry('b', { billingStatus: 'billed' }),
      entry('c', { billingStatus: 'queued' }),
    ];
    expect(ids(w.filterTimeEntries(mixed, { billingStatus: 'unbilled,queued,covered_by_retainer' })))
      .toEqual(['a', 'c']);
    expect(ids(w.filterTimeEntries(mixed, { billingStatus: 'billed' }))).toEqual(['b']);
  });

  test('date bounds compare calendar days', () => {
    const dated = [entry('a', { date: '2026-07-09' }), entry('b', { date: '2026-07-10' })];
    expect(ids(w.filterTimeEntries(dated, { dateFrom: '2026-07-10' }))).toEqual(['b']);
    expect(ids(w.filterTimeEntries(dated, { dateTo: '2026-07-09' }))).toEqual(['a']);
  });

  test('a client scope takes direct work by its billed client, and matter work by the matter\'s clients', () => {
    // A direct entry billed to someone else must not ride in on the scope just
    // because a matter client elsewhere matches: its own client decides.
    const scoped = [
      entry('direct', { contextType: 'client', matterId: null, clientId: 'c1' }),
      entry('directOther', { contextType: 'client', matterId: null, clientId: 'c2', matterClients: [{ id: 'c1' }] }),
      entry('onMatter', { matterClients: [{ id: 'c9' }, { id: 'c1' }] }),
      entry('offMatter', { matterClients: [{ id: 'c2' }, null] }),
      entry('noClients'),
    ];
    expect(ids(w.filterTimeEntries(scoped, { clientScope: new Set(['c1']) })))
      .toEqual(['direct', 'onMatter']);
  });

  test('search covers the member who logged the work', () => {
    const records = [entry('a'), entry('b', { userName: 'Bob' })];
    expect(ids(w.filterTimeEntries(records, { search: 'bob' }))).toEqual(['b']);
  });
});

describe('windowList', () => {
  const rows = Array.from({ length: 25 }, (_, i) => i + 1);

  test('returns the requested page and the full match count', () => {
    expect(w.windowList(rows, { limit: 10, page: 3 }))
      .toEqual({ items: [21, 22, 23, 24, 25], totalItems: 25 });
  });

  test('returns everything when no limit is supplied', () => {
    // The workbench and the billing summary depend on this: they aggregate over
    // the whole firm and must never be handed a page.
    expect(w.windowList(rows, {})).toEqual({ items: rows, totalItems: 25 });
  });

  test('clamps a page size above the ceiling', () => {
    expect(w.windowList(rows, { limit: 5000, page: 1 }).items).toHaveLength(25);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
