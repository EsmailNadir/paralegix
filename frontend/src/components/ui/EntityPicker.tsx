"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import {
  useEntityByIds,
  useEntityLookup,
  type LookupEntity,
  type LookupItem,
} from "@/hooks/useEntityLookup";
import { SEARCH_DEBOUNCE_MS, lookupOverflowNote } from "@/lib/constants/search";

interface EntityPickerProps<T extends LookupItem = LookupItem> {
  entity: LookupEntity;
  lawFirmId?: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * Fires alongside onChange with the selected lookup item (null for the empty
   * option), so callers can read extra fields off the selection, e.g. task
   * forms prefill their court from the chosen matter's courtId/courtName.
   */
  onSelectItem?: (item: T | null) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  portal?: boolean;
  className?: string;
  buttonClassName?: string;
  labelClassName?: string;
  /** Decorative icon shown inside the trigger, left of the selected label. */
  icon?: ReactNode;
  /** Prepended to the options, for an "All"/"None" choice. Value is usually "". */
  emptyOption?: DropdownOption;
  /**
   * `entity="matters"`: only offer matters linked to this client.
   * A value the server cannot resolve yields an empty picker rather than the
   * unscoped list, because silently widening is how a trust transaction ends up
   * attributed to another client's matter.
   */
  clientId?: string;
  /** `entity="clients"`: only offer clients linked to this matter. */
  matterId?: string;
  /**
   * `entity="clients"`: keep archived clients out of the options, for pickers
   * that attach a client to new work. Only `archived` is excluded; `inactive`
   * clients stay selectable.
   *
   * An already-selected client that has since been archived still resolves its
   * label, because the server applies this only to the browse/search branch and
   * never to id resolution.
   */
  excludeArchived?: boolean;
  /** `entity="clients"`: restrict the options to one client type ('person' or 'company'). */
  clientType?: "person" | "company";
  /**
   * `entity="clients"`: drop clients already linked to this company client, for
   * the "add an existing client" picker on a company's Related Clients tab, so
   * it cannot offer someone the link endpoint would then reject as a duplicate.
   */
  excludeLinkedToClientId?: string;
  /**
   * `entity="clients"`: only offer clients that have a linked portal account, so
   * every option carries a non-null `userId`. Required wherever the selection
   * identifies a person rather than a client record, e.g. a portal e-signature
   * signer, who is addressed by portal UID and not by `clients.id`.
   */
  portalOnly?: boolean;
  /**
   * `entity="matters"` or `"clients"`: each item carries the complete enriched
   * record as well as its label, for callers that read the whole thing off
   * `onSelectItem`. Pair it with the `FullLookupItem` type argument
   * (`<EntityPicker<FullLookupItem> full … />`) to read those extra fields.
   */
  full?: boolean;
  /**
   * `entity="contacts"`: hide the contacts already linked to this matter, for
   * the picker that adds one to it.
   */
  excludeMatterId?: string;
  /** Restrict the options to specific entity IDs. */
  ids?: string[];
}

const SEARCH_PLACEHOLDER: Record<LookupEntity, string> = {
  matters: "Search matters…",
  clients: "Search clients…",
  tasks: "Search tasks…",
  contacts: "Search contacts…",
};

/**
 * Select-style picker whose options come from a server typeahead instead of a
 * fully loaded list, so it stays usable for firms with thousands of matters,
 * clients or tasks.
 *
 * Two queries back it: one for what the user is typing, and one that resolves
 * the label of whatever is already selected. The second is what keeps the
 * trigger readable when the selection is archived, renamed, or simply past the
 * first page of search results.
 */
export default function EntityPicker<T extends LookupItem = LookupItem>({
  entity,
  lawFirmId,
  value,
  onChange,
  onSelectItem,
  label,
  placeholder = "Select…",
  disabled = false,
  portal = false,
  className,
  buttonClassName,
  labelClassName,
  icon,
  emptyOption,
  clientId,
  matterId,
  excludeArchived,
  clientType,
  excludeLinkedToClientId,
  portalOnly,
  full,
  excludeMatterId,
  ids,
}: EntityPickerProps<T>) {
  const [open, setOpen] = useState(false);
  // Raw input for a responsive field, plus the debounced value that actually
  // reaches the server.
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Only search while the menu is open: a form with several pickers would
  // otherwise fire a request per picker on mount.
  const { items, hasMore, loading, isPlaceholder } = useEntityLookup<T>(entity, lawFirmId, {
    search: debouncedSearch,
    enabled: open,
    clientId,
    matterId,
    excludeArchived,
    clientType,
    excludeLinkedToClientId,
    portalOnly,
    full,
    excludeMatterId,
    ids,
  });

  const selectedIds = useMemo(() => (value ? [value] : []), [value]);
  // The label lookup carries the same scope as the search. Resolving the
  // selection unscoped would keep a now-out-of-scope id looking valid in the
  // trigger (and selectable in the list) after the scope changed underneath it.
  // `excludeArchived` is the one scope the server does not apply here, so an
  // archived client saved on an existing record still shows its name.
  const { items: selectedItems } = useEntityByIds<T>(entity, lawFirmId, selectedIds, {
    clientId,
    matterId,
    excludeArchived,
    clientType,
    excludeLinkedToClientId,
    portalOnly,
    full,
    excludeMatterId,
  });

  // Every row either query has ever produced, kept for as long as the picker is
  // mounted. Choosing an option closes the menu, which disables the search query
  // and resets its term, so the row the user just picked can leave `items`
  // before the id-resolution query has fetched it - a gap in which the trigger
  // has nothing to label the selection with and falls back to the placeholder.
  // Remembering the row closes that gap: it was on screen a moment ago, so it is
  // by definition already known.
  const seenItems = useRef(new Map<string, T>());
  useEffect(() => {
    for (const item of [...selectedItems, ...items]) {
      if (item?.id) seenItems.current.set(item.id, item);
    }
  }, [selectedItems, items]);

  // Selected first, then search results, deduped by id. The order matters: it
  // is what guarantees the trigger has a label before the search resolves, and
  // when the selection is not among the results at all.
  const knownItems = useMemo(() => {
    const byId = new Map<string, T>();
    for (const item of [...selectedItems, ...items]) {
      if (item?.id && !byId.has(item.id)) byId.set(item.id, item);
    }
    const rows = Array.from(byId.values());
    // The remembered row is a fallback only: whenever a query currently carries
    // the selection, that fresher copy wins, so a rename never lingers.
    const remembered = value ? seenItems.current.get(value) : undefined;
    return remembered && !byId.has(value) ? [remembered, ...rows] : rows;
  }, [selectedItems, items, value]);

  const options = useMemo<DropdownOption[]>(() => {
    const rows = knownItems.map((item) => ({
      value: item.id,
      label: item.sublabel ? `${item.label} (${item.sublabel})` : item.label,
    }));
    // "All"/"None" belongs to browsing, not a non-empty search result set.
    return emptyOption && !searchInput.trim() ? [emptyOption, ...rows] : rows;
  }, [knownItems, emptyOption, searchInput]);

  // The menu blanks itself while searching, so this must mean "what is on
  // screen does not answer what was typed" and nothing wider: either the
  // debounce has not caught up yet, or the rows showing are the previous term's,
  // held over while the new term loads. A background refetch of the term already
  // displayed is excluded on purpose - it re-fetches rows the menu is already
  // showing correctly, and blanking them for it makes reopening a picker flash.
  const searching =
    open &&
    (searchInput.trim() !== debouncedSearch.trim() ||
      isPlaceholder ||
      (loading && items.length === 0));

  const handleChange = (next: string) => {
    onChange(next);
    onSelectItem?.(knownItems.find((item) => item.id === next) ?? null);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    // Start each visit to the menu from an unfiltered list.
    if (!next) {
      setSearchInput("");
      setDebouncedSearch("");
    }
  };

  // Dropdown renders this after every option (inside the scrolling list), so it
  // only comes into view once the user reaches the bottom of the result window,
  // whether that window is the unfiltered list or a search result set.
  const overflowNote = lookupOverflowNote(hasMore, searchInput);

  return (
    <Dropdown
      label={label}
      value={value}
      onChange={handleChange}
      options={options}
      placeholder={placeholder}
      disabled={disabled}
      portal={portal}
      className={className}
      buttonClassName={buttonClassName}
      labelClassName={labelClassName}
      leading={icon}
      searchValue={searchInput}
      onSearchChange={setSearchInput}
      onOpenChange={handleOpenChange}
      loading={searching}
      clearOptionsWhileLoading
      searchPlaceholder={SEARCH_PLACEHOLDER[entity]}
      footerNote={overflowNote}
    />
  );
}
