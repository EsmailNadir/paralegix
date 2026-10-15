/**
 * The document-request scenario families that none of the sibling suites reach:
 * neither `documentRequests.test.ts`, `documentRequestLifecycles.test.ts`,
 * `documentRequestFulfillmentRetry.test.ts` nor `portalDocumentRequests.test.ts`
 * exercises what is below.
 *
 * What's pinned here:
 *
 *   - A CANCELLED request refuses further portal fulfillment (recordFulfillment's
 *     own check, exercised only at the service-layer today - never through the
 *     real portal route).
 *   - A COMPLETED request does NOT refuse further fulfillment. `recordFulfillment`
 *     checks only `status === 'cancelled'`; a client adding a document to an
 *     item that already has one is accepted and simply appends another
 *     fulfillment row. Characterization, not a bug: nothing declares this
 *     out of bounds, and the request's rollup is unaffected either way.
 *   - Item/request identity boundaries: fulfilling with an itemId that belongs to
 *     a DIFFERENT request (`getItem` is scoped by both), and fulfilling a request
 *     addressed to a DIFFERENT client (`getClientRequestTarget`'s ownership
 *     check), both refuse before anything is written.
 *   - `linkFile`'s matter boundary: a firm member cannot link a file that lives
 *     under a different matter than the request, even though both matters belong
 *     to the same firm.
 *   - A "missing linked object": once the underlying `files` row (and its GCS
 *     object) is gone, the portal's signed-URL route answers 404 rather than
 *     crashing or leaking whatever the stale fulfillment row still names.
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
const fulfillmentUrlRoute = (requestId: string, itemId: string, fulfillmentId: string) =>
  `/api/client-portal/lawfirm/${firm.id}/document-requests/${requestId}/items/${itemId}/fulfillments/${fulfillmentId}/url`;

async function portalPerson(name: string): Promise<PortalPerson> {
  const portal = await createPortalUser({ name });
  const clientRow = await createPersonClient(firm.id, {
    name, userId: portal.uid, email: `${portal.uid}@example.test`,
  });
  return { uid: portal.uid, clientId: clientRow.id, api: as(tokenFor({ uid: portal.uid })) };
}

async function seedMatter(): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Fulfillment Matter', $3)`,
    [id, firm.id, `REF-${id.slice(0, 8)}`],
  );
  return id;
}

async function addClientToMatter(theMatterId: string, clientId: string) {
  await testPool.query(
    `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
    [theMatterId, clientId, firm.id],
  );
}

async function addOwnerToMatter(theMatterId: string) {
  await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id, role) values ($1, $2, $3, 'lead')`,
    [theMatterId, owner.uid, firm.id],
  );
}

/** Create a matter-scoped request with one item, through the real create route. */
async function createRequestFor(theClient: PortalPerson, theMatterId: string, title: string) {
  const res = await owner.api.post(requestsPath()).send({
    matterId: theMatterId,
    clientId: theClient.clientId,
    title,
    items: [{ label: 'W2 Form' }],
  });
  expect(res.status).toBe(201);
  return { requestId: res.body.request.id as string, itemId: res.body.request.items[0].id as string };
}

const requestStatus = async (requestId: string) => {
  const { rows } = await testPool.query('select status from document_requests where id = $1', [requestId]);
  return rows[0]?.status;
};

const fulfillmentCount = async (itemId: string) => {
  const { rows } = await testPool.query(
    'select count(*)::int as n from attachments where document_request_item_id = $1', [itemId],
  );
  return rows[0].n;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await portalPerson('Dana Client');
  matterId = await seedMatter();
  await addClientToMatter(matterId, client.clientId);
  await addOwnerToMatter(matterId);
  await drainEvents();
});

afterEach(() => {
  bucketObjects.clear();
});

describe('cancelled and completed requests', () => {
  it('refuses a portal fulfillment once the request is cancelled', async () => {
    const { requestId, itemId } = await createRequestFor(client, matterId, 'Cancellable request');

    const cancel = await owner.api.patch(requestsPath(`/${requestId}`)).send({ status: 'cancelled' });
    expect(cancel.status).toBe(200);
    await drainEvents();

    const res = await portalUpload(client, fulfillUrl(requestId, itemId), [{ name: 'w2.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 too late')) }]);

    expect(res.status).toBe(400);
    expect(await fulfillmentCount(itemId)).toBe(0);
    // The request itself must still read as cancelled, not silently reopened by
    // the refused attempt.
    expect(await requestStatus(requestId)).toBe('cancelled');
  });

  it('CHARACTERIZATION: still accepts a portal fulfillment once the request is already completed', async () => {
    const { requestId, itemId } = await createRequestFor(client, matterId, 'One-item request');

    const first = await portalUpload(client, fulfillUrl(requestId, itemId), [{ name: 'w2.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 first upload')) }]);
    expect(first.status).toBe(201);
    await drainEvents();
    // The only item is now received, so the rollup already reads completed.
    expect(await requestStatus(requestId)).toBe('completed');

    // recordFulfillment only refuses `status === 'cancelled'`; a completed
    // request has no equivalent guard, so a second, later document for the same
    // item is accepted rather than refused.
    const second = await portalUpload(client, fulfillUrl(requestId, itemId), [{ name: 'w2-corrected.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 a later addition')) }]);

    expect(second.status).toBe(201);
    expect(await fulfillmentCount(itemId)).toBe(2);
    expect(await requestStatus(requestId)).toBe('completed');
  });
});

describe('item and request identity boundaries', () => {
  it('refuses a portal fulfillment whose itemId belongs to a DIFFERENT request', async () => {
    const first = await createRequestFor(client, matterId, 'First request');
    const second = await createRequestFor(client, matterId, 'Second request');

    // first.requestId in the URL, but second.itemId - the two are real rows for
    // the same client, just not the same parent. getItem scopes by both.
    const res = await portalUpload(client, fulfillUrl(first.requestId, second.itemId), [{ name: 'mixed.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 mismatched item')) }]);

    expect(res.status).toBe(404);
    expect(await fulfillmentCount(second.itemId)).toBe(0);
  });

  it('refuses a portal fulfillment against a request addressed to a DIFFERENT client', async () => {
    const other = await portalPerson('Rory Other Client');
    await addClientToMatter(matterId, other.clientId);
    const { requestId, itemId } = await createRequestFor(client, matterId, 'Dana only');

    // Rory has a real portal identity in this same firm/matter, but this
    // request was addressed to Dana, not to them.
    const res = await portalUpload(other, fulfillUrl(requestId, itemId), [{ name: 'intrusion.pdf', size: Buffer.byteLength(Buffer.from('%PDF-1.4 not yours')) }]);

    expect(res.status).toBe(403);
    expect(await fulfillmentCount(itemId)).toBe(0);
  });
});

describe('linking a file that lives under a different matter', () => {
  it('refuses to link it, and leaves the item unfulfilled', async () => {
    const otherMatterId = await seedMatter();
    const { requestId, itemId } = await createRequestFor(client, matterId, 'Wants a file from ITS OWN matter');

    const otherRoot = await rootOf(firm.id, { matterId: otherMatterId });
    const foreign = await seedFile(firm.id, {
      parentId: otherRoot, name: 'foreign-file.pdf', bytes: 2048,
    });

    const res = await owner.api
      .post(requestsPath(`/${requestId}/items/${itemId}/link-file`))
      .send({ fileId: foreign.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different matter/i);

    const { rows } = await testPool.query(
      'select count(*)::int as n from attachments where document_request_item_id = $1', [itemId],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('a fulfillment whose linked object no longer exists', () => {
  it('answers 404 for the signed-url route instead of crashing or leaking the stale path', async () => {
    const { requestId, itemId } = await createRequestFor(client, matterId, 'Linked then deleted');
    const root = await rootOf(firm.id, { matterId });
    const doomed = await seedFile(firm.id, { parentId: root, name: 'soon-gone.pdf', bytes: 512 });

    const link = await owner.api
      .post(requestsPath(`/${requestId}/items/${itemId}/link-file`))
      .send({ fileId: doomed.id });
    expect(link.status).toBe(200);
    const fulfillmentId = link.body.request.items[0].fulfillments[0].id;

    // The document is removed the way a real delete does. The attachment row is
    // a foreign key to `files`, so it goes with it, and the item is left with
    // nothing to serve rather than a dangling reference.
    await testPool.query('delete from files where id = $1', [doomed.id]);

    const res = await client.api.get(fulfillmentUrlRoute(requestId, itemId, fulfillmentId));

    expect(res.status).toBe(404);
  });
});
