'use client';

import { X } from 'lucide-react';
import useAnnotationGeometry from '@/hooks/signatureHooks/useAnnotationGeometry';
import type { SignatureAnnotationData } from '@/types/signature';
import SignatureVisual from './SignatureVisual';

interface SignatureAnnotationProps {
  annotation: SignatureAnnotationData;
  isSelected: boolean;
  pageWidth: number;
  pageHeight: number;
  onSelect: () => void;
  onMove: (xPercent: number, yPercent: number) => void;
  onResize: (widthPercent: number, heightPercent: number) => void;
  onDelete: () => void;
}

export default function SignatureAnnotation({
  annotation,
  isSelected,
  pageWidth,
  pageHeight,
  onSelect,
  onMove,
  onResize,
  onDelete,
}: SignatureAnnotationProps) {

  const { containerRef, left, top, width, height, handleDragStart, handleResizeStart, handleKeyDown } = useAnnotationGeometry({
    annotation, pageWidth, pageHeight, minWidthPercent: 3, minHeightPercent: 2,
    onSelect, onMove, onResize,
  });


  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={`Signature annotation, page ${annotation.page}`}
      aria-description={`Use arrow keys to move, Alt and arrow keys to resize, and Shift for larger steps. Left ${annotation.xPercent} percent, top ${annotation.yPercent} percent, width ${annotation.widthPercent} percent, height ${annotation.heightPercent} percent.`}
      tabIndex={0}
      onFocus={(event) => { if (event.target === event.currentTarget) onSelect(); }}
      onKeyDown={handleKeyDown}
      data-annotation="signature"
      data-annotation-id={annotation.id}
      // touch-none so a finger dragging this moves it instead of panning the page.
      className={`absolute group touch-none cursor-move active:cursor-grabbing ${isSelected ? 'z-20' : 'z-10'}`}
      style={{ left, top, width, height }}
      onPointerDown={handleDragStart}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      {/* Border */}
      <div
        className={`absolute inset-0 rounded pointer-events-none ${
          isSelected
            ? 'border-2 border-blue-500 shadow-sm shadow-blue-200'
            : 'border border-dashed border-transparent group-hover:border-blue-300'
        }`}
      />

      {/* Delete button */}
      {isSelected && (
        <button
          className="absolute -top-3 -right-3 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 shadow-sm cursor-pointer"
          // Stops the drag beginning underneath, but must not cancel the event:
          // cancelling pointerdown can swallow the tap's click on touch.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete signature"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}

      <SignatureVisual style={annotation.style} dataUrl={annotation.dataUrl} />

      {/* Resize handle */}
      {isSelected && (
        <div
          // before: widens the grab area well past the 12px dot for fingertips,
          // without changing what is drawn.
          className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-blue-500 rounded-sm cursor-se-resize before:absolute before:-inset-2 before:content-['']"
          onPointerDown={handleResizeStart}
        />
      )}
    </div>
  );
}
