/**
 * B06.1 row 4: "A client cannot spend another client's trust balance, even in
 * the same account. Tenant totals never substitute for client-specific
 * available funds."
 *
 * `trustConcurrency.test.ts`'s T02 already proves the WITHDRAWAL route refuses
 * an empty client's request against a shared account. What nothing in the
 * suite exercised before this file is the set of READ surfaces that report
 * per-client trust money: `GET .../clients/:clientId/balance`,
 * `GET .../accounts/:accountId/summary`, and `GET .../trust/balances` (the
 * firm-wide breakdown). All three are built from independent repository
 * queries (`computeClientBalancesByAccount`, `computeAccountClientBreakdown`,
 * `computeAllBalances`) that only share a common SQL fragment, not a common
 * function -- exactly the shape where one path could drift from the others,
 * or from what the withdrawal guard itself uses, without any single existing
 * test noticing.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  createTrustDeposit,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let clientA: ClientRecord;
let clientB: ClientRecord;
let accountId: string;

const TRUST = () => `/api/lawfirms/${firm.id}/trust`;

// Non-round, visibly distinct cent amounts: any pooling/mixing/doubling bug
// shows up as a wrong figure rather than a coincidental match.
const CLIENT_A_DEPOSIT_CENTS = 412_600; // $4,126.00 (createTrustDeposit's own fixture amount)
const CLIENT_B_DEPOSIT_CENTS = 137_733; // $1,377.33

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clientA = await createPersonClient(firm.id, { name: 'Funded Client' });
  clientB = await createPersonClient(firm.id, { name: 'Empty Client' });

  ({ accountId } = await createTrustDeposit(firm.id, clientA.id, { amountCents: CLIENT_A_DEPOSIT_CENTS }));

  // Client B deposits into the SAME account, through the real route (not the
  // fixture helper), so both clients' money genuinely shares one
  // `trust_accounts` row and one pooled `book_balance_cents`.
  const depositB = await owner.api.post(`${TRUST()}/transactions`).send({
    trustAccountId: accountId,
    type: 'deposit',
    amountCents: CLIENT_B_DEPOSIT_CENTS,
    clientId: clientB.id,
    clientName: 'Empty Client',
    date: '2026-03-10',
  });
  expect(depositB.status).toBe(201);
  await drainEvents();
});

describe('per-client trust balance, read across every surface that exposes it', () => {
  it('client balance, account summary, and firm-wide balances all report the SAME per-client figures', async () => {
    const pooledCents = CLIENT_A_DEPOSIT_CENTS + CLIENT_B_DEPOSIT_CENTS;

    // Ground truth: the account's own pooled book balance, independent of any
    // of the three read serializers under test.
    const { rows: acctRows } = await testPool.query(
      'select book_balance_cents from trust_accounts where id = $1', [accountId],
    );
    expect(Number(acctRows[0].book_balance_cents)).toBe(pooledCents);

    // 1. GET .../clients/:clientId/balance -- per-client, own-account.
    const balA = await owner.api.get(`${TRUST()}/clients/${clientA.id}/balance`);
    const balB = await owner.api.get(`${TRUST()}/clients/${clientB.id}/balance`);
    expect(balA.status).toBe(200);
    expect(balB.status).toBe(200);
    expect(balA.body.totalBalanceCents).toBe(CLIENT_A_DEPOSIT_CENTS);
    expect(balB.body.totalBalanceCents).toBe(CLIENT_B_DEPOSIT_CENTS);
    // Neither client's own balance figure is the pooled account total.
    expect(balA.body.totalBalanceCents).not.toBe(pooledCents);
    expect(balB.body.totalBalanceCents).not.toBe(pooledCents);

    // 2. GET .../accounts/:accountId/summary -- per-client breakdown within
    // the shared account.
    const summary = await owner.api.get(`${TRUST()}/accounts/${accountId}/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.clientCount).toBe(2);
    const summaryA = summary.body.clientBalances.find((c: any) => c.clientId === clientA.id);
    const summaryB = summary.body.clientBalances.find((c: any) => c.clientId === clientB.id);
    expect(summaryA?.balanceCents).toBe(CLIENT_A_DEPOSIT_CENTS);
    expect(summaryB?.balanceCents).toBe(CLIENT_B_DEPOSIT_CENTS);

    // 3. GET .../trust/balances -- firm-wide per-(client, account) breakdown.
    const firmBalances = await owner.api.get(`${TRUST()}/balances`);
    expect(firmBalances.status).toBe(200);
    const firmA = firmBalances.body.balances.find(
      (b: any) => b.clientId === clientA.id && b.trustAccountId === accountId,
    );
    const firmB = firmBalances.body.balances.find(
      (b: any) => b.clientId === clientB.id && b.trustAccountId === accountId,
    );
    expect(firmA?.balanceCents).toBe(CLIENT_A_DEPOSIT_CENTS);
    expect(firmB?.balanceCents).toBe(CLIENT_B_DEPOSIT_CENTS);

    // All three surfaces agree with each other, not just with the DB.
    expect(balA.body.totalBalanceCents).toBe(summaryA?.balanceCents);
    expect(balA.body.totalBalanceCents).toBe(firmA?.balanceCents);
    expect(balB.body.totalBalanceCents).toBe(summaryB?.balanceCents);
    expect(balB.body.totalBalanceCents).toBe(firmB?.balanceCents);

    // And the two clients' figures sum to the pooled account total -- proving
    // the per-client numbers are a genuine partition, not each one silently
    // reporting the whole pool.
    expect((summaryA?.balanceCents || 0) + (summaryB?.balanceCents || 0)).toBe(pooledCents);
  });

  it('refuses a withdrawal sized to the pooled account total using client B\'s OWN balance, and every read surface stays exactly as it was', async () => {
    // $2,000.00: more than client B's own $1,377.33, but comfortably less than
    // the account's pooled $5,503.33 -- the exact case that would succeed if
    // the withdrawal guard (or a display surface) ever substituted the
    // account/tenant total for the client's own available funds.
    const overdraftAttempt = await owner.api.post(`${TRUST()}/transactions`).send({
      trustAccountId: accountId,
      type: 'withdrawal',
      amountCents: 200_000,
      clientId: clientB.id,
      clientName: 'Empty Client',
      date: '2026-03-20',
    });
    expect(overdraftAttempt.status).toBeGreaterThanOrEqual(400);
    await drainEvents();

    // Nothing moved: not client B's balance, not the pooled account balance,
    // not client A's balance. A rejected request must write nothing.
    const balA = await owner.api.get(`${TRUST()}/clients/${clientA.id}/balance`);
    const balB = await owner.api.get(`${TRUST()}/clients/${clientB.id}/balance`);
    expect(balA.body.totalBalanceCents).toBe(CLIENT_A_DEPOSIT_CENTS);
    expect(balB.body.totalBalanceCents).toBe(CLIENT_B_DEPOSIT_CENTS);

    const { rows: acctRows } = await testPool.query(
      'select book_balance_cents from trust_accounts where id = $1', [accountId],
    );
    expect(Number(acctRows[0].book_balance_cents)).toBe(CLIENT_A_DEPOSIT_CENTS + CLIENT_B_DEPOSIT_CENTS);

    // Control: the SAME amount succeeds for client A, who actually has it,
    // proving the refusal above was about client B's balance specifically,
    // not some blanket cap or account-wide freeze.
    const controlWithdrawal = await owner.api.post(`${TRUST()}/transactions`).send({
      trustAccountId: accountId,
      type: 'withdrawal',
      amountCents: 200_000,
      clientId: clientA.id,
      clientName: 'Funded Client',
      date: '2026-03-20',
    });
    expect(controlWithdrawal.status).toBe(201);
  });
});
