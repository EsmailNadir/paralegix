'use client';

import type { ReactNode } from 'react';
import PdfCanvasPage from '@/components/ui/PdfCanvasPage';

interface PdfScrollPageProps {
  pageNumber: number;
  /** Width the canvas is rasterised at. */
  renderWidth: number;
  /** Width the page is presented at; the gap from `renderWidth` is a CSS scale. */
  displayWidth: number;
  /** 0 until this page's aspect ratio is known. */
  displayHeight: number;
  /** False on a read-only viewer, so the page keeps the default cursor. */
  interactive: boolean;
  /** Renders the page's selectable text layer, so the reader can highlight or
   *  copy its actual text. See `PdfCanvasPage`'s prop of the same name. */
  enableTextLayer?: boolean;
  onLoadSuccess: (page: { width: number; height: number; originalWidth?: number; originalHeight?: number }) => void;
  /** This page's overlays, given its on-screen size. */
  children: (pageWidth: number, pageHeight: number) => ReactNode;
  /** The in-progress drag rectangle, when it belongs to this page. */
  dragRect?: { x: number; y: number; w: number; h: number } | null;
  /**
   * True while this page is outside the drawn window. Its box is still laid out
   * at full height, so only the raster is dropped: the scrollbar stays honest
   * and nothing shifts when the canvas arrives.
   */
  offscreen?: boolean;
  /**
   * Registers this page's box with the viewer's page window, which is what
   * decides `offscreen`. Given the box and the page number so one observer can
   * watch the whole document instead of one per page.
   */
  slotRef?: (node: Element | null, pageNumber: number) => (() => void) | void;
  onKeyboardPlace?: () => void;
}

/**
 * One page of a stacked PDF: its canvas, its overlays, and the size they are
 * positioned from.
 *
 * `data-pdf-page` carries the page number so a pointer event anywhere in the stack
 * can be traced back to the page it landed on with `closest()`, rather than the
 * viewer having to keep a ref per page and hit-test them by hand.
 */
export default function PdfScrollPage({
  pageNumber,
  renderWidth,
  displayWidth,
  displayHeight,
  interactive,
  enableTextLayer = false,
  onLoadSuccess,
  children,
  dragRect = null,
  offscreen = false,
  slotRef,
  onKeyboardPlace,
}: PdfScrollPageProps) {
  return (
    <div
      data-pdf-page={pageNumber}
      role={onKeyboardPlace ? 'group' : undefined}
      aria-label={onKeyboardPlace ? `Page ${pageNumber}` : undefined}
      aria-description={onKeyboardPlace ? 'Press Enter to place the selected annotation tool at the center of this page. Focus the annotation to move or resize it with arrow keys.' : undefined}
      tabIndex={onKeyboardPlace ? 0 : undefined}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.key !== 'Enter' || !onKeyboardPlace) return;
        event.preventDefault();
        onKeyboardPlace();
      }}
      ref={(node) => slotRef?.(node, pageNumber)}
      className={`relative shadow-lg ${interactive ? 'cursor-crosshair' : 'cursor-default'}`}
      style={{ width: displayWidth, height: displayHeight || 'auto' }}
    >
      {offscreen ? (
        // Nothing to paint yet. The box above still holds the page's full height,
        // so the document's length and every scroll position stay correct.
        <div aria-hidden className="h-full w-full rounded bg-surface-alt/40" />
      ) : (
        <PdfCanvasPage
          pageNumber={pageNumber}
          renderWidth={renderWidth}
          displayWidth={displayWidth}
          displayHeight={displayHeight}
          onLoadSuccess={onLoadSuccess}
          renderTextLayer={enableTextLayer}
        />
      )}
      {dragRect && (
        <div
          data-drag-rect
          className="pointer-events-none absolute z-30 rounded border-2 border-accent-control-ring bg-blue-500/10"
          style={{ left: dragRect.x, top: dragRect.y, width: dragRect.w, height: dragRect.h }}
        />
      )}
      {displayHeight > 0 && children(displayWidth, displayHeight)}
    </div>
  );
}
