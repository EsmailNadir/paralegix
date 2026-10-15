/**
 * Trust bank accounts: creating them, editing them, and deactivating them.
 *
 * `trustLedger.test.ts` covers the money that moves through an account and
 * `trustVoidAndReconciliation.test.ts` covers corrections. Neither covers the
 * account RECORD itself, which is where three rules live that nothing else
 * enforces:
 *
 *   AN ACCOUNT WITH MONEY IN IT CANNOT BE DEACTIVATED. Hiding an account that
 *   still holds client funds is how a trust balance stops being reconciled, and
 *   the check is against a non-zero balance in EITHER direction, not a positive
 *   one.
 *
 *   READ AND WRITE ARE DIFFERENT PERMISSIONS. Neither `trust.view` nor
 *   `trust.manage` is baseline. A member needs `trust.view` to see the accounts
 *   and `trust.manage` to change them.
 *
 *   ONLY THE LAST FOUR DIGITS ARE EVER STORED. The schema keeps
 *   `account_number_last4`, and the validation refuses anything but four digits,
 *   so a full account number cannot be persisted by accident.
 *
 * Driven through the routes rather than the service. The permission gate and the
 * Zod schema are both middleware, so a service-level test proves neither, and
 * those two are most of what stands between a member and a trust account.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
/** Baseline only: holds `trust.view` and not `trust.manage`. */
let viewer: Actor;
let otherFirm: Firm;
let otherOwner: Actor;
let client: ClientRecord;

const A = (lawFirmId: string, suffix = '') =>
  `/api/lawfirms/${lawFirmId}/trust/accounts${suffix}`;
const TXN = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/trust/transactions`;

// `createPersonClient` returns only an id, so the display name the transaction
// schema demands is held here rather than read back off the fixture.
const CLIENT_NAME = 'Deposit Client';

const ACCOUNT_BODY = {
  name: 'Primary IOLTA Account',
  bankName: 'First Legal Bank',
  accountNumberLast4: '9876',
  routingNumberLast4: '1234',
  accountType: 'iolta',
};

/** Create an account through the API and return its id. */
async function createAccount(actor: Actor, lawFirmId: string, overrides = {}) {
  const res = await actor.api.post(A(lawFirmId)).send({ ...ACCOUNT_BODY, ...overrides });
  expect(res.status).toBe(201);
  return res.body.account.id as string;
}

async function accountRow(id: string) {
  const { rows } = await testPool.query('select * from trust_accounts where id = $1', [id]);
  return rows[0] || null;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Trust Accounts Firm' });
  owner = await ownerOf(firm.id);
  viewer = await memberWith(firm.id, []);
  client = await createPersonClient(firm.id, { name: CLIENT_NAME });

  otherFirm = await createFirm({ name: 'Neighbour LLP' });
  otherOwner = await ownerOf(otherFirm.id);
});

describe('creating an account', () => {
  it('stores the bank details and starts it active with a zero balance', async () => {
    const res = await owner.api.post(A(firm.id)).send(ACCOUNT_BODY);

    expect(res.status).toBe(201);
    expect(res.body.account).toMatchObject({
      id: expect.any(String),
      name: 'Primary IOLTA Account',
      bankName: 'First Legal Bank',
      accountNumberLast4: '9876',
      accountType: 'iolta',
    });
    // The row, because two of these are defaults the request never sent. An
    // account that started inactive would be invisible to the transaction form,
    // and a non-zero opening balance is money nobody deposited.
    const row = await accountRow(res.body.account.id);
    expect(row).toMatchObject({ status: 'active', law_firm_id: firm.id });
    expect(Number(row.book_balance_cents)).toBe(0);
  });

  it('defaults the account type to iolta when none is given', async () => {
    const withoutType: Partial<typeof ACCOUNT_BODY> = { ...ACCOUNT_BODY };
    delete withoutType.accountType;
    const res = await owner.api.post(A(firm.id)).send(withoutType);

    // IOLTA is the regulated default: pooled client funds whose interest goes to
    // the bar foundation. Defaulting to anything else would misclassify the
    // account for every report that groups by type.
    expect(res.status).toBe(201);
    expect(res.body.account.accountType).toBe('iolta');
    expect((await accountRow(res.body.account.id)).account_type).toBe('iolta');
  });

  it('refuses anything but four digits for the account number', async () => {
    const tooLong = await owner.api.post(A(firm.id))
      .send({ ...ACCOUNT_BODY, accountNumberLast4: '123456789012' });
    const tooShort = await owner.api.post(A(firm.id))
      .send({ ...ACCOUNT_BODY, accountNumberLast4: '987' });
    const letters = await owner.api.post(A(firm.id))
      .send({ ...ACCOUNT_BODY, accountNumberLast4: 'ABCD' });

    // This is the rule that keeps a full account number out of the database. A
    // length check alone would accept 'ABCD'; a digits check alone would accept
    // a whole account number.
    expect([tooLong.status, tooShort.status, letters.status]).toEqual([400, 400, 400]);
    const { rows } = await testPool.query(
      'select 1 from trust_accounts where law_firm_id = $1', [firm.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a missing name or bank name', async () => {
    const noName = await owner.api.post(A(firm.id)).send({ ...ACCOUNT_BODY, name: '' });
    const noBank = await owner.api.post(A(firm.id)).send({ ...ACCOUNT_BODY, bankName: '' });

    expect([noName.status, noBank.status]).toEqual([400, 400]);
  });
});

describe('who may read and who may write', () => {
  it('refuses a member whose role grants nothing the accounts', async () => {
    await createAccount(owner, firm.id);

    const res = await viewer.api.get(A(firm.id));

    // `trust.view` is not baseline, so reading trust accounts needs an explicit
    // grant. Seeded first, so a 403 cannot be mistaken for an empty list.
    expect(res.status).toBe(403);
    expect(res.body.accounts).toBeUndefined();
  });

  it('refuses a baseline member every WRITE, and changes nothing', async () => {
    const id = await createAccount(owner, firm.id);

    const create = await viewer.api.post(A(firm.id)).send(ACCOUNT_BODY);
    const update = await viewer.api.put(A(firm.id, `/${id}`)).send({ name: 'Renamed' });
    const status = await viewer.api.patch(A(firm.id, `/${id}/status`)).send({ status: 'inactive' });
    const close = await viewer.api.patch(A(firm.id, `/${id}/book-close`))
      .send({ bookCloseDate: '2026-08-01' });

    expect([create.status, update.status, status.status, close.status])
      .toEqual([403, 403, 403, 403]);
    // Four gates, one assertion that covers all four: the row is exactly as it
    // was, and no second account exists.
    expect(await accountRow(id)).toMatchObject({ name: 'Primary IOLTA Account', status: 'active' });
    const { rows } = await testPool.query(
      'select 1 from trust_accounts where law_firm_id = $1', [firm.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a member of another firm, and leaves that firm accounts alone', async () => {
    const mine = await createAccount(owner, firm.id);
    await createAccount(otherOwner, otherFirm.id, { name: 'Their IOLTA' });

    const read = await otherOwner.api.get(A(firm.id));
    const update = await otherOwner.api.put(A(firm.id, `/${mine}`)).send({ name: 'Hijacked' });

    expect(read.status).toBe(403);
    expect(update.status).toBe(403);
    expect(await accountRow(mine)).toMatchObject({ name: 'Primary IOLTA Account' });
  });
});

describe('listing and reading accounts', () => {
  it('lists this firm accounts and never another firm', async () => {
    await createAccount(owner, firm.id, { name: 'Mine' });
    await createAccount(otherOwner, otherFirm.id, { name: 'Theirs' });

    const mine = await owner.api.get(A(firm.id));
    const theirs = await otherOwner.api.get(A(otherFirm.id));

    // Both directions, so an empty result cannot pass as isolation.
    expect(mine.body.accounts.map((a: any) => a.name)).toEqual(['Mine']);
    expect(theirs.body.accounts.map((a: any) => a.name)).toEqual(['Theirs']);
  });

  it('reads one account by its id', async () => {
    const id = await createAccount(owner, firm.id);

    const res = await owner.api.get(A(firm.id, `/${id}`));

    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ id, name: 'Primary IOLTA Account' });
  });

  it('does not serve another firm account by its id', async () => {
    const theirs = await createAccount(otherOwner, otherFirm.id, { name: 'Theirs' });

    const res = await owner.api.get(A(firm.id, `/${theirs}`));

    // A real, existing id. The 404 is the tenant scope refusing it rather than a
    // missing row, which is why the account is created rather than invented.
    expect(res.status).toBe(404);
  });

  it('answers 404 for an id that exists nowhere', async () => {
    expect((await owner.api.get(A(firm.id, `/${randomUUID()}`))).status).toBe(404);
  });
});

describe('editing an account', () => {
  it('writes the fields it was given', async () => {
    const id = await createAccount(owner, firm.id);

    const res = await owner.api.put(A(firm.id, `/${id}`)).send({
      name: 'Main State Bar IOLTA',
      bankName: 'Second Legal Bank',
      accountNumberLast4: '4321',
    });

    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({
      name: 'Main State Bar IOLTA',
      bankName: 'Second Legal Bank',
      accountNumberLast4: '4321',
    });
    expect(await accountRow(id)).toMatchObject({
      name: 'Main State Bar IOLTA', bank_name: 'Second Legal Bank',
    });
  });

  it('leaves unmentioned fields alone', async () => {
    const id = await createAccount(owner, firm.id);

    await owner.api.put(A(firm.id, `/${id}`)).send({ name: 'Renamed Only' });

    // The update builds its SET list field by field. A whole-row write would
    // blank the bank details, and a trust account with no bank on it cannot be
    // reconciled against a statement.
    expect(await accountRow(id)).toMatchObject({
      name: 'Renamed Only',
      bank_name: 'First Legal Bank',
      account_number_last4: '9876',
      routing_number_last4: '1234',
    });
  });

  it('still refuses a bad account number on update', async () => {
    const id = await createAccount(owner, firm.id);

    const res = await owner.api.put(A(firm.id, `/${id}`))
      .send({ accountNumberLast4: '123456789012' });

    // The create schema and the update schema are separate objects, so a rule
    // present on one is not evidence about the other.
    expect(res.status).toBe(400);
    expect(await accountRow(id)).toMatchObject({ account_number_last4: '9876' });
  });

  it('does not edit another firm account', async () => {
    const theirs = await createAccount(otherOwner, otherFirm.id, { name: 'Theirs' });

    const res = await owner.api.put(A(firm.id, `/${theirs}`)).send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect(await accountRow(theirs)).toMatchObject({ name: 'Theirs' });
  });
});

describe('deactivating an account', () => {
  it('deactivates one that holds nothing', async () => {
    const id = await createAccount(owner, firm.id);

    const res = await owner.api.patch(A(firm.id, `/${id}/status`)).send({ status: 'inactive' });

    expect(res.status).toBe(200);
    expect(await accountRow(id)).toMatchObject({ status: 'inactive' });
  });

  it('refuses to deactivate one that still holds client money', async () => {
    const id = await createAccount(owner, firm.id);
    const deposit = await owner.api.post(TXN(firm.id)).send({
      trustAccountId: id,
      clientId: client.id,
      clientName: CLIENT_NAME,
      type: 'deposit',
      amountCents: 50000,
      date: '2026-08-15',
      description: 'Initial retainer',
    });
    expect(deposit.status).toBe(201);

    const res = await owner.api.patch(A(firm.id, `/${id}/status`)).send({ status: 'inactive' });

    // Deactivating an account with a balance takes it off the reconciliation
    // screens while the firm is still holding the money. That is the shape of a
    // trust-accounting violation, so it is refused rather than warned about.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_ACCOUNT_HAS_BALANCE');
    expect(await accountRow(id)).toMatchObject({ status: 'active' });
  });

  it('cannot reach a negative balance for the guard to catch in the first place', async () => {
    const id = await createAccount(owner, firm.id);

    // `updateAccountStatus` is worded against a NON-ZERO balance rather than a
    // positive one, so that an overdrawn legacy row could not be hidden by
    // deactivating it. That branch is unreachable: `trust_accounts_book_balance_nonneg`
    // refuses the row outright, so the schema settles it before the service can.
    // Written directly, because the API refuses to create an overdraft too.
    await expect(testPool.query(
      'update trust_accounts set book_balance_cents = -2500 where id = $1', [id],
    )).rejects.toThrow(/trust_accounts_book_balance_nonneg/);

    // The account is untouched, so the deactivate guard still has only the
    // positive case to answer, which the test above covers.
    expect(Number((await accountRow(id)).book_balance_cents)).toBe(0);
  });

  it('refuses a deposit into an inactive account, and writes nothing', async () => {
    // A deactivated account is off the reconciliation screens, so money posted
    // into it is money nobody reconciles.
    const id = await createAccount(owner, firm.id);
    await owner.api.patch(A(firm.id, `/${id}/status`)).send({ status: 'inactive' });

    const res = await owner.api.post(TXN(firm.id)).send({
      trustAccountId: id, clientId: client.id, clientName: CLIENT_NAME,
      type: 'deposit', amountCents: 12_345, date: '2026-08-15',
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_ACCOUNT_INACTIVE');
    expect(Number((await accountRow(id)).book_balance_cents)).toBe(0);
    const { rows } = await testPool.query(
      'select count(*)::int n from trust_transactions where trust_account_id = $1', [id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses a transfer into an inactive account, leaving both balances where they were', async () => {
    // The transfer path locks both accounts itself rather than going through the
    // single-entry create, so it needs its own check on the destination leg.
    const source = await createAccount(owner, firm.id);
    const closed = await createAccount(owner, firm.id, { name: 'Closed IOLTA', accountNumberLast4: '5555' });
    const deposit = await owner.api.post(TXN(firm.id)).send({
      trustAccountId: source, clientId: client.id, clientName: CLIENT_NAME,
      type: 'deposit', amountCents: 50_000, date: '2026-08-15',
    });
    expect(deposit.status).toBe(201);
    await owner.api.patch(A(firm.id, `/${closed}/status`)).send({ status: 'inactive' });

    const res = await owner.api.post(TXN(firm.id)).send({
      trustAccountId: source, transferToAccountId: closed, clientId: client.id, clientName: CLIENT_NAME,
      type: 'transfer', amountCents: 20_000, date: '2026-08-16',
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_ACCOUNT_INACTIVE');
    expect(Number((await accountRow(source)).book_balance_cents)).toBe(50_000);
    expect(Number((await accountRow(closed)).book_balance_cents)).toBe(0);
    const { rows } = await testPool.query(
      `select count(*)::int n from trust_transactions where law_firm_id = $1 and type = 'transfer'`, [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('reactivates an inactive account', async () => {
    const id = await createAccount(owner, firm.id);
    await owner.api.patch(A(firm.id, `/${id}/status`)).send({ status: 'inactive' });

    const res = await owner.api.patch(A(firm.id, `/${id}/status`)).send({ status: 'active' });

    // The balance guard is one-directional. Applying it to reactivation as well
    // would strand every account that was closed with money in it.
    expect(res.status).toBe(200);
    expect(await accountRow(id)).toMatchObject({ status: 'active' });
  });

  it('rejects a status outside the allowed pair', async () => {
    const id = await createAccount(owner, firm.id);

    const res = await owner.api.patch(A(firm.id, `/${id}/status`)).send({ status: 'closed' });

    expect(res.status).toBe(400);
    expect(await accountRow(id)).toMatchObject({ status: 'active' });
  });
});

describe('closing the books on an account', () => {
  // Recording the close date, refusing an entry inside the period and accepting
  // one after it are pinned in `trustPeriodGuards.test.ts` and
  // `trustVoidAndReconciliation.test.ts`.
  it('clears the lock when the date is set to null', async () => {
    const id = await createAccount(owner, firm.id);
    await owner.api.patch(A(firm.id, `/${id}/book-close`)).send({ bookCloseDate: '2026-08-01' });

    const cleared = await owner.api.patch(A(firm.id, `/${id}/book-close`))
      .send({ bookCloseDate: null });

    expect(cleared.status).toBe(200);
    expect((await accountRow(id)).book_close_date).toBeNull();
    // Proved by the entry that was refused a moment ago now landing.
    const res = await owner.api.post(TXN(firm.id)).send({
      trustAccountId: id,
      clientId: client.id,
      clientName: CLIENT_NAME,
      type: 'deposit',
      amountCents: 20000,
      date: '2026-07-25',
      description: 'Allowed once the lock is gone',
    });
    expect(res.status).toBe(201);
  });

  it('rejects a malformed close date', async () => {
    const id = await createAccount(owner, firm.id);

    const res = await owner.api.patch(A(firm.id, `/${id}/book-close`))
      .send({ bookCloseDate: '01/08/2026' });

    expect(res.status).toBe(400);
    expect((await accountRow(id)).book_close_date).toBeNull();
  });
});

/**
 * IOLTA interest remittances: what the bank paid on pooled client money and what
 * the firm passed on to the bar foundation. The list is accounting history, so
 * the amounts must come back to the cent, each account's filter must hold, and
 * the total must count the whole scope rather than the page.
 */
describe('IOLTA interest remittances', () => {
  const R = (lawFirmId: string, suffix = '') => `/api/lawfirms/${lawFirmId}/trust/interest-remittances${suffix}`;

  async function remit(accountId: string, periodEnd: string, interestEarnedCents: number, amountRemittedCents: number) {
    const res = await owner.api.post(R(firm.id)).send({
      trustAccountId: accountId, periodStart: `${periodEnd.slice(0, 8)}01`, periodEnd,
      interestEarnedCents, amountRemittedCents, remittedTo: 'State Bar Foundation', status: 'remitted',
    });
    expect(res.status).toBe(201);
    return res.body.remittance.id as string;
  }

  it('lists every remittance newest period first, with exact cents and the account name', async () => {
    const primary = await createAccount(owner, firm.id);
    const second = await createAccount(owner, firm.id, { name: 'Second IOLTA', accountNumberLast4: '4444' });
    await remit(primary, '2026-01-31', 1_234, 1_233);
    await remit(primary, '2026-02-28', 5_678, 5_678);
    await remit(second, '2026-03-31', 9_999, 0);

    const res = await owner.api.get(R(firm.id));

    expect(res.status).toBe(200);
    expect(res.body.remittances.map((r: any) => [r.periodEnd, r.trustAccountName, r.interestEarnedCents, r.amountRemittedCents]))
      .toEqual([
        ['2026-03-31', 'Second IOLTA', 9_999, 0],
        ['2026-02-28', 'Primary IOLTA Account', 5_678, 5_678],
        ['2026-01-31', 'Primary IOLTA Account', 1_234, 1_233],
      ]);
    expect(res.body).toMatchObject({ totalItems: 3, truncated: false });
  });

  it('narrows to one account and pages it, while the total counts that account\'s whole history', async () => {
    const primary = await createAccount(owner, firm.id);
    const second = await createAccount(owner, firm.id, { name: 'Second IOLTA', accountNumberLast4: '4444' });
    await remit(primary, '2026-01-31', 100, 100);
    await remit(primary, '2026-02-28', 200, 200);
    await remit(primary, '2026-03-31', 300, 300);
    await remit(second, '2026-03-31', 999, 999);

    const page = await owner.api.get(R(firm.id)).query({ trustAccountId: primary, limit: 1, offset: 1 });

    expect(page.status).toBe(200);
    expect(page.body.remittances.map((r: any) => r.interestEarnedCents)).toEqual([200]);
    expect(page.body.totalItems).toBe(3);
  });

  it('shows another firm none of this firm\'s remittances', async () => {
    const primary = await createAccount(owner, firm.id);
    await remit(primary, '2026-01-31', 1_234, 1_234);

    const res = await otherOwner.api.get(R(otherFirm.id));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ remittances: [], totalItems: 0 });
    expect((await owner.api.get(R(firm.id))).body.totalItems).toBe(1);
  });
});
