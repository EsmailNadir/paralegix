/**
 * Messaging, characterised at the route layer.
 *
 * `messaging.service.ts` was at 10% and its repository at 30%. Messaging is the
 * one place where a mistake is immediately visible to a client: a message sent to
 * the wrong conversation, or a thread visible to someone who was never in it.
 *
 * NOT covered here, deliberately: the three Realtime surfaces. Messaging is one
 * of the few tables with row-level security, and the backend connects as
 * `postgres` and bypasses RLS everywhere except a Firebase-uid JWT path that only
 * a real session takes. Those policies are Playwright's job, and asserting them
 * from here would produce a green test for a control that was never exercised.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createOrgClient,
  createPortalUser,
  createFirmMember,
  linkPersonToOrg,
  ownerOf,
  as,
  tokenFor,
  recipientsOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

/**
 * `_maybeNotifyClient` is fire-and-forget from the send route (`.catch(...)`
 * with no await), so a request awaiting only the HTTP response can race past
 * it. `drainEvents()` does not cover this path either: it is not an eventBus
 * emit. A fixed handful of `setImmediate` turns is not enough either - the
 * path does real DB round trips (the preference lookup, the notification-
 * cooldown stamp) that resolve whenever their own I/O finishes, not on a
 * predictable tick count. Poll instead: check for the expected recipient
 * every 25ms, for up to a second, and stop as soon as it shows up (or a
 * negative assertion times the full budget out, which only the "not sent"
 * case pays).
 */
async function waitForRecipient(pattern: RegExp, email: string, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (recipientsOf(pattern).includes(email)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
/**
 * The PORTAL USER uid of `client`, not the client record id.
 *
 * `clientId` in the messaging API is a Firebase uid: `verifyClientAccess` matches
 * it against `clients.user_id`, and the schema types it as a plain string rather
 * than a uuid, which is the only hint. Passing the client record id is refused
 * with "Client is not associated with this law firm", a message that reads like a
 * tenancy problem rather than a wrong identifier. An organization can never carry
 * `user_id`, so an organization can never be the target of this route at all;
 * its thread is the canonical company conversation further down.
 */
let clientUid: string;

const api = (suffix: string) => `/api/lawfirms/${firm.id}/messaging${suffix}`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const portal = await createPortalUser();
  clientUid = portal.uid;
  client = await createPersonClient(firm.id, { name: 'Messaged Client', userId: portal.uid });
  await drainEvents();
});

describe('sending a message', () => {
  it('sends to a client and returns it in that conversation', async () => {
    const sent = await owner.api.post(api('/send'))
      .send({ clientId: clientUid, content: 'Hello from the firm' });

    expect(sent.status).toBe(201);
    await drainEvents();

    const list = await owner.api.get(api('/conversations'));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain('Hello from the firm');
  });

  it('rejects a message with neither content nor an attachment', async () => {
    const res = await owner.api.post(api('/send')).send({ clientId: clientUid, content: '   ' });

    // An empty message would render as a blank bubble in the client's portal.
    expect(res.status).toBe(400);
  });

  it('rejects a message with no client', async () => {
    const res = await owner.api.post(api('/send')).send({ content: 'To nobody' });

    expect(res.status).toBe(400);
  });

  it('rejects content past the length cap', async () => {
    const res = await owner.api.post(api('/send'))
      .send({ clientId: clientUid, content: 'x'.repeat(5_000) });

    expect(res.status).toBe(400);
  });

  it('stores the message body exactly, including unicode', async () => {
    const content = 'Prêt pour lundi ? 👍 山田さんにも連絡しました';

    const res = await owner.api.post(api('/send')).send({ clientId: clientUid, content });
    expect(res.status).toBe(201);
    await drainEvents();

    const { rows } = await testPool.query(
      'select content from messages where law_firm_id = $1', [firm.id],
    );
    // A mangled character here is a message the client reads as gibberish.
    expect(rows[0].content).toBe(content);
  });

  it('does not let one firm send into another firm conversation', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/messaging/send`)
      .send({ clientId: clientUid, content: 'Should not arrive' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await testPool.query(
      `select count(*)::int as n from messages where content = 'Should not arrive'`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('conversations and unread counts', () => {
  it('starts a firm with no conversations', async () => {
    const res = await owner.api.get(api('/conversations'));

    expect(res.status).toBe(200);
    expect(res.body.conversations ?? []).toEqual([]);
  });

  it('reports an unread count', async () => {
    const res = await owner.api.get(api('/unread-count'));

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });

  it('answers the inbox for a member with nothing in it', async () => {
    const res = await owner.api.get(api('/inbox'));

    expect(res.status).toBe(200);
  });

  it('answers 404 for a conversation that does not exist', async () => {
    const res = await owner.api.get(api('/conversations/00000000-0000-0000-0000-000000000000'));

    expect([403, 404]).toContain(res.status);
  });

  it('refuses a malformed conversation id without erroring', async () => {
    const res = await owner.api.get(api('/conversations/not-a-uuid'));

    // A uuid cast reaching the database is a 500 with a Postgres message in it.
    expect([400, 403, 404]).toContain(res.status);
  });
});

describe('group conversations', () => {
  async function createGroup(body: Record<string, unknown> = {}) {
    return owner.api.post(api('/groups')).send({
      title: 'Case team',
      clientRecordIds: [client.id],
      ...body,
    });
  }

  it('creates a group and lists it', async () => {
    const created = await createGroup({ title: 'Findable group' });

    expect([200, 201]).toContain(created.status);
    await drainEvents();

    const list = await owner.api.get(api('/groups'));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain('Findable group');
  });

  it('refuses a group with no participants at all', async () => {
    const res = await owner.api.post(api('/groups')).send({ title: 'Nobody here' });

    // A conversation with one participant is a note to self wearing a thread's
    // clothes.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('sends a message into a group', async () => {
    const created = await createGroup();
    const id = created.body.conversationId ?? created.body.conversation?.id;

    const sent = await owner.api.post(api(`/groups/${id}/messages`))
      .send({ content: 'Group message' });

    expect([200, 201]).toContain(sent.status);
    await drainEvents();

    const read = await owner.api.get(api(`/groups/${id}`));
    expect(JSON.stringify(read.body)).toContain('Group message');
  });

  it('does not show a group to a firm member who is not in it', async () => {
    const created = await createGroup({ title: 'Private thread' });
    expect([200, 201]).toContain(created.status);
    const id = created.body.conversationId ?? created.body.conversation?.id;
    await drainEvents();

    const bystander = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const bystanderApi = as(tokenFor({ uid: bystander.uid }));

    const res = await bystanderApi.get(api(`/groups/${id}`));

    // Group threads are participant-gated for firm members too, which is the
    // property migration 0182 had to backfill for company conversations.
    expect([403, 404]).toContain(res.status);
  });

  it('does not show one firm another firm groups', async () => {
    await createGroup({ title: 'Confidential Group' });
    await drainEvents();
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.get(`/api/lawfirms/${otherFirm.id}/messaging/groups`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Group');
  });
});

describe('the canonical company conversation', () => {
  async function orgWithRoster() {
    const org = await createOrgClient(firm.id, { name: 'Threaded Corp' });
    const portal = await createPortalUser();
    const person = await createPersonClient(firm.id, { userId: portal.uid, name: 'Roster Person' });
    await linkPersonToOrg(firm.id, person.id, org.id, { canViewBilling: false });
    return { org, person, portal };
  }

  it('creates one thread per organization and reuses it', async () => {
    const { org } = await orgWithRoster();

    const first = await owner.api.get(api(`/company-conversation/${org.id}`));
    const second = await owner.api.get(api(`/company-conversation/${org.id}`));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // "Canonical" is the whole point: a second call must find the existing thread
    // rather than opening a parallel one nobody else is in.
    expect(second.body.conversationId).toBe(first.body.conversationId);
  });

  it('puts every current firm member on it', async () => {
    const { org } = await orgWithRoster();
    const colleague = await createFirmMember(firm.id, { isOwner: false, permissions: [] });

    const created = await owner.api.get(api(`/company-conversation/${org.id}`));
    expect(created.status).toBe(200);
    await drainEvents();

    const { rows } = await testPool.query(
      `select participant_user_id from conversation_participants
        where conversation_id = $1 and removed_at is null`,
      [created.body.conversationId],
    );
    const participants = rows.map((r: any) => r.participant_user_id);
    // Both the creator and a colleague who did nothing. Seeding only the creator
    // is what locked later joiners out and needed migration 0182.
    expect(participants).toEqual(expect.arrayContaining([owner.uid, colleague.uid]));
  });

  it('refuses a company conversation for a PERSON client', async () => {
    const res = await owner.api.get(api(`/company-conversation/${client.id}`));

    // A person client already has an ordinary conversation. A second, differently
    // shaped one would split their history in two.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('does not open another firm organization thread', async () => {
    const { org } = await orgWithRoster();
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.get(
      `/api/lawfirms/${otherFirm.id}/messaging/company-conversation/${org.id}`,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('search', () => {
  it('finds a message by its text', async () => {
    await owner.api.post(api('/send'))
      .send({ clientId: clientUid, content: 'Distinctive searchable phrase' });
    await drainEvents();

    // The parameter is `q`, not `query`. `?query=` is rejected with "expected
    // string, received undefined" for a field the caller never heard of.
    const res = await owner.api.get(api('/search?q=Distinctive'));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Distinctive searchable phrase');
  });

  it('requires at least two characters', async () => {
    // A one-character search over every message in a firm is a full scan, so the
    // minimum is a real guard rather than a nicety. It also means a bare `%`
    // cannot reach the query at all.
    const res = await owner.api.get(api('/search?q=%25'));

    expect(res.status).toBe(400);
  });

  it('treats search metacharacters literally', async () => {
    await owner.api.post(api('/send')).send({ clientId: clientUid, content: 'Plain message' });
    await drainEvents();

    const res = await owner.api.get(api('/search?q=%25%25'));

    // An unescaped `%%` matches every message in the firm, which would show a
    // searcher threads they were not looking for.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('Plain message');
  });

  it('does not search across firms', async () => {
    await owner.api.post(api('/send'))
      .send({ clientId: clientUid, content: 'Confidential phrase' });
    await drainEvents();
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.get(
      `/api/lawfirms/${otherFirm.id}/messaging/search?q=Confidential`,
    );

    expect(JSON.stringify(res.body ?? {})).not.toContain('Confidential phrase');
  });
});

describe('the client-facing new-message email', () => {
  // Fresh clients per case, each in its own brand-new conversation: the
  // notification is gated by a 1-hour per-conversation cooldown that starts
  // on the first successful send, so reusing `client`/`clientUid` between
  // cases would make a later assertion depend on the cooldown state an
  // earlier one left behind.
  async function freshClient() {
    const portal = await createPortalUser();
    const record = await createPersonClient(firm.id, { name: 'Notified Client', userId: portal.uid });
    return { uid: portal.uid, clientRecordId: record.id };
  }

  it('emails the client on their first message, when they have not turned it off', async () => {
    const { uid } = await freshClient();

    const res = await owner.api.post(api('/send')).send({ clientId: uid, content: 'Your case has moved forward' });
    expect(res.status).toBe(201);
    await drainEvents();

    expect(await waitForRecipient(/New message/i, `${uid}@example.test`)).toBe(true);
  });

  it('does not email a client who turned off "email on new message"', async () => {
    const { uid, clientRecordId } = await freshClient();
    const off = await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${clientRecordId}/settings`)
      .send({ settings: { notifications: { emailOnNewMessage: false } } });
    expect(off.status).toBe(200);

    const res = await owner.api.post(api('/send')).send({ clientId: uid, content: 'Suppressed notice' });
    expect(res.status).toBe(201);
    await drainEvents();
    // A negative assertion can never poll-until-true, so wait the same budget
    // the positive case above would need to succeed, then confirm the email
    // never arrived in that window.
    await waitForRecipient(/New message/i, `${uid}@example.test`);

    expect(recipientsOf(/New message/i)).not.toContain(`${uid}@example.test`);
  });
});
