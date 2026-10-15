"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MessageSquare, Users, ChevronRight, Plus, ExternalLink } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import LoadingSpinner from "@/components/LoadingSpinner";
import ConversationView from "@/components/messagesComp/ConversationView";
import ConversationMatterTags from "@/components/messagesComp/ConversationMatterTags";
import NewGroupModal from "@/components/messagesComp/NewGroupModal";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useNavigation } from "@/contexts/NavigationContext";
import { useAuth } from "@/hooks/useAuth";
import useFirmConversations from "@/hooks/messagingHooks/useFirmConversations";
import messagesService from "@/services/messages.service";
import type { Conversation } from "@/types";
import CountPill from "@/components/ui/CountPill";
import { AutoPager } from "@/components/ui/ListPager";
import usePagedRows from "@/hooks/usePagedRows";
import SectionLabel from "@/components/ui/SectionLabel";
import Button from "@/components/ui/Button";
import ListEmptyState from "@/components/ui/ListEmptyState";

interface ClientMessagesTabProps {
  lawFirmId: string;
  // The legal client record id (clients.id). Unused by the person path (which
  // keys off clientUserId instead), required by the company path to resolve
  // the canonical company conversation.
  clientId: string;
  // The client's portal user id (conversations key on this, not the client record
  // id). Null when the client has no portal account and so can't be messaged.
  // Always null for a company (clients.user_id can never be set on a company
  // row); see clientType below.
  clientUserId: string | null;
  // 'company' switches this tab to the one canonical company conversation
  // (organization-clients plan Phase 7) instead of the clientUserId-keyed
  // direct/group lookup, which has no meaning for a company (there is no
  // single uid that represents it). Absent or 'person' keeps the original
  // behavior unchanged.
  clientType?: "person" | "company";
  clientName: string;
  clientEmail: string;
}

type Selection =
  | { kind: "direct"; conversationId: string; name: string }
  | { kind: "group"; conversationId: string; name: string };

// Messaging surface embedded in a client's detail page. Mirrors MatterMessagesTab
// but scoped to one client: it lists the 1:1 direct thread(s) with this client
// (every one, so duplicates are all reachable) and every group the client is in,
// and lets you open any of them inline. A client with a single thread and no
// groups opens straight into it.
//
// A company client (clientType === 'company') takes a different, much simpler
// path: there is exactly one canonical company conversation per firm (found or
// created automatically, never composed by hand), so this tab resolves and
// opens that one thread directly instead of listing anything.
export default function ClientMessagesTab({ lawFirmId, clientId, clientUserId, clientType, clientName, clientEmail }: ClientMessagesTabProps) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const { navigate } = useNavigation();
  const canSend = hasPermission("messaging.send");
  const currentUserId = user?.uid || "";

  const isCompany = clientType === "company";

  const [selected, setSelected] = useState<Selection | null>(null);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const autoSelectedRef = useRef(false);

  // A company can always be messaged (the canonical conversation is found or
  // created on demand); a person needs a portal account first.
  const canMessage = isCompany || !!clientUserId;

  // Existing direct threads (firm-side list), filtered to this client below.
  // Shared with ClientDetail via the ["firmConversations", lawFirmId] query key,
  // so the list is fetched once across the detail page. Disabled entirely for a
  // company: clientUserId is always null, so this lookup has nothing to match.
  const { conversations: firmConversations, loading: convLoading } = useFirmConversations(
    lawFirmId,
    !isCompany && canMessage,
    { clientId: clientUserId || undefined },
  );

  // Group threads the current firm member is in; filtered to those this client
  // participates in via the firm-side clientParticipantIds. Also disabled for a
  // company; see above.
  const { data: groupConversations = [], isLoading: groupsLoading } = useQuery<Conversation[]>({
    queryKey: ["groupConversations", lawFirmId, { clientId: clientUserId }],
    queryFn: () => messagesService.listGroups(lawFirmId, { clientId: clientUserId || undefined }),
    enabled: !isCompany && !!lawFirmId && canMessage,
    staleTime: 30_000,
  });

  // Company path: resolve the one canonical company conversation, creating it
  // on first need (mirrors the lazy creation a person's direct thread already
  // gets on first send). This fully replaces the direct/group lookups above.
  const {
    data: companyConversationId,
    isLoading: companyConvLoading,
    isError: companyConvError,
  } = useQuery<string>({
    queryKey: ["companyConversation", lawFirmId, clientId],
    queryFn: async () => (await messagesService.getCompanyConversation(lawFirmId, clientId)).conversationId,
    enabled: isCompany && !!lawFirmId && !!clientId,
    staleTime: 30_000,
  });

  const clientDirects = useMemo(
    () =>
      isCompany
        ? []
        : firmConversations.filter(
            (c) => c.conversationType !== "group" && c.clientId === clientUserId
          ),
    [isCompany, firmConversations, clientUserId]
  );

  const clientGroups = useMemo(
    () =>
      isCompany
        ? []
        : groupConversations.filter((g) => (g.clientParticipantIds || []).includes(clientUserId || "")),
    [isCompany, groupConversations, clientUserId]
  );

  // A client on many matters can be in a long tail of group threads, so the
  // rendered rows are windowed the way every other client tab's list is.
  const groupsPager = usePagedRows(clientGroups, 10);

  // A company never has a list to return to: its one canonical conversation
  // opens directly. For a person, the only case with nothing to go back to is
  // the single direct thread we auto-open; every other case reached a
  // conversation by a click on the list.
  const hasListToReturnTo = !isCompany && !(clientDirects.length === 1 && clientGroups.length === 0);

  // Open the client's direct thread. Falls back to a synthetic
  // `${lawFirmId}_${clientUserId}` key that ConversationView opens as a fresh
  // thread (created on first send) when none exists yet.
  const openDirect = (conversationId?: string) =>
    setSelected({
      kind: "direct",
      conversationId: conversationId || `${lawFirmId}_${clientUserId}`,
      name: clientName || clientEmail || "Client",
    });

  const openGroup = (g: Conversation) =>
    setSelected({ kind: "group", conversationId: g.conversationId, name: g.title || "Group conversation" });

  // With a single existing thread and nothing else, drop straight into it - but
  // only once, so backing out to the list stays put. When there are several
  // threads (or none yet) we keep the list visible so all conversations are easy
  // to see and the user can pick direct vs. a new group.
  useEffect(() => {
    if (isCompany || !canMessage || autoSelectedRef.current || selected || convLoading || groupsLoading) return;
    if (clientDirects.length === 1 && clientGroups.length === 0) {
      autoSelectedRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time auto-open of the sole thread
      openDirect(clientDirects[0].conversationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompany, canMessage, clientDirects, clientGroups, convLoading, groupsLoading, selected]);

  // Company path: there is only ever one thread, so open it as soon as it
  // resolves, unlike the person path above which has a list to pick from.
  useEffect(() => {
    if (!isCompany || autoSelectedRef.current || selected || companyConvLoading || !companyConversationId) return;
    autoSelectedRef.current = true;
    setSelected({ kind: "group", conversationId: companyConversationId, name: clientName || "Company" });
  }, [isCompany, companyConversationId, companyConvLoading, selected, clientName]);

  const handleGroupCreated = (conversationId: string) => {
    queryClient.invalidateQueries({ queryKey: ["groupConversations", lawFirmId] });
    setSelected({ kind: "group", conversationId, name: "Group conversation" });
    setShowNewGroup(false);
  };

  // Open the currently selected thread on the full Messages page. Groups need the
  // ?type=group hint (a UUID alone can't distinguish them); a not-yet-created direct
  // thread carries a synthetic `${lawFirmId}_${clientUserId}` id, which the Messages
  // page opens as a fresh thread just as this tab does.
  const openInMessages = () => {
    if (!selected) return;
    const suffix = selected.kind === "group" ? "?type=group" : "";
    navigate(`/lawfirm/${lawFirmId}/messages/${selected.conversationId}${suffix}`);
  };

  if (!canMessage) {
    return (
      <ListEmptyState
        compact
        icon={<MessageSquare size={32} />}
        title="This client can't be messaged yet"
        message="They need a portal account before you can start a conversation. Invite them from the header above."
      />
    );
  }

  if (selected) {
    return (
      <div className="flex flex-col gap-3 min-w-0">
        <div className="flex items-center justify-between gap-2">
          {/* Only offer "back to the list" when there's actually a list to go back to. */}
          {hasListToReturnTo ? (
            <button
              onClick={() => setSelected(null)}
              className="group flex items-center gap-1.5 text-sm font-medium text-on-surface-secondary hover:text-accent-emphasis dark:hover:text-accent-emphasis transition-colors cursor-pointer"
            >
              <ArrowLeft size={15} className="group-hover:-translate-x-0.5 transition-transform" />
              All conversations
            </button>
          ) : (
            <span />
          )}
          <button
            onClick={openInMessages}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-on-surface-secondary hover:text-accent-emphasis dark:hover:text-accent-emphasis transition-colors cursor-pointer"
          >
            Open in Messages
            <ExternalLink size={14} />
          </button>
        </div>
        <div className="h-[65vh] min-h-[420px] rounded-lg border border-outline-subtle overflow-hidden">
          <ConversationView
            // A direct thread is keyed by its client, not its id, so the first
            // send moving a new thread onto its real id keeps the same view
            // (and its pending bubble) instead of remounting it.
            key={selected.kind === "direct" ? `direct:${clientUserId}` : selected.conversationId}
            conversationId={selected.conversationId}
            lawFirmId={lawFirmId}
            clientId={selected.kind === "direct" ? clientUserId! : ""}
            currentUserId={currentUserId}
            isClient={false}
            isGroup={selected.kind === "group"}
            recipientName={selected.name}
            onConversationCreated={(createdId) =>
              setSelected((prev) => (prev && prev.kind === "direct" ? { ...prev, conversationId: createdId } : prev))
            }
          />
        </div>
      </div>
    );
  }

  // Company path: nothing to list, just resolving (or failing to resolve) the
  // one canonical conversation. `selected` above already handles the success
  // case, so reaching here means it's still loading or the lookup failed.
  if (isCompany) {
    if (companyConvError) {
      return (
        <ListEmptyState
          compact
          icon={<MessageSquare size={32} />}
          title="Couldn't load this conversation"
          message="Try refreshing the page."
        />
      );
    }
    return (
      <div className="py-16 flex justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (convLoading || groupsLoading) {
    return (
      <div className="py-16 flex justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h3 className="text-lg font-semibold text-on-surface">Messages</h3>
          <p className="text-sm text-on-surface-secondary">
            Every conversation with {clientName || "this client"}, their direct thread and any
            group they&apos;re in.
          </p>
        </div>
        {canSend && (
          <Button
            size="compact"
            onClick={() => setShowNewGroup(true)}
            icon={<Users size={14} />}
            className="whitespace-nowrap"
          >
            New group
          </Button>
        )}
      </div>

      <div className="space-y-6 min-w-0">
      {/* Direct thread(s). Usually one, but every match is listed so duplicate
          threads for the same client are all reachable rather than hidden. */}
      <div>
        <SectionLabel gap="2">
          Direct message
        </SectionLabel>
        {clientDirects.length === 0 ? (
          <button
            onClick={() => openDirect()}
            className="w-full flex items-center gap-3 px-4 py-3 text-left rounded-lg border border-outline-subtle hover:bg-surface-hover transition-colors cursor-pointer"
          >
            <span className="w-9 h-9 rounded-full bg-accent-soft text-accent-emphasis dark:text-accent-emphasis flex items-center justify-center shrink-0">
              <Plus size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-on-surface truncate">
                Message {clientName || clientEmail || "this client"}
              </div>
              <div className="text-xs text-on-surface-muted truncate">Start a private 1:1 thread</div>
            </div>
            <ChevronRight size={16} className="text-on-surface-muted shrink-0" />
          </button>
        ) : (
          <div className="overflow-hidden rounded-xl border border-outline bg-surface">
            {clientDirects.map((c) => (
              <button
                key={c.conversationId}
                onClick={() => openDirect(c.conversationId)}
                className="w-full flex items-center gap-3 border-b border-outline-subtle px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-surface-hover cursor-pointer"
              >
                <Avatar size="sm" name={clientName} email={clientEmail} photoUrl={c.clientPhotoUrl} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-on-surface truncate">
                    {clientName || clientEmail || "Client"}
                  </div>
                  <div className="text-xs text-on-surface-muted truncate">
                    {c.lastMessagePreview || "No messages yet"}
                  </div>
                </div>
                {!!c.unreadCountFirm && (
                  <CountPill tone="accent" count={c.unreadCountFirm} />
                )}
                <ChevronRight size={16} className="text-on-surface-muted shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Group threads the client is in */}
      {clientGroups.length > 0 && (
        <div>
          <SectionLabel gap="2">
            Group threads
          </SectionLabel>
          <div className="overflow-hidden rounded-xl border border-outline bg-surface">
            <div className="divide-y divide-outline-subtle">
              {groupsPager.pagedRows.map((g) => (
                <button
                  key={g.conversationId}
                  onClick={() => openGroup(g)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover cursor-pointer"
                >
                  <span className="w-9 h-9 rounded-full bg-accent-soft text-accent-emphasis dark:text-accent-emphasis flex items-center justify-center shrink-0">
                    <Users size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-on-surface truncate">
                      {g.title || (g.participantNames || []).join(", ") || "Group conversation"}
                    </div>
                    {g.lastMessagePreview && (
                      <div className="text-xs text-on-surface-muted truncate">{g.lastMessagePreview}</div>
                    )}
                    <ConversationMatterTags matters={g.matters} className="mt-1" />
                  </div>
                  {!!g.unreadCount && (
                    <CountPill tone="accent" count={g.unreadCount} />
                  )}
                  <ChevronRight size={16} className="text-on-surface-muted shrink-0" />
                </button>
              ))}
            </div>
            {groupsPager.total > groupsPager.rowsPerPage && (
              <div className="border-t border-outline-subtle px-4 py-2.5">
                <AutoPager pager={groupsPager} />
              </div>
            )}
          </div>
        </div>
      )}
      </div>

      <NewGroupModal
        open={showNewGroup}
        onClose={() => setShowNewGroup(false)}
        lawFirmId={lawFirmId}
        initialClientUserId={clientUserId || undefined}
        initialClientId={clientId}
        onCreated={handleGroupCreated}
      />
    </div>
  );
}
