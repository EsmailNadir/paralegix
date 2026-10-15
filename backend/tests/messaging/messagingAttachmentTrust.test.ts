/**
 * What a message attachment is allowed to claim, and who it belongs to.
 *
 * An attachment arrives at send as a descriptor the CALLER wrote: an object
 * path, a name, a size and a type. Before any of it is stored the server has to
 * replace every claim with what storage recorded, because each one is used
 * later for something that matters:
 *
 *   - `size` is what deleting the message subtracts from the firm's tracked
 *     storage, so a forged size is a way to zero another tenant's usage meter.
 *   - The object path is shared ground. A direct thread's folder is written by
 *     BOTH sides, and every read serves the path back, so a path one person
 *     sent is visible to the other, who could name it in a message of their own
 *     and then delete that message to destroy the original.
 *   - Finalize is where the size cap, the magic-byte sniff and the quota charge
 *     happen. A send that accepts an object finalize never saw skips all three.
 *
 * Each case below seeds the thing it guards (real usage, a real sent object, a
 * real landed upload) so an absence is measured against something present.
 */
import {
  as,
  tokenFor,
  testPool,
  createFirm,
  createPersonClient,
  createPortalUser,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects, landUpload } from '../support/inMemoryBucket';
import { PDF_HEAD, EXE_HEAD, declaredPdf, storageUsageOf } from '../support/directUpload';
import { rootOf, seedFile } from '../files/fileWorld';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let client: Actor;

/** Usage the firm already carries from elsewhere, which no message may erase. */
const BASELINE_BYTES = 1_000_000;
const LANDED_BYTES = 2048;

const firmBase = () => `/api/lawfirms/${firm.id}/messaging`;
const portalBase = () => `/api/client-portal/lawfirm/${firm.id}/messages`;

/** Open, land and finalize one PDF through the portal, as the client. */
async function clientUpload(name = 'receipt.pdf', over: { bytes?: number; head?: Buffer } = {}) {
  const opened = await client.api.post(`${portalBase()}/attachments/upload-init`)
    .send({ files: [declaredPdf(name, over.bytes ?? LANDED_BYTES)] });
  expect(opened.status).toBe(200);
  const [upload] = opened.body.uploads;
  landUpload(upload.objectPath, {
    bytes: over.bytes ?? LANDED_BYTES, contentType: 'application/pdf', head: over.head ?? PDF_HEAD,
  });
  return upload;
}

async function clientFinalize(uploads: any[]) {
  const res = await client.api.post(`${portalBase()}/attachments/upload-finalize`).send({ uploads });
  expect(res.status).toBe(201);
  expect(res.body.failures).toEqual([]);
  return res.body.attachments as any[];
}

/** Open, land and finalize one PDF through the firm route, as `actor`. */
async function firmUpload(actor: Actor, name = 'engagement.pdf') {
  const opened = await actor.api.post(`${firmBase()}/attachments/upload-init`)
    .send({ clientId: client.uid, files: [declaredPdf(name, LANDED_BYTES)] });
  expect(opened.status).toBe(200);
  const [upload] = opened.body.uploads;
  landUpload(upload.objectPath, { bytes: LANDED_BYTES, contentType: 'application/pdf', head: PDF_HEAD });
  const done = await actor.api.post(`${firmBase()}/attachments/upload-finalize`)
    .send({ clientId: client.uid, uploads: [upload] });
  expect(done.status).toBe(201);
  expect(done.body.failures).toEqual([]);
  return done.body.attachments[0];
}

/** A descriptor exactly as a browser would send it, with whatever it claims. */
const descriptor = (objectPath: string, over: Record<string, unknown> = {}) => ({
  id: 'att-1',
  name: 'receipt.pdf',
  url: 'https://storage.example.test/signed',
  objectPath,
  mimeType: 'application/pdf',
  size: LANDED_BYTES,
  ...over,
});

const clientSend = (body: Record<string, unknown>) => client.api.post(portalBase()).send(body);

const clientDelete = (messageId: string) => client.api.delete(`/api/messaging/messages/${messageId}`);

async function usedBytes(): Promise<number> {
  return (await storageUsageOf(firm.id)).used;
}

async function storedAttachments(messageId: string): Promise<any[]> {
  const { rows } = await testPool.query('select attachments from messages where id = $1', [messageId]);
  expect(rows).toHaveLength(1);
  return rows[0].attachments;
}

async function messageCount(): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int as n from messages where law_firm_id = $1', [firm.id],
  );
  return rows[0].n;
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Trust LLP' });
  owner = await ownerOf(firm.id);
  const portal = await createPortalUser({ name: 'Ada Client' });
  await createPersonClient(firm.id, { name: 'Ada Client', userId: portal.uid });
  client = { uid: portal.uid, api: as(tokenFor({ uid: portal.uid })) };
  await testPool.query('update law_firms set storage_used_bytes = $2 where id = $1', [firm.id, BASELINE_BYTES]);
});

describe('the size an attachment claims', () => {
  it('stores what storage recorded, not what the sender wrote', async () => {
    const upload = await clientUpload();
    const [finalized] = await clientFinalize([upload]);

    const res = await clientSend({
      content: 'Receipt',
      attachments: [{ ...finalized, size: 9_000_000_000_000, mimeType: 'text/plain', name: 'other.txt' }],
    });

    expect(res.status).toBe(200);
    const [stored] = await storedAttachments(res.body.messageId);
    expect(stored.size).toBe(LANDED_BYTES);
    expect(stored.mimeType).toBe('application/pdf');
    expect(stored.name).toBe('receipt.pdf');
  });

  it('cannot reduce the firm usage below what deleting the real file frees', async () => {
    const upload = await clientUpload();
    const [finalized] = await clientFinalize([upload]);
    expect(await usedBytes()).toBe(BASELINE_BYTES + LANDED_BYTES);

    const sent = await clientSend({
      content: 'Receipt', attachments: [{ ...finalized, size: 9_000_000_000_000 }],
    });
    expect(sent.status).toBe(200);

    const deleted = await clientDelete(sent.body.messageId);

    expect(deleted.status).toBe(200);
    expect(objects.has(upload.objectPath)).toBe(false);
    expect(await usedBytes()).toBe(BASELINE_BYTES);
  });

  it('refuses an object that does not exist in the sender folder', async () => {
    const res = await clientSend({
      content: 'Phantom',
      attachments: [descriptor(`lawfirmids/${firm.id}/messaging/${firm.id}_${client.uid}/nothing.pdf`, {
        size: 9_000_000_000_000,
      })],
    });

    expect(res.status).toBe(400);
    expect(await messageCount()).toBe(0);
    expect(await usedBytes()).toBe(BASELINE_BYTES);
  });
});

describe('an object somebody else sent', () => {
  it('cannot be named by the other side of a direct thread', async () => {
    const theirs = await firmUpload(owner);
    const firmSent = await owner.api.post(`${firmBase()}/send`)
      .send({ clientId: client.uid, content: 'Engagement letter', attachments: [theirs] });
    expect(firmSent.status).toBe(201);

    const res = await clientSend({ content: 'Mine now', attachments: [descriptor(theirs.objectPath)] });

    expect(res.status).toBe(403);
    expect(await messageCount()).toBe(1);
  });

  it('cannot be named by a colleague in the same thread', async () => {
    const colleague = await memberWith(firm.id, ['messaging.send']);
    const theirs = await firmUpload(owner);

    const res = await colleague.api.post(`${firmBase()}/send`)
      .send({ clientId: client.uid, content: 'Forwarding', attachments: [theirs] });

    expect(res.status).toBe(403);
    expect(await messageCount()).toBe(0);
  });

  it('cannot be sent twice, even by the uploader', async () => {
    const upload = await clientUpload();
    const [finalized] = await clientFinalize([upload]);
    const first = await clientSend({ content: 'Once', attachments: [finalized] });
    expect(first.status).toBe(200);

    const second = await clientSend({ content: 'Twice', attachments: [finalized] });

    expect(second.status).toBe(403);
    expect(await messageCount()).toBe(1);
  });

  it('is never deleted with your message while another message names it', async () => {
    const upload = await clientUpload();
    const [finalized] = await clientFinalize([upload]);
    const mine = await clientSend({ content: 'Mine', attachments: [finalized] });
    expect(mine.status).toBe(200);
    // A second message naming the same object, written the way a server-side
    // post (or a row from before send checked references) writes one: straight
    // to the table, not through the send route that now refuses it.
    const { rows: [conv] } = await testPool.query(
      'select conversation_id from messages where id = $1', [mine.body.messageId],
    );
    await testPool.query(
      `insert into messages (law_firm_id, conversation_id, sender_user_id, sender_type, content, attachments)
       values ($1, $2, $3, 'firm_member', 'Keeps it', $4::jsonb)`,
      [firm.id, conv.conversation_id, owner.uid, JSON.stringify([{
        name: 'receipt.pdf', objectPath: upload.objectPath, mimeType: 'application/pdf', size: LANDED_BYTES,
      }])],
    );
    const usedBefore = await usedBytes();

    const deleted = await clientDelete(mine.body.messageId);

    expect(deleted.status).toBe(200);
    expect(objects.has(upload.objectPath)).toBe(true);
    expect(await usedBytes()).toBe(usedBefore);
  });
});

describe('an upload finalize never saw', () => {
  it('is refused at send', async () => {
    const upload = await clientUpload();

    const res = await clientSend({ content: 'Skipped finalize', attachments: [descriptor(upload.objectPath)] });

    expect(res.status).toBe(400);
    expect(await messageCount()).toBe(0);
  });

  it('is refused at send even when finalize would have rejected the bytes', async () => {
    const upload = await clientUpload('setup.pdf', { head: EXE_HEAD });

    const res = await clientSend({ content: 'Run this', attachments: [descriptor(upload.objectPath)] });

    expect(res.status).toBe(400);
    expect(await messageCount()).toBe(0);
  });

  it('is refused on the firm route too', async () => {
    const opened = await owner.api.post(`${firmBase()}/attachments/upload-init`)
      .send({ clientId: client.uid, files: [declaredPdf('x.pdf', LANDED_BYTES)] });
    const [upload] = opened.body.uploads;
    landUpload(upload.objectPath, { bytes: LANDED_BYTES, contentType: 'application/pdf', head: PDF_HEAD });

    const res = await owner.api.post(`${firmBase()}/send`)
      .send({ clientId: client.uid, content: 'Skipped', attachments: [descriptor(upload.objectPath)] });

    expect(res.status).toBe(400);
    expect(await messageCount()).toBe(0);
  });

  it('accepts a file-manager copy, which is admitted by the copy itself', async () => {
    const source = await seedFile(firm.id, { parentId: await rootOf(firm.id), name: 'Engagement.pdf', bytes: 3000 });
    const attached = await owner.api.post(`${firmBase()}/attachments/from-files`)
      .send({ clientId: client.uid, files: [{ fileId: source.id }] });
    expect(attached.status).toBe(201);

    const res = await owner.api.post(`${firmBase()}/send`)
      .send({ clientId: client.uid, content: 'From the file manager', attachments: attached.body.attachments });

    expect(res.status).toBe(201);
    const [stored] = await storedAttachments(res.body.messageId);
    expect(stored.objectPath).toBe(attached.body.attachments[0].objectPath);
  });
});

describe('what a portal send may carry', () => {
  const inFolder = (n: number) => `lawfirmids/${firm.id}/messaging/${firm.id}_${client.uid}/f${n}.pdf`;

  it('refuses more than five attachments', async () => {
    const res = await clientSend({
      content: 'Six', attachments: [0, 1, 2, 3, 4, 5].map((n) => descriptor(inFolder(n))),
    });

    expect(res.status).toBe(400);
    expect(await messageCount()).toBe(0);
  });

  it('refuses content past the firm limit of 4000 characters', async () => {
    const res = await clientSend({ content: 'x'.repeat(4001) });

    expect(res.status).toBe(400);
    expect(await messageCount()).toBe(0);
  });

  it('refuses an attachment missing the fields the firm schema requires', async () => {
    const res = await clientSend({ content: 'Odd shape', attachments: [{ objectPath: inFolder(0) }] });

    expect(res.status).toBe(400);
    expect(await messageCount()).toBe(0);
  });

  it('still accepts 4000 characters', async () => {
    const res = await clientSend({ content: 'x'.repeat(4000) });

    expect(res.status).toBe(200);
  });
});

describe('finalize', () => {
  it('refuses more uploads than one message may carry on the firm route', async () => {
    const opened = await owner.api.post(`${firmBase()}/attachments/upload-init`)
      .send({ clientId: client.uid, files: [declaredPdf('a.pdf', 10)] });
    const [upload] = opened.body.uploads;
    landUpload(upload.objectPath, { bytes: 10, contentType: 'application/pdf', head: PDF_HEAD });

    const res = await owner.api.post(`${firmBase()}/attachments/upload-finalize`)
      .send({ clientId: client.uid, uploads: Array.from({ length: 6 }, () => upload) });

    expect(res.status).toBe(400);
    expect(await usedBytes()).toBe(BASELINE_BYTES);
  });

  it('charges a firm upload once however often it is finalized', async () => {
    const opened = await owner.api.post(`${firmBase()}/attachments/upload-init`)
      .send({ clientId: client.uid, files: [declaredPdf('a.pdf', LANDED_BYTES)] });
    const [upload] = opened.body.uploads;
    landUpload(upload.objectPath, { bytes: LANDED_BYTES, contentType: 'application/pdf', head: PDF_HEAD });
    const finalize = () => owner.api.post(`${firmBase()}/attachments/upload-finalize`)
      .send({ clientId: client.uid, uploads: [upload] });

    expect((await finalize()).status).toBe(201);
    expect(await usedBytes()).toBe(BASELINE_BYTES + LANDED_BYTES);
    const again = await finalize();

    expect(again.status).toBe(201);
    expect(again.body.attachments).toHaveLength(1);
    expect(await usedBytes()).toBe(BASELINE_BYTES + LANDED_BYTES);
  });

  it('charges a portal upload once however often it is finalized', async () => {
    const upload = await clientUpload();
    await clientFinalize([upload]);
    expect(await usedBytes()).toBe(BASELINE_BYTES + LANDED_BYTES);

    await clientFinalize([upload]);

    expect(await usedBytes()).toBe(BASELINE_BYTES + LANDED_BYTES);
  });
});
