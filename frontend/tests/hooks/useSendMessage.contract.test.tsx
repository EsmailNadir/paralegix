/**
 * Offline send-queue contracts.
 *
 * The composer shows each optimistic row immediately, but network writes must
 * still reach the server in composition order. If a failed write poisons that
 * queue, every later message becomes a permanent local-only bubble.
 */
jest.unmock('@/services/messages.service');

jest.mock('@/hooks/useAuth', () => ({ useAuth: jest.fn() }));

import { act, renderHook, waitFor } from '@testing-library/react';

import { useSendMessage } from '@/hooks/useSendMessage';
import { useAuth } from '@/hooks/useAuth';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock } from '../support/apiMock';

const useAuthMock = useAuth as jest.Mock;
const FIRM_ID = 'firm-a';
const CLIENT_ID = 'client-a';
const api = setupApiMock();

function options(content: string, callbacks: {
  onSuccess?: jest.Mock;
  onError?: jest.Mock;
} = {}) {
  return {
    lawFirmId: FIRM_ID,
    clientId: CLIENT_ID,
    content,
    ...callbacks,
  };
}

beforeEach(() => {
  __resetDuplicateRequestGuard();
  useAuthMock.mockReturnValue({
    user: { uid: 'member-a', displayName: 'Avery Attorney' },
    loading: false,
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('useSendMessage offline contract', () => {
  it('rejects an unauthenticated composer before creating an optimistic row or request', async () => {
    useAuthMock.mockReturnValue({ user: null, loading: false });
    const onSuccess = jest.fn();
    const { result } = renderHook(() => useSendMessage());

    await expect(result.current.sendMessage(options('Hello', { onSuccess })))
      .rejects.toThrow(/not authenticated/i);

    expect(onSuccess).not.toHaveBeenCalled();
    expect(api.calls()).toEqual([]);
  });

  it('rejects whitespace-only content before creating an optimistic row or request', async () => {
    const onSuccess = jest.fn();
    const { result } = renderHook(() => useSendMessage());

    await expect(result.current.sendMessage(options('   ', { onSuccess })))
      .rejects.toThrow('Message cannot be empty');

    expect(onSuccess).not.toHaveBeenCalled();
    expect(api.calls()).toEqual([]);
  });

  it('shows an optimistic firm message before its real scoped send completes', async () => {
    let release: ((value: unknown) => void) | undefined;
    api.postExact(`/api/lawfirms/${FIRM_ID}/messaging/send`, () => new Promise((resolve) => {
      release = resolve;
    }));
    const onSuccess = jest.fn();
    const { result } = renderHook(() => useSendMessage());

    let send: Promise<unknown> | undefined;
    await act(async () => {
      send = result.current.sendMessage(options('Draft motion attached', { onSuccess }));
    });

    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({
      messageId: expect.stringMatching(/^temp-/),
      senderId: 'member-a',
      senderType: 'firm_member',
      status: 'sending',
      content: 'Draft motion attached',
    }));
    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(api.calls('POST')[0].body).toEqual(expect.objectContaining({
      lawFirmId: FIRM_ID,
      clientId: CLIENT_ID,
      content: 'Draft motion attached',
    }));

    await act(async () => {
      release?.({ messageId: 'message-1', conversationId: 'conversation-a' });
      await send;
    });
  });

  it('delivers rapidly composed messages to the server in composition order', async () => {
    const releases: Array<(value: unknown) => void> = [];
    api.postExact(`/api/lawfirms/${FIRM_ID}/messaging/send`, () => new Promise((resolve) => {
      releases.push(resolve);
    }));
    const optimistic: string[] = [];
    const onSuccess = jest.fn((row) => optimistic.push(row.content));
    const { result } = renderHook(() => useSendMessage());

    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    await act(async () => {
      first = result.current.sendMessage(options('First', { onSuccess }));
      second = result.current.sendMessage(options('Second', { onSuccess }));
    });

    // Both bubbles appear immediately, even though only the first write can be
    // in flight. This distinction is why the queue lives below the optimistic
    // callback rather than around the whole send function.
    expect(optimistic).toEqual(['First', 'Second']);
    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect((api.calls('POST')[0].body as { content: string }).content).toBe('First');

    await act(async () => {
      releases[0]({ messageId: 'message-1', conversationId: 'conversation-a' });
      await first;
    });
    await waitFor(() => expect(api.calls('POST')).toHaveLength(2));
    expect((api.calls('POST')[1].body as { content: string }).content).toBe('Second');

    await act(async () => {
      releases[1]({ messageId: 'message-2', conversationId: 'conversation-a' });
      await second;
    });
  });

  it('reports a refusal and still lets the next queued message reach the server', async () => {
    api.postExact(`/api/lawfirms/${FIRM_ID}/messaging/send`, (call) => {
      const content = (call.body as { content: string }).content;
      return content === 'Blocked'
        ? { status: 403, body: { error: 'Messaging access denied' } }
        : { messageId: 'message-ok', conversationId: 'conversation-a' };
    });
    const onError = jest.fn();
    const { result } = renderHook(() => useSendMessage());

    let blocked: Promise<unknown> | undefined;
    let next: Promise<unknown> | undefined;
    await act(async () => {
      blocked = result.current.sendMessage(options('Blocked', { onError }));
      // The service can refuse on the first microtask. Attach a no-op observer
      // immediately, then assert the same rejection below after the queued
      // second send has had a chance to start.
      void blocked.catch(() => undefined);
      next = result.current.sendMessage(options('Still sends'));
    });

    await expect(blocked).rejects.toThrow(/Messaging access denied/i);
    await expect(next).resolves.toEqual({ messageId: 'message-ok', conversationId: 'conversation-a' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Messaging access denied' }));
    expect(api.calls('POST').map((call) => (call.body as { content: string }).content))
      .toEqual(['Blocked', 'Still sends']);
  });
});
