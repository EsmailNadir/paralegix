"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import clientPortalService, { type PortalNotification } from "@/services/client-portal.service";
import { getErrorMessage } from '@/lib/utils/apiErrors';

interface ClientNotificationsData {
  notifications: PortalNotification[];
  unreadCount: number;
  /**
   * Composite cursor for the page after this one, or nulls when this is the
   * whole feed. The id breaks ties between rows sharing a timestamp, which a
   * created_at-only cursor would silently skip across a page boundary.
   */
  nextBefore: string | null;
  nextBeforeId: string | null;
}

/** Notifications per request, for the first page and each older page. */
const PAGE_SIZE = 30;

/**
 * The signed-in client's in-app notification feed for one firm (the portal bell).
 * Polled on a slow interval and on window focus - clients don't have the firm's
 * Realtime wiring, and share digests are debounced by ~a minute anyway, so a
 * near-real-time feel isn't needed.
 *
 * The newest page is owned by React Query (so polling keeps refreshing it) while
 * older pages, walked back through the `before` cursor, accumulate in local
 * state. Older notifications are immutable relative to the newest page, so a
 * poll can prepend new rows without disturbing the history already loaded.
 */
export function useClientNotifications(lawFirmId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["client-notifications", lawFirmId];

  const { data, isLoading, error, refetch } = useQuery<ClientNotificationsData>({
    queryKey,
    queryFn: async () => {
      const res = await clientPortalService.getNotifications(lawFirmId!, { limit: PAGE_SIZE });
      return {
        notifications: res.notifications,
        unreadCount: res.unreadCount,
        nextBefore: res.nextBefore,
        nextBeforeId: res.nextBeforeId,
      };
    },
    enabled: !!user && !!lawFirmId,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  // Pages older than the React Query page, oldest-last, plus the cursor for the
  // page after them.
  const [olderNotifications, setOlderNotifications] = useState<PortalNotification[]>([]);
  // Undefined means no older page has loaded; null means the history is exhausted.
  const [olderBefore, setOlderBefore] = useState<{ before: string; beforeId: string | null } | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  // The firm the bell is showing now, read after an older page answers. The bell
  // stays mounted across the portal's firm switcher, so a page requested for
  // the previous firm can arrive after the switch.
  const currentFirmRef = useRef(lawFirmId);
  useEffect(() => {
    currentFirmRef.current = lawFirmId;
  }, [lawFirmId]);

  // Switching firms makes this a different feed, so the loaded history is dropped.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the paged history when the firm scope changes
    setOlderNotifications([]);
    setOlderBefore(undefined);
  }, [lawFirmId]);

  const unreadCount = data?.unreadCount ?? 0;

  // The newest page can overlap what was already paged in (a poll that picks up
  // rows added since), so ids are de-duplicated with the newest copy winning.
  // The `?? []` fallback lives inside the memo so an undefined page can't build a
  // fresh array on every render and defeat it.
  const notifications = useMemo(() => {
    const seen = new Set<string>();
    const merged: PortalNotification[] = [];
    for (const n of [...(data?.notifications ?? []), ...olderNotifications]) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      merged.push(n);
    }
    return merged;
  }, [data?.notifications, olderNotifications]);

  // The cursor to read next: the end of the history loaded so far, or the end of
  // the first page when nothing older has been loaded yet. An empty older page
  // still supplies the next cursor, including null when the history is exhausted.
  // Memoized so `loadMore` keeps a stable identity between renders (the first
  // page's cursor would otherwise be a fresh object every time).
  const firstPageBefore = data?.nextBefore ?? null;
  const firstPageBeforeId = data?.nextBeforeId ?? null;
  const cursor = useMemo(() => {
    if (olderBefore !== undefined) return olderBefore;
    return firstPageBefore ? { before: firstPageBefore, beforeId: firstPageBeforeId } : null;
  }, [olderBefore, firstPageBefore, firstPageBeforeId]);
  const hasMore = !!cursor;

  const loadMore = useCallback(async () => {
    if (!lawFirmId || loadingMore || !cursor) return;
    setLoadingMore(true);
    try {
      const res = await clientPortalService.getNotifications(lawFirmId, {
        limit: PAGE_SIZE,
        before: cursor.before,
        beforeId: cursor.beforeId ?? undefined,
      });
      // Dropped if the firm changed while it loaded: its rows and its cursor
      // belong to the previous firm's feed, not this one.
      if (currentFirmRef.current !== lawFirmId) return;
      setOlderNotifications((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        return [...prev, ...res.notifications.filter((n) => !seen.has(n.id))];
      });
      setOlderBefore(res.nextBefore ? { before: res.nextBefore, beforeId: res.nextBeforeId } : null);
    } finally {
      setLoadingMore(false);
    }
  }, [lawFirmId, loadingMore, cursor]);

  // Optimistically flip a row (or all rows) to read so the badge and list update
  // immediately, then reconcile with the server. Both the React Query page and
  // the paged-in history are updated, so a row read on page 3 doesn't snap back.
  const markRead = async (notificationId: string) => {
    if (!lawFirmId) return;
    queryClient.setQueryData<ClientNotificationsData>(queryKey, (prev) =>
      prev
        ? {
            ...prev,
            notifications: prev.notifications.map((n) =>
              n.id === notificationId ? { ...n, read: true } : n,
            ),
            unreadCount: Math.max(0, prev.unreadCount - (prev.notifications.find((n) => n.id === notificationId && !n.read) ? 1 : 0)),
          }
        : prev,
    );
    setOlderNotifications((prev) =>
      prev.map((n) => (n.id === notificationId ? { ...n, read: true } : n)),
    );
    try {
      await clientPortalService.markNotificationRead(lawFirmId, notificationId);
    } finally {
      refetch();
    }
  };

  const markAllRead = async () => {
    if (!lawFirmId) return;
    queryClient.setQueryData<ClientNotificationsData>(queryKey, (prev) =>
      prev ? { ...prev, notifications: prev.notifications.map((n) => ({ ...n, read: true })), unreadCount: 0 } : prev,
    );
    setOlderNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    try {
      await clientPortalService.markAllNotificationsRead(lawFirmId);
    } finally {
      refetch();
    }
  };

  return {
    notifications,
    error: error ? getErrorMessage(error, 'Failed to load notifications') : null,
    unreadCount,
    loading: isLoading,
    loadingMore,
    hasMore,
    loadMore,
    refetch,
    markRead,
    markAllRead,
  };
}
