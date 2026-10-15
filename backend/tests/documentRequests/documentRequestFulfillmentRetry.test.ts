/** Upload retries reuse one action; distinct submissions remain distinct documents. */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  tokenFor,
  as,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects as bucketObjects } from '../support/inMemoryBucket';
import { portalUpload } from '../support/portalUpload';

// Module scope, before the app loads: files.storage.ts and shareLinks.service.ts
// each resolve admin.storage().bucket(...) once at import time.
installInMemoryBucket();

interface PortalPerson extends Actor {
  clientId: string;
}

let firm: Firm;
let owner: Actor;
let client: PortalPerson;
let matterId: string;
let requestId: string;
let itemId: string;

const fulfillUrl = () =>
  `/api/client-portal/lawfirm/${firm.id}/document-requests/${requestId}/items/${itemId}/fulfill`;

async function seedMatterWithClient(): Promise<{ matterId: string }> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Tax Matter', $3)`,
    [id, firm.id, `REF-${id.slice(0, 8)}`],
  );
  await testPool.query(
    `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
    [id, client.clientId, firm.id],
  );
  await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id, role) values ($1, $2, $3, 'lead')`,
    [id, owner.uid, firm.id],
  );
  return { matterId: id };
}

async function seedRequestWithItem(): Promise<{ requestId: string; itemId: string }> {
  const id = randomUUID();
  await testPool.query(
    `insert into document_requests (id, law_firm_id, matter_id, client_id, title, status)
     values ($1, $2, $3, $4, 'W2 Form', 'open')`,
    [id, firm.id, matterId, client.clientId],
  );
  const item = randomUUID();
  await testPool.query(
    `insert into document_request_items (id, law_firm_id, request_id, label, sort_order)
     values ($1, $2, $3, 'W2 Form', 0)`,
    [item, firm.id, id],
  );
  return { requestId: id, itemId: item };
}

const fulfillmentCount = async () => {
  const { rows } = await testPool.query(
    'select count(*)::int as n from attachments where document_request_item_id = $1',
    [itemId],
  );
  return rows[0].n;
};

const documentUploadNotificationCount = async () => {
  const { rows } = await testPool.query(
    `select count(*)::int as n from notifications
      where law_firm_id = $1 and user_id = $2 and type = 'document_uploaded'`,
    [firm.id, owner.uid],
  );
  return rows[0].n;
};

const storageUsedBytes = async () => {
  const { rows } = await testPool.query(
    'select coalesce(storage_used_bytes, 0) as bytes from law_firms where id = $1', [firm.id],
  );
  return Number(rows[0]?.bytes || 0);
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const portal = await createPortalUser({ name: 'Dana Client' });
  const clientRow = await createPersonClient(firm.id, {
    name: 'Dana Client', userId: portal.uid, email: `${portal.uid}@example.test`,
  });
  client = { uid: portal.uid, clientId: clientRow.id, api: as(tokenFor({ uid: portal.uid } as never)) };
  ({ matterId } = await seedMatterWithClient());
  ({ requestId, itemId } = await seedRequestWithItem());
  await drainEvents();
});

describe('one client action submitted twice (lost response, retried upload)', () => {
  it('records the fulfillment and notifies the firm once for a single submission', async () => {
    const res = await portalUpload(client, fulfillUrl(), [{ name: 'w2.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 fake w2')) }]);

    expect(res.status).toBe(201);
    await drainEvents();

    expect(await fulfillmentCount()).toBe(1);
    expect(await documentUploadNotificationCount()).toBe(1);
  });

  it('reuses the file, storage charge and notification on a retried action', async () => {
    const fileBuffer = Buffer.from('%PDF-1.4 fake w2, identical bytes both times');
    const actionKey = randomUUID();

    const first = await portalUpload(client, fulfillUrl(), [{ name: 'w2.pdf', size: Buffer.byteLength(fileBuffer) }], { actionKey });
    await drainEvents();
    const usageAfterFirst = await storageUsedBytes();

    // The client's browser never saw this 201 (the connection dropped) and
    // resubmits the exact same file for the exact same item.
    const second = await portalUpload(client, fulfillUrl(), [{ name: 'w2.pdf', size: Buffer.byteLength(fileBuffer) }], { actionKey });
    await drainEvents();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    expect(await fulfillmentCount()).toBe(1);
    expect(await storageUsedBytes()).toBe(usageAfterFirst);
    expect(await documentUploadNotificationCount()).toBe(1);

    const { rows } = await testPool.query(
      `select ri.status as item_status, r.status as request_status
         from document_request_items ri
         join document_requests r on r.id = ri.request_id
        where ri.id = $1`,
      [itemId],
    );
    expect(rows[0].item_status).toBe('received');
    expect(rows[0].request_status).toBe('completed');
  });

  it('notifies for each distinct submission even when the rendered message is identical', async () => {
    const first = await portalUpload(client, fulfillUrl(), [{ name: 'w2-page-1.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 first document')) }]);
    await drainEvents();

    const second = await portalUpload(client, fulfillUrl(), [{ name: 'w2-page-2.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 a completely different document')) }]);
    await drainEvents();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await fulfillmentCount()).toBe(2);
    expect(await documentUploadNotificationCount()).toBe(2);
  });

  it('allows concurrent distinct documents for one item', async () => {
    const [first, second] = await Promise.all([
      portalUpload(client, fulfillUrl(), [{ name: 'first.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 concurrent first')) }]),
      portalUpload(client, fulfillUrl(), [{ name: 'second.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 concurrent second')) }]),
    ]);
    await drainEvents();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await fulfillmentCount()).toBe(2);
    expect(await storageUsedBytes()).toBe(
      Buffer.byteLength('%PDF-1.4 concurrent first') + Buffer.byteLength('%PDF-1.4 concurrent second'),
    );
  });
  it('returns the same sessions for concurrent init retries and rejects a changed payload', async () => {
    const actionKey = randomUUID();
    const files = [{ fileName: 'w2.pdf', contentType: 'application/pdf', size: 64 }];
    const [first, second] = await Promise.all([
      client.api.post(`${fulfillUrl()}/upload-init`).send({ files, actionKey }),
      client.api.post(`${fulfillUrl()}/upload-init`).send({ files, actionKey }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.uploads).toEqual(first.body.uploads);
    const changed = await client.api.post(`${fulfillUrl()}/upload-init`)
      .send({ files: [{ ...files[0], size: 65 }], actionKey });
    expect(changed.status).toBe(409);
    const { rows } = await testPool.query(
      `select count(*)::int as n from files where law_firm_id = $1 and uploaded_by = $2 and kind = 'file'`,
      [firm.id, client.uid],
    );
    expect(rows[0].n).toBe(1);
  });

  it('rejects an unknown checklist item before claiming upload files', async () => {
    const badUrl = fulfillUrl().replace(itemId, randomUUID());
    const reply = await client.api.post(`${badUrl}/upload-init`).send({
      files: [{ fileName: 'w2.pdf', contentType: 'application/pdf', size: 64 }],
      actionKey: randomUUID(),
    });
    expect(reply.status).toBe(404);
    const claimed = await testPool.query(
      `select id from files where law_firm_id = $1 and uploaded_by = $2 and kind = 'file'`, [firm.id, client.uid],
    );
    expect(claimed.rows).toHaveLength(0);
  });

  it('records a concurrently retried finalize once', async () => {
    const opened = await client.api.post(`${fulfillUrl()}/upload-init`).send({
      files: [{ fileName: 'w2.pdf', contentType: 'application/pdf', size: 64 }],
    });
    expect(opened.status).toBe(200);
    const { landUpload } = require('../support/inMemoryBucket');
    landUpload(opened.body.uploads[0].objectPath, { bytes: 64, contentType: 'application/pdf', head: Buffer.from('%PDF-1.4') });
    const replies = await Promise.all([
      client.api.post(`${fulfillUrl()}/upload-finalize`).send({ uploads: opened.body.uploads }),
      client.api.post(`${fulfillUrl()}/upload-finalize`).send({ uploads: opened.body.uploads }),
    ]);
    expect(replies.map((r) => r.status)).toEqual([201, 201]);
    await drainEvents();
    expect(await fulfillmentCount()).toBe(1);
    expect(await storageUsedBytes()).toBe(64);
    expect(await documentUploadNotificationCount()).toBe(1);
  });

});

afterEach(() => {
  bucketObjects.clear();
});
