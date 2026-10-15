/**
 * The per-firm trust settings, and whether they actually DO anything.
 *
 * Three of the four settings were stored, returned by the API and rendered as
 * controls, while nothing in the codebase ever read them. A firm could set a
 * monthly reconcile cadence and a five-year retention and receive no reminder,
 * no report and no retention behaviour, which is worse than having no control at
 * all: the screen states a policy the software does not keep.
 *
 * `flatFeeToOperatingAllowed` is covered by trustEntryIntegrity.test.ts, next to
 * the other entry-shape rules it belongs with. This file covers the rest:
 *
 *   - `reconcileCadence` produces a real due date and a real overdue flag.
 *   - `retentionYears` produces a real cutoff date a report can act on.
 *   - `enforceMatterTrustBalance` (new) makes the matter ledger authoritative for
 *     firms that hold money per matter rather than per client.
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
import { freezeClockAt } from '../support/clock';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let accountId: string;

const F = () => `/api/lawfirms/${firm.id}/trust`;
const MATTERS = () => `/api/lawfirms/${firm.id}/matters`;

const createAccount = (name = 'Primary IOLTA', last4 = '1111') => createTrustAccount(owner, firm.id, { name, last4 });

async function createMatter(clientRec: ClientRecord, name: string) {
  const res = await owner.api.post(MATTERS()).send({
    name, clients: [{ clientId: clientRec.id, name }],
  });
  expect(res.status).toBe(201);
  return res.body.matterId as string;
}

const post = (type: string, amountCents: number, extra: Record<string, unknown> = {}) =>
  postTrustTxn(owner, firm.id, { trustAccountId: accountId, clientId: client.id, type, amountCents, ...extra });

/** Record a reconciliation dated `date`, seeding enough money to make it balance. */
async function reconcileOn(date: string, bankStatementBalanceCents: number) {
  return owner.api.post(`${F()}/reconciliations`).send({
    trustAccountId: accountId,
    reconciliationDate: date,
    bankStatementBalanceCents,
  });
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Trust Client' });
  accountId = await createAccount();
});

describe('the reconcile cadence produces a real due date', () => {
  it('reports a never-reconciled account as due with no last date', async () => {
    const res = await owner.api.get(
      `${F()}/reconciliation-snapshot?trustAccountId=${accountId}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.lastReconciliationDate).toBeNull();
    // An account that has never been reconciled is the one a firm most needs
    // chasing. Reporting it as "not overdue" because there is no previous date
    // to add a month to would hide exactly the worst case.
    expect(res.body.reconciliationOverdue).toBe(true);
    expect(res.body.reconcileCadence).toBe('monthly');
  });

  it('adds one month to the last statement date on the monthly cadence', async () => {
    expect((await post('deposit', 100_000, { date: '2026-01-10' })).status).toBe(201);
    expect((await reconcileOn('2026-01-31', 100_000)).status).toBe(201);

    const res = await owner.api.get(
      `${F()}/reconciliation-snapshot?trustAccountId=${accountId}`,
    );

    expect(res.body.lastReconciliationDate).toBe('2026-01-31');
    expect(res.body.nextReconciliationDueDate).toBe('2026-02-28');
    // Today in these tests is well past February 2026, so a January
    // reconciliation on a monthly cadence is overdue.
    expect(res.body.reconciliationOverdue).toBe(true);
  });

  /**
   * "Overdue" is decided on the firm's day. Goes red if it is the UTC day: at
   * 8pm Pacific on the due date it is already the next day in UTC, so the
   * warning showed a few hours before the reconciliation was actually late.
   */
  it('is not overdue until the due day is over for the firm', async () => {
    await testPool.query(
      `update law_firms set settings = coalesce(settings, '{}'::jsonb) || '{"timezone":"America/Los_Angeles"}'::jsonb where id = $1`,
      [firm.id],
    );
    expect((await post('deposit', 100_000, { date: '2026-08-10' })).status).toBe(201);
    expect((await reconcileOn('2026-08-26', 100_000)).status).toBe(201);
    freezeClockAt('2026-09-26T20:00:00-07:00');

    const res = await owner.api.get(`${F()}/reconciliation-snapshot?trustAccountId=${accountId}`);

    expect(res.body.nextReconciliationDueDate).toBe('2026-09-26');
    expect(res.body.reconciliationOverdue).toBe(false);
  });

  it('adds three months on the quarterly cadence', async () => {
    expect((await owner.api.put(`${F()}/settings`)
      .send({ reconcileCadence: 'quarterly' })).status).toBe(200);
    expect((await post('deposit', 100_000, { date: '2026-01-10' })).status).toBe(201);
    expect((await reconcileOn('2026-01-31', 100_000)).status).toBe(201);

    const res = await owner.api.get(
      `${F()}/reconciliation-snapshot?trustAccountId=${accountId}`,
    );

    // The setting has to change the answer, or it is still decorative.
    expect(res.body.nextReconciliationDueDate).toBe('2026-04-30');
    expect(res.body.reconcileCadence).toBe('quarterly');
  });

  it('clamps the due date to a real calendar day when the month is shorter', async () => {
    expect((await post('deposit', 100_000, { date: '2026-01-10' })).status).toBe(201);
    expect((await reconcileOn('2026-01-30', 100_000)).status).toBe(201);

    const res = await owner.api.get(
      `${F()}/reconciliation-snapshot?trustAccountId=${accountId}`,
    );

    // Naive month arithmetic turns 30 January into 2 March. A due date that
    // silently skips a month is a reminder that fires late.
    expect(res.body.nextReconciliationDueDate).toBe('2026-02-28');
  });
});

describe('the retention setting produces a real cutoff', () => {
  it('stores and returns the default low-balance minimum', async () => {
    // The setting is only useful if it survives the round trip: the writable-key
    // filter in `updateTrustSettings` silently drops anything not on its list,
    // so a setting the API "accepts" can still never be read back.
    expect((await owner.api.put(`${F()}/settings`).send({ defaultMinimumCents: 50_000 })).status).toBe(200);

    const res = await owner.api.get(`${F()}/settings`);
    expect(res.status).toBe(200);
    expect(res.body.settings.defaultMinimumCents).toBe(50_000);
  });

  it('reports null when the firm has set none, meaning the built-in default', async () => {
    const res = await owner.api.get(`${F()}/settings`);

    // Null and zero are different: zero would mean no client ever alerts.
    expect(res.body.settings.defaultMinimumCents).toBeNull();
  });

  it('clears back to the built-in default', async () => {
    await owner.api.put(`${F()}/settings`).send({ defaultMinimumCents: 50_000 });

    expect((await owner.api.put(`${F()}/settings`).send({ defaultMinimumCents: null })).status).toBe(200);
    expect((await owner.api.get(`${F()}/settings`)).body.settings.defaultMinimumCents).toBeNull();
  });

  it('derives a cutoff date from retentionYears', async () => {
    expect((await owner.api.put(`${F()}/settings`).send({ retentionYears: 7 })).status).toBe(200);

    const res = await owner.api.get(`${F()}/settings`);

    expect(res.status).toBe(200);
    expect(res.body.settings.retentionYears).toBe(7);
    // A number of years is not actionable on its own. The date it resolves to is
    // what a report or an archive decision can be measured against.
    const cutoff = res.body.settings.retentionCutoffDate as string;
    expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const yearsBack = new Date().getUTCFullYear() - Number(cutoff.slice(0, 4));
    expect(yearsBack).toBe(7);
  });

  it('moves the cutoff when the setting changes', async () => {
    const before = (await owner.api.get(`${F()}/settings`)).body.settings.retentionCutoffDate;
    await owner.api.put(`${F()}/settings`).send({ retentionYears: 10 });
    const after = (await owner.api.get(`${F()}/settings`)).body.settings.retentionCutoffDate;

    // Default is 5 years, so raising it to 10 must push the cutoff further back.
    expect(after < before).toBe(true);
  });
});

describe('matter-level trust balances, when the firm asks for them', () => {
  it('allows a withdrawal that overdraws the matter while the setting is off', async () => {
    const matterA = await createMatter(client, 'Matter A');
    const matterB = await createMatter(client, 'Matter B');
    expect((await post('deposit', 100_000, { matterId: matterA })).status).toBe(201);

    const res = await post('withdrawal', 40_000, { matterId: matterB });

    // Default behaviour is unchanged: balances are per (client, account), the
    // client has 100,000, and the matter ledger is a reporting view. Turning this
    // on by default would break every firm that deposits at the client level.
    expect(res.status).toBe(201);
  });

  it('refuses a withdrawal that overdraws the matter once the setting is on', async () => {
    expect((await owner.api.put(`${F()}/settings`)
      .send({ enforceMatterTrustBalance: true })).status).toBe(200);
    const matterA = await createMatter(client, 'Matter A');
    const matterB = await createMatter(client, 'Matter B');
    expect((await post('deposit', 100_000, { matterId: matterA })).status).toBe(201);

    const res = await post('withdrawal', 40_000, { matterId: matterB });

    // Matter B holds nothing. Spending Matter A's retainer on it is the same
    // error as spending another client's money, one level down, and the
    // client-level guard cannot see it.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_MATTER_TRUST_BALANCE');

    const { rows } = await testPool.query(
      `select book_balance_cents from trust_accounts where id = $1`, [accountId],
    );
    expect(Number(rows[0].book_balance_cents)).toBe(100_000);
  });

  it('still allows a withdrawal the matter can cover', async () => {
    expect((await owner.api.put(`${F()}/settings`)
      .send({ enforceMatterTrustBalance: true })).status).toBe(200);
    const matterA = await createMatter(client, 'Matter A');
    expect((await post('deposit', 100_000, { matterId: matterA })).status).toBe(201);

    const res = await post('withdrawal', 40_000, { matterId: matterA });

    expect(res.status).toBe(201);
  });

  it('refuses a transfer that overdraws the matter on the source account once the setting is on', async () => {
    // The transfer is the other debit path. Its destination leg credits the
    // same matter, so the matter's total across accounts never changes; what
    // it can overdraw is the matter's share of the SOURCE account.
    expect((await owner.api.put(`${F()}/settings`)
      .send({ enforceMatterTrustBalance: true })).status).toBe(200);
    const destinationId = await createAccount('Secondary IOLTA', '2222');
    const matterA = await createMatter(client, 'Matter A');
    const matterB = await createMatter(client, 'Matter B');
    expect((await post('deposit', 100_000, { matterId: matterA })).status).toBe(201);
    expect((await post('deposit', 30_000, { matterId: matterB })).status).toBe(201);

    const refused = await post('transfer', 30_001, { matterId: matterB, transferToAccountId: destinationId });
    const allowed = await post('transfer', 30_000, { matterId: matterB, transferToAccountId: destinationId });

    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('INSUFFICIENT_MATTER_TRUST_BALANCE');
    expect(refused.body.error).toContain('Available: $300.00, required: $300.01.');
    expect(allowed.status).toBe(201);
    const books = await testPool.query(
      'select id, book_balance_cents from trust_accounts where id = any($1)', [[accountId, destinationId]],
    );
    const book = Object.fromEntries(books.rows.map((r: any) => [r.id, Number(r.book_balance_cents)]));
    expect(book).toEqual({ [accountId]: 100_000, [destinationId]: 30_000 });
  });

  it('reports a matter\'s balance per account, leaving voided entries and empty accounts out', async () => {
    const destinationId = await createAccount('Secondary IOLTA', '2222');
    await createAccount('Untouched IOLTA', '3333');
    const matterA = await createMatter(client, 'Matter A');
    const matterB = await createMatter(client, 'Matter B');
    expect((await post('deposit', 100_000, { matterId: matterA })).status).toBe(201);
    expect((await post('withdrawal', 12_345, { matterId: matterA })).status).toBe(201);
    expect((await post('transfer', 20_000, { matterId: matterA, transferToAccountId: destinationId })).status).toBe(201);
    const mistaken = await post('deposit', 99_999, { matterId: matterA });
    expect((await owner.api.patch(`${F()}/transactions/${mistaken.body.transaction.id}/void`)
      .send({ voidReason: 'Posted twice' })).status).toBe(200);
    expect((await post('deposit', 7_000, { matterId: matterB })).status).toBe(201);

    const res = await owner.api.get(`${F()}/matters/${matterA}/balance`);

    expect(res.status).toBe(200);
    // 100,000 - 12,345 - 20,000 on the primary; the 20,000 transfer's credit leg
    // on the secondary; the voided 99,999 nowhere; Matter B's 7,000 not here.
    expect(res.body.totalBalanceCents).toBe(87_655);
    expect(res.body.accountBalances.map((b: any) => [b.trustAccountId, b.balanceCents]).sort())
      .toEqual([[accountId, 67_655], [destinationId, 20_000]].sort());

    const ledger = await owner.api.get(`${F()}/matters/${matterA}/ledger`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.totalItems).toBe(ledger.body.transactions.length);
    expect(ledger.body.transactions.every((t: any) => t.matterId === matterA)).toBe(true);
  });

  it('does not report one firm\'s matter balance to another firm', async () => {
    const matterA = await createMatter(client, 'Matter A');
    expect((await post('deposit', 100_000, { matterId: matterA })).status).toBe(201);
    const rival = await createFirm();
    const rivalOwner = await ownerOf(rival.id);

    const res = await rivalOwner.api.get(`/api/lawfirms/${rival.id}/trust/matters/${matterA}/balance`);

    // Asked under the rival's own firm id, the matter's id names nothing there.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matterId: matterA, totalBalanceCents: 0, accountBalances: [] });
  });

  it('does not guard an entry that names no matter', async () => {
    expect((await owner.api.put(`${F()}/settings`)
      .send({ enforceMatterTrustBalance: true })).status).toBe(200);
    expect((await post('deposit', 100_000)).status).toBe(201);

    const res = await post('withdrawal', 40_000);

    // A firm-level disbursement with no matter has no matter balance to check.
    // Refusing it would make the setting unusable rather than stricter.
    expect(res.status).toBe(201);
  });
});
