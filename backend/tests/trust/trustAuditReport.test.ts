/**
 * The firm-wide trust audit report.
 *
 * A state bar examination does not ask for one client's statement or one
 * month's reconciliation. It asks the firm to prove, across every trust account
 * at once, that the three figures agree and that no client is negative inside a
 * pooled account whose total looks healthy. Before this endpoint the data
 * existed but only one account and one client at a time, so producing that proof
 * meant clicking through every account and every client by hand.
 *
 * The report is deliberately as-of-now rather than as-of-a-date:
 * `trust_accounts.book_balance_cents` is a live running total with no history,
 * so an as-of-date column would be a derived ledger figure sitting next to a
 * present-day book figure and the comparison between them would be meaningless.
 *
 * All amounts are CENTS.
 */
import {
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  stranger,
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

const post = (account: string, type: string, amountCents: number,
  clientRec: ClientRecord, extra: Record<string, unknown> = {}) =>
  postTrustTxn(owner, firm.id, { trustAccountId: account, clientId: clientRec.id, type, amountCents, ...extra });

const report = () => owner.api.get(`${F()}/audit-report`);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Trust Client' });
  accountId = await createTrustAccount(owner, firm.id);
});

// The three figures, the per-client breakdown and the firm totals across several
// accounts are pinned in `trustAuditReportConnections.test.ts`.
describe('the report covers every account in one read', () => {
  it('excludes voided entries from every figure', async () => {
    const kept = await post(accountId, 'deposit', 100_000, client);
    const reversed = await post(accountId, 'deposit', 30_000, client);
    expect(kept.status).toBe(201);
    expect(reversed.status).toBe(201);
    expect((await owner.api.patch(`${F()}/transactions/${reversed.body.transaction.id}/void`)
      .send({ voidReason: 'entered twice' })).status).toBe(200);

    const res = await report();

    // A report that counted reversed money would certify funds the firm already
    // established were never there.
    expect(Number(res.body.accounts[0].bookBalanceCents)).toBe(100_000);
    expect(Number(res.body.accounts[0].clientLedgerTotalCents)).toBe(100_000);
  });
});

describe('the report surfaces what an examiner looks for', () => {
  it('flags a client whose balance has gone negative', async () => {
    // The guards refuse to CREATE a negative client balance, so the only way one
    // exists is historical data or a repair gone wrong. That is precisely why the
    // report has to look: an examiner finds it whether or not the app can still
    // produce it, and a pooled account's healthy total hides it completely.
    expect((await post(accountId, 'deposit', 100_000, client)).status).toBe(201);
    const second = await createPersonClient(firm.id, { name: 'Second Client' });
    const { testPool } = await import('../support/setupInProcess');
    await testPool.query(
      `insert into trust_transactions
         (law_firm_id, trust_account_id, type, amount_cents, client_id, txn_date, status)
       values ($1, $2, 'withdrawal', 25000, $3, '2026-03-16', 'completed')`,
      [firm.id, accountId, second.id],
    );

    const res = await report();

    const negatives = res.body.accounts[0].negativeClientBalances as any[];
    expect(negatives).toHaveLength(1);
    expect(negatives[0].clientId).toBe(second.id);
    expect(Number(negatives[0].balanceCents)).toBe(-25_000);
    // One negative client is a commingling finding, so the account cannot be
    // reported as clean no matter what its total says.
    expect(res.body.accounts[0].balanced).toBe(false);
    expect(res.body.totals.balanced).toBe(false);
  });

  it('reports the last reconciliation and whether one is overdue', async () => {
    expect((await post(accountId, 'deposit', 100_000, client, { date: '2026-01-10' })).status)
      .toBe(201);
    expect((await owner.api.post(`${F()}/reconciliations`).send({
      trustAccountId: accountId,
      reconciliationDate: '2026-01-31',
      bankStatementBalanceCents: 100_000,
    })).status).toBe(201);

    const res = await report();

    const account = res.body.accounts[0];
    expect(account.lastReconciliationDate).toBe('2026-01-31');
    expect(account.nextReconciliationDueDate).toBe('2026-02-28');
    expect(account.reconciliationOverdue).toBe(true);
  });

  it('counts entries that have not cleared the bank', async () => {
    expect((await post(accountId, 'deposit', 100_000, client, { date: '2026-01-10' })).status)
      .toBe(201);
    expect((await owner.api.post(`${F()}/reconciliations`).send({
      trustAccountId: accountId,
      reconciliationDate: '2026-01-31',
      bankStatementBalanceCents: 100_000,
    })).status).toBe(201);
    expect((await post(accountId, 'withdrawal', 20_000, client, { date: '2026-02-10' })).status)
      .toBe(201);

    const res = await report();

    // The January deposit cleared; the February cheque has not. Outstanding items
    // are the reconciling difference an examiner asks the firm to explain.
    expect(res.body.accounts[0].outstandingCount).toBe(1);
    expect(Number(res.body.accounts[0].outstandingNetCents)).toBe(-20_000);
  });

  it('carries the retention cutoff the firm configured', async () => {
    await owner.api.put(`${F()}/settings`).send({ retentionYears: 7 });

    const res = await report();

    expect(res.body.retentionCutoffDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date().getUTCFullYear() - Number(res.body.retentionCutoffDate.slice(0, 4))).toBe(7);
  });
});

describe('the report is scoped and gated like the rest of trust', () => {
  it('shows nothing from another firm', async () => {
    expect((await post(accountId, 'deposit', 100_000, client)).status).toBe(201);
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.get(`/api/lawfirms/${otherFirm.id}/trust/audit-report`);

    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(0);
    expect(Number(res.body.totals.bookBalanceCents)).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain(accountId);
  });

  it('refuses a member whose role grants nothing, like every other trust view', async () => {
    expect((await post(accountId, 'deposit', 100_000, client)).status).toBe(201);
    const baseline = await memberWith(firm.id, []);

    const res = await baseline.api.get(`${F()}/audit-report`);

    // `trust.view` is not in DEFAULT_PERMISSIONS, so a role that never names it
    // cannot read trust data. This route must behave like `GET /accounts` and
    // `GET /balances` rather than inventing a laxer gate of its own, which would
    // be the only trust read open to a member with no grant. The seeded deposit
    // and the body check show the figures were withheld.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(accountId);
  });

  it('refuses a caller who is not in the firm at all', async () => {
    expect((await post(accountId, 'deposit', 100_000, client)).status).toBe(201);
    const outsider = stranger();

    const res = await outsider.api.get(`${F()}/audit-report`);

    // The real boundary for this report is the firm, not the role. It aggregates
    // every account and every client balance the firm holds, so a caller with no
    // membership must get nothing rather than an empty-looking 200.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(accountId);
  });
});
