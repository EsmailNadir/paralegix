"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Upload,
  RotateCcw,
  Plus,
  ZoomIn,
  ZoomOut,
  Save,
  X,
  AlertCircle,
  ArrowLeft,
  Type,
  Bold,
  Italic,
  Underline,
  Link2,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  ChevronDown,
  GripHorizontal,
  Undo2,
  Redo2,
  List,
  ListOrdered,
  Repeat,
  Minus,
  UnfoldVertical,
  Image as ImageIcon,
  Download,
  FolderUp,
} from "lucide-react";
import Dropdown from "@/components/ui/Dropdown";
import LoadingSpinner from "@/components/LoadingSpinner";
import Modal from "@/components/ui/Modal";
import PageHeader from "@/components/ui/PageHeader";
import Spinner from "@/components/ui/Spinner";
import Tooltip from "@/components/ui/Tooltip";
import PlaceholderModal from "./PlaceholderModal";
import DocxTemplatePreview from "./DocxTemplatePreview";
import TemplateImageCropModal from "@/components/templatesComp/TemplateImageCropModal";
import SaveToFilesModal, { type SaveDestination } from "@/components/templatesComp/SaveToFilesModal";
import ErrorNotification from "@/components/ErrorNotification";
import { ClientTextCheckError, wordTemplatesService } from "@/services/wordTemplates.service";
import { templatesService as documentConversionService } from "@/services/templates.service";
import filesService from "@/services/files.service";
import { scopeFromIds } from "@/lib/files/fileScope";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { LeftoverClientTextDialog } from "./LeftoverClientText";
import type { LeftoverClientText } from "@/lib/wordTemplates/auto-bracket-types";
import { buildFilledTemplateHtml } from "@/lib/wordTemplates/template-fill";
import { injectTemplatePreviewStyles } from "@/lib/wordTemplates/template-preview";
import { convertPdfToHtml } from "@/lib/wordTemplates/pdf-to-html";
import { chipifyPlaceholdersInHtml } from "@/lib/wordTemplates/chipify-placeholders";
import { inspectDocxForImport, inspectPdfFormFields } from "@/lib/wordTemplates/import-guards";
import { FONT_FAMILIES, FONT_SIZES } from "@/types/signature";
import type { WordTemplateAsset as TemplateAsset } from "@/types/wordTemplate";
import { foreColorToHex, mapCssToFontValue } from "@/components/signaturesComp/textFormatting";
import {
  TEMPLATE_IMAGE_OBJECT_SELECTOR,
  applyTemplateImageObjectLayout,
  createTemplateImageObjectElement,
  getTemplateImageCropRect,
  getTemplateImageElement,
  setTemplateImageCropRect,
  stripTemplateImagePreviewSources,
  syncTemplateImageIntrinsicSize,
} from "@/lib/wordTemplates/template-image-objects";


function sortTemplateImagesOnPage(page: HTMLElement): HTMLElement[] {
  const images = Array.from(page.querySelectorAll<HTMLElement>(TEMPLATE_IMAGE_OBJECT_SELECTOR));
  return images.sort((a, b) => {
    const pa = parseInt(a.dataset.templateImagePriority ?? "0", 10) || 0;
    const pb = parseInt(b.dataset.templateImagePriority ?? "0", 10) || 0;
    if (pa !== pb) return pa - pb;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

function normalizeTemplateImagePrioritiesOnPage(page: HTMLElement) {
  const sorted = sortTemplateImagesOnPage(page);
  sorted.forEach((el, i) => {
    el.dataset.templateImagePriority = String(i);
  });
}

/** Move image toward front (+1) or back (-1) in the stack; reassigns consecutive priorities so ties cannot break ordering. */
function moveImageInStack(page: HTMLElement, object: HTMLElement, delta: 1 | -1): boolean {
  const sorted = sortTemplateImagesOnPage(page);
  const idx = sorted.indexOf(object);
  if (idx < 0) return false;
  const nextIdx = idx + delta;
  if (nextIdx < 0 || nextIdx >= sorted.length) return false;
  const newOrder = [...sorted];
  [newOrder[idx], newOrder[nextIdx]] = [newOrder[nextIdx], newOrder[idx]];
  newOrder.forEach((el, i) => {
    el.dataset.templateImagePriority = String(i);
  });
  return true;
}

/** Move image to an absolute stack index (0 = back, length − 1 = front). */
function moveImageToStackIndex(page: HTMLElement, object: HTMLElement, targetIndex: number): boolean {
  const sorted = sortTemplateImagesOnPage(page);
  const idx = sorted.indexOf(object);
  if (idx < 0) return false;
  const clamped = Math.max(0, Math.min(sorted.length - 1, Math.floor(targetIndex)));
  if (idx === clamped) return false;
  const newOrder = sorted.filter((el) => el !== object);
  newOrder.splice(clamped, 0, object);
  newOrder.forEach((el, i) => {
    el.dataset.templateImagePriority = String(i);
  });
  return true;
}

function applyTemplateImageObjectZIndex(object: HTMLElement) {
  // Body paragraphs use z-index:1 in the editor. Foreground images must sit above
  // so drag/resize hit-testing works; only true watermarks stay behind text.
  object.style.zIndex = object.dataset.templateImageBehindText === "true" ? "0" : "2";
}

function applyTemplateImageZOrderInPage(page: HTMLElement) {
  // Image controls and layer menus are positioned outside the page box when an
  // image sits near an edge; allow them to render into the editor gutter.
  page.style.overflow = "visible";
  const sorted = sortTemplateImagesOnPage(page);

  // Keep DOM order aligned with layer priority so ties on z-index still paint
  // deterministically (later siblings appear on top).
  sorted.forEach((el) => {
    page.appendChild(el);
  });
  sorted.forEach((el) => {
    applyTemplateImageObjectZIndex(el);
  });
}

function applyTemplateImageZOrderForEditor(editor: HTMLElement) {
  editor.querySelectorAll<HTMLElement>(".pdf-page").forEach((page) => {
    applyTemplateImageZOrderInPage(page);
  });
}

/** After text reflow: refresh overflow + stacking without reordering image DOM (layer order unchanged). */
function syncTemplateImageStackingAfterReflow(editor: HTMLElement) {
  editor.querySelectorAll<HTMLElement>(".pdf-page").forEach((page) => {
    page.style.overflow = "visible";
    page.querySelectorAll<HTMLElement>(TEMPLATE_IMAGE_OBJECT_SELECTOR).forEach((el) => {
      applyTemplateImageObjectZIndex(el);
    });
  });
}

const TEMPLATE_PAGE_BACKGROUND_SELECTOR = "img.pdf-page-background";

function closeTemplateImageLayerMenus(root: ParentNode) {
  root.querySelectorAll<HTMLElement>("[data-template-image-layer-menu]").forEach((menu) => {
    menu.style.display = "none";
  });
  root.querySelectorAll<HTMLElement>("[data-template-image-layer-trigger]").forEach((trigger) => {
    trigger.setAttribute("aria-expanded", "false");
  });
}

function setTemplateImageLayerActionState(button: HTMLButtonElement | null, disabled: boolean) {
  if (!button) return;
  button.disabled = disabled;
  button.style.opacity = disabled ? "0.45" : "1";
  button.style.cursor = disabled ? "not-allowed" : "pointer";
}

function syncTemplateImageLayerMenuState(object: HTMLElement) {
  const info = getTemplateImagePriorityIndex(object);
  const trigger = object.querySelector<HTMLButtonElement>("[data-template-image-layer-trigger]");
  if (trigger) {
    trigger.title = info ? `Layer ${info.index} of ${info.total}` : "Layer order";
  }

  setTemplateImageLayerActionState(
    object.querySelector<HTMLButtonElement>('[data-template-image-layer-action="all-back"]'),
    !info || info.index <= 1,
  );
  setTemplateImageLayerActionState(
    object.querySelector<HTMLButtonElement>('[data-template-image-layer-action="back-one"]'),
    !info || info.index <= 1,
  );
  setTemplateImageLayerActionState(
    object.querySelector<HTMLButtonElement>('[data-template-image-layer-action="up-one"]'),
    !info || info.index >= info.total,
  );
  setTemplateImageLayerActionState(
    object.querySelector<HTMLButtonElement>('[data-template-image-layer-action="all-up"]'),
    !info || info.index >= info.total,
  );

  const pinButton = object.querySelector<HTMLButtonElement>('[data-template-image-layer-action="pin-background"]');
  if (pinButton) {
    const isPinned = object.dataset.templateImagePinned === "true";
    pinButton.textContent = isPinned ? "Background \u2713" : "Pin as background";
    pinButton.style.color = isPinned ? "#0ea5e9" : "#0f172a";
  }
}

function migratePageBackgroundImageToTemplateObject(page: HTMLElement, image: HTMLImageElement, pageIndex: number, imageIndex: number) {
  const pageWidth = Math.max(
    1,
    Number.parseFloat(page.style.width || "0") || page.offsetWidth || image.naturalWidth || 1,
  );
  const pageHeight = Math.max(
    1,
    Number.parseFloat(page.dataset.baseMinHeight || page.style.minHeight || "0") || page.offsetHeight || image.naturalHeight || 1,
  );
  const left = Number.parseFloat(image.style.left || "0") || 0;
  const top = Number.parseFloat(image.style.top || "0") || 0;

  const object = createTemplateImageObjectElement(document, {
    left,
    top,
    width: pageWidth,
    height: pageHeight,
    src: image.getAttribute("src"),
    fileName: image.dataset.templateFileName || `pdf-background-page-${pageIndex + 1}-${imageIndex + 1}.png`,
    intrinsicWidth: image.naturalWidth || pageWidth,
    intrinsicHeight: image.naturalHeight || pageHeight,
    source: image.dataset.templateSource || "pdf-import-fallback",
  });

  object.dataset.templateImagePriority = String(-1 - imageIndex);
  object.dataset.templateImageBehindText = "true";
  page.insertBefore(object, image.nextSibling);
  image.remove();
}

function migrateLegacyTemplateImageLayer(object: HTMLElement) {
  if (object.dataset.templateImageLayer === "front" && !object.dataset.templateImagePriority) {
    object.dataset.templateImagePriority = "1";
  }
  delete object.dataset.templateImageLayer;
}

function getTemplateImagePriorityIndex(object: HTMLElement): { index: number; total: number } | null {
  const page = object.closest<HTMLElement>(".pdf-page");
  if (!page) return null;
  const sorted = sortTemplateImagesOnPage(page);
  const idx = sorted.indexOf(object);
  if (idx < 0) return null;
  return { index: idx + 1, total: sorted.length };
}

interface TemplateEditorProps {
  lawFirmId: string;
  templateId?: string;
  folderId?: string | null;
  initialFillValues?: Record<string, string>;
  initialRepeaterFillValues?: Record<string, Record<string, string>[]>;
  // When true, the server's DOCX to PDF converter is available, so a
  // re-uploaded document is previewed as a rendered PDF. Defaults to off.
  converterEnabled?: boolean;
  onSaved: () => void;
  onBack: () => void;
  onReady?: () => void;
}

const TEMPLATE_ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".doc", ".odt", ".rtf", ".txt"];
const TEMPLATE_ACCEPT_ATTR = TEMPLATE_ACCEPTED_EXTENSIONS.join(",");

// Raster image types only, SVG is excluded because it can carry script and
// these images are persisted to Storage and re-served into template HTML
// (matches the server-side allowlist in templates/actions.ts).
const IMAGE_MIME_ALLOWLIST = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const IMAGE_ACCEPT_ATTR = IMAGE_MIME_ALLOWLIST.join(",");

// US Letter @ 96dpi. The positional editor operates on `.pdf-page`
// elements; PDF import creates them, but a blank HTML template (or a
// legacy flow-authored template) has none, and the editor bails if the
// first `.pdf-page` is missing. wrapBareContentInBlankPage gives such
// content a real page so it renders with page chrome + can host images.
const BLANK_PAGE_WIDTH = 816;
const BLANK_PAGE_HEIGHT = 1056;
const BLANK_PAGE_MARGIN = 96; // 1in
export function buildBlankTemplatePage(innerHtml = "<p>Start typing here…</p>"): string {
  const colLeft = BLANK_PAGE_MARGIN;
  const colRight = BLANK_PAGE_WIDTH - BLANK_PAGE_MARGIN;
  const colWidth = BLANK_PAGE_WIDTH - BLANK_PAGE_MARGIN * 2;
  return (
    `<div class="pdf-page" data-page-index="0" data-base-min-height="${BLANK_PAGE_HEIGHT}" ` +
    `data-column-left="${colLeft}" data-column-right="${colRight}" data-column-width="${colWidth}" ` +
    `style="position:relative;width:${BLANK_PAGE_WIDTH}px;min-height:${BLANK_PAGE_HEIGHT}px;` +
    `margin:0 auto 24px;background:#fff;color:#000;box-shadow:0 2px 12px rgba(0,0,0,0.12);` +
    `padding:${BLANK_PAGE_MARGIN}px;overflow:hidden;">${innerHtml}</div>`
  );
}
function ensurePdfPage(innerHtml: string): string {
  return innerHtml.includes("pdf-page") ? innerHtml : buildBlankTemplatePage(innerHtml.trim() || undefined);
}
const TEMPLATE_TEXTBOX_WIDTH = 220;
const TEMPLATE_TEXTBOX_HEIGHT = 64;
const PAGE_RULER_WIDTH = 52;
const TAB_INSERTION = "\u00A0\u00A0\u00A0\u00A0";
const FONT_MARKER = "__template_font_marker__";
const FONT_SIZE_MARKER = "7";

function focusTemplateEditable(el: HTMLElement | null | undefined) {
  el?.focus({ preventScroll: true });
}

/** Character offsets for the selection, relative to text nodes under `root` (order matches TreeWalker SHOW_TEXT). */
function getTextRangeCharOffsetsWithinRoot(root: HTMLElement, range: Range): { start: number; end: number } | null {
  if (!root.contains(range.commonAncestorContainer)) return null;
  try {
    const rStart = document.createRange();
    rStart.setStart(root, 0);
    rStart.setEnd(range.startContainer, range.startOffset);
    const rEnd = document.createRange();
    rEnd.setStart(root, 0);
    rEnd.setEnd(range.endContainer, range.endOffset);
    let start = rStart.toString().length;
    let end = rEnd.toString().length;
    if (start > end) [start, end] = [end, start];
    return { start, end };
  } catch {
    return null;
  }
}

function resolveCharOffsetInRoot(root: HTMLElement, offset: number): { node: Node; offset: number } | null {
  let remaining = offset;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = node as Text;
    const len = t.length;
    if (remaining < len) return { node: t, offset: remaining };
    if (remaining === len) return { node: t, offset: remaining };
    remaining -= len;
  }
  return null;
}

function restoreTextRangeCharOffsetsWithinRoot(root: HTMLElement, start: number, end: number): boolean {
  const selection = window.getSelection();
  if (!selection) return false;
  let s = start;
  let e = end;
  if (s > e) [s, e] = [e, s];
  const startPos = resolveCharOffsetInRoot(root, s);
  const endPos = resolveCharOffsetInRoot(root, e);
  if (!startPos || !endPos) return false;
  const r = document.createRange();
  try {
    r.setStart(startPos.node, startPos.offset);
    r.setEnd(endPos.node, endPos.offset);
  } catch {
    return false;
  }
  selection.removeAllRanges();
  selection.addRange(r);
  return true;
}

/** When offsets cannot be restored, keep a single wrapped region selected (only valid if one replacement). */
function selectSingleReplacementSpan(span: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;
  const r = document.createRange();
  r.setStart(span, 0);
  r.setEnd(span, span.childNodes.length);
  selection.removeAllRanges();
  selection.addRange(r);
}

function selectReplacementSpanRange(spans: HTMLElement[]): boolean {
  if (spans.length === 0) return false;
  const selection = window.getSelection();
  if (!selection) return false;

  const first = spans[0];
  const last = spans[spans.length - 1];
  const r = document.createRange();
  try {
    r.setStart(first, 0);
    r.setEnd(last, last.childNodes.length);
  } catch {
    return false;
  }
  selection.removeAllRanges();
  selection.addRange(r);
  return true;
}

function collapseCaretToEndOfElement(el: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;
  const r = document.createRange();
  const lastText = findLastTextNodeInSubtree(el);
  if (lastText) {
    const len = lastText.length;
    r.setStart(lastText, len);
    r.setEnd(lastText, len);
  } else {
    r.setStart(el, el.childNodes.length);
    r.setEnd(el, el.childNodes.length);
  }
  selection.removeAllRanges();
  selection.addRange(r);
}

function findLastTextNodeInSubtree(root: Node): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  let n: Node | null;
  while ((n = walker.nextNode())) last = n as Text;
  return last;
}

/** Node at the logical start of the range, use for toolbar font/size (anchorNode can be the opposite end). */
function getRangeStartLeafForToolbar(range: Range): Node {
  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    return startContainer;
  }
  if (startContainer instanceof HTMLElement) {
    if (startOffset < startContainer.childNodes.length) {
      const child = startContainer.childNodes[startOffset];
      if (child.nodeType === Node.TEXT_NODE) return child;
      const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
      const t = walker.nextNode();
      if (t) return t;
      return child;
    }
    if (startOffset > 0) {
      const prev = startContainer.childNodes[startOffset - 1];
      if (prev.nodeType === Node.TEXT_NODE) return prev;
      if (prev instanceof HTMLElement) {
        const walker = document.createTreeWalker(prev, NodeFilter.SHOW_TEXT);
        let last: Node | null = null;
        let n: Node | null;
        while ((n = walker.nextNode())) last = n;
        if (last) return last;
      }
      return prev;
    }
  }
  return startContainer;
}

/**
 * Parent of the first non-empty text node that actually intersects the range.
 * Paragraph-level ancestors often inherit a different font than the run the user selected (e.g. PDF import).
 */
function getFirstMeaningfulTextParentInRange(range: Range): HTMLElement | null {
  const ca = range.commonAncestorContainer;
  const root = ca.nodeType === Node.ELEMENT_NODE ? (ca as HTMLElement) : ca.parentElement;
  if (!root) return null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    if (t.textContent?.replace(/\u200B/g, "").trim() === "") continue;
    try {
      if (!range.intersectsNode(t)) continue;
    } catch {
      continue;
    }
    return t.parentElement;
  }
  return null;
}

const LINE_SPACING_OPTIONS = [
  { value: "1", label: "Single" },
  { value: "1.15", label: "1.15" },
  { value: "1.5", label: "1.5" },
  { value: "2", label: "Double" },
] as const;
const TEXT_ALIGN_OPTIONS = [
  { value: "left", label: "Align left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Align right" },
  { value: "justify", label: "Justify" },
] as const;

type ToolbarStyleState = {
  fontFamily: string;
  fontSize: number;
  lineHeight: string;
  spaceBefore: number;
  spaceAfter: number;
  textAlign: string;
  isLink: boolean;
  isBold: boolean;
  isItalic: boolean;
  isUnderline: boolean;
  isBulletList: boolean;
  isNumberedList: boolean;
  color: string;
};

type PlaceholderFieldStyle = {
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  color: string;
};

type ActiveParagraphMetrics = {
  id: string;
  left: number;
  width: number;
  pageWidth: number;
};

type SelectionSnapshot = {
  kind: "paragraph" | "textbox";
  targetId: string;
  start: number;
  end: number;
};

const DEFAULT_TOOLBAR_STYLE: ToolbarStyleState = {
  fontFamily: "Times-Roman",
  fontSize: 16,
  lineHeight: "1.15",
  spaceBefore: 0,
  spaceAfter: 0,
  textAlign: "left",
  isLink: false,
  isBold: false,
  isItalic: false,
  isUnderline: false,
  isBulletList: false,
  isNumberedList: false,
  color: "#000000",
};

function isSupportedTemplateFile(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  return TEMPLATE_ACCEPTED_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
}

function isPdfFile(file: File): boolean {
  return file.type.toLowerCase().includes("pdf") || file.name.toLowerCase().endsWith(".pdf");
}

function isDocxFile(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  return lowerName.endsWith(".docx");
}

function getFontCss(fontFamily: string): string {
  return FONT_FAMILIES.find((font) => font.value === fontFamily)?.css ?? "'Times New Roman', Times, serif";
}

const DEFAULT_PLACEHOLDER_FIELD_STYLE: PlaceholderFieldStyle = {
  fontFamily: getFontCss(DEFAULT_TOOLBAR_STYLE.fontFamily),
  fontSize: DEFAULT_TOOLBAR_STYLE.fontSize,
  fontWeight: "400",
  fontStyle: "normal",
  color: DEFAULT_TOOLBAR_STYLE.color,
};

/** Base font on the contenteditable root so unstyled runs (e.g. a space outside a PDF span) do not inherit the app UI sans-serif. */
const EDITOR_ROOT_FONT_FAMILY = DEFAULT_PLACEHOLDER_FIELD_STYLE.fontFamily;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image file."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function loadImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
    image.onerror = () => reject(new Error("Failed to load image."));
    image.src = src;
  });
}

/** Any `<p>` under a page (DOCX / some imports nest; PDF lines are usually `.pdf-page > p`). */
const SEL_PAGE_P = ".pdf-page p";
/** PDF flow lines merged by the editor, always direct children of `.pdf-page`. */
const SEL_DIRECT_PAGE_P = ".pdf-page > p";

function getToolbarStyleFromElement(element: HTMLElement, selectionElement?: Element | null): ToolbarStyleState {
  const selectionSource = selectionElement ?? element;
  const styleSource = (selectionElement instanceof HTMLElement ? selectionElement : element);
  const computed = window.getComputedStyle(styleSource);
  const fallbackComputed = styleSource === element ? computed : window.getComputedStyle(element);
  const fontSize = Math.round(Number.parseFloat(computed.fontSize) || DEFAULT_TOOLBAR_STYLE.fontSize);
  const isChip = Boolean(selectionSource.closest("[data-placeholder-chip]"));

  // When the selection element differs from the fallback (e.g. cursor is on
  // a ZWS but we resolved to the nearest styled span), queryCommandValue
  // returns the wrong font/color from the cursor's actual position. Skip it
  // and rely on computed styles from the resolved element instead.
  const useQueryCommands = !isChip && styleSource === element;

  // Read paragraph spacing from the paragraph element (spacing metadata lives on direct PDF lines only)
  const paragraphEl = element.closest<HTMLElement>(SEL_PAGE_P) ?? element;
  const isDirectPdfLine = paragraphEl.matches(SEL_DIRECT_PAGE_P);
  const spaceBefore = isDirectPdfLine
    ? Math.max(0, Number.parseFloat(paragraphEl.dataset.baseGapBefore || "0") || 0)
    : 0;
  const nextSibling = isDirectPdfLine
    ? paragraphEl.nextElementSibling as HTMLElement | null
    : null;
  const spaceAfter = nextSibling?.matches("p")
    ? Math.max(0, Number.parseFloat(nextSibling.dataset.baseGapBefore || "0") || 0)
    : 0;

  return {
    // Always use computed font-family from the resolved element, queryCommandValue("fontName")
    // is unreliable after programmatic range restore / multi-page selections.
    fontFamily: mapCssToFontValue(
      computed.fontFamily || fallbackComputed.fontFamily || ""
    ),
    fontSize,
    lineHeight: getClosestLineSpacing(
      element.style.lineHeight || fallbackComputed.lineHeight || "",
      Math.round(Number.parseFloat(fallbackComputed.fontSize) || fontSize),
    ),
    spaceBefore,
    spaceAfter,
    textAlign: normalizeTextAlign(fallbackComputed.textAlign || ""),
    isLink: Boolean(selectionSource.closest("a") || selectionSource.closest("[data-link-href]")),
    isBold: (useQueryCommands && document.queryCommandState("bold"))
      || /bold|600|700|800|900/.test(computed.fontWeight),
    isItalic: (useQueryCommands && document.queryCommandState("italic"))
      || computed.fontStyle === "italic",
    isUnderline: (useQueryCommands && document.queryCommandState("underline"))
      || (isChip
        ? (selectionSource.closest("[data-placeholder-chip]") as HTMLElement)?.dataset.chipUnderline === "1"
        : computed.textDecorationLine.includes("underline")
          || (selectionSource.closest("[data-link-href]") as HTMLElement | null)?.style.textDecoration?.includes("underline") === true),
    isBulletList: Boolean(selectionSource.closest("ul")),
    isNumberedList: Boolean(selectionSource.closest("ol")),
    color: foreColorToHex(
      (useQueryCommands ? document.queryCommandValue("foreColor") : "") || computed.color || DEFAULT_TOOLBAR_STYLE.color
    ),
  };
}

function getPlaceholderFieldStyleFromElement(element: HTMLElement): PlaceholderFieldStyle {
  const computed = window.getComputedStyle(element);
  return {
    fontFamily: computed.fontFamily || DEFAULT_PLACEHOLDER_FIELD_STYLE.fontFamily,
    fontSize: Math.round(Number.parseFloat(computed.fontSize) || DEFAULT_PLACEHOLDER_FIELD_STYLE.fontSize),
    fontWeight: computed.fontWeight || DEFAULT_PLACEHOLDER_FIELD_STYLE.fontWeight,
    fontStyle: computed.fontStyle || DEFAULT_PLACEHOLDER_FIELD_STYLE.fontStyle,
    color: foreColorToHex(computed.color || DEFAULT_PLACEHOLDER_FIELD_STYLE.color),
  };
}

function getPlaceholderFieldStyleFromToolbar(style: ToolbarStyleState): PlaceholderFieldStyle {
  return {
    fontFamily: getFontCss(style.fontFamily),
    fontSize: style.fontSize,
    fontWeight: style.isBold ? "700" : "400",
    fontStyle: style.isItalic ? "italic" : "normal",
    color: style.color,
  };
}

function applyPlaceholderFieldStyle(chip: HTMLElement, style: PlaceholderFieldStyle) {
  chip.style.fontFamily = style.fontFamily;
  chip.style.fontSize = `${style.fontSize}px`;
  chip.style.fontWeight = style.fontWeight;
  chip.style.fontStyle = style.fontStyle;
  chip.style.color = style.color;
  chip.style.textDecorationColor = style.color;
}

const CUSTOM_SPACING_THRESHOLD = 0.05;
const UNDO_BATCH_MS = 300;

function getClosestLineSpacing(lineHeight: string, fontSize: number): string {
  if (!lineHeight || lineHeight === "normal") return DEFAULT_TOOLBAR_STYLE.lineHeight;

  const parsed = Number.parseFloat(lineHeight);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TOOLBAR_STYLE.lineHeight;

  const ratio = lineHeight.endsWith("px")
    ? parsed / Math.max(fontSize, 1)
    : parsed;

  let closest: string = LINE_SPACING_OPTIONS[0].value;
  let delta = Number.POSITIVE_INFINITY;
  for (const option of LINE_SPACING_OPTIONS) {
    const nextDelta = Math.abs(Number.parseFloat(option.value) - ratio);
    if (nextDelta < delta) {
      delta = nextDelta;
      closest = option.value;
    }
  }

  if (delta > CUSTOM_SPACING_THRESHOLD) {
    return String(Math.round(ratio * 100) / 100);
  }

  return closest;
}

function normalizeTextAlign(textAlign: string): string {
  if (textAlign === "start") return "left";
  if (textAlign === "end") return "right";
  return TEXT_ALIGN_OPTIONS.some((option) => option.value === textAlign)
    ? textAlign
    : DEFAULT_TOOLBAR_STYLE.textAlign;
}

function normalizeLinkHref(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(https?:|mailto:|tel:|ftp:|#|\/)/i.test(trimmed)) return trimmed;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return `mailto:${trimmed}`;
  return `https://${trimmed}`;
}

function getNodeTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent?.length ?? 0;
  }

  if (node.nodeName === "BR") {
    return 1;
  }

  let total = 0;
  node.childNodes.forEach((child) => {
    total += getNodeTextLength(child);
  });
  return total;
}

function getNodeTextValue(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }

  if (node.nodeName === "BR") {
    return "\n";
  }

  let text = "";
  node.childNodes.forEach((child) => {
    text += getNodeTextValue(child);
  });
  return text;
}

function isParagraphBreakChar(char: string | undefined): boolean {
  return typeof char === "string" && /[\s\u00A0]/u.test(char);
}

function findPreferredSplitOffset(root: HTMLElement, offset: number): number {
  const text = getNodeTextValue(root);
  if (offset <= 0 || offset >= text.length) {
    return offset;
  }

  for (let index = Math.min(offset - 1, text.length - 1); index >= 0; index -= 1) {
    if (!isParagraphBreakChar(text[index])) continue;

    const boundary = index + 1;
    if (boundary > 0 && boundary < text.length) {
      return boundary;
    }
  }

  return offset;
}

function defaultParagraphGap(paragraph: HTMLElement): number {
  const fontSize = Number.parseFloat(paragraph.style.fontSize || "12");
  const lineHeight = Number.parseFloat(paragraph.style.lineHeight || "1.15");
  return Math.round(fontSize * lineHeight * 0.25);
}

function applyParagraphWrapStyles(paragraph: HTMLElement) {
  paragraph.style.whiteSpace = "normal";
  paragraph.style.overflowWrap = "break-word";
  paragraph.style.wordBreak = "normal";
  if (paragraph.style.width) {
    paragraph.style.maxWidth = paragraph.style.width;
  }
}

function isParagraphAwaitingNewText(paragraph: HTMLElement): boolean {
  const normalized = (paragraph.textContent || "")
    .replace(/\u200B/g, "")
    .replace(/\u00A0/g, " ")
    .trim();

  if (!normalized) return true;

  return /^([•‣◦⁃∙▪▫▸▹●○■□✓✔✗✘‒–\u2014-]|\d+[.)]|[a-zA-Z][.)]|[ivxIVX]+[.)])$/.test(normalized);
}

function preserveEditableGapSpans(paragraph: HTMLElement) {
  paragraph.querySelectorAll<HTMLElement>("[data-pdf-gap]").forEach((gap) => {
    // Stash original width so repeated calls can restore it.
    if (!gap.dataset.pdfGapWidth) {
      const w = Number.parseFloat(gap.style.width || "0");
      if (w > 0) gap.dataset.pdfGapWidth = String(w);
    }
    const gapWidth = Number.parseFloat(gap.dataset.pdfGapWidth || gap.style.width || "0");
    if (gapWidth <= 0) return;

    // Keep inline-block for pixel-accurate layout (inline causes subtle
    // height drift that corrupts pagination). Ensure width is always set.
    gap.textContent = "\u00A0";
    gap.style.display = "inline-block";
    gap.style.width = `${gapWidth}px`;
    gap.style.verticalAlign = "baseline";

    // Insert zero-width spaces around the gap so the caret can be placed
    // on either side and so backspace/delete doesn't swallow the gap.
    const prev = gap.previousSibling;
    if (!prev || prev.nodeType !== Node.TEXT_NODE) {
      gap.parentNode?.insertBefore(document.createTextNode("\u200B"), gap);
    }
    const next = gap.nextSibling;
    if (!next || next.nodeType !== Node.TEXT_NODE) {
      gap.parentNode?.insertBefore(document.createTextNode("\u200B"), gap.nextSibling);
    }
  });
}

function ensureChipCaretTargets(container: Element) {
  container.querySelectorAll("[data-placeholder-chip]").forEach((chip) => {
    const prev = chip.previousSibling;
    if (!prev || prev.nodeType !== Node.TEXT_NODE) {
      chip.parentNode?.insertBefore(document.createTextNode("\u200B"), chip);
    }
    const next = chip.nextSibling;
    if (!next || next.nodeType !== Node.TEXT_NODE) {
      chip.parentNode?.insertBefore(document.createTextNode("\u200B"), chip.nextSibling);
    }
  });
}

function stripZeroWidthSpaces(container: Element) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const toRemove: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.data.includes("\u200B")) {
      node.data = node.data.replace(/\u200B/g, "");
      if (!node.data) toRemove.push(node);
    }
  }
  for (const n of toRemove) n.remove();
}

const CHIP_EDGE_THRESHOLD = 8;

function placeCaretBesideChip(chip: HTMLElement, side: "before" | "after") {
  if (side === "before") {
    if (!chip.previousSibling || chip.previousSibling.nodeType !== Node.TEXT_NODE) {
      chip.parentNode?.insertBefore(document.createTextNode("\u200B"), chip);
    }
    const textNode = chip.previousSibling;
    if (textNode?.nodeType === Node.TEXT_NODE) {
      const range = document.createRange();
      range.setStart(textNode, textNode.textContent?.length ?? 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  } else {
    if (!chip.nextSibling || chip.nextSibling.nodeType !== Node.TEXT_NODE) {
      chip.parentNode?.insertBefore(document.createTextNode("\u200B"), chip.nextSibling);
    }
    const textNode = chip.nextSibling;
    if (textNode?.nodeType === Node.TEXT_NODE) {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }
}

function getPageColumnRightEdge(page: HTMLElement): number {
  const datasetRight = Number.parseFloat(page.dataset.columnRight || "");
  if (Number.isFinite(datasetRight) && datasetRight > 0) {
    return datasetRight;
  }

  const pageWidth = Number.parseFloat(page.style.width || "0") || page.offsetWidth || 0;
  const paragraphs = Array.from(page.querySelectorAll<HTMLElement>(":scope > p"));
  const maxRight = paragraphs.length > 0
    ? Math.max(...paragraphs.map((paragraph) => {
        const left = Number.parseFloat(paragraph.style.left || paragraph.style.marginLeft || "0");
        const width = Number.parseFloat(paragraph.style.width || "0");
        return left + width;
      }))
    : 0;

  if (pageWidth > 0) {
    const defaultRight = pageWidth - Math.max(72, pageWidth * 0.08);
    return Math.max(defaultRight, maxRight);
  }

  return maxRight;
}

function getParagraphHorizontalBounds(paragraph: HTMLElement) {
  const left = Number.parseFloat(paragraph.style.left || paragraph.style.marginLeft || "0");
  const width = Number.parseFloat(paragraph.style.width || "0");
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  return {
    left,
    width: safeWidth,
    right: left + safeWidth,
    center: left + (safeWidth / 2),
  };
}

function sharesRulerColumn(
  selectedBounds: { left: number; right: number; width: number; center: number },
  candidateBounds: { left: number; right: number; width: number; center: number },
) {
  if (candidateBounds.width <= 0 || selectedBounds.width <= 0) return false;

  const overlap = Math.max(0, Math.min(selectedBounds.right, candidateBounds.right) - Math.max(selectedBounds.left, candidateBounds.left));
  const overlapRatio = overlap / Math.max(1, Math.min(selectedBounds.width, candidateBounds.width));
  const leftAligned = Math.abs(candidateBounds.left - selectedBounds.left) <= 36;
  const rightAligned = Math.abs(candidateBounds.right - selectedBounds.right) <= 36;
  const centerAligned = Math.abs(candidateBounds.center - selectedBounds.center) <= Math.max(48, Math.min(selectedBounds.width, candidateBounds.width) * 0.25);

  return leftAligned || rightAligned || (overlapRatio >= 0.75 && centerAligned);
}

function getOffsetWithinBlock(root: Node, target: Node, targetOffset: number): number {
  let total = 0;
  let found = false;

  const walk = (node: Node) => {
    if (found) return;

    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) {
        total += Math.min(targetOffset, node.textContent?.length ?? 0);
      } else {
        Array.from(node.childNodes)
          .slice(0, targetOffset)
          .forEach((child) => {
            total += getNodeTextLength(child);
          });
      }
      found = true;
      return;
    }

    if (node.nodeType === Node.TEXT_NODE || node.nodeName === "BR") {
      total += getNodeTextLength(node);
      return;
    }

    node.childNodes.forEach((child) => walk(child));
  };

  walk(root);
  return total;
}

function resolveOffsetWithinBlock(root: HTMLElement, offset: number): { node: Node; offset: number } {
  if (offset <= 0) {
    return { node: root, offset: 0 };
  }

  let remaining = offset;
  let resolved: { node: Node; offset: number } | null = null;

  const walk = (node: Node) => {
    if (resolved) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) {
        resolved = { node, offset: remaining };
        return;
      }
      remaining -= length;
      return;
    }

    if (node.nodeName === "BR") {
      const parent = node.parentNode;
      if (!parent) return;
      if (remaining <= 1) {
        resolved = {
          node: parent,
          offset: Array.from(parent.childNodes).indexOf(node as ChildNode) + 1,
        };
        return;
      }
      remaining -= 1;
      return;
    }

    node.childNodes.forEach((child) => walk(child));
  };

  walk(root);

  if (resolved) return resolved;
  return { node: root, offset: root.childNodes.length };
}

function getDefaultPageContentBottom(pageHeight: number, contentTop: number): number {
  if (!Number.isFinite(pageHeight) || pageHeight <= 0) {
    return Math.max(240, contentTop + 240);
  }

  const desiredBottom = Math.min(pageHeight - 96, pageHeight * 0.92);
  return Math.max(contentTop + 240, desiredBottom);
}

/** Page 1 often encodes a large Y for the first body line; overflow pages must not inherit that as content top. */
const OVERFLOW_PAGE_CONTENT_TOP_THRESHOLD = 130;

/** Prefer `style.top`, it is updated by repagination; `dataset.baseTop` is often stale PDF import metadata. */
function getParagraphLayoutTop(paragraph: HTMLElement): number {
  const fromStyle = paragraph.style.top?.trim();
  if (fromStyle) {
    const v = Number.parseFloat(fromStyle);
    if (Number.isFinite(v)) return v;
  }
  return Number.parseFloat(paragraph.dataset.baseTop || "0") || 0;
}

type PageFlowGroupMetrics = {
  id: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  avgFontSize: number;
  lineCount: number;
  isBlank: boolean;
};

function getMedian(values: number[]): number {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) return 0;

  const sorted = [...filtered].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

function collectPageFlowGroups(page: HTMLElement): PageFlowGroupMetrics[] {
  const paragraphs = Array.from(page.querySelectorAll<HTMLElement>(":scope > p"));
  const groups = new Map<string, PageFlowGroupMetrics>();

  paragraphs.forEach((paragraph, index) => {
    const groupId = paragraph.dataset.flowGroup
      || paragraph.dataset.logicalParagraphId
      || paragraph.dataset.paragraphId
      || `group_${index}`;
    const top = getParagraphLayoutTop(paragraph);
    const fontSize = Number.parseFloat(paragraph.style.fontSize || "0") || 12;
    const height = Number.parseFloat(paragraph.dataset.baseHeight || "0")
      || paragraph.offsetHeight
      || Math.max(fontSize * 1.2, 1);
    const left = Number.parseFloat(paragraph.style.left || paragraph.style.marginLeft || "0");
    const width = Number.parseFloat(paragraph.style.width || "0") || paragraph.offsetWidth || 0;
    const right = left + width;
    const isBlank = paragraph.dataset.blankLine === "true" || !(paragraph.textContent || "").trim();

    const existing = groups.get(groupId);
    if (existing) {
      existing.top = Math.min(existing.top, top);
      existing.bottom = Math.max(existing.bottom, top + height);
      existing.left = Math.min(existing.left, left);
      existing.right = Math.max(existing.right, right);
      existing.width = Math.max(existing.width, existing.right - existing.left);
      existing.avgFontSize = ((existing.avgFontSize * existing.lineCount) + fontSize) / (existing.lineCount + 1);
      existing.lineCount += 1;
      existing.isBlank = existing.isBlank && isBlank;
      return;
    }

    groups.set(groupId, {
      id: groupId,
      top,
      bottom: top + height,
      left,
      right,
      width: Math.max(width, right - left),
      avgFontSize: fontSize,
      lineCount: 1,
      isBlank,
    });
  });

  return Array.from(groups.values()).sort((a, b) => a.top - b.top);
}

function detectFooterBandTop(page: HTMLElement): number | null {
  const groups = collectPageFlowGroups(page).filter((group) => !group.isBlank);
  if (groups.length < 2) return null;

  const pageHeight = Number.parseFloat(page.dataset.baseMinHeight || page.style.minHeight || "0")
    || page.offsetHeight
    || 0;
  const pageWidth = Number.parseFloat(page.style.width || "0") || page.offsetWidth || 0;
  const colLeft = Number.parseFloat(page.dataset.columnLeft || "0") || 0;
  const colRight = Number.parseFloat(page.dataset.columnRight || "0")
    || (pageWidth > 0 ? pageWidth - Math.max(72, pageWidth * 0.08) : 0);
  const colWidth = Math.max(1, colRight - colLeft);

  const bodySizedGroups = groups.filter((group) => group.width >= colWidth * 0.55);
  const bodyFontSize = getMedian((bodySizedGroups.length > 0 ? bodySizedGroups : groups).map((group) => group.avgFontSize)) || 12;
  const groupGaps = groups
    .slice(1)
    .map((group, index) => Math.max(0, group.top - groups[index].bottom))
    .filter((gap) => gap > 2 && gap < 200);
  const typicalGap = getMedian(groupGaps) || Math.max(bodyFontSize * 1.2, 12);
  const insetTolerance = Math.max(24, colWidth * 0.08);
  const footerSeparationThreshold = Math.max(18, typicalGap * 1.45, bodyFontSize * 1.35);
  const footerClusterGapThreshold = Math.max(16, typicalGap * 1.1, bodyFontSize * 0.9);
  const compactHeightThreshold = Math.max(36, bodyFontSize * 2.6);

  const isCompact = (group: PageFlowGroupMetrics) =>
    group.lineCount <= 2 || (group.bottom - group.top) <= compactHeightThreshold;

  const looksSupplemental = (group: PageFlowGroupMetrics) => {
    const leftInset = Math.abs(group.left - colLeft);
    const rightInset = Math.abs(colRight - group.right);
    const doesNotSpanColumn = leftInset > insetTolerance || rightInset > insetTolerance;
    const narrowerThanBody = group.width < colWidth * 0.86;
    const smallerThanBody = group.avgFontSize < bodyFontSize * 0.95;

    if (!isCompact(group)) {
      return false;
    }

    return smallerThanBody || doesNotSpanColumn || narrowerThanBody;
  };

  let footerTop: number | null = null;

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    const prev = index > 0 ? groups[index - 1] : null;
    const next = index < groups.length - 1 ? groups[index + 1] : null;
    const gapBefore = prev ? Math.max(0, group.top - prev.bottom) : group.top;
    const gapToNext = next ? Math.max(0, next.top - group.bottom) : 0;
    const nearBottom = pageHeight > 0
      ? group.bottom >= pageHeight * 0.88 || group.top >= pageHeight * 0.82
      : true;

    if (footerTop === null) {
      if (!(nearBottom && gapBefore >= footerSeparationThreshold && looksSupplemental(group))) {
        break;
      }
      footerTop = group.top;
      continue;
    }

    const belongsToFooterCluster = nearBottom && gapToNext <= footerClusterGapThreshold && looksSupplemental(group);
    if (!belongsToFooterCluster) {
      break;
    }

    footerTop = group.top;
  }

  return footerTop;
}

function inferAutoPageContentBottom(page: HTMLElement, contentTop: number): number {
  const pageHeight = Number.parseFloat(page.dataset.baseMinHeight || page.style.minHeight || "0")
    || page.offsetHeight
    || 0;
  const fallbackBottom = getDefaultPageContentBottom(pageHeight, contentTop);
  const paragraphs = Array.from(page.querySelectorAll<HTMLElement>(":scope > p"))
    .filter((paragraph) => !(paragraph.dataset.blankLine === "true" || !(paragraph.textContent || "").trim()));
  const actualContentBottom = paragraphs.length > 0
    ? Math.max(...paragraphs.map((paragraph) => {
        const top = getParagraphLayoutTop(paragraph);
        const height = Number.parseFloat(paragraph.dataset.baseHeight || "0")
          || paragraph.offsetHeight
          || 0;
        return top + height;
      }))
    : 0;
  const actualBottom = actualContentBottom > 0
    ? Math.min(actualContentBottom + 24, Math.max(0, pageHeight - 24))
    : 0;
  const footerTop = detectFooterBandTop(page);

  if (footerTop === null) {
    return actualBottom > 0 ? Math.max(fallbackBottom, actualBottom) : fallbackBottom;
  }

  const groups = collectPageFlowGroups(page).filter((group) => !group.isBlank);
  const bodyFontSize = getMedian(groups.map((group) => group.avgFontSize)) || 12;
  const groupGaps = groups
    .slice(1)
    .map((group, index) => Math.max(0, group.top - groups[index].bottom))
    .filter((gap) => gap > 2 && gap < 200);
  const padding = Math.max(12, getMedian(groupGaps) * 0.75, bodyFontSize * 0.6);
  const minBottom = Math.max(contentTop + 240, 220);
  const maxBottom = Math.max(minBottom, pageHeight - 24);

  const unclampedBottom = actualBottom > 0 ? Math.max(fallbackBottom, actualBottom) : fallbackBottom;
  const footerBound = footerTop - padding;

  // If any paragraph that *starts* above the detected footer extends below footerBound,
  // the footer heuristic is wrong (e.g. a long inserted list matched "supplemental") or the
  // body legitimately fills that band, do not reserve a no-man's land that forces early
  // page breaks and leaves a large gap on page 1.
  const bodyMaxBottom = paragraphs.reduce((acc, paragraph) => {
    const top = getParagraphLayoutTop(paragraph);
    if (top >= footerTop) return acc;
    const height = Number.parseFloat(paragraph.dataset.baseHeight || "0") || paragraph.offsetHeight || 0;
    return Math.max(acc, top + height);
  }, 0);

  if (bodyMaxBottom > footerBound) {
    return Math.min(maxBottom, Math.max(minBottom, unclampedBottom));
  }

  return Math.min(maxBottom, Math.max(minBottom, Math.min(unclampedBottom, footerBound)));
}

function createTemplateDomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export default function TemplateEditor({ lawFirmId, templateId, folderId, initialFillValues, initialRepeaterFillValues, converterEnabled = false, onSaved, onBack, onReady }: TemplateEditorProps) {
  const [phase, setPhase] = useState<"upload" | "editor" | "docx-setup">("upload");
  const repeaterTitleId = useId();
  const repeaterInputId = useId();
  const linkTitleId = useId();
  const linkInputId = useId();
  const [exportHtml, setExportHtml] = useState("");
  const [chipNames, setChipNames] = useState<string[]>([]);
  const [repeaterNames, setRepeaterNames] = useState<string[]>([]);
  const [showRepeaterModal, setShowRepeaterModal] = useState(false);
  const [repeaterNameInput, setRepeaterNameInput] = useState("");
  const [activeRepeaterContext, setActiveRepeaterContext] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertingDocx, setConvertingDocx] = useState(false);
  // DOCX template state
  const [docxFields, setDocxFields] = useState<string[]>([]);
  const [docxRepeaters, setDocxRepeaters] = useState<{ name: string; fields: string[] }[]>([]);
  const [docxPreviewUrl, setDocxPreviewUrl] = useState<string | null>(null);
  // Bumped on a successful DOCX re-upload so the client-side DocxTemplatePreview
  // remounts and refetches the new source (same templateId → the effect alone
  // wouldn't). Only matters when the converter <embed> path is off.
  const [docxPreviewVersion, setDocxPreviewVersion] = useState(0);
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A .docx the server held back because it still names a firm client (task
  // 12), kept so Save anyway can run the same import or re-upload again with
  // those values acknowledged.
  const [leftoverPrompt, setLeftoverPrompt] = useState<{
    kind: "import" | "reupload";
    file: File;
    leftovers: LeftoverClientText[];
  } | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [nameError, setNameError] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [insertBtnReady, setInsertBtnReady] = useState(false);
  const [textBoxMode, setTextBoxMode] = useState(false);
  const [selectedTextBoxId, setSelectedTextBoxId] = useState<string | null>(null);
  const [selectedImageObjectId, setSelectedImageObjectId] = useState<string | null>(null);
  /** Bumps when image layer priority changes so the footer re-reads DOM rank. */
  const [imageLayerTick, setImageLayerTick] = useState(0);
  const [selectedChipVersion, setSelectedChipVersion] = useState(0);
  const [templateAssets, setTemplateAssets] = useState<TemplateAsset[]>([]);
  // Fill-mode export state (Download + Save to Files buttons next to "Back to Fill")
  const [fillExporting, setFillExporting] = useState(false);
  const [fillUploading, setFillUploading] = useState(false);
  const [showFillFormats, setShowFillFormats] = useState(false);
  const [showFillSaveModal, setShowFillSaveModal] = useState(false);
  const fillFormatDropdownRef = useRef<HTMLDivElement>(null);
  const [cropTargetImageId, setCropTargetImageId] = useState<string | null>(null);
  const [toolbarStyle, setToolbarStyle] = useState<ToolbarStyleState>(DEFAULT_TOOLBAR_STYLE);
  const [fieldStylePreset, setFieldStylePreset] = useState<PlaceholderFieldStyle>(DEFAULT_PLACEHOLDER_FIELD_STYLE);
  const [pageWidth, setPageWidth] = useState(0);
  const [pageHeight, setPageHeight] = useState(0);
  const [pageContentTop, setPageContentTop] = useState(72);
  const [pageContentBottom, setPageContentBottom] = useState(0);
  const [activePageOffsetTop, setActivePageOffsetTop] = useState(0);
  const [activePageNumber, setActivePageNumber] = useState(1);
  const [activeParagraphId, setActiveParagraphId] = useState<string | null>(null);
  const [activeParagraphMetrics, setActiveParagraphMetrics] = useState<ActiveParagraphMetrics | null>(null);
  const [editorScrollLeft, setEditorScrollLeft] = useState(0);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkUrlInput, setLinkUrlInput] = useState("");
  const linkContextRef = useRef<{
    existingLink: HTMLElement | null;
    selectionWasCollapsed: boolean;
    editable: HTMLElement | null;
    startOffset: number;
    endOffset: number;
  } | null>(null);

  const editorRef = useRef<HTMLDivElement>(null);
  const editorWrapperRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const pendingHighlightRef = useRef<HTMLElement | null>(null);
  const activeEditableRef = useRef<HTMLElement | null>(null);
  const initializedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const docxReuploadInputRef = useRef<HTMLInputElement>(null);
  const docxTemplateIdRef = useRef<string | null>(null);
  const mutNormalizerRef = useRef<MutationObserver | null>(null);
  const textBoxDragActiveRef = useRef(false);
  const suppressNextTextBoxClickRef = useRef(false);
  const zoomLevelRef = useRef(1);
  const textBoxModeRef = useRef(false);
  const mouseDownInEditorRef = useRef(false);
  const chipEdgeClickRef = useRef(false);
  const nativeLineBreakInsertionRef = useRef(false);
  const fieldStylePresetCustomizedRef = useRef(false);
  const customHistoryRef = useRef<{
    snapshots: Array<{ html: string; cursorPos: number }>;
    index: number;
    debounceTimer: ReturnType<typeof setTimeout> | null;
  }>({ snapshots: [], index: -1, debounceTimer: null });
  // Stores latest undo/redo functions so the shared editor key handler can call
  // them without a forward-reference dependency on callbacks defined later in the file.
  const undoRedoHandlersRef = useRef<{ undo: () => void; redo: () => void }>({ undo: () => {}, redo: () => {} });

  // Notify parent that editor has mounted (used to clear loading spinner on view transitions)
  useEffect(() => { onReady?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Custom undo/redo history (time-batched) ──────────────────

  // Returns total characters before the cursor within the editor (text nodes only).
  const getCursorCharOffset = useCallback((): number => {
    const sel = window.getSelection();
    const editor = editorRef.current;
    if (!sel?.rangeCount || !editor) return 0;
    const range = sel.getRangeAt(0);
    const pre = document.createRange();
    try {
      pre.setStart(editor, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      return pre.toString().length;
    } catch {
      return 0;
    }
  }, []);

  // Moves cursor to the given character offset within the editor.
  const restoreCursorToOffset = useCallback((offset: number) => {
    const editor = editorRef.current;
    const sel = window.getSelection();
    if (!editor || !sel) return;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node as Text;
      if (remaining <= t.length) {
        const range = document.createRange();
        range.setStart(t, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        savedRangeRef.current = range.cloneRange();
        activeEditableRef.current = editor;
        return;
      }
      remaining -= t.length;
    }
    // Fallback: start of first paragraph
    const firstP = editor.querySelector<HTMLElement>(".pdf-page > p");
    if (firstP) {
      const range = document.createRange();
      const target = firstP.firstChild ?? firstP;
      range.setStart(target, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      savedRangeRef.current = range.cloneRange();
      activeEditableRef.current = editor;
    }
  }, []);

  const flushSnapshot = useCallback(() => {
    if (!editorRef.current) return;
    const hist = customHistoryRef.current;
    if (hist.debounceTimer) {
      clearTimeout(hist.debounceTimer);
      hist.debounceTimer = null;
    }
    const html = editorRef.current.innerHTML;
    if (hist.index >= 0 && hist.snapshots[hist.index].html === html) return;
    hist.snapshots = hist.snapshots.slice(0, hist.index + 1);
    if (hist.snapshots.length >= 100) hist.snapshots.shift();
    hist.snapshots.push({ html, cursorPos: getCursorCharOffset() });
    hist.index = hist.snapshots.length - 1;
  }, [getCursorCharOffset]);

  const scheduleSnapshot = useCallback(() => {
    const hist = customHistoryRef.current;
    if (hist.debounceTimer) clearTimeout(hist.debounceTimer);
    hist.debounceTimer = setTimeout(() => {
      hist.debounceTimer = null;
      flushSnapshot();
    }, UNDO_BATCH_MS);
  }, [flushSnapshot]);

  const applyFieldStylePreset = useCallback((style: PlaceholderFieldStyle, customized = true) => {
    fieldStylePresetCustomizedRef.current = customized;
    setFieldStylePreset(style);
  }, []);

  const applyCustomizedFieldStylePresetFromToolbar = useCallback((patch: Partial<ToolbarStyleState>) => {
    applyFieldStylePreset(getPlaceholderFieldStyleFromToolbar({ ...toolbarStyle, ...patch }), true);
  }, [applyFieldStylePreset, toolbarStyle]);

  const getEditorPages = useCallback(() => {
    return Array.from(editorRef.current?.querySelectorAll<HTMLElement>(".pdf-page") ?? []);
  }, []);

  const getDirectParagraphs = useCallback((page: HTMLElement) => {
    return Array.from(page.querySelectorAll<HTMLElement>(":scope > p"));
  }, []);

  const getPageBaseContentTop = useCallback((page: HTMLElement) => {
    const parsed = Number.parseFloat(page.dataset.baseContentTop || "");
    if (Number.isFinite(parsed)) {
      if (page.dataset.generatedOverflowPage === "true" && parsed > OVERFLOW_PAGE_CONTENT_TOP_THRESHOLD) {
        return 72;
      }
      return parsed;
    }
    return 72;
  }, []);

  const getPageContentBottom = useCallback((page: HTMLElement) => {
    const parsed = Number.parseFloat(page.dataset.baseContentBottom || "");
    if (Number.isFinite(parsed)) return parsed;

    const baseMinHeight = Number.parseFloat(page.dataset.baseMinHeight || page.style.minHeight || "0") || page.offsetHeight || 0;
    return getDefaultPageContentBottom(baseMinHeight, getPageBaseContentTop(page));
  }, [getPageBaseContentTop]);

  const ensureParagraphIdentity = useCallback((paragraph: HTMLElement, preferredLogicalId?: string | null) => {
    if (!paragraph.dataset.paragraphId) {
      paragraph.dataset.paragraphId = createTemplateDomId("para");
    }

    const logicalParagraphId = preferredLogicalId
      || paragraph.dataset.logicalParagraphId
      || paragraph.dataset.paragraphId
      || createTemplateDomId("logical");

    paragraph.dataset.logicalParagraphId = logicalParagraphId;

    return {
      paragraphId: paragraph.dataset.paragraphId,
      logicalParagraphId,
    };
  }, []);

  const getLinkedParagraphSegments = useCallback((paragraph?: HTMLElement | null) => {
    if (!paragraph) return [] as HTMLElement[];

    const existingLogicalId = paragraph.dataset.logicalParagraphId || "";
    if (existingLogicalId && editorRef.current) {
      const linked = Array.from(
        editorRef.current.querySelectorAll<HTMLElement>(
          `.pdf-page > p[data-logical-paragraph-id="${existingLogicalId}"]`
        )
      );
      if (linked.length > 0) return linked;
    }

    const page = paragraph.closest<HTMLElement>(".pdf-page");
    const flowGroup = paragraph.dataset.flowGroup || "";
    if (flowGroup && page) {
      return Array.from(page.querySelectorAll<HTMLElement>(`:scope > p[data-flow-group="${flowGroup}"]`));
    }

    const { logicalParagraphId } = ensureParagraphIdentity(paragraph);
    if (editorRef.current) {
      const linked = Array.from(
        editorRef.current.querySelectorAll<HTMLElement>(
          `.pdf-page > p[data-logical-paragraph-id="${logicalParagraphId}"]`
        )
      );
      if (linked.length > 0) return linked;
    }

    return [paragraph];
  }, [ensureParagraphIdentity]);

  const getLeadParagraphSegment = useCallback((paragraph?: HTMLElement | null) => {
    const segments = getLinkedParagraphSegments(paragraph);
    return segments[0] ?? paragraph ?? null;
  }, [getLinkedParagraphSegments]);

  const replaceLogicalParagraphId = useCallback((fromId?: string | null, toId?: string | null) => {
    if (!editorRef.current || !fromId || !toId || fromId === toId) return;

    editorRef.current
      .querySelectorAll<HTMLElement>(`.pdf-page > p[data-logical-paragraph-id="${fromId}"]`)
      .forEach((paragraph) => {
        paragraph.dataset.logicalParagraphId = toId;
      });
  }, []);

  const remapMergedSelectionSnapshot = useCallback((
    snapshot: SelectionSnapshot | null,
    targetParagraph: HTMLElement,
    sourceParagraph: HTMLElement,
    targetOffsetBase: number,
  ): SelectionSnapshot | null => {
    const targetParagraphId = targetParagraph.dataset.paragraphId;
    const sourceParagraphId = sourceParagraph.dataset.paragraphId;
    if (
      !snapshot ||
      snapshot.kind !== "paragraph" ||
      !targetParagraphId ||
      !sourceParagraphId ||
      snapshot.targetId !== sourceParagraphId
    ) {
      return snapshot;
    }

    return {
      kind: "paragraph",
      targetId: targetParagraphId,
      start: targetOffsetBase + snapshot.start,
      end: targetOffsetBase + snapshot.end,
    };
  }, []);

  const collapseLogicalParagraphSegments = useCallback((pages: HTMLElement[], snapshot: SelectionSnapshot | null) => {
    const paragraphs = pages.flatMap((page) => getDirectParagraphs(page));
    let nextSnapshot = snapshot;

    for (let index = 0; index < paragraphs.length; index += 1) {
      const head = paragraphs[index];
      const { logicalParagraphId } = ensureParagraphIdentity(head);
      if (!logicalParagraphId) continue;

      let headLength = getNodeTextLength(head);
      const lookahead = index + 1;
      while (lookahead < paragraphs.length) {
        const tail = paragraphs[lookahead];
        const tailLogicalId = ensureParagraphIdentity(tail).logicalParagraphId;
        if (tailLogicalId !== logicalParagraphId) break;

        // Pagination splits intentionally share a logical id across pages; merging them
        // would stuff all text into the first segment's DOM node and breaks reflow.
        const headPage = head.closest<HTMLElement>(".pdf-page");
        const tailPage = tail.closest<HTMLElement>(".pdf-page");
        if (!headPage || !tailPage || headPage !== tailPage) break;

        nextSnapshot = remapMergedSelectionSnapshot(nextSnapshot, head, tail, headLength);

        while (tail.firstChild) {
          head.appendChild(tail.firstChild);
        }

        head.dataset.baseHeight = "";
        head.dataset.wrapEnabled = "1";
        applyParagraphWrapStyles(head);
        if (head.style.width) {
          head.style.maxWidth = head.style.width;
        }

        tail.remove();
        paragraphs.splice(lookahead, 1);
        headLength = getNodeTextLength(head);
      }
    }

    return nextSnapshot;
  }, [ensureParagraphIdentity, getDirectParagraphs, remapMergedSelectionSnapshot]);

  const getSelectionSnapshot = useCallback((): SelectionSnapshot | null => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!container || !editorRef.current?.contains(container)) return null;

    const paragraph = container.closest<HTMLElement>(SEL_PAGE_P);
    if (paragraph?.dataset.paragraphId) {
      return {
        kind: "paragraph",
        targetId: paragraph.dataset.paragraphId,
        start: getOffsetWithinBlock(paragraph, range.startContainer, range.startOffset),
        end: getOffsetWithinBlock(paragraph, range.endContainer, range.endOffset),
      };
    }

    const textBoxEditor = container.closest<HTMLElement>("[data-template-text-box-editor]");
    const textBox = textBoxEditor?.closest<HTMLElement>("[data-template-text-box-id]");
    if (textBoxEditor && textBox?.dataset.templateTextBoxId) {
      return {
        kind: "textbox",
        targetId: textBox.dataset.templateTextBoxId,
        start: getOffsetWithinBlock(textBoxEditor, range.startContainer, range.startOffset),
        end: getOffsetWithinBlock(textBoxEditor, range.endContainer, range.endOffset),
      };
    }

    return null;
  }, []);

  const restoreSelectionSnapshot = useCallback((snapshot: SelectionSnapshot | null) => {
    if (!snapshot || !editorRef.current) return false;

    const block = snapshot.kind === "paragraph"
      ? editorRef.current.querySelector<HTMLElement>(`[data-paragraph-id="${snapshot.targetId}"]`)
      : editorRef.current
        .querySelector<HTMLElement>(`[data-template-text-box-id="${snapshot.targetId}"]`)
        ?.querySelector<HTMLElement>("[data-template-text-box-editor]");

    if (!block) return false;

    const startPosition = resolveOffsetWithinBlock(block, snapshot.start);
    const endPosition = resolveOffsetWithinBlock(block, snapshot.end);
    const selection = window.getSelection();
    if (!selection) return false;

    const range = document.createRange();
    range.setStart(startPosition.node, startPosition.offset);
    range.setEnd(endPosition.node, endPosition.offset);
    selection.removeAllRanges();
    selection.addRange(range);
    savedRangeRef.current = range.cloneRange();

    if (snapshot.kind === "textbox") {
      block.focus();
    }

    return true;
  }, []);

  const insertParagraphIntoPage = useCallback((page: HTMLElement, paragraph: HTMLElement) => {
    const anchorLikeChild = Array.from(page.children).find((child) => {
      const element = child as HTMLElement;
      return element.tagName === "A" || element.hasAttribute("data-template-text-box-id");
    });

    if (anchorLikeChild) {
      page.insertBefore(paragraph, anchorLikeChild);
      return;
    }

    page.appendChild(paragraph);
  }, []);

  const createOverflowPage = useCallback((referencePage: HTMLElement) => {
    const page = document.createElement("div");
    page.className = referencePage.className;
    page.style.cssText = referencePage.style.cssText;
    page.style.minHeight = `${Number.parseFloat(referencePage.dataset.baseMinHeight || referencePage.style.minHeight || "0") || referencePage.offsetHeight || 0}px`;
    page.dataset.pageIndex = String(getEditorPages().length);
    page.dataset.baseMinHeight = String(Number.parseFloat(referencePage.dataset.baseMinHeight || referencePage.style.minHeight || "0") || referencePage.offsetHeight || 0);
    const refContentTop = Number.parseFloat(referencePage.dataset.baseContentTop || "") || 72;
    page.dataset.baseContentTop =
      refContentTop > OVERFLOW_PAGE_CONTENT_TOP_THRESHOLD ? "72" : String(refContentTop);
    page.dataset.baseContentBottom = referencePage.dataset.baseContentBottom
      || String(getPageContentBottom(referencePage));
    if (referencePage.dataset.baseContentBottomSource) {
      page.dataset.baseContentBottomSource = referencePage.dataset.baseContentBottomSource;
    }
    if (referencePage.dataset.columnLeft) page.dataset.columnLeft = referencePage.dataset.columnLeft;
    if (referencePage.dataset.columnRight) page.dataset.columnRight = referencePage.dataset.columnRight;
    if (referencePage.dataset.columnWidth) page.dataset.columnWidth = referencePage.dataset.columnWidth;
    page.dataset.generatedOverflowPage = "true";
    referencePage.insertAdjacentElement("afterend", page);
    return page;
  }, [getEditorPages, getPageContentBottom]);

  const cloneBlockFragment = useCallback((root: HTMLElement, start: number, end: number) => {
    const range = document.createRange();
    const startPosition = resolveOffsetWithinBlock(root, start);
    const endPosition = resolveOffsetWithinBlock(root, end);
    range.setStart(startPosition.node, startPosition.offset);
    range.setEnd(endPosition.node, endPosition.offset);
    return range.cloneContents();
  }, []);

  const measureDetachedParagraphHeight = useCallback((paragraph: HTMLElement) => {
    const editor = editorRef.current;
    if (!editor) {
      return Number.parseFloat(paragraph.dataset.baseHeight || "0") || paragraph.offsetHeight || 0;
    }

    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;";
    const pWidth = Number.parseFloat(paragraph.style.width || "0");
    if (Number.isFinite(pWidth) && pWidth > 0) {
      host.style.width = `${pWidth}px`;
    }
    const clone = paragraph.cloneNode(true) as HTMLElement;
    // PDF <p> uses position:absolute + top; out of flow the host can measure 0 height, normalize for layout height.
    clone.style.position = "relative";
    clone.style.top = "0";
    clone.style.left = "0";
    clone.style.marginLeft = "0";
    host.appendChild(clone);
    editor.appendChild(host);
    const height = clone.offsetHeight || Number.parseFloat(clone.dataset.baseHeight || "0") || 0;
    editor.removeChild(host);
    return height;
  }, []);

  const ensureWrappingStyles = useCallback((p: HTMLElement, maxRightEdge?: number) => {
    // Expand narrow paragraphs so text wraps at the full column width.
    // maxRightEdge is the rightmost edge (left + width) of any paragraph on the
    // page. The available width for this paragraph = maxRightEdge - its own left.
    const page = p.closest<HTMLElement>(".pdf-page");
    const wrapRightEdge = page ? getPageColumnRightEdge(page) : (maxRightEdge || 0);
    if (wrapRightEdge > 0) {
      const pLeft = Number.parseFloat(p.style.left || p.style.marginLeft || "0");
      const targetWidth = wrapRightEdge - pLeft;
      const currentWidth = Number.parseFloat(p.style.width || "0");
      if (targetWidth > currentWidth) {
        p.style.width = `${targetWidth}px`;
      }
    }
    applyParagraphWrapStyles(p);
  }, []);

  const splitParagraphToFit = useCallback((paragraph: HTMLElement, availableHeight: number, maxRightEdge?: number) => {
    const totalLength = getNodeTextLength(paragraph);
    if (totalLength <= 1 || availableHeight <= 0) return null;

    // Ensure wrapping is enabled on the source paragraph before measuring.
    ensureWrappingStyles(paragraph, maxRightEdge);
    // Capture the resolved width from the source paragraph, this is the
    // authoritative width that all clones (test + tail) must use.
    const resolvedWidth = paragraph.style.width || "";

    let bestOffset = 0;
    let low = 1;
    let high = totalLength - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const testParagraph = paragraph.cloneNode(false) as HTMLElement;
      // Force the same width/wrapping on the test clone
      if (resolvedWidth) {
        testParagraph.style.width = resolvedWidth;
        testParagraph.style.maxWidth = resolvedWidth;
      }
      applyParagraphWrapStyles(testParagraph);
      testParagraph.appendChild(cloneBlockFragment(paragraph, 0, mid));
      const height = measureDetachedParagraphHeight(testParagraph);

      if (height <= availableHeight) {
        bestOffset = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const splitOffset = findPreferredSplitOffset(paragraph, bestOffset);
    if (splitOffset <= 0 || splitOffset >= totalLength) return null;

    const headFragment = cloneBlockFragment(paragraph, 0, splitOffset);
    const tailFragment = cloneBlockFragment(paragraph, splitOffset, totalLength);
    const headParagraph = paragraph;
    const tailParagraph = paragraph.cloneNode(false) as HTMLElement;
    headParagraph.replaceChildren(headFragment);
    tailParagraph.replaceChildren(tailFragment);

    if (!(tailParagraph.textContent || "").trim()) return null;

    const { logicalParagraphId } = ensureParagraphIdentity(headParagraph);
    tailParagraph.dataset.paragraphId = createTemplateDomId("para");
    tailParagraph.dataset.logicalParagraphId = logicalParagraphId;
    headParagraph.dataset.logicalParagraphId = logicalParagraphId;
    delete headParagraph.dataset.flowGroup;
    delete tailParagraph.dataset.flowGroup;
    headParagraph.dataset.wrapEnabled = "1";
    tailParagraph.dataset.wrapEnabled = "1";

    // Explicitly set width/wrapping on both halves
    for (const p of [headParagraph, tailParagraph]) {
      if (resolvedWidth) {
        p.style.width = resolvedWidth;
        p.style.maxWidth = resolvedWidth;
      }
      applyParagraphWrapStyles(p);
    }

    tailParagraph.dataset.baseGapBefore = "0";
    tailParagraph.dataset.baseHeight = "";
    headParagraph.dataset.baseHeight = "";

    if (paragraph.dataset.repeater) {
      tailParagraph.dataset.repeater = paragraph.dataset.repeater;
    }

    const headHeight = measureDetachedParagraphHeight(headParagraph);
    const tailHeight = measureDetachedParagraphHeight(tailParagraph);

    return { headParagraph, tailParagraph, headHeight, tailHeight };
  }, [cloneBlockFragment, ensureParagraphIdentity, ensureWrappingStyles, measureDetachedParagraphHeight]);

  const splitParagraphAtCursor = useCallback((paragraph: HTMLElement): { headParagraph: HTMLElement; tailParagraph: HTMLElement } | null => {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return null;

    const range = sel.getRangeAt(0);
    if (!range.collapsed) range.deleteContents();

    const cursorOffset = getOffsetWithinBlock(paragraph, range.startContainer, range.startOffset);
    const totalLength = getNodeTextLength(paragraph);

    const gap = defaultParagraphGap(paragraph);

    if (cursorOffset <= 0) {
      // Cursor at start: create empty <p> before
      const newP = paragraph.cloneNode(false) as HTMLElement;
      newP.appendChild(document.createElement("br"));
      newP.dataset.paragraphId = createTemplateDomId("para");
      newP.dataset.logicalParagraphId = createTemplateDomId("logical");
      newP.dataset.baseGapBefore = paragraph.dataset.baseGapBefore || "0";
      newP.dataset.baseTop = "";
      newP.dataset.baseHeight = "";
      newP.dataset.wrapEnabled = "1";
      applyParagraphWrapStyles(newP);

      paragraph.dataset.baseGapBefore = String(gap);
      ensureParagraphIdentity(paragraph);
      paragraph.dataset.logicalParagraphId = createTemplateDomId("logical");

      return { headParagraph: newP, tailParagraph: paragraph };
    }

    if (cursorOffset >= totalLength) {
      // Cursor at end: create empty <p> after
      const newP = paragraph.cloneNode(false) as HTMLElement;
      newP.appendChild(document.createElement("br"));
      newP.dataset.paragraphId = createTemplateDomId("para");
      newP.dataset.logicalParagraphId = createTemplateDomId("logical");
      newP.dataset.baseGapBefore = String(gap);
      newP.dataset.baseTop = "";
      newP.dataset.baseHeight = "";
      newP.dataset.wrapEnabled = "1";
      applyParagraphWrapStyles(newP);

      ensureParagraphIdentity(paragraph);

      return { headParagraph: paragraph, tailParagraph: newP };
    }

    // Split content at cursor
    const headFragment = cloneBlockFragment(paragraph, 0, cursorOffset);
    const tailFragment = cloneBlockFragment(paragraph, cursorOffset, totalLength);

    const headParagraph = paragraph;
    const tailParagraph = paragraph.cloneNode(false) as HTMLElement;

    headParagraph.replaceChildren(headFragment);
    tailParagraph.replaceChildren(tailFragment);

    if (!headParagraph.textContent?.trim() && !headParagraph.querySelector("br")) {
      headParagraph.appendChild(document.createElement("br"));
    }
    if (!tailParagraph.textContent?.trim() && !tailParagraph.querySelector("br")) {
      tailParagraph.appendChild(document.createElement("br"));
    }

    ensureParagraphIdentity(headParagraph);
    headParagraph.dataset.logicalParagraphId = headParagraph.dataset.paragraphId || createTemplateDomId("logical");
    headParagraph.dataset.baseHeight = "";
    headParagraph.dataset.wrapEnabled = "1";
    applyParagraphWrapStyles(headParagraph);

    tailParagraph.dataset.paragraphId = createTemplateDomId("para");
    tailParagraph.dataset.logicalParagraphId = tailParagraph.dataset.paragraphId;
    tailParagraph.dataset.baseGapBefore = String(gap);
    tailParagraph.dataset.baseTop = "";
    tailParagraph.dataset.baseHeight = "";
    tailParagraph.dataset.wrapEnabled = "1";
    applyParagraphWrapStyles(tailParagraph);

    // Preserve repeater attribute
    if (paragraph.dataset.repeater) {
      tailParagraph.dataset.repeater = paragraph.dataset.repeater;
    }

    return { headParagraph, tailParagraph };
  }, [cloneBlockFragment, ensureParagraphIdentity]);

  const repaginateFromPage = useCallback((startPage: HTMLElement) => {
    const allPages = getEditorPages();
    const startIndex = allPages.findIndex((page) => page === startPage);
    if (startIndex === -1) return;

    // Preserve scroll position, removing/re-inserting absolutely-positioned
    // paragraphs can cause the wrapper to jump.
    const wrapper = editorWrapperRef.current;
    const savedScrollTop = wrapper?.scrollTop ?? 0;
    const savedScrollLeft = wrapper?.scrollLeft ?? 0;

    const affectedPages = allPages.slice(startIndex);
    for (const page of affectedPages) {
      if (page.dataset.baseContentBottomSource === "manual") continue;
      const contentTop = Number.parseFloat(page.dataset.baseContentTop || "72") || 72;
      page.dataset.baseContentBottom = String(inferAutoPageContentBottom(page, contentTop));
      page.dataset.baseContentBottomSource = "auto";
    }

    let preservedSelection = getSelectionSnapshot();
    const paragraphEntries = affectedPages.flatMap((page) =>
      getDirectParagraphs(page).map((paragraph) => ({
        paragraph,
        height: paragraph.offsetHeight || Number.parseFloat(paragraph.dataset.baseHeight || "0") || 0,
      }))
    );

    // Compute the widest content right-edge across ALL pages BEFORE removing
    // paragraphs from the DOM. Used to expand narrow paragraphs during splitting.
    let maxContentWidth = 0;
    for (const page of allPages) {
      for (const p of getDirectParagraphs(page)) {
        const pLeft = Number.parseFloat(p.style.left || p.style.marginLeft || "0");
        const pW = Number.parseFloat(p.style.width || "0");
        const right = pLeft + pW;
        if (right > maxContentWidth) maxContentWidth = right;
      }
    }

    // Merge flow-group siblings and enable wrapping on ALL affected paragraphs
    // BEFORE removing them from the DOM. Unmerged PDF line fragments have tiny
    // widths (one line of text each), if they get pushed to another page
    // without merging, they render letter-by-letter.
    for (const page of affectedPages) {
      const processedGroups = new Set<string>();
      for (const p of getDirectParagraphs(page)) {
        if (!page.contains(p)) continue; // removed as a sibling during a prior merge

        const flowGroup = p.dataset.flowGroup || "";
        if (p.dataset.wrapEnabled && !flowGroup) {
          ensureParagraphIdentity(p);
          continue; // already merged & wrapped
        }

        const wrapRightEdge = getPageColumnRightEdge(page) || maxContentWidth;
        if (flowGroup) {
          if (processedGroups.has(flowGroup)) continue;
          processedGroups.add(flowGroup);

          // Always merge into the FIRST sibling in this flow-group
          const target = page.querySelector<HTMLElement>(`:scope > p[data-flow-group="${flowGroup}"]`) ?? p;
          const siblings = Array.from(
            page.querySelectorAll<HTMLElement>(`:scope > p[data-flow-group="${flowGroup}"]`)
          );
          const preferredLogicalId = target.dataset.logicalParagraphId
            || siblings.find((sibling) => sibling.dataset.logicalParagraphId)?.dataset.logicalParagraphId
            || target.dataset.paragraphId
            || createTemplateDomId("logical");
          const { logicalParagraphId } = ensureParagraphIdentity(target, preferredLogicalId);
          let mergeMaxWidth = Number.parseFloat(target.style.width || "0");
          let blockBottom =
            getParagraphLayoutTop(target) +
            Number.parseFloat(target.dataset.baseHeight || "0");
          const sibFontSize = Number.parseFloat(target.style.fontSize || "12");

          for (const sib of siblings) {
            ensureParagraphIdentity(sib, logicalParagraphId);
            if (sib === target) continue;
            mergeMaxWidth = Math.max(mergeMaxWidth, Number.parseFloat(sib.style.width || "0"));
            blockBottom = Math.max(
              blockBottom,
              getParagraphLayoutTop(sib) +
                Number.parseFloat(sib.dataset.baseHeight || "0")
            );

            const mergeOffset = getNodeTextLength(target) + 1;
            preservedSelection = remapMergedSelectionSnapshot(preservedSelection, target, sib, mergeOffset);

            target.append(document.createTextNode(" "));
            while (sib.firstChild) target.appendChild(sib.firstChild);
            sib.remove();
          }

          target.dataset.logicalParagraphId = logicalParagraphId;
          target.dataset.baseHeight = String(blockBottom - getParagraphLayoutTop(target));
          if (mergeMaxWidth > 0) target.style.width = `${mergeMaxWidth}px`;

          const totalBlockHeight = blockBottom - getParagraphLayoutTop(target);
          if (siblings.length >= 2 && sibFontSize > 0 && totalBlockHeight > 0) {
            const lineHeightRatio = totalBlockHeight / (siblings.length * sibFontSize);
            target.style.lineHeight = String(Math.max(1.0, Math.min(3.0, lineHeightRatio)));
          }
          target.dataset.paragraphMerged = "true";

          // Apply wrapping + width expansion on the merged target
          if (wrapRightEdge > 0) {
            const tLeft = Number.parseFloat(target.style.left || target.style.marginLeft || "0");
            const targetWidth = wrapRightEdge - tLeft;
            if (targetWidth > Number.parseFloat(target.style.width || "0")) {
              target.style.width = `${targetWidth}px`;
            }
          }
          preserveEditableGapSpans(target);
          applyParagraphWrapStyles(target);
          delete target.dataset.flowGroup;
          target.dataset.wrapEnabled = "1";
          continue; // target was processed; skip the per-p block below
        }

        // Non-flow-group paragraph: just expand width and apply wrapping
        ensureParagraphIdentity(p);
        preserveEditableGapSpans(p);
        if (wrapRightEdge > 0) {
          const pLeft = Number.parseFloat(p.style.left || p.style.marginLeft || "0");
          const targetWidth = wrapRightEdge - pLeft;
          const currentWidth = Number.parseFloat(p.style.width || "0");
          if (targetWidth > currentWidth) {
            p.style.width = `${targetWidth}px`;
          }
        }
        applyParagraphWrapStyles(p);
        delete p.dataset.flowGroup;
        p.dataset.wrapEnabled = "1";
      }
    }

    preservedSelection = collapseLogicalParagraphSegments(affectedPages, preservedSelection);

    // Re-collect paragraph entries after merging (merging removes siblings)
    const mergedEntries = affectedPages.flatMap((page) =>
      getDirectParagraphs(page).map((paragraph) => ({
        paragraph,
        height: paragraph.offsetHeight || Number.parseFloat(paragraph.dataset.baseHeight || "0") || 0,
      }))
    );
    paragraphEntries.length = 0;
    paragraphEntries.push(...mergedEntries);

    // Recompute maxContentWidth after merging (widths may have expanded)
    maxContentWidth = 0;
    for (const page of allPages) {
      for (const p of getDirectParagraphs(page)) {
        const pLeft = Number.parseFloat(p.style.left || p.style.marginLeft || "0");
        const pW = Number.parseFloat(p.style.width || "0");
        const right = pLeft + pW;
        if (right > maxContentWidth) maxContentWidth = right;
      }
    }

    for (const page of affectedPages) {
      page.style.minHeight = `${Number.parseFloat(page.dataset.baseMinHeight || "0") || page.offsetHeight || 0}px`;
      getDirectParagraphs(page).forEach((paragraph) => paragraph.remove());
    }

    if (paragraphEntries.length === 0) {
      return;
    }

    const pagesInFlow = [...affectedPages];
    let currentPageIndex = 0;
    let currentPage = pagesInFlow[currentPageIndex];
    let currentBottom = getPageBaseContentTop(currentPage);
    let isFirstParagraphOnPage = true;

    for (let entryIndex = 0; entryIndex < paragraphEntries.length; entryIndex += 1) {
      let { paragraph, height } = paragraphEntries[entryIndex];
      if (!Number.isFinite(height) || height < 4) {
        const fontSize = Number.parseFloat(paragraph.style.fontSize || "12") || 12;
        const lhRaw = paragraph.style.lineHeight || "1.2";
        const lhNum = Number.parseFloat(lhRaw);
        const linePx = Number.isFinite(lhNum)
          ? (String(lhRaw).trim().endsWith("px") ? lhNum : fontSize * lhNum)
          : fontSize * 1.2;
        height = Math.max(height || 0, Math.round(linePx));
      }
      let baseContentBottom = getPageContentBottom(currentPage);
      const fontSize = Number.parseFloat(paragraph.style.fontSize || "12") || 12;
      const rawGapBefore = isFirstParagraphOnPage
        ? 0
        : Math.max(0, Number.parseFloat(paragraph.dataset.baseGapBefore || "0") || 0);
      const maxInterParagraphGap = Math.max(40, fontSize * 5);
      const gapBefore = isFirstParagraphOnPage ? 0 : Math.min(rawGapBefore, maxInterParagraphGap);
      let nextTop = isFirstParagraphOnPage ? getPageBaseContentTop(currentPage) : currentBottom + gapBefore;

      if (!isFirstParagraphOnPage && nextTop + height > baseContentBottom) {
        // Try to split the paragraph first so part of it stays on this page.
        // Only bump the entire paragraph to the next page if the split fails
        // (e.g. not even one line fits in the remaining space).
        const remainingHeight = Math.max(0, baseContentBottom - nextTop);
        const split = remainingHeight > 0 ? splitParagraphToFit(paragraph, remainingHeight, maxContentWidth) : null;

        if (split) {
          // Remap cursor snapshot if it falls in the tail portion
          if (
            preservedSelection?.kind === "paragraph" &&
            preservedSelection.targetId === split.headParagraph.dataset.paragraphId
          ) {
            const headLen = getNodeTextLength(split.headParagraph);
            if (preservedSelection.start > headLen && split.tailParagraph.dataset.paragraphId) {
              const tailOffset = preservedSelection.start - headLen;
              preservedSelection = {
                kind: "paragraph",
                targetId: split.tailParagraph.dataset.paragraphId,
                start: tailOffset,
                end: Math.max(tailOffset, preservedSelection.end - headLen),
              };
            }
          }
          // Keep the head on the current page; tail will be processed next iteration
          paragraph = split.headParagraph;
          height = split.headHeight;
          paragraphEntries.splice(entryIndex + 1, 0, {
            paragraph: split.tailParagraph,
            height: split.tailHeight,
          });
        } else {
          // Split failed, move entire paragraph to next page
          currentPageIndex += 1;
          if (!pagesInFlow[currentPageIndex]) {
            const referencePage = pagesInFlow[currentPageIndex - 1] ?? currentPage;
            pagesInFlow.push(createOverflowPage(referencePage));
          }
          currentPage = pagesInFlow[currentPageIndex];
          currentPage.style.minHeight = `${Number.parseFloat(currentPage.dataset.baseMinHeight || "0") || currentPage.offsetHeight || 0}px`;
          currentBottom = getPageBaseContentTop(currentPage);
          isFirstParagraphOnPage = true;
          baseContentBottom = getPageContentBottom(currentPage);
          nextTop = getPageBaseContentTop(currentPage);
        }
      }

      // If the paragraph is STILL taller than the available space (e.g. it's
      // the first paragraph on a fresh page and spans more than one full page),
      // split it again.
      const availableHeight = Math.max(0, baseContentBottom - nextTop);
      if (height > availableHeight) {
        const split = splitParagraphToFit(paragraph, availableHeight, maxContentWidth);
        if (split) {
          if (
            preservedSelection?.kind === "paragraph" &&
            preservedSelection.targetId === split.headParagraph.dataset.paragraphId
          ) {
            const headLen = getNodeTextLength(split.headParagraph);
            if (preservedSelection.start > headLen && split.tailParagraph.dataset.paragraphId) {
              const tailOffset = preservedSelection.start - headLen;
              preservedSelection = {
                kind: "paragraph",
                targetId: split.tailParagraph.dataset.paragraphId,
                start: tailOffset,
                end: Math.max(tailOffset, preservedSelection.end - headLen),
              };
            }
          }
          paragraph = split.headParagraph;
          height = split.headHeight;
          paragraphEntries.splice(entryIndex + 1, 0, {
            paragraph: split.tailParagraph,
            height: split.tailHeight,
          });
        }
      }

      paragraph.style.top = `${nextTop}px`;
      paragraph.dataset.baseTop = String(nextTop);
      insertParagraphIntoPage(currentPage, paragraph);
      const laidOutHeight =
        paragraph.offsetHeight >= 4 ? paragraph.offsetHeight : height;
      paragraph.dataset.baseHeight = String(laidOutHeight);
      currentBottom = nextTop + laidOutHeight;
      isFirstParagraphOnPage = false;
    }

    for (let i = currentPageIndex + 1; i < pagesInFlow.length; i += 1) {
      pagesInFlow[i].style.minHeight = `${Number.parseFloat(pagesInFlow[i].dataset.baseMinHeight || "0") || pagesInFlow[i].offsetHeight || 0}px`;
    }

    // Refresh auto page footers using current paragraph geometry so a bad initial
    // footer band does not permanently cap body flow (huge blank on page 1, next block
    // pinned to the top of page 2).
    for (const page of getEditorPages()) {
      if (page.dataset.baseContentBottomSource === "manual") continue;
      const contentTop = Number.parseFloat(page.dataset.baseContentTop || "72") || 72;
      page.dataset.baseContentBottom = String(inferAutoPageContentBottom(page, contentTop));
      page.dataset.baseContentBottomSource = "auto";
    }

    restoreSelectionSnapshot(preservedSelection);

    if (editorRef.current) {
      syncTemplateImageStackingAfterReflow(editorRef.current);
    }

    // Restore scroll position to prevent visual jump
    if (wrapper) {
      wrapper.scrollTop = savedScrollTop;
      wrapper.scrollLeft = savedScrollLeft;
    }
  }, [collapseLogicalParagraphSegments, createOverflowPage, ensureParagraphIdentity, getDirectParagraphs, getEditorPages, getPageBaseContentTop, getPageContentBottom, getSelectionSnapshot, insertParagraphIntoPage, remapMergedSelectionSnapshot, restoreSelectionSnapshot, splitParagraphToFit]);

  const recomputePageLayout = useCallback((page: HTMLElement) => {
    repaginateFromPage(page);
  }, [repaginateFromPage]);

  const mergeContinuationParagraphs = useCallback((paragraph: HTMLElement) => {
    if (paragraph.dataset.paragraphMerged === "true") return;

    const baseTop = getParagraphLayoutTop(paragraph);
    const baseLeft = Number.parseFloat(paragraph.style.left || paragraph.style.marginLeft || "0");
    const baseFontSize = Number.parseFloat(paragraph.style.fontSize || "0");
    const flowGroup = paragraph.dataset.flowGroup || "";
    let maxWidth = Number.parseFloat(paragraph.style.width || "0");
    let lastTop = baseTop;
    let lastHeight = Number.parseFloat(paragraph.dataset.baseHeight || "0");
    let blockBottom = baseTop + lastHeight;

    let next = paragraph.nextElementSibling as HTMLElement | null;
    while (next && next.matches(".pdf-page > p")) {
      const nextTop = getParagraphLayoutTop(next);
      const nextHeight = Number.parseFloat(next.dataset.baseHeight || "0");
      const nextLeft = Number.parseFloat(next.style.left || next.style.marginLeft || "0");
      const nextWidth = Number.parseFloat(next.style.width || "0");
      const nextFontSize = Number.parseFloat(next.style.fontSize || "0");
      const nextGroup = next.dataset.flowGroup || "";
      const nextGapBefore = Math.max(0, Number.parseFloat(next.dataset.baseGapBefore || "0") || 0);

      const verticalGap = nextTop - (lastTop + lastHeight);
      const similarFont = Math.abs(nextFontSize - baseFontSize) <= 2;
      const similarLeft = Math.abs(nextLeft - baseLeft) <= Math.max(32, baseFontSize * 2);
      const continuationGap = verticalGap <= Math.max(10, baseFontSize * 0.55);
      const sameFlowGroup = Boolean(flowGroup && nextGroup && flowGroup === nextGroup);
      const continuationSpacing = nextGapBefore <= Math.max(8, baseFontSize * 0.45);

      if (!(similarFont && similarLeft && continuationGap && sameFlowGroup && continuationSpacing)) {
        break;
      }

      paragraph.append(document.createTextNode(" "));
      while (next.firstChild) {
        paragraph.appendChild(next.firstChild);
      }

      maxWidth = Math.max(maxWidth, nextWidth);
      blockBottom = Math.max(blockBottom, nextTop + nextHeight);
      lastTop = nextTop;
      lastHeight = nextHeight;

      const following = next.nextElementSibling as HTMLElement | null;
      next.remove();
      next = following;
    }

    paragraph.dataset.baseHeight = String(Math.max(blockBottom - baseTop, lastHeight));
    if (maxWidth > 0) {
      paragraph.style.width = `${maxWidth}px`;
    }
    paragraph.dataset.paragraphMerged = "true";
  }, []);

  const primePageLayoutMetadata = useCallback(() => {
    editorRef.current?.querySelectorAll<HTMLElement>(".pdf-page").forEach((page) => {
      page.style.userSelect = "none";
      if (!page.dataset.baseMinHeight) {
        page.dataset.baseMinHeight = String(Number.parseFloat(page.style.minHeight || "0") || page.offsetHeight || 0);
      }
      if (!page.dataset.columnRight) {
        const columnRight = getPageColumnRightEdge(page);
        if (columnRight > 0) {
          page.dataset.columnRight = String(columnRight);
        }
      }

      const paragraphs = page.querySelectorAll<HTMLElement>(":scope > p");
      const paragraphList = Array.from(paragraphs);
      const minTop = paragraphList.length > 0
        ? Math.min(...paragraphList.map((p) => Number.parseFloat(p.style.top || "0")))
        : 72;
      if (!page.dataset.baseContentTop) {
        page.dataset.baseContentTop = String(Math.max(0, minTop));
      }

      let previousBaseTop = 0;
      let previousBaseHeight = 0;
      paragraphList.forEach((p, index) => {
        p.style.userSelect = "text";
        if (!p.dataset.paragraphId) {
          p.dataset.paragraphId = `para_${Math.random().toString(36).slice(2, 10)}`;
        }
        const stTop = p.style.top?.trim();
        if (stTop && Number.isFinite(Number.parseFloat(stTop))) {
          p.dataset.baseTop = String(Number.parseFloat(stTop));
        } else if (!p.dataset.baseTop) {
          p.dataset.baseTop = String(Number.parseFloat(p.style.top || "0"));
        }
        if (!p.dataset.baseHeight) {
          p.dataset.baseHeight = String(p.offsetHeight || Number.parseFloat(p.style.lineHeight || "0") || 0);
        }
        if (!p.dataset.baseGapBefore) {
          const baseTop = getParagraphLayoutTop(p);
          const gapBefore = index === 0
            ? 0
            : Math.max(0, baseTop - (previousBaseTop + previousBaseHeight));
          p.dataset.baseGapBefore = String(gapBefore);
          previousBaseTop = baseTop;
          previousBaseHeight = Number.parseFloat(p.dataset.baseHeight || "0");
        } else {
          previousBaseTop = getParagraphLayoutTop(p);
          previousBaseHeight = Number.parseFloat(p.dataset.baseHeight || "0");
        }
      });

      if (page.dataset.baseContentBottomSource !== "manual") {
        const contentTop = Number.parseFloat(page.dataset.baseContentTop || "72") || 72;
        page.dataset.baseContentBottom = String(inferAutoPageContentBottom(page, contentTop));
        page.dataset.baseContentBottomSource = "auto";
      }
    });
  }, []);

  const syncActiveParagraphMetrics = useCallback((paragraph?: HTMLElement | null) => {
    const p = paragraph ?? (activeParagraphId
      ? editorRef.current?.querySelector<HTMLElement>(`[data-paragraph-id="${activeParagraphId}"]`) ?? null
      : null);

    if (!p) {
      setActiveParagraphMetrics(null);
      return;
    }

    const page = p.closest<HTMLElement>(".pdf-page");
    if (!page) {
      setActiveParagraphMetrics(null);
      return;
    }

    const groupParagraphs = getLinkedParagraphSegments(p);

    const paragraphBounds = groupParagraphs.map(getParagraphHorizontalBounds);
    let left = Math.min(...paragraphBounds.map((bounds) => bounds.left));
    let right = Math.max(...paragraphBounds.map((bounds) => bounds.right));
    const currentPageWidth = Number.parseFloat(page.style.width || String(page.offsetWidth || 0));

    const selectedBounds = {
      left,
      right,
      width: Math.max(0, right - left),
      center: left + ((right - left) / 2),
    };

    // If the selected paragraph is narrower than the rest of its text column
    // (e.g. a bullet or short final line), expand the ruler to the widest
    // sibling in the same horizontal cluster. Keep split headers/side blocks
    // isolated so the ruler doesn't jump to another column.
    const usesManualRulerBounds = groupParagraphs.some((paragraphEl) => paragraphEl.dataset.manualRulerBounds === "1");
    if (!usesManualRulerBounds) {
      const allPageParagraphs = Array.from(page.querySelectorAll<HTMLElement>(":scope > p"));
      let widestLeft = left;
      let widestRight = right;
      for (const sibling of allPageParagraphs) {
        const siblingBounds = getParagraphHorizontalBounds(sibling);
        if (!sharesRulerColumn(selectedBounds, siblingBounds)) {
          continue;
        }

        const sibLeft = siblingBounds.left;
        const sibRight = siblingBounds.right;
        if (sibRight - sibLeft > widestRight - widestLeft) {
          widestLeft = sibLeft;
          widestRight = sibRight;
        }
      }
      // Expand the ruler display to the widest column when the selected paragraph is narrow.
      // Don't touch the DOM here, DOM changes on click cause scroll jumps and cursor
      // misplacement. Width expansion for typing is handled in enableWrappingOnP instead.
      if (widestRight - widestLeft > right - left) {
        left = widestLeft;
        right = widestRight;
      }
    }

    setActiveParagraphMetrics({
      id: p.dataset.paragraphId || "",
      left,
      width: Math.max(40, right - left),
      pageWidth: currentPageWidth,
    });
  }, [activeParagraphId, getLinkedParagraphSegments]);

  const reconnectContinuationFromLead = useCallback((paragraph?: HTMLElement | null) => {
    if (!paragraph) return;

    const leadParagraph = getLeadParagraphSegment(paragraph);
    const currentPage = paragraph.closest<HTMLElement>(".pdf-page");
    const leadPage = leadParagraph?.closest<HTMLElement>(".pdf-page");
    if (!leadParagraph || !currentPage || !leadPage) return;

    if (leadParagraph === paragraph && leadPage === currentPage) return;

    recomputePageLayout(leadPage);
    syncActiveParagraphMetrics(paragraph);
  }, [getLeadParagraphSegment, recomputePageLayout, syncActiveParagraphMetrics]);

  const getSelectionElement = useCallback(() => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);

    let raw: HTMLElement | null = getFirstMeaningfulTextParentInRange(range);
    const startLeaf = getRangeStartLeafForToolbar(range);
    if (!raw) {
      const fallback = startLeaf instanceof HTMLElement ? startLeaf : startLeaf.parentElement;
      raw = fallback instanceof HTMLElement ? fallback : null;
    }

    // When the cursor sits on a ZWS caret-target or a gap span directly
    // inside a <p>, the computed style reflects the paragraph's default
    // font instead of the actual content's font.  Walk forward to the
    // nearest styled content node so the toolbar picks up the right font.
    if (raw && raw.matches(".pdf-page p, [data-pdf-gap], [data-template-text-box-editor]")) {
      const anchor = startLeaf;
      const isZws = anchor.nodeType === Node.TEXT_NODE
        && anchor.textContent?.replace(/\u200B/g, "").trim() === "";
      const isGap = anchor instanceof Element && anchor.hasAttribute("data-pdf-gap");
      if (isZws || isGap) {
        const isStyledNode = (n: Node): HTMLElement | null => {
          if (n.nodeType === Node.TEXT_NODE && n.textContent?.replace(/\u200B/g, "").trim()) {
            return n.parentElement;
          }
          if (n instanceof HTMLElement) {
            if (n.hasAttribute("data-pdf-gap")) return null;
            if (n.textContent?.replace(/\u200B/g, "").trim()) return n;
          }
          return null;
        };
        // Search forward first, then backward
        let sibling: Node | null = anchor.nextSibling;
        while (sibling) {
          const found = isStyledNode(sibling);
          if (found) return found;
          sibling = sibling.nextSibling;
        }
        sibling = anchor.previousSibling;
        while (sibling) {
          const found = isStyledNode(sibling);
          if (found) return found;
          sibling = sibling.previousSibling;
        }
      }
    }

    return raw;
  }, []);

  const getActiveEditable = useCallback(() => {
    const selectionNode = getSelectionElement();
    const editor = editorRef.current;
    if (!selectionNode || !editor) return activeEditableRef.current;

    const editable = selectionNode.closest<HTMLElement>('[contenteditable="true"]');
    if (!editable || !editor.contains(editable)) return activeEditableRef.current;
    return editable;
  }, [getSelectionElement]);

  const saveCurrentRange = useCallback(() => {
    const selection = window.getSelection();
    const editor = editorRef.current;
    if (!selection?.rangeCount || !editor) return;

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!container || !editor.contains(container)) return;

    savedRangeRef.current = range.cloneRange();
    activeEditableRef.current = getActiveEditable();
  }, [getActiveEditable]);

  const restoreSavedRange = useCallback(() => {
    if (!savedRangeRef.current) return false;
    const selection = window.getSelection();
    if (!selection) return false;

    focusTemplateEditable(activeEditableRef.current);
    selection.removeAllRanges();
    selection.addRange(savedRangeRef.current);
    return true;
  }, []);

  const placeCaretInParagraph = useCallback((paragraph: HTMLElement, clientX: number, clientY: number) => {
    const selection = window.getSelection();
    if (!selection) return false;

    let nextRange: Range | null = null;
    const docWithCaretApis = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };

    const assignIfInsideParagraph = (node: Node | null | undefined, offset: number) => {
      const element = node instanceof Element ? node : node?.parentElement;
      if (!node || !element || !paragraph.contains(element)) return false;
      const range = document.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      nextRange = range;
      return true;
    };

    if (typeof docWithCaretApis.caretPositionFromPoint === "function") {
      const position = docWithCaretApis.caretPositionFromPoint(clientX, clientY);
      assignIfInsideParagraph(position?.offsetNode, position?.offset ?? 0);
    }

    if (!nextRange && typeof docWithCaretApis.caretRangeFromPoint === "function") {
      const range = docWithCaretApis.caretRangeFromPoint(clientX, clientY);
      const element = range?.startContainer instanceof Element
        ? range.startContainer
        : range?.startContainer.parentElement;
      if (range && element && paragraph.contains(element)) {
        nextRange = range.cloneRange();
      }
    }

    // When the click is outside the paragraph bounds (e.g. left margin),
    // retry the browser caret APIs using the paragraph's nearest edge so they
    // resolve to the correct wrapped line instead of failing.
    if (!nextRange) {
      const paragraphRect = paragraph.getBoundingClientRect();
      const clampedX = Math.max(paragraphRect.left + 1, Math.min(clientX, paragraphRect.right - 1));
      const clampedY = Math.max(paragraphRect.top + 1, Math.min(clientY, paragraphRect.bottom - 1));
      if (clampedX !== clientX || clampedY !== clientY) {
        if (typeof docWithCaretApis.caretPositionFromPoint === "function") {
          const position = docWithCaretApis.caretPositionFromPoint(clampedX, clampedY);
          assignIfInsideParagraph(position?.offsetNode, position?.offset ?? 0);
        }
        if (!nextRange && typeof docWithCaretApis.caretRangeFromPoint === "function") {
          const range = docWithCaretApis.caretRangeFromPoint(clampedX, clampedY);
          const element = range?.startContainer instanceof Element
            ? range.startContainer
            : range?.startContainer.parentElement;
          if (range && element && paragraph.contains(element)) {
            nextRange = range.cloneRange();
          }
        }
      }
    }

    if (!nextRange) {
      const position = resolveOffsetWithinBlock(paragraph, clientX <= paragraph.getBoundingClientRect().left
        ? 0
        : getNodeTextLength(paragraph));
      const range = document.createRange();
      range.setStart(position.node, position.offset);
      range.collapse(true);
      nextRange = range;
    }

    // If the resolved caret position landed inside a contentEditable="false"
    // chip, redirect it to the ZWS text node on the nearest side of that chip.
    // We keep the browser's resolution (rather than rejecting it) so we stay
    // on the correct wrapped line.
    const resolvedNode = nextRange.startContainer;
    const resolvedElement = resolvedNode instanceof Element ? resolvedNode : resolvedNode.parentElement;
    const insideChip = resolvedElement?.closest<HTMLElement>("[data-placeholder-chip]") ?? null;

    if (insideChip) {
      const chipRect = insideChip.getBoundingClientRect();
      const side = clientX <= chipRect.left + chipRect.width / 2 ? "before" : "after";
      if (side === "before") {
        if (!insideChip.previousSibling || insideChip.previousSibling.nodeType !== Node.TEXT_NODE) {
          insideChip.parentNode?.insertBefore(document.createTextNode("\u200B"), insideChip);
        }
        if (insideChip.previousSibling?.nodeType === Node.TEXT_NODE) {
          nextRange = document.createRange();
          nextRange.setStart(insideChip.previousSibling, insideChip.previousSibling.textContent?.length ?? 0);
          nextRange.collapse(true);
        }
      } else {
        if (!insideChip.nextSibling || insideChip.nextSibling.nodeType !== Node.TEXT_NODE) {
          insideChip.parentNode?.insertBefore(document.createTextNode("\u200B"), insideChip.nextSibling);
        }
        if (insideChip.nextSibling?.nodeType === Node.TEXT_NODE) {
          nextRange = document.createRange();
          nextRange.setStart(insideChip.nextSibling, 0);
          nextRange.collapse(true);
        }
      }
    } else if (resolvedNode.nodeType === Node.ELEMENT_NODE) {
      // Normalize element-level positions ({<p>, N}) into text-node-level
      // positions for reliable caret rendering.
      const caretOffset = nextRange.startOffset;
      const child = resolvedNode.childNodes[caretOffset];
      const prev = caretOffset > 0 ? resolvedNode.childNodes[caretOffset - 1] : null;

      if (child instanceof HTMLElement && child.hasAttribute("data-placeholder-chip")) {
        if (!child.previousSibling || child.previousSibling.nodeType !== Node.TEXT_NODE) {
          child.parentNode?.insertBefore(document.createTextNode("\u200B"), child);
        }
        if (child.previousSibling?.nodeType === Node.TEXT_NODE) {
          nextRange = document.createRange();
          nextRange.setStart(child.previousSibling, child.previousSibling.textContent?.length ?? 0);
          nextRange.collapse(true);
        }
      } else if (child?.nodeType === Node.TEXT_NODE) {
        nextRange = document.createRange();
        nextRange.setStart(child, 0);
        nextRange.collapse(true);
      } else if (prev instanceof HTMLElement && prev.hasAttribute("data-placeholder-chip")) {
        if (!prev.nextSibling || prev.nextSibling.nodeType !== Node.TEXT_NODE) {
          prev.parentNode?.insertBefore(document.createTextNode("\u200B"), prev.nextSibling);
        }
        if (prev.nextSibling?.nodeType === Node.TEXT_NODE) {
          nextRange = document.createRange();
          nextRange.setStart(prev.nextSibling, 0);
          nextRange.collapse(true);
        }
      } else if (prev?.nodeType === Node.TEXT_NODE) {
        nextRange = document.createRange();
        nextRange.setStart(prev, prev.textContent?.length ?? 0);
        nextRange.collapse(true);
      }
    }

    editorRef.current?.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(nextRange);
    savedRangeRef.current = nextRange.cloneRange();
    activeEditableRef.current = editorRef.current;
    return true;
  }, []);

  // Track the currently selected chip via a ref so that selectChipElement
  // never performs synchronous DOM mutations (which can trigger spurious
  // selectionchange events inside the contenteditable area).
  const selectedChipRef = useRef<HTMLElement | null>(null);

  const selectChipElement = useCallback((chip: HTMLElement | null) => {
    selectedChipRef.current = chip;
    setSelectedChipVersion((v) => v + 1);
  }, []);

  const getSelectedPlaceholderChip = useCallback(() => {
    return selectedChipRef.current;
  }, []);

  const getSelectedTextBox = useCallback(() => {
    if (!selectedTextBoxId || !editorRef.current) return null;
    return editorRef.current.querySelector<HTMLElement>(`[data-template-text-box-id="${selectedTextBoxId}"]`);
  }, [selectedTextBoxId]);

  const getImageObjectById = useCallback((imageObjectId?: string | null) => {
    if (!imageObjectId || !editorRef.current) return null;
    return editorRef.current.querySelector<HTMLElement>(`[data-template-image-object-id="${imageObjectId}"]`);
  }, []);

  const getImageObjectAtPoint = useCallback((clientX: number, clientY: number, options?: { includeBehindText?: boolean }) => {
    const editor = editorRef.current;
    if (!editor) return null;
    const includeBehindText = Boolean(options?.includeBehindText);

    const objects = Array.from(editor.querySelectorAll<HTMLElement>(TEMPLATE_IMAGE_OBJECT_SELECTOR));
    const candidates = objects
      .filter((object) => {
        if (!includeBehindText && object.dataset.templateImageBehindText === "true") return false;
        const rect = object.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
      })
      .sort((left, right) => {
        const leftZ = Number.parseFloat(left.style.zIndex || "0") || 0;
        const rightZ = Number.parseFloat(right.style.zIndex || "0") || 0;
        if (leftZ !== rightZ) return rightZ - leftZ;

        const leftPriority = Number.parseInt(left.dataset.templateImagePriority || "0", 10) || 0;
        const rightPriority = Number.parseInt(right.dataset.templateImagePriority || "0", 10) || 0;
        return rightPriority - leftPriority;
      });

    return candidates[0] ?? null;
  }, []);

  const getFieldStyleAtRange = useCallback((range?: Range | null) => {
    const editor = editorRef.current;
    const container = range?.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range?.commonAncestorContainer.parentElement;

    if (!container || !editor?.contains(container)) {
      return fieldStylePreset;
    }

    const source = container instanceof HTMLElement
      ? container
      : container.closest<HTMLElement>(`${SEL_PAGE_P}, [data-template-text-box-editor]`);

    return getPlaceholderFieldStyleFromElement(source ?? editor);
  }, [fieldStylePreset]);

  const getNextFieldStyle = useCallback(() => {
    const selectedChip = getSelectedPlaceholderChip();
    if (selectedChip) {
      return getPlaceholderFieldStyleFromElement(selectedChip);
    }

    // When replacing a highlight, read style from the highlighted content
    // (the original styled nodes) rather than the stale saved range.
    const highlight = pendingHighlightRef.current;
    if (highlight && editorRef.current?.contains(highlight)) {
      const styledChild = highlight.querySelector<HTMLElement>("span, b, i, u, em, strong")
        ?? (highlight.firstElementChild as HTMLElement | null);
      if (styledChild) {
        return getPlaceholderFieldStyleFromElement(styledChild);
      }
      const parentEl = highlight.parentElement;
      if (parentEl) {
        return getPlaceholderFieldStyleFromElement(parentEl);
      }
    }

    // Match the surrounding text style at the cursor position
    const selection = window.getSelection();
    const liveRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
    return getFieldStyleAtRange(savedRangeRef.current ?? liveRange);
  }, [getFieldStyleAtRange, getSelectedPlaceholderChip]);

  const getPageAtClientPoint = useCallback((clientX: number, clientY: number) => {
    const editor = editorRef.current;
    if (!editor) return null;

    return Array.from(editor.querySelectorAll<HTMLElement>(".pdf-page")).find((page) => {
      const rect = page.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }) ?? null;
  }, []);

  const getNearestParagraphOnPage = useCallback((page: HTMLElement, clientX: number, clientY: number) => {
    const paragraphs = getDirectParagraphs(page);
    if (paragraphs.length === 0) return null;

    let bestParagraph: HTMLElement | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    // First pass: find paragraphs whose vertical extent contains the click Y.
    // Among those, pick the one closest horizontally. This ensures margin clicks
    // land on the line at the same vertical position rather than a horizontally
    // closer line on a different row.
    for (const paragraph of paragraphs) {
      const rect = paragraph.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        const dx = clientX < rect.left
          ? rect.left - clientX
          : clientX > rect.right
            ? clientX - rect.right
            : 0;
        if (dx < bestDistance) {
          bestDistance = dx;
          bestParagraph = paragraph;
        }
      }
    }
    if (bestParagraph) return bestParagraph;

    // Second pass: no vertical overlap, pick by smallest vertical distance,
    // breaking ties by horizontal distance.
    for (const paragraph of paragraphs) {
      const rect = paragraph.getBoundingClientRect();
      const dx = clientX < rect.left
        ? rect.left - clientX
        : clientX > rect.right
          ? clientX - rect.right
          : 0;
      const dy = clientY < rect.top
        ? rect.top - clientY
        : clientY > rect.bottom
          ? clientY - rect.bottom
          : 0;
      const distance = dy * 1000 + dx;

      if (distance < bestDistance) {
        bestDistance = distance;
        bestParagraph = paragraph;
      }
    }

    return bestParagraph;
  }, [getDirectParagraphs]);

  const syncActivePage = useCallback((page?: HTMLElement | null) => {
    const nextPage = page ?? getEditorPages()[0] ?? null;
    if (!nextPage) {
      setPageHeight(0);
      setPageContentBottom(0);
      setActivePageOffsetTop(0);
      setActivePageNumber(1);
      return;
    }

    const nextPageHeight = Number.parseFloat(nextPage.dataset.baseMinHeight || nextPage.style.minHeight || "0")
      || nextPage.offsetHeight
      || 0;
    const parsedPageIndex = Number.parseInt(nextPage.dataset.pageIndex || "", 10);
    const wrapper = editorWrapperRef.current;
    const wrapperRect = wrapper?.getBoundingClientRect();
    const pageRect = nextPage.getBoundingClientRect();
    const nextOffsetTop = wrapper && wrapperRect
      ? pageRect.top - wrapperRect.top + wrapper.scrollTop
      : nextPage.offsetTop;

    setPageHeight(nextPageHeight);
    setPageContentTop(getPageBaseContentTop(nextPage));
    setPageContentBottom(getPageContentBottom(nextPage));
    setActivePageOffsetTop(nextOffsetTop);
    setActivePageNumber(Number.isFinite(parsedPageIndex) ? parsedPageIndex + 1 : 1);
  }, [getEditorPages, getPageBaseContentTop, getPageContentBottom]);

  const getActiveParagraph = useCallback(() => {
    if (!activeParagraphId || !editorRef.current) return null;
    return editorRef.current.querySelector<HTMLElement>(`[data-paragraph-id="${activeParagraphId}"]`);
  }, [activeParagraphId]);

  const getToolbarContextElement = useCallback(() => {
    const selectedPlaceholderChip = getSelectedPlaceholderChip();
    if (selectedPlaceholderChip) return selectedPlaceholderChip;

    const selectedTextBoxEditor = getSelectedTextBox()?.querySelector<HTMLElement>("[data-template-text-box-editor]");
    if (selectedTextBoxEditor) return selectedTextBoxEditor;

    const editor = editorRef.current;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (sel?.rangeCount && editor) {
      const r = sel.getRangeAt(0);
      const n = r.commonAncestorContainer;
      const host = n instanceof Element ? n : n.parentElement;
      if (host && editor.contains(host)) {
        const pFromRange = host.closest<HTMLElement>(SEL_PAGE_P);
        if (pFromRange) return pFromRange;
      }
    }

    const paragraph = getActiveParagraph();
    if (paragraph) return paragraph;

    return getActiveEditable();
  }, [getActiveEditable, getActiveParagraph, getSelectedPlaceholderChip, getSelectedTextBox]);

  const syncToolbarStyle = useCallback(() => {
    const fallbackEl = getToolbarContextElement();
    const selectionElement = getSelectionElement();
    const selectedPlaceholderChip = getSelectedPlaceholderChip();

    if (!fallbackEl) {
      setToolbarStyle(DEFAULT_TOOLBAR_STYLE);
      return;
    }

    setToolbarStyle(getToolbarStyleFromElement(fallbackEl, selectedPlaceholderChip ?? selectionElement));
  }, [getSelectedPlaceholderChip, getSelectionElement, getToolbarContextElement]);

  const applyTextBoxSelectionVisual = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    editor.querySelectorAll<HTMLElement>("[data-template-text-box-id]").forEach((box) => {
      const isSelected = box.getAttribute("data-template-text-box-id") === selectedTextBoxId;
      box.style.outline = isSelected ? "2px solid rgba(79,70,229,0.55)" : "none";
      box.style.boxShadow = isSelected ? "0 0 0 1px rgba(99,102,241,0.15)" : "none";
      box.querySelectorAll<HTMLElement>("[data-template-text-box-control]").forEach((control) => {
        control.style.display = isSelected ? "flex" : "none";
      });
    });
  }, [selectedTextBoxId]);

  const applyImageObjectSelectionVisual = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    editor.querySelectorAll<HTMLElement>(TEMPLATE_IMAGE_OBJECT_SELECTOR).forEach((object) => {
      const isSelected = object.getAttribute("data-template-image-object-id") === selectedImageObjectId;
      object.style.outline = isSelected ? "2px solid rgba(14,165,233,0.6)" : "none";
      object.style.boxShadow = isSelected ? "0 0 0 1px rgba(56,189,248,0.18)" : "none";
      object.querySelectorAll<HTMLElement>("[data-template-image-control]").forEach((control) => {
        control.style.display = isSelected ? "flex" : "none";
      });
      syncTemplateImageLayerMenuState(object);
      if (!isSelected) {
        const layerMenu = object.querySelector<HTMLElement>("[data-template-image-layer-menu]");
        const layerTrigger = object.querySelector<HTMLElement>("[data-template-image-layer-trigger]");
        if (layerMenu) layerMenu.style.display = "none";
        layerTrigger?.setAttribute("aria-expanded", "false");
      }
    });
    applyTemplateImageZOrderForEditor(editor);
    if (selectedImageObjectId) {
      const selectedObject = editor.querySelector<HTMLElement>(`[data-template-image-object-id="${selectedImageObjectId}"]`);
      if (selectedObject) {
        const layerMenu = selectedObject.querySelector<HTMLElement>("[data-template-image-layer-menu]");
        selectedObject.style.zIndex = layerMenu?.style.display === "flex" ? "14" : "12";
      }
    }
  }, [selectedImageObjectId]);

  const applyPlaceholderSelectionVisual = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const selectedChip = selectedChipRef.current;
    editor.querySelectorAll<HTMLElement>("[data-placeholder-chip]").forEach((chip) => {
      const isSelected = chip === selectedChip;
      if (isSelected) {
        chip.setAttribute("data-placeholder-chip-selected", "true");
        chip.style.outline = "2px solid rgba(79,70,229,0.55)";
        chip.style.boxShadow = "0 0 0 1px rgba(99,102,241,0.18)";
        chip.style.borderRadius = "4px";
      } else {
        chip.removeAttribute("data-placeholder-chip-selected");
        chip.style.outline = "none";
        chip.style.boxShadow = "none";
      }
    });
  }, [selectedChipVersion]);

  const replaceFontTags = useCallback((editable: HTMLElement, callback: (font: HTMLElement, span: HTMLSpanElement) => void) => {
    editable.querySelectorAll("font").forEach((fontNode) => {
      const font = fontNode as HTMLElement;
      const span = document.createElement("span");
      callback(font, span);
      while (font.firstChild) span.appendChild(font.firstChild);
      font.parentNode?.replaceChild(span, font);
    });
  }, []);

  const applySelectedPlaceholderChipMutation = useCallback((mutator: (chip: HTMLElement) => void) => {
    const chip = getSelectedPlaceholderChip();
    if (!chip) return false;

    flushSnapshot();
    mutator(chip);
    applyFieldStylePreset(getPlaceholderFieldStyleFromElement(chip), true);
    setToolbarStyle(getToolbarStyleFromElement(chip, chip));
    scheduleSnapshot();
    return true;
  }, [applyFieldStylePreset, flushSnapshot, getSelectedPlaceholderChip, scheduleSnapshot]);

  const runTextCommand = useCallback((command: "bold" | "italic" | "underline" | "fontName" | "fontSize" | "foreColor", value?: string) => {
    const activeEditable = getActiveEditable() ?? getSelectedTextBox()?.querySelector<HTMLElement>("[data-template-text-box-editor]");
    if (!activeEditable) return;

    flushSnapshot();
    restoreSavedRange();
    focusTemplateEditable(activeEditable);
    // fontName / fontSize rely on legacy <font> tags so we can find and replace
    // the marker face/size with real CSS on a <span>. With styleWithCSS true,
    // browsers emit inline styles instead and the marker cleanup never runs.
    const useLegacyFontTags = command === "fontName" || command === "fontSize";
    document.execCommand("styleWithCSS", false, useLegacyFontTags ? "false" : "true");
    document.execCommand(command, false, value);

    if (command === "foreColor" && value) {
      replaceFontTags(activeEditable, (font, span) => {
        span.style.color = font.getAttribute("color") || value;
      });
    }

    saveCurrentRange();
    syncToolbarStyle();
  }, [flushSnapshot, getActiveEditable, getSelectedTextBox, replaceFontTags, restoreSavedRange, saveCurrentRange, syncToolbarStyle]);

  const selectTextBox = useCallback((box: HTMLElement | null, focusEditor = false) => {
    const nextId = box?.getAttribute("data-template-text-box-id") ?? null;
    setSelectedTextBoxId(nextId);
    selectChipElement(null);
    setActiveParagraphId(null);
    setActiveParagraphMetrics(null);
    if (!box) return;

    const innerEditor = box.querySelector<HTMLElement>("[data-template-text-box-editor]");
    if (innerEditor) {
      activeEditableRef.current = innerEditor;
      if (focusEditor) focusTemplateEditable(innerEditor);
    }
  }, [selectChipElement]);

  const hydrateTextBox = useCallback((box: HTMLElement) => {
    if (box.dataset.templateTextBoxHydrated === "true") return;
    box.dataset.templateTextBoxHydrated = "true";
    box.setAttribute("contenteditable", "false");
    box.style.position = "absolute";
    box.style.zIndex = "8";
    box.style.overflow = "visible";
    box.style.minWidth = "80px";
    box.style.minHeight = "28px";

    let innerEditor = box.querySelector<HTMLElement>("[data-template-text-box-editor]");
    if (!innerEditor) {
      innerEditor = document.createElement("div");
      innerEditor.setAttribute("data-template-text-box-editor", "true");
      innerEditor.innerHTML = box.innerHTML;
      box.innerHTML = "";
      box.appendChild(innerEditor);
    }

    innerEditor.setAttribute("contenteditable", "true");
    innerEditor.spellcheck = true;
    innerEditor.style.width = "100%";
    innerEditor.style.height = "100%";
    innerEditor.style.minHeight = "28px";
    innerEditor.style.padding = "4px 6px";
    innerEditor.style.whiteSpace = "pre-wrap";
    innerEditor.style.wordBreak = "break-word";
    innerEditor.style.outline = "none";
    innerEditor.style.background = "transparent";
    innerEditor.style.cursor = "text";
    if (!innerEditor.style.fontFamily) innerEditor.style.fontFamily = getFontCss(DEFAULT_TOOLBAR_STYLE.fontFamily);
    if (!innerEditor.style.fontSize) innerEditor.style.fontSize = `${DEFAULT_TOOLBAR_STYLE.fontSize}px`;
    if (!innerEditor.style.lineHeight) innerEditor.style.lineHeight = DEFAULT_TOOLBAR_STYLE.lineHeight;
    if (!innerEditor.style.color) innerEditor.style.color = DEFAULT_TOOLBAR_STYLE.color;

    const ensureControl = (selector: string, creator: () => HTMLElement) => {
      let control = box.querySelector<HTMLElement>(selector);
      if (!control) {
        control = creator();
        box.appendChild(control);
      }
      control.setAttribute("data-template-text-box-control", "true");
      control.style.display = "none";
      return control;
    };

    const dragHandle = ensureControl('[data-template-text-box-drag]', () => {
      const handle = document.createElement("button");
      handle.type = "button";
      handle.setAttribute("data-template-text-box-drag", "true");
      handle.setAttribute("aria-label", "Move text box");
      handle.title = "Move text box";
      handle.textContent = "⋮⋮";
      handle.style.cssText = "position:absolute;top:-30px;left:0;width:24px;height:24px;border:none;border-radius:999px;background:#4f46e5;color:#fff;font-size:12px;font-weight:700;letter-spacing:-1px;align-items:center;justify-content:center;cursor:grab;box-shadow:0 8px 20px rgba(79,70,229,0.25);";
      return handle;
    });

    const deleteButton = ensureControl('[data-template-text-box-delete]', () => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-template-text-box-delete", "true");
      button.textContent = "Delete";
      button.style.cssText = "position:absolute;top:-28px;right:0;height:22px;padding:0 8px;border:none;border-radius:999px;background:#dc2626;color:#fff;font-size:11px;font-weight:600;align-items:center;justify-content:center;cursor:pointer;";
      return button;
    });

    const resizeHandle = ensureControl('[data-template-text-box-resize]', () => {
      const handle = document.createElement("div");
      handle.setAttribute("data-template-text-box-resize", "true");
      handle.style.cssText = "position:absolute;right:-8px;bottom:-8px;width:16px;height:16px;border-radius:4px;background:#4f46e5;border:2px solid #fff;box-shadow:0 4px 12px rgba(79,70,229,0.35);cursor:se-resize;z-index:2;touch-action:none;";
      return handle;
    });

    box.addEventListener("mousedown", (event) => {
      event.stopPropagation();
      selectTextBox(box);
    });

    innerEditor.addEventListener("focus", () => {
      selectTextBox(box);
      syncToolbarStyle();
    });
    innerEditor.addEventListener("mouseup", () => {
      saveCurrentRange();
      syncToolbarStyle();
    });
    innerEditor.addEventListener("keyup", () => {
      saveCurrentRange();
      syncToolbarStyle();
    });
    innerEditor.addEventListener("input", () => {
      saveCurrentRange();
      syncToolbarStyle();
    });

    deleteButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const boxId = box.getAttribute("data-template-text-box-id");
      setSelectedTextBoxId((current) => current === boxId ? null : current);
      box.remove();
      syncToolbarStyle();
    });

    dragHandle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectTextBox(box);
      textBoxDragActiveRef.current = true;
      let didMove = false;
      let currentPage = box.closest<HTMLElement>(".pdf-page");
      if (!currentPage) {
        textBoxDragActiveRef.current = false;
        return;
      }
      const currentZoom = Math.max(zoomLevelRef.current, 0.01);
      const boxRect = box.getBoundingClientRect();
      const offsetX = (event.clientX - boxRect.left) / currentZoom;
      const offsetY = (event.clientY - boxRect.top) / currentZoom;

      const onMove = (moveEvent: MouseEvent) => {
        didMove = true;
        const hoveredPage = getPageAtClientPoint(moveEvent.clientX, moveEvent.clientY);
        if (hoveredPage && hoveredPage !== currentPage) {
          hoveredPage.appendChild(box);
          currentPage = hoveredPage;
        }

        if (!currentPage) return;
        const liveBoxRect = box.getBoundingClientRect();
        const pageRect = currentPage.getBoundingClientRect();
        const zoom = Math.max(zoomLevelRef.current, 0.01);
        const pageWidth = pageRect.width / zoom;
        const pageHeight = pageRect.height / zoom;
        const boxWidth = liveBoxRect.width / zoom;
        const boxHeight = liveBoxRect.height / zoom;
        const pointerX = (moveEvent.clientX - pageRect.left) / zoom;
        const pointerY = (moveEvent.clientY - pageRect.top) / zoom;
        const nextLeft = Math.max(0, Math.min(pageWidth - boxWidth, pointerX - offsetX));
        const nextTop = Math.max(0, Math.min(pageHeight - boxHeight, pointerY - offsetY));
        box.style.left = `${nextLeft}px`;
        box.style.top = `${nextTop}px`;
      };

      const onUp = () => {
        textBoxDragActiveRef.current = false;
        if (didMove) {
          scheduleSnapshot();
          suppressNextTextBoxClickRef.current = true;
          requestAnimationFrame(() => {
            suppressNextTextBoxClickRef.current = false;
          });
        }
        selectTextBox(box);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });

    resizeHandle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectTextBox(box);
      textBoxDragActiveRef.current = true;
      const zoom = Math.max(zoomLevelRef.current, 0.01);
      const startRect = box.getBoundingClientRect();
      const startWidth = startRect.width / zoom;
      const startHeight = startRect.height / zoom;
      const startX = event.clientX;
      const startY = event.clientY;
      const page = box.closest<HTMLElement>(".pdf-page");
      const pageRect = page?.getBoundingClientRect() ?? null;
      const boxLeft = Number.parseFloat(box.style.left || "0");
      const boxTop = Number.parseFloat(box.style.top || "0");
      let didResize = false;
      const previousUserSelect = document.body.style.userSelect;
      const previousCursor = document.body.style.cursor;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "se-resize";

      const onMove = (moveEvent: MouseEvent) => {
        const liveZoom = Math.max(zoomLevelRef.current, 0.01);
        const maxWidth = pageRect ? Math.max(80, pageRect.width / liveZoom - boxLeft) : Number.POSITIVE_INFINITY;
        const maxHeight = pageRect ? Math.max(32, pageRect.height / liveZoom - boxTop) : Number.POSITIVE_INFINITY;
        const nextWidth = Math.min(maxWidth, Math.max(80, startWidth + (moveEvent.clientX - startX) / liveZoom));
        const nextHeight = Math.min(maxHeight, Math.max(32, startHeight + (moveEvent.clientY - startY) / liveZoom));
        box.style.width = `${nextWidth}px`;
        box.style.height = `${nextHeight}px`;
        didResize = true;
      };

      const onUp = () => {
        textBoxDragActiveRef.current = false;
        document.body.style.userSelect = previousUserSelect;
        document.body.style.cursor = previousCursor;
        if (didResize) {
          suppressNextTextBoxClickRef.current = true;
          scheduleSnapshot();
          requestAnimationFrame(() => {
            suppressNextTextBoxClickRef.current = false;
          });
        }
        syncToolbarStyle();
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }, [getPageAtClientPoint, saveCurrentRange, scheduleSnapshot, selectTextBox, syncToolbarStyle]);

  const hydrateTextBoxes = useCallback(() => {
    editorRef.current?.querySelectorAll<HTMLElement>("[data-template-text-box-id]").forEach((box) => hydrateTextBox(box));
  }, [hydrateTextBox]);

  const createTextBoxAt = useCallback((page: HTMLElement, left: number, top: number) => {
    const box = document.createElement("div");
    box.setAttribute("data-template-text-box-id", `textbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${TEMPLATE_TEXTBOX_WIDTH}px`;
    box.style.height = `${TEMPLATE_TEXTBOX_HEIGHT}px`;

    const inner = document.createElement("div");
    inner.setAttribute("data-template-text-box-editor", "true");
    inner.innerHTML = "";
    box.appendChild(inner);
    page.appendChild(box);
    hydrateTextBox(box);
    selectTextBox(box, true);

    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(inner);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      savedRangeRef.current = range.cloneRange();
    }
    syncToolbarStyle();
  }, [hydrateTextBox, selectTextBox, syncToolbarStyle]);

  const selectImageObject = useCallback((object: HTMLElement | null) => {
    const nextId = object?.getAttribute("data-template-image-object-id") ?? null;
    setSelectedImageObjectId(nextId);
    setSelectedTextBoxId(null);
    selectChipElement(null);
    setActiveParagraphId(null);
    setActiveParagraphMetrics(null);
  }, [selectChipElement]);

  const migratePageBackgroundImages = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    editor.querySelectorAll<HTMLElement>(".pdf-page").forEach((page, pageIndex) => {
      const backgroundImages = Array.from(
        page.querySelectorAll<HTMLImageElement>(`:scope > ${TEMPLATE_PAGE_BACKGROUND_SELECTOR}`)
      );
      backgroundImages.forEach((image, imageIndex) => {
        migratePageBackgroundImageToTemplateObject(page, image, pageIndex, imageIndex);
      });
    });
  }, []);

  const hydrateImageObjectSrc = useCallback((object: HTMLElement) => {
    const img = getTemplateImageElement(object);
    if (!img) return;
    const assetId = img.dataset.templateAssetId;
    if (assetId) {
      const asset = templateAssets.find((a) => a.id === assetId);
      const previewUrl = asset?.previewUrl ?? null;
      if (previewUrl && !(img.getAttribute("src") || "").startsWith("data:")) {
        img.src = previewUrl;
      }
    }
    const applyLayout = () => { syncTemplateImageIntrinsicSize(object); };
    if (img.complete) {
      applyLayout();
    } else {
      img.addEventListener("load", applyLayout, { once: true });
    }
    applyTemplateImageObjectLayout(object);
  }, [templateAssets]);

  const hydrateImageObject = useCallback((object: HTMLElement) => {
    if (object.dataset.templateImageHydrated === "true") {
      object.querySelectorAll("[data-template-image-drag]").forEach((el) => el.remove());
      syncTemplateImageLayerMenuState(object);
      hydrateImageObjectSrc(object);
      return;
    }

    object.dataset.templateImageHydrated = "true";
    object.setAttribute("contenteditable", "false");
    migrateLegacyTemplateImageLayer(object);
    object.style.position = "absolute";
    object.style.overflow = "visible";
    object.style.minWidth = "24px";
    object.style.minHeight = "24px";
    object.style.cursor = "grab";

    hydrateImageObjectSrc(object);

    const ensureControl = (selector: string, creator: () => HTMLElement) => {
      let control = object.querySelector<HTMLElement>(selector);
      if (!control) {
        control = creator();
        object.appendChild(control);
      }
      control.setAttribute("data-template-image-control", "true");
      control.style.display = "none";
      return control;
    };

    const cropButton = ensureControl('[data-template-image-crop]', () => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-template-image-crop", "true");
      button.textContent = "Crop";
      button.style.cssText = "position:absolute;top:-28px;right:54px;height:22px;padding:0 8px;border:none;border-radius:999px;background:#0284c7;color:#fff;font-size:11px;font-weight:600;align-items:center;justify-content:center;cursor:pointer;";
      return button;
    });

    const layerButton = ensureControl('[data-template-image-layer-trigger]', () => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-template-image-layer-trigger", "true");
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      button.textContent = "Layer";
      button.style.cssText = "position:absolute;top:-28px;right:108px;height:22px;padding:0 10px;border:none;border-radius:999px;background:#0f172a;color:#fff;font-size:11px;font-weight:600;align-items:center;justify-content:center;cursor:pointer;";
      return button;
    });

    const deleteButton = ensureControl('[data-template-image-delete]', () => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-template-image-delete", "true");
      button.textContent = "Delete";
      button.style.cssText = "position:absolute;top:-28px;right:0;height:22px;padding:0 8px;border:none;border-radius:999px;background:#dc2626;color:#fff;font-size:11px;font-weight:600;align-items:center;justify-content:center;cursor:pointer;";
      return button;
    });

    const resizeHandle = ensureControl('[data-template-image-resize]', () => {
      const handle = document.createElement("div");
      handle.setAttribute("data-template-image-resize", "true");
      handle.style.cssText = "position:absolute;right:-8px;bottom:-8px;width:16px;height:16px;border-radius:4px;background:#0ea5e9;border:2px solid #fff;box-shadow:0 4px 12px rgba(14,165,233,0.35);cursor:se-resize;z-index:2;touch-action:none;";
      return handle;
    });

    let layerMenu = object.querySelector<HTMLElement>("[data-template-image-layer-menu]");
    if (!layerMenu) {
      layerMenu = document.createElement("div");
      layerMenu.setAttribute("data-template-image-layer-menu", "true");
      layerMenu.setAttribute("role", "menu");
      layerMenu.style.cssText = "position:absolute;top:0;right:108px;display:none;min-width:158px;flex-direction:column;gap:2px;padding:6px;border:1px solid rgba(15,23,42,0.12);border-radius:10px;background:rgba(255,255,255,0.98);box-shadow:0 18px 40px rgba(15,23,42,0.18);backdrop-filter:blur(8px);z-index:24;";

      const createLayerActionButton = (action: string, label: string) => {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("data-template-image-layer-action", action);
        button.setAttribute("role", "menuitem");
        button.textContent = label;
        button.style.cssText = "display:flex;align-items:center;justify-content:flex-start;width:100%;padding:7px 10px;border:none;border-radius:8px;background:transparent;color:#0f172a;font-size:12px;font-weight:600;cursor:pointer;text-align:left;";
        button.addEventListener("mouseenter", () => {
          if (!button.disabled) button.style.background = "rgba(14,165,233,0.12)";
        });
        button.addEventListener("mouseleave", () => {
          button.style.background = "transparent";
        });
        layerMenu?.appendChild(button);
        return button;
      };

      createLayerActionButton("all-back", "All the way back");
      createLayerActionButton("back-one", "Back one");
      createLayerActionButton("up-one", "Up one");
      createLayerActionButton("all-up", "All the way up");

      const menuSeparator = document.createElement("div");
      menuSeparator.style.cssText = "height:1px;background:rgba(15,23,42,0.1);margin:4px 2px;";
      layerMenu.appendChild(menuSeparator);
      createLayerActionButton("pin-background", "Pin as background");
      object.appendChild(layerMenu);
    }

    const hideLayerMenu = () => {
      layerMenu.style.display = "none";
      layerButton.setAttribute("aria-expanded", "false");
    };

    const showLayerMenu = () => {
      const editor = editorRef.current;
      if (editor) closeTemplateImageLayerMenus(editor);
      syncTemplateImageLayerMenuState(object);
      layerMenu.style.display = "flex";
      layerButton.setAttribute("aria-expanded", "true");
    };

    const runLayerAction = (mutate: (page: HTMLElement, imageObject: HTMLElement) => boolean) => {
      const editor = editorRef.current;
      const page = object.closest<HTMLElement>(".pdf-page");
      if (!editor || !page) return;
      selectImageObject(object);
      if (!mutate(page, object)) return;
      hideLayerMenu();
      closeTemplateImageLayerMenus(editor);
      flushSnapshot();
      applyTemplateImageZOrderForEditor(editor);
      syncTemplateImageLayerMenuState(object);
      scheduleSnapshot();
      setImageLayerTick((tick) => tick + 1);
    };

    object.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (textBoxModeRef.current) return;
      const t = event.target;
      if (t instanceof Element && t.closest("[data-template-image-crop], [data-template-image-delete], [data-template-image-resize], [data-template-image-layer-trigger], [data-template-image-layer-menu]")) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      selectImageObject(object);
      hideLayerMenu();
      textBoxDragActiveRef.current = true;
      let didMove = false;
      let currentPage = object.closest<HTMLElement>(".pdf-page");
      if (!currentPage) {
        textBoxDragActiveRef.current = false;
        return;
      }

      const currentZoom = Math.max(zoomLevelRef.current, 0.01);
      const objectRect = object.getBoundingClientRect();
      const offsetX = (event.clientX - objectRect.left) / currentZoom;
      const offsetY = (event.clientY - objectRect.top) / currentZoom;
      const previousBodyCursor = document.body.style.cursor;
      document.body.style.cursor = "grabbing";

      const onMove = (moveEvent: MouseEvent) => {
        didMove = true;
        const hoveredPage = getPageAtClientPoint(moveEvent.clientX, moveEvent.clientY);
        if (hoveredPage && hoveredPage !== currentPage) {
          hoveredPage.appendChild(object);
          currentPage = hoveredPage;
        }

        if (!currentPage) return;
        const liveRect = object.getBoundingClientRect();
        const pageRect = currentPage.getBoundingClientRect();
        const zoom = Math.max(zoomLevelRef.current, 0.01);
        const pageWidth = pageRect.width / zoom;
        const pageHeight = pageRect.height / zoom;
        const objectWidth = liveRect.width / zoom;
        const objectHeight = liveRect.height / zoom;
        const pointerX = (moveEvent.clientX - pageRect.left) / zoom;
        const pointerY = (moveEvent.clientY - pageRect.top) / zoom;
        // Allow partial off-page placement so users can intentionally crop by viewport.
        // Keep a small sliver visible to avoid losing the image completely.
        const minVisible = 24;
        const minLeft = -objectWidth + minVisible;
        const maxLeft = pageWidth - minVisible;
        const minTop = -objectHeight + minVisible;
        const maxTop = pageHeight - minVisible;
        const nextLeft = Math.max(minLeft, Math.min(maxLeft, pointerX - offsetX));
        const nextTop = Math.max(minTop, Math.min(maxTop, pointerY - offsetY));
        object.style.left = `${nextLeft}px`;
        object.style.top = `${nextTop}px`;
      };

      const onUp = () => {
        textBoxDragActiveRef.current = false;
        document.body.style.cursor = previousBodyCursor;
        if (didMove) {
          scheduleSnapshot();
          suppressNextTextBoxClickRef.current = true;
          requestAnimationFrame(() => {
            suppressNextTextBoxClickRef.current = false;
          });
        }
        selectImageObject(object);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });

    deleteButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideLayerMenu();
      const objectId = object.getAttribute("data-template-image-object-id");
      setSelectedImageObjectId((current) => current === objectId ? null : current);
      object.remove();
      const ed = editorRef.current;
      if (ed) applyTemplateImageZOrderForEditor(ed);
      scheduleSnapshot();
      setImageLayerTick((t) => t + 1);
    });

    cropButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideLayerMenu();
      selectImageObject(object);
      setCropTargetImageId(object.getAttribute("data-template-image-object-id"));
    });

    layerButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectImageObject(object);
      if (layerMenu.style.display === "flex") {
        hideLayerMenu();
      } else {
        showLayerMenu();
      }
    });

    const layerActions: Array<{
      selector: string;
      handler: () => void;
    }> = [
      {
        selector: '[data-template-image-layer-action="all-back"]',
        handler: () => runLayerAction((page, imageObject) => moveImageToStackIndex(page, imageObject, 0)),
      },
      {
        selector: '[data-template-image-layer-action="back-one"]',
        handler: () => runLayerAction((page, imageObject) => moveImageInStack(page, imageObject, -1)),
      },
      {
        selector: '[data-template-image-layer-action="up-one"]',
        handler: () => runLayerAction((page, imageObject) => moveImageInStack(page, imageObject, 1)),
      },
      {
        selector: '[data-template-image-layer-action="all-up"]',
        handler: () => runLayerAction((page, imageObject) => {
          const totalImages = sortTemplateImagesOnPage(page).length;
          return moveImageToStackIndex(page, imageObject, totalImages - 1);
        }),
      },
    ];

    layerActions.forEach(({ selector, handler }) => {
      const button = layerMenu.querySelector<HTMLButtonElement>(selector);
      button?.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        hideLayerMenu();
        selectImageObject(object);
        handler();
      });
    });

    // Pin-as-background toggle, separate from layer stack actions
    const pinActionButton = layerMenu.querySelector<HTMLButtonElement>('[data-template-image-layer-action="pin-background"]');
    pinActionButton?.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideLayerMenu();
      const isPinned = object.dataset.templateImagePinned === "true";
      if (isPinned) {
        delete object.dataset.templateImagePinned;
      } else {
        object.dataset.templateImagePinned = "true";
      }
      scheduleSnapshot();
    });

    resizeHandle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideLayerMenu();
      selectImageObject(object);
      textBoxDragActiveRef.current = true;

      const zoom = Math.max(zoomLevelRef.current, 0.01);
      const startRect = object.getBoundingClientRect();
      const startWidth = startRect.width / zoom;
      const startHeight = startRect.height / zoom;
      const startX = event.clientX;
      const startY = event.clientY;
      const page = object.closest<HTMLElement>(".pdf-page");
      const pageRect = page?.getBoundingClientRect() ?? null;
      const objectLeft = Number.parseFloat(object.style.left || "0");
      const objectTop = Number.parseFloat(object.style.top || "0");
      let didResize = false;
      const previousUserSelect = document.body.style.userSelect;
      const previousCursor = document.body.style.cursor;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "se-resize";

      const onMove = (moveEvent: MouseEvent) => {
        const liveZoom = Math.max(zoomLevelRef.current, 0.01);
        const maxWidth = pageRect ? Math.max(24, pageRect.width / liveZoom - objectLeft) : Number.POSITIVE_INFINITY;
        const maxHeight = pageRect ? Math.max(24, pageRect.height / liveZoom - objectTop) : Number.POSITIVE_INFINITY;
        const nextWidth = Math.min(maxWidth, Math.max(24, startWidth + (moveEvent.clientX - startX) / liveZoom));
        const nextHeight = Math.min(maxHeight, Math.max(24, startHeight + (moveEvent.clientY - startY) / liveZoom));
        object.style.width = `${nextWidth}px`;
        object.style.height = `${nextHeight}px`;
        applyTemplateImageObjectLayout(object);
        didResize = true;
      };

      const onUp = () => {
        textBoxDragActiveRef.current = false;
        document.body.style.userSelect = previousUserSelect;
        document.body.style.cursor = previousCursor;
        if (didResize) {
          scheduleSnapshot();
          suppressNextTextBoxClickRef.current = true;
          requestAnimationFrame(() => {
            suppressNextTextBoxClickRef.current = false;
          });
        }
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
    syncTemplateImageLayerMenuState(object);
  }, [flushSnapshot, getPageAtClientPoint, hydrateImageObjectSrc, scheduleSnapshot, selectImageObject, templateAssets]);

  const hydrateImageObjects = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    migratePageBackgroundImages();
    editor.querySelectorAll<HTMLElement>(TEMPLATE_IMAGE_OBJECT_SELECTOR).forEach((object) => {
      hydrateImageObject(object);
    });
    editor.querySelectorAll<HTMLElement>(".pdf-page").forEach((pageEl) => {
      normalizeTemplateImagePrioritiesOnPage(pageEl);
    });
    applyTemplateImageZOrderForEditor(editor);
  }, [hydrateImageObject, migratePageBackgroundImages]);

  const createImageObjectAt = useCallback((page: HTMLElement, config: {
    left: number;
    top: number;
    width: number;
    height: number;
    src: string;
    fileName?: string | null;
    intrinsicWidth: number;
    intrinsicHeight: number;
    source?: string | null;
  }) => {
    const object = createTemplateImageObjectElement(document, config);
    page.appendChild(object);
    hydrateImageObject(object);
    normalizeTemplateImagePrioritiesOnPage(page);
    const editor = editorRef.current;
    if (editor) applyTemplateImageZOrderForEditor(editor);
    selectImageObject(object);
    scheduleSnapshot();
    setImageLayerTick((t) => t + 1);
  }, [hydrateImageObject, scheduleSnapshot, selectImageObject]);

  const insertImageFromFile = useCallback(async (file: File) => {
    const editor = editorRef.current;
    if (!editor || !IMAGE_MIME_ALLOWLIST.includes(file.type)) {
      setError("Please choose a PNG, JPEG, WEBP, or GIF image.");
      return;
    }

    try {
      const src = await readFileAsDataUrl(file);
      const { width: intrinsicWidth, height: intrinsicHeight } = await loadImageDimensions(src);
      const pages = getEditorPages();
      const activePage = pages.find((page) => {
        const pageIndex = Number.parseInt(page.dataset.pageIndex || "", 10);
        return Number.isFinite(pageIndex) && pageIndex + 1 === activePageNumber;
      }) ?? pages[0];
      if (!activePage) {
        setError("No page is available to place this image.");
        return;
      }

      const pageWidthValue = Number.parseFloat(activePage.style.width || "0") || activePage.offsetWidth || intrinsicWidth;
      const pageHeightValue = Number.parseFloat(activePage.style.minHeight || "0") || activePage.offsetHeight || intrinsicHeight;
      const maxWidth = Math.max(120, Math.min(pageWidthValue * 0.42, intrinsicWidth));
      const scale = maxWidth / Math.max(intrinsicWidth, 1);
      const displayWidth = Math.max(48, Math.round(intrinsicWidth * scale));
      const displayHeight = Math.max(48, Math.round(intrinsicHeight * scale));
      const left = Math.max(0, Math.min(pageWidthValue - displayWidth, (pageWidthValue - displayWidth) / 2));
      const top = Math.max(pageContentTop, Math.min(pageHeightValue - displayHeight - 24, pageContentTop + 24));

      createImageObjectAt(activePage, {
        left,
        top,
        width: displayWidth,
        height: displayHeight,
        src,
        fileName: file.name,
        intrinsicWidth,
        intrinsicHeight,
        source: "manual-upload",
      });
      setError(null);
      syncActivePage(activePage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to insert image.");
    }
  }, [activePageNumber, createImageObjectAt, getEditorPages, pageContentTop, syncActivePage]);

  useEffect(() => {
    applyTextBoxSelectionVisual();
  }, [applyTextBoxSelectionVisual]);

  useEffect(() => {
    applyImageObjectSelectionVisual();
  }, [applyImageObjectSelectionVisual, imageLayerTick]);

  useEffect(() => {
    applyPlaceholderSelectionVisual();
  }, [applyPlaceholderSelectionVisual]);

  useEffect(() => {
    if (phase !== "editor") return;
    hydrateImageObjects();
  }, [hydrateImageObjects, phase, templateAssets]);

  useEffect(() => {
    if (!activeParagraphId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs DOM-measured paragraph metrics to state when the active paragraph changes; not derivable during render.
      setActiveParagraphMetrics(null);
      return;
    }
    syncActiveParagraphMetrics();
  }, [activeParagraphId, syncActiveParagraphMetrics]);

  useEffect(() => {
    if (phase !== "editor") return;

    const activePage = getEditorPages().find((page) => {
      const pageIndex = Number.parseInt(page.dataset.pageIndex || "", 10);
      return Number.isFinite(pageIndex) && pageIndex + 1 === activePageNumber;
    });

    if (activePage) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs state from the live editor DOM page element after pagination; not derivable during render.
      syncActivePage(activePage);
    }
  }, [activePageNumber, getEditorPages, phase, syncActivePage, zoomLevel]);

  useEffect(() => {
    if (phase !== "editor") return;

    const onSelectionChange = () => {
      if (textBoxDragActiveRef.current) return;
      const editor = editorRef.current;
      const selectionNode = getSelectionElement();
      if (!editor || !selectionNode || !editor.contains(selectionNode)) return;

      const selectedChip = selectionNode.closest<HTMLElement>("[data-placeholder-chip]");
      if (selectedChip) {
        selectChipElement(selectedChip);
        setSelectedTextBoxId(selectedChip.closest<HTMLElement>("[data-template-text-box-id]")?.dataset.templateTextBoxId ?? null);
        const paragraph = selectedChip.closest<HTMLElement>(SEL_PAGE_P);
        setActiveParagraphId(paragraph?.dataset.paragraphId ?? null);
        syncActiveParagraphMetrics(paragraph);
        syncActivePage(selectedChip.closest<HTMLElement>(".pdf-page"));
        setToolbarStyle(getToolbarStyleFromElement(selectedChip, selectedChip));
        return;
      }

      selectChipElement(null);
      saveCurrentRange();
      syncToolbarStyle();

      const textBox = selectionNode.closest<HTMLElement>("[data-template-text-box-id]");
      if (textBox) {
        setSelectedTextBoxId(textBox.getAttribute("data-template-text-box-id"));
        setActiveParagraphId(null);
        setActiveParagraphMetrics(null);
        syncActivePage(textBox.closest<HTMLElement>(".pdf-page"));
      } else {
        setSelectedTextBoxId(null);
        const paragraph = selectionNode.closest<HTMLElement>(SEL_PAGE_P);
        const paragraphId = paragraph?.dataset.paragraphId ?? null;
        setActiveParagraphId(paragraphId);
        syncActiveParagraphMetrics(paragraph);
        syncActivePage(paragraph?.closest<HTMLElement>(".pdf-page"));
      }
    };

    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [getSelectionElement, phase, saveCurrentRange, selectChipElement, syncActivePage, syncActiveParagraphMetrics, syncToolbarStyle]);

  // ─── Re-scan DOM for chip names and repeater blocks ───────────
  const scanChipNames = useCallback(() => {
    const els = editorRef.current?.querySelectorAll("[data-placeholder-chip]") ?? [];
    const seen = new Set<string>();
    const names: string[] = [];
    for (const el of els) {
      const n = el.getAttribute("data-placeholder-chip") ?? "";
      if (n && !seen.has(n)) { seen.add(n); names.push(n); }
    }
    setChipNames(names);

    const repEls = editorRef.current?.querySelectorAll<HTMLElement>("[data-repeater]") ?? [];
    const repSeen = new Set<string>();
    const reps: string[] = [];
    for (const el of repEls) {
      const n = el.getAttribute("data-repeater") ?? "";
      if (n && !repSeen.has(n)) { repSeen.add(n); reps.push(n); }
    }
    setRepeaterNames(reps);
  }, []);

  // ─── Repeater helpers ─────────────────────────────────────────
  const REPEATER_BORDER_STYLE = "3px dashed rgba(99,102,241,0.45)";
  const REPEATER_BG_STYLE = "rgba(99,102,241,0.04)";

  const insertRepeaterLabel = useCallback((p: HTMLElement, name: string) => {
    if (p.querySelector("[data-repeater-label]")) return;
    const label = document.createElement("span");
    label.setAttribute("data-repeater-label", "true");
    label.setAttribute("contentEditable", "false");
    label.style.cssText =
      "display:inline-block;font-size:9px;color:#6366f1;background:#eef2ff;padding:1px 6px;border-radius:3px;margin-right:6px;vertical-align:baseline;user-select:none;cursor:default;";
    const text = document.createElement("span");
    text.textContent = `↻ ${name}`;
    const removeBtn = document.createElement("span");
    removeBtn.setAttribute("data-repeater-remove", "true");
    removeBtn.textContent = "×";
    removeBtn.style.cssText =
      "cursor:pointer;opacity:0.5;margin-left:3px;font-size:1.1em;transition:opacity 0.15s;";
    removeBtn.addEventListener("mouseenter", () => { removeBtn.style.opacity = "1"; });
    removeBtn.addEventListener("mouseleave", () => { removeBtn.style.opacity = "0.5"; });
    label.appendChild(text);
    label.appendChild(removeBtn);
    p.insertBefore(label, p.firstChild);
  }, []);

  const applyRepeaterStyling = useCallback((p: HTMLElement) => {
    p.style.borderLeft = REPEATER_BORDER_STYLE;
    p.style.background = REPEATER_BG_STYLE;
  }, []);

  const stripRepeaterStyling = useCallback((p: HTMLElement) => {
    p.style.removeProperty("border-left");
    p.style.removeProperty("background");
  }, []);

  const handleCreateRepeater = useCallback((name: string) => {
    const range = savedRangeRef.current;
    if (!range) return;
    const container = range.commonAncestorContainer;
    const el = container instanceof Element ? container : container.parentElement;
    const paragraph = el?.closest<HTMLElement>(SEL_PAGE_P)
      ?? el?.closest<HTMLElement>(".pdf-page p")
      ?? el?.closest<HTMLElement>("p");
    if (!paragraph || !editorRef.current?.contains(paragraph)) return;
    paragraph.setAttribute("data-repeater", name);

    // Auto-prefix existing chips inside this paragraph so they become
    // repeater fields (e.g. "date" → "payments.date").
    paragraph.querySelectorAll<HTMLElement>("[data-placeholder-chip]").forEach((chip) => {
      const current = chip.getAttribute("data-placeholder-chip") ?? "";
      if (current && !current.startsWith(name + ".")) {
        const prefixed = `${name}.${current}`;
        chip.setAttribute("data-placeholder-chip", prefixed);
        const textSpan = chip.firstElementChild as HTMLElement | null;
        if (textSpan && !textSpan.hasAttribute("data-chip-remove")) {
          textSpan.textContent = `{${prefixed}}`;
        }
      }
    });

    applyRepeaterStyling(paragraph);
    insertRepeaterLabel(paragraph, name);
    scanChipNames();
    scheduleSnapshot();
  }, [applyRepeaterStyling, insertRepeaterLabel, scanChipNames, scheduleSnapshot]);

  const handleRemoveRepeater = useCallback((p: HTMLElement) => {
    const rName = p.getAttribute("data-repeater") ?? "";

    // Strip the repeater prefix from chips inside this paragraph
    // (e.g. "payments.date" → "date").
    if (rName) {
      p.querySelectorAll<HTMLElement>("[data-placeholder-chip]").forEach((chip) => {
        const current = chip.getAttribute("data-placeholder-chip") ?? "";
        if (current.startsWith(rName + ".")) {
          const stripped = current.slice(rName.length + 1);
          chip.setAttribute("data-placeholder-chip", stripped);
          const textSpan = chip.firstElementChild as HTMLElement | null;
          if (textSpan && !textSpan.hasAttribute("data-chip-remove")) {
            textSpan.textContent = `{${stripped}}`;
          }
        }
      });
    }

    p.removeAttribute("data-repeater");
    stripRepeaterStyling(p);
    p.querySelector("[data-repeater-label]")?.remove();
    scanChipNames();
    scheduleSnapshot();
  }, [scanChipNames, scheduleSnapshot, stripRepeaterStyling]);

  const hydrateRepeaters = useCallback(() => {
    editorRef.current?.querySelectorAll<HTMLElement>("[data-repeater]").forEach((p) => {
      const name = p.getAttribute("data-repeater") ?? "";
      if (!name) return;
      applyRepeaterStyling(p);
      insertRepeaterLabel(p, name);
    });
  }, [applyRepeaterStyling, insertRepeaterLabel]);

  // Convert an extracted PDF line into an editable wrapped block while
  // preserving its original right boundary. Once a line grows, we shift the
  // later lines on that page downward so text stays within the original area
  // instead of running past the edge or overlapping the next line.
  const prepareParagraphForInput = useCallback((node: Node) => {
    const clickedP = (node instanceof Element ? node : node.parentElement)
      ?.closest<HTMLElement>(SEL_PAGE_P);
    if (!clickedP) return;

    const page = clickedP.closest<HTMLElement>(".pdf-page");
    if (!page) return;

    const groupParagraphs = getLinkedParagraphSegments(clickedP);
    const columnRightEdge = getPageColumnRightEdge(page);

    let widestPageWidth = Math.max(
      ...groupParagraphs.map((paragraph) => Number.parseFloat(paragraph.style.width || "0"))
    );
    let widestPageLeft = Number.parseFloat(clickedP.style.left || clickedP.style.marginLeft || "0");

    for (const sibling of Array.from(page.querySelectorAll<HTMLElement>(":scope > p"))) {
      const siblingWidth = Number.parseFloat(sibling.style.width || "0");
      if (siblingWidth > widestPageWidth) {
        widestPageWidth = siblingWidth;
        widestPageLeft = Number.parseFloat(sibling.style.left || sibling.style.marginLeft || "0");
      }
    }

    for (const paragraph of groupParagraphs) {
      const paragraphPage = paragraph.closest<HTMLElement>(".pdf-page") ?? page;
      const paragraphRightEdge = getPageColumnRightEdge(paragraphPage) || columnRightEdge;
      const paragraphLeft = Number.parseFloat(paragraph.style.left || paragraph.style.marginLeft || "0");
      const paragraphWidth = Number.parseFloat(paragraph.style.width || "0");
      let nextWidth = paragraphRightEdge > paragraphLeft
        ? Math.max(paragraphWidth, paragraphRightEdge - paragraphLeft)
        : paragraphWidth;

      if (paragraphRightEdge <= paragraphLeft && widestPageWidth > paragraphWidth && paragraphWidth < widestPageWidth * 0.6) {
        nextWidth = Math.max(paragraphWidth, (widestPageLeft + widestPageWidth) - paragraphLeft);
      }

      if (nextWidth > paragraphWidth) {
        paragraph.style.width = `${nextWidth}px`;
      }

      applyParagraphWrapStyles(paragraph);
      if (nextWidth > 0) {
        paragraph.style.maxWidth = `${nextWidth}px`;
      }
    }

    void clickedP.offsetWidth;
  }, [getLinkedParagraphSegments]);

  const enableWrappingOnP = useCallback((node: Node, skipRepaginate = false) => {
    const clickedP = (node instanceof Element ? node : node.parentElement)
      ?.closest<HTMLElement>(SEL_PAGE_P);
    if (!clickedP) return;

    const page = clickedP.closest<HTMLElement>(".pdf-page");
    if (!page) return;

    // pdfToHtml groups continuation lines under the same data-flow-group.
    // Always use the FIRST <p> in the group as the merge target so that
    // clicking any line (not just the first) merges the full paragraph.
    const flowGroup = clickedP.dataset.flowGroup || "";
    const p = flowGroup
      ? (page.querySelector<HTMLElement>(`:scope > p[data-flow-group="${flowGroup}"]`) ?? clickedP)
      : clickedP;
    const logicalParagraphId = p.dataset.logicalParagraphId
      || clickedP.dataset.logicalParagraphId
      || createTemplateDomId("logical");
    ensureParagraphIdentity(p, logicalParagraphId);

    if (p.dataset.wrapEnabled && !flowGroup) {
      delete p.dataset.flowGroup;
      syncActiveParagraphMetrics(p);
      return; // already done
    }

    p.dataset.wrapEnabled = "1";
    p.dataset.logicalParagraphId = logicalParagraphId;

    // Save cursor before the merge so we can restore it if a sibling that
    // contained the cursor gets removed from the DOM.
    const preMergeSel = window.getSelection();
    const preMergeRange = preMergeSel?.rangeCount ? preMergeSel.getRangeAt(0).cloneRange() : null;

    // Pre-compute cursor offset within the future merged paragraph. This is needed
    // when the cursor's container is a sibling element (not a text node), e.g. when
    // the user clicked on/near a gap span, because after sib.remove() the element
    // becomes detached and the range is stale. We compute the character offset NOW,
    // before DOM mutation, so we can restore accurately instead of falling back to
    // the very beginning of the paragraph.
    let preCursorInMerged: number | null = null;
    if (preMergeRange && flowGroup) {
      const sibOrder = Array.from(
        page.querySelectorAll<HTMLElement>(`:scope > p[data-flow-group="${flowGroup}"]`)
      );
      let runningOffset = 0;
      for (let i = 0; i < sibOrder.length; i++) {
        const sib = sibOrder[i];
        if (i > 0) runningOffset += 1; // space separator added before each non-first sibling
        const isCursorInThisSib =
          sib === preMergeRange.startContainer || sib.contains(preMergeRange.startContainer);
        if (isCursorInThisSib) {
          preCursorInMerged = runningOffset + getOffsetWithinBlock(sib, preMergeRange.startContainer, preMergeRange.startOffset);
          break;
        }
        runningOffset += getNodeTextLength(sib);
      }
    }

    if (flowGroup) {
      // Merge every sibling in this flow group directly into p, pdfToHtml
      // already validated they belong to the same paragraph, so no spatial
      // re-check is needed. querySelectorAll returns them in document order.
      const siblings = Array.from(
        page.querySelectorAll<HTMLElement>(`:scope > p[data-flow-group="${flowGroup}"]`)
      );
      const columnRightEdge = getPageColumnRightEdge(page);
      let maxWidth = Number.parseFloat(p.style.width || "0");
      let blockBottom =
        getParagraphLayoutTop(p) +
        Number.parseFloat(p.dataset.baseHeight || "0");

      const sibFontSize = Number.parseFloat(p.style.fontSize || "12");

      for (const sib of siblings) {
        ensureParagraphIdentity(sib, logicalParagraphId);
        if (sib === p) continue;
        maxWidth = Math.max(maxWidth, Number.parseFloat(sib.style.width || "0"));
        blockBottom = Math.max(
          blockBottom,
          getParagraphLayoutTop(sib) +
            Number.parseFloat(sib.dataset.baseHeight || "0")
        );
        p.append(document.createTextNode(" "));
        while (sib.firstChild) p.appendChild(sib.firstChild);
        sib.remove();
      }

      p.dataset.baseHeight = String(
        blockBottom - getParagraphLayoutTop(p)
      );
      if (columnRightEdge > 0) {
        const pLeft = Number.parseFloat(p.style.left || p.style.marginLeft || "0");
        maxWidth = Math.max(maxWidth, columnRightEdge - pLeft);
      } else {
        // If this paragraph is narrow (e.g. a bullet), expand its width to match
        // the widest paragraph on the page so text wraps to the full column width.
        const allPs = Array.from(page.querySelectorAll<HTMLElement>(":scope > p"));
        let widestPageWidth = maxWidth;
        for (const sibling of allPs) {
          const sibW = Number.parseFloat(sibling.style.width || "0");
          if (sibW > widestPageWidth) widestPageWidth = sibW;
        }
        if (widestPageWidth > maxWidth && maxWidth < widestPageWidth * 0.6) {
          const pLeft = Number.parseFloat(p.style.left || p.style.marginLeft || "0");
          const widestSib = allPs.find((sibling) => Number.parseFloat(sibling.style.width || "0") === widestPageWidth);
          const widestLeft = widestSib ? Number.parseFloat(widestSib.style.left || widestSib.style.marginLeft || "0") : pLeft;
          maxWidth = (widestLeft + widestPageWidth) - pLeft;
        }
      }
      if (maxWidth > 0) p.style.width = `${maxWidth}px`;

      // Apply line spacing that makes the merged paragraph's total rendered
      // height match the original block height (blockBottom - baseTop).
      // Using lineGapPx/fontSize overshoots because CSS line-height gives the
      // last line full leading below its baseline, which the original PDF
      // absolute positions don't include, causing a downward shift on first edit.
      const totalBlockHeight = blockBottom - getParagraphLayoutTop(p);
      if (siblings.length >= 2 && sibFontSize > 0 && totalBlockHeight > 0) {
        const lineHeightRatio = totalBlockHeight / (siblings.length * sibFontSize);
        p.style.lineHeight = String(Math.max(1.0, Math.min(3.0, lineHeightRatio)));
      }

      p.dataset.paragraphMerged = "true";
      delete p.dataset.flowGroup;
    } else {
      mergeContinuationParagraphs(p);
    }

    // Keep the PDF's extra-wide gaps as measured inline-block spans so
    // footer/header layouts and tab-like spacing stay visually recognizable
    // inside the editor instead of collapsing down to a few characters.
    preserveEditableGapSpans(p);

    applyParagraphWrapStyles(p);
    p.style.maxWidth = p.style.width;
    void p.offsetWidth;

    // If the cursor's start container was removed during the merge (it was inside
    // a sibling that got merged into p), restore the saved range. The child nodes
    // were moved via appendChild so the text nodes are still in the DOM (inside p
    // now), but if the containing element was `sib` itself which is now detached,
    // the range becomes stale. Re-apply it; the browser will try to snap it to a
    // valid position within p.
    if (preMergeRange && preMergeSel) {
      try {
        if (!document.contains(preMergeRange.startContainer)) {
          // The anchor node was removed (e.g. the cursor was on a sibling element or
          // gap span that got detached). Restore to the pre-computed character offset
          // within the now-merged paragraph so the cursor stays near where the user
          // clicked, rather than jumping to the very start of the paragraph.
          const range = document.createRange();
          if (preCursorInMerged !== null) {
            const pos = resolveOffsetWithinBlock(p, preCursorInMerged);
            range.setStart(pos.node, pos.offset);
          } else {
            const target = p.firstChild ?? p;
            range.setStart(target, 0);
          }
          range.collapse(true);
          preMergeSel.removeAllRanges();
          preMergeSel.addRange(range);
        }
        // If the node is still in the document, the browser already tracked it
        // correctly, no action needed.
      } catch {
        // ignore
      }
    }

    if (!skipRepaginate) {
      const startPage = getLeadParagraphSegment(p)?.closest<HTMLElement>(".pdf-page") ?? page;
      recomputePageLayout(startPage);
    }
    syncActiveParagraphMetrics(p);
  }, [ensureParagraphIdentity, getLeadParagraphSegment, mergeContinuationParagraphs, recomputePageLayout, syncActiveParagraphMetrics]);

  const normalizeInitialParagraphs = useCallback(() => {
    const pages = getEditorPages();
    if (pages.length === 0) return;

    for (const page of pages) {
      const paragraphs = getDirectParagraphs(page);
      for (const paragraph of paragraphs) {
        enableWrappingOnP(paragraph, true);
      }
    }

    repaginateFromPage(pages[0]);
  }, [enableWrappingOnP, getDirectParagraphs, getEditorPages, repaginateFromPage]);

  // ─── Load existing template for edit mode ─────────────────────
  useEffect(() => {
    if (!templateId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- toggles loading flag for an async template fetch (external system); cannot run during render.
    setLoadingTemplate(true);
    const openDocxSetupFallback = (
      t: Awaited<ReturnType<typeof wordTemplatesService.getById>>,
    ) => {
      // Read-only fallback (converter off or conversion failed): show the
      // detected placeholders + rename + in-place Re-upload, mirroring the
      // pre-converter behavior. No editable canvas.
      setDocxFields(t.fields ?? []);
      setDocxRepeaters(t.repeaters ?? []);
      setTemplateAssets(t.assets ?? []);
      setPhase("docx-setup");
    };

    wordTemplatesService.getById(lawFirmId, templateId).then(async (t) => {
      if (cancelled) return;
      initializedRef.current = false;
      setTemplateName(t.name);
      setChipNames(t.fields);
      if (t.type === "docx") {
        docxTemplateIdRef.current = t.id;
        // A .docx template opens READ-ONLY, never through the HTML rebuild, 
        // and regardless of whether the row carries a stored `html`.
        //
        // This used to convert docx → PDF → HTML on open whenever the converter
        // was configured, and persist that HTML on the next Save, silently
        // downgrading a byte-perfect Word template into a
        // coordinate-reconstructed approximation, permanently, just because
        // someone clicked Edit. The rebuild cannot carry form fields, and it
        // reflows tables and tab-stop layout (see import-guards.ts), so the
        // damage was exactly what the upload guards exist to prevent, only
        // applied to templates already safely stored.
        //
        // Rows written while that was live still carry the converted HTML.
        // Opening on it made the row's own fill path prefer that HTML forever
        // after, so it is ignored here: the stored .docx is the content, the
        // server refuses to write HTML onto a docx row, and
        // scripts/repair-docx-templates.ts clears the leftover column.
        //
        // Editing the real document belongs in Word: the Re-upload button in
        // this pane replaces the source.
        // `converterEnabled` still drives the PDF PREVIEW below, that renders
        // a copy and never rewrites the stored file.
        openDocxSetupFallback(t);
      } else {
        setTemplateAssets(t.assets ?? []);
        setExportHtml(t.html ?? "");
        setPhase("editor");
      }
    }).catch((err) => {
      if (!cancelled) setError(getErrorMessage(err, "Failed to load template."));
    }).finally(() => {
      if (!cancelled) setLoadingTemplate(false);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Init editor content (once per PDF load) ──────────────────
  useEffect(() => {
    if (editorRef.current && exportHtml && !initializedRef.current) {
      // In fill-preview mode pre-process the HTML exactly as view/download do, 
      // this expands repeater rows with correct positions and replaces chips with
      // styled text, so the editor layout matches the downloaded document.
      const htmlToLoad = (initialFillValues && initialRepeaterFillValues != null)
        ? buildFilledTemplateHtml(exportHtml, initialFillValues, initialRepeaterFillValues)
        : initialFillValues
          ? buildFilledTemplateHtml(exportHtml, initialFillValues, {})
          : exportHtml;
      const bodyMatch = htmlToLoad.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      // Blank/legacy-flow templates carry no `.pdf-page`; give them one so
      // the positional editor initializes (otherwise it bails just below).
      editorRef.current.innerHTML = ensurePdfPage(bodyMatch ? bodyMatch[1] : htmlToLoad);
      initializedRef.current = true;
      customHistoryRef.current = { snapshots: [], index: -1, debounceTimer: null };

      requestAnimationFrame(() => requestAnimationFrame(() => {
        const wrapper = editorWrapperRef.current;
        const editor = editorRef.current;
        if (!wrapper || !editor) return;
        const firstPage = editor.querySelector<HTMLElement>(".pdf-page");
        if (!firstPage) return;
        const pageWidth = parseFloat(firstPage.style.width) || firstPage.offsetWidth;
        if (!pageWidth) return;
        setPageWidth(pageWidth);
        editor.style.width = `${pageWidth}px`;
        editor.style.zoom = "1";
        setZoomLevel(1);

        migratePageBackgroundImages();
        primePageLayoutMetadata();
        // In fill-preview mode the HTML is pre-processed by buildFilledTemplateHtml
        // which already handles overflow and page layout. Running repagination on
        // top would double-process positions, splitting paragraphs mid-sentence.
        if (!initialFillValues) {
          normalizeInitialParagraphs();
        }
        setActiveParagraphId(null);
        setActiveParagraphMetrics(null);
        syncActivePage(firstPage);
        hydrateTextBoxes();
        hydrateImageObjects();
        if (!initialFillValues) {
          hydrateRepeaters();
        }

        flushSnapshot(); // capture initial state as first undo point (after hydration)

        // Remove browser-injected <br> elements after chips and ensure
        // zero-width space text nodes exist around chips for caret placement.
        // Only removes a <br> that is the DIRECT next sibling of a chip, 
        // if a text node (ZWS) already sits between the chip and the <br>,
        // the <br> is a user-created line break and must be preserved.
        const normalizeBrsAndCaretTargets = () => {
          editor.querySelectorAll("[data-placeholder-chip]").forEach(chip => {
            if (chip.nextSibling?.nodeName === "BR") {
              chip.nextSibling.parentNode?.removeChild(chip.nextSibling);
            }
          });
          ensureChipCaretTargets(editor);
        };

        // Run once on init to handle chips in saved HTML
        normalizeBrsAndCaretTargets();

        mutNormalizerRef.current?.disconnect();
        mutNormalizerRef.current = new MutationObserver((mutations) => {
          let needsCleanup = false;
          for (const m of mutations) {
            for (const node of Array.from(m.addedNodes)) {
              if (node.nodeName === "BR") { needsCleanup = true; break; }
            }
            if (needsCleanup) break;
          }
          if (needsCleanup) normalizeBrsAndCaretTargets();
        });
        mutNormalizerRef.current.observe(editor, { childList: true, subtree: true });
      }));
    }
  }, [exportHtml, flushSnapshot, hydrateImageObjects, hydrateRepeaters, hydrateTextBoxes, initialFillValues, initialRepeaterFillValues, migratePageBackgroundImages, normalizeInitialParagraphs, primePageLayoutMetadata, syncActivePage]);

  // Build a chip DOM element for a given field name (shared by handleInsert and
  // the auto-conversion of typed {fieldname} text).
  // Pass `style` to override the default fieldStylePreset (e.g. to match the
  // surrounding text when auto-converting typed {fieldname} syntax).
  const buildChipElement = useCallback((name: string, style?: PlaceholderFieldStyle) => {
    const chip = document.createElement("span");
    chip.setAttribute("data-placeholder-chip", name);
    chip.setAttribute("contentEditable", "false");
    chip.style.cssText =
      "display:inline-flex;align-items:center;gap:3px;text-decoration:underline dotted;text-underline-offset:3px;font-style:inherit;font-weight:inherit;color:inherit;vertical-align:baseline;";
    applyPlaceholderFieldStyle(chip, style ?? fieldStylePreset);

    const label = document.createElement("span");
    label.textContent = `{${name}}`;
    label.style.cssText = "cursor:default;color:inherit;";

    const removeBtn = document.createElement("span");
    removeBtn.setAttribute("data-chip-remove", "true");
    removeBtn.textContent = "×";
    removeBtn.style.cssText =
      "cursor:pointer;font-size:0.9em;opacity:0.5;line-height:1;padding:0 1px;transition:opacity 0.15s;color:inherit;";
    removeBtn.addEventListener("mouseenter", () => { removeBtn.style.opacity = "1"; });
    removeBtn.addEventListener("mouseleave", () => { removeBtn.style.opacity = "0.5"; });

    chip.appendChild(label);
    chip.appendChild(removeBtn);
    return chip;
  }, [fieldStylePreset]);

  // Scan a paragraph for plain {fieldname} text and convert matches into chips.
  // Returns true if at least one conversion was made.
  const convertBracedTextToChips = useCallback((paragraph: HTMLElement): boolean => {
    const FIELD_PATTERN = /\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g;
    let didConvert = false;

    // Collect text nodes that are NOT already inside a chip.
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return (node.parentElement as HTMLElement | null)?.closest("[data-placeholder-chip]")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = n as Text;
      FIELD_PATTERN.lastIndex = 0;
      if (FIELD_PATTERN.test(t.textContent ?? "")) textNodes.push(t);
    }

    if (textNodes.length === 0) return false;

    // Save caret info before mutating the DOM.
    const sel = window.getSelection();
    const savedRange = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    let caretContainer: Node | null = savedRange?.startContainer ?? null;
    let caretOffset = savedRange?.startOffset ?? 0;

    for (const textNode of textNodes) {
      const text = textNode.textContent ?? "";
      FIELD_PATTERN.lastIndex = 0;
      const matches: { index: number; length: number; name: string }[] = [];
      let m: RegExpExecArray | null;
      while ((m = FIELD_PATTERN.exec(text)) !== null) {
        matches.push({ index: m.index, length: m[0].length, name: m[1] });
      }
      if (matches.length === 0) continue;

      const parent = textNode.parentNode;
      if (!parent) continue;

      // Read the computed style of the text node's parent so the chip
      // matches the surrounding text size, weight, colour, etc.
      const surroundingStyle = getPlaceholderFieldStyleFromElement(
        (textNode.parentElement ?? paragraph) as HTMLElement,
      );

      const parts: (Text | HTMLElement)[] = [];
      let offset = 0;
      let newCaretNode: Node | null = null;
      let newCaretOffset = 0;

      for (const match of matches) {
        if (match.index > offset) {
          const before = document.createTextNode(text.slice(offset, match.index));
          // Adjust caret if it was inside this text node before the match.
          if (caretContainer === textNode && caretOffset <= match.index && caretOffset >= offset) {
            newCaretNode = before;
            newCaretOffset = caretOffset - offset;
          }
          parts.push(before);
        }
        const chip = buildChipElement(match.name, surroundingStyle);
        // If caret was right after the closing }, place it after the chip.
        if (caretContainer === textNode && caretOffset === match.index + match.length) {
          newCaretNode = chip;
          newCaretOffset = 1; // after the chip node
        }
        parts.push(chip);
        offset = match.index + match.length;
      }

      if (offset < text.length) {
        const after = document.createTextNode(text.slice(offset));
        if (caretContainer === textNode && caretOffset > offset) {
          newCaretNode = after;
          newCaretOffset = caretOffset - offset;
        }
        parts.push(after);
      }

      const fragment = document.createDocumentFragment();
      for (const p of parts) fragment.appendChild(p);
      parent.replaceChild(fragment, textNode);

      // Ensure ZWS around each new chip for caret targeting.
      for (const p of parts) {
        if (p instanceof HTMLElement && p.hasAttribute("data-placeholder-chip")) {
          if (!p.previousSibling || p.previousSibling.nodeType !== Node.TEXT_NODE) {
            p.parentNode?.insertBefore(document.createTextNode("\u200B"), p);
          }
          if (!p.nextSibling || p.nextSibling.nodeType !== Node.TEXT_NODE) {
            p.parentNode?.insertBefore(document.createTextNode("\u200B"), p.nextSibling);
          }
        }
      }

      // Restore caret, always place inside a text node for reliable typing.
      if (newCaretNode) {
        try {
          const range = document.createRange();
          if (newCaretNode instanceof HTMLElement) {
            // Place cursor at position 0 of the ZWS text node that follows
            // the chip, mirroring placeCaretBesideChip("after") for reliability.
            const nextText = newCaretNode.nextSibling;
            if (nextText?.nodeType === Node.TEXT_NODE) {
              range.setStart(nextText, 0);
            } else {
              range.setStartAfter(newCaretNode);
            }
          } else {
            range.setStart(newCaretNode, Math.min(newCaretOffset, (newCaretNode as Text).length));
          }
          range.collapse(true);
          sel?.removeAllRanges();
          sel?.addRange(range);
          caretContainer = range.startContainer;
          caretOffset = range.startOffset;
        } catch {
          // Ignore caret restoration errors.
        }
      }

      enableWrappingOnP(paragraph);
      didConvert = true;
    }

    return didConvert;
  }, [buildChipElement, enableWrappingOnP]);

  const handleEditorInput = useCallback(() => {
    const sel = window.getSelection();
    let paragraph: HTMLElement | null = null;
    let page: HTMLElement | null = null;
    if (sel?.rangeCount) {
      const initialContainer = sel.getRangeAt(0).commonAncestorContainer;
      enableWrappingOnP(initialContainer);

      const updatedSelection = window.getSelection();
      const liveContainer = updatedSelection?.rangeCount
        ? updatedSelection.getRangeAt(0).commonAncestorContainer
        : initialContainer;
      paragraph = (liveContainer instanceof Element ? liveContainer : liveContainer.parentElement)
        ?.closest<HTMLElement>(SEL_PAGE_P) ?? null;
      page = paragraph?.closest<HTMLElement>(".pdf-page")
        ?? (liveContainer instanceof Element ? liveContainer : liveContainer.parentElement)?.closest<HTMLElement>(".pdf-page")
        ?? null;

      // Auto-convert typed {fieldname} text into chips before repaginating.
      if (paragraph) {
        convertBracedTextToChips(paragraph);
      }

      if (paragraph && page) {
        const leadParagraph = getLeadParagraphSegment(paragraph);
        const startPage = leadParagraph?.closest<HTMLElement>(".pdf-page") ?? page;
        recomputePageLayout(startPage);
        syncActiveParagraphMetrics(paragraph);
      } else if (page) {
        recomputePageLayout(page);
      }
    }
    scanChipNames();
    // Native typing/paste does not always emit a selectionchange after the DOM
    // mutates, so resync the saved range and toolbar state from the live caret.
    saveCurrentRange();
    syncToolbarStyle();
    scheduleSnapshot();
  }, [
    convertBracedTextToChips,
    enableWrappingOnP,
    getLeadParagraphSegment,
    recomputePageLayout,
    saveCurrentRange,
    scanChipNames,
    scheduleSnapshot,
    syncActiveParagraphMetrics,
    syncToolbarStyle,
  ]);

  // ─── Apply zoom level changes ──────────────────────────────────
  useEffect(() => {
    zoomLevelRef.current = zoomLevel;
    if (editorRef.current) {
      editorRef.current.style.zoom = String(zoomLevel);
    }
  }, [zoomLevel]);

  useEffect(() => {
    textBoxModeRef.current = textBoxMode;
  }, [textBoxMode]);

  useEffect(() => {
    if (phase !== "editor") return;

    const wrapper = editorWrapperRef.current;
    if (!wrapper) return;

    const syncScroll = () => {
      setEditorScrollLeft(wrapper.scrollLeft);
    };

    syncScroll();
    wrapper.addEventListener("scroll", syncScroll, { passive: true });
    return () => wrapper.removeEventListener("scroll", syncScroll);
  }, [phase]);

  // ─── Intercept browser zoom gestures on the editor ────────────
  useEffect(() => {
    if (phase !== "editor") return;

    const clamp = (v: number) => Math.min(3, Math.max(0.3, v));

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoomLevel(z => clamp(+(z - e.deltaY * 0.001).toFixed(3)));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoomLevel(z => clamp(+(z + 0.1).toFixed(2)));
      } else if (e.key === "-") {
        e.preventDefault();
        setZoomLevel(z => clamp(+(z - 0.1).toFixed(2)));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoomLevel(1);
      }
    };

    const wrapper = editorWrapperRef.current;
    wrapper?.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      wrapper?.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [phase]);

  // ─── Insert button highlight on doc click ─────────────────────
  useEffect(() => {
    if (phase !== "editor") return;
    const onDocumentClick = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".pdf-page")) {
        setInsertBtnReady(false);
      }
    };
    document.addEventListener("mousedown", onDocumentClick);
    return () => document.removeEventListener("mousedown", onDocumentClick);
  }, [phase]);

  const handleDocClick = useCallback((e: React.MouseEvent) => {
    if (suppressNextTextBoxClickRef.current) {
      suppressNextTextBoxClickRef.current = false;
      return;
    }

    const target = e.target as Element;
    if (!target.closest("[data-template-image-layer-menu], [data-template-image-layer-trigger]") && editorRef.current) {
      closeTemplateImageLayerMenus(editorRef.current);
    }
    const page = getPageAtClientPoint(e.clientX, e.clientY);
    if (!page) {
      if (!target.closest("[data-template-text-box-id]")) {
        setSelectedTextBoxId(null);
      }
      if (!target.closest(TEMPLATE_IMAGE_OBJECT_SELECTOR)) {
        setSelectedImageObjectId(null);
      }
      if (!target.closest("[data-placeholder-chip]")) {
        selectChipElement(null);
      }
      setActiveParagraphId(null);
      setActiveParagraphMetrics(null);
      setInsertBtnReady(false);
      return;
    }

    syncActivePage(page);

    const clickedParagraph = target.closest<HTMLElement>(SEL_PAGE_P);

    if (textBoxMode && !target.closest("[data-template-text-box-id]")) {
      const pageRect = page.getBoundingClientRect();
      const zoom = Math.max(zoomLevel, 0.01);
      const pageWidth = pageRect.width / zoom;
      const pageHeight = pageRect.height / zoom;
      const boxLeft = Math.max(0, Math.min(pageWidth - TEMPLATE_TEXTBOX_WIDTH, (e.clientX - pageRect.left) / zoom));
      const boxTop = Math.max(0, Math.min(pageHeight - TEMPLATE_TEXTBOX_HEIGHT, (e.clientY - pageRect.top) / zoom));
      createTextBoxAt(page, boxLeft, boxTop);
      setTextBoxMode(false);
      setInsertBtnReady(false);
      return;
    }

    const imageObjectAtPoint = clickedParagraph
      ? null
      : getImageObjectAtPoint(e.clientX, e.clientY);

    if (!target.closest("[data-template-text-box-id]")) {
      setSelectedTextBoxId(null);
    }
    if (!target.closest(TEMPLATE_IMAGE_OBJECT_SELECTOR) && !imageObjectAtPoint) {
      setSelectedImageObjectId(null);
    }
    if (!target.closest("[data-placeholder-chip]")) {
      selectChipElement(null);
    }
    if (imageObjectAtPoint) {
      selectImageObject(imageObjectAtPoint);
      syncActivePage(imageObjectAtPoint.closest<HTMLElement>(".pdf-page"));
      setInsertBtnReady(true);
      return;
    }
    const paragraph = clickedParagraph
      ?? getNearestParagraphOnPage(page, e.clientX, e.clientY);
    setActiveParagraphId(paragraph?.dataset.paragraphId ?? null);
    syncActiveParagraphMetrics(paragraph);
    setInsertBtnReady(true);
  }, [createTextBoxAt, getImageObjectAtPoint, getNearestParagraphOnPage, getPageAtClientPoint, selectImageObject, syncActivePage, syncActiveParagraphMetrics, textBoxMode, zoomLevel]);

  const handleEditorMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (!target.closest("[data-template-image-layer-menu], [data-template-image-layer-trigger]") && editorRef.current) {
      closeTemplateImageLayerMenus(editorRef.current);
    }
    const chip = target.closest<HTMLElement>("[data-placeholder-chip]");
    if (chip && !target.closest("[data-chip-remove]")) {
      // If the click lands near the left or right edge of the chip,
      // place the caret beside it instead of selecting the chip.
      const chipRect = chip.getBoundingClientRect();
      if (e.clientX - chipRect.left < CHIP_EDGE_THRESHOLD) {
        e.preventDefault();
        placeCaretBesideChip(chip, "before");
        selectChipElement(null);
        chipEdgeClickRef.current = true;
        const paragraph = chip.closest<HTMLElement>(SEL_PAGE_P);
        setActiveParagraphId(paragraph?.dataset.paragraphId ?? null);
        syncActiveParagraphMetrics(paragraph);
        syncActivePage(chip.closest<HTMLElement>(".pdf-page"));
        return;
      }
      if (chipRect.right - e.clientX < CHIP_EDGE_THRESHOLD) {
        e.preventDefault();
        placeCaretBesideChip(chip, "after");
        selectChipElement(null);
        chipEdgeClickRef.current = true;
        const paragraph = chip.closest<HTMLElement>(SEL_PAGE_P);
        setActiveParagraphId(paragraph?.dataset.paragraphId ?? null);
        syncActiveParagraphMetrics(paragraph);
        syncActivePage(chip.closest<HTMLElement>(".pdf-page"));
        return;
      }

      e.preventDefault();
      selectChipElement(chip);
      setSelectedTextBoxId(chip.closest<HTMLElement>("[data-template-text-box-id]")?.dataset.templateTextBoxId ?? null);
      const paragraph = chip.closest<HTMLElement>(SEL_PAGE_P);
      setActiveParagraphId(paragraph?.dataset.paragraphId ?? null);
      syncActiveParagraphMetrics(paragraph);
      syncActivePage(chip.closest<HTMLElement>(".pdf-page"));
      setToolbarStyle(getToolbarStyleFromElement(chip, chip));
      return;
    }

    // Let chip/repeater remove buttons pass through to the click handler
    if (target.closest("[data-chip-remove]") || target.closest("[data-repeater-remove]")) {
      return;
    }

    // Text and text-box placement take precedence over image hit-testing.
    if (textBoxMode || target.closest(SEL_PAGE_P) || target.closest("[data-template-text-box-editor]")) {
      return;
    }

    const directImageObject = target.closest<HTMLElement>(TEMPLATE_IMAGE_OBJECT_SELECTOR);
    const imageObject = directImageObject ?? getImageObjectAtPoint(e.clientX, e.clientY);
    if (imageObject) {
      e.preventDefault();
      setSelectedImageObjectId(imageObject.dataset.templateImageObjectId ?? null);
      setSelectedTextBoxId(null);
      selectChipElement(null);
      setActiveParagraphId(null);
      setActiveParagraphMetrics(null);
      syncActivePage(imageObject.closest<HTMLElement>(".pdf-page"));
      return;
    }

    const inParagraph = Boolean(target.closest(SEL_PAGE_P));
    const inTextBox = Boolean(target.closest("[data-template-text-box-editor]"));
    if (inParagraph || inTextBox) {
      // When a paragraph contains contentEditable="false" chips, the browser's
      // default mousedown may "block-select" a chip instead of placing a caret.
      // Only intervene when the browser's caret resolution would actually land
      // inside or directly adjacent to a chip, otherwise let the browser
      // handle it (text clicks, empty lines, etc.).
      if (inParagraph) {
        const paragraph = target.closest<HTMLElement>(SEL_PAGE_P)!;
        if (paragraph.querySelector("[data-placeholder-chip]")) {
          let wouldHitChip = false;
          const docApis = document as Document & {
            caretRangeFromPoint?: (x: number, y: number) => Range | null;
          };
          if (typeof docApis.caretRangeFromPoint === "function") {
            const testRange = docApis.caretRangeFromPoint(e.clientX, e.clientY);
            if (testRange) {
              const container = testRange.startContainer;
              const offset = testRange.startOffset;
              const el = container instanceof Element ? container : container.parentElement;
              if (el?.closest("[data-placeholder-chip]")) {
                wouldHitChip = true;
              } else if (container.nodeType === Node.ELEMENT_NODE) {
                const child = container.childNodes[offset];
                const prev = offset > 0 ? container.childNodes[offset - 1] : null;
                if ((child instanceof HTMLElement && child.hasAttribute("data-placeholder-chip"))
                  || (prev instanceof HTMLElement && prev.hasAttribute("data-placeholder-chip"))) {
                  wouldHitChip = true;
                }
              }
            }
          }
          if (wouldHitChip) {
            e.preventDefault();
            placeCaretInParagraph(paragraph, e.clientX, e.clientY);
            selectChipElement(null);
            chipEdgeClickRef.current = true;
            setActiveParagraphId(paragraph.dataset.paragraphId ?? null);
            syncActiveParagraphMetrics(paragraph);
            syncActivePage(paragraph.closest<HTMLElement>(".pdf-page"));
            return;
          }
        }
      }

      // When clicking inside a link span, the browser may not place the caret
      // due to select-none on the editor. Manually place it so clicks and
      // drag-selections work inside linked text.
      if (target.closest("[data-link-href]") && inParagraph) {
        const paragraph = target.closest<HTMLElement>(SEL_PAGE_P)!;
        placeCaretInParagraph(paragraph, e.clientX, e.clientY);
      }

      mouseDownInEditorRef.current = true;
    } else {
      const page = target.closest<HTMLElement>(".pdf-page");
      if (page) {
        const paragraph = getNearestParagraphOnPage(page, e.clientX, e.clientY);
        if (paragraph) {
          placeCaretInParagraph(paragraph, e.clientX, e.clientY);
          const paragraphId = paragraph.dataset.paragraphId ?? null;
          setActiveParagraphId(paragraphId);
          syncActiveParagraphMetrics(paragraph);
          syncActivePage(page);
        }
      }
    }
  }, [getImageObjectAtPoint, getNearestParagraphOnPage, placeCaretInParagraph, selectChipElement, syncActivePage, syncActiveParagraphMetrics]);

  const handleEditorWrapperMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const page = getPageAtClientPoint(event.clientX, event.clientY);
    if (page) {
      syncActivePage(page);
    }
  }, [getPageAtClientPoint, syncActivePage]);

  const handleEditorWrapperMouseUp = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (textBoxMode || textBoxDragActiveRef.current) return;

    const target = event.target as Element;
    if (target.closest("[data-template-text-box-id]")) return;
    if (target.closest(TEMPLATE_IMAGE_OBJECT_SELECTOR)) return;

    const page = getPageAtClientPoint(event.clientX, event.clientY);
    if (!page) return;

    const paragraph = target.closest<HTMLElement>(SEL_PAGE_P)
      ?? getNearestParagraphOnPage(page, event.clientX, event.clientY);
    if (!paragraph) return;

    selectChipElement(null);

    const selection = window.getSelection();

    // If user has an active text selection (drag-selected), preserve it
    if (selection?.rangeCount && !selection.isCollapsed) {
      const anchorEl = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
      const focusEl = selection.focusNode instanceof Element ? selection.focusNode : selection.focusNode?.parentElement;
      const editor = editorRef.current;
      if (editor && anchorEl && focusEl && editor.contains(anchorEl) && editor.contains(focusEl)) {
        savedRangeRef.current = selection.getRangeAt(0).cloneRange();
        activeEditableRef.current = editor;
        reconnectContinuationFromLead(paragraph);
        setActiveParagraphId(paragraph.dataset.paragraphId ?? null);
        syncActiveParagraphMetrics(paragraph);
        syncActivePage(page);
        syncToolbarStyle();
        return;
      }
    }

    const anchorElement = selection?.anchorNode instanceof Element
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement;
    const focusElement = selection?.focusNode instanceof Element
      ? selection.focusNode
      : selection?.focusNode?.parentElement;
    const selectionWithinParagraph = Boolean(
      anchorElement &&
      focusElement &&
      paragraph.contains(anchorElement) &&
      paragraph.contains(focusElement)
    );

    if (!selection?.rangeCount || !selectionWithinParagraph) {
      if (placeCaretInParagraph(paragraph, event.clientX, event.clientY)) {
        reconnectContinuationFromLead(paragraph);
        setActiveParagraphId(paragraph.dataset.paragraphId ?? null);
        syncActiveParagraphMetrics(paragraph);
        syncActivePage(page);
        saveCurrentRange();
        syncToolbarStyle();
      }
      return;
    }

    savedRangeRef.current = selection.getRangeAt(0).cloneRange();
    activeEditableRef.current = editorRef.current;
    reconnectContinuationFromLead(paragraph);
    setActiveParagraphId(paragraph.dataset.paragraphId ?? null);
    syncActiveParagraphMetrics(paragraph);
    syncActivePage(page);
    syncToolbarStyle();
  }, [getImageObjectAtPoint, getNearestParagraphOnPage, getPageAtClientPoint, placeCaretInParagraph, reconnectContinuationFromLead, saveCurrentRange, syncActivePage, syncActiveParagraphMetrics, syncToolbarStyle, textBoxMode]);

  // ─── Upload ───────────────────────────────────────────────────
  const handleFile = useCallback(async (file: File, acknowledgedLeftovers?: string[]) => {
    if (!isSupportedTemplateFile(file)) {
      setError("Please upload a supported file (.docx, .pdf, .doc, .odt, .rtf, or .txt).");
      return;
    }
    setConverting(true);
    setError(null);
    try {
      const isLegacyDocFile = file.name.toLowerCase().endsWith(".doc");
      const normalizedDocxFile = isLegacyDocFile
        ? await documentConversionService.convertToFormat(file, "docx")
        : file;

      const isDocxUpload = isDocxFile(normalizedDocxFile) || isLegacyDocFile;

      // Decide up front whether this document can survive the PDF→HTML rebuild
      // below (see import-guards.ts). A Word fill-in form cannot: the rebuild
      // reads text positions, so the form fields and the ruled lines they sit
      // on are dropped. Checking before the converter round-trip also saves a
      // conversion we know we're going to throw away.
      const docxGuard = isDocxUpload
        ? inspectDocxForImport(new Uint8Array(await normalizedDocxFile.arrayBuffer()))
        : null;

      // For DOCX files: also upload to backend to store the original .docx
      // (the Word-formatted fill fallback). This runs even for a blocked form, 
      // it IS the lossless landing spot such a document falls back to.
      let uploadedDocx: Awaited<ReturnType<typeof wordTemplatesService.uploadDocxTemplate>> | null = null;
      if (isDocxUpload) {
        setConvertingDocx(true);
        try {
          uploadedDocx = await wordTemplatesService.uploadDocxTemplate(
            lawFirmId,
            normalizedDocxFile,
            normalizedDocxFile.name.replace(/\.[^.]+$/, ""),
            { folderId, acknowledgedLeftovers },
          );
          docxTemplateIdRef.current = uploadedDocx.id;
          setTemplateAssets((uploadedDocx.assets ?? []) as TemplateAsset[]);
        } catch (uploadErr) {
          // Held back by the client-details check. Stop the whole import, 
          // carrying on would put the same text into the editor's copy with no
          // warning at all. If it named a client, ask (Save anyway runs the
          // import again); if it could not check, say why.
          if (uploadErr instanceof ClientTextCheckError) {
            if (uploadErr.leftovers) {
              setLeftoverPrompt({ kind: "import", file, leftovers: uploadErr.leftovers });
            } else {
              setError(uploadErr.message);
            }
            return;
          }
          // Non-fatal, PDF→HTML import still succeeds even if DOCX
          // re-upload fails. Surface the error but continue.
          console.warn("templates: DOCX source upload failed", uploadErr);
        }
      }

      // A blocked Word form skips the rebuild entirely and opens on the stored
      // original instead, same read-only pane the converter-off path uses, and
      // the only place the document keeps its structure. Without a stored copy
      // there is nowhere lossless to land, so report the reason and stop.
      if (docxGuard && !docxGuard.ok) {
        if (uploadedDocx) {
          setDocxFields(uploadedDocx.fields ?? []);
          setDocxRepeaters(uploadedDocx.repeaters ?? []);
          setTemplateAssets((uploadedDocx.assets ?? []) as TemplateAsset[]);
          setImportWarnings([docxGuard.reason]);
          setPhase("docx-setup");
        } else {
          setError(docxGuard.reason);
        }
        return;
      }

      // All formats: convert to PDF → HTML → editor (Paralegix-editable).
      // DOCX needs the document converter; if it's off/unreachable, fall back
      // to the read-only docx-setup pane on the stored .docx rather than
      // failing the upload.
      try {
        const pdfFile = isPdfFile(file) ? file : await wordTemplatesService.convertToPdf(lawFirmId, normalizedDocxFile);
        const result = await convertPdfToHtml(pdfFile);

        // A fillable PDF survives this conversion as bare labels over an empty
        // page, the fields and their rules are gone. There is no lossless PDF
        // path to fall back to, so refuse instead of presenting that as an
        // import that worked.
        const pdfGuard = inspectPdfFormFields(result.formFieldNames);
        if (!pdfGuard.ok) {
          setError(pdfGuard.reason);
          return;
        }

        initializedRef.current = false;
        applyFieldStylePreset(DEFAULT_PLACEHOLDER_FIELD_STYLE, false);
        // Reconstitute {placeholder} tokens into editable chips (see
        // chipify-placeholders.ts) so imported templates stay fillable.
        setExportHtml(chipifyPlaceholdersInHtml(result.html));
        setImportWarnings([...(docxGuard?.warnings ?? []), ...result.warnings]);
        setTemplateAssets([]);
        setChipNames([]);
        setSelectedImageObjectId(null);
        selectChipElement(null);
        setPhase("editor");
      } catch (convErr) {
        if (isDocxUpload && uploadedDocx) {
          console.warn("templates: docx convert→editable failed, using docx-setup", convErr);
          setDocxFields(uploadedDocx.fields ?? []);
          setDocxRepeaters(uploadedDocx.repeaters ?? []);
          setTemplateAssets((uploadedDocx.assets ?? []) as TemplateAsset[]);
          setPhase("docx-setup");
        } else {
          throw convErr;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load document.");
    } finally {
      setConverting(false);
      setConvertingDocx(false);
    }
  }, [applyFieldStylePreset, lawFirmId, folderId]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleImageFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void insertImageFromFile(file);
    e.target.value = "";
  };

  const insertManualLineBreak = useCallback(() => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!container || !editorRef.current?.contains(container)) return;

    const paragraph = container.closest<HTMLElement>(SEL_PAGE_P);
    const textBoxEditor = container.closest<HTMLElement>("[data-template-text-box-editor]");
    if (!paragraph && !textBoxEditor) return;

    if (paragraph) {
      enableWrappingOnP(paragraph);
    }

    // ─── List continuation on Enter ───────────────────────────────
    // Handles both real HTML lists (<ul>/<ol>) and text-based bullets from PDF
    // conversion (e.g. "• item", "1. item", "a) item").
    const listItem = container.closest<HTMLElement>("li");
    if (listItem) {
      const listEl = listItem.closest<HTMLElement>("ul, ol");
      const itemText = listItem.textContent || "";

      if (itemText.trim() === "") {
        const parentList = listItem.parentElement;
        listItem.remove();
        if (parentList && parentList.parentNode) {
          const br = document.createElement("br");
          parentList.parentNode.insertBefore(br, parentList.nextSibling);
          const newRange = document.createRange();
          newRange.setStartAfter(br);
          newRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(newRange);
          if (parentList.children.length === 0) parentList.remove();
        }
      } else {
        range.deleteContents();
        const newLi = document.createElement("li");
        const afterRange = document.createRange();
        afterRange.setStart(range.endContainer, range.endOffset);
        afterRange.setEndAfter(listItem.lastChild || listItem);
        newLi.appendChild(afterRange.extractContents());
        if (!newLi.textContent && !newLi.querySelector("br")) {
          newLi.appendChild(document.createElement("br"));
        }
        listItem.parentNode?.insertBefore(newLi, listItem.nextSibling);
        if (!listItem.textContent && !listItem.querySelector("br")) {
          listItem.appendChild(document.createElement("br"));
        }
        const newRange = document.createRange();
        newRange.setStart(newLi, 0);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
      }

      const updatedSelection = window.getSelection();
      if (updatedSelection?.rangeCount) {
        savedRangeRef.current = updatedSelection.getRangeAt(0).cloneRange();
      }
      const page = paragraph?.closest<HTMLElement>(".pdf-page") ?? listEl?.closest<HTMLElement>(".pdf-page");
      if (page) {
        const startPage = paragraph
          ? getLeadParagraphSegment(paragraph)?.closest<HTMLElement>(".pdf-page") ?? page
          : page;
        recomputePageLayout(startPage);
        syncActiveParagraphMetrics(paragraph);
      }
      syncToolbarStyle();
      return;
    }

    // ─── Text-based bullet/number continuation ────────────────────
    // Detect bullet or numbered prefix on the current line (text between
    // the previous <br> and the cursor, or from the start of the paragraph).
    const editableRoot = paragraph || textBoxEditor;
    let currentLineText = "";
    if (editableRoot) {
      // Walk backwards from the cursor to find the start of the current line
      // (either a <br> or the beginning of the editable element).
      const cursorNode = range.startContainer;
      const cursorOffset = range.startOffset;
      const treeWalker = document.createTreeWalker(editableRoot, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: (node) => {
          if (node.nodeName === "BR") return NodeFilter.FILTER_ACCEPT;
          if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        },
      });

      // Collect text nodes and br positions in order
      const nodes: Array<{ node: Node; type: "text" | "br" }> = [];
      let current: Node | null = treeWalker.nextNode();
      while (current) {
        nodes.push({ node: current, type: current.nodeName === "BR" ? "br" : "text" });
        current = treeWalker.nextNode();
      }

      // Find cursor position, then walk backward to previous <br> to get current line text
      let cursorFound = false;
      const lineTextParts: string[] = [];
      for (let i = nodes.length - 1; i >= 0; i--) {
        const entry = nodes[i];
        if (!cursorFound) {
          if (entry.type === "text" && entry.node === cursorNode) {
            cursorFound = true;
            lineTextParts.unshift((entry.node.textContent || "").slice(0, cursorOffset));
          } else if (entry.type === "text" && cursorNode instanceof Element && cursorNode.contains(entry.node)) {
            cursorFound = true;
            lineTextParts.unshift(entry.node.textContent || "");
          }
          continue;
        }
        if (entry.type === "br") break;
        lineTextParts.unshift(entry.node.textContent || "");
      }
      // If cursor was at a non-text position (e.g. element boundary), try simpler approach
      if (!cursorFound && editableRoot.textContent) {
        // Fallback: use full text content up to cursor
        currentLineText = editableRoot.textContent;
      } else {
        currentLineText = lineTextParts.join("");
      }
    }

    // Match bullet patterns: bullet chars, numbered lists (1. 2.), lettered (a) b))
    // Also captures leading whitespace/nbsp so indentation is preserved.
    const bulletPatterns = [
      // Bullet characters: •, ‣, ◦, ⁃, ∙, ▪, ▫, ▸, ▹, ●, ○, ■, □, ✓, ✔, ✗, ✘, ‒, –,, 
      /^([\s\u00A0]*)([•‣◦⁃∙▪▫▸▹●○■□✓✔✗✘‒–\u2014-][\s\u00A0]*)/,
      // Numbered: "1. ", "12. ", "1) ", "12) "
      /^([\s\u00A0]*)(\d+[.)]\s+)/,
      // Lettered: "a. ", "b) ", "A. ", "B) "
      /^([\s\u00A0]*)([a-zA-Z][.)]\s+)/,
      // Roman numerals: "i. ", "ii) ", "IV. "
      /^([\s\u00A0]*)([ivxIVX]+[.)]\s+)/,
    ];

    let bulletPrefix = "";
    let isNumberedBullet = false;
    let numberedMatch: RegExpMatchArray | null = null;
    for (const pattern of bulletPatterns) {
      const match = currentLineText.match(pattern);
      if (match) {
        bulletPrefix = match[0];
        // Check if this is a numbered pattern that should auto-increment
        const numMatch = match[2]?.match(/^(\d+)([.)]\s+)$/);
        if (numMatch) {
          isNumberedBullet = true;
          numberedMatch = numMatch;
        }
        break;
      }
    }

    // If the line is ONLY the bullet prefix (empty bullet), don't continue, just
    // remove the prefix and insert a plain line break.
    const lineContentAfterBullet = currentLineText.slice(bulletPrefix.length).trim();
    if (bulletPrefix && lineContentAfterBullet === "") {
      // Remove the bullet prefix text from the current line
      if (editableRoot) {
        const treeWalker = document.createTreeWalker(editableRoot, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
          acceptNode: (n) => {
            if (n.nodeName === "BR") return NodeFilter.FILTER_ACCEPT;
            if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
            return NodeFilter.FILTER_SKIP;
          },
        });

        // Find the start of the current line (after last <br> before cursor)
        const allNodes: Array<{ node: Node; type: "text" | "br" }> = [];
        let n: Node | null = treeWalker.nextNode();
        while (n) {
          allNodes.push({ node: n, type: n.nodeName === "BR" ? "br" : "text" });
          n = treeWalker.nextNode();
        }

        let lineStartIdx = 0;
        for (let i = allNodes.length - 1; i >= 0; i--) {
          if (allNodes[i].node === range.startContainer || (range.startContainer instanceof Element && range.startContainer.contains(allNodes[i].node))) {
            // Found cursor position, now find previous <br>
            for (let j = i; j >= 0; j--) {
              if (allNodes[j].type === "br") {
                lineStartIdx = j + 1;
                break;
              }
            }
            break;
          }
        }

        // Delete the prefix characters from the line start
        let charsToRemove = bulletPrefix.length;
        for (let i = lineStartIdx; i < allNodes.length && charsToRemove > 0; i++) {
          const entry = allNodes[i];
          if (entry.type !== "text") continue;
          const textNode = entry.node as Text;
          const removeCount = Math.min(charsToRemove, textNode.length);
          textNode.deleteData(0, removeCount);
          charsToRemove -= removeCount;
          if (textNode.length === 0 && textNode.parentNode) {
            textNode.parentNode.removeChild(textNode);
          }
        }
      }

      // Don't insert a line break, just leave cursor where the prefix was
      const updatedSelection = window.getSelection();
      if (updatedSelection?.rangeCount) {
        savedRangeRef.current = updatedSelection.getRangeAt(0).cloneRange();
      }
      const page = paragraph?.closest<HTMLElement>(".pdf-page");
      if (page) {
        const startPage = getLeadParagraphSegment(paragraph)?.closest<HTMLElement>(".pdf-page") ?? page;
        recomputePageLayout(startPage);
        syncActiveParagraphMetrics(paragraph);
      }
      syncToolbarStyle();
      return;
    }

    // ─── Paragraph split on Enter ──────────────────────────────────
    if (paragraph) {
      flushSnapshot();

      const split = splitParagraphAtCursor(paragraph);
      if (split) {
        const page = paragraph.closest<HTMLElement>(".pdf-page");
        if (page) {
          if (split.headParagraph !== paragraph) {
            // Cursor was at start: new empty <p> (head) goes before paragraph
            page.insertBefore(split.headParagraph, paragraph);
          } else {
            // Normal or cursor-at-end: tail goes after head
            const nextSibling = split.headParagraph.nextElementSibling;
            if (nextSibling) {
              page.insertBefore(split.tailParagraph, nextSibling);
            } else {
              page.appendChild(split.tailParagraph);
            }
          }

          // Place cursor at the start of the tail paragraph
          const newRange = document.createRange();
          newRange.setStart(split.tailParagraph, 0);
          newRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(newRange);

          setActiveParagraphId(split.tailParagraph.dataset.paragraphId || null);

          // Insert bullet prefix on the new paragraph
          if (bulletPrefix) {
            let prefixToInsert = bulletPrefix;
            if (isNumberedBullet && numberedMatch) {
              const nextNum = parseInt(numberedMatch[1], 10) + 1;
              prefixToInsert = bulletPrefix.replace(/\d+/, String(nextNum));
            }
            document.execCommand("insertText", false, prefixToInsert);
          }

          const startPage = getLeadParagraphSegment(split.headParagraph)?.closest<HTMLElement>(".pdf-page") ?? page;
          recomputePageLayout(startPage);
          syncActiveParagraphMetrics(split.tailParagraph);
        }
      }

      const updatedSelection = window.getSelection();
      if (updatedSelection?.rangeCount) {
        savedRangeRef.current = updatedSelection.getRangeAt(0).cloneRange();
      }
      syncToolbarStyle();
      scheduleSnapshot();
      return;
    }

    // ─── Text box: insert <br> ───────────────────────────────────
    if (textBoxEditor) {
      let inserted = false;

      if (typeof document.execCommand === "function") {
        nativeLineBreakInsertionRef.current = true;
        try {
          inserted = document.execCommand("insertLineBreak");
          if (!inserted) {
            inserted = document.execCommand("insertHTML", false, "<br>");
          }
        } finally {
          window.setTimeout(() => {
            nativeLineBreakInsertionRef.current = false;
          }, 0);
        }
      }

      if (!inserted) {
        range.deleteContents();
        const lineBreak = document.createElement("br");
        range.insertNode(lineBreak);

        const spacer = document.createTextNode("");
        lineBreak.parentNode?.insertBefore(spacer, lineBreak.nextSibling);

        const nextRange = document.createRange();
        nextRange.setStartAfter(lineBreak);
        nextRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(nextRange);
      }

      // Insert bullet prefix on the new line
      if (bulletPrefix) {
        let prefixToInsert = bulletPrefix;
        if (isNumberedBullet && numberedMatch) {
          const nextNum = parseInt(numberedMatch[1], 10) + 1;
          prefixToInsert = bulletPrefix.replace(/\d+/, String(nextNum));
        }
        document.execCommand("insertText", false, prefixToInsert);
      }

      const updatedSelection = window.getSelection();
      if (updatedSelection?.rangeCount) {
        savedRangeRef.current = updatedSelection.getRangeAt(0).cloneRange();
      }
      syncToolbarStyle();
    }
  }, [enableWrappingOnP, flushSnapshot, getLeadParagraphSegment, recomputePageLayout, scheduleSnapshot, splitParagraphAtCursor, syncActiveParagraphMetrics, syncToolbarStyle]);

  const insertTabAtSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!container || !editorRef.current?.contains(container)) return;

    const paragraph = container.closest<HTMLElement>(SEL_PAGE_P);
    const textBoxEditor = container.closest<HTMLElement>("[data-template-text-box-editor]");
    if (!paragraph && !textBoxEditor) return;

    if (paragraph) {
      enableWrappingOnP(paragraph);
    }

    range.deleteContents();
    const tabNode = document.createTextNode(TAB_INSERTION);
    range.insertNode(tabNode);

    const nextRange = document.createRange();
    nextRange.setStart(tabNode, tabNode.textContent?.length ?? 0);
    nextRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(nextRange);
    savedRangeRef.current = nextRange.cloneRange();
    activeEditableRef.current = textBoxEditor ?? editorRef.current;

    const page = paragraph?.closest<HTMLElement>(".pdf-page");
    if (page) {
      const startPage = getLeadParagraphSegment(paragraph)?.closest<HTMLElement>(".pdf-page") ?? page;
      recomputePageLayout(startPage);
      syncActiveParagraphMetrics(paragraph);
    }

    syncToolbarStyle();
    scheduleSnapshot();
  }, [enableWrappingOnP, getLeadParagraphSegment, recomputePageLayout, scheduleSnapshot, syncActiveParagraphMetrics, syncToolbarStyle]);

  const handleEditorKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    if (!target || !editorRef.current?.contains(target)) return;

    // Ctrl/Cmd+Z: undo; Ctrl/Cmd+Shift+Z or Ctrl+Y: redo
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) undoRedoHandlersRef.current.redo();
      else undoRedoHandlersRef.current.undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "y") {
      event.preventDefault();
      undoRedoHandlersRef.current.redo();
      return;
    }

    // Ctrl+A / Cmd+A: select all text in the active paragraph only, not the
    // whole page. Always preventDefault so the browser never selects everything.
    if ((event.ctrlKey || event.metaKey) && event.key === "a") {
      event.preventDefault();
      const activeParagraph = activeParagraphId
        ? editorRef.current?.querySelector<HTMLElement>(`[data-paragraph-id="${activeParagraphId}"]`) ?? null
        : null;
      const sel = window.getSelection();
      if (activeParagraph && sel) {
        const range = document.createRange();
        range.selectNodeContents(activeParagraph);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      return;
    }

    // ── Backspace / Delete across page boundaries ────────────────
    // The browser's native backspace/delete at a page boundary can move or
    // destroy paragraph elements because each .pdf-page is a separate block
    // container. Intercept these cases and perform a controlled merge instead.
    if (event.key === "Backspace" || event.key === "Delete") {
      const sel = window.getSelection();
      if (!sel?.rangeCount || !sel.isCollapsed) return; // let browser handle selections

      const range = sel.getRangeAt(0);
      const container = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      const paragraph = container?.closest<HTMLElement>(SEL_PAGE_P);
      const page = paragraph?.closest<HTMLElement>(".pdf-page");
      if (!paragraph || !page) return;

      const allPages = getEditorPages();
      const pageIndex = allPages.indexOf(page);

      if (event.key === "Backspace") {
        // Only intercept if cursor is at the very start of the paragraph AND
        // this paragraph is the first paragraph on the page (so backspace
        // would cross into the previous page).
        const offsetInParagraph = getOffsetWithinBlock(paragraph, range.startContainer, range.startOffset);
        if (offsetInParagraph !== 0) return; // not at start, let browser handle

        const pageParagraphs = getDirectParagraphs(page);
        const paragraphIndexInPage = pageParagraphs.indexOf(paragraph);

        if (paragraphIndexInPage === 0 && pageIndex > 0) {
          // Crossing into previous page, prevent the native backspace
          event.preventDefault();

          const prevPage = allPages[pageIndex - 1];
          const prevParagraphs = getDirectParagraphs(prevPage);
          if (prevParagraphs.length === 0) return;

          const targetParagraph = prevParagraphs[prevParagraphs.length - 1];

          // Enable wrapping on target paragraph if not already done
          enableWrappingOnP(targetParagraph, true);

          // Save cursor position: it should be at the end of the target paragraph's current text
          const cursorOffset = getNodeTextLength(targetParagraph);

          // Enable wrapping on source paragraph to merge its flow-group siblings first
          enableWrappingOnP(paragraph, true);
          const targetLogicalId = ensureParagraphIdentity(targetParagraph).logicalParagraphId;
          const sourceLogicalId = ensureParagraphIdentity(paragraph).logicalParagraphId;
          replaceLogicalParagraphId(sourceLogicalId, targetLogicalId);

          // Move all child nodes from source paragraph into target paragraph
          while (paragraph.firstChild) {
            targetParagraph.appendChild(paragraph.firstChild);
          }
          paragraph.remove();

          // Restore cursor at the merge point
          const pos = resolveOffsetWithinBlock(targetParagraph, cursorOffset);
          const newRange = document.createRange();
          newRange.setStart(pos.node, pos.offset);
          newRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(newRange);

          // Update height and repaginate from the previous page
          targetParagraph.dataset.baseHeight = String(targetParagraph.offsetHeight || 0);
          const startPage = getLeadParagraphSegment(targetParagraph)?.closest<HTMLElement>(".pdf-page") ?? prevPage;
          recomputePageLayout(startPage);
          syncActiveParagraphMetrics(targetParagraph);
          scheduleSnapshot();
          return;
        } else if (paragraphIndexInPage > 0) {
          // Merging with the previous paragraph on the SAME page, also needs
          // interception because absolute positioning confuses the browser.
          event.preventDefault();

          const targetParagraph = pageParagraphs[paragraphIndexInPage - 1];
          enableWrappingOnP(targetParagraph, true);
          const cursorOffset = getNodeTextLength(targetParagraph);
          enableWrappingOnP(paragraph, true);
          const targetLogicalId = ensureParagraphIdentity(targetParagraph).logicalParagraphId;
          const sourceLogicalId = ensureParagraphIdentity(paragraph).logicalParagraphId;
          replaceLogicalParagraphId(sourceLogicalId, targetLogicalId);

          while (paragraph.firstChild) {
            targetParagraph.appendChild(paragraph.firstChild);
          }
          paragraph.remove();

          const pos = resolveOffsetWithinBlock(targetParagraph, cursorOffset);
          const newRange = document.createRange();
          newRange.setStart(pos.node, pos.offset);
          newRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(newRange);

          targetParagraph.dataset.baseHeight = String(targetParagraph.offsetHeight || 0);
          const startPage = getLeadParagraphSegment(targetParagraph)?.closest<HTMLElement>(".pdf-page") ?? page;
          recomputePageLayout(startPage);
          syncActiveParagraphMetrics(targetParagraph);
          scheduleSnapshot();
          return;
        }
      }

      if (event.key === "Delete") {
        // Only intercept if cursor is at the very end of the paragraph AND
        // this paragraph is the last paragraph on the page.
        const offsetInParagraph = getOffsetWithinBlock(paragraph, range.startContainer, range.startOffset);
        const totalLength = getNodeTextLength(paragraph);
        if (offsetInParagraph < totalLength) return; // not at end, let browser handle

        const pageParagraphs = getDirectParagraphs(page);
        const paragraphIndexInPage = pageParagraphs.indexOf(paragraph);

        if (paragraphIndexInPage === pageParagraphs.length - 1 && pageIndex < allPages.length - 1) {
          // Crossing into next page
          event.preventDefault();

          const nextPage = allPages[pageIndex + 1];
          const nextParagraphs = getDirectParagraphs(nextPage);
          if (nextParagraphs.length === 0) return;

          const sourceParagraph = nextParagraphs[0];
          enableWrappingOnP(paragraph, true);
          const cursorOffset = getNodeTextLength(paragraph);
          enableWrappingOnP(sourceParagraph, true);
          const targetLogicalId = ensureParagraphIdentity(paragraph).logicalParagraphId;
          const sourceLogicalId = ensureParagraphIdentity(sourceParagraph).logicalParagraphId;
          replaceLogicalParagraphId(sourceLogicalId, targetLogicalId);

          while (sourceParagraph.firstChild) {
            paragraph.appendChild(sourceParagraph.firstChild);
          }
          sourceParagraph.remove();

          const pos = resolveOffsetWithinBlock(paragraph, cursorOffset);
          const newRange = document.createRange();
          newRange.setStart(pos.node, pos.offset);
          newRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(newRange);

          paragraph.dataset.baseHeight = String(paragraph.offsetHeight || 0);
          const startPage = getLeadParagraphSegment(paragraph)?.closest<HTMLElement>(".pdf-page") ?? page;
          recomputePageLayout(startPage);
          syncActiveParagraphMetrics(paragraph);
          scheduleSnapshot();
          return;
        } else if (paragraphIndexInPage < pageParagraphs.length - 1) {
          // Merging with the next paragraph on the SAME page
          event.preventDefault();

          const sourceParagraph = pageParagraphs[paragraphIndexInPage + 1];
          enableWrappingOnP(paragraph, true);
          const cursorOffset = getNodeTextLength(paragraph);
          enableWrappingOnP(sourceParagraph, true);
          const targetLogicalId = ensureParagraphIdentity(paragraph).logicalParagraphId;
          const sourceLogicalId = ensureParagraphIdentity(sourceParagraph).logicalParagraphId;
          replaceLogicalParagraphId(sourceLogicalId, targetLogicalId);

          while (sourceParagraph.firstChild) {
            paragraph.appendChild(sourceParagraph.firstChild);
          }
          sourceParagraph.remove();

          const pos = resolveOffsetWithinBlock(paragraph, cursorOffset);
          const newRange = document.createRange();
          newRange.setStart(pos.node, pos.offset);
          newRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(newRange);

          paragraph.dataset.baseHeight = String(paragraph.offsetHeight || 0);
          const startPage = getLeadParagraphSegment(paragraph)?.closest<HTMLElement>(".pdf-page") ?? page;
          recomputePageLayout(startPage);
          syncActiveParagraphMetrics(paragraph);
          scheduleSnapshot();
          return;
        }
      }
    }

    if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      insertTabAtSelection();
      return;
    }

    if (event.key !== "Enter" || (event.nativeEvent as KeyboardEvent).isComposing) return;

    const templateNameInput = target.closest('input[type="text"]');
    if (templateNameInput) return;

    event.preventDefault();
    insertManualLineBreak();
  }, [activeParagraphId, enableWrappingOnP, ensureParagraphIdentity, getDirectParagraphs, getEditorPages, getLeadParagraphSegment, insertManualLineBreak, insertTabAtSelection, recomputePageLayout, replaceLogicalParagraphId, scheduleSnapshot, syncActiveParagraphMetrics]);

  // ─── Insert Field ─────────────────────────────────────────────
  const handleInsertFieldClick = () => {
    const sel = window.getSelection();
    const range = sel?.rangeCount
      ? sel.getRangeAt(0).cloneRange()
      : savedRangeRef.current?.cloneRange() ?? null;
    if (range) {

      // Ignore clicks when cursor isn't inside a .pdf-page element
      const container = range.commonAncestorContainer;
      const inPage = (container instanceof Element ? container : container.parentElement)?.closest(".pdf-page");
      if (!inPage) return;

      savedRangeRef.current = range;

      // Detect if cursor is inside a repeater paragraph
      const repeaterP = (container instanceof Element ? container : container.parentElement)
        ?.closest<HTMLElement>("[data-repeater]");
      setActiveRepeaterContext(repeaterP?.getAttribute("data-repeater") ?? null);

      // If text is selected, wrap it in a highlight span so the user can
      // see exactly where the field will be inserted while the modal is open.
      if (!range.collapsed && editorRef.current?.contains(range.commonAncestorContainer)) {
        const highlight = document.createElement("span");
        highlight.setAttribute("data-pending-insert", "true");
        highlight.style.cssText =
          "background: rgba(99,102,241,0.18); border-radius: 2px; outline: 1.5px solid rgba(99,102,241,0.4);";
        const fragment = range.extractContents();
        highlight.appendChild(fragment);
        range.insertNode(highlight);
        pendingHighlightRef.current = highlight;
      }
    }
    setShowModal(true);
  };

  const clearPendingHighlight = useCallback(() => {
    const h = pendingHighlightRef.current;
    if (h && editorRef.current?.contains(h)) {
      const parent = h.parentNode;
      if (parent) {
        while (h.firstChild) parent.insertBefore(h.firstChild, h);
        parent.removeChild(h);
      }
    }
    pendingHighlightRef.current = null;
  }, []);

  // Keep beforeinput limited to style-only changes. Structural DOM edits here can
  // invalidate the browser's native insertion point and make the caret jump into
  // the following paragraph before the character is inserted. We defer the actual
  // paragraph merge/reflow work to handleEditorInput once the DOM contains the new
  // character and the selection is stable again.
  const handleEditorBeforeInput = useCallback((event: React.FormEvent<HTMLDivElement>) => {
    const nativeEvent = event.nativeEvent as InputEvent;
    // Prevent browser native undo/redo, our custom stack handles it via keyboard shortcuts.
    if (nativeEvent.inputType === "historyUndo" || nativeEvent.inputType === "historyRedo") {
      event.preventDefault();
      return;
    }
    if (nativeEvent.inputType === "insertParagraph" || nativeEvent.inputType === "insertLineBreak") {
      if (nativeLineBreakInsertionRef.current) return;
      event.preventDefault();
      insertManualLineBreak();
      return;
    }

    const sel = window.getSelection();
    if (sel?.rangeCount) {
      const range = sel.getRangeAt(0);
      prepareParagraphForInput(range.commonAncestorContainer);

      // Detect if a non-collapsed selection spans multiple paragraphs, 
    }
    saveCurrentRange();
  }, [insertManualLineBreak, prepareParagraphForInput, saveCurrentRange]);

  const handleEditorPaste = useCallback(async (e: React.ClipboardEvent<HTMLDivElement>) => {
    const { clipboardData } = e;

    // 1. Image files pasted from outside (e.g. screenshot, external app)
    const imageFile = Array.from(clipboardData.files).find((f) => f.type.startsWith("image/"));
    if (imageFile) {
      e.preventDefault();
      await insertImageFromFile(imageFile);
      return;
    }

    // 2. HTML containing template image objects (copy within the editor)
    const htmlData = clipboardData.getData("text/html");
    if (htmlData) {
      const parser = new DOMParser();
      const parsed = parser.parseFromString(htmlData, "text/html");
      const templateImages = parsed.querySelectorAll<HTMLElement>("[data-template-image-object-id]");
      if (templateImages.length > 0) {
        e.preventDefault();
        for (const imgEl of Array.from(templateImages)) {
          const img = imgEl.querySelector<HTMLImageElement>("img[data-template-object-image]");
          if (!img?.src) continue;
          try {
            const blob = await fetch(img.src).then((r) => r.blob());
            const file = new File([blob], "pasted-image", { type: blob.type || "image/png" });
            await insertImageFromFile(file);
          } catch {
            // If we can't fetch the image (e.g. CORS), skip it
          }
        }
        return;
      }

      // 3. Generic HTML paste, strip to plain text to avoid injecting random markup
      e.preventDefault();
      const text = clipboardData.getData("text/plain") || parsed.body.textContent || "";
      if (text) document.execCommand("insertText", false, text);
      return;
    }

    // 4. Plain text, allow default
  }, [insertImageFromFile]);

  const handleEditorClick = useCallback((e: React.MouseEvent) => {
    // If mousedown already handled this as a chip edge click, skip chip selection
    if (chipEdgeClickRef.current) {
      chipEdgeClickRef.current = false;
      return;
    }

    const target = e.target as Element;

    // Handle repeater-remove click
    const repeaterRemoveBtn = target.closest("[data-repeater-remove]");
    if (repeaterRemoveBtn) {
      const repeaterP = repeaterRemoveBtn.closest<HTMLElement>("[data-repeater]");
      if (repeaterP) handleRemoveRepeater(repeaterP);
      return;
    }

    const removeBtn = target.closest("[data-chip-remove]");
    if (removeBtn) {
      const chip = removeBtn.closest<HTMLElement>("[data-placeholder-chip]");
      if (chip?.getAttribute("data-placeholder-chip-selected") === "true") {
        selectChipElement(null);
      }
      chip?.remove();
      scanChipNames();
      syncToolbarStyle();
      return;
    }

    const chip = target.closest<HTMLElement>("[data-placeholder-chip]");
    if (chip) {
      selectChipElement(chip);
      setToolbarStyle(getToolbarStyleFromElement(chip, chip));
      return;
    }

    // While placing a textbox, suppress image selection entirely.
    if (textBoxMode) {
      return;
    }

    const directImageObject = target.closest<HTMLElement>(TEMPLATE_IMAGE_OBJECT_SELECTOR);
    const imageObject = directImageObject ?? getImageObjectAtPoint(e.clientX, e.clientY);
    if (imageObject) {
      setSelectedImageObjectId(imageObject.dataset.templateImageObjectId ?? null);
      return;
    }

    selectChipElement(null);
    if (!target.closest("[data-template-text-box-id]") && !target.closest(TEMPLATE_IMAGE_OBJECT_SELECTOR)) {
      saveCurrentRange();
      syncToolbarStyle();
    }
  }, [getImageObjectAtPoint, handleRemoveRepeater, saveCurrentRange, scanChipNames, selectChipElement, syncToolbarStyle, textBoxMode]);

  const handleInsert = useCallback((name: string) => {
    flushSnapshot();
    const chip = document.createElement("span");
    chip.setAttribute("data-placeholder-chip", name);
    chip.setAttribute("contentEditable", "false");
    chip.style.cssText =
      "display:inline-flex;align-items:center;gap:3px;text-decoration:underline dotted;text-underline-offset:3px;font-style:inherit;font-weight:inherit;color:inherit;vertical-align:baseline;";
    applyPlaceholderFieldStyle(chip, getNextFieldStyle());

    const label = document.createElement("span");
    label.textContent = `{${name}}`;
    label.style.cssText = "cursor:default;color:inherit;";

    const removeBtn = document.createElement("span");
    removeBtn.setAttribute("data-chip-remove", "true");
    removeBtn.textContent = "×";
    removeBtn.style.cssText =
      "cursor:pointer;font-size:0.9em;opacity:0.5;line-height:1;padding:0 1px;transition:opacity 0.15s;color:inherit;";
    removeBtn.addEventListener("mouseenter", () => { removeBtn.style.opacity = "1"; });
    removeBtn.addEventListener("mouseleave", () => { removeBtn.style.opacity = "0.5"; });

    chip.appendChild(label);
    chip.appendChild(removeBtn);

    const highlight = pendingHighlightRef.current;
    if (highlight && editorRef.current?.contains(highlight)) {
      // Replace the highlight span with the chip
      highlight.replaceWith(chip);
      pendingHighlightRef.current = null;
    } else {
      // Cursor-only insertion (no selection)
      const range = savedRangeRef.current;
      if (!range || !editorRef.current) return;
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      range.deleteContents();
      range.insertNode(chip);
    }

    // Switch the parent <p> to wrapping mode now that it contains a chip.
    enableWrappingOnP(chip);

    // Ensure zero-width space text nodes around the chip so the caret
    // can be placed on either side of it.  The ZWS provides a cursor
    // target, so we no longer need to strip <br> elements here, doing
    // so would destroy user-created line breaks (Enter).
    if (!chip.previousSibling || chip.previousSibling.nodeType !== Node.TEXT_NODE) {
      chip.parentNode?.insertBefore(document.createTextNode("\u200B"), chip);
    }
    if (!chip.nextSibling || chip.nextSibling.nodeType !== Node.TEXT_NODE) {
      chip.parentNode?.insertBefore(document.createTextNode("\u200B"), chip.nextSibling);
    }

    const sel = window.getSelection();
    const after = document.createRange();
    after.setStartAfter(chip);
    after.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(after);

    const appliedStyle = getPlaceholderFieldStyleFromElement(chip);
    applyFieldStylePreset(appliedStyle, fieldStylePresetCustomizedRef.current);
    selectChipElement(null);
    savedRangeRef.current = after.cloneRange();

    // Explicitly repaginate, onInput may not fire for programmatic insertions
    const chipParagraph = chip.closest<HTMLElement>(SEL_PAGE_P);
    const chipPage = chip.closest<HTMLElement>(".pdf-page");
    if (chipParagraph && chipPage) {
      chipParagraph.dataset.baseHeight = String(chipParagraph.offsetHeight || 0);
      const startPage = getLeadParagraphSegment(chipParagraph)?.closest<HTMLElement>(".pdf-page") ?? chipPage;
      recomputePageLayout(startPage);
    }

    scanChipNames();
    scheduleSnapshot();
  }, [applyFieldStylePreset, enableWrappingOnP, flushSnapshot, getLeadParagraphSegment, getNextFieldStyle, recomputePageLayout, scanChipNames, scheduleSnapshot, selectChipElement]);

  const handleToolbarButtonMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    saveCurrentRange();
  }, [saveCurrentRange]);

  const handleToolbarControlMouseDown = useCallback((e: React.MouseEvent) => {
    // Keep focus in the contenteditable for dropdowns etc. so the selection survives.
    // Do not preventDefault on native inputs, otherwise number fields never focus.
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select")) {
      saveCurrentRange();
      return;
    }
    e.preventDefault();
    saveCurrentRange();
  }, [saveCurrentRange]);

  const handleFontFamilyChange = useCallback((fontFamily: string) => {
    if (applySelectedPlaceholderChipMutation((chip) => {
      chip.style.fontFamily = getFontCss(fontFamily);
    })) {
      return;
    }

    const selectionSnapshot = getSelectionSnapshot();
    const activeEditable = getActiveEditable() ?? getSelectedTextBox()?.querySelector<HTMLElement>("[data-template-text-box-editor]");
    let rangeBefore: Range | null = null;
    const selBefore = window.getSelection();
    if (selBefore?.rangeCount) {
      try {
        rangeBefore = selBefore.getRangeAt(0).cloneRange();
      } catch {
        rangeBefore = null;
      }
    }
    if (!rangeBefore && savedRangeRef.current) {
      try {
        rangeBefore = savedRangeRef.current.cloneRange();
      } catch {
        rangeBefore = null;
      }
    }
    const collapsedParagraph = selectionSnapshot?.kind === "paragraph" && rangeBefore?.collapsed
      ? editorRef.current?.querySelector<HTMLElement>(`[data-paragraph-id="${selectionSnapshot.targetId}"]`) ?? null
      : null;
    if (collapsedParagraph && isParagraphAwaitingNewText(collapsedParagraph)) {
      flushSnapshot();
      collapsedParagraph.style.fontFamily = getFontCss(fontFamily);
      const paragraphPage = collapsedParagraph.closest<HTMLElement>(".pdf-page");
      if (paragraphPage) {
        const startPage = getLeadParagraphSegment(collapsedParagraph)?.closest<HTMLElement>(".pdf-page") ?? paragraphPage;
        recomputePageLayout(startPage);
        syncActiveParagraphMetrics(collapsedParagraph);
      }
      restoreSelectionSnapshot(selectionSnapshot);
      saveCurrentRange();
      applyCustomizedFieldStylePresetFromToolbar({ fontFamily });
      syncToolbarStyle();
      return;
    }
    const hadExplicitSelection = Boolean(rangeBefore && !rangeBefore.collapsed);
    const offsets =
      rangeBefore && activeEditable && activeEditable.contains(rangeBefore.commonAncestorContainer)
        ? getTextRangeCharOffsetsWithinRoot(activeEditable, rangeBefore)
        : null;

    runTextCommand("fontName", FONT_MARKER);
    if (activeEditable) {
      const markerFonts = Array.from(activeEditable.querySelectorAll(`font[face="${FONT_MARKER}"]`)) as HTMLElement[];

      const replacementSpans: HTMLElement[] = [];
      for (const font of markerFonts) {
        const span = document.createElement("span");
        span.style.fontFamily = getFontCss(fontFamily);
        while (font.firstChild) span.appendChild(font.firstChild);
        font.parentNode?.replaceChild(span, font);
        replacementSpans.push(span);
      }
      if (replacementSpans.length > 0) {
        const paragraph = replacementSpans[0]?.closest<HTMLElement>(SEL_PAGE_P);
        const page = paragraph?.closest<HTMLElement>(".pdf-page");
        if (paragraph && page) {
          const startPage = getLeadParagraphSegment(paragraph)?.closest<HTMLElement>(".pdf-page") ?? page;
          recomputePageLayout(startPage);
        }

        let restored = false;
        if (hadExplicitSelection) {
          restored = selectReplacementSpanRange(replacementSpans);
        }
        if (!restored && offsets) {
          restored = restoreTextRangeCharOffsetsWithinRoot(activeEditable, offsets.start, offsets.end);
        }
        if (!restored && replacementSpans.length === 1) {
          selectSingleReplacementSpan(replacementSpans[0]);
          restored = true;
        }
        if (!restored) {
          collapseCaretToEndOfElement(replacementSpans[replacementSpans.length - 1]);
        }
        const selAfter = window.getSelection();
        savedRangeRef.current = selAfter?.rangeCount ? selAfter.getRangeAt(0).cloneRange() : null;
        activeEditableRef.current = activeEditable;
        focusTemplateEditable(activeEditable);
      } else if (offsets && restoreTextRangeCharOffsetsWithinRoot(activeEditable, offsets.start, offsets.end)) {
        const selAfter = window.getSelection();
        savedRangeRef.current = selAfter?.rangeCount ? selAfter.getRangeAt(0).cloneRange() : null;
        activeEditableRef.current = activeEditable;
        focusTemplateEditable(activeEditable);
      } else if (!window.getSelection()?.toString()) {
        activeEditable.style.fontFamily = getFontCss(fontFamily);
      }
    }
    applyCustomizedFieldStylePresetFromToolbar({ fontFamily });
    syncToolbarStyle();
  }, [
    applyCustomizedFieldStylePresetFromToolbar,
    applySelectedPlaceholderChipMutation,
    flushSnapshot,
    getActiveEditable,
    getLeadParagraphSegment,
    getSelectedTextBox,
    getSelectionSnapshot,
    recomputePageLayout,
    restoreSelectionSnapshot,
    runTextCommand,
    saveCurrentRange,
    syncActiveParagraphMetrics,
    syncToolbarStyle,
  ]);

  const handleFontSizeChange = useCallback((fontSize: number) => {
    if (applySelectedPlaceholderChipMutation((chip) => {
      chip.style.fontSize = `${fontSize}px`;
    })) {
      return;
    }

    const selectionSnapshot = getSelectionSnapshot();
    const activeEditable = getActiveEditable() ?? getSelectedTextBox()?.querySelector<HTMLElement>("[data-template-text-box-editor]");
    let rangeBefore: Range | null = null;
    const selBefore = window.getSelection();
    if (selBefore?.rangeCount) {
      try {
        rangeBefore = selBefore.getRangeAt(0).cloneRange();
      } catch {
        rangeBefore = null;
      }
    }
    if (!rangeBefore && savedRangeRef.current) {
      try {
        rangeBefore = savedRangeRef.current.cloneRange();
      } catch {
        rangeBefore = null;
      }
    }
    const collapsedParagraph = selectionSnapshot?.kind === "paragraph" && rangeBefore?.collapsed
      ? editorRef.current?.querySelector<HTMLElement>(`[data-paragraph-id="${selectionSnapshot.targetId}"]`) ?? null
      : null;
    if (collapsedParagraph && isParagraphAwaitingNewText(collapsedParagraph)) {
      flushSnapshot();
      collapsedParagraph.style.fontSize = `${fontSize}px`;
      const paragraphPage = collapsedParagraph.closest<HTMLElement>(".pdf-page");
      if (paragraphPage) {
        const startPage = getLeadParagraphSegment(collapsedParagraph)?.closest<HTMLElement>(".pdf-page") ?? paragraphPage;
        recomputePageLayout(startPage);
        syncActiveParagraphMetrics(collapsedParagraph);
      }
      restoreSelectionSnapshot(selectionSnapshot);
      saveCurrentRange();
      applyCustomizedFieldStylePresetFromToolbar({ fontSize });
      syncToolbarStyle();
      return;
    }
    const hadExplicitSelection = Boolean(rangeBefore && !rangeBefore.collapsed);
    const offsets =
      rangeBefore && activeEditable && activeEditable.contains(rangeBefore.commonAncestorContainer)
        ? getTextRangeCharOffsetsWithinRoot(activeEditable, rangeBefore)
        : null;

    runTextCommand("fontSize", FONT_SIZE_MARKER);
    if (activeEditable) {
      const markerFonts = Array.from(activeEditable.querySelectorAll(`font[size="${FONT_SIZE_MARKER}"]`)) as HTMLElement[];

      const replacementSpans: HTMLElement[] = [];
      for (const font of markerFonts) {
        const span = document.createElement("span");
        span.style.fontSize = `${fontSize}px`;
        while (font.firstChild) span.appendChild(font.firstChild);
        font.parentNode?.replaceChild(span, font);
        replacementSpans.push(span);
      }
      if (replacementSpans.length > 0) {
        const paragraph = replacementSpans[0]?.closest<HTMLElement>(SEL_PAGE_P);
        const page = paragraph?.closest<HTMLElement>(".pdf-page");
        if (paragraph && page) {
          const startPage = getLeadParagraphSegment(paragraph)?.closest<HTMLElement>(".pdf-page") ?? page;
          recomputePageLayout(startPage);
        }

        let restored = false;
        if (hadExplicitSelection) {
          restored = selectReplacementSpanRange(replacementSpans);
        }
        if (!restored && offsets) {
          restored = restoreTextRangeCharOffsetsWithinRoot(activeEditable, offsets.start, offsets.end);
        }
        if (!restored && replacementSpans.length === 1) {
          selectSingleReplacementSpan(replacementSpans[0]);
          restored = true;
        }
        if (!restored) {
          collapseCaretToEndOfElement(replacementSpans[replacementSpans.length - 1]);
        }
        const selAfter = window.getSelection();
        savedRangeRef.current = selAfter?.rangeCount ? selAfter.getRangeAt(0).cloneRange() : null;
        activeEditableRef.current = activeEditable;
        focusTemplateEditable(activeEditable);
      } else if (offsets && restoreTextRangeCharOffsetsWithinRoot(activeEditable, offsets.start, offsets.end)) {
        const selAfter = window.getSelection();
        savedRangeRef.current = selAfter?.rangeCount ? selAfter.getRangeAt(0).cloneRange() : null;
        activeEditableRef.current = activeEditable;
        focusTemplateEditable(activeEditable);
      } else if (!window.getSelection()?.toString()) {
        activeEditable.style.fontSize = `${fontSize}px`;
      }
    }
    applyCustomizedFieldStylePresetFromToolbar({ fontSize });
    syncToolbarStyle();
  }, [
    applyCustomizedFieldStylePresetFromToolbar,
    applySelectedPlaceholderChipMutation,
    flushSnapshot,
    getActiveEditable,
    getLeadParagraphSegment,
    getSelectedTextBox,
    getSelectionSnapshot,
    recomputePageLayout,
    restoreSelectionSnapshot,
    runTextCommand,
    saveCurrentRange,
    syncActiveParagraphMetrics,
    syncToolbarStyle,
  ]);

  const handleBoldToggle = useCallback(() => {
    const nextIsBold = !toolbarStyle.isBold;
    if (applySelectedPlaceholderChipMutation((chip) => {
      chip.style.fontWeight = nextIsBold ? "700" : "400";
    })) {
      return;
    }

    runTextCommand("bold");
    applyCustomizedFieldStylePresetFromToolbar({ isBold: nextIsBold });
  }, [applyCustomizedFieldStylePresetFromToolbar, applySelectedPlaceholderChipMutation, runTextCommand, toolbarStyle.isBold]);

  const handleItalicToggle = useCallback(() => {
    const nextIsItalic = !toolbarStyle.isItalic;
    if (applySelectedPlaceholderChipMutation((chip) => {
      chip.style.fontStyle = nextIsItalic ? "italic" : "normal";
    })) {
      return;
    }

    runTextCommand("italic");
    applyCustomizedFieldStylePresetFromToolbar({ isItalic: nextIsItalic });
  }, [applyCustomizedFieldStylePresetFromToolbar, applySelectedPlaceholderChipMutation, runTextCommand, toolbarStyle.isItalic]);

  const handleUnderlineToggle = useCallback(() => {
    if (applySelectedPlaceholderChipMutation((chip) => {
      const wasUnderlined = chip.dataset.chipUnderline === "1";
      if (wasUnderlined) {
        delete chip.dataset.chipUnderline;
        chip.style.textDecorationLine = "underline";
        chip.style.textDecorationStyle = "dotted";
        chip.style.textUnderlineOffset = "3px";
      } else {
        chip.dataset.chipUnderline = "1";
        chip.style.textDecorationLine = "underline";
        chip.style.textDecorationStyle = "solid";
        chip.style.textUnderlineOffset = "3px";
      }
    })) {
      return;
    }

    // execCommand("underline") can't reliably override the link wrapper's
    // inline text-decoration. Toggle it directly on the wrapper instead.
    const saved = savedRangeRef.current;
    const savedAnchor = saved?.commonAncestorContainer instanceof Element
      ? saved.commonAncestorContainer
      : saved?.commonAncestorContainer?.parentElement;
    const linkWrapper = savedAnchor?.closest<HTMLElement>("[data-link-href]");

    if (linkWrapper) {
      flushSnapshot();
      const wasUnderlined = linkWrapper.style.textDecoration?.includes("underline");
      linkWrapper.style.textDecoration = wasUnderlined ? "none" : "underline";
      saveCurrentRange();
      syncToolbarStyle();
      return;
    }

    runTextCommand("underline");
  }, [applySelectedPlaceholderChipMutation, flushSnapshot, runTextCommand, saveCurrentRange, syncToolbarStyle]);

  const insertPlainTextAtCursor = useCallback((text: string) => {
    flushSnapshot();
    restoreSavedRange();
    const activeEditable = getActiveEditable() ?? getSelectedTextBox()?.querySelector<HTMLElement>("[data-template-text-box-editor]");
    if (!activeEditable) return;
    focusTemplateEditable(activeEditable);

    if (!document.execCommand("insertText", false, text)) {
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(document.createTextNode(text));
        r.collapse(false);
      }
    }

    saveCurrentRange();
    syncToolbarStyle();
  }, [flushSnapshot, getActiveEditable, getSelectedTextBox, restoreSavedRange, saveCurrentRange, syncToolbarStyle]);

  const handleBulletListToggle = useCallback(() => {
    insertPlainTextAtCursor("• ");
  }, [insertPlainTextAtCursor]);

  const handleNumberedListToggle = useCallback(() => {
    insertPlainTextAtCursor("1. ");
  }, [insertPlainTextAtCursor]);

  const handleColorChange = useCallback((color: string) => {
    if (applySelectedPlaceholderChipMutation((chip) => {
      chip.style.color = color;
      chip.style.textDecorationColor = color;
    })) {
      return;
    }

    // execCommand("foreColor") can't reliably override inline colors on
    // link wrapper spans and their children.  Manipulate the DOM directly.
    const saved = savedRangeRef.current;
    const savedAnchor = saved?.commonAncestorContainer instanceof Element
      ? saved.commonAncestorContainer
      : saved?.commonAncestorContainer?.parentElement;
    const linkWrapper = savedAnchor?.closest<HTMLElement>("[data-link-href]");

    if (linkWrapper && saved) {
      flushSnapshot();
      const linkText = linkWrapper.textContent || "";
      const selectedText = saved.toString();

      if (saved.collapsed || selectedText.length >= linkText.trim().length) {
        // Entire link (or cursor with no selection): change everything
        linkWrapper.style.color = color;
        linkWrapper.querySelectorAll<HTMLElement>("*").forEach((el) => {
          if (el.style.color) el.style.color = color;
        });
      } else {
        // Partial selection: extract selected content, restyle, reinsert
        restoreSavedRange();
        const sel = window.getSelection();
        if (sel?.rangeCount) {
          const range = sel.getRangeAt(0).cloneRange();
          const fragment = range.extractContents();
          const colorSpan = document.createElement("span");
          colorSpan.style.color = color;
          // Clear old hardcoded color from extracted children
          fragment.querySelectorAll<HTMLElement>("*").forEach((el) => {
            if (el.style.color) el.style.color = "";
          });
          colorSpan.appendChild(fragment);
          range.insertNode(colorSpan);

          // Place caret after the newly inserted content
          const newRange = document.createRange();
          newRange.selectNodeContents(colorSpan);
          newRange.collapse(false);
          sel.removeAllRanges();
          sel.addRange(newRange);
        }
      }

      saveCurrentRange();
      syncToolbarStyle();
      return;
    }

    runTextCommand("foreColor", color);
    const activeEditable = getActiveEditable() ?? getSelectedTextBox()?.querySelector<HTMLElement>("[data-template-text-box-editor]");
    if (activeEditable && !window.getSelection()?.toString()) {
      activeEditable.style.color = color;
    }
    applyCustomizedFieldStylePresetFromToolbar({ color });
    syncToolbarStyle();
  }, [applyCustomizedFieldStylePresetFromToolbar, applySelectedPlaceholderChipMutation, flushSnapshot, getActiveEditable, getSelectedTextBox, restoreSavedRange, runTextCommand, saveCurrentRange, syncToolbarStyle]);

  const handleLineSpacingChange = useCallback((lineHeight: string) => {
    const textBoxEditor = getSelectedTextBox()?.querySelector<HTMLElement>("[data-template-text-box-editor]");
    if (textBoxEditor) {
      textBoxEditor.style.lineHeight = lineHeight;
      syncToolbarStyle();
      return;
    }

    const paragraph = getActiveParagraph();
    const page = paragraph?.closest<HTMLElement>(".pdf-page");
    if (paragraph && page) {
      enableWrappingOnP(paragraph);

      const targetParagraph = getActiveParagraph() ?? paragraph;
      const targetParagraphs = getLinkedParagraphSegments(targetParagraph);

      for (const target of targetParagraphs) {
        target.style.lineHeight = lineHeight;
      }

      // Use the first live paragraph in the group (the original may have been
      // merged away and detached from the DOM by enableWrappingOnP).
      const liveParagraph = targetParagraphs.find((candidate) => candidate.dataset.paragraphId === activeParagraphId)
        ?? targetParagraphs[0]
        ?? targetParagraph;
      const startPage = getLeadParagraphSegment(targetParagraph)?.closest<HTMLElement>(".pdf-page") ?? page;
      recomputePageLayout(startPage);
      syncActiveParagraphMetrics(liveParagraph);
      syncToolbarStyle();
      return;
    }

    const activeEditable = getActiveEditable();
    if (activeEditable) {
      activeEditable.style.lineHeight = lineHeight;
      syncToolbarStyle();
    }
  }, [activeParagraphId, enableWrappingOnP, getActiveEditable, getActiveParagraph, getLeadParagraphSegment, getLinkedParagraphSegments, getSelectedTextBox, recomputePageLayout, syncActiveParagraphMetrics, syncToolbarStyle]);

  const getSelectedParagraphs = useCallback((): HTMLElement[] => {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return [];
    const range = sel.getRangeAt(0);

    const allPages = getEditorPages();
    const allParagraphs: HTMLElement[] = [];
    for (const page of allPages) {
      for (const p of getDirectParagraphs(page)) {
        allParagraphs.push(p);
      }
    }

    return allParagraphs.filter((p) => {
      const pRange = document.createRange();
      pRange.selectNodeContents(p);
      return (
        range.compareBoundaryPoints(Range.END_TO_START, pRange) <= 0 &&
        range.compareBoundaryPoints(Range.START_TO_END, pRange) >= 0
      );
    });
  }, [getDirectParagraphs, getEditorPages]);

  const handleSpaceBeforeChange = useCallback((value: number) => {
    const clamped = Math.max(0, Math.round(value));

    // Multi-paragraph selection: apply to the FIRST selected paragraph only
    const sel = window.getSelection();
    const selectedParagraphs = sel && !sel.isCollapsed ? getSelectedParagraphs() : [];
    if (selectedParagraphs.length > 1) {
      const firstP = selectedParagraphs[0];
      firstP.dataset.baseGapBefore = String(clamped);
      const page = firstP.closest<HTMLElement>(".pdf-page");
      if (page) recomputePageLayout(page);
      syncToolbarStyle();
      scheduleSnapshot();
      return;
    }

    // Single paragraph
    const paragraph = getActiveParagraph();
    const page = paragraph?.closest<HTMLElement>(".pdf-page");
    if (!paragraph || !page) return;

    const leadParagraph = getLeadParagraphSegment(paragraph) ?? paragraph;
    leadParagraph.dataset.baseGapBefore = String(clamped);

    const startPage = leadParagraph.closest<HTMLElement>(".pdf-page") ?? page;
    recomputePageLayout(startPage);
    syncActiveParagraphMetrics(paragraph);
    syncToolbarStyle();
    scheduleSnapshot();
  }, [getActiveParagraph, getLeadParagraphSegment, getSelectedParagraphs, recomputePageLayout, scheduleSnapshot, syncActiveParagraphMetrics, syncToolbarStyle]);

  const findNextParagraph = useCallback((paragraph: HTMLElement): HTMLElement | null => {
    const page = paragraph.closest<HTMLElement>(".pdf-page");
    if (!page) return null;
    const pageParagraphs = getDirectParagraphs(page);
    const idx = pageParagraphs.indexOf(paragraph);
    if (idx >= 0 && idx < pageParagraphs.length - 1) return pageParagraphs[idx + 1];
    const allPages = getEditorPages();
    const pageIdx = allPages.indexOf(page);
    if (pageIdx >= 0 && pageIdx < allPages.length - 1) {
      return getDirectParagraphs(allPages[pageIdx + 1])[0] ?? null;
    }
    return null;
  }, [getDirectParagraphs, getEditorPages]);

  const handleSpaceAfterChange = useCallback((value: number) => {
    const clamped = Math.max(0, Math.round(value));

    // Multi-paragraph selection: apply spaceAfter to the LAST selected paragraph
    const sel = window.getSelection();
    const selectedParagraphs = sel && !sel.isCollapsed ? getSelectedParagraphs() : [];
    const target = selectedParagraphs.length > 1
      ? selectedParagraphs[selectedParagraphs.length - 1]
      : getActiveParagraph();
    if (!target) return;

    const nextP = findNextParagraph(target);
    if (!nextP) return;

    nextP.dataset.baseGapBefore = String(clamped);
    const page = target.closest<HTMLElement>(".pdf-page");
    if (page) {
      recomputePageLayout(page);
      syncActiveParagraphMetrics(target);
    }
    syncToolbarStyle();
    scheduleSnapshot();
  }, [findNextParagraph, getActiveParagraph, getSelectedParagraphs, recomputePageLayout, scheduleSnapshot, syncActiveParagraphMetrics, syncToolbarStyle]);

  const handleTextAlignChange = useCallback((textAlign: string) => {
    const textBoxEditor = getSelectedTextBox()?.querySelector<HTMLElement>("[data-template-text-box-editor]");
    if (textBoxEditor) {
      textBoxEditor.style.textAlign = textAlign;
      syncToolbarStyle();
      return;
    }

    const paragraph = getActiveParagraph();
    const page = paragraph?.closest<HTMLElement>(".pdf-page");
    if (paragraph && page) {
      enableWrappingOnP(paragraph);

      const targetParagraph = getActiveParagraph() ?? paragraph;
      const targetParagraphs = getLinkedParagraphSegments(targetParagraph);

      for (const target of targetParagraphs) {
        target.style.textAlign = textAlign;
      }

      const liveParagraph = targetParagraphs.find((candidate) => candidate.dataset.paragraphId === activeParagraphId)
        ?? targetParagraphs[0]
        ?? targetParagraph;
      const startPage = getLeadParagraphSegment(targetParagraph)?.closest<HTMLElement>(".pdf-page") ?? page;
      recomputePageLayout(startPage);
      syncActiveParagraphMetrics(liveParagraph);
      syncToolbarStyle();
      return;
    }

    const activeEditable = getActiveEditable();
    if (activeEditable) {
      activeEditable.style.textAlign = textAlign;
      syncToolbarStyle();
    }
  }, [activeParagraphId, enableWrappingOnP, getActiveEditable, getActiveParagraph, getLeadParagraphSegment, getLinkedParagraphSegments, getSelectedTextBox, recomputePageLayout, syncActiveParagraphMetrics, syncToolbarStyle]);

  const handleInsertLink = useCallback(() => {
    // Use the range saved during mouseDown (savedRangeRef), by the time onClick
    // fires the live selection may already be collapsed.
    const saved = savedRangeRef.current;
    const editable = activeEditableRef.current ?? getActiveEditable() ?? getSelectedTextBox()?.querySelector<HTMLElement>("[data-template-text-box-editor]");
    if (!editable || !saved) return;

    const selectionElement = saved.commonAncestorContainer instanceof Element
      ? saved.commonAncestorContainer
      : saved.commonAncestorContainer.parentElement;
    const existingLink = selectionElement?.closest<HTMLElement>("[data-link-href]")
      ?? selectionElement?.closest<HTMLAnchorElement>("a")
      ?? null;
    const selectionWasCollapsed = saved.collapsed;
    const suggestedHref = existingLink?.getAttribute("data-link-href") || existingLink?.getAttribute("data-href") || existingLink?.getAttribute("href") || "https://";

    // Compute character offsets from the saved range (not the live selection).
    const root = editable.closest<HTMLElement>(".pdf-page") ? editorRef.current : editable;
    let startOffset = 0;
    let endOffset = 0;
    if (root) {
      try {
        const pre = document.createRange();
        pre.setStart(root, 0);
        pre.setEnd(saved.startContainer, saved.startOffset);
        startOffset = pre.toString().length;
        const preEnd = document.createRange();
        preEnd.setStart(root, 0);
        preEnd.setEnd(saved.endContainer, saved.endOffset);
        endOffset = preEnd.toString().length;
      } catch { /* fallback to 0 */ }
    }

    linkContextRef.current = { existingLink, selectionWasCollapsed, editable: root, startOffset, endOffset };
    setLinkUrlInput(suggestedHref);
    setShowLinkModal(true);
  }, [getActiveEditable, getSelectedTextBox]);

  const handleLinkModalSubmit = useCallback(() => {
    const ctx = linkContextRef.current;
    if (!ctx) return;

    const rawHref = linkUrlInput;
    const href = normalizeLinkHref(rawHref);
    if (!href) {
      setShowLinkModal(false);
      linkContextRef.current = null;
      syncToolbarStyle();
      return;
    }

    // Close modal first so focus can return to the editor, then insert link
    // after the modal is removed from the DOM.
    setShowLinkModal(false);
    linkContextRef.current = null;

    requestAnimationFrame(() => {
      const root = ctx.editable ?? editorRef.current;
      if (!root) return;
      root.focus();

      // Restore selection from saved character offsets.
      const walkToOffset = (container: Node, offset: number): { node: Node; offset: number } | null => {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let remaining = offset;
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const t = node as Text;
          if (remaining <= t.length) return { node: t, offset: remaining };
          remaining -= t.length;
        }
        return null;
      };

      const sel = window.getSelection();
      if (!sel) return;

      const startPos = walkToOffset(root, ctx.startOffset);
      const endPos = ctx.startOffset === ctx.endOffset ? startPos : walkToOffset(root, ctx.endOffset);

      if (startPos && endPos) {
        const range = document.createRange();
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, endPos.offset);
        sel.removeAllRanges();
        sel.addRange(range);
        savedRangeRef.current = range.cloneRange();
      } else {
        restoreSavedRange();
      }

      if (ctx.existingLink && ctx.selectionWasCollapsed) {
        ctx.existingLink.setAttribute("data-link-href", href);
        ctx.existingLink.style.textDecoration = "underline";
        ctx.existingLink.style.color = "#2563eb";
        ctx.existingLink.style.userSelect = "text";
        ctx.existingLink.style.setProperty("-webkit-user-select", "text");
        ctx.existingLink.querySelectorAll<HTMLElement>("span[style]").forEach((s) => { s.style.color = "#2563eb"; });
        saveCurrentRange();
        syncToolbarStyle();
        return;
      }

      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);

      if (range.collapsed) {
        const linkSpan = document.createElement("span");
        linkSpan.setAttribute("data-link-href", href);
        linkSpan.style.textDecoration = "underline";
        linkSpan.style.color = "#2563eb";
        linkSpan.textContent = href;
        range.insertNode(linkSpan);
        enableWrappingOnP(linkSpan);
      } else {
        // Use the browser's built-in createLink which handles all edge cases
        // (full paragraph, partial selection, cross-span ranges, etc.)
        document.execCommand("createLink", false, href);

        // The browser wraps the selection in <a href="...">. Convert those
        // to data-link-href spans so they don't interfere with editing.
        const editor = editorRef.current;
        if (editor) {
          editor.querySelectorAll<HTMLAnchorElement>(`a[href="${CSS.escape(href)}"]`).forEach((a) => {
            const span = document.createElement("span");
            span.setAttribute("data-link-href", href);
            span.style.textDecoration = "underline";
            span.style.color = "#2563eb";
            while (a.firstChild) span.appendChild(a.firstChild);
            a.replaceWith(span);
            // Also color child spans
            span.querySelectorAll<HTMLElement>("span[style]").forEach((s) => {
              s.style.color = "#2563eb";
            });
          });
        }
      }

      saveCurrentRange();
      syncToolbarStyle();
    });
  }, [linkUrlInput, enableWrappingOnP, restoreSavedRange, saveCurrentRange, syncToolbarStyle]);

  const handleParagraphBarrierChange = useCallback((nextLeft: number, nextWidth: number) => {
    if (!activeParagraphId) return;
    const paragraph = editorRef.current?.querySelector<HTMLElement>(`[data-paragraph-id="${activeParagraphId}"]`);
    const page = paragraph?.closest<HTMLElement>(".pdf-page");
    if (!paragraph || !page) return;

    const targetParagraphs = getLinkedParagraphSegments(paragraph);
    const currentPageWidth = Number.parseFloat(page.style.width || String(page.offsetWidth || 0));

    for (const target of targetParagraphs) {
      target.style.left = `${nextLeft}px`;
      target.style.width = `${nextWidth}px`;
      target.style.maxWidth = `${nextWidth}px`;
      target.dataset.wrapEnabled = "1";
      target.dataset.manualRulerBounds = "1";
      applyParagraphWrapStyles(target);
    }

    setActiveParagraphMetrics({
      id: paragraph.dataset.paragraphId || "",
      left: nextLeft,
      width: nextWidth,
      pageWidth: currentPageWidth,
    });
  }, [activeParagraphId, getLinkedParagraphSegments]);

  const handleParagraphBarrierCommit = useCallback(() => {
    if (!activeParagraphId) return;
    const paragraph = editorRef.current?.querySelector<HTMLElement>(`[data-paragraph-id="${activeParagraphId}"]`);
    const page = paragraph?.closest<HTMLElement>(".pdf-page");
    if (!paragraph || !page) return;

    const startPage = getLeadParagraphSegment(paragraph)?.closest<HTMLElement>(".pdf-page") ?? page;
    recomputePageLayout(startPage);
    syncActiveParagraphMetrics(paragraph);
    scheduleSnapshot();
  }, [activeParagraphId, getLeadParagraphSegment, recomputePageLayout, scheduleSnapshot, syncActiveParagraphMetrics]);

  const refreshEditorAfterHistoryChange = useCallback(() => {
    scanChipNames();

    const pages = getEditorPages();
    if (pages.length > 0) {
      repaginateFromPage(pages[0]);
    }

    const selectionNode = getSelectionElement();
    const selectedChip = selectionNode?.closest<HTMLElement>("[data-placeholder-chip]") ?? getSelectedPlaceholderChip();
    if (selectedChip) {
      selectChipElement(selectedChip);
      setSelectedTextBoxId(selectedChip.closest<HTMLElement>("[data-template-text-box-id]")?.dataset.templateTextBoxId ?? null);
      const paragraph = selectedChip.closest<HTMLElement>(SEL_PAGE_P) ?? null;
      setActiveParagraphId(paragraph?.dataset.paragraphId ?? null);
      syncActiveParagraphMetrics(paragraph);
      syncActivePage(selectedChip.closest<HTMLElement>(".pdf-page"));
      setToolbarStyle(getToolbarStyleFromElement(selectedChip, selectedChip));
      saveCurrentRange();
      return;
    }

    selectChipElement(null);
    const textBox = selectionNode?.closest<HTMLElement>("[data-template-text-box-id]") ?? null;
    if (textBox) {
      setSelectedTextBoxId(textBox.dataset.templateTextBoxId ?? null);
      setActiveParagraphId(null);
      setActiveParagraphMetrics(null);
      syncActivePage(textBox.closest<HTMLElement>(".pdf-page"));
    } else {
      const paragraph = selectionNode?.closest<HTMLElement>(SEL_PAGE_P) ?? null;
      setSelectedTextBoxId(null);
      setActiveParagraphId(paragraph?.dataset.paragraphId ?? null);
      syncActiveParagraphMetrics(paragraph);
      syncActivePage(paragraph?.closest<HTMLElement>(".pdf-page"));
    }

    syncToolbarStyle();
    saveCurrentRange();
  }, [getEditorPages, getSelectedPlaceholderChip, getSelectionElement, repaginateFromPage, saveCurrentRange, scanChipNames, selectChipElement, syncActivePage, syncActiveParagraphMetrics, syncToolbarStyle]);

  const handleUndo = useCallback(() => {
    const hist = customHistoryRef.current;
    // Flush any pending debounced snapshot so current state is saved before going back.
    if (hist.debounceTimer) {
      clearTimeout(hist.debounceTimer);
      hist.debounceTimer = null;
      flushSnapshot();
    }
    // If there's unsaved content, save it first.
    const currentHtml = editorRef.current?.innerHTML ?? "";
    if (hist.index >= 0 && hist.snapshots[hist.index].html !== currentHtml) {
      flushSnapshot();
    }
    if (hist.index <= 0) return;
    hist.index--;
    const snap = hist.snapshots[hist.index];
    if (editorRef.current) {
      editorRef.current.innerHTML = snap.html;
      requestAnimationFrame(() => {
        refreshEditorAfterHistoryChange();
        restoreCursorToOffset(snap.cursorPos);
      });
    }
  }, [flushSnapshot, refreshEditorAfterHistoryChange, restoreCursorToOffset]);

  const handleRedo = useCallback(() => {
    const hist = customHistoryRef.current;
    if (hist.debounceTimer) {
      clearTimeout(hist.debounceTimer);
      hist.debounceTimer = null;
    }
    if (hist.index >= hist.snapshots.length - 1) return;
    hist.index++;
    const snap = hist.snapshots[hist.index];
    if (editorRef.current) {
      editorRef.current.innerHTML = snap.html;
      requestAnimationFrame(() => {
        refreshEditorAfterHistoryChange();
        restoreCursorToOffset(snap.cursorPos);
      });
    }
  }, [refreshEditorAfterHistoryChange, restoreCursorToOffset]);

  // Keep the ref current every render so the shared editor key handler can call through it
  // without creating a circular hook dependency.
   
  undoRedoHandlersRef.current = { undo: handleUndo, redo: handleRedo };

  const handlePageTopBoundaryChange = useCallback((nextTop: number) => {
    const pages = getEditorPages();
    if (pages.length === 0) return;

    const activePage = pages.find((page) => {
      const pageIndex = Number.parseInt(page.dataset.pageIndex || "", 10);
      return Number.isFinite(pageIndex) && pageIndex + 1 === activePageNumber;
    }) ?? pages[0];
    const currentBottom = getPageContentBottom(activePage);
    const clamped = Math.min(Math.max(0, nextTop), Math.max(160, currentBottom - 160));

    activePage.dataset.baseContentTop = String(clamped);
    setPageContentTop(clamped);
    repaginateFromPage(activePage);
    syncActivePage(activePage);
  }, [activePageNumber, getEditorPages, getPageContentBottom, repaginateFromPage, syncActivePage]);

  const handlePageBoundaryChange = useCallback((nextBottom: number) => {
    const pages = getEditorPages();
    if (pages.length === 0) return;

    const activePage = pages.find((page) => {
      const pageIndex = Number.parseInt(page.dataset.pageIndex || "", 10);
      return Number.isFinite(pageIndex) && pageIndex + 1 === activePageNumber;
    }) ?? pages[0];
    const minBottom = Math.max(getPageBaseContentTop(activePage) + 160, 220);
    const maxBottom = Math.max(minBottom, (Number.parseFloat(activePage.dataset.baseMinHeight || activePage.style.minHeight || "0") || activePage.offsetHeight || 0) - 24);
    const clampedBottom = Math.min(maxBottom, Math.max(minBottom, nextBottom));

    activePage.dataset.baseContentBottom = String(clampedBottom);
    activePage.dataset.baseContentBottomSource = "manual";
    setPageContentBottom(clampedBottom);
    repaginateFromPage(activePage);
    syncActivePage(activePage);
  }, [activePageNumber, getEditorPages, getPageBaseContentTop, repaginateFromPage, syncActivePage]);

  // ─── Save Template ────────────────────────────────────────────
  const handleSave = async () => {
    if (!templateName.trim()) {
      setNameError(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const editorClone = editorRef.current?.cloneNode(true) as HTMLDivElement | null;
      editorClone?.querySelectorAll("[data-template-text-box-control]").forEach((node) => node.remove());
      editorClone?.querySelectorAll("[data-template-image-control]").forEach((node) => node.remove());
      editorClone?.querySelectorAll("[data-template-image-layer-menu]").forEach((node) => node.remove());
      editorClone?.querySelectorAll<HTMLElement>("[data-template-text-box-id]").forEach((box) => {
        box.style.outline = "none";
        box.style.boxShadow = "none";
        box.removeAttribute("data-template-text-box-hydrated");
      });
      editorClone?.querySelectorAll<HTMLElement>(TEMPLATE_IMAGE_OBJECT_SELECTOR).forEach((object) => {
        object.style.outline = "none";
        object.style.boxShadow = "none";
        object.removeAttribute("data-template-image-hydrated");
      });
      editorClone?.querySelectorAll<HTMLElement>("[data-placeholder-chip]").forEach((chip) => {
        chip.style.outline = "none";
        chip.style.boxShadow = "none";
        chip.removeAttribute("data-placeholder-chip-selected");
        // Restore chip label to {field_name} in case fill-preview values were applied
        const chipName = chip.getAttribute("data-placeholder-chip") ?? "";
        if (chipName) {
          const textSpan = chip.firstElementChild as HTMLElement | null;
          if (textSpan && !textSpan.hasAttribute("data-chip-remove")) {
            textSpan.textContent = `{${chipName}}`;
          }
        }
      });

      // Strip repeater visual elements and auto-prefix un-prefixed chips
      const repeaters: { name: string; fields: string[] }[] = [];
      const seenRepeaterNames = new Set<string>();
      editorClone?.querySelectorAll<HTMLElement>("[data-repeater]").forEach((p) => {
        const rName = p.getAttribute("data-repeater") ?? "";
        p.querySelector("[data-repeater-label]")?.remove();
        p.style.removeProperty("border-left");
        p.style.removeProperty("background");
        if (rName) {
          seenRepeaterNames.add(rName);
          // Auto-prefix chips inside this repeater that are missing the prefix
          p.querySelectorAll<HTMLElement>("[data-placeholder-chip]").forEach((chip) => {
            const current = chip.getAttribute("data-placeholder-chip") ?? "";
            if (current && !current.startsWith(rName + ".")) {
              const prefixed = `${rName}.${current}`;
              chip.setAttribute("data-placeholder-chip", prefixed);
              const textSpan = chip.firstElementChild as HTMLElement | null;
              if (textSpan && !textSpan.hasAttribute("data-chip-remove")) {
                textSpan.textContent = `{${prefixed}}`;
              }
            }
          });
        }
      });

      // Collect repeater fields from ALL chips that match a known repeater prefix
      for (const rName of seenRepeaterNames) {
        const rFields: string[] = [];
        editorClone?.querySelectorAll("[data-placeholder-chip]").forEach((chip) => {
          const fullName = chip.getAttribute("data-placeholder-chip") ?? "";
          if (fullName.startsWith(rName + ".")) {
            const subField = fullName.slice(rName.length + 1);
            if (subField && !rFields.includes(subField)) rFields.push(subField);
          }
        });
        repeaters.push({ name: rName, fields: rFields });
      }

      // Re-scan chip names from the clone (after auto-prefixing)
      const cloneChipNames: string[] = [];
      const cloneChipSeen = new Set<string>();
      editorClone?.querySelectorAll("[data-placeholder-chip]").forEach((chip) => {
        const n = chip.getAttribute("data-placeholder-chip") ?? "";
        if (n && !cloneChipSeen.has(n)) { cloneChipSeen.add(n); cloneChipNames.push(n); }
      });

      // Group consecutive [data-link-href] spans with the same URL into <a> tags.
      if (editorClone) {
        const linkSpans = Array.from(editorClone.querySelectorAll<HTMLElement>("[data-link-href]"));
        const processed = new Set<HTMLElement>();
        for (const span of linkSpans) {
          if (processed.has(span)) continue;
          const href = span.getAttribute("data-link-href")!;
          const group: HTMLElement[] = [span];
          processed.add(span);
          // Collect consecutive siblings with the same href
          let next = span.nextSibling;
          while (next) {
            if (next instanceof HTMLElement && next.getAttribute("data-link-href") === href) {
              group.push(next);
              processed.add(next);
              next = next.nextSibling;
            } else if (next.nodeType === Node.TEXT_NODE && next.textContent?.trim() === "") {
              // skip whitespace text nodes between link spans
              next = next.nextSibling;
            } else {
              break;
            }
          }
          const a = document.createElement("a");
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.style.textDecoration = "underline";
          a.style.color = "#2563eb";
          span.before(a);
          for (const s of group) {
            s.removeAttribute("data-link-href");
            a.appendChild(s);
          }
        }
      }

      // Strip the stashed width attribute from gap spans in the saved clone
      editorClone?.querySelectorAll<HTMLElement>("[data-pdf-gap]").forEach((gap) => {
        delete gap.dataset.pdfGapWidth;
      });

      // Strip zero-width spaces used as caret targets around chips
      if (editorClone) stripZeroWidthSpaces(editorClone);
      if (editorClone) stripTemplateImagePreviewSources(editorClone);

      const editorContent = editorClone?.innerHTML ?? "";
      const fullHtml = exportHtml.replace(
        /<body[^>]*>[\s\S]*<\/body>/i,
        `<body>${editorContent}</body>`
      );
      const payload = {
        name: templateName.trim(),
        html: fullHtml,
        fields: cloneChipNames,
        repeaters,
        ...(folderId !== undefined && !templateId ? { folderId } : {}),
      };
      // If a DOCX was uploaded, the template already exists, update it
      const existingId = templateId || docxTemplateIdRef.current;
      const savedTemplate = existingId
        ? await wordTemplatesService.update(lawFirmId, existingId, payload)
        : await wordTemplatesService.create(lawFirmId, payload);
      setTemplateAssets(savedTemplate.assets ?? []);
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save template."));
    } finally {
      setSaving(false);
    }
  };

  // ─── DOCX Save ────────────────────────────────────────────────
  const handleDocxSave = async () => {
    if (!templateName.trim()) {
      setNameError(true);
      return;
    }
    const tid = docxTemplateIdRef.current;
    if (!tid) {
      setError("No DOCX template to save. Please re-upload the file.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Template was already created on upload; just update the name.
      await wordTemplatesService.renameTemplate(lawFirmId, tid, templateName.trim());
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save DOCX template."));
    } finally {
      setSaving(false);
    }
  };

  // In-place Re-upload of the DOCX source from the docx-setup phase.
  // Replaces the stored .docx on the SAME template record and re-detects
  // placeholders, distinct from the upload-phase handleFile (which is the
  // PDF→HTML import path and creates a new record). No convertToPdf needed.
  const handleDocxReupload = async (file: File, acknowledgedLeftovers?: string[]) => {
    const tid = docxTemplateIdRef.current;
    if (!tid) {
      setError("No DOCX template to re-upload.");
      return;
    }
    if (!isDocxFile(file)) {
      setError("Please upload a .docx file.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await wordTemplatesService.replaceDocx(lawFirmId, tid, file, acknowledgedLeftovers);
      setTemplateName(updated.name);
      setChipNames(updated.fields);
      setDocxFields(updated.fields ?? []);
      setDocxRepeaters(updated.repeaters ?? []);
      // The stored .docx changed, refresh the preview so it doesn't show the
      // old document: load the converted PDF afresh (converter path), and bump
      // the version so the client-side DocxTemplatePreview remounts + refetches.
      if (converterEnabled) {
        const pdf = await wordTemplatesService.previewPdf(lawFirmId, tid).catch(() => null);
        if (pdf) {
          setDocxPreviewUrl((current) => {
            if (current) URL.revokeObjectURL(current);
            return URL.createObjectURL(pdf);
          });
        }
      }
      setDocxPreviewVersion((v) => v + 1);
    } catch (err) {
      if (err instanceof ClientTextCheckError && err.leftovers) {
        setLeftoverPrompt({ kind: "reupload", file, leftovers: err.leftovers });
        return;
      }
      setError(getErrorMessage(err, "Failed to re-upload DOCX."));
    } finally {
      setSaving(false);
    }
  };

  const handleDocxReuploadInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleDocxReupload(file);
    e.target.value = "";
  };

  // ─── Reset ────────────────────────────────────────────────────
  const handleReset = () => {
    mutNormalizerRef.current?.disconnect();
    mutNormalizerRef.current = null;
    setPhase("upload");
    setExportHtml("");
    setChipNames([]);
    setRepeaterNames([]);
    setTemplateName("");
    setError(null);
    setNameError(false);
    setInsertBtnReady(false);
    setTextBoxMode(false);
    setSelectedTextBoxId(null);
    setSelectedImageObjectId(null);
    selectChipElement(null);
    setTemplateAssets([]);
    setImageLayerTick(0);
    setCropTargetImageId(null);
    setToolbarStyle(DEFAULT_TOOLBAR_STYLE);
    applyFieldStylePreset(DEFAULT_PLACEHOLDER_FIELD_STYLE, false);
    setPageHeight(0);
    setPageContentBottom(0);
    setActivePageOffsetTop(0);
    setActivePageNumber(1);
    activeEditableRef.current = null;
    savedRangeRef.current = null;
    initializedRef.current = false;
    customHistoryRef.current = { snapshots: [], index: -1, debounceTimer: null };
    if (editorRef.current) editorRef.current.innerHTML = "";
    // DOCX state
    setDocxFields([]);
    setDocxRepeaters([]);
    if (docxPreviewUrl) URL.revokeObjectURL(docxPreviewUrl);
    setDocxPreviewUrl(null);
    docxTemplateIdRef.current = null;
  };

  // Close fill-format dropdown on outside click
  useEffect(() => {
    if (!showFillFormats) return;
    const handleClick = (e: MouseEvent) => {
      if (fillFormatDropdownRef.current && !fillFormatDropdownRef.current.contains(e.target as Node)) {
        setShowFillFormats(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showFillFormats]);

  // ─── Fill-mode Download ───────────────────────────────────────
  // Build the filled HTML → {pdf | docx | txt} via the export route
  // (matches the fill form). ODT/RTF are omitted.
  const buildFilledExportBlob = async (format: "pdf" | "docx" | "txt"): Promise<Blob> => {
    const full = await wordTemplatesService.getById(lawFirmId, templateId!);
    if (!full.html) throw new Error("No HTML content found for this template.");
    const filled = buildFilledTemplateHtml(
      full.html,
      initialFillValues!,
      initialRepeaterFillValues ?? {},
    );
    const doc = injectTemplatePreviewStyles(filled, templateName || "document");
    return wordTemplatesService.exportHtml(lawFirmId, doc, format);
  };

  const handleFillDownload = async (format: "pdf" | "docx" | "txt" = "pdf") => {
    if (!templateId || !initialFillValues) return;
    setFillExporting(true);
    setError(null);
    try {
      const blob = await buildFilledExportBlob(format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${templateName || "document"}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to download."));
    } finally {
      setFillExporting(false);
    }
  };

  const handleFillConfirmSave = async (destination: SaveDestination) => {
    if (!templateId || !initialFillValues) return;
    setFillUploading(true);
    setError(null);
    try {
      const blob = await buildFilledExportBlob("pdf");
      const base = destination.fileName.replace(/\.[^.]+$/, "") || "document";
      const file = new File([blob], `${base}.pdf`, { type: "application/pdf" });
      await filesService.upload(
        lawFirmId,
        scopeFromIds({
          matterId: destination.scope === "matter" ? destination.matterId : null,
          taskId: destination.scope === "task" ? destination.taskId : null,
          clientId: destination.scope === "client" ? destination.clientId : null,
        }),
        [file],
        undefined,
        destination.folderId,
      );
      setShowFillSaveModal(false);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save to files."));
    } finally {
      setFillUploading(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────
  return (
    <div className="h-screen bg-page overflow-hidden flex flex-col">
      {/* Hide selection highlight on page background; only show on text */}
      <style>{`
        .pdf-page::selection,
        .pdf-page::before,
        .pdf-page::after { background: transparent !important; }
        .pdf-page *::selection { background: transparent !important; }
        .pdf-page > p::selection,
        .pdf-page > p *::selection,
        .pdf-page [data-template-text-box-editor]::selection,
        .pdf-page [data-template-text-box-editor] *::selection { background: Highlight !important; }
        /* Flow lines must stay above z-index:0 images; saved HTML may omit inline z-index on <p>. */
        .pdf-page p { z-index: 1; }
        .pdf-page > a[href] { z-index: 1; }
      `}</style>
      <div className="p-4 pl-5 md:p-6 w-full max-w-[1600px] mx-auto min-w-0 flex flex-col gap-y-6 flex-1 overflow-hidden">

        {/* Hero Banner, upload phase only */}
        {phase === "upload" && !loadingTemplate && (
          <PageHeader
            eyebrow="Document Templates"
            title="New Template"
            description="Upload a document, insert named field placeholders, then save it as a reusable template."
            actions={
              <button
                onClick={onBack}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-surface text-on-surface border border-input-border hover:bg-surface-alt px-3 text-sm font-medium transition-colors cursor-pointer"
              >
                <ArrowLeft size={13} /> Back to Templates
              </button>
            }
          />
        )}

        <ErrorNotification error={error} onClose={() => setError(null)} />

        {importWarnings.length > 0 && (
          <div className="mx-4 mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="flex-1">
              {importWarnings.map((w, i) => (<p key={i}>{w}</p>))}
            </div>
            <button type="button" onClick={() => setImportWarnings([])} className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-amber-600/70 dark:text-amber-400 hover:text-amber-600 dark:hover:text-amber-400"><X size={14} /></button>
          </div>
        )}

        {/* Loading spinner for edit mode */}
        {loadingTemplate && (
          <div className="flex flex-1 min-h-0 items-center justify-center">
            <LoadingSpinner />
          </div>
        )}

        {/* Upload Phase */}
        {phase === "upload" && !loadingTemplate && (
          <UploadZone
            converting={converting}
            convertingDocx={convertingDocx}
            isDragging={isDragging}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onBrowse={() => fileInputRef.current?.click()}
          />
        )}

        {/* DOCX Preview Phase */}
        {phase === "docx-setup" && (
          <div
            className="rounded-lg border border-outline overflow-hidden flex flex-col flex-1 min-h-0"
            data-testid="docx-setup-pane"
          >
            {/* Toolbar */}
            <div className="border-b border-outline bg-surface shadow-sm">
              <div className="px-3 py-2 flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={handleReset}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium border border-outline bg-surface text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  <ArrowLeft size={13} /> Back
                </button>

                <div className="h-5 w-px bg-outline" />

                {/* Detected placeholders */}
                {(docxFields.length > 0 || docxRepeaters.length > 0) && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {docxFields.map((f) => (
                      <span key={f} className="inline-flex h-5 items-center whitespace-nowrap rounded-md px-1.5 bg-accent-soft text-accent-emphasis text-sm font-medium border border-accent-border-soft">
                        {"{" + f + "}"}
                      </span>
                    ))}
                    {docxRepeaters.map((r) => (
                      <span key={r.name} className="inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md px-1.5 bg-accent-soft text-accent-emphasis text-sm font-medium border border-accent-border-soft">
                        <Repeat size={10} /> {r.name} ({r.fields.length})
                      </span>
                    ))}
                  </div>
                )}
                {docxFields.length === 0 && docxRepeaters.length === 0 && (
                  <span className="text-xs text-on-surface-muted">
                    No fillable fields yet: add {"{field_name}"} tags in Word, or go to Templates →
                    New Template → Upload a Word document to name this form&apos;s blanks.
                  </span>
                )}

                <div className="flex-1" />

                {/* Name + Save */}
                <input
                  type="text"
                  value={templateName}
                  onChange={(e) => { setTemplateName(e.target.value); setNameError(false); }}
                  placeholder="Template name"
                  className={`h-8 w-48 rounded-lg border ${nameError ? "border-red-600" : "border-input-border"} bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-control-ring`}
                />
                <button
                  type="button"
                  onClick={() => docxReuploadInputRef.current?.click()}
                  disabled={saving}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium border border-outline bg-surface text-on-surface hover:bg-surface-hover disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <Upload size={13} /> Re-upload
                </button>
                <button
                  type="button"
                  onClick={handleDocxSave}
                  disabled={saving}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium bg-accent-solid text-accent-foreground hover:bg-accent-solid/90 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {saving ? (
                    <Spinner />
                  ) : (
                    <Save size={13} />
                  )}
                  Save
                </button>
              </div>
              {nameError && <p className="text-xs text-red-600 dark:text-red-400 px-3 pb-2">Template name is required.</p>}
            </div>

            {/* PDF Preview */}
            <div className="flex-1 overflow-auto bg-surface-alt flex items-start justify-center p-6">
              {docxPreviewUrl ? (
                <embed
                  src={docxPreviewUrl}
                  type="application/pdf"
                  className="w-full max-w-[850px] h-full min-h-[800px] rounded shadow-lg"
                />
              ) : (templateId ?? docxTemplateIdRef.current) ? (
                // DOCX→PDF preview needs LibreOffice (not wired on this stack), so
                // render the stored .docx directly in the browser via docx-preview
                // instead, real formatting with the {placeholders} inline. The
                // version in the key forces a refetch after a re-upload.
                <DocxTemplatePreview
                  key={`${templateId ?? docxTemplateIdRef.current}-${docxPreviewVersion}`}
                  lawFirmId={lawFirmId}
                  templateId={(templateId ?? docxTemplateIdRef.current) as string}
                />
              ) : (
                // Brand-new upload not yet persisted → no id to fetch. Keep the
                // clear placeholder; the placeholders + rename + Re-upload work.
                <div className="max-w-[850px] w-full bg-surface rounded shadow-lg flex flex-col items-center justify-center text-center gap-3 px-8 py-20">
                  <AlertCircle size={28} className="text-on-surface-muted" />
                  <p className="text-base font-semibold text-on-surface">Preview not available for Word templates</p>
                  <p className="text-xs text-on-surface-muted max-w-sm">
                    Edit the detected placeholders by re-uploading the .docx above.
                    Download the filled document from the Fill flow to view it in Word.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Editor Phase */}
        {phase === "editor" && (
          <div className="rounded-lg border border-outline overflow-hidden flex flex-col flex-1 min-h-0">
            {/* Toolbar */}
            <div className="border-b border-outline bg-surface shadow-sm">
              <div className="px-3 py-2 border-b border-outline/70">
                <div className="flex items-center gap-2 flex-wrap">
                  {initialFillValues && (
                    <button
                      type="button"
                      onClick={onBack}
                      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium bg-surface text-on-surface border border-input-border hover:bg-surface-alt transition-colors cursor-pointer"
                    >
                      <ArrowLeft size={13} />
                      Back to Fill
                    </button>
                  )}
                  {!initialFillValues && (
                    <>
                      <button
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); handleInsertFieldClick(); }}
                        className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium border transition-colors duration-150 cursor-pointer ${
                          insertBtnReady
                            ? "bg-accent-solid text-accent-foreground border-accent-solid"
                            : "bg-surface text-on-surface border-outline hover:bg-surface-hover"
                        }`}
                      >
                        <Plus size={13} />
                        Insert Field
                      </button>
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          // Save the current selection before the modal steals focus
                          const sel = window.getSelection();
                          const range = sel?.rangeCount
                            ? sel.getRangeAt(0).cloneRange()
                            : savedRangeRef.current?.cloneRange() ?? null;
                          if (range) savedRangeRef.current = range;
                          setShowRepeaterModal(true);
                          setRepeaterNameInput("");
                        }}
                        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium border transition-colors duration-150 cursor-pointer bg-surface text-on-surface border-outline hover:bg-surface-hover"
                      >
                        <Repeat size={13} />
                        Repeater
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setTextBoxMode((current) => !current);
                      setInsertBtnReady(false);
                    }}
                    className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium border transition-colors duration-150 cursor-pointer ${
                      textBoxMode
                        ? "bg-accent-solid text-accent-foreground border-accent-solid"
                        : "bg-surface text-on-surface border-outline hover:bg-surface-hover"
                    }`}
                  >
                    <Type size={13} />
                    Text Box
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      imageInputRef.current?.click();
                    }}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium border transition-colors duration-150 cursor-pointer bg-surface text-on-surface border-outline hover:bg-surface-hover"
                  >
                    <ImageIcon size={13} />
                    Insert Image
                  </button>
                  <p className="text-xs text-on-surface-muted hidden xl:block">
                    {textBoxMode
                      ? "Click anywhere on the page to place a text box. You can insert fields inside it too."
                      : "Click in the document to place your cursor, add a text box, or upload an image over the page."}
                  </p>

                  <div className="ml-auto flex items-center gap-2">
                    {initialFillValues ? (
                      <>
                        {/* Save to Files */}
                        <Tooltip title="Save to Files" enterDelay={300}>
                          <button
                            type="button"
                            onClick={() => setShowFillSaveModal(true)}
                            disabled={fillExporting || fillUploading}
                            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium bg-surface border border-outline text-on-surface hover:bg-surface-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors cursor-pointer"
                          >
                            {fillUploading ? <Spinner size={13} /> : <FolderUp size={13} />}
                            Save to Files
                          </button>
                        </Tooltip>
                        {/* Download split-button */}
                        <div className="relative" ref={fillFormatDropdownRef}>
                          <div className="flex">
                            <Tooltip title="Download as PDF" enterDelay={300}>
                              <button
                                type="button"
                                onClick={() => handleFillDownload("pdf")}
                                disabled={fillExporting || fillUploading}
                                className="inline-flex h-8 items-center gap-1.5 rounded-l-lg px-3 text-sm font-medium bg-accent-solid text-accent-foreground hover:bg-accent-solid/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors cursor-pointer"
                              >
                                {fillExporting ? <Spinner size={13} /> : <Download size={13} />}
                                Download
                              </button>
                            </Tooltip>
                            <Tooltip title="More download formats" enterDelay={300}>
                              <button
                                type="button"
                                onClick={() => setShowFillFormats((v) => !v)}
                                disabled={fillExporting || fillUploading}
                                className="inline-flex h-8 items-center rounded-r-lg px-2 text-accent-foreground bg-accent-solid hover:bg-accent-solid/90 border-l border-accent-foreground/20 disabled:opacity-60 disabled:cursor-not-allowed transition-colors cursor-pointer"
                              >
                                <ChevronDown size={13} />
                              </button>
                            </Tooltip>
                          </div>
                          {showFillFormats && (
                            <div className="absolute right-0 top-full mt-1 bg-surface border border-outline-subtle rounded-lg shadow-lg overflow-hidden z-50 min-w-[180px]">
                              {(["pdf", "docx", "txt"] as const).map((fmt) => (
                                <button
                                  key={fmt}
                                  type="button"
                                  onClick={() => { setShowFillFormats(false); handleFillDownload(fmt); }}
                                  className="w-full text-left px-4 py-2.5 text-xs text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
                                >
                                  {{ pdf: "PDF", docx: "Word (DOCX)", txt: "Plain Text (TXT)" }[fmt]}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <input
                          type="text"
                          value={templateName}
                          onChange={(e) => { setTemplateName(e.target.value); setNameError(false); }}
                          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                          placeholder="Template name…"
                          className={`h-8 rounded-lg border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-control-ring w-44 ${nameError ? "border-red-600 focus:ring-red-600" : "border-input-border"}`}
                        />
                        <button
                          type="button"
                          onClick={handleSave}
                          disabled={saving}
                          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium bg-accent-solid text-accent-foreground hover:bg-accent-solid/90 disabled:opacity-50 transition-colors cursor-pointer"
                        >
                          <Save size={13} />
                          {saving ? "Saving…" : templateId ? "Update Template" : "Save Template"}
                        </button>
                        <button
                          type="button"
                          onClick={handleReset}
                          className="inline-flex size-8 items-center justify-center rounded-lg text-on-surface-muted hover:text-on-surface border border-outline hover:bg-surface-hover transition-colors cursor-pointer"
                        >
                          <RotateCcw size={13} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
                <TemplateFormattingToolbar
                  styleState={toolbarStyle}
                  onToolbarButtonMouseDown={handleToolbarButtonMouseDown}
                  onToolbarControlMouseDown={handleToolbarControlMouseDown}
                  onUndo={handleUndo}
                  onRedo={handleRedo}
                  onFontFamilyChange={handleFontFamilyChange}
                  onFontSizeChange={handleFontSizeChange}
                  onLineSpacingChange={handleLineSpacingChange}
                  onSpaceBeforeChange={handleSpaceBeforeChange}
                  onSpaceAfterChange={handleSpaceAfterChange}
                  onTextAlignChange={handleTextAlignChange}
                  onInsertLink={handleInsertLink}
                  onBoldToggle={handleBoldToggle}
                  onItalicToggle={handleItalicToggle}
                  onUnderlineToggle={handleUnderlineToggle}
                  onBulletListToggle={handleBulletListToggle}
                  onNumberedListToggle={handleNumberedListToggle}
                  onColorChange={handleColorChange}
                />

                <div className="flex items-center gap-1 ml-auto">
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); setZoomLevel(z => Math.max(0.3, +(z - 0.1).toFixed(2))); }}
                    className="inline-flex size-8 items-center justify-center rounded-lg hover:bg-surface-hover transition-colors cursor-pointer text-on-surface-muted hover:text-on-surface"
                  >
                    <ZoomOut size={14} />
                  </button>
                  <span className="text-xs text-on-surface-muted w-10 text-center tabular-nums">
                    {Math.round(zoomLevel * 100)}%
                  </span>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); setZoomLevel(z => Math.min(3, +(z + 0.1).toFixed(2))); }}
                    className="inline-flex size-8 items-center justify-center rounded-lg hover:bg-surface-hover transition-colors cursor-pointer text-on-surface-muted hover:text-on-surface"
                  >
                    <ZoomIn size={14} />
                  </button>
                </div>
              </div>

              <div className="pb-3">
                <TemplateParagraphRuler
                  pageWidth={pageWidth}
                  zoomLevel={zoomLevel}
                  metrics={activeParagraphMetrics}
                  scrollLeft={editorScrollLeft}
                  onDragStart={flushSnapshot}
                  onChange={handleParagraphBarrierChange}
                  onCommit={handleParagraphBarrierCommit}
                />
              </div>
            </div>

            {/* Name error bar */}
            {nameError && (
              <div className="border-b border-outline px-4 py-2 bg-surface flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <AlertCircle size={13} className="text-red-600 dark:text-red-400 shrink-0" />
                  <span className="text-xs font-medium text-red-600 dark:text-red-400">Enter a template name before saving.</span>
                </div>
                <button onClick={() => setNameError(false)} className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-on-surface-muted hover:text-on-surface transition-colors cursor-pointer">
                  <X size={13} />
                </button>
              </div>
            )}

            {/* Fields badge strip */}
            {(() => {
              const visibleChips = initialFillValues
                ? chipNames.filter(n => {
                    if (initialFillValues[n]) return false;
                    // Check if it's a repeater field (e.g. "payment.date") that's filled
                    if (initialRepeaterFillValues) {
                      const dotIdx = n.indexOf(".");
                      if (dotIdx !== -1) {
                        const repeaterName = n.slice(0, dotIdx);
                        const field = n.slice(dotIdx + 1);
                        const firstRow = initialRepeaterFillValues[repeaterName]?.[0];
                        if (firstRow?.[field]) return false;
                      }
                    }
                    return true;
                  })
                : chipNames;
              return visibleChips.length > 0 ? (
                <div className="border-b border-outline px-3 py-1.5 bg-surface flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-on-surface-muted">Fields:</span>
                  {/* dedupe, the same placeholder name can appear in multiple chips */}
                  {[...new Set(visibleChips)].map(n => (
                    <span key={n} className="inline-flex h-5 items-center whitespace-nowrap rounded-md px-1.5 bg-accent-soft text-accent-emphasis text-sm font-medium">
                      {"{" + n + "}"}
                    </span>
                  ))}
                </div>
              ) : null;
            })()}

            {/* Repeater badge strip, hidden when coming from fill modal */}
            {!initialFillValues && repeaterNames.length > 0 && (
              <div className="border-b border-outline px-3 py-1.5 bg-surface flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-on-surface-muted">Repeaters:</span>
                {repeaterNames.map(name => {
                  const fields = chipNames
                    .filter(c => c.startsWith(name + "."))
                    .map(c => c.slice(name.length + 1));
                  return (
                    <span key={name} className="inline-flex h-5 items-center whitespace-nowrap rounded-md px-1.5 bg-accent-soft text-accent-emphasis text-sm font-medium">
                      ↻ {name}{fields.length > 0 ? ` (${fields.join(", ")})` : ""}
                    </span>
                  );
                })}
              </div>
            )}

            {/* Editable document, centered */}
              <div
                ref={editorWrapperRef}
                onMouseDown={handleEditorWrapperMouseDown}
                onMouseUp={handleEditorWrapperMouseUp}
                onClick={handleDocClick}
                className="relative flex-1 min-h-0 overflow-auto bg-surface-alt styled-scrollbar flex flex-col items-center"
              >
              <TemplatePageBoundaryRuler
                pageHeight={pageHeight}
                zoomLevel={zoomLevel}
                topBoundary={pageContentTop}
                boundary={pageContentBottom}
                topOffset={Math.max(16, activePageOffsetTop + 16)}
                pageNumber={activePageNumber}
                onTopChange={handlePageTopBoundaryChange}
                onChange={handlePageBoundaryChange}
              />
              <div className="relative min-w-fit px-4 py-4">
                <div
                  ref={editorRef}
                  contentEditable="true"
                  suppressContentEditableWarning={true}
                  className="focus:outline-none"
                  style={{ fontFamily: EDITOR_ROOT_FONT_FAMILY }}
                  onMouseDown={handleEditorMouseDown}
                  onKeyDown={handleEditorKeyDown}
                  onBeforeInput={handleEditorBeforeInput}
                  onInput={handleEditorInput}
                  onClick={handleEditorClick}
                  onPaste={(e) => { void handleEditorPaste(e); }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept={TEMPLATE_ACCEPT_ATTR}
          className="hidden"
          onChange={handleFileInput}
          data-testid="template-file-input"
        />

        <input
          ref={imageInputRef}
          type="file"
          accept={IMAGE_ACCEPT_ATTR}
          className="hidden"
          onChange={handleImageFileInput}
        />

        {/* Hidden input for in-place DOCX Re-upload (docx-setup phase) */}
        <input
          ref={docxReuploadInputRef}
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={handleDocxReuploadInput}
        />

        <PlaceholderModal
          open={showModal}
          onClose={() => { clearPendingHighlight(); setShowModal(false); setActiveRepeaterContext(null); }}
          onInsert={handleInsert}
          repeaterPrefix={activeRepeaterContext}
        />

        <TemplateImageCropModal
           
          isOpen={Boolean(cropTargetImageId && getImageObjectById(cropTargetImageId))}
          imageSrc={(() => {
             
            const imageObject = getImageObjectById(cropTargetImageId);
            return imageObject ? getTemplateImageElement(imageObject)?.getAttribute("src") ?? null : null;
          })()}
          imageName={(() => {
             
            const imageObject = getImageObjectById(cropTargetImageId);
            return imageObject ? getTemplateImageElement(imageObject)?.dataset.templateFileName ?? "image" : "image";
          })()}
          initialCrop={(() => {
             
            const imageObject = getImageObjectById(cropTargetImageId);
            return imageObject ? getTemplateImageCropRect(imageObject) : null;
          })()}
          onClose={() => setCropTargetImageId(null)}
          onConfirm={(crop) => {
            const imageObject = getImageObjectById(cropTargetImageId);
            if (imageObject) {
              setTemplateImageCropRect(imageObject, crop);
              scheduleSnapshot();
            }
            setCropTargetImageId(null);
          }}
        />

        <SaveToFilesModal
          open={showFillSaveModal}
          onClose={() => setShowFillSaveModal(false)}
          onConfirm={handleFillConfirmSave}
          lawFirmId={lawFirmId}
          defaultFileName={`${templateName || "document"}.pdf`}
          saving={fillUploading}
        />

        {/* Repeater Name Modal */}
        <Modal
          isOpen={showRepeaterModal}
          onClose={() => setShowRepeaterModal(false)}
          labelledBy={repeaterTitleId}
          showClose={false}
          size="sm"
          className="rounded-xl border-2 border-outline shadow-2xl"
          bodyClassName={null}
        >
                <div className="flex items-center justify-between px-6 py-4 border-b border-outline shrink-0">
                  <div>
                    <h2 id={repeaterTitleId} className="text-base font-semibold text-on-surface">Create Repeater</h2>
                    <p className="text-xs text-on-surface-muted mt-0.5">
                      Mark the current line as a repeatable row
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Close"
                    onClick={() => setShowRepeaterModal(false)}
                    className="inline-flex size-8 items-center justify-center rounded-lg text-on-surface-muted hover:text-on-surface transition-colors cursor-pointer"
                  >
                    &#x2715;
                  </button>
                </div>
                <div className="px-6 py-5 space-y-3">
                  <div>
                    <label htmlFor={repeaterInputId} className="mb-1 block text-sm font-medium text-on-surface">Repeater name</label>
                    <input
                      id={repeaterInputId}
                      type="text"
                      value={repeaterNameInput}
                      onChange={(e) => setRepeaterNameInput(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && repeaterNameInput.trim()) {
                          handleCreateRepeater(repeaterNameInput.trim());
                          setShowRepeaterModal(false);
                        }
                      }}
                      placeholder="e.g. payments, witnesses"
                      autoFocus
                      className="h-8 w-full rounded-lg border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-control-ring"
                    />
                  </div>
                  {repeaterNameInput.trim() && (
                    <div className="flex items-center gap-2 rounded-md bg-surface-alt border border-outline px-3 py-2">
                      <span className="text-xs text-on-surface-muted">Fields inside will be named:</span>
                      <span className="inline-flex h-5 items-center whitespace-nowrap rounded-md px-1.5 font-mono text-sm font-medium bg-accent-soft text-accent-emphasis border border-accent-border-soft">
                        {`{${repeaterNameInput.trim()}.___}`}
                      </span>
                    </div>
                  )}
                  <p className="text-xs text-on-surface-muted">
                    Place your cursor on the line you want to repeat, then create the repeater.
                    When filling, you can add as many rows as needed.
                  </p>
                </div>
                <div className="flex items-center justify-end gap-2 px-6 py-4 bg-surface-alt rounded-b-xl border-t border-outline shrink-0">
                  <button
                    onClick={() => setShowRepeaterModal(false)}
                    className="inline-flex h-8 items-center justify-center rounded-lg px-3 text-sm font-medium text-on-surface border border-outline hover:bg-surface-hover transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (repeaterNameInput.trim()) {
                        handleCreateRepeater(repeaterNameInput.trim());
                        setShowRepeaterModal(false);
                      }
                    }}
                    disabled={!repeaterNameInput.trim()}
                    className="inline-flex h-8 items-center justify-center rounded-lg px-3 text-sm font-medium bg-accent-solid text-accent-foreground hover:bg-accent-solid/90 disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    Create Repeater
                  </button>
                </div>
        </Modal>

        {/* Link URL Modal */}
        <Modal
          isOpen={showLinkModal}
          onClose={() => { setShowLinkModal(false); linkContextRef.current = null; }}
          labelledBy={linkTitleId}
          showClose={false}
          size="sm"
          className="rounded-xl border-2 border-outline shadow-2xl"
          bodyClassName={null}
        >
                <div className="flex items-center justify-between px-6 py-4 border-b border-outline shrink-0">
                  <div>
                    <h2 id={linkTitleId} className="text-base font-semibold text-on-surface">Insert Link</h2>
                    <p className="text-xs text-on-surface-muted mt-0.5">Enter the URL for this link</p>
                  </div>
                  <button
                    type="button"
                    aria-label="Close"
                    onClick={() => { setShowLinkModal(false); linkContextRef.current = null; }}
                    className="inline-flex size-8 items-center justify-center rounded-lg text-on-surface-muted hover:text-on-surface transition-colors cursor-pointer"
                  >
                    &#x2715;
                  </button>
                </div>
                <div className="px-6 py-5 space-y-3">
                  <div>
                    <label htmlFor={linkInputId} className="mb-1 block text-sm font-medium text-on-surface">URL</label>
                    <input
                      id={linkInputId}
                      type="text"
                      value={linkUrlInput}
                      onChange={(e) => setLinkUrlInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && linkUrlInput.trim()) handleLinkModalSubmit();
                      }}
                      placeholder="https://example.com"
                      autoFocus
                      className="h-8 w-full rounded-lg border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-control-ring"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 px-6 py-4 bg-surface-alt rounded-b-xl border-t border-outline shrink-0">
                  <button
                    onClick={() => { setShowLinkModal(false); linkContextRef.current = null; }}
                    className="inline-flex h-8 items-center justify-center rounded-lg px-3 text-sm font-medium text-on-surface border border-outline hover:bg-surface-hover transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleLinkModalSubmit}
                    disabled={!linkUrlInput.trim()}
                    className="inline-flex h-8 items-center justify-center rounded-lg px-3 text-sm font-medium bg-accent-solid text-accent-foreground hover:bg-accent-solid/90 disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    Insert
                  </button>
                </div>
        </Modal>
      </div>
      {/* Closes on Save anyway: the import or re-upload shows its own progress
          and errors, and reopens this if the server holds the file back again. */}
      <LeftoverClientTextDialog
        leftovers={leftoverPrompt?.leftovers ?? null}
        pending={false}
        error={null}
        onConfirm={() => {
          if (!leftoverPrompt) return;
          const { kind, file, leftovers } = leftoverPrompt;
          const acknowledged = leftovers.map((l) => l.literal);
          setLeftoverPrompt(null);
          if (kind === "import") void handleFile(file, acknowledged);
          else void handleDocxReupload(file, acknowledged);
        }}
        onCancel={() => setLeftoverPrompt(null)}
      />
    </div>
  );
}

// ─── Upload Zone ──────────────────────────────────────────────

interface TemplateFormattingToolbarProps {
  styleState: ToolbarStyleState;
  onToolbarButtonMouseDown: (e: React.MouseEvent) => void;
  onToolbarControlMouseDown: (e: React.MouseEvent) => void;
  onUndo: () => void;
  onRedo: () => void;
  onFontFamilyChange: (fontFamily: string) => void;
  onFontSizeChange: (fontSize: number) => void;
  onLineSpacingChange: (lineHeight: string) => void;
  onSpaceBeforeChange: (value: number) => void;
  onSpaceAfterChange: (value: number) => void;
  onTextAlignChange: (textAlign: string) => void;
  onInsertLink: () => void;
  onBoldToggle: () => void;
  onItalicToggle: () => void;
  onUnderlineToggle: () => void;
  onBulletListToggle: () => void;
  onNumberedListToggle: () => void;
  onColorChange: (color: string) => void;
}

function TemplateFormattingToolbar({
  styleState,
  onToolbarButtonMouseDown,
  onToolbarControlMouseDown,
  onUndo,
  onRedo,
  onFontFamilyChange,
  onFontSizeChange,
  onLineSpacingChange,
  onSpaceBeforeChange,
  onSpaceAfterChange,
  onTextAlignChange,
  onInsertLink,
  onBoldToggle,
  onItalicToggle,
  onUnderlineToggle,
  onBulletListToggle,
  onNumberedListToggle,
  onColorChange,
}: TemplateFormattingToolbarProps) {
  const colorInputRef = useRef<HTMLInputElement>(null);
  const spacingPopoutRef = useRef<HTMLDivElement>(null);
  const [showSpacingPopout, setShowSpacingPopout] = useState(false);
  const isCustomSpacing = !LINE_SPACING_OPTIONS.some((o) => o.value === styleState.lineHeight);
  const [customSpacingInput, setCustomSpacingInput] = useState(isCustomSpacing ? styleState.lineHeight : "");
  const [showCustomInput, setShowCustomInput] = useState(isCustomSpacing);

  useEffect(() => {
    if (isCustomSpacing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the custom-spacing UI inputs to mirror the incoming lineHeight prop; user can also mutate these states independently, so a during-render derivation would change behavior.
      setShowCustomInput(true);
      setCustomSpacingInput(styleState.lineHeight);
    } else {
      setShowCustomInput(false);
      setCustomSpacingInput("");
    }
  }, [styleState.lineHeight, isCustomSpacing]);

  // Close spacing popout on outside click
  useEffect(() => {
    if (!showSpacingPopout) return;
    const handleClick = (e: MouseEvent) => {
      if (spacingPopoutRef.current && !spacingPopoutRef.current.contains(e.target as Node)) {
        setShowSpacingPopout(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showSpacingPopout]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <ToolbarIconButton
        label="Undo"
        active={false}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onUndo}
      >
        <Undo2 size={14} />
      </ToolbarIconButton>

      <ToolbarIconButton
        label="Redo"
        active={false}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onRedo}
      >
        <Redo2 size={14} />
      </ToolbarIconButton>

      <div className="w-px h-5 bg-outline mx-1" />

      <span className="text-sm font-medium uppercase tracking-[0.06em] text-on-surface-muted">
        Font
      </span>
      <Dropdown
        value={styleState.fontFamily}
        onMouseDown={onToolbarControlMouseDown}
        onChange={onFontFamilyChange}
        options={FONT_FAMILIES.map((font) => ({
          value: font.value,
          label: font.label,
        }))}
        title="Font family"
        aria-label="Font family"
        className="min-w-[148px]"
        buttonClassName="h-8 px-2 rounded-lg border-outline bg-input-bg text-sm"
      />

      <span className="text-sm font-medium uppercase tracking-[0.06em] text-on-surface-muted">
        Size
      </span>
      <Dropdown
        value={String(styleState.fontSize)}
        onMouseDown={onToolbarControlMouseDown}
        onChange={(value) => onFontSizeChange(Number(value))}
        options={FONT_SIZES.map((size) => ({
          value: String(size),
          label: `${size}px`,
        }))}
        title="Font size"
        aria-label="Font size"
        className="w-[84px]"
        buttonClassName="h-8 px-2 rounded-lg border-outline bg-input-bg text-sm"
      />

      {/* ─── Spacing popout ─────────────────────────────────── */}
      <div className="relative" ref={spacingPopoutRef}>
        <Tooltip title="Line & paragraph spacing" enterDelay={300}>
          <button
            type="button"
            onMouseDown={onToolbarButtonMouseDown}
            onClick={() => setShowSpacingPopout((prev) => !prev)}
            aria-label="Line & paragraph spacing"
            className={`inline-flex size-8 items-center justify-center rounded-lg border transition-colors cursor-pointer ${
              showSpacingPopout
                ? "bg-accent-solid text-accent-foreground border-accent-solid"
                : "bg-surface text-on-surface border-outline hover:bg-surface-hover"
            }`}
          >
            <UnfoldVertical size={14} />
          </button>
        </Tooltip>

        {showSpacingPopout && (
          <div className="absolute top-full left-0 mt-1.5 z-50 w-[272px] rounded-xl border border-outline bg-surface shadow-xl p-4 space-y-4">
            {/* Line spacing */}
            <div>
              <span className="text-sm font-medium uppercase tracking-[0.06em] text-on-surface-muted mb-2 block">
                Line Spacing
              </span>
              <div className="grid grid-cols-4 gap-1.5">
                {LINE_SPACING_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onMouseDown={onToolbarButtonMouseDown}
                    onClick={() => {
                      setShowCustomInput(false);
                      setCustomSpacingInput("");
                      onLineSpacingChange(option.value);
                    }}
                    className={`px-1 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer border text-center truncate ${
                      !showCustomInput && styleState.lineHeight === option.value
                        ? "bg-accent-solid text-accent-foreground border-accent-solid shadow-sm"
                        : "bg-input-bg text-on-surface border-outline-subtle hover:border-outline hover:bg-surface-hover"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onMouseDown={onToolbarButtonMouseDown}
                  onClick={() => {
                    setShowCustomInput(true);
                    setCustomSpacingInput(styleState.lineHeight);
                  }}
                  className={`px-2.5 py-1 rounded-md text-sm font-medium uppercase tracking-[0.06em] transition-colors cursor-pointer border ${
                    showCustomInput
                      ? "bg-accent-solid text-accent-foreground border-accent-solid shadow-sm"
                      : "bg-input-bg text-on-surface-muted border-outline-subtle hover:border-outline hover:bg-surface-hover"
                  }`}
                >
                  Custom
                </button>
                {showCustomInput && (
                  <Tooltip title="Custom line spacing" enterDelay={300}>
                    <input
                      type="number"
                      min="0.5"
                      max="5"
                      step="0.05"
                      value={customSpacingInput}
                      onMouseDown={onToolbarControlMouseDown}
                      onChange={(e) => setCustomSpacingInput(e.target.value)}
                      onBlur={(e) => {
                        const val = Number.parseFloat(e.target.value.trim());
                        if (Number.isFinite(val) && val >= 0.5 && val <= 5) {
                          onLineSpacingChange(String(Math.round(val * 100) / 100));
                        } else {
                          setCustomSpacingInput(styleState.lineHeight);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      aria-label="Custom line spacing"
                      className="h-7 w-[66px] px-2 rounded-md border border-outline bg-input-bg text-on-surface text-xs text-center focus:outline-none focus:ring-2 focus:ring-accent-control-ring"
                    />
                  </Tooltip>
                )}
              </div>
            </div>

            <div className="h-px bg-outline-subtle" />

            {/* Paragraph spacing */}
            <div>
              <span className="text-sm font-medium uppercase tracking-[0.06em] text-on-surface-muted mb-2 block">
                Paragraph Spacing
              </span>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-on-surface-secondary">Before</span>
                  <div className="inline-flex items-center h-7 rounded-md border border-outline bg-input-bg overflow-hidden">
                    <button
                      type="button"
                      onMouseDown={onToolbarButtonMouseDown}
                      onClick={() => onSpaceBeforeChange(Math.max(0, styleState.spaceBefore - 2))}
                      className="w-7 h-full flex items-center justify-center text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      <Minus size={12} />
                    </button>
                    <Tooltip title="Space before (px)" enterDelay={300}>
                      <input
                        type="number"
                        min="0"
                        max="200"
                        step="1"
                        value={Math.round(styleState.spaceBefore)}
                        onMouseDown={onToolbarControlMouseDown}
                        onChange={(e) => {
                          const val = Number.parseFloat(e.target.value);
                          if (Number.isFinite(val) && val >= 0) onSpaceBeforeChange(val);
                        }}
                        aria-label="Space before paragraph"
                        className="h-full w-[38px] text-center text-xs bg-transparent text-on-surface border-x border-outline focus:outline-none"
                      />
                    </Tooltip>
                    <button
                      type="button"
                      onMouseDown={onToolbarButtonMouseDown}
                      onClick={() => onSpaceBeforeChange(styleState.spaceBefore + 2)}
                      className="w-7 h-full flex items-center justify-center text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-on-surface-secondary">After</span>
                  <div className="inline-flex items-center h-7 rounded-md border border-outline bg-input-bg overflow-hidden">
                    <button
                      type="button"
                      onMouseDown={onToolbarButtonMouseDown}
                      onClick={() => onSpaceAfterChange(Math.max(0, styleState.spaceAfter - 2))}
                      className="w-7 h-full flex items-center justify-center text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      <Minus size={12} />
                    </button>
                    <Tooltip title="Space after (px)" enterDelay={300}>
                      <input
                        type="number"
                        min="0"
                        max="200"
                        step="1"
                        value={Math.round(styleState.spaceAfter)}
                        onMouseDown={onToolbarControlMouseDown}
                        onChange={(e) => {
                          const val = Number.parseFloat(e.target.value);
                          if (Number.isFinite(val) && val >= 0) onSpaceAfterChange(val);
                        }}
                        aria-label="Space after paragraph"
                        className="h-full w-[38px] text-center text-xs bg-transparent text-on-surface border-x border-outline focus:outline-none"
                      />
                    </Tooltip>
                    <button
                      type="button"
                      onMouseDown={onToolbarButtonMouseDown}
                      onClick={() => onSpaceAfterChange(styleState.spaceAfter + 2)}
                      className="w-7 h-full flex items-center justify-center text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <AlignmentDropdown
        value={styleState.textAlign}
        onMouseDown={onToolbarButtonMouseDown}
        onChange={onTextAlignChange}
      />

      <ToolbarIconButton
        label="Insert link"
        active={styleState.isLink}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onInsertLink}
      >
        <Link2 size={14} />
      </ToolbarIconButton>

      <ToolbarIconButton
        label="Bold"
        active={styleState.isBold}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onBoldToggle}
      >
        <Bold size={14} />
      </ToolbarIconButton>

      <ToolbarIconButton
        label="Italic"
        active={styleState.isItalic}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onItalicToggle}
      >
        <Italic size={14} />
      </ToolbarIconButton>

      <ToolbarIconButton
        label="Underline"
        active={styleState.isUnderline}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onUnderlineToggle}
      >
        <Underline size={14} />
      </ToolbarIconButton>

      <div className="w-px h-5 bg-outline mx-1" />

      <ToolbarIconButton
        label="Bullet list"
        active={styleState.isBulletList}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onBulletListToggle}
      >
        <List size={14} />
      </ToolbarIconButton>

      <ToolbarIconButton
        label="Numbered list"
        active={styleState.isNumberedList}
        onMouseDown={onToolbarButtonMouseDown}
        onClick={onNumberedListToggle}
      >
        <ListOrdered size={14} />
      </ToolbarIconButton>

      <div className="w-px h-5 bg-outline mx-1" />

      <Tooltip title="Text color" enterDelay={300}>
        <button
          type="button"
          onMouseDown={(e) => {
            onToolbarButtonMouseDown(e);
            colorInputRef.current?.click();
          }}
          className="inline-flex h-8 items-center gap-2 rounded-lg px-2 border border-outline bg-surface text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
          aria-label="Text color"
        >
          <span className="text-sm font-medium uppercase tracking-[0.06em] text-on-surface-muted">
            Color
          </span>
          <span
            className="w-4 h-4 rounded-full border border-outline"
            style={{ backgroundColor: styleState.color }}
          />
          <input
            ref={colorInputRef}
            type="color"
            value={styleState.color}
            onChange={(e) => onColorChange(e.target.value)}
            className="sr-only"
            tabIndex={-1}
          />
        </button>
      </Tooltip>
    </div>
  );
}

function AlignmentDropdown({
  value,
  onMouseDown,
  onChange,
}: {
  value: string;
  onMouseDown: (e: React.MouseEvent) => void;
  onChange: (textAlign: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <Tooltip title="Paragraph alignment" enterDelay={300}>
        <button
          type="button"
          onMouseDown={(event) => {
            onMouseDown(event);
            setOpen((current) => !current);
          }}
          className="inline-flex h-8 items-center gap-2 rounded-lg px-2 border border-outline bg-surface text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
          aria-label="Paragraph alignment"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="text-sm font-medium uppercase tracking-[0.06em] text-on-surface-muted">
            Align
          </span>
          <AlignmentIcon value={value} className="h-4 w-4" />
          <ChevronDown className="h-3.5 w-3.5 text-on-surface-muted" />
        </button>
      </Tooltip>

      {open ? (
        <div className="absolute left-0 top-[calc(100%+8px)] z-20 flex gap-1 rounded-xl border border-outline bg-surface p-2 shadow-xl">
          {TEXT_ALIGN_OPTIONS.map((option) => (
            <Tooltip key={option.value} title={option.label} enterDelay={300}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onMouseDown(event);
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`inline-flex h-10 w-10 items-center justify-center rounded-lg border transition-colors cursor-pointer ${
                  value === option.value
                    ? "border-accent-border-soft bg-accent-soft text-accent-emphasis"
                    : "border-transparent text-on-surface-muted hover:bg-surface-hover hover:text-on-surface"
                }`}
                aria-label={option.label}
              >
                <AlignmentIcon value={option.value} className="h-5 w-5" />
              </button>
            </Tooltip>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AlignmentIcon({ value, className }: { value: string; className?: string }) {
  if (value === "center") return <AlignCenter className={className} />;
  if (value === "right") return <AlignRight className={className} />;
  if (value === "justify") return <AlignJustify className={className} />;
  return <AlignLeft className={className} />;
}

interface ToolbarIconButtonProps {
  active: boolean;
  label: string;
  onMouseDown: (e: React.MouseEvent) => void;
  onClick: () => void;
  children: ReactNode;
}

function ToolbarIconButton({ active, label, onMouseDown, onClick, children }: ToolbarIconButtonProps) {
  return (
    <Tooltip title={label} enterDelay={300}>
      <button
        type="button"
        onMouseDown={onMouseDown}
        onClick={onClick}
        aria-label={label}
        className={`inline-flex size-8 items-center justify-center rounded-lg border transition-colors cursor-pointer ${
          active
            ? "bg-accent-solid text-accent-foreground border-accent-solid"
            : "bg-surface text-on-surface border-outline hover:bg-surface-hover"
        }`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

interface TemplateParagraphRulerProps {
  pageWidth: number;
  zoomLevel: number;
  metrics: ActiveParagraphMetrics | null;
  scrollLeft: number;
  onDragStart: () => void;
  onChange: (left: number, width: number) => void;
  onCommit: () => void;
}

function TemplateParagraphRuler({ pageWidth, zoomLevel, metrics, scrollLeft, onDragStart, onChange, onCommit }: TemplateParagraphRulerProps) {
  const minWidth = 120;
  const scaledWidth = pageWidth > 0 ? pageWidth * zoomLevel : 0;

  const startDrag = (handle: "left" | "right") => (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!metrics) return;
    event.preventDefault();
    onDragStart();

    const startX = event.clientX;
    const startLeft = metrics.left;
    const startRight = metrics.left + metrics.width;
    let pendingLeft = startLeft;
    let pendingWidth = metrics.width;
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
            <div className="absolute inset-x-0 top-5 border-t border-on-surface-muted/50" />
            <div className="absolute inset-x-0 top-1 flex justify-between text-xs text-on-surface-muted">
              <span>0&quot;</span>
              <span>{`${Math.round(pageWidth / 96)}"`}</span>
            </div>

            {metrics ? (
              <>
                <div
                  className="absolute top-[18px] h-[4px] rounded-full bg-accent-solid/90 ring-1 ring-accent-control-ring/20"
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

function TemplatePageBoundaryRuler({
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
            <div className="absolute bottom-0 right-[12px] top-0 w-px bg-on-surface-muted/60" />

            {tickMarks.map((mark) => (
              <div
                key={mark}
                className="absolute right-[12px] border-t border-on-surface-muted/50"
                style={{
                  top: `${mark * zoomLevel}px`,
                  width: mark % 96 === 0 ? "14px" : mark % 48 === 0 ? "10px" : "6px",
                }}
              />
            ))}

            {inchMarks.map((mark, index) => (
              <span
                key={mark}
                className="absolute left-1.5 -translate-y-1/2 text-xs text-on-surface-muted tabular-nums"
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
              className="absolute right-[12px] border-t-2 border-accent-solid/80"
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
      <p className="mt-2 whitespace-nowrap text-xs text-on-surface-muted">
        Page {pageNumber}
      </p>
    </div>
  );
}

interface UploadZoneProps {
  converting: boolean;
  convertingDocx: boolean;
  isDragging: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onBrowse: () => void;
}

function UploadZone({ converting, convertingDocx, isDragging, onDragOver, onDragLeave, onDrop, onBrowse }: UploadZoneProps) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onBrowse}
      className={`flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed py-20 transition-colors cursor-pointer ${
        isDragging
          ? "border-accent-solid bg-accent-soft"
          : "border-outline bg-surface hover:border-accent-border-soft"
      }`}
    >
      {converting ? (
        <>
          <LoadingSpinner />
          <p className="text-base font-semibold text-on-surface-secondary">Preparing document…</p>
          <p className="text-xs text-on-surface-muted">
            {convertingDocx ? "Parsing DOCX placeholders" : "Converting to PDF and extracting layout"}
          </p>
        </>
      ) : (
        <>
          <div className="w-14 h-14 rounded-full bg-accent-soft flex items-center justify-center">
            <Upload size={28} className="text-accent-emphasis" />
          </div>
          <div className="text-center">
            <p className="text-base font-semibold text-on-surface">Drop a document here</p>
            <p className="text-xs text-on-surface-muted mt-1">or click to browse</p>
          </div>
          <p className="text-xs text-on-surface-muted">DOCX, PDF, DOC, ODT, RTF, TXT</p>
        </>
      )}
    </div>
  );
}
