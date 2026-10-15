"use client";

import type { PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import type { TemplatePlacementFontFamily } from "@/types/template";
import { isBoldByName, isItalicByName, normalizePdfFontName } from "@/lib/pdfFontNames";

/**
 * A box on a PDF page, as a percentage of that page's own width and height.
 *
 * The same coordinate space every overlay placement is stored in, so a box here
 * is positioned on screen exactly the way a placement is, and stays put through
 * a zoom without any conversion of its own.
 */
export type PercentBox = {
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
};

/** One run of text on a page, with the box it occupies and the font it is set in. */
export type PdfTextRun = PercentBox & {
  text: string;
  /** The family as a reader would name it, weight and slant words removed. */
  familyLabel: string;
  /** The nearest family the overlay editor can actually stamp. */
  family: TemplatePlacementFontFamily;
  /** Where the run sits on its line. Used to decide which line a selection
   *  band is on: two lines' boxes overlap once ascent and descent are counted,
   *  but their baselines never do. */
  baselineYPercent: number;
  /** Size in PDF points, which is what the editor's own size control means. */
  sizePt: number;
  bold: boolean;
  italic: boolean;
  /** False when the run was read before pdf.js had loaded its font, so the
   *  family and weight came from the generic fallback and are worth a
   *  re-read once the page has painted. */
  faceKnown: boolean;
};

/**
 * What the toolbar reports for the current selection.
 *
 * A property is null when the selection covers more than one value for it. That
 * is deliberate and matches every word processor: a selection spanning a heading
 * and its body shows a blank font box rather than picking one of the two.
 */
export type FontSample = {
  familyLabel: string | null;
  family: TemplatePlacementFontFamily | null;
  sizePt: number | null;
  bold: boolean | null;
  italic: boolean | null;
};

/**
 * Which of the seven stampable families a PDF font is closest to.
 *
 * Order matters: the specific names have to be tested before the generic
 * serif/sans catch-alls at the bottom, or every Cambria run would come back as
 * Times.
 */
const FAMILY_PATTERNS: Array<{ family: TemplatePlacementFontFamily; test: RegExp }> = [
  { family: "courier", test: /courier|mono|consolas|menlo|monaco|typewriter/i },
  { family: "cambria", test: /cambria|caladea/i },
  { family: "calibri", test: /calibri|carlito/i },
  { family: "pt-serif", test: /pt serif/i },
  { family: "pt-sans", test: /pt sans/i },
  { family: "helvetica", test: /helvetica|arial|verdana|tahoma|segoe|roboto|lato|open sans|liberation sans|nimbus sans|sans/i },
  { family: "times", test: /times|georgia|garamond|palatino|book antiqua|minion|serif|roman/i },
];

export function matchOverlayFontFamily(psName: string): TemplatePlacementFontFamily {
  const name = normalizePdfFontName(psName);
  for (const { family, test } of FAMILY_PATTERNS) {
    if (test.test(name)) return family;
  }
  // Nothing recognisable. A stamped box still has to be set in something, and
  // Times is what a newly drawn placement already defaults to.
  return "times";
}

/**
 * A font name as a reader would say it out loud.
 *
 * Beyond `normalizePdfFontName` this splits the run-together spellings a PDF
 * really carries (`TimesNewRomanPSMT`, `ArialMT`) and drops the weight and slant
 * words, because the sampler reports those as separate flags and showing them
 * twice reads as a contradiction when only one of the two is mixed.
 */
export function pdfFontDisplayFamily(psName: string): string {
  const normalized = normalizePdfFontName(psName);
  const spaced = normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // Word's PostScript names end in PSMT or PS-BoldMT; once the hyphen is a
    // space the PS and the MT are separate words and both are noise.
    .replace(/\b(PS)?(MT|MS)\b|\bPS\b/g, " ")
    // A PDF writer that embeds the same face more than once numbers the copies:
    // pdf-lib reports `Carlito-Regular-8450`. Three digits or more is the tag;
    // shorter runs stay, because a weight really can be part of a name
    // (`Helvetica 65 Medium`).
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/\b(bold|black|heavy|demi|semi ?bold|light|thin|medium|italic|oblique|slanted|regular)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return spaced || normalized || "Unknown";
}

/**
 * The PostScript name pdf.js holds for one of a page's fonts.
 *
 * The real name only exists on the font object pdf.js registers while the page
 * renders, so this is empty for a page whose canvas has not painted yet. In the
 * overlay editor that never happens in practice, because a selection requires a
 * text layer, which requires a rendered page. `has` keeps the unlucky ordering
 * from throwing rather than returning nothing.
 */
type PdfFontFace = {
  name?: string;
  /** Set from the font program itself, and so more trustworthy than the name.
   *  Left undefined for an embedded subset whose program does not declare it. */
  bold?: boolean;
  italic?: boolean;
};

function readFontFace(page: PDFPageProxy, fontId: string): PdfFontFace | null {
  if (!fontId || !page.commonObjs.has(fontId)) return null;
  return (page.commonObjs.get(fontId) as PdfFontFace | null) ?? null;
}

/**
 * Every run of text on a page, boxed and described.
 *
 * Read once per page and cached by the caller: `getTextContent` walks the whole
 * page's content stream, which is far too much work to repeat on every tick of a
 * selection drag.
 */
export async function readPageTextRuns(page: PDFPageProxy): Promise<PdfTextRun[]> {
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  const runs: PdfTextRun[] = [];

  for (const entry of textContent.items) {
    // `items` also carries marked-content markers, which have no `str` and no
    // position; only real text items do.
    if (!("str" in entry)) continue;
    const item = entry as TextItem;
    if (!item.str.trim()) continue;

    const [, , c, d, originX, originY] = item.transform as number[];
    // The y column of the text matrix, not the x column. pdf.js builds the
    // matrix as [size * horizontalScale, 0, 0, size, 0, rise], so the x column
    // carries the PDF's Tz horizontal scaling as well as the size, and reads
    // half the real size on a condensed line. This is what pdf.js's own text
    // layer measures.
    const sizePt = Math.hypot(c, d);
    if (!(sizePt > 0)) continue;

    // A run's box is its baseline plus the font's own rise and drop. `descent`
    // is reported negative, so both edges are the baseline plus a signed offset.
    const style = textContent.styles[item.fontName];
    const ascent = (style?.ascent ?? 0.75) * sizePt;
    const descent = (style?.descent ?? -0.25) * sizePt;
    // Going through the viewport rather than flipping y by hand keeps a rotated
    // page correct: `getViewport` has already applied the page's /Rotate.
    const [left, top] = viewport.convertToViewportPoint(originX, originY + ascent) as [number, number];
    const [right, bottom] = viewport.convertToViewportPoint(originX + item.width, originY + descent) as [number, number];

    // `style.fontFamily` is not the document's font name: pdf.js sets it to the
    // face's generic fallback, so it reads "sans-serif" for every sans font in
    // the file. It is still the best guess at a family when the real name is
    // missing, but it must never be shown as one.
    const face = readFontFace(page, item.fontName);
    const psName = face?.name ?? "";
    const generic = style?.fontFamily ?? "";
    const [, baselineY] = viewport.convertToViewportPoint(originX, originY) as [number, number];

    runs.push({
      text: item.str,
      xPercent: (Math.min(left, right) / viewport.width) * 100,
      yPercent: (Math.min(top, bottom) / viewport.height) * 100,
      widthPercent: (Math.abs(right - left) / viewport.width) * 100,
      heightPercent: (Math.abs(bottom - top) / viewport.height) * 100,
      baselineYPercent: (baselineY / viewport.height) * 100,
      familyLabel: pdfFontDisplayFamily(psName || generic),
      family: matchOverlayFontFamily(psName || generic),
      // A tenth of a point is finer than any control offers and still coarse
      // enough that two runs of the same font compare equal.
      sizePt: Math.round(sizePt * 10) / 10,
      // The font program's own flags where it declares them. An embedded subset
      // often does not, and then the name is the only thing left to read.
      bold: face?.bold ?? isBoldByName(psName),
      italic: face?.italic ?? isItalicByName(psName),
      faceKnown: Boolean(psName),
    });
  }

  return runs;
}

/**
 * The runs whose box contains one point on the page, for sampling from a
 * click rather than a drag. A click has no band to test a baseline against,
 * so this uses the run's whole box (ascent to descent). Two lines' boxes can
 * overlap on tight leading, and then both are returned; `summarizeRuns`
 * blanks whatever they disagree on, which is the honest answer for a click
 * that really did land between two lines.
 */
export function runsAtPoint(runs: PdfTextRun[], point: { xPercent: number; yPercent: number }): PdfTextRun[] {
  return runs.filter((run) => (
    point.xPercent >= run.xPercent
    && point.xPercent <= run.xPercent + run.widthPercent
    && point.yPercent >= run.yPercent
    && point.yPercent <= run.yPercent + run.heightPercent
  ));
}

/**
 * The runs a set of selection rectangles covers.
 *
 * A selection rectangle is a thin band over one line. Testing it against a run's
 * full box does not separate the lines: a box spans the font's whole rise and
 * drop, so on tight leading, or in a face with a tall ascent, one line's box
 * reaches into its neighbour's band and the readout reports the wrong line. A
 * run's baseline is inside its own band and never inside another's, because the
 * text layer draws each band from its baseline upward by the font's ascent.
 */
export function runsUnderBoxes(runs: PdfTextRun[], boxes: PercentBox[]): PdfTextRun[] {
  return runs.filter((run) =>
    boxes.some((box) => (
      run.xPercent < box.xPercent + box.widthPercent
      && run.xPercent + run.widthPercent > box.xPercent
      && run.baselineYPercent >= box.yPercent
      && run.baselineYPercent <= box.yPercent + box.heightPercent
    )));
}

/** The one value every run agrees on, or null if they do not all agree. */
function agreed<T>(values: T[]): T | null {
  const first = values[0];
  return values.every((value) => value === first) ? first : null;
}

export function summarizeRuns(runs: PdfTextRun[]): FontSample | null {
  if (runs.length === 0) return null;
  return {
    familyLabel: agreed(runs.map((run) => run.familyLabel)),
    family: agreed(runs.map((run) => run.family)),
    sizePt: agreed(runs.map((run) => run.sizePt)),
    bold: agreed(runs.map((run) => run.bold)),
    italic: agreed(runs.map((run) => run.italic)),
  };
}
