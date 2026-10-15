/**
 * A trust entry cannot name a voided invoice. The ledger is append-only, so a
 * fee transfer linked to a cancelled bill could never be unlinked, and the
 * invoice side already refuses to take a trust payment once it is voided.
 *
 * All amounts are CENTS.
 */
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

const post = (type: string, amountCents: number, extra: Record<string, unknown> = {}) =>
  postTrustTxn(owner, firm.id, { trustAccountId: accountId, clientId: client.id, type, amountCents, ...extra });

const txnCount = async () => {
  const { rows } = await testPool.query(
    'select count(*)::int as n from trust_transactions where law_firm_id = $1', [firm.id],
  );
  return rows[0].n as number;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Trust Client' });
  accountId = await createTrustAccount(owner, firm.id);
  expect((await post('deposit', 100_000)).status).toBe(201);
});

describe('linking a trust entry to an invoice', () => {
  it('refuses a voided invoice with a 409 and writes no ledger row', async () => {
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 40_000, status: 'voided' });
    const before = await txnCount();

    const res = await post('transfer', 40_000, { transferTo: 'operating', invoiceId: invoice.id });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(res.body.error).toMatch(/voided/);
    expect(await txnCount()).toBe(before);
  });

  it('still links a live invoice', async () => {
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 40_000 });

    const res = await post('transfer', 40_000, { transferTo: 'operating', invoiceId: invoice.id });

    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      'select invoice_id from trust_transactions where id = $1', [res.body.transaction.id],
    );
    expect(rows[0].invoice_id).toBe(invoice.id);
  });

  it('still refuses another firm\'s invoice', async () => {
    const otherFirm = await createFirm();
    const otherClient = await createPersonClient(otherFirm.id, { name: 'Elsewhere' });
    const foreign = await createInvoice(otherFirm.id, otherClient.id, { totalCents: 40_000 });
    const before = await txnCount();

    const res = await post('withdrawal', 40_000, { invoiceId: foreign.id });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_INVOICE_NOT_FOUND');
    expect(await txnCount()).toBe(before);
  });
});
