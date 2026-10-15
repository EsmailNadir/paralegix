"use client";

import { useEffect, useMemo, Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { useConversations } from '@/hooks/useConversations';
import ConversationView from '@/components/messagesComp/ConversationView';
import { ArrowLeft, User, Building2, Users } from 'lucide-react';
import { useNavigation } from '@/contexts/NavigationContext';
import { useClientPortal } from '@/contexts/ClientPortalContext';
import TabBar from '@/components/ui/TabBar';
import LoadingSpinner from '@/components/LoadingSpinner';
import clientPortalService from '@/services/client-portal.service';
import type { PortalConversationSummary } from '@/types';

// The icon/label a switcher row shows for one conversation, distinguishing a
// person's own direct thread from a company's canonical (or an ad-hoc) group
// thread. Mirrors the Building2/User convention `ClientRecordPicker` uses for the
// same person/company distinction elsewhere in the portal.
function conversationIcon(c: PortalConversationSummary) {
  if (c.conversationType === 'direct') return User;
  return c.clientType === 'company' ? Building2 : Users;
}

function conversationLabel(c: PortalConversationSummary) {
  if (c.conversationType === 'direct') return 'Personal';
  return c.title || (c.clientType === 'company' ? 'Organization' : 'Group conversation');
}

// useSearchParams requires a Suspense boundary during the Next.js build.
export default function ClientConversationPage() {
  return (
    <Suspense fallback={null}>
      <ClientConversationContent />
    </Suspense>
  );
}

function ClientConversationContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const { navigate } = useNavigation();
  const { user } = useAuth();
  const lawFirmId = params.lawFirmId as string;
  // The `c` query param names the open conversation. The all-firms list, a
  // search result, the dashboard's per-firm shortcut and the switcher below all
  // write it, so Back and Forward move between threads.
  const cParam = searchParams.get('c');
  // The client layout already fetched the client's firms and this firm's client
  // records; read both from that shared context instead of re-requesting them.
  const { lawFirms, associations } = useClientPortal();
  const queryClient = useQueryClient();
  const lawFirmName = lawFirms.find((firm) => firm.id === lawFirmId)?.name || null;

  // Every conversation this client participates in for this one firm - their
  // direct thread (if any) plus every group thread (a company's canonical
  // conversation for each company association, and any ad-hoc group), each
  // tagged with which client record it belongs to. Organization-clients plan
  // Phase 7.
  const { data, isLoading } = useQuery({
    queryKey: ['portalConversations', lawFirmId],
    queryFn: () => clientPortalService.listConversations(lawFirmId),
    enabled: !!lawFirmId,
    staleTime: 15_000,
  });

  // The switcher's unread counts come from the list above, so it is re-read
  // whenever a thread is marked read and on every live conversation change.
  // `useConversations` holds the Realtime subscription to this client's
  // conversation rows (direct and group alike) and announces each change as
  // `unread-count-updated`, so activity in a thread that is not open still
  // reaches its tab.
  useConversations({ isClient: true });
  useEffect(() => {
    const refetchList = () => {
      queryClient.invalidateQueries({ queryKey: ['portalConversations', lawFirmId] });
    };
    window.addEventListener('messages-marked-read', refetchList);
    window.addEventListener('unread-count-updated', refetchList);
    return () => {
      window.removeEventListener('messages-marked-read', refetchList);
      window.removeEventListener('unread-count-updated', refetchList);
    };
  }, [queryClient, lawFirmId]);

  // The personal thread is keyed `${lawFirmId}_${uid}` until its row exists.
  // A client with a person record can always start it, so the switcher offers
  // it even when the list holds only group threads (the server also lists it
  // under that key, and then it is not added twice).
  const personalKey = user ? `${lawFirmId}_${user.uid}` : '';
  const personRecord = associations.find((a) => a.clientType === 'person') || null;
  const conversations = useMemo(() => {
    const listed = data?.conversations ?? [];
    if (!personalKey || !personRecord || listed.some((c) => c.conversationType === 'direct')) return listed;
    const personal: PortalConversationSummary = {
      conversationId: personalKey,
      conversationType: 'direct',
      clientRecordId: personRecord.clientRecordId,
      clientType: 'person',
      title: '',
      lastMessageAt: null,
      lastMessagePreview: '',
      unreadCount: 0,
      archivedAt: null,
    };
    return [...listed, personal];
  }, [data, personalKey, personRecord]);

  if (!user) {
    return <div>Not authenticated</div>;
  }

  // The url names the open thread. Without one (or with one this client no
  // longer has) the most recently active conversation opens, the list being
  // server-sorted newest-first; a single conversation needs no switcher. The
  // personal key always names the direct thread, whichever id it now has.
  const fromUrl = cParam
    ? conversations.find((c) => c.conversationId === cParam)
      || (cParam === personalKey ? conversations.find((c) => c.conversationType === 'direct') : undefined)
    : undefined;
  const selected = fromUrl || conversations[0] || null;
  const isGroup = selected?.conversationType === 'group';
  // Group threads use their real conversation id. The direct thread - including a
  // brand-new client with no conversations at all yet - uses the synthetic
  // `${lawFirmId}_${uid}` key the client-portal direct-thread path keys off of.
  const conversationId = isGroup ? selected!.conversationId : personalKey;
  const clientId = user.uid;

  const handleSelect = (id: string) => {
    navigate(`/client/messages/${lawFirmId}?c=${encodeURIComponent(id)}`);
  };

  return (
    // Mobile: viewport height minus the fixed h-14 top bar (dvh tracks the
    // browser chrome) so the page itself never scrolls, only the message
    // list does. Desktop has no top bar.
    <div className="h-[calc(100dvh-3.5rem)] md:h-screen overflow-hidden flex flex-col bg-page">
      <div className="flex-1 flex flex-col p-3 md:p-6 max-w-[1600px] mx-auto w-full gap-3 md:gap-4 min-h-0">

        {/* Back Link */}
        <button
          onClick={() => navigate('/client/messages')}
          className="group flex items-center gap-1.5 text-sm font-medium text-on-surface-secondary hover:text-accent-emphasis dark:hover:text-accent-emphasis transition-colors flex-shrink-0 cursor-pointer"
        >
          <ArrowLeft size={15} className="group-hover:-translate-x-0.5 transition-transform" />
          All Messages
        </button>

        {/* Conversation Card */}
        <div className="flex-1 min-h-0 flex flex-col">
          {isLoading ? (
            <div className="flex-1 min-h-0 flex items-center justify-center bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
              <LoadingSpinner />
            </div>
          ) : (
            <>
              {/* Conversation switcher: only shown when there's genuinely a
                  choice (a company association's canonical thread alongside the
                  personal direct thread, or more than one company). */}
              {conversations.length > 1 && (
                <div className="shrink-0 bg-surface rounded-t-2xl border border-b-0 border-outline-subtle px-2">
                  <TabBar
                    value={selected?.conversationId || conversations[0].conversationId}
                    onChange={handleSelect}
                    density="compact"
                    tabs={conversations.map((c) => ({
                      value: c.conversationId,
                      label: conversationLabel(c),
                      icon: conversationIcon(c),
                      count: c.unreadCount,
                    }))}
                  />
                </div>
              )}
              <div
                className={`bg-surface border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden flex-1 min-h-0 ${
                  conversations.length > 1 ? 'rounded-b-2xl' : 'rounded-2xl'
                }`}
              >
                <ConversationView
                  conversationId={conversationId}
                  lawFirmId={lawFirmId}
                  clientId={clientId}
                  currentUserId={user.uid}
                  isClient={true}
                  isGroup={isGroup}
                  recipientName={isGroup ? undefined : (lawFirmName || undefined)}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
