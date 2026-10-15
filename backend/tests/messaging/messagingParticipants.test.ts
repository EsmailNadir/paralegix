/**
 * A group thread's roster and its matter scope, changed while the thread is live.
 *
 * `messagingCore.test.ts` creates a group and proves a non-participant cannot
 * read it. It never changes one afterwards, and that is where the confidentiality
 * decisions actually live:
 *
 *  - Adding a client to a thread hands someone outside the firm a channel into
 *    the firm's correspondence, and cannot be taken back once they have read it.
 *    What they may read of what came BEFORE they arrived is a separate decision
 *    again, and its default flips depending on whose words are already there.
 *  - Removing someone has to end their access, not merely hide the thread.
 *  - Re-adding someone must not replay what was said while they were gone.
 *
 * `conversation_matters` is one of the two messaging tables with NO row-level
 * security (`conversations`, `messages` and `conversation_participants` have it;
 * Realtime reads through a Firebase-uid JWT while the backend writes as
 * `postgres` and bypasses it). So for matter scope the application check is the
 * ONLY check, and a cross-firm matter id that reaches the insert lands.
 *
 * Every absence below is measured against a second firm and a second client that
 * both hold real data.
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
/** The client the thread starts with. */
let clientUid: string;
let clientApi: ReturnType<typeof as>;
/** A second client of the same firm, added or excluded case by case. */
let laterUid: string;
let laterApi: ReturnType<typeof as>;
let otherFirm: Firm;
let otherOwner: Actor;

const M = () => `/api/lawfirms/${firm.id}/messaging`;

/** A matter, inserted directly so a wrong matters module cannot fake the fixture. */
async function seedMatter(lawFirmId: string, name: string, matterNumber: string) {
  const id = randomUUID();
  const { rowCount } = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_number, matter_reference_id, status)
     values ($1, $2, $3, $4, $5, 'active')`,
    [id, lawFirmId, name, matterNumber, `REF-${id.slice(0, 8)}`],
  );
  expect(rowCount).toBe(1);
  return { id, name, matterNumber };
}

/** Create a group the owner is in, with whatever participants the case needs. */
async function createGroup(body: Record<string, unknown>) {
  const res = await owner.api.post(`${M()}/groups`).send({ title: 'Working group', ...body });
  expect(res.status).toBe(201);
  return res.body.conversationId as string;
}

const sendToGroup = async (conversationId: string, content: string, api = owner.api) => {
  const res = await api.post(`${M()}/groups/${conversationId}/messages`).send({ content });
  expect(res.status).toBe(201);
  return res.body.messageId as string;
};

/** Active participant uids, read straight from Postgres. */
async function activeParticipants(conversationId: string) {
  const { rows } = await testPool.query(
    `select participant_user_id from conversation_participants
      where conversation_id = $1 and removed_at is null`,
    [conversationId],
  );
  return rows.map((r: any) => r.participant_user_id as string);
}

/** The user-authored message texts one viewer is served for a group thread. */
async function textsFor(api: ReturnType<typeof as>, path: string) {
  const res = await api.get(path);
  expect(res.status).toBe(200);
  return (res.body.messages as any[]).filter((m) => m.kind !== 'system').map((m) => m.content);
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);

  const portal = await createPortalUser({ name: 'Dana Reyes' });
  clientUid = portal.uid;
  clientApi = as(tokenFor({ uid: portal.uid }));
  await createPersonClient(firm.id, { name: 'Dana Reyes', userId: portal.uid });

  const later = await createPortalUser({ name: 'Sam Okafor' });
  laterUid = later.uid;
  laterApi = as(tokenFor({ uid: later.uid }));
  await createPersonClient(firm.id, { name: 'Sam Okafor', userId: later.uid });

  // A second firm with a group thread of its own, so the cross-firm absences
  // below have something real to fail to find.
  otherFirm = await createFirm();
  otherOwner = await ownerOf(otherFirm.id);
  const otherPortal = await createPortalUser();
  await createPersonClient(otherFirm.id, { name: 'Their Client', userId: otherPortal.uid });
  const theirs = await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/messaging/groups`)
    .send({ title: 'Their group', clientIds: [otherPortal.uid] });
  expect(theirs.status).toBe(201);

  await drainEvents();
});

describe('a conversation tied to a matter', () => {
  it('carries the matter name and number on the thread', async () => {
    const matter = await seedMatter(firm.id, 'Reyes v. Northgate', '2026-0042');
    const conversationId = await createGroup({ clientIds: [clientUid], matterIds: [matter.id] });

    const res = await owner.api.get(`${M()}/groups/${conversationId}`);

    expect(res.status).toBe(200);
    // The header renders these without a second, separately permissioned matters
    // fetch, so they have to travel with the thread.
    expect(res.body.conversation.matters).toEqual([
      { id: matter.id, name: 'Reyes v. Northgate', matterNumber: '2026-0042' },
    ]);
    expect(res.body.conversation.matterIds).toEqual([matter.id]);
  });

  it('mirrors the first matter of the set onto the conversation row', async () => {
    const first = await seedMatter(firm.id, 'Primary matter', 'P-1');
    const second = await seedMatter(firm.id, 'Secondary matter', 'P-2');

    const conversationId = await createGroup({
      clientIds: [clientUid], matterIds: [first.id, second.id],
    });

    const { rows } = await testPool.query(
      'select matter_id from conversations where id = $1', [conversationId],
    );
    // Message-event routing reads the single column, so a scope whose primary is
    // null routes nothing even though the thread displays two matters.
    expect(rows[0].matter_id).toBe(first.id);
  });

  it('REPLACES the scope rather than adding to it', async () => {
    const original = await seedMatter(firm.id, 'Original matter', 'M-1');
    const replacement = await seedMatter(firm.id, 'Replacement matter', 'M-2');
    const conversationId = await createGroup({
      clientIds: [clientUid], matterIds: [original.id],
    });

    const res = await owner.api.put(`${M()}/groups/${conversationId}/matters`)
      .send({ matterIds: [replacement.id] });

    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      'select matter_id from conversation_matters where conversation_id = $1', [conversationId],
    );
    // Replace-set semantics: a junction that only ever accumulated would leave
    // the thread tagged to a matter the firm deliberately untagged it from.
    expect(rows.map((r: any) => r.matter_id)).toEqual([replacement.id]);
  });

  it('clears the scope down to nothing', async () => {
    const matter = await seedMatter(firm.id, 'Scoped matter', 'M-3');
    const conversationId = await createGroup({ clientIds: [clientUid], matterIds: [matter.id] });

    const res = await owner.api.put(`${M()}/groups/${conversationId}/matters`).send({ matterIds: [] });

    expect(res.status).toBe(200);
    const junction = await testPool.query(
      'select 1 from conversation_matters where conversation_id = $1', [conversationId],
    );
    expect(junction.rowCount).toBe(0);
    const conv = await testPool.query('select matter_id from conversations where id = $1', [conversationId]);
    expect(conv.rows[0].matter_id).toBeNull();
  });

  it('refuses another firm matter at create time', async () => {
    const theirMatter = await seedMatter(otherFirm.id, 'Their matter', 'T-1');

    const res = await owner.api.post(`${M()}/groups`)
      .send({ title: 'Cross-tenant scope', clientIds: [clientUid], matterIds: [theirMatter.id] });

    expect(res.status).toBe(403);
    // `conversation_matters` has no RLS, so nothing below the application would
    // have stopped this row. Prove the row is absent, not just the response.
    const { rows } = await testPool.query(
      'select 1 from conversation_matters where matter_id = $1', [theirMatter.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses another firm matter when re-scoping an existing thread', async () => {
    const mine = await seedMatter(firm.id, 'My matter', 'M-4');
    const theirMatter = await seedMatter(otherFirm.id, 'Their matter', 'T-2');
    const conversationId = await createGroup({ clientIds: [clientUid], matterIds: [mine.id] });

    const res = await owner.api.put(`${M()}/groups/${conversationId}/matters`)
      .send({ matterIds: [theirMatter.id] });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      'select matter_id from conversation_matters where conversation_id = $1', [conversationId],
    );
    // The rejection has to happen BEFORE the replace, or refusing the new scope
    // still destroys the old one.
    expect(rows.map((r: any) => r.matter_id)).toEqual([mine.id]);
  });

  it('does not let a non-participant member re-scope the thread', async () => {
    const matter = await seedMatter(firm.id, 'Scoped matter', 'M-5');
    const other = await seedMatter(firm.id, 'Their idea of scope', 'M-6');
    const conversationId = await createGroup({ clientIds: [clientUid], matterIds: [matter.id] });
    const bystander = await createFirmMember(firm.id, {
      isOwner: false, permissions: ['messaging.view', 'messaging.send'],
    });

    const res = await as(tokenFor({ uid: bystander.uid }))
      .put(`${M()}/groups/${conversationId}/matters`).send({ matterIds: [other.id] });

    // messaging.send is a firm-wide baseline every member holds and gates nothing
    // per conversation. Participation is the real boundary.
    expect([403, 404]).toContain(res.status);
    const { rows } = await testPool.query(
      'select matter_id from conversation_matters where conversation_id = $1', [conversationId],
    );
    expect(rows.map((r: any) => r.matter_id)).toEqual([matter.id]);
  });
});

describe('adding a client to a live thread', () => {
  it('hides what another client already said', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid] });
    await sendToGroup(conversationId, 'Firm opening note');
    const clientSaid = await clientApi.post(`/api/messaging/client-groups/${conversationId}/messages`)
      .send({ content: 'Dana private answer' });
    expect(clientSaid.status).toBe(201);

    const added = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ clientIds: [laterUid] });
    expect(added.status).toBe(200);
    await sendToGroup(conversationId, 'Note after Sam joined');

    const texts = await textsFor(laterApi, `/api/messaging/client-groups/${conversationId}`);
    // With another client's words already in the thread, sharing the history
    // hands one client the other's correspondence. The default has to flip.
    expect(texts).toContain('Note after Sam joined');
    expect(texts).not.toContain('Dana private answer');
    expect(texts).not.toContain('Firm opening note');
  });

  it('shares a firm-only history by default', async () => {
    const colleague = await createFirmMember(firm.id, {
      isOwner: false, permissions: ['messaging.view', 'messaging.send'],
    });
    const conversationId = await createGroup({ memberIds: [colleague.uid] });
    await sendToGroup(conversationId, 'Internal background');

    const added = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ clientIds: [laterUid] });
    expect(added.status).toBe(200);

    const texts = await textsFor(laterApi, `/api/messaging/client-groups/${conversationId}`);
    // Nobody else's client words are in here, so the long-standing full-history
    // default stands. This is the complement of the case above: a rule that
    // hid history unconditionally would pass that one and fail this.
    expect(texts).toContain('Internal background');
  });

  it('hides the history when the firm says so explicitly', async () => {
    const conversationId = await createGroup({ memberIds: [] , clientIds: [clientUid] });
    await sendToGroup(conversationId, 'Earlier firm note');

    const added = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ clientIds: [laterUid], shareHistory: false });
    expect(added.status).toBe(200);
    await sendToGroup(conversationId, 'Later firm note');

    const texts = await textsFor(laterApi, `/api/messaging/client-groups/${conversationId}`);
    expect(texts).toContain('Later firm note');
    expect(texts).not.toContain('Earlier firm note');
  });

  it('shares the history when the firm ticks the box', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid] });
    await sendToGroup(conversationId, 'Firm opening note');
    const clientSaid = await clientApi.post(`/api/messaging/client-groups/${conversationId}/messages`)
      .send({ content: 'Dana answer to be shared' });
    expect(clientSaid.status).toBe(201);

    const added = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ clientIds: [laterUid], shareHistory: true });
    expect(added.status).toBe(200);

    const texts = await textsFor(laterApi, `/api/messaging/client-groups/${conversationId}`);
    // An explicit tick overrides the co-client default. Deliberate, and recorded
    // as such, but it must actually work or the firm has no way to brief a new
    // party at all.
    expect(texts).toContain('Dana answer to be shared');
    expect(texts).toContain('Firm opening note');
  });

  it('announces the new client in the thread', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid] });

    const added = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ clientIds: [laterUid], shareHistory: true });
    expect(added.status).toBe(200);

    const res = await owner.api.get(`${M()}/groups/${conversationId}`);
    const events = (res.body.messages as any[]).filter((m) => m.kind === 'system');
    // Someone arriving unannounced on a thread carrying privileged discussion is
    // how a client ends up writing to an audience they did not know they had.
    expect(events).toHaveLength(1);
    expect(events[0].systemEvent).toMatchObject({
      action: 'participant_added', subjectUserId: laterUid, subjectName: 'Sam Okafor',
    });
  });

  it('does not announce a re-add of someone already on the thread', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid, laterUid] });

    const added = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ clientIds: [laterUid] });
    expect(added.status).toBe(200);

    const res = await owner.api.get(`${M()}/groups/${conversationId}`);
    // A no-op add that posts an event fills a thread with notices about nothing.
    expect((res.body.messages as any[]).filter((m) => m.kind === 'system')).toHaveLength(0);
  });

  it('hides a firm member joining from the client viewer', async () => {
    const colleague = await createFirmMember(firm.id, {
      isOwner: false, permissions: ['messaging.view', 'messaging.send'], name: 'Priya Raman',
    });
    const conversationId = await createGroup({ clientIds: [clientUid] });

    const added = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ memberIds: [colleague.uid] });
    expect(added.status).toBe(200);

    const firmSide = await owner.api.get(`${M()}/groups/${conversationId}`);
    expect((firmSide.body.messages as any[]).some((m) => m.kind === 'system')).toBe(true);

    const clientSide = await clientApi.get(`/api/messaging/client-groups/${conversationId}`);
    expect(clientSide.status).toBe(200);
    // Which individual lawyers sit on a thread is internal. The firm side proves
    // the event exists, so this absence is a filter and not a missing write.
    expect((clientSide.body.messages as any[]).some((m) => m.kind === 'system')).toBe(false);
    expect(JSON.stringify(clientSide.body.messages)).not.toContain('Priya Raman');
  });

  it('requires manageParticipants to add a CLIENT', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid] });
    const staffer = await createFirmMember(firm.id, {
      isOwner: false, permissions: ['messaging.view', 'messaging.send'],
    });
    // On the thread, so the refusal below is about the permission and not about
    // participation.
    const seated = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ memberIds: [staffer.uid] });
    expect(seated.status).toBe(200);

    const res = await as(tokenFor({ uid: staffer.uid }))
      .post(`${M()}/groups/${conversationId}/participants`).send({ clientIds: [laterUid] });

    expect(res.status).toBe(403);
    expect(await activeParticipants(conversationId)).not.toContain(laterUid);
  });

  it('lets the same member add a COLLEAGUE on the baseline permission', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid] });
    const staffer = await createFirmMember(firm.id, {
      isOwner: false, permissions: ['messaging.view', 'messaging.send'],
    });
    const colleague = await createFirmMember(firm.id, {
      isOwner: false, permissions: ['messaging.view', 'messaging.send'],
    });
    const seated = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ memberIds: [staffer.uid] });
    expect(seated.status).toBe(200);

    const res = await as(tokenFor({ uid: staffer.uid }))
      .post(`${M()}/groups/${conversationId}/participants`).send({ memberIds: [colleague.uid] });

    // Internal staffing stays on the baseline. Without this the case above would
    // pass against a route that simply refused every add.
    expect(res.status).toBe(200);
    expect(await activeParticipants(conversationId)).toContain(colleague.uid);
  });

  it('does not let a non-participant member add themselves', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid] });
    const outsider = await createFirmMember(firm.id, {
      isOwner: false, permissions: ['messaging.view', 'messaging.send'],
    });

    const res = await as(tokenFor({ uid: outsider.uid }))
      .post(`${M()}/groups/${conversationId}/participants`).send({ memberIds: [outsider.uid] });

    expect([403, 404]).toContain(res.status);
    expect(await activeParticipants(conversationId)).not.toContain(outsider.uid);
  });

  it('does not let another firm add anyone to this thread', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid] });

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/messaging/groups/${conversationId}/participants`)
      .send({ memberIds: [otherOwner.uid] });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await activeParticipants(conversationId)).not.toContain(otherOwner.uid);
  });

  it('refuses a client who belongs to another firm', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid] });
    const stranger = await createPortalUser();
    await createPersonClient(otherFirm.id, { name: 'Their Person', userId: stranger.uid });

    const res = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ clientIds: [stranger.uid] });

    expect(res.status).toBe(403);
    expect(await activeParticipants(conversationId)).not.toContain(stranger.uid);
  });
});

describe('removing someone from a live thread', () => {
  it('ends their access to it', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid, laterUid] });
    await sendToGroup(conversationId, 'Before the removal');
    const before = await laterApi.get(`/api/messaging/client-groups/${conversationId}`);
    expect(before.status).toBe(200);

    const removed = await owner.api
      .delete(`${M()}/groups/${conversationId}/participants/${laterUid}`);
    expect(removed.status).toBe(200);
    await sendToGroup(conversationId, 'After the removal');

    const after = await laterApi.get(`/api/messaging/client-groups/${conversationId}`);
    // Read access BEFORE and refusal AFTER, so this is a change of state rather
    // than a thread they never reached.
    expect(after.status).toBe(403);
  });

  it('takes them off the roster the firm sees', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid, laterUid] });

    await owner.api.delete(`${M()}/groups/${conversationId}/participants/${laterUid}`);

    expect(await activeParticipants(conversationId)).not.toContain(laterUid);
    // Soft-removed, not deleted: who was on a thread is part of the record.
    const { rows } = await testPool.query(
      `select removed_at from conversation_participants
        where conversation_id = $1 and participant_user_id = $2`,
      [conversationId, laterUid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].removed_at).not.toBeNull();
  });

  it('announces the removal in the thread', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid, laterUid] });

    await owner.api.delete(`${M()}/groups/${conversationId}/participants/${laterUid}`);

    const res = await owner.api.get(`${M()}/groups/${conversationId}`);
    const events = (res.body.messages as any[]).filter((m) => m.kind === 'system');
    expect(events).toHaveLength(1);
    expect(events[0].systemEvent).toMatchObject({
      action: 'participant_removed', subjectUserId: laterUid, subjectName: 'Sam Okafor',
    });
  });

  it('refuses to remove yourself', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid] });

    const res = await owner.api.delete(`${M()}/groups/${conversationId}/participants/${owner.uid}`);

    // Leaving is a separate action with its own semantics; letting removal stand
    // in for it would strand a thread with no firm member on it.
    expect(res.status).toBe(400);
    expect(await activeParticipants(conversationId)).toContain(owner.uid);
  });

  it('does not replay what was said while they were gone', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid, laterUid] });
    await sendToGroup(conversationId, 'Said while Sam was present');
    await owner.api.delete(`${M()}/groups/${conversationId}/participants/${laterUid}`);
    await sendToGroup(conversationId, 'Said while Sam was away');

    const readded = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ clientIds: [laterUid] });
    expect(readded.status).toBe(200);
    await sendToGroup(conversationId, 'Said after Sam returned');

    const texts = await textsFor(laterApi, `/api/messaging/client-groups/${conversationId}`);
    // Removing someone, talking, and re-adding them must not hand them the
    // conversation they were deliberately kept out of.
    expect(texts).toContain('Said after Sam returned');
    expect(texts).not.toContain('Said while Sam was away');
    expect(texts).not.toContain('Said while Sam was present');
  });

  it('reopens the history only on an explicit share', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid, laterUid] });
    await owner.api.delete(`${M()}/groups/${conversationId}/participants/${laterUid}`);
    await sendToGroup(conversationId, 'Said while Sam was away');

    const readded = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ clientIds: [laterUid], shareHistory: true });
    expect(readded.status).toBe(200);

    const texts = await textsFor(laterApi, `/api/messaging/client-groups/${conversationId}`);
    expect(texts).toContain('Said while Sam was away');
  });

  it('does not let another firm remove a participant here', async () => {
    const conversationId = await createGroup({ clientIds: [clientUid, laterUid] });

    const res = await otherOwner.api
      .delete(`/api/lawfirms/${otherFirm.id}/messaging/groups/${conversationId}/participants/${laterUid}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await activeParticipants(conversationId)).toContain(laterUid);
  });
});

describe('adding someone to a direct thread', () => {
  it('converts it in place and keeps its history', async () => {
    const sent = await owner.api.post(`${M()}/send`)
      .send({ clientId: clientUid, content: 'The original 1:1 exchange' });
    expect(sent.status).toBe(201);
    const conversationId = sent.body.conversationId as string;

    const res = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ memberIds: [(await createFirmMember(firm.id, { isOwner: false, permissions: [] })).uid] });

    expect(res.status).toBe(200);
    expect(res.body.converted).toBe(true);
    const { rows } = await testPool.query(
      'select conversation_type from conversations where id = $1', [conversationId],
    );
    expect(rows[0].conversation_type).toBe('group');
    // Same id, same history. A conversion that opened a new thread would split
    // the client's correspondence in two, each half looking complete.
    const texts = await textsFor(owner.api, `${M()}/groups/${conversationId}`);
    expect(texts).toContain('The original 1:1 exchange');
  });

  it('seats the original client rather than locking them out', async () => {
    const sent = await owner.api.post(`${M()}/send`)
      .send({ clientId: clientUid, content: 'The original 1:1 exchange' });
    expect(sent.status).toBe(201);
    const conversationId = sent.body.conversationId as string;

    await owner.api.post(`${M()}/groups/${conversationId}/participants`)
      .send({ memberIds: [(await createFirmMember(firm.id, { isOwner: false, permissions: [] })).uid] });

    // Before conversion the client's access came from `conversations.client_id`;
    // after it, only a participant row grants access. Losing them here would
    // silently cut a client off from their own thread.
    expect(await activeParticipants(conversationId)).toContain(clientUid);
  });
});
