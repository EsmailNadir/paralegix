/**
 * The client portal's upload routes and the firm's storage quota.
 *
 * Three portal flows open direct uploads: documents into a matter, documents
 * that fulfil a request checklist item, and message attachments. Each init
 * holds its declared bytes as reservations, and each now has a cancel that
 * frees them at once. The two document flows also claim file ROWS, so their
 * cancel removes the unfinalized rows the caller claimed, in the scope the
 * request authorizes, and nothing else: a client cannot reach another client's
 * upload or any document that already landed.
 *
 * The last group is about the notification. The portal caps one init at ten
 * files, so a larger selection opens several inits and finalizes them in ONE
 * call, which is what makes the firm hear about one upload once.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  as,
  tokenFor,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects, landUpload } from '../support/inMemoryBucket';
import { PDF_HEAD } from '../support/portalUpload';
import { seedMatter } from '../files/fileWorld';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let client: Actor;
let clientRecordId: string;
let matterId: string;

const P = () => `/api/client-portal/lawfirm/${firm.id}`;
const matterDocs = (m = matterId) => `${P()}/matters/${m}/documents`;

const declared = (name: string, size = 1024) => ({ fileName: name, contentType: 'application/pdf', size });
const echo = (u: any) => ({ fileId: u.fileId, objectPath: u.objectPath, reservationId: u.reservationId });
const landAll = (uploads: any[]) => uploads.forEach((u) => landUpload(u.objectPath, {
  bytes: 1024, contentType: 'application/pdf', head: PDF_HEAD,
}));

async function held(): Promise<number> {
  const { rows } = await testPool.query(
    `select coalesce(sum(bytes), 0)::bigint as held from storage_reservations
      where law_firm_id = $1 and expires_at > now()`, [firm.id],
  );
  return Number(rows[0].held);
}

async function fileRowCount(): Promise<number> {
  const { rows } = await testPool.query(
    `select count(*)::int as n from files where law_firm_id = $1 and kind = 'file'`, [firm.id],
  );
  return rows[0].n;
}

async function newPortalClient(name: string): Promise<{ actor: Actor; recordId: string }> {
  const portal = await createPortalUser({ name });
  const record = await createPersonClient(firm.id, { name, userId: portal.uid });
  await testPool.query(
    'insert into matter_clients (law_firm_id, matter_id, client_id) values ($1, $2, $3) on conflict do nothing',
    [firm.id, matterId, record.id],
  );
  return { actor: { uid: portal.uid, api: as(tokenFor({ uid: portal.uid })) }, recordId: record.id };
}

async function seedRequestItem(): Promise<{ requestId: string; itemId: string }> {
  const requestId = randomUUID();
  await testPool.query(
    `insert into document_requests (id, law_firm_id, matter_id, client_id, title, status)
     values ($1, $2, $3, $4, 'Tax documents', 'open')`,
    [requestId, firm.id, matterId, clientRecordId],
  );
  const itemId = randomUUID();
  await testPool.query(
    `insert into document_request_items (id, law_firm_id, request_id, label, sort_order)
     values ($1, $2, $3, 'Receipts', 0)`,
    [itemId, firm.id, requestId],
  );
  return { requestId, itemId };
}

const notificationCount = async () => {
  const { rows } = await testPool.query(
    `select count(*)::int as n from notifications
      where law_firm_id = $1 and user_id = $2 and type = 'document_uploaded'`,
    [firm.id, owner.uid],
  );
  return rows[0].n;
};

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Portal Cancel LLP' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Ellis v. Hart');
  const me = await newPortalClient('Ada Client');
  client = me.actor;
  clientRecordId = me.recordId;
  await drainEvents();
});

describe('cancelling a matter document upload', () => {
  it('frees the quota and the claimed rows', async () => {
    const opened = await client.api.post(`${matterDocs()}/upload-init`)
      .send({ files: [declared('receipt.pdf', 5_000), declared('invoice.pdf', 3_000)] });
    expect(await held()).toBe(8_000);
    landAll(opened.body.uploads.slice(0, 1));

    const res = await client.api.post(`${matterDocs()}/upload-cancel`)
      .send({ uploads: opened.body.uploads.map(echo) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: 2 });
    expect(await held()).toBe(0);
    expect(await fileRowCount()).toBe(0);
    expect(objects.has(opened.body.uploads[0].objectPath)).toBe(false);

    // The name is free at once, so a retry does not land as "receipt (1).pdf".
    const retry = await client.api.post(`${matterDocs()}/upload-init`).send({ files: [declared('receipt.pdf')] });
    const { rows } = await testPool.query('select name from files where id = $1', [retry.body.uploads[0].fileId]);
    expect(rows[0].name).toBe('receipt.pdf');
  });

  it('never removes a document that already landed', async () => {
    const opened = await client.api.post(`${matterDocs()}/upload-init`).send({ files: [declared('kept.pdf')] });
    landAll(opened.body.uploads);
    await client.api.post(`${matterDocs()}/upload-finalize`).send({ uploads: opened.body.uploads });

    const res = await client.api.post(`${matterDocs()}/upload-cancel`)
      .send({ uploads: opened.body.uploads.map(echo) });

    expect(res.body).toEqual({ cancelled: 0 });
    expect(await fileRowCount()).toBe(1);
    expect(objects.has(opened.body.uploads[0].objectPath)).toBe(true);
  });

  it('does not let another client of the matter cancel your upload', async () => {
    const other = await newPortalClient('Bob Client');
    const opened = await client.api.post(`${matterDocs()}/upload-init`).send({ files: [declared('mine.pdf')] });
    landAll(opened.body.uploads);

    const res = await other.actor.api.post(`${matterDocs()}/upload-cancel`)
      .send({ uploads: opened.body.uploads.map(echo) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: 0 });
    expect(await held()).toBe(1024);
    expect(await fileRowCount()).toBe(1);
    expect(objects.has(opened.body.uploads[0].objectPath)).toBe(true);
  });

  it('refuses a matter this client is not on', async () => {
    const otherMatter = await seedMatter(firm.id, owner.uid, 'Someone Else');
    const opened = await client.api.post(`${matterDocs()}/upload-init`).send({ files: [declared('mine.pdf')] });

    const res = await client.api.post(`${matterDocs(otherMatter)}/upload-cancel`)
      .send({ uploads: opened.body.uploads.map(echo) });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await fileRowCount()).toBe(1);
  });

  it('refuses a client of another firm', async () => {
    const opened = await client.api.post(`${matterDocs()}/upload-init`).send({ files: [declared('mine.pdf')] });
    const away = await createFirm();
    const awayPortal = await createPortalUser({ name: 'Outsider' });
    await createPersonClient(away.id, { name: 'Outsider', userId: awayPortal.uid });
    const outsider = as(tokenFor({ uid: awayPortal.uid }));

    const res = await outsider.post(`${matterDocs()}/upload-cancel`).send({ uploads: opened.body.uploads.map(echo) });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await held()).toBe(1024);
    expect(await fileRowCount()).toBe(1);
  });
});

describe('cancelling a request item upload', () => {
  it('frees the quota and the claimed rows', async () => {
    const { requestId, itemId } = await seedRequestItem();
    const url = `${P()}/document-requests/${requestId}/items/${itemId}/fulfill`;
    const opened = await client.api.post(`${url}/upload-init`).send({ files: [declared('w2.pdf', 2_000)] });
    expect(await held()).toBe(2_000);

    const res = await client.api.post(`${url}/upload-cancel`).send({ uploads: opened.body.uploads.map(echo) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: 1 });
    expect(await held()).toBe(0);
    expect(await fileRowCount()).toBe(0);
  });
});

describe('cancelling a portal message attachment', () => {
  it('frees the quota and removes the partial object', async () => {
    const url = `${P()}/messages/attachments`;
    const opened = await client.api.post(`${url}/upload-init`).send({ files: [declared('photo.pdf', 3_000)] });
    expect(await held()).toBe(3_000);
    landAll(opened.body.uploads);

    const res = await client.api.post(`${url}/upload-cancel`).send({ uploads: opened.body.uploads.map(echo) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: 1 });
    expect(await held()).toBe(0);
    expect(objects.has(opened.body.uploads[0].objectPath)).toBe(false);
  });
});

describe('a selection larger than one init', () => {
  /** Twelve files opened as an init of ten and an init of two, the way the portal does it. */
  async function openTwelve(url: string) {
    const names = Array.from({ length: 12 }, (_, i) => declared(`scan-${i}.pdf`));
    const first = await client.api.post(`${url}/upload-init`).send({ files: names.slice(0, 10) });
    const second = await client.api.post(`${url}/upload-init`).send({ files: names.slice(10) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const uploads = [...first.body.uploads, ...second.body.uploads];
    landAll(uploads);
    return uploads;
  }

  it('finalizes a matter upload of twelve in one call and tells the firm once', async () => {
    const uploads = await openTwelve(matterDocs());

    const res = await client.api.post(`${matterDocs()}/upload-finalize`).send({ uploads });
    await drainEvents();

    expect(res.status).toBe(201);
    expect(res.body.documents).toHaveLength(12);
    expect(await notificationCount()).toBe(1);
    expect(await held()).toBe(0);
  });

  it('records all twelve against a request item in one call, and tells the firm once', async () => {
    const { requestId, itemId } = await seedRequestItem();
    const url = `${P()}/document-requests/${requestId}/items/${itemId}/fulfill`;
    const uploads = await openTwelve(url);

    const res = await client.api.post(`${url}/upload-finalize`).send({ uploads });
    await drainEvents();

    expect(res.status).toBe(201);
    expect(res.body.documents).toHaveLength(12);
    const { rows } = await testPool.query(
      'select count(*)::int as n from attachments where document_request_item_id = $1', [itemId],
    );
    expect(rows[0].n).toBe(12);
    expect(await notificationCount()).toBe(1);
  });

  it('still caps one init at ten files', async () => {
    const names = Array.from({ length: 11 }, (_, i) => declared(`scan-${i}.pdf`));

    const res = await client.api.post(`${matterDocs()}/upload-init`).send({ files: names });

    expect(res.status).toBe(400);
  });

  it('caps one finalize at fifty', async () => {
    const res = await client.api.post(`${matterDocs()}/upload-finalize`).send({
      uploads: Array.from({ length: 51 }, () => ({ fileId: randomUUID(), fileName: 'x.pdf' })),
    });

    expect(res.status).toBe(400);
  });
});
