/**
 * The guards that keep a signed-off accounting period signed off.
 *
 * Three separate mechanisms are asserted here, because each one alone leaves a
 * hole the other two do not cover:
 *
 *   1. `book_close_date` is a one-way ratchet. It may advance or be cleared
 *      outright, but it may not silently move BACKWARDS, which would reopen a
 *      period a firm already locked without leaving any trace that it happened.
 *   2. A reconciliation implicitly closes the period it certifies. Posting a
 *      backdated entry into an already-reconciled span changes the book balance
 *      a bar examiner reads off a signed reconciliation, so it is refused.
 *   3. Reconciliations themselves run forward in time. A future statement date
 *      or one at/before the previous reconciliation is a typo, and the first of
 *      those clears every entry in the account.
 *
 * The fourth case is the outstanding list: an entry a previous reconciliation
 * already cleared must not be flaggable as outstanding again, or its delta is
 * subtracted from the expected bank balance a second time and the recorded
 * discrepancy is wrong with nothing to show for it.
 *
 * All amounts are CENTS.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { createTrustAccount, postTrustTxn } from '../support/trust';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let accountId: string;

const F = () => `/api/lawfirms/${firm.id}/trust`;

const post = (type: string, amountCents: number, extra: Record<string, unknown> = {}) =>
  postTrustTxn(owner, firm.id, { trustAccountId: accountId, clientId: client.id, type, amountCents, ...extra });

async function reconcile(overrides: Record<string, unknown> = {}) {
  return owner.api.post(`${F()}/reconciliations`).send({
    trustAccountId: accountId,
    reconciliationDate: '2026-03-31',
    bankStatementBalanceCents: 0,
    ...overrides,
  });
}

const accountRow = async (id: string) => {
  const { rows } = await testPool.query('select * from trust_accounts where id = $1', [id]);
  return rows[0];
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Trust Client' });
  accountId = await createTrustAccount(owner, firm.id);
});

describe('the book-close date is a one-way ratchet', () => {
  it('refuses to move the close date backwards', async () => {
    const set = await owner.api.patch(`${F()}/accounts/${accountId}/book-close`)
      .send({ bookCloseDate: '2026-06-30' });
    expect(set.status).toBe(200);

    const back = await owner.api.patch(`${F()}/accounts/${accountId}/book-close`)
      .send({ bookCloseDate: '2026-05-31' });

    // Rolling the lock backwards reopens a period the firm already closed, and
    // the only record that it ever happened is the column that just changed.
    expect(back.status).toBe(400);
    expect(back.body.code).toBe('TRUST_PERIOD_LOCK_REGRESSION');
    expect((await accountRow(accountId)).book_close_date).toBe('2026-06-30');
  });

  it('still allows advancing the close date', async () => {
    await owner.api.patch(`${F()}/accounts/${accountId}/book-close`)
      .send({ bookCloseDate: '2026-05-31' });

    const forward = await owner.api.patch(`${F()}/accounts/${accountId}/book-close`)
      .send({ bookCloseDate: '2026-06-30' });

    expect(forward.status).toBe(200);
    expect((await accountRow(accountId)).book_close_date).toBe('2026-06-30');
  });
  // Clearing the lock outright is pinned in `trustAccountsOps.test.ts`, which
  // also proves an entry refused under the lock then lands.
});

describe('a reconciled period is closed to new postings', () => {
  it('refuses an entry dated on or before the latest reconciliation for that account', async () => {
    expect((await post('deposit', 100_000, { date: '2026-03-15' })).status).toBe(201);
    expect((await reconcile({ bankStatementBalanceCents: 100_000 })).status).toBe(201);

    const backdated = await post('deposit', 5_000, { date: '2026-03-20' });

    // The reconciliation certified a book balance of 100,000 as of 2026-03-31.
    // A March entry posted afterwards silently makes that signed figure wrong,
    // and nothing in the reconciliation record shows it changed.
    expect(backdated.status).toBe(400);
    expect(backdated.body.code).toBe('TRUST_PERIOD_RECONCILED');

    const { rows } = await testPool.query(
      `select count(*)::int n from trust_transactions
        where law_firm_id = $1 and amount_cents = 5000`, [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('accepts an entry dated after the latest reconciliation', async () => {
    expect((await post('deposit', 100_000, { date: '2026-03-15' })).status).toBe(201);
    expect((await reconcile({ bankStatementBalanceCents: 100_000 })).status).toBe(201);

    // Without this the guard would be a lock that closes the account for good
    // the first time anyone reconciles it.
    expect((await post('deposit', 5_000, { date: '2026-04-01' })).status).toBe(201);
  });

  it('lets a reopened reconciliation take the period lock away again', async () => {
    expect((await post('deposit', 100_000, { date: '2026-03-15' })).status).toBe(201);
    const rec = await reconcile({ bankStatementBalanceCents: 100_000 });
    expect(rec.status).toBe(201);

    expect((await post('deposit', 5_000, { date: '2026-03-20' })).status).toBe(400);

    const reopen = await owner.api.delete(`${F()}/reconciliations/${rec.body.reconciliation.id}`);
    expect(reopen.status).toBe(200);

    // Reopening is already the sanctioned way to unblock a void. It has to
    // unblock a correcting entry too, or a genuine March omission found in April
    // could never be recorded at its real date.
    expect((await post('deposit', 5_000, { date: '2026-03-20' })).status).toBe(201);
  });

  it('scopes the lock to the account that was reconciled', async () => {
    expect((await post('deposit', 100_000, { date: '2026-03-15' })).status).toBe(201);
    expect((await reconcile({ bankStatementBalanceCents: 100_000 })).status).toBe(201);

    const otherAccountId = await createTrustAccount(owner, firm.id, { name: 'Secondary IOLTA', last4: '2222' });
    const res = await owner.api.post(`${F()}/transactions`).send({
      trustAccountId: otherAccountId,
      type: 'deposit',
      amountCents: 5_000,
      clientId: client.id,
      clientName: 'Trust Client',
      date: '2026-03-20',
    });

    // Reconciling one bank account says nothing about another one. A firm-wide
    // lock would make the first reconciliation of the year freeze every account.
    expect(res.status).toBe(201);
  });
});

describe('reconciliations run forward in time', () => {
  it('refuses a statement date in the future', async () => {
    expect((await post('deposit', 100_000, { date: '2026-03-15' })).status).toBe(201);

    const future = await reconcile({
      reconciliationDate: '2099-12-31',
      bankStatementBalanceCents: 100_000,
    });

    // A mistyped year is the cheapest way to clear every entry in the account,
    // and clearing is what makes an entry un-voidable.
    expect(future.status).toBe(400);
    const { rows } = await testPool.query(
      'select count(*)::int n from trust_reconciliations where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses a statement date at or before the previous reconciliation', async () => {
    expect((await post('deposit', 100_000, { date: '2026-03-15' })).status).toBe(201);
    expect((await reconcile({ bankStatementBalanceCents: 100_000 })).status).toBe(201);

    const backwards = await reconcile({
      reconciliationDate: '2026-02-28',
      bankStatementBalanceCents: 100_000,
    });

    // Reconciliation history is a sequence of statements. One landing before the
    // last is either a duplicate or a typo, and either way the `is_reconciled`
    // it records is measured against a book balance from the wrong month.
    expect(backwards.status).toBe(400);
    expect(backwards.body.code).toBe('RECONCILIATION_OUT_OF_ORDER');
  });

  it('refuses a second reconciliation on the same date as the last', async () => {
    expect((await post('deposit', 100_000, { date: '2026-03-15' })).status).toBe(201);
    expect((await reconcile({ bankStatementBalanceCents: 100_000 })).status).toBe(201);

    const duplicate = await reconcile({ bankStatementBalanceCents: 100_000 });

    expect(duplicate.status).toBe(400);
    expect(duplicate.body.code).toBe('RECONCILIATION_OUT_OF_ORDER');
  });
});

describe('an already-cleared entry cannot be flagged outstanding again', () => {
  it('refuses an outstanding id that a previous reconciliation already cleared', async () => {
    const deposit = await post('deposit', 100_000, { date: '2026-03-15' });
    expect(deposit.status).toBe(201);
    const depositId = deposit.body.transaction.id as string;

    expect((await reconcile({ bankStatementBalanceCents: 100_000 })).status).toBe(201);
    expect((await post('deposit', 40_000, { date: '2026-04-10' })).status).toBe(201);

    const second = await owner.api.post(`${F()}/reconciliations`).send({
      trustAccountId: accountId,
      reconciliationDate: '2026-04-30',
      bankStatementBalanceCents: 140_000,
      outstandingTransactionIds: [depositId],
    });

    // The March deposit already cleared the bank. Counting it outstanding again
    // subtracts its 100,000 from the expected bank balance a second time, and
    // the clearing UPDATE skips it because `cleared_at` is already set, so the
    // wrong `discrepancy_cents` is recorded with nothing to show why.
    expect(second.status).toBe(400);
    expect(second.body.details.invalidIds).toEqual([depositId]);

    const { rows } = await testPool.query(
      'select count(*)::int n from trust_reconciliations where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].n).toBe(1);
  });
});
