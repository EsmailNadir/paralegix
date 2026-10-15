/**
 * B09.3: portal upload and firm-side link-file, compared directly against the
 * same request through their real routes.
 *
 * Both paths end at the same two repository writes -
 * `documentRequests.repository.ts`'s `recordFulfillments` (portal) and
 * `linkFile` (firm) each insert a fulfillment row, flip the item to
 * 'received', and call the shared `recomputeStatus` - so the completion
 * rollup genuinely is one shared contract regardless of which path filled
 * which item. That convergence is proven positively below.
 *
 * The permission/business-rule side does NOT converge, and nothing in the
 * plan or the code says it should: `recordFulfillment` (portal.service.ts,
 * via documentRequests.service.ts) explicitly refuses once a request is
 * 'cancelled' ("This request has been cancelled"), but `linkFile`
 * (documentRequests.service.ts) has no equivalent check at all - it looks up
 * the request, the matter membership and the item, and never reads
 * `request.status`. A firm member can link a file to a cancelled request's
 * item and the write succeeds; recomputeStatus then leaves the request
 * 'cancelled' (it early-returns on that status), so the request doesn't
 * silently reopen, but the fulfillment row and the item's 'received' flip
 * both land regardless. This is characterization, not a fix: nothing
 * declares whether a firm member should be able to attach evidence to a
 * cancelled request after the fact (e.g. filing a document that arrived
 * right before cancellation) or whether that is a gap that should mirror the
 * portal's refusal. Logged as a functionality question for product to
 * resolve, not invented here.
 */
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
import { rootOf, seedFile } from '../files/fileWorld';
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

const requestsPath = (suffix = '') => `/api/lawfirms/${firm.id}/document-requests${suffix}`;
const fulfillUrl = (requestId: string, itemId: string) =>
  `/api/client-portal/lawfirm/${firm.id}/document-requests/${requestId}/items/${itemId}/fulfill`;

async function seedMatter(): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Convergence Matter', $3)`,
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
  return id;
}

/** A document already sitting in the matter's Files tab, ready to be linked. */
async function seedMatterFile(name: string) {
  const root = await rootOf(firm.id, { matterId });
  return seedFile(firm.id, { parentId: root, name });
}

async function createTwoItemRequest(title: string) {
  const res = await owner.api.post(requestsPath()).send({
    matterId,
    clientId: client.clientId,
    title,
    items: [{ label: 'Item A' }, { label: 'Item B' }],
  });
  expect(res.status).toBe(201);
  return {
    requestId: res.body.request.id as string,
    itemAId: res.body.request.items[0].id as string,
    itemBId: res.body.request.items[1].id as string,
  };
}

const requestState = async (requestId: string) => {
  const { rows } = await testPool.query(
    `select r.status as request_status,
            (select array_agg(status order by sort_order) from document_request_items where request_id = r.id) as item_statuses
       from document_requests r where r.id = $1`,
    [requestId],
  );
  return rows[0];
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const portal = await createPortalUser({ name: 'Convergence Client' });
  const clientRow = await createPersonClient(firm.id, {
    name: 'Convergence Client', userId: portal.uid, email: `${portal.uid}@example.test`,
  });
  client = { uid: portal.uid, clientId: clientRow.id, api: as(tokenFor({ uid: portal.uid })) };
  matterId = await seedMatter();
  await drainEvents();
});

afterEach(() => {
  bucketObjects.clear();
});

describe('completion rule: shared regardless of which path fulfills which item', () => {
  it.each(['firm link', 'portal upload', 'portal removal'])('rolls back %s if the request rollup fails', async (operation) => {
    const { requestId, itemAId } = await createTwoItemRequest('Atomic fulfillment');
    if (operation === 'portal removal') {
      const uploaded = await portalUpload(client, fulfillUrl(requestId, itemAId), [{ name: 'client-file.pdf', size: 16 }]);
      expect(uploaded.status).toBe(201);
    }
    const repo = require('../../src/modules/documentRequests/documentRequests.repository');
    const before = await repo.getById(firm.id, requestId);
    const file = operation === 'firm link' ? await seedMatterFile('evidence.pdf') : null;
    const original = repo.recomputeStatus;
    let rolledUp = false;
    const fault = jest.spyOn(repo, 'recomputeStatus').mockImplementation(async (...args: any[]) => {
      await original.apply(repo, args);
      rolledUp = true;
      throw new Error('Injected rollup failure');
    });
    try {
      const response = operation === 'firm link'
        ? await owner.api.post(requestsPath(`/${requestId}/items/${itemAId}/link-file`)).send({ fileId: file!.id })
        : operation === 'portal upload'
          ? await portalUpload(client, fulfillUrl(requestId, itemAId), [{ name: 'client-file.pdf', size: 16 }])
          : await client.api.delete(`/api/client-portal/lawfirm/${firm.id}/document-requests/${requestId}/items/${itemAId}/fulfillments/${before.items[0].fulfillments[0].id}`);
      expect(response.status).toBe(500);
      expect(rolledUp).toBe(true);
      const after = await repo.getById(firm.id, requestId);
      expect(after.status).toBe(before.status);
      expect(after.items.map((item: any) => ({ status: item.status, fulfillments: item.fulfillments })))
        .toEqual(before.items.map((item: any) => ({ status: item.status, fulfillments: item.fulfillments })));
    } finally {
      fault.mockRestore();
    }
  });

  it('reaches the same completed rollup whether the firm links one item and the client uploads the other', async () => {
    const { requestId, itemAId, itemBId } = await createTwoItemRequest('Mixed-path request');

    // Firm fulfills item A by linking an already-uploaded file.
    const file = await seedMatterFile('linked-evidence.pdf');
    const linked = await owner.api
      .post(requestsPath(`/${requestId}/items/${itemAId}/link-file`))
      .send({ fileId: file.id });
    expect(linked.status).toBe(200);

    // One item still pending: the rollup must not complete yet, from either path.
    let state = await requestState(requestId);
    expect(state.request_status).toBe('open');
    expect(state.item_statuses).toEqual(['received', 'pending']);

    // Client fulfills item B by uploading through the portal.
    const uploaded = await portalUpload(client, fulfillUrl(requestId, itemBId), [{ name: 'client-file.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 client upload')) }]);
    expect(uploaded.status).toBe(201);
    await drainEvents();

    // Now both items are received, one from each path - the SAME recomputeStatus
    // rule fires for both and the request converges to 'completed'.
    state = await requestState(requestId);
    expect(state.request_status).toBe('completed');
    expect(state.item_statuses).toEqual(['received', 'received']);
  });

  it('reaches the same completed rollup with the paths reversed', async () => {
    // Mirror of the case above (client fulfills A, firm links B) - proves the
    // convergence isn't an artifact of item ordering.
    const { requestId, itemAId, itemBId } = await createTwoItemRequest('Mixed-path request, reversed');

    const uploaded = await portalUpload(client, fulfillUrl(requestId, itemAId), [{ name: 'client-file.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 client upload first')) }]);
    expect(uploaded.status).toBe(201);
    await drainEvents();

    let state = await requestState(requestId);
    expect(state.request_status).toBe('open');

    const file = await seedMatterFile('linked-evidence-2.pdf');
    const linked = await owner.api
      .post(requestsPath(`/${requestId}/items/${itemBId}/link-file`))
      .send({ fileId: file.id });
    expect(linked.status).toBe(200);

    state = await requestState(requestId);
    expect(state.request_status).toBe('completed');
    expect(state.item_statuses).toEqual(['received', 'received']);
  });
});

describe('permission rule on a cancelled request: the two paths do NOT converge', () => {
  it('portal upload refuses (400), but firm link-file still succeeds on the same request', async () => {
    const { requestId, itemAId, itemBId } = await createTwoItemRequest('Cancelled mid-flight');

    const cancel = await owner.api.patch(requestsPath(`/${requestId}`)).send({ status: 'cancelled' });
    expect(cancel.status).toBe(200);
    await drainEvents();

    // Portal side: explicitly refused, nothing written.
    const uploadAttempt = await portalUpload(client, fulfillUrl(requestId, itemAId), [{ name: 'late.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 too late')) }]);
    expect(uploadAttempt.status).toBe(400);

    // Firm side: no equivalent guard exists in linkFile, so the same kind of
    // action - attaching a file to an item on a cancelled request - succeeds.
    const file = await seedMatterFile('linked-after-cancel.pdf');
    const linkAttempt = await owner.api
      .post(requestsPath(`/${requestId}/items/${itemBId}/link-file`))
      .send({ fileId: file.id });
    expect(linkAttempt.status).toBe(200);

    const state = await requestState(requestId);
    // The fulfillment landed and the item flipped...
    expect(state.item_statuses).toEqual(['pending', 'received']);
    // ...but the request itself stays cancelled: recomputeStatus early-returns
    // on a cancelled status rather than reopening it to 'completed'/'open'.
    expect(state.request_status).toBe('cancelled');

    const { rows } = await testPool.query(
      'select count(*)::int as n from attachments where document_request_item_id = $1', [itemBId],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('who may remove a fulfillment: the client\'s own upload, not the firm\'s link', () => {
  const portalDeleteUrl = (requestId: string, itemId: string, fulfillmentId: string) =>
    `/api/client-portal/lawfirm/${firm.id}/document-requests/${requestId}`
    + `/items/${itemId}/fulfillments/${fulfillmentId}`;

  /** The one fulfillment on an item, as the portal sees it. */
  const soleFulfillmentId = async (itemId: string): Promise<string> => {
    const { rows } = await testPool.query(
      'select id from attachments where document_request_item_id = $1', [itemId],
    );
    expect(rows).toHaveLength(1);
    return rows[0].id as string;
  };

  it('lets the client remove the file they uploaded themselves', async () => {
    const { requestId, itemAId } = await createTwoItemRequest('Client removes own upload');

    const uploaded = await portalUpload(client, fulfillUrl(requestId, itemAId), [{ name: 'mine.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 mine')) }]);
    expect(uploaded.status).toBe(201);
    await drainEvents();

    const removed = await client.api.delete(
      portalDeleteUrl(requestId, itemAId, await soleFulfillmentId(itemAId)),
    );

    expect(removed.status).toBe(200);
    const { rows } = await testPool.query(
      'select count(*)::int as n from attachments where document_request_item_id = $1', [itemAId],
    );
    expect(rows[0].n).toBe(0);
    // Removing the only fulfillment returns the item to pending: the client has
    // no separate control to set an item's status.
    expect((await requestState(requestId)).item_statuses).toEqual(['pending', 'pending']);
  });

  it('refuses to let the client remove a file the firm linked on their behalf', async () => {
    const { requestId, itemAId } = await createTwoItemRequest('Firm links, client cannot remove');

    const file = await seedMatterFile('firm-linked-evidence.pdf');
    const linked = await owner.api
      .post(requestsPath(`/${requestId}/items/${itemAId}/link-file`))
      .send({ fileId: file.id });
    expect(linked.status).toBe(200);

    const fulfillmentId = await soleFulfillmentId(itemAId);
    const refused = await client.api.delete(portalDeleteUrl(requestId, itemAId, fulfillmentId));

    // The two paths write the same row shape, so the only thing separating them
    // is who attached it. Before attachments.created_by existed that was implied
    // by `file_id` being null on a client upload; every attachment is keyed on a
    // file now, so a check on file_id would refuse BOTH cases and the case above
    // would fail with it.
    expect(refused.status).toBe(403);
    expect(String(refused.body?.error || refused.text)).toMatch(/law firm/i);

    const { rows } = await testPool.query(
      'select count(*)::int as n from attachments where document_request_item_id = $1', [itemAId],
    );
    expect(rows[0].n).toBe(1);
    // The firm can still remove what the firm attached.
    const byFirm = await owner.api.delete(
      requestsPath(`/${requestId}/items/${itemAId}/files/${fulfillmentId}`),
    );
    expect(byFirm.status).toBe(200);
  });
});
