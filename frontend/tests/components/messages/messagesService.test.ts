/**
 * The messaging service, tested OFFLINE against a fake transport.
 *
 * `messages.service.ts` reports 0%. Messaging is the one surface where a wrong
 * request delivers privileged text to a real person: a send is attributed to a
 * thread by an id the user never sees, and the thread decides who reads it.
 *
 * WHAT GETS THE MOST ATTENTION
 * 1. WHICH THREAD A SEND IS ATTRIBUTED TO. A direct send names its recipient by
 *    `clientId` in the BODY; a group send names its thread by `conversationId`
 *    in the PATH. The two are different id spaces and neither is visible on
 *    screen, so the tests pin where each one lands.
 * 2. READ RECEIPTS. Marking specific messages read and marking a whole group
 *    read are different endpoints with different bodies. Crossing them either
 *    clears a badge that should still be lit or leaves one lit forever.
 * 3. THE THREE LIST ROUTES. Direct conversations, the merged inbox and the
 *    caller's groups share one query-string builder and differ only by path.
 *    Sending one list's request to another's route silently shows the wrong set
 *    of threads.
 * 4. ARGUMENT ORDER. Several methods take `(conversationId, lawFirmId, ...)`
 *    while the rest of the service takes `(lawFirmId, ...)`. Both are opaque
 *    uuids, so a swap type-checks and produces a plausible-looking 404.
 *
 * Attachment uploads hand-build an `XMLHttpRequest` because `fetch` has no
 * request-progress API, so they are invisible to a fetch-level fake; `xhrMock`
 * covers those.
 */
jest.unmock('@/services/messages.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { installXhrMock, formDataValues, type XhrMock } from '../../support/xhrMock';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import messagesService from '@/services/messages.service';

const LAW_FIRM_ID = 'firm-1';
const CONVERSATION_ID = 'conv-7';
const CLIENT_ID = 'client-uid-3';

let api: ApiMock;
let xhr: XhrMock;

/** Query parameters of a recorded call, read back the way a server reads them. */
const paramsOf = (url: string): URLSearchParams => new URL(url, 'http://x').searchParams;

/** The parsed JSON body of a recorded call. */
const bodyOf = (call: { body: unknown }): Record<string, unknown> =>
  call.body as Record<string, unknown>;

const fileNamed = (name: string, type = 'application/pdf'): File =>
  new File(['x'], name, { type });

beforeEach(() => {
  api = installApiMock();
  xhr = installXhrMock();
  // The dev-only duplicate-GET guard warns when a spec hits the same endpoint
  // twice inside its window, which is normal here and would otherwise bury the
  // real output.
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
  xhr.restore();
});

describe('sending a direct message', () => {
  const SENT = { messageId: 'msg-1', conversationId: CONVERSATION_ID };

  it('POSTs to the firm SEND route with the firm in the path', async () => {
    api.post('/messaging/send', SENT);

    await messagesService.sendMessage({
      lawFirmId: LAW_FIRM_ID, clientId: CLIENT_ID, content: 'Hello',
    });

    expect(api.calls('POST')[0].pathname)
      .toMatch(new RegExp(`/lawfirms/${LAW_FIRM_ID}/messaging/send$`));
  });

  it('attributes the send by clientId in the BODY', async () => {
    api.post('/messaging/send', SENT);

    await messagesService.sendMessage({
      lawFirmId: LAW_FIRM_ID, clientId: CLIENT_ID, content: 'Confidential',
    });

    // `clientId` is a PORTAL USER ID, and it is the only thing naming who
    // receives this. The conversation row may not exist yet, so there is no
    // conversation id to fall back on: get this wrong and privileged text is
    // delivered to a different client of the same firm.
    const body = bodyOf(api.calls('POST')[0]);
    expect(body.clientId).toBe(CLIENT_ID);
    expect(body.content).toBe('Confidential');
  });

  it('CHARACTERISATION: repeats the firm id in the body as well as the path', async () => {
    api.post('/messaging/send', SENT);

    await messagesService.sendMessage({
      lawFirmId: LAW_FIRM_ID, clientId: CLIENT_ID, content: 'Hello',
    });

    // The whole `SendMessageData` is serialised, so the firm arrives twice. Two
    // sources for one fact can disagree, and only the path is authorised.
    // Recorded rather than asserted as correct: the sibling `matters.service`
    // strips it out.
    expect(bodyOf(api.calls('POST')[0]).lawFirmId).toBe(LAW_FIRM_ID);
  });

  it('carries the matter scope and the mention list through', async () => {
    api.post('/messaging/send', SENT);

    await messagesService.sendMessage({
      lawFirmId: LAW_FIRM_ID,
      clientId: CLIENT_ID,
      content: 'See the filing',
      matterId: 'matter-2',
      mentions: ['member-a', 'member-b'],
    });

    // Mentions drive notifications to named people. A dropped list is a silent
    // non-notification; a reordered one still notifies the same set, so only the
    // membership is asserted here.
    const body = bodyOf(api.calls('POST')[0]);
    expect(body.matterId).toBe('matter-2');
    expect(body.mentions).toEqual(['member-a', 'member-b']);
  });

  it('throws when the send is refused', async () => {
    api.post('/messaging/send', { status: 403, body: { error: 'Not a participant' } });

    // The composer has to keep the draft. A swallowed refusal clears the box and
    // shows a sent bubble for a message nobody received.
    await expect(messagesService.sendMessage({
      lawFirmId: LAW_FIRM_ID, clientId: CLIENT_ID, content: 'Hello',
    })).rejects.toThrow(/not a participant/i);
  });
});

describe('sending a group message', () => {
  it('names the thread in the PATH and never in the body', async () => {
    api.post(`/groups/${CONVERSATION_ID}/messages`, {
      messageId: 'msg-2', conversationId: CONVERSATION_ID,
    });

    await messagesService.sendGroupMessage(LAW_FIRM_ID, CONVERSATION_ID, {
      content: 'Team update',
    });

    // The opposite placement to a direct send. A group already exists, so it is
    // addressed by its own id in the url; the body carries only the message.
    const call = api.calls('POST')[0];
    expect(call.pathname)
      .toMatch(new RegExp(`/lawfirms/${LAW_FIRM_ID}/messaging/groups/${CONVERSATION_ID}/messages$`));
    expect(bodyOf(call).conversationId).toBeUndefined();
    expect(bodyOf(call).content).toBe('Team update');
  });

  it('sends group attachments and mentions in the body', async () => {
    api.post(`/groups/${CONVERSATION_ID}/messages`, { messageId: 'm', conversationId: 'c' });

    await messagesService.sendGroupMessage(LAW_FIRM_ID, CONVERSATION_ID, {
      content: 'Draft attached',
      attachments: [{
        name: 'draft.pdf', url: 'https://x/draft.pdf', objectPath: 'firm/1/draft.pdf',
        mimeType: 'application/pdf', size: 12,
      }],
      mentions: ['member-a'],
    });

    const body = bodyOf(api.calls('POST')[0]);
    // The objectPath is what the server re-authorises and copies. Dropping the
    // attachment array posts the text with no file and no error.
    expect((body.attachments as Array<{ objectPath: string }>)[0].objectPath)
      .toBe('firm/1/draft.pdf');
    expect(body.mentions).toEqual(['member-a']);
  });

  it('a direct send and a group send reach DIFFERENT endpoints', async () => {
    api.post('/messaging/send', { messageId: 'm1', conversationId: 'c1' });
    api.post(`/groups/${CONVERSATION_ID}/messages`, { messageId: 'm2', conversationId: 'c2' });

    await messagesService.sendMessage({
      lawFirmId: LAW_FIRM_ID, clientId: CLIENT_ID, content: 'direct',
    });
    await messagesService.sendGroupMessage(LAW_FIRM_ID, CONVERSATION_ID, { content: 'group' });

    // One creates or finds a two-party thread with a named client; the other
    // posts into an existing multi-party thread. Crossed, a private note to one
    // client is published to everyone on a group.
    const paths = api.calls('POST').map((c) => c.pathname);
    expect(paths[0]).toMatch(/\/messaging\/send$/);
    expect(paths[1]).toMatch(/\/messages$/);
  });

  it('throws when a group send is refused', async () => {
    api.post(`/groups/${CONVERSATION_ID}/messages`, {
      status: 403, body: { error: 'You are not in this conversation' },
    });

    await expect(messagesService.sendGroupMessage(LAW_FIRM_ID, CONVERSATION_ID, {
      content: 'Team update',
    })).rejects.toThrow(/not in this conversation/i);
  });
});

describe('the three conversation list routes', () => {
  const PAGE = { conversations: [], totalItems: 0 };

  it('reads direct threads from /conversations', async () => {
    api.get('/messaging/conversations', PAGE);

    await messagesService.getFirmConversationPage(LAW_FIRM_ID);

    expect(api.calls('GET')[0].pathname).toMatch(/\/messaging\/conversations$/);
  });

  it('reads the merged inbox from /inbox', async () => {
    api.get('/messaging/inbox', PAGE);

    await messagesService.getFirmInboxPage(LAW_FIRM_ID);

    // Page N of the merged list is not page N of either half, which is the whole
    // reason this route exists. Reading /conversations here would silently drop
    // every group thread from the inbox.
    expect(api.calls('GET')[0].pathname).toMatch(/\/messaging\/inbox$/);
  });

  it('reads the caller groups from /groups', async () => {
    api.get('/messaging/groups', PAGE);

    await messagesService.listGroupsPage(LAW_FIRM_ID);

    expect(api.calls('GET')[0].pathname).toMatch(/\/messaging\/groups$/);
  });

  it('reads the CLIENT list from a route with no firm in the path', async () => {
    api.get('/messaging/client-conversations', { conversations: [] });

    await messagesService.getClientConversations();

    // A portal client belongs to several firms at once and is scoped by their
    // own identity, not by a firm id they could substitute.
    const call = api.calls('GET')[0];
    expect(call.pathname).toMatch(/\/messaging\/client-conversations$/);
    expect(call.pathname).not.toContain('/lawfirms/');
  });

  it('sends NO query string at all when no options are given', async () => {
    api.get('/messaging/conversations', PAGE);

    await messagesService.getFirmConversationPage(LAW_FIRM_ID);

    // A bare url is what the historic unpaginated read used, and the server
    // answers it with the whole list. A stray `?` or an empty `limit=` would
    // window a read whose callers expect every thread.
    expect(api.calls('GET')[0].url).not.toContain('?');
  });

  it('passes each window and filter under its own key', async () => {
    api.get('/messaging/conversations', PAGE);

    await messagesService.getFirmConversationPage(LAW_FIRM_ID, {
      limit: 25, offset: 50, search: 'contract dispute', matterId: 'matter-2',
      clientId: CLIENT_ID,
    });

    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('limit')).toBe('25');
    expect(params.get('offset')).toBe('50');
    expect(params.get('matterId')).toBe('matter-2');
    expect(params.get('clientId')).toBe(CLIENT_ID);
    // Read back through URLSearchParams, not decodeURIComponent: a query string
    // encodes a space as `+`, which decodeURIComponent leaves as a literal plus.
    expect(params.get('search')).toBe('contract dispute');
  });

  it('OMITS a filter that was not given', async () => {
    api.get('/messaging/conversations', PAGE);

    await messagesService.getFirmConversationPage(LAW_FIRM_ID, { limit: 25 });

    // `matterId=undefined` scopes the list to a matter of that name, which is
    // none, and the inbox renders empty.
    const url = api.calls('GET')[0].url;
    expect(url).not.toContain('matterId');
    expect(url).not.toContain('clientId');
    expect(url).not.toContain('search');
  });

  it('TRIMS a search term and omits a blank one', async () => {
    api.get('/messaging/conversations', PAGE);

    await messagesService.getFirmConversationPage(LAW_FIRM_ID, { search: '  Acme  ' });
    await messagesService.getFirmConversationPage(LAW_FIRM_ID, { search: '   ' });

    expect(paramsOf(api.calls('GET')[0].url).get('search')).toBe('Acme');
    // A blank search sent as a parameter becomes part of the React Query key, so
    // clearing the box refetches instead of returning to the cached list.
    expect(api.calls('GET')[1].url).not.toContain('search');
  });

  it('sends archived=false as a real filter, not as an omission', async () => {
    api.get('/messaging/conversations', PAGE);

    await messagesService.getFirmConversationPage(LAW_FIRM_ID, { archived: false });
    await messagesService.getFirmConversationPage(LAW_FIRM_ID, { archived: true });
    await messagesService.getFirmConversationPage(LAW_FIRM_ID, {});

    // The flag selects ONE SIDE of the archive split and omitting it returns
    // both. Dropping `false` the way a truthiness check would puts archived
    // threads back in the active inbox.
    expect(paramsOf(api.calls('GET')[0].url).get('archived')).toBe('false');
    expect(paramsOf(api.calls('GET')[1].url).get('archived')).toBe('true');
    expect(api.calls('GET')[2].url).not.toContain('archived');
  });

  it('joins clientIds with commas under a single key', async () => {
    api.get('/messaging/conversations', PAGE);

    await messagesService.getFirmConversationPage(LAW_FIRM_ID, {
      clientIds: ['uid-a', 'uid-b', 'uid-c'],
    });

    // One key, comma-joined, which is what the server splits on. Repeating the
    // key instead would leave the backend reading only one of them.
    expect(paramsOf(api.calls('GET')[0].url).get('clientIds')).toBe('uid-a,uid-b,uid-c');
  });

  it('omits an EMPTY clientIds list rather than sending a blank key', async () => {
    api.get('/messaging/conversations', PAGE);

    await messagesService.getFirmConversationPage(LAW_FIRM_ID, { clientIds: [] });

    // `clientIds=` matches no client, so an empty selection would show an empty
    // inbox instead of an unfiltered one.
    expect(api.calls('GET')[0].url).not.toContain('clientIds');
  });

  it('defaults a missing conversations list to an empty array', async () => {
    api.get('/messaging/conversations', {});

    // The list maps over this. `undefined` is a crash on the messages page.
    expect((await messagesService.getFirmConversationPage(LAW_FIRM_ID)).conversations)
      .toEqual([]);
  });

  it('falls totalItems back to the number of rows returned', async () => {
    api.get('/messaging/conversations', { conversations: [{ conversationId: 'a' }] });

    // A pager told `undefined` renders NaN pages.
    expect((await messagesService.getFirmConversationPage(LAW_FIRM_ID)).totalItems).toBe(1);
  });

  it('keeps a server total larger than the page', async () => {
    api.get('/messaging/conversations', {
      conversations: [{ conversationId: 'a' }], totalItems: 87,
    });

    // The positive half: collapsing the real total to the page size hides every
    // thread past the first row.
    expect((await messagesService.getFirmConversationPage(LAW_FIRM_ID)).totalItems).toBe(87);
  });

  it('unwraps the page for the plain list callers', async () => {
    api.get('/messaging/conversations', {
      conversations: [{ conversationId: 'a' }, { conversationId: 'b' }], totalItems: 2,
    });
    api.get('/messaging/groups', { conversations: [{ conversationId: 'g' }], totalItems: 1 });

    expect(await messagesService.getFirmConversations(LAW_FIRM_ID)).toHaveLength(2);
    expect(await messagesService.listGroups(LAW_FIRM_ID)).toHaveLength(1);
  });

  it('throws when a conversation list is refused', async () => {
    api.get('/messaging/conversations', { status: 403, body: { error: 'Forbidden' } });

    // A swallowed 403 is indistinguishable from a firm with no conversations.
    await expect(messagesService.getFirmConversationPage(LAW_FIRM_ID)).rejects.toBeDefined();
  });
});

describe('loading one thread', () => {
  const THREAD = { messages: [], hasMore: false, conversation: { conversationId: CONVERSATION_ID } };

  it('puts the FIRM in the lawfirms segment and the CONVERSATION at the end', async () => {
    api.get(`/messaging/conversations/${CONVERSATION_ID}`, THREAD);

    await messagesService.getConversationMessages(CONVERSATION_ID, LAW_FIRM_ID);

    // This method takes `(conversationId, lawFirmId)`, the reverse of nearly
    // every other method here. Both are opaque uuids, so a swapped call
    // type-checks and produces a 404 that reads as a deleted thread.
    expect(api.calls('GET')[0].pathname)
      .toMatch(new RegExp(`/lawfirms/${LAW_FIRM_ID}/messaging/conversations/${CONVERSATION_ID}$`));
  });

  it('always sends a limit and defaults it to 25', async () => {
    api.get(`/messaging/conversations/${CONVERSATION_ID}`, THREAD);

    await messagesService.getConversationMessages(CONVERSATION_ID, LAW_FIRM_ID);

    // Without a page size the server would be asked for a thread's whole
    // history on every open.
    expect(paramsOf(api.calls('GET')[0].url).get('limit')).toBe('25');
  });

  it('sends lastMessageId only when paging backwards', async () => {
    api.get(`/messaging/conversations/${CONVERSATION_ID}`, THREAD);

    await messagesService.getConversationMessages(CONVERSATION_ID, LAW_FIRM_ID, 50, 'msg-100');
    await messagesService.getConversationMessages(CONVERSATION_ID, LAW_FIRM_ID, 50);

    // The cursor is what stops the second page repeating the first. Sent on the
    // initial load it would page from a message the user has not reached.
    expect(paramsOf(api.calls('GET')[0].url).get('lastMessageId')).toBe('msg-100');
    expect(api.calls('GET')[1].url).not.toContain('lastMessageId');
  });

  it('loads a GROUP thread from the groups route with its own cursor', async () => {
    api.get(`/messaging/groups/${CONVERSATION_ID}`, {
      conversation: {}, participants: [], messages: [], hasMore: false,
    });

    await messagesService.getGroup(LAW_FIRM_ID, CONVERSATION_ID, {
      limit: 40, lastMessageId: 'msg-9',
    });

    const call = api.calls('GET')[0];
    // A group read returns participants as well as messages. Routed to the
    // direct-thread endpoint the roster comes back empty and the add-people
    // picker shows nobody as already present.
    expect(call.pathname)
      .toMatch(new RegExp(`/messaging/groups/${CONVERSATION_ID}$`));
    expect(paramsOf(call.url).get('limit')).toBe('40');
    expect(paramsOf(call.url).get('lastMessageId')).toBe('msg-9');
  });

  it('sends no query string when a group is opened with no options', async () => {
    api.get(`/messaging/groups/${CONVERSATION_ID}`, {
      conversation: {}, participants: [], messages: [], hasMore: false,
    });

    await messagesService.getGroup(LAW_FIRM_ID, CONVERSATION_ID);

    expect(api.calls('GET')[0].url).not.toContain('?');
  });

  it('resolves a company thread by the CLIENT RECORD id in the path', async () => {
    api.get('/messaging/company-conversation/client-record-5', {
      conversationId: CONVERSATION_ID,
    });

    const result = await messagesService.getCompanyConversation(LAW_FIRM_ID, 'client-record-5');

    // This id is a `clients.id`, not a portal uid: the whole point is to reach a
    // company's canonical thread rather than one person's. Passing a uid here
    // finds nothing and the backend lazily creates a thread against the wrong
    // key.
    expect(api.calls('GET')[0].pathname)
      .toMatch(/\/messaging\/company-conversation\/client-record-5$/);
    expect(result.conversationId).toBe(CONVERSATION_ID);
  });

  it('throws when a thread load is refused', async () => {
    api.get(`/messaging/conversations/${CONVERSATION_ID}`, {
      status: 403, body: { error: 'Forbidden' },
    });

    // An empty thread rendered from a swallowed 403 reads as a conversation
    // nobody has written in.
    await expect(messagesService.getConversationMessages(CONVERSATION_ID, LAW_FIRM_ID))
      .rejects.toBeDefined();
  });
});

describe('read receipts', () => {
  it('marks NAMED messages read through the firm mark-read route', async () => {
    api.put('/messaging/mark-read', {});

    await messagesService.markAsRead(CONVERSATION_ID, LAW_FIRM_ID, ['msg-1', 'msg-2']);

    const call = api.calls('PUT')[0];
    // Both the thread and the exact messages are in the BODY here; only the firm
    // is in the path. The server clears receipts for precisely this list.
    expect(call.pathname).toMatch(/\/messaging\/mark-read$/);
    expect(bodyOf(call).conversationId).toBe(CONVERSATION_ID);
    expect(bodyOf(call).messageIds).toEqual(['msg-1', 'msg-2']);
  });

  it('preserves a single-message list as an ARRAY', async () => {
    api.put('/messaging/mark-read', {});

    await messagesService.markAsRead(CONVERSATION_ID, LAW_FIRM_ID, ['msg-1']);

    // Unwrapping one element into a bare string changes the request shape for
    // the most common case there is: reading the message that just arrived.
    expect(bodyOf(api.calls('PUT')[0]).messageIds).toEqual(['msg-1']);
  });

  it('sends an EMPTY list as an empty array', async () => {
    api.put('/messaging/mark-read', {});

    await messagesService.markAsRead(CONVERSATION_ID, LAW_FIRM_ID, []);

    // `undefined` would let the server apply its own default, and "no scope" on
    // a mark-read is the worst possible default.
    expect(bodyOf(api.calls('PUT')[0]).messageIds).toEqual([]);
  });

  it('marks a GROUP read through the group route with NO message list', async () => {
    api.put(`/groups/${CONVERSATION_ID}/mark-read`, {});

    await messagesService.markGroupRead(LAW_FIRM_ID, CONVERSATION_ID);

    const call = api.calls('PUT')[0];
    // A group read cursor is per-viewer and covers everything up to now, so the
    // thread is in the PATH and there is no body at all.
    expect(call.pathname)
      .toMatch(new RegExp(`/messaging/groups/${CONVERSATION_ID}/mark-read$`));
    expect(call.body).toBeNull();
  });

  it('the two mark-read calls reach DIFFERENT endpoints', async () => {
    api.put('/messaging/mark-read', {});
    api.put(`/groups/${CONVERSATION_ID}/mark-read`, {});

    await messagesService.markAsRead(CONVERSATION_ID, LAW_FIRM_ID, ['msg-1']);
    await messagesService.markGroupRead(LAW_FIRM_ID, CONVERSATION_ID);

    // Same verb, near-identical signatures, different scopes. Crossed, either a
    // group badge never clears or a direct thread is marked read wholesale
    // including messages still on screen unread.
    const paths = api.calls('PUT').map((c) => c.pathname);
    expect(paths[0]).toMatch(/\/messaging\/mark-read$/);
    expect(paths[1]).toMatch(/\/groups\/conv-7\/mark-read$/);
    expect(paths[0]).not.toBe(paths[1]);
  });

  it('throws when a mark-read is refused', async () => {
    api.put('/messaging/mark-read', { status: 403, body: { error: 'Forbidden' } });

    await expect(messagesService.markAsRead(CONVERSATION_ID, LAW_FIRM_ID, ['msg-1']))
      .rejects.toBeDefined();
  });
});

describe('the unread badge', () => {
  it('reads the FIRM route when a firm is given', async () => {
    api.get(`/lawfirms/${LAW_FIRM_ID}/messaging/unread-count`, { count: 4 });

    expect(await messagesService.getUnreadCount(LAW_FIRM_ID)).toBe(4);
    expect(api.calls('GET')[0].pathname).toContain(`/lawfirms/${LAW_FIRM_ID}/`);
  });

  it('reads the CLIENT route when no firm is given', async () => {
    api.get('/messaging/unread-count', { count: 2 });

    expect(await messagesService.getUnreadCount()).toBe(2);
    // A portal client has no single firm. Reaching the firm-scoped route with
    // `undefined` in the path is a 404 that would zero their badge permanently.
    expect(api.calls('GET')[0].pathname).not.toContain('/lawfirms/');
  });

  it('SWALLOWS a refusal and answers zero', async () => {
    api.get('/messaging/unread-count', { status: 403, body: { error: 'Forbidden' } });

    // Deliberately unlike every other method here: the badge is chrome on every
    // page, so a throw would surface as an error boundary during a role change
    // rather than as an absent number.
    await expect(messagesService.getUnreadCount()).resolves.toBe(0);
  });

  it('answers zero on a server error too', async () => {
    api.get('/messaging/unread-count', { status: 500, body: { error: 'Boom' } });

    await expect(messagesService.getUnreadCount()).resolves.toBe(0);
  });

  it('answers zero when the body carries no count', async () => {
    api.get('/messaging/unread-count', {});

    // `undefined` on a badge renders as "NaN" next to the inbox link.
    await expect(messagesService.getUnreadCount()).resolves.toBe(0);
  });
});

describe('editing and deleting a message', () => {
  it('PATCHes the new content to the message url', async () => {
    api.patch('/messaging/messages/msg-1', { messageId: 'msg-1', editedAt: 'now' });

    await messagesService.editMessage(LAW_FIRM_ID, 'msg-1', 'Corrected text');

    const call = api.calls('PATCH')[0];
    expect(call.pathname).toMatch(/\/messaging\/messages\/msg-1$/);
    expect(bodyOf(call).content).toBe('Corrected text');
  });

  it('DELETEs through the same url with no body', async () => {
    api.delete('/messaging/messages/msg-1', { messageId: 'msg-1' });

    await messagesService.deleteMessage(LAW_FIRM_ID, 'msg-1');

    // Same url as the edit, and the verb is all that separates "fix a typo" from
    // "replace this with a tombstone for everyone on the thread".
    const call = api.calls('DELETE')[0];
    expect(call.pathname).toMatch(/\/messaging\/messages\/msg-1$/);
    expect(call.body).toBeNull();
  });

  it('throws when an edit is refused', async () => {
    api.patch('/messaging/messages/msg-1', {
      status: 403, body: { error: 'Only the sender can edit this message' },
    });

    // Sender-only is enforced server-side. A swallowed refusal shows the edited
    // text locally until the next load restores the original.
    await expect(messagesService.editMessage(LAW_FIRM_ID, 'msg-1', 'x'))
      .rejects.toThrow(/only the sender/i);
  });
});

describe('searching messages', () => {
  it('sends the term under q and reads results from the envelope', async () => {
    api.get('/messaging/search', { results: [{ messageId: 'm1' }] });

    const results = await messagesService.searchMessages(LAW_FIRM_ID, 'retainer agreement');

    // Read through URLSearchParams: the space is on the wire as `+`.
    expect(paramsOf(api.calls('GET')[0].url).get('q')).toBe('retainer agreement');
    expect(results).toHaveLength(1);
  });

  it('defaults a missing results list to an empty array', async () => {
    api.get('/messaging/search', {});

    // The results panel maps over this. The endpoint deliberately never answers
    // a bare array at the root, so the envelope key is the only source.
    expect(await messagesService.searchMessages(LAW_FIRM_ID, 'x')).toEqual([]);
  });

  it('throws when search is refused', async () => {
    api.get('/messaging/search', { status: 403, body: { error: 'Forbidden' } });

    // "No results" and "you may not search" must not look the same.
    await expect(messagesService.searchMessages(LAW_FIRM_ID, 'x')).rejects.toBeDefined();
  });
});

describe('group composition', () => {
  it('creates a group with each id list under its own key', async () => {
    api.post('/messaging/groups', { conversationId: CONVERSATION_ID });

    await messagesService.createGroup(LAW_FIRM_ID, {
      title: 'Trial prep',
      memberIds: ['member-a', 'member-b'],
      clientIds: ['uid-1'],
      organizationClientIds: ['org-client-1'],
      matterIds: ['matter-1', 'matter-2'],
    });

    const body = bodyOf(api.calls('POST')[0]);
    // Three different id spaces decide who can read the thread: firm members,
    // portal uids, and company records the server expands into whole rosters.
    // Merged or crossed, a client is added to a thread the firm meant to keep
    // internal.
    expect(body.memberIds).toEqual(['member-a', 'member-b']);
    expect(body.clientIds).toEqual(['uid-1']);
    expect(body.organizationClientIds).toEqual(['org-client-1']);
    expect(body.matterIds).toEqual(['matter-1', 'matter-2']);
  });

  it('adds participants with POST to the participants collection', async () => {
    api.post(`/groups/${CONVERSATION_ID}/participants`, { message: 'Added' });

    await messagesService.addGroupParticipants(LAW_FIRM_ID, CONVERSATION_ID, {
      clientIds: ['uid-9'], shareHistory: true,
    });

    const call = api.calls('POST')[0];
    expect(call.pathname).toMatch(/\/groups\/conv-7\/participants$/);
    // `shareHistory` decides whether the new person can read everything said
    // before they arrived. Dropped, the server falls back to its own default and
    // the firm's choice is silently discarded.
    expect(bodyOf(call).shareHistory).toBe(true);
  });

  it('sends shareHistory false rather than omitting it', async () => {
    api.post(`/groups/${CONVERSATION_ID}/participants`, { message: 'Added' });

    await messagesService.addGroupParticipants(LAW_FIRM_ID, CONVERSATION_ID, {
      clientIds: ['uid-9'], shareHistory: false,
    });

    // The whole object is serialised, so an explicit false survives. Withholding
    // history is the more protective choice and it must be the one that reaches
    // the server.
    expect(bodyOf(api.calls('POST')[0]).shareHistory).toBe(false);
  });

  it('removes a participant by PORTAL UID on the participants url', async () => {
    api.delete(`/groups/${CONVERSATION_ID}/participants/uid-9`, { message: 'Removed' });

    await messagesService.removeGroupParticipant(LAW_FIRM_ID, CONVERSATION_ID, 'uid-9');

    expect(api.calls('DELETE')[0].pathname)
      .toMatch(/\/groups\/conv-7\/participants\/uid-9$/);
  });

  it('removes a PENDING recipient by client record id on a DIFFERENT url', async () => {
    api.delete(`/groups/${CONVERSATION_ID}/pending/client-record-5`, { message: 'Removed' });

    await messagesService.removePendingGroupClient(
      LAW_FIRM_ID, CONVERSATION_ID, 'client-record-5',
    );

    // Someone added before they had a portal account has no participant row at
    // all, so the participants route cannot address them. Sent there the removal
    // 404s and the firm keeps seeing a recipient they thought they took off.
    expect(api.calls('DELETE')[0].pathname)
      .toMatch(/\/groups\/conv-7\/pending\/client-record-5$/);
  });

  it('the two removals do not share an endpoint', async () => {
    api.delete(`/groups/${CONVERSATION_ID}/participants/uid-9`, { message: 'ok' });
    api.delete(`/groups/${CONVERSATION_ID}/pending/client-record-5`, { message: 'ok' });

    await messagesService.removeGroupParticipant(LAW_FIRM_ID, CONVERSATION_ID, 'uid-9');
    await messagesService.removePendingGroupClient(
      LAW_FIRM_ID, CONVERSATION_ID, 'client-record-5',
    );

    // Two id spaces, two routes. The ids are both opaque uuids so nothing else
    // would catch a swap.
    const paths = api.calls('DELETE').map((c) => c.pathname);
    expect(paths[0]).toContain('/participants/');
    expect(paths[1]).toContain('/pending/');
  });

  it('throws when a participant add is refused', async () => {
    api.post(`/groups/${CONVERSATION_ID}/participants`, {
      status: 400, body: { error: 'Too many organizations in one group' },
    });

    await expect(messagesService.addGroupParticipants(LAW_FIRM_ID, CONVERSATION_ID, {
      organizationClientIds: new Array(21).fill('org'),
    })).rejects.toThrow(/too many organizations/i);
  });
});

describe('group settings', () => {
  it('REPLACES the matter scope with a PUT of the whole list', async () => {
    api.put(`/groups/${CONVERSATION_ID}/matters`, {
      message: 'ok', matterIds: ['matter-1'],
    });

    await messagesService.setGroupMatters(LAW_FIRM_ID, CONVERSATION_ID, ['matter-1', 'matter-3']);

    const call = api.calls('PUT')[0];
    expect(call.pathname).toMatch(/\/groups\/conv-7\/matters$/);
    // A replace, not an append: whatever is sent becomes the entire scope.
    expect(bodyOf(call).matterIds).toEqual(['matter-1', 'matter-3']);
  });

  it('sends an EMPTY matter list to clear the scope', async () => {
    api.put(`/groups/${CONVERSATION_ID}/matters`, { message: 'ok', matterIds: [] });

    await messagesService.setGroupMatters(LAW_FIRM_ID, CONVERSATION_ID, []);

    // Clearing every matter is a legitimate instruction. Dropping the key would
    // make it a no-op and the tags would reappear on the next load.
    expect(bodyOf(api.calls('PUT')[0]).matterIds).toEqual([]);
  });

  it('sets group privacy with the boolean the caller chose', async () => {
    api.put(`/groups/${CONVERSATION_ID}/privacy`, {
      message: 'ok', hideClientNames: false,
    });

    await messagesService.setGroupPrivacy(LAW_FIRM_ID, CONVERSATION_ID, false);

    // Turning masking OFF exposes co-clients' names to each other. A body that
    // dropped `false` would leave the setting on and look like a broken toggle,
    // but the inverse mistake reveals identities.
    const call = api.calls('PUT')[0];
    expect(call.pathname).toMatch(/\/groups\/conv-7\/privacy$/);
    expect(bodyOf(call).hideClientNames).toBe(false);
  });

  it('reads and writes the present-as-firm preference on one url', async () => {
    api.get('/messaging/present-as-firm', { presentAsFirm: true });
    api.put('/messaging/present-as-firm', { message: 'ok', presentAsFirm: false });

    expect((await messagesService.getPresentAsFirm(LAW_FIRM_ID)).presentAsFirm).toBe(true);
    await messagesService.setPresentAsFirm(LAW_FIRM_ID, false);

    // The GET reads and the PUT writes. The value decides whether a client sees
    // the firm's name or the individual member's on every message they send.
    expect(bodyOf(api.calls('PUT')[0]).presentAsFirm).toBe(false);
  });

  it('archives a conversation with the flag in the body and the thread in the path', async () => {
    api.put(`/conversations/${CONVERSATION_ID}/archive`, { message: 'ok', archived: true });

    await messagesService.setConversationArchived(LAW_FIRM_ID, CONVERSATION_ID, true);

    const call = api.calls('PUT')[0];
    expect(call.pathname).toMatch(/\/conversations\/conv-7\/archive$/);
    expect(bodyOf(call).archived).toBe(true);
  });

  it('UNarchives through the same route with false', async () => {
    api.put(`/conversations/${CONVERSATION_ID}/archive`, { message: 'ok', archived: false });

    await messagesService.setConversationArchived(LAW_FIRM_ID, CONVERSATION_ID, false);

    // One route, both directions. A body that dropped `false` would make
    // unarchiving impossible while archiving kept working.
    expect(bodyOf(api.calls('PUT')[0]).archived).toBe(false);
  });

  it('throws when an archive write is refused', async () => {
    api.put(`/conversations/${CONVERSATION_ID}/archive`, {
      status: 403, body: { error: 'Forbidden' },
    });

    await expect(
      messagesService.setConversationArchived(LAW_FIRM_ID, CONVERSATION_ID, true),
    ).rejects.toBeDefined();
  });
});

describe('attaching files that already live in the file manager', () => {
  const FILE_A = 'a1b2c3d4-0000-4000-8000-00000000000a';
  const FILE_B = 'a1b2c3d4-0000-4000-8000-00000000000b';

  it('POSTs the target and the file ids to the from-files route', async () => {
    api.post('/messaging/attachments/from-files', { attachments: [] });

    await messagesService.attachExistingFiles(
      LAW_FIRM_ID,
      { conversationId: CONVERSATION_ID },
      [{ fileId: FILE_A }, { fileId: FILE_B }],
    );

    const call = api.calls('POST')[0];
    expect(call.pathname).toMatch(/\/messaging\/attachments\/from-files$/);
    // The server re-verifies read access to each document before copying it
    // into the thread, and takes the name from the row. The request used to
    // carry an object path and an optional name, which let one document be
    // forwarded into a chat under another document's name.
    const body = bodyOf(call);
    expect(body.conversationId).toBe(CONVERSATION_ID);
    expect((body.files as Array<{ fileId: string }>).map((f) => f.fileId))
      .toEqual([FILE_A, FILE_B]);
  });

  it('spreads a clientId target to the top level of the body', async () => {
    api.post('/messaging/attachments/from-files', { attachments: [] });

    await messagesService.attachExistingFiles(
      LAW_FIRM_ID, { clientId: CLIENT_ID }, [{ fileId: FILE_A }],
    );

    // Nested under a `target` key the server would not see it, and the copy
    // would have no conversation to land in.
    expect(bodyOf(api.calls('POST')[0]).clientId).toBe(CLIENT_ID);
  });

  it('defaults a missing attachments list to an empty array', async () => {
    api.post('/messaging/attachments/from-files', {});

    // The composer maps over this before sending.
    expect(await messagesService.attachExistingFiles(
      LAW_FIRM_ID, { clientId: CLIENT_ID }, [{ fileId: FILE_A }],
    )).toEqual([]);
  });

  it('throws when the copy is refused', async () => {
    api.post('/messaging/attachments/from-files', {
      status: 403, body: { error: 'You cannot read that file' },
    });

    await expect(messagesService.attachExistingFiles(
      LAW_FIRM_ID, { clientId: CLIENT_ID }, [{ fileId: FILE_A }],
    )).rejects.toThrow(/cannot read that file/i);
  });
});

describe('uploading attachments', () => {
  const BASE = `/lawfirms/${LAW_FIRM_ID}/messaging/attachments`;
  const SESSION_A = 'https://storage.googleapis.com/upload/a';
  const SESSION_B = 'https://storage.googleapis.com/upload/b';

  /**
   * One session per file, every PUT succeeding, one finalize.
   *
   * The upload is three steps now. It used to be a single multipart POST that
   * carried the files through the API container, which held up to five of them
   * at a hundred megabytes each while eighty other requests were being served.
   */
  function arrange(sessions: string[] = [SESSION_A], attachments: unknown[] = []) {
    api.post(`${BASE}/upload-init`, {
      uploads: sessions.map((url, i) => ({
        uploadUrl: url, objectPath: `msg/${i}.pdf`, fileName: `${i}.pdf`,
      })),
      reservedBytes: 100,
    });
    sessions.forEach((url) => xhr.onExact('PUT', url, { status: 200 }));
    api.post(`${BASE}/upload-finalize`, { attachments, failures: [] });
  }

  it('sends the bytes to storage and returns what the server recorded', async () => {
    arrange([SESSION_A], [{ name: 'a.pdf' }]);

    const result = await messagesService.uploadAttachments(
      LAW_FIRM_ID, { clientId: CLIENT_ID }, [fileNamed('a.pdf')],
    );

    // The bytes leave on an XHR PUT to storage. Only an XHR-level fake proves
    // that leg happened at all; `apiMock` covers the two JSON legs around it.
    expect(xhr.calls('PUT')[0].url).toBe(SESSION_A);
    expect(result).toEqual([{ name: 'a.pdf' }]);
  });

  it('sends no reservation of its own at finalize', async () => {
    arrange([SESSION_A]);

    await messagesService.uploadAttachments(
      LAW_FIRM_ID, { clientId: CLIENT_ID }, [fileNamed('a.pdf')],
    );

    // The server derives what init reserved from the rows it claimed.
    const done = api.callsTo(`${BASE}/upload-finalize`)[0];
    expect((done.body as any).uploads.map((u: any) => u.objectPath)).toEqual(['msg/0.pdf']);
    expect((done.body as any).reservedBytes).toBeUndefined();
  });

  it('declares every file to the server, in order', async () => {
    arrange([SESSION_A, SESSION_B]);

    await messagesService.uploadAttachments(
      LAW_FIRM_ID, { clientId: CLIENT_ID },
      [fileNamed('first.pdf'), fileNamed('second.pdf')],
    );

    // The server mints one session per declared file and reserves quota for the
    // declared total. A dropped or reordered entry hands the wrong session to
    // the wrong file, and each lands under the other's name.
    const declared = (api.callsTo(`${BASE}/upload-init`)[0].body as any).files;
    expect(declared.map((f: any) => f.fileName)).toEqual(['first.pdf', 'second.pdf']);
  });

  it('does NOT attach the credential to the storage request', async () => {
    arrange();

    await messagesService.uploadAttachments(
      LAW_FIRM_ID, { clientId: CLIENT_ID }, [fileNamed('a.pdf')],
    );

    // Inverted from the multipart path, where the service attached the token by
    // hand. A signed session url IS the authorization; adding a bearer token
    // sends the user's API credential to a host that never needed it.
    const put = xhr.calls('PUT')[0];
    expect(Object.keys(put.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('targets a CLIENT for a direct thread and a CONVERSATION for a group', async () => {
    arrange();

    await messagesService.uploadAttachments(
      LAW_FIRM_ID, { clientId: CLIENT_ID }, [fileNamed('a.pdf')],
    );
    await messagesService.uploadAttachments(
      LAW_FIRM_ID, { conversationId: CONVERSATION_ID }, [fileNamed('b.pdf')],
    );

    // A direct thread may not exist yet, so it is addressed by the client. A
    // group has no single client, so it is addressed by the thread. The upload
    // lands in the wrong storage folder if these are crossed.
    const [first, second] = api.callsTo(`${BASE}/upload-init`).map((c) => c.body as any);
    expect(first.clientId).toBe(CLIENT_ID);
    expect(first.conversationId).toBeUndefined();
    expect(second.conversationId).toBe(CONVERSATION_ID);
    expect(second.clientId).toBeUndefined();
  });

  it('sends ONLY the clientId when both targets are supplied', async () => {
    arrange();

    await messagesService.uploadAttachments(
      LAW_FIRM_ID,
      { clientId: CLIENT_ID, conversationId: CONVERSATION_ID },
      [fileNamed('a.pdf')],
    );

    // clientId wins. Sending both would let the server pick, and the two can
    // name different threads.
    const body = api.callsTo(`${BASE}/upload-init`)[0].body as any;
    expect(body.clientId).toBe(CLIENT_ID);
    expect(body.conversationId).toBeUndefined();
  });

  it('reports progress as a whole-number percentage that never goes backwards', async () => {
    arrange([SESSION_A, SESSION_B]);
    const seen: number[] = [];

    await messagesService.uploadAttachments(
      LAW_FIRM_ID, { clientId: CLIENT_ID },
      [fileNamed('a.pdf'), fileNamed('b.pdf')], (p) => seen.push(p),
    );

    // Across the batch, not per file. A per-file percentage drops back to zero
    // on the second attachment, which reads as the upload restarting.
    expect(seen.every((p) => Number.isInteger(p) && p >= 0 && p <= 100)).toBe(true);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('defaults a missing attachments list to an empty array', async () => {
    api.post(`${BASE}/upload-init`, {
      uploads: [{ uploadUrl: SESSION_A, objectPath: 'msg/0.pdf', fileName: '0.pdf' }],
      reservedBytes: 100,
    });
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    api.post(`${BASE}/upload-finalize`, {});

    // The composer maps over this before sending.
    expect(await messagesService.uploadAttachments(
      LAW_FIRM_ID, { clientId: CLIENT_ID }, [fileNamed('a.pdf')],
    )).toEqual([]);
  });

  it('rejects with the server message when the upload is refused', async () => {
    api.post(`${BASE}/upload-init`, {
      status: 413, body: { error: 'Storage limit reached', code: 'STORAGE_LIMIT_EXCEEDED' },
    });

    await expect(messagesService.uploadAttachments(
      LAW_FIRM_ID, { clientId: CLIENT_ID }, [fileNamed('a.pdf')],
    )).rejects.toThrow(/Storage limit reached/);
  });

  it('does not finalize when the bytes never landed', async () => {
    api.post(`${BASE}/upload-init`, {
      uploads: [{ uploadUrl: SESSION_A, objectPath: 'msg/0.pdf', fileName: '0.pdf' }],
      reservedBytes: 100,
    });
    // 410 is the session being gone, which the uploader treats as terminal.
    xhr.onExact('PUT', SESSION_A, { status: 410 });
    api.allowUnhandled();

    await expect(messagesService.uploadAttachments(
      LAW_FIRM_ID, { clientId: CLIENT_ID }, [fileNamed('a.pdf')],
    )).rejects.toThrow();

    // Finalizing here records attachments pointing at objects that are not
    // there, and tells the user the message is ready to send.
    expect(api.callsTo(`${BASE}/upload-finalize`)).toEqual([]);
  });

  it('does nothing at all for an empty selection', async () => {
    expect(await messagesService.uploadAttachments(LAW_FIRM_ID, { clientId: CLIENT_ID }, []))
      .toEqual([]);
    expect(xhr.calls()).toEqual([]);
  });
});
