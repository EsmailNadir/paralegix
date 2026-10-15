/**
 * The trust ledger side of a Stripe ACH deposit at its edges: a clawback on a
 * deposit the books have already closed over, a re-credit that has to keep the
 * deposit's matter, and a deposit that settles after the account was closed or
 * trust accounting was switched off.
 *
 * Delivered through the real payments webhook into real Postgres, with
 * automatic cash recovery OFF (its production default, forced by
 * `tests/support/db.ts`). Every Stripe SDK surface refuses, and the `afterEach`
 * fails a case that reached for one: these are database-only decisions.
 */

const mockStripeCalls: string[] = [];

jest.mock('../../src/modules/stripe/stripe.config', () => {
  // `require`, not `import`: the package's ESM entry does not parse under Jest.
  const StripeLib = require('stripe');
  const refuse = (name: string) => () => {
    mockStripeCalls.push(name);
    throw new Error(`stripe.${name} was called; recovery is off, so no Stripe call may happen`);
  };
  return {
    webhooks: StripeLib.webhooks,
    invoices: { create: refuse('invoices.create'), retrieve: refuse('invoices.retrieve') },
    customers: { retrieve: refuse('customers.retrieve') },
    paymentIntents: { create: refuse('paymentIntents.create'), retrieve: refuse('paymentIntents.retrieve') },
    refunds: { create: refuse('refunds.create') },
    transfers: {
      create: refuse('transfers.create'),
      retrieve: refuse('transfers.retrieve'),
      createReversal: refuse('transfers.createReversal'),
    },
  };
});

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  drainEvents,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter, seedMatterClient } from '../support/matters';
import {
  STRIPE_DEPOSIT_CENTS as DEPOSIT_CENTS,
  deliverSigned,
  newPaymentIntentId,
  paymentIntentSucceededEvent,
  stripeWebhookSender,
  trustBookBalance as bookBalance,
  trustRowsFor as trustRows,
} from '../support/stripeWebhook';

const WEBHOOK_SECRET = 'whsec_trust_ledger_edges_spec_secret';
const { refunded, disputed, disputeClosed } = stripeWebhookSender(WEBHOOK_SECRET);

let firm: Firm;
let owner: Actor;

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  mockStripeCalls.length = 0;
});

afterEach(() => {
  expect(mockStripeCalls).toEqual([]);
});

/**
 * One trust account holding one ACH deposit posted from `paymentIntentId`,
 * dated `txnDate`, optionally against a matter of the same client. Inserted
 * directly because `trust_transactions` is append-only: the date and the
 * payment intent have to be on the row from the start.
 */
async function seedDeposit(paymentIntentId: string, { txnDate = null as string | null, withMatter = false } = {}) {
  const client = await createPersonClient(firm.id, { email: 'edge-client@example.test' });
  const matterId = withMatter ? await seedMatter(firm.id) : null;
  if (matterId) await seedMatterClient(firm.id, matterId, client.id);
  const accountId = randomUUID();
  const depositId = randomUUID();
  await testPool.query(
    `insert into trust_accounts (id, law_firm_id, name, account_type, status, book_balance_cents, stripe_connected_account_id)
     values ($1, $2, 'Stripe IOLTA', 'iolta', 'active', $3, 'acct_trust_fixture')`,
    [accountId, firm.id, DEPOSIT_CENTS],
  );
  await testPool.query(
    `insert into trust_transactions
       (id, law_firm_id, trust_account_id, type, amount_cents, client_id, matter_id, txn_date, description,
        status, client_balance_after_cents, account_balance_after_cents, source, stripe_payment_intent_id)
     values ($1, $2, $3, 'deposit', $4, $5, $6, coalesce($7::date, current_date), 'ACH retainer',
             'completed', $4, $4, 'stripe', $8)`,
    [depositId, firm.id, accountId, DEPOSIT_CENTS, client.id, matterId, txnDate, paymentIntentId],
  );
  return { accountId, depositId, clientId: client.id, matterId };
}

async function clientBalance(clientId: string) {
  const res = await owner.api.get(`/api/lawfirms/${firm.id}/trust/clients/${clientId}/balance`);
  expect(res.status).toBe(200);
  return Number(res.body.totalBalanceCents);
}

async function notificationsOfType(type: string) {
  const { rows } = await testPool.query(
    'select user_id, title, body from notifications where law_firm_id = $1 and type = $2',
    [firm.id, type],
  );
  return rows;
}

/** Spend part of the client's deposit so a full reversal would go negative. */
async function disburse(accountId: string, clientId: string, cents: number) {
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/trust/transactions`).send({
    trustAccountId: accountId, clientId, clientName: 'Edge Client', type: 'withdrawal',
    amountCents: cents, date: new Date().toISOString().slice(0, 10),
  });
  expect(res.status).toBe(201);
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  const warnings = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    errors.mockRestore();
    warnings.mockRestore();
  }
}

describe('a full clawback on a deposit the books have already closed over', () => {
  it('reverses a reconciled deposit with a withdrawal dated today, taking the client to zero', async () => {
    const pi = newPaymentIntentId();
    const { accountId, depositId, clientId } = await seedDeposit(pi, { txnDate: '2026-01-15' });
    // Cleared by a signed three-way reconciliation, which a void must never touch.
    await testPool.query('update trust_transactions set cleared_at = now() where id = $1', [depositId]);

    await refunded(pi, DEPOSIT_CENTS);

    expect((await trustRows(accountId)).map((r) => [r.type, r.status, r.cents])).toEqual([
      ['deposit', 'completed', DEPOSIT_CENTS],
      ['withdrawal', 'completed', DEPOSIT_CENTS],
    ]);
    const { rows } = await testPool.query(
      `select reverses_transaction_id, txn_date from trust_transactions where type = 'withdrawal' and trust_account_id = $1`,
      [accountId],
    );
    expect(rows[0].reverses_transaction_id).toBe(depositId);
    expect(rows[0].txn_date).not.toBe('2026-01-15');
    expect(await bookBalance(accountId)).toBe(0);
    expect(await clientBalance(clientId)).toBe(0);
    expect(await notificationsOfType('trust_reversal_failed')).toEqual([]);
  });

  it('reverses a deposit dated inside a closed book period', async () => {
    const pi = newPaymentIntentId();
    const { accountId, clientId } = await seedDeposit(pi, { txnDate: '2026-01-15' });
    await testPool.query(`update trust_accounts set book_close_date = '2026-01-31' where id = $1`, [accountId]);

    await disputed(pi, DEPOSIT_CENTS);

    expect((await trustRows(accountId)).map((r) => [r.type, r.status, r.cents])).toEqual([
      ['deposit', 'completed', DEPOSIT_CENTS],
      ['withdrawal', 'completed', DEPOSIT_CENTS],
    ]);
    expect(await bookBalance(accountId)).toBe(0);
    expect(await clientBalance(clientId)).toBe(0);
  });

  it('still refuses when the reconciled deposit was spent, and alerts instead', async () => {
    // The fallback is for a closed period, not for spent money: reversing here
    // would take this client below zero on other clients' funds.
    const pi = newPaymentIntentId();
    const { accountId, depositId, clientId } = await seedDeposit(pi, { txnDate: '2026-01-15' });
    await testPool.query('update trust_transactions set cleared_at = now() where id = $1', [depositId]);
    await disburse(accountId, clientId, 50_000);

    await quietly(() => refunded(pi, DEPOSIT_CENTS));

    expect((await trustRows(accountId)).map((r) => [r.type, r.status, r.cents])).toEqual([
      ['deposit', 'completed', DEPOSIT_CENTS],
      ['withdrawal', 'completed', 50_000],
    ]);
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS - 50_000);
    expect(await clientBalance(clientId)).toBe(DEPOSIT_CENTS - 50_000);
    expect(await notificationsOfType('trust_reversal_failed')).toHaveLength(1);
  });
});

describe('a won dispute re-credits a voided deposit', () => {
  it('puts the money back on the matter it was deposited for', async () => {
    const pi = newPaymentIntentId();
    const { accountId, matterId } = await seedDeposit(pi, { withMatter: true });
    await disputed(pi, DEPOSIT_CENTS);
    expect(await bookBalance(accountId)).toBe(0);

    await disputeClosed(pi, DEPOSIT_CENTS, 'won');

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/trust/matters/${matterId}/balance`);
    expect(res.status).toBe(200);
    expect(Number(res.body.totalBalanceCents)).toBe(DEPOSIT_CENTS);
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS);
  });
});

describe('a won dispute whose re-credit the ledger refuses', () => {
  it('alerts the firm that returned trust money is not on the books', async () => {
    const pi = newPaymentIntentId();
    const { accountId } = await seedDeposit(pi);
    await disputed(pi, DEPOSIT_CENTS);
    await testPool.query(`update trust_accounts set book_close_date = '2099-12-31' where id = $1`, [accountId]);

    await quietly(() => disputeClosed(pi, DEPOSIT_CENTS, 'won'));

    expect(await bookBalance(accountId)).toBe(0);
    const alerts = await notificationsOfType('trust_deposit_posting_failed');
    expect(alerts.map((a: any) => [a.user_id, a.title])).toEqual([[owner.uid, 'Trust deposit received but not recorded']]);
    expect(alerts[0].body).toContain('$555.00');
    expect(alerts[0].body).toContain(pi);
  });
});

describe('a deposit that settles after the account stopped taking entries', () => {
  async function seedAccount(status: 'active' | 'inactive') {
    const client = await createPersonClient(firm.id, { email: 'late-client@example.test' });
    const accountId = randomUUID();
    await testPool.query(
      `insert into trust_accounts (id, law_firm_id, name, account_type, status, book_balance_cents, stripe_connected_account_id)
       values ($1, $2, 'Closed IOLTA', 'iolta', $3, 0, 'acct_trust_fixture')`,
      [accountId, firm.id, status],
    );
    return { accountId, clientId: client.id };
  }

  async function settle(pi: string, accountId: string, clientId: string) {
    return deliverSigned(paymentIntentSucceededEvent(`evt_settle_${randomUUID().slice(0, 8)}`, {
      paymentIntentId: pi, lawFirmId: firm.id, trustAccountId: accountId, clientId, amountCents: DEPOSIT_CENTS,
    }), WEBHOOK_SECRET).then(async (res) => {
      await drainEvents();
      return res;
    });
  }

  it('records money that arrived for an account deactivated while the ACH was in flight', async () => {
    const pi = newPaymentIntentId();
    const { accountId, clientId } = await seedAccount('inactive');

    const res = await quietly(() => settle(pi, accountId, clientId));

    expect(res.status).toBe(200);
    expect(await trustRows(accountId)).toEqual([
      { type: 'deposit', status: 'completed', cents: DEPOSIT_CENTS, pi },
    ]);
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS);
  });

  it('records money that arrived after trust accounting was switched off', async () => {
    const pi = newPaymentIntentId();
    const { accountId, clientId } = await seedAccount('active');
    await testPool.query(
      `update law_firms set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
         coalesce(settings->'features', '{}'::jsonb) || '{"trustAccounting": false}'::jsonb, true)
        where id = $1`,
      [firm.id],
    );

    const res = await quietly(() => settle(pi, accountId, clientId));

    expect(res.status).toBe(200);
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS);
  });

  it('keeps a hand-entered deposit out of a deactivated account, whatever its body claims', async () => {
    // The exemption is for money Stripe settled. `validate()` passes undeclared
    // body keys through, so it must not be reachable from a request body.
    const { accountId, clientId } = await seedAccount('inactive');

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/trust/transactions`).send({
      trustAccountId: accountId, clientId, clientName: 'Late Client', type: 'deposit',
      amountCents: 5_000, date: new Date().toISOString().slice(0, 10),
      stripePaymentIntentId: newPaymentIntentId(), settledStripeFunds: true,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_ACCOUNT_INACTIVE');
    expect(await bookBalance(accountId)).toBe(0);
  });

  it('alerts the firm, once, when a settled deposit still cannot be recorded', async () => {
    // A book closed past today is the one refusal left on this path. The money
    // is in the IOLTA either way, so a person has to hear about it.
    const pi = newPaymentIntentId();
    const { accountId, clientId } = await seedAccount('active');
    await testPool.query(`update trust_accounts set book_close_date = '2099-12-31' where id = $1`, [accountId]);

    const first = await quietly(() => settle(pi, accountId, clientId));
    const retry = await quietly(() => settle(pi, accountId, clientId));

    // Still a 500, so Stripe keeps retrying once the period is reopened.
    expect(first.status).toBe(500);
    expect(retry.status).toBe(500);
    expect(await trustRows(accountId)).toEqual([]);
    const alerts = await notificationsOfType('trust_deposit_posting_failed');
    expect(alerts).toEqual([{
      user_id: owner.uid,
      title: 'Trust deposit received but not recorded',
      body: 'A trust deposit of $555.00 has settled into the trust account but could not be recorded in the '
        + 'ledger: This date falls in a closed period (book closed through 2099-12-31). Fix the cause or record '
        + `it manually; Stripe keeps retrying it (payment ${pi}).`,
    }]);
  });
});
