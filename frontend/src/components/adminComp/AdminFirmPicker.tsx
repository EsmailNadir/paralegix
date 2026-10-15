"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import adminService, { type AdminLawFirmLookupItem } from "@/services/admin.service";
import { LOOKUP_PAGE_SIZE, SEARCH_DEBOUNCE_MS, lookupOverflowNote } from "@/lib/constants/search";

interface AdminFirmPickerProps {
  value: string;
  onChange: (lawFirmId: string) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  portal?: boolean;
}

/**
 * Firm picker for the platform-admin console, backed by the cross-tenant
 * `/admin/lawfirms/lookup` typeahead.
 *
 * This is the admin-side counterpart to `EntityPicker`: the firm list grows with
 * the whole business, so the options come from a server search rather than a full
 * download, and the label of an already-selected id is resolved on its own so the
 * trigger stays readable when the selection is not in the current results.
 */
export default function AdminFirmPicker({
  value,
  onChange,
  label,
  placeholder = "Select a law firm",
  disabled = false,
  portal = false,
}: AdminFirmPickerProps) {
  const [open, setOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Only search while the menu is open, so mounting the form costs no request.
  const search = useQuery({
    queryKey: ["adminFirmLookup", "search", debouncedSearch],
    queryFn: () =>
      adminService.lookupLawFirms({ search: debouncedSearch, limit: LOOKUP_PAGE_SIZE }),
    enabled: open,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const selected = useQuery({
    queryKey: ["adminFirmLookup", "ids", value],
    queryFn: () => adminService.lookupLawFirms({ ids: [value] }),
    enabled: !!value,
    staleTime: 5 * 60_000,
  });

  // Selected first, then search results, deduped by id. The order is what
  // guarantees the trigger has a label before the search resolves, and when the
  // selection is not among the results at all.
  const options = useMemo<DropdownOption[]>(() => {
    const byId = new Map<string, AdminLawFirmLookupItem>();
    for (const item of [...(selected.data?.items ?? []), ...(search.data?.items ?? [])]) {
      if (item?.id && !byId.has(item.id)) byId.set(item.id, item);
    }
    return Array.from(byId.values()).map((item) => ({
      value: item.id,
      label: item.sublabel ? `${item.label} (${item.sublabel})` : item.label,
    }));
  }, [selected.data, search.data]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    // Start each visit to the menu from an unfiltered list.
    if (!next) {
      setSearchInput("");
      setDebouncedSearch("");
    }
  };

  const searching = open && (search.isFetching || searchInput.trim() !== debouncedSearch.trim());

  return (
    <Dropdown
      label={label}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder}
      disabled={disabled}
      portal={portal}
      searchValue={searchInput}
      onSearchChange={setSearchInput}
      onOpenChange={handleOpenChange}
      loading={searching}
      clearOptionsWhileLoading
      searchPlaceholder="Search law firms…"
      footerNote={lookupOverflowNote(search.data?.hasMore, searchInput)}
    />
  );
}
