/**
 * Attachments, and editing or deleting a message after it has been sent.
 *
 * `messagingCore.test.ts` covers sending, groups, the canonical company thread
 * and search; `messagingReadState.test.ts` covers unread counts and the read
 * cursor. Neither touches an attachment or a message that changes after it was
 * sent, and both of those carry their own confidentiality rules:
 *
 *  - An attachment is referenced by a GCS `objectPath` the CALLER supplies, and
 *    the read path signs a fresh download URL for whatever is stored. Every firm
 *    shares one bucket, so the prefix check on that path is the only thing
 *    standing between a message and an arbitrary object read.
 *  - The signed URL is a bearer token. It must not be persisted on the row.
 *  - A deleted message keeps its row as a legal record, so "deleted" is a
 *    property of what is SERVED, not of what exists.
 *
 * Every absence asserted below is measured against a second firm and a second
 * client of the same firm, both seeded with real threads, so "not there" is a
 * statement about the boundary and not about an empty database.
 *
 * ON GCS: send admits an attachment only when storage holds a finalized object
 * at its path uploaded by the sender, so these cases run against the in-memory
 * bucket and `attachment()` puts that object in place. The checks that refuse a
 * send for what storage says are `messagingAttachmentTrust.test.ts`; here the
 * object exists so a refusal below is about the folder alone. These cases
 * assert the metadata that survives signing (objectPath, name, size), never a
 * URL.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createPortalUser,
  createFirmMember,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects, putObject } from '../support/inMemoryBucket';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
/** The portal uid the direct thread is keyed on. */
let clientUid: string;
/** A SECOND client of the SAME firm, whose folder must stay out of reach. */
let neighbourUid: string;
/** Another firm entirely, with its own owner and its own thread. */
let otherFirm: Firm;
let otherOwner: Actor;

const M = () => `/api/lawfirms/${firm.id}/messaging`;

/** The one folder prefix `sendMessage` accepts for a direct thread. */
const folderFor = (lawFirmId: string, targetUid: string) =>
  `lawfirmids/${lawFirmId}/messaging/${lawFirmId}_${targetUid}/`;

function attachment(objectPath: string, overrides: Record<string, unknown> = {}) {
  const described = {
    name: 'retainer.pdf', mimeType: 'application/pdf', size: 4096, ...overrides,
  } as { name: string; mimeType: string; size: number };
  // The finalized upload the owner would have made at this path, as finalize
  // leaves it in storage.
  putObject(objectPath, {
    bytes: described.size,
    contentType: described.mimeType,
    custom: { uploadedBy: owner.uid, originalName: described.name, finalizedAt: new Date().toISOString() },
  });
  return {
    id: 'att-1',
    name: 'retainer.pdf',
    // A live, access-granting signed URL, exactly as the upload endpoint returns
    // it. Whether this survives into the row is the point of the first case.
    url: 'https://storage.example.test/signed?X-Goog-Signature=deadbeef',
    objectPath,
    mimeType: 'application/pdf',
    size: 4096,
    ...overrides,
  };
}

const send = (body: Record<string, unknown>) =>
  owner.api.post(`${M()}/send`).send({ clientId: clientUid, ...body });

/** The raw stored row, read straight from Postgres rather than through the API. */
async function storedMessage(messageId: string) {
  const { rows } = await testPool.query(
    'select content, attachments, deleted_at, edited_at from messages where id = $1',
    [messageId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** The firm-side rendering of one direct conversation's messages. */
async function servedMessages(conversationId: string) {
  const res = await owner.api.get(`${M()}/conversations/${conversationId}`);
  expect(res.status).toBe(200);
  return res.body.messages as any[];
}

/** Push a message's send time back so the 30-minute modify window has closed. */
async function backdate(messageId: string, interval: string) {
  const { rowCount } = await testPool.query(
    `update messages set created_at = now() - $2::interval where id = $1`,
    [messageId, interval],
  );
  expect(rowCount).toBe(1);
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm();
  owner = await ownerOf(firm.id);

  const portal = await createPortalUser();
  clientUid = portal.uid;
  await createPersonClient(firm.id, { name: 'Messaged Client', userId: portal.uid });

  // A second client of the same firm. Their conversation folder is the nearest
  // thing to a legitimate path that must still be refused, and it exists.
  const neighbour = await createPortalUser();
  neighbourUid = neighbour.uid;
  await createPersonClient(firm.id, { name: 'Neighbour Client', userId: neighbour.uid });
  const neighbourThread = await owner.api.post(`${M()}/send`)
    .send({ clientId: neighbourUid, content: 'Neighbour thread exists' });
  expect(neighbourThread.status).toBe(201);

  // And a whole second firm with a live thread of its own, so a cross-firm
  // absence below is an absence of something real.
  otherFirm = await createFirm();
  otherOwner = await ownerOf(otherFirm.id);
  const otherPortal = await createPortalUser();
  await createPersonClient(otherFirm.id, { name: 'Their Client', userId: otherPortal.uid });
  const otherThread = await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/messaging/send`)
    .send({ clientId: otherPortal.uid, content: 'Other firm privileged text' });
  expect(otherThread.status).toBe(201);

  await drainEvents();
});

describe('what an attachment stores versus what it serves', () => {
  it('drops the signed url from the stored row and keeps the objectPath', async () => {
    const objectPath = `${folderFor(firm.id, clientUid)}retainer.pdf`;

    const res = await send({ content: 'Signed and returned', attachments: [attachment(objectPath)] });
    expect(res.status).toBe(201);

    const stored = await storedMessage(res.body.messageId);
    expect(stored.attachments).toHaveLength(1);
    // A signed URL is a bearer token that bypasses every permission check for as
    // long as it lives. Persisting it on the row leaves one in the database for
    // anyone who can read the row, and it is worthless anyway: it has expired
    // long before most reads. The key must be ABSENT, not merely falsy.
    expect(Object.keys(stored.attachments[0])).not.toContain('url');
    // The objectPath is what the read path re-signs from, so losing it makes the
    // attachment permanently unreachable while still looking present.
    expect(stored.attachments[0].objectPath).toBe(objectPath);
    expect(stored.attachments[0].name).toBe('retainer.pdf');
    expect(stored.attachments[0].size).toBe(4096);
  });

  it('serves the attachment metadata back on the firm read', async () => {
    const objectPath = `${folderFor(firm.id, clientUid)}retainer.pdf`;
    const res = await send({ content: 'With a file', attachments: [attachment(objectPath)] });
    expect(res.status).toBe(201);
    await drainEvents();

    const messages = await servedMessages(res.body.conversationId);
    const withFile = messages.find((m) => m.messageId === res.body.messageId);
    expect(withFile).toBeDefined();
    expect(withFile.attachments).toHaveLength(1);
    expect(withFile.attachments[0].objectPath).toBe(objectPath);
    expect(withFile.attachments[0].name).toBe('retainer.pdf');
  });

  it('accepts a message that is nothing but an attachment', async () => {
    const objectPath = `${folderFor(firm.id, clientUid)}scan.pdf`;

    const res = await send({ content: '', attachments: [attachment(objectPath, { name: 'scan.pdf' })] });

    // The send validator refuses an empty message, EXCEPT when a file carries it.
    // A client who is sent only a document must still receive it.
    expect(res.status).toBe(201);
  });

  it('previews an attachment-only message by its filename', async () => {
    const objectPath = `${folderFor(firm.id, clientUid)}deposition.pdf`;
    const res = await send({ content: '', attachments: [attachment(objectPath, { name: 'deposition.pdf' })] });
    expect(res.status).toBe(201);
    await drainEvents();

    const list = await owner.api.get(`${M()}/conversations?clientId=${clientUid}`);
    expect(list.status).toBe(200);
    const thread = list.body.conversations.find((c: any) => c.clientId === clientUid);
    // Without the filename fallback the inbox row for a document-only message is
    // blank, which reads as an empty thread rather than an unread file.
    expect(thread.lastMessagePreview).toBe('[Attachment: deposition.pdf]');
  });
});

describe('an attachment path is confined to its own conversation folder', () => {
  /** Every message in the firm, so "nothing was written" is checkable. */
  const messageCount = async () => {
    const { rows } = await testPool.query(
      'select count(*)::int as n from messages where law_firm_id = $1', [firm.id],
    );
    return rows[0].n as number;
  };

  it('refuses another client of the same firm', async () => {
    const before = await messageCount();

    const res = await send({
      content: 'Their document, my thread',
      attachments: [attachment(`${folderFor(firm.id, neighbourUid)}their-file.pdf`)],
    });

    // The firm owns both folders, so a firm-level prefix check passes this. The
    // conversation folder is the participant boundary, and it is the only one
    // that keeps one client's documents out of another client's portal.
    expect(res.status).toBe(403);
    expect(await messageCount()).toBe(before);
  });

  it('refuses the firm folder with no conversation segment', async () => {
    const before = await messageCount();

    const res = await send({
      content: 'Straight out of the firm folder',
      attachments: [attachment(`lawfirmids/${firm.id}/messaging/anything.pdf`)],
    });

    expect(res.status).toBe(403);
    expect(await messageCount()).toBe(before);
  });

  it('refuses another firm entirely', async () => {
    const before = await messageCount();

    const res = await send({
      content: 'Someone else privileged file',
      attachments: [attachment(`${folderFor(otherFirm.id, clientUid)}theirs.pdf`)],
    });

    expect(res.status).toBe(403);
    expect(await messageCount()).toBe(before);
  });

  it('refuses a path that merely starts like the right one', async () => {
    const before = await messageCount();
    // `{firm}_{client}evil/` shares the accepted prefix's characters up to the
    // trailing slash. Comparing without it lets a sibling folder through.
    const nearMiss = `lawfirmids/${firm.id}/messaging/${firm.id}_${clientUid}evil/file.pdf`;

    const res = await send({ content: 'Near miss', attachments: [attachment(nearMiss)] });

    expect(res.status).toBe(403);
    expect(await messageCount()).toBe(before);
  });
});

describe('a group thread has its own attachment folder', () => {
  let conversationId: string;

  beforeEach(async () => {
    const created = await owner.api.post(`${M()}/groups`)
      .send({ title: 'Attachment group', clientIds: [clientUid] });
    expect(created.status).toBe(201);
    conversationId = created.body.conversationId;
  });

  it('accepts a path under the group folder', async () => {
    const res = await owner.api.post(`${M()}/groups/${conversationId}/messages`).send({
      content: 'Group file',
      attachments: [attachment(`lawfirmids/${firm.id}/messaging/group_${conversationId}/brief.pdf`)],
    });

    expect(res.status).toBe(201);
  });

  it('refuses a direct thread path in a group', async () => {
    const res = await owner.api.post(`${M()}/groups/${conversationId}/messages`).send({
      content: 'Wrong folder',
      attachments: [attachment(`${folderFor(firm.id, clientUid)}brief.pdf`)],
    });

    // The two folder schemes are different keys for different participant sets.
    // Accepting a direct-thread path in a group would put a 1:1 document in front
    // of everyone on the group.
    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      `select count(*)::int as n from messages where conversation_id = $1`, [conversationId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses another group folder', async () => {
    const second = await owner.api.post(`${M()}/groups`)
      .send({ title: 'Second group', clientIds: [neighbourUid] });
    expect(second.status).toBe(201);

    const res = await owner.api.post(`${M()}/groups/${conversationId}/messages`).send({
      content: 'Other group file',
      attachments: [attachment(
        `lawfirmids/${firm.id}/messaging/group_${second.body.conversationId}/brief.pdf`,
      )],
    });

    expect(res.status).toBe(403);
  });
});

describe('reaching a thread through the wrong firm', () => {
  /**
   * The caller belongs to BOTH firms with different rights in each: full owner
   * of `otherFirm`, and a member of `firm` whose role grants no messaging
   * permission at all. `requirePermission` is evaluated against the :lawFirmId in
   * the PATH, so routing a request for this firm's conversation through the other
   * firm's path satisfies it. Only the conversation's own firm check refuses.
   *
   * Firm membership alone is not enough to make this case go red, which is why
   * the second role is deliberately empty: a caller who merely belonged to both
   * firms would be refused by the ordinary membership fallback and the case would
   * prove nothing about the path-firm check.
   */
  let dualApi: ReturnType<typeof as>;
  let conversationId: string;
  let messageId: string;

  beforeEach(async () => {
    const dual = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    // A full messaging role in the OTHER firm, not a second owner: a firm has
    // at most one owner (`members_one_owner_per_firm_idx`) and `otherFirm`
    // already has theirs. What the case needs is a caller whose rights in the
    // path firm satisfy `requirePermission`, which these two codes do.
    const dualRoleId = randomUUID();
    await testPool.query(
      `insert into roles (id, law_firm_id, name, is_built_in, permissions)
       values ($1, $2, 'Dual firm messaging', false, $3)`,
      [dualRoleId, otherFirm.id, ['messaging.view', 'messaging.send']],
    );
    await testPool.query(
      `insert into members (law_firm_id, user_id, role_id, is_owner, joined_at)
       values ($1, $2, $3, false, now())`,
      [otherFirm.id, dual.uid, dualRoleId],
    );
    dualApi = as(tokenFor({ uid: dual.uid }));

    const sent = await send({ content: 'Privileged wording for this firm only' });
    expect(sent.status).toBe(201);
    conversationId = sent.body.conversationId;
    messageId = sent.body.messageId;
    await drainEvents();
  });

  it('grants them the thread through their OWN firm path', async () => {
    // The control. They really are an owner of the other firm, so the refusal
    // below is about the conversation and not about a broken actor.
    const res = await dualApi.get(`/api/lawfirms/${otherFirm.id}/messaging/conversations`);

    expect(res.status).toBe(200);
  });

  it('refuses the conversation read', async () => {
    const res = await dualApi
      .get(`/api/lawfirms/${otherFirm.id}/messaging/conversations/${conversationId}`);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body ?? {})).not.toContain('Privileged wording for this firm only');
  });

  it('refuses to mark it read', async () => {
    // A message FROM the client: those are the only ones a firm-side mark-read
    // can move, so a firm-sent message would make this assertion vacuous.
    const inbound = await as(tokenFor({ uid: clientUid }))
      .post(`/api/client-portal/lawfirm/${firm.id}/messages`).send({ content: 'Client asking' });
    expect(inbound.status).toBe(200);
    await drainEvents();
    const { rows: before } = await testPool.query(
      `select id from messages where conversation_id = $1 and sender_type = 'client'`,
      [conversationId],
    );
    expect(before).toHaveLength(1);

    const res = await dualApi.put(`/api/lawfirms/${otherFirm.id}/messaging/mark-read`)
      .send({ conversationId, messageIds: [before[0].id] });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      'select read_by_firm from messages where id = $1', [before[0].id],
    );
    // Marking a thread read from outside it clears the badge for the people who
    // were supposed to answer, without any of them having seen it.
    expect(rows[0].read_by_firm).toBe(false);
  });
});

describe('editing a message', () => {
  let messageId: string;
  let conversationId: string;

  beforeEach(async () => {
    const res = await send({ content: 'Original wording' });
    expect(res.status).toBe(201);
    messageId = res.body.messageId;
    conversationId = res.body.conversationId;
    await drainEvents();
  });

  it('replaces the content for the sender', async () => {
    const res = await owner.api.patch(`${M()}/messages/${messageId}`)
      .send({ content: 'Corrected wording' });

    expect(res.status).toBe(200);
    const messages = await servedMessages(conversationId);
    const edited = messages.find((m) => m.messageId === messageId);
    expect(edited.content).toBe('Corrected wording');
    // The marker is what tells the reader the text they were quoted no longer
    // stands. An edit that leaves it null is an invisible rewrite.
    expect(edited.editedAt).not.toBeNull();
  });

  it('does not let a colleague rewrite it', async () => {
    const colleague = await createFirmMember(firm.id, {
      isOwner: false, permissions: ['messaging.view', 'messaging.send'],
    });
    const colleagueApi = as(tokenFor({ uid: colleague.uid }));

    const res = await colleagueApi.patch(`${M()}/messages/${messageId}`)
      .send({ content: 'Words I did not write' });

    expect(res.status).toBe(403);
    // Status alone would pass against a route that refuses AND writes. Read the
    // row: putting words in a colleague's mouth is the actual harm.
    expect((await storedMessage(messageId)).content).toBe('Original wording');
  });

  it('does not let the client rewrite the firm message', async () => {
    const clientApi = as(tokenFor({ uid: clientUid }));

    const res = await clientApi.patch(`/api/messaging/messages/${messageId}`)
      .send({ content: 'You said you would settle' });

    expect(res.status).toBe(403);
    expect((await storedMessage(messageId)).content).toBe('Original wording');
  });

  it('does not let another firm reach it at all', async () => {
    const res = await otherOwner.api
      .patch(`/api/lawfirms/${otherFirm.id}/messaging/messages/${messageId}`)
      .send({ content: 'Cross-tenant edit' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await storedMessage(messageId)).content).toBe('Original wording');
  });

  it('closes the window 30 minutes after sending', async () => {
    await backdate(messageId, '31 minutes');

    const res = await owner.api.patch(`${M()}/messages/${messageId}`)
      .send({ content: 'Too late' });

    // A message the other side has already read and acted on must not change
    // underneath them. 400, and the stored text is untouched.
    expect(res.status).toBe(400);
    expect((await storedMessage(messageId)).content).toBe('Original wording');
  });

  it('still allows an edit just inside the window', async () => {
    // The complement of the case above: without it, a window check that refused
    // EVERY edit would pass that one.
    await backdate(messageId, '29 minutes');

    const res = await owner.api.patch(`${M()}/messages/${messageId}`)
      .send({ content: 'Just in time' });

    expect(res.status).toBe(200);
    expect((await storedMessage(messageId)).content).toBe('Just in time');
  });

  it('refuses to empty a text-only message', async () => {
    const res = await owner.api.patch(`${M()}/messages/${messageId}`).send({ content: '   ' });

    // Same rule as sending. An emptied message renders as a blank bubble that
    // cannot be told from a rendering failure.
    expect(res.status).toBe(400);
    expect((await storedMessage(messageId)).content).toBe('Original wording');
  });

  it('allows emptying a message that carries an attachment', async () => {
    const withFile = await send({
      content: 'Caption to remove',
      attachments: [attachment(`${folderFor(firm.id, clientUid)}exhibit.pdf`)],
    });
    expect(withFile.status).toBe(201);

    const res = await owner.api.patch(`${M()}/messages/${withFile.body.messageId}`)
      .send({ content: '' });

    // The file IS the message here, so the non-empty rule is satisfied by the
    // attachment rather than by the text.
    expect(res.status).toBe(200);
    expect((await storedMessage(withFile.body.messageId)).content).toBe('');
  });
});

describe('deleting a message', () => {
  let messageId: string;
  let conversationId: string;

  beforeEach(async () => {
    const res = await send({
      content: 'Privileged wording to retract',
      attachments: [attachment(`${folderFor(firm.id, clientUid)}retract.pdf`)],
    });
    expect(res.status).toBe(201);
    messageId = res.body.messageId;
    conversationId = res.body.conversationId;
    await drainEvents();
  });

  it('masks the content on read while retaining the row', async () => {
    const res = await owner.api.delete(`${M()}/messages/${messageId}`);
    expect(res.status).toBe(200);

    const messages = await servedMessages(conversationId);
    const tombstone = messages.find((m) => m.messageId === messageId);
    // Present in the thread, occupying its slot, carrying no words.
    expect(tombstone).toBeDefined();
    expect(tombstone.deleted).toBe(true);
    expect(tombstone.content).toBe('');
    // And the row survives, because the record is a legal one. A hard delete
    // would make both halves of this case pass for the wrong reason.
    expect((await storedMessage(messageId)).content).toBe('Privileged wording to retract');
  });

  it('strips the attachments from the served message', async () => {
    await owner.api.delete(`${M()}/messages/${messageId}`);

    const messages = await servedMessages(conversationId);
    const tombstone = messages.find((m) => m.messageId === messageId);
    // A retracted message whose file is still downloadable is not retracted.
    expect(tombstone.attachments).toEqual([]);
  });

  it('drops the message out of search', async () => {
    const survivor = await send({ content: 'Privileged wording that stands' });
    expect(survivor.status).toBe(201);
    await owner.api.delete(`${M()}/messages/${messageId}`);
    await drainEvents();

    const res = await owner.api.get(`${M()}/search?q=Privileged%20wording`);

    expect(res.status).toBe(200);
    const ids = res.body.results.map((r: any) => r.messageId);
    // The sibling proves the search itself matched. Without it, an empty result
    // set would pass whether the filter worked or the query was broken.
    expect(ids).toContain(survivor.body.messageId);
    expect(ids).not.toContain(messageId);
  });

  it('does not let a colleague delete it', async () => {
    const colleague = await createFirmMember(firm.id, {
      isOwner: false, permissions: ['messaging.view', 'messaging.send'],
    });
    const colleagueApi = as(tokenFor({ uid: colleague.uid }));

    const res = await colleagueApi.delete(`${M()}/messages/${messageId}`);

    expect(res.status).toBe(403);
    expect((await storedMessage(messageId)).deleted_at).toBeNull();
  });

  it('does not let another firm delete it', async () => {
    const res = await otherOwner.api
      .delete(`/api/lawfirms/${otherFirm.id}/messaging/messages/${messageId}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await storedMessage(messageId)).deleted_at).toBeNull();
  });

  it('is idempotent', async () => {
    const first = await owner.api.delete(`${M()}/messages/${messageId}`);
    expect(first.status).toBe(200);
    const stampedAt = (await storedMessage(messageId)).deleted_at;

    const second = await owner.api.delete(`${M()}/messages/${messageId}`);

    // A retry after a dropped response must not read as a failure, and must not
    // move the recorded deletion time.
    expect(second.status).toBe(200);
    expect((await storedMessage(messageId)).deleted_at).toEqual(stampedAt);
  });

  it('refuses to edit a deleted message', async () => {
    await owner.api.delete(`${M()}/messages/${messageId}`);

    const res = await owner.api.patch(`${M()}/messages/${messageId}`)
      .send({ content: 'Back from the dead' });

    // Editing a tombstone would resurrect it: the read path only masks a row
    // whose deleted_at is set, and the edit path would otherwise happily write
    // new content behind it.
    expect(res.status).toBe(400);
  });

  it('closes the window 30 minutes after sending', async () => {
    await backdate(messageId, '31 minutes');

    const res = await owner.api.delete(`${M()}/messages/${messageId}`);

    expect(res.status).toBe(400);
    expect((await storedMessage(messageId)).deleted_at).toBeNull();
  });

  it('answers not-found for a message id that does not exist', async () => {
    const res = await owner.api.delete(`${M()}/messages/${randomUUID()}`);

    expect(res.status).toBe(404);
  });
});
