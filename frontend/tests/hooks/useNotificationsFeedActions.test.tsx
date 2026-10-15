/**
 * The notification bell's feed, badge count and the four actions a person
 * takes on a notification (mark read, mark unread, delete, mark all read).
 *
 * The actions update the React Query caches optimistically and roll back when
 * the server refuses, so the bell and its dropdown never disagree with each
 * other or with the server. The real notifications service runs here against
 * a fake transport, so the exact url and method each action sends are pinned.
 */
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';

import {
  useNotificationActions,
  useNotifications,
  useUnreadCount,
} from '@/hooks/notificationHooks/useNotifications';
import type { Notification } from '@/services/notifications.service';
import { installApiMock, sequence, type ApiMock } from '../support/apiMock';
import { makeTestQueryClient } from '../support/renderWithProviders';

const FIRM = 'firm-1';
const BASE = `/api/lawfirms/${FIRM}/notifications`;

let api: ApiMock;
let queryClient: QueryClient;

function note(id: string, read: boolean): Notification {
  return {
    id,
    type: 'task_assigned',
    title: `Title ${id}`,
    body: `Body ${id}`,
    read,
    entityType: 'task',
    entityId: `task-${id}`,
    matterId: null,
    lawFirmId: FIRM,
    actionUrl: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    createdBy: null,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** The bell as mounted: feed, badge and actions for one firm. */
function useBell(lawFirmId?: string) {
  return {
    feed: useNotifications(lawFirmId),
    badge: useUnreadCount(lawFirmId),
    actions: useNotificationActions(lawFirmId),
  };
}

/** A response the spec releases by hand, to observe the optimistic state. */
function held() {
  let release!: (value: unknown) => void;
  const promise = new Promise((resolve) => { release = resolve; });
  return { handler: () => promise, release };
}

async function mountBell(
  feed: Notification[],
  unreadCount: number,
  countAfter: number = unreadCount,
) {
  api.getExact(`${BASE}/feed?limit=50`, { notifications: feed, total: feed.length, unreadCount });
  api.getExact(`${BASE}/count`, sequence({ unreadCount }, { unreadCount: countAfter }));
  const view = renderHook(() => useBell(FIRM), { wrapper });
  await waitFor(() => expect(view.result.current.feed.loading).toBe(false));
  await waitFor(() => expect(view.result.current.badge.unreadCount).toBe(unreadCount));
  return view;
}

const readFlags = (list: Notification[]) => list.map((n) => `${n.id}:${n.read}`);

beforeEach(() => {
  api = installApiMock();
  queryClient = makeTestQueryClient();
});

afterEach(() => {
  api.restore();
});

describe('reading the feed and the badge', () => {
  it('loads the fifty most recent notifications and the unread count for the firm', async () => {
    const view = await mountBell([note('a', false), note('b', true)], 1);

    expect(view.result.current.feed.notifications.map((n) => n.id)).toEqual(['a', 'b']);
    expect(view.result.current.feed.total).toBe(2);
    expect(view.result.current.feed.error).toBeNull();
    expect(view.result.current.badge.unreadCount).toBe(1);
    expect(api.calls('GET').map((c) => `${c.pathname}${c.search}`).sort()).toEqual([
      `${BASE}/count`,
      `${BASE}/feed?limit=50`,
    ]);
  });

  it('asks for nothing and reports an empty feed while no firm is selected', async () => {
    const view = renderHook(() => useBell(undefined), { wrapper });

    await act(async () => { await Promise.resolve(); });

    expect(view.result.current.feed.notifications).toEqual([]);
    expect(view.result.current.feed.total).toBe(0);
    expect(view.result.current.badge.unreadCount).toBe(0);
    expect(api.calls()).toHaveLength(0);
  });

  it('surfaces the server message when the feed cannot be loaded', async () => {
    api.getExact(`${BASE}/feed?limit=50`, { status: 500, body: { error: 'Feed is down' } });

    const { result } = renderHook(() => useNotifications(FIRM), { wrapper });

    await waitFor(() => expect(result.current.error).toBe('Feed is down'));
    expect(result.current.notifications).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});

describe('marking one notification read', () => {
  it('flips it read and drops the badge before the server answers, then reconciles the badge', async () => {
    const view = await mountBell([note('a', false), note('b', false)], 2, 7);
    const response = held();
    api.postExact(`${BASE}/a/read`, response.handler);

    let done!: Promise<void>;
    act(() => { done = view.result.current.actions.markRead('a'); });

    await waitFor(() => expect(readFlags(view.result.current.feed.notifications)).toEqual(['a:true', 'b:false']));
    expect(view.result.current.badge.unreadCount).toBe(1);
    expect(queryClient.getQueryData<{ unreadCount: number }>(['notificationsFeed', FIRM])?.unreadCount).toBe(1);

    await act(async () => {
      response.release({ message: 'ok' });
      await done;
    });

    // The count is refetched from the server after success, so a figure the
    // optimistic arithmetic got wrong is corrected.
    await waitFor(() => expect(view.result.current.badge.unreadCount).toBe(7));
    expect(api.callsTo('/count')).toHaveLength(2);
  });

  it('leaves the badge alone when the notification was already read', async () => {
    const view = await mountBell([note('a', true), note('b', false)], 1);
    const response = held();
    api.postExact(`${BASE}/a/read`, response.handler);

    let done!: Promise<void>;
    act(() => { done = view.result.current.actions.markRead('a'); });
    await waitFor(() => expect(api.callsTo('/a/read')).toHaveLength(1));

    expect(view.result.current.badge.unreadCount).toBe(1);
    expect(queryClient.getQueryData<{ unreadCount: number }>(['notificationsFeed', FIRM])?.unreadCount).toBe(1);

    await act(async () => {
      response.release({ message: 'ok' });
      await done;
    });
  });

  it('restores the feed and the badge and rethrows when the server refuses', async () => {
    const view = await mountBell([note('a', false)], 1);
    api.postExact(`${BASE}/a/read`, { status: 403, body: { error: 'Not yours' } });

    let caught: unknown;
    await act(async () => {
      try {
        await view.result.current.actions.markRead('a');
      } catch (err) {
        caught = err;
      }
    });

    expect((caught as Error).message).toBe('Not yours');
    expect(readFlags(view.result.current.feed.notifications)).toEqual(['a:false']);
    expect(view.result.current.badge.unreadCount).toBe(1);
    // No reconcile on failure: the rollback is the answer.
    expect(api.callsTo('/count')).toHaveLength(1);
  });

  it('still sends the request when the feed was never loaded', async () => {
    api.postExact(`${BASE}/a/read`, { message: 'ok' });
    const { result } = renderHook(() => useNotificationActions(FIRM), { wrapper });

    await act(async () => { await result.current.markRead('a'); });

    expect(api.calls('POST').map((c) => c.pathname)).toEqual([`${BASE}/a/read`]);
  });
});

describe('marking one notification unread', () => {
  it('flips it unread and raises the badge by one', async () => {
    const view = await mountBell([note('a', true), note('b', false)], 1);
    const response = held();
    api.postExact(`${BASE}/a/unread`, response.handler);

    let done!: Promise<void>;
    act(() => { done = view.result.current.actions.markUnread('a'); });

    await waitFor(() => expect(readFlags(view.result.current.feed.notifications)).toEqual(['a:false', 'b:false']));
    expect(view.result.current.badge.unreadCount).toBe(2);
    expect(queryClient.getQueryData<{ unreadCount: number }>(['notificationsFeed', FIRM])?.unreadCount).toBe(2);

    await act(async () => {
      response.release({ message: 'ok' });
      await done;
    });
  });

  it('does not raise the badge for a notification that is already unread', async () => {
    const view = await mountBell([note('a', false)], 1);
    const response = held();
    api.postExact(`${BASE}/a/unread`, response.handler);

    let done!: Promise<void>;
    act(() => { done = view.result.current.actions.markUnread('a'); });
    await waitFor(() => expect(api.callsTo('/a/unread')).toHaveLength(1));

    expect(view.result.current.badge.unreadCount).toBe(1);

    await act(async () => {
      response.release({ message: 'ok' });
      await done;
    });
  });

  it('rolls back and rethrows when the server refuses', async () => {
    const view = await mountBell([note('a', true)], 0);
    api.postExact(`${BASE}/a/unread`, { status: 500, body: { error: 'Boom' } });

    await act(async () => {
      await expect(view.result.current.actions.markUnread('a')).rejects.toThrow('Boom');
    });

    expect(readFlags(view.result.current.feed.notifications)).toEqual(['a:true']);
    expect(view.result.current.badge.unreadCount).toBe(0);
  });
});

describe('deleting a notification', () => {
  it('removes an unread one from the list and lowers the total and the badge', async () => {
    const view = await mountBell([note('a', false), note('b', false)], 2);
    const response = held();
    api.deleteExact(`${BASE}/a`, response.handler);

    let done!: Promise<void>;
    act(() => { done = view.result.current.actions.remove('a'); });

    await waitFor(() => expect(view.result.current.feed.notifications.map((n) => n.id)).toEqual(['b']));
    expect(view.result.current.feed.total).toBe(1);
    expect(view.result.current.badge.unreadCount).toBe(1);

    await act(async () => {
      response.release({ message: 'ok' });
      await done;
    });
  });

  it('removes a read one without touching the badge', async () => {
    const view = await mountBell([note('a', true), note('b', false)], 1);
    const response = held();
    api.deleteExact(`${BASE}/a`, response.handler);

    let done!: Promise<void>;
    act(() => { done = view.result.current.actions.remove('a'); });

    await waitFor(() => expect(view.result.current.feed.notifications.map((n) => n.id)).toEqual(['b']));
    expect(view.result.current.feed.total).toBe(1);
    expect(view.result.current.badge.unreadCount).toBe(1);

    await act(async () => {
      response.release({ message: 'ok' });
      await done;
    });
  });

  it('puts the notification back and rethrows when the delete is refused', async () => {
    const view = await mountBell([note('a', false), note('b', true)], 1);
    api.deleteExact(`${BASE}/a`, { status: 404, body: { error: 'Gone' } });

    await act(async () => {
      await expect(view.result.current.actions.remove('a')).rejects.toThrow('Gone');
    });

    expect(view.result.current.feed.notifications.map((n) => n.id)).toEqual(['a', 'b']);
    expect(view.result.current.feed.total).toBe(2);
    expect(view.result.current.badge.unreadCount).toBe(1);
  });
});

describe('marking everything read', () => {
  it('reads every notification and zeroes the badge before the server answers', async () => {
    const view = await mountBell([note('a', false), note('b', true), note('c', false)], 2, 0);
    const response = held();
    api.postExact(`${BASE}/mark-all-read`, response.handler);

    let done!: Promise<void>;
    act(() => { done = view.result.current.actions.markAllRead(); });

    await waitFor(() => expect(readFlags(view.result.current.feed.notifications)).toEqual(['a:true', 'b:true', 'c:true']));
    expect(view.result.current.badge.unreadCount).toBe(0);
    expect(queryClient.getQueryData<{ unreadCount: number }>(['notificationsFeed', FIRM])?.unreadCount).toBe(0);

    await act(async () => {
      response.release({ message: 'ok', updated: 2 });
      await done;
    });
    expect(api.calls('POST').map((c) => c.pathname)).toEqual([`${BASE}/mark-all-read`]);
  });

  it('restores the unread ones and the badge when the server refuses', async () => {
    const view = await mountBell([note('a', false), note('b', true)], 1);
    api.postExact(`${BASE}/mark-all-read`, { status: 500, body: { error: 'Nope' } });

    await act(async () => {
      await expect(view.result.current.actions.markAllRead()).rejects.toThrow('Nope');
    });

    expect(readFlags(view.result.current.feed.notifications)).toEqual(['a:false', 'b:true']);
    expect(view.result.current.badge.unreadCount).toBe(1);
  });
});

describe('without a firm', () => {
  it('sends no request for any action', async () => {
    const { result } = renderHook(() => useNotificationActions(undefined), { wrapper });

    await act(async () => {
      await result.current.markRead('a');
      await result.current.markUnread('a');
      await result.current.remove('a');
      await result.current.markAllRead();
    });

    expect(api.calls()).toHaveLength(0);
  });
});
