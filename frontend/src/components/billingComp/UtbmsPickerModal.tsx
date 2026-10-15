'use client';

import { useCallback } from 'react';
import CatalogPickerModal from '@/components/ui/CatalogPickerModal';
import catalogService, { type UtbmsCode } from '@/services/catalog.service';

interface Props {
  open: boolean;
  lawFirmId: string;
  codeType: 'task' | 'expense';
  title: string;
  onClose: () => void;
  onAdopted: () => void;
}

/**
 * Browse the UTBMS catalog and import selected codes into the firm's charge
 * codes (task codes) or expense categories (expense codes). Copy-on-adopt: each
 * import becomes an editable per-firm row linked to the UTBMS entry.
 */
export default function UtbmsPickerModal({ open, lawFirmId, codeType, title, onClose, onAdopted }: Props) {
  const loadItems = useCallback(async () => {
    const res = await catalogService.listUtbms(lawFirmId, codeType);
    return res.utbmsCodes || [];
  }, [lawFirmId, codeType]);

  const filterItem = useCallback((c: UtbmsCode, query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q);
  }, []);

  const onAdopt = useCallback(async (ids: string[]) => {
    if (codeType === 'task') await catalogService.adoptChargeCodes(lawFirmId, ids);
    else await catalogService.adoptExpenseCategories(lawFirmId, ids);
  }, [lawFirmId, codeType]);

  return (
    <CatalogPickerModal<UtbmsCode>
      open={open}
      onClose={onClose}
      onAdopted={onAdopted}
      title={title}
      description="Standard ABA/LEDES UTBMS codes. Selected codes are added to your firm and stay editable. Codes you already have are skipped."
      searchPlaceholder="Filter by code or description…"
      mode="filter"
      loadItems={loadItems}
      filterItem={filterItem}
      getId={(c) => c.id}
      renderRow={(c) => (
        <>
          <span className="inline-flex w-14 shrink-0 items-center rounded bg-surface-alt px-2 py-0.5 text-[11px] font-mono font-medium text-on-surface-muted border border-outline-subtle">
            {c.code}
          </span>
          <span className="text-sm text-on-surface truncate">{c.name}</span>
        </>
      )}
      loadingLabel="Loading…"
      emptyLabel="No matching codes."
      adoptLabel={(n) => `Import ${n > 0 ? n : ''}`}
      errorFallback="Failed to load UTBMS codes"
      adoptErrorFallback="Failed to import codes"
      onAdopt={onAdopt}
    />
  );
}
