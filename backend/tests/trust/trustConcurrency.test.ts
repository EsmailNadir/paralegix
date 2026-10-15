/**
 * Trust writes that race each other.
 *
 * The overdraw races hold both requests at the entry of the repository write
 * (`trustTxnRepo.createWithBalance` / `createTransferWithBalance`) with a gate,
 * so the test proves the two were in flight together before either took the
 * row lock. `Promise.all` alone cannot: the first request may commit before the
 * second reaches the balance read, and the case would pass against code with
 * no locking at all.
 */
import {
  testPool,
  createFirm,
  ownerOf,
  createPersonClient,
  createTrustDeposit,
  drainEvents,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';
import { createTrustAccount } from '../support/trust';

// `require`: the service calls these methods on the shared singleton, so the
// gate has to replace them on that same object.
const { trustTxnRepo } = require('../../src/modules/trust/trust.repository');

const TRUST = (firmId: string) => `/api/lawfirms/${firmId}/trust`;
const TRANSACTIONS = (firmId: string) => `${TRUST(firmId)}/transactions`;

describe('Trust Ledger Concurrency', () => {
  let firm: Firm;
  let owner: any;
  let clientA: any;
  let otherFirm: Firm;
  let otherFirmSnapshot: any[];
  let gate: Gate | null = null;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    clientA = await createPersonClient(firm.id, { name: 'Client A' });

    otherFirm = await createFirm();
    const otherClient = await createPersonClient(otherFirm.id, { name: 'Other Client' });
    await createTrustDeposit(otherFirm.id, otherClient.id, { amountCents: 9999 });

    const { rows } = await testPool.query('SELECT * FROM trust_accounts WHERE law_firm_id = $1', [otherFirm.id]);
    otherFirmSnapshot = rows;

    await drainEvents();
  });

  afterEach(async () => {
    // Unconditional, so a failed assertion cannot leave a request paused.
    gate?.restore();
    gate = null;
    // Assert isolation: another firm's trust accounts are completely unchanged
    const { rows } = await testPool.query('SELECT * FROM trust_accounts WHERE law_firm_id = $1', [otherFirm.id]);
    expect(rows).toEqual(otherFirmSnapshot);
  });

  it('T01: Two withdrawals each individually affordable but jointly unaffordable', async () => {
    const { accountId } = await createTrustDeposit(firm.id, clientA.id, { amountCents: 10000 });
    gate = gateMethod(trustTxnRepo, 'createWithBalance');

    // `.then()` starts each request now; supertest only sends on first await.
    const req1 = owner.api.post(TRANSACTIONS(firm.id)).send({
      trustAccountId: accountId,
      type: 'withdrawal',
      amountCents: 6000,
      clientId: clientA.id,
      clientName: 'Client A',
      date: '2026-03-15',
    }).then((r: any) => r);

    const req2 = owner.api.post(TRANSACTIONS(firm.id)).send({
      trustAccountId: accountId,
      type: 'withdrawal',
      amountCents: 6000,
      clientId: clientA.id,
      clientName: 'Client A',
      date: '2026-03-15',
    }).then((r: any) => r);

    // The evidence: both withdrawals are inside the repository write together,
    // past every check that runs before the row lock.
    await gate.arrived(2);
    gate.open();
    const results = await Promise.all([req1, req2]);
    const statuses = results.map(r => r.status).sort();

    // Exactly one succeeds; the other is refused by the client overdraft guard.
    expect(statuses).toEqual([201, 400]);
    expect(results.find(r => r.status === 400)!.body.code).toBe('INSUFFICIENT_TRUST_BALANCE');

    const { rows } = await testPool.query(
      'SELECT book_balance_cents FROM trust_accounts WHERE id = $1', [accountId]
    );
    expect(Number(rows[0].book_balance_cents)).toBe(4000);

    const { rows: txns } = await testPool.query(
      'SELECT type, amount_cents FROM trust_transactions WHERE trust_account_id = $1', [accountId]
    );
    // 1 deposit + 1 successful withdrawal
    expect(txns).toHaveLength(2);
  });

  it('T03: Withdrawal races with void/reversal', async () => {
    const { accountId, transactionId } = await createTrustDeposit(firm.id, clientA.id, { amountCents: 10000 });

    const reqWithdraw = owner.api.post(TRANSACTIONS(firm.id)).send({
      trustAccountId: accountId,
      type: 'withdrawal',
      amountCents: 6000,
      clientId: clientA.id,
      clientName: 'Client A',
      date: '2026-03-15',
    });

    const reqVoid = owner.api.patch(`${TRANSACTIONS(firm.id)}/${transactionId}/void`).send({
      voidReason: 'reversal'
    });

    const [resWithdraw, resVoid] = await Promise.all([reqWithdraw, reqVoid]);

    const withdrawSucceeded = resWithdraw.status === 201;
    const voidSucceeded = resVoid.status === 200;

    // At most one succeeds
    expect(withdrawSucceeded && voidSucceeded).toBe(false);

    const { rows } = await testPool.query(
      'SELECT book_balance_cents FROM trust_accounts WHERE id = $1', [accountId]
    );
    const balance = Number(rows[0].book_balance_cents);

    if (voidSucceeded) {
      expect(withdrawSucceeded).toBe(false);
      expect(balance).toBe(0);
    } else {
      expect(withdrawSucceeded).toBe(true);
      expect(balance).toBe(4000);
    }

    expect(balance).toBeGreaterThanOrEqual(0);
  });

  // Not the plan's B06.3 T04 ("duplicate online deposit through webhook and
  // reconciliation") -- that scenario is covered by
  // trustDuplicateDepositPaths.test.ts. This one just pins that the ordinary
  // manual-entry route has no built-in same-request dedupe: two identical
  // POSTs both succeed and both post, because nothing here claims they
  // describe the same real-world deposit (no client-supplied idempotency key,
  // no Stripe correlation on this route).
  it('two identical manual deposit requests both post (no same-request dedupe on this route)', async () => {
    const { accountId } = await createTrustDeposit(firm.id, clientA.id, { amountCents: 10000 });

    const payload = {
      trustAccountId: accountId,
      type: 'deposit',
      amountCents: 5000,
      clientId: clientA.id,
      clientName: 'Client A',
      date: '2026-03-15',
    };

    const [r1, r2] = await Promise.all([
      owner.api.post(TRANSACTIONS(firm.id)).send(payload),
      owner.api.post(TRANSACTIONS(firm.id)).send(payload)
    ]);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const { rows } = await testPool.query(
      'SELECT book_balance_cents FROM trust_accounts WHERE id = $1', [accountId]
    );
    expect(Number(rows[0].book_balance_cents)).toBe(20000);
  });

  // Not the plan's B06.3 T05 ("fee attempt times out after provider may have
  // charged") -- that scenario is covered by
  // trustDepositFeeRetryIdempotency.test.ts. This one is a different
  // concurrency case entirely: two transfer requests racing for the same
  // source account's balance.
  it('transfer races: two transfers from the same account only let one drain the balance', async () => {
    const { accountId: acctA } = await createTrustDeposit(firm.id, clientA.id, { amountCents: 10000 });
    const acctB = await createTrustAccount(owner, firm.id, { name: 'Account B', last4: '2222' });

    const payload = {
      trustAccountId: acctA,
      transferToAccountId: acctB,
      type: 'transfer',
      amountCents: 6000,
      clientId: clientA.id,
      clientName: 'Client A',
      date: '2026-03-15',
    };

    gate = gateMethod(trustTxnRepo, 'createTransferWithBalance');
    const first = owner.api.post(TRANSACTIONS(firm.id)).send(payload).then((r: any) => r);
    const second = owner.api.post(TRANSACTIONS(firm.id)).send(payload).then((r: any) => r);
    await gate.arrived(2);
    gate.open();
    const [r1, r2] = await Promise.all([first, second]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 400]);

    const { rows } = await testPool.query('SELECT id, book_balance_cents FROM trust_accounts WHERE id IN ($1, $2) ORDER BY id', [acctA, acctB]);

    const aRow = rows.find(r => r.id === acctA);
    const bRow = rows.find(r => r.id === acctB);

    expect(Number(aRow.book_balance_cents)).toBe(4000);
    expect(Number(bRow.book_balance_cents)).toBe(6000);
  });

  it('T06: Transfer or multi-entry operation fails midway', async () => {
    const { accountId: acctA } = await createTrustDeposit(firm.id, clientA.id, { amountCents: 10000 });
    const acctB = await createTrustAccount(owner, firm.id, { name: 'Account B', last4: '2222' });

    // Successful transfer
    const r1 = await owner.api.post(TRANSACTIONS(firm.id)).send({
      trustAccountId: acctA,
      transferToAccountId: acctB,
      type: 'transfer',
      amountCents: 4000,
      clientId: clientA.id,
      clientName: 'Client A',
      date: '2026-03-15',
    });
    expect(r1.status).toBe(201);

    // Failing transfer
    const r2 = await owner.api.post(TRANSACTIONS(firm.id)).send({
      trustAccountId: acctA,
      transferToAccountId: acctB,
      type: 'transfer',
      amountCents: 9000,
      clientId: clientA.id,
      clientName: 'Client A',
      date: '2026-03-15',
    });
    expect(r2.status).toBe(400);

    // A transfer is double entry: the source account gets a `transfer` leg and
    // the destination gets a `deposit` leg, and the two are tied together by
    // `transfer_group_id`. Asking for `type = 'transfer'` on the destination
    // finds nothing even on a perfectly recorded transfer, so the pairing is
    // what has to be asserted.
    const { rows: legs } = await testPool.query(
      `SELECT trust_account_id, type, amount_cents, transfer_group_id
         FROM trust_transactions
        WHERE trust_account_id IN ($1, $2)
        ORDER BY type`,
      [acctA, acctB],
    );
    const transferLegs = legs.filter((r) => r.transfer_group_id !== null);

    // Exactly one transfer happened, and it left exactly two legs.
    expect(new Set(transferLegs.map((r) => r.transfer_group_id)).size).toBe(1);
    expect(transferLegs).toHaveLength(2);

    const outflow = transferLegs.find((r) => r.trust_account_id === acctA);
    const inflow = transferLegs.find((r) => r.trust_account_id === acctB);
    expect(outflow?.type).toBe('transfer');
    expect(inflow?.type).toBe('deposit');
    expect(Number(outflow?.amount_cents)).toBe(4000);
    expect(Number(inflow?.amount_cents)).toBe(4000);

    // The refused transfer left nothing behind: no orphan leg on either side.
    expect(legs.filter((r) => Number(r.amount_cents) === 9000)).toHaveLength(0);

    const { rows } = await testPool.query('SELECT id, book_balance_cents FROM trust_accounts WHERE id IN ($1, $2)', [acctA, acctB]);
    const aRow = rows.find(r => r.id === acctA);
    const bRow = rows.find(r => r.id === acctB);

    expect(Number(aRow.book_balance_cents)).toBe(6000);
    expect(Number(bRow.book_balance_cents)).toBe(4000);
  });
});
