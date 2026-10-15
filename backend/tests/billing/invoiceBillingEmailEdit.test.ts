/**
 * Correcting the billing email on an issued invoice.
 *
 * An invoice freezes who it is billed to the first time it goes out, and every
 * reminder, payment link and receipt reads that frozen list. When the firm
 * learns the address was wrong, this is how it fixes it. Nothing here is
 * visible as a wrong screen: a write to the wrong firm's invoice, or one that
 * leaves the old address in the list, quietly mails a client's bill to a
 * stranger. So each case reads the stored list back.
 */
import {
  testPool,
  createFirm,
  createOrgClient,
  createPersonClient,
  linkPersonToOrg,
  createInvoice,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

const url = (clientId: string, invoiceId: string, lawFirmId = firm.id) =>
  `/api/lawfirms/${lawFirmId}/billing/invoices/client/${clientId}/${invoiceId}/billing-email`;

/** An invoice already issued to `emails`, as its first send would freeze it. */
async function issuedInvoice(clientId: string, emails: string[]) {
  const invoice = await createInvoice(firm.id, clientId, { totalCents: 250_00 });
  const res = await testPool.query(
    `update invoices
        set billing_emails = $2::text[], billing_contact_email = $3, billing_snapshot_at = now()
      where id = $1`,
    [invoice.id, emails, emails[0] ?? null],
  );
  expect(res.rowCount).toBe(1);
  return invoice.id;
}

async function billedTo(invoiceId: string) {
  const { rows } = await testPool.query(
    'select billing_emails, billing_contact_email from invoices where id = $1', [invoiceId],
  );
  return { emails: rows[0].billing_emails, primary: rows[0].billing_contact_email };
}

it('refuses the owner of another firm and leaves the invoice billed as it was', async () => {
  const client = await createPersonClient(firm.id, { email: 'old@example.test' });
  const invoiceId = await issuedInvoice(client.id, ['old@example.test']);
  const outsider = await ownerOf((await createFirm()).id);

  const res = await outsider.api.put(url(client.id, invoiceId)).send({ emails: ['attacker@example.test'] });

  expect(res.status).toBe(403);
  expect(await billedTo(invoiceId)).toEqual({ emails: ['old@example.test'], primary: 'old@example.test' });
});

it('refuses a member who cannot manage invoices', async () => {
  const client = await createPersonClient(firm.id, { email: 'old@example.test' });
  const invoiceId = await issuedInvoice(client.id, ['old@example.test']);
  const member = await memberWith(firm.id, ['billing.viewInvoices']);

  const res = await member.api.put(url(client.id, invoiceId)).send({ emails: ['new@example.test'] });

  expect(res.status).toBe(403);
  expect((await billedTo(invoiceId)).emails).toEqual(['old@example.test']);
});

it('replaces the wrong address, leaving the client record alone', async () => {
  const client = await createPersonClient(firm.id, { email: 'old@example.test' });
  const invoiceId = await issuedInvoice(client.id, ['old@example.test']);

  const res = await owner.api.put(url(client.id, invoiceId)).send({ emails: ['  New@Example.test '] });

  expect(res.status).toBe(200);
  // Breaks if the new address is added beside the old one: the wrong person
  // would keep getting the bill.
  // Trimmed, with the case kept, as every other billing address is stored.
  expect(await billedTo(invoiceId)).toEqual({ emails: ['New@Example.test'], primary: 'New@Example.test' });
  expect(res.body.billingRecipients.emails).toEqual(['New@Example.test']);
  const { rows } = await testPool.query('select email from clients where id = $1', [client.id]);
  expect(rows[0].email).toBe('old@example.test');
});

it('sets a company invoice to exactly the list given, and records who changed it', async () => {
  const org = await createOrgClient(firm.id);
  const person = await createPersonClient(firm.id, { email: 'ap@acme.example.test' });
  await linkPersonToOrg(firm.id, person.id, org.id, { canViewBilling: true, isEmailRecipient: true });
  const invoiceId = await issuedInvoice(org.id, ['ap@acme.example.test']);

  const res = await owner.api.put(url(org.id, invoiceId))
    .send({ emails: ['billing@acme.example.test', 'cfo@acme.example.test'] });

  expect(res.status).toBe(200);
  expect((await billedTo(invoiceId)).emails).toEqual(['billing@acme.example.test', 'cfo@acme.example.test']);
  const { rows } = await testPool.query(
    `select actor_uid, metadata from audit_events
      where law_firm_id = $1 and action = 'invoice.billing_recipients.edited' and resource_id = $2`,
    [firm.id, invoiceId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].actor_uid).toBe(owner.uid);
  expect(rows[0].metadata).toMatchObject({
    previousEmails: ['ap@acme.example.test'],
    newEmails: ['billing@acme.example.test', 'cfo@acme.example.test'],
  });
});

it('rejects something that is not an email address', async () => {
  const client = await createPersonClient(firm.id, { email: 'old@example.test' });
  const invoiceId = await issuedInvoice(client.id, ['old@example.test']);

  const res = await owner.api.put(url(client.id, invoiceId)).send({ emails: ['not-an-email'] });

  expect(res.status).toBe(400);
  expect((await billedTo(invoiceId)).emails).toEqual(['old@example.test']);
});

it('rejects an empty list, because an invoice must go to someone', async () => {
  const client = await createPersonClient(firm.id, { email: 'old@example.test' });
  const invoiceId = await issuedInvoice(client.id, ['old@example.test']);

  const res = await owner.api.put(url(client.id, invoiceId)).send({ emails: [] });

  expect(res.status).toBe(400);
  expect((await billedTo(invoiceId)).emails).toEqual(['old@example.test']);
});

it('refuses a voided invoice', async () => {
  const client = await createPersonClient(firm.id, { email: 'old@example.test' });
  const invoiceId = await issuedInvoice(client.id, ['old@example.test']);
  await testPool.query(`update invoices set status = 'voided' where id = $1`, [invoiceId]);

  const res = await owner.api.put(url(client.id, invoiceId)).send({ emails: ['new@example.test'] });

  expect(res.status).toBe(409);
  expect((await billedTo(invoiceId)).emails).toEqual(['old@example.test']);
});
