/**
 * Two things neither existing messaging spec touches: a recipient the firm added
 * BEFORE they had a portal account, and reading a thread that is longer than one
 * page.
 *
 * A pending recipient is a real, deliberate addition. The firm picked that person
 * and expects them on the thread; they simply have no Firebase uid yet, so they
 * wait in `conversation_participants` with a client_id and null participant_user_id.
 * Two consequences make this worth its own cases: they are invisible to every ordinary
 * roster read, so nothing tells the firm they are queued, and they join the thread
 * automatically the moment they accept an invitation. What they can read of what came
 * before has to survive that promotion, or accepting an invitation silently hands
 * them a back-history the firm chose to withhold.
 *
 * Paging matters for a plainer reason: `hasMore` and the cursor are the only way
 * a caller reaches the older half of a thread. A cursor that skips or repeats a
 * message loses correspondence without any screen looking broken.
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
let clientUid: string;
let clientApi: ReturnType<typeof as>;
let otherFirm: Firm;
let otherOwner: Actor;

const M = () => `/api/lawfirms/${firm.id}/messaging`;

/** A `users` row with a chosen email, so an invitation can be addressed to it. */
async function seedPortalUserWithEmail(email: string, name: string) {
  const uid = `portal-${randomUUID().slice(0, 8)}`;
  const { rowCount } = await testPool.query(
    `insert into users (id, email, name, user_type) values ($1, $2, $3, 'client')`,
    [uid, email, name],
  );
  expect(rowCount).toBe(1);
  return { uid, api: as(tokenFor({ uid, email })) };
}

/** A pending client invitation, inserted directly. */
async function seedClientInvite(lawFirmId: string, email: string, invitedBy: string) {
  const id = randomUUID();
  const token = `invite-token-${id}`;
  const { rowCount } = await testPool.query(
    `insert into invitations (id, law_firm_id, email, invite_type, token, status, invited_by)
     values ($1, $2, $3, 'client', $4, 'pending', $5)`,
    [id, lawFirmId, email, token, invitedBy],
  );
  expect(rowCount).toBe(1);
  return token;
}

/** Pending recipient client-record ids on one conversation, straight from Postgres. */
async function pendingRows(conversationId: string) {
  const { rows } = await testPool.query(
    `select client_id, history_visible_from from conversation_participants
      where conversation_id = $1 and participant_user_id is null and removed_at is null`,
    [conversationId],
  );
  return rows;
}

async function activeParticipants(conversationId: string) {
  const { rows } = await testPool.query(
    `select participant_user_id from conversation_participants
      where conversation_id = $1 and removed_at is null and participant_user_id is not null`,
    [conversationId],
  );
  return rows.map((r: any) => r.participant_user_id as string);
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);

  const portal = await createPortalUser({ name: 'Dana Reyes' });
  clientUid = portal.uid;
  clientApi = as(tokenFor({ uid: portal.uid }));
  await createPersonClient(firm.id, { name: 'Dana Reyes', userId: portal.uid });

  // A second firm with a live thread, so every cross-firm absence below is an
  // absence of something that exists.
  otherFirm = await createFirm();
  otherOwner = await ownerOf(otherFirm.id);
  const otherPortal = await createPortalUser();
  await createPersonClient(otherFirm.id, { name: 'Their Client', userId: otherPortal.uid });
  const theirs = await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/messaging/send`)
    .send({ clientId: otherPortal.uid, content: 'Other firm privileged text' });
  expect(theirs.status).toBe(201);

  await drainEvents();
});

describe('a recipient who has no portal account yet', () => {
  /** An unclaimed client record: a real person the firm has not invited yet. */
  const unclaimed = (email = 'unclaimed@example.test') =>
    createPersonClient(firm.id, { name: 'Unclaimed Person', email, userId: null });

  it('is stored as a pending recipient, not a participant', async () => {
    const record = await unclaimed();

    const created = await owner.api.post(`${M()}/groups`)
      .send({ title: 'Waiting room', clientRecordIds: [record.id] });

    expect(created.status).toBe(201);
    const pending = await pendingRows(created.body.conversationId);
    expect(pending.map((r: any) => r.client_id)).toEqual([record.id]);
    // There is no uid to key a participant row on. A row written anyway would
    // point at nobody and grant access to nobody, while looking seated.
    expect(await activeParticipants(created.body.conversationId)).toEqual([owner.uid]);
  });

  it('counts toward the "at least one other person" rule', async () => {
    const record = await unclaimed();

    const created = await owner.api.post(`${M()}/groups`)
      .send({ title: 'Only a pending recipient', clientRecordIds: [record.id] });

    // Nobody else is on this thread yet, and it is still a real conversation the
    // firm is composing. Refusing it would make an unregistered client
    // unaddressable until they signed up.
    expect(created.status).toBe(201);
  });

  it('is listed on the firm side of the thread with their name and email', async () => {
    const record = await unclaimed('waiting@example.test');
    const created = await owner.api.post(`${M()}/groups`)
      .send({ title: 'Waiting room', clientIds: [clientUid], clientRecordIds: [record.id] });
    expect(created.status).toBe(201);

    const res = await owner.api.get(`${M()}/groups/${created.body.conversationId}`);

    expect(res.status).toBe(200);
    // Nothing else surfaces them, so without this the firm sees no trace of
    // someone they deliberately chose, who then appears unannounced on the day
    // they register.
    expect(res.body.pendingClients).toEqual([
      { clientRecordId: record.id, name: 'Unclaimed Person', email: 'waiting@example.test', historyVisibleFrom: null },
    ]);
  });

  it('is not disclosed to a client viewer of the same thread', async () => {
    const record = await unclaimed('waiting@example.test');
    const created = await owner.api.post(`${M()}/groups`)
      .send({ title: 'Waiting room', clientIds: [clientUid], clientRecordIds: [record.id] });
    expect(created.status).toBe(201);

    const res = await clientApi.get(`/api/messaging/client-groups/${created.body.conversationId}`);

    expect(res.status).toBe(200);
    // The firm-side case above proves the list is populated, so this is a
    // withheld field rather than an empty one. Who else the firm has lined up is
    // not a client's business.
    expect(res.body.pendingClients).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('waiting@example.test');
  });

  it('refuses a client record belonging to another firm', async () => {
    const theirRecord = await createPersonClient(otherFirm.id, {
      name: 'Their Unclaimed', email: 'theirs@example.test', userId: null,
    });

    const created = await owner.api.post(`${M()}/groups`)
      .send({ title: 'Cross-tenant recipient', clientRecordIds: [theirRecord.id] });

    expect(created.status).toBe(403);
    // No RLS on this table, so the application refusal is the whole defence.
    const { rows } = await testPool.query(
      'select 1 from conversation_participants where client_id = $1 and participant_user_id is null', [theirRecord.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses an ORGANIZATION record as a recipient', async () => {
    const org = await testPool.query(
      `insert into clients (id, law_firm_id, name, client_type) values ($1, $2, 'Northgate LLC', 'company')`,
      [randomUUID(), firm.id],
    );
    expect(org.rowCount).toBe(1);
    const { rows } = await testPool.query(
      `select id from clients where law_firm_id = $1 and client_type = 'company'`, [firm.id],
    );

    const created = await owner.api.post(`${M()}/groups`)
      .send({ title: 'Organization as recipient', clientRecordIds: [rows[0].id] });

    // An organization can never hold a portal uid, so seating one as a recipient
    // creates a pending row that can never be promoted.
    expect(created.status).toBe(403);
  });

  describe('taking them off again', () => {
    it('removes the pending row', async () => {
      const record = await unclaimed();
      const created = await owner.api.post(`${M()}/groups`)
        .send({ title: 'Waiting room', clientRecordIds: [record.id] });
      expect(created.status).toBe(201);
      expect(await pendingRows(created.body.conversationId)).toHaveLength(1);

      const res = await owner.api
        .delete(`${M()}/groups/${created.body.conversationId}/pending/${record.id}`);

      expect(res.status).toBe(200);
      expect(await pendingRows(created.body.conversationId)).toHaveLength(0);
    });

    it('requires manageParticipants', async () => {
      const record = await unclaimed();
      const created = await owner.api.post(`${M()}/groups`)
        .send({ title: 'Waiting room', clientRecordIds: [record.id] });
      expect(created.status).toBe(201);
      const conversationId = created.body.conversationId as string;
      const staffer = await createFirmMember(firm.id, {
        isOwner: false, permissions: ['messaging.view', 'messaging.send'],
      });
      const seated = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
        .send({ memberIds: [staffer.uid] });
      expect(seated.status).toBe(200);

      const res = await as(tokenFor({ uid: staffer.uid }))
        .delete(`${M()}/groups/${conversationId}/pending/${record.id}`);

      // Who outside the firm is on a thread is one decision, whichever direction
      // it moves in. The staffer is a participant, so this is the permission and
      // not the roster refusing.
      expect(res.status).toBe(403);
      expect(await pendingRows(conversationId)).toHaveLength(1);
    });

    it('answers not-found when there is nothing pending for that client', async () => {
      const record = await unclaimed();
      const created = await owner.api.post(`${M()}/groups`)
        .send({ title: 'Waiting room', clientIds: [clientUid] });
      expect(created.status).toBe(201);

      const res = await owner.api
        .delete(`${M()}/groups/${created.body.conversationId}/pending/${record.id}`);

      expect(res.status).toBe(404);
    });
  });

  describe('when that person is finally created for real', () => {
    it('joins the thread on accepting their invitation', async () => {
      const email = 'promoted@example.test';
      const record = await unclaimed(email);
      const created = await owner.api.post(`${M()}/groups`)
        .send({ title: 'Waiting room', clientRecordIds: [record.id] });
      expect(created.status).toBe(201);
      const conversationId = created.body.conversationId as string;
      const newcomer = await seedPortalUserWithEmail(email, 'Unclaimed Person');
      const token = await seedClientInvite(firm.id, email, owner.uid);

      const accepted = await newcomer.api.post('/api/invitations/accept').send({ token });
      expect(accepted.status).toBe(200);
      await drainEvents();

      // The pending row is consumed, not merely shadowed by a participant row.
      expect(await pendingRows(conversationId)).toHaveLength(0);
      expect(await activeParticipants(conversationId)).toContain(newcomer.uid);
    });

    it('lets them read the thread they were queued for', async () => {
      const email = 'promoted@example.test';
      const record = await unclaimed(email);
      const created = await owner.api.post(`${M()}/groups`)
        .send({ title: 'Waiting room', clientRecordIds: [record.id] });
      expect(created.status).toBe(201);
      const conversationId = created.body.conversationId as string;
      const newcomer = await seedPortalUserWithEmail(email, 'Unclaimed Person');
      const token = await seedClientInvite(firm.id, email, owner.uid);
      const before = await newcomer.api.get(`/api/messaging/client-groups/${conversationId}`);
      expect(before.status).toBe(403);

      await newcomer.api.post('/api/invitations/accept').send({ token });
      await drainEvents();
      const sent = await owner.api.post(`${M()}/groups/${conversationId}/messages`)
        .send({ content: 'Welcome aboard' });
      expect(sent.status).toBe(201);

      const after = await newcomer.api.get(`/api/messaging/client-groups/${conversationId}`);
      // Refused before, served after: the promotion is what changed, not the
      // thread's existence.
      expect(after.status).toBe(200);
      expect(JSON.stringify(after.body.messages)).toContain('Welcome aboard');
    });

    it('carries the withheld history across the promotion', async () => {
      const email = 'promoted@example.test';
      const record = await unclaimed(email);
      const created = await owner.api.post(`${M()}/groups`)
        .send({ title: 'Waiting room', clientIds: [clientUid] });
      expect(created.status).toBe(201);
      const conversationId = created.body.conversationId as string;
      const said = await clientApi.post(`/api/messaging/client-groups/${conversationId}/messages`)
        .send({ content: 'Dana confidential answer' });
      expect(said.status).toBe(201);
      // Added to a thread that already carries ANOTHER client's words, so the
      // default withholds the history and stamps a cutoff on the pending row.
      const added = await owner.api.post(`${M()}/groups/${conversationId}/participants`)
        .send({ clientRecordIds: [record.id] });
      expect(added.status).toBe(200);
      expect((await pendingRows(conversationId))[0].history_visible_from).not.toBeNull();

      const newcomer = await seedPortalUserWithEmail(email, 'Unclaimed Person');
      const token = await seedClientInvite(firm.id, email, owner.uid);
      await newcomer.api.post('/api/invitations/accept').send({ token });
      await drainEvents();
      const sent = await owner.api.post(`${M()}/groups/${conversationId}/messages`)
        .send({ content: 'Said after they joined' });
      expect(sent.status).toBe(201);

      const res = await newcomer.api.get(`/api/messaging/client-groups/${conversationId}`);
      expect(res.status).toBe(200);
      const texts = (res.body.messages as any[]).map((m) => m.content);
      // Registering must not be the thing that reopens correspondence the firm
      // chose to withhold. The later message proves the read itself works.
      expect(texts).toContain('Said after they joined');
      expect(texts).not.toContain('Dana confidential answer');
    });

    it('does not seat someone the firm took off the list first', async () => {
      const email = 'promoted@example.test';
      const record = await unclaimed(email);
      const created = await owner.api.post(`${M()}/groups`)
        .send({ title: 'Waiting room', clientRecordIds: [record.id], clientIds: [clientUid] });
      expect(created.status).toBe(201);
      const conversationId = created.body.conversationId as string;
      const removed = await owner.api
        .delete(`${M()}/groups/${conversationId}/pending/${record.id}`);
      expect(removed.status).toBe(200);

      const newcomer = await seedPortalUserWithEmail(email, 'Unclaimed Person');
      const token = await seedClientInvite(firm.id, email, owner.uid);
      const accepted = await newcomer.api.post('/api/invitations/accept').send({ token });
      expect(accepted.status).toBe(200);
      await drainEvents();

      // Without the removal actually deleting the row, a rescinded invitation to
      // a thread would still be honoured months later at registration time.
      expect(await activeParticipants(conversationId)).not.toContain(newcomer.uid);
      const res = await newcomer.api.get(`/api/messaging/client-groups/${conversationId}`);
      expect(res.status).toBe(403);
    });

    it('does not seat them on another firm thread they were never queued for', async () => {
      const email = 'promoted@example.test';
      const record = await unclaimed(email);
      const mine = await owner.api.post(`${M()}/groups`)
        .send({ title: 'Waiting room', clientRecordIds: [record.id] });
      expect(mine.status).toBe(201);
      // The same email is also an unclaimed record at the OTHER firm, queued on
      // the other firm's thread.
      const theirRecord = await createPersonClient(otherFirm.id, {
        name: 'Unclaimed Person', email, userId: null,
      });
      const theirs = await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/messaging/groups`)
        .send({ title: 'Their waiting room', clientRecordIds: [theirRecord.id] });
      expect(theirs.status).toBe(201);

      const newcomer = await seedPortalUserWithEmail(email, 'Unclaimed Person');
      const token = await seedClientInvite(firm.id, email, owner.uid);
      const accepted = await newcomer.api.post('/api/invitations/accept').send({ token });
      expect(accepted.status).toBe(200);
      await drainEvents();

      // Accepting ONE firm's invitation proves ownership of the address for that
      // firm only. The other firm's thread is still waiting on its own invite.
      expect(await activeParticipants(mine.body.conversationId)).toContain(newcomer.uid);
      expect(await activeParticipants(theirs.body.conversationId)).not.toContain(newcomer.uid);
      expect(await pendingRows(theirs.body.conversationId)).toHaveLength(1);
    });
  });
});

describe('paging a long thread', () => {
  const PAGE = 10;
  const TOTAL = 25;
  let conversationId: string;

  /** Newest first is how the query reads; the API hands each page back oldest first. */
  const label = (n: number) => `Message ${String(n).padStart(2, '0')}`;

  beforeEach(async () => {
    // One real send opens the conversation; the rest are seeded directly with
    // explicit, strictly-decreasing timestamps. The cursor compares `created_at`,
    // so messages written in the same instant would page nondeterministically and
    // the case would be testing the clock rather than the paging.
    //
    // Truncated to milliseconds on purpose. `getMessages` reads the cursor row's
    // `created_at` into a JS `Date`, which holds milliseconds, and sends it back
    // as the bound - so a stored microsecond value never compares equal to the
    // bound derived from it, and the `<` that keeps the cursor row out of the
    // next page is doing nothing observable. At millisecond precision the value
    // round-trips exactly and the boundary is real, which is the only way this
    // case can tell `<` from `<=`.
    const sent = await owner.api.post(`${M()}/send`)
      .send({ clientId: clientUid, content: label(TOTAL) });
    expect(sent.status).toBe(201);
    conversationId = sent.body.conversationId;

    for (let n = 1; n < TOTAL; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { rowCount } = await testPool.query(
        `insert into messages
           (conversation_id, law_firm_id, sender_user_id, sender_type, sender_name,
            content, status, read_by_firm, created_at)
         values ($1, $2, $3, 'firm_member', 'Owner', $4, 'sent', true,
                 date_trunc('milliseconds', now()) - ($5::int * interval '1 minute'))`,
        [conversationId, firm.id, owner.uid, label(n), TOTAL - n],
      );
      expect(rowCount).toBe(1);
    }
    await drainEvents();
  });

  const page = async (cursor?: string) => {
    const query = `limit=${PAGE}${cursor ? `&lastMessageId=${cursor}` : ''}`;
    const res = await owner.api.get(`${M()}/conversations/${conversationId}?${query}`);
    expect(res.status).toBe(200);
    return res.body as { messages: any[]; hasMore: boolean };
  };

  it('serves the newest page first, oldest message first within it', async () => {
    const first = await page();

    expect(first.messages).toHaveLength(PAGE);
    expect(first.messages.map((m: any) => m.content))
      .toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25].map(label));
    expect(first.hasMore).toBe(true);
  });

  it('walks the whole thread exactly once', async () => {
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const p = await page(cursor);
      collected.unshift(...p.messages.map((m: any) => m.content));
      cursor = p.messages[0].messageId;
    }

    // Every message, once, in order. A cursor built off the wrong end of the page
    // repeats a page forever; one built off `created_at <=` repeats its boundary
    // message; one built off `<` on a tied timestamp drops it silently.
    expect(collected).toEqual(Array.from({ length: TOTAL }, (_, i) => label(i + 1)));
    expect(new Set(collected).size).toBe(TOTAL);
  });

  it('reports no more once the thread is exhausted', async () => {
    const first = await page();
    const second = await page(first.messages[0].messageId);
    const third = await page(second.messages[0].messageId);

    expect(third.messages).toHaveLength(TOTAL - 2 * PAGE);
    // `hasMore` is what stops the caller asking again. Left true at the end, the
    // client pages forever against an empty tail.
    expect(third.hasMore).toBe(false);
  });

  it('refuses a cursor from a different conversation', async () => {
    const elsewhere = await owner.api.post(`${M()}/groups`)
      .send({ title: 'Another thread', clientIds: [clientUid] });
    expect(elsewhere.status).toBe(201);
    const foreign = await owner.api.post(`${M()}/groups/${elsewhere.body.conversationId}/messages`)
      .send({ content: 'Not part of the direct thread' });
    expect(foreign.status).toBe(201);

    const res = await owner.api.get(
      `${M()}/conversations/${conversationId}?limit=${PAGE}&lastMessageId=${foreign.body.messageId}`,
    );

    // The cursor is resolved against THIS conversation. Resolving it globally
    // would let one thread's timestamp slice another thread's history.
    expect(res.status).toBe(404);
  });

  it('refuses a page size past the cap', async () => {
    const res = await owner.api.get(`${M()}/conversations/${conversationId}?limit=101`);

    // An unbounded page over a long thread is a firm-sized read on one request.
    expect(res.status).toBe(400);
  });

  it('does not page another firm thread', async () => {
    const res = await otherOwner.api.get(
      `/api/lawfirms/${otherFirm.id}/messaging/conversations/${conversationId}?limit=${PAGE}`,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body ?? {})).not.toContain('Message 25');
  });
});
