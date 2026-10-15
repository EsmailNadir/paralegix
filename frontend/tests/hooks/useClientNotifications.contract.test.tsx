/**
 * Offline contract for the client portal's notification bell
 * (`useClientNotifications`).
 *
 * The newest page is a React Query entry keyed by firm; older pages walked back
 * through the cursor live in local state. That split is where the risk is: the
 * query cache is firm-scoped for free, the local history is only as scoped as
 * the code that writes it. A client of two firms switches between them in the
 * same portal session, and each firm's notifications describe that firm's
 * matters.
 *
 * What has to break for these to go red: the cursor not being sent (or the
 * wrong one), paged history not de-duplicated, the optimistic read not applied
 * to both the newest page and the history, the server's answer not reconciled
 * after a write, or one firm's notifications surviving into another's feed.
 */
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';

import { useClientNotifications } from '@/hooks/notificationHooks/useClientNotifications';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import clientPortalService, { type PortalNotification } from '@/services/client-portal.service';
import { sequence, setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated, itSendsNothingWithoutScope } from '../support/scopeIsolation';

const api = setupApiMock();

// A write is followed by a re-read of the page it just changed, which trips the
// dev-only duplicate-GET warning. That re-read is the behaviour under test.
beforeEach(() => {
  process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off';
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN;
});

const base = (firm: string) => `/api/client-portal/lawfirm/${firm}/notifications`;
const firstPage = (firm: string) => `${base(firm)}?limit=30`;
const olderPage = (firm: string, before: string, beforeId: string) =>
  `${base(firm)}?limit=30&before=${encodeURIComponent(before)}&beforeId=${beforeId}`;

function note(id: string, read = false): PortalNotification {
  return { id, type: 'share', title: id, body: '', read, createdAt: '2026-09-01T00:00:00.000Z' };
}

function page(rows: PortalNotification[], unreadCount: number, cursor: [string, string] | null = null) {
  return {
    notifications: rows,
    unreadCount,
    nextBefore: cursor ? cursor[0] : null,
    nextBeforeId: cursor ? cursor[1] : null,
  };
}

const ids = (r: { notifications: PortalNotification[] }) => r.notifications.map((n) => n.id);
const CURSOR_1: [string, string] = ['2026-08-31T00:00:00.000Z', 'n2'];
const CURSOR_2: [string, string] = ['2026-08-30T00:00:00.000Z', 'n4'];

function renderFeed(firm = 'firm-a') {
  return renderHook(() => useClientNotifications(firm), { wrapper: createQueryWrapper() });
}

itSendsNothingWithoutScope({
  title: 'sends nothing before a firm is chosen',
  api: () => api,
  useHook: () => useClientNotifications(undefined),
  settled: (r) => r.loading === false,
  finally: (r) => {
    expect(r.notifications).toEqual([]);
    expect(r.unreadCount).toBe(0);
    expect(r.hasMore).toBe(false);
  },
});

describe('the newest page', () => {
  it("shows the firm's newest notifications with the server's unread count", async () => {
    api.getExact(firstPage('firm-a'), page([note('n1'), note('n2', true)], 7, CURSOR_1));

    const { result } = renderFeed();

    await waitFor(() => expect(ids(result.current)).toEqual(['n1', 'n2']));
    // The count is the server's, across the whole feed, not the unread rows
    // on this page.
    expect(result.current.unreadCount).toBe(7);
    expect(result.current.hasMore).toBe(true);
  });

  it('offers no older page when the server gives no cursor, and loadMore sends nothing', async () => {
    api.getExact(firstPage('firm-a'), page([note('n1')], 1));

    const { result } = renderFeed();
    await waitFor(() => expect(ids(result.current)).toEqual(['n1']));
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(api.calls()).toHaveLength(1);
  });
});

describe('walking back through older pages', () => {
  it('sends the composite cursor, appends the older rows, and follows the next cursor', async () => {
    api.getExact(firstPage('firm-a'), page([note('n1'), note('n2')], 0, CURSOR_1));
    api.getExact(olderPage('firm-a', ...CURSOR_1), page([note('n3'), note('n4')], 0, CURSOR_2));
    api.getExact(olderPage('firm-a', ...CURSOR_2), page([note('n5')], 0));

    const { result } = renderFeed();
    await waitFor(() => expect(ids(result.current)).toEqual(['n1', 'n2']));

    await act(async () => {
      await result.current.loadMore();
    });
    expect(ids(result.current)).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(ids(result.current)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.loadingMore).toBe(false);
  });

  it('stops pagination when an older page is empty and supplies no next cursor', async () => {
    api.getExact(firstPage('firm-a'), page([note('n1')], 1, CURSOR_1));
    api.getExact(olderPage('firm-a', ...CURSOR_1), page([], 0));

    const { result } = renderFeed();
    await waitFor(() => expect(ids(result.current)).toEqual(['n1']));
    expect(result.current.hasMore).toBe(true);
    await act(async () => { await result.current.loadMore(); });

    expect(ids(result.current)).toEqual(['n1']);
    expect(result.current.hasMore).toBe(false);
    await act(async () => { await result.current.loadMore(); });
    expect(api.callsTo('/notifications')).toHaveLength(2);
  });

  it('keeps the current feed and cursor after a failed older page, then retries the same cursor', async () => {
    api.getExact(firstPage('firm-a'), page([note('n1')], 4, CURSOR_1));
    api.getExact(olderPage('firm-a', ...CURSOR_1), sequence(
      { status: 503, body: { error: 'Older feed unavailable' } },
      page([note('n3')], 0),
    ));

    const { result } = renderFeed();
    await waitFor(() => expect(ids(result.current)).toEqual(['n1']));
    await act(async () => {
      await expect(result.current.loadMore()).rejects.toThrow('Older feed unavailable');
    });
    expect(ids(result.current)).toEqual(['n1']);
    expect(result.current.unreadCount).toBe(4);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loadingMore).toBe(false);

    await act(async () => { await result.current.loadMore(); });
    expect(ids(result.current)).toEqual(['n1', 'n3']);
    expect(result.current.hasMore).toBe(false);
    expect(api.callsTo('/notifications').map((call) => call.query)).toEqual([
      { limit: ['30'] },
      { limit: ['30'], before: [CURSOR_1[0]], beforeId: [CURSOR_1[1]] },
      { limit: ['30'], before: [CURSOR_1[0]], beforeId: [CURSOR_1[1]] },
    ]);
  });

  it('sends no second older-page request while the first is pending', async () => {
    api.getExact(firstPage('firm-a'), page([note('n1')], 1, CURSOR_1));
    const older = holdResponse();
    api.getExact(olderPage('firm-a', ...CURSOR_1), older.handler);

    const { result } = renderFeed();
    await waitFor(() => expect(ids(result.current)).toEqual(['n1']));
    let pending!: Promise<void>;
    act(() => { pending = result.current.loadMore(); });
    await older.untilRequested();
    expect(result.current.loadingMore).toBe(true);
    // The transport also deduplicates GETs. Observe the real service call so
    // that deduplication cannot hide a missing hook guard.
    const reads = jest.spyOn(clientPortalService, 'getNotifications');
    let duplicate!: Promise<void>;
    try {
      await act(async () => { duplicate = result.current.loadMore(); });
      expect(reads).not.toHaveBeenCalled();
      expect(api.callsTo('/notifications')).toHaveLength(2);
      expect(ids(result.current)).toEqual(['n1']);
    } finally {
      reads.mockRestore();
      await act(async () => {
        older.release(page([note('n3')], 0));
        await Promise.all([pending, duplicate]);
      });
    }
    expect(ids(result.current)).toEqual(['n1', 'n3']);
    expect(result.current.loadingMore).toBe(false);
  });

  it('shows a row once when an older page overlaps the newest one', async () => {
    // Rows that share a timestamp can straddle the boundary; the newest copy wins.
    api.getExact(firstPage('firm-a'), page([note('n1'), note('n2')], 0, CURSOR_1));
    api.getExact(olderPage('firm-a', ...CURSOR_1), page([note('n2'), note('n3')], 0));

    const { result } = renderFeed();
    await waitFor(() => expect(ids(result.current)).toEqual(['n1', 'n2']));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(ids(result.current)).toEqual(['n1', 'n2', 'n3']);
  });
});

describe('marking notifications read', () => {
  it('flips the row and the badge at once, then reconciles with the server', async () => {
    api.getExact(firstPage('firm-a'), sequence(
      page([note('n1'), note('n2')], 2),
      page([note('n1', true), note('n2')], 1),
    ));
    const write = holdResponse();
    api.postExact(`${base('firm-a')}/n1/read`, write.handler);

    const { result } = renderFeed();
    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.markRead('n1');
    });
    await write.untilRequested();

    // Before the server has answered.
    expect(result.current.notifications.find((n) => n.id === 'n1')?.read).toBe(true);
    expect(result.current.unreadCount).toBe(1);

    await act(async () => {
      write.release({ status: 204 });
      await pending;
    });
    await waitFor(() => expect(api.callsTo('/notifications')).toHaveLength(2));
  });

  it('does not lower the badge for a row that was already read', async () => {
    api.getExact(firstPage('firm-a'), page([note('n1', true), note('n2')], 1));
    api.postExact(`${base('firm-a')}/n1/read`, { status: 204 });

    const { result } = renderFeed();
    await waitFor(() => expect(result.current.unreadCount).toBe(1));

    await act(async () => {
      await result.current.markRead('n1');
    });

    expect(result.current.unreadCount).toBe(1);
  });

  it('marks a row read in the paged history too, so it does not snap back', async () => {
    api.getExact(firstPage('firm-a'), page([note('n1')], 2, CURSOR_1));
    api.getExact(olderPage('firm-a', ...CURSOR_1), page([note('n3')], 0));
    api.postExact(`${base('firm-a')}/n3/read`, { status: 204 });

    const { result } = renderFeed();
    await waitFor(() => expect(ids(result.current)).toEqual(['n1']));
    await act(async () => {
      await result.current.loadMore();
    });

    await act(async () => {
      await result.current.markRead('n3');
    });

    expect(result.current.notifications.find((n) => n.id === 'n3')?.read).toBe(true);
  });

  it('puts the row back to unread when the server refuses, and rejects', async () => {
    api.getExact(firstPage('firm-a'), page([note('n1')], 1));
    api.postExact(`${base('firm-a')}/n1/read`, { status: 403, body: { error: 'Not your notification' } });

    const { result } = renderFeed();
    await waitFor(() => expect(result.current.unreadCount).toBe(1));

    await act(async () => {
      await expect(result.current.markRead('n1')).rejects.toThrow('Not your notification');
    });

    // The optimistic flip is undone by the re-read, not left standing.
    await waitFor(() => expect(result.current.notifications[0].read).toBe(false));
    expect(result.current.unreadCount).toBe(1);
  });

  it('marks everything read, history included, and zeroes the badge', async () => {
    api.getExact(firstPage('firm-a'), sequence(
      page([note('n1')], 2, CURSOR_1),
      page([note('n1', true)], 0, CURSOR_1),
    ));
    api.getExact(olderPage('firm-a', ...CURSOR_1), page([note('n3')], 0));
    api.postExact(`${base('firm-a')}/mark-all-read`, { status: 204 });

    const { result } = renderFeed();
    await waitFor(() => expect(ids(result.current)).toEqual(['n1']));
    await act(async () => {
      await result.current.loadMore();
    });

    await act(async () => {
      await result.current.markAllRead();
    });

    expect(result.current.unreadCount).toBe(0);
    expect(result.current.notifications.every((n) => n.read)).toBe(true);
    expect(api.calls('POST').map((c) => c.pathname)).toEqual([`${base('firm-a')}/mark-all-read`]);
  });

  it('sends no write without a firm', async () => {
    const { result } = renderHook(() => useClientNotifications(undefined), { wrapper: createQueryWrapper() });

    await act(async () => {
      await result.current.markRead('n1');
      await result.current.markAllRead();
      await result.current.loadMore();
    });

    expect(api.calls()).toEqual([]);
  });
});

describe('switching firms', () => {
  itKeepsScopeIsolated({
    title: "does not show one firm's notifications while another firm's feed loads",
    mode: 'pending',
    api: () => api,
    useHook: ({ firm }: { firm: string }) => useClientNotifications(firm),
    ids,
    a: { props: { firm: 'firm-a' }, url: firstPage('firm-a'), body: page([note('a1')], 1), ids: ['a1'] },
    b: { props: { firm: 'firm-b' }, url: firstPage('firm-b'), body: page([note('b1')], 4), ids: ['b1'] },
    finally: (r) => expect(r.unreadCount).toBe(4),
  });

  it("drops the previous firm's paged history", async () => {
    api.getExact(firstPage('firm-a'), page([note('a1')], 0, CURSOR_1));
    api.getExact(olderPage('firm-a', ...CURSOR_1), page([note('a-old')], 0));
    api.getExact(firstPage('firm-b'), page([note('b1')], 0));

    const { result, rerender } = renderHook(
      ({ firm }: { firm: string }) => useClientNotifications(firm),
      { wrapper: createQueryWrapper(), initialProps: { firm: 'firm-a' } },
    );
    await waitFor(() => expect(ids(result.current)).toEqual(['a1']));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(ids(result.current)).toEqual(['a1', 'a-old']);

    rerender({ firm: 'firm-b' });

    await waitFor(() => expect(ids(result.current)).toEqual(['b1']));
    expect(result.current.hasMore).toBe(false);
  });

  // The bell stays mounted across `ClientSidebar`'s firm switcher, so a "load
  // more" followed by a firm switch before it answers must not put firm A's
  // older page (or its cursor) into firm B's feed.
  it("does not let an older page still loading for the previous firm land in the new firm's feed", async () => {
    api.getExact(firstPage('firm-a'), page([note('a1')], 0, CURSOR_1));
    const older = holdResponse();
    api.getExact(olderPage('firm-a', ...CURSOR_1), older.handler);
    api.getExact(firstPage('firm-b'), page([note('b1')], 0));

    const { result, rerender } = renderHook(
      ({ firm }: { firm: string }) => useClientNotifications(firm),
      { wrapper: createQueryWrapper(), initialProps: { firm: 'firm-a' } },
    );
    await waitFor(() => expect(ids(result.current)).toEqual(['a1']));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.loadMore();
    });
    await older.untilRequested();

    rerender({ firm: 'firm-b' });
    await waitFor(() => expect(ids(result.current)).toEqual(['b1']));

    await act(async () => {
      older.release(page([note('a-old')], 0));
      await pending;
    });

    expect(ids(result.current)).toEqual(['b1']);
  });
});
