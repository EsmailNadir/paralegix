/**
 * Collected revenue after a Stripe payment lands on an already-voided invoice.
 *
 * Money that arrives on a cancelled bill is owed back to the payer, so it is not
 * revenue the firm collected. The dashboard's collected-this-month figure, the
 * billing summary's totalCollected and the workbench's totalCollected must agree
 * on that, and must still count a live invoice's Stripe payment.
 *
 * RED IF: the dashboard sums an invoice_payments row whose invoice is voided
 * into collectedThisMonthCents, or any of the three surfaces drops the live
 * invoice's payment.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE: stripe.config is replaced wholesale.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const StripeLib = require('stripe');
  return {
    webhooks: StripeLib.webhooks,
    invoices: {
      retrieve: jest.fn(), voidInvoice: jest.fn(), create: jest.fn(), finalizeInvoice: jest.fn(),
    },
    invoiceItems: { create: jest.fn() },
    customers: { create: jest.fn() },
    checkout: { sessions: { retrieve: jest.fn(), expire: jest.fn(), create: jest.fn() } },
    paymentIntents: { create: jest.fn(), retrieve: jest.fn(), list: jest.fn() },
    transfers: { createReversal: jest.fn() },
    accounts: { retrieve: jest.fn() },
  };
});

import {
  testPool, createFirm, createPersonClient, createInvoice, ownerOf, type Actor, type Firm,
} from '../support/setupInProcess';
import { stripeWebhookSender } from '../support/stripeWebhook';

const WEBHOOK_SECRET = 'whsec_voided_invoice_collected_spec';

let firm: Firm;
let owner: Actor;
let clientId: string;
let liveId: string;
let voidedId: string;
let errorSpy: jest.SpyInstance;

// A direct charge is reported by the firm's own connected account.
const FIRM_ACCOUNT = 'acct_voided_collected';
const send = stripeWebhookSender(WEBHOOK_SECRET, { account: FIRM_ACCOUNT });

async function stripePays(invoiceId: string, cents: number, intent: string) {
  const now = Math.floor(Date.now() / 1000);
  await send.deliver('checkout.session.completed', {
    id: `cs_${intent}`, object: 'checkout.session', status: 'complete', payment_status: 'paid',
    amount_total: cents, created: now,
    payment_intent: intent,
    metadata: { lawFirmId: firm.id, invoiceId, contextType: 'client', entityId: clientId, chargeModel: 'direct' },
  });
}

const dashboardCollected = async () => {
  const res = await owner.api.get(`/api/lawfirms/${firm.id}/dashboard-summary`);
  expect(res.status).toBe(200);
  return res.body.stats.collectedThisMonthCents;
};
const analyticsCollected = async () => {
  const res = await owner.api.get(`/api/lawfirms/${firm.id}/billing/analytics/billing-summary`);
  expect(res.status).toBe(200);
  return res.body.totalCollected;
};
const workbenchCollected = async () => {
  const res = await owner.api.get(`/api/lawfirms/${firm.id}/billing/workbench`);
  expect(res.status).toBe(200);
  return res.body.summary.totalCollected;
};

beforeAll(() => { process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET; });
beforeEach(async () => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  firm = await createFirm();
  await testPool.query('update law_firms set stripe_account_id = $2 where id = $1', [firm.id, FIRM_ACCOUNT]);
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { email: 'collected@example.test' })).id;
  liveId = (await createInvoice(firm.id, clientId, { totalCents: 40_000 })).id;
  voidedId = (await createInvoice(firm.id, clientId, { totalCents: 25_000 })).id;
});
afterEach(() => errorSpy.mockRestore());

it('counts a live invoice Stripe payment on the dashboard, the billing summary and the workbench (control)', async () => {
  await stripePays(liveId, 40_000, 'pi_live_collected');

  const { rows } = await testPool.query('select amount_cents from invoice_payments where invoice_id = $1', [liveId]);
  expect(rows).toEqual([{ amount_cents: '40000' }]);
  expect(await dashboardCollected()).toBe(40_000);
  expect(await analyticsCollected()).toBe(400);
  expect(await workbenchCollected()).toBe(400);
});

it('leaves a payment that landed on a voided invoice out of all three, beside a live payment', async () => {
  await stripePays(liveId, 40_000, 'pi_live_beside');
  const voidRes = await owner.api.post(
    `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${voidedId}/void`);
  expect(voidRes.status).toBe(200);

  await stripePays(voidedId, 25_000, 'pi_voided_late');

  // The late payment is on record, so the exclusion below is not an empty table.
  const { rows } = await testPool.query(
    'select amount_cents from invoice_payments where invoice_id = $1', [voidedId]);
  expect(rows).toEqual([{ amount_cents: '25000' }]);
  expect(await dashboardCollected()).toBe(40_000);
  expect(await analyticsCollected()).toBe(400);
  expect(await workbenchCollected()).toBe(400);
});
