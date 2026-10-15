/**
 * How the invoice PDF reaches the email.
 *
 * The browser renders the PDF, and it is used twice: attached to the message
 * and archived as the copy the client received. It used to arrive base64 inside
 * the JSON body, which is the most expensive possible shape for it. The
 * container held the raw request bytes, the string they arrived as and the
 * buffer they decoded to, all at once, on an instance with 512 MiB that serves
 * 80 concurrent requests and signs documents at the same time. The route needed
 * its own 50 MiB body ceiling to allow it, and that ceiling applied to any
 * caller with permission to email an invoice.
 *
 * It now goes to storage on its own leg and the send carries only its path.
 * That makes the path caller input which reaches an object read, mailed out and
 * archived under this invoice's name, so most of what follows is about refusing
 * a path that is not this invoice's own upload.
 */
import {
  createFirm,
  createInvoice,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installEmailCapture, resetEmails, sentEmails } from '../support/email.mock';
import { installInMemoryBucket, objects, putObject, pathsUnder } from '../support/inMemoryBucket';

installEmailCapture();
installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let clientId: string;
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices`;
const outgoing = (id = invoiceId, name = 'upload.pdf') =>
  `lawfirmids/${firm.id}/invoice-outgoing/${id}/${name}`;

const PDF = Buffer.from('%PDF-1.7\nthe rendered invoice\n%%EOF');

const init = (actor: Actor) =>
  actor.api.post(`${B()}/client/${clientId}/${invoiceId}/send-email-init`)
    .send({ fileName: 'INV-1.pdf', size: PDF.length });

const send = (actor: Actor, body: Record<string, unknown>) =>
  actor.api.post(`${B()}/client/${clientId}/${invoiceId}/send-email`)
    .send({ recipientEmail: 'billing@client.test', ...body });

/** An upload that has landed, stamped as this caller's the way storage does. */
function landed(path: string, body = PDF) {
  putObject(path, { body, contentType: 'application/pdf', custom: { uploadedBy: owner.uid } });
  return path;
}

beforeEach(async () => {
  objects.clear();
  resetEmails();
  firm = await createFirm({ name: 'Billing LLP' });
  owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Ada Client', email: 'ada@client.test' });
  clientId = client.id;
  ({ id: invoiceId } = await createInvoice(firm.id, clientId, {
    invoiceNumber: 'INV-1', status: 'outstanding',
  }));
});

describe('opening the upload', () => {
  it('hands back a session url rather than accepting the document', async () => {
    const res = await init(owner);

    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toEqual(expect.any(String));
    // Confined to this invoice's own working prefix. The finalize step checks
    // the path it is given against the same prefix, so an object opened
    // anywhere else could never be settled.
    expect(res.body.objectPath).toMatch(
      new RegExp(`^lawfirmids/${firm.id}/invoice-outgoing/${invoiceId}/[^/]+\\.pdf$`),
    );
  });

  it('opens nothing for someone outside the firm', async () => {
    const other = await ownerOf((await createFirm({ name: 'Other LLP' })).id);

    const res = await other.api.post(`${B()}/client/${clientId}/${invoiceId}/send-email-init`)
      .send({ fileName: 'x.pdf', size: 10 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(pathsUnder(`lawfirmids/${firm.id}/invoice-outgoing/`)).toEqual([]);
  });
});

describe('sending with the uploaded attachment', () => {
  it('attaches the bytes that landed in storage', async () => {
    const path = landed(outgoing());

    const res = await send(owner, { objectPath: path, pdfFileName: 'INV-1.pdf' });

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    // Read from storage, not from the request. An empty attachment list here
    // means the client received an email with no invoice in it.
    const [mail] = sentEmails();
    expect(mail.attachments).toHaveLength(1);
    const attached = (mail.attachments as any[])[0];
    expect(Buffer.from(attached.content).toString()).toBe(PDF.toString());
  });

  it('keeps the copy the client received', async () => {
    await send(owner, { objectPath: landed(outgoing()), pdfFileName: 'INV-1.pdf' });

    // The archive is the record of what was billed, and it is the whole reason
    // the bytes have to reach this process at all.
    const archived = pathsUnder(`lawfirmids/${firm.id}/invoices/${invoiceId}/`);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/sent-.*\.pdf$/);
  });

  it('drops the working copy once the mail has left', async () => {
    const path = landed(outgoing());

    await send(owner, { objectPath: path, pdfFileName: 'INV-1.pdf' });

    // The archived copy is the one that is kept. Leaving this one would store
    // every emailed invoice twice, for good.
    expect(objects.has(path)).toBe(false);
  });

  it('still sends without an attachment, as it always could', async () => {
    const res = await send(owner, {});

    expect(res.body.sent).toBe(true);
    expect(sentEmails()[0].attachments ?? []).toHaveLength(0);
  });
});

describe('the path is caller input', () => {
  it('refuses an object belonging to another invoice', async () => {
    const { id: otherInvoice } = await createInvoice(firm.id, clientId, {
      invoiceNumber: 'INV-2', status: 'outstanding',
    });
    const path = landed(outgoing(otherInvoice));

    const res = await send(owner, { objectPath: path });

    // Same firm, same permission, wrong record. Unchecked, this mails one
    // invoice's document out under another's name and archives it there.
    expect(res.status).toBe(400);
    expect(sentEmails()).toHaveLength(0);
  });

  it('refuses an object outside the working prefix entirely', async () => {
    const path = landed(`lawfirmids/${firm.id}/general/someone-elses-contract.pdf`);

    const res = await send(owner, { objectPath: path });

    expect(res.status).toBe(400);
    expect(sentEmails()).toHaveLength(0);
    // Refused, not consumed: a rejected path must not delete the object it named.
    expect(objects.has(path)).toBe(true);
  });

  it('refuses a name that climbs out of the prefix', async () => {
    const path = landed(`lawfirmids/${firm.id}/invoice-outgoing/${invoiceId}/nested/deep.pdf`);

    const res = await send(owner, { objectPath: path });

    expect(res.status).toBe(400);
    expect(sentEmails()).toHaveLength(0);
  });

  it('refuses an upload someone else left at this path', async () => {
    putObject(outgoing(), {
      body: PDF, contentType: 'application/pdf', custom: { uploadedBy: 'another-user' },
    });

    const res = await send(owner, { objectPath: outgoing() });

    expect(res.status).toBe(403);
    expect(sentEmails()).toHaveLength(0);
  });
});

describe('what may be attached', () => {
  it('refuses one over the cap without reading it', async () => {
    // Declared by storage rather than by the caller, and large enough that
    // reading it to find out would be the cost the cap exists to avoid.
    putObject(outgoing(), {
      bytes: 21 * 1024 * 1024,
      contentType: 'application/pdf',
      custom: { uploadedBy: owner.uid },
    });

    const res = await send(owner, { objectPath: outgoing() });

    expect(res.status).toBe(413);
    expect(sentEmails()).toHaveLength(0);
  });

  it('refuses something that is not a PDF', async () => {
    putObject(outgoing(), {
      body: Buffer.from('MZ'), contentType: 'application/x-msdownload',
      custom: { uploadedBy: owner.uid },
    });

    const res = await send(owner, { objectPath: outgoing() });

    expect(res.status).toBe(415);
    expect(sentEmails()).toHaveLength(0);
  });
});
