"use client";

import { useMemo, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useConversations } from '@/hooks/useConversations';
import ConversationList from '@/components/messagesComp/ConversationList';
import MessageSearch from '@/components/messagesComp/MessageSearch';
import ListSkeleton from '@/components/ui/ListSkeleton';
import ErrorNotification from '@/components/ErrorNotification';
import { useAuth } from '@/hooks/useAuth';
import { MessageSquare } from 'lucide-react';
import { useNavigation } from '@/contexts/NavigationContext';
import { AutoPager } from '@/components/ui/ListPager';
import usePagedRows from '@/hooks/usePagedRows';
import clientPortalService from '@/services/client-portal.service';
import type { Conversation } from '@/types';
import Card from '@/components/ui/Card';

/**
 * Conversations per page, matching the firm-side inbox. A portal client has one
 * direct thread per firm plus their group threads, so the whole set arrives in one
 * read and the paging happens in memory.
 */
const CONVERSATIONS_PER_PAGE = 10;

export default function ClientMessagesPage() {
  const { navigate } = useNavigation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { conversations, loading, error } = useConversations({ isClient: true });

  // Group threads the client participates in, merged into the direct list.
  const { data: groupConversations = [], isLoading: groupsLoading } = useQuery<Conversation[]>({
    queryKey: ['clientGroupConversations'],
    queryFn: () => clientPortalService.listGroups(),
    staleTime: 30_000,
  });

  // Group threads live on their own query with no Realtime subscription of their
  // own. `useConversations` (direct threads) broadcasts these window events on
  // every Realtime conversations-table change and after a read (and re-broadcasts
  // on its own remount). Refetch the group list on them so a group thread's
  // list-row unread badge clears in step with the read instead of serving a stale
  // count from cache until the query's staleTime lapses.
  useEffect(() => {
    const refetchGroups = () => {
      queryClient.invalidateQueries({ queryKey: ['clientGroupConversations'] });
    };
    window.addEventListener('unread-count-updated', refetchGroups);
    window.addEventListener('messages-marked-read', refetchGroups);
    return () => {
      window.removeEventListener('unread-count-updated', refetchGroups);
      window.removeEventListener('messages-marked-read', refetchGroups);
    };
  }, [queryClient]);

  const allConversations = useMemo(() => {
    const merged = [...conversations, ...groupConversations];
    return merged.sort((a, b) => {
      const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return tb - ta;
    });
  }, [conversations, groupConversations]);

  // Direct threads and group threads come from two queries merged in memory, so
  // the paging is applied here rather than server-side.
  const pager = usePagedRows(allConversations, CONVERSATIONS_PER_PAGE);

  const handleSelectConversation = (conversationId: string) => {
    const selected = allConversations.find(
      (conversation) => conversation.conversationId === conversationId
    );
    const lawFirmId = selected?.lawFirmId;
    if (!lawFirmId) return;
    // Every thread opens by its id, so a direct row opens the direct thread
    // rather than whichever of the firm's threads is newest.
    navigate(`/client/messages/${lawFirmId}?c=${encodeURIComponent(conversationId)}`);
  };

  // Full-text search across the client's conversations (message content). Opening
  // a result routes to its thread by id, direct and group alike.
  const searchMessages = useCallback((q: string) => clientPortalService.searchMessages(q), []);
  const handleOpenSearchResult = (r: { conversationId: string; lawFirmId: string }) => {
    if (!r.lawFirmId) return;
    navigate(`/client/messages/${r.lawFirmId}?c=${encodeURIComponent(r.conversationId)}`);
  };

  return (
    <div className="p-8 max-w-[1600px] mx-auto min-w-0">
      {/* Header */}
      <div className="mb-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-on-surface">Messages</h1>
            <p className="text-sm text-on-surface-muted mt-1">
              View and manage your conversations with your legal teams.
              {allConversations.length > 0 && (
                <>
                  {" "}You have <span className="font-semibold text-on-surface">{allConversations.length} conversation{allConversations.length !== 1 ? "s" : ""}</span>.
                </>
              )}
            </p>
          </div>

          {allConversations.length > 0 && (
            <div className="w-full max-w-xs">
              <MessageSearch searchFn={searchMessages} onSelect={handleOpenSearchResult} />
            </div>
          )}
        </div>
      </div>

      <ErrorNotification error={error} onClose={() => {}} />

      {/* Conversations */}
      <Card>
        {loading || (groupsLoading && allConversations.length === 0) ? (
          <ListSkeleton rows={6} bordered={false} label="Loading conversations" />
        ) : allConversations.length === 0 ? (
          <div className="p-8 text-center">
            <MessageSquare size={32} className="text-on-surface-muted mx-auto mb-3" />
            <p className="text-sm text-on-surface-secondary mb-1">No messages yet</p>
            <p className="text-xs text-on-surface-muted">Your conversations will appear here.</p>
          </div>
        ) : (
          <ConversationList
            conversations={pager.pagedRows}
            onSelect={handleSelectConversation}
            currentUserId={user?.uid}
          />
        )}
      </Card>

      {allConversations.length > 0 && (
        <div className="mt-4">
          <AutoPager pager={pager} />
        </div>
      )}
    </div>
  );
}
