"use client";

import type { TemplateRichTextBlock, TemplateRichTextRun } from "@/types/template";

/**
 * DOM plumbing for the rich contentEditable box a selected 'textbox'
 * placement becomes in `TemplateOverlayFieldBox.tsx`. Reuses the PATTERN
 * `TemplateEditor.tsx`'s own hand-rolled contentEditable editor already
 * proved out (execCommand + styleWithCSS for bold/italic/color, a
 * non-editable "chip" span for an inline merge-field reference, zero-width
 * spaces flanking a chip for caret targeting) rather than its code, which is
 * closed over that editor's own pagination/repeater DOM. Serializes to/from
 * `TemplateRichTextBlock[]` (a plain data structure, not HTML) so the
 * backend never needs an HTML parser: see the migration/PR notes on
 * `template_field_placements.rich_text`.
 */

const ZWS = "​";
const CHIP_ATTR = "data-overlay-field-chip";
const BULLET_MARKER_ATTR = "data-overlay-bullet-marker";

export interface InlineStyle {
  bold: boolean;
  italic: boolean;
  color: string;
}

// ── selection ────────────────────────────────────────────────────────

/** Snapshots the live selection, but only when it's actually inside
 *  `container`: a toolbar button's mousedown fires after focus has already
 *  left the box in some browsers, so a stale/foreign range must not be kept. */
export function saveSelectionRange(container: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  return range.cloneRange();
}

export function restoreSelectionRange(range: Range | null) {
  if (!range) return;
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

// ── bold / italic / color ───────────────────────────────────────────

/** Two-call execCommand pattern `TemplateEditor.tsx`'s own `runTextCommand`
 *  uses: styleWithCSS makes bold/italic/foreColor apply as inline `style`
 *  attributes (spans), not semantic `<b>/<i>` tags, which is what the
 *  serializer below expects to read back. */
export function runInlineTextCommand(command: "bold" | "italic" | "foreColor", value?: string) {
  document.execCommand("styleWithCSS", false, "true");
  document.execCommand(command, false, value);
}

function rgbToHex(value: string): string | null {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
  if (!match) return null;
  return `#${[match[1], match[2], match[3]].map((c) => Number(c).toString(16).padStart(2, "0")).join("")}`;
}

/** The format at the current caret/selection: what bold/italic/color the
 *  NEXT typed character would get, or what the current selection already
 *  has, exactly execCommand's own native semantics. */
export function getInlineFormatAtSelection(fallback: InlineStyle): InlineStyle {
  try {
    const bold = document.queryCommandState("bold");
    const italic = document.queryCommandState("italic");
    const raw = document.queryCommandValue("foreColor");
    const color = raw ? (rgbToHex(raw) ?? fallback.color) : fallback.color;
    return { bold, italic, color };
  } catch {
    return fallback;
  }
}

// ── field chips ──────────────────────────────────────────────────────

function buildFieldChipElement(fieldName: string, style: InlineStyle): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.setAttribute(CHIP_ATTR, fieldName);
  chip.setAttribute("contenteditable", "false");
  chip.style.cssText =
    "display:inline-flex;align-items:center;gap:2px;text-decoration:underline dotted;text-underline-offset:2px;vertical-align:baseline;border-radius:3px;padding:0 2px;";
  chip.style.fontWeight = style.bold ? "700" : "400";
  chip.style.fontStyle = style.italic ? "italic" : "normal";
  chip.style.color = style.color;

  const label = document.createElement("span");
  label.textContent = `{${fieldName}}`;
  label.style.cursor = "default";

  const removeBtn = document.createElement("span");
  removeBtn.setAttribute("data-overlay-chip-remove", "true");
  removeBtn.textContent = "×";
  removeBtn.style.cssText = "cursor:pointer;font-size:0.85em;opacity:0.55;line-height:1;padding:0 1px;";

  chip.appendChild(label);
  chip.appendChild(removeBtn);
  return chip;
}

function buildBulletMarker(): HTMLSpanElement {
  const marker = document.createElement("span");
  marker.setAttribute(BULLET_MARKER_ATTR, "true");
  marker.setAttribute("contenteditable", "false");
  marker.textContent = "•  ";
  marker.style.userSelect = "none";
  return marker;
}

/** Inserts a field chip at the given (already-restored) selection, replacing
 *  it if non-collapsed, flanked by zero-width spaces so the caret has a real
 *  text position to land on immediately before/after an otherwise-atomic
 *  (contenteditable=false) chip, the same trick `TemplateEditor.tsx`'s own
 *  `buildChipElement`/`handleInsert` use. */
export function insertFieldChipAtSelection(fieldName: string, style: InlineStyle) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();

  const fragment = document.createDocumentFragment();
  const before = document.createTextNode(ZWS);
  const chip = buildFieldChipElement(fieldName, style);
  const after = document.createTextNode(ZWS);
  fragment.appendChild(before);
  fragment.appendChild(chip);
  fragment.appendChild(after);
  range.insertNode(fragment);

  const newRange = document.createRange();
  newRange.setStartAfter(after);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);
}

// ── bullet toggle (a direct DOM op, not execCommand: insertUnorderedList
//    produces real <ul>/<li> markup the serializer below doesn't model) ──

function closestBlock(root: HTMLElement, node: Node): HTMLElement | null {
  let el: Node | null = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== root) {
    if (el instanceof HTMLElement && el.parentElement === root) return el;
    el = el.parentElement;
  }
  return null;
}

export function isCaretInBulletedBlock(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const block = closestBlock(root, selection.getRangeAt(0).startContainer);
  return Boolean(block?.firstElementChild?.hasAttribute(BULLET_MARKER_ATTR));
}

export function toggleBulletAtSelection(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const block = closestBlock(root, selection.getRangeAt(0).startContainer);
  if (!block) return false;

  const first = block.firstElementChild;
  if (first && first.hasAttribute(BULLET_MARKER_ATTR)) {
    first.remove();
  } else {
    block.insertBefore(buildBulletMarker(), block.firstChild);
  }
  return true;
}

// ── hydrate (blocks -> DOM) ──────────────────────────────────────────

function buildRunElement(run: TemplateRichTextRun): Node[] {
  if (run.fieldName) {
    return [document.createTextNode(ZWS), buildFieldChipElement(run.fieldName, run), document.createTextNode(ZWS)];
  }
  const span = document.createElement("span");
  span.style.fontWeight = run.bold ? "700" : "400";
  span.style.fontStyle = run.italic ? "italic" : "normal";
  span.style.color = run.color;
  span.textContent = run.text;
  return [span];
}

/** Rebuilds `root`'s contentEditable DOM from `blocks` (one `<div>` per
 *  paragraph, always explicit, never relying on the browser's own implicit
 *  "bare text until the first Enter" structure, so typing always happens
 *  inside a real block). Called once when a box enters edit mode. */
export function renderRichTextToEditable(root: HTMLElement, blocks: TemplateRichTextBlock[]) {
  root.innerHTML = "";
  const list = blocks.length ? blocks : [{ bullet: false, runs: [{ text: "", bold: false, italic: false, color: "#000000" }] }];

  for (const block of list) {
    const div = document.createElement("div");
    if (block.bullet) div.appendChild(buildBulletMarker());
    for (const run of block.runs) {
      for (const node of buildRunElement(run)) div.appendChild(node);
    }
    if (!div.childNodes.length) div.appendChild(document.createElement("br"));
    root.appendChild(div);
  }
}

// ── serialize (DOM -> blocks) ────────────────────────────────────────

/** Groups root's direct children into per-paragraph node lists: a `<div>`
 *  child is its own block (the normal case, see `renderRichTextToEditable`
 *  and `defaultParagraphSeparator: 'div'` set on focus); any bare text/
 *  inline nodes directly under root (the browser's own behavior before the
 *  first Enter is pressed in a freshly-focused, freshly-typed-into box) are
 *  collected into one implicit leading block instead of being dropped. */
function getBlockChildGroups(root: HTMLElement): Node[][] {
  const blocks: Node[][] = [];
  let implicit: Node[] = [];
  for (const child of Array.from(root.childNodes)) {
    if (child instanceof HTMLElement && child.tagName === "DIV") {
      if (implicit.length) {
        blocks.push(implicit);
        implicit = [];
      }
      blocks.push(Array.from(child.childNodes));
    } else {
      implicit.push(child);
    }
  }
  if (implicit.length) blocks.push(implicit);
  return blocks;
}

function mergeStyle(base: InlineStyle, el: HTMLElement): InlineStyle {
  const fw = el.style.fontWeight;
  const fs = el.style.fontStyle;
  const color = el.style.color;
  return {
    bold: fw ? fw === "700" || fw === "bold" : base.bold,
    italic: fs ? fs === "italic" : base.italic,
    color: color ? (rgbToHex(color) ?? base.color) : base.color,
  };
}

function serializeBlock(children: Node[], defaultStyle: InlineStyle): TemplateRichTextBlock {
  let bullet = false;
  const runs: TemplateRichTextRun[] = [];

  const appendRun = (run: TemplateRichTextRun) => {
    if (!run.text) return;
    const last = runs[runs.length - 1];
    if (!run.fieldName && last && !last.fieldName && last.bold === run.bold && last.italic === run.italic && last.color === run.color) {
      last.text += run.text;
    } else {
      runs.push(run);
    }
  };

  const walk = (node: Node, style: InlineStyle) => {
    if (node instanceof HTMLElement && node.hasAttribute(BULLET_MARKER_ATTR)) {
      bullet = true;
      return;
    }
    if (node instanceof HTMLElement && node.hasAttribute(CHIP_ATTR)) {
      const fieldName = node.getAttribute(CHIP_ATTR) || "";
      // The chip carries its own weight, slant and color (buildFieldChipElement
      // sets them inline), and they must survive a serialize/hydrate cycle the
      // same way a styled span's do; reading the surrounding style instead
      // would silently un-bold a bold chip on the next keystroke.
      if (fieldName) appendRun({ text: `{${fieldName}}`, fieldName, ...mergeStyle(style, node) });
      return;
    }
    if (node instanceof HTMLElement && node.hasAttribute("data-overlay-chip-remove")) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || "").split(ZWS).join("");
      if (text) appendRun({ text, ...style });
      return;
    }
    if (node instanceof HTMLElement) {
      if (node.tagName === "BR") return;
      const next = mergeStyle(style, node);
      node.childNodes.forEach((child) => walk(child, next));
    }
  };

  for (const node of children) walk(node, defaultStyle);
  if (!runs.length) runs.push({ text: "", ...defaultStyle });
  return { bullet, runs };
}

/** The inverse of `renderRichTextToEditable`. `defaultStyle` is the
 *  placement's own whole-box bold/italic/color, used for any text node or
 *  span that doesn't explicitly override a given property (an unset CSS
 *  property means "didn't change this," not "plain/black"). */
export function serializeEditableToRichText(root: HTMLElement, defaultStyle: InlineStyle): TemplateRichTextBlock[] {
  const blocks = getBlockChildGroups(root).map((children) => serializeBlock(children, defaultStyle));
  return blocks.length ? blocks : [{ bullet: false, runs: [{ text: "", ...defaultStyle }] }];
}
