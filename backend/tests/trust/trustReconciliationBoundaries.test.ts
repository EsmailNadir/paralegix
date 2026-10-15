/**
 * Reconciliation boundaries that `trustVoidAndReconciliation.test.ts` does not
 * already pin: the exact cutoff date, an outstanding WITHDRAWAL (not just a
 * deposit), a missing or duplicated outstanding-id "match", what a SECOND
 * reconciliation does to entries a FIRST one already cleared, and reopening a
 * reconciliation to unblock a void it was blocking.
 *
 * `createReconciliation` (trust.service.ts) and `createWithClearing` /
 * `validateAndSumOutstanding` / `reopen` (trust.repository.ts) are the source
 * under test throughout. All amounts are CENTS; bigint columns come back as
 * strings, so assertions coerce with Number().
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
import { gateMethod, type Gate } from '../support/gate';

const { trustRecRepo } = require('../../src/modules/trust/trust.repository');

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let accountId: string;

const F = () => `/api/lawfirms/${firm.id}/trust`;

async function post(type: string, amountCents: number, extra: Record<string, unknown> = {}) {
  const res = await postTrustTxn(owner, firm.id, {
    trustAccountId: accountId, clientId: client.id, type, amountCents,
    description: `${type} of ${amountCents}`, ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.transaction.id as string;
}

async function reconcile(overrides: Record<string, unknown>) {
  return owner.api.post(`${F()}/reconciliations`).send({
    trustAccountId: accountId,
    reconciliationDate: '2026-03-31',
    bankStatementBalanceCents: 0,
    ...overrides,
  });
}

const clearedStatusOf = async (id: string) => {
  const { rows } = await testPool.query(
    'select cleared_at, cleared_in_reconciliation_id from trust_transactions where id = $1', [id],
  );
  return { cleared: rows[0].cleared_at !== null, recId: rows[0].cleared_in_reconciliation_id as string | null };
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Trust Client' });
  accountId = await createTrustAccount(owner, firm.id);
});

describe('the statement cutoff is inclusive of the reconciliation date', () => {
  it('clears entries dated before or exactly ON the cutoff, and leaves the day after uncleared', async () => {
    const before = await post('deposit', 10_000, { date: '2026-03-01' });
    const onCutoff = await post('deposit', 20_000, { date: '2026-03-31' });
    const after = await post('deposit', 5_000, { date: '2026-04-01' });

    const res = await reconcile({ bankStatementBalanceCents: 30_000 });
    expect(res.status).toBe(201);

    // The book balance the reconciliation itself reports must match only the
    // before/on-cutoff money; the after-cutoff deposit hasn't happened "yet"
    // from the statement's point of view. That is the account's TOTAL ledger
    // balance though (bookBalanceCents on the account row), which already
    // includes the april deposit -- what actually distinguishes the boundary
    // is per-row `cleared_at`, asserted below.
    expect((await clearedStatusOf(before)).cleared).toBe(true);
    // The exact-equality case: a row dated ON the statement date is what a
    // real bank statement would show as of that date, so it must clear. A
    // strict `<` here (rather than `<=`) would leave every month-end entry
    // permanently uncleared no matter how many reconciliations ran.
    expect((await clearedStatusOf(onCutoff)).cleared).toBe(true);
    expect((await clearedStatusOf(after)).cleared).toBe(false);
  });
});

describe('an outstanding entry can be a withdrawal, not only a deposit', () => {
  it('leaves a flagged outstanding withdrawal uncleared while the deposit around it clears', async () => {
    const depositId = await post('deposit', 100_000);
    const withdrawalId = await post('withdrawal', 40_000);

    // Book balance is 60,000. The withdrawal hasn't hit the bank yet (outstanding
    // cheque), so the statement should show the pre-withdrawal 100,000.
    const res = await reconcile({
      bankStatementBalanceCents: 100_000,
      outstandingTransactionIds: [withdrawalId],
    });
    expect(res.status).toBe(201);
    expect(res.body.reconciliation.isReconciled).toBe(true);

    expect((await clearedStatusOf(depositId)).cleared).toBe(true);
    // If only deposits could be marked outstanding, this withdrawal would be
    // force-cleared alongside the deposit and the reconciliation would silently
    // certify a cheque the bank has not actually paid out yet.
    expect((await clearedStatusOf(withdrawalId)).cleared).toBe(false);
  });
});

describe('a missing match is rejected, not silently dropped', () => {
  it('refuses an outstandingTransactionId that does not belong to this account', async () => {
    await post('deposit', 100_000);
    const otherAccountId = await createTrustAccount(owner, firm.id, { name: 'Secondary IOLTA', last4: '2222' });
    const foreignTxnId = await post('deposit', 5_000, { trustAccountId: otherAccountId });

    const res = await reconcile({
      bankStatementBalanceCents: 100_000,
      outstandingTransactionIds: [foreignTxnId],
    });

    // Silently ignoring an id that doesn't resolve would understate the
    // outstanding total and let a discrepancy slip through undetected. The
    // service instead refuses the whole request and names the bad id.
    expect(res.status).toBe(400);
    expect(res.body.details.invalidIds).toEqual([foreignTxnId]);

    const { rows } = await testPool.query(
      'select count(*)::int n from trust_reconciliations where law_firm_id = $1', [firm.id],
    );
    // The refusal has to happen BEFORE the insert, or a bad request would still
    // leave a reconciliation record behind.
    expect(rows[0].n).toBe(0);
  });

  it('refuses a random, non-existent uuid the same way', async () => {
    await post('deposit', 100_000);

    const res = await reconcile({
      bankStatementBalanceCents: 100_000,
      outstandingTransactionIds: ['00000000-0000-0000-0000-000000000000'],
    });

    expect(res.status).toBe(400);
  });
});

describe('a duplicated match counts once, not twice', () => {
  it('does not double-subtract a withdrawal listed twice as outstanding', async () => {
    await post('deposit', 100_000);
    const withdrawalId = await post('withdrawal', 20_000);
    // Book balance is 80,000. The withdrawal (20,000 outflow) is outstanding, so
    // the statement should show the pre-withdrawal 100,000 -- counted ONCE.
    // A double count would expect the statement to show 120,000 instead.
    const res = await reconcile({
      bankStatementBalanceCents: 100_000,
      outstandingTransactionIds: [withdrawalId, withdrawalId],
    });

    expect(res.status).toBe(201);
    expect(res.body.reconciliation.isReconciled).toBe(true);
    expect(Number(res.body.reconciliation.discrepancyCents)).toBe(0);
  });
});

describe('a later reconciliation does not touch what an earlier one already cleared', () => {
  it('keeps the first reconciliation as the clearing owner of its own entries', async () => {
    const marchDeposit = await post('deposit', 100_000, { date: '2026-03-15' });
    const marchRec = await reconcile({ bankStatementBalanceCents: 100_000 });
    expect(marchRec.status).toBe(201);
    const marchRecId = marchRec.body.reconciliation.id as string;
    expect((await clearedStatusOf(marchDeposit)).recId).toBe(marchRecId);

    const aprilDeposit = await post('deposit', 25_000, { date: '2026-04-10' });
    const aprilRec = await owner.api.post(`${F()}/reconciliations`).send({
      trustAccountId: accountId,
      reconciliationDate: '2026-04-30',
      bankStatementBalanceCents: 125_000,
    });
    expect(aprilRec.status).toBe(201);
    const aprilRecId = aprilRec.body.reconciliation.id as string;

    // The march entry keeps pointing at the reconciliation that actually
    // cleared it. A second reconciliation re-stamping every eligible row with
    // ITS OWN id would erase the record of which statement first certified
    // which money -- exactly the audit trail a bar examiner reads.
    expect((await clearedStatusOf(marchDeposit)).recId).toBe(marchRecId);
    expect((await clearedStatusOf(aprilDeposit)).recId).toBe(aprilRecId);
  });
});

describe('reopening a reconciliation is the sanctioned way to unblock a void', () => {
  it('un-clears the transactions it stamped and lets a previously-refused void proceed', async () => {
    const depositId = await post('deposit', 100_000);
    const rec = await reconcile({ bankStatementBalanceCents: 100_000 });
    expect(rec.status).toBe(201);
    const reconciliationId = rec.body.reconciliation.id as string;

    const blockedVoid = await owner.api
      .patch(`${F()}/transactions/${depositId}/void`)
      .send({ voidReason: 'test' });
    // A cleared entry is part of a signed-off reconciliation, so voiding it
    // would change a figure the firm already certified against a bank statement.
    expect(blockedVoid.status).toBe(409);
    expect(blockedVoid.body.code).toBe('TRANSACTION_RECONCILED');

    const reopen = await owner.api.delete(`${F()}/reconciliations/${reconciliationId}`);
    expect(reopen.status).toBe(200);
    expect(reopen.body.unclearedCount).toBe(1);
    expect((await clearedStatusOf(depositId)).cleared).toBe(false);

    const nowVoid = await owner.api
      .patch(`${F()}/transactions/${depositId}/void`)
      .send({ voidReason: 'reopened first' });
    expect(nowVoid.status).toBe(200);
  });

  it('does not let a different firm reopen this reconciliation', async () => {
    const depositId = await post('deposit', 100_000);
    const rec = await reconcile({ bankStatementBalanceCents: 100_000 });
    const reconciliationId = rec.body.reconciliation.id as string;

    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const res = await otherOwner.api.delete(`/api/lawfirms/${otherFirm.id}/trust/reconciliations/${reconciliationId}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await clearedStatusOf(depositId)).cleared).toBe(true);
  });
});

describe('a posting that lands while a reconciliation is being prepared', () => {
  let gate: Gate | null = null;
  afterEach(() => { gate?.restore(); gate = null; });

  it('refuses the stale reconciliation and clears nothing, rather than clearing an entry it never saw', async () => {
    // The service reads the book balance, works out what clears, then takes the
    // account lock to write. A deposit committed in that gap is in the book but
    // not in the snapshot; clearing against the snapshot would stamp that
    // deposit as cleared, after which it could never be flagged outstanding or
    // voided. The repository re-reads the balance under the lock to catch it.
    const seen = await post('deposit', 30_000, { date: '2026-03-01' });
    gate = gateMethod(trustRecRepo, 'createWithClearing');

    async function fire() { return reconcile({ bankStatementBalanceCents: 30_000 }); }
    const pending = fire();
    await gate.arrived(1);
    const late = await post('deposit', 1_234, { date: '2026-03-02' });
    gate.open();
    const res = await pending;

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RECONCILIATION_STALE');
    const { rows } = await testPool.query(
      'select count(*)::int n from trust_reconciliations where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].n).toBe(0);
    expect(await clearedStatusOf(seen)).toEqual({ cleared: false, recId: null });
    expect(await clearedStatusOf(late)).toEqual({ cleared: false, recId: null });

    // Recomputed against the current book, the same statement now reconciles.
    gate.restore(); gate = null;
    const retried = await reconcile({ bankStatementBalanceCents: 31_234 });
    expect(retried.status).toBe(201);
    expect((await clearedStatusOf(late)).cleared).toBe(true);
  });
});
