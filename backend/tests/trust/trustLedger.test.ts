/**
 * The trust ledger, driven through the real routes.
 *
 * Trust accounting is the highest-consequence code in the product. It holds
 * client money a firm does not own, its rules are a bar-association obligation
 * rather than a product decision, and the schema enforces some of them with a
 * database trigger because the application alone was not considered enough.
 *
 * Four properties are asserted here, in the order they matter:
 *
 *   1. Balances are exact. Money is integer cents, and the running balance is
 *      recomputed inside the Postgres transaction under a row lock.
 *   2. An account cannot be overdrawn. A withdrawal beyond the client's balance
 *      is refused, not merely warned about.
 *   3. Completed entries are immutable. Corrections are reversing entries, and
 *      the `trust_txn_immutable` trigger is the backstop.
 *   4. A firm sees only its own ledger.
 *
 * These read amounts in CENTS throughout: the trust API takes `amountCents`
 * directly rather than dollars, unlike the invoice routes.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { createTrustAccount, postTrustTxn, trustClientBalanceCents } from '../support/trust';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let accountId: string;

const post = (type: string, amountCents: number, extra: Record<string, unknown> = {}) =>
  postTrustTxn(owner, firm.id, {
    trustAccountId: accountId, clientId: client.id, type, amountCents,
    description: `${type} of ${amountCents}`, ...extra,
  });

const clientBalanceCents = () => trustClientBalanceCents(owner, firm.id, client.id);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Trust Client' });
  accountId = await createTrustAccount(owner, firm.id, { name: 'Test IOLTA', last4: '1234' });
  await drainEvents();
});

describe('balances', () => {
  it('starts a client at zero', async () => {
    expect(await clientBalanceCents()).toBe(0);
  });

  it('adds a deposit and subtracts a withdrawal, exactly', async () => {
    expect((await post('deposit', 500_000)).status).toBe(201);
    expect(await clientBalanceCents()).toBe(500_000);

    expect((await post('withdrawal', 125_050)).status).toBe(201);
    // 5000.00 minus 1250.50. Asserted in cents so a float round-trip anywhere in
    // the path would show as a mismatch rather than a rounding that looks right.
    expect(await clientBalanceCents()).toBe(374_950);
  });

  it('keeps the account book balance in step with the ledger', async () => {
    await post('deposit', 300_000);
    await post('withdrawal', 100_000);
    await drainEvents();

    const { rows } = await testPool.query(
      'select book_balance_cents from trust_accounts where id = $1', [accountId],
    );
    // The account's own stored balance is updated inside the same Postgres
    // transaction as the entry, so a drift here means the two can disagree about
    // how much money the firm is holding.
    expect(Number(rows[0].book_balance_cents)).toBe(200_000);
  });

  it('sums many entries without drift', async () => {
    for (const cents of [10_001, 20_002, 30_003]) {
      // Each write is asserted, not just awaited. Without this the case failed
      // intermittently under full-suite load with a confusing "expected 60006,
      // got 40004": a deposit had been refused and the sum was simply short, and
      // the message pointed at arithmetic rather than at the failed write.
      // eslint-disable-next-line no-await-in-loop
      const res = await post('deposit', cents);
      expect(res.status).toBe(201);
    }
    expect(await clientBalanceCents()).toBe(60_006);
  });
});

describe('the overdraft guards', () => {
  /**
   * There are TWO guards, and a test that does not separate them proves less
   * than it looks. `trust.repository.ts` refuses a withdrawal that would take
   * the CLIENT's balance below zero, and separately one that would take the
   * ACCOUNT's book balance below zero.
   *
   * A pooled IOLTA account holds many clients' money, so the account can be
   * flush while one client has nothing. That case is the one that matters: it is
   * the shape of taking one client's money to pay another's bill.
   *
   * An earlier version of this block asserted only against an account holding
   * exactly one client's deposit, so removing the client guard entirely left
   * three of its four cases green: the account guard caught them instead.
   * `fundedByAnotherClient` exists to keep that from happening again.
   */
  async function fundedByAnotherClient(cents: number) {
    const benefactor = await createPersonClient(firm.id, { name: 'Benefactor' });
    const res = await owner.api.post(`/api/lawfirms/${firm.id}/trust/transactions`).send({
      trustAccountId: accountId,
      type: 'deposit',
      amountCents: cents,
      clientId: benefactor.id,
      clientName: 'Benefactor',
      date: '2026-03-15',
    });
    expect(res.status).toBe(201);
    return benefactor;
  }

  describe('the CLIENT guard, with the account holding other clients money', () => {
    it('refuses a withdrawal one cent past this client balance', async () => {
      await fundedByAnotherClient(1_000_000);
      await post('deposit', 100_000);

      const res = await post('withdrawal', 100_001);

      // The account has plenty. Only the client-level guard can refuse this, and
      // allowing it would spend another client's money.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await clientBalanceCents()).toBe(100_000);
    });

    it('refuses any withdrawal for a client who has deposited nothing', async () => {
      await fundedByAnotherClient(1_000_000);

      const res = await post('withdrawal', 1);

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await clientBalanceCents()).toBe(0);
    });

    it('allows a withdrawal of exactly this client balance', async () => {
      await fundedByAnotherClient(1_000_000);
      await post('deposit', 100_000);

      expect((await post('withdrawal', 100_000)).status).toBe(201);
      expect(await clientBalanceCents()).toBe(0);
    });
  });

  describe('the sole-depositor case', () => {
    it('refuses a withdrawal beyond the balance and leaves the book untouched', async () => {
      // Named for what it is. With one depositor the client balance and the
      // account book balance are the same number, so BOTH guards would refuse
      // this and the case cannot attribute the refusal to either.
      //
      // The account guard is a defensive backstop rather than a reachable rule:
      // in a consistent ledger the book balance is the sum of the client
      // balances, so any withdrawal that would overdraw the account has already
      // overdrawn its client. Removing the account guard turns nothing here red,
      // which is the correct result and is recorded so nobody reads that as a
      // coverage gap.
      await post('deposit', 100_000);

      const res = await post('withdrawal', 100_001);

      expect(res.status).toBeGreaterThanOrEqual(400);
      const { rows } = await testPool.query(
        'select book_balance_cents from trust_accounts where id = $1', [accountId],
      );
      expect(Number(rows[0].book_balance_cents)).toBe(100_000);
    });
  });
});

describe('immutability', () => {
  it('refuses an in-place edit of a completed entry at the database', async () => {
    await post('deposit', 250_000);
    const { rows } = await testPool.query(
      'select id from trust_transactions where law_firm_id = $1', [firm.id],
    );
    const txnId = rows[0].id;

    // The trigger is the backstop under the application, so it is asserted
    // directly. Attribution, amount and date are all frozen: a correction is a
    // reversing entry, never an edit.
    await expect(testPool.query(
      'update trust_transactions set amount_cents = 1 where id = $1', [txnId],
    )).rejects.toThrow(/append-only/);

    await expect(testPool.query(
      'update trust_transactions set txn_date = current_date + 1 where id = $1', [txnId],
    )).rejects.toThrow(/append-only/);
  });

  it('refuses deletion of a completed entry', async () => {
    await post('deposit', 250_000);
    const { rows } = await testPool.query(
      'select id from trust_transactions where law_firm_id = $1', [firm.id],
    );

    // Deleting would destroy the audit trail the ledger depends on.
    await expect(testPool.query(
      'delete from trust_transactions where id = $1', [rows[0].id],
    )).rejects.toThrow(/append-only/);
  });
});

describe('tenancy', () => {
  it('does not show one firm another firm trust ledger', async () => {
    await post('deposit', 777_700);
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    // The positive control: the owning firm reads the same ledger and sees the
    // deposit, so the absence below is about the caller, not an empty ledger.
    const own = await owner.api.get(`/api/lawfirms/${firm.id}/trust/clients/${client.id}/ledger`);
    expect(own.status).toBe(200);
    expect(own.body.totalItems).toBe(1);
    expect(own.body.transactions[0].amountCents).toBe(777_700);

    const res = await otherOwner.api.get(
      `/api/lawfirms/${otherFirm.id}/trust/clients/${client.id}/ledger`,
    );

    // Scoped by the caller's own firm, so the foreign client id matches nothing.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transactions: [], totalItems: 0 });
  });

  it('refuses a trust write against another firm account', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const otherClient = await createPersonClient(otherFirm.id, { name: 'Elsewhere' });

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/trust/transactions`)
      .send({
        trustAccountId: accountId, // this firm's account
        type: 'deposit',
        amountCents: 100_000,
        clientId: otherClient.id,
        clientName: 'Elsewhere',
        date: '2026-03-15',
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

/**
 * `GET /trust/transactions`, the firm-wide ledger list. Every filter is a
 * predicate the repository builds by hand, and the count beside it is a second
 * query built the same way. A filter that reached one query and not the other
 * pages a reader through a list whose total does not match what it shows.
 */
describe('the firm ledger list', () => {
  const list = (query: Record<string, string | number> = {}) =>
    owner.api.get(`/api/lawfirms/${firm.id}/trust/transactions`).query(query);
  const amounts = (res: any) => res.body.transactions.map((t: any) => t.amountCents).sort((a: number, b: number) => a - b);

  let other: ClientRecord;
  let secondAccount: string;
  beforeEach(async () => {
    other = await createPersonClient(firm.id, { name: 'Other Client' });
    secondAccount = await createTrustAccount(owner, firm.id, { name: 'Second IOLTA', last4: '9999' });
    expect((await post('deposit', 100_001, { date: '2026-03-01' })).status).toBe(201);
    expect((await post('withdrawal', 20_002, { date: '2026-03-10' })).status).toBe(201);
    const voided = await post('deposit', 3_003, { date: '2026-03-20' });
    expect((await owner.api.patch(`/api/lawfirms/${firm.id}/trust/transactions/${voided.body.transaction.id}/void`)
      .send({ voidReason: 'Entered twice' })).status).toBe(200);
    expect((await postTrustTxn(owner, firm.id, {
      trustAccountId: secondAccount, clientId: other.id, clientName: 'Other Client',
      type: 'deposit', amountCents: 40_004, date: '2026-04-01',
    })).status).toBe(201);
  });

  it('narrows by client, account, type, status and date, with a total that matches each', async () => {
    // A void writes a second, balance-neutral `void` row pointing at the
    // original (the reversal lineage), so the voided 30.03 lists twice.
    const cases: Array<[Record<string, string>, number[]]> = [
      [{ clientId: client.id }, [3_003, 3_003, 20_002, 100_001]],
      [{ trustAccountId: secondAccount }, [40_004]],
      [{ type: 'withdrawal' }, [20_002]],
      [{ status: 'void' }, [3_003, 3_003]],
      [{ status: 'completed', type: 'deposit' }, [40_004, 100_001]],
      [{ startDate: '2026-03-10', endDate: '2026-03-31' }, [3_003, 3_003, 20_002]],
    ];
    for (const [query, expected] of cases) {
      // eslint-disable-next-line no-await-in-loop -- one filter at a time, named on failure
      const res = await list(query);
      expect({ query, status: res.status, amounts: amounts(res), totalItems: res.body.totalItems })
        .toEqual({ query, status: 200, amounts: expected, totalItems: expected.length });
    }
  });

  it('pages newest first while the total still counts every match', async () => {
    // Newest first: 40.04 (Apr 1), the two 30.03 rows (Mar 20), 200.02, 1,000.01.
    const res = await list({ limit: 2, offset: 2 });

    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBe(5);
    expect(res.body.transactions.map((t: any) => t.amountCents)).toEqual([3_003, 20_002]);
  });

  it('lists nothing of this firm for another firm, even when asked for this firm\'s client', async () => {
    const rival = await createFirm();
    const rivalOwner = await ownerOf(rival.id);

    const res = await rivalOwner.api.get(`/api/lawfirms/${rival.id}/trust/transactions`)
      .query({ clientId: client.id });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transactions: [], totalItems: 0 });
    // The rows are there for the firm that owns them.
    expect((await list({ clientId: client.id })).body.totalItems).toBe(4);
  });
});
