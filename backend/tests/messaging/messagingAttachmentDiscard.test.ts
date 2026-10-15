/**
 * Discarding an attachment that was uploaded but never sent:
 * `POST .../messaging/attachments/discard` (firm) and
 * `POST /api/client-portal/lawfirm/:lawFirmId/messages/attachments/discard`.
 *
 * Finalize charges an attachment's bytes to the firm's tracked usage. Removing
 * the chip from the composer before sending used to leave that object in
 * storage, counted against the quota forever: cancel only releases live
 * reservations, and a message attachment has no file row the file browser
 * could show. Discard is the way back.
 *
 * Message attachments have no row of their own, so the object is the only
 * record, and discard deletes one only when it can prove it is the caller's own
 * unsent upload: directly under a folder the caller may upload to for that
 * conversation, finalized, stamped with the caller as uploader, and named by no
 * message. A direct thread's folder is written by both the firm and the client,
 * so the uploader stamp is what keeps either side from deleting the other's
 * file. Usage drops by the size storage reports, once, however many times or
 * however concurrently the discard is repeated.
 */
import {
  as,
  testPool,
  tokenFor,
  createFirm,
  createPersonClient,
  createPortalUser,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects, landUpload } from '../support/inMemoryBucket';
import { PDF_HEAD } from '../support/directUpload';
import { rootOf, seedFile } from '../files/fileWorld';

installInMemoryBucket();

/** Usage the firm already carries from elsewhere, so a double decrement cannot hide behind a floor of zero. */
const BASELINE_USAGE = 50_000;

let firm: Firm;
let owner: Actor;
let client: Actor;

const firmBase = (id: string) => `/api/lawfirms/${id}/messaging/attachments`;
const portalBase = (id: string) => `/api/client-portal/lawfirm/${id}/messages/attachments`;

const declared = (name = 'retainer.pdf', size = 4096) => ({
  fileName: name, contentType: 'application/pdf', size,
});

/** Init, land and finalize one firm-side upload into the client's direct thread. Answers the attachment. */
async function firmUpload(actor: Actor, bytes = 4096) {
  const opened = await actor.api.post(`${firmBase(firm.id)}/upload-init`)
    .send({ clientId: client.uid, files: [declared('retainer.pdf', bytes)] });
  expect(opened.status).toBe(200);
  const upload = opened.body.uploads[0];
  landUpload(upload.objectPath, { bytes, contentType: 'application/pdf', head: PDF_HEAD });
  const done = await actor.api.post(`${firmBase(firm.id)}/upload-finalize`)
    .send({ clientId: client.uid, uploads: [upload] });
  expect(done.status).toBe(201);
  expect(done.body.attachments).toHaveLength(1);
  return done.body.attachments[0];
}

/** The same flow through the portal, as the client. */
async function portalUpload(bytes = 2048) {
  const opened = await client.api.post(`${portalBase(firm.id)}/upload-init`)
    .send({ files: [declared('receipt.pdf', bytes)] });
  expect(opened.status).toBe(200);
  const upload = opened.body.uploads[0];
  landUpload(upload.objectPath, { bytes, contentType: 'application/pdf', head: PDF_HEAD });
  const done = await client.api.post(`${portalBase(firm.id)}/upload-finalize`).send({ uploads: [upload] });
  expect(done.status).toBe(201);
  expect(done.body.attachments).toHaveLength(1);
  return done.body.attachments[0];
}

const discard = (actor: Actor, objectPaths: string[], id?: string) =>
  actor.api.post(`${firmBase(id ?? firm.id)}/discard`).send({ clientId: client.uid, objectPaths });

const portalDiscard = (objectPaths: string[]) =>
  client.api.post(`${portalBase(firm.id)}/discard`).send({ objectPaths });

async function used(): Promise<number> {
  const { rows } = await testPool.query('select storage_used_bytes from law_firms where id = $1', [firm.id]);
  return Number(rows[0].storage_used_bytes);
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Discard LLP' });
  owner = await ownerOf(firm.id);
  const portal = await createPortalUser({ name: 'Ada Client' });
  await createPersonClient(firm.id, { name: 'Ada Client', userId: portal.uid });
  client = { uid: portal.uid, api: as(tokenFor({ uid: portal.uid })) };
  await testPool.query('update law_firms set storage_used_bytes = $2 where id = $1', [firm.id, BASELINE_USAGE]);
});

describe('the firm route', () => {
  it('deletes an unsent upload and gives its bytes back', async () => {
    const att = await firmUpload(owner);
    expect(await used()).toBe(BASELINE_USAGE + 4096);

    const res = await discard(owner, [att.objectPath]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ discarded: 1 });
    expect(objects.has(att.objectPath)).toBe(false);
    expect(await used()).toBe(BASELINE_USAGE);
  });

  it('subtracts the size storage reports, not one the request could claim', async () => {
    const att = await firmUpload(owner, 4096);

    await owner.api.post(`${firmBase(firm.id)}/discard`)
      .send({ clientId: client.uid, objectPaths: [att.objectPath], size: 40_000 });

    expect(await used()).toBe(BASELINE_USAGE);
  });

  it('is idempotent: a second discard removes nothing and subtracts nothing', async () => {
    const att = await firmUpload(owner);
    await discard(owner, [att.objectPath]);

    const again = await discard(owner, [att.objectPath]);

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ discarded: 0 });
    expect(await used()).toBe(BASELINE_USAGE);
  });

  it('subtracts once when the same object is discarded concurrently', async () => {
    const att = await firmUpload(owner);

    const [a, b] = await Promise.all([discard(owner, [att.objectPath]), discard(owner, [att.objectPath])]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.discarded + b.body.discarded).toBe(1);
    expect(await used()).toBe(BASELINE_USAGE);
  });

  it('subtracts once when one request names the same path twice', async () => {
    const att = await firmUpload(owner);

    const res = await discard(owner, [att.objectPath, att.objectPath]);

    expect(res.body).toEqual({ discarded: 1 });
    expect(await used()).toBe(BASELINE_USAGE);
  });

  it('refuses another member\'s upload in the same thread', async () => {
    const colleague = await memberWith(firm.id, ['messaging.send']);
    const theirs = await firmUpload(colleague);

    const res = await discard(owner, [theirs.objectPath]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ discarded: 0 });
    expect(objects.has(theirs.objectPath)).toBe(true);
    expect(await used()).toBe(BASELINE_USAGE + 4096);
  });

  it('refuses the client\'s upload in the shared direct-thread folder', async () => {
    const theirs = await portalUpload();

    const res = await discard(owner, [theirs.objectPath]);

    expect(res.body).toEqual({ discarded: 0 });
    expect(objects.has(theirs.objectPath)).toBe(true);
  });

  it('refuses an attachment a message already names', async () => {
    const att = await firmUpload(owner);
    const sent = await owner.api.post(`/api/lawfirms/${firm.id}/messaging/send`)
      .send({ clientId: client.uid, content: 'Here it is', attachments: [att] });
    expect(sent.status).toBe(201);

    const res = await discard(owner, [att.objectPath]);

    expect(res.body).toEqual({ discarded: 0 });
    expect(objects.has(att.objectPath)).toBe(true);
    expect(await used()).toBe(BASELINE_USAGE + 4096);
  });

  it('leaves an upload that never finalized, which cancel owns', async () => {
    const opened = await owner.api.post(`${firmBase(firm.id)}/upload-init`)
      .send({ clientId: client.uid, files: [declared()] });
    const upload = opened.body.uploads[0];
    landUpload(upload.objectPath, { bytes: 4096, contentType: 'application/pdf', head: PDF_HEAD });

    const res = await discard(owner, [upload.objectPath]);

    expect(res.body).toEqual({ discarded: 0 });
    expect(objects.has(upload.objectPath)).toBe(true);
    expect(await used()).toBe(BASELINE_USAGE);
  });

  it('leaves the caller\'s own object outside the folder this request authorizes', async () => {
    const neighbour = await createPortalUser({ name: 'Ben Neighbour' });
    await createPersonClient(firm.id, { name: 'Ben Neighbour', userId: neighbour.uid });
    const elsewhere = `lawfirmids/${firm.id}/messaging/${firm.id}_${neighbour.uid}/1_x_own.pdf`;
    landUpload(elsewhere, {
      bytes: 10, custom: { uploadedBy: owner.uid, finalizedAt: new Date().toISOString() },
    });

    const res = await discard(owner, [elsewhere]);

    expect(res.body).toEqual({ discarded: 0 });
    expect(objects.has(elsewhere)).toBe(true);
  });

  it('refuses a member of another firm', async () => {
    const att = await firmUpload(owner);
    const away = await createFirm();
    const awayOwner = await ownerOf(away.id);

    const res = await discard(awayOwner, [att.objectPath]);

    expect(res.status).toBe(403);
    expect(objects.has(att.objectPath)).toBe(true);
    expect(await used()).toBe(BASELINE_USAGE + 4096);
  });

  it('refuses a portal client, who has their own route', async () => {
    const att = await firmUpload(owner);

    const res = await client.api.post(`${firmBase(firm.id)}/discard`)
      .send({ clientId: client.uid, objectPaths: [att.objectPath] });

    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(objects.has(att.objectPath)).toBe(true);
  });

  it('discards a copy attached from the file manager', async () => {
    const source = await seedFile(firm.id, { parentId: await rootOf(firm.id), name: 'Engagement.pdf', bytes: 2_000 });
    const attached = await owner.api.post(`${firmBase(firm.id)}/from-files`)
      .send({ clientId: client.uid, files: [{ fileId: source.id }] });
    expect(attached.status).toBe(201);
    const copy = attached.body.attachments[0];
    expect(await used()).toBe(BASELINE_USAGE + 2_000);

    const res = await discard(owner, [copy.objectPath]);

    expect(res.body).toEqual({ discarded: 1 });
    expect(objects.has(copy.objectPath)).toBe(false);
    expect(await used()).toBe(BASELINE_USAGE);
  });
});

describe('the portal route', () => {
  it('deletes the client\'s unsent upload and gives its bytes back', async () => {
    const att = await portalUpload(2048);
    expect(await used()).toBe(BASELINE_USAGE + 2048);

    const res = await portalDiscard([att.objectPath]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ discarded: 1 });
    expect(objects.has(att.objectPath)).toBe(false);
    expect(await used()).toBe(BASELINE_USAGE);
  });

  it('is idempotent', async () => {
    const att = await portalUpload(2048);
    await portalDiscard([att.objectPath]);

    const again = await portalDiscard([att.objectPath]);

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ discarded: 0 });
    expect(await used()).toBe(BASELINE_USAGE);
  });

  it('refuses the firm\'s upload in the shared direct-thread folder', async () => {
    const firmFile = await firmUpload(owner);

    const res = await portalDiscard([firmFile.objectPath]);

    expect(res.body).toEqual({ discarded: 0 });
    expect(objects.has(firmFile.objectPath)).toBe(true);
    expect(await used()).toBe(BASELINE_USAGE + 4096);
  });

  it('refuses an attachment the client already sent', async () => {
    const att = await portalUpload(2048);
    const sent = await client.api.post(`/api/client-portal/lawfirm/${firm.id}/messages`)
      .send({ content: 'Receipt attached', attachments: [att] });
    expect(sent.status).toBe(200);

    const res = await portalDiscard([att.objectPath]);

    expect(res.body).toEqual({ discarded: 0 });
    expect(objects.has(att.objectPath)).toBe(true);
  });

  it('refuses a client of another firm', async () => {
    const att = await portalUpload(2048);
    const otherFirm = await createFirm({ name: 'Other LLP' });
    const otherPortal = await createPortalUser({ name: 'Bob' });
    await createPersonClient(otherFirm.id, { name: 'Bob', userId: otherPortal.uid });
    const outsider = as(tokenFor({ uid: otherPortal.uid }));

    const res = await outsider.post(`${portalBase(firm.id)}/discard`).send({ objectPaths: [att.objectPath] });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(objects.has(att.objectPath)).toBe(true);
  });
});
