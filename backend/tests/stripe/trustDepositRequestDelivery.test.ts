/**
 * Sending a trust deposit request: the firm has Paralegix email the secure
 * bank-transfer link to the client, or copies it to send another way, the same
 * choice an invoice payment request offers.
 *
 * Red if a copy request emails the client, if an emailed one goes to anyone
 * but the client's billing address or without the link, or if a firm with no
 * address to email is told it was sent.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    customers: { create: fn(), retrieve: fn(), update: fn(), list: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
  };
});

import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  emailsMatching,
  resetEmails,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const fakeStripe = () => require('../../src/modules/stripe/stripe.config');
const LINK = 'https://checkout.stripe.test/cs_deposit';

let firm: Firm;
let owner: Actor;
let trustAccountId: string;

beforeEach(async () => {
  resetEmails();
  firm = await createFirm({ name: 'Deposit LLP' });
  owner = await ownerOf(firm.id);
  await testPool.query(
    `update law_firms
        set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{trust}',
                                 '{"electronicTrustDepositsAllowed": true}'::jsonb, true),
            plan = coalesce(plan, '{}'::jsonb) || '{"stripeCustomerId": "cus_firm_sub"}'::jsonb
      where id = $1`,
    [firm.id],
  );
  trustAccountId = randomUUID();
  await testPool.query(
    `insert into trust_accounts
       (id, law_firm_id, name, account_type, status, stripe_connected_account_id, stripe_charges_enabled)
     values ($1, $2, 'Client IOLTA', 'iolta', 'active', 'acct_trust_delivery', true)`,
    [trustAccountId, firm.id],
  );
  const stripe = fakeStripe();
  stripe.customers.create.mockReset().mockResolvedValue({ id: 'cus_depositor' });
  stripe.customers.list.mockReset().mockResolvedValue({ data: [] });
  stripe.checkout.sessions.create.mockReset().mockResolvedValue({ id: 'cs_deposit', url: LINK });
});

const post = (body: any) => owner.api.post(`/api/stripe/trust/${firm.id}/request-deposit`).send(body);

/** The request email is sent without being awaited, so wait for it to land. */
async function depositEmail() {
  for (let i = 0; i < 50; i += 1) {
    const [email] = emailsMatching(/Trust deposit requested/);
    if (email) return email;
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  }
  return undefined;
}

it('emails the deposit link to the client when asked', async () => {
  const client = await createPersonClient(firm.id, { name: 'Dana Depositor', email: 'dana@example.test' });

  const res = await post({ trustAccountId, clientId: client.id, amountCents: 150_000, sendEmail: true });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ checkoutUrl: LINK, sessionId: 'cs_deposit', emailedTo: 'dana@example.test' });
  const email = await depositEmail();
  expect(email?.to).toEqual(['dana@example.test']);
  expect(email?.html).toContain(`href="${LINK}"`);
  expect(email?.text).toContain('$1,500.00');
  // Stripe ends a checkout link after a day, so the client is told.
  expect(email?.text).toContain('24 hours');
});

it('creates the link without emailing when the firm copies it instead', async () => {
  const client = await createPersonClient(firm.id, { email: 'dana@example.test' });

  const res = await post({ trustAccountId, clientId: client.id, amountCents: 150_000, sendEmail: false });

  expect(res.status).toBe(200);
  expect(res.body.emailedTo).toBeNull();
  expect(res.body.checkoutUrl).toBe(LINK);
  expect(await depositEmail()).toBeUndefined();
});

it('rejects a delivery choice that is not true or false', async () => {
  const client = await createPersonClient(firm.id, { email: 'dana@example.test' });

  const res = await post({ trustAccountId, clientId: client.id, amountCents: 150_000, sendEmail: 'yes' });

  expect(res.status).toBe(400);
  expect(fakeStripe().checkout.sessions.create).not.toHaveBeenCalled();
});
