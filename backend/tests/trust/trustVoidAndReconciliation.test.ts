/**
 * Voiding a trust entry, closing the books, and the three-way reconciliation.
 *
 * `trustLedger.test.ts` covers balances, the overdraft guards and immutability.
 * This file covers what happens AFTER an entry is posted, which is where trust
 * accounting is actually audited.
 *
 * Voiding is the only correction mechanism the ledger has. `trust_transactions`
 * is append-only, enforced by the `trust_txn_immutable` database trigger, so a
 * mistake cannot be edited or deleted away. It has to be reversed. A void that
 * does too little leaves money on the books that is not in the bank; a void that
 * does too much removes history a bar audit requires. Neither shows up on a
 * screen.
 *
 * All amounts are CENTS, and bigint columns come back as STRINGS, so the
 * assertions coerce with Number() rather than comparing to a numeric literal.
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
import { createTrustDepositFromStripe } from '../../src/modules/trust/trust.service';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let accountId: string;

const F = () => `/api/lawfirms/${firm.id}/trust`;

const post = (type: string, amountCents: number, extra: Record<string, unknown> = {}) =>
  postTrustTxn(owner, firm.id, {
    trustAccountId: accountId, clientId: client.id, type, amountCents,
    description: `${type} of ${amountCents}`, ...extra,
  });

const idOf = (res: any) => res.body.transaction.id as string;

const voidTxn = (id: string, voidReason = 'Recorded in error') =>
  owner.api.patch(`${F()}/transactions/${id}/void`).send({ voidReason });

const clientBalanceCents = () => trustClientBalanceCents(owner, firm.id, client.id);

const bookBalanceOf = async (id: string) => {
  const { rows } = await testPool.query(
    'select book_balance_cents from trust_accounts where id = $1', [id],
  );
  return Number(rows[0].book_balance_cents);
};

const txnRow = async (id: string) => {
  const { rows } = await testPool.query(
    `select status, voided_by, void_reason, voided_at
       from trust_transactions where id = $1`, [id],
  );
  return rows[0];
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Trust Client' });
  accountId = await createTrustAccount(owner, firm.id);
  await drainEvents();
});

describe('voiding preserves the record', () => {
  it('keeps the row, marks it void with its amount intact, and records who, when and why', async () => {
    const id = idOf(await post('deposit', 100_000));

    const res = await voidTxn(id, 'Client cheque returned unpaid');
    expect(res.status).toBe(200);

    // The append-only rule, stated as an assertion. A void implemented as a
    // delete removes the evidence that the money was ever recorded, which is
    // exactly what a bar audit reconstructs.
    const { rows } = await testPool.query(
      'select amount_cents from trust_transactions where id = $1', [id],
    );
    expect(rows).toHaveLength(1);
    // The amount stays exactly as posted. Zeroing it instead would erase what
    // was originally recorded while leaving a row that looks legitimate.
    expect(Number(rows[0].amount_cents)).toBe(100_000);

    // The audit trail is the point of the void. Without the reason, the ledger
    // shows money appearing and vanishing with no explanation.
    const row = await txnRow(id);
    expect(row.status).toBe('void');
    expect(row.voided_by).toBe(owner.uid);
    expect(row.void_reason).toBe('Client cheque returned unpaid');
    expect(row.voided_at).not.toBeNull();
  });

  it('writes a reversal-lineage entry pointing at the original, itself void so it cannot double-count', async () => {
    const id = idOf(await post('deposit', 100_000));

    await voidTxn(id);

    const { rows } = await testPool.query(
      `select status, amount_cents, description from trust_transactions
        where reverses_transaction_id = $1`, [id],
    );
    // An INSERT, never an edit, so the immutability trigger stays satisfied. It
    // is the row that shows a reader WHAT was reversed and by how much.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount_cents)).toBe(100_000);
    expect(rows[0].description).toContain(id);
    // Subtle and load-bearing. Every balance query sums `status <> 'void'`. A
    // lineage row posted as 'completed' would subtract the amount a SECOND time,
    // on top of the book-balance update the void already made.
    expect(rows[0].status).toBe('void');
  });
});

describe('voiding moves the money back', () => {
  it('removes a voided deposit from the client balance', async () => {
    const id = idOf(await post('deposit', 100_000));
    expect(await clientBalanceCents()).toBe(100_000);

    await voidTxn(id);

    expect(await clientBalanceCents()).toBe(0);
  });

  it('restores a voided withdrawal to the client balance', async () => {
    await post('deposit', 100_000);
    const withdrawalId = idOf(await post('withdrawal', 40_000));
    expect(await clientBalanceCents()).toBe(60_000);

    await voidTxn(withdrawalId);

    // The opposite direction. A void that always subtracted would pass the
    // deposit case above and quietly destroy sixty thousand cents here.
    expect(await clientBalanceCents()).toBe(100_000);
  });

  it('moves the account book balance too, not just the ledger', async () => {
    const id = idOf(await post('deposit', 100_000));
    expect(await bookBalanceOf(accountId)).toBe(100_000);

    await voidTxn(id);

    // The book balance is the figure reconciled against the bank statement. If
    // it and the client ledger disagree, the three-way reconciliation fails and
    // nobody can tell which of the two is wrong.
    expect(await bookBalanceOf(accountId)).toBe(0);
  });

  it('leaves other entries for the same client untouched', async () => {
    const first = idOf(await post('deposit', 100_000));
    await post('deposit', 25_000);

    await voidTxn(first);

    // Voiding by client or by account rather than by id is a plausible
    // implementation slip, and it would wipe a client's whole ledger.
    expect(await clientBalanceCents()).toBe(25_000);
  });
});

describe('what voiding refuses to do', () => {
  it('refuses to void the same entry twice, and does not move the balance on that attempt', async () => {
    const id = idOf(await post('deposit', 100_000));
    await post('deposit', 50_000);
    await voidTxn(id);
    expect(await clientBalanceCents()).toBe(50_000);

    const res = await voidTxn(id);

    // Two voids of one deposit would subtract the amount twice and drive the
    // account below what the bank actually holds.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ALREADY_VOIDED');
    // Asserting the MONEY, not only the status. A route that returned 400 after
    // already decrementing would satisfy the code check above.
    expect(await clientBalanceCents()).toBe(50_000);
  });

  it('refuses to void an electronically funded deposit by hand, leaving the balance untouched', async () => {
    // `source = 'stripe'` means Stripe moved the money. A manual void posts a
    // reversing entry and moves nothing at Stripe, so the IOLTA keeps the funds
    // while the ledger says they left. The refund path returns the money AND
    // reverses the ledger through `charge.refunded`.
    // Posted the way the payment_intent.succeeded webhook posts it: the manual
    // route refuses a `stripe` source, because a hand-entered row has no charge.
    const { transactionId: id } = await createTrustDepositFromStripe({
      lawFirmId: firm.id, trustAccountId: accountId, clientId: client.id, amountCents: 100_000,
      date: new Date().toISOString().slice(0, 10), stripePaymentIntentId: 'pi_void_guard_fixture',
    });

    const res = await voidTxn(id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRUST_ENTRY_STRIPE_FUNDED');
    expect(res.body.error).toMatch(/refund it in stripe/i);
    expect(await clientBalanceCents()).toBe(100_000);
  });

  it('still voids a deposit the firm recorded by hand', async () => {
    // The guard is about how the money moved, not about deposits in general: a
    // cheque entered in error is exactly what voiding is for.
    const id = idOf(await post('deposit', 100_000, { source: 'check' }));

    expect((await voidTxn(id)).status).toBe(200);
  });

  it('refuses to void a deposit whose funds were already disbursed, leaving the client balance intact', async () => {
    const depositId = idOf(await post('deposit', 100_000));
    await post('withdrawal', 90_000);

    const res = await voidTxn(depositId);

    // The commingling guard, and the most important refusal here. Reversing this
    // deposit would take the client to minus ninety thousand cents, which in a
    // pooled IOLTA account means covering one client's shortfall with other
    // clients' money. That is the violation the account-level balance check
    // cannot see, because the account as a whole still holds enough.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_TRUST_BALANCE');
    expect(await clientBalanceCents()).toBe(10_000);
    expect((await txnRow(depositId)).status).toBe('completed');
  });

  it('does not let another firm void this firm entry', async () => {
    const id = idOf(await post('deposit', 100_000));
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .patch(`/api/lawfirms/${otherFirm.id}/trust/transactions/${id}/void`)
      .send({ voidReason: 'not mine' });

    expect(res.status).toBe(404);
    expect((await txnRow(id)).status).toBe('completed');
  });

  it('answers not-found for a transaction id that does not exist', async () => {
    const res = await voidTxn('00000000-0000-0000-0000-000000000000');

    expect(res.status).toBe(404);
  });

  it('refuses a malformed transaction id without a database error', async () => {
    const res = await owner.api
      .patch(`${F()}/transactions/not-a-uuid/void`)
      .send({ voidReason: 'x' });

    // A non-uuid can never name a row, so it is answered as not-found rather
    // than reaching Postgres as a cast error.
    expect(res.status).toBe(404);
  });
});

describe('a transfer is voided as one unit', () => {
  let destinationId: string;

  beforeEach(async () => {
    destinationId = await createTrustAccount(owner, firm.id, { name: 'Secondary IOLTA', last4: '2222' });
    await drainEvents();
  });

  it('posts two linked legs when created', async () => {
    await post('deposit', 100_000);

    const transfer = await post('transfer', 20_000, {
      date: '2026-03-16', transferToAccountId: destinationId,
    });
    expect(transfer.status).toBe(201);

    const { rows } = await testPool.query(
      `select trust_account_id, type from trust_transactions
        where transfer_group_id is not null and status = 'completed'`,
    );
    // Double entry: a debit leg on the source and a credit leg on the
    // destination, sharing one `transfer_group_id`. One leg alone would create
    // money in one account or destroy it in the other.
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.trust_account_id).sort())
      .toEqual([accountId, destinationId].sort());
  });

  it('voids BOTH legs when either is voided', async () => {
    await post('deposit', 100_000);
    const transferId = idOf(await post('transfer', 20_000, {
      date: '2026-03-16', transferToAccountId: destinationId,
    }));

    await voidTxn(transferId, 'Transfer made in error');

    const { rows } = await testPool.query(
      `select count(*)::int n from trust_transactions
        where transfer_group_id is not null and status = 'completed'`,
    );
    // Voiding one leg only would leave the destination holding twenty thousand
    // cents that no source account gave up, and the two accounts would never
    // reconcile again.
    expect(rows[0].n).toBe(0);
  });

  it('restores both account book balances', async () => {
    await post('deposit', 100_000);
    const transferId = idOf(await post('transfer', 20_000, {
      date: '2026-03-16', transferToAccountId: destinationId,
    }));
    expect(await bookBalanceOf(accountId)).toBe(80_000);
    expect(await bookBalanceOf(destinationId)).toBe(20_000);

    await voidTxn(transferId);

    expect(await bookBalanceOf(accountId)).toBe(100_000);
    expect(await bookBalanceOf(destinationId)).toBe(0);
  });

  it('leaves the client total unchanged across the transfer and its void', async () => {
    await post('deposit', 100_000);
    const transferId = idOf(await post('transfer', 20_000, {
      date: '2026-03-16', transferToAccountId: destinationId,
    }));

    // A transfer moves money between the firm's own accounts. The client still
    // holds the same total before, during and after.
    expect(await clientBalanceCents()).toBe(100_000);
    await voidTxn(transferId);
    expect(await clientBalanceCents()).toBe(100_000);
  });
});

describe('closing the books', () => {
  beforeEach(async () => {
    await post('deposit', 100_000);
    const res = await owner.api
      .patch(`${F()}/accounts/${accountId}/book-close`)
      .send({ bookCloseDate: '2026-03-31' });
    expect(res.status).toBe(200);
  });

  it('refuses a new entry dated inside the closed period', async () => {
    const res = await post('deposit', 5_000, { date: '2026-03-20' });

    // A closed period has been reported. Back-dating money into it changes a
    // figure the firm already certified.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_PERIOD_LOCKED');
  });

  it('writes no row for that refused entry', async () => {
    await post('deposit', 5_000, { date: '2026-03-20' });

    expect(await clientBalanceCents()).toBe(100_000);
  });

  it('accepts an entry dated AFTER the close date', async () => {
    const res = await post('deposit', 5_000, { date: '2026-04-01' });

    // The positive half. A guard that refused everything would satisfy the case
    // above and freeze the account permanently.
    expect(res.status).toBe(201);
    expect(await clientBalanceCents()).toBe(105_000);
  });

  it('refuses to void an entry dated inside the closed period', async () => {
    // Posted before the close, so it sits inside the now-closed period.
    const { rows } = await testPool.query(
      `select id from trust_transactions
        where law_firm_id = $1 and status = 'completed' limit 1`, [firm.id],
    );

    const res = await voidTxn(rows[0].id);

    // Voiding alters balances as of the ORIGINAL entry's date, so it reaches
    // back into the closed period exactly as a back-dated posting would.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_PERIOD_LOCKED');
  });
});

describe('the three-way reconciliation', () => {
  beforeEach(async () => {
    await post('deposit', 100_000);
  });

  it('agrees when the bank statement matches the books', async () => {
    const res = await owner.api.post(`${F()}/reconciliations`).send({
      trustAccountId: accountId,
      reconciliationDate: '2026-03-31',
      bankStatementBalanceCents: 100_000,
    });

    expect(res.status).toBe(201);
    expect(res.body.reconciliation.isReconciled).toBe(true);
    expect(Number(res.body.reconciliation.discrepancyCents)).toBe(0);
  });

  it('reports the three figures it compared', async () => {
    const res = await owner.api.post(`${F()}/reconciliations`).send({
      trustAccountId: accountId,
      reconciliationDate: '2026-03-31',
      bankStatementBalanceCents: 100_000,
    });

    // The three-way part: bank statement, account book balance, and the sum of
    // every client's ledger. All three must agree, and the record has to show
    // all three so a later reader can see WHY it agreed.
    const r = res.body.reconciliation;
    expect(Number(r.bankStatementBalanceCents)).toBe(100_000);
    expect(Number(r.bookBalanceCents)).toBe(100_000);
    expect(Number(r.clientLedgerTotalCents)).toBe(100_000);
  });

  it('RECORDS a discrepancy rather than refusing it', async () => {
    const res = await owner.api.post(`${F()}/reconciliations`).send({
      trustAccountId: accountId,
      reconciliationDate: '2026-03-31',
      bankStatementBalanceCents: 99_999,
    });

    // Reconciliation records reality. Refusing to save a mismatch would leave
    // the firm no way to document a known break, which is the thing a regulator
    // most wants to see written down.
    expect(res.status).toBe(201);
    expect(res.body.reconciliation.isReconciled).toBe(false);
    expect(Number(res.body.reconciliation.discrepancyCents)).toBe(-1);
  });

  it('serves a snapshot of what would be reconciled', async () => {
    const res = await owner.api.get(
      `${F()}/reconciliation-snapshot?trustAccountId=${accountId}&reconciliationDate=2026-03-31`,
    );

    expect(res.status).toBe(200);
    expect(Number(res.body.bookBalanceCents)).toBe(100_000);
    expect(Number(res.body.clientLedgerTotalCents)).toBe(100_000);
  });

  it('breaks the snapshot down per client', async () => {
    const second = await createPersonClient(firm.id, { name: 'Second Client' });
    await owner.api.post(`${F()}/transactions`).send({
      trustAccountId: accountId, type: 'deposit', amountCents: 30_000,
      clientId: second.id, clientName: 'Second Client', date: '2026-03-15',
    });

    const res = await owner.api.get(
      `${F()}/reconciliation-snapshot?trustAccountId=${accountId}&reconciliationDate=2026-03-31`,
    );

    // The per-client breakdown is what proves no client is overdrawn inside a
    // pooled account whose total looks healthy.
    const byClient = res.body.clientBreakdown as any[];
    expect(byClient).toHaveLength(2);
    expect(Number(byClient.find((c) => c.clientId === client.id).balanceCents)).toBe(100_000);
    expect(Number(byClient.find((c) => c.clientId === second.id).balanceCents)).toBe(30_000);
  });

  it('excludes voided entries from the snapshot', async () => {
    const extra = idOf(await post('deposit', 30_000));
    await voidTxn(extra);

    const res = await owner.api.get(
      `${F()}/reconciliation-snapshot?trustAccountId=${accountId}&reconciliationDate=2026-03-31`,
    );

    // A voided entry that still counted would reconcile the books against money
    // the firm already established was never there.
    expect(Number(res.body.bookBalanceCents)).toBe(100_000);
    expect(Number(res.body.clientLedgerTotalCents)).toBe(100_000);
  });

  it('does not show another firm reconciliation', async () => {
    await owner.api.post(`${F()}/reconciliations`).send({
      trustAccountId: accountId,
      reconciliationDate: '2026-03-31',
      bankStatementBalanceCents: 100_000,
    });
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    // The positive control: the owning firm sees its reconciliation.
    const own = await owner.api.get(`${F()}/reconciliations`);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).toContain(accountId);

    const res = await otherOwner.api.get(`/api/lawfirms/${otherFirm.id}/trust/reconciliations`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(accountId);
  });
});
