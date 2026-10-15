/**
 * Signed Stripe webhook delivery for the payment-lifecycle specs.
 *
 * `refuseAllStripe` is the factory for `jest.mock('.../stripe.config')`: every
 * SDK surface throws, so a spec that reaches Stripe fails loudly instead of
 * calling out. `stripeHarness` builds `checkout.session.completed` payloads for
 * the world's invoice and delivers them through the real, signature-verified
 * webhook route, then drains the event bus so listeners have run.
 */
import { randomUUID } from 'crypto';
import { drainEvents } from '../../support/setupInProcess';
import {
  deliverSigned,
  stripeEventPayload,
  stripeWebhookSender,
  newPaymentIntentId,
} from '../../support/stripeWebhook';
import type { World } from './lifecycleKit';

export function refuseAllStripe() {
  const StripeLib = require('stripe');
  const refuse = (name: string) => () => {
    throw new Error(`stripe.${name} was called`);
  };
  return {
    webhooks: StripeLib.webhooks,
    invoices: {
      create: refuse('invoices.create'),
      retrieve: refuse('invoices.retrieve'),
      voidInvoice: refuse('invoices.voidInvoice'),
    },
    customers: { retrieve: refuse('customers.retrieve') },
    checkout: { sessions: { retrieve: refuse('checkout.sessions.retrieve'), expire: refuse('checkout.sessions.expire') } },
    paymentIntents: { create: refuse('paymentIntents.create'), retrieve: refuse('paymentIntents.retrieve') },
    transfers: {
      create: refuse('transfers.create'),
      retrieve: refuse('transfers.retrieve'),
      createReversal: refuse('transfers.createReversal'),
    },
  };
}

export function stripeHarness(getWorld: () => World, secret = 'whsec_lifecycle_secret') {
  const sender = stripeWebhookSender(secret);
  let counter = 0;
  const now = () => Math.floor(Date.now() / 1000);

  const checkout = (cents: number, paymentIntent: string) => {
    const w = getWorld();
    return {
      id: `cs_${randomUUID().slice(0, 8)}`,
      object: 'checkout.session',
      payment_status: 'paid',
      amount_total: cents,
      payment_intent: paymentIntent,
      created: now(),
      metadata: { lawFirmId: w.firm.id, invoiceId: w.invoiceId, contextType: 'client', entityId: w.clientId },
    };
  };

  async function send(type: string, object: unknown, id = `evt_lc_${counter++}_${randomUUID().slice(0, 8)}`) {
    const res = await deliverSigned(stripeEventPayload(id, type, object), secret);
    await drainEvents();
    return res;
  }

  async function stripePaid(cents: number) {
    const paymentIntent = newPaymentIntentId();
    const res = await send('checkout.session.completed', checkout(cents, paymentIntent));
    expect(res.status).toBe(200);
    return paymentIntent;
  }

  return {
    sender,
    checkout,
    send,
    stripePaid,
    install: () => { process.env.STRIPE_WEBHOOK_SECRET = secret; },
  };
}
