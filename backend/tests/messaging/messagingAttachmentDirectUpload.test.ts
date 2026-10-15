/**
 * Message attachments, uploaded straight to storage.
 *
 * They used to arrive as multipart: up to five files at a hundred megabytes
 * each, all resident in the container's heap before the handler ran, on an
 * instance that serves eighty concurrent requests on 512 MiB and signs
 * documents at the same time. Five people attaching at once was the exposure,
 * not one large file.
 *
 * A batch is not a loop, and the difference is the firm's storage quota. Every
 * declared size is reserved before any session is minted, so a firm at its
 * limit is refused before a byte moves; finalize then charges what actually
 * landed and deletes the reservations. A reservation left standing holds space
 * the firm is not using until it lapses, and uploads are refused for it in the
 * meantime with nothing saying why.
 *
 * Everything the multipart route checked has to still happen, and all of it used
 * to run on `req.files`, which no longer exists:
 *
 *   Firm membership and `messaging.send`, on BOTH steps. A finalize without
 *   them is a way to stage files in a firm's conversation folder without
 *   permission.
 *
 *   The conversation folder. It is resolved from the caller's access, never
 *   taken from the client, or a member stages attachments under another
 *   client's thread.
 *
 *   The dangerous-type list and the magic-byte sniff, now applied to what
 *   storage recorded rather than to a request buffer.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  as,
  tokenFor,
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects, landUpload } from '../support/inMemoryBucket';
import {
  PDF_HEAD,
  EXE_HEAD,
  declaredPdf,
  landAll as landAllAs,
  storageUsageOf,
} from '../support/directUpload';
import { reserveStorageUsage } from '../../src/shared/utils/storageUsage';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let otherFirm: Firm;
let otherOwner: Actor;
let clientUid: string;

const initPath = (id: string) => `/api/lawfirms/${id}/messaging/attachments/upload-init`;
const finalizePath = (id: string) => `/api/lawfirms/${id}/messaging/attachments/upload-finalize`;

const declared = (name = 'retainer.pdf', size = 4096) => declaredPdf(name, size);

const init = (actor: Actor, files: any[] = [declared()], over: Record<string, unknown> = {}, id?: string) =>
  actor.api.post(initPath(id ?? firm.id)).send({ clientId: clientUid, files, ...over });

const finalize = (actor: Actor, body: Record<string, unknown>, id?: string) =>
  actor.api.post(finalizePath(id ?? firm.id)).send({ clientId: clientUid, ...body });

/** Land every opened session as a valid PDF. */
const landAll = (uploads: any[], over: Record<string, unknown> = {}) => landAllAs(uploads, 4096, over);

const usageOf = storageUsageOf;

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Messaging LLP' });
  owner = await ownerOf(firm.id);
  // The conversation is keyed on the portal USER id, and `verifyClientAccess`
  // finds it through `clients.user_id`, so the client row has to carry it.
  const portal = await createPortalUser({ name: 'Ada Client' });
  clientUid = portal.uid;
  await createPersonClient(firm.id, { name: 'Ada Client', userId: clientUid });
  otherFirm = await createFirm({ name: 'Other LLP' });
  otherOwner = await ownerOf(otherFirm.id);
});

describe('who may attach', () => {
  it('lets a member with messaging.send open the upload', async () => {
    const res = await init(owner);

    expect(res.status).toBe(200);
    expect(res.body.uploads).toHaveLength(1);
  });

  it('carries messaging.send on BOTH routes, not just the opening one', () => {
    // Asserted structurally because it cannot be asserted behaviourally:
    // `messaging.send` is in DEFAULT_PERMISSIONS, which a role can never drop,
    // so a firm member without it does not exist. The risk is still real and
    // this is where it would appear: the permission used to sit on one route,
    // and a finalize that does not carry it would be reachable by whatever
    // future role DOES lack the permission.
    const routes = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'modules', 'messaging', 'messaging.routes.ts'), 'utf8',
    );
    const guarded = routes.split('\n');
    for (const suffix of ['upload-init', 'upload-finalize']) {
      const at = guarded.findIndex((line) => line.includes(`messaging/attachments/${suffix}'`));
      expect(at).toBeGreaterThan(-1);
      // The guard sits within the few middleware lines after the path.
      expect(guarded.slice(at, at + 5).join(' ')).toContain("requirePermission('messaging.send')");
    }
  });

  it('refuses a portal client on both steps', async () => {
    // The audience that genuinely lacks the permission. A client uploading into
    // the firm's own conversation folder is the boundary that matters here.
    const outsider = await createPortalUser({ name: 'Not A Member' });
    const client = as(await tokenFor({ uid: outsider.uid }));

    expect((await client.post(initPath(firm.id)).send({ clientId: clientUid, files: [declared()] })).status)
      .toBeGreaterThanOrEqual(401);
    expect((await client.post(finalizePath(firm.id)).send({ clientId: clientUid, uploads: [], reservedBytes: 0 })).status)
      .toBeGreaterThanOrEqual(401);
  });

  it('refuses another firm member on both steps', async () => {
    expect((await init(otherOwner)).status).toBe(403);
    expect((await finalize(otherOwner, { uploads: [], reservedBytes: 0 })).status).toBe(403);
  });
});

describe('where the bytes land', () => {
  it('puts them under the conversation folder the caller can reach', async () => {
    const res = await init(owner);

    expect(res.body.uploads[0].objectPath)
      .toContain(`lawfirmids/${firm.id}/messaging/${firm.id}_${clientUid}/`);
  });

  it('creates nothing until the browser uploads', async () => {
    await init(owner);

    expect([...objects.keys()]).toEqual([]);
  });

  it('will not stage files against another firm client', async () => {
    // The conversation is resolved from the caller's access. Taken from the
    // request instead, a member writes into an unrelated firm's client folder.
    const theirPortal = await createPortalUser({ name: 'Theirs' });
    const theirUid = theirPortal.uid;
    await createPersonClient(otherFirm.id, { name: 'Theirs', userId: theirUid });

    const res = await init(owner, [declared()], { clientId: theirUid });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses an object path outside the conversation folder at finalize', async () => {
    // The path is echoed back by the client. Trusted, it records an attachment
    // pointing at any object in the bucket.
    const opened = await init(owner);
    landAll(opened.body.uploads);
    landUpload(`lawfirmids/${firm.id}/objects/secret.pdf`, {
      bytes: 10, contentType: 'application/pdf', head: PDF_HEAD,
    });

    const res = await finalize(owner, {
      uploads: [{ objectPath: `lawfirmids/${firm.id}/objects/secret.pdf`, fileName: 'secret.pdf', declaredSize: 10 }],
      reservedBytes: 10,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('admission', () => {
  it('refuses an executable by name and type before reserving quota', async () => {
    const before = await usageOf(firm.id);

    const res = await init(owner, [{ fileName: 'virus.exe', contentType: 'application/x-msdownload', size: 10 }]);

    expect(res.status).toBe(415);
    expect(await usageOf(firm.id)).toEqual(before);
  });

  it('rejects an executable renamed as a pdf, at finalize', async () => {
    // The magic-byte sniff, moved from the request buffer to a ranged read.
    const opened = await init(owner);
    landAll(opened.body.uploads, { head: EXE_HEAD });

    const res = await finalize(owner, {
      uploads: opened.body.uploads, reservedBytes: opened.body.reservedBytes,
    });

    expect(res.status).toBe(201);
    expect(res.body.attachments).toEqual([]);
    expect(res.body.failures).toHaveLength(1);
  });

  it('caps how many files one request may carry', async () => {
    const six = Array.from({ length: 6 }, (_, i) => declared(`f${i}.pdf`));

    expect((await init(owner, six)).status).toBe(400);
  });
});

describe('the storage quota', () => {
  it('reserves the declared total at init', async () => {
    const before = await usageOf(firm.id);

    await init(owner, [declared('a.pdf', 4096), declared('b.pdf', 2048)]);

    expect((await usageOf(firm.id)).reserved).toBe(before.reserved + 6144);
  });

  it('settles the reservation against what landed', async () => {
    const opened = await init(owner, [declared('a.pdf', 4096), declared('b.pdf', 2048)]);
    // Both land at 4096, so one landed MORE than it declared. A resumable
    // session has no size ceiling of its own, which is why the declared size
    // cannot be the figure that is committed.
    landAll(opened.body.uploads);

    const res = await finalize(owner, {
      uploads: opened.body.uploads, reservedBytes: opened.body.reservedBytes,
    });

    expect(res.status).toBe(201);
    const after = await usageOf(firm.id);
    expect(after.reserved).toBe(0);
    expect(after.used).toBe(8192);
  });

  it('gives back the whole reservation when nothing was uploaded', async () => {
    // Every session abandoned. Left reserved, this is space the firm is charged
    // for and can never use, and nothing ever reports it.
    const opened = await init(owner, [declared('a.pdf', 4096)]);

    await finalize(owner, { uploads: opened.body.uploads, reservedBytes: opened.body.reservedBytes });

    const after = await usageOf(firm.id);
    expect(after.reserved).toBe(0);
    expect(after.used).toBe(0);
  });

  it('keeps the good attachments when one file is refused', async () => {
    const opened = await init(owner, [declared('good.pdf'), declared('bad.pdf')]);
    landUpload(opened.body.uploads[0].objectPath, { bytes: 4096, contentType: 'application/pdf', head: PDF_HEAD });
    landUpload(opened.body.uploads[1].objectPath, { bytes: 4096, contentType: 'application/pdf', head: EXE_HEAD });

    const res = await finalize(owner, {
      uploads: opened.body.uploads, reservedBytes: opened.body.reservedBytes,
    });

    // One bad attachment never discarded a whole message on the multipart path.
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.failures).toHaveLength(1);
    expect((await usageOf(firm.id)).reserved).toBe(0);
  });

  it('ignores a client-supplied reservedBytes and settles only what init reserved', async () => {
    const opened = await init(owner, [declared('a.pdf', 4096)]);
    landAll(opened.body.uploads);
    // Another upload in the same firm is mid-flight and holds its own reservation.
    await reserveStorageUsage({ lawFirmId: firm.id, createdBy: otherOwner.uid, sizes: [50_000] });

    const res = await finalize(owner, { uploads: opened.body.uploads, reservedBytes: 51_000 });

    // Honoured, the request's own number released the other uploader's live
    // reservation along with this one.
    expect(res.status).toBe(201);
    expect(res.body.attachments).toHaveLength(1);
    expect(await usageOf(firm.id)).toEqual({ used: 4096, reserved: 50_000 });
  });
});

describe('what the caller gets back', () => {
  it('returns an attachment descriptor the send endpoint accepts', async () => {
    const opened = await init(owner);
    landAll(opened.body.uploads);

    const res = await finalize(owner, {
      uploads: opened.body.uploads, reservedBytes: opened.body.reservedBytes,
    });

    expect(res.status).toBe(201);
    const [attachment] = res.body.attachments;
    expect(attachment.objectPath).toBe(opened.body.uploads[0].objectPath);
    expect(attachment.name).toBe('retainer.pdf');
    expect(attachment.size).toBe(4096);
    expect(attachment.url).toBeTruthy();
  });
});
