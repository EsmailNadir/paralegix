// Pure DOM / text-range / pagination helpers for the template editor, extracted
// from TemplateEditor.tsx. These functions operate directly on editor DOM nodes
// and carry no React/component state, so they live in their own module.

import {
  TEMPLATE_IMAGE_OBJECT_SELECTOR,
  createTemplateImageObjectElement,
} from "./templateImageObjects";
import { foreColorToHex, mapCssToFontValue } from "@/components/signaturesComp/textFormatting";
import { FONT_FAMILIES } from "@/types/signature";
import {
  LINE_SPACING_OPTIONS,
  TEXT_ALIGN_OPTIONS,
  type ToolbarStyleState,
} from "./templateEditorTypes";

export function sortTemplateImagesOnPage(page: HTMLElement): HTMLElement[] {
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

export function normalizeTemplateImagePrioritiesOnPage(page: HTMLElement) {
  const sorted = sortTemplateImagesOnPage(page);
  sorted.forEach((el, i) => {
    el.dataset.templateImagePriority = String(i);
  });
}

/** Move image toward front (+1) or back (-1) in the stack; reassigns consecutive priorities so ties cannot break ordering. */
export function moveImageInStack(page: HTMLElement, object: HTMLElement, delta: 1 | -1): boolean {
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
export function moveImageToStackIndex(page: HTMLElement, object: HTMLElement, targetIndex: number): boolean {
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

export function applyTemplateImageObjectZIndex(object: HTMLElement) {
  // Body paragraphs use z-index:1 in the editor. Foreground images must sit above
  // so drag/resize hit-testing works; only true watermarks stay behind text.
  object.style.zIndex = object.dataset.templateImageBehindText === "true" ? "0" : "2";
}

export function applyTemplateImageZOrderInPage(page: HTMLElement) {
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

export function applyTemplateImageZOrderForEditor(editor: HTMLElement) {
  editor.querySelectorAll<HTMLElement>(".pdf-page").forEach((page) => {
    applyTemplateImageZOrderInPage(page);
  });
}

/** After text reflow: refresh overflow + stacking without reordering image DOM (layer order unchanged). */
export function syncTemplateImageStackingAfterReflow(editor: HTMLElement) {
  editor.querySelectorAll<HTMLElement>(".pdf-page").forEach((page) => {
    page.style.overflow = "visible";
    page.querySelectorAll<HTMLElement>(TEMPLATE_IMAGE_OBJECT_SELECTOR).forEach((el) => {
      applyTemplateImageObjectZIndex(el);
    });
  });
}

export const TEMPLATE_PAGE_BACKGROUND_SELECTOR = "img.pdf-page-background";

export function closeTemplateImageLayerMenus(root: ParentNode) {
  root.querySelectorAll<HTMLElement>("[data-template-image-layer-menu]").forEach((menu) => {
    menu.style.display = "none";
  });
  root.querySelectorAll<HTMLElement>("[data-template-image-layer-trigger]").forEach((trigger) => {
    trigger.setAttribute("aria-expanded", "false");
  });
}

export function setTemplateImageLayerActionState(button: HTMLButtonElement | null, disabled: boolean) {
  if (!button) return;
  button.disabled = disabled;
  button.style.opacity = disabled ? "0.45" : "1";
  button.style.cursor = disabled ? "not-allowed" : "pointer";
}

export function syncTemplateImageLayerMenuState(object: HTMLElement) {
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

export function migratePageBackgroundImageToTemplateObject(page: HTMLElement, image: HTMLImageElement, pageIndex: number, imageIndex: number) {
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

export function getTemplateImagePriorityIndex(object: HTMLElement): { index: number; total: number } | null {
  const page = object.closest<HTMLElement>(".pdf-page");
  if (!page) return null;
  const sorted = sortTemplateImagesOnPage(page);
  const idx = sorted.indexOf(object);
  if (idx < 0) return null;
  return { index: idx + 1, total: sorted.length };
}

export const TEMPLATE_ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".doc", ".odt", ".rtf", ".txt"];
export const TEMPLATE_ACCEPT_ATTR = TEMPLATE_ACCEPTED_EXTENSIONS.join(",");
export const TEMPLATE_TEXTBOX_WIDTH = 220;
export const TEMPLATE_TEXTBOX_HEIGHT = 64;
export const TAB_INSERTION = "\u00A0\u00A0\u00A0\u00A0";
export const FONT_MARKER = "__template_font_marker__";
export const FONT_SIZE_MARKER = "7";

export function focusTemplateEditable(el: HTMLElement | null | undefined) {
  el?.focus({ preventScroll: true });
}

/** Character offsets for the selection, relative to text nodes under `root` (order matches TreeWalker SHOW_TEXT). */
export function getTextRangeCharOffsetsWithinRoot(root: HTMLElement, range: Range): { start: number; end: number } | null {
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

export function resolveCharOffsetInRoot(root: HTMLElement, offset: number): { node: Node; offset: number } | null {
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

export function restoreTextRangeCharOffsetsWithinRoot(root: HTMLElement, start: number, end: number): boolean {
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
export function selectSingleReplacementSpan(span: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;
  const r = document.createRange();
  r.setStart(span, 0);
  r.setEnd(span, span.childNodes.length);
  selection.removeAllRanges();
  selection.addRange(r);
}

export function selectReplacementSpanRange(spans: HTMLElement[]): boolean {
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

export function collapseCaretToEndOfElement(el: HTMLElement) {
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

export function findLastTextNodeInSubtree(root: Node): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  let n: Node | null;
  while ((n = walker.nextNode())) last = n as Text;
  return last;
}

/** Node at the logical start of the range. Use for toolbar font/size (anchorNode can be the opposite end). */
export function getRangeStartLeafForToolbar(range: Range): Node {
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
export function getFirstMeaningfulTextParentInRange(range: Range): HTMLElement | null {
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

export type PlaceholderFieldStyle = {
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  color: string;
};

export const DEFAULT_TOOLBAR_STYLE: ToolbarStyleState = {
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

export function isSupportedTemplateFile(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  return TEMPLATE_ACCEPTED_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
}

export function isPdfFile(file: File): boolean {
  return file.type.toLowerCase().includes("pdf") || file.name.toLowerCase().endsWith(".pdf");
}

export function isDocxFile(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  return lowerName.endsWith(".docx");
}

export function getFontCss(fontFamily: string): string {
  return FONT_FAMILIES.find((font) => font.value === fontFamily)?.css ?? "'Times New Roman', Times, serif";
}

export const DEFAULT_PLACEHOLDER_FIELD_STYLE: PlaceholderFieldStyle = {
  fontFamily: getFontCss(DEFAULT_TOOLBAR_STYLE.fontFamily),
  fontSize: DEFAULT_TOOLBAR_STYLE.fontSize,
  fontWeight: "400",
  fontStyle: "normal",
  color: DEFAULT_TOOLBAR_STYLE.color,
};

/** Base font on the contenteditable root so unstyled runs (e.g. a space outside a PDF span) do not inherit the app UI sans-serif. */
export const EDITOR_ROOT_FONT_FAMILY = DEFAULT_PLACEHOLDER_FIELD_STYLE.fontFamily;

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image file."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

export function loadImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
    image.onerror = () => reject(new Error("Failed to load image."));
    image.src = src;
  });
}

/** Any `<p>` under a page (DOCX / some imports nest; PDF lines are usually `.pdf-page > p`). */
export const SEL_PAGE_P = ".pdf-page p";
/** PDF flow lines merged by the editor, always direct children of `.pdf-page`. */
export const SEL_DIRECT_PAGE_P = ".pdf-page > p";

export function getToolbarStyleFromElement(element: HTMLElement, selectionElement?: Element | null): ToolbarStyleState {
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
    // Always use computed font-family from the resolved element. queryCommandValue("fontName")
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

export function getPlaceholderFieldStyleFromElement(element: HTMLElement): PlaceholderFieldStyle {
  const computed = window.getComputedStyle(element);
  return {
    fontFamily: computed.fontFamily || DEFAULT_PLACEHOLDER_FIELD_STYLE.fontFamily,
    fontSize: Math.round(Number.parseFloat(computed.fontSize) || DEFAULT_PLACEHOLDER_FIELD_STYLE.fontSize),
    fontWeight: computed.fontWeight || DEFAULT_PLACEHOLDER_FIELD_STYLE.fontWeight,
    fontStyle: computed.fontStyle || DEFAULT_PLACEHOLDER_FIELD_STYLE.fontStyle,
    color: foreColorToHex(computed.color || DEFAULT_PLACEHOLDER_FIELD_STYLE.color),
  };
}

export function getPlaceholderFieldStyleFromToolbar(style: ToolbarStyleState): PlaceholderFieldStyle {
  return {
    fontFamily: getFontCss(style.fontFamily),
    fontSize: style.fontSize,
    fontWeight: style.isBold ? "700" : "400",
    fontStyle: style.isItalic ? "italic" : "normal",
    color: style.color,
  };
}

export function applyPlaceholderFieldStyle(chip: HTMLElement, style: PlaceholderFieldStyle) {
  chip.style.fontFamily = style.fontFamily;
  chip.style.fontSize = `${style.fontSize}px`;
  chip.style.fontWeight = style.fontWeight;
  chip.style.fontStyle = style.fontStyle;
  chip.style.color = style.color;
  chip.style.textDecorationColor = style.color;
}

export const CUSTOM_SPACING_THRESHOLD = 0.05;
export const UNDO_BATCH_MS = 300;

export function getClosestLineSpacing(lineHeight: string, fontSize: number): string {
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

export function normalizeTextAlign(textAlign: string): string {
  if (textAlign === "start") return "left";
  if (textAlign === "end") return "right";
  return TEXT_ALIGN_OPTIONS.some((option) => option.value === textAlign)
    ? textAlign
    : DEFAULT_TOOLBAR_STYLE.textAlign;
}

export function normalizeLinkHref(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(https?:|mailto:|tel:|ftp:|#|\/)/i.test(trimmed)) return trimmed;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return `mailto:${trimmed}`;
  return `https://${trimmed}`;
}

export function getNodeTextLength(node: Node): number {
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

export function getNodeTextValue(node: Node): string {
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

export function isParagraphBreakChar(char: string | undefined): boolean {
  return typeof char === "string" && /[\s\u00A0]/u.test(char);
}

export function findPreferredSplitOffset(root: HTMLElement, offset: number): number {
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

export function defaultParagraphGap(paragraph: HTMLElement): number {
  const fontSize = Number.parseFloat(paragraph.style.fontSize || "12");
  const lineHeight = Number.parseFloat(paragraph.style.lineHeight || "1.15");
  return Math.round(fontSize * lineHeight * 0.25);
}

export function applyParagraphWrapStyles(paragraph: HTMLElement) {
  paragraph.style.whiteSpace = "normal";
  paragraph.style.overflowWrap = "break-word";
  paragraph.style.wordBreak = "normal";
  if (paragraph.style.width) {
    paragraph.style.maxWidth = paragraph.style.width;
  }
}

export function isParagraphAwaitingNewText(paragraph: HTMLElement): boolean {
  const normalized = (paragraph.textContent || "")
    .replace(/\u200B/g, "")
    .replace(/\u00A0/g, " ")
    .trim();

  if (!normalized) return true;

  return /^([•‣◦⁃∙▪▫▸▹●○■□✓✔✗✘‒– - -]|\d+[.)]|[a-zA-Z][.)]|[ivxIVX]+[.)])$/.test(normalized);
}

export function preserveEditableGapSpans(paragraph: HTMLElement) {
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

export function ensureChipCaretTargets(container: Element) {
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

export function stripZeroWidthSpaces(container: Element) {
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

export const CHIP_EDGE_THRESHOLD = 8;

export function placeCaretBesideChip(chip: HTMLElement, side: "before" | "after") {
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

export function getPageColumnRightEdge(page: HTMLElement): number {
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

export function getParagraphHorizontalBounds(paragraph: HTMLElement) {
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

export function sharesRulerColumn(
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

export function getOffsetWithinBlock(root: Node, target: Node, targetOffset: number): number {
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

export function resolveOffsetWithinBlock(root: HTMLElement, offset: number): { node: Node; offset: number } {
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

export function getDefaultPageContentBottom(pageHeight: number, contentTop: number): number {
  if (!Number.isFinite(pageHeight) || pageHeight <= 0) {
    return Math.max(240, contentTop + 240);
  }

  const desiredBottom = Math.min(pageHeight - 96, pageHeight * 0.92);
  return Math.max(contentTop + 240, desiredBottom);
}

/** Page 1 often encodes a large Y for the first body line; overflow pages must not inherit that as content top. */
export const OVERFLOW_PAGE_CONTENT_TOP_THRESHOLD = 130;

/** Prefer `style.top` (it is updated by repagination; `dataset.baseTop` is often stale PDF import metadata. */
export function getParagraphLayoutTop(paragraph: HTMLElement): number {
  const fromStyle = paragraph.style.top?.trim();
  if (fromStyle) {
    const v = Number.parseFloat(fromStyle);
    if (Number.isFinite(v)) return v;
  }
  return Number.parseFloat(paragraph.dataset.baseTop || "0") || 0;
}

export type PageFlowGroupMetrics = {
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

export function getMedian(values: number[]): number {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) return 0;

  const sorted = [...filtered].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

export function collectPageFlowGroups(page: HTMLElement): PageFlowGroupMetrics[] {
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

export function detectFooterBandTop(page: HTMLElement): number | null {
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

export function inferAutoPageContentBottom(page: HTMLElement, contentTop: number): number {
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
  // body legitimately fills that band. Do not reserve a no-man's land that forces early
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

/**
 * Re-derive a page's auto content bottom during repagination without letting it
 * chase the content: `inferAutoPageContentBottom` allows the deepest paragraph
 * plus slack, so re-persisting its raw value after every edit ratchets the
 * writable area toward the physical page edge and Enter at a full page keeps
 * wedging new lines onto the same page instead of overflowing to the next one.
 * The refreshed value may shrink (footer band detection) but never grows past
 * the previously stored bottom or the default margin, whichever is larger.
 * Pages with a manually dragged boundary are left untouched.
 */
export function refreshAutoPageContentBottom(page: HTMLElement): void {
  if (page.dataset.baseContentBottomSource === "manual") return;
  const contentTop = Number.parseFloat(page.dataset.baseContentTop || "72") || 72;
  const inferred = inferAutoPageContentBottom(page, contentTop);
  const stored = Number.parseFloat(page.dataset.baseContentBottom || "");
  const pageHeight = Number.parseFloat(page.dataset.baseMinHeight || page.style.minHeight || "0")
    || page.offsetHeight
    || 0;
  const cap = Number.isFinite(stored)
    ? Math.max(stored, getDefaultPageContentBottom(pageHeight, contentTop))
    : Number.POSITIVE_INFINITY;
  page.dataset.baseContentBottom = String(Math.min(inferred, cap));
  page.dataset.baseContentBottomSource = "auto";
}

export function createTemplateDomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
