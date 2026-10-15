/**
 * What a ledger entry is allowed to say, and what an account is allowed to
 * become once it holds money.
 *
 * Every case here is a way the ledger could record something that is internally
 * consistent and still false:
 *
 *   - Voiding a trust withdrawal that paid an invoice returns the money to the
 *     client while the invoice still reads paid. The billing side already
 *     reverses the trust entry when a payment is deleted; nothing did the
 *     reverse, so the trust route is the one that has to refuse.
 *   - A matter id that belongs to a different client attributes one client's
 *     money to another client's engagement, on an append-only row.
 *   - Changing an account's type or last four digits after it has ledger history
 *     silently rewrites what every existing entry was posted into.
 *   - A duplicated check number is the classic trust bookkeeping error, and
 *     `reference_number` is free text with nothing watching it.
 *   - Moving trust money to the operating account is taking a fee. Bar rules
 *     want a bill behind it, which is what `flatFeeToOperatingAllowed` was
 *     added to express and never enforced.
 *
 * All amounts are CENTS.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createInvoice,
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
const MATTERS = () => `/api/lawfirms/${firm.id}/matters`;

const createAccount = (name = 'Primary IOLTA', last4 = '1111') => createTrustAccount(owner, firm.id, { name, last4 });

async function createMatter(clientRec: ClientRecord, name = 'Trust Matter') {
  const res = await owner.api.post(MATTERS()).send({
    name, clients: [{ clientId: clientRec.id, name: clientRec.id }],
  });
  expect(res.status).toBe(201);
  return res.body.matterId as string;
}

const post = (type: string, amountCents: number, extra: Record<string, unknown> = {}) =>
  postTrustTxn(owner, firm.id, { trustAccountId: accountId, clientId: client.id, type, amountCents, ...extra });

const accountRow = async (id: string) => {
  const { rows } = await testPool.query('select * from trust_accounts where id = $1', [id]);
  return rows[0];
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Trust Client' });
  accountId = await createAccount();
});

describe('the invoice a trust entry names', () => {
  it('must belong to the same client, not merely the same firm', async () => {
    expect((await post('deposit', 100_000)).status).toBe(201);
    const otherClient = await createPersonClient(firm.id, { name: 'Other Client' });
    const theirInvoice = await createInvoice(firm.id, otherClient.id, { totalCents: 40_000 });

    // In-firm, so the composite key is satisfied; the only thing wrong is the
    // payer. Linking this client's fee withdrawal to that bill on an append-only
    // ledger cannot be undone.
    const res = await post('withdrawal', 40_000, { invoiceId: theirInvoice.id });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_INVOICE_CLIENT_MISMATCH');
  });

  it('must exist in this firm, answered as a client error rather than a scrubbed 500', async () => {
    expect((await post('deposit', 100_000)).status).toBe(201);
    const res = await post('withdrawal', 40_000, { invoiceId: randomUUID() });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_INVOICE_NOT_FOUND');
  });
});

describe('a withdrawal that paid an invoice cannot be voided from the trust side', () => {
  it('refuses the void and leaves the balance alone', async () => {
    expect((await post('deposit', 100_000)).status).toBe(201);
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 40_000 });
    const withdrawal = await post('withdrawal', 40_000, { invoiceId: invoice.id });
    expect(withdrawal.status).toBe(201);

    const res = await owner.api
      .patch(`${F()}/transactions/${withdrawal.body.transaction.id}/void`)
      .send({ voidReason: 'changed my mind' });

    // Voiding here returns 40,000 to the client's trust balance while the
    // invoice still records a trust payment of 40,000. The invoice could then be
    // paid from trust a second time.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRUST_ENTRY_LINKED_TO_INVOICE');

    const { rows } = await testPool.query(
      'select book_balance_cents from trust_accounts where id = $1', [accountId],
    );
    expect(Number(rows[0].book_balance_cents)).toBe(60_000);
  });

  it('still allows voiding a withdrawal with no invoice behind it', async () => {
    expect((await post('deposit', 100_000)).status).toBe(201);
    const withdrawal = await post('withdrawal', 40_000);
    expect(withdrawal.status).toBe(201);

    const res = await owner.api
      .patch(`${F()}/transactions/${withdrawal.body.transaction.id}/void`)
      .send({ voidReason: 'entered twice' });

    // The refusal above has to be about the invoice link specifically, not a
    // blanket ban on voiding withdrawals.
    expect(res.status).toBe(200);
  });
});

describe('a matter on a trust entry must belong to the paying client', () => {
  it("refuses a matter that belongs to another client", async () => {
    const other = await createPersonClient(firm.id, { name: 'Other Client' });
    const otherMatter = await createMatter(other, 'Other Matter');

    const res = await post('deposit', 50_000, { matterId: otherMatter });

    // `trust_transactions` is append-only, so a row attributing this client's
    // money to another client's matter can never be edited back out. The matter
    // FK only proves the matter is in the same firm.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_MATTER_CLIENT_MISMATCH');

    const { rows } = await testPool.query(
      'select count(*)::int n from trust_transactions where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("accepts the client's own matter", async () => {
    const ownMatter = await createMatter(client);

    const res = await post('deposit', 50_000, { matterId: ownMatter });

    expect(res.status).toBe(201);
    expect(res.body.transaction.matterId).toBe(ownMatter);
  });
});

describe('an account that holds ledger history cannot change identity', () => {
  it('refuses a change of account type once an entry has been posted', async () => {
    expect((await post('deposit', 50_000)).status).toBe(201);

    const res = await owner.api.put(`${F()}/accounts/${accountId}`)
      .send({ accountType: 'separate_interest' });

    // Every posted entry was made into an IOLTA account. Flipping the type after
    // the fact rewrites what those entries mean, including who the interest on
    // them belongs to.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_ACCOUNT_HAS_HISTORY');
    expect((await accountRow(accountId)).account_type).toBe('iolta');
  });

  it('refuses a change of the bank account digits once an entry has been posted', async () => {
    expect((await post('deposit', 50_000)).status).toBe(201);

    const res = await owner.api.put(`${F()}/accounts/${accountId}`)
      .send({ accountNumberLast4: '9999' });

    expect(res.status).toBe(400);
    expect((await accountRow(accountId)).account_number_last4).toBe('1111');
  });

  it('still allows renaming the account and correcting the bank name', async () => {
    expect((await post('deposit', 50_000)).status).toBe(201);

    const res = await owner.api.put(`${F()}/accounts/${accountId}`)
      .send({ name: 'Primary IOLTA (Wells Fargo)', bankName: 'Wells Fargo' });

    // A label is not an identity. Blocking a rename would make a typo in the
    // account name permanent for the life of the firm.
    expect(res.status).toBe(200);
    expect((await accountRow(accountId)).name).toBe('Primary IOLTA (Wells Fargo)');
  });

  it('still allows setting the type on an account with no history yet', async () => {
    const res = await owner.api.put(`${F()}/accounts/${accountId}`)
      .send({ accountType: 'trust' });

    expect(res.status).toBe(200);
    expect((await accountRow(accountId)).account_type).toBe('trust');
  });
});

describe('the check register refuses a duplicate check number', () => {
  it('refuses a second check with a reference number already used in the account', async () => {
    expect((await post('deposit', 100_000)).status).toBe(201);
    expect((await post('withdrawal', 10_000, {
      source: 'check', referenceNumber: '1042',
    })).status).toBe(201);

    const res = await post('withdrawal', 20_000, { source: 'check', referenceNumber: '1042' });

    // Two ledger rows claiming the same cheque number is the error a bar
    // examiner finds by reading the register, and `reference_number` is free
    // text with nothing else watching it.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_DUPLICATE_CHECK_NUMBER');
  });

  it('allows the same reference number in a different account', async () => {
    expect((await post('deposit', 100_000)).status).toBe(201);
    expect((await post('withdrawal', 10_000, {
      source: 'check', referenceNumber: '1042',
    })).status).toBe(201);

    const otherAccountId = await createAccount('Secondary IOLTA', '2222');
    const seed = await owner.api.post(`${F()}/transactions`).send({
      trustAccountId: otherAccountId, type: 'deposit', amountCents: 100_000,
      clientId: client.id, clientName: 'Trust Client', date: '2026-03-15',
    });
    expect(seed.status).toBe(201);

    const res = await owner.api.post(`${F()}/transactions`).send({
      trustAccountId: otherAccountId, type: 'withdrawal', amountCents: 10_000,
      clientId: client.id, clientName: 'Trust Client', date: '2026-03-15',
      source: 'check', referenceNumber: '1042',
    });

    // Cheque numbers run per chequebook, so the same number in a different
    // bank account is normal, not a duplicate.
    expect(res.status).toBe(201);
  });

  it('does not treat a reused wire reference as a duplicate cheque', async () => {
    expect((await post('deposit', 100_000)).status).toBe(201);
    expect((await post('withdrawal', 10_000, {
      source: 'wire', referenceNumber: 'REF-1',
    })).status).toBe(201);

    const res = await post('withdrawal', 20_000, { source: 'wire', referenceNumber: 'REF-1' });

    // The register rule is about cheques. Applying it to every source would
    // reject legitimately repeated bank references.
    expect(res.status).toBe(201);
  });

  it('ignores a voided cheque when judging the duplicate', async () => {
    expect((await post('deposit', 100_000)).status).toBe(201);
    const first = await post('withdrawal', 10_000, { source: 'check', referenceNumber: '1042' });
    expect(first.status).toBe(201);
    expect((await owner.api.patch(`${F()}/transactions/${first.body.transaction.id}/void`)
      .send({ voidReason: 'spoiled cheque' })).status).toBe(200);

    const res = await post('withdrawal', 20_000, { source: 'check', referenceNumber: '1042' });

    // A spoiled cheque that was voided releases its number. Holding the number
    // forever would force the firm to skip one on every mistake.
    expect(res.status).toBe(201);
  });
});

describe('moving trust money to operating needs a bill behind it', () => {
  it('refuses an operating transfer with no invoice while the setting is off', async () => {
    expect((await post('deposit', 100_000)).status).toBe(201);

    const res = await post('transfer', 40_000, { transferTo: 'operating' });

    // Taking a fee out of trust without a bill is the violation the setting was
    // added to express. It defaulted to false and enforced nothing.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_FEE_REQUIRES_INVOICE');
  });

  it('accepts an operating transfer that names the invoice it pays', async () => {
    expect((await post('deposit', 100_000)).status).toBe(201);
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 40_000 });

    const res = await post('transfer', 40_000, {
      transferTo: 'operating', invoiceId: invoice.id,
    });

    expect(res.status).toBe(201);
  });

  it('accepts an unbilled operating transfer once the firm opts in', async () => {
    expect((await post('deposit', 100_000)).status).toBe(201);
    const settings = await owner.api.put(`${F()}/settings`)
      .send({ flatFeeToOperatingAllowed: true });
    expect(settings.status).toBe(200);

    const res = await post('transfer', 40_000, { transferTo: 'operating' });

    // Some jurisdictions permit an earned flat fee to move without a separate
    // invoice. The setting is the firm asserting its jurisdiction allows it.
    expect(res.status).toBe(201);
  });

  it('does not apply the rule to a transfer between two trust accounts', async () => {
    expect((await post('deposit', 100_000)).status).toBe(201);
    const otherAccountId = await createAccount('Secondary IOLTA', '2222');

    const res = await post('transfer', 40_000, { transferToAccountId: otherAccountId });

    // Trust to trust is not a fee. The money is still the client's.
    expect(res.status).toBe(201);
  });
});
