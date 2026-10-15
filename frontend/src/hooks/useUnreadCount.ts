"use client";

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { REFRESH_ON_FOCUS } from '@/lib/query/lawFirmQueryClient';
import { useAuth } from '@/hooks/useAuth';
import messagesService from '@/services/messages.service';

export function useUnreadCount(lawFirmId?: string) {
  const { user } = useAuth();

  const { data: unreadCount, isLoading, refetch } = useQuery<number>({
    queryKey: ['unreadCount', lawFirmId],
    queryFn: () => messagesService.getUnreadCount(lawFirmId),
    enabled: !!user,
    // The badge is driven event-first: Realtime-backed `useConversations`
    // broadcasts `unread-count-updated` on every list change and
    // `useConversationMessages` dispatches `messages-marked-read` after a read
    // POST (both handled below). The interval is now only a slow safety net for
    // when Realtime is unavailable, not the primary refresh mechanism.
    refetchInterval: 10 * 60_000,
    refetchIntervalInBackground: false,
    // Outside the messages pages nothing pushes a new inbound message to the
    // sidebar badge, so re-read on return to the tab rather than wait out the
    // ten minute backstop.
    ...REFRESH_ON_FOCUS,
  });

  useEffect(() => {
    if (!user) return;

    const handleRefresh = () => { refetch(); };

    window.addEventListener('messages-marked-read', handleRefresh);
    window.addEventListener('unread-count-updated', handleRefresh);

    return () => {
      window.removeEventListener('messages-marked-read', handleRefresh);
      window.removeEventListener('unread-count-updated', handleRefresh);
    };
  }, [user, refetch]);

  return { unreadCount: unreadCount ?? 0, loading: isLoading, refresh: refetch };
}
