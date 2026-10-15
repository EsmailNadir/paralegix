/**
 * Sending, chasing and exporting a MATTER invoice follow the matter's wall.
 *
 * `billing.manageInvoices` says a member may manage invoices; it does not say
 * which matters. Every other invoice write authorizes the matter
 * (`authorizeContext`, write mode = matter membership). These four routes did
 * not, so a member walled off a matter could email its bill (freezing the
 * bill-to record), chase its client, or download its LEDES file.
 *
 * Write gate (membership) for the sends; read gate for LEDES, which lets an
 * owner or firm admin read any matter's billing, as the invoice reads do.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  sentEmails,
  recipientsOf,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';
import { installEmailCapture } from '../support/email.mock';
import { installInMemoryBucket, objects, pathsUnder } from '../support/inMemoryBucket';

installEmailCapture();
installInMemoryBucket();

const CLIENT_EMAIL = 'walled@client.test';

let firm: Firm;
let owner: Actor;
let insider: Actor;
let outsider: Actor;
let client: ClientRecord;
let matterId: string;
let invoiceId: string;
let previousKillSwitch: string | undefined;

const onInvoice = (suffix: string, id = invoiceId, matter = matterId) =>
  `/api/lawfirms/${firm.id}/billing/invoices/matter/${matter}/${id}${suffix}`;

async function seedMatterInvoice(matter: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into invoices (id, law_firm_id, matter_id, client_id, context_type, invoice_number, invoice_name,
        status, total_cents, invoice_date, due_date, client_email, client_name)
     values ($1, $2, $3, $4, 'matter', $5, $5, 'overdue', 75000, current_date - 40, current_date - 10, $6, 'Walled Client')`,
    [id, firm.id, matter, client.id, `INV-${id.slice(0, 8)}`, CLIENT_EMAIL],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function reminderRows(id = invoiceId) {
  const { rows } = await testPool.query('select sent_count from reminders where invoice_id = $1', [id]);
  return rows;
}

async function snapshotAt(id = invoiceId) {
  const { rows } = await testPool.query('select billing_snapshot_at from invoices where id = $1', [id]);
  return rows[0].billing_snapshot_at;
}

beforeEach(async () => {
  previousKillSwitch = process.env.DISABLE_ALL_REMINDER_EMAILS;
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  objects.clear();
  firm = await createFirm({ name: 'Wall LLP' });
  owner = await ownerOf(firm.id);
  insider = await memberWith(firm.id, ['billing.manageInvoices']);
  outsider = await memberWith(firm.id, ['billing.manageInvoices']);
  client = await createPersonClient(firm.id, { name: 'Walled Client', email: CLIENT_EMAIL });
  // The owner is deliberately NOT on this matter: it is what separates the
  // write gate (sends) from the read gate (LEDES) below.
  matterId = await seedMatter(firm.id, { memberUids: [insider.uid], clientIds: [client.id] });
  invoiceId = await seedMatterInvoice(matterId);
});

afterEach(() => {
  if (previousKillSwitch === undefined) delete process.env.DISABLE_ALL_REMINDER_EMAILS;
  else process.env.DISABLE_ALL_REMINDER_EMAILS = previousKillSwitch;
});

describe('send-reminder', () => {
  /** RED IF the route authorizes only the permission: the outsider gets 200 and the client is mailed. */
  it('refuses a permissioned member who is not on the matter, and mails nobody', async () => {
    const res = await outsider.api.post(onInvoice('/send-reminder')).send({});

    expect(res.status).toBe(403);
    expect(sentEmails()).toHaveLength(0);
    expect(await reminderRows()).toEqual([]);
  });

  it('refuses the firm owner who is not on the matter (a send is a write)', async () => {
    const res = await owner.api.post(onInvoice('/send-reminder')).send({});

    expect(res.status).toBe(403);
    expect(sentEmails()).toHaveLength(0);
  });

  it('refuses the owner of another firm', async () => {
    const otherOwner = await ownerOf((await createFirm({ name: 'Other LLP' })).id);

    const res = await otherOwner.api.post(onInvoice('/send-reminder')).send({});

    expect(res.status).toBe(403);
    expect(sentEmails()).toHaveLength(0);
  });

  it('sends for a member on the matter, and records it', async () => {
    const res = await insider.api.post(onInvoice('/send-reminder')).send({});

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(recipientsOf(/past due/)).toEqual([CLIENT_EMAIL]);
    expect(await reminderRows()).toEqual([{ sent_count: 1 }]);
  });
});

describe('send-email', () => {
  /** RED IF unauthorized: 200, a mail goes out, and the bill-to snapshot is frozen by the wrong person. */
  it('refuses a member who is not on the matter, mails nobody and freezes nothing', async () => {
    const res = await outsider.api.post(onInvoice('/send-email')).send({ recipientEmail: 'ap@client.test' });

    expect(res.status).toBe(403);
    expect(sentEmails()).toHaveLength(0);
    expect(await snapshotAt()).toBeNull();
  });

  it('sends for a member on the matter and issues the invoice', async () => {
    const res = await insider.api.post(onInvoice('/send-email')).send({ recipientEmail: 'ap@client.test' });

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(recipientsOf(/./).sort()).toEqual(['ap@client.test', CLIENT_EMAIL].sort());
    expect(await snapshotAt()).toBeInstanceOf(Date);
  });
});

describe('send-email-init', () => {
  const prefix = () => `lawfirmids/${firm.id}/invoice-outgoing/${invoiceId}/`;

  /** RED IF the upload is opened for anyone holding the permission. */
  it('opens no upload for a member who is not on the matter', async () => {
    const res = await outsider.api.post(onInvoice('/send-email-init')).send({ fileName: 'x.pdf', size: 10 });

    expect(res.status).toBe(403);
    expect(res.body.uploadUrl).toBeUndefined();
    expect(pathsUnder(prefix())).toEqual([]);
  });

  it('refuses an invoice id that is not on this matter', async () => {
    const res = await insider.api.post(onInvoice('/send-email-init', randomUUID())).send({ fileName: 'x.pdf', size: 10 });

    expect(res.status).toBe(404);
  });

  it('opens the upload for a member on the matter', async () => {
    const res = await insider.api.post(onInvoice('/send-email-init')).send({ fileName: 'x.pdf', size: 10 });

    expect(res.status).toBe(200);
    expect(res.body.objectPath.startsWith(prefix())).toBe(true);
  });
});

describe('LEDES export', () => {
  /** RED IF unauthorized: 200 with the full LEDES body. */
  it('refuses a member who is not on the matter and returns no file', async () => {
    const res = await outsider.api.get(onInvoice('/export/ledes'));

    expect(res.status).toBe(403);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.text).not.toContain('LEDES1998B');
  });

  it('exports for a member on the matter', async () => {
    const res = await insider.api.get(onInvoice('/export/ledes'));

    expect(res.status).toBe(200);
    expect(res.text.startsWith('LEDES1998B[]')).toBe(true);
  });

  it('exports for the firm owner who is not on the matter (read gate)', async () => {
    const res = await owner.api.get(onInvoice('/export/ledes'));

    expect(res.status).toBe(200);
    expect(res.text.startsWith('LEDES1998B[]')).toBe(true);
  });
});
