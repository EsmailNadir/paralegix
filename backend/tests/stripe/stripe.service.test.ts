// Unit tests for the Stripe webhook handlers against the Postgres invoices repo.
//
// The service no longer touches Firestore. Payment mutations run through
// invoicesRepo.runInvoiceTxn(context, invoiceId, compute): a row-locked
// read→compute→write where `compute(existing)` returns the next-state patch (or
// null for a no-op). reconcileStripeInvoices reads the Stripe-backed invoices a
// page at a time via invoicesRepo.listStripeCandidateInvoices({ after, pageSize })
// (returning { invoice, context } pairs, empty when the scan is done). The mocks
// below emulate that contract over a single mutable in-memory invoice.

let mockCurrentInvoice: any;

jest.mock('../../src/modules/stripe/stripe.config', () => ({
  invoices: {
    voidInvoice: jest.fn(),
    retrieve: jest.fn(),
  },
  checkout: {
    sessions: {
      retrieve: jest.fn(),
    },
  },
}));

jest.mock('../../src/modules/billing/invoices/invoices.repository', () => ({
  // Row-locked read→compute→write. Loads the current in-memory invoice, runs the
  // caller's compute, and persists the returned patch by merging it (null = no-op).
  // Returns null when the invoice row doesn't exist (compute never runs), matching
  // the real repo used by applyStripeCandidateTransaction's not-found detection.
  runInvoiceTxn: jest.fn(async (_context, invoiceId, compute) => {
    if (!mockCurrentInvoice || mockCurrentInvoice.id !== invoiceId) return null;
    const existing = { ...mockCurrentInvoice };
    const updateData = await compute(existing, {});
    if (updateData == null) return { ...mockCurrentInvoice };
    mockCurrentInvoice = { ...mockCurrentInvoice, ...updateData };
    return { ...mockCurrentInvoice };
  }),
  findById: jest.fn(async () => (mockCurrentInvoice ? { ...mockCurrentInvoice } : null)),
  update: jest.fn(async (_context, _invoiceId, data) => {
    mockCurrentInvoice = { ...mockCurrentInvoice, ...data };
    return { ...mockCurrentInvoice };
  }),
  listStripeCandidateInvoices: jest.fn(async () => []),
  // The reversal handlers look a payment up by its PaymentIntent id across every
  // firm. Answer from the in-memory invoice so a reversal can be driven end to end.
  findInvoicePaymentByStripePaymentIntentAnyFirm: jest.fn(async (paymentIntentId) => {
    const hit = (mockCurrentInvoice?.payments || []).find((p: any) => p.stripePaymentIntentId === paymentIntentId);
    if (!hit) return null;
    return {
      lawFirmId: 'lf_1',
      invoiceId: mockCurrentInvoice.id,
      context: { type: 'matter', lawFirmId: 'lf_1', entityId: 'matter_1' },
    };
  }),
}));

jest.mock('../../src/modules/billing/invoices/invoices.service', () => ({
  refreshInvoiceCalendarSyncAfterPersistence: jest.fn(async () => null),
}));

jest.mock('../../src/shared/events/eventBus', () => ({
  emit: jest.fn(),
}));

jest.mock('../../src/shared/services/emailService', () => ({
  sendPaymentRequestEmail: jest.fn(),
}));

const stripe = require('../../src/modules/stripe/stripe.config');
const invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');
const invoicesService = require('../../src/modules/billing/invoices/invoices.service');
const eventBus = require('../../src/shared/events/eventBus');
const stripeService = require('../../src/modules/stripe/stripe.service');

describe('stripe.service webhook handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('handleCheckoutCompleted is idempotent and clears the stale checkout session id', async () => {
    mockCurrentInvoice = {
      id: 'inv_1',
      totalAmount: 100,
      totalWrittenOff: 0,
      amountPaid: 0,
      isPaid: false,
      payments: [],
      stripeCheckoutSessionId: 'cs_test',
      paymentPlan: null,
      paidDate: null,
    };

    const session = {
      id: 'cs_test',
      amount_total: 10000, // cents -> $100
      payment_intent: 'pi_test',
      created: 1710000000,
      metadata: {
        lawFirmId: 'lf_1',
        invoiceId: 'inv_1',
        contextType: 'matter',
        entityId: 'matter_1',
        clientUserId: 'client_1',
      },
    };

    await stripeService.handleCheckoutCompleted(session);
    await stripeService.handleCheckoutCompleted(session);

    expect(mockCurrentInvoice.amountPaid).toBe(100);
    expect(mockCurrentInvoice.payments).toHaveLength(1);
    expect(mockCurrentInvoice.payments[0]).toMatchObject({
      paymentSource: 'stripe',
      stripeSessionId: 'cs_test',
      stripePaymentIntentId: 'pi_test',
      // Recorded by nobody: the webhook is not a user, and `recorded_by` is a
      // real key to `users`. `paymentSource` is what marks it as Stripe's.
      recordedBy: null,
    });
    expect(mockCurrentInvoice.isPaid).toBe(true);
    expect(mockCurrentInvoice.status).toBe('paid');
    expect(mockCurrentInvoice.stripeCheckoutSessionId).toBeNull();
    // Side effects fire exactly once (second call is a deduped no-op).
    expect(invoicesService.refreshInvoiceCalendarSyncAfterPersistence).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
  });

  test('handleCheckoutCompleted credits the named installment once and keeps nextPaymentDate a Date', async () => {
    mockCurrentInvoice = {
      id: 'inv_1',
      totalAmount: 100,
      totalWrittenOff: 0,
      amountPaid: 0,
      isPaid: false,
      payments: [],
      stripePaymentRequested: true,
      stripeCheckoutSessionId: 'cs_installment',
      payLinkToken: 'tok_installment',
      payLinkInstallmentId: 'ep_2',
      paymentPlan: {
        enabled: true,
        expectedPayments: [
          { id: 'ep_1', dueDate: '2026-05-01', amount: 50, status: 'pending' },
          { id: 'ep_2', dueDate: '2026-06-01', amount: 50, status: 'pending' },
        ],
      },
      nextPaymentDate: null,
      paidDate: null,
    };

    const session = {
      id: 'cs_installment',
      payment_status: 'paid',
      amount_total: 5000, // cents -> $50
      payment_intent: 'pi_installment',
      created: 1710000000,
      metadata: {
        lawFirmId: 'lf_1',
        invoiceId: 'inv_1',
        contextType: 'matter',
        entityId: 'matter_1',
        clientUserId: 'client_1',
        installmentId: 'ep_2',
      },
    };

    await stripeService.handleCheckoutCompleted(session);
    await stripeService.handleCheckoutCompleted(session);

    expect(mockCurrentInvoice.amountPaid).toBe(50);
    expect(mockCurrentInvoice.isPaid).toBe(false);
    expect(mockCurrentInvoice.status).toBe('partially_paid');
    expect(mockCurrentInvoice.payments).toHaveLength(1);
    expect(mockCurrentInvoice.payments[0]).toMatchObject({
      paymentSource: 'stripe',
      stripeSessionId: 'cs_installment',
      stripePaymentIntentId: 'pi_installment',
    });
    // The named row is paid, not the earliest open one.
    expect(mockCurrentInvoice.paymentPlan.expectedPayments.map((ep: any) => [ep.id, ep.status])).toEqual([
      ['ep_1', 'pending'],
      ['ep_2', 'paid'],
    ]);
    // The recorded payment ends the request.
    expect(mockCurrentInvoice).toMatchObject({
      stripePaymentRequested: false,
      stripePaymentStatus: 'completed',
      stripeCheckoutSessionId: null,
      payLinkToken: null,
      payLinkInstallmentId: null,
    });
    // nextPaymentDate is a native JS Date pointing at the still-pending installment.
    expect(mockCurrentInvoice.nextPaymentDate).toBeInstanceOf(Date);
    expect(mockCurrentInvoice.nextPaymentDate.toISOString()).toContain('2026-05-01');
    // Side effects fire exactly once (second call is a deduped no-op).
    expect(invoicesService.refreshInvoiceCalendarSyncAfterPersistence).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
  });

  test('reconcileStripeInvoices dry-run reports a paid checkout session missing from the invoice without mutating it', async () => {
    // One page, then nothing: the job pages until a page comes back empty, so a
    // mock that answered the same page forever would never terminate.
    const page = [
      {
        invoice: {
          id: 'inv_1',
          totalAmount: 100,
          totalWrittenOff: 0,
          amountPaid: 0,
          isPaid: false,
          payments: [],
          stripePaymentRequested: true,
          stripeCheckoutSessionId: 'cs_paid_1',
          // A pointer left from before payment requests became pay links.
          // Reconciliation reads only the checkout session, so it must not be
          // looked up.
          stripeInvoiceId: 'in_legacy',
          paymentPlan: null,
        },
        context: { type: 'matter', lawFirmId: 'lf_1', entityId: 'matter_1' },
      },
    ];
    invoicesRepo.listStripeCandidateInvoices
      .mockResolvedValueOnce(page)
      .mockResolvedValue([]);

    stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_paid_1',
      status: 'complete',
      payment_status: 'paid',
      amount_total: 10000, // cents -> $100
      payment_intent: 'pi_paid_1',
      created: 1710000000,
      metadata: {
        lawFirmId: 'lf_1',
        invoiceId: 'inv_1',
        contextType: 'matter',
        entityId: 'matter_1',
      },
    });

    const summary = await stripeService.reconcileStripeInvoices({ dryRun: true });

    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_paid_1');
    expect(stripe.invoices.retrieve).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ eligible: 1, changed: 1, repaired: 0, failures: [] });
    expect(invoicesRepo.update).not.toHaveBeenCalled();
  });
});

describe('handleInvoicePaymentReversal on a dispute', () => {
  const paidInvoice = () => ({
    id: 'inv_1', totalAmount: 100, totalWrittenOff: 0, amountPaid: 100, isPaid: true,
    paidDate: '2026-09-01T00:00:00.000Z', paymentPlan: null, stripeInvoiceId: 'in_1',
    payments: [{ amount: 100, paymentSource: 'stripe', stripePaymentIntentId: 'pi_disputed', stripeRefundedCents: 0 }],
  });

  // A partial dispute, and its redelivery, are pinned through the real route in
  // `stripeReversalWebhooks.test.ts`.
  test('a dispute with no amount still reverses the whole charge', async () => {
    mockCurrentInvoice = paidInvoice();
    await stripeService.handleInvoicePaymentReversal({ payment_intent: 'pi_disputed' }, 'dispute');
    expect(mockCurrentInvoice.payments[0].amount).toBe(0);
    expect(mockCurrentInvoice.amountPaid).toBe(0);
  });
});

// `formatDueDateForEmail` feeds the payment-request email's `dueDate` text
// (`requestPayment` calls it). It pins
// `timeZone: 'UTC'` explicitly because the value comes from a `date`-only
// column with no timezone concept of its own; reading it back without an
// explicit zone would use the SERVER PROCESS's ambient local zone, and on a
// server running behind UTC that silently shows the day BEFORE the one on
// the invoice - the exact defect these cases pin against regressing.
describe('formatDueDateForEmail', () => {
  it('names the literal calendar day for a bare YYYY-MM-DD string', () => {
    expect(stripeService.formatDueDateForEmail('2026-03-15')).toBe('March 15, 2026');
  });

  it('names the literal calendar day for a full ISO instant at UTC midnight', () => {
    expect(stripeService.formatDueDateForEmail('2026-03-15T00:00:00.000Z')).toBe('March 15, 2026');
  });

  it('accepts a Firestore-compatible timestamp', () => {
    expect(stripeService.formatDueDateForEmail({ toDate: () => new Date('2026-01-01T00:00:00.000Z') }))
      .toBe('January 1, 2026');
  });

  it('returns null for a missing or unparseable value', () => {
    expect(stripeService.formatDueDateForEmail(null)).toBeNull();
    expect(stripeService.formatDueDateForEmail(undefined)).toBeNull();
    expect(stripeService.formatDueDateForEmail('not a date')).toBeNull();
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
