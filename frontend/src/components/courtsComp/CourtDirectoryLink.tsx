'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Library } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import CourtCatalogPickerModal from './CourtCatalogPickerModal';

interface Props {
  /** Firm id. Falls back to the [lawFirmId] route param when omitted. */
  lawFirmId?: string;
  /** Optional extra callback after courts are adopted (e.g. a manual reload). */
  onAdopted?: () => void;
  className?: string;
}

/**
 * Inline "Browse directory" trigger + court-catalog picker. Drop it next to any
 * court selector (matter/task modals, settings) to let users add courts from the
 * national directory without leaving the form.
 *
 * On adopt it invalidates the shared ['courts', lawFirmId] React Query cache, so
 * every consumer of useCourts (matter modals, task grid, etc.) refreshes
 * automatically. Callers that load courts another way can pass onAdopted.
 */
export default function CourtDirectoryLink({ lawFirmId, onAdopted, className }: Props) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const params = useParams();
  const routeFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string | undefined);
  const firmId = lawFirmId || routeFirmId;
  if (!firmId) return null;

  const handleAdopted = () => {
    queryClient.invalidateQueries({ queryKey: ['courts', firmId] });
    onAdopted?.();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`text-xs text-accent-emphasis hover:underline inline-flex items-center gap-1 ${className || ''}`}
      >
        <Library size={12} /> Browse directory
      </button>
      <CourtCatalogPickerModal
        open={open}
        lawFirmId={firmId}
        onClose={() => setOpen(false)}
        onAdopted={handleAdopted}
        stacked
      />
    </>
  );
}
