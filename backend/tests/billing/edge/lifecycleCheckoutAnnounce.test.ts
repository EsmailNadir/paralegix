/**
 * A checkout payment commits before anything is announced. Whatever goes wrong
 * after that commit (the invoice read-back, an event listener) is logged and never
 * turns the committed payment into a 500, because Stripe's retry would find the
 * payment already recorded and could not announce it anyway.
 */
jest.mock('../../../src/modules/stripe/stripe.config', () => require('./lifecycleStripeKit').refuseAllStripe());

import { randomUUID } from 'crypto';
import { drainEvents, sentEmails, resetEmails } from '../../support/setupInProcess';
import { deliverSigned, stripeEventPayload, newPaymentIntentId } from '../../support/stripeWebhook';
import { seedWorld, invoiceRow, paymentRows, assertInvoiceInvariants, type World } from './lifecycleKit';
import { stripeHarness } from './lifecycleStripeKit';

const bus = require('../../../src/shared/events/eventBus');
const invoicesRepo = require('../../../src/modules/billing/invoices/invoices.repository');

const SECRET = 'whsec_lifecycle_secret';
let w: World;
const stripe = stripeHarness(() => w, SECRET);
let emitted: string[] = [];
let emitSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeAll(stripe.install);
beforeEach(async () => {
  w = await seedWorld(100_000);
  resetEmails();
  emitted = [];
  const realEmit = bus.emit.bind(bus);
  emitSpy = jest.spyOn(bus, 'emit').mockImplementation((...args: any[]) => {
    emitted.push(args[0]);
    return realEmit(...args);
  });
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  emitSpy.mockRestore();
  errorSpy.mockRestore();
  jest.restoreAllMocks();
});

const deliver = (eventId: string, session: unknown) =>
  deliverSigned(stripeEventPayload(eventId, 'checkout.session.completed', session), SECRET);
const received = () => emitted.filter((e) => e === 'invoice.paymentReceived');
const receipts = () => sentEmails().filter((e) => /received your payment/i.test(e.text || ''));

it('announces a payment once, and a redelivery of the same event announces nothing more', async () => {
  const eventId = `evt_announce_${randomUUID().slice(0, 8)}`;
  const session = stripe.checkout(100_000, newPaymentIntentId());

  const first = await deliver(eventId, session);
  const retry = await deliver(eventId, session);
  await drainEvents();

  expect([first.status, retry.status]).toEqual([200, 200]);
  expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([100_000]);
  expect(received()).toHaveLength(1);
  expect(receipts()).toHaveLength(1);
  expect((await invoiceRow(w.invoiceId)).is_paid).toBe(true);
  await assertInvoiceInvariants(w.invoiceId);
});

it('a failing invoice read after the commit does not fail the webhook or lose the announcement', async () => {
  jest.spyOn(invoicesRepo, 'findById').mockImplementation(async () => { throw new Error('db blip'); });

  const res = await deliver(`evt_${randomUUID().slice(0, 8)}`, stripe.checkout(100_000, newPaymentIntentId()));
  await drainEvents();

  expect(res.status).toBe(200);
  expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([100_000]);
  expect(received()).toHaveLength(1);
});

it('the announcement reports the invoice as fully paid', async () => {
  const seen: any[] = [];
  emitSpy.mockImplementation((...args: any[]) => {
    if (args[0] === 'invoice.paymentReceived') seen.push(args[1]);
    return true;
  });

  const res = await deliver(`evt_${randomUUID().slice(0, 8)}`, stripe.checkout(100_000, newPaymentIntentId()));

  expect(res.status).toBe(200);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ amountPaidCents: 100_000, isFullyPaid: true, source: 'stripe', invoiceId: w.invoiceId });
});

it('a failing announcement is logged and the webhook still answers 200 with the payment recorded', async () => {
  emitSpy.mockImplementation((name: string) => {
    if (name === 'invoice.paymentReceived') throw new Error('listener exploded');
    return true;
  });

  const res = await deliver(`evt_${randomUUID().slice(0, 8)}`, stripe.checkout(100_000, newPaymentIntentId()));

  expect(res.status).toBe(200);
  expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([100_000]);
  expect(JSON.stringify(errorSpy.mock.calls)).toMatch(/listener exploded/);
  await assertInvoiceInvariants(w.invoiceId);
});
