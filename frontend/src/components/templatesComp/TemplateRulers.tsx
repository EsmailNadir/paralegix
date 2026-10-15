"use client";

import { GripHorizontal } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import { type ActiveParagraphMetrics } from "./templateEditorTypes";

const PAGE_RULER_WIDTH = 52;

interface TemplateParagraphRulerProps {
  pageWidth: number;
  zoomLevel: number;
  metrics: ActiveParagraphMetrics | null;
  scrollLeft: number;
  onDragStart: () => void;
  onChange: (left: number, width: number) => void;
  onCommit: () => void;
}

export function TemplateParagraphRuler({ pageWidth, zoomLevel, metrics, scrollLeft, onDragStart, onChange, onCommit }: TemplateParagraphRulerProps) {
  const minWidth = 120;
  const scaledWidth = pageWidth > 0 ? pageWidth * zoomLevel : 0;

  const startDrag = (handle: "left" | "right") => (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!metrics) return;
    event.preventDefault();
    onDragStart();

    const startX = event.clientX;
    // Drag from the paragraph's real bounds, not the display bounds: the bar
    // may be expanded to the widest sibling in the column, and writing those
    // expanded bounds back would visibly move the paragraph.
    const startLeft = metrics.actualLeft;
    const startRight = metrics.actualLeft + metrics.actualWidth;
    let pendingLeft = startLeft;
    let pendingWidth = metrics.actualWidth;
    let frameId: number | null = null;

    const flushPreview = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      onChange(pendingLeft, pendingWidth);
    };

    const schedulePreview = (nextLeft: number, nextWidth: number) => {
      pendingLeft = nextLeft;
      pendingWidth = nextWidth;
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        onChange(pendingLeft, pendingWidth);
      });
    };

    const onMove = (moveEvent: MouseEvent) => {
      const delta = (moveEvent.clientX - startX) / zoomLevel;

      if (handle === "left") {
        const nextLeft = Math.max(0, Math.min(startRight - minWidth, startLeft + delta));
        schedulePreview(nextLeft, startRight - nextLeft);
        return;
      }

      const nextRight = Math.max(startLeft + minWidth, Math.min(pageWidth, startRight + delta));
      schedulePreview(startLeft, nextRight - startLeft);
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      flushPreview();
      onCommit();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-outline bg-surface/70">
      <div className="relative h-11 overflow-hidden px-3 py-2">
        {scaledWidth > 0 ? (
          <div
            className="absolute inset-y-0"
            style={{
              width: `${scaledWidth}px`,
              left: "50%",
              marginLeft: `${-(scaledWidth / 2) - scrollLeft}px`,
            }}
          >
            <div className="absolute inset-x-0 top-5 border-t border-neutral-400/60" />
            <div className="absolute inset-x-0 top-1 flex justify-between text-[10px] text-on-surface-muted">
              <span>0"</span>
              <span>{`${Math.round(pageWidth / 96)}"`}</span>
            </div>

            {metrics ? (
              <>
                <div
                  className="absolute top-[18px] h-[4px] rounded-full bg-blue-500/90 shadow-[0_0_0_1px_rgba(59,130,246,0.18)]"
                  style={{
                    left: `${metrics.left * zoomLevel}px`,
                    width: `${metrics.width * zoomLevel}px`,
                  }}
                />

                <Tooltip title="Drag left text barrier" enterDelay={300}>
                  <button
                    type="button"
                    onMouseDown={startDrag("left")}
                    className="absolute top-[10px] -translate-x-1/2 cursor-ew-resize"
                    style={{ left: `${metrics.left * zoomLevel}px` }}
                    aria-label="Drag left text barrier"
                  >
                    <div className="w-3 h-3 rounded-sm bg-accent-solid shadow-sm border border-white/80" />
                  </button>
                </Tooltip>

                <Tooltip title="Drag right text barrier" enterDelay={300}>
                  <button
                    type="button"
                    onMouseDown={startDrag("right")}
                    className="absolute top-[10px] -translate-x-1/2 cursor-ew-resize"
                    style={{ left: `${(metrics.left + metrics.width) * zoomLevel}px` }}
                    aria-label="Drag right text barrier"
                  >
                    <div className="w-3 h-3 rounded-sm bg-accent-solid shadow-sm border border-white/80" />
                  </button>
                </Tooltip>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface TemplatePageBoundaryRulerProps {
  pageHeight: number;
  zoomLevel: number;
  topBoundary: number;
  boundary: number;
  topOffset: number;
  pageNumber: number;
  onTopChange: (top: number) => void;
  onChange: (bottom: number) => void;
}

export function TemplatePageBoundaryRuler({
  pageHeight,
  zoomLevel,
  topBoundary,
  boundary,
  topOffset,
  pageNumber,
  onTopChange,
  onChange,
}: TemplatePageBoundaryRulerProps) {
  const minGap = 160;
  const scaledHeight = pageHeight > 0 ? pageHeight * zoomLevel : 0;
  const rulerHeight = scaledHeight > 0 ? scaledHeight : 0;
  const maxBoundary = Math.max(minGap, pageHeight - 24);
  const clampedBoundary = Math.min(maxBoundary, Math.max(minGap, boundary || 0));
  const clampedTop = Math.min(Math.max(0, topBoundary || 0), clampedBoundary - minGap);

  const startDrag = (handle: "top" | "bottom") => (event: React.MouseEvent<HTMLButtonElement>) => {
    if (pageHeight <= 0) return;
    event.preventDefault();

    const startY = event.clientY;
    const startValue = handle === "top" ? clampedTop : clampedBoundary;

    const onMove = (moveEvent: MouseEvent) => {
      const delta = (moveEvent.clientY - startY) / zoomLevel;
      if (handle === "top") {
        onTopChange(startValue + delta);
      } else {
        onChange(startValue + delta);
      }
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const inchMarks = pageHeight > 0
    ? Array.from({ length: Math.floor(pageHeight / 96) + 1 }, (_, index) => index * 96)
    : [];
  const tickMarks = pageHeight > 0
    ? Array.from({ length: Math.floor(pageHeight / 24) + 1 }, (_, index) => index * 24)
    : [];

  return (
    <div
      className="pointer-events-auto absolute left-3 z-10 transition-[top] duration-150 ease-out"
      style={{
        top: `${topOffset}px`,
        width: `${PAGE_RULER_WIDTH}px`,
      }}
    >
      <div
        className="relative rounded-xl border border-outline bg-surface/85"
        style={{ height: `${Math.max(96, rulerHeight)}px` }}
      >
        {rulerHeight > 0 ? (
          <>
            <div className="absolute bottom-0 right-[12px] top-0 w-px bg-neutral-400/70" />

            {tickMarks.map((mark) => (
              <div
                key={mark}
                className="absolute right-[12px] border-t border-neutral-400/55"
                style={{
                  top: `${mark * zoomLevel}px`,
                  width: mark % 96 === 0 ? "14px" : mark % 48 === 0 ? "10px" : "6px",
                }}
              />
            ))}

            {inchMarks.map((mark, index) => (
              <span
                key={mark}
                className="absolute left-1.5 -translate-y-1/2 text-[10px] text-on-surface-muted tabular-nums"
                style={{
                  top: `${Math.min(Math.max(10, mark * zoomLevel), Math.max(10, rulerHeight - 10))}px`,
                }}
              >
                {index}
              </span>
            ))}

            {/* Top boundary marker */}
            <div
              className="absolute right-[12px] border-t-2 border-emerald-500/80"
              style={{
                top: `${clampedTop * zoomLevel}px`,
                width: "18px",
              }}
            />
            <Tooltip title="Drag page start boundary" enterDelay={300}>
              <button
                type="button"
                onMouseDown={startDrag("top")}
                className="absolute right-[3px] -translate-y-1/2 cursor-ns-resize rounded-full border border-white/80 bg-emerald-500 p-1.5 text-white shadow-sm"
                style={{ top: `${clampedTop * zoomLevel}px` }}
                aria-label="Drag page start boundary"
              >
                <GripHorizontal className="h-3.5 w-3.5" />
              </button>
            </Tooltip>

            {/* Bottom boundary marker */}
            <div
              className="absolute right-[12px] border-t-2 border-accent-control-ring/80"
              style={{
                top: `${clampedBoundary * zoomLevel}px`,
                width: "18px",
              }}
            />
            <Tooltip title="Drag page end boundary" enterDelay={300}>
              <button
                type="button"
                onMouseDown={startDrag("bottom")}
                className="absolute right-[3px] -translate-y-1/2 cursor-ns-resize rounded-full border border-white/80 bg-accent-solid p-1.5 text-accent-foreground shadow-sm"
                style={{ top: `${clampedBoundary * zoomLevel}px` }}
                aria-label="Drag page end boundary"
              >
                <GripHorizontal className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </>
        ) : null}
      </div>
      <p className="mt-2 text-[10px] leading-4 text-on-surface-muted">
        Page {pageNumber}
      </p>
    </div>
  );
}
