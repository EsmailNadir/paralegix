"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Repeat } from "lucide-react";
import { useMountTransition } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";
import { SUGGESTION_GROUPS, type SuggestionGroup } from "./mergeFieldCatalog";

/**
 * A small search+pick popover for inserting an EXISTING field's reference
 * inline into a rich text box, anchored under the box's own "+ Field"
 * button. Deliberately not a `PlaceholderModal` mode: that modal is "define
 * a new named placeholder" (collects a fresh Field ID, optionally a new
 * repeater name); this is "pick an existing name to reference inline": no
 * naming, search-first, click-to-insert immediately.
 */
export default function OverlayFieldChipPopover({
  open,
  onClose,
  onSelect,
  siblingFields,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (fieldName: string) => void;
  /** Other column names already drawn in the same repeater (empty for a
   *  standalone, non-repeater text box), offered ahead of the global
   *  auto-fill catalog, since they resolve from the same row's own data. */
  siblingFields: string[];
}) {
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { mounted, exiting } = useMountTransition(open, 150);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the search field when the popover opens
    setSearch("");
    const t = setTimeout(() => searchRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open, onClose]);

  const groups = useMemo(() => {
    const all: SuggestionGroup[] = siblingFields.length
      ? [{ label: "This repeater", icon: Repeat, fields: siblingFields.map((f) => ({ id: f, description: "Column in this repeater" })) }, ...SUGGESTION_GROUPS]
      : SUGGESTION_GROUPS;

    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all
      .map((group) => ({ ...group, fields: group.fields.filter((f) => f.id.includes(q) || f.description.toLowerCase().includes(q)) }))
      .filter((group) => group.fields.length > 0);
  }, [search, siblingFields]);

  if (!mounted) return null;

  return (
    <div
      ref={containerRef}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      className={`absolute left-0 top-[calc(100%+6px)] z-30 w-64 rounded-xl border border-outline bg-surface p-2 shadow-xl dark:bg-surface-alt origin-top ${menuAnim(exiting)}`}
    >
      <div className="relative mb-2">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-muted" />
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search fields..."
          className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-8 pr-3 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        />
      </div>

      <div className="space-y-2 max-h-[220px] overflow-y-auto overflow-x-hidden styled-scrollbar">
        {groups.length === 0 ? (
          <p className="text-xs text-on-surface-muted text-center py-3">No matching fields</p>
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-on-surface-muted"><group.icon size={12} /></span>
                <span className="text-xs font-semibold text-on-surface-secondary">{group.label}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                {group.fields.map((field) => (
                  <button
                    key={field.id}
                    type="button"
                    onClick={() => onSelect(field.id)}
                    className="flex items-center justify-between gap-2 px-2 py-1 rounded text-left text-xs text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface transition-colors cursor-pointer"
                  >
                    <span className="font-medium">{field.id}</span>
                    <span className="text-on-surface-muted truncate">{field.description}</span>
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
