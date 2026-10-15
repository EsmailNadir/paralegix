/**
 * `setGroupPrivacy`'s `hideClientNames` toggle: the per-group setting that masks
 * a co-client's identity from other client viewers over the REST API.
 *
 * This is a REST-layer control, distinct from and complementary to the RLS
 * policies covered in `tests/rls/messaging.test.ts` (R04): RLS stops a client
 * from reading a raw group `messages` row at the database layer at all. This
 * masking is what protects a firm-member-authored payload the client CAN
 * legitimately read - a co-client's name and photo inside a conversation the
 * client is allowed to see, gated by a setting a firm member controls per
 * thread. Neither layer is a substitute for the other.
 *
 * Before this file, nothing exercised `setGroupPrivacy`, `hideClientNames`, or
 * `clientNamesMasked` anywhere in the suite.
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

let firm: Firm;
let owner: Actor;
/** The client whose identity is the one being masked or not. */
let subjectUid: string;
/** A second client, the one whose view of `subjectUid` is under test. */
let viewerUid: string;
let viewerApi: ReturnType<typeof as>;

const M = () => `/api/lawfirms/${firm.id}/messaging`;
const clientGroupPath = (conversationId: string) => `/api/messaging/client-groups/${conversationId}`;

async function createGroup(body: Record<string, unknown>) {
  const res = await owner.api.post(`${M()}/groups`).send({ title: 'Case team', ...body });
  expect(res.status).toBe(201);
  return res.body.conversationId as string;
}

/** Firm-side send: the firm-scoped route requires `messaging.send`, a firm permission. */
async function sendToGroupAsFirm(conversationId: string, content: string, api = owner.api) {
  const res = await api.post(`${M()}/groups/${conversationId}/messages`).send({ content });
  expect(res.status).toBe(201);
  return res.body.messageId as string;
}

/** Client-side send: clients use the separate client-portal route, never the firm-scoped one. */
async function sendToGroupAsClient(conversationId: string, content: string, api: ReturnType<typeof as>) {
  const res = await api.post(`${clientGroupPath(conversationId)}/messages`).send({ content });
  expect(res.status).toBe(201);
  return res.body.messageId as string;
}

async function setPrivacy(conversationId: string, hideClientNames: boolean, api = owner.api) {
  return api.put(`${M()}/groups/${conversationId}/privacy`).send({ hideClientNames });
}

async function rawHideClientNames(conversationId: string) {
  const { rows } = await testPool.query(
    `select hide_client_names from conversations where id = $1`,
    [conversationId],
  );
  return rows[0]?.hide_client_names as boolean;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);

  const subject = await createPortalUser({ name: 'Sam Okafor' });
  subjectUid = subject.uid;
  await createPersonClient(firm.id, { name: 'Sam Okafor', userId: subjectUid });

  const viewer = await createPortalUser({ name: 'Dana Reyes' });
  viewerUid = viewer.uid;
  viewerApi = as(tokenFor({ uid: viewerUid }));
  await createPersonClient(firm.id, { name: 'Dana Reyes', userId: viewerUid });

  await drainEvents();
});

describe('setGroupPrivacy: persistence and permission', () => {
  it('persists hideClientNames on the conversation and returns it', async () => {
    const conversationId = await createGroup({ clientIds: [subjectUid, viewerUid] });

    const res = await setPrivacy(conversationId, true);

    expect(res.status).toBe(200);
    expect(res.body.hideClientNames).toBe(true);
    expect(await rawHideClientNames(conversationId)).toBe(true);
  });

  it('flips back off and persists that too', async () => {
    const conversationId = await createGroup({ clientIds: [subjectUid, viewerUid] });
    await setPrivacy(conversationId, true);

    const res = await setPrivacy(conversationId, false);

    expect(res.status).toBe(200);
    expect(res.body.hideClientNames).toBe(false);
    expect(await rawHideClientNames(conversationId)).toBe(false);
  });

  it('refuses a firm member without messaging.send', async () => {
    const conversationId = await createGroup({ clientIds: [subjectUid, viewerUid] });
    const bystander = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const bystanderApi = as(tokenFor({ uid: bystander.uid }));

    const res = await setPrivacy(conversationId, true, bystanderApi);

    expect(res.status).toBe(403);
    // The refusal must not have the side effect it was refused for.
    expect(await rawHideClientNames(conversationId)).toBe(false);
  });

  it('refuses a client, even a participant on the thread', async () => {
    const conversationId = await createGroup({ clientIds: [subjectUid, viewerUid] });

    const res = await setPrivacy(conversationId, true, viewerApi);

    expect([403, 404]).toContain(res.status);
    expect(await rawHideClientNames(conversationId)).toBe(false);
  });

  it('404s for a direct (non-group) conversation id', async () => {
    // A direct conversation between the firm and one client, not a group -
    // loadGroupConversationRow must not match it.
    const created = await owner.api.post(`${M()}/send`).send({ clientId: subjectUid, content: 'hi' });
    expect(created.status).toBe(201);
    const directId = created.body.conversationId as string;

    const res = await setPrivacy(directId, true);

    expect(res.status).toBe(404);
  });
});

describe('hideClientNames=true: what a client viewer is served', () => {
  it('masks a co-client name and email in the message list and roster, not the viewer\'s own', async () => {
    const conversationId = await createGroup({ clientIds: [subjectUid, viewerUid] });
    await sendToGroupAsClient(conversationId, 'From the subject client', as(tokenFor({ uid: subjectUid })));
    await sendToGroupAsClient(conversationId, 'From the viewer client', viewerApi);
    await drainEvents();
    const setRes = await setPrivacy(conversationId, true);
    expect(setRes.status).toBe(200);

    const res = await viewerApi.get(clientGroupPath(conversationId));

    expect(res.status).toBe(200);
    expect(res.body.conversation.hideClientNames).toBe(true);
    expect(res.body.conversation.clientNamesMasked).toBe(true);

    const subjectMessage = res.body.messages.find((m: any) => m.content === 'From the subject client');
    expect(subjectMessage.senderName).toBe('Client');

    const ownMessage = res.body.messages.find((m: any) => m.content === 'From the viewer client');
    expect(ownMessage.senderName).not.toBe('Client');
    expect(ownMessage.senderName).toContain('Dana');

    const subjectParticipant = res.body.participants.find((p: any) => p.userId === subjectUid);
    expect(subjectParticipant.name).toBe('Client');
    expect(subjectParticipant.email).toBe('');

    const ownParticipant = res.body.participants.find((p: any) => p.userId === viewerUid);
    expect(ownParticipant.name).not.toBe('Client');
  });

  it('leaves a co-client fully identified when the flag is off (the default)', async () => {
    const conversationId = await createGroup({ clientIds: [subjectUid, viewerUid] });
    await sendToGroupAsClient(conversationId, 'Visible by default', as(tokenFor({ uid: subjectUid })));
    await drainEvents();

    // No setPrivacy call at all: proves the un-set default is "visible", not
    // an implicit mask that only setPrivacy(false) would lift.
    const res = await viewerApi.get(clientGroupPath(conversationId));

    expect(res.status).toBe(200);
    expect(res.body.conversation.hideClientNames).toBe(false);
    expect(res.body.conversation.clientNamesMasked).toBe(false);

    const subjectMessage = res.body.messages.find((m: any) => m.content === 'Visible by default');
    expect(subjectMessage.senderName).not.toBe('Client');
    expect(subjectMessage.senderName).toContain('Sam');

    const subjectParticipant = res.body.participants.find((p: any) => p.userId === subjectUid);
    expect(subjectParticipant.name).not.toBe('Client');
    expect(subjectParticipant.email).not.toBe('');
  });

  it('reveals the real name again once the flag is turned back off', async () => {
    const conversationId = await createGroup({ clientIds: [subjectUid, viewerUid] });
    await sendToGroupAsClient(conversationId, 'Toggled message', as(tokenFor({ uid: subjectUid })));
    await drainEvents();
    await setPrivacy(conversationId, true);
    const maskedRes = await viewerApi.get(clientGroupPath(conversationId));
    expect(maskedRes.body.messages.find((m: any) => m.content === 'Toggled message').senderName).toBe('Client');

    await setPrivacy(conversationId, false);
    const unmaskedRes = await viewerApi.get(clientGroupPath(conversationId));

    expect(unmaskedRes.body.conversation.clientNamesMasked).toBe(false);
    const message = unmaskedRes.body.messages.find((m: any) => m.content === 'Toggled message');
    expect(message.senderName).toContain('Sam');
  });
});

describe('hideClientNames=true: a firm member is never masked', () => {
  it('sees every client\'s real name and email regardless of the flag', async () => {
    const conversationId = await createGroup({ clientIds: [subjectUid, viewerUid] });
    await sendToGroupAsClient(conversationId, 'From the subject client', as(tokenFor({ uid: subjectUid })));
    await drainEvents();
    const setRes = await setPrivacy(conversationId, true);
    expect(setRes.status).toBe(200);

    const res = await owner.api.get(`${M()}/groups/${conversationId}`);

    expect(res.status).toBe(200);
    // The raw setting travels to every viewer type; only client-side masking
    // is viewer-gated.
    expect(res.body.conversation.hideClientNames).toBe(true);
    expect(res.body.conversation.clientNamesMasked).toBe(false);

    const message = res.body.messages.find((m: any) => m.content === 'From the subject client');
    expect(message.senderName).toContain('Sam');

    const participant = res.body.participants.find((p: any) => p.userId === subjectUid);
    expect(participant.name).toContain('Sam');
    expect(participant.email).not.toBe('');
  });

  it('a second firm member added after the toggle also sees real names', async () => {
    const conversationId = await createGroup({ clientIds: [subjectUid] });
    await setPrivacy(conversationId, true);
    const colleague = await createFirmMember(firm.id, { isOwner: false, permissions: ['messaging.view', 'messaging.send'] });
    const addRes = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ memberIds: [colleague.uid] });
    expect(addRes.status).toBe(200);
    const colleagueApi = as(tokenFor({ uid: colleague.uid }));

    const res = await colleagueApi.get(`${M()}/groups/${conversationId}`);

    expect(res.status).toBe(200);
    const participant = res.body.participants.find((p: any) => p.userId === subjectUid);
    expect(participant.name).toContain('Sam');
  });
});
