/**
 * What a conversation LIST row says about a thread, and who may act on it.
 *
 * The thread read itself (`getGroupConversation`) has carried a client's history
 * cutoff and the soft-delete mask for a long time. The list rows, the unread
 * badges, the archive toggle and the participant routes are separate reads and
 * writes, and each one can disagree with the thread without any screen looking
 * broken: a preview quoting a message the viewer may not read, a badge counting
 * a message nobody can see, a firm name that renders as a placeholder, or a
 * route that acts on a conversation from a firm the URL never named.
 *
 * Every absence below is measured against data that exists: a second client in
 * the same firm, a message that really was sent, a second firm with its own
 * thread.
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
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let danaUid: string;
let danaApi: ReturnType<typeof as>;
let samUid: string;
let samApi: ReturnType<typeof as>;

const M = (suffix = '') => `/api/lawfirms/${firm.id}/messaging${suffix}`;

async function createGroup(body: Record<string, unknown>) {
  const res = await owner.api.post(M('/groups')).send({ title: 'Working group', ...body });
  expect(res.status).toBe(201);
  return res.body.conversationId as string;
}

async function sendToGroup(conversationId: string, content: string) {
  const res = await owner.api.post(M(`/groups/${conversationId}/messages`)).send({ content });
  expect(res.status).toBe(201);
  return res.body.messageId as string;
}

async function clientGroupRow(api: ReturnType<typeof as>, conversationId: string) {
  const res = await api.get('/api/messaging/client-groups');
  expect(res.status).toBe(200);
  const row = (res.body.conversations as any[]).find((c) => c.conversationId === conversationId);
  expect(row).toBeDefined();
  return row;
}

async function clientUnread(api: ReturnType<typeof as>) {
  const res = await api.get('/api/messaging/unread-count');
  expect(res.status).toBe(200);
  return Number(res.body.count);
}

const res409Message = (body: any) => String(body?.error || '');

async function systemEventCount(conversationId: string) {
  const { rows } = await testPool.query(
    `select count(*)::int as n from messages where conversation_id = $1 and kind = 'system'`,
    [conversationId],
  );
  return rows[0].n as number;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);

  const dana = await createPortalUser({ name: 'Dana Reyes' });
  danaUid = dana.uid;
  danaApi = as(tokenFor({ uid: dana.uid }));
  await createPersonClient(firm.id, { name: 'Dana Reyes', userId: dana.uid });

  const sam = await createPortalUser({ name: 'Sam Okafor' });
  samUid = sam.uid;
  samApi = as(tokenFor({ uid: sam.uid }));
  await createPersonClient(firm.id, { name: 'Sam Okafor', userId: sam.uid });

  await drainEvents();
});

describe('the list preview a client is shown for a group', () => {
  it('does not quote a message sent before a client whose history is hidden joined', async () => {
    const conversationId = await createGroup({ clientIds: [danaUid] });
    await sendToGroup(conversationId, 'Said before Sam was here');
    const added = await owner.api.post(M(`/groups/${conversationId}/participants`))
      .send({ clientIds: [samUid], shareHistory: false });
    expect(added.status).toBe(200);

    // The thread itself withholds the message from Sam; the list row is the
    // other place the same text can reach him.
    const samRow = await clientGroupRow(samApi, conversationId);
    expect(samRow.lastMessagePreview).toBe('');
    // Dana was there for it, so her row still quotes it.
    const danaRow = await clientGroupRow(danaApi, conversationId);
    expect(danaRow.lastMessagePreview).toBe('Said before Sam was here');

    // The portal's per-firm list builds its row from the same read.
    const portal = await samApi.get(`/api/client-portal/lawfirm/${firm.id}/messages/conversations`);
    expect(portal.status).toBe(200);
    const portalRow = portal.body.conversations.find((c: any) => c.conversationId === conversationId);
    expect(portalRow.lastMessagePreview).toBe('');
    expect(JSON.stringify(portal.body)).not.toContain('Said before Sam was here');
  });

  it('quotes a message sent after that client joined', async () => {
    const conversationId = await createGroup({ clientIds: [danaUid] });
    await sendToGroup(conversationId, 'Said before Sam was here');
    const added = await owner.api.post(M(`/groups/${conversationId}/participants`))
      .send({ clientIds: [samUid], shareHistory: false });
    expect(added.status).toBe(200);
    await sendToGroup(conversationId, 'Said after Sam joined');

    const samRow = await clientGroupRow(samApi, conversationId);
    expect(samRow.lastMessagePreview).toBe('Said after Sam joined');
  });
});

describe('the list preview when the newest message was deleted', () => {
  it('reads "Message deleted" on a direct thread rather than looking empty', async () => {
    const first = await owner.api.post(M('/send')).send({ clientId: danaUid, content: 'Still here' });
    expect(first.status).toBe(201);
    const second = await owner.api.post(M('/send')).send({ clientId: danaUid, content: 'Withdrawn text' });
    expect(second.status).toBe(201);
    const del = await owner.api.delete(M(`/messages/${second.body.messageId}`));
    expect(del.status).toBe(200);

    const list = await owner.api.get(M('/conversations'));
    expect(list.status).toBe(200);
    const row = list.body.conversations.find((c: any) => c.conversationId === first.body.conversationId);
    expect(row.lastMessagePreview).toBe('Message deleted');
    expect(JSON.stringify(list.body)).not.toContain('Withdrawn text');
  });

  it('reads "Message deleted" on a group thread', async () => {
    const conversationId = await createGroup({ clientIds: [danaUid] });
    await sendToGroup(conversationId, 'Still here');
    const withdrawn = await sendToGroup(conversationId, 'Withdrawn text');
    const del = await owner.api.delete(M(`/messages/${withdrawn}`));
    expect(del.status).toBe(200);

    const danaRow = await clientGroupRow(danaApi, conversationId);
    expect(danaRow.lastMessagePreview).toBe('Message deleted');
  });
});

describe('the firm name on a group list row', () => {
  it('names the firm to a client instead of falling back to a placeholder', async () => {
    const conversationId = await createGroup({ clientIds: [danaUid] });
    await sendToGroup(conversationId, 'Hello');

    const row = await clientGroupRow(danaApi, conversationId);
    expect(row.lawFirmName).toBe(firm.name);
    // The client sees the firm side collapsed to one entry under its name.
    expect(row.participantNames).toEqual([firm.name]);
  });
});

describe('unread counts a client cannot act on', () => {
  it('does not count messages a re-added client is no longer allowed to read', async () => {
    const conversationId = await createGroup({ clientIds: [danaUid, samUid] });
    await sendToGroup(conversationId, 'One');
    await sendToGroup(conversationId, 'Two');
    const removed = await owner.api.delete(M(`/groups/${conversationId}/participants/${danaUid}`));
    expect(removed.status).toBe(200);
    await sendToGroup(conversationId, 'While Dana was away');
    const readded = await owner.api.post(M(`/groups/${conversationId}/participants`))
      .send({ clientIds: [danaUid] });
    expect(readded.status).toBe(200);

    // Sam was on the thread throughout and never read it, which proves the
    // three messages are really there to be counted.
    expect(await clientUnread(samApi)).toBe(3);

    const page = await danaApi.get(`/api/messaging/client-groups/${conversationId}`);
    expect(page.status).toBe(200);
    expect(page.body.messages.filter((m: any) => m.kind !== 'system')).toHaveLength(0);
    expect(await clientUnread(danaApi)).toBe(0);
    expect((await clientGroupRow(danaApi, conversationId)).unreadCount).toBe(0);
  });

  it('does not count a deleted direct message', async () => {
    const kept = await owner.api.post(M('/send')).send({ clientId: danaUid, content: 'Kept' });
    expect(kept.status).toBe(201);
    const sent = await owner.api.post(M('/send')).send({ clientId: danaUid, content: 'Sent in error' });
    expect(sent.status).toBe(201);
    const del = await owner.api.delete(M(`/messages/${sent.body.messageId}`));
    expect(del.status).toBe(200);

    expect(await clientUnread(danaApi)).toBe(1);
    const portal = await danaApi.get(`/api/client-portal/lawfirm/${firm.id}/messages/conversations`);
    const direct = portal.body.conversations.find((c: any) => c.conversationType === 'direct');
    expect(direct.unreadCount).toBe(1);
  });

  it('does not count a deleted group message', async () => {
    const conversationId = await createGroup({ clientIds: [danaUid] });
    await sendToGroup(conversationId, 'Kept');
    const withdrawn = await sendToGroup(conversationId, 'Sent in error');
    const del = await owner.api.delete(M(`/messages/${withdrawn}`));
    expect(del.status).toBe(200);

    expect(await clientUnread(danaApi)).toBe(1);
    expect((await clientGroupRow(danaApi, conversationId)).unreadCount).toBe(1);
  });
});

describe('an archived organization thread that has been replaced', () => {
  async function splitCanonicalThread() {
    const org = await createOrgClient(firm.id, { name: 'Threaded Corp' });
    const portal = await createPortalUser({ name: 'Roster Person' });
    const person = await createPersonClient(firm.id, { userId: portal.uid, name: 'Roster Person' });
    await linkPersonToOrg(firm.id, person.id, org.id, { canViewBilling: false });

    const first = await owner.api.get(M(`/company-conversation/${org.id}`));
    expect(first.status).toBe(200);
    const archived = await owner.api.put(M(`/conversations/${first.body.conversationId}/archive`))
      .send({ archived: true });
    expect(archived.status).toBe(200);
    const second = await owner.api.get(M(`/company-conversation/${org.id}`));
    expect(second.status).toBe(200);
    expect(second.body.conversationId).not.toBe(first.body.conversationId);

    return {
      oldId: first.body.conversationId as string,
      newId: second.body.conversationId as string,
      rosterApi: as(tokenFor({ uid: portal.uid })),
    };
  }

  it('still delivers a client reply posted into the archived thread', async () => {
    const { oldId, newId, rosterApi } = await splitCanonicalThread();

    const reply = await rosterApi.post(`/api/messaging/client-groups/${oldId}/messages`)
      .send({ content: 'Replying to the old thread' });

    expect(reply.status).toBe(201);
    const { rows } = await testPool.query(
      'select conversation_id from messages where id = $1', [reply.body.messageId],
    );
    expect(rows[0].conversation_id).toBe(oldId);
    // The replacement keeps the canonical slot; the old thread stays archived.
    const { rows: convs } = await testPool.query(
      'select id, archived_at from conversations where id = any($1::uuid[])', [[oldId, newId]],
    );
    const byId = new Map(convs.map((c: any) => [c.id, c.archived_at]));
    expect(byId.get(oldId)).not.toBeNull();
    expect(byId.get(newId)).toBeNull();
  });

  it('answers a conflict, not a server error, when the firm tries to restore it', async () => {
    const { oldId } = await splitCanonicalThread();

    const restore = await owner.api.put(M(`/conversations/${oldId}/archive`)).send({ archived: false });

    expect(restore.status).toBe(409);
    // A generic "already exists" leaves the firm no way to tell what to do next.
    expect(res409Message(restore.body)).toMatch(/already has an active conversation/i);
    const { rows } = await testPool.query('select archived_at from conversations where id = $1', [oldId]);
    expect(rows[0].archived_at).not.toBeNull();
  });

  it('still restores an archived thread that has no replacement', async () => {
    const conversationId = await createGroup({ clientIds: [danaUid] });
    const archived = await owner.api.put(M(`/conversations/${conversationId}/archive`)).send({ archived: true });
    expect(archived.status).toBe(200);

    const restore = await owner.api.put(M(`/conversations/${conversationId}/archive`)).send({ archived: false });

    expect(restore.status).toBe(200);
    const { rows } = await testPool.query('select archived_at from conversations where id = $1', [conversationId]);
    expect(rows[0].archived_at).toBeNull();
  });
});

describe('removing someone who is not on the thread', () => {
  it('answers 404 on a group and records nothing', async () => {
    const conversationId = await createGroup({ clientIds: [danaUid] });
    const outsider = await createPortalUser({ name: 'Never Added' });
    const before = await systemEventCount(conversationId);

    const res = await owner.api.delete(M(`/groups/${conversationId}/participants/${outsider.uid}`));

    expect(res.status).toBe(404);
    expect(await systemEventCount(conversationId)).toBe(before);
    const page = await owner.api.get(M(`/groups/${conversationId}`));
    expect(JSON.stringify(page.body)).not.toContain('Never Added');
  });

  it('answers 404 on a direct thread and leaves it a direct thread', async () => {
    const sent = await owner.api.post(M('/send')).send({ clientId: danaUid, content: 'Hello Dana' });
    expect(sent.status).toBe(201);
    const conversationId = sent.body.conversationId;

    const res = await owner.api.delete(M(`/groups/${conversationId}/participants/${samUid}`));

    expect(res.status).toBe(404);
    const { rows } = await testPool.query(
      'select conversation_type, client_id from conversations where id = $1', [conversationId],
    );
    expect(rows[0]).toEqual({ conversation_type: 'direct', client_id: danaUid });
    expect(await systemEventCount(conversationId)).toBe(0);
  });

  it('still removes the actual client of a direct thread', async () => {
    const sent = await owner.api.post(M('/send')).send({ clientId: danaUid, content: 'Hello Dana' });
    expect(sent.status).toBe(201);

    const res = await owner.api.delete(M(`/groups/${sent.body.conversationId}/participants/${danaUid}`));

    expect(res.status).toBe(200);
    expect(res.body.converted).toBe(true);
  });
});

describe('paging a thread whose messages share a timestamp', () => {
  it('walks every message once even when several were written in the same instant', async () => {
    const sent = await owner.api.post(M('/send')).send({ clientId: danaUid, content: 'Opener' });
    expect(sent.status).toBe(201);
    const conversationId = sent.body.conversationId;
    for (let n = 1; n <= 4; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      await testPool.query(
        `insert into messages
           (conversation_id, law_firm_id, sender_user_id, sender_type, sender_name,
            content, status, read_by_firm, created_at)
         values ($1, $2, $3, 'firm_member', 'Owner', $4, 'sent', true,
                 date_trunc('milliseconds', now()) - interval '1 hour')`,
        [conversationId, firm.id, owner.uid, `Tied ${n}`],
      );
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 4; i += 1) {
      const query = `limit=2${cursor ? `&lastMessageId=${cursor}` : ''}`;
      // eslint-disable-next-line no-await-in-loop
      const res = await owner.api.get(M(`/conversations/${conversationId}?${query}`));
      expect(res.status).toBe(200);
      collected.push(...res.body.messages.map((m: any) => m.content));
      if (!res.body.hasMore || res.body.messages.length === 0) break;
      cursor = res.body.messages[0].messageId;
    }

    expect(collected.sort()).toEqual(['Opener', 'Tied 1', 'Tied 2', 'Tied 3', 'Tied 4']);
  });
});

describe('a group reached through a firm the URL does not name', () => {
  let otherFirm: Firm;
  let bothFirms: Actor;
  let theirGroup: string;

  beforeEach(async () => {
    otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    // An owner of THIS firm who is also a member of the other firm with no
    // messaging permission there at all.
    bothFirms = owner;
    await createFirmMember(otherFirm.id, { uid: owner.uid, isOwner: false, permissions: [] });
    const created = await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/messaging/groups`)
      .send({ title: 'Their internal thread', memberIds: [owner.uid] });
    expect(created.status).toBe(201);
    theirGroup = created.body.conversationId;
    const seeded = await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/messaging/groups/${theirGroup}/messages`)
      .send({ content: 'Other firm privileged text' });
    expect(seeded.status).toBe(201);
  });

  it('refuses to read it', async () => {
    const res = await bothFirms.api.get(M(`/groups/${theirGroup}`));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Other firm privileged text');
  });

  it('refuses to post into it', async () => {
    const res = await bothFirms.api.post(M(`/groups/${theirGroup}/messages`)).send({ content: 'Borrowed send' });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      'select 1 from messages where conversation_id = $1 and content = $2', [theirGroup, 'Borrowed send'],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses to mark it read', async () => {
    const res = await bothFirms.api.put(M(`/groups/${theirGroup}/mark-read`));

    expect(res.status).toBe(403);
  });
});

describe('the portal list for a client with no personal thread yet', () => {
  it('offers a personal thread alongside the groups they are in', async () => {
    const conversationId = await createGroup({ clientIds: [samUid] });
    await sendToGroup(conversationId, 'Group hello');

    const res = await samApi.get(`/api/client-portal/lawfirm/${firm.id}/messages/conversations`);

    expect(res.status).toBe(200);
    const direct = res.body.conversations.filter((c: any) => c.conversationType === 'direct');
    expect(direct).toEqual([{
      conversationId: `${firm.id}_${samUid}`,
      conversationType: 'direct',
      clientRecordId: expect.any(String),
      clientType: 'person',
      title: firm.name,
      lastMessageAt: null,
      lastMessagePreview: '',
      unreadCount: 0,
      archivedAt: null,
    }]);
    expect(res.body.conversations.map((c: any) => c.conversationId)).toContain(conversationId);
    expect(res.body.totalItems).toBe(2);
  });

  it('lists the real personal thread once it exists, not a second synthetic one', async () => {
    const sent = await owner.api.post(M('/send')).send({ clientId: samUid, content: 'Direct hello' });
    expect(sent.status).toBe(201);

    const res = await samApi.get(`/api/client-portal/lawfirm/${firm.id}/messages/conversations`);

    const direct = res.body.conversations.filter((c: any) => c.conversationType === 'direct');
    expect(direct.map((c: any) => c.conversationId)).toEqual([sent.body.conversationId]);
  });
});
