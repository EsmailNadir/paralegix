'use client';

import { useCallback } from 'react';
import CatalogPickerModal from '@/components/ui/CatalogPickerModal';
import catalogService, { type CatalogCourt } from '@/services/catalog.service';

interface Props {
  open: boolean;
  lawFirmId: string;
  onClose: () => void;
  onAdopted: () => void;
  /** Render above another open dialog (the matter and task forms open this). */
  stacked?: boolean;
}

/** "state" -> "State", "bankruptcy_panel" -> "Bankruptcy Panel". */
const titleCase = (s?: string | null) =>
  (s || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Browse the global court directory (court_catalog) and add selected courts to
 * the firm. Adopted courts become editable per-firm rows (copy-on-adopt).
 */
export default function CourtCatalogPickerModal({ open, lawFirmId, onClose, onAdopted, stacked }: Props) {
  const search = useCallback(async (query: string) => {
    if (!lawFirmId) return { items: [], total: 0 };
    const res = await catalogService.searchCourts(lawFirmId, { search: query, limit: 50 });
    return { items: res.items || [], total: res.totalItems || 0 };
  }, [lawFirmId]);

  const onAdopt = useCallback(async (ids: string[]) => {
    await catalogService.adoptCourts(lawFirmId, ids);
  }, [lawFirmId]);

  return (
    <CatalogPickerModal<CatalogCourt>
      open={open}
      onClose={onClose}
      onAdopted={onAdopted}
      stacked={stacked}
      title="Browse court directory"
      description="Search the national directory and add courts to your firm. You can edit them afterward."
      searchPlaceholder="Search by name, abbreviation, or state…"
      mode="search"
      search={search}
      debounceMs={300}
      getId={(c) => c.id}
      isAlreadyAdded={(c) => !!c.alreadyAdded}
      renderRow={(c, { alreadyAdded }) => (
        <>
          <span className="block min-w-0 flex-1">
            <span className="block text-sm font-medium text-on-surface truncate">{c.fullName}</span>
            <span className="block text-xs text-on-surface-secondary truncate">
              {[c.citationAbbrev, titleCase(c.jurisdiction), titleCase(c.courtType)].filter(Boolean).join(' · ')}
            </span>
          </span>
          {alreadyAdded && (
            <span className="text-[10px] font-medium text-on-surface-muted shrink-0">Added</span>
          )}
        </>
      )}
      loadingLabel="Searching…"
      emptyLabel="No courts found. Try a different search, or close this and add a custom court."
      adoptLabel={(n) => `Add ${n > 0 ? n : ''} court${n === 1 ? '' : 's'}`}
      errorFallback="Failed to search the court directory"
      adoptErrorFallback="Failed to add courts"
      onAdopt={onAdopt}
    />
  );
}
