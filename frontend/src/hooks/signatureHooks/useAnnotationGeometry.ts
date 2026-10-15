"use client";

import { useRef, useCallback, type KeyboardEvent } from "react";
import { startPointerDrag } from "@/lib/utils/pointerDrag";

interface Options {
  annotation: { xPercent: number; yPercent: number; widthPercent: number; heightPercent: number };
  pageWidth: number;
  pageHeight: number;
  minWidthPercent: number;
  minHeightPercent: number;
  onSelect: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (width: number, height: number) => void;
}

/** Shared page-relative geometry for draggable signature and text annotations. */
export default function useAnnotationGeometry({ annotation, pageWidth, pageHeight, minWidthPercent, minHeightPercent, onSelect, onMove, onResize }: Options) {
  const containerRef = useRef<HTMLDivElement>(null);
  const left = annotation.xPercent / 100 * pageWidth;
  const top = annotation.yPercent / 100 * pageHeight;
  const width = annotation.widthPercent / 100 * pageWidth;
  const height = annotation.heightPercent / 100 * pageHeight;

  const handleDragStart = useCallback(
    (e: React.PointerEvent) => {
      if (!e.isPrimary) return;
      e.preventDefault();
      e.stopPropagation();
      onSelect();

      const rect = containerRef.current!.getBoundingClientRect();
      const grabX = e.clientX - rect.left;
      const grabY = e.clientY - rect.top;

      startPointerDrag(e, {
        onMove: (move) => {
          const parent = containerRef.current?.parentElement;
          if (!parent) return;
          const parentRect = parent.getBoundingClientRect();

          const newLeft = move.clientX - parentRect.left - grabX;
          const newTop = move.clientY - parentRect.top - grabY;

          const xPercent = Math.max(0, Math.min(100 - annotation.widthPercent, (newLeft / pageWidth) * 100));
          const yPercent = Math.max(0, Math.min(100 - annotation.heightPercent, (newTop / pageHeight) * 100));
          onMove(xPercent, yPercent);
        },
      });
    },
    [onSelect, onMove, pageWidth, pageHeight, annotation.widthPercent, annotation.heightPercent]
  );

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      if (!e.isPrimary) return;
      e.preventDefault();
      e.stopPropagation();

      startPointerDrag(e, {
        onMove: (move) => {
          const parent = containerRef.current?.parentElement;
          if (!parent) return;
          const parentRect = parent.getBoundingClientRect();

          const newWidth = move.clientX - parentRect.left - left;
          const newHeight = move.clientY - parentRect.top - top;

          const widthPercent = Math.max(minWidthPercent, Math.min(100 - annotation.xPercent, (newWidth / pageWidth) * 100));
          const heightPercent = Math.max(minHeightPercent, Math.min(100 - annotation.yPercent, (newHeight / pageHeight) * 100));
          onResize(widthPercent, heightPercent);
        },
      });
    },
    [onResize, left, top, pageWidth, pageHeight, annotation.xPercent, annotation.yPercent, minWidthPercent, minHeightPercent]
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const direction: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const delta = direction[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 5 : 1;
    if (event.altKey) {
      onResize(
        Math.max(minWidthPercent, Math.min(100 - annotation.xPercent, annotation.widthPercent + delta[0] * step)),
        Math.max(minHeightPercent, Math.min(100 - annotation.yPercent, annotation.heightPercent + delta[1] * step)),
      );
    } else {
      onMove(
        Math.max(0, Math.min(100 - annotation.widthPercent, annotation.xPercent + delta[0] * step)),
        Math.max(0, Math.min(100 - annotation.heightPercent, annotation.yPercent + delta[1] * step)),
      );
    }
  };

  return { containerRef, left, top, width, height, handleDragStart, handleResizeStart, handleKeyDown };
}
