/**
 * Client portal "New" badge on documents.
 *
 * A document is new to a client until that client opens it. Opening goes
 * through `POST documents/refresh-url`, which records the first open in
 * `file_client_access.first_seen_at` for that client and file. Both document
 * listings then stamp `isNew` from that column.
 *
 * The badge is per client: a second client on the same matter who has not
 * opened the document still sees it as new. A `file_client_access` row by
 * itself is not an open, because sharing and notification write the same row;
 * only `first_seen_at` is.
 */
import { randomUUID } from 'crypto';
import { testPool, createFirm, type Firm } from '../support/setupInProcess';
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';
import { rootOf, seedFile } from '../files/fileWorld';
import { portalPerson, portalPath, seedMatter, type PortalPerson } from './portalWorld';

installInMemoryBucket();

let firm: Firm;
let alice: PortalPerson;
let bruno: PortalPerson;
let matterId: string;
let complaintId: string;
let exhibitId: string;

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Badge & Seen LLP' });
  alice = await portalPerson(firm.id, 'Alice Seen');
  bruno = await portalPerson(firm.id, 'Bruno Unseen');
  matterId = await seedMatter(firm.id, 'Seen v. Unseen', [alice.clientId, bruno.clientId]);
  const rootId = await rootOf(firm.id, { matterId });
  complaintId = (await seedFile(firm.id, { parentId: rootId, name: 'complaint.pdf', clientVisible: true })).id;
  exhibitId = (await seedFile(firm.id, { parentId: rootId, name: 'exhibit.pdf', clientVisible: true })).id;
});

/** `isNew` per document id, from one listing response. */
function newFlags(res: any): Record<string, unknown> {
  expect(res.status).toBe(200);
  return Object.fromEntries(res.body.documents.map((d: any) => [d.id, d.isNew]));
}

const matterDocuments = (who: PortalPerson) =>
  who.api.get(portalPath(firm.id, `matters/${matterId}/documents`));
const allDocuments = (who: PortalPerson) =>
  who.api.get(portalPath(firm.id, 'documents'));
const open = (who: PortalPerson, fileId: string) =>
  who.api.post(portalPath(firm.id, 'documents/refresh-url')).send({ fileId });

describe('portal document "New" badge', () => {
  it('flags every document the client has not opened, on both listings', async () => {
    expect(newFlags(await matterDocuments(alice))).toEqual({ [complaintId]: true, [exhibitId]: true });
    expect(newFlags(await allDocuments(alice))).toEqual({ [complaintId]: true, [exhibitId]: true });
  });

  it('clears the badge for the client who opened the document, and only that document', async () => {
    const opened = await open(alice, complaintId);
    expect(opened.status).toBe(200);
    expect(opened.body.downloadUrl).toMatch(/^https:\/\/signed\.test\//);

    expect(newFlags(await matterDocuments(alice))).toEqual({ [complaintId]: false, [exhibitId]: true });
    expect(newFlags(await allDocuments(alice))).toEqual({ [complaintId]: false, [exhibitId]: true });
  });

  it("keeps the badge for another client on the same matter who has not opened it", async () => {
    expect((await open(alice, complaintId)).status).toBe(200);

    expect(newFlags(await matterDocuments(bruno))).toEqual({ [complaintId]: true, [exhibitId]: true });
  });

  it('treats a share row with no first open as still new', async () => {
    await testPool.query(
      `insert into file_client_access (id, law_firm_id, file_id, client_user_id, notified_at)
       values ($1, $2, $3, $4, now())`,
      [randomUUID(), firm.id, exhibitId, alice.uid],
    );

    expect(newFlags(await matterDocuments(alice))).toEqual({ [complaintId]: true, [exhibitId]: true });
  });
});
