'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Printer, X } from 'lucide-react';
import LoadingSpinner from '@/components/LoadingSpinner';
import DocumentViewerModal, { DocumentViewerHeader } from "@/components/ui/DocumentViewerModal";
import ActionIconButton from '@/components/ui/ActionIconButton';

interface NotePrintPreviewModalProps {
  isOpen: boolean;
  lawFirmId: string;
  matterId: string;
  noteId: string | null;
  onClose: () => void;
}

/**
 * Previews a note's print view in a dialog before handing it to the browser's
 * print dialog, the same way a signed document or invoice is read here rather
 * than dropped into a stray new tab.
 */
export default function NotePrintPreviewModal({
  isOpen,
  lawFirmId,
  matterId,
  noteId,
  onClose,
}: NotePrintPreviewModalProps) {
  const titleId = useId();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);

  // Keep the last opened note rendered through the exit animation, after the
  // parent clears the target on close.
  const lastTargetRef = useRef<string | null>(null);
  if (noteId) lastTargetRef.current = noteId;
  const targetNoteId = noteId || lastTargetRef.current;

  // Closing (or switching notes) puts the iframe back into its loading state,
  // so the next note opens on its own spinner rather than briefly showing the
  // previous note's content.
  useEffect(() => {
    if (!isOpen || !noteId) return;
    return () => setLoading(true);
  }, [isOpen, noteId]);

  if (!targetNoteId) return null;

  const printUrl = `/lawfirm/${lawFirmId}/matters/${matterId}/notes/${targetNoteId}/print`;

  const handlePrint = () => {
    iframeRef.current?.contentWindow?.print();
  };

  return (
    <DocumentViewerModal presentation="document"
      isOpen={isOpen && !!noteId}
      onClose={onClose}
      labelledBy={titleId}
    >
      {/* Header */}
      <DocumentViewerHeader>
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="shrink-0 p-1.5 bg-surface rounded border border-outline">
            <Printer size={16} className="text-on-surface-muted" />
          </div>
          <div className="min-w-0">
            <h3 id={titleId} className="text-sm font-semibold text-on-surface truncate">
              Print preview
            </h3>
            <p className="text-xs text-on-surface-muted">Note</p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handlePrint}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-on-surface bg-surface-alt border border-outline rounded-md hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 cursor-pointer"
          >
            <Printer size={14} />
            Print
          </button>
          <ActionIconButton label="Close preview" onClick={onClose}>
            <X size={16} />
          </ActionIconButton>
        </div>
      </DocumentViewerHeader>

      {/* Content */}
      <div className="flex-1 min-h-0 relative p-3">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-surface/80 backdrop-blur-[1px]">
            <div className="flex flex-col items-center gap-2 text-center">
              <LoadingSpinner />
              <p className="text-sm text-on-surface-secondary">Loading note...</p>
            </div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={printUrl}
          title="Note print preview"
          className="w-full h-full rounded-lg bg-surface-alt border border-outline-subtle"
          onLoad={() => setLoading(false)}
        />
      </div>
    </DocumentViewerModal>
  );
}
