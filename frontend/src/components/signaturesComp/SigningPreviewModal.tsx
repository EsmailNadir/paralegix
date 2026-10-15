'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Award, Download, FileText, X } from 'lucide-react';
import ErrorNotification from '@/components/ErrorNotification';
import LoadingSpinner from '@/components/LoadingSpinner';
import PdfPreview from '@/components/filesComp/PdfPreview';
import DocumentViewerModal, { DocumentViewerHeader } from "@/components/ui/DocumentViewerModal";
import Spinner from '@/components/ui/Spinner';
import ZoomControls from '@/components/ui/ZoomControls';
import { useDocumentZoom } from '@/hooks/useDocumentZoom';
import { useRefreshingReadUrl } from '@/hooks/useRefreshingReadUrl';
import signaturesService from '@/services/signatures.service';
import { getErrorMessage } from '@/lib/utils/apiErrors';

/**
 * Which of a completed session's two PDFs is on screen. They are separate
 * documents with separate buttons: the executed document is what was signed, the
 * certificate is the record of how it was signed.
 */
export type SigningPreviewKind = 'document' | 'certificate';

interface SigningPreviewModalProps {
  isOpen: boolean;
  kind: SigningPreviewKind;
  /** Session token of the completed session being read. */
  token: string | null;
  /** The document's own name, shown as the dialog title. */
  fileName: string | null;
  onClose: () => void;
  onDownload: () => void;
  /** True while that download is in flight. */
  downloading?: boolean;
}

const KIND_COPY: Record<SigningPreviewKind, { subtitle: string; loading: string; failed: string }> = {
  document: {
    subtitle: 'Signed document',
    loading: 'Loading signed document...',
    failed: 'Failed to load the signed document',
  },
  certificate: {
    subtitle: 'Certificate of completion',
    loading: 'Loading certificate...',
    failed: 'Failed to load the certificate',
  },
};

/**
 * Reads a completed session's PDF in a dialog, the same way the file browser
 * previews one, rather than handing the reader a download or a stray browser tab.
 *
 * The executed document is shown without the Signature Certificate page appended
 * to the filed copy - the certificate opens here in its own right, so it does not
 * sit in the way of the pages someone opened this to read.
 */
export default function SigningPreviewModal({
  isOpen,
  kind,
  token,
  fileName,
  onClose,
  onDownload,
  downloading = false,
}: SigningPreviewModalProps) {
  const titleId = useId();

  // Keep the last opened document rendered through the exit animation, after the
  // parent clears the target on close.
  const lastTargetRef = useRef<{ token: string; fileName: string | null; kind: SigningPreviewKind } | null>(null);
  if (token) lastTargetRef.current = { token, fileName, kind };
  const target = token ? { token, fileName, kind } : lastTargetRef.current;

  // Fetching starts as soon as a token arrives, so both flags open in their
  // in-flight state and are cleared by the load rather than set by it.
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [documentUrl, setDocumentUrl] = useState<string | null>(null);
  const { zoom, zoomIn, zoomOut, resetZoom, zoomAreaProps } = useDocumentZoom({ enabled: isOpen });

  const refreshDocument = async () => {
    if (!target) throw new Error('No document is selected.');
    return target.kind === 'certificate'
      ? (await signaturesService.getCertificateUrl(target.token, 'inline')).url
      : (await signaturesService.getSignedDocumentUrl(target.token, 'inline', 'without-certificate')).url;
  };
  const refreshing = useRefreshingReadUrl({
    url: documentUrl,
    enabled: isOpen && !!documentUrl,
    refresh: refreshDocument,
  });

  useEffect(() => {
    if (!isOpen || !token) return;

    let cancelled = false;

    const load = kind === 'certificate'
      ? signaturesService.getCertificateUrl(token, 'inline')
      : signaturesService.getSignedDocumentUrl(token, 'inline', 'without-certificate');

    load
      .then(({ url }) => {
        if (cancelled) return;
        setDocumentUrl(url);
      })
      .catch((err) => {
        if (cancelled) return;
        setRendering(false);
        setError(getErrorMessage(err, KIND_COPY[kind].failed));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // Closing drops the document and puts every control back to its opening
    // state, so the next session opens on its own document rather than briefly
    // showing the previous one at the previous zoom.
    return () => {
      cancelled = true;
      setDocumentUrl(null);
      setError(null);
      setLoading(true);
      setRendering(true);
      resetZoom();
    };
  }, [isOpen, token, kind, resetZoom]);

  if (!target) return null;

  const copy = KIND_COPY[target.kind];
  const TitleIcon = target.kind === 'certificate' ? Award : FileText;

  return (
    <DocumentViewerModal presentation="document"
      isOpen={isOpen && !!token}
      onClose={onClose}
      labelledBy={titleId}
    >
          {/* Header */}
          <DocumentViewerHeader>
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="shrink-0 p-1.5 bg-surface rounded border border-outline">
                <TitleIcon size={16} className="text-on-surface-muted" />
              </div>
              <div className="min-w-0">
                <h3 id={titleId} className="text-sm font-semibold text-on-surface truncate">
                  {target.fileName || copy.subtitle}
                </h3>
                <p className="text-xs text-on-surface-muted">{copy.subtitle}</p>
              </div>
            </div>

            <ZoomControls className="shrink-0" zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />

            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={onDownload}
                disabled={downloading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-on-surface bg-surface-alt border border-outline rounded-md hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 cursor-pointer"
              >
                {downloading ? <Spinner size={14} /> : <Download size={14} />}
                Download
              </button>
              <button
                onClick={onClose}
                aria-label="Close preview"
                className="p-1.5 rounded-md text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>
          </DocumentViewerHeader>

          {/* Content */}
          <div className="flex-1 min-h-0 flex flex-col p-3">
            <ErrorNotification error={error} onClose={() => setError(null)} className="mb-3" />

            {!error && (
              <div {...zoomAreaProps} className="relative flex-1 min-h-0">
                {(loading || rendering) && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-surface/80 backdrop-blur-[1px]">
                    <div className="flex flex-col items-center gap-2 text-center">
                      <LoadingSpinner />
                      <p className="text-sm text-on-surface-secondary">{copy.loading}</p>
                    </div>
                  </div>
                )}

                {refreshing.readUrl && (
                  <PdfPreview
                    url={refreshing.readUrl}
                    zoom={zoom}
                    onLoaded={() => setRendering(false)}
                    onError={(message) => {
                      setRendering(false);
                      setError(message);
                    }}
                  />
                )}
              </div>
            )}
          </div>
    </DocumentViewerModal>
  );
}
