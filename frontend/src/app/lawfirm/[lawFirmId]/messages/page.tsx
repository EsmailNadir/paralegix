"use client";

import { useParams } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@/contexts/NavigationContext';
import { useConversations } from '@/hooks/useConversations';
import ConversationList from '@/components/messagesComp/ConversationList';
import MessageSearch from '@/components/messagesComp/MessageSearch';
import NewGroupModal from '@/components/messagesComp/NewGroupModal';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorNotification from '@/components/ErrorNotification';
import RequirePermission from '@/components/ui/RequirePermission';
import RequireFeature from '@/components/ui/RequireFeature';
import PageHeader from '@/components/ui/PageHeader';
import ListBusyIndicator from '@/components/ui/ListBusyIndicator';
import ListPager from '@/components/ui/ListPager';
import { usePermissions } from '@/contexts/PermissionsContext';
import messagesService from '@/services/messages.service';
import ErrorToast from '@/components/ui/ErrorToast';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import { MessageSquare, Plus, Archive, Inbox } from 'lucide-react';
import Card from '@/components/ui/Card';
import SectionLabel from '@/components/ui/SectionLabel';

// Conversations per page. The whole inbox - direct threads and group threads alike - 
// is ordered and paged by the server, so a page holds exactly this many rows.
const PAGE_SIZE = 10;

export default function FirmMessagesPage() {
  const params = useParams();
  const { navigate } = useNavigation();
  const lawFirmId = params.lawFirmId as string;
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission('messaging.send');
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [search, setSearch] = useState('');
  // Toggles the list between the active inbox and archived threads.
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [actionError, setActionError] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const archived = view === 'archived';

  // Search is resolved in SQL, so hold the input for a beat rather than issuing a
  // request per keystroke.
  const [searchTerm, setSearchTerm] = useState('');
  // Mirrors the footer's own click acknowledgement, so the inline indicator
  // stays quiet while the pager button already carries the wait.
  const [pagerPending, setPagerPending] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // 1-based page. A new search term or a switch between the inbox and the archive is
  // a different result set, so the page is stored together with the filter
  // combination it belongs to: changing the filters rewinds to page 1 in the same
  // render, with no reset effect to catch up.
  const [pageState, setPageState] = useState({ filterKey: '', page: 1 });
  const filterKey = `${archived ? 'archived' : 'active'}|${searchTerm}`;
  const page = pageState.filterKey === filterKey ? pageState.page : 1;
  const goToPage = (next: number) => setPageState({ filterKey, page: next });

  const {
    conversations,
    totalItems,
    loading,
    fetching,
    error,
    refresh,
  } = useConversations({ lawFirmId, limit: PAGE_SIZE, page, search: searchTerm, archived });

  // The archive toggle reports how many threads are archived, which is a count the
  // active view does not otherwise load. Only the active view renders it.
  const { data: archivedTotal = 0 } = useQuery<number>({
    queryKey: ['archivedConversationCount', lawFirmId],
    queryFn: async () => {
      const { totalItems: archivedCount } = await messagesService.getFirmInboxPage(lawFirmId, {
        limit: 1,
        archived: true,
      });
      return archivedCount;
    },
    enabled: !!lawFirmId && !archived,
    staleTime: 30_000,
  });

  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  // Archiving the last row of the last page can strand the view on a page that no
  // longer exists, which the server answers with no rows. Clamp back into range
  // during render (the way the server-paged tables do) so React restarts with the
  // corrected page instead of committing an empty list first.
  if (!fetching && totalItems > 0 && page > totalPages) {
    setPageState({ filterKey, page: totalPages });
  }

  const handleArchive = async (conversationId: string, nextArchived: boolean) => {
    setArchivingId(conversationId);
    try {
      setActionError(null);
      await messagesService.setConversationArchived(lawFirmId, conversationId, nextArchived);
      // Refetch the list so the row moves between inbox and archived, and the
      // sidebar unread badge (which excludes archived) plus the archive toggle's count
      // stay in step.
      await refresh();
      queryClient.invalidateQueries({ queryKey: ['archivedConversationCount', lawFirmId] });
    } catch (err) {
      setActionError(getErrorMessage(err, 'Failed to update conversation'));
    } finally {
      setArchivingId(null);
    }
  };

  const handleSelectConversation = (conversationId: string) => {
    const selected = conversations.find((c) => c.conversationId === conversationId);
    const suffix = selected?.conversationType === 'group' ? '?type=group' : '';
    navigate(`/lawfirm/${lawFirmId}/messages/${conversationId}${suffix}`);
  };

  const handleGroupCreated = (conversationId: string) => {
    navigate(`/lawfirm/${lawFirmId}/messages/${conversationId}?type=group`);
  };

  // Full-text search within message content. The same term also filters the
  // conversation list by name/title/last-preview. Opening a result routes to its
  // conversation.
  const searchMessages = useCallback(
    (q: string) => messagesService.searchMessages(lawFirmId, q),
    [lawFirmId]
  );
  const handleOpenSearchResult = (r: { conversationId: string; conversationType: 'direct' | 'group' }) => {
    const suffix = r.conversationType === 'group' ? '?type=group' : '';
    navigate(`/lawfirm/${lawFirmId}/messages/${r.conversationId}${suffix}`);
  };

  if (loading) {
    return <LoadingSpinner fullPage />;
  }

  return (
    <RequirePermission permission="messaging.view" page>
      <RequireFeature feature="messaging">
      <div className="min-h-screen bg-page">
        <div className="p-4 pl-5 md:p-6 max-w-[1600px] mx-auto space-y-6 min-w-0">

          <PageHeader
            eyebrow="Conversations"
            title="Messages"
            description={
              view === 'archived' ? (
                <>Archived conversations. They&apos;re hidden from your inbox; a new message brings one back automatically.</>
              ) : searchTerm ? (
                <>
                  <span className="font-semibold text-on-surface">{totalItems} conversation{totalItems !== 1 ? "s" : ""}</span> match your search.
                </>
              ) : (
                <>
                  View and manage your conversations with clients and your team.
                  {totalItems > 0 && (
                    <>
                      {" "}You have <span className="font-semibold text-on-surface">{totalItems} conversation{totalItems !== 1 ? "s" : ""}</span>.
                    </>
                  )}
                </>
              )
            }
            actions={
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setView((v) => (v === 'archived' ? 'active' : 'archived'))}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer whitespace-nowrap border ${
                    view === 'archived'
                      ? 'bg-accent-soft dark:bg-accent-soft border-accent-border-soft dark:border-accent-border-soft text-accent-emphasis dark:text-accent-emphasis'
                      : 'bg-surface border-outline-subtle text-on-surface hover:bg-surface-hover'
                  }`}
                >
                  {view === 'archived' ? (
                    <><Inbox size={15} /> Inbox</>
                  ) : (
                    <><Archive size={15} /> Archived{archivedTotal > 0 ? ` (${archivedTotal})` : ''}</>
                  )}
                </button>
                {hasPermission('messaging.send') && (
                  <button
                    onClick={() => setShowNewGroup(true)}
                    className="inline-flex items-center gap-1.5 bg-accent-solid hover:bg-accent-solid-hover text-accent-foreground px-4 py-2 rounded-xl text-sm font-medium transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer whitespace-nowrap"
                  >
                    <Plus size={15} />
                    New Message
                  </button>
                )}
              </div>
            }
          />

          <ErrorNotification error={error} onClose={() => {}} onRetry={refresh} />

          {/* One search term, two scopes: it filters the conversation list by
              name/title below and runs a full-text search within message content,
              whose hits render under the input. */}
          <MessageSearch
            value={search}
            onValueChange={setSearch}
            searchFn={searchMessages}
            onSelect={handleOpenSearchResult}
            placeholder="Search conversations and messages..."
          />

          {/* Conversations */}
          <div className="space-y-4">
            {/* The section header carries the "still working" line: the search
                term and the inbox/archived switch both re-read from the server
                while the current conversations stay on screen. */}
            <div className="flex items-center gap-3">
              <SectionLabel>
                All Conversations
              </SectionLabel>
              <ListBusyIndicator busy={fetching && !pagerPending} />
            </div>
            <Card>
              {conversations.length === 0 ? (
                <div className="p-8 text-center">
                  {view === 'archived' ? (
                    <Archive size={32} className="text-on-surface-muted mx-auto mb-3" />
                  ) : (
                    <MessageSquare size={32} className="text-on-surface-muted mx-auto mb-3" />
                  )}
                  <p className="text-sm text-on-surface-secondary mb-1">
                    {searchTerm
                      ? 'No conversations match your search'
                      : view === 'archived'
                        ? 'No archived conversations'
                        : 'No conversations yet'}
                  </p>
                  <p className="text-xs text-on-surface-muted">
                    {searchTerm
                      ? 'Try a different search term'
                      : view === 'archived'
                        ? 'Conversations you archive will appear here.'
                        : 'Start a new message to begin a conversation with a client'}
                  </p>
                </div>
              ) : (
                <ConversationList
                  conversations={conversations}
                  onSelect={handleSelectConversation}
                  onArchive={canManage ? handleArchive : undefined}
                  archivingId={archivingId}
                  archivedView={view === 'archived'}
                  fetching={fetching}
                />
              )}
            </Card>

            {/* The app's shared pager, so paging the inbox behaves exactly like
                paging matters or tasks. It hides itself while everything fits on
                one page. */}
            <ListPager
              page={page}
              totalPages={totalPages}
              total={totalItems}
              rowsPerPage={PAGE_SIZE}
              onPageChange={goToPage}
              busy={fetching}
              serverPaged
              onPendingChange={setPagerPending}
            />
          </div>
      </div>
        <NewGroupModal
          open={showNewGroup}
          onClose={() => setShowNewGroup(false)}
          lawFirmId={lawFirmId}
          onCreated={handleGroupCreated}
        />
        {actionError && <ErrorToast message={actionError} onDismiss={() => setActionError(null)} />}
      </div>
    </RequireFeature>
    </RequirePermission>
  );
}
