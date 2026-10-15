"use client";

import { Users, Archive, ArchiveRestore, MessageSquare } from 'lucide-react';
import type { Conversation } from '@/types';
import { Avatar } from '@/components/ui/Avatar';
import ConversationMatterTags from '@/components/messagesComp/ConversationMatterTags';
import RowActionMenu from '@/components/ui/RowActionMenu';
import Spinner from '@/components/ui/Spinner';
import ListEmptyState from '@/components/ui/ListEmptyState';

interface ConversationListProps {
  conversations: Conversation[];
  onSelect: (conversationId: string) => void;
  currentUserId?: string;
  selectedConversationId?: string; // Added optional prop for active state styling
  // When provided, each row gets a hover archive/unarchive control. `archivedView`
  // flips it to "unarchive". Firm-side only; the client portal omits these.
  onArchive?: (conversationId: string, archived: boolean) => void;
  archivedView?: boolean;
  /**
   * Conversation whose archive/unarchive is still in flight. The row only moves
   * between inbox and archived once the refetch lands, so it is marked busy in
   * place to show the click registered.
   */
  archivingId?: string | null;
  /**
   * True while the next server page is in flight. The rows already on screen stay
   * put (the pager button carries the wait), so this only marks the list busy for
   * assistive tech, the way `ListView` does.
   */
  fetching?: boolean;
}

export default function ConversationList({
  conversations,
  onSelect,
  currentUserId,
  selectedConversationId,
  onArchive,
  archivedView = false,
  archivingId = null,
  fetching = false,
}: ConversationListProps) {
  
  // Helper to format time (memoized to prevent recalculation on render)
  const formatTime = (date: Date | string) => {
    const d = date instanceof Date ? date : new Date(date);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (days === 1) {
      return 'Yesterday';
    } else if (days < 7) {
      return d.toLocaleDateString([], { weekday: 'short' });
    } else {
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  };

  // Collapse markdown link syntax [label](url) down to just its label so the
  // preview reads as plain text instead of leaking raw markdown.
  const formatPreview = (text?: string) =>
    (text || '').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1');

  // Empty State
  if (conversations.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <ListEmptyState
          icon={<MessageSquare size={32} />}
          title="No messages yet"
          message="Your conversations will appear here."
        />
      </div>
    );
  }

  return (
    <div
      aria-busy={fetching}
      className="flex flex-col h-full overflow-y-auto overflow-x-hidden divide-y divide-outline-subtle bg-surface"
    >
      {conversations.map((conversation) => {
        const isGroup = conversation.conversationType === 'group';
        // For direct rows the viewer is the client when their uid matches the
        // conversation's client_id. Group rows carry a single per-viewer unread.
        const isClient = currentUserId === conversation.clientId;
        const unreadCount = isGroup
          ? (conversation.unreadCount || 0)
          : (isClient ? conversation.unreadCountClient : conversation.unreadCountFirm);

        // Group rows read as their member list (the other participants, comma-
        // separated) so an untitled thread isn't just "Group conversation". A
        // custom title, when set, still wins; the member list is the fallback.
        const memberList = conversation.participantNames?.filter(Boolean).join(', ');
        const displayName = isGroup
          ? (conversation.title || memberList || 'Group conversation')
          : (isClient ? (conversation.lawFirmName || 'Law Firm') : conversation.clientName);
        // Direct firm-side rows can show the client's avatar; the client viewing a
        // firm has no per-user photo, so it falls back to initials.
        const directPhotoUrl = !isGroup && !isClient ? conversation.clientPhotoUrl : null;
        const isActive = selectedConversationId === conversation.conversationId;

        return (
          <div
            key={conversation.conversationId}
            role="button"
            aria-label={`Open conversation with ${displayName}${unreadCount > 0 ? `, ${unreadCount} unread ${unreadCount === 1 ? 'message' : 'messages'}` : ''}`}
            aria-pressed={isActive}
            tabIndex={0}
            onClick={() => onSelect(conversation.conversationId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(conversation.conversationId);
              }
            }}
            className={`
              relative flex items-center gap-3 p-4 w-full text-left transition-all duration-200 cursor-pointer
              focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring
              ${isActive ? 'bg-blue-500/10 dark:bg-blue-500/15' : 'hover:bg-surface-hover'}
            `}
          >
            {/* Active Indicator Line */}
            {isActive && (
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-accent-solid rounded-r" />
            )}

            {/* Avatar */}
            <div className="flex-shrink-0">
              {isGroup ? (
                <div className="w-10 h-10 rounded-full flex items-center justify-center bg-accent-soft text-accent-emphasis dark:text-accent-emphasis">
                  <Users size={18} />
                </div>
              ) : (
                <Avatar name={displayName} photoUrl={directPhotoUrl} size="md" />
              )}
            </div>

            {/* Content Container */}
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between mb-1">
                <h3 className={`
                  min-w-0 flex-1 truncate text-sm font-medium
                  ${unreadCount > 0 ? 'text-on-surface font-semibold' : 'text-on-surface-secondary'}
                `}>
                  {displayName}
                </h3>
                <span className={`
                  text-xs whitespace-nowrap ml-2
                  ${unreadCount > 0 ? 'text-accent-emphasis font-medium' : 'text-on-surface-muted'}
                `}>
                  {formatTime(conversation.lastMessageAt)}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <p className={`
                  min-w-0 flex-1 truncate text-sm
                  ${unreadCount > 0 ? 'text-on-surface-secondary font-medium' : 'text-on-surface-muted'}
                `}>
                  {formatPreview(conversation.lastMessagePreview)}
                </p>

                {/* Unread Badge */}
                {unreadCount > 0 && (
                  <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[10px] font-bold text-accent-foreground bg-accent-solid rounded-full shadow-sm">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </div>

              {/* Linked matter(s), when the thread is scoped to any */}
              <ConversationMatterTags matters={conversation.matters} className="mt-1.5" />
            </div>

            {/* Row action menu (firm-side only): three-dots → Archive/Unarchive.
                A real flex sibling, centered by the row's own `items-center`
                rather than an absolute overlay, so it always lines up with
                the avatar regardless of how many matter tags a conversation
                has. */}
            {onArchive && (
              <div
                className="shrink-0"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {archivingId === conversation.conversationId ? (
                  <Spinner size={15} className="text-on-surface-muted" label="Updating conversation" />
                ) : (
                  <RowActionMenu
                    ariaLabel="Conversation actions"
                    actions={[
                      {
                        label: archivedView ? 'Unarchive' : 'Archive',
                        icon: archivedView ? <ArchiveRestore size={15} /> : <Archive size={15} />,
                        onClick: () => onArchive(conversation.conversationId, !archivedView),
                      },
                    ]}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
