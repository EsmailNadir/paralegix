/**
 * Offline contracts for the shared messaging unread badge.
 *
 * The firm sidebar and client sidebar call the same hook, but they must reach
 * different endpoints. Its event listeners also outlive most message views, so
 * an old listener must not refetch after unmount or carry a previous firm into
 * the next workspace.
 */
jest.unmock('@/services/messages.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/hooks/useAuth', () => ({ useAuth: jest.fn() }));

import { act, renderHook, waitFor } from '@testing-library/react';

import { useUnreadCount } from '@/hooks/useUnreadCount';
import { useAuth } from '@/hooks/useAuth';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock, sequence } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { createQueryWrapper } from '../support/queryWrapper';

const useAuthMock = useAuth as jest.Mock;
const api = setupApiMock();

beforeEach(() => {
  __resetDuplicateRequestGuard();
  useAuthMock.mockReturnValue({ user: { uid: 'member-a' }, loading: false });
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('useUnreadCount offline contract', () => {
  it('does not request a badge before an identity exists', async () => {
    useAuthMock.mockReturnValue({ user: null, loading: false });

    const { result } = renderHook(() => useUnreadCount('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unreadCount).toBe(0);
    expect(api.calls()).toEqual([]);
  });

  it('uses the portal-wide route when a client sidebar has no single firm scope', async () => {
    api.getExact('/api/messaging/unread-count', { count: 2 });

    const { result } = renderHook(() => useUnreadCount(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.unreadCount).toBe(2));
    expect(api.calls()).toEqual([expect.objectContaining({
      pathname: '/api/messaging/unread-count',
    })]);
  });

  it('uses the selected firm endpoint and refreshes when a message view marks messages read', async () => {
    api.getExact('/api/lawfirms/firm-a/messaging/unread-count', sequence(
      { count: 4 },
      { count: 1 },
    ));

    const { result } = renderHook(() => useUnreadCount('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.unreadCount).toBe(4));

    // A read event deliberately requests the same badge endpoint again. It is
    // a state-change boundary, not duplicate work from two consumers.
    __resetDuplicateRequestGuard();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('messages-marked-read', {
        detail: { conversationId: 'conversation-a' },
      }));
    });

    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    expect(api.callsTo('/lawfirms/firm-a/messaging/unread-count')).toHaveLength(2);
  });

  it('does not retain firm A count after a scope change or a late firm A response', async () => {
    const heldFirmA = holdResponse();
    api.getExact('/api/lawfirms/firm-a/messaging/unread-count', heldFirmA.handler);
    api.getExact('/api/lawfirms/firm-b/messaging/unread-count', { count: 7 });

    const { result, rerender } = renderHook(
      ({ lawFirmId }: { lawFirmId: string }) => useUnreadCount(lawFirmId),
      { initialProps: { lawFirmId: 'firm-a' }, wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(api.callsTo('/lawfirms/firm-a/messaging/unread-count')).toHaveLength(1));

    rerender({ lawFirmId: 'firm-b' });
    await waitFor(() => expect(result.current.unreadCount).toBe(7));

    await act(async () => {
      heldFirmA.release({ count: 99 });
    });

    expect(result.current.unreadCount).toBe(7);
  });

  it('removes its event listeners on unmount', async () => {
    api.getExact('/api/lawfirms/firm-a/messaging/unread-count', { count: 3 });

    const { result, unmount } = renderHook(() => useUnreadCount('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.unreadCount).toBe(3));
    unmount();

    await act(async () => {
      window.dispatchEvent(new Event('unread-count-updated'));
    });

    expect(api.callsTo('/lawfirms/firm-a/messaging/unread-count')).toHaveLength(1);
  });
});
