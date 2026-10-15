"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Calendar, CheckSquare, GripVertical, ImageIcon, Plus, Trash2, Type, Upload } from "lucide-react";
import { startPointerDrag } from "@/lib/utils/pointerDrag";
import { pageFromPoint } from "@/components/signaturesComp/pdfPointerPage";
import { fitTextToBox } from "@/lib/utils/textFit";
import { fitRichTextToBox } from "@/lib/utils/textFitRich";
import type { TemplateFieldPlacementType, TemplateRichTextBlock } from "@/types/template";
import type { PlacementDraft, PlacementStyleDraft } from "./templateOverlayTypes";
import { autoPlacementFontSize, resizedPlacementSize } from "./templateOverlayTypes";
import {
  type InlineStyle,
  getInlineFormatAtSelection,
  insertFieldChipAtSelection,
  isCaretInBulletedBlock,
  renderRichTextToEditable,
  restoreSelectionRange,
  runInlineTextCommand,
  saveSelectionRange,
  serializeEditableToRichText,
  toggleBulletAtSelection,
} from "./richTextEditing";
import OverlayFieldChipPopover from "./OverlayFieldChipPopover";

const TYPE_ICON: Record<TemplateFieldPlacementType, typeof Type> = {
  text: Type,
  date: Calendar,
  checkbox: CheckSquare,
  textbox: Type,
  image: ImageIcon,
};

const CSS_FONT_FAMILY: Record<PlacementStyleDraft["fontFamily"], string> = {
  helvetica: "Helvetica, Arial, sans-serif",
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
  // Carlito/Caladea/PT Serif/PT Sans are the same fonts the PDF stamp
  // fontkit-embeds (see overlayFill.service.ts), loaded here as web fonts so
  // this on-canvas preview isn't just falling back to a generic system font.
  calibri: "Carlito, Calibri, sans-serif",
  cambria: "Caladea, Cambria, serif",
  "pt-serif": "'PT Serif', serif",
  "pt-sans": "'PT Sans', sans-serif",
};

// Mirrors SignatureModal's own GOOGLE_FONTS_LINK_ID pattern: one <link>,
// injected once and reused across every box on the canvas.
const GOOGLE_FONTS_LINK_ID = "template-overlay-google-fonts";
let overlayFontsStylesheetInjected = false;
function ensureOverlayFontsStylesheet() {
  if (typeof document === "undefined" || overlayFontsStylesheetInjected) return;
  overlayFontsStylesheetInjected = true;
  if (document.getElementById(GOOGLE_FONTS_LINK_ID)) return;

  const families = ["Carlito", "Caladea", "PT+Serif", "PT+Sans"]
    .map((name) => `family=${name}:ital,wght@0,400;0,700;1,400;1,700`)
    .join("&");
  const link = document.createElement("link");
  link.id = GOOGLE_FONTS_LINK_ID;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
  document.head.appendChild(link);
}

/**
 * Bumps once the web font a box previews in has actually loaded. The canvas
 * measurement below falls back to a system font until then, and a wrap
 * computed in the fallback puts line breaks where the real font would not,
 * so the fit has to run again once the face is in. `document.fonts` is
 * absent under jsdom and in older engines, and then there is nothing to
 * wait for.
 */
function useOverlayFontLoaded(family: string, bold: boolean, italic: boolean) {
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    if (!fonts?.load) return;
    let cancelled = false;
    // Only the first family of the stack is a web font that can still be
    // loading; the rest are local fallbacks.
    const first = family.split(",")[0].trim();
    fonts.load(`${italic ? "italic " : ""}${bold ? "bold " : ""}12px ${first}`)
      .then(() => { if (!cancelled) setLoaded((v) => v + 1); })
      .catch(() => { /* The face is unavailable; the fallback measurement stands. */ });
    return () => { cancelled = true; };
  }, [family, bold, italic]);
  return loaded;
}

// Reused offscreen canvas for measuring text width in the preview, mirroring
// RestrictedSigningView's own measurePreviewTextWidth.
let previewTextCanvas: HTMLCanvasElement | null = null;
function measurePreviewTextWidth(text: string, fontSize: number, family: string, bold: boolean, italic: boolean) {
  if (typeof document === "undefined") return 0;
  if (!previewTextCanvas) previewTextCanvas = document.createElement("canvas");
  const ctx = previewTextCanvas.getContext("2d");
  if (!ctx) return 0;
  ctx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${fontSize}px ${family}`;
  return ctx.measureText(text).width;
}

// Mirrors overlayFill.service.ts's own applyBulletList: not real list markup
// (the placement's content is a single string, not HTML), just a bullet
// prefix on every non-blank line before layout, applied identically here and
// in the PDF stamp so the preview and the stamped output agree.
function applyBulletList(text: string, bulletList: boolean) {
  if (!bulletList) return text;
  return text.split("\n").map((line) => (line.trim() ? `•  ${line}` : line)).join("\n");
}

/**
 * Sizes a textbox's literal content to its box the way the PDF stamp does
 * (`overlayFill.service.ts`'s `drawStyledText`): a chosen font size is still
 * only a maximum, long text still shrinks-to-fit and wraps. Computed in PDF
 * POINTS (the box's `pagePointSize`-derived width/height) with the fitted
 * size then scaled to screen pixels by the caller, so the preview's line
 * wrapping doesn't disagree with the stamped output at different zoom levels.
 */
function fitOverlayPreviewText(text: string, boxWidthPt: number, boxHeightPt: number, style: PlacementStyleDraft) {
  const family = CSS_FONT_FAMILY[style.fontFamily] ?? CSS_FONT_FAMILY.helvetica;
  const maxFontSize = style.fontSize ?? autoPlacementFontSize(boxHeightPt);
  return fitTextToBox(
    applyBulletList(text, style.bulletList),
    boxWidthPt,
    boxHeightPt,
    maxFontSize,
    (line, size) => measurePreviewTextWidth(line, size, family, style.bold, style.italic),
  );
}

/** Mixed-run counterpart of `fitOverlayPreviewText` for a placement with
 *  `richText` set. No fill context while authoring, so a field run shows its
 *  `{fieldName}` label (same convention the plain text/date preview uses). */
function fitOverlayPreviewRichText(blocks: TemplateRichTextBlock[], boxWidthPt: number, boxHeightPt: number, style: PlacementStyleDraft) {
  const family = CSS_FONT_FAMILY[style.fontFamily] ?? CSS_FONT_FAMILY.helvetica;
  const maxFontSize = style.fontSize ?? autoPlacementFontSize(boxHeightPt);
  const displayBlocks = blocks.map((block) => ({
    bullet: block.bullet,
    runs: block.runs.map((run) => ({
      text: run.fieldName ? `{${run.fieldName}}` : run.text,
      bold: run.bold,
      italic: run.italic,
      color: run.color,
    })),
  }));
  return fitRichTextToBox(
    displayBlocks,
    boxWidthPt,
    boxHeightPt,
    maxFontSize,
    (text, size, bold, italic) => measurePreviewTextWidth(text, size, family, bold, italic),
  );
}

export interface OverlayTextBoxHandle {
  /** Snapshots the box's current selection before something that will steal
   *  focus (opening the color input, the field popover), restored by the
   *  next `runCommand` so the command still applies to the right place. */
  saveSelection: () => void;
  runCommand: (command: "bold" | "italic" | "foreColor", value?: string) => void;
  toggleBullet: () => void;
  getSelectionFormat: () => InlineStyle & { bulletActive: boolean };
}

/**
 * One field or repeater-column box on the overlay canvas: drag to move
 * (including across a page boundary), a resize handle, and a floating
 * type/delete toolbar while selected. Adapted directly from
 * `signaturesComp/SignatureFieldPlacer`'s `FieldOverlay`, using the same drag
 * mechanics; only what a box represents differs.
 *
 * A selected 'textbox' placement is the one exception to "the whole box
 * drags": its body becomes a real rich contentEditable box (mixed bold/
 * italic/color, bullets, inline field chips, see `richTextEditing.ts`) so
 * typing works immediately after placing it, which means the body can no
 * longer also start a drag (a pointerdown there has to reach the editable
 * box, not `startPointerDrag`). It gets its own small grip handle instead,
 * matching the resize handle's corner-handle convention. Exposes an
 * imperative handle so the persistent `TemplateOverlayFormattingBar` (a
 * different part of the tree) can drive bold/italic/color/bullet on
 * whichever box currently has focus.
 */
const TemplateOverlayFieldBox = forwardRef<OverlayTextBoxHandle, {
  placement: PlacementDraft;
  isSelected: boolean;
  pageWidth: number;
  pageHeight: number;
  /** The page's intrinsic PDF-point size, for sizing a textbox's preview the
   *  way the stamped PDF will. Absent until the page has rendered once. */
  pagePointSize?: { width: number; height: number };
  /** A translucent preview row (a repeater's un-authored slot), not a real
   *  placement: no interaction, just a visual guide. */
  isGuide?: boolean;
  /** Other column names already drawn in the same repeater (empty for a
   *  standalone box), offered by the "+ Field" popover ahead of the global
   *  auto-fill catalog, since they resolve from this row's own data. */
  siblingFieldNames?: string[];
  onSelect?: () => void;
  onMove?: (xPercent: number, yPercent: number) => void;
  onMoveToPage?: (page: number, xPercent: number, yPercent: number) => void;
  onResize?: (widthPercent: number, heightPercent: number) => void;
  onTypeChange?: (fieldType: TemplateFieldPlacementType) => void;
  onRichTextChange?: (richText: TemplateRichTextBlock[]) => void;
  onFormatChange?: (format: InlineStyle & { bulletActive: boolean }) => void;
  onReplaceImage?: () => void;
  onDelete?: () => void;
  /** The size the box's text actually renders at, once fitted, while this
   *  box is selected (null when it has nothing to fit). The toolbar shows it
   *  beside the chosen size when the two differ. */
  onFittedSizeChange?: (fontSize: number | null) => void;
  /** A move or resize has just started changing the layout: called once per
   *  gesture, on its first real change (never for a press that does not
   *  move anything), so the caller records an undo point here rather than
   *  on every pointer move. */
  onInteractionStart?: () => void;
}>(function TemplateOverlayFieldBox({
  placement,
  isSelected,
  pageWidth,
  pageHeight,
  pagePointSize,
  isGuide = false,
  siblingFieldNames = [],
  onSelect,
  onMove,
  onMoveToPage,
  onResize,
  onTypeChange,
  onRichTextChange,
  onFormatChange,
  onReplaceImage,
  onDelete,
  onFittedSizeChange,
  onInteractionStart,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editableRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const [fieldPopoverOpen, setFieldPopoverOpen] = useState(false);
  useEffect(() => { ensureOverlayFontsStylesheet(); }, []);
  const isRepeaterColumn = Boolean(placement.repeaterName);
  const Icon = TYPE_ICON[placement.fieldType] ?? Type;
  const isEditingText = placement.fieldType === "textbox" && isSelected && !isGuide;

  const left = (placement.xPercent / 100) * pageWidth;
  const top = (placement.yPercent / 100) * pageHeight;
  const width = (placement.widthPercent / 100) * pageWidth;
  const height = (placement.heightPercent / 100) * pageHeight;

  const pxPerPt = pagePointSize ? pageWidth / pagePointSize.width : 1;
  // The stamp keeps 4pt clear on each side of the box (fitTextToBox's own
  // inset), so the preview's padding is that in screen pixels at the current
  // zoom, not a fixed CSS value that only matches at one zoom level.
  const insetPx = 4 * pxPerPt;
  const fontLoaded = useOverlayFontLoaded(CSS_FONT_FAMILY[placement.fontFamily], placement.bold, placement.italic);
  const baseStyle: InlineStyle = useMemo(
    () => ({ bold: placement.bold, italic: placement.italic, color: placement.color }),
    [placement.bold, placement.italic, placement.color]
  );

  const emitRichTextChange = useCallback(() => {
    if (!editableRef.current) return;
    onRichTextChange?.(serializeEditableToRichText(editableRef.current, baseStyle));
  }, [onRichTextChange, baseStyle]);

  useImperativeHandle(ref, () => ({
    saveSelection: () => {
      if (editableRef.current) savedRangeRef.current = saveSelectionRange(editableRef.current);
    },
    runCommand: (command, value) => {
      if (!editableRef.current) return;
      editableRef.current.focus();
      restoreSelectionRange(savedRangeRef.current);
      runInlineTextCommand(command, value);
      savedRangeRef.current = saveSelectionRange(editableRef.current);
      emitRichTextChange();
    },
    toggleBullet: () => {
      if (!editableRef.current) return;
      editableRef.current.focus();
      restoreSelectionRange(savedRangeRef.current);
      if (toggleBulletAtSelection(editableRef.current)) emitRichTextChange();
    },
    getSelectionFormat: () => ({
      ...getInlineFormatAtSelection(baseStyle),
      bulletActive: editableRef.current ? isCaretInBulletedBlock(editableRef.current) : false,
    }),
  }), [emitRichTextChange, baseStyle]);

  // Text/date/textbox all preview in the placement's actual font/size/
  // weight/style/color/alignment, so the canvas shows what's actually
  // configured instead of a generic uppercase chip. text/date have no real
  // value yet at authoring time, so they preview their merge-field name in
  // braces (matching the "Fields:" strip's own `{name}` convention); textbox
  // previews its styled paragraph content.
  const previewFit = useMemo(() => {
    if (placement.fieldType === "textbox") {
      if (placement.richText && placement.richText.length > 0) {
        return { kind: "rich" as const, fit: fitOverlayPreviewRichText(placement.richText, width / pxPerPt, height / pxPerPt, placement) };
      }
      return null;
    }
    if ((placement.fieldType === "text" || placement.fieldType === "date") && placement.fieldName) {
      return { kind: "plain" as const, fit: fitOverlayPreviewText(`{${placement.fieldName}}`, width / pxPerPt, height / pxPerPt, placement) };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fontLoaded is a re-fit trigger, not an input: the measurement it changes is read through the canvas
  }, [placement, width, height, pxPerPt, fontLoaded]);

  // The editable view sets its text at the SAME fitted size the preview and
  // the stamp use, so a box does not change size when it is clicked into.
  // An empty box has nothing to fit and falls back to the chosen or
  // automatic maximum, which is what the first typed character will get.
  const editingFontSizePt = previewFit
    ? previewFit.fit.fontSize
    : (placement.fontSize ?? autoPlacementFontSize(height / pxPerPt));
  const editingLineHeightPx = (previewFit ? previewFit.fit.lineHeight : editingFontSizePt * 1.15) * pxPerPt;

  // Reported through a ref: the caller passes an inline arrow, and re-running
  // this on every new identity would report on every render of the canvas.
  const fittedFontSize = previewFit ? previewFit.fit.fontSize : null;
  const onFittedSizeChangeRef = useRef(onFittedSizeChange);
  onFittedSizeChangeRef.current = onFittedSizeChange;
  useEffect(() => {
    if (!isSelected || isGuide) return;
    onFittedSizeChangeRef.current?.(fittedFontSize);
  }, [isSelected, isGuide, fittedFontSize]);

  // Hydrates the contentEditable DOM from the placement's stored content the
  // moment it becomes the edited box, and focuses it so placing/reselecting
  // a text box drops straight into typing.
  useEffect(() => {
    if (!isEditingText || !editableRef.current) return;
    document.execCommand("defaultParagraphSeparator", false, "div");
    renderRichTextToEditable(editableRef.current, placement.richText ?? []);
    editableRef.current.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately only re-hydrates when the EDITED box changes, not on every keystroke (onInput below owns live edits; re-running this on placement.richText would fight the user's own typing)
  }, [isEditingText, placement.id]);

  // Keeps the persistent toolbar's bold/italic/color highlighting in sync
  // with wherever the caret actually is inside this box.
  useEffect(() => {
    if (!isEditingText) return;
    const handleSelectionChange = () => {
      const editable = editableRef.current;
      if (!editable?.contains(document.getSelection()?.anchorNode ?? null)) return;
      onFormatChange?.({ ...getInlineFormatAtSelection(baseStyle), bulletActive: isCaretInBulletedBlock(editable) });
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [isEditingText, onFormatChange, baseStyle]);

  const handleDragStart = useCallback(
    (e: React.PointerEvent) => {
      if (isGuide || !e.isPrimary) return;
      e.preventDefault();
      e.stopPropagation();
      onSelect?.();

      const rect = containerRef.current!.getBoundingClientRect();
      const grabX = e.clientX - rect.left;
      const grabY = e.clientY - rect.top;
      // Tracked in the closure, not re-read from the DOM: crossing a page
      // remounts this box under the new page, so the drag keeps driving off
      // the pointer's own geometry rather than a ref that just went stale.
      let dragPage = placement.page;
      // The undo point is taken on the first move that changes the layout,
      // not on press: a plain click to select a box is not an edit, and a
      // checkpoint there would also wipe the redo stack.
      let moved = false;

      startPointerDrag(e, {
        onMove: (move) => {
          const over = pageFromPoint(move.clientX, move.clientY);
          const pageEl = over?.element
            ?? document.querySelector<HTMLElement>(`[data-pdf-page="${dragPage}"]`);
          if (!pageEl) return;
          const pageRect = pageEl.getBoundingClientRect();
          if (pageRect.width <= 0 || pageRect.height <= 0) return;

          const newLeft = move.clientX - pageRect.left - grabX;
          const newTop = move.clientY - pageRect.top - grabY;
          const xPercent = Math.max(0, Math.min(100 - placement.widthPercent, (newLeft / pageRect.width) * 100));
          const yPercent = Math.max(0, Math.min(100 - placement.heightPercent, (newTop / pageRect.height) * 100));
          const changesPage = Boolean(over && over.pageNumber !== dragPage);

          if (!moved) {
            if (!changesPage && xPercent === placement.xPercent && yPercent === placement.yPercent) return;
            moved = true;
            onInteractionStart?.();
          }

          if (over && changesPage) {
            dragPage = over.pageNumber;
            onMoveToPage?.(over.pageNumber, xPercent, yPercent);
          } else {
            onMove?.(xPercent, yPercent);
          }
        },
      });
    },
    [isGuide, onSelect, onInteractionStart, onMove, onMoveToPage, placement.page, placement.xPercent, placement.yPercent, placement.widthPercent, placement.heightPercent]
  );

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      if (!e.isPrimary) return;
      e.preventDefault();
      e.stopPropagation();
      // Same as a drag: the undo point waits for the first size change.
      let resized = false;

      startPointerDrag(e, {
        onMove: (move) => {
          const parent = containerRef.current?.parentElement;
          if (!parent) return;
          const parentRect = parent.getBoundingClientRect();
          const newWidth = move.clientX - parentRect.left - left;
          const newHeight = move.clientY - parentRect.top - top;
          const size = resizedPlacementSize(
            placement.xPercent,
            placement.yPercent,
            (newWidth / pageWidth) * 100,
            (newHeight / pageHeight) * 100,
          );
          if (!resized) {
            if (size.widthPercent === placement.widthPercent && size.heightPercent === placement.heightPercent) return;
            resized = true;
            onInteractionStart?.();
          }
          onResize?.(size.widthPercent, size.heightPercent);
        },
      });
    },
    [placement.xPercent, placement.yPercent, placement.widthPercent, placement.heightPercent, left, top, pageWidth, pageHeight, onResize, onInteractionStart]
  );

  // Repeater columns get the same violet accent TemplateEditor's own
  // docx-setup toolbar already uses for detected repeater placeholders, so a
  // box's colour says what it is at a glance without a label.
  const colorCls = isRepeaterColumn
    ? "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300"
    : "border-accent-border-soft bg-accent-soft text-accent-emphasis dark:text-accent-emphasis";

  const handleInsertField = (fieldName: string) => {
    if (!editableRef.current) return;
    editableRef.current.focus();
    restoreSelectionRange(savedRangeRef.current);
    insertFieldChipAtSelection(fieldName, getInlineFormatAtSelection(baseStyle));
    savedRangeRef.current = saveSelectionRange(editableRef.current);
    setFieldPopoverOpen(false);
    emitRichTextChange();
  };

  return (
    <div
      ref={containerRef}
      data-annotation="field"
      className={`absolute group touch-none transition-opacity ${isGuide ? "pointer-events-none opacity-40" : isEditingText ? "" : "cursor-move active:cursor-grabbing"} ${
        isSelected ? "z-20" : "z-10"
      } ${isSelected ? "opacity-100" : isGuide ? "opacity-40" : "opacity-85"}`}
      style={{ left, top, width, height }}
      onPointerDown={isEditingText ? undefined : handleDragStart}
      onClick={(e) => { e.stopPropagation(); onSelect?.(); }}
    >
      {placement.fieldType === "image" ? (
        <div className={`absolute inset-0 rounded border-2 border-dashed overflow-hidden flex items-center justify-center ${colorCls}`}>
          {placement.imagePreviewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a signed GCS URL, not a static/optimizable asset
            <img src={placement.imagePreviewUrl} alt="" className="w-full h-full object-contain p-0.5" draggable={false} />
          ) : (
            <ImageIcon size={16} className="opacity-60" />
          )}
        </div>
      ) : placement.fieldType === "checkbox" ? (
        <div className={`absolute inset-0 rounded border-2 border-dashed flex items-center gap-1 px-1.5 ${colorCls}`}>
          <Icon size={11} className="shrink-0" />
          <span className="truncate text-[10px] font-semibold uppercase tracking-wide">
            {placement.fieldName || "field"}
          </span>
        </div>
      ) : isEditingText ? (
        // Laid out exactly like the read-only preview below (vertically
        // centered, the stamp's inset, the fitted size) so the text stays
        // put when the box is clicked into; only the content itself becomes
        // editable.
        <div
          className={`absolute inset-0 rounded border-2 border-dashed overflow-hidden flex flex-col justify-center ${colorCls}`}
          style={{ paddingLeft: insetPx, paddingRight: insetPx }}
        >
          <div
            ref={editableRef}
            contentEditable
            suppressContentEditableWarning
            onInput={emitRichTextChange}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onPaste={(e) => {
              e.preventDefault();
              document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
            }}
            className="w-full bg-transparent outline-none [&_div]:min-h-[1em]"
            style={{
              fontSize: `${editingFontSizePt * pxPerPt}px`,
              lineHeight: `${editingLineHeightPx}px`,
              fontFamily: CSS_FONT_FAMILY[placement.fontFamily],
              textAlign: placement.textAlign,
            }}
          />
        </div>
      ) : (
        // text / date (its bound merge-field name, previewed as "{name}") and
        // textbox not being edited (its real content) all preview in the
        // placement's actual font/size/weight/style/color/alignment, so the
        // canvas shows what's configured rather than a generic chip. A small
        // corner icon still marks text/date so the type reads at a glance
        // even though the content itself no longer differs by type.
        <div
          className={`absolute inset-0 rounded border-2 border-dashed overflow-hidden flex flex-col justify-center ${colorCls}`}
          style={{ paddingLeft: insetPx, paddingRight: insetPx }}
        >
          {placement.fieldType !== "textbox" && (
            <Icon size={9} className="absolute top-1 left-1 opacity-60 pointer-events-none" />
          )}
          {previewFit ? (
            previewFit.kind === "rich" ? (
              previewFit.fit.lines.map((line, i) => (
                <div
                  key={i}
                  className="w-full whitespace-nowrap overflow-hidden text-ellipsis"
                  style={{
                    fontSize: `${previewFit.fit.fontSize * pxPerPt}px`,
                    lineHeight: `${previewFit.fit.lineHeight * pxPerPt}px`,
                    fontFamily: CSS_FONT_FAMILY[placement.fontFamily],
                    textAlign: placement.textAlign,
                  }}
                >
                  {line.segments.map((segment, si) => (
                    <span key={si} style={{ fontWeight: segment.bold ? 700 : 400, fontStyle: segment.italic ? "italic" : "normal", color: segment.color }}>
                      {segment.text}
                    </span>
                  ))}
                </div>
              ))
            ) : (
              previewFit.fit.lines.map((line, i) => (
                <div
                  key={i}
                  className="w-full whitespace-nowrap overflow-hidden text-ellipsis"
                  style={{
                    fontSize: `${previewFit.fit.fontSize * pxPerPt}px`,
                    lineHeight: `${previewFit.fit.lineHeight * pxPerPt}px`,
                    fontFamily: CSS_FONT_FAMILY[placement.fontFamily],
                    fontWeight: placement.bold ? 700 : 400,
                    fontStyle: placement.italic ? "italic" : "normal",
                    color: placement.color,
                    textAlign: placement.textAlign,
                  }}
                >
                  {line}
                </div>
              ))
            )
          ) : (
            <span className="text-[10px] italic opacity-60 text-center">
              {placement.fieldType === "textbox" ? "Empty text box" : (placement.fieldName || "field")}
            </span>
          )}
        </div>
      )}

      {isEditingText && (
        <div
          className="absolute -top-1.5 -left-1.5 w-4 h-4 rounded-sm bg-accent-solid text-accent-foreground flex items-center justify-center cursor-move before:absolute before:-inset-1.5 before:content-['']"
          onPointerDown={handleDragStart}
          aria-label="Move text box"
        >
          <GripVertical size={10} />
        </div>
      )}

      {isSelected && !isGuide && (
        <div
          className="absolute left-0 -top-10 flex items-center gap-2 rounded-lg bg-surface shadow-lg ring-1 ring-outline-subtle py-1.5 pl-2.5 pr-1"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="text-[11px] font-medium text-on-surface truncate max-w-[140px]">
            {placement.fieldName}
          </span>
          <span className="h-4 w-px bg-outline-subtle shrink-0" />

          {(placement.fieldType === "text" || placement.fieldType === "date" || placement.fieldType === "checkbox") && (
            <>
              <div className="flex items-center rounded-md bg-surface-alt p-0.5 gap-0.5">
                {(["text", "date", "checkbox"] as TemplateFieldPlacementType[]).map((t) => {
                  const TIcon = TYPE_ICON[t];
                  const active = placement.fieldType === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-label={`Set field type ${t}`}
                      onClick={() => onTypeChange?.(t)}
                      className={`p-1 rounded transition-colors cursor-pointer ${
                        active
                          ? "bg-accent-solid text-accent-foreground"
                          : "text-on-surface-muted hover:text-on-surface hover:bg-surface-hover"
                      }`}
                    >
                      <TIcon size={12} />
                    </button>
                  );
                })}
              </div>
              <span className="h-4 w-px bg-outline-subtle shrink-0" />
            </>
          )}

          {isEditingText && (
            <>
              <div className="relative">
                <button
                  type="button"
                  onPointerDown={(e) => { e.stopPropagation(); if (editableRef.current) savedRangeRef.current = saveSelectionRange(editableRef.current); }}
                  onClick={(e) => { e.stopPropagation(); setFieldPopoverOpen((v) => !v); }}
                  aria-label="Insert field"
                  className="inline-flex items-center gap-1 px-1.5 py-1 rounded text-[11px] font-medium text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-colors cursor-pointer shrink-0"
                >
                  <Plus size={12} /> Field
                </button>
                <OverlayFieldChipPopover
                  open={fieldPopoverOpen}
                  onClose={() => setFieldPopoverOpen(false)}
                  onSelect={handleInsertField}
                  siblingFields={siblingFieldNames}
                />
              </div>
              <span className="h-4 w-px bg-outline-subtle shrink-0" />
            </>
          )}

          {placement.fieldType === "image" && onReplaceImage && (
            <>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onReplaceImage(); }}
                aria-label="Replace image"
                className="p-1 rounded text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-colors cursor-pointer shrink-0"
              >
                <Upload size={13} />
              </button>
              <span className="h-4 w-px bg-outline-subtle shrink-0" />
            </>
          )}

          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete?.(); }}
            aria-label="Delete field"
            className="p-1 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer shrink-0"
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}

      {isSelected && !isGuide && (
        <div
          className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-accent-solid rounded-sm cursor-se-resize before:absolute before:-inset-2 before:content-['']"
          onPointerDown={handleResizeStart}
        />
      )}
    </div>
  );
});

export default TemplateOverlayFieldBox;
