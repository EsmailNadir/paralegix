'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { X } from 'lucide-react';
import useAnnotationGeometry from '@/hooks/signatureHooks/useAnnotationGeometry';
import type { TextAnnotationData } from '@/types/signature';
import { FONT_FAMILIES } from '@/types/signature';

interface TextAnnotationProps {
  annotation: TextAnnotationData;
  isSelected: boolean;
  pageWidth: number;
  pageHeight: number;
  onSelect: () => void;
  onMove: (xPercent: number, yPercent: number) => void;
  onResize: (widthPercent: number, heightPercent: number) => void;
  onTextChange: (text: string) => void;
  onDelete: () => void;
}

export default function TextAnnotation({
  annotation,
  isSelected,
  pageWidth,
  pageHeight,
  onSelect,
  onMove,
  onResize,
  onTextChange,
  onDelete,
}: TextAnnotationProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  // A text box drags anywhere on its body when idle, and only becomes an
  // editable text field on double-click (or when first created empty), so
  // moving it never fights with typing into it.
  const [isEditing, setIsEditing] = useState(annotation.text === '');
  const isInternalChange = useRef(false);

  const { containerRef, left, top, width, height, handleDragStart, handleResizeStart, handleKeyDown } = useAnnotationGeometry({
    annotation, pageWidth, pageHeight, minWidthPercent: 5, minHeightPercent: 2,
    onSelect, onMove, onResize,
  });

  const fontCss =
    FONT_FAMILIES.find((f) => f.value === annotation.fontFamily)?.css ||
    'Arial, Helvetica, sans-serif';

  // Set initial content and sync on undo/redo (external changes)
  useEffect(() => {
    if (!editorRef.current) return;
    if (isInternalChange.current) {
      isInternalChange.current = false;
      return;
    }
    if (editorRef.current.innerHTML !== annotation.text) {
      editorRef.current.innerHTML = annotation.text;
    }
  }, [annotation.text]);

  // Focus editor when first created (empty + selected)
  useEffect(() => {
    if (isSelected && annotation.text === '' && editorRef.current) {
      editorRef.current.focus();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSelected]);

  // Sync contentEditable → state on input (typing, paste, execCommand)
  const handleInput = useCallback(() => {
    if (editorRef.current) {
      isInternalChange.current = true;
      onTextChange(editorRef.current.innerHTML);
    }
  }, [onTextChange]);

  // Also observe mutations from execCommand (which may not fire input event)
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;

    const observer = new MutationObserver(() => {
      isInternalChange.current = true;
      onTextChange(el.innerHTML);
    });

    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    return () => observer.disconnect();
  }, [onTextChange]);


  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={`Text annotation, page ${annotation.page}`}
      aria-description={`Use arrow keys to move, Alt and arrow keys to resize, and Shift for larger steps. Press Enter to edit text and Escape to finish editing. Left ${annotation.xPercent} percent, top ${annotation.yPercent} percent, width ${annotation.widthPercent} percent, height ${annotation.heightPercent} percent.`}
      tabIndex={0}
      onFocus={(event) => { if (event.target === event.currentTarget) onSelect(); }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          setIsEditing(true);
          requestAnimationFrame(() => editorRef.current?.focus());
        } else handleKeyDown(event);
      }}
      data-annotation="text"
      data-annotation-id={annotation.id}
      // touch-none only while it drags; an editable box needs the browser's own
      // touch handling for placing the caret and selecting text.
      className={`absolute group ${isEditing ? '' : 'touch-none cursor-move active:cursor-grabbing'} ${isSelected ? 'z-20' : 'z-10'}`}
      style={{
        left,
        top,
        width,
        height,
      }}
      onPointerDown={handleDragStart}
      onDoubleClick={() => {
        setIsEditing(true);
        requestAnimationFrame(() => editorRef.current?.focus());
      }}
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
            : 'border border-dashed border-gray-400 hover:border-blue-400'
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
          aria-label="Delete annotation"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}

      {/* ContentEditable editor */}
      <div
        ref={editorRef}
        role={isEditing ? 'textbox' : undefined}
        aria-label={isEditing ? 'Annotation text' : undefined}
        aria-multiline={isEditing ? true : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setIsEditing(false);
            containerRef.current?.focus();
          }
        }}
        contentEditable={isEditing}
        suppressContentEditableWarning
        onInput={handleInput}
        onBlur={() => setIsEditing(false)}
        data-placeholder="Type here..."
        className={`w-full h-full outline-none p-1 overflow-hidden empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400 empty:before:pointer-events-none ${isEditing ? 'cursor-text' : 'cursor-move'}`}
        style={{
          fontFamily: fontCss,
          fontSize: `${annotation.fontSize}px`,
          fontWeight: annotation.isBold ? 'bold' : 'normal',
          fontStyle: annotation.isItalic ? 'italic' : 'normal',
          color: annotation.color || '#000000',
          lineHeight: 1.2,
          minHeight: '1em',
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
        }}
        onPointerDown={(e) => {
          if (isEditing) e.stopPropagation();
        }}
      />

      {/* Resize handle */}
      {isSelected && (
        <div
          // before: widens the grab area well past the 12px dot for fingertips,
          // without changing what is drawn.
          className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-blue-500 rounded-sm cursor-se-resize touch-none before:absolute before:-inset-2 before:content-['']"
          onPointerDown={handleResizeStart}
        />
      )}
    </div>
  );
}
