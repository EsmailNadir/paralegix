"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MessageSquare, Users, ChevronRight, ExternalLink, UserPlus } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import LoadingSpinner from "@/components/LoadingSpinner";
import ConversationView from "@/components/messagesComp/ConversationView";
import ConversationMatterTags from "@/components/messagesComp/ConversationMatterTags";
import NewGroupModal from "@/components/messagesComp/NewGroupModal";
import InviteMatterClientsModal from "@/components/matterComp/InviteMatterClientsModal";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useNavigation } from "@/contexts/NavigationContext";
import messagesService from "@/services/messages.service";
import clientsService from "@/services/clients.service";
import mattersService from "@/services/matters.service";
import type { Conversation } from "@/types";
import ListEmptyState from "@/components/ui/ListEmptyState";
import CountPill from "@/components/ui/CountPill";
import SectionLabel from "@/components/ui/SectionLabel";
import Button from "@/components/ui/Button";

interface MatterMessagesTabProps {
  lawFirmId: string;
  matterId: string;
  currentUserId: string;
}

type Selection =
  | { kind: "direct"; conversationId: string; clientUserId: string; name: string }
  | { kind: "group"; conversationId: string; name: string };

// Messaging surface embedded in a matter. Lists the matter's portal clients (each
// opens a 1:1 direct thread - so you can message one client without the others)
// and any group threads scoped to this matter, plus a "new group for this matter"
// action. A single-client matter opens straight into that client's thread.
export default function MatterMessagesTab({ lawFirmId, matterId, currentUserId }: MatterMessagesTabProps) {
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const { navigate } = useNavigation();
  const canSend = hasPermission("messaging.send");
  const canInvite = hasPermission("clients.invite");

  const [selected, setSelected] = useState<Selection | null>(null);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const autoSelectedRef = useRef(false);

  // Portal clients on this matter (only those with a portal account can be messaged).
  const { data: portalClients = [], isLoading: clientsLoading } = useQuery({
    queryKey: ["portalClients", lawFirmId, matterId],
    queryFn: async () => {
      const result = await clientsService.lookupClients(lawFirmId, {
        matterId,
        portalOnly: true,
        limit: 200,
        full: true,
      });
      return result.items.map((item) => {
        const fullItem = item as typeof item & { email?: string | null };
        return {
          id: item.id,
          userId: item.userId,
          name: item.label,
          email: fullItem.email || "",
          matterIds: [matterId],
        };
      });
    },
    enabled: !!lawFirmId,
    staleTime: 5 * 60_000,
  });

  // Existing direct threads, so a client with history opens by its real id.
  const { data: firmConversations = [], isLoading: convLoading } = useQuery<Conversation[]>({
    queryKey: ["firmConversations", lawFirmId, { clientIds: portalClients.map((c) => c.userId) }],
    queryFn: () => messagesService.getFirmConversations(lawFirmId, {
      clientIds: portalClients.map((c) => c.userId).filter((id): id is string => !!id),
    }),
    enabled: !!lawFirmId && !clientsLoading && portalClients.some((c) => !!c.userId),
    staleTime: 30_000,
  });

  // Group threads scoped to this matter (matterIds carries the full scope set).
  const { data: groupConversations = [], isLoading: groupsLoading } = useQuery<Conversation[]>({
    queryKey: ["groupConversations", lawFirmId, { matterId }],
    queryFn: () => messagesService.listGroups(lawFirmId, { matterId }),
    enabled: !!lawFirmId,
    staleTime: 30_000,
  });

  const matterClients = useMemo(
    () => portalClients.filter((c) => !!c.userId && (c.matterIds || []).includes(matterId)),
    [portalClients, matterId]
  );

  // All clients on the matter (portal or not), just to count who's missing
  // portal access - drives the "Invite clients" action below.
  const { data: allMatterClients = [] } = useQuery({
    queryKey: ["matterClients", lawFirmId, matterId],
    queryFn: () => mattersService.listClients(lawFirmId, matterId),
    enabled: !!lawFirmId && !!matterId,
    staleTime: 60_000,
  });
  const uninvitedCount = allMatterClients.filter((c) => c.clientType !== "company" && !c.userId).length;

  const matterGroups = useMemo(
    () => groupConversations.filter((g) => (g.matterIds || []).includes(matterId)),
    [groupConversations, matterId]
  );

  // Resolve the existing direct conversation id for a client, or a synthetic
  // `${lawFirmId}_${clientUserId}` key that ConversationView opens as a fresh
  // thread (created on first send).
  const directIdFor = (clientUserId: string) => {
    const existing = firmConversations.find(
      (c) => c.conversationType !== "group" && c.clientId === clientUserId
    );
    return existing?.conversationId || `${lawFirmId}_${clientUserId}`;
  };

  const openClient = (clientUserId: string, name: string) =>
    setSelected({ kind: "direct", conversationId: directIdFor(clientUserId), clientUserId, name });

  const openGroup = (g: Conversation) =>
    setSelected({ kind: "group", conversationId: g.conversationId, name: g.title || "Group conversation" });

  // A matter with exactly one client and no groups opens straight into that
  // client's thread (only once, so backing out to the list stays put).
  useEffect(() => {
    // Wait for ALL THREE queries: without the conversation list, directIdFor
    // would fall back to a synthetic id and open an empty thread instead of
    // history; without the group list, a matter with one client AND an
    // already-existing group could wrongly auto-open the client thread before
    // the group is known to exist.
    if (autoSelectedRef.current || selected || clientsLoading || convLoading || groupsLoading) return;
    if (matterClients.length === 1 && matterGroups.length === 0) {
      autoSelectedRef.current = true;
      const c = matterClients[0];
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time auto-open of the sole client's thread
      openClient(c.userId!, c.name || c.email || "Client");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matterClients, matterGroups, clientsLoading, convLoading, groupsLoading, selected]);

  const handleGroupCreated = (conversationId: string) => {
    queryClient.invalidateQueries({ queryKey: ["groupConversations", lawFirmId] });
    setSelected({ kind: "group", conversationId, name: "Group conversation" });
    setShowNewGroup(false);
  };

  // Open the currently selected thread on the full Messages page. Groups need the
  // ?type=group hint (a UUID alone can't distinguish them); direct threads may use
  // a synthetic `${lawFirmId}_${clientUserId}` id, which the Messages page opens as
  // a fresh thread just as this tab does.
  const openInMessages = () => {
    if (!selected) return;
    const suffix = selected.kind === "group" ? "?type=group" : "";
    navigate(`/lawfirm/${lawFirmId}/messages/${selected.conversationId}${suffix}`);
  };

  if (selected) {
    return (
      <div className="flex flex-col gap-3 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => setSelected(null)}
            className="group flex items-center gap-1.5 text-sm font-medium text-on-surface-secondary hover:text-accent-emphasis dark:hover:text-accent-emphasis transition-colors cursor-pointer"
          >
            <ArrowLeft size={15} className="group-hover:-translate-x-0.5 transition-transform" />
            Back to matter messages
          </button>
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
            key={selected.kind === "direct" ? `direct:${selected.clientUserId}` : selected.conversationId}
            conversationId={selected.conversationId}
            lawFirmId={lawFirmId}
            clientId={selected.kind === "direct" ? selected.clientUserId : ""}
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

  if (clientsLoading || convLoading || groupsLoading) {
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
            Message a client on this matter, or a group scoped to it.
          </p>
        </div>
        {canSend && matterClients.length > 0 && (
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
      {/* Group threads scoped to this matter */}
      {matterGroups.length > 0 && (
        <div>
          <SectionLabel gap="2">
            Group threads
          </SectionLabel>
          <div className="overflow-hidden rounded-xl border border-outline bg-surface">
            {matterGroups.map((g) => (
              <button
                key={g.conversationId}
                onClick={() => openGroup(g)}
                className="w-full flex items-center gap-3 border-b border-outline-subtle px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-surface-hover cursor-pointer"
              >
                <span className="w-9 h-9 rounded-full bg-accent-soft text-accent-emphasis dark:text-accent-emphasis flex items-center justify-center shrink-0">
                  <Users size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-on-surface truncate">
                    {g.title || "Group conversation"}
                  </div>
                  {g.lastMessagePreview && (
                    <div className="text-xs text-on-surface-muted truncate">{g.lastMessagePreview}</div>
                  )}
                  {/* Only OTHER matters this group is also linked to - the current
                      matter is implied by context here. */}
                  <ConversationMatterTags
                    matters={(g.matters || []).filter((m) => m.id !== matterId)}
                    className="mt-1"
                  />
                </div>
                {!!g.unreadCount && (
                  <CountPill tone="accent" count={g.unreadCount} />
                )}
                <ChevronRight size={16} className="text-on-surface-muted shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Individual clients on the matter */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <SectionLabel>
            Clients
          </SectionLabel>
          {canInvite && uninvitedCount > 0 && (
            <button
              onClick={() => setShowInvite(true)}
              className="inline-flex items-center gap-1 text-xs font-medium text-accent-emphasis hover:underline cursor-pointer"
            >
              <UserPlus size={12} /> Invite clients ({uninvitedCount})
            </button>
          )}
        </div>
        {matterClients.length === 0 ? (
          <ListEmptyState
            compact
            icon={<MessageSquare size={32} />}
            title="No portal clients on this matter"
            message="A client needs a portal account before they can be messaged here."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-outline bg-surface">
            {matterClients.map((c) => {
              const unread = firmConversations.find(
                (conv) => conv.conversationType !== "group" && conv.clientId === c.userId
              )?.unreadCountFirm;
              return (
                <button
                  key={c.userId}
                  onClick={() => openClient(c.userId!, c.name || c.email || "Client")}
                  className="w-full flex items-center gap-3 border-b border-outline-subtle px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-surface-hover cursor-pointer"
                >
                  <Avatar size="sm" name={c.name} email={c.email} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-on-surface truncate">{c.name || c.email}</div>
                    {c.email && <div className="text-xs text-on-surface-muted truncate">{c.email}</div>}
                  </div>
                  {!!unread && (
                    <CountPill tone="accent" count={unread} />
                  )}
                  <ChevronRight size={16} className="text-on-surface-muted shrink-0" />
                </button>
              );
            })}
          </div>
        )}
      </div>
      </div>

      <NewGroupModal
        open={showNewGroup}
        onClose={() => setShowNewGroup(false)}
        lawFirmId={lawFirmId}
        initialMatterId={matterId}
        onCreated={handleGroupCreated}
      />

      <InviteMatterClientsModal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        lawFirmId={lawFirmId}
        matterId={matterId}
      />
    </div>
  );
}
