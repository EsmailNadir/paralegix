/**
 * What tells a portal client's DIRECT thread that something changed.
 *
 * A client may not stream raw message rows (RLS, migration 0040): a row would
 * hand them the real sender of a "send as firm" message and the retained text
 * of a deleted one. Their direct thread instead re-reads through the masked
 * portal endpoint when it is pinged. A send moves the conversations row, which
 * the client watches, but an edit, a soft delete and the firm reading the
 * client's messages touch only message rows. Those fire the same content-free
 * Realtime broadcast a group thread uses, on the conversation's topic.
 *
 * Supabase is reached over `fetch`, so the spec points `SUPABASE_URL` at a host
 * that only this file answers and records what was posted there.
 */
import {
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  as,
  tokenFor,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const REALTIME_HOST = 'https://realtime-signal.example.test';
process.env.SUPABASE_URL = REALTIME_HOST;

interface Broadcast { topic: string; event: string; payload: Record<string, unknown>; private: boolean }
const broadcasts: Broadcast[] = [];

const walledFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input?.url);
  if (url.startsWith(`${REALTIME_HOST}/realtime/v1/api/broadcast`)) {
    broadcasts.push(...JSON.parse(String(init?.body)).messages);
    return new Response('{}', { status: 202 });
  }
  return walledFetch(input, init);
}) as typeof globalThis.fetch;

let firm: Firm;
let owner: Actor;
let client: Actor;

const M = () => `/api/lawfirms/${firm.id}/messaging`;

/** Settle the fire-and-forget broadcast the route started without awaiting. */
async function settle() {
  await drainEvents();
  await new Promise((resolve) => setImmediate(resolve));
}

const pingsFor = (conversationId: string) =>
  broadcasts.filter((b) => b.topic === `groupmsg:${conversationId}`);

async function firmSends(content: string) {
  const res = await owner.api.post(`${M()}/send`).send({ clientId: client.uid, content });
  expect(res.status).toBe(201);
  await settle();
  return { messageId: res.body.messageId as string, conversationId: res.body.conversationId as string };
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Signal LLP' });
  owner = await ownerOf(firm.id);
  const portal = await createPortalUser({ name: 'Ada Client' });
  await createPersonClient(firm.id, { name: 'Ada Client', userId: portal.uid });
  client = { uid: portal.uid, api: as(tokenFor({ uid: portal.uid })) };
  broadcasts.length = 0;
});

describe('a firm-side change the client must see live', () => {
  it('pings the direct thread when the firm edits a message', async () => {
    const { messageId, conversationId } = await firmSends('First wording');
    broadcasts.length = 0;

    const res = await owner.api.patch(`${M()}/messages/${messageId}`).send({ content: 'Second wording' });
    await settle();

    expect(res.status).toBe(200);
    expect(pingsFor(conversationId)).toEqual([{
      topic: `groupmsg:${conversationId}`,
      event: 'new',
      payload: { conversationId, messageId },
      private: false,
    }]);
  });

  it('pings the direct thread when the firm deletes a message', async () => {
    const { messageId, conversationId } = await firmSends('Retract this');
    broadcasts.length = 0;

    const res = await owner.api.delete(`${M()}/messages/${messageId}`);
    await settle();

    expect(res.status).toBe(200);
    expect(pingsFor(conversationId)).toEqual([expect.objectContaining({
      event: 'new', payload: { conversationId, messageId },
    })]);
  });

  it('pings the direct thread when the firm reads the client messages', async () => {
    const sent = await client.api.post(`/api/client-portal/lawfirm/${firm.id}/messages`)
      .send({ content: 'Question from the client' });
    expect(sent.status).toBe(200);
    const { conversationId, messageId } = sent.body;
    await settle();
    broadcasts.length = 0;

    const res = await owner.api.put(`${M()}/mark-read`).send({ conversationId, messageIds: [messageId] });
    await settle();

    expect(res.status).toBe(200);
    expect(res.body.markedCount).toBe(1);
    expect(pingsFor(conversationId)).toEqual([expect.objectContaining({
      event: 'new', payload: { conversationId },
    })]);
  });

  it('does not ping when a mark-read changed nothing', async () => {
    const sent = await client.api.post(`/api/client-portal/lawfirm/${firm.id}/messages`)
      .send({ content: 'Question from the client' });
    const { conversationId, messageId } = sent.body;
    await owner.api.put(`${M()}/mark-read`).send({ conversationId, messageIds: [messageId] });
    await settle();
    broadcasts.length = 0;

    const res = await owner.api.put(`${M()}/mark-read`).send({ conversationId, messageIds: [messageId] });
    await settle();

    expect(res.body.markedCount).toBe(0);
    expect(pingsFor(conversationId)).toEqual([]);
  });

  it('carries no message content on the ping', async () => {
    const { messageId } = await firmSends('Privileged wording');
    broadcasts.length = 0;

    await owner.api.patch(`${M()}/messages/${messageId}`).send({ content: 'Still privileged' });
    await settle();

    expect(broadcasts).toHaveLength(1);
    expect(JSON.stringify(broadcasts)).not.toContain('privileged');
    expect(JSON.stringify(broadcasts)).not.toContain('Privileged');
  });
});
