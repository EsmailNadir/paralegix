// pdf-lib and @pdf-lib/fontkit are required inside the functions that use them,
// not here. fontkit alone is over ten megabytes once loaded, and only filling an
// overlay template needs either; at the top they would load on every instance
// at boot.
const fs = require('fs');
const path = require('path');
const { getFieldBox, drawCheckbox } = require('../signatures/signingFieldValues');
const { fitTextToBox } = require('../signatures/textFit');
const { fitRichTextToBox } = require('../signatures/textFitRich');
const { ValidationError } = require('../../shared/errors/AppError');

/**
 * Most anchor-page copies one fill may add for repeater overflow, across every
 * repeater. Each copy is held in memory until the whole document is saved, and
 * the per-repeater row cap (500, templates.validation.ts) still allows 499
 * copies at one row per page, so the pages need a cap of their own.
 */
const OVERLAY_MAX_CONTINUATION_PAGES = 200;

/**
 * Stamp resolved field values onto a Document Overlay template's source PDF
 * and return the flattened result. Mirrors stampSessionFieldsOntoPdf in
 * signingFieldValues.ts (same percent-of-page box math) but draws from
 * matter/client/custom-field values instead of signer-submitted ones, lays
 * out repeater rows with page-overflow continuation pages, and additionally
 * supports two placement types signing fields don't have: 'textbox' (a
 * literal string typed once in the editor, not resolved from `values`) and
 * 'image' (a firm-uploaded image, stamped from `imageBuffers` rather than
 * `values`). Text styling (font family/size/bold/italic/color/align/bullet
 * list) is read off each placement rather than the fixed centered-Helvetica-
 * black layout signing fields use.
 *
 * @param {Buffer} pdfBuffer - the template's overlay_pdf_object_path bytes
 * @param {Array} placements - template_field_placements rows (camelCase), both
 *   non-repeater (repeaterName null) and repeater-column (repeaterName set,
 *   authored on row 0) placements
 * @param {Array} repeaters - templates.repeaters entries:
 *   { name, fields, anchorPage, anchorYPercent, rowHeightPercent, rowCount }
 * @param {Record<string,string>} values - resolved non-repeater field values,
 *   the same map fillTemplate() already builds for the docx fill path
 * @param {Record<string, Record<string,string>[]>} repeaterValues - resolved
 *   repeater row data, same shape fillTemplate() already builds
 * @param {Record<string,Buffer>} imageBuffers - bytes for every distinct
 *   'image'-type placement's imageObjectPath, keyed by that path (fetched by
 *   the caller, which is the one with GCS access)
 * @param {(fieldName: string, characters: string[]) => void} [onIncompleteField] -
 *   called once per field, after drawing, when some of its text could not be
 *   printed: `characters` are the ones no bundled font has (printed as "?"),
 *   and is empty when the box could not be drawn at all. Every repeater row
 *   of a column is merged into one call.
 */
export async function fillOverlayTemplate({
  pdfBuffer, placements, repeaters, values, repeaterValues, imageBuffers, onIncompleteField,
}: any) {
  // ignoreEncryption: accept PDFs carrying permission-only encryption (no user
  // password), matching the signing module's load option.
  const { PDFDocument } = require('pdf-lib');
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const getFont = createFontCache(pdfDoc);
  const images = imageBuffers || {};
  const incomplete = new Map<string, Set<string>>();
  const reportIncomplete = (fieldName: string, characters: string[]) => {
    const seen = incomplete.get(fieldName) || new Set<string>();
    for (const character of characters) seen.add(character);
    incomplete.set(fieldName, seen);
  };

  const allPlacements = Array.isArray(placements) ? placements : [];
  const repeaterList = Array.isArray(repeaters) ? repeaters : [];

  const nonRepeaterPlacements = allPlacements.filter((p: any) => !p.repeaterName);
  const columnsByRepeater = new Map<string, any[]>();
  for (const placement of allPlacements) {
    if (!placement.repeaterName) continue;
    const list = columnsByRepeater.get(placement.repeaterName) || [];
    list.push(placement);
    columnsByRepeater.set(placement.repeaterName, list);
  }

  // Precompute every continuation page BEFORE any drawing happens. A
  // continuation page is a copy of the (still pristine) anchor page, so it
  // carries over borders/headers baked into the source document; copying it
  // AFTER stamping would bake the anchor page's own field values into every
  // continuation page as well.
  type RepeaterLayout = { anchorPageIndex: number; rowsPerPage: number; pages: any[] };
  const layoutByRepeater = new Map<string, RepeaterLayout>();

  // Sized before any page is copied, so a fill over the cap is refused without
  // having allocated the pages it is refused for.
  const plans: { repeater: any; anchorPageIndex: number; anchorPage: any; rowsPerPage: number; continuationPagesNeeded: number }[] = [];
  for (const repeater of repeaterList) {
    const columns = columnsByRepeater.get(repeater.name);
    if (!columns || !columns.length) continue;

    const anchorPageIndex = Math.max(1, Math.trunc(Number(repeater.anchorPage)) || 1) - 1;
    const anchorPage = pdfDoc.getPages()[anchorPageIndex];
    if (!anchorPage) continue;

    const rows: any[] = Array.isArray(repeaterValues?.[repeater.name]) ? repeaterValues[repeater.name] : [];
    const rowsPerPage = Math.max(1, Math.trunc(Number(repeater.rowCount)) || 1);
    const continuationPagesNeeded = Math.max(0, Math.ceil(rows.length / rowsPerPage) - 1);
    plans.push({ repeater, anchorPageIndex, anchorPage, rowsPerPage, continuationPagesNeeded });
  }

  const totalContinuationPages = plans.reduce((sum, plan) => sum + plan.continuationPagesNeeded, 0);
  if (totalContinuationPages > OVERLAY_MAX_CONTINUATION_PAGES) {
    const overflowing = plans
      .filter((plan) => plan.continuationPagesNeeded > 0)
      .map((plan) => `"${plan.repeater.name}"`)
      .join(', ');
    throw new ValidationError(
      `These rows need ${totalContinuationPages} extra pages (repeater ${overflowing}), over the limit of `
      + `${OVERLAY_MAX_CONTINUATION_PAGES}. Fill fewer rows, or fit more rows on each page in the template layout.`,
    );
  }

  for (const { repeater, anchorPageIndex, anchorPage, rowsPerPage, continuationPagesNeeded } of plans) {
    const pages: any[] = [anchorPage];
    for (let i = 0; i < continuationPagesNeeded; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const [copiedPage] = await pdfDoc.copyPages(pdfDoc, [anchorPageIndex]);
      pdfDoc.addPage(copiedPage);
      pages.push(copiedPage);
    }

    layoutByRepeater.set(repeater.name, { anchorPageIndex, rowsPerPage, pages });
  }

  // Non-repeater fields: draw directly onto their authored page. A field
  // whose value doesn't resolve renders as an empty box, not an error.
  const nonRepeaterResolve = makeFieldResolver(values, null);
  for (const placement of nonRepeaterPlacements) {
    const page = pdfDoc.getPages()[(placement.page || 1) - 1];
    if (!page) continue;
    // eslint-disable-next-line no-await-in-loop
    await drawPlacementOrSkip(pdfDoc, getFont, images, page, placement, nonRepeaterResolve, reportIncomplete);
  }

  // Repeater rows: each row draws onto the anchor page or the matching
  // continuation page (rowsPerPage rows per page), only that repeater's
  // columns, never the anchor page's other static placements.
  for (const repeater of repeaterList) {
    const columns = columnsByRepeater.get(repeater.name);
    const layout = layoutByRepeater.get(repeater.name);
    if (!columns || !columns.length || !layout) continue;

    const rows: any[] = Array.isArray(repeaterValues?.[repeater.name]) ? repeaterValues[repeater.name] : [];
    const anchorYPercent = Number(repeater.anchorYPercent) || 0;
    const rowHeightPercent = Number(repeater.rowHeightPercent) || 0;

    for (let index = 0; index < rows.length; index += 1) {
      const rowData = rows[index];
      const pageOffset = Math.floor(index / layout.rowsPerPage);
      const rowWithinPage = index % layout.rowsPerPage;
      const targetPage = layout.pages[pageOffset];
      if (!targetPage) continue; // beyond the precomputed continuation pages; should not happen

      const yPercent = anchorYPercent + rowWithinPage * rowHeightPercent;
      const rowResolve = makeFieldResolver(values, rowData);
      for (const column of columns) {
        // eslint-disable-next-line no-await-in-loop
        await drawPlacementOrSkip(pdfDoc, getFont, images, targetPage, { ...column, yPercent }, rowResolve, reportIncomplete);
      }
    }
  }

  if (onIncompleteField) {
    for (const [fieldName, characters] of incomplete) onIncompleteField(fieldName, [...characters]);
  }

  return Buffer.from(await pdfDoc.save());
}

// ── fonts ────────────────────────────────────────────────────────────
//
// Helvetica/Times/Courier are pdf-lib's built-in standard fonts (12 total
// across their 4 style variants) - free to embed, since there are no bytes
// to fetch. Every other family is a real TTF bundled in ./fonts and embedded
// via fontkit (pdfDoc.registerFontkit below): Carlito/Caladea are metric-
// compatible substitutes for Calibri/Cambria (the same substitution
// LibreOffice itself makes), and PT Serif/PT Sans are their own real fonts.
// All are SIL Open Font License (see the OFL-*.txt files alongside them).
// A font is only ever embedded once per document, the first time a
// placement asks for it, and subset to the glyphs actually used.

const FONTS_DIR = path.join(__dirname, 'fonts');

const EMBEDDED_FONT_BYTES = new Map<string, Buffer>();
function loadFontBytes(fileName: string) {
  if (!EMBEDDED_FONT_BYTES.has(fileName)) {
    EMBEDDED_FONT_BYTES.set(fileName, fs.readFileSync(path.join(FONTS_DIR, fileName)));
  }
  return EMBEDDED_FONT_BYTES.get(fileName);
}

// Each variant is either a pdf-lib StandardFonts value (no file) or the
// bundled TTF's file name (fontkit-embedded). Built on first use, because the
// StandardFonts values come from pdf-lib, which this module loads lazily.
type FontFamilies = Record<string, Record<string, { standard?: string; file?: string }>>;
let fontFamiliesTable: FontFamilies | null = null;
function fontFamilies(): FontFamilies {
  if (fontFamiliesTable) return fontFamiliesTable;
  const { StandardFonts } = require('pdf-lib');
  fontFamiliesTable = {
    helvetica: {
      regular: { standard: StandardFonts.Helvetica },
      bold: { standard: StandardFonts.HelveticaBold },
      italic: { standard: StandardFonts.HelveticaOblique },
      boldItalic: { standard: StandardFonts.HelveticaBoldOblique },
    },
    times: {
      regular: { standard: StandardFonts.TimesRoman },
      bold: { standard: StandardFonts.TimesRomanBold },
      italic: { standard: StandardFonts.TimesRomanItalic },
      boldItalic: { standard: StandardFonts.TimesRomanBoldItalic },
    },
    courier: {
      regular: { standard: StandardFonts.Courier },
      bold: { standard: StandardFonts.CourierBold },
      italic: { standard: StandardFonts.CourierOblique },
      boldItalic: { standard: StandardFonts.CourierBoldOblique },
    },
    calibri: {
      regular: { file: 'Carlito-Regular.ttf' },
      bold: { file: 'Carlito-Bold.ttf' },
      italic: { file: 'Carlito-Italic.ttf' },
      boldItalic: { file: 'Carlito-BoldItalic.ttf' },
    },
    cambria: {
      regular: { file: 'Caladea-Regular.ttf' },
      bold: { file: 'Caladea-Bold.ttf' },
      italic: { file: 'Caladea-Italic.ttf' },
      boldItalic: { file: 'Caladea-BoldItalic.ttf' },
    },
    'pt-serif': {
      regular: { file: 'PT_Serif-Web-Regular.ttf' },
      bold: { file: 'PT_Serif-Web-Bold.ttf' },
      italic: { file: 'PT_Serif-Web-Italic.ttf' },
      boldItalic: { file: 'PT_Serif-Web-BoldItalic.ttf' },
    },
    'pt-sans': {
      regular: { file: 'PT_Sans-Web-Regular.ttf' },
      bold: { file: 'PT_Sans-Web-Bold.ttf' },
      italic: { file: 'PT_Sans-Web-Italic.ttf' },
      boldItalic: { file: 'PT_Sans-Web-BoldItalic.ttf' },
    },
  };
  return fontFamiliesTable;
}

// Where a value goes when its chosen face cannot draw one of its characters,
// tried in order. The standard fonts are WinAnsi only, so "Łukasz Żółć" or any
// Cyrillic name cannot be drawn in them at all; each falls back to the bundled
// face closest in style, then to Carlito, which also covers Greek and
// Vietnamese. No bundled face covers CJK, Hebrew or Arabic: those characters
// print as "?" and are reported (see chooseFamilyFor).
const FONT_FALLBACKS: Record<string, string[]> = {
  helvetica: ['pt-sans', 'calibri'],
  times: ['pt-serif', 'calibri'],
  courier: ['pt-sans', 'calibri'],
  cambria: ['pt-serif', 'calibri'],
  'pt-serif': ['calibri'],
  'pt-sans': ['calibri'],
  calibri: [],
};

const UNDRAWN_CHARACTER = '?';

/** NFC: an accent typed as a separate combining mark (common from macOS
 *  input and pasted text) joins its letter, so "e" + U+0301 is checked and
 *  drawn as the one glyph "é" that every face has, rather than switching
 *  fonts for a bare mark that pdf-lib cannot position anyway. */
function toComposed(text: string) {
  return text.normalize('NFC');
}

// fontkit parses of the bundled faces, kept only for glyph lookups. Embedding
// a face just to ask what it covers would write it into the document.
const GLYPH_TABLES = new Map<string, any>();
function glyphTable(fileName: string) {
  if (!GLYPH_TABLES.has(fileName)) {
    GLYPH_TABLES.set(fileName, require('@pdf-lib/fontkit').create(loadFontBytes(fileName)));
  }
  return GLYPH_TABLES.get(fileName);
}

/** Whether `family`'s face for this style can draw the character. Line
 *  breaks and tabs are layout, never drawn, so they always pass. */
function canDraw(family: string, bold: any, italic: any, character: string) {
  if (character === '\n' || character === '\r' || character === '\t') return true;
  const families = fontFamilies();
  const spec = (families[family] || families.times)[fontVariant(bold, italic)];
  const codePoint = character.codePointAt(0) as number;
  if (spec.standard) {
    return require('@pdf-lib/standard-fonts').Encodings.WinAnsi.canEncodeUnicodeCodePoint(codePoint);
  }
  return glyphTable(spec.file as string).hasGlyphForCodePoint(codePoint);
}

type StyledPiece = { text: string; bold?: any; italic?: any };

function undrawable(family: string, pieces: StyledPiece[]) {
  const missing: string[] = [];
  for (const piece of pieces) {
    for (const character of piece.text) {
      if (!canDraw(family, piece.bold, piece.italic, character) && !missing.includes(character)) missing.push(character);
    }
  }
  return missing;
}

/**
 * The family to draw a placement's text in: its own, when that face covers
 * every character, otherwise the first fallback that does. When none covers
 * them all (CJK in any bundled face), the candidate missing the fewest wins
 * and `missing` lists what it still cannot draw. One family for the whole
 * placement, so a single box never mixes two typefaces.
 */
export function chooseFamilyFor(family: any, pieces: StyledPiece[]) {
  const own = fontFamilies()[family] ? family : 'times';
  const candidates = [own, ...(FONT_FALLBACKS[own] || [])];
  let best = { family: own, missing: undrawable(own, pieces) };
  for (const candidate of candidates.slice(1)) {
    if (!best.missing.length) break;
    const missing = undrawable(candidate, pieces);
    if (missing.length < best.missing.length) best = { family: candidate, missing };
  }
  return best;
}

/** The text with every character the face cannot draw replaced by "?", so
 *  the rest of the value still prints and the gap is visible on the page. */
function withUndrawnMarked(family: string, piece: StyledPiece) {
  let text = '';
  for (const character of piece.text) {
    text += canDraw(family, piece.bold, piece.italic, character) ? character : UNDRAWN_CHARACTER;
  }
  return text;
}

function fontVariant(bold: any, italic: any) {
  if (bold && italic) return 'boldItalic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return 'regular';
}

function createFontCache(pdfDoc: any) {
  // Required before embedding any non-standard (fontkit) font; harmless to
  // call even for a document that only ever asks for standard fonts.
  pdfDoc.registerFontkit(require('@pdf-lib/fontkit'));

  const cache = new Map<string, Promise<any>>();
  return function getFont(family: any, bold: any, italic: any) {
    const families = fontFamilies();
    const variants = families[family] || families.times;
    const variant = fontVariant(bold, italic);
    const key = `${family || 'times'}:${variant}`;
    if (!cache.has(key)) {
      const spec = variants[variant];
      const embedPromise = spec.standard
        ? pdfDoc.embedFont(spec.standard)
        : pdfDoc.embedFont(loadFontBytes(spec.file as string), { subset: true });
      cache.set(key, embedPromise);
    }
    return cache.get(key);
  };
}

// ── drawing ──────────────────────────────────────────────────────────

function resolveColor(hex: any) {
  const { rgb } = require('pdf-lib');
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) return rgb(0, 0, 0);
  const value = parseInt(match[1], 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

// Looks up a field name against the current row's own data first (a
// repeater column referencing a sibling column, the closer/more specific
// scope), then the top-level firm/client/matter/date auto-fill map, so a
// rich-text field chip inside a repeater textbox column can reference
// either. `rowData` is null for a non-repeater placement, which just skips
// straight to `values`.
function makeFieldResolver(values: any, rowData: any) {
  return (fieldName: string) => {
    if (rowData && Object.prototype.hasOwnProperty.call(rowData, fieldName)) return rowData[fieldName];
    if (values && Object.prototype.hasOwnProperty.call(values, fieldName)) return values[fieldName];
    return undefined;
  };
}

/**
 * One placement's failure stays that placement's. Measuring a value in a
 * font that cannot encode one of its characters (a CJK name in a WinAnsi
 * standard font, an emoji in any of the bundled faces) throws from inside
 * the fit, before any drawText and so before the per-line guards there.
 * Left uncaught, that one box would abort the whole fill with every other
 * field still blank; the signing module's stampSessionFieldsOntoPdf makes
 * the same per-field choice for the same reason.
 */
async function drawPlacementOrSkip(
  pdfDoc: any, getFont: any, images: Record<string, any>, page: any, placement: any, resolveField: any,
  reportIncomplete: (fieldName: string, characters: string[]) => void,
) {
  try {
    const missing = await drawPlacementValue(pdfDoc, getFont, images, page, placement, resolveField);
    if (missing.length) reportIncomplete(placement.fieldName, missing);
  } catch (error: any) {
    console.error(`[templates] Skipped overlay placement "${placement.fieldName}" on page ${placement.page}:`, error?.message);
    reportIncomplete(placement.fieldName, []);
  }
}

/** Draws plain text in the first family that can print it (see
 *  chooseFamilyFor) and returns the characters none could. The bullet
 *  prefix is part of what has to be drawable. */
async function drawPlainText(getFont: any, page: any, placement: any, value: any, box: any) {
  const raw = toComposed(typeof value === 'string' ? value : String(value ?? ''));
  const piece = { text: applyBulletList(raw, placement.bulletList), bold: placement.bold, italic: placement.italic };
  const { family, missing } = chooseFamilyFor(placement.fontFamily, [piece]);
  const font = await getFont(family, placement.bold, placement.italic);
  const printable = missing.length ? withUndrawnMarked(family, { ...piece, text: raw }) : raw;
  drawStyledText(page, font, placement, printable, box);
  return missing;
}

async function drawPlacementValue(
  pdfDoc: any, getFont: any, images: Record<string, any>, page: any, placement: any, resolveField: any,
): Promise<string[]> {
  if (placement.fieldType === 'image') {
    await drawPlacementImage(pdfDoc, images, page, placement);
    return [];
  }

  const pageSize = page.getSize();
  const box = getFieldBox(placement, pageSize.width, pageSize.height);

  if (placement.fieldType === 'textbox') {
    return drawRichText(page, getFont, placement, resolveField, box);
  }

  const value = resolveField(placement.fieldName);
  if (value === undefined || value === null || value === '') return []; // empty box, not an error

  if (placement.fieldType === 'checkbox') {
    if (value === true || value === 'true' || value === 1 || value === '1') {
      drawCheckbox(page, box);
    }
    return [];
  }

  return drawPlainText(getFont, page, placement, value, box);
}

// Not real list markup (a placement's content is a single string, not HTML):
// prefixes every non-blank line with a bullet before layout. Mirrored by the
// frontend's own applyBulletList in TemplateOverlayFieldBox.tsx so the canvas
// preview and the stamped output agree.
function applyBulletList(text: string, bulletList: any) {
  if (!bulletList) return text;
  return text.split('\n').map((line) => (line.trim() ? `•  ${line}` : line)).join('\n');
}

/**
 * Draws text/date and textbox placements, honoring the placement's own
 * font/size/color/alignment rather than the fixed centered-black layout
 * signing fields use. A user-chosen font size is still only a MAXIMUM: long
 * values still shrink-to-fit and wrap via fitTextToBox, so a value that
 * doesn't fit at the chosen size degrades instead of overflowing the box.
 * Placements created before this styling existed have `fontSize: null`,
 * which falls back to the original auto-fit-to-box behavior: 55% of the
 * box height, between 10pt and 18pt, the one rule every field type shares
 * with the editor's own preview (TemplateOverlayFieldBox's autoFontSize).
 */
export function autoFontSize(boxHeight: number) {
  return Math.max(10, Math.min(boxHeight * 0.55, 18));
}

export function drawStyledText(page: any, font: any, placement: any, value: any, box: any) {
  let text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (placement.fieldType === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
    // Both the parse and the format are pinned to UTC (not left to the SERVER
    // PROCESS's ambient local zone): a bare 'YYYY-MM-DD' has no time-of-day to
    // roll across a zone boundary, so anchoring in UTC always reproduces the
    // literal date, the same way a same-zone round trip would - but without
    // depending on which zone the process happens to be running in.
    const parsed = new Date(`${text}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) {
      text = parsed.toLocaleDateString('en-US', { timeZone: 'UTC' });
    }
  }
  if (!text) return;
  text = applyBulletList(text, placement.bulletList);

  const requestedSize = Number(placement.fontSize);
  const maxFontSize = Number.isFinite(requestedSize) && requestedSize > 0
    ? requestedSize
    : autoFontSize(box.boxHeight);

  const { lines, fontSize, lineHeight } = fitTextToBox(
    text,
    box.boxWidth,
    box.boxHeight,
    maxFontSize,
    (line: string, size: number) => font.widthOfTextAtSize(line, size),
  );
  const color = resolveColor(placement.color);
  const align = placement.textAlign === 'center' || placement.textAlign === 'right' ? placement.textAlign : 'left';
  const blockHeight = lines.length * lineHeight;
  let y = box.y + Math.max(2, (box.boxHeight - blockHeight) / 2) + blockHeight - fontSize;

  for (const line of lines) {
    const lineWidth = font.widthOfTextAtSize(line, fontSize);
    let x = box.x + 4;
    if (align === 'center') {
      x = box.x + Math.max(4, (box.boxWidth - lineWidth) / 2);
    } else if (align === 'right') {
      x = box.x + Math.max(4, box.boxWidth - lineWidth - 4);
    }

    try {
      page.drawText(line, { x, y, size: fontSize, font, color });
    } catch {
      // Skip unsupported glyphs in WinAnsi fonts.
    }
    y -= lineHeight;
  }
}

/** Embeds all 4 style variants of a family up front so `drawRichText` can
 *  switch fonts per run without an `await` inside its draw loop; free after
 *  the first placement of a given family, since `getFont` caches per
 *  document (see `createFontCache`). */
async function fontVariantsFor(getFont: any, family: any) {
  const [regular, bold, italic, boldItalic] = await Promise.all([
    getFont(family, false, false),
    getFont(family, true, false),
    getFont(family, false, true),
    getFont(family, true, true),
  ]);
  return { regular, bold, italic, boldItalic };
}

function pickFontVariant(variants: any, bold: any, italic: any) {
  if (bold && italic) return variants.boldItalic;
  if (bold) return variants.bold;
  if (italic) return variants.italic;
  return variants.regular;
}

// Substitutes each run's resolved value in place of its fieldName (a run
// without one is already literal text), so fitRichTextToBox/drawRichText
// never need to know about resolution at all, only plain styled runs.
function resolveRichTextBlocks(blocks: any[], resolveField: any) {
  return blocks.map((block: any) => ({
    bullet: Boolean(block.bullet),
    runs: (block.runs || []).map((run: any) => ({
      text: toComposed(run.fieldName ? String(resolveField(run.fieldName) ?? '') : String(run.text ?? '')),
      bold: Boolean(run.bold),
      italic: Boolean(run.italic),
      color: run.color || '#000000',
    })),
  }));
}

/**
 * Mixed-formatting counterpart of drawStyledText for a 'textbox' placement
 * with `richText` set: same shrink-to-fit-then-wrap and box/align/y math,
 * generalized (via fitRichTextToBox) to lay out more than one bold/italic/
 * color run per line, switching font variant and color per drawn segment.
 */
export async function drawRichText(page: any, getFont: any, placement: any, resolveField: any, box: any): Promise<string[]> {
  let resolved = resolveRichTextBlocks(placement.richText, resolveField);
  if (!resolved.some((block: any) => block.runs.some((run: any) => run.text.trim()))) return []; // empty box, not an error

  // The bullet glyph is drawn by the layout, so it has to be drawable too.
  const pieces = resolved.flatMap((block: any) => [
    ...(block.bullet ? [{ text: '•', bold: false, italic: false }] : []),
    ...block.runs,
  ]);
  const { family, missing } = chooseFamilyFor(placement.fontFamily, pieces);
  if (missing.length) {
    resolved = resolved.map((block: any) => ({
      ...block,
      runs: block.runs.map((run: any) => ({ ...run, text: withUndrawnMarked(family, run) })),
    }));
  }

  const variants = await fontVariantsFor(getFont, family);
  const measure = (text: string, size: number, bold: any, italic: any) =>
    pickFontVariant(variants, bold, italic).widthOfTextAtSize(text, size);

  const requestedSize = Number(placement.fontSize);
  const maxFontSize = Number.isFinite(requestedSize) && requestedSize > 0
    ? requestedSize
    : autoFontSize(box.boxHeight);

  const { lines, fontSize, lineHeight } = fitRichTextToBox(resolved, box.boxWidth, box.boxHeight, maxFontSize, measure);
  const align = placement.textAlign === 'center' || placement.textAlign === 'right' ? placement.textAlign : 'left';
  const blockHeight = lines.length * lineHeight;
  let y = box.y + Math.max(2, (box.boxHeight - blockHeight) / 2) + blockHeight - fontSize;

  for (const line of lines) {
    const lineWidth = line.segments.reduce((w: number, s: any) => w + measure(s.text, fontSize, s.bold, s.italic), 0);
    let x = box.x + 4;
    if (align === 'center') {
      x = box.x + Math.max(4, (box.boxWidth - lineWidth) / 2);
    } else if (align === 'right') {
      x = box.x + Math.max(4, box.boxWidth - lineWidth - 4);
    }

    for (const segment of line.segments) {
      const font = pickFontVariant(variants, segment.bold, segment.italic);
      const color = resolveColor(segment.color);
      try {
        page.drawText(segment.text, { x, y, size: fontSize, font, color });
      } catch {
        // Skip unsupported glyphs in WinAnsi fonts.
      }
      x += font.widthOfTextAtSize(segment.text, fontSize);
    }
    y -= lineHeight;
  }
  return missing;
}

/** Scales the image to fit inside the box, preserving aspect ratio, centered. */
async function drawPlacementImage(pdfDoc: any, images: Record<string, any>, page: any, placement: any) {
  const buffer = placement.imageObjectPath ? images[placement.imageObjectPath] : null;
  if (!buffer) return; // not uploaded, or the caller's fetch failed: empty box, not an error

  let image;
  try {
    const mimeType = String(placement.imageMimeType || '').toLowerCase();
    image = mimeType.includes('png') ? await pdfDoc.embedPng(buffer) : await pdfDoc.embedJpg(buffer);
  } catch {
    return; // corrupt or unsupported bytes: leave the box empty rather than failing the whole fill
  }

  const pageSize = page.getSize();
  const box = getFieldBox(placement, pageSize.width, pageSize.height);
  const scale = Math.min(box.boxWidth / image.width, box.boxHeight / image.height);
  const width = image.width * scale;
  const height = image.height * scale;

  page.drawImage(image, {
    x: box.x + (box.boxWidth - width) / 2,
    y: box.y + (box.boxHeight - height) / 2,
    width,
    height,
  });
}
