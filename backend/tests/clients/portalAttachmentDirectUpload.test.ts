/**
 * Client portal message attachments, uploaded straight to storage.
 *
 * The portal is the one upload path whose caller is OUTSIDE the firm, which is
 * why it carried the same executable deny-list as the firm-side routes. Losing
 * that in a transport change would let a client deliver active content to staff,
 * and nothing on any screen would look different.
 *
 * The memory reason is the same as everywhere else: five files at a hundred
 * megabytes each used to sit in a 512 MiB container that serves eighty
 * concurrent requests and signs documents. The exposure was several clients
 * attaching at once, not one large file.
 *
 * What must survive the move, and all of it used to run on `req.files`:
 *
 *   The firm association. A portal user may only write under a firm they are
 *   actually a client of, on BOTH steps.
 *
 *   The folder. A direct thread is the client's own; a GROUP thread requires
 *   active participation, and its folder is the only one `sendGroupMessage`
 *   accepts attachments from. Taking it from the request rather than resolving
 *   it is how a client stages files in a thread they are not in.
 *
 *   The deny-list and the magic-byte sniff, now against what storage recorded.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  createPortalUser,
  as,
  tokenFor,
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
let client: Actor;
/** A portal user of a DIFFERENT firm. */
let outsider: Actor;

const initPath = (id: string) => `/api/client-portal/lawfirm/${id}/messages/attachments/upload-init`;
const finalizePath = (id: string) => `/api/client-portal/lawfirm/${id}/messages/attachments/upload-finalize`;

const declared = (name = 'receipt.pdf', size = 2048) => declaredPdf(name, size);

const init = (actor: Actor, files: any[] = [declared()], over: Record<string, unknown> = {}, id?: string) =>
  actor.api.post(initPath(id ?? firm.id)).send({ files, ...over });

const finalize = (actor: Actor, body: Record<string, unknown>, id?: string) =>
  actor.api.post(finalizePath(id ?? firm.id)).send(body);

const landAll = (uploads: any[], over: Record<string, unknown> = {}) => landAllAs(uploads, 2048, over);

const usageOf = storageUsageOf;

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Portal LLP' });
  const portal = await createPortalUser({ name: 'Ada Client' });
  await createPersonClient(firm.id, { name: 'Ada Client', userId: portal.uid });
  client = { uid: portal.uid, api: as(tokenFor({ uid: portal.uid })) };

  const otherFirm = await createFirm({ name: 'Other LLP' });
  const otherPortal = await createPortalUser({ name: 'Bob' });
  await createPersonClient(otherFirm.id, { name: 'Bob', userId: otherPortal.uid });
  outsider = { uid: otherPortal.uid, api: as(tokenFor({ uid: otherPortal.uid })) };
});

describe('who may attach', () => {
  it('lets a client of the firm open the upload', async () => {
    const res = await init(client);

    expect(res.status).toBe(200);
    expect(res.body.uploads).toHaveLength(1);
  });

  it('refuses a client of another firm at init', async () => {
    expect((await init(outsider)).status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a client of another firm at FINALIZE', async () => {
    // The association used to be checked once, on the route that took the
    // bytes. Split in two, a finalize that skips it lets an outsider record
    // attachments against a firm they have no relationship with.
    const opened = await init(client);
    landAll(opened.body.uploads);

    const res = await finalize(outsider, {
      uploads: opened.body.uploads, reservedBytes: opened.body.reservedBytes,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a firm member, who is not a portal caller', async () => {
    const { ownerOf } = await import('../support/setupInProcess');
    const owner = await ownerOf(firm.id);

    expect((await init(owner)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('where the bytes land', () => {
  it('defaults to the client own direct-thread folder', async () => {
    const res = await init(client);

    expect(res.body.uploads[0].objectPath)
      .toContain(`lawfirmids/${firm.id}/messaging/${firm.id}_${client.uid}/`);
  });

  it('creates nothing until the browser uploads', async () => {
    await init(client);

    expect([...objects.keys()]).toEqual([]);
  });

  it('will not put a client into a group thread they are not in', async () => {
    // A group folder is the only one `sendGroupMessage` accepts attachments
    // from, and writing there requires active participation. Taken from the
    // request unchecked, this is a way into a thread the client is not in.
    const { rows } = await testPool.query(
      `insert into conversations (law_firm_id, conversation_type, title)
       values ($1, 'group', 'Staff only') returning id`,
      [firm.id],
    );
    const groupId = rows[0].id;

    const res = await init(client, [declared()], { conversationId: groupId });

    // Refused outright rather than quietly redirected to the client's own
    // folder. Both keep the files out of the group, but a refusal also tells
    // the caller, and a silent redirect would hide a client repeatedly aiming
    // at threads they are not in.
    expect(res.status).toBe(403);
    expect([...objects.keys()]).toEqual([]);
  });

  it('DOES use the group folder for a group the client is in', async () => {
    // The positive half. Without it the case above would pass just as well
    // against a route that refused every group.
    const { rows } = await testPool.query(
      `insert into conversations (law_firm_id, conversation_type, title)
       values ($1, 'group', 'Case team') returning id`,
      [firm.id],
    );
    const groupId = rows[0].id;
    await testPool.query(
      `insert into conversation_participants
         (conversation_id, participant_user_id, law_firm_id, participant_type)
       values ($1, $2, $3, 'client')`,
      [groupId, client.uid, firm.id],
    );

    const res = await init(client, [declared()], { conversationId: groupId });

    expect(res.status).toBe(200);
    expect(res.body.uploads[0].objectPath).toContain(`group_${groupId}`);
  });

  it('refuses an object path outside the resolved folder at finalize', async () => {
    landUpload(`lawfirmids/${firm.id}/objects/secret.pdf`, {
      bytes: 10, contentType: 'application/pdf', head: PDF_HEAD,
    });

    const res = await finalize(client, {
      uploads: [{ objectPath: `lawfirmids/${firm.id}/objects/secret.pdf`, fileName: 's.pdf', declaredSize: 10 }],
      reservedBytes: 10,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('admission', () => {
  it('refuses an executable by name and type before reserving quota', async () => {
    // The deny-list this route carries specifically because the caller is
    // outside the firm.
    const before = await usageOf(firm.id);

    const res = await init(client, [{ fileName: 'payload.exe', contentType: 'application/x-msdownload', size: 10 }]);

    expect(res.status).toBe(415);
    expect(await usageOf(firm.id)).toEqual(before);
  });

  it('rejects an executable renamed as a pdf, at finalize', async () => {
    const opened = await init(client);
    landAll(opened.body.uploads, { head: EXE_HEAD });

    const res = await finalize(client, {
      uploads: opened.body.uploads, reservedBytes: opened.body.reservedBytes,
    });

    expect(res.status).toBe(201);
    expect(res.body.attachments).toEqual([]);
    expect(res.body.failures).toHaveLength(1);
  });

  it('caps how many files one request may carry', async () => {
    const six = Array.from({ length: 6 }, (_, i) => declared(`f${i}.pdf`));

    expect((await init(client, six)).status).toBe(400);
  });
});

describe('the firm storage quota', () => {
  it('charges the FIRM, not the client', async () => {
    const before = await usageOf(firm.id);

    await init(client, [declared('a.pdf', 2048)]);

    expect((await usageOf(firm.id)).reserved).toBe(before.reserved + 2048);
  });

  it('gives back the whole reservation when nothing was uploaded', async () => {
    const opened = await init(client, [declared('a.pdf', 2048)]);

    await finalize(client, { uploads: opened.body.uploads, reservedBytes: opened.body.reservedBytes });

    expect(await usageOf(firm.id)).toEqual({ used: 0, reserved: 0 });
  });

  it('ignores a client-supplied reservedBytes and settles only what init reserved', async () => {
    const opened = await init(client, [declared('a.pdf', 2048)]);
    landAll(opened.body.uploads);
    // Another upload in the same firm is mid-flight and holds its own reservation.
    await reserveStorageUsage({ lawFirmId: firm.id, createdBy: outsider.uid, sizes: [50_000] });

    const res = await finalize(client, { uploads: opened.body.uploads, reservedBytes: 51_000 });

    // A client outside the firm chose that number. Honoured, it released the
    // other uploader's live reservation along with this one.
    expect(res.status).toBe(201);
    expect(res.body.attachments).toHaveLength(1);
    expect(await usageOf(firm.id)).toEqual({ used: 2048, reserved: 50_000 });
  });

});

describe('what the caller gets back', () => {
  it('returns an attachment descriptor the send endpoint accepts', async () => {
    const opened = await init(client);
    landAll(opened.body.uploads);

    const res = await finalize(client, {
      uploads: opened.body.uploads, reservedBytes: opened.body.reservedBytes,
    });

    expect(res.status).toBe(201);
    const [attachment] = res.body.attachments;
    expect(attachment.objectPath).toBe(opened.body.uploads[0].objectPath);
    expect(attachment.name).toBe('receipt.pdf');
    expect(attachment.url).toBeTruthy();
  });
});
