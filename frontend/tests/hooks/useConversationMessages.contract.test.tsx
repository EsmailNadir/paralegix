/**
 * Firm-side conversation-message contracts.
 *
 * This hook combines an authorized REST history with a Realtime change stream.
 * The tests keep the REST service real and supply only the socket boundary, so
 * an endpoint, read-receipt body, stale-thread guard, or channel cleanup change
 * fails in ordinary offline CI.
 */
jest.unmock('@/services/messages.service');
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/lib/supabase/realtimeClient', () => ({
  authorizeRealtime: jest.fn(),
  getRealtimeClient: jest.fn(),
  retainRealtime: jest.fn(),
  releaseRealtime: jest.fn(),
  onRealtimeResume: jest.fn(() => () => {}),
}));

import { act, renderHook, waitFor } from '@testing-library/react';

import { useConversationMessages } from '@/hooks/useConversationMessages';
import {
  authorizeRealtime,
  getRealtimeClient,
  retainRealtime,
  releaseRealtime,
  onRealtimeResume,
} from '@/lib/supabase/realtimeClient';
import { resetPageVisibility, setPageVisibility } from '../support/pageVisibility';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock, sequence } from '../support/apiMock';
import { holdResponse } from '../support/deferred';

const authorizeRealtimeMock = authorizeRealtime as jest.Mock;
const getRealtimeClientMock = getRealtimeClient as jest.Mock;
const retainRealtimeMock = retainRealtime as jest.Mock;
const releaseRealtimeMock = releaseRealtime as jest.Mock;
const onRealtimeResumeMock = onRealtimeResume as jest.Mock;
let resumeListeners: Set<() => void>;
let channelFactory: jest.Mock;

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';
const CONVERSATION_A = 'conversation-a';
const CONVERSATION_B = 'conversation-b';

const api = setupApiMock();
let realtimeCallback: ((payload: unknown) => void) | undefined;
let removeChannel: jest.Mock;
let channelOn: jest.Mock;

interface FakeRealtimeChannel {
  on: jest.Mock;
  subscribe: jest.Mock;
}

function message(messageId: string, senderType: 'client' | 'firm_member' = 'firm_member') {
  return {
    messageId,
    senderId: senderType === 'client' ? 'client-a' : 'member-a',
    senderType,
    senderName: senderType === 'client' ? 'Pat Client' : 'Firm Member',
    recipientId: senderType === 'client' ? 'member-a' : 'client-a',
    content: `message ${messageId}`,
    createdAt: '2026-08-31T10:00:00.000Z',
    updatedAt: '2026-08-31T10:00:00.000Z',
  };
}

beforeEach(() => {
  __resetDuplicateRequestGuard();
  realtimeCallback = undefined;
  removeChannel = jest.fn();

  const channel = {} as FakeRealtimeChannel;
  channel.on = jest.fn((_event: string, _filter: unknown, callback: (payload: unknown) => void) => {
      realtimeCallback = callback;
      return channel;
    });
  channelOn = channel.on;
  channel.subscribe = jest.fn(() => channel);
  channelFactory = jest.fn(() => channel);
  authorizeRealtimeMock.mockResolvedValue({ channel: channelFactory, removeChannel });
  getRealtimeClientMock.mockReturnValue({ removeChannel });
  resumeListeners = new Set();
  onRealtimeResumeMock.mockImplementation((listener: () => void) => {
    resumeListeners.add(listener);
    return () => resumeListeners.delete(listener);
  });
});

afterEach(() => {
  resetPageVisibility();
  jest.clearAllMocks();
});

describe('useConversationMessages offline contract', () => {
  it('marks an incoming direct message unread until the firm cursor advances even when its shared flag is true', async () => {
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/conversations/${CONVERSATION_A}?limit=30`, {
      messages: [{ ...message('asymmetric-cursor', 'client'), read: true, readByFirm: false, readByClient: true }],
      conversation: { conversationId: CONVERSATION_A },
      hasMore: false,
    });
    api.putExact(`/api/lawfirms/${FIRM_A}/messaging/mark-read`, {});
    const { result } = renderHook(() => useConversationMessages(CONVERSATION_A, FIRM_A));
    await waitFor(() => expect(result.current.messages.map((row) => row.messageId)).toEqual(['asymmetric-cursor']));
    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    expect(api.calls('PUT')[0].body).toEqual({ conversationId: CONVERSATION_A, messageIds: ['asymmetric-cursor'] });
  });

  it('keeps an incoming portal message unread according to the client cursor rather than the shared flag', async () => {
    api.getExact(`/api/client-portal/lawfirm/${FIRM_A}/messages?limit=30`, {
      messages: [{ ...message('client-cursor', 'firm_member'), read: true, readByClient: false, readByFirm: true }],
      hasMore: false,
    });
    api.getExact('/api/messaging/client-conversations', {
      conversations: [{ conversationId: CONVERSATION_A, lawFirmId: FIRM_A }],
    });
    api.putExact(`/api/client-portal/lawfirm/${FIRM_A}/messages/mark-read`, {});
    const { result } = renderHook(() => useConversationMessages(CONVERSATION_A, FIRM_A, true));
    await waitFor(() => expect(result.current.messages.map((row) => row.messageId)).toEqual(['client-cursor']));
    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    expect(api.calls('PUT')[0].body).toEqual({ messageIds: ['client-cursor'] });
  });

  it('does not request history or retain a realtime subscriber before both thread and firm scopes exist', async () => {
    const noThread = renderHook(() => useConversationMessages(null, FIRM_A));
    await waitFor(() => expect(noThread.result.current.loading).toBe(false));
    expect(noThread.result.current.messages).toEqual([]);

    const noFirm = renderHook(() => useConversationMessages(CONVERSATION_A, undefined));
    await waitFor(() => expect(noFirm.result.current.loading).toBe(false));

    expect(api.calls()).toEqual([]);
    expect(retainRealtimeMock).not.toHaveBeenCalled();
    expect(releaseRealtimeMock).not.toHaveBeenCalled();
  });

  it('loads the exact firm/thread page and marks only unread client messages read', async () => {
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/conversations/${CONVERSATION_A}?limit=30`, {
      messages: [message('firm-message'), message('client-message', 'client')],
      conversation: { conversationId: CONVERSATION_A },
      hasMore: false,
    });
    api.putExact(`/api/lawfirms/${FIRM_A}/messaging/mark-read`, {});

    const { result } = renderHook(() => useConversationMessages(CONVERSATION_A, FIRM_A));

    await waitFor(() => expect(result.current.messages.map((row) => row.messageId))
      .toEqual(['firm-message', 'client-message']));
    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));

    expect(api.calls('GET')).toEqual([expect.objectContaining({
      pathname: `/api/lawfirms/${FIRM_A}/messaging/conversations/${CONVERSATION_A}`,
      query: { limit: ['30'] },
    })]);
    expect(api.calls('PUT')[0].body).toEqual({
      conversationId: CONVERSATION_A,
      messageIds: ['client-message'],
    });
  });

  it('surfaces a refused thread load instead of rendering it as an empty conversation', async () => {
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/conversations/${CONVERSATION_A}?limit=30`, {
      status: 403,
      body: { error: 'Conversation access denied' },
    });

    const { result } = renderHook(() => useConversationMessages(CONVERSATION_A, FIRM_A));

    await waitFor(() => expect(result.current.error).toMatch(/Conversation access denied/i));
    expect(result.current.messages).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('merges a renderable realtime row without another history request and cleans up the channel', async () => {
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/conversations/${CONVERSATION_A}?limit=30`, {
      messages: [message('firm-message')],
      conversation: { conversationId: CONVERSATION_A },
      hasMore: false,
    });
    // The incoming row is from the client, so auto-read is an expected write;
    // a direct apply must not also trigger a second GET history request.
    api.putExact(`/api/lawfirms/${FIRM_A}/messaging/mark-read`, {});

    const { result, unmount } = renderHook(() => useConversationMessages(CONVERSATION_A, FIRM_A));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await waitFor(() => expect(realtimeCallback).toBeDefined());

    await act(async () => {
      realtimeCallback?.({
        eventType: 'INSERT',
        new: {
          id: 'client-message',
          sender_user_id: 'client-a',
          sender_type: 'client',
          sender_name: 'Pat Client',
          recipient_id: 'member-a',
          content: 'New filing uploaded',
          created_at: '2026-08-31T11:00:00.000Z',
        },
      });
    });

    await waitFor(() => expect(result.current.messages.map((row) => row.messageId))
      .toEqual(['firm-message', 'client-message']));
    expect(api.calls('GET')).toHaveLength(1);
    await waitFor(() => expect(api.calls('PUT')[0].body).toEqual({
      conversationId: CONVERSATION_A,
      messageIds: ['client-message'],
    }));

    unmount();
    expect(removeChannel).toHaveBeenCalledTimes(1);
    expect(releaseRealtimeMock).toHaveBeenCalledTimes(1);
  });

  it('refetches authoritative REST data for a realtime row with attachments', async () => {
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/conversations/${CONVERSATION_A}?limit=30`, sequence(
      {
        messages: [message('firm-message')],
        conversation: { conversationId: CONVERSATION_A },
        hasMore: false,
      },
      {
        messages: [
          message('firm-message'),
          {
            ...message('attachment-message'),
            attachments: [{ objectPath: 'firms/a/attachment.pdf', url: 'https://signed.example/attachment.pdf' }],
          },
        ],
        conversation: { conversationId: CONVERSATION_A },
        hasMore: false,
      },
    ));

    const { result } = renderHook(() => useConversationMessages(CONVERSATION_A, FIRM_A));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await waitFor(() => expect(realtimeCallback).toBeDefined());

    // This is the intentional authoritative refetch after an attachment event,
    // not a second consumer requesting the same stable history page.
    __resetDuplicateRequestGuard();
    await act(async () => {
      realtimeCallback?.({
        eventType: 'INSERT',
        new: {
          id: 'attachment-message',
          sender_user_id: 'member-a',
          sender_type: 'firm_member',
          sender_name: 'Firm Member',
          recipient_id: 'client-a',
          content: 'See the attachment',
          created_at: '2026-08-31T11:00:00.000Z',
          // The socket row knows only storage metadata. Applying it directly
          // would render an attachment with no signed URL.
          attachments: [{ objectPath: 'firms/a/attachment.pdf' }],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    await waitFor(() => expect(result.current.messages.map((row) => row.messageId))
      .toEqual(['firm-message', 'attachment-message']));
    expect(api.calls('GET')).toHaveLength(2);
    expect(result.current.messages[1].attachments).toEqual([
      { objectPath: 'firms/a/attachment.pdf', url: 'https://signed.example/attachment.pdf' },
    ]);
  });

  it('does not let a delayed thread from firm A overwrite the selected firm B thread', async () => {
    const heldFirmA = holdResponse();
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/conversations/${CONVERSATION_A}?limit=30`, heldFirmA.handler);
    api.getExact(`/api/lawfirms/${FIRM_B}/messaging/conversations/${CONVERSATION_B}?limit=30`, {
      messages: [message('firm-b-message')],
      conversation: { conversationId: CONVERSATION_B },
      hasMore: false,
    });

    const { result, rerender } = renderHook(
      ({ conversationId, lawFirmId }: { conversationId: string; lawFirmId: string }) =>
        useConversationMessages(conversationId, lawFirmId),
      { initialProps: { conversationId: CONVERSATION_A, lawFirmId: FIRM_A } },
    );
    await waitFor(() => expect(api.callsTo(`/lawfirms/${FIRM_A}/messaging/conversations/${CONVERSATION_A}`)).toHaveLength(1));

    rerender({ conversationId: CONVERSATION_B, lawFirmId: FIRM_B });
    await waitFor(() => expect(result.current.messages.map((row) => row.messageId)).toEqual(['firm-b-message']));

    await act(async () => {
      heldFirmA.release({
        messages: [message('firm-a-message')],
        conversation: { conversationId: CONVERSATION_A },
        hasMore: false,
      });
    });

    expect(result.current.messages.map((row) => row.messageId)).toEqual(['firm-b-message']);
  });

  it('does not let a delayed load-more page for firm A leak into a switched firm B thread', async () => {
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/conversations/${CONVERSATION_A}?limit=30`, {
      messages: [message('a-2')],
      conversation: { conversationId: CONVERSATION_A },
      hasMore: true,
    });
    const heldLoadMore = holdResponse();
    api.getExact(
      `/api/lawfirms/${FIRM_A}/messaging/conversations/${CONVERSATION_A}?limit=30&lastMessageId=a-2`,
      heldLoadMore.handler,
    );
    api.getExact(`/api/lawfirms/${FIRM_B}/messaging/conversations/${CONVERSATION_B}?limit=30`, {
      messages: [message('b-1')],
      conversation: { conversationId: CONVERSATION_B },
      hasMore: false,
    });

    const { result, rerender } = renderHook(
      ({ conversationId, lawFirmId }: { conversationId: string; lawFirmId: string }) =>
        useConversationMessages(conversationId, lawFirmId),
      { initialProps: { conversationId: CONVERSATION_A, lawFirmId: FIRM_A } },
    );
    await waitFor(() => expect(result.current.messages.map((row) => row.messageId)).toEqual(['a-2']));
    expect(result.current.hasMore).toBe(true);

    act(() => {
      result.current.loadMore();
    });
    await heldLoadMore.untilRequested();

    // Switch threads while firm A's load-more page is still in flight.
    rerender({ conversationId: CONVERSATION_B, lawFirmId: FIRM_B });
    await waitFor(() => expect(result.current.messages.map((row) => row.messageId)).toEqual(['b-1']));

    // Firm A's older page finally arrives. It must not be prepended onto the
    // thread the viewer has since switched to.
    await act(async () => {
      heldLoadMore.release({
        messages: [message('a-1')],
        conversation: { conversationId: CONVERSATION_A },
        hasMore: false,
      });
    });

    expect(result.current.messages.map((row) => row.messageId)).toEqual(['b-1']);
  });

  it('loads a portal direct thread from its client route and sorts it oldest first', async () => {
    api.getExact(`/api/client-portal/lawfirm/${FIRM_A}/messages?limit=30`, {
      messages: [
        { ...message('newer-client-message', 'client'), createdAt: '2026-08-31T12:00:00.000Z' },
        { ...message('older-client-message', 'client'), createdAt: '2026-08-31T10:00:00.000Z' },
      ],
      hasMore: true,
    });
    api.getExact('/api/messaging/client-conversations', {
      conversations: [{ conversationId: CONVERSATION_A, lawFirmId: FIRM_A }],
    });

    const { result } = renderHook(() => useConversationMessages(CONVERSATION_A, FIRM_A, true));

    await waitFor(() => expect(result.current.messages.map((row) => row.messageId))
      .toEqual(['older-client-message', 'newer-client-message']));
    expect(result.current.hasMore).toBe(true);
    expect(api.calls('GET')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pathname: `/api/client-portal/lawfirm/${FIRM_A}/messages`,
        query: { limit: ['30'] },
      }),
      expect.objectContaining({ pathname: '/api/messaging/client-conversations' }),
    ]));
  });

  it('subscribes a portal group through content-free broadcast rather than raw message rows', async () => {
    api.getExact(`/api/messaging/client-groups/${CONVERSATION_A}?limit=30`, {
      conversation: {
        conversationId: CONVERSATION_A,
        lawFirmId: FIRM_A,
        lastMessageAt: '2026-08-31T10:00:00.000Z',
        title: 'Client group',
        matterId: null,
      },
      messages: [{ ...message('group-message', 'client'), read: true }],
      participants: [],
      hasMore: false,
    });
    api.putExact(`/api/messaging/client-groups/${CONVERSATION_A}/mark-read`, {});

    const { result } = renderHook(() => useConversationMessages(CONVERSATION_A, FIRM_A, true, true));

    await waitFor(() => expect(result.current.messages.map((row) => row.messageId)).toEqual(['group-message']));
    await waitFor(() => expect(channelOn).toHaveBeenCalled());
    expect(channelOn.mock.calls[0][0]).toBe('broadcast');
    expect(channelOn.mock.calls[0][1]).toEqual({ event: 'new' });
    await waitFor(() => expect(api.calls('PUT')).toEqual([expect.objectContaining({
      pathname: `/api/messaging/client-groups/${CONVERSATION_A}/mark-read`,
      body: null,
    })]));
  });
});

describe('useConversationMessages live updates keep resolved sender photos', () => {
  const PHOTO = 'https://photos.example/pat.png';

  async function mountWithPhoto() {
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/conversations/${CONVERSATION_A}?limit=30`, {
      messages: [{ ...message('client-message', 'client'), readByFirm: true, senderPhotoUrl: PHOTO }],
      conversation: { conversationId: CONVERSATION_A },
      hasMore: false,
    });
    const hook = renderHook(() => useConversationMessages(CONVERSATION_A, FIRM_A));
    await waitFor(() => expect(hook.result.current.messages).toHaveLength(1));
    await waitFor(() => expect(realtimeCallback).toBeDefined());
    expect(hook.result.current.messages[0].senderPhotoUrl).toBe(PHOTO);
    return hook;
  }

  it('keeps the avatar when a live edit of the message arrives without a photo column', async () => {
    const { result } = await mountWithPhoto();

    await act(async () => {
      realtimeCallback?.({
        eventType: 'UPDATE',
        new: {
          id: 'client-message',
          sender_user_id: 'client-a',
          sender_type: 'client',
          sender_name: 'Pat Client',
          content: 'message client-message (edited)',
          read_by_firm: true,
          edited_at: '2026-08-31T10:05:00.000Z',
          created_at: '2026-08-31T10:00:00.000Z',
        },
      });
    });

    await waitFor(() => expect(result.current.messages[0].content).toBe('message client-message (edited)'));
    expect(result.current.messages[0].senderPhotoUrl).toBe(PHOTO);
  });

  it('gives a new live message the photo its sender already shows in the thread', async () => {
    api.putExact(`/api/lawfirms/${FIRM_A}/messaging/mark-read`, {});
    const { result } = await mountWithPhoto();

    await act(async () => {
      realtimeCallback?.({
        eventType: 'INSERT',
        new: {
          id: 'client-message-2',
          sender_user_id: 'client-a',
          sender_type: 'client',
          sender_name: 'Pat Client',
          content: 'A second note',
          created_at: '2026-08-31T11:00:00.000Z',
        },
      });
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages[1].senderPhotoUrl).toBe(PHOTO);
  });
});

describe('useConversationMessages switching threads', () => {
  function group(conversationId: string, messageId: string) {
    return {
      conversation: {
        conversationId,
        lawFirmId: FIRM_A,
        lastMessageAt: '2026-08-31T10:00:00.000Z',
        title: `Group ${conversationId}`,
        matterId: null,
      },
      messages: [{ ...message(messageId, 'firm_member'), read: false }],
      participants: [],
      hasMore: false,
    };
  }

  it('does not mark the next group read before that group has loaded', async () => {
    api.getExact(`/api/messaging/client-groups/${CONVERSATION_A}?limit=30`, group(CONVERSATION_A, 'a-1'));
    api.putExact(`/api/messaging/client-groups/${CONVERSATION_A}/mark-read`, {});
    const heldB = holdResponse();
    api.getExact(`/api/messaging/client-groups/${CONVERSATION_B}?limit=30`, heldB.handler);
    api.putExact(`/api/messaging/client-groups/${CONVERSATION_B}/mark-read`, {});

    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useConversationMessages(conversationId, FIRM_A, true, true),
      { initialProps: { conversationId: CONVERSATION_A } },
    );
    await waitFor(() => expect(api.callsTo(`/client-groups/${CONVERSATION_A}/mark-read`)).toHaveLength(1));

    rerender({ conversationId: CONVERSATION_B });
    await heldB.untilRequested();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    // Group B is still loading: the only messages in hand are group A's, so
    // nothing the viewer has seen justifies advancing B's read cursor.
    expect(api.callsTo(`/client-groups/${CONVERSATION_B}/mark-read`)).toHaveLength(0);

    await act(async () => { heldB.release(group(CONVERSATION_B, 'b-1')); });
    await waitFor(() => expect(result.current.messages.map((row) => row.messageId)).toEqual(['b-1']));
    await waitFor(() => expect(api.callsTo(`/client-groups/${CONVERSATION_B}/mark-read`)).toHaveLength(1));
  });

  it('drops the previous thread\'s messages as soon as the conversation changes', async () => {
    api.getExact(`/api/messaging/client-groups/${CONVERSATION_A}?limit=30`, group(CONVERSATION_A, 'a-1'));
    api.putExact(`/api/messaging/client-groups/${CONVERSATION_A}/mark-read`, {});
    const heldB = holdResponse();
    api.getExact(`/api/messaging/client-groups/${CONVERSATION_B}?limit=30`, heldB.handler);
    api.putExact(`/api/messaging/client-groups/${CONVERSATION_B}/mark-read`, {});

    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useConversationMessages(conversationId, FIRM_A, true, true),
      { initialProps: { conversationId: CONVERSATION_A } },
    );
    await waitFor(() => expect(result.current.messages.map((row) => row.messageId)).toEqual(['a-1']));

    rerender({ conversationId: CONVERSATION_B });
    await heldB.untilRequested();

    expect(result.current.messages).toEqual([]);
    expect(result.current.loading).toBe(true);
    await act(async () => { heldB.release(group(CONVERSATION_B, 'b-1')); });
    await waitFor(() => expect(result.current.messages.map((row) => row.messageId)).toEqual(['b-1']));
  });
});

describe('useConversationMessages portal direct thread realtime', () => {
  it('watches the client\'s conversations row instead of streaming raw message rows', async () => {
    api.getExact(`/api/client-portal/lawfirm/${FIRM_A}/messages?limit=30`, sequence(
      { messages: [{ ...message('firm-1'), readByClient: true }], hasMore: false },
      {
        messages: [
          { ...message('firm-1'), readByClient: true },
          { ...message('firm-2'), readByClient: true, senderName: 'Test Firm' },
        ],
        hasMore: false,
      },
    ));
    api.getExact('/api/messaging/client-conversations', {
      conversations: [{ conversationId: CONVERSATION_A, lawFirmId: FIRM_A }],
    });

    const { result } = renderHook(() => useConversationMessages(`${FIRM_A}_client-a`, FIRM_A, true));
    await waitFor(() => expect(result.current.messages.map((row) => row.messageId)).toEqual(['firm-1']));
    await waitFor(() => expect(channelOn).toHaveBeenCalled());

    const subscriptions = channelOn.mock.calls.map((call) => call[1]);
    expect(subscriptions).toEqual([
      { event: 'UPDATE', schema: 'public', table: 'conversations', filter: `id=eq.${CONVERSATION_A}` },
      { event: 'new' },
    ]);
    expect(subscriptions).not.toContainEqual(expect.objectContaining({ table: 'messages' }));

    // The row change carries no message content; the masked REST read does.
    __resetDuplicateRequestGuard();
    await act(async () => {
      channelOn.mock.calls[0][2]({ eventType: 'UPDATE', new: { id: CONVERSATION_A } });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    await waitFor(() => expect(result.current.messages.map((row) => row.messageId)).toEqual(['firm-1', 'firm-2']));
    expect(result.current.messages[1].senderName).toBe('Test Firm');
  });
  it('re-reads on the content-free conversation ping, which carries firm edits, deletes and read receipts', async () => {
    api.getExact(`/api/client-portal/lawfirm/${FIRM_A}/messages?limit=30`, sequence(
      { messages: [{ ...message('firm-1'), readByClient: true }, { ...message('mine', 'client'), readByFirm: false }], hasMore: false },
      {
        messages: [
          { ...message('firm-1'), readByClient: true, content: 'Corrected wording', editedAt: '2026-08-31T10:05:00.000Z' },
          { ...message('mine', 'client'), readByFirm: true },
        ],
        hasMore: false,
      },
    ));
    api.getExact('/api/messaging/client-conversations', {
      conversations: [{ conversationId: CONVERSATION_A, lawFirmId: FIRM_A }],
    });

    const { result } = renderHook(() => useConversationMessages(`${FIRM_A}_client-a`, FIRM_A, true));
    await waitFor(() => expect(result.current.messages.map((row) => row.messageId)).toEqual(['firm-1', 'mine']));
    await waitFor(() => expect(channelOn).toHaveBeenCalledTimes(2));

    // The ping arrives on the conversation's broadcast topic, the one the
    // backend posts to for every thread kind.
    expect(channelFactory).toHaveBeenCalledWith(`groupmsg:${CONVERSATION_A}`);
    const ping = channelOn.mock.calls.find((call) => call[0] === 'broadcast');
    expect(ping?.[1]).toEqual({ event: 'new' });

    __resetDuplicateRequestGuard();
    await act(async () => {
      ping?.[2]({ payload: { conversationId: CONVERSATION_A } });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    await waitFor(() => expect(result.current.messages[0].content).toBe('Corrected wording'));
    expect(result.current.messages[1].readByFirm).toBe(true);
  });
});

describe('useConversationMessages in a background tab', () => {
  const HISTORY = `/api/lawfirms/${FIRM_A}/messaging/conversations/${CONVERSATION_A}`;

  async function mountThread() {
    api.getExact(`${HISTORY}?limit=30`, {
      messages: [message('firm-message')],
      conversation: { conversationId: CONVERSATION_A },
      hasMore: false,
    });
    const hook = renderHook(() => useConversationMessages(CONVERSATION_A, FIRM_A));
    await waitFor(() => expect(hook.result.current.messages).toHaveLength(1));
    await waitFor(() => expect(realtimeCallback).toBeDefined());
    expect(api.callsTo(HISTORY)).toHaveLength(1);
    return hook;
  }

  /** A DELETE cannot be applied from the payload, so it takes the REST refetch path. */
  async function deliverDelete() {
    await act(async () => {
      realtimeCallback?.({ eventType: 'DELETE', new: {} });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  }

  it('makes no history request for changes while hidden, then exactly one on becoming visible', async () => {
    const { unmount } = await mountThread();

    act(() => setPageVisibility('hidden'));
    await deliverDelete();
    await deliverDelete();
    expect(api.callsTo(HISTORY)).toHaveLength(1);

    act(() => setPageVisibility('visible'));
    await waitFor(() => expect(api.callsTo(HISTORY)).toHaveLength(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(api.callsTo(HISTORY)).toHaveLength(2);
    unmount();
  });

  it('still refetches, debounced, for a change while visible', async () => {
    const { unmount } = await mountThread();

    await deliverDelete();

    expect(api.callsTo(HISTORY)).toHaveLength(2);
    unmount();
  });

  it('reopens its channel and refetches once when the realtime token lapsed while hidden', async () => {
    const { unmount } = await mountThread();
    expect(channelFactory).toHaveBeenCalledTimes(1);

    await act(async () => {
      resumeListeners.forEach((listener) => listener());
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(channelFactory).toHaveBeenCalledTimes(2);
    expect(removeChannel).toHaveBeenCalledTimes(1);
    expect(api.callsTo(HISTORY)).toHaveLength(2);

    unmount();
    expect(resumeListeners.size).toBe(0);
  });
});
