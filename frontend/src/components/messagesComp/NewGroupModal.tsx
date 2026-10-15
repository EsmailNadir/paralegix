"use client";

import { FIELD_LABEL_BLOCK_CLS, FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Users, Search } from "lucide-react";
import Button from "@/components/ui/Button";
import EntityPicker from "@/components/ui/EntityPicker";
import EntityMultiPicker from "@/components/ui/EntityMultiPicker";
import SelectablePersonList from "@/components/ui/SelectablePersonList";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Modal from "@/components/ui/Modal";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { useAuth } from "@/hooks/useAuth";
import { useFirmMembers } from "@/hooks/useFirmMembers";
import messagesService from "@/services/messages.service";
import clientsService from "@/services/clients.service";
import { isCompanyRosterContact } from "@/types/client";

interface NewGroupModalProps {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  onCreated: (conversationId: string) => void;
  // Preselect a matter (e.g. when opened from a matter's Messages tab).
  initialMatterId?: string;
  // Preselect a client (e.g. when opened from a client's Messages tab).
  initialClientUserId?: string;
  initialClientId?: string;
}

const inputClass = FULL_INPUT_CLS;
const labelClass = FIELD_LABEL_BLOCK_CLS;

// Mirrors the backend's cap on `organizationClientIds` (messaging.validation.ts).
const MAX_ORGANIZATIONS = 20;

// Case-insensitive substring match over a person's name/email. Module-level (no
// component state) so it's a stable reference and not a hook dependency.
const matchesSearch = (query: string, name?: string | null, email?: string | null) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${name ?? ""} ${email ?? ""}`.toLowerCase().includes(q);
};

export default function NewGroupModal({ open, onClose, lawFirmId, onCreated, initialMatterId, initialClientUserId, initialClientId }: NewGroupModalProps) {
  const fieldIds = useId();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  // Mounted closed wherever it is offered, so the member list loads on open.
  const members = useFirmMembers(lawFirmId, open);

  const [title, setTitle] = useState("");
  const [matterId, setMatterId] = useState("");
  const [selectedClientUserIds, setSelectedClientUserIds] = useState<string[]>([]);
  const [selectedClientRecordIds, setSelectedClientRecordIds] = useState<string[]>([]);
  // Company `clients.id`s picked via the org quick-add. Each is expanded
  // server-side to that company's whole roster and merged with
  // selectedClientUserIds (organization-clients plan Phase 7).
  const [selectedOrgIds, setSelectedOrgIds] = useState<string[]>([]);
  // The organizations picked right now, readable from a roster request that
  // resolves later: an organization dropped while its roster was loading must
  // not add its people when the response lands.
  const selectedOrgIdsRef = useRef<string[]>([]);
  // Cache of each picked organization's roster (person `clients.id`s), so
  // picking an org also checks its people in the Clients picker below, and
  // dropping the org can cleanly un-check only the ones it added.
  const [orgRosterIds, setOrgRosterIds] = useState<Record<string, string[]>>({});
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown when a multi-client group is being created without a matter, so the
  // user confirms they intend an unscoped cross-client thread.
  const [confirmNoMatter, setConfirmNoMatter] = useState(false);

  // Reset all fields whenever the modal (re)opens (it stays mounted across the
  // close animation, so fields must be cleared on the next open, not on unmount).
  // A preselected client arrives as a portal UID, which is already the value the
  // client picker selects on, so it seeds the selection directly.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time field reset when the always-mounted modal reopens
      setTitle("");
      setMatterId(initialMatterId || "");
      setSelectedClientUserIds(initialClientUserId ? [initialClientUserId] : []);
      setSelectedClientRecordIds(initialClientId ? [initialClientId] : []);
      setSelectedOrgIds([]);
      selectedOrgIdsRef.current = [];
      setOrgRosterIds({});
      setSelectedMemberIds([]);
      setMemberSearch("");
      setError(null);
    }
  }, [open, initialMatterId, initialClientUserId, initialClientId]);

  // The creator is always a participant, so they are not a pickable member.
  const selectableMembers = useMemo(
    () => members.filter((m) => m.id !== user?.uid),
    [members, user?.uid]
  );

  // The creator's own row, pinned first and locked on, so the list shows who the
  // conversation will actually include. Their firm member record is preferred;
  // the signed-in profile covers a member list that is still loading or lacks
  // them. Never part of `selectedMemberIds`: the server adds the creator itself.
  const selfPerson = useMemo(() => {
    if (!user) return null;
    const record = members.find((m) => m.id === user.uid);
    return {
      id: user.uid,
      name: record?.name || user.displayName,
      email: record?.email || user.email,
      photoUrl: record?.photoUrl ?? user.photoURL,
      nameSuffix: " (you)",
      locked: true,
    };
  }, [members, user]);

  const filteredMembers = useMemo(
    () => selectableMembers.filter((m) => matchesSearch(memberSearch, m.name, m.email)),
    [selectableMembers, memberSearch]
  );

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  // Picking an organization also checks its roster in the Clients picker
  // above, so the actual people being messaged are visible (and individually
  // removable) rather than hidden behind the company row. Dropping the org
  // un-checks only the roster ids it added, and only if no other still-picked
  // org needs them too; anyone picked by hand in Clients directly is
  // untouched either way.
  const handleOrgIdsChange = (nextOrgIds: string[]) => {
    const removedOrgIds = selectedOrgIds.filter((id) => !nextOrgIds.includes(id));
    const addedOrgIds = nextOrgIds.filter((id) => !selectedOrgIds.includes(id));
    setSelectedOrgIds(nextOrgIds);
    selectedOrgIdsRef.current = nextOrgIds;

    if (removedOrgIds.length > 0) {
      setSelectedClientRecordIds((current) => {
        const stillNeeded = new Set(nextOrgIds.flatMap((id) => orgRosterIds[id] || []));
        const toRemove = new Set(
          removedOrgIds.flatMap((id) => orgRosterIds[id] || []).filter((cid) => !stillNeeded.has(cid))
        );
        return toRemove.size > 0 ? current.filter((cid) => !toRemove.has(cid)) : current;
      });
    }

    for (const orgId of addedOrgIds) {
      const cached = orgRosterIds[orgId];
      if (cached) {
        setSelectedClientRecordIds((current) => {
          const additions = cached.filter((id) => !current.includes(id));
          return additions.length > 0 ? [...current, ...additions] : current;
        });
        continue;
      }
      clientsService.listClientContacts(lawFirmId, orgId)
        .then((contacts) => {
          const rosterIds = contacts
            .filter(isCompanyRosterContact)
            .map((c) => c.personClientId)
            .filter((id): id is string => !!id);
          setOrgRosterIds((current) => ({ ...current, [orgId]: rosterIds }));
          if (!selectedOrgIdsRef.current.includes(orgId)) return;
          setSelectedClientRecordIds((current) => {
            const additions = rosterIds.filter((id) => !current.includes(id));
            return additions.length > 0 ? [...current, ...additions] : current;
          });
        })
        .catch(() => {
          setOrgRosterIds((current) => ({ ...current, [orgId]: [] }));
        });
    }
  };

  // Unchecking a client by hand drops an org selection once none of its
  // roster is left checked, so the org row and its people stay in sync.
  // Unchecking just one of several roster members leaves the org selected.
  const handleClientRecordIdsChange = (nextIds: string[]) => {
    setSelectedClientRecordIds(nextIds);
    setSelectedOrgIds((current) => {
      const next = current.filter((orgId) => {
        const roster = orgRosterIds[orgId];
        // Roster not loaded (or genuinely empty) yet: leave the org alone.
        if (!roster || roster.length === 0) return true;
        return roster.some((id) => nextIds.includes(id));
      });
      if (next.length === current.length) return current;
      selectedOrgIdsRef.current = next;
      return next;
    });
  };

  // "Add whole firm" quick action: select every colleague at once (the creator is
  // always included separately), toggling back to clear.
  const allMemberIds = useMemo(() => selectableMembers.map((m) => m.id), [selectableMembers]);
  const allMembersSelected =
    allMemberIds.length > 0 && allMemberIds.every((id) => selectedMemberIds.includes(id));
  const toggleAllMembers = () =>
    setSelectedMemberIds(allMembersSelected ? [] : allMemberIds);

  const doCreate = async () => {
    try {
      setSubmitting(true);
      setError(null);
      const { conversationId } = await messagesService.createGroup(lawFirmId, {
        title: title.trim() || undefined,
        matterIds: matterId ? [matterId] : undefined,
        memberIds: selectedMemberIds,
        clientIds: selectedClientUserIds,
        clientRecordIds: selectedClientRecordIds,
        organizationClientIds: selectedOrgIds,
      });
      queryClient.invalidateQueries({ queryKey: ["groupConversations", lawFirmId] });
      onCreated(conversationId);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to create group."));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = () => {
    if (selectedClientUserIds.length + selectedClientRecordIds.length + selectedOrgIds.length + selectedMemberIds.length === 0) {
      setError("Add at least one client, organization, or firm member to message.");
      return;
    }
    // A multi-client group with no matter is allowed, but confirm it first so an
    // unscoped cross-client thread is never created by accident. Any organization
    // counts on its own here (even just one expands to its whole roster, which is
    // already more than one person), not only multiple hand-picked clients.
    // Hand-picked clients arrive as record ids; a preselected one may also
    // arrive as a portal UID for the same person, so each list is counted on
    // its own rather than summed.
    const multipleClients = selectedClientRecordIds.length > 1 || selectedClientUserIds.length > 1;
    if ((multipleClients || selectedOrgIds.length > 0) && !matterId) {
      setConfirmNoMatter(true);
      return;
    }
    doCreate();
  };

  return (
    <>
    <Modal
      isOpen={open}
      onClose={onClose}
      title="New message"
      icon={<Users size={18} className="text-accent-emphasis" />}
      showClose={false}
      size="xl"
      dismissible={!submitting}
      bodyClassName="px-6 py-5 space-y-5 overflow-y-auto overflow-x-hidden styled-scrollbar"
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={submitting || selectedClientUserIds.length + selectedClientRecordIds.length + selectedOrgIds.length + selectedMemberIds.length === 0}
          >
            Start conversation
          </Button>
        </>
      }
    >
            <ErrorNotification error={error} onClose={() => setError(null)} />

            <div>
              <label htmlFor={`${fieldIds}-title`} className={labelClass}>Conversation name</label>
              <input
                id={`${fieldIds}-title`}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Smith settlement"
                className={inputClass}
              />
            </div>

            <EntityPicker
              entity="matters"
              lawFirmId={lawFirmId}
              label="Matter"
              value={matterId}
              onChange={setMatterId}
              emptyOption={{ label: "No matter", value: "" }}
              placeholder="Select a matter"
              portal
            />
            <p className="-mt-3 text-xs text-on-surface-muted">
              Tags the conversation under a matter. You can scope it to
              more matters later from the conversation&apos;s Options.
            </p>

            <div>
              <label className={labelClass}>Organizations</label>
              <p className="-mt-1 mb-1.5 text-xs text-on-surface-muted">
                Add every portal-enabled contact at a company in one action. This
                checks its people in Clients below, where you can still add or
                remove individuals.
              </p>
              {/* Company `clients.id`s, not portal UIDs: the roster expansion
                  happens server-side, so this picker selects on the client-row id
                  (the default `identifyBy`), unlike the individual-clients picker
                  below. */}
              <EntityMultiPicker
                entity="clients"
                lawFirmId={lawFirmId}
                clientType="company"
                max={MAX_ORGANIZATIONS}
                selectedIds={selectedOrgIds}
                onChange={handleOrgIdsChange}
                listClassName="max-h-44"
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

            <div>
              <label className={labelClass}>
                Clients <span aria-hidden="true">*</span>
              </label>
              <p className="-mt-1 mb-1.5 text-xs text-on-surface-muted">
                Add one or more clients, or leave empty for a firm-members-only chat.
                Clients without an account will be able to see this conversation after they create one.
              </p>
              {/* Client record ids support both portal-enabled clients and
                  pending clients who have not created an account yet. */}
              <EntityMultiPicker
                entity="clients"
                lawFirmId={lawFirmId}
                clientType="person"
                selectedIds={selectedClientRecordIds}
                onChange={handleClientRecordIdsChange}
                listClassName="max-h-44"
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label className={labelClass}>
                  Firm members <span aria-hidden="true">*</span>
                </label>
                {selectableMembers.length > 0 && (
                  <button
                    type="button"
                    onClick={toggleAllMembers}
                    className="mb-1 text-xs font-medium text-accent-emphasis hover:underline cursor-pointer"
                  >
                    {allMembersSelected ? "Clear all" : "Add whole firm"}
                  </button>
                )}
              </div>
              <p className="-mt-1 mb-1.5 text-xs text-on-surface-muted">
                You are added automatically. Add colleagues to include them.
              </p>
              <div className="relative mb-1.5">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-muted pointer-events-none" />
                <input
                  type="text"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder="Search firm members..."
                  className={`${inputClass} pl-8`}
                />
              </div>
              <div className="max-h-40 overflow-y-auto overflow-x-hidden styled-scrollbar rounded-md border border-outline-subtle">
                {/* The creator's row ignores the search, the way a selected
                    client stays visible in the client picker: they are always
                    included, so they are never hidden. */}
                {(selfPerson || filteredMembers.length > 0) && (
                  <SelectablePersonList
                    people={[
                      ...(selfPerson ? [selfPerson] : []),
                      ...filteredMembers.map((m) => ({ id: m.id, name: m.name, email: m.email, photoUrl: m.photoUrl })),
                    ]}
                    selectedIds={selectedMemberIds}
                    onToggle={(id) => setSelectedMemberIds((prev) => toggle(prev, id))}
                  />
                )}
                {selectableMembers.length === 0 ? (
                  <p className={`px-3 py-4 text-sm text-on-surface-muted text-center ${selfPerson ? "border-t border-outline-subtle" : ""}`}>No other members.</p>
                ) : filteredMembers.length === 0 ? (
                  <p className={`px-3 py-4 text-sm text-on-surface-muted text-center ${selfPerson ? "border-t border-outline-subtle" : ""}`}>No members match your search.</p>
                ) : null}
              </div>
            </div>
    </Modal>

    <ConfirmModal
      isOpen={confirmNoMatter}
      title="Start conversation without a matter?"
      message="This conversation has more than one client and isn't linked to a matter. Everyone added will share one thread and can see each other. You can scope it to a matter later from the conversation's Options."
      confirmText="Start anyway"
      loading={submitting}
      onConfirm={() => { setConfirmNoMatter(false); doCreate(); }}
      onClose={() => setConfirmNoMatter(false)}
    />
    </>
  );
}
