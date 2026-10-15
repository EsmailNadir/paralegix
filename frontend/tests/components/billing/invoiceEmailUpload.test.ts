/**
 * Emailing an invoice, with the PDF going straight to storage.
 *
 * The rendered PDF used to be base64 inside the request body. That cost the API
 * container the raw bytes, the string they arrived as and the buffer they
 * decoded to, all at once, and it needed a 50 MiB body ceiling to be allowed at
 * all. It cost this tab too: building the string walked the document one byte at
 * a time through a growing string.
 *
 * Three properties are pinned here, and none of them is visible from the page:
 *
 *   No document travels in the request body. What the send carries is a path.
 *
 *   The storage request must NOT carry the API credential. The session url is
 *   already the authorization, and sending a bearer token to a storage host
 *   widens where that credential has been.
 *
 *   The send must not run when the upload failed. Reached anyway it emails an
 *   invoice with no attachment and archives nothing as the copy the client
 *   received, while reporting success.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { installXhrMock, type XhrMock } from '../../support/xhrMock';
import billingService from '@/services/billing.service';

const FIRM = 'firm-1';
const CLIENT = 'client-1';
const INVOICE = 'invoice-1';
const OBJECT_PATH = `lawfirmids/${FIRM}/invoice-outgoing/${INVOICE}/abc.pdf`;
const SESSION_URL = 'https://storage.googleapis.com/upload/invoice-session';
const BASE = `/billing/invoices/client/${CLIENT}/${INVOICE}`;

const context = { type: 'client' as const, lawFirmId: FIRM, entityId: CLIENT };

let api: ApiMock;
let xhr: XhrMock;

const pdfFile = (size = 4096) => {
  const file = new File([new Uint8Array(size)], 'INV-1.pdf', { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

const sendIt = (pdf = pdfFile()) => billingService.sendInvoiceEmail(context, INVOICE, {
  recipientEmail: 'billing@client.test',
  recipientName: 'Ada Client',
  pdf,
});

beforeEach(() => {
  api = installApiMock();
  xhr = installXhrMock();
});

afterEach(() => {
  api.restore();
  xhr.restore();
});

function arrangeSuccess() {
  api.post(`${BASE}/send-email-init`, { uploadUrl: SESSION_URL, objectPath: OBJECT_PATH });
  xhr.onExact('PUT', SESSION_URL, { status: 200 });
  api.post(`${BASE}/send-email`, { sent: true, to: ['billing@client.test'] });
}

describe('emailing an invoice', () => {
  it('reports what the server said about the send', async () => {
    arrangeSuccess();

    const result = await sendIt();

    expect(result).toMatchObject({ sent: true, to: ['billing@client.test'] });
  });

  it('declares the type and size before asking for a session', async () => {
    arrangeSuccess();

    await sendIt(pdfFile(9000));

    // The server refuses an oversized attachment here, which saves uploading
    // bytes it is going to throw away.
    const [init] = api.callsTo(`${BASE}/send-email-init`);
    expect(init.body).toMatchObject({
      contentType: 'application/pdf', fileName: 'INV-1.pdf', size: 9000,
    });
  });

  it('sends the document to storage, not through the API', async () => {
    arrangeSuccess();

    await sendIt();

    expect(xhr.calls().some((c) => c.url === SESSION_URL && c.method === 'PUT')).toBe(true);
  });

  it('puts no document in the request body', async () => {
    arrangeSuccess();

    await sendIt();

    // The whole point. A `pdfBase64` here is the document in the JSON body
    // again, and every byte of it resident in the API three times over.
    const [send] = api.callsTo(`${BASE}/send-email`);
    expect(send.body).not.toHaveProperty('pdfBase64');
    expect(JSON.stringify(send.body).length).toBeLessThan(1000);
  });

  it('names the object the server chose', async () => {
    arrangeSuccess();

    await sendIt();

    const [send] = api.callsTo(`${BASE}/send-email`);
    expect(send.body).toMatchObject({
      objectPath: OBJECT_PATH,
      recipientEmail: 'billing@client.test',
      pdfFileName: 'INV-1.pdf',
    });
  });

  it('does not attach the API credential to the storage request', async () => {
    arrangeSuccess();

    await sendIt();

    const put = xhr.calls().find((c) => c.url === SESSION_URL);
    const headers = Object.keys(put?.headers ?? {}).map((h) => h.toLowerCase());
    expect(headers).not.toContain('authorization');
  });
});

describe('when something goes wrong', () => {
  it('does not send an email for an upload that failed', async () => {
    // A 410 is the session being gone, which the uploader treats as terminal.
    api.post(`${BASE}/send-email-init`, { uploadUrl: SESSION_URL, objectPath: OBJECT_PATH });
    xhr.onExact('PUT', SESSION_URL, { status: 410 });
    api.allowUnhandled();

    await expect(sendIt()).rejects.toThrow();

    expect(api.callsTo(`${BASE}/send-email`)).toEqual([]);
  });

  it('surfaces a permission refusal without uploading anything', async () => {
    api.post(`${BASE}/send-email-init`, {
      status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' },
    });

    await expect(sendIt()).rejects.toThrow();

    expect(xhr.calls()).toEqual([]);
  });
});
