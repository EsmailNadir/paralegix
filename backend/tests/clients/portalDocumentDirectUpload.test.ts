/**
 * Client portal document uploads, straight to storage.
 *
 * Two routes: a free upload into one of the client's matters, and fulfilling a
 * checklist item on a document request. Both used to take ten files at a
 * hundred megabytes each as multipart, resident in a 512 MiB container that
 * serves eighty concurrent requests and signs documents.
 *
 * These differ from the message attachments in that they write a file ROW into
 * the firm's tree, so the row has to be claimed before the bytes exist and
 * stamped after they land. What that adds, and what the cases below are mostly
 * about, is that the row is the authorization: finalize looks a row up by id and
 * checks it belongs to this client's scope, so a client naming another client's
 * row finds nothing rather than being handed a signed url for it.
 *
 * Everything the multipart routes checked still has to happen, on BOTH steps,
 * because each is reachable on its own:
 *
 *   The client's access to the matter. Skipped at finalize, a client could
 *   stamp rows in a matter they were refused at init.
 *
 *   The request being addressed to this client, and not cancelled.
 *
 *   The firm's storage quota, and `client_visible` on the row, so the uploading
 *   client keeps seeing what they sent.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';
import {
  PDF_HEAD,
  EXE_HEAD,
  declaredPdf,
  landAll as landAllAs,
  storageUsageOf,
} from '../support/directUpload';
import { seedMatter } from '../files/fileWorld';
import { reserveStorageUsage } from '../../src/shared/utils/storageUsage';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let client: Actor;
let clientRecordId: string;
let matterId: string;
/** A matter this client has no access to. */
let otherMatterId: string;

const P = () => `/api/client-portal/lawfirm/${firm.id}`;
const initPath = (m: string) => `${P()}/matters/${m}/documents/upload-init`;
const finalizePath = (m: string) => `${P()}/matters/${m}/documents/upload-finalize`;

const declared = (name = 'receipt.pdf', size = 2048) => declaredPdf(name, size);

const init = (actor: Actor, m: string, files: any[] = [declared()]) =>
  actor.api.post(initPath(m)).send({ files });

const finalize = (actor: Actor, m: string, body: Record<string, unknown>) =>
  actor.api.post(finalizePath(m)).send(body);

const landAll = (uploads: any[], over: Record<string, unknown> = {}) => landAllAs(uploads, 2048, over);

const usageOf = storageUsageOf;

/** Link a client record to a matter, which is what grants portal access. */
async function grantMatterAccess(recordId: string, matter: string) {
  await testPool.query(
    `insert into matter_clients (law_firm_id, matter_id, client_id) values ($1, $2, $3)
     on conflict do nothing`,
    [firm.id, matter, recordId],
  );
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Portal Docs LLP' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Ellis v. Hart');
  otherMatterId = await seedMatter(firm.id, owner.uid, 'Someone Else');

  const portal = await createPortalUser({ name: 'Ada Client' });
  const record = await createPersonClient(firm.id, { name: 'Ada Client', userId: portal.uid });
  clientRecordId = record.id;
  client = { uid: portal.uid, api: as(tokenFor({ uid: portal.uid })) };
  await grantMatterAccess(clientRecordId, matterId);
});

describe('who may upload into a matter', () => {
  it('lets a client of the matter open the upload', async () => {
    const res = await init(client, matterId);

    expect(res.status).toBe(200);
    expect(res.body.uploads).toHaveLength(1);
  });

  it('refuses a matter this client is not on, at init', async () => {
    const res = await init(client, otherMatterId);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.uploads).toBeUndefined();
  });

  it('refuses a matter this client is not on, at FINALIZE', async () => {
    // Each route is reachable on its own. Skipped here, a client could stamp
    // rows in a matter they were refused at init.
    const opened = await init(client, matterId);
    landAll(opened.body.uploads);

    const res = await finalize(client, otherMatterId, {
      uploads: opened.body.uploads, reservedBytes: opened.body.reservedBytes,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a firm member, who is not a portal caller', async () => {
    expect((await init(owner, matterId)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('the row is the authorization', () => {
  it('claims a row before any byte exists, and does not list it yet', async () => {
    const opened = await init(client, matterId);

    const { rows } = await testPool.query(
      'select finalized_at, client_visible from files where id = $1', [opened.body.uploads[0].fileId],
    );
    // Claimed but not a document: nothing lists it until finalize stamps it.
    expect(rows[0].finalized_at).toBeNull();
    // Set at INSERT rather than patched later, so there is no window where the
    // client's own upload is invisible to them.
    expect(rows[0].client_visible).toBe(true);
  });

  it('will not finalize a row belonging to another client', async () => {
    const otherPortal = await createPortalUser({ name: 'Bob' });
    const otherRecord = await createPersonClient(firm.id, { name: 'Bob', userId: otherPortal.uid });
    await grantMatterAccess(otherRecord.id, matterId);
    const other: Actor = { uid: otherPortal.uid, api: as(tokenFor({ uid: otherPortal.uid })) };

    const mine = await init(client, matterId);
    landAll(mine.body.uploads);

    const res = await finalize(other, matterId, {
      uploads: mine.body.uploads, reservedBytes: mine.body.reservedBytes,
    });

    // A signed url for someone else's document is what this refusal prevents.
    expect(res.body.documents ?? []).toEqual([]);
  });
});

describe('finishing the upload', () => {
  it('stamps the row and answers with the document', async () => {
    const opened = await init(client, matterId);
    landAll(opened.body.uploads);

    const res = await finalize(client, matterId, {
      uploads: opened.body.uploads, reservedBytes: opened.body.reservedBytes,
    });

    expect(res.status).toBe(201);
    expect(res.body.documents).toHaveLength(1);
    const { rows } = await testPool.query(
      'select finalized_at, matter_id from files where id = $1', [opened.body.uploads[0].fileId],
    );
    expect(rows[0].finalized_at).not.toBeNull();
    expect(rows[0].matter_id).toBe(matterId);
  });

  it('rejects an executable renamed as a pdf', async () => {
    const opened = await init(client, matterId);
    landAll(opened.body.uploads, { head: EXE_HEAD });

    const res = await finalize(client, matterId, {
      uploads: opened.body.uploads, reservedBytes: opened.body.reservedBytes,
    });

    expect(res.body.documents).toEqual([]);
    expect(res.body.failures).toHaveLength(1);
  });

  it('refuses an executable by name and type before reserving quota', async () => {
    const before = await usageOf(firm.id);

    const res = await init(client, matterId, [
      { fileName: 'payload.exe', contentType: 'application/x-msdownload', size: 10 },
    ]);

    expect(res.status).toBe(415);
    expect(await usageOf(firm.id)).toEqual(before);
  });
});

describe('an invalid request leaves nothing behind', () => {
  it('creates no scope-root folder for an empty selection', async () => {
    // `ensureScopeRoot` writes a folder row. Validating after it would leave one
    // behind for a request that was never valid, and the refusal would then be
    // reported over a side effect it had already had.
    const res = await init(client, matterId, []);

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      'select count(*)::int as n from files where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('removes the rows it claimed when a later file is refused', async () => {
    // A row claimed and then abandoned holds its name in the folder until the
    // sweeper finds it, so the user's retry lands as "receipt (1).pdf".
    const res = await init(client, matterId, [
      declared('good.pdf'),
      { fileName: 'payload.exe', contentType: 'application/x-msdownload', size: 10 },
    ]);

    expect(res.status).toBe(415);
    const { rows } = await testPool.query(
      `select count(*)::int as n from files where law_firm_id = $1 and kind = 'file'`, [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('the firm storage quota', () => {
  it('gives the whole reservation back when nothing was uploaded', async () => {
    const opened = await init(client, matterId, [declared('a.pdf', 2048)]);

    await finalize(client, matterId, {
      uploads: opened.body.uploads, reservedBytes: opened.body.reservedBytes,
    });

    expect(await usageOf(firm.id)).toEqual({ used: 0, reserved: 0 });
  });

  it('ignores a client-supplied reservedBytes and settles only what init reserved', async () => {
    const opened = await init(client, matterId, [declared('a.pdf', 2048)]);
    landAll(opened.body.uploads);
    // Another upload in the same firm is mid-flight and holds its own reservation.
    await reserveStorageUsage({ lawFirmId: firm.id, createdBy: owner.uid, sizes: [50_000] });

    const res = await finalize(client, matterId, { uploads: opened.body.uploads, reservedBytes: 51_000 });

    // Only this upload's 2,048 bytes settle. A client-chosen figure was released
    // on top of that, walking down the other uploader's live reservation.
    expect(res.status).toBe(201);
    expect(res.body.documents).toHaveLength(1);
    expect(await usageOf(firm.id)).toEqual({ used: 2048, reserved: 50_000 });
  });

  it('charges a retried finalize nothing', async () => {
    const opened = await init(client, matterId, [declared('a.pdf', 2048)]);
    landAll(opened.body.uploads);
    const first = await finalize(client, matterId, { uploads: opened.body.uploads });
    expect(first.status).toBe(201);
    const once = await usageOf(firm.id);
    expect(once).toEqual({ used: 2048, reserved: 0 });

    // The client re-sends a finalize whose response it never saw. The row was
    // already stamped and counted, so the retry changes nothing.
    const again = await finalize(client, matterId, { uploads: opened.body.uploads });

    expect(again.status).toBe(201);
    expect(again.body.documents).toHaveLength(1);
    expect(await usageOf(firm.id)).toEqual(once);
  });
});

describe('which object a finalize stamps', () => {
  it('stamps the row with ITS OWN object, whatever path the body names', async () => {
    // The row is the authorization, so the row decides which object it
    // describes. Taking the path from the body let a client finalize one row
    // with the bytes of another upload of theirs, leaving the row naming an
    // object it never received.
    const first = await init(client, matterId, [declared('mine.pdf', 2048)]);
    const second = await init(client, matterId, [declared('other.pdf', 4096)]);
    landAll(first.body.uploads, { bytes: 2048 });
    landAll(second.body.uploads, { bytes: 4096 });

    const [row] = first.body.uploads;
    const res = await finalize(client, matterId, {
      uploads: [{ ...row, objectPath: second.body.uploads[0].objectPath }],
    });

    expect(res.status).toBe(201);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0].objectPath).toBe(row.objectPath);
    expect(res.body.documents[0].size).toBe(2048);
    const { rows } = await testPool.query('select size_bytes from files where id = $1', [row.fileId]);
    expect(Number(rows[0].size_bytes)).toBe(2048);
  });
});
