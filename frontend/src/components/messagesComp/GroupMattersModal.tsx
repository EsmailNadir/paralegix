"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Briefcase, Search, X, Users, AlertTriangle } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import { useMountTransition } from "@/hooks/useMountTransition";
import Modal from "@/components/ui/Modal";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import Button from "@/components/ui/Button";
import messagesService from "@/services/messages.service";
import mattersService from "@/services/matters.service";
import type { Matter } from "@/types/matter";
import { matterStatusMeta } from "@/constants/statusMeta";
import {
  useEntityByIdsChunked,
  useEntityLookup,
  type FullLookupItem,
} from "@/hooks/useEntityLookup";

export interface GroupClient {
  userId: string;
  name: string;
  email: string;
}

interface GroupMattersModalProps {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  conversationId: string;
  matterIds: string[];
  // The clients in this conversation. Used to flag (not block) matters that
  // don't include them, and to offer adding them to a newly-linked matter.
  groupClients?: GroupClient[];
  onChanged: () => void;
}

// Popup for managing a group conversation's matter scope. Scope is an
// organizational tag (zero, one, or many matters) and never gates who can be in
// the group. A single searchable list - by matter name, number, or the clients
// on the matter - where linked matters are checked. Selections are staged
// locally and only persisted when the user clicks Done. When a newly-linked
// matter is missing clients who are in the conversation, Done first offers to
// add those clients to the matter.
export default function GroupMattersModal({
  open,
  onClose,
  lawFirmId,
  conversationId,
  matterIds,
  groupClients = [],
  onChanged,
}: GroupMattersModalProps) {
  const queryClient = useQueryClient();
  // Only `mounted` is read here: the lookups below stay on through the exit
  // animation. `Modal` runs its own transition for the panel itself.
  const { mounted } = useMountTransition(open, 100);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Staged selection, edited locally; persisted only on Done.
  const [selected, setSelected] = useState<string[]>(matterIds);
  // The set linked when the modal opened, frozen so the list order stays put as
  // rows are toggled (the initially-linked matters always sort to the top).
  const [baseline, setBaseline] = useState<string[]>(matterIds);
  // When true, the "add missing clients to these matters?" confirmation is shown.
  const [confirming, setConfirming] = useState(false);
  // `matterId|userId` pairs already added during this session. The matter
  // lookups are only refreshed once every add succeeds, so after a partial
  // failure they still list these clients as missing, and a retry would add
  // them a second time.
  const [addedPairs, setAddedPairs] = useState<ReadonlySet<string>>(() => new Set());
  const titleId = useId();
  const confirmTitleId = useId();
  // Every way out (Escape, backdrop, the close button, Cancel) is refused while
  // a save is in flight. The confirmation stacks above the picker, so Escape
  // and the focus trap follow whichever dialog is on top.
  const requestClose = () => { if (!saving) onClose(); };
  const requestCloseConfirm = () => { if (!saving) setConfirming(false); };

  // Reset the staged selection to the server's truth each time the modal opens.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- staged selection is re-synced to the server truth on each open
      setSelected(matterIds);
      setBaseline(matterIds);
      setSearch("");
      setError(null);
      setConfirming(false);
      setSaving(false);
      setAddedPairs(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), search.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [search]);

  const searchResult = useEntityLookup<FullLookupItem>("matters", lawFirmId, {
    search: debouncedSearch,
    // `mounted`, not `open`: the list must keep its rows through the exit
    // animation rather than empty as the lookups switch off.
    enabled: mounted,
    full: true,
  });
  const selectedResult = useEntityByIdsChunked<FullLookupItem>(
    "matters",
    mounted ? lawFirmId : undefined,
    selected,
    { full: true },
  );
  const matters = useMemo(() => {
    const byId = new Map<string, Matter>();
    for (const item of [...selectedResult.items, ...searchResult.items]) {
      byId.set(item.id, item as unknown as Matter);
    }
    return Array.from(byId.values());
  }, [searchResult.items, selectedResult.items]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const baselineSet = useMemo(() => new Set(baseline), [baseline]);
  const matterById = useMemo(() => {
    const map = new Map<string, Matter>();
    matters.forEach((m) => map.set(m.id, m));
    return map;
  }, [matters]);

  const label = (m: Matter) =>
    m.matterNumber ? `${m.matterNumber}: ${m.name}` : m.name;

  const clientText = (m: Matter) => {
    const names = m.clientNames?.length
      ? m.clientNames
      : (m.clients?.map((c) => c.name) ?? []);
    return names.filter(Boolean).join(", ");
  };

  // Conversation clients who aren't on the given matter. Empty when the
  // conversation has no clients. Drives the per-row warning and the Done prompt.
  const missingClients = (m: Matter): GroupClient[] => {
    if (groupClients.length === 0) return [];
    const has = new Set(m.clientUserIds ?? []);
    return groupClients.filter(
      (c) => c.userId && !has.has(c.userId) && !addedPairs.has(`${m.id}|${c.userId}`),
    );
  };

  // Search is applied server-side, over matter name, matter number and client
  // name alike, so there is nothing to re-filter here: narrowing the rows again
  // locally would only be able to drop matches the server already made. Selected
  // rows are resolved separately so they stay visible and labelled even when they
  // do not match the current term.
  const visible = useMemo(
    () =>
      [...matters].sort((a, b) => {
        const rank = (m: Matter) => (baselineSet.has(m.id) ? 0 : 1);
        return rank(a) - rank(b);
      }),
    [matters, baselineSet],
  );

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const dirty = useMemo(() => {
    if (selected.length !== baseline.length) return true;
    return selected.some((id) => !baselineSet.has(id));
  }, [selected, baseline.length, baselineSet]);

  // Newly-linked matters that are missing one or more conversation clients.
  const gaps = useMemo(() => {
    if (groupClients.length === 0) return [];
    const out: { matter: Matter; missing: GroupClient[] }[] = [];
    for (const id of selected) {
      if (baselineSet.has(id)) continue; // only matters being added now
      const m = matterById.get(id);
      if (!m) continue;
      const missing = missingClients(m);
      if (missing.length) out.push({ matter: m, missing });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, baselineSet, matterById, groupClients, addedPairs]);

  const persistScope = async () => {
    try {
      setSaving(true);
      setError(null);
      await messagesService.setGroupMatters(lawFirmId, conversationId, selected);
      queryClient.invalidateQueries({ queryKey: ["groupConversations", lawFirmId] });
      onChanged();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update matter scope."));
      setConfirming(false);
      // On success the dialog is closing, so "Saving..." stays until it has
      // gone; reopening resets the flag.
      setSaving(false);
    }
  };

  const addClientsThenPersist = async () => {
    try {
      setSaving(true);
      setError(null);
      for (const gap of gaps) {
        for (const c of gap.missing) {
          await mattersService.addClient({
            lawFirmId,
            matterId: gap.matter.id,
            client: { userId: c.userId, name: c.name, email: c.email || undefined },
          });
          const pair = `${gap.matter.id}|${c.userId}`;
          setAddedPairs((prev) => new Set(prev).add(pair));
        }
      }
      queryClient.invalidateQueries({ queryKey: ["matters", lawFirmId] });
      await messagesService.setGroupMatters(lawFirmId, conversationId, selected);
      queryClient.invalidateQueries({ queryKey: ["groupConversations", lawFirmId] });
      onChanged();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to add clients to the matter."));
      setConfirming(false);
      setSaving(false);
    }
  };

  const handleDone = () => {
    if (!dirty) {
      onClose();
      return;
    }
    if (gaps.length > 0) {
      setConfirming(true);
      return;
    }
    persistScope();
  };

  // Confirmation copy, built as plain strings to avoid JSX whitespace pitfalls
  // around the interpolated noun. Kept deliberately explicit about the two
  // distinct relationships: the matter↔conversation link (always happens) vs.
  // adding clients to the matter's own roster (the actual choice here).
  const matterNoun = gaps.length > 1 ? "matters" : "matter";
  const confirmTitle = `Add these clients to the ${matterNoun}?`;
  const confirmBody =
    `Some people in this conversation aren't clients on the ${matterNoun} you're linking. ` +
    `Adding them puts them on the ${matterNoun}'s client list. ` +
    `Either way, the ${matterNoun} still gets linked to this conversation.`;

  return (
    <>
      <Modal
        isOpen={open}
        onClose={requestClose}
        portal
        size="lg"
        dismissible={!saving}
        labelledBy={titleId}
        showClose={false}
        bodyClassName={null}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-outline shrink-0">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-on-surface">Matter scope</h2>
            <p className="text-xs text-on-surface-muted mt-0.5">
              {selected.length === 0
                ? "No matters selected."
                : `${selected.length} matter${selected.length !== 1 ? "s" : ""} selected.`}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={saving}
            aria-label="Close"
            className="text-on-surface-muted hover:text-on-surface transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 pt-4 shrink-0">
          <ErrorNotification error={error} onClose={() => setError(null)} className="mb-3" />

          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted pointer-events-none" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by matter, number, or client..."
              className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-9 pr-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden styled-scrollbar px-4 py-3">
          {visible.length === 0 ? (
            <p className="text-sm text-on-surface-muted text-center py-8">
              {matters.length === 0 ? "No matters yet." : "No matters match your search."}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {visible.map((m) => {
                const isSelected = selectedSet.has(m.id);
                const clients = clientText(m);
                const missing = missingClients(m);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => toggle(m.id)}
                      aria-pressed={isSelected}
                      aria-label={`${isSelected ? "Unlink" : "Link"} ${label(m)}`}
                      className={`w-full flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                        isSelected ? "bg-accent-soft dark:bg-accent-soft" : "hover:bg-surface-hover"
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex items-center justify-center h-4 w-4 shrink-0 rounded border transition-colors ${
                          isSelected
                            ? "bg-accent-solid border-accent-control-ring text-accent-foreground"
                            : "border-outline bg-transparent"
                        }`}
                      >
                        {isSelected && <Check size={11} strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <Briefcase size={13} className="shrink-0 text-on-surface-muted" />
                          <span className="truncate text-sm font-medium text-on-surface">
                            {label(m)}
                          </span>
                          {m.status && (
                            <span className="shrink-0 text-[10px] uppercase tracking-wide text-on-surface-muted capitalize">
                              {matterStatusMeta(m.status).label}
                            </span>
                          )}
                          {missing.length > 0 && (
                            <Tooltip
                              title={`Not on this matter: ${missing.map((c) => c.name).join(", ")}`}
                              enterDelay={300}
                            >
                              <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                <AlertTriangle size={11} /> Missing client{missing.length > 1 ? "s" : ""}
                              </span>
                            </Tooltip>
                          )}
                        </span>
                        {clients && (
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-on-surface-muted">
                            <Users size={11} className="shrink-0" />
                            <span className="truncate">{clients}</span>
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 bg-surface-alt rounded-b-lg max-sm:rounded-b-none border-t border-outline shrink-0">
          <Button type="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="primary" onClick={handleDone} loading={saving}>
            Done
          </Button>
        </div>
      </Modal>

      {/* Prompt to add missing conversation clients to the matters being linked. */}
      <Modal
        isOpen={confirming}
        onClose={requestCloseConfirm}
        stacked
        size="md"
        dismissible={!saving}
        labelledBy={confirmTitleId}
        showClose={false}
        className="border border-outline shadow-2xl"
        bodyClassName={null}
      >
        <div className="px-5 py-4 border-b border-outline flex items-start gap-3 shrink-0">
          <span className="mt-0.5 text-amber-500 shrink-0">
            <AlertTriangle size={22} />
          </span>
          <div>
            <h3 id={confirmTitleId} className="text-lg font-semibold text-on-surface">{confirmTitle}</h3>
            <p className="text-sm text-on-surface-secondary mt-1">{confirmBody}</p>
          </div>
        </div>

        <div className="px-5 py-3 overflow-y-auto overflow-x-hidden styled-scrollbar space-y-2">
          {gaps.map((g) => (
            <div
              key={g.matter.id}
              className="rounded-md border border-outline-subtle bg-surface-alt px-3 py-2"
            >
              <p className="text-sm font-medium text-on-surface truncate">{label(g.matter)}</p>
              <p className="text-sm text-on-surface-secondary mt-0.5">
                Clients to add: {g.missing.map((c) => c.name).join(", ")}
              </p>
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-outline flex items-center justify-end gap-2 shrink-0">
          <Button type="secondary" onClick={() => setConfirming(false)} disabled={saving}>
            Back
          </Button>
          <Button type="secondary" onClick={persistScope} disabled={saving}>
            Don&apos;t add
          </Button>
          <Button type="primary" onClick={addClientsThenPersist} loading={saving}>
            Add to {matterNoun}
          </Button>
        </div>
      </Modal>
    </>
  );
}
