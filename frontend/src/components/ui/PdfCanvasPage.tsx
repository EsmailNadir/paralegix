'use client';

import { useCallback, useState } from 'react';
import { Page } from 'react-pdf';

/**
 * The most pixels one page raster may hold: 16.7 million, the size of a
 * 4096 x 4096 canvas. A Letter page at 200% on a 3x display would otherwise
 * be 186 MB, and two rasters overlap during every zoom step.
 */
export const MAX_CANVAS_PIXELS = 4096 * 4096;

/** The highest display density a page is drawn at, however dense the screen. */
const MAX_DEVICE_PIXEL_RATIO = 2;

/** Height over width of a Letter page, for a page not yet measured. */
const LETTER_ASPECT = 1.294;

/**
 * The density to rasterise at: the display's own, held to 2x and then lowered
 * until the canvas fits `MAX_CANVAS_PIXELS`. Never below 1, which would draw
 * fewer pixels than the page occupies on screen.
 *
 * `width` and `height` are the raster's CSS size, which differs from the box's
 * while a zoom is scaling one into the other.
 */
function cappedDevicePixelRatio(width: number, height: number): number {
  const native = Math.min(
    typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
    MAX_DEVICE_PIXEL_RATIO,
  );
  const area = Math.max(1, width * (height || width * LETTER_ASPECT));
  const budget = Math.sqrt(MAX_CANVAS_PIXELS / area);
  return Math.max(1, Math.min(native, budget));
}

interface PdfCanvasPageProps {
  pageNumber: number;
  /** Width the page occupies on screen. */
  displayWidth: number;
  /** Height the page occupies on screen; 0 before the page has been measured. */
  displayHeight: number;
  /** Width the canvas is rasterised at. Changing it re-rasterises the page. */
  renderWidth: number;
  /** react-pdf's page callback: width/height are at the render scale, while
   *  originalWidth/originalHeight are the page's intrinsic size in PDF points. */
  onLoadSuccess?: (page: { width: number; height: number; originalWidth?: number; originalHeight?: number }) => void;
  className?: string;
  /** Renders react-pdf's selectable text layer over the canvas, so the reader
   *  can highlight/copy the document's actual text. Off by default: signature
   *  field placement never wants a text selection competing with its own
   *  drag gestures, so callers opt in only for a read/select viewing mode. */
  renderTextLayer?: boolean;
}

interface Raster {
  id: number;
  /** Width this raster was requested at. */
  width: number;
  /** Whether its canvas has finished painting and can be shown. */
  painted: boolean;
}

/**
 * One page of a PDF, rasterised at `renderWidth` and presented at
 * `displayWidth`. The difference between the two is taken up by a CSS scale, so
 * the page can follow a zoom gesture without waiting on a re-rasterise.
 *
 * react-pdf keys its canvas on the render scale, so re-rasterising a page
 * unmounts the painted canvas and mounts an empty one in its place: the page
 * blanks out for as long as the new raster takes, and its box collapses to an
 * unsized canvas's default in the meantime. This holds the outgoing raster on
 * screen, scaled to the new size, until the incoming one has actually painted,
 * and keeps the box at the size the page will occupy either way.
 */
export default function PdfCanvasPage({
  pageNumber,
  displayWidth,
  displayHeight,
  renderWidth,
  onLoadSuccess,
  className = '',
  renderTextLayer = false,
}: PdfCanvasPageProps) {
  const [rasters, setRasters] = useState<Raster[]>([{ id: 0, width: renderWidth, painted: false }]);
  const [requested, setRequested] = useState(renderWidth);

  // Adjusting state during render (rather than in an effect) so the incoming
  // raster starts in the same commit that changed the requested width, instead
  // of a frame later.
  if (requested !== renderWidth) {
    setRequested(renderWidth);
    setRasters((prev) => {
      // Only a painted raster is worth keeping underneath; an unpainted one it
      // replaces has nothing to show, so its render is abandoned here.
      const outgoing = prev.filter((raster) => raster.painted).slice(-1);
      const nextId = (prev[prev.length - 1]?.id ?? 0) + 1;
      return [...outgoing, { id: nextId, width: renderWidth, painted: false }];
    });
  }

  const markPainted = useCallback((id: number) => {
    setRasters((prev) => {
      const next = prev.map((raster) => (raster.id === id ? { ...raster, painted: true } : raster));
      // Once the newest raster is on screen, the one it replaced is redundant.
      return next[next.length - 1]?.painted ? next.slice(-1) : next;
    });
  }, []);

  return (
    <div
      className={`relative ${className}`}
      style={{ width: displayWidth, height: displayHeight || undefined }}
    >
      {rasters.map((raster, index) => {
        const isNewest = index === rasters.length - 1;
        // The bottom raster stays in normal flow so a page that has not been
        // measured yet is still sized by its own content.
        const stacked = index > 0;
        return (
          <div
            key={raster.id}
            // w-max keeps this layer the width of the canvas it holds. As a plain
            // block it would instead stretch to the box's width - which is the
            // width *after* the scale below is applied - and scaling that spills
            // react-pdf's opaque page background past the box's right edge.
            className={`w-max origin-top-left ${stacked ? 'absolute top-0 left-0' : ''}`}
            style={{
              transform:
                raster.width === displayWidth ? undefined : `scale(${displayWidth / raster.width})`,
              // Hidden only while something painted is behind it; the first
              // raster of a page stays visible so its loading state shows.
              opacity: !raster.painted && rasters.length > 1 ? 0 : 1,
            }}
          >
            <Page
              pageNumber={pageNumber}
              width={raster.width}
              devicePixelRatio={cappedDevicePixelRatio(
                raster.width,
                displayHeight && displayWidth ? (displayHeight * raster.width) / displayWidth : 0,
              )}
              onLoadSuccess={isNewest ? onLoadSuccess : undefined}
              onRenderSuccess={() => markPainted(raster.id)}
              renderTextLayer={isNewest && renderTextLayer}
              renderAnnotationLayer={false}
              // Both layers are the same page, and react-pdf's registry is keyed
              // by page index: letting the outgoing layer register would have its
              // unmount deregister the layer that is staying.
              _enableRegisterUnregisterPage={isNewest}
            />
          </div>
        );
      })}
    </div>
  );
}
