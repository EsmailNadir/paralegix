'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import PdfCanvasPage from '@/components/ui/PdfCanvasPage';
import ScrollArea from '@/components/ui/ScrollArea';
import { useSettledZoom } from '@/hooks/useDocumentZoom';
import { usePdfPageWindow, MAX_RENDERED_CANVASES } from '@/hooks/usePdfPageWindow';
import { pdfSourceKey, pdfUrlSource } from '@/lib/pdfLoadingOptions';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// Every page of the document is rasterised at once, so the resolution they are
// rasterised at is capped: past this the page is presented by scaling the canvas
// instead of redrawing it at a size that would cost hundreds of megabytes a page.
const MAX_RENDER_ZOOM = 200;

// Re-exported for the specs and call sites that reason about this component's
// page budget; the value itself is shared with every other PDF viewer.
export { MAX_RENDERED_CANVASES };

interface PdfPreviewProps {
  /** The document as bytes already in memory. Handed to pdf.js as-is rather
   *  than fetched from a `url` (which, for every such caller, is a `blob:`
   *  one). That sidesteps a pdf.js interaction where React Strict Mode's
   *  mount-unmount-remount in dev aborts the in-flight blob fetch and pdf.js
   *  reports it as a permanent "Unexpected server response (0)" instead of a
   *  cancellation. The right choice for anything that fits in memory. */
  bytes?: Uint8Array;
  /** The document by https url, for one too large to hold whole. pdf.js opens
   *  the url itself and fetches only the byte ranges of the pages it renders,
   *  which the bucket permits: `Accept-Ranges` and `Content-Range` are exposed
   *  over CORS. Exactly one of `bytes` and `url` is given. */
  url?: string;
  /** Zoom level as a percentage (100 = fit width). */
  zoom: number;
  onLoaded?: () => void;
  onError?: (message: string) => void;
}

/**
 * Renders every page of a PDF stacked vertically in a scrollable container.
 * Zoom drives the rendered page width so all pages stay legible while scrolling.
 */
export default function PdfPreviewDocument({ bytes, url, zoom, onLoaded, onError }: PdfPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [numPages, setNumPages] = useState(0);

  // Height-to-width ratio per page, so a page's box can be sized before its
  // canvas exists. Pages within one PDF can differ, hence per page number.
  const [pageRatios, setPageRatios] = useState<Record<number, number>>({});

  /**
   * Which document is on screen, as identity rather than as a url.
   *
   * A signed url is reminted over the SAME object when it nears expiry, so only
   * its query changes. Treating that as a new document would discard every page
   * measurement and put the reader back at page 1 in the middle of reading.
   */
  const sourceKey: string | Uint8Array | undefined = bytes ?? pdfSourceKey(url);
  const [loadedKey, setLoadedKey] = useState(sourceKey);
  if (loadedKey !== sourceKey) {
    // Adjusting state during render rather than in an effect, so the new
    // document's first frame is already measured from scratch instead of being
    // laid out once with the previous one's page sizes.
    setLoadedKey(sourceKey);
    setPageRatios({});
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handlePageLoad = useCallback(
    (pageNumber: number, page: { width: number; height: number }) => {
      if (!page.width) return;
      const ratio = page.height / page.width;
      setPageRatios((prev) => (prev[pageNumber] === ratio ? prev : { ...prev, [pageNumber]: ratio }));
    },
    [],
  );

  // Base "fit width" leaves room for padding; zoom scales relative to that.
  const baseWidth = Math.min(containerWidth - 32, 1000);
  // What the canvases are rasterised at trails the live zoom, so a gesture
  // redraws them once it settles rather than on every step of the way.
  const renderZoom = Math.min(useSettledZoom(zoom), MAX_RENDER_ZOOM);
  const renderWidth = baseWidth > 0 ? baseWidth * (renderZoom / 100) : 0;
  const displayWidth = baseWidth > 0 ? baseWidth * (zoom / 100) : 0;

  /**
   * Which pages may hold a canvas right now, and which one the reader is on.
   * Shared with every other PDF viewer, so all of them bound their rasters the
   * same way and a fix to one reaches the rest.
   */
  const pageWindow = usePdfPageWindow({ numPages, documentKey: sourceKey });

  // pdf.js transfers (detaches) the underlying ArrayBuffer of whatever Uint8Array
  // it's given to its worker, so a `.slice()` copy goes in here rather than
  // `bytes` itself, which the caller may still hold onto elsewhere.
  //
  // Memoised, and stable while the url is: react-pdf reloads the whole document
  // whenever this object changes identity, so a fresh one per render would undo
  // the ranged reading the options in it are there to buy.
  const pdfSource = useMemo(
    () => (bytes ? { data: bytes.slice() } : pdfUrlSource(url ?? '')),
    [bytes, url],
  );

  return (
    // The measured element sits outside the scroller: ScrollArea's bars overlay the
    // content rather than taking a gutter, so this box and the viewport inside it
    // are the same width, and the pages keep being measured against a stable one.
    <div ref={containerRef} className="w-full h-full">
    <ScrollArea className="w-full h-full bg-surface-alt rounded-lg">
      <Document
        file={pdfSource}
        // width:max-content + min-width:100% + auto side margins centers the page
        // stack when it fits, but lets a zoomed-in page (wider than the frame) scroll
        // horizontally to both edges instead of being clipped by flex centering.
        className="w-max min-w-full mx-auto flex flex-col items-center gap-4 py-4"
        onLoadSuccess={(pdf) => {
          setNumPages(pdf.numPages);
          onLoaded?.();
        }}
        onLoadError={(err) => onError?.(err?.message || 'Failed to load PDF')}
        // The parent FilePreviewModal renders its own overlay spinner while the
        // PDF loads, so suppress react-pdf's built-in one to avoid a duplicate.
        loading={null}
        error={
          <div className="flex items-center justify-center h-64 text-red-500 text-sm">
            Failed to load PDF.
          </div>
        }
      >
        {renderWidth > 0 &&
          Array.from({ length: numPages }, (_, i) => {
            const pageNumber = i + 1;
            const ratio = pageRatios[pageNumber];
            const height = ratio ? displayWidth * ratio : displayWidth * 1.294;
            const drawn = pageWindow.isDrawn(pageNumber);
            return (
              // The slot always exists and always occupies the page's height, so
              // the scroller measures the whole document and any page can be
              // reached. Only the canvas inside comes and goes.
              <div
                key={pageNumber}
                data-testid={`page-slot-${pageNumber}`}
                ref={(node) => pageWindow.observePage(node, pageNumber)}
                className="shrink-0"
                style={{ width: displayWidth || undefined, height: drawn ? undefined : height }}
              >
                {drawn && (
                  <PdfCanvasPage
                    className="shadow-sm shrink-0"
                    pageNumber={pageNumber}
                    renderWidth={renderWidth}
                    displayWidth={displayWidth}
                    displayHeight={ratio ? displayWidth * ratio : 0}
                    onLoadSuccess={(page) => handlePageLoad(pageNumber, page)}
                  />
                )}
              </div>
            );
          })}
      </Document>
    </ScrollArea>
    </div>
  );
}
