/**
 * Contracts for the notification bell's Supabase Realtime channel.
 *
 * `useNotificationsRealtime` deliberately shares ONE channel across every
 * mount for the current uid (NotificationBell renders in several responsive
 * layout slots at once) and debounces a burst of row changes into one
 * invalidation per touched firm. Neither the multi-firm isolation, the burst
 * collapsing, nor the uid-switch teardown had a test anywhere before this
 * file - a regression in any of them would either spam the wrong firm's
 * badge, hammer the API once per row in a bulk action, or leak a signed-out
 * user's channel into the next signed-in user's session.
 */
jest.mock('@/hooks/useAuth', () => ({ useAuth: jest.fn() }));

jest.mock('@/lib/supabase/realtimeClient', () => ({
  authorizeRealtime: jest.fn(),
  getRealtimeClient: jest.fn(),
  retainRealtime: jest.fn(),
  releaseRealtime: jest.fn(),
  onRealtimeResume: jest.fn(),
}));

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';

import { useAuth } from '@/hooks/useAuth';
import { useNotificationsRealtime } from '@/hooks/notificationHooks/useNotificationsRealtime';
import { COUNT_QUERY_KEY, FEED_QUERY_KEY } from '@/hooks/notificationHooks/useNotifications';
import {
  authorizeRealtime,
  getRealtimeClient,
  retainRealtime,
  releaseRealtime,
  onRealtimeResume,
} from '@/lib/supabase/realtimeClient';
import { makeTestQueryClient } from '../support/renderWithProviders';
import { resetPageVisibility, setPageVisibility } from '../support/pageVisibility';

const useAuthMock = useAuth as jest.Mock;
const authorizeRealtimeMock = authorizeRealtime as jest.Mock;
const getRealtimeClientMock = getRealtimeClient as jest.Mock;
const retainRealtimeMock = retainRealtime as jest.Mock;
const releaseRealtimeMock = releaseRealtime as jest.Mock;
const onRealtimeResumeMock = onRealtimeResume as jest.Mock;
let resumeListeners: Set<() => void>;

interface FakeChannel {
  name: string;
  on: jest.Mock;
  subscribe: jest.Mock;
  callback?: (payload: unknown) => void;
  filter?: string;
}

let channels: FakeChannel[];
let channelFactory: jest.Mock;
let removeChannel: jest.Mock;
let queryClient: QueryClient;

function makeChannel(name: string): FakeChannel {
  const channel: FakeChannel = {
    name,
    on: jest.fn(),
    subscribe: jest.fn(),
  };
  channel.on.mockImplementation((_event: string, filterConfig: { filter?: string }, cb: (payload: unknown) => void) => {
    channel.callback = cb;
    channel.filter = filterConfig?.filter;
    return channel;
  });
  channel.subscribe.mockImplementation(() => channel);
  return channel;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  channels = [];
  removeChannel = jest.fn();
  channelFactory = jest.fn((name: string) => {
    const channel = makeChannel(name);
    channels.push(channel);
    return channel;
  });
  authorizeRealtimeMock.mockResolvedValue({ channel: channelFactory });
  getRealtimeClientMock.mockReturnValue({ removeChannel });
  useAuthMock.mockReturnValue({ user: { uid: 'user-a' }, loading: false });
  queryClient = makeTestQueryClient();
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

function invalidationsOf(spy: jest.SpyInstance, key: string, firm: string) {
  return spy.mock.calls.filter((call) => {
    const queryKey = (call[0] as { queryKey?: unknown[] })?.queryKey;
    return queryKey?.[0] === key && queryKey?.[1] === firm;
  });
}

async function settleDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
}

describe('useNotificationsRealtime offline contract', () => {
  it('opens no channel and retains nothing before both an identity and a firm scope exist', async () => {
    useAuthMock.mockReturnValue({ user: null, loading: false });
    const { unmount } = renderHook(() => useNotificationsRealtime('firm-a'), { wrapper });

    await act(async () => { await Promise.resolve(); });
    expect(authorizeRealtimeMock).not.toHaveBeenCalled();
    expect(retainRealtimeMock).not.toHaveBeenCalled();

    unmount();
    expect(releaseRealtimeMock).not.toHaveBeenCalled();
  });

  it('opens a channel scoped to the current uid and invalidates this firm\'s badge and feed caches on a row change', async () => {
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const { unmount } = renderHook(() => useNotificationsRealtime('firm-a'), { wrapper });

    await waitFor(() => expect(channels).toHaveLength(1));
    expect(channels[0].name).toBe('notifications:user-a');
    expect(channels[0].filter).toBe('user_id=eq.user-a');
    expect(retainRealtimeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      channels[0].callback?.({
        eventType: 'UPDATE',
        new: { id: 'n1', law_firm_id: 'firm-a' },
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: [COUNT_QUERY_KEY, 'firm-a'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: [FEED_QUERY_KEY, 'firm-a'] });

    unmount();
  });

  it('collapses a rapid burst of changes into one invalidation per key instead of one per row', async () => {
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const { unmount } = renderHook(() => useNotificationsRealtime('firm-a'), { wrapper });
    await waitFor(() => expect(channels).toHaveLength(1));

    await act(async () => {
      // Five rapid, out-of-order-looking events (insert, update, delete...) in
      // one burst, the shape a bulk mark-all-read or a batch send produces.
      for (let i = 0; i < 5; i += 1) {
        channels[0].callback?.({ eventType: 'INSERT', new: { id: `n${i}`, law_firm_id: 'firm-a' } });
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    const countInvalidations = invalidateSpy.mock.calls.filter(
      (call) => (call[0] as { queryKey: unknown[] })?.queryKey?.[0] === COUNT_QUERY_KEY,
    );
    const feedInvalidations = invalidateSpy.mock.calls.filter(
      (call) => (call[0] as { queryKey: unknown[] })?.queryKey?.[0] === FEED_QUERY_KEY,
    );
    expect(countInvalidations).toHaveLength(1);
    expect(feedInvalidations).toHaveLength(1);

    unmount();
  });

  it('does not invalidate or fire onNew for a firm this listener does not own', async () => {
    const onChange = jest.fn();
    const onNew = jest.fn();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const { unmount } = renderHook(
      () => useNotificationsRealtime('firm-a', { onChange, onNew }),
      { wrapper },
    );
    await waitFor(() => expect(channels).toHaveLength(1));

    // The subscription itself spans every firm the user belongs to (Realtime
    // takes one uid filter); a row for a DIFFERENT firm must not reach this
    // firm-a-scoped listener.
    await act(async () => {
      channels[0].callback?.({
        eventType: 'INSERT',
        new: { id: 'foreign', law_firm_id: 'firm-b' },
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(onNew).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: [COUNT_QUERY_KEY, 'firm-a'] });

    // Positive control: a firm-a row on the exact same channel does fire.
    await act(async () => {
      channels[0].callback?.({
        eventType: 'INSERT',
        new: { id: 'own', law_firm_id: 'firm-a' },
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: [COUNT_QUERY_KEY, 'firm-a'] });

    unmount();
  });

  it('removes the shared channel and releases the realtime client on the last unmount', async () => {
    const { unmount } = renderHook(() => useNotificationsRealtime('firm-a'), { wrapper });
    await waitFor(() => expect(channels).toHaveLength(1));

    unmount();

    expect(removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(releaseRealtimeMock).toHaveBeenCalledTimes(1);
  });

  it('tears down the previous user\'s channel and opens a fresh one on a mid-session user switch', async () => {
    const { rerender, unmount } = renderHook(() => useNotificationsRealtime('firm-a'), { wrapper });
    await waitFor(() => expect(channels).toHaveLength(1));
    const oldChannel = channels[0];
    expect(oldChannel.filter).toBe('user_id=eq.user-a');

    // A different user signs in without a full page reload (e.g. an account
    // switch). The stale channel must not keep delivering user A's rows.
    useAuthMock.mockReturnValue({ user: { uid: 'user-b' }, loading: false });
    rerender();

    await waitFor(() => expect(channels).toHaveLength(2));
    expect(removeChannel).toHaveBeenCalledWith(oldChannel);
    expect(channels[1].name).toBe('notifications:user-b');
    expect(channels[1].filter).toBe('user_id=eq.user-b');

    unmount();
    expect(removeChannel).toHaveBeenCalledWith(channels[1]);
    expect(removeChannel).toHaveBeenCalledTimes(2);
  });
});

describe('useNotificationsRealtime request volume', () => {
  it('invalidates each firm cache once per burst however many mounts share the channel', async () => {
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const onChange = jest.fn();
    // The sidebar mounts a bell per responsive slot and the toaster mounts one
    // more, all in the same firm and the same QueryClient.
    const bellA = renderHook(() => useNotificationsRealtime('firm-a'), { wrapper });
    const bellB = renderHook(() => useNotificationsRealtime('firm-a'), { wrapper });
    const view = renderHook(() => useNotificationsRealtime('firm-a', { onChange }), { wrapper });
    await waitFor(() => expect(channels).toHaveLength(1));

    channels[0].callback?.({ eventType: 'UPDATE', new: { id: 'n1', law_firm_id: 'firm-a' } });
    await settleDebounce();

    expect(invalidationsOf(invalidateSpy, COUNT_QUERY_KEY, 'firm-a')).toHaveLength(1);
    expect(invalidationsOf(invalidateSpy, FEED_QUERY_KEY, 'firm-a')).toHaveLength(1);
    // A caller holding its own list state is still told, once.
    expect(onChange).toHaveBeenCalledTimes(1);

    bellA.unmount();
    bellB.unmount();
    view.unmount();
  });

  it('holds changes back while the tab is hidden and applies them once when it is visible again', async () => {
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const onChange = jest.fn();
    const { unmount } = renderHook(() => useNotificationsRealtime('firm-a', { onChange }), { wrapper });
    await waitFor(() => expect(channels).toHaveLength(1));

    setPageVisibility('hidden');
    channels[0].callback?.({ eventType: 'INSERT', new: { id: 'n1', law_firm_id: 'firm-a' } });
    await settleDebounce();
    channels[0].callback?.({ eventType: 'UPDATE', new: { id: 'n1', law_firm_id: 'firm-a' } });
    await settleDebounce();

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    act(() => setPageVisibility('visible'));

    expect(invalidationsOf(invalidateSpy, COUNT_QUERY_KEY, 'firm-a')).toHaveLength(1);
    expect(invalidationsOf(invalidateSpy, FEED_QUERY_KEY, 'firm-a')).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('does nothing on becoming visible when nothing changed while hidden', async () => {
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const { unmount } = renderHook(() => useNotificationsRealtime('firm-a'), { wrapper });
    await waitFor(() => expect(channels).toHaveLength(1));

    act(() => setPageVisibility('hidden'));
    act(() => setPageVisibility('visible'));

    expect(invalidateSpy).not.toHaveBeenCalled();
    unmount();
  });

  it('reopens the channel and refetches the badge and feed once when the token lapsed while hidden', async () => {
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const onChange = jest.fn();
    const bell = renderHook(() => useNotificationsRealtime('firm-a'), { wrapper });
    const view = renderHook(() => useNotificationsRealtime('firm-a', { onChange }), { wrapper });
    await waitFor(() => expect(channels).toHaveLength(1));
    const dropped = channels[0];

    await act(async () => {
      resumeListeners.forEach((listener) => listener());
    });
    await waitFor(() => expect(channels).toHaveLength(2));
    await settleDebounce();

    expect(removeChannel).toHaveBeenCalledWith(dropped);
    expect(channels[1].filter).toBe('user_id=eq.user-a');
    expect(invalidationsOf(invalidateSpy, COUNT_QUERY_KEY, 'firm-a')).toHaveLength(1);
    expect(invalidationsOf(invalidateSpy, FEED_QUERY_KEY, 'firm-a')).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    bell.unmount();
    view.unmount();
    // Every mount shares one resume registration, and it goes with the channel.
    expect(resumeListeners.size).toBe(0);
  });
});
