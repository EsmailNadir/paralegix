/**
 * Cancelling a message attachment upload: `POST .../messaging/attachments/upload-cancel`.
 *
 * Init holds the declared bytes as reservations, one per file. Cancel deletes
 * them at once, so a user who abandons a large attachment gets the firm's quota
 * back immediately rather than when the reservation lapses.
 *
 * Message attachments have no file row, so the only record of an attachment is
 * the object itself and the message that names it. Cancel therefore deletes a
 * partial object only when it can PROVE the object is an unsent upload of this
 * caller's that is still in flight: under the folder this route authorizes,
 * stamped with this caller and the reservation being cancelled, that
 * reservation still live, and no saved message naming it. A sent attachment is
 * the firm's record of what the client was sent, and nothing here may take it.
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
import { rootOf, seedFile, seedReservation } from '../files/fileWorld';
import * as messagingRepo from '../../src/modules/messaging/messaging.repository';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let clientUid: string;

const base = (id: string) => `/api/lawfirms/${id}/messaging/attachments`;

const declared = (name = 'retainer.pdf', size = 4096) => ({
  fileName: name, contentType: 'application/pdf', size,
});

const init = (actor: Actor, files: any[] = [declared()]) =>
  actor.api.post(`${base(firm.id)}/upload-init`).send({ clientId: clientUid, files });

const finalize = (actor: Actor, uploads: any[]) =>
  actor.api.post(`${base(firm.id)}/upload-finalize`).send({ clientId: clientUid, uploads });

const cancel = (actor: Actor, uploads: any[], id?: string) =>
  actor.api.post(`${base(id ?? firm.id)}/upload-cancel`).send({ clientId: clientUid, uploads });

const echo = (u: any) => ({ objectPath: u.objectPath, reservationId: u.reservationId });

const land = (u: any) => landUpload(u.objectPath, { bytes: 4096, contentType: 'application/pdf', head: PDF_HEAD });

async function held(): Promise<number> {
  const { rows } = await testPool.query(
    `select coalesce(sum(bytes), 0)::bigint as held from storage_reservations
      where law_firm_id = $1 and expires_at > now()`, [firm.id],
  );
  return Number(rows[0].held);
}

async function used(): Promise<number> {
  const { rows } = await testPool.query('select storage_used_bytes from law_firms where id = $1', [firm.id]);
  return Number(rows[0].storage_used_bytes);
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Cancel LLP' });
  owner = await ownerOf(firm.id);
  const portal = await createPortalUser({ name: 'Ada Client' });
  clientUid = portal.uid;
  await createPersonClient(firm.id, { name: 'Ada Client', userId: clientUid });
});

describe('releasing the quota', () => {
  it('hands each opened upload a reservation id and holds its bytes', async () => {
    const opened = await init(owner, [declared('a.pdf', 4096), declared('b.pdf', 1000)]);

    expect(opened.body.uploads.every((u: any) => typeof u.reservationId === 'string')).toBe(true);
    expect(await held()).toBe(5096);
    expect(await used()).toBe(0);
  });

  it('frees the reservation at once', async () => {
    const opened = await init(owner, [declared('a.pdf', 4096), declared('b.pdf', 1000)]);

    const res = await cancel(owner, opened.body.uploads.map(echo));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: 2 });
    expect(await held()).toBe(0);
    expect(await used()).toBe(0);
  });

  it('finalize deletes the reservation too', async () => {
    const opened = await init(owner);
    land(opened.body.uploads[0]);

    await finalize(owner, opened.body.uploads);

    expect(await held()).toBe(0);
    expect(await used()).toBe(4096);
  });
});

describe('what happens to the bytes', () => {
  it('deletes a partial object of an upload still in flight', async () => {
    const opened = await init(owner);
    land(opened.body.uploads[0]);

    await cancel(owner, opened.body.uploads.map(echo));

    expect(objects.has(opened.body.uploads[0].objectPath)).toBe(false);
  });

  it('never deletes an attachment a sent message names', async () => {
    const opened = await init(owner);
    const upload = opened.body.uploads[0];
    land(upload);
    // Named by a message without being finalized. The send route refuses that
    // now, but a server-side post (the signed-copy delivery writes straight
    // through the repository) or a row from before the refusal can still name
    // an object whose reservation is live, so the cancel below must check.
    const sent = await messagingRepo.sendMessage(firm.id, {
      senderId: owner.uid,
      senderType: 'firm_member',
      senderName: 'Owner',
      sentAsFirm: false,
      clientId: clientUid,
      clientData: { name: 'Ada Client' },
      content: 'Here it is',
      attachments: [{
        name: 'retainer.pdf', objectPath: upload.objectPath, mimeType: 'application/pdf', size: 4096,
      }],
      matterId: null,
    });
    expect(sent.messageId).toBeTruthy();

    const res = await cancel(owner, [echo(upload)]);

    expect(res.body).toEqual({ cancelled: 1 });
    expect(objects.has(upload.objectPath)).toBe(true);
  });

  it('leaves the object of an upload that already finalized', async () => {
    const opened = await init(owner);
    const upload = opened.body.uploads[0];
    land(upload);
    await finalize(owner, [upload]);

    const res = await cancel(owner, [echo(upload)]);

    expect(res.body).toEqual({ cancelled: 0 });
    expect(objects.has(upload.objectPath)).toBe(true);
  });

  it('leaves an object outside the folder this request authorizes', async () => {
    const opened = await init(owner);
    const upload = opened.body.uploads[0];
    const foreign = `lawfirmids/${firm.id}/objects/someone-elses.pdf`;
    landUpload(foreign, {
      bytes: 10,
      custom: { uploadedBy: owner.uid, reservationId: upload.reservationId },
    });

    await cancel(owner, [{ objectPath: foreign, reservationId: upload.reservationId }]);

    expect(objects.has(foreign)).toBe(true);
  });
});

describe('who may cancel', () => {
  it('does not let another member release your upload', async () => {
    const colleague = await memberWith(firm.id, ['messaging.send']);
    const opened = await init(owner);
    land(opened.body.uploads[0]);

    const res = await cancel(colleague, opened.body.uploads.map(echo));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: 0 });
    expect(await held()).toBe(4096);
    expect(objects.has(opened.body.uploads[0].objectPath)).toBe(true);
  });

  it('refuses a member of another firm', async () => {
    const opened = await init(owner);
    land(opened.body.uploads[0]);
    const away = await createFirm();
    const awayOwner = await ownerOf(away.id);

    const res = await cancel(awayOwner, opened.body.uploads.map(echo));

    expect(res.status).toBe(403);
    expect(await held()).toBe(4096);
    expect(objects.has(opened.body.uploads[0].objectPath)).toBe(true);
  });

  it('refuses a portal client, who has their own route', async () => {
    const opened = await init(owner);
    const client = as(tokenFor({ uid: clientUid }));

    const res = await client.post(`${base(firm.id)}/upload-cancel`)
      .send({ clientId: clientUid, uploads: opened.body.uploads.map(echo) });

    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(await held()).toBe(4096);
  });
});

describe('attaching from the file manager', () => {
  /**
   * The copy path holds the bytes itself rather than going browser to storage,
   * so it reserves, copies, charges and releases within one request. It must
   * count other uploads' live reservations exactly as an init does, or a copy
   * slips past a hard limit that a concurrent upload is holding.
   */
  async function sourceDocument(bytes: number) {
    return seedFile(firm.id, { parentId: await rootOf(firm.id), name: 'Engagement.pdf', bytes });
  }
  const attach = (fileId: string) => owner.api.post(`${base(firm.id)}/from-files`)
    .send({ clientId: clientUid, files: [{ fileId }] });

  it('charges the copy and leaves nothing held', async () => {
    const source = await sourceDocument(2_000);

    const res = await attach(source.id);

    expect(res.status).toBe(201);
    expect(await used()).toBe(2_000);
    expect(await held()).toBe(0);
  });

  it('is refused when a live reservation leaves no room', async () => {
    const source = await sourceDocument(2_000);
    await testPool.query(
      'update law_firms set storage_quota_bytes = 10000, storage_hard_limit = true where id = $1', [firm.id],
    );
    const colleague = await memberWith(firm.id, ['messaging.send']);
    await seedReservation(firm.id, colleague.uid, 9_000);

    const res = await attach(source.id);

    expect(res.status).toBe(413);
    expect(await used()).toBe(0);
  });
});
