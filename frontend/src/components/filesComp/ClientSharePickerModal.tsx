"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Modal from "@/components/ui/Modal";
import { DROPDOWN_SEARCH_THRESHOLD } from "@/lib/constants/search";

export interface ShareClient {
  id: string;
  name: string;
  /**
   * The client's portal account id, if any. `null`/`undefined` means no
   * portal account; `undefined` specifically means the caller doesn't know
   * (it didn't fetch that far) rather than having confirmed there isn't one.
   */
  userId?: string | null;
}

interface ClientSharePickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Clients on the matter/task the item(s) belong to. */
  clients: ShareClient[];
  /** Client ids checked when the modal opens. Empty means "everyone". The picker
   *  seeds all clients checked in that matter so the default action shares with all. */
  initialSelectedIds: string[];
  /** Human label for what is being shared (a file name or "N items"). */
  itemLabel: string;
  /** Receives the chosen client ids and whether to notify them; if all clients are
   *  selected the caller should treat it as "no restriction" (shared with everyone,
   *  incl. future clients). */
  onConfirm: (clientIds: string[], notify: boolean) => void;
}

/**
 * Recipient picker for sharing matter/task files with specific clients. Shown when a
 * matter/task has more than one client so the firm can limit who sees the item(s);
 * defaults to everyone selected. Shared by the matter/task file manager and the
 * firm-wide Files browser so both surfaces present the same chooser.
 */
export default function ClientSharePickerModal({
  open,
  onClose,
  clients,
  initialSelectedIds,
  itemLabel,
  onConfirm,
}: ClientSharePickerModalProps) {
  const [selected, setSelected] = useState<string[]>(initialSelectedIds);
  const [notify, setNotify] = useState(true);
  const [search, setSearch] = useState("");

  // Filters the rows only. Selection and the select-all/clear-all action always
  // operate on the complete roster, because "every client selected" is what the
  // caller reads as "no restriction", including clients added to the matter
  // later. Narrowing that set to whatever the search happened to show would
  // quietly convert an open share into a fixed recipient list.
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return clients;
    return clients.filter((c) => (c.name || "").toLowerCase().includes(term));
  }, [clients, search]);

  // Re-seed the selection each time the modal opens (a different item or audience).
  // The modal stays mounted through its close animation, so seeding keys off the
  // open transition rather than mount. Parents pass a stable initialSelectedIds.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- re-seed picker state only when it (re)opens or its audience changes
      setSelected(initialSelectedIds);
      setNotify(true);
      setSearch("");
    }
  }, [open, initialSelectedIds]);

  const allSelected = clients.length > 0 && selected.length === clients.length;
  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Share with clients"
      showClose={false}
      size="md"
      footer={
        <>
          <Button type="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="primary" onClick={() => onConfirm(selected, notify)} disabled={selected.length === 0}>
            Share
          </Button>
        </>
      }
    >
      <p className="text-sm text-on-surface-secondary">
        Choose which clients can see {itemLabel}. Leave everyone checked to share with all clients on this matter/task.
      </p>

            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-on-surface-muted">
                {selected.length} of {clients.length} selected
              </span>
              <button
                type="button"
                onClick={() => setSelected(allSelected ? [] : clients.map((c) => c.id))}
                className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer"
              >
                {allSelected ? "Clear all" : "Select all"}
              </button>
            </div>

            {clients.length >= DROPDOWN_SEARCH_THRESHOLD && (
              <div className="relative">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search clients..."
                  className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-9 pr-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>
            )}

            <div className="space-y-1">
              {visible.length === 0 && (
                <p className="px-3 py-4 text-sm text-on-surface-muted text-center">
                  No clients match your search.
                </p>
              )}
              {visible.map((c) => {
                const checked = selected.includes(c.id);
                return (
                  <label
                    key={c.id}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-hover cursor-pointer"
                  >
                    <Checkbox
                      checked={checked}
                      onChange={() => toggle(c.id)}
                    />
                    <span className="text-sm text-on-surface">{c.name}</span>
                  </label>
                );
              })}
            </div>
            <label className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-hover cursor-pointer border-t border-outline-subtle mt-2 pt-3">
              <Checkbox checked={notify} onChange={() => setNotify((v) => !v)} />
              <span className="text-sm text-on-surface">
                Notify {selected.length === 1 ? "the client" : "clients"}
                <span className="block text-xs text-on-surface-muted">Sends a portal notification and an email digest.</span>
              </span>
            </label>
    </Modal>
  );
}
