"use client";

import { useEffect, useMemo, useState } from "react";
import Dropdown from "@/components/ui/Dropdown";
import { useEntityLookup, type LookupItem } from "@/hooks/useEntityLookup";
import { SEARCH_DEBOUNCE_MS, lookupOverflowNote } from "@/lib/constants/search";

/**
 * "Add an existing client" search shared by the create/edit matter modals: a
 * server-backed typeahead (so it stays usable for a firm with thousands of
 * clients) that hands back the picked client instead of holding a persistent
 * selection, since each pick is immediately added to the matter's client list.
 */
export default function MatterClientPicker({
  lawFirmId,
  excludeIds,
  onSelect,
  disabled = false,
}: {
  lawFirmId: string;
  /** Ids already on the matter (or already queued), hidden from the results. */
  excludeIds: string[];
  onSelect: (client: { id: string; name: string; email: string; clientType?: 'person' | 'company' | null }) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  const { items, hasMore, loading } = useEntityLookup<LookupItem>("clients", lawFirmId, {
    search: debouncedSearch,
    enabled: open,
    excludeArchived: true,
  });

  const excludedSet = useMemo(() => new Set(excludeIds), [excludeIds]);
  const visibleItems = useMemo(
    () => items.filter((item) => !excludedSet.has(item.id)),
    [items, excludedSet]
  );

  const options = useMemo(
    () =>
      visibleItems.map((item) => ({
        value: item.id,
        label: item.sublabel ? `${item.label} (${item.sublabel})` : item.label,
      })),
    [visibleItems]
  );

  const handleChange = (id: string) => {
    const item = visibleItems.find((i) => i.id === id);
    if (!item) return;
    onSelect({
      id: item.id,
      name: item.label,
      email: typeof item.sublabel === "string" ? item.sublabel : "",
      // An organization keeps its legal name in `name` and has no `organization`
      // value of its own, so the conflict check downstream needs the type to know
      // which of the two search sets this name belongs in.
      clientType: item.clientType ?? null,
    });
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setSearchInput("");
      setDebouncedSearch("");
    }
  };
  const searching =
    open &&
    (loading || searchInput.trim() !== debouncedSearch.trim());

  return (
    <Dropdown
      value=""
      onChange={handleChange}
      options={options}
      placeholder="Search existing clients by name or email..."
      disabled={disabled}
      searchValue={searchInput}
      onSearchChange={setSearchInput}
      onOpenChange={handleOpenChange}
      loading={searching}
      clearOptionsWhileLoading
      searchPlaceholder="Search existing clients..."
      footerNote={lookupOverflowNote(hasMore, searchInput)}
      portal
    />
  );
}
