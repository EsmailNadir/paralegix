/**
 * Unread counts and the read cursor, from both sides of a conversation.
 *
 * `messagingCore.test.ts` covers sending, groups, the canonical company thread
 * and search. This file covers what happens AFTER a message is sent: who it
 * counts as unread for, and what actually clears it.
 *
 * The unread badge is the single most-looked-at number in the product. Wrong in
 * one direction it nags a client who has read everything; wrong in the other it
 * hides a message from the person it was sent to, and neither shows up as an
 * error.
 *
 * ONE THING WORTH KNOWING FIRST: marking a DIRECT conversation read requires
 * `messageIds`. Passing `conversationId` alone works for a GROUP thread and is a
 * silent no-op for a direct one, which is characterised below.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
/** The portal user on the other end of the conversation. */
let clientUid: string;
let clientApi: ReturnType<typeof as>;

const M = () => `/api/lawfirms/${firm.id}/messaging`;
const P = () => `/api/client-portal/lawfirm/${firm.id}`;

const sendFromFirm = (content: string) =>
  owner.api.post(`${M()}/send`).send({ clientId: clientUid, content });

const clientConversationId = async () => {
  const res = await clientApi.get(`${P()}/messages/conversations`);
  return res.body.conversations[0].conversationId as string;
};

const clientUnread = async () => {
  const res = await clientApi.get('/api/client-portal/unread-count');
  return Number(res.body.totalUnread);
};

const messageIdsIn = async (conversationId: string) => {
  const { rows } = await testPool.query(
    'select id from messages where conversation_id = $1', [conversationId],
  );
  return rows.map((r: any) => r.id);
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const portal = await createPortalUser();
  clientUid = portal.uid;
  clientApi = as(tokenFor({ uid: portal.uid }));
  await createPersonClient(firm.id, { name: 'Messaged Client', userId: portal.uid });
  await drainEvents();
});

describe('what counts as unread for a client', () => {
  it('counts a message the firm sent them', async () => {
    await sendFromFirm('First');
    await drainEvents();

    expect(await clientUnread()).toBe(1);
  });

  it('counts each message separately', async () => {
    await sendFromFirm('First');
    await sendFromFirm('Second');
    await drainEvents();

    // A count that collapsed a thread to one would tell a client with ten
    // waiting messages that they have one.
    expect(await clientUnread()).toBe(2);
  });

  it('starts at zero with no messages', async () => {
    expect(await clientUnread()).toBe(0);
  });

  it('does NOT count a message the client sent themselves', async () => {
    await sendFromFirm('From the firm');
    await drainEvents();
    await clientApi.post(`${P()}/messages`).send({ content: 'My own reply' });
    await drainEvents();

    // Your own message is not something you need to read. Counting it leaves a
    // badge nobody can ever clear.
    expect(await clientUnread()).toBe(1);
  });

  it('breaks the count down by firm', async () => {
    await sendFromFirm('First');
    await drainEvents();

    const res = await clientApi.get('/api/client-portal/unread-count');
    // A client of several firms needs to know WHICH one is waiting on them.
    expect(res.body.unreadByFirm[firm.id]).toBe(1);
  });

  it('does not count another firm messages for this client', async () => {
    await sendFromFirm('First');
    await drainEvents();
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const otherPortal = await createPortalUser();
    await createPersonClient(otherFirm.id, { name: 'Other Client', userId: otherPortal.uid });
    await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/messaging/send`)
      .send({ clientId: otherPortal.uid, content: 'Not for you' });
    await drainEvents();

    // The count spans firms by design, so it has to span them CORRECTLY.
    expect(await clientUnread()).toBe(1);
  });
});

describe('clearing the count', () => {
  beforeEach(async () => {
    await sendFromFirm('First');
    await sendFromFirm('Second');
    await drainEvents();
  });

  it('marks the named messages read', async () => {
    const conversationId = await clientConversationId();
    const messageIds = await messageIdsIn(conversationId);

    const res = await clientApi.put(`${P()}/messages/mark-read`)
      .send({ conversationId, messageIds });

    expect(res.status).toBe(200);
    expect(res.body.markedCount).toBe(2);
  });

  it('drops the unread count to zero', async () => {
    const conversationId = await clientConversationId();
    const messageIds = await messageIdsIn(conversationId);

    await clientApi.put(`${P()}/messages/mark-read`).send({ conversationId, messageIds });
    await drainEvents();

    // Asserting the COUNT, not the reported markedCount. The two are computed
    // separately, and a mark that updated rows without moving the badge is the
    // failure a client actually experiences.
    expect(await clientUnread()).toBe(0);
  });

  it('clears only the messages named', async () => {
    const conversationId = await clientConversationId();
    const [first] = await messageIdsIn(conversationId);

    await clientApi.put(`${P()}/messages/mark-read`)
      .send({ conversationId, messageIds: [first] });
    await drainEvents();

    // One of two. A mark-read that cleared the whole thread regardless would
    // hide the message the client had not reached yet.
    expect(await clientUnread()).toBe(1);
  });

  it('CHARACTERISATION: a bare conversationId is a silent no-op on a DIRECT thread', async () => {
    const conversationId = await clientConversationId();

    const before = await clientUnread();
    const res = await clientApi.put(`${P()}/messages/mark-read`).send({ conversationId });
    await drainEvents();

    // Asserted as UNCHANGED rather than as a literal 2. The property is that the
    // call is a no-op, and pinning the absolute number instead made the case
    // depend on both seeded sends having fully settled, which flaked under load.
    // Comparing before and after tests the thing the case is actually about.
    //
    // 200 with "No messages to mark", and the count stays where it was.
    //
    // `markPortalMessagesRead` handles a bare `conversationId` for GROUP threads
    // and falls through to a `messageIds` requirement for direct ones, so the
    // same request shape succeeds on one kind of conversation and quietly does
    // nothing on the other. A caller reading only the status believes the thread
    // was cleared.
    //
    // Reported rather than changed: making it clear the whole thread is a
    // product decision, and the frontend already sends message ids. This test
    // goes red the moment someone makes that call.
    expect(res.status).toBe(200);
    expect(res.body.markedCount).toBe(0);
    expect(await clientUnread()).toBe(before);
    // And the before-count must be non-zero, or "unchanged" is vacuous.
    expect(before).toBeGreaterThan(0);
  });

  it('answers not-found for a conversation that does not exist', async () => {
    const res = await clientApi.put(`${P()}/messages/mark-read`)
      .send({ conversationId: '00000000-0000-0000-0000-000000000000' });

    expect(res.status).toBe(404);
  });

  it('does not let a client mark ANOTHER firm conversation read', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const otherPortal = await createPortalUser();
    await createPersonClient(otherFirm.id, { name: 'Other Client', userId: otherPortal.uid });
    await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/messaging/send`)
      .send({ clientId: otherPortal.uid, content: 'Theirs' });
    await drainEvents();
    const theirConversation = (await as(tokenFor({ uid: otherPortal.uid }))
      .get(`/api/client-portal/lawfirm/${otherFirm.id}/messages/conversations`))
      .body.conversations[0].conversationId;

    const res = await clientApi.put(`${P()}/messages/mark-read`)
      .send({ conversationId: theirConversation });

    // Marking someone else's thread read hides a message from the person it was
    // sent to, which is worse than the ordinary read-leak: it removes the signal
    // that they should look.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the firm side of a conversation', () => {
  it('lists the conversation once a message exists', async () => {
    await sendFromFirm('First');
    await drainEvents();

    const res = await owner.api.get(`${M()}/conversations`);

    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
  });

  it('serves the messages in that conversation', async () => {
    await sendFromFirm('Distinctive content');
    await drainEvents();
    const res = await owner.api.get(`${M()}/conversations`);
    const conversationId = res.body.conversations[0].conversationId;

    const detail = await owner.api.get(`${M()}/conversations/${conversationId}`);

    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).toContain('Distinctive content');
  });

  it('reuses ONE conversation for the same client', async () => {
    await sendFromFirm('First');
    await sendFromFirm('Second');
    await drainEvents();

    const res = await owner.api.get(`${M()}/conversations`);

    // Two threads with one client splits their history in half, and each half
    // looks complete.
    expect(res.body.conversations).toHaveLength(1);
  });

  it('reports an unread count for the firm', async () => {
    const res = await owner.api.get(`${M()}/unread-count`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('count');
  });

  it('does not serve another firm conversation by id', async () => {
    await sendFromFirm('Confidential content');
    await drainEvents();
    const conversationId = (await owner.api.get(`${M()}/conversations`))
      .body.conversations[0].conversationId;
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .get(`/api/lawfirms/${otherFirm.id}/messaging/conversations/${conversationId}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body ?? {})).not.toContain('Confidential content');
  });
});
