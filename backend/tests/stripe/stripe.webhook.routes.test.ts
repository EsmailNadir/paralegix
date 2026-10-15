jest.mock('../../src/modules/stripe/stripe.config', () => ({
  webhooks: {
    constructEvent: jest.fn(),
  },
}));

jest.mock('../../src/modules/stripe/stripe.service', () => ({
  // The route claims the Stripe event id for idempotency before dispatching to a
  // handler. Mock the claim to succeed (this caller "won" the event) and the
  // release and finish to no-op so the handler path, not the claim guard, is
  // what these tests exercise.
  claimStripeEvent: jest.fn().mockResolvedValue({ status: 'claimed', claimToken: 'claim_token' }),
  releaseStripeEvent: jest.fn().mockResolvedValue(undefined),
  finishStripeEvent: jest.fn().mockResolvedValue(undefined),
  handleCheckoutCompleted: jest.fn(),
  handleCheckoutExpired: jest.fn(),
  handleCheckoutAsyncPaymentFailed: jest.fn(),
  handleAccountUpdated: jest.fn(),
}));

const stripe = require('../../src/modules/stripe/stripe.config');
const stripeService = require('../../src/modules/stripe/stripe.service');
const router = require('../../src/modules/stripe/stripe.webhook.routes');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code: any) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
}

// The 500-and-release path and signature refusals are driven through the real
// route in `stripeInvoiceEffectRecovery` and `webhookIdempotency`, and a Paralegix
// invoice.paid recording nothing in `installmentPayLinks`. This file keeps the
// dispatch branch for hosted Stripe invoice events: every one is acknowledged.
describe('stripe.webhook.routes', () => {
  const handler = router.stack[0].route.stack[0].handle;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    // A trust ACH fee invoice carries `{ lawFirmId, trustTransactionId }` and no
    // `invoiceId`. Refusing it answered 500 and Stripe retried for three days.
    ['invoice.paid', { lawFirmId: 'lf_1', trustTransactionId: 'tt_1' }],
    // Invoice payments are collected through checkout sessions, so even an event
    // naming a Paralegix invoice is not a payment to record here.
    ['invoice.paid', { lawFirmId: 'lf_1', invoiceId: 'inv_1', contextType: 'client', entityId: 'c_1' }],
    ['invoice.voided', { lawFirmId: 'lf_1', invoiceId: 'inv_1', contextType: 'client', entityId: 'c_1' }],
  ])('acknowledges %s without handing it to any handler', async (type, metadata) => {
    stripe.webhooks.constructEvent.mockReturnValue({
      id: `evt_${type}`,
      type,
      data: { object: { id: 'in_any', object: 'invoice', metadata } },
    });

    const res = createResponse();
    await handler({ body: Buffer.from('{}'), headers: { 'stripe-signature': 'sig' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(stripeService.claimStripeEvent).toHaveBeenCalledWith(`evt_${type}`, 'payments');
    for (const name of ['handleCheckoutCompleted', 'handleCheckoutExpired', 'handleCheckoutAsyncPaymentFailed', 'handleAccountUpdated']) {
      expect(stripeService[name]).not.toHaveBeenCalled();
    }
    expect(stripeService.releaseStripeEvent).not.toHaveBeenCalled();
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
