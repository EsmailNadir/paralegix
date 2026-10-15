/**
 * Downloading a preserved copy of a sent invoice.
 *
 * The route used to read the whole PDF out of storage and send it as the
 * response body, so every download put a document in a 512 MiB container that
 * serves eighty concurrent requests and signs documents. Reads are far more
 * frequent than uploads, so this is the direction that carries the most traffic.
 *
 * It hands out a short-lived signed url instead, which the browser fetches
 * directly. That makes the url a bearer credential, and the cases below are
 * mostly about that:
 *
 *   It is minted only AFTER the same authorization the route already did.
 *   Otherwise it is a way to read an invoice a caller may not see.
 *
 *   It is short-lived. The old response was authorized per request; a long url
 *   outlives the permission that produced it.
 *
 *   The name is confined to the invoice's own archive prefix, so a traversing
 *   name cannot reach another record's artifacts.
 *
 * The filename the user sees has to survive too. It is set on the signed url
 * now, not on a response the browser no longer receives.
 */
import {
  createFirm,
  createInvoice,
  createPersonClient,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects, putObject } from '../support/inMemoryBucket';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let outsider: Actor;
let invoiceId: string;
let clientId: string;

const COPY = 'sent-2026-03-15T10-00-00.pdf';
const B = () => `/api/lawfirms/${firm.id}/billing/invoices`;

const archivePath = (id: string, name: string) =>
  `lawfirmids/${firm.id}/invoices/${id}/${name}`;

const fetchCopy = (actor: Actor, id = invoiceId, name = COPY) =>
  actor.api.get(`${B()}/${id}/sent-copies/${encodeURIComponent(name)}`);

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Billing LLP' });
  owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Ada Client' });
  clientId = client.id;

  ({ id: invoiceId } = await createInvoice(firm.id, clientId, { invoiceNumber: 'INV-1', status: 'outstanding' }));

  const other = await createFirm({ name: 'Other LLP' });
  outsider = await ownerOf(other.id);

  putObject(archivePath(invoiceId, COPY), { bytes: 4096, contentType: 'application/pdf' });
});

describe('what the route answers with', () => {
  it('hands back a url rather than the document itself', async () => {
    const res = await fetchCopy(owner);

    expect(res.status).toBe(200);
    // A PDF body here is the whole file resident in the container. The point of
    // the change is that the bytes go storage to browser.
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.signedUrl).toEqual(expect.any(String));
  });

  it('keeps the filename the user sees', async () => {
    const res = await fetchCopy(owner);

    // Set on the signed url now, because there is no response for the browser
    // to read a Content-Disposition from. Losing it saves the file under the
    // storage object's own opaque name.
    expect(res.body.fileName).toMatch(/^Invoice INV-1 - sent 2026-03-15\.pdf$/);
  });

  it('reports the size, so the client can show it before fetching', async () => {
    const res = await fetchCopy(owner);

    expect(res.body.size).toBe(4096);
  });
});

describe('the url is a credential', () => {
  it('is not minted for a caller who may not read the invoice', async () => {
    // The old response was authorized per request. A url handed out first and
    // checked afterwards is a way to read an invoice this caller cannot see.
    const res = await fetchCopy(outsider);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.signedUrl).toBeUndefined();
  });

  it('is not minted for someone with no membership at all', async () => {
    // The widest audience that lacks `billing.viewInvoices`: anyone outside the
    // firm. A member with an empty role is the next case down.
    const { stranger } = await import('../support/setupInProcess');
    const nobody = stranger();

    const res = await fetchCopy(nobody);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.signedUrl).toBeUndefined();
  });

  it('is not minted for a firm member whose role grants nothing', async () => {
    // Financial reads need an explicit grant; membership alone is not enough.
    const { memberWith } = await import('../support/setupInProcess');
    const member = await memberWith(firm.id, []);

    const res = await fetchCopy(member);

    expect(res.status).toBe(403);
    expect(res.body.signedUrl).toBeUndefined();
  });

  it('expires quickly', async () => {
    const res = await fetchCopy(owner);

    // A long-lived url outlives the permission that produced it. An hour is the
    // ceiling used everywhere else a stored document is handed out.
    const ttlMs = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

describe('which artifact it will reach', () => {
  it('refuses a name that tries to climb out of the invoice archive', async () => {
    // The name is a path segment. Unconfined it reads another record's
    // artifacts, including another firm's.
    const res = await fetchCopy(owner, invoiceId, '../../signatures/other/secret.pdf');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.signedUrl).toBeUndefined();
  });

  it('answers 404 for a copy that was never archived', async () => {
    const res = await fetchCopy(owner, invoiceId, 'sent-1999-01-01T00-00-00.pdf');

    expect(res.status).toBe(404);
  });

  it('will not reach another invoice archive', async () => {
    const { id: otherInvoice } = await createInvoice(firm.id, clientId, { invoiceNumber: 'INV-2', status: 'outstanding' });
    putObject(archivePath(otherInvoice, COPY), { bytes: 10, contentType: 'application/pdf' });

    const res = await fetchCopy(owner, invoiceId, COPY);

    // The url must name THIS invoice's object. Both exist, so a path built from
    // the name alone would resolve to whichever was written last.
    expect(res.body.signedUrl).toContain(encodeURIComponent(archivePath(invoiceId, COPY)));
  });
});
