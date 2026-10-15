import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import notificationsService, {
  type NotificationFeedResponse,
  type UnreadCountResponse,
} from "@/services/notifications.service";

export const FEED_QUERY_KEY = "notificationsFeed";
export const COUNT_QUERY_KEY = "notificationsUnreadCount";

function useNotificationsFeed(lawFirmId?: string) {
  return useQuery({
    queryKey: [FEED_QUERY_KEY, lawFirmId],
    queryFn: () => notificationsService.getFeed(lawFirmId!, { limit: 50 }),
    enabled: !!lawFirmId,
    // Realtime (useNotificationsRealtime) is the primary refresh path; this slow
    // interval is only a backstop for when the WebSocket/JWT is unavailable.
    refetchInterval: 10 * 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useNotifications(lawFirmId?: string) {
  const { data, isLoading, error, refetch } = useNotificationsFeed(lawFirmId);

  return {
    notifications: data?.notifications ?? [],
    total: data?.total ?? 0,
    loading: isLoading,
    error: error instanceof Error ? error.message : null,
    refetch,
  };
}

export function useUnreadCount(lawFirmId?: string) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: [COUNT_QUERY_KEY, lawFirmId],
    // Badge uses the cheap count-only endpoint instead of the full feed.
    queryFn: () => notificationsService.getUnreadCount(lawFirmId!),
    enabled: !!lawFirmId,
    // Realtime (useNotificationsRealtime) is the primary refresh path; this slow
    // interval is only a backstop for when the WebSocket/JWT is unavailable.
    refetchInterval: 10 * 60_000,
    refetchIntervalInBackground: false,
  });

  return {
    unreadCount: data?.unreadCount ?? 0,
    loading: isLoading,
    refetch,
  };
}

export function useNotificationActions(lawFirmId?: string) {
  const queryClient = useQueryClient();

  const markRead = useCallback(async (notificationId: string) => {
    if (!lawFirmId) return;

    const feedKey = [FEED_QUERY_KEY, lawFirmId];
    const countKey = [COUNT_QUERY_KEY, lawFirmId];

    // Cancel in-flight refetches so they don't clobber the optimistic update.
    await Promise.all([
      queryClient.cancelQueries({ queryKey: feedKey }),
      queryClient.cancelQueries({ queryKey: countKey }),
    ]);

    const prevFeed = queryClient.getQueryData<NotificationFeedResponse>(feedKey);
    const prevCount = queryClient.getQueryData<UnreadCountResponse>(countKey);

    // Optimistically mark the single item read in the feed cache.
    let wasUnread = false;
    if (prevFeed) {
      const next = prevFeed.notifications.map((n) => {
        if (n.id === notificationId && !n.read) {
          wasUnread = true;
          return { ...n, read: true };
        }
        return n;
      });
      queryClient.setQueryData<NotificationFeedResponse>(feedKey, {
        ...prevFeed,
        notifications: next,
        unreadCount: wasUnread
          ? Math.max(0, prevFeed.unreadCount - 1)
          : prevFeed.unreadCount,
      });
    }

    // Keep the badge count cache in sync optimistically.
    if (prevCount && wasUnread) {
      queryClient.setQueryData<UnreadCountResponse>(countKey, {
        unreadCount: Math.max(0, prevCount.unreadCount - 1),
      });
    }

    try {
      await notificationsService.markRead(lawFirmId, notificationId);
    } catch (err) {
      // Rollback on error.
      if (prevFeed) queryClient.setQueryData(feedKey, prevFeed);
      if (prevCount) queryClient.setQueryData(countKey, prevCount);
      throw err;
    }
    // Reconcile the badge from the server (cheap count-only query). The list is
    // handled optimistically + by Realtime, but the count must stay correct even
    // when the feed cache isn't populated (e.g. the full notifications page,
    // which uses its own local state) or a Realtime event isn't delivered.
    queryClient.invalidateQueries({ queryKey: countKey });
  }, [lawFirmId, queryClient]);

  const markUnread = useCallback(async (notificationId: string) => {
    if (!lawFirmId) return;

    const feedKey = [FEED_QUERY_KEY, lawFirmId];
    const countKey = [COUNT_QUERY_KEY, lawFirmId];

    await Promise.all([
      queryClient.cancelQueries({ queryKey: feedKey }),
      queryClient.cancelQueries({ queryKey: countKey }),
    ]);

    const prevFeed = queryClient.getQueryData<NotificationFeedResponse>(feedKey);
    const prevCount = queryClient.getQueryData<UnreadCountResponse>(countKey);

    let wasRead = false;
    if (prevFeed) {
      const next = prevFeed.notifications.map((n) => {
        if (n.id === notificationId && n.read) {
          wasRead = true;
          return { ...n, read: false };
        }
        return n;
      });
      queryClient.setQueryData<NotificationFeedResponse>(feedKey, {
        ...prevFeed,
        notifications: next,
        unreadCount: wasRead ? prevFeed.unreadCount + 1 : prevFeed.unreadCount,
      });
    }
    if (prevCount && wasRead) {
      queryClient.setQueryData<UnreadCountResponse>(countKey, {
        unreadCount: prevCount.unreadCount + 1,
      });
    }

    try {
      await notificationsService.markUnread(lawFirmId, notificationId);
    } catch (err) {
      if (prevFeed) queryClient.setQueryData(feedKey, prevFeed);
      if (prevCount) queryClient.setQueryData(countKey, prevCount);
      throw err;
    }
    queryClient.invalidateQueries({ queryKey: countKey });
  }, [lawFirmId, queryClient]);

  const remove = useCallback(async (notificationId: string) => {
    if (!lawFirmId) return;

    const feedKey = [FEED_QUERY_KEY, lawFirmId];
    const countKey = [COUNT_QUERY_KEY, lawFirmId];

    await Promise.all([
      queryClient.cancelQueries({ queryKey: feedKey }),
      queryClient.cancelQueries({ queryKey: countKey }),
    ]);

    const prevFeed = queryClient.getQueryData<NotificationFeedResponse>(feedKey);
    const prevCount = queryClient.getQueryData<UnreadCountResponse>(countKey);

    let removedUnread = false;
    if (prevFeed) {
      const target = prevFeed.notifications.find((n) => n.id === notificationId);
      removedUnread = !!target && !target.read;
      queryClient.setQueryData<NotificationFeedResponse>(feedKey, {
        ...prevFeed,
        notifications: prevFeed.notifications.filter((n) => n.id !== notificationId),
        total: Math.max(0, prevFeed.total - 1),
        unreadCount: removedUnread ? Math.max(0, prevFeed.unreadCount - 1) : prevFeed.unreadCount,
      });
    }
    if (prevCount && removedUnread) {
      queryClient.setQueryData<UnreadCountResponse>(countKey, {
        unreadCount: Math.max(0, prevCount.unreadCount - 1),
      });
    }

    try {
      await notificationsService.remove(lawFirmId, notificationId);
    } catch (err) {
      if (prevFeed) queryClient.setQueryData(feedKey, prevFeed);
      if (prevCount) queryClient.setQueryData(countKey, prevCount);
      throw err;
    }
    queryClient.invalidateQueries({ queryKey: countKey });
  }, [lawFirmId, queryClient]);

  const markAllRead = useCallback(async () => {
    if (!lawFirmId) return;

    const feedKey = [FEED_QUERY_KEY, lawFirmId];
    const countKey = [COUNT_QUERY_KEY, lawFirmId];

    await Promise.all([
      queryClient.cancelQueries({ queryKey: feedKey }),
      queryClient.cancelQueries({ queryKey: countKey }),
    ]);

    const prevFeed = queryClient.getQueryData<NotificationFeedResponse>(feedKey);
    const prevCount = queryClient.getQueryData<UnreadCountResponse>(countKey);

    if (prevFeed) {
      queryClient.setQueryData<NotificationFeedResponse>(feedKey, {
        ...prevFeed,
        notifications: prevFeed.notifications.map((n) => (n.read ? n : { ...n, read: true })),
        unreadCount: 0,
      });
    }
    if (prevCount) {
      queryClient.setQueryData<UnreadCountResponse>(countKey, { unreadCount: 0 });
    }

    try {
      await notificationsService.markAllRead(lawFirmId);
    } catch (err) {
      if (prevFeed) queryClient.setQueryData(feedKey, prevFeed);
      if (prevCount) queryClient.setQueryData(countKey, prevCount);
      throw err;
    }
    queryClient.invalidateQueries({ queryKey: countKey });
  }, [lawFirmId, queryClient]);

  return { markRead, markUnread, markAllRead, remove };
}
