"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UserPlus, Minus, Search, Users, RotateCcw } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import Button from "@/components/ui/Button";
import EntityMultiPicker from "@/components/ui/EntityMultiPicker";
import SelectablePersonList from "@/components/ui/SelectablePersonList";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { useFirmMembers } from "@/hooks/useFirmMembers";
import messagesService from "@/services/messages.service";
import type { GroupParticipant, PendingGroupClient } from "@/types";
import SectionLabel from "@/components/ui/SectionLabel";

// Mirrors the backend's cap on `organizationClientIds` (messaging.validation.ts).
const MAX_ORGANIZATIONS = 20;

interface GroupParticipantsProps {
  lawFirmId: string;
  conversationId: string;
  participants: GroupParticipant[];
  canManage: boolean;
  // Adding a colleague only needs `messaging.send`; adding a CLIENT hands someone
  // outside the firm a way into the correspondence, so it carries its own
  // permission. False hides the client and organization pickers rather than
  // letting the add fail on the server.
  canAddClients?: boolean;
  currentUserId: string;
  // People who were on this thread before and were removed from it, by portal uid
  // and by client record id (the two keys the pickers select on). Marked in the
  // picker, and they flip the history toggle's default: putting someone back
  // should not silently replay what was said while they were away.
  removedParticipantIds?: string[];
  removedClientRecordIds?: string[];
  // People the firm already added who have no portal account yet. They sit on
  // the thread's pending list rather than its participant list, and join it the
  // day they register. Shown so the roster reflects everyone the firm chose,
  // instead of leaving them invisible until they turn up on their own.
  pendingClients?: PendingGroupClient[];
  // Whether the group is scoped to at least one matter. Drives the "adding a
  // client to an unscoped multi-client group" confirmation. Defaults to false
  // (the conservative choice: confirm when scope is unknown).
  groupHasMatter?: boolean;
  // False when the thread is still a direct (1:1) conversation. Both add and
  // remove are offered: on a 1:1 each converts the thread into a group in place
  // (the only way to enforce per-person membership). Drives the confirm copy.
  isGroupThread?: boolean;
  // When true, render as bare modal-body content (no inline-panel chrome) so a
  // parent modal supplies the surface, padding, and title.
  bare?: boolean;
  onChanged: () => void;
  // Fired once when an add converted a direct thread into a group.
  onConverted?: () => void;
}

export default function GroupParticipants({
  lawFirmId,
  conversationId,
  participants,
  canManage,
  canAddClients = false,
  currentUserId,
  removedParticipantIds = [],
  removedClientRecordIds = [],
  pendingClients = [],
  groupHasMatter = false,
  isGroupThread = true,
  bare = false,
  onChanged,
  onConverted,
}: GroupParticipantsProps) {
  const queryClient = useQueryClient();
  const members = useFirmMembers(lawFirmId);
  const [adding, setAdding] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [selectedClientUserIds, setSelectedClientUserIds] = useState<string[]>([]);
  const [selectedClientRecordIds, setSelectedClientRecordIds] = useState<string[]>([]);
  const [removePendingTarget, setRemovePendingTarget] = useState<PendingGroupClient | null>(null);
  // Company `clients.id`s picked via the org quick-add. Each is expanded
  // server-side to that company's whole portal-enabled roster and merged with
  // selectedClientUserIds (organization-clients plan Phase 7).
  const [selectedOrgIds, setSelectedOrgIds] = useState<string[]>([]);
  // One choice for the whole batch of added clients: may they read messages sent
  // before they joined? Left alone it follows the selection - true, except when
  // someone in it is coming back to a thread they were removed from, where the
  // safe answer is not to replay what they missed. Touching the switch pins it.
  const [shareHistoryChoice, setShareHistoryChoice] = useState(true);
  const [shareHistoryTouched, setShareHistoryTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<GroupParticipant | null>(null);
  // Shown before adding a client that would leave a multi-client group unscoped
  // to any matter (mirrors the create-time confirmation).
  const [confirmAdd, setConfirmAdd] = useState(false);

  // The portal UIDs already in the conversation. Firm members are matched against
  // it directly; the client picker takes it as `excludeIds`, which it keys the
  // same way (by portal UID), so nobody already here is offered again.
  const existingUserIds = useMemo(() => participants.map((p) => p.userId), [participants]);
  const existingIds = useMemo(() => new Set(existingUserIds), [existingUserIds]);

  const addableMembers = useMemo(
    () => members.filter((m) => !existingIds.has(m.id)),
    [members, existingIds]
  );

  // Firm members are a bounded in-memory list, so their search stays local.
  const filteredAddMembers = useMemo(() => {
    const q = addSearch.trim().toLowerCase();
    if (!q) return addableMembers;
    return addableMembers.filter((m) =>
      `${m.name ?? ""} ${m.email ?? ""}`.toLowerCase().includes(q)
    );
  }, [addableMembers, addSearch]);

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  // "Add all" quick action for the firm-member picker: select every colleague not
  // already in the group (ignores the search filter so it always means the whole
  // firm), toggling back to clear.
  const allAddableMemberIds = useMemo(() => addableMembers.map((m) => m.id), [addableMembers]);
  const allAddableMembersSelected =
    allAddableMemberIds.length > 0 && allAddableMemberIds.every((id) => selectedMemberIds.includes(id));
  const toggleAllAddableMembers = () =>
    setSelectedMemberIds(allAddableMembersSelected ? [] : allAddableMemberIds);

  const resetAdd = () => {
    setSelectedMemberIds([]);
    setSelectedClientUserIds([]);
    setSelectedClientRecordIds([]);
    setSelectedOrgIds([]);
    setShareHistoryChoice(true);
    setShareHistoryTouched(false);
    setAddSearch("");
    setAdding(false);
    setError(null);
  };

  const removedUserIdSet = useMemo(() => new Set(removedParticipantIds), [removedParticipantIds]);
  const removedClientIdSet = useMemo(() => new Set(removedClientRecordIds), [removedClientRecordIds]);
  const returningSelected =
    selectedMemberIds.some((id) => removedUserIdSet.has(id))
    || selectedClientUserIds.some((id) => removedUserIdSet.has(id))
    || selectedClientRecordIds.some((id) => removedClientIdSet.has(id));
  const shareHistory = shareHistoryTouched ? shareHistoryChoice : !returningSelected;
  const returningMeta = (
    <span className="flex items-center gap-1 text-xs text-on-surface-muted">
      <RotateCcw size={12} />
      Was removed
    </span>
  );

  const existingClientCount = participants.filter((p) => p.type === "client").length;
  // Adding a client (or an organization, which expands to its whole roster) that
  // leaves the group with more than one client and no matter scope warrants the
  // same confirmation as creating such a group.
  const wouldNeedConfirm =
    (selectedClientUserIds.length > 0 || selectedClientRecordIds.length > 0 || selectedOrgIds.length > 0)
    && (existingClientCount + selectedClientUserIds.length + selectedClientRecordIds.length > 1 || selectedOrgIds.length > 0)
    && !groupHasMatter;

  const doAdd = async () => {
    try {
      setBusy(true);
      setError(null);
      const result = await messagesService.addGroupParticipants(lawFirmId, conversationId, {
        memberIds: selectedMemberIds,
        clientIds: selectedClientUserIds,
        clientRecordIds: selectedClientRecordIds,
        organizationClientIds: selectedOrgIds,
        // Only meaningful when adding clients; harmless otherwise (firm members
        // always see full history).
        shareHistory: selectedClientUserIds.length > 0 || selectedClientRecordIds.length > 0 || selectedOrgIds.length > 0 ? shareHistory : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["groupConversations", lawFirmId] });
      resetAdd();
      onChanged();
      // Adding to a 1:1 converts it to a group in place; tell the parent so the
      // open view reloads in group mode.
      if (result?.converted) onConverted?.();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to add participants."));
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = () => {
    if (selectedMemberIds.length === 0 && selectedClientUserIds.length === 0 && selectedClientRecordIds.length === 0 && selectedOrgIds.length === 0) {
      setError("Select at least one person or organization to add.");
      return;
    }
    if (wouldNeedConfirm) {
      setConfirmAdd(true);
      return;
    }
    doAdd();
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    try {
      setBusy(true);
      const result = await messagesService.removeGroupParticipant(lawFirmId, conversationId, removeTarget.userId);
      queryClient.invalidateQueries({ queryKey: ["groupConversations", lawFirmId] });
      setRemoveTarget(null);
      onChanged();
      // Removing from a 1:1 converts it to a group in place (the only way to
      // enforce membership); tell the parent so the open view reloads in group mode.
      if (result?.converted) onConverted?.();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to remove participant."));
      setRemoveTarget(null);
    } finally {
      setBusy(false);
    }
  };

  // The remove confirmation adapts to the thread and the person. On a real group
  // it's a plain removal; on a 1:1 removing anyone converts the thread to a group
  // the firm manages, and removing the client leaves it firm-only (internal).
  const removeMessage = (() => {
    const who = removeTarget?.name || removeTarget?.email || "this participant";
    if (isGroupThread) {
      return `Remove ${who} from the group? They will no longer see new messages.`;
    }
    if (removeTarget?.type === "client") {
      return `Remove ${who} from this conversation? They lose access and it becomes an internal, firm-only thread. Colleagues who aren't participants also lose the firm-wide access they have to it now.`;
    }
    return `Remove ${who} from this conversation? This turns it into a group your firm manages, and they will no longer have access. Colleagues who aren't participants also lose the firm-wide access they have to it now.`;
  })();

  const clientParticipants = participants.filter((p) => p.type === "client");
  const firmParticipants = participants.filter((p) => p.type !== "client");

  const handleRemovePending = async () => {
    if (!removePendingTarget) return;
    try {
      setBusy(true);
      await messagesService.removePendingGroupClient(
        lawFirmId,
        conversationId,
        removePendingTarget.clientRecordId,
      );
      queryClient.invalidateQueries({ queryKey: ["groupConversations", lawFirmId] });
      setRemovePendingTarget(null);
      onChanged();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to remove pending recipient."));
      setRemovePendingTarget(null);
    } finally {
      setBusy(false);
    }
  };

  // One grouped section (Clients / Firm) rendered as a vertical list. Returns
  // null for an empty group so a firm-only or client-only thread shows just the
  // one relevant heading.
  const renderGroup = (title: string, list: GroupParticipant[]) => {
    if (list.length === 0) return null;
    return (
      <div>
        <p className="px-1 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-muted">
          {title} ({list.length})
        </p>
        <ul className="space-y-0.5">
          {list.map((p) => (
            <li
              key={p.userId}
              className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover transition-colors"
            >
              <Avatar
                size="sm"
                name={p.name}
                email={p.email}
                photoUrl={p.photoUrl}
                // The collapsed firm entry (client viewers) uses the firm's
                // logo/wordmark, which must be letterboxed, not cropped in half.
                fit={p.userId === '__firm__' ? 'contain' : 'cover'}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-on-surface truncate">
                  {p.name || p.email}
                  {p.userId === currentUserId && " (you)"}
                </p>
                {p.name && p.email && (
                  <p className="text-xs text-on-surface-muted truncate">{p.email}</p>
                )}
              </div>
              {canManage && p.userId !== currentUserId && (
                <button
                  onClick={() => setRemoveTarget(p)}
                  aria-label={`Remove ${p.name || p.email}`}
                  className="shrink-0 rounded-md p-1 text-on-surface-muted hover:text-red-600 hover:bg-surface dark:hover:text-red-400 transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                >
                  <Minus size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  // Recipients the firm added before they had a portal account. Same row
  // skeleton as a real participant, with the wait spelled out: they are on the
  // thread by the firm's choice, they just cannot read it yet.
  const renderPendingGroup = () => {
    if (pendingClients.length === 0) return null;
    return (
      <div>
        <p className="px-1 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-muted">
          Waiting to join ({pendingClients.length})
        </p>
        <ul className="space-y-0.5">
          {pendingClients.map((c) => (
            <li
              key={c.clientRecordId}
              className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover transition-colors"
            >
              <Avatar size="sm" name={c.name} email={c.email} photoUrl={null} />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-on-surface truncate">{c.name || c.email}</p>
                <p className="text-xs text-on-surface-muted truncate">
                  {c.email ? `${c.email} · ` : ""}No portal account yet
                </p>
              </div>
              {canManage && canAddClients && (
                <button
                  onClick={() => setRemovePendingTarget(c)}
                  aria-label={`Remove ${c.name || c.email}`}
                  className="shrink-0 rounded-md p-1 text-on-surface-muted hover:text-red-600 hover:bg-surface dark:hover:text-red-400 transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                >
                  <Minus size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <div className={bare ? "" : "border-b border-outline-subtle bg-surface-alt px-6 py-4"}>
      <div className={`flex items-center ${bare ? "justify-end" : "justify-between"} mb-3`}>
        {!bare && (
          <SectionLabel>
            Participants ({participants.length})
          </SectionLabel>
        )}
        {canManage && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-emphasis hover:underline cursor-pointer"
          >
            <UserPlus size={13} /> Add participant
          </button>
        )}
      </div>

      <ErrorNotification error={error} onClose={() => setError(null)} />

      <div className="space-y-4">
        {renderGroup("Clients", clientParticipants)}
        {renderPendingGroup()}
        {renderGroup("Firm members", firmParticipants)}
      </div>

      {adding && (
        <div className="mt-4 space-y-3 rounded-lg border border-outline-subtle bg-surface p-3">
          {!isGroupThread && (
            <p className="text-xs text-on-surface-muted">
              Adding someone turns this conversation into a group. Everyone you add can see the
              messages already in it, and colleagues who aren&apos;t participants will lose the
              firm-wide access they have to this thread now.
            </p>
          )}
          <div>
            <div className="flex items-center justify-between px-1 pb-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-muted">
                Firm members
              </p>
              {addableMembers.length > 1 && (
                <button
                  type="button"
                  onClick={toggleAllAddableMembers}
                  className="text-[11px] font-medium text-accent-emphasis hover:underline cursor-pointer"
                >
                  {allAddableMembersSelected ? "Clear all" : "Add whole firm"}
                </button>
              )}
            </div>
            <div className="relative mb-1.5">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-muted pointer-events-none" />
              <input
                autoFocus
                value={addSearch}
                onChange={(e) => setAddSearch(e.target.value)}
                placeholder="Search firm members..."
                className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-8 pr-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
            <div className="max-h-40 overflow-y-auto overflow-x-hidden styled-scrollbar rounded-md border border-outline-subtle">
              {addableMembers.length === 0 ? (
                <p className="px-3 py-4 text-sm text-on-surface-muted text-center">
                  No other firm members to add.
                </p>
              ) : filteredAddMembers.length === 0 ? (
                <p className="px-3 py-4 text-sm text-on-surface-muted text-center">
                  No members match your search.
                </p>
              ) : (
                <SelectablePersonList
                  people={filteredAddMembers.map((m) => ({
                    id: m.id,
                    name: m.name,
                    email: m.email,
                    meta: removedUserIdSet.has(m.id) ? returningMeta : undefined,
                  }))}
                  selectedIds={selectedMemberIds}
                  onToggle={(id) => setSelectedMemberIds((prev) => toggle(prev, id))}
                />
              )}
            </div>
          </div>

          {canAddClients && (
          <div>
            <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-muted">
              Clients
            </p>
            <p className="-mt-1 mb-1.5 px-1 text-xs text-on-surface-muted">
              Clients without an account will get access after they create one.
            </p>
            <EntityMultiPicker
              entity="clients"
              lawFirmId={lawFirmId}
              clientType="person"
              selectedIds={selectedClientRecordIds}
              onChange={setSelectedClientRecordIds}
              listClassName="max-h-40"
              renderMeta={(item) => (removedClientIdSet.has(item.id) ? returningMeta : null)}
            />
          </div>
          )}

          {canAddClients && (
          <div>
            <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-muted">
              Organizations
            </p>
            {/* Adds every person linked to a company in one action, including
                people who have not created portal accounts yet.
                Company `clients.id`s, not portal UIDs, so this picker selects on
                the client-row id (the default identifyBy). */}
            <EntityMultiPicker
              entity="clients"
              lawFirmId={lawFirmId}
              clientType="company"
              max={MAX_ORGANIZATIONS}
              selectedIds={selectedOrgIds}
              onChange={setSelectedOrgIds}
              listClassName="max-h-40"
              renderMeta={(item) =>
                item.contactCount != null ? (
                  <span className="flex items-center gap-1 text-xs text-on-surface-muted">
                    <Users size={12} />
                    {item.contactCount}
                  </span>
                ) : null
              }
            />
          </div>
          )}

          {(selectedClientUserIds.length > 0 || selectedClientRecordIds.length > 0 || selectedOrgIds.length > 0) && (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-outline-subtle bg-surface-alt px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-xs font-medium text-on-surface">
                  Let the {selectedClientUserIds.length + selectedClientRecordIds.length + selectedOrgIds.length === 1 ? "client" : "clients"} see previous messages
                </p>
                <p className="text-[11px] text-on-surface-muted mt-0.5">
                  {shareHistory
                    ? "They can read the full conversation history."
                    : returningSelected
                      ? "They'll only see messages sent from now on, not what was said while they were away."
                      : "They'll only see messages sent from now on."}
                </p>
              </div>
              <ToggleSwitch
                checked={shareHistory}
                onChange={() => {
                  setShareHistoryChoice(!shareHistory);
                  setShareHistoryTouched(true);
                }}
                ariaLabel="Let added clients see previous messages"
              />
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="secondary" size="small" onClick={resetAdd}>
              Cancel
            </Button>
            <Button type="primary" size="small" onClick={handleAdd} loading={busy}>
              Add
            </Button>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={!!removeTarget}
        title="Remove participant"
        message={removeMessage}
        confirmText="Remove"
        loading={busy}
        onConfirm={handleRemove}
        onClose={() => setRemoveTarget(null)}
      />

      <ConfirmModal
        isOpen={!!removePendingTarget}
        title="Remove pending recipient"
        message={`Remove ${removePendingTarget?.name || removePendingTarget?.email || "this person"} from the conversation? They have not created a portal account yet, so they have seen nothing. They will not join this thread when they register.`}
        confirmText="Remove"
        loading={busy}
        onConfirm={handleRemovePending}
        onClose={() => setRemovePendingTarget(null)}
      />

      <ConfirmModal
        isOpen={confirmAdd}
        title="Add client to an unscoped group?"
        message="This group will have more than one client and isn't linked to a matter. The clients share one thread and can see each other. You can scope it to a matter from the conversation settings."
        confirmText="Add anyway"
        loading={busy}
        onConfirm={() => { setConfirmAdd(false); doAdd(); }}
        onClose={() => setConfirmAdd(false)}
      />
    </div>
  );
}
