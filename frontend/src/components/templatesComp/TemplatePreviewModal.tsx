"use client";

import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import LoadingSpinner from "@/components/LoadingSpinner";
import PdfPreview from "@/components/filesComp/PdfPreview";
import ZoomControls from "@/components/ui/ZoomControls";
import DocumentViewerModal from "@/components/ui/DocumentViewerModal";
import ActionIconButton from "@/components/ui/ActionIconButton";
import { useDocumentZoom } from "@/hooks/useDocumentZoom";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import type { TemplatePreviewContent } from "./useTemplatePreview";

/**
 * Read-only render of a template as it will look when filled: the HTML itself
 * for HTML templates, and the document's PDF for the DOCX and Document Overlay
 * ones, which have no HTML to show.
 */
export default function TemplatePreviewModal({
  open,
  content,
  name,
  onClose,
}: {
  open: boolean;
  content: TemplatePreviewContent | null;
  name: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const { zoom, zoomIn, zoomOut, resetZoom, zoomAreaProps } = useDocumentZoom({ enabled: open });

  // A PDF is fetched by pdf.js and then rasterised, so the dialog holds a
  // spinner over the empty page stack until pdf.js reports the document
  // loaded.
  const [rendering, setRendering] = useState(true);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a newly opened document is rasterised from scratch, so the spinner returns with it
    setRendering(true);
  }, [content]);

  // The next template opens at the zoom this one opened at, not the one it was
  // left on, and gets there after the dialog is gone rather than in front of it.
  useResetAfterClose(open, resetZoom);

  return (
    <DocumentViewerModal presentation="template"
      isOpen={open}
      onClose={onClose}
      labelledBy={titleId}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-outline px-5 py-3">
        <h2 id={titleId} className="truncate text-sm font-semibold text-on-surface">
          {name ? `${name} Preview` : "Template Preview"}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {content?.kind === "pdf" && (
            <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
          )}
          <ActionIconButton label="Close preview" onClick={onClose}>
            <X size={16} />
          </ActionIconButton>
        </div>
      </div>
      {content?.kind === "pdf" ? (
        <div {...zoomAreaProps} className="relative min-h-0 flex-1 p-3">
          {rendering && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/80 backdrop-blur-[1px]">
              <LoadingSpinner />
            </div>
          )}
          <PdfPreview
            url={content.url}
            zoom={zoom}
            onLoaded={() => setRendering(false)}
            onError={() => setRendering(false)}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <iframe
            src={content?.url}
            // Empty sandbox: render the styled HTML and images in an opaque
            // origin with scripts disabled, so any markup that slipped past the
            // server sanitizer still cannot execute in the app's origin.
            sandbox=""
            className="h-full w-full border-0"
            title="Template Preview"
          />
        </div>
      )}
    </DocumentViewerModal>
  );
}
