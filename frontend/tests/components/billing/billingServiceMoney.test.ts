/**
 * The money-moving half of the billing service, tested OFFLINE against a fake
 * transport.
 *
 * `billingService.test.ts` next door covers the read/list/create surface: the
 * context segment, the invoice list, the firm invoice page, the three payment
 * verbs and the split flow. This file takes the operations it does not reach,
 * and they are the ones that change what a client owes: credit notes, ad-hoc
 * amounts, late fees, payment plans and their installments, line-item replaces,
 * the flat-fee and expense edit/delete routes, the trust deposit request, and
 * the arithmetic in `generateInvoiceFromUnbilled`.
 *
 * THREE HAZARDS DRIVE THE ASSERTIONS.
 *
 * 1. UNITS. Postgres stores money as integer cents, but these invoice routes
 *    speak dollars, and exactly one route on this service (`requestTrustDeposit`)
 *    speaks cents, under a differently-named key. So the useful assertion is
 *    never "the digits appear somewhere in the request" - 731.90 dollars and
 *    73190 cents share every digit. It is that the exact NUMBER the caller
 *    passed arrives under the exact KEY the server reads, unconverted.
 *
 * 2. ATTRIBUTION. Every one of these routes carries the invoice id in the path.
 *    A payment or a write-off filed against the wrong invoice leaves both
 *    invoices wrong and balances the firm's books to the same total, so nothing
 *    looks broken on any screen.
 *
 * 3. WHICH OPERATION. A credit note and a payment both reduce a balance, and
 *    they are different ledger events: one forgives money, the other receives
 *    it. They are told apart only by the endpoint the browser picks.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import billingService, {
  FIRM_BILLING_MAX_LIMIT,
  FIRM_TIME_ENTRY_SELECT_ALL_CEILING,
  FIRM_TIME_ENTRY_SELECT_ALL_MAX_PAGES,
} from '@/services/billing.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import type { UnbilledSummary } from '@/types';

const LAW_FIRM_ID = 'firm-1';
const MATTER_CONTEXT = { type: 'matter' as const, entityId: 'matter-9', lawFirmId: LAW_FIRM_ID };
const CLIENT_CONTEXT = { type: 'client' as const, entityId: 'client-7', lawFirmId: LAW_FIRM_ID };

/**
 * Query parameters read back the way a server reads them.
 *
 * A query string encodes a space as `+`, which `decodeURIComponent` leaves as a
 * literal plus. Reading through `URLSearchParams` is the only way to assert what
 * the backend will actually parse out of a search phrase.
 */
const paramsOf = (url: string): URLSearchParams => new URL(url, 'http://x').searchParams;

const bodyOf = (call: { body: unknown }): Record<string, unknown> =>
  call.body as Record<string, unknown>;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  // The dev-only duplicate-GET guard warns when the same endpoint is hit twice
  // inside its window. Several cases here deliberately read one endpoint twice
  // to compare two parameter sets, and the warning would bury the real output.
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

describe('each kind of billable work has its own collection', () => {
  it('creates a time entry, a flat fee and an expense on THREE different routes', async () => {
    api.post('/time-entries', { timeEntry: { id: 'te-1' } });
    api.post('/flat-fees', { flatFee: { id: 'ff-1' } });
    api.post('/expenses', { expense: { id: 'ex-1' } });

    await billingService.createTimeEntry(MATTER_CONTEXT, {
      userId: 'user-1', hours: 1, date: '2026-03-01',
    });
    await billingService.addFlatFee(MATTER_CONTEXT, { description: 'Filing', amount: 350 });
    await billingService.addExpense(MATTER_CONTEXT, { description: 'Courier', amount: 42 });

    // The three kinds bill differently: hours x rate, a fixed fee, and a
    // pass-through cost that is often not marked up at all. Collapsing two of
    // them onto one route files the work under the wrong kind, and the invoice
    // still totals correctly, so the error is invisible until a client queries
    // a line they were never meant to be charged an hourly rate for.
    const paths = api.calls('POST').map((call) => call.pathname);
    expect(paths).toEqual([
      expect.stringMatching(/\/billing\/time-entries$/),
      expect.stringMatching(/\/billing\/flat-fees$/),
      expect.stringMatching(/\/billing\/expenses$/),
    ]);
  });

  it('sends clientId, not matterId, when all three are created on a client', async () => {
    api.post('/time-entries', { timeEntry: { id: 'te-1' } });
    api.post('/flat-fees', { flatFee: { id: 'ff-1' } });
    api.post('/expenses', { expense: { id: 'ex-1' } });

    await billingService.createTimeEntry(CLIENT_CONTEXT, {
      userId: 'user-1', hours: 1, date: '2026-03-01',
    });
    await billingService.addFlatFee(CLIENT_CONTEXT, { description: 'Filing', amount: 350 });
    await billingService.addExpense(CLIENT_CONTEXT, { description: 'Courier', amount: 42 });

    // Creates put the context in the BODY rather than the path, so a context
    // key that defaulted to `matterId` would post client work against a matter
    // id that does not exist, or worse, one that does.
    expect(api.calls('POST')).toHaveLength(3);
    for (const call of api.calls('POST')) {
      expect(bodyOf(call).clientId).toBe('client-7');
      expect(bodyOf(call).matterId).toBeUndefined();
    }
  });

  it('edits a flat fee and an expense on their own context-segmented routes', async () => {
    api.put('/flat-fees/matter/matter-9/ff-1', { flatFee: { id: 'ff-1', amount: 400 } });
    api.put('/expenses/matter/matter-9/ex-1', { expense: { id: 'ex-1', amount: 50 } });

    await billingService.updateFlatFee(MATTER_CONTEXT, 'ff-1', { amount: 400 });
    await billingService.updateExpense(MATTER_CONTEXT, 'ex-1', { amount: 50 });

    // Same shape, two collections. An edit sent to the neighbouring collection
    // addresses an id that belongs to a different table and either 404s or, if
    // the ids ever collide, rewrites an unrelated charge.
    const [feeCall, expenseCall] = api.calls('PUT');
    expect(feeCall.pathname).toMatch(/\/flat-fees\/matter\/matter-9\/ff-1$/);
    expect(expenseCall.pathname).toMatch(/\/expenses\/matter\/matter-9\/ex-1$/);
    expect(api.callsTo('/expenses/matter/matter-9/ff-1')).toHaveLength(0);
  });

  it('sends only the payload on an edit, with no context key in the body', async () => {
    api.put('/flat-fees/matter/matter-9/ff-1', { flatFee: { id: 'ff-1' } });

    await billingService.updateFlatFee(MATTER_CONTEXT, 'ff-1', { amount: 400 });

    // The context is already in the path on an edit. Spreading it into the body
    // as well, the way the CREATE methods do, gives the server two sources for
    // the same fact and lets a stale one move the charge to another matter.
    const body = bodyOf(api.calls('PUT')[0]);
    expect(body).toEqual({ amount: 400 });
  });

  it('removes a flat fee without touching the expenses route', async () => {
    api.delete('/flat-fees/matter/matter-9/ff-1', {});

    await billingService.removeFlatFee(MATTER_CONTEXT, 'ff-1');

    expect(api.calls('DELETE')[0].pathname).toMatch(/\/flat-fees\/matter\/matter-9\/ff-1$/);
    expect(api.callsTo('/expenses/matter/matter-9/ff-1')).toHaveLength(0);
  });

  it('throws rather than reporting success when a delete is refused', async () => {
    api.delete('/expenses/matter/matter-9/ex-1', { status: 403, body: { error: 'Forbidden' } });

    // A delete that resolved on a 403 removes the row from the screen while the
    // charge stays on the invoice, so the next reload silently restores it.
    await expect(billingService.removeExpense(MATTER_CONTEXT, 'ex-1')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('the unit an amount leaves the browser in', () => {
  it('sends a credit note amount in dollars, exactly as given', async () => {
    api.post('/invoices/matter/matter-9/inv-1/credit-note', { invoice: { id: 'inv-1' } });

    await billingService.addCreditNote(MATTER_CONTEXT, 'inv-1', {
      amount: 731.9, type: 'write_off', description: 'Goodwill',
    });

    // Compared as a NUMBER against the exact value the caller passed. These
    // invoice routes take dollars; a service that multiplied by 100 on the way
    // out would write off 73,190 dollars against a 731.90 dollar balance, and
    // every digit of the wrong figure is a digit of the right one, so a
    // string-containment check would pass either way.
    const body = bodyOf(api.calls('POST')[0]);
    expect(body.amount).toBe(731.9);
    expect(body.type).toBe('write_off');
  });

  it('sends a trust deposit in integer CENTS under its own key', async () => {
    api.post('/stripe/trust/firm-1/request-deposit', { checkoutUrl: 'https://x', sessionId: 's1' });

    await billingService.requestTrustDeposit(LAW_FIRM_ID, {
      trustAccountId: 'trust-1', clientId: 'client-7', amountCents: 250000,
    });

    // The one route on this service that speaks cents. It is a Stripe checkout
    // amount, and Stripe takes the smallest currency unit. Sending 2500.00 here
    // charges a client 25 dollars for a 2,500 dollar retainer.
    const body = bodyOf(api.calls('POST')[0]);
    expect(body.amountCents).toBe(250000);
    expect(body.amount).toBeUndefined();
  });

  it('keeps the dollar routes and the cents route on their own units in one flow', async () => {
    api.patch('/invoices/matter/matter-9/inv-1/add-amount', { invoice: { id: 'inv-1' } });
    api.post('/stripe/trust/firm-1/request-deposit', { checkoutUrl: 'https://x', sessionId: 's1' });

    await billingService.addAmountToInvoice(MATTER_CONTEXT, 'inv-1', { amount: 25, note: 'Rush fee' });
    await billingService.requestTrustDeposit(LAW_FIRM_ID, {
      trustAccountId: 'trust-1', clientId: 'client-7', amountCents: 2500,
    });

    // Twenty-five dollars, twice, expressed two ways because two different
    // servers read it. Normalising both onto one unit is the change this pins:
    // it would leave one of the two off by a factor of a hundred.
    expect(bodyOf(api.calls('PATCH')[0]).amount).toBe(25);
    expect(bodyOf(api.calls('POST')[0]).amountCents).toBe(2500);
  });

  it('passes a fractional dollar amount through without re-rounding it', async () => {
    api.patch('/invoices/matter/matter-9/inv-1/add-amount', { invoice: { id: 'inv-1' } });

    await billingService.addAmountToInvoice(MATTER_CONTEXT, 'inv-1', { amount: 12.05 });

    // Rounding belongs to the server, which holds the cents. A helpful
    // `Math.round` here would turn every sub-dollar adjustment into 12.
    expect(bodyOf(api.calls('PATCH')[0]).amount).toBe(12.05);
  });
});

describe('a credit note and a payment are different ledger events', () => {
  it('POSTs a credit note to its own route and never to the payment route', async () => {
    api.post('/invoices/matter/matter-9/inv-1/credit-note', { invoice: { id: 'inv-1' } });

    await billingService.addCreditNote(MATTER_CONTEXT, 'inv-1', { amount: 100, type: 'discount' });

    // Both reduce the balance due. A payment says the firm received money; a
    // credit note says the firm gave it up. Routing one to the other reconciles
    // to the same outstanding figure while recording revenue that never arrived.
    expect(api.calls('POST')[0].pathname).toMatch(/\/inv-1\/credit-note$/);
    expect(api.callsTo('/inv-1/payment')).toHaveLength(0);
  });

  it('identifies a credit note by id and a payment by index when deleting', async () => {
    api.delete('/invoices/matter/matter-9/inv-1/credit-note', { invoice: { id: 'inv-1' } });
    api.delete('/invoices/matter/matter-9/inv-1/payment', { invoice: { id: 'inv-1' } });

    await billingService.deleteCreditNote(MATTER_CONTEXT, 'inv-1', 'cn-4');
    await billingService.deleteInvoicePayment(MATTER_CONTEXT, 'inv-1', 0);

    // Two reversals, two different identifiers: a credit note has a stable id, a
    // payment has only its position in the invoice's list. Sending one key to
    // the other route reverses nothing, or reverses whatever sits at that index.
    const [creditCall, paymentCall] = api.calls('DELETE');
    expect(paramsOf(creditCall.url).get('creditNoteId')).toBe('cn-4');
    expect(paramsOf(creditCall.url).get('paymentIndex')).toBeNull();
    expect(paramsOf(paymentCall.url).get('paymentIndex')).toBe('0');
    expect(paramsOf(paymentCall.url).get('creditNoteId')).toBeNull();
  });

  it('returns the updated invoice from a credit note, not the note', async () => {
    api.post('/invoices/matter/matter-9/inv-1/credit-note', {
      invoice: { id: 'inv-1', totalWrittenOff: 100, remainingBalance: 400 },
    });

    const invoice = await billingService.addCreditNote(MATTER_CONTEXT, 'inv-1', {
      amount: 100, type: 'write_off',
    });

    // The caller re-renders the balance from this. Handing back the note would
    // leave the screen showing the pre-write-off balance after a successful save.
    expect(invoice.id).toBe('inv-1');
    expect(invoice.totalWrittenOff).toBe(100);
    expect(invoice.remainingBalance).toBe(400);
  });
});

describe('a write-off or an adjustment lands on the invoice it was entered against', () => {
  it('addresses the invoice given, not another invoice on the same matter', async () => {
    api.get('/invoices/matter/matter-9', {
      invoices: [{ id: 'inv-1', invoiceName: 'March' }, { id: 'inv-2', invoiceName: 'April' }],
    });
    api.post('/invoices/matter/matter-9/inv-2/credit-note', { invoice: { id: 'inv-2' } });

    await billingService.listInvoices(MATTER_CONTEXT);
    await billingService.addCreditNote(MATTER_CONTEXT, 'inv-2', { amount: 50, type: 'adjustment' });

    // A matter carries many invoices and the list is loaded first. Writing the
    // amount off the wrong one leaves the firm's total receivable unchanged, so
    // no dashboard figure moves and nobody notices until a client disputes it.
    const [call] = api.calls('POST');
    expect(call.pathname).toContain('/inv-2/');
    expect(call.pathname).not.toContain('/inv-1/');
  });

  it('escapes an invoice id so a slash cannot become a path segment', async () => {
    const invoiceId = '2026/03-A';
    api.patch('/add-amount', { invoice: { id: invoiceId } });

    await billingService.addAmountToInvoice(MATTER_CONTEXT, invoiceId, { amount: 10 });

    // Firms number invoices with slashes. Unescaped, `2026/03-A` splits into two
    // segments and the request lands on a route that takes `2026` as the invoice
    // and `03-A` as the operation, which is a different endpoint entirely.
    const { pathname } = api.calls('PATCH')[0];
    expect(pathname).toContain(encodeURIComponent(invoiceId));
    expect(pathname).toMatch(/\/invoices\/matter\/matter-9\/[^/]+\/add-amount$/);
  });

  it('keeps the edited payment index in the body alongside the new amount', async () => {
    api.patch('/invoices/matter/matter-9/inv-1/payment', { invoice: { id: 'inv-1' } });

    await billingService.editInvoicePayment(MATTER_CONTEXT, 'inv-1', {
      paymentIndex: 2, amount: 350, date: '2026-04-02',
    });

    // The index says WHICH receipt is being corrected. Dropping it makes the
    // server apply the new amount to a payment of its own choosing.
    const body = bodyOf(api.calls('PATCH')[0]);
    expect(body.paymentIndex).toBe(2);
    expect(body.amount).toBe(350);
    expect(body.date).toBe('2026-04-02');
  });
});

describe('payment plans and their installments', () => {
  const PLAN = '/invoices/matter/matter-9/inv-1/payment-plan';

  it('creates a plan with POST and removes it with DELETE on one route', async () => {
    api.post(PLAN, { invoice: { id: 'inv-1' } });
    api.delete(PLAN, { invoice: { id: 'inv-1' } });

    await billingService.setPaymentPlan(MATTER_CONTEXT, 'inv-1', {
      installmentAmount: 500, frequencyDays: 30, planStartDate: '2026-04-01',
    });
    await billingService.removePaymentPlan(MATTER_CONTEXT, 'inv-1');

    // The server routes on the verb alone here, so a wrong one tears down the
    // schedule a firm just agreed with a client, or re-creates one it just ended.
    expect(api.calls('POST')[0].pathname).toMatch(/\/inv-1\/payment-plan$/);
    expect(api.calls('DELETE')[0].pathname).toMatch(/\/inv-1\/payment-plan$/);
    expect(bodyOf(api.calls('POST')[0]).installmentAmount).toBe(500);
  });

  it('addresses an installment by index IN THE PATH, not the query', async () => {
    api.patch('/payment-plan/installment/2', { invoice: { id: 'inv-1' } });

    await billingService.updateInstallment(MATTER_CONTEXT, 'inv-1', 2, {
      dueDate: '2026-06-01', amount: 250,
    });

    // The route declares the index as a path parameter. Moving it to the query
    // leaves the server with no index at all, which either 404s or, on a route
    // with a default, rewrites the first installment.
    const call = api.calls('PATCH')[0];
    expect(call.pathname).toMatch(/\/payment-plan\/installment\/2$/);
    expect(paramsOf(call.url).get('installmentIndex')).toBeNull();
    expect(bodyOf(call).amount).toBe(250);
  });

  it('puts installment index ZERO in the path rather than dropping it as falsy', async () => {
    api.patch('/payment-plan/installment/0', { invoice: { id: 'inv-1' } });

    await billingService.updateInstallment(MATTER_CONTEXT, 'inv-1', 0, { dueDate: '2026-05-01' });

    // The first installment is index 0, and it is the one most often corrected
    // right after a plan is set up. A truthiness guard would break exactly it.
    expect(api.calls('PATCH')[0].pathname).toMatch(/\/installment\/0$/);
  });

  it('unpays an installment on the installment sub-route, not the invoice payment route', async () => {
    api.delete('/payment-plan/installment/1/payment', { invoice: { id: 'inv-1' } });

    await billingService.unpayInstallment(MATTER_CONTEXT, 'inv-1', 1);

    // Both routes end in `/payment` and both DELETE. The invoice-level one
    // removes a recorded receipt; this one only marks a scheduled installment
    // unpaid. Confusing them deletes money the firm actually received.
    const call = api.calls('DELETE')[0];
    expect(call.pathname).toMatch(/\/payment-plan\/installment\/1\/payment$/);
    expect(call.pathname).not.toMatch(/\/inv-1\/payment$/);
  });

  it('replaces the whole schedule in one request', async () => {
    api.patch('/payment-plan/schedule', { invoice: { id: 'inv-1' } });

    await billingService.replacePaymentPlanSchedule(MATTER_CONTEXT, 'inv-1', {
      installments: [
        { dueDate: '2026-05-01', amount: 400 },
        { dueDate: '2026-06-01', amount: 400 },
        { dueDate: '2026-07-01', amount: 200 },
      ],
      frequencyDays: 30,
    });

    // Replace-all: the server takes the list as the complete new schedule. A
    // partial send silently shortens the plan and leaves the balance unscheduled.
    const body = bodyOf(api.calls('PATCH')[0]);
    expect(body.installments).toHaveLength(3);
    expect((body.installments as Array<{ amount: number }>)[2].amount).toBe(200);
    expect(body.frequencyDays).toBe(30);
  });
});

describe('replacing an invoice line items', () => {
  const LINE_ITEMS = '/invoices/matter/matter-9/inv-1/line-items';

  it('sends all three kinds, including the sections left empty', async () => {
    api.patch(LINE_ITEMS, { invoice: { id: 'inv-1' } });

    await billingService.updateInvoiceLineItems(MATTER_CONTEXT, 'inv-1', {
      timeEntries: [{ id: 'te-1', hours: 2, rate: 300, amount: 600 }],
      flatFees: [],
      expenses: [],
    });

    // An omitted array clears that section server-side, so the three keys have
    // to travel together. Pruning empty arrays on the way out is the change this
    // catches, and it looks harmless right up until it is the only difference
    // between "no expenses on this invoice" and "expenses left untouched".
    const body = bodyOf(api.calls('PATCH')[0]);
    expect(Object.keys(body).sort()).toEqual(['expenses', 'flatFees', 'timeEntries']);
    expect(body.flatFees).toEqual([]);
  });

  it('surfaces the credit a shrinking total would leave, from a 409', async () => {
    api.patch(LINE_ITEMS, {
      status: 409,
      body: {
        error: 'Invoice total is below what has been settled',
        code: 'INVOICE_TOTAL_BELOW_SETTLED',
        details: { creditAmount: 150.25 },
      },
    });

    let error: ApiError | undefined;
    try {
      await billingService.updateInvoiceLineItems(MATTER_CONTEXT, 'inv-1', {
        timeEntries: [], flatFees: [], expenses: [],
      });
    } catch (caught) {
      error = caught as ApiError;
    }

    // The UI cannot ask "this leaves a 150.25 credit, go ahead?" unless the
    // amount survives the throw. An error path that kept only the message would
    // force the firm to guess, or to abandon the edit.
    expect(error).toBeInstanceOf(ApiError);
    expect(error?.status).toBe(409);
    expect(error?.code).toBe('INVOICE_TOTAL_BELOW_SETTLED');
    expect((error?.details as { creditAmount: number }).creditAmount).toBe(150.25);
  });

  it('carries the acknowledgement flag when the caller confirms the overpayment', async () => {
    api.patch(LINE_ITEMS, { invoice: { id: 'inv-1' } });

    await billingService.updateInvoiceLineItems(MATTER_CONTEXT, 'inv-1', {
      timeEntries: [], flatFees: [], expenses: [], acknowledgeOverpayment: true,
    });

    // Without the flag the retry hits the same 409 and the firm can never
    // complete an edit that legitimately leaves a client in credit.
    expect(bodyOf(api.calls('PATCH')[0]).acknowledgeOverpayment).toBe(true);
  });
});

describe('a late fee', () => {
  it('returns the fee that was charged alongside the updated invoice', async () => {
    api.post('/invoices/matter/matter-9/inv-1/late-fee', {
      invoice: { id: 'inv-1', totalAmount: 1045 },
      lateFeeAmount: 45,
    });

    const result = await billingService.applyLateFee(MATTER_CONTEXT, 'inv-1');

    // The amount is decided server-side from the firm's settings, so this
    // response is the only place the browser learns what was added. Unwrapping
    // to `body.invoice` the way every neighbouring method does would drop it and
    // leave the confirmation unable to say what the client is now being charged.
    expect(result.lateFeeAmount).toBe(45);
    expect(result.invoice.id).toBe('inv-1');
  });
});

describe('building an invoice out of unbilled work', () => {
  const summary: UnbilledSummary = {
    unbilledTimeEntries: [
      {
        id: 'te-1', userId: 'u1', userName: 'Ada', hours: 2.5, date: '2026-03-01',
        name: 'Drafting', description: 'Motion',
      },
      {
        id: 'te-2', userId: 'u1', userName: 'Ada', hours: 4, date: '2026-03-02',
        name: 'Hearing', description: 'Appearance',
      },
      {
        id: 'te-3', userId: 'u2', userName: 'Grace', hours: 1, date: '2026-03-03',
        name: 'Review', description: 'Docs',
      },
    ],
    unbilledFlatFees: [
      { id: 'ff-1', description: 'Filing', amount: 350, date: '2026-03-01' },
      { id: 'ff-2', description: 'Courier', amount: 20, date: '2026-03-02' },
    ],
    totalUnbilledHours: 7.5,
    totalUnbilledFlatFees: 370,
  };

  // Registered as a FUNCTION handler so the typed `UnbilledSummary` const above
  // stays typed: the plain-body arm of the handler type takes an indexable
  // record, which a named interface is not.
  const arrangeSummary = () => {
    api.get('/invoices/matter/matter-9/unbilled-summary', () => summary);
    api.post('/invoices', { invoice: { id: 'inv-new' } });
  };

  it('bills only the lines the caller selected', async () => {
    arrangeSummary();

    await billingService.generateInvoiceFromUnbilled(MATTER_CONTEXT, {
      invoiceName: 'March', invoiceDate: '2026-03-31',
      selectedTimeEntryIds: ['te-2'], selectedFlatFeeIds: ['ff-1'],
      timeEntryRates: { 'te-2': 300 },
    });

    // The summary holds everything unbilled on the matter; the user ticked two
    // lines. Losing the filter invoices the whole backlog, and the invoice is
    // already sent by the time anyone reads the total.
    const body = bodyOf(api.calls('POST')[0]);
    expect((body.timeEntries as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['te-2']);
    expect((body.flatFees as Array<{ id: string }>).map((fee) => fee.id)).toEqual(['ff-1']);
  });

  it('rounds hours x rate to whole cents', async () => {
    arrangeSummary();

    await billingService.generateInvoiceFromUnbilled(MATTER_CONTEXT, {
      invoiceName: 'March', invoiceDate: '2026-03-31',
      selectedTimeEntryIds: ['te-1'], selectedFlatFeeIds: [],
      timeEntryRates: { 'te-1': 199.99 },
    });

    // 2.5 x 199.99 is 499.97500000000002 in binary floating point. Unrounded it
    // reaches the server as a sub-cent amount that cannot be stored, and the
    // invoice total then disagrees with the sum of its own lines by a fraction
    // that grows with every line.
    const line = (bodyOf(api.calls('POST')[0]).timeEntries as Array<{ amount: number }>)[0];
    expect(line.amount).toBe(499.98);
  });

  it('bills an unrated entry at zero rather than NaN', async () => {
    arrangeSummary();

    await billingService.generateInvoiceFromUnbilled(MATTER_CONTEXT, {
      invoiceName: 'March', invoiceDate: '2026-03-31',
      selectedTimeEntryIds: ['te-3'], selectedFlatFeeIds: [],
      timeEntryRates: {},
    });

    // A rate the caller never supplied is `undefined`; multiplied it is NaN, and
    // `JSON.stringify` turns NaN into null. The line then arrives with no amount
    // and the server either rejects the whole invoice or stores nothing for it.
    const body = bodyOf(api.calls('POST')[0]);
    expect((body.timeEntries as Array<{ amount: number }>)[0].amount).toBe(0);
    expect(body.totalAmount).toBe(0);
  });

  it('totals time and flat fees together, to the cent', async () => {
    arrangeSummary();

    await billingService.generateInvoiceFromUnbilled(MATTER_CONTEXT, {
      invoiceName: 'March', invoiceDate: '2026-03-31',
      selectedTimeEntryIds: ['te-1', 'te-2'], selectedFlatFeeIds: ['ff-1', 'ff-2'],
      timeEntryRates: { 'te-1': 199.99, 'te-2': 300 },
    });

    // 499.98 of drafting plus 1200 of hearing plus 370 of fees. The totals are
    // computed here, not by the server, so a total that omitted the flat fees
    // would produce an invoice whose lines add up to more than it asks for.
    const body = bodyOf(api.calls('POST')[0]);
    expect(body.totalHours).toBe(6.5);
    expect(body.flatFeesAmount).toBe(370);
    expect(body.totalAmount).toBe(2069.98);
  });

  it('reads the unbilled summary before it creates anything', async () => {
    arrangeSummary();

    await billingService.generateInvoiceFromUnbilled(MATTER_CONTEXT, {
      invoiceName: 'March', invoiceDate: '2026-03-31',
      selectedTimeEntryIds: ['te-1'], selectedFlatFeeIds: [],
      timeEntryRates: { 'te-1': 200 },
    });

    // The selected ids are ids only; the hours and descriptions behind them come
    // from this read. Creating first, or skipping it, would post an invoice with
    // ids and no work on it.
    expect(api.calls().map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(api.calls('GET')[0].pathname).toMatch(/\/unbilled-summary$/);
  });

  it('falls back to the context clientId when the payload names no client', async () => {
    api.get('/invoices/client/client-7/unbilled-summary', () => summary);
    api.post('/invoices/client/client-7', { invoice: { id: 'inv-new' } });

    await billingService.generateInvoiceFromUnbilled(
      { ...CLIENT_CONTEXT, clientId: 'billed-client-2' },
      {
        invoiceName: 'March', invoiceDate: '2026-03-31',
        selectedTimeEntryIds: [], selectedFlatFeeIds: [], timeEntryRates: {},
      },
    );

    // `clientId` is who the invoice is billed TO, which on a matter can differ
    // from the context. Losing the fallback leaves the invoice unattributed, and
    // an unattributed invoice never appears on the client's portal.
    expect(bodyOf(api.calls('POST')[0]).clientId).toBe('billed-client-2');
  });
});

describe('the firm-wide time entry reads', () => {
  const FIRM_TIME = '/billing/time-entries/firm';
  const emptyPage = { timeEntries: [], totalItems: 0, summary: { totalHours: 0, totalAmount: 0 } };

  it('sends a multi-word search the server can read back whole', async () => {
    api.get(FIRM_TIME, emptyPage);

    await billingService.listFirmTimeEntriesPage(LAW_FIRM_ID, { search: 'Ada Lovelace estate' });

    // Read through URLSearchParams, because a query string encodes each space as
    // `+`. A hand-rolled query string, or a `decodeURIComponent` on the way in,
    // hands the backend "Ada+Lovelace+estate" and it matches nothing.
    expect(paramsOf(api.calls('GET')[0].url).get('search')).toBe('Ada Lovelace estate');
  });

  it('trims a padded search and omits a blank one', async () => {
    api.get(FIRM_TIME, emptyPage);

    await billingService.listFirmTimeEntriesPage(LAW_FIRM_ID, { search: '   ' });
    await billingService.listFirmTimeEntriesPage(LAW_FIRM_ID, { search: '  ada  ' });

    // A blank search sent as an empty parameter is a filter the backend applies,
    // and it is not the same query as no filter at all, so the cleared search box
    // would return a different page than the one the user started from.
    const [blank, padded] = api.calls('GET');
    expect(paramsOf(blank.url).get('search')).toBeNull();
    expect(paramsOf(padded.url).get('search')).toBe('ada');
  });

  it('clamps a limit above the firm maximum', async () => {
    api.get(FIRM_TIME, emptyPage);

    await billingService.listFirmTimeEntriesPage(LAW_FIRM_ID, { limit: 5000 });

    // The endpoint's schema rejects anything over the ceiling with a 400, so an
    // unclamped request from a "show all" control fails the whole screen rather
    // than returning the largest page it can.
    expect(paramsOf(api.calls('GET')[0].url).get('limit')).toBe(String(FIRM_BILLING_MAX_LIMIT));
  });

  it('windows the select-all read at the server ceiling, and the paged read at its page size', async () => {
    api.get(FIRM_TIME, emptyPage);

    await billingService.listFirmTimeEntriesAll(LAW_FIRM_ID, { billingStatus: 'unbilled' });
    await billingService.listFirmTimeEntriesPage(LAW_FIRM_ID, { billingStatus: 'unbilled', page: 3 });

    // Both hit the same url, carrying the same filters; only the window differs.
    // The select-all read asks for the largest page the endpoint serves and walks
    // on from there. Sending NO limit is not the way to ask for everything: the
    // endpoint answers that with a silent clamp to the same ceiling, so the read
    // would select the first 200 of a 5,000-entry match set and report nothing.
    const [all, paged] = api.calls('GET').map((call) => paramsOf(call.url));
    expect(all.get('limit')).toBe(String(FIRM_BILLING_MAX_LIMIT));
    expect(all.get('page')).toBe('1');
    expect(all.get('billingStatus')).toBe('unbilled');
    expect(paged.get('limit')).toBe('10');
    expect(paged.get('page')).toBe('3');
  });

  it('walks the select-all read one page at a time and stops on the first short page', async () => {
    // 201 matches: a full page, then a page of one. Both are the same filtered
    // query, so the walk must carry the filter forward rather than re-deriving it.
    const entries = Array.from({ length: 201 }, (_, i) => ({ id: `entry-${i}` }));
    api.get(FIRM_TIME, (call) => {
      const page = Number(paramsOf(call.url).get('page'));
      return {
        timeEntries: entries.slice((page - 1) * 200, page * 200),
        totalItems: entries.length,
        summary: { totalHours: 201, totalAmount: 40200 },
      };
    });

    const result = await billingService.listFirmTimeEntriesAll(LAW_FIRM_ID, { billingStatus: 'unbilled' });

    expect(result.timeEntries).toHaveLength(201);
    // Not truncated: the walk reached every matching entry, so a bulk action on
    // these ids really does cover the whole match set.
    expect(result.truncated).toBe(false);
    expect(api.calls('GET')).toHaveLength(2);
    expect(api.calls('GET').map((call) => paramsOf(call.url).get('page'))).toEqual(['1', '2']);
    for (const call of api.calls('GET')) {
      expect(paramsOf(call.url).get('billingStatus')).toBe('unbilled');
    }
  });

  it('stops the select-all walk at the cap and reports the shortfall', async () => {
    // More matches than the walk can reach. The endpoint keeps reporting the true
    // total, which is exactly what a caller must not mistake for what it holds.
    const total = FIRM_TIME_ENTRY_SELECT_ALL_CEILING + 1;
    api.get(FIRM_TIME, (call) => {
      const page = Number(paramsOf(call.url).get('page'));
      return {
        timeEntries: Array.from({ length: 200 }, (_, i) => ({ id: `entry-${(page - 1) * 200 + i}` })),
        totalItems: total,
        summary: { totalHours: total, totalAmount: total * 200 },
      };
    });

    const result = await billingService.listFirmTimeEntriesAll(LAW_FIRM_ID, {});

    expect(result.timeEntries).toHaveLength(FIRM_TIME_ENTRY_SELECT_ALL_CEILING);
    expect(result.truncated).toBe(true);
    // The whole match set is still reported, so a caller can say "N of M".
    expect(result.totalItems).toBe(total);
    // Bounded. Without the cap this walks the firm's entire time log one request
    // at a time, holding a pool connection per round trip.
    expect(api.calls('GET')).toHaveLength(FIRM_TIME_ENTRY_SELECT_ALL_MAX_PAGES);
  });

  it('keeps clientId and clientScope as separate filters', async () => {
    api.get(FIRM_TIME, emptyPage);

    await billingService.listFirmTimeEntriesPage(LAW_FIRM_ID, {
      clientId: 'client-7', clientScope: 'client-8', userId: 'user-3',
      dateFrom: '2026-01-01', dateTo: '2026-03-31',
    });

    // They ask different questions: `clientId` is who the work is billed to,
    // `clientScope` is everything under a client relationship including matter
    // work nobody has been charged for. Folding them together widens a billed-to
    // filter into unbilled work, or narrows a relationship view out of existence.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('clientId')).toBe('client-7');
    expect(query.get('clientScope')).toBe('client-8');
    expect(query.get('userId')).toBe('user-3');
    expect(query.get('dateFrom')).toBe('2026-01-01');
    expect(query.get('dateTo')).toBe('2026-03-31');
  });

  it('serializes a multi-column sort as field:dir pairs', async () => {
    api.get(FIRM_TIME, emptyPage);

    await billingService.listFirmTimeEntriesPage(LAW_FIRM_ID, {
      sort: [{ field: 'date', sort: 'desc' }, { field: 'hours', sort: 'asc' }],
    });

    // The backend validates this string with a regex. Any other separator is a
    // 400, and the grid's ordering silently reverts to the server default.
    expect(paramsOf(api.calls('GET')[0].url).get('sort')).toBe('date:desc,hours:asc');
  });

  it('fills in a summary the server omitted, and keeps one it sent', async () => {
    api.get(FIRM_TIME, { timeEntries: [] });

    const empty = await billingService.listFirmTimeEntriesPage(LAW_FIRM_ID);

    api.get(FIRM_TIME, {
      timeEntries: [], totalItems: 12, summary: { totalHours: 7.5, totalAmount: 2069.98 },
    });
    const filled = await billingService.listFirmTimeEntriesPage(LAW_FIRM_ID);

    // The tiles above the grid read these directly. Undefined renders as NaN
    // once it is formatted as currency, and a defaulted zero must not overwrite
    // a real total the server did send.
    expect(empty.summary).toEqual({ totalHours: 0, totalAmount: 0 });
    expect(empty.totalItems).toBe(0);
    expect(filled.summary.totalAmount).toBe(2069.98);
    expect(filled.totalItems).toBe(12);
  });

  it('throws rather than returning an empty page when the read is refused', async () => {
    api.get(FIRM_TIME, { status: 403, body: { error: 'Forbidden' } });

    // An empty page and a forbidden page look identical on screen: both say the
    // firm has logged no time.
    await expect(billingService.listFirmTimeEntriesPage(LAW_FIRM_ID)).rejects.toBeInstanceOf(ApiError);
  });
});

/**
 * Exact-path cases for the remaining money routes. `postExact`/`getExact`
 * match the whole pathname and every query parameter, so a request that drifts
 * to another firm, another invoice, or grows a stray filter matches nothing and
 * the transport throws.
 */
const BILLING = `/api/lawfirms/${LAW_FIRM_ID}/billing`;
const STRIPE = '/api/stripe';

function onlyCall(method: string) {
  const calls = api.calls(method);
  expect(calls).toHaveLength(1);
  return calls[0];
}

/** Reject-or-fail, returning the error so its fields can be asserted. */
async function rejectionOf(promise: Promise<unknown>): Promise<ApiError> {
  return promise.then(
    () => { throw new Error('expected the call to reject'); },
    (error: unknown) => error as ApiError,
  );
}

describe('bulk-deleting time entries reports both halves', () => {
  it('POSTs exactly the selected ids and returns the partial result unchanged', async () => {
    const result = {
      requested: 3,
      deleted: 2,
      failed: ['te-3'],
      errors: { 'te-3': 'Time entry is on a sent invoice' },
    };
    api.postExact(`${BILLING}/time-entries/bulk-delete`, result);

    const outcome = await billingService.bulkDeleteTimeEntries(LAW_FIRM_ID, ['te-1', 'te-2', 'te-3']);

    // The id list is the whole of what gets destroyed. The firm id stays in the
    // path; a body that also carried it could disagree with the route.
    expect(onlyCall('POST').body).toEqual({ timeEntryIds: ['te-1', 'te-2', 'te-3'] });
    expect(outcome).toEqual(result);
  });

  it('throws the server reason when the whole request is refused', async () => {
    api.postExact(`${BILLING}/time-entries/bulk-delete`, {
      status: 400, body: { error: 'At most 1000 time entries per request' },
    });

    const error = await rejectionOf(billingService.bulkDeleteTimeEntries(LAW_FIRM_ID, ['te-1']));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('At most 1000 time entries per request');
    expect(error.status).toBe(400);
  });
});

describe('the firm flat fee page', () => {
  it('sends every filter under its own key, matter ids comma-joined', async () => {
    api.getExact(
      `${BILLING}/flat-fees/firm?limit=50&offset=100&clientId=client-7&context=matter&billingStatus=unbilled`
        + '&dateFrom=2026-01-01&dateTo=2026-03-31&matterIds=m-1,m-2&countOnly=true',
      { flatFees: [], totalItems: 12, truncated: false, summary: { totalAmount: 4500.5 } },
    );

    const page = await billingService.listFirmFlatFeesPage(LAW_FIRM_ID, {
      limit: 50,
      offset: 100,
      clientId: 'client-7',
      context: 'matter',
      billingStatus: 'unbilled',
      dateFrom: '2026-01-01',
      dateTo: '2026-03-31',
      matterIds: ['m-1', 'm-2'],
      countOnly: true,
    });

    expect(page).toEqual({ flatFees: [], totalItems: 12, truncated: false, summary: { totalAmount: 4500.5 } });
  });

  it('omits an EMPTY matter list instead of sending matterIds=', async () => {
    api.getExact(`${BILLING}/flat-fees/firm?limit=${FIRM_BILLING_MAX_LIMIT}&page=1`, { flatFees: [] });

    await billingService.listFirmFlatFeesPage(LAW_FIRM_ID, { matterIds: [] });

    // The server reads a named-but-empty set as "these zero matters" and
    // answers with nothing at all.
    expect(paramsOf(onlyCall('GET').url).has('matterIds')).toBe(false);
  });

  it('fills a bare envelope with zeros rather than undefined', async () => {
    api.getExact(`${BILLING}/flat-fees/firm?limit=${FIRM_BILLING_MAX_LIMIT}&page=1`, {});

    await expect(billingService.listFirmFlatFeesPage(LAW_FIRM_ID)).resolves.toEqual({
      flatFees: [], totalItems: 0, truncated: false, summary: { totalAmount: 0 },
    });
  });

  it('reads truncated only from a literal true', async () => {
    api.getExact(`${BILLING}/flat-fees/firm?limit=${FIRM_BILLING_MAX_LIMIT}&page=1`, { flatFees: [], truncated: 'yes' });

    const page = await billingService.listFirmFlatFeesPage(LAW_FIRM_ID);

    expect(page.truncated).toBe(false);
  });

  it('throws its own message when the read fails with no reason', async () => {
    api.getExact(`${BILLING}/flat-fees/firm?limit=${FIRM_BILLING_MAX_LIMIT}&page=1`, { status: 422, body: {} });

    const error = await rejectionOf(billingService.listFirmFlatFeesPage(LAW_FIRM_ID));
    expect(error.message).toBe('Failed to fetch flat fees');
  });
});

describe('every flat fee under one client relationship', () => {
  const page = (ids: string[], totalAmount: number, truncated = false) => ({
    flatFees: ids.map((id) => ({ id })),
    totalItems: ids.length,
    truncated,
    summary: { totalAmount },
  });

  it('sends NO request when there is neither a client nor a matter', async () => {
    const result = await billingService.listClientScopeFlatFees(LAW_FIRM_ID, {});

    // The unfiltered route answers for the whole firm. A client screen asking
    // that question would show every other client's fees.
    expect(result).toEqual({ flatFees: [], totalItems: 0, truncated: false, summary: { totalAmount: 0 } });
    expect(api.calls()).toHaveLength(0);
  });

  it('reads a client with no matters in one request carrying only the client', async () => {
    api.getExact(
      `${BILLING}/flat-fees/firm?limit=${FIRM_BILLING_MAX_LIMIT}&page=1&clientId=client-7&billingStatus=unbilled`,
      page(['ff-1'], 750),
    );

    const result = await billingService.listClientScopeFlatFees(LAW_FIRM_ID, {
      clientId: 'client-7',
      billingStatus: 'unbilled',
    });

    expect(result).toEqual(page(['ff-1'], 750));
  });

  it('splits matter ids at the route ceiling, sends clientId on the first read only, and sums the pages', async () => {
    const matterIds = Array.from({ length: FIRM_BILLING_MAX_LIMIT + 1 }, (_, i) => `m-${i}`);
    api.get('/flat-fees/firm', (call) => (paramsOf(call.url).has('clientId')
      ? page(['ff-1', 'ff-2'], 1500)
      : page(['ff-3'], 250.25, true)));

    const result = await billingService.listClientScopeFlatFees(LAW_FIRM_ID, {
      clientId: 'client-7',
      matterIds,
    });

    const [first, second] = api.calls('GET').map((c) => paramsOf(c.url));
    expect(api.calls('GET')).toHaveLength(2);
    expect(first.get('clientId')).toBe('client-7');
    expect(first.get('matterIds')!.split(',')).toEqual(matterIds.slice(0, FIRM_BILLING_MAX_LIMIT));
    // Counted once: repeating clientId on every chunk would return the client's
    // own fees once per chunk and double their total.
    expect(second.has('clientId')).toBe(false);
    expect(second.get('matterIds')).toBe(`m-${FIRM_BILLING_MAX_LIMIT}`);

    expect(result.flatFees.map((f) => f.id)).toEqual(['ff-1', 'ff-2', 'ff-3']);
    expect(result.totalItems).toBe(3);
    expect(result.summary.totalAmount).toBe(1750.25);
    // One truncated chunk makes the whole answer incomplete.
    expect(result.truncated).toBe(true);
  });
});

describe('the billing reports carry money defaults rather than undefined', () => {
  it('sends the by-matter filters and returns the rows as sent', async () => {
    const body = {
      rows: [{ matterId: 'm-1', totalBilled: 1200.5 }],
      totalItems: 41,
      unlinkedInvoices: { count: 2, totalAmount: 300.25 },
      practiceAreas: ['Family'],
    };
    api.getExact(`${BILLING}/reports/by-matter?page=2&limit=20&search=acme+holdings&status=open&practiceArea=Family`, body);

    const report = await billingService.getByMatterReport(LAW_FIRM_ID, {
      page: 2, limit: 20, search: 'acme holdings', status: 'open', practiceArea: 'Family',
    });

    expect(report).toEqual(body);
    // Which payments read as overdue depends on the viewer's day.
    expect(onlyCall('GET').headers['x-timezone']).toBeTruthy();
  });

  it('fills an empty by-matter report with a zero unlinked total', async () => {
    api.getExact(`${BILLING}/reports/by-matter`, {});

    await expect(billingService.getByMatterReport(LAW_FIRM_ID)).resolves.toEqual({
      rows: [], totalItems: 0, unlinkedInvoices: { count: 0, totalAmount: 0 }, practiceAreas: [],
    });
  });

  it('sends the by-client window and search', async () => {
    const body = { rows: [{ clientId: 'c-1' }], totalItems: 1, unattributedInvoices: { count: 1, totalAmount: 99.99 } };
    api.getExact(`${BILLING}/reports/by-client?page=3&limit=10&search=smith`, body);

    await expect(billingService.getByClientReport(LAW_FIRM_ID, { page: 3, limit: 10, search: 'smith' }))
      .resolves.toEqual(body);
  });

  it('fills an empty by-client report with a zero unattributed total', async () => {
    api.getExact(`${BILLING}/reports/by-client`, {});

    await expect(billingService.getByClientReport(LAW_FIRM_ID)).resolves.toEqual({
      rows: [], totalItems: 0, unattributedInvoices: { count: 0, totalAmount: 0 },
    });
  });

  it('reads one client breakdown from its own route', async () => {
    api.getExact(`${BILLING}/reports/by-client/client-7/matters`, { matters: [{ matterId: 'm-1', totalBilled: 10 }] });

    await expect(billingService.getClientMatterBreakdown(LAW_FIRM_ID, 'client-7'))
      .resolves.toEqual([{ matterId: 'm-1', totalBilled: 10 }]);
  });

  it('returns an empty breakdown for an envelope with no matters key', async () => {
    api.getExact(`${BILLING}/reports/by-client/client-7/matters`, {});

    await expect(billingService.getClientMatterBreakdown(LAW_FIRM_ID, 'client-7')).resolves.toEqual([]);
  });

  it.each([
    ['getByMatterReport', '/reports/by-matter', () => billingService.getByMatterReport(LAW_FIRM_ID), 'Failed to load the billing report'],
    ['getByClientReport', '/reports/by-client', () => billingService.getByClientReport(LAW_FIRM_ID), 'Failed to load the billing report'],
    ['getClientMatterBreakdown', '/reports/by-client/client-7/matters', () => billingService.getClientMatterBreakdown(LAW_FIRM_ID, 'client-7'), 'Failed to load the client breakdown'],
  ] as const)('%s throws its own message on a bare refusal', async (_name, path, run, message) => {
    api.getExact(`${BILLING}${path}`, { status: 422, body: {} });

    const error = await rejectionOf(run());
    expect(error.message).toBe(message);
  });
});

describe('deleting an invoice and editing its details', () => {
  it('DELETEs the invoice on its context-segmented route', async () => {
    api.deleteExact(`${BILLING}/invoices/matter/matter-9/inv-1`, { status: 204 });

    await expect(billingService.deleteInvoice(MATTER_CONTEXT, 'inv-1')).resolves.toBeUndefined();
    expect(onlyCall('DELETE').pathname).toBe(`${BILLING}/invoices/matter/matter-9/inv-1`);
  });

  it('throws when the delete is refused', async () => {
    api.deleteExact(`${BILLING}/invoices/client/client-7/inv-1`, {
      status: 409, body: { error: 'Invoice has payments recorded' },
    });

    const error = await rejectionOf(billingService.deleteInvoice(CLIENT_CONTEXT, 'inv-1'));
    expect(error.message).toBe('Invoice has payments recorded');
    expect(error.status).toBe(409);
  });

  it('PATCHes only the detail fields and returns the invoice from its envelope', async () => {
    api.patchExact(`${BILLING}/invoices/matter/matter-9/inv-1/details`, {
      invoice: { id: 'inv-1', invoiceNumber: 'INV-0042', dueDate: '2026-04-30' },
    });

    const invoice = await billingService.updateInvoiceDetails(MATTER_CONTEXT, 'inv-1', {
      invoiceNumber: 'INV-0042',
      dueDate: '2026-04-30',
      remitTo: null,
    });

    expect(onlyCall('PATCH').body).toEqual({ invoiceNumber: 'INV-0042', dueDate: '2026-04-30', remitTo: null });
    expect(invoice).toEqual({ id: 'inv-1', invoiceNumber: 'INV-0042', dueDate: '2026-04-30' });
  });

  it('throws its own message when a details edit is refused with no reason', async () => {
    api.patchExact(`${BILLING}/invoices/matter/matter-9/inv-1/details`, { status: 422, body: {} });

    const error = await rejectionOf(billingService.updateInvoiceDetails(MATTER_CONTEXT, 'inv-1', {}));
    expect(error.message).toBe('Failed to update invoice');
  });

  it('POSTs a billing-recipient refresh with no body and returns the resolved recipients', async () => {
    const resolved = {
      message: 'Billing recipients refreshed',
      billingRecipients: { primaryEmail: 'ap@acme.test', emails: ['ap@acme.test'], source: 'current' },
    };
    api.postExact(`${BILLING}/invoices/client/client-7/inv-1/billing-recipients/refresh`, resolved);

    const result = await billingService.refreshBillingRecipients(CLIENT_CONTEXT, 'inv-1');

    expect(onlyCall('POST').body).toBeNull();
    expect(result).toEqual(resolved);
  });

  it('throws its own message when a refresh is refused with no reason', async () => {
    api.postExact(`${BILLING}/invoices/client/client-7/inv-1/billing-recipients/refresh`, { status: 422, body: {} });

    const error = await rejectionOf(billingService.refreshBillingRecipients(CLIENT_CONTEXT, 'inv-1'));
    expect(error.message).toBe('Failed to refresh billing recipients');
  });
});

describe('Stripe payment requests address the invoice by firm, context and id', () => {
  it('requests a whole-invoice payment on the context route and returns the payment link', async () => {
    api.postExact(`${STRIPE}/payment/${LAW_FIRM_ID}/matter/matter-9/inv-1/request`, {
      message: 'Payment link emailed', paymentUrl: 'https://app.test/pay/tok_1',
    });

    const result = await billingService.requestStripePayment(MATTER_CONTEXT, 'inv-1');

    // Emailing is the default; no fee choice means the firm setting decides.
    expect(onlyCall('POST').body).toEqual({ sendEmail: true });
    expect(result).toEqual({ message: 'Payment link emailed', paymentUrl: 'https://app.test/pay/tok_1' });
  });

  it('asks for no email when the firm copies the link instead', async () => {
    api.postExact(`${STRIPE}/payment/${LAW_FIRM_ID}/matter/matter-9/inv-1/request`, {
      message: 'Payment link created', paymentUrl: 'https://app.test/pay/tok_2',
    });

    await billingService.requestStripePayment(MATTER_CONTEXT, 'inv-1', { card: true, bank: false }, { sendEmail: false });

    expect(onlyCall('POST').body).toEqual({ isCardFeePassedOn: true, isBankFeePassedOn: false, sendEmail: false });
  });

  it('asks for a link that charges one payment-plan row, named by its id', async () => {
    api.postExact(`${STRIPE}/payment/${LAW_FIRM_ID}/client/client-7/inv-1/request`, {
      message: 'Payment link emailed', paymentUrl: 'https://app.test/pay/tok_3',
    });

    await billingService.requestStripePayment(CLIENT_CONTEXT, 'inv-1', undefined, { installmentId: 'ep-2' });

    expect(onlyCall('POST').body).toEqual({ sendEmail: true, installmentId: 'ep-2' });
  });

  it('prices the fee quote for one payment-plan row alongside the fee choice', async () => {
    api.getExact(`${STRIPE}/payment/${LAW_FIRM_ID}/client/client-7/inv-1/fee-quote?card=true&bank=false&installmentId=ep-2`, {
      invoiceCents: 15_000, firmDefault: { card: false, bank: false }, emailTo: [], methods: [],
    });

    await expect(billingService.getPaymentFeeQuote(CLIENT_CONTEXT, 'inv-1', { card: true, bank: false }, 'ep-2'))
      .resolves.toMatchObject({ invoiceCents: 15_000 });
  });

  it('voids a whole-invoice request on its own void route', async () => {
    api.postExact(`${STRIPE}/payment/${LAW_FIRM_ID}/matter/matter-9/inv-1/void`, { message: 'Voided' });

    await expect(billingService.voidStripePaymentRequest(MATTER_CONTEXT, 'inv-1')).resolves.toEqual({ message: 'Voided' });
  });

  it('requests a trust deposit on the firm route and returns the checkout session', async () => {
    api.postExact(`${STRIPE}/trust/${LAW_FIRM_ID}/request-deposit`, {
      checkoutUrl: 'https://checkout.stripe.test/c/1', sessionId: 'cs_1',
    });

    const result = await billingService.requestTrustDeposit(LAW_FIRM_ID, {
      trustAccountId: 'acct-1', clientId: 'client-7', amountCents: 250001, matterId: 'matter-9',
    });

    expect(onlyCall('POST').body).toEqual({
      trustAccountId: 'acct-1', clientId: 'client-7', amountCents: 250001, matterId: 'matter-9',
    });
    expect(result).toEqual({ checkoutUrl: 'https://checkout.stripe.test/c/1', sessionId: 'cs_1' });
  });

  it.each([
    ['requestStripePayment', `/payment/${LAW_FIRM_ID}/matter/matter-9/inv-1/request`, () => billingService.requestStripePayment(MATTER_CONTEXT, 'inv-1'), 'Failed to request payment'],
    ['voidStripePaymentRequest', `/payment/${LAW_FIRM_ID}/matter/matter-9/inv-1/void`, () => billingService.voidStripePaymentRequest(MATTER_CONTEXT, 'inv-1'), 'Failed to void payment request'],
    ['requestTrustDeposit', `/trust/${LAW_FIRM_ID}/request-deposit`, () => billingService.requestTrustDeposit(LAW_FIRM_ID, { trustAccountId: 'a', clientId: 'c', amountCents: 1 }), 'Failed to request trust deposit'],
  ] as const)('%s throws its own message on a bare refusal', async (_name, path, run, message) => {
    api.postExact(`${STRIPE}${path}`, { status: 422, body: {} });

    const error = await rejectionOf(run());
    expect(error.message).toBe(message);
    expect(error.status).toBe(422);
  });
});

describe('bulk invoice creation', () => {
  it('POSTs the contexts and the selected lines unchanged, and returns every outcome list', async () => {
    const outcome = {
      message: 'Created 1 of 2 invoices',
      requested: 2,
      created: [{ id: 'inv-1' }],
      skipped: [],
      failed: ['client-7'],
      errors: { 'client-7': 'No unbilled work' },
    };
    api.postExact(`${BILLING}/invoices/bulk`, outcome);

    const payload = {
      contexts: [
        { type: 'matter' as const, entityId: 'matter-9', timeEntryIds: ['te-1'], flatFeeIds: [] },
        { type: 'client' as const, entityId: 'client-7' },
      ],
      invoiceDate: '2026-03-31',
      dueDate: null,
      invoiceNamePrefix: 'March',
    };
    const result = await billingService.bulkCreateInvoices(LAW_FIRM_ID, payload);

    expect(onlyCall('POST').body).toEqual(payload);
    expect(result).toEqual(outcome);
  });

  it('throws its own message when the batch is refused with no reason', async () => {
    api.postExact(`${BILLING}/invoices/bulk`, { status: 422, body: {} });

    const error = await rejectionOf(billingService.bulkCreateInvoices(LAW_FIRM_ID, { contexts: [], invoiceDate: '2026-03-31' }));
    expect(error.message).toBe('Failed to bulk create invoices');
  });
});

describe('retainer billing plans', () => {
  const PLAN = { id: 'plan-1', name: 'Monthly retainer', amount: 2500.5, intervalUnit: 'month' };

  it('POSTs a new plan with the amount exactly as given and unwraps it', async () => {
    api.postExact(`${BILLING}/plans`, { plan: PLAN });

    const payload = {
      contextType: 'matter' as const,
      entityId: 'matter-9',
      name: 'Monthly retainer',
      intervalUnit: 'month' as const,
      startDate: '2026-04-01',
      amount: 2500.5,
    };
    const created = await billingService.createPlan(LAW_FIRM_ID, payload);

    expect(onlyCall('POST').body).toEqual(payload);
    expect(created).toEqual(PLAN);
  });

  it('PUTs an edit to the plan by id', async () => {
    api.putExact(`${BILLING}/plans/plan-1`, { plan: { ...PLAN, amount: 3000 } });

    const updated = await billingService.updatePlan(LAW_FIRM_ID, 'plan-1', { amount: 3000 });

    expect(onlyCall('PUT').body).toEqual({ amount: 3000 });
    expect(updated.amount).toBe(3000);
  });

  it('lists plans, scoped to a related client when given', async () => {
    api.getExact(`${BILLING}/plans?relatedClientId=client-7`, { plans: [PLAN] });

    await expect(billingService.listPlans(LAW_FIRM_ID, { relatedClientId: 'client-7' })).resolves.toEqual([PLAN]);
  });

  it('returns an empty list for an envelope with no plans key', async () => {
    api.getExact(`${BILLING}/plans`, {});

    await expect(billingService.listPlans(LAW_FIRM_ID)).resolves.toEqual([]);
  });

  it('CHARACTERISATION: getPlan reads the whole list and picks one in the browser', async () => {
    api.getExact(`${BILLING}/plans`, { plans: [{ ...PLAN, id: 'plan-0' }, PLAN] });

    await expect(billingService.getPlan(LAW_FIRM_ID, 'plan-1')).resolves.toEqual(PLAN);
  });

  it('getPlan throws a plain not-found error when the id is not in the list', async () => {
    api.getExact(`${BILLING}/plans`, { plans: [PLAN] });

    await expect(billingService.getPlan(LAW_FIRM_ID, 'plan-404')).rejects.toThrow('Billing plan not found');
  });

  it('creates a draft from one plan period with an empty JSON body', async () => {
    const result = { invoice: { id: 'inv-9' }, period: { id: 'per-3' } };
    api.postExact(`${BILLING}/plans/plan-1/periods/per-3/create-draft`, result);

    await expect(billingService.createDraftFromPlanPeriod(LAW_FIRM_ID, 'plan-1', 'per-3')).resolves.toEqual(result);
    expect(onlyCall('POST').body).toEqual({});
  });

  it.each([
    ['listPlans', 'get', '/plans', () => billingService.listPlans(LAW_FIRM_ID), 'Failed to fetch billing plans'],
    ['createPlan', 'post', '/plans', () => billingService.createPlan(LAW_FIRM_ID, { contextType: 'matter', entityId: 'm', name: 'n', intervalUnit: 'month', startDate: '2026-04-01', amount: 1 }), 'Failed to create billing plan'],
    ['updatePlan', 'put', '/plans/plan-1', () => billingService.updatePlan(LAW_FIRM_ID, 'plan-1', {}), 'Failed to update billing plan'],
    ['createDraftFromPlanPeriod', 'post', '/plans/plan-1/periods/per-3/create-draft', () => billingService.createDraftFromPlanPeriod(LAW_FIRM_ID, 'plan-1', 'per-3'), 'Failed to create draft from billing plan period'],
  ] as const)('%s throws its own message on a bare refusal', async (_name, method, path, run, message) => {
    const register = { get: api.getExact, post: api.postExact, put: api.putExact }[method];
    register(`${BILLING}${path}`, { status: 422, body: {} });

    const error = await rejectionOf(run());
    expect(error.message).toBe(message);
  });
});

describe('charge code rates', () => {
  it('POSTs a charge code with its default and per-member rates exactly as given', async () => {
    api.postExact(`${BILLING}/charge-codes`, { message: 'Created', chargeCodeId: 'cc-1' });

    const result = await billingService.createChargeCode(LAW_FIRM_ID, {
      code: 'LIT',
      name: 'Litigation',
      defaultRate: 325.5,
      memberRates: { 'user-1': 450, 'user-2': 199.99 },
    });

    expect(onlyCall('POST').body).toEqual({
      code: 'LIT',
      name: 'Litigation',
      defaultRate: 325.5,
      memberRates: { 'user-1': 450, 'user-2': 199.99 },
    });
    expect(result).toEqual({ message: 'Created', chargeCodeId: 'cc-1' });
  });

  it('clears a default rate by sending an explicit null', async () => {
    api.putExact(`${BILLING}/charge-codes/cc-1`, { message: 'Updated' });

    await billingService.updateChargeCode(LAW_FIRM_ID, 'cc-1', { defaultRate: null });

    // Omitting the key would leave the old rate in place.
    expect(onlyCall('PUT').body).toEqual({ defaultRate: null });
  });
});

describe('firm unbilled work', () => {
  it('lists every context with unbilled work from one firm route', async () => {
    const summaries = [{ type: 'matter', entityId: 'matter-9', unbilledAmount: 1234.56 }];
    api.getExact(`${BILLING}/invoices/firm/unbilled-summaries`, { summaries });

    await expect(billingService.listFirmUnbilledSummaries(LAW_FIRM_ID)).resolves.toEqual(summaries);
  });

  it('returns an empty list for an envelope with no summaries key', async () => {
    api.getExact(`${BILLING}/invoices/firm/unbilled-summaries`, {});

    await expect(billingService.listFirmUnbilledSummaries(LAW_FIRM_ID)).resolves.toEqual([]);
  });

  it('reads one context summary from its context-segmented route', async () => {
    const summary = { timeEntries: [], flatFees: [], totalAmount: 0 };
    api.getExact(`${BILLING}/invoices/client/client-7/unbilled-summary`, summary);

    await expect(billingService.getUnbilledSummary(CLIENT_CONTEXT)).resolves.toEqual(summary);
  });

  it('sends the unbilled-work window only when given', async () => {
    api.getExact(`${BILLING}/unbilled-work?limit=25&page=0`, { rows: [], totalItems: 0 });

    await billingService.getUnbilledWork(LAW_FIRM_ID, { limit: 25, page: 0 });

    // `!= null`, not truthiness: page 0 still goes out.
    expect(paramsOf(onlyCall('GET').url).get('page')).toBe('0');
  });

  it('sends no query when no window is given', async () => {
    api.getExact(`${BILLING}/unbilled-work`, { rows: [] });

    await billingService.getUnbilledWork(LAW_FIRM_ID);

    expect(onlyCall('GET').search).toBe('');
  });

  it.each([
    ['listFirmUnbilledSummaries', '/invoices/firm/unbilled-summaries', () => billingService.listFirmUnbilledSummaries(LAW_FIRM_ID), 'Failed to fetch unbilled work'],
    ['getUnbilledSummary', '/invoices/matter/matter-9/unbilled-summary', () => billingService.getUnbilledSummary(MATTER_CONTEXT), 'Failed to fetch unbilled summary'],
    ['getUnbilledWork', '/unbilled-work', () => billingService.getUnbilledWork(LAW_FIRM_ID), 'Failed to fetch unbilled work'],
  ] as const)('%s throws its own message on a bare refusal', async (_name, path, run, message) => {
    api.getExact(`${BILLING}${path}`, { status: 422, body: {} });

    const error = await rejectionOf(run());
    expect(error.message).toBe(message);
  });
});

describe('remaining money writes refuse loudly', () => {
  it.each([
    ['addFlatFee', 'post', '/flat-fees', () => billingService.addFlatFee(MATTER_CONTEXT, { description: 'd', amount: 1 } as never), 'Failed to add flat fee'],
    ['updateFlatFee', 'put', '/flat-fees/matter/matter-9/ff-1', () => billingService.updateFlatFee(MATTER_CONTEXT, 'ff-1', {} as never), 'Failed to update flat fee'],
    ['addExpense', 'post', '/expenses', () => billingService.addExpense(MATTER_CONTEXT, { description: 'd', amount: 1 } as never), 'Failed to add expense'],
    ['updateExpense', 'put', '/expenses/matter/matter-9/ex-1', () => billingService.updateExpense(MATTER_CONTEXT, 'ex-1', {} as never), 'Failed to update expense'],
    ['removeExpense', 'delete', '/expenses/matter/matter-9/ex-1', () => billingService.removeExpense(MATTER_CONTEXT, 'ex-1'), 'Failed to remove expense'],
    ['addCreditNote', 'post', '/invoices/matter/matter-9/inv-1/credit-note', () => billingService.addCreditNote(MATTER_CONTEXT, 'inv-1', { amount: 1 } as never), 'Failed to add credit note'],
    ['applyLateFee', 'post', '/invoices/matter/matter-9/inv-1/late-fee', () => billingService.applyLateFee(MATTER_CONTEXT, 'inv-1'), 'Failed to apply late fee'],
  ] as const)('%s throws its own message on a bare refusal', async (_name, method, path, run, message) => {
    const register = { post: api.post, put: api.put, delete: api.delete }[method];
    register(`${BILLING}${path}`, { status: 422, body: {} });

    const error = await rejectionOf(run());
    expect(error.message).toBe(message);
    expect(error.status).toBe(422);
  });
});
