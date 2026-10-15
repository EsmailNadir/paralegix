'use client';

import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { Document, pdfjs } from 'react-pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { startPointerDrag } from '@/lib/utils/pointerDrag';
import { useSettledZoom } from '@/hooks/useDocumentZoom';
import { usePdfPageWindow } from '@/hooks/usePdfPageWindow';
import { pdfSourceKey, pdfUrlSource } from '@/lib/pdfLoadingOptions';
import type { ToolMode } from '@/types/signature';
import PdfScrollPage from './PdfScrollPage';
import { pageFromPointerTarget } from './pdfPointerPage';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// Past this the page is scaled rather than redrawn. Lower than a single-page
// viewer could afford, because several pages of the document are mounted at once.
const MAX_RENDER_ZOOM = 200;

function clampToPage(value: number, max: number) {
  return Math.max(0, Math.min(max, value));
}

interface PDFPageViewerProps {
  /** The document, either as bytes already in memory or by url alone.
   *
   *  With `bytes`, those are what get handed to pdf.js and `url` is display-only
   *  (used in error copy). Loading from bytes rather than fetching `url` sidesteps
   *  a pdf.js/blob-URL interaction where React Strict Mode's mount-unmount-remount
   *  in dev aborts the in-flight blob fetch and pdf.js reports it as a permanent
   *  "Unexpected server response (0)" instead of a cancellation.
   *
   *  Without `bytes`, pdf.js opens the url itself and fetches only the byte
   *  ranges of the pages being drawn, for a document too large to hold whole. */
  file: { url: string; bytes?: Uint8Array };
  mode: ToolMode;
  onDocumentLoad: (numPages: number) => void;
  /** The loaded pdf.js document, for a caller that needs the page proxies
   *  themselves rather than a page count: the overlay editor reads each page's
   *  text runs off them to report the font under a selection. Kept separate from
   *  `onDocumentLoad` so the three signing viewers, which only ever wanted the
   *  count, keep their existing signature. */
  onDocumentProxy?: (pdf: PDFDocumentProxy) => void;
  /** Which page is most in view, for the page indicator. */
  onVisiblePageChange?: (page: number) => void;
  onPageClick: (page: number, xPercent: number, yPercent: number, widthPercent?: number, heightPercent?: number) => void;
  /** Zoom level as a percentage (100 = fit width). */
  zoom?: number;
  /** Test seam: the container width before a ResizeObserver has reported one. */
  initialContainerWidth?: number;
  keyboardPlacement?: boolean;
  /** One page's overlays. Called once per page, with that page's number, its
   *  on-screen size, and (once measured) its intrinsic size in PDF points,
   *  which is what overlay text must be fitted against to reproduce the
   *  stamped PDF's layout independent of zoom. */
  children?: (
    page: number,
    pageWidth: number,
    pageHeight: number,
    pagePointSize?: { width: number; height: number },
  ) => React.ReactNode;
}

/**
 * The signing document, as one continuously scrollable stack of pages.
 *
 * It used to render exactly the page you were on, with prev/next buttons beneath
 * it, which meant reading a two-page engagement letter was a navigation exercise
 * and a field could only ever be placed on `currentPage`. Every page is now
 * mounted, so the page a pointer landed on is discovered from the DOM
 * (`pageFromPointerTarget`) rather than passed in, and overlays are rendered per
 * page through `children(page, width, height)`.
 *
 * Coordinates are unchanged: each page reports its own on-screen size and every
 * field stays a percentage of the page it sits on, so nothing downstream of this
 * component - least of all the stamping of the executed PDF - had to change.
 */
export default function PDFPageViewer({
  file,
  mode,
  onDocumentLoad,
  onDocumentProxy,
  keyboardPlacement = false,
  onVisiblePageChange,
  onPageClick,
  zoom = 100,
  initialContainerWidth,
  children,
}: PDFPageViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(initialContainerWidth ?? 0);
  const [numPages, setNumPages] = useState(0);
  // Height/width ratio per page. Pages in one PDF are not necessarily the same
  // size, so a single measurement can no longer stand in for all of them.
  const [pageRatios, setPageRatios] = useState<Record<number, number>>({});
  // Intrinsic page size in PDF points, for overlays that must lay text out the
  // way the stamped PDF will.
  const [pagePointSizes, setPagePointSizes] = useState<Record<number, { width: number; height: number }>>({});

  // Which handful of pages may hold a canvas, and which page the reader is on.
  // Shared with every other PDF viewer in the app: this used to be a local `Set`
  // that only ever grew, so reading a long document to the end left a raster
  // behind for every page of it.
  const pageWindow = usePdfPageWindow({
    numPages,
    onVisiblePageChange,
    // Reminting the read url over the same object must not count as a new
    // document, or a signer placing fields is thrown back to page 1.
    documentKey: file.bytes ?? pdfSourceKey(file.url),
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Held in a ref for the same reason `onVisiblePageChange` is below: callers
  // pass an inline arrow, and rebuilding the load handler on every render would
  // hand `Document` a new callback each time.
  const onDocumentProxyRef = useRef(onDocumentProxy);
  onDocumentProxyRef.current = onDocumentProxy;

  const handleDocumentLoad = useCallback(
    (pdf: PDFDocumentProxy) => {
      setNumPages(pdf.numPages);
      onDocumentLoad(pdf.numPages);
      onDocumentProxyRef.current?.(pdf);
    },
    [onDocumentLoad]
  );

  const handlePageLoad = useCallback((
    pageNumber: number,
    page: { width: number; height: number; originalWidth?: number; originalHeight?: number },
  ) => {
    setPageRatios((prev) => (
      prev[pageNumber] ? prev : { ...prev, [pageNumber]: page.height / page.width }
    ));
    // width/height are at the render scale, so they are no substitute here:
    // only the intrinsic size is meaningful as points.
    if (page.originalWidth && page.originalHeight) {
      const size = { width: page.originalWidth, height: page.originalHeight };
      setPagePointSizes((prev) => (
        prev[pageNumber] ? prev : { ...prev, [pageNumber]: size }
      ));
    }
  }, []);

  // Zoom drives the page's on-screen width, so the annotation overlays - which
  // are positioned from that width and the page's own bounding rect - stay
  // pinned to the same spot on the page at any zoom level.
  //
  // The canvas is rasterised at the zoom the gesture has settled on while the
  // page is presented at the live one, the gap between them taken up by a CSS
  // scale. Overlays are given the on-screen size and sit outside that scale, so
  // they and the hit-testing against each page stay in one coordinate space.
  const baseWidth = Math.min(containerWidth - 32, 900);
  const renderZoom = Math.min(useSettledZoom(zoom), MAX_RENDER_ZOOM);
  const renderWidth = baseWidth * (renderZoom / 100);
  const pageWidth = baseWidth * (zoom / 100);

  /**
   * The shape to assume for a page that has not been measured yet.
   *
   * A page only reports its ratio once its canvas renders, and a page is only
   * rasterised once it nears the viewport - so without a stand-in every deferred
   * page would have zero height, the whole document would collapse into the first
   * screenful, every page would count as visible, and all of them would rasterise
   * at once. The first measured page is the best guess (pages in one PDF are
   * almost always uniform), falling back to US Letter until there is one.
   */
  const measuredRatios = Object.values(pageRatios);
  const fallbackRatio = pageRatios[1] ?? measuredRatios[0] ?? 11 / 8.5;

  // --- Drag-to-size for field placement ---
  const [dragRect, setDragRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // Which page the in-progress rectangle belongs to, so it is drawn on that page
  // and not repeated on every one of them.
  const [dragPage, setDragPage] = useState<number | null>(null);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode === 'select' || !e.isPrimary) return;

      const hit = pageFromPointerTarget(e.target as HTMLElement);
      if (!hit) return;
      const { pageNumber, element: el } = hit;

      // A finger on the page background has to stay free to scroll the document,
      // so touch places a field by tapping it down rather than by dragging a size
      // out; only a mouse drags the rectangle.
      const sizeByDrag = e.pointerType === 'mouse';
      if (sizeByDrag) e.preventDefault();

      const elRect = el.getBoundingClientRect();
      const startX = clampToPage(e.clientX - elRect.left, elRect.width);
      const startY = clampToPage(e.clientY - elRect.top, elRect.height);
      let endX = startX;
      let endY = startY;

      startPointerDrag(e, {
        onMove: (move) => {
          const rect = el.getBoundingClientRect();
          endX = clampToPage(move.clientX - rect.left, rect.width);
          endY = clampToPage(move.clientY - rect.top, rect.height);
          if (!sizeByDrag) return;

          const w = Math.abs(endX - startX);
          const h = Math.abs(endY - startY);
          if (w > 5 || h > 5) {
            setDragPage(pageNumber);
            setDragRect({ x: Math.min(startX, endX), y: Math.min(startY, endY), w, h });
          }
        },
        onEnd: ({ aborted }) => {
          setDragRect(null);
          setDragPage(null);
          // The gesture turned into a scroll or a second finger joined it, so it
          // was never a placement.
          if (aborted) return;

          const rect = el.getBoundingClientRect();
          const w = Math.abs(endX - startX);
          const h = Math.abs(endY - startY);

          if (sizeByDrag && w > 10 && h > 10) {
            onPageClick(
              pageNumber,
              (Math.min(startX, endX) / rect.width) * 100,
              (Math.min(startY, endY) / rect.height) * 100,
              (w / rect.width) * 100,
              (h / rect.height) * 100,
            );
            return;
          }

          // A touch that travelled was the reader moving around the page.
          if (!sizeByDrag && (w > 10 || h > 10)) return;

          onPageClick(pageNumber, (startX / rect.width) * 100, (startY / rect.height) * 100);
        },
      });
    },
    [mode, onPageClick]
  );

  // pdf.js transfers (detaches) the underlying ArrayBuffer of whatever Uint8Array
  // it's given to its worker, so a `.slice()` copy goes in here rather than
  // `file.bytes` itself - callers keep using `file.bytes` afterwards (e.g. to
  // stamp and download the signed PDF), and it would otherwise go dead the
  // moment this viewer opened it.
  //
  // Memoised because react-pdf reloads the whole document whenever this object
  // changes identity, so a fresh one per render costs more than the range
  // options in it save.
  const { bytes, url } = file;
  const pdfSource = useMemo(
    () => (bytes ? { data: bytes.slice() } : pdfUrlSource(url)),
    [bytes, url],
  );

  return (
    // The outer element stays at the frame's width so it keeps measuring the space
    // available rather than the page it holds; the inner one grows past that width
    // when zoomed in, so the enclosing scroller can reach both edges of the page
    // instead of clipping them behind centring.
    <div ref={containerRef} className="w-full">
      <div ref={stackRef} onPointerDown={handlePointerDown}>
        {/* The stacking layout belongs on `Document`, not on a wrapper around it:
            the pages are children of react-pdf's own inner div, so a `gap` on an
            ancestor has only the Document itself to space and the pages butt
            together with no visible break between them.
            `filesComp/PdfPreview` stacks them the same way. */}
        <Document
          file={pdfSource}
          className="w-max min-w-full mx-auto flex flex-col items-center gap-4 py-4"
          onLoadSuccess={handleDocumentLoad}
          onLoadError={(error) => {
            console.error('PDFPageViewer: PDF.js load error:', error?.message || error, 'file:', file.url);
          }}
          loading={
            <div className="flex items-center justify-center h-64 text-on-surface-muted">
              Loading PDF...
            </div>
          }
          error={
            <div className="flex items-center justify-center h-64 text-red-500">
              Failed to load PDF. Please try a different file.
            </div>
          }
        >
          {containerWidth > 0 && Array.from({ length: numPages }, (_, index) => {
            const pageNumber = index + 1;
            const ratio = pageRatios[pageNumber] ?? fallbackRatio;
            return (
              <PdfScrollPage
                key={pageNumber}
                pageNumber={pageNumber}
                renderWidth={renderWidth}
                displayWidth={pageWidth}
                displayHeight={pageWidth * ratio}
                interactive={mode !== 'select'}
                enableTextLayer={mode === 'select'}
                onLoadSuccess={(page) => handlePageLoad(pageNumber, page)}
                dragRect={dragPage === pageNumber ? dragRect : null}
                offscreen={!pageWindow.isDrawn(pageNumber)}
                slotRef={pageWindow.observePage}
                onKeyboardPlace={keyboardPlacement && mode !== 'select' ? () => onPageClick(pageNumber, 50, 50) : undefined}
              >
                {(width, height) => children?.(pageNumber, width, height, pagePointSizes[pageNumber])}
              </PdfScrollPage>
            );
          })}
        </Document>
      </div>
    </div>
  );
}
