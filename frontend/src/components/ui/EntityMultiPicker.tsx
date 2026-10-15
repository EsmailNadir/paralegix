"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Briefcase, Building2, Check, CheckSquare, Contact, Plus, Search } from "lucide-react";
import SelectablePersonList from "@/components/ui/SelectablePersonList";
import {
  useEntityByIdsChunked,
  useEntityLookup,
  type LookupEntity,
  type LookupItem,
} from "@/hooks/useEntityLookup";
import { SEARCH_DEBOUNCE_MS, lookupOverflowNote } from "@/lib/constants/search";

interface EntityMultiPickerProps<T extends LookupItem = LookupItem> {
  entity: LookupEntity;
  lawFirmId?: string;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Cap on how many ids can be selected. Unselected rows go inert at the cap. */
  max?: number;
  /** `entity="matters"`: only offer matters linked to this client. */
  clientId?: string;
  /** `entity="clients"`: only offer clients linked to this matter. */
  matterId?: string;
  /**
   * `entity="clients"`: keep archived clients out of the search results. Only
   * `archived` is excluded; `inactive` clients stay selectable. Already-selected
   * archived clients still resolve their label, so they stay visible and
   * removable.
   */
  excludeArchived?: boolean;
  /**
   * `entity="clients"`: only offer clients that have a linked portal account, so
   * every row carries a non-null `userId`. Required wherever the selection
   * identifies a person rather than a client record.
   */
  portalOnly?: boolean;
  /**
   * `entity="clients"`: restrict to one client type. `"company"` also switches
   * the row rendering from the person-shaped avatar list to the generic row
   * (icon + label + `renderMeta`), since a company isn't a person and callers
   * typically want to show its roster size (`item.contactCount`) alongside it.
   */
  clientType?: "person" | "company";
  /**
   * Which value the picker's `selectedIds` are expressed in. `"id"` (the default)
   * is the record's own id. `"userId"` is a client's linked portal Firebase UID,
   * for pickers whose value must identify the PERSON rather than the client
   * record: a messaging participant is stored by UID, so a picker handed a UID
   * has no client-row id to match against and could neither pin nor un-select its
   * own selection without this. Pair it with `portalOnly` so every offered row
   * actually carries a UID; rows without one are not selectable.
   */
  identifyBy?: "id" | "userId";
  /**
   * Ids the picker must never offer, whatever the search returns. Used where a
   * record cannot reference itself (a task's own id in its dependency list).
   * Expressed in the same key as `selectedIds`, so `identifyBy` governs both.
   */
  excludeIds?: string[];
  /** Right-aligned per-row content, e.g. a status badge. Non-people rows only. */
  renderMeta?: (item: T) => ReactNode;
  /** Height of the scrolling row area. */
  listClassName?: string;
  /**
   * Offers a "create new" affordance below the search box, e.g. so a matter
   * event's attendee picker can add a contact the directory doesn't have yet
   * without leaving the form. Omit to hide it; the caller owns any
   * permission check for whether the record type can be created.
   */
  onCreateNew?: () => void;
  /** Label for the `onCreateNew` button. Required when `onCreateNew` is set. */
  createNewLabel?: string;
}

const SEARCH_PLACEHOLDER: Record<LookupEntity, string> = {
  matters: "Search matters...",
  clients: "Search clients...",
  tasks: "Search tasks...",
  contacts: "Search contacts...",
};

const EMPTY_LABEL: Record<LookupEntity, string> = {
  matters: "No matters match your search.",
  clients: "No clients match your search.",
  tasks: "No tasks match your search.",
  contacts: "No contacts match your search.",
};

const ROW_ICON: Record<LookupEntity, typeof Briefcase> = {
  matters: Briefcase,
  clients: Briefcase,
  tasks: CheckSquare,
  contacts: Contact,
};

/**
 * Multi-select whose rows come from the `/lookup` typeahead rather than a fully
 * loaded list, so it stays usable for firms with thousands of matters, clients
 * or tasks.
 *
 * The selected rows are resolved from their stored values and pinned above the
 * search results (see `identifyBy` for which value that is). That
 * is the part that makes a server-backed multi-select safe to use: without it, a
 * search term that excludes an existing selection would hide it, and the user
 * could neither see nor remove it.
 */
export default function EntityMultiPicker<T extends LookupItem = LookupItem>({
  entity,
  lawFirmId,
  selectedIds,
  onChange,
  label,
  placeholder,
  disabled = false,
  max,
  clientId,
  matterId,
  excludeArchived,
  portalOnly,
  clientType,
  identifyBy = "id",
  excludeIds,
  renderMeta,
  listClassName = "max-h-64",
  onCreateNew,
  createNewLabel,
}: EntityMultiPickerProps<T>) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  const { items, hasMore, loading, isPlaceholder } = useEntityLookup<T>(entity, lawFirmId, {
    search: debouncedSearch,
    clientId,
    matterId,
    excludeArchived,
    clientType,
    portalOnly,
  });

  // Chunked because the server caps a lookup at LOOKUP_MAX_LIMIT rows and a
  // multi-select can hold more selections than that.
  const { items: selectedItems } = useEntityByIdsChunked<T>(entity, lawFirmId, selectedIds, {
    clientId,
    matterId,
    excludeArchived,
    portalOnly,
    clientType,
    identifyBy,
  });

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const excludedSet = useMemo(() => new Set(excludeIds ?? []), [excludeIds]);

  // The value this picker speaks in. Null when a row cannot be addressed at all
  // (a client with no portal account under `identifyBy="userId"`); such a row is
  // dropped rather than allowed to collapse onto another row's key.
  const keyOf = useMemo(
    () => (item: T): string | null =>
      identifyBy === "userId" ? item.userId ?? null : item.id || null,
    [identifyBy]
  );

  // Selected rows first, in the caller's order, then whatever the search turned
  // up that is not already pinned above.
  const rows = useMemo(() => {
    const byKey = new Map<string, T>();
    for (const item of [...selectedItems, ...items]) {
      if (!item) continue;
      const key = keyOf(item);
      if (!key || byKey.has(key) || excludedSet.has(key)) continue;
      byKey.set(key, item);
    }
    const pinned = selectedIds.map((id) => byKey.get(id)).filter((i): i is T => !!i);
    const rest = [...byKey.values()].filter((i) => !selectedSet.has(keyOf(i) as string));
    return [...pinned, ...rest];
  }, [selectedItems, items, selectedIds, selectedSet, excludedSet, keyOf]);

  const atMax = typeof max === "number" && selectedIds.length >= max;
  // "The rows on screen do not answer what was typed", not "a request is in
  // flight": either the debounce is behind, or the rows are the previous term's
  // held over while the new one loads. A background refetch of the term already
  // showing is excluded, since hiding correct rows for it would strip the list
  // back to the selected few for no reason the user can see.
  const searching =
    searchInput.trim() !== debouncedSearch.trim() ||
    isPlaceholder ||
    (loading && items.length === 0);
  // Keep existing selections removable, but do not show stale unselected browse
  // rows while a new server search is pending.
  const visibleRows =
    searchInput.trim() && searching
      ? rows.filter((item) => selectedSet.has(keyOf(item) as string))
      : rows;

  const toggle = (id: string) => {
    if (disabled) return;
    if (selectedSet.has(id)) {
      onChange(selectedIds.filter((existing) => existing !== id));
      return;
    }
    if (atMax) return;
    onChange([...selectedIds, id]);
  };

  // A company client isn't a person, so it gets the generic row treatment
  // (below) with a Building2 icon instead of the person list's avatar.
  const Icon = clientType === "company" ? Building2 : ROW_ICON[entity];
  const isPersonList = entity === "clients" && clientType !== "company";
  const overflowNote = lookupOverflowNote(hasMore, searchInput);
  // The control this label names is the search box below, so clicking the label
  // should put the caret in it. That is what `for` gives and `aria-labelledby`
  // would not.
  const searchId = useId();

  return (
    <div>
      {(label || onCreateNew) && (
        <div className="mb-1 flex items-center justify-between gap-2">
          {label && (
            <label htmlFor={searchId} className="block text-sm font-medium text-on-surface">
              {label}
            </label>
          )}
          {onCreateNew && (
            <button
              type="button"
              onClick={onCreateNew}
              disabled={disabled}
              className="inline-flex items-center gap-1 text-xs font-medium text-accent-emphasis hover:underline disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <Plus size={13} /> {createNewLabel}
            </button>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-input-border bg-input-bg">
        <div className="relative">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted pointer-events-none"
          />
          <input
            id={searchId}
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            disabled={disabled}
            placeholder={placeholder || SEARCH_PLACEHOLDER[entity]}
            className="w-full bg-transparent text-on-surface placeholder:text-on-surface-muted pl-9 pr-3 py-2 text-sm focus:outline-none disabled:opacity-50"
          />
        </div>

        <div
          className={`${listClassName} overflow-y-auto overflow-x-hidden styled-scrollbar border-t border-outline-subtle`}
        >
          {visibleRows.length === 0 ? (
            <p className="px-3 py-6 text-sm text-on-surface-muted text-center">
              {searching ? "Searching..." : EMPTY_LABEL[entity]}
            </p>
          ) : isPersonList ? (
            // People-shaped rows get the canonical avatar list.
            <SelectablePersonList
              people={visibleRows.map((item) => ({
                id: keyOf(item) as string,
                name: item.label,
                email: typeof item.sublabel === "string" ? item.sublabel : null,
              }))}
              selectedIds={selectedIds}
              onToggle={toggle}
              disabled={disabled}
            />
          ) : (
            <ul className="space-y-0.5 p-1">
              {visibleRows.map((item) => {
                const rowKey = keyOf(item) as string;
                const isSelected = selectedSet.has(rowKey);
                const inert = disabled || (!isSelected && atMax);
                return (
                  <li key={rowKey}>
                    <button
                      type="button"
                      disabled={inert}
                      onClick={() => toggle(rowKey)}
                      aria-pressed={isSelected}
                      className={`w-full flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        isSelected
                          ? "bg-accent-picker"
                          : "hover:bg-surface-hover"
                      } ${inert ? "" : "cursor-pointer"}`}
                    >
                      <span
                        className={`mt-0.5 flex items-center justify-center h-4 w-4 shrink-0 rounded border transition-colors ${
                          isSelected
                            ? "bg-accent-solid border-accent-solid text-accent-foreground"
                            : "border-outline bg-transparent"
                        }`}
                      >
                        {isSelected && <Check size={11} strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <Icon size={13} className="shrink-0 text-on-surface-muted" />
                          <span className="truncate text-sm font-medium text-on-surface">
                            {item.label}
                          </span>
                        </span>
                        {item.sublabel && (
                          <span className="mt-0.5 block truncate text-xs text-on-surface-muted">
                            {String(item.sublabel)}
                          </span>
                        )}
                      </span>
                      {renderMeta && <span className="mt-0.5 shrink-0">{renderMeta(item)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {visibleRows.length > 0 && searchInput.trim() && !searching && items.length === 0 && (
            <p className="px-3 py-6 text-sm text-on-surface-muted text-center">
              {EMPTY_LABEL[entity]}
            </p>
          )}

          {/* Truncation note: it scrolls with the rows instead of being pinned
              under the viewport, so it reads as the end of the list. */}
          {overflowNote && (
            <p className="px-3 py-1.5 text-xs text-on-surface-muted border-t border-outline-subtle bg-surface-alt">
              {overflowNote}
            </p>
          )}
        </div>
      </div>

      {typeof max === "number" && (
        <p className="mt-1 text-xs text-on-surface-muted">
          {selectedIds.length} of {max} selected
        </p>
      )}
    </div>
  );
}
