'use client';

import { useState } from 'react';
import { Layers, FileText, AlertCircle, X } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Spinner from '@/components/ui/Spinner';
import { formatBytes } from '@/lib/utils/format';
import { flattenPdf, FLATTEN_MAX_BYTES, flattenTooLargeMessage } from '@/lib/pdfFlatten';
import { useLastOpenValue, useResetAfterClose } from '@/hooks/useMountTransition';

interface FlattenPdfModalProps {
  file: File | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (flattenedFile: File) => Promise<void>;
}

export default function FlattenPdfModal({
  file,
  isOpen,
  onClose,
  onSuccess,
}: FlattenPdfModalProps) {
  const [flattening, setFlattening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preserve the file details through the close animation so content doesn't abruptly unmount
  const activeFile = useLastOpenValue(isOpen, file);
  useResetAfterClose(isOpen, () => {
    setError(null);
    setFlattening(false);
  });

  if (!activeFile) return null;

  // Known before anything is tried, so the reason and the manual route show up
  // front and the button stays off, rather than a click freezing the tab.
  const tooLarge = activeFile.size > FLATTEN_MAX_BYTES;
  const shownError = tooLarge ? flattenTooLargeMessage(activeFile.size) : error;

  const handleFlatten = async () => {
    if (!activeFile || tooLarge) return;
    setError(null);
    setFlattening(true);
    try {
      const result = await flattenPdf(activeFile);
      await onSuccess(result.file);
      onClose();
    } catch (err: any) {
      setError(
        err?.message ||
          'Unable to flatten this PDF automatically. Please open it in your viewer and select File > Print > Save as PDF to flatten it manually.'
      );
    } finally {
      setFlattening(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!flattening) onClose();
      }}
      title="Flatten Document for Signing"
      size="md"
      closeIcon={<X size={18} strokeWidth={2} />}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={flattening}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-outline text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface disabled:opacity-50 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleFlatten}
            disabled={flattening || tooLarge}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover disabled:opacity-50 transition-colors cursor-pointer"
          >
            {flattening && <Spinner size={14} />}
            <span>{flattening ? 'Flattening document...' : 'Flatten and Upload'}</span>
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border border-outline-subtle bg-surface-alt/40 p-3.5">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-emphasis">
            <Layers size={20} />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-on-surface">
              Why does this document need flattening?
            </p>
            <p className="text-xs leading-relaxed text-on-surface-secondary">
              This PDF contains interactive form fields or dynamic widgets. For legal e-signatures,
              documents must be permanently sealed into static pages so the signed contents cannot
              be altered or rendered differently across devices.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-outline-subtle bg-surface p-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <FileText size={18} className="text-on-surface-muted shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-on-surface truncate">
                {activeFile.name}
              </p>
              <p className="text-[11px] text-on-surface-muted">
                {formatBytes(activeFile.size)}
              </p>
            </div>
          </div>
          <span className="shrink-0 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2 py-0.5 text-[11px] font-medium">
            Interactive form
          </span>
        </div>

        <p className="text-xs text-on-surface-muted leading-relaxed">
          Clicking <strong>Flatten and Upload</strong> will convert all form fields into permanent,
          static text directly in your browser with zero server overhead.
        </p>

        {shownError && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800/50 bg-red-50/70 dark:bg-red-900/20 p-3 text-xs text-red-600 dark:text-red-400">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>{shownError}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
