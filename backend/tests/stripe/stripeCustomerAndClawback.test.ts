/**
 * Two Stripe behaviours that reach a real person or a real bill.
 *
 *   `getOrCreateStripeCustomer` creates a customer once and reuses it forever,
 *   so the identity Stripe holds is whatever it was on the first payment. A
 *   company whose billing recipient changes keeps the old address at Stripe, and
 *   Stripe's own hosted-invoice and receipt mail keeps going there while
 *   Paralegix mails the new list. The sync is best-effort on purpose: it runs on
 *   a payment path, and a stale display name is not worth refusing a payment.
 *
 *   `notifyFirmOfClawbackCharge` is the other half of a recovery charge. When a
 *   trust deposit is returned or disputed and the funds have already left the
 *   trust account, the firm's card is charged off-session to make the account
 *   whole. Nothing persists that PaymentIntent, so if the dispute is later won
 *   the refund is only findable if the id reached a human. It used to be a log
 *   line.
 */
const refuse = (name: string) => jest.fn(() => {
  throw new Error(`stripe.${name} was called; this spec must not reach that surface`);
});

jest.mock('../../src/modules/stripe/stripe.config', () => ({
  customers: {
    retrieve: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  accounts: { retrieve: refuse('accounts.retrieve') },
  paymentIntents: { create: refuse('paymentIntents.create') },
}));

import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const stripe = require('../../src/modules/stripe/stripe.config');
const stripeService = require('../../src/modules/stripe/stripe.service');

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  jest.clearAllMocks();
  firm = await createFirm({ name: 'Customer Sync Firm' });
  owner = await ownerOf(firm.id);
});

/** A client that already has a Stripe customer, as one has after its first payment. */
async function clientWithCustomer(customerId: string, overrides: { name?: string; email?: string } = {}) {
  const client = await createPersonClient(firm.id, {
    name: overrides.name ?? 'Original Name',
    email: overrides.email ?? 'original@example.test',
  });
  await testPool.query(
    'update clients set stripe_customer_id = $2 where id = $1', [client.id, customerId],
  );
  return client;
}

describe('the Stripe customer follows the client record', () => {
  it('pushes a changed email and name onto the existing customer', async () => {
    const client = await clientWithCustomer('cus_existing');
    stripe.customers.retrieve.mockResolvedValue({
      id: 'cus_existing', email: 'original@example.test', name: 'Original Name',
    });

    const customerId = await stripeService.getOrCreateStripeCustomer({
      lawFirmId: firm.id,
      clientId: client.id,
      clientEmail: 'new-billing@example.test',
      clientName: 'New Billing Contact',
    });

    // Same customer, corrected identity. A new customer here would orphan the
    // firm's payment history against the old one.
    expect(customerId).toBe('cus_existing');
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.customers.update).toHaveBeenCalledWith('cus_existing', {
      email: 'new-billing@example.test',
      name: 'New Billing Contact',
    });
  });

  it('writes nothing when the identity already matches', async () => {
    const client = await clientWithCustomer('cus_same');
    stripe.customers.retrieve.mockResolvedValue({
      id: 'cus_same', email: 'original@example.test', name: 'Original Name',
    });

    await stripeService.getOrCreateStripeCustomer({
      lawFirmId: firm.id,
      clientId: client.id,
      clientEmail: 'original@example.test',
      clientName: 'Original Name',
    });

    // One read and no write. This runs on every payment, so a no-op must cost a
    // single call rather than an update per payment.
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it('sends only the field that changed', async () => {
    const client = await clientWithCustomer('cus_partial');
    stripe.customers.retrieve.mockResolvedValue({
      id: 'cus_partial', email: 'original@example.test', name: 'Original Name',
    });

    await stripeService.getOrCreateStripeCustomer({
      lawFirmId: firm.id,
      clientId: client.id,
      clientEmail: 'moved@example.test',
      clientName: 'Original Name',
    });

    expect(stripe.customers.update).toHaveBeenCalledWith('cus_partial', { email: 'moved@example.test' });
  });

  it('still returns the customer when Stripe refuses the sync', async () => {
    const client = await clientWithCustomer('cus_unreachable');
    stripe.customers.retrieve.mockRejectedValue(new Error('Stripe unavailable'));

    const customerId = await stripeService.getOrCreateStripeCustomer({
      lawFirmId: firm.id,
      clientId: client.id,
      clientEmail: 'new@example.test',
      clientName: 'New Name',
    });

    // The caller is on a payment path. The id we hold is still the right
    // customer, so a failed sync must not refuse the payment.
    expect(customerId).toBe('cus_unreachable');
  });

  it('leaves a deleted customer alone rather than trying to update it', async () => {
    const client = await clientWithCustomer('cus_deleted');
    stripe.customers.retrieve.mockResolvedValue({ id: 'cus_deleted', deleted: true });

    await stripeService.getOrCreateStripeCustomer({
      lawFirmId: firm.id,
      clientId: client.id,
      clientEmail: 'new@example.test',
      clientName: 'New Name',
    });

    expect(stripe.customers.update).not.toHaveBeenCalled();
  });
});

describe('a trust clawback charge reaches the firm', () => {
  async function clawbackAlerts() {
    await drainEvents();
    const { rows } = await testPool.query(
      `select user_id, title, body from notifications
        where law_firm_id = $1 and type = 'trust_clawback_charged'`,
      [firm.id],
    );
    return rows;
  }

  it('names the amount and the PaymentIntent the refund would have to reference', async () => {
    await stripeService.notifyFirmOfClawbackCharge(firm.id, 42_500, 'pi_recovery_1');

    const alerts = await clawbackAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].user_id).toBe(owner.uid);
    expect(alerts[0].title).toMatch(/card was charged/i);
    // Both figures matter: the firm needs to know what was taken, and a won
    // dispute is refunded by hand against this id. Nothing else records it.
    expect(alerts[0].body).toContain('$425.00');
    expect(alerts[0].body).toContain('pi_recovery_1');
  });

  it('does not throw when the firm has nobody to tell', async () => {
    const emptyFirm = await createFirm({ name: 'No Members LLP' });

    await expect(
      stripeService.notifyFirmOfClawbackCharge(emptyFirm.id, 1000, 'pi_recovery_2'),
    ).resolves.toBeUndefined();
  });
});
