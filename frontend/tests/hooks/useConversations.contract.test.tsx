/**
 * Offline contracts for the firm inbox / client-portal conversation list.
 *
 * `useConversations` backs both `/lawfirm/[lawFirmId]/messages` and
 * `/client/messages` (the top-level list pages, not the per-thread history
 * covered by `useConversationMessages.contract.test.tsx`). Before this file,
 * its only coverage was `useConversations.test.ts`: one shape assertion
 * against the legacy jest-mocked-firebase pattern, with no real transport, no
 * failure/recovery path, no parameter check, and no realtime coverage at all.
 * A prior ledger tick claimed a `useConversations.contract.test.tsx` already
 * existed and had been re-run for regressions; no such file was ever
 * committed, so that claim did not hold.
 */
jest.unmock('@/services/messages.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/lib/supabase/realtimeClient', () => ({
  authorizeRealtime: jest.fn(),
  getRealtimeClient: jest.fn(),
  retainRealtime: jest.fn(),
  releaseRealtime: jest.fn(),
  onRealtimeResume: jest.fn(),
}));

import { act, renderHook, waitFor } from '@testing-library/react';

import { useConversations } from '@/hooks/useConversations';
import {
  authorizeRealtime,
  getRealtimeClient,
  retainRealtime,
  releaseRealtime,
  onRealtimeResume,
} from '@/lib/supabase/realtimeClient';
import { resetPageVisibility, setPageVisibility } from '../support/pageVisibility';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock } from '../support/apiMock';
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

const api = setupApiMock();
let postgresChangesCallback: ((payload: unknown) => void) | undefined;
let removeChannel: jest.Mock;
let channelOn: jest.Mock;

interface FakeRealtimeChannel {
  on: jest.Mock;
  subscribe: jest.Mock;
}

beforeEach(() => {
  __resetDuplicateRequestGuard();
  postgresChangesCallback = undefined;
  removeChannel = jest.fn();

  const channel = {} as FakeRealtimeChannel;
  channel.on = jest.fn((_event: string, _config: unknown, callback: (payload: unknown) => void) => {
    postgresChangesCallback = callback;
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

describe('useConversations offline contract', () => {
  it('does not request a list or retain a realtime subscriber without a firm scope or portal identity', async () => {
    const { result } = renderHook(() => useConversations({}));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conversations).toEqual([]);
    expect(result.current.totalItems).toBe(0);
    expect(result.current.error).toBeNull();
    expect(api.calls()).toEqual([]);
    expect(retainRealtimeMock).not.toHaveBeenCalled();
  });

  it('requests the exact firm inbox page with pagination and filters', async () => {
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/inbox?limit=20&page=2&search=foo&archived=false`, {
      conversations: [{ conversationId: 'conversation-a' }],
      totalItems: 1,
    });

    const { result } = renderHook(() =>
      useConversations({ lawFirmId: FIRM_A, limit: 20, page: 2, search: 'foo', archived: false }));

    await waitFor(() => expect(result.current.conversations.map((row) => row.conversationId))
      .toEqual(['conversation-a']));

    expect(api.calls()).toEqual([expect.objectContaining({
      method: 'GET',
      pathname: `/api/lawfirms/${FIRM_A}/messaging/inbox`,
      query: { limit: ['20'], page: ['2'], search: ['foo'], archived: ['false'] },
    })]);
    expect(result.current.totalItems).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it('treats an empty inbox page as a loaded state, not an error', async () => {
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/inbox`, { conversations: [], totalItems: 0 });

    const { result } = renderHook(() => useConversations({ lawFirmId: FIRM_A }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conversations).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a refused list load instead of rendering it as an empty inbox', async () => {
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/inbox`, {
      status: 403,
      body: { error: 'Messaging access denied' },
    });

    const { result } = renderHook(() => useConversations({ lawFirmId: FIRM_A }));

    await waitFor(() => expect(result.current.error).toBe('Messaging access denied'));
    expect(result.current.conversations).toEqual([]);
    expect(String(result.current.error)).toMatch(/Messaging access denied/i);
  });

  it('clears a previous load failure once a manual refresh succeeds', async () => {
    let call = 0;
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/inbox`, () => {
      call += 1;
      if (call === 1) return { status: 403, body: { error: 'Messaging access denied' } };
      return { conversations: [{ conversationId: 'conversation-a' }], totalItems: 1 };
    });

    const { result } = renderHook(() => useConversations({ lawFirmId: FIRM_A }));
    await waitFor(() => expect(result.current.error).toBe('Messaging access denied'));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.conversations.map((row) => row.conversationId)).toEqual(['conversation-a']);
  });

  it('loads the client portal conversation list from the shared client route', async () => {
    api.getExact('/api/messaging/client-conversations', {
      conversations: [{ conversationId: 'conversation-portal' }],
    });

    const { result } = renderHook(() => useConversations({ isClient: true }));

    await waitFor(() => expect(result.current.conversations.map((row) => row.conversationId))
      .toEqual(['conversation-portal']));
    expect(api.calls()).toEqual([expect.objectContaining({ pathname: '/api/messaging/client-conversations' })]);
  });

  it('does not let a delayed firm A inbox page overwrite a switched firm B list', async () => {
    const heldFirmA = holdResponse();
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/inbox`, heldFirmA.handler);
    api.getExact(`/api/lawfirms/${FIRM_B}/messaging/inbox`, {
      conversations: [{ conversationId: 'conversation-b' }],
      totalItems: 1,
    });

    const { result, rerender } = renderHook(
      ({ lawFirmId }: { lawFirmId: string }) => useConversations({ lawFirmId }),
      { initialProps: { lawFirmId: FIRM_A } },
    );
    await waitFor(() => expect(api.callsTo(`/lawfirms/${FIRM_A}/messaging/inbox`)).toHaveLength(1));

    rerender({ lawFirmId: FIRM_B });
    await waitFor(() => expect(result.current.conversations.map((row) => row.conversationId))
      .toEqual(['conversation-b']));

    await act(async () => {
      heldFirmA.release({ conversations: [{ conversationId: 'conversation-a' }], totalItems: 1 });
    });

    expect(result.current.conversations.map((row) => row.conversationId)).toEqual(['conversation-b']);
    expect(result.current.error).toBeNull();
  });

  it('does not surface a firm A load failure that arrives after switching to firm B', async () => {
    const heldFirmA = holdResponse();
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/inbox`, heldFirmA.handler);
    api.getExact(`/api/lawfirms/${FIRM_B}/messaging/inbox`, {
      conversations: [{ conversationId: 'conversation-b' }],
      totalItems: 1,
    });

    const { result, rerender } = renderHook(
      ({ lawFirmId }: { lawFirmId: string }) => useConversations({ lawFirmId }),
      { initialProps: { lawFirmId: FIRM_A } },
    );
    await heldFirmA.untilRequested();

    rerender({ lawFirmId: FIRM_B });
    await waitFor(() => expect(result.current.conversations.map((row) => row.conversationId))
      .toEqual(['conversation-b']));

    await act(async () => {
      heldFirmA.release({ status: 403, body: { error: 'Firm A messaging access denied' } });
    });

    // Firm A's refusal is about a list no longer on screen.
    expect(result.current.error).toBeNull();
    expect(result.current.conversations.map((row) => row.conversationId)).toEqual(['conversation-b']);
  });

  it("clears one conversation's unread badge on a messages-marked-read event without a refetch", async () => {
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/inbox`, {
      conversations: [{
        conversationId: 'conversation-a',
        conversationType: 'direct',
        unreadCountFirm: 3,
        unreadCountClient: 0,
      }],
      totalItems: 1,
    });

    const { result } = renderHook(() => useConversations({ lawFirmId: FIRM_A }));
    await waitFor(() => expect(result.current.conversations[0]?.unreadCountFirm).toBe(3));

    const broadcastSpy = jest.fn();
    window.addEventListener('unread-count-updated', broadcastSpy);
    try {
      act(() => {
        window.dispatchEvent(new CustomEvent('messages-marked-read', {
          detail: { conversationId: 'conversation-a' },
        }));
      });

      expect(result.current.conversations[0]?.unreadCountFirm).toBe(0);
      expect(broadcastSpy).toHaveBeenCalled();
    } finally {
      window.removeEventListener('unread-count-updated', broadcastSpy);
    }

    // No second GET: the badge cleared from the local event alone.
    expect(api.calls('GET')).toHaveLength(1);
  });

  it('reorders a realtime-patched conversation immediately, then refetches for its preview', async () => {
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/inbox?page=1`, {
      conversations: [
        {
          conversationId: 'conversation-a', conversationType: 'direct',
          lastMessageAt: '2026-09-01T10:00:00.000Z', lastMessagePreview: 'Older',
        },
        {
          conversationId: 'conversation-b', conversationType: 'direct',
          lastMessageAt: '2026-09-01T09:00:00.000Z', lastMessagePreview: 'Stale preview',
        },
      ],
      totalItems: 2,
    });

    const { result } = renderHook(() => useConversations({ lawFirmId: FIRM_A, page: 1 }));
    await waitFor(() => expect(result.current.conversations.map((row) => row.conversationId))
      .toEqual(['conversation-a', 'conversation-b']));
    await waitFor(() => expect(channelOn).toHaveBeenCalled());

    // What the refetch will answer with: the preview the server derived from the
    // message that triggered this event.
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/inbox?page=1`, {
      conversations: [
        {
          conversationId: 'conversation-b', conversationType: 'direct',
          lastMessageAt: '2026-09-01T12:00:00.000Z', lastMessagePreview: 'The newest thing said',
        },
        {
          conversationId: 'conversation-a', conversationType: 'direct',
          lastMessageAt: '2026-09-01T10:00:00.000Z', lastMessagePreview: 'Older',
        },
      ],
      totalItems: 2,
    });

    await act(async () => {
      postgresChangesCallback?.({
        eventType: 'UPDATE',
        new: { id: 'conversation-b', last_message_at: '2026-09-01T12:00:00.000Z' },
      });
    });

    // The reorder is instant: the payload carries `last_message_at`, so the row
    // moves before any request goes out.
    await waitFor(() => expect(result.current.conversations.map((row) => row.conversationId))
      .toEqual(['conversation-b', 'conversation-a']));

    // The preview is not on the payload. `conversations.last_message_preview`
    // was dropped and the server derives it from the newest message, so a patch
    // alone would leave the list quoting the previous message forever.
    await waitFor(() => expect(result.current.conversations[0].lastMessagePreview)
      .toBe('The newest thing said'));
    expect(api.calls('GET').length).toBeGreaterThan(1);
  });

  it('cleans up its realtime channel and releases the retainer on unmount', async () => {
    api.getExact(`/api/lawfirms/${FIRM_A}/messaging/inbox`, { conversations: [], totalItems: 0 });

    const { unmount } = renderHook(() => useConversations({ lawFirmId: FIRM_A }));
    await waitFor(() => expect(retainRealtimeMock).toHaveBeenCalledTimes(1));

    unmount();

    expect(removeChannel).toHaveBeenCalledTimes(1);
    expect(releaseRealtimeMock).toHaveBeenCalledTimes(1);
  });
});

describe('useConversations in a background tab', () => {
  const INBOX = `/api/lawfirms/${FIRM_A}/messaging/inbox`;

  async function mountInbox() {
    api.getExact(INBOX, { conversations: [], totalItems: 0 });
    const hook = renderHook(() => useConversations({ lawFirmId: FIRM_A }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await waitFor(() => expect(channelOn).toHaveBeenCalled());
    expect(api.callsTo(INBOX)).toHaveLength(1);
    return hook;
  }

  /** A DELETE cannot be patched in place, so it always takes the REST refetch path. */
  async function deliverChange() {
    await act(async () => {
      postgresChangesCallback?.({ eventType: 'DELETE', new: {} });
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
  }

  it('makes no inbox request for changes that arrive while hidden, then exactly one on becoming visible', async () => {
    const { unmount } = await mountInbox();

    act(() => setPageVisibility('hidden'));
    await deliverChange();
    await deliverChange();
    expect(api.callsTo(INBOX)).toHaveLength(1);

    act(() => setPageVisibility('visible'));
    await waitFor(() => expect(api.callsTo(INBOX)).toHaveLength(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(api.callsTo(INBOX)).toHaveLength(2);
    unmount();
  });

  it('still refetches, debounced, for a change while visible', async () => {
    const { unmount } = await mountInbox();

    await act(async () => {
      postgresChangesCallback?.({ eventType: 'DELETE', new: {} });
      postgresChangesCallback?.({ eventType: 'DELETE', new: {} });
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(api.callsTo(INBOX)).toHaveLength(2);
    unmount();
  });

  it('reopens its channel and refetches once when the realtime token lapsed while hidden', async () => {
    const { unmount } = await mountInbox();
    expect(channelFactory).toHaveBeenCalledTimes(1);

    await act(async () => {
      resumeListeners.forEach((listener) => listener());
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(channelFactory).toHaveBeenCalledTimes(2);
    expect(removeChannel).toHaveBeenCalledTimes(1);
    expect(api.callsTo(INBOX)).toHaveLength(2);

    unmount();
    expect(resumeListeners.size).toBe(0);
  });
});
