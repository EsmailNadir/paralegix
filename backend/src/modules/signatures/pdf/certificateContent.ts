/**
 * Drawing the Signature Certificate, as content streams rather than as a page.
 *
 * `appendPage.ts` knows how to hang new leaves off a document's page tree
 * without rewriting it. It does not know what goes ON them, which is this file:
 * the certificate's own text, laid out into as many pages as the content needs
 * and handed back as page dictionaries plus stream objects the writer can take
 * unchanged.
 *
 * Two things drive every decision here.
 *
 * IT PAGINATES. The certificate lists signers, and a list has no bound. A fixed
 * one-page layout is not a cosmetic limitation: it silently omits the eleventh
 * signer, and a certificate that omits a signer is worse than no certificate
 * because it misstates who executed the document while looking complete. So the
 * content is measured against the usable box and flows. A signer entry is
 * atomic, and moves to the next page whole rather than being cut in half, since
 * a name at the foot of one page with the IP address that belongs to it at the
 * head of the next reads as if someone else signed from that address. The one
 * exception is an entry that cannot fit a page even alone, where the choice is
 * splitting it or dropping it.
 *
 * EVERY STRING IS ESCAPED. `(`, `)` and `\` are content-stream syntax, and
 * signer names are typed by the person signing. A name that closes its own
 * string object turns the remainder of the page into operators. Text is
 * therefore serialized through the writer's string serializer, the same one the
 * object graph uses, rather than interpolated.
 *
 * Only the standard 14 fonts are used, so nothing has to be embedded and a
 * certificate page costs a few kilobytes regardless of the document it joins.
 */
import type { PDFFont } from 'pdf-lib';

import { AppError } from '../../../shared/errors/AppError';
import { formatTimestamp, sanitizeForStandardFont } from '../certificatePage';
import type { PdfDict, PdfRef, PdfValue } from './types';
import { serializeValue, type AppendedObject } from './writer';

export class PdfCertificateError extends AppError {
  constructor(message: string) {
    super(message, 400, 'PDF_CERTIFICATE_ERROR');
  }
}

/** Resource names for the two fonts. The page is built here, so they are free. */
const FONT_REGULAR = 'PxHelv';
const FONT_BOLD = 'PxHelvB';

const TITLE_SIZE = 18;
const SECTION_SIZE = 11;
const FIELD_SIZE = 9.5;
const BODY_SIZE = 9;
const NOTE_SIZE = 8;

const TITLE_ADVANCE = 30;
const RULE_ADVANCE = 16;
const SECTION_ADVANCE = 12;
const LINE_ADVANCE = 14;
const FIELD_GAP = 4;
const SIGNER_GAP = 6;
const SECTION_GAP = 10;
const NOTE_ADVANCE = 22;

/** Grey levels, matching what the certificate has always rendered. */
const GREY = {
  title: 0.1,
  section: 0.15,
  label: 0.35,
  value: 0.1,
  rule: 0.7,
  footer: 0.45,
};

/** Widest label column, narrowed on a page too small to give it that much. */
const LABEL_COLUMN = 180;

/** A user agent past this is trimmed so it cannot dominate the certificate. */
const USER_AGENT_LIMIT = 160;

export interface CertificateSigner {
  name?: string | null;
  roleLabel?: string | null;
  email?: string | null;
  completedAt?: string | null;
  signerIp?: string | null;
  signerUserAgent?: string | null;
}

/**
 * Everything the certificate states.
 *
 * The top-level signer fields are the fallback for a session recorded before
 * per-signer rows existed: when `signers` is empty they become the one entry.
 */
export interface CertificateData {
  /** Defaults to `SIGNATURE CERTIFICATE`. */
  title?: string | null;
  documentTitle?: string | null;
  transactionId?: string | null;
  /** Pages of the executed document, not counting the certificate itself. */
  documentPageCount?: number | null;
  signers?: CertificateSigner[] | null;
  sessionCreatedAt?: string | null;
  signedAt?: string | null;
  originalDocumentHash?: string | null;
  deliveryDocumentHash?: string | null;
  consentStatement?: string | null;
}

/** The box each certificate page is drawn into, in points. */
export interface CertificatePageGeometry {
  width: number;
  height: number;
  /** Uniform margin on all four sides. */
  margin: number;
}

export interface CertificateContentPlan {
  /**
   * One entry per certificate page, in order.
   *
   * `dictionary` is a leaf page WITHOUT `/Parent`, which is what
   * `planAppendedPages` expects and fills in. `content` goes straight into
   * `buildIncrementalUpdate`'s object list.
   */
  pages: Array<{ dictionary: PdfDict; content: AppendedObject }>;
  /** First object number still free once the content streams have taken theirs. */
  nextObjectNumber: number;
}

// --- text measurement ---------------------------------------------------------

/**
 * Helvetica metrics, borrowed from pdf-lib.
 *
 * Measuring text needs the font's glyph widths. pdf-lib is already a dependency
 * and carries the standard 14 font metrics, so they are read from an empty
 * throwaway document rather than copied into this repo as a width table that
 * would then be one more thing to keep correct. Nothing is embedded: only the
 * widths are read.
 */
let metricsPromise: Promise<{ regular: PDFFont; bold: PDFFont }> | null = null;

async function loadMetrics(): Promise<{ regular: PDFFont; bold: PDFFont }> {
  if (!metricsPromise) {
    metricsPromise = (async () => {
      // Required here, not at the top: pdf-lib is megabytes once loaded and is
      // needed only when the first document is signed.
      const { PDFDocument, StandardFonts } = require('pdf-lib') as typeof import('pdf-lib');
      const document = await PDFDocument.create();
      return {
        regular: await document.embedFont(StandardFonts.Helvetica),
        bold: await document.embedFont(StandardFonts.HelveticaBold),
      };
    })().catch((error) => {
      // A failed load must not be cached, or every later certificate in this
      // process fails with the first one's error.
      metricsPromise = null;
      throw error;
    });
  }
  return metricsPromise;
}

interface Measure {
  (text: string, size: number, bold: boolean): number;
}

// --- the layout model ---------------------------------------------------------

type Draw =
  | { kind: 'text'; text: string; dx: number; size: number; bold: boolean; grey: number }
  | { kind: 'rule'; grey: number };

/**
 * One baseline of content.
 *
 * A row is the unit a page break may fall between. `advance` is how far the
 * cursor drops after it, so a label and the first line of its value share one
 * row and cannot be separated.
 */
interface Row {
  draws: Draw[];
  advance: number;
}

/**
 * Rows that belong together.
 *
 * A group is never split across pages unless it is taller than a whole page.
 * One signer is one group, which is what keeps an entry intact.
 */
interface Group {
  rows: Row[];
  height: number;
}

const group = (rows: Row[]): Group => ({
  rows,
  height: rows.reduce((total, row) => total + row.advance, 0),
});

// --- laying out ---------------------------------------------------------------

export async function planCertificateContent(options: {
  data: CertificateData;
  geometry: CertificatePageGeometry;
  /** Object number the first content stream takes. Later pages take the next. */
  firstObjectNumber: number;
}): Promise<CertificateContentPlan> {
  const { data, geometry, firstObjectNumber } = options;

  assertGeometry(geometry);
  if (!Number.isSafeInteger(firstObjectNumber) || firstObjectNumber <= 0) {
    throw new PdfCertificateError(`Invalid object number ${firstObjectNumber}.`);
  }

  const usableWidth = geometry.width - geometry.margin * 2;
  const usableHeight = geometry.height - geometry.margin * 2;

  const fonts = await loadMetrics();
  const measure: Measure = (text, size, bold) =>
    (bold ? fonts.bold : fonts.regular).widthOfTextAtSize(text, size);

  const groups = buildGroups(data, measure, usableWidth);
  const paginated = paginate(groups, usableHeight);

  const pages = paginated.map((rows, i) => {
    const streamBytes = renderPage(rows, geometry);
    const ref: PdfRef = { objectNumber: firstObjectNumber + i, generationNumber: 0 };
    return {
      dictionary: pageDictionary(geometry, ref),
      content: {
        ref,
        value: dict({ Length: streamBytes.length }),
        streamBytes,
      } satisfies AppendedObject,
    };
  });

  return { pages, nextObjectNumber: firstObjectNumber + pages.length };
}

function assertGeometry(geometry: CertificatePageGeometry): void {
  const { width, height, margin } = geometry;
  for (const [label, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new PdfCertificateError(`A certificate page needs a positive ${label}.`);
    }
  }
  if (!Number.isFinite(margin) || margin < 0) {
    throw new PdfCertificateError('A certificate page needs a margin of zero or more.');
  }
  if (width - margin * 2 <= 0 || height - margin * 2 <= 0) {
    throw new PdfCertificateError(
      `A ${width}x${height} page with a ${margin}pt margin has nothing left to draw in.`,
    );
  }
}

/**
 * Fill pages with groups, breaking where the next group no longer fits.
 *
 * A group moves to the next page whole. Only a group taller than an entire page
 * is broken up, and then only because the alternative is dropping it.
 */
function paginate(groups: Group[], usableHeight: number): Row[][] {
  const pages: Row[][] = [];
  let current: Row[] = [];
  let used = 0;

  const flush = () => {
    if (current.length > 0) {
      pages.push(current);
      current = [];
      used = 0;
    }
  };

  for (const item of groups) {
    if (item.height <= usableHeight - used) {
      for (const row of item.rows) {
        current.push(row);
        used += row.advance;
      }
      continue;
    }
    if (item.height <= usableHeight) {
      flush();
      for (const row of item.rows) {
        current.push(row);
        used += row.advance;
      }
      continue;
    }
    // Taller than a whole page even on its own, so it is broken between rows.
    for (const row of item.rows) {
      if (row.advance > usableHeight) {
        // Refused rather than clamped. A row drawn past the bottom margin is
        // content nobody can read on a certificate that reports success.
        throw new PdfCertificateError(
          `A ${row.advance}pt line does not fit a ${usableHeight}pt page.`,
        );
      }
      if (row.advance > usableHeight - used) flush();
      current.push(row);
      used += row.advance;
    }
  }

  flush();
  if (pages.length === 0) throw new PdfCertificateError('This certificate has nothing to draw.');
  return pages;
}

// --- the certificate's own content -------------------------------------------

function buildGroups(data: CertificateData, measure: Measure, usableWidth: number): Group[] {
  const labelWidth = Math.min(LABEL_COLUMN, usableWidth * 0.4);
  const valueWidth = usableWidth - labelWidth;

  const field = (label: string, value: unknown): Row[] => {
    const lines = wrap(measure, String(value ?? '') || 'N/A', FIELD_SIZE, false, valueWidth);
    return lines.map((line, i) => ({
      draws: [
        ...(i === 0
          ? [{ kind: 'text' as const, text: clean(label), dx: 0, size: FIELD_SIZE, bold: true, grey: GREY.label }]
          : []),
        { kind: 'text' as const, text: line, dx: labelWidth, size: FIELD_SIZE, bold: false, grey: GREY.value },
      ],
      advance: LINE_ADVANCE + (i === lines.length - 1 ? FIELD_GAP : 0),
    }));
  };

  const section = (heading: string): Row[] => [
    {
      draws: [{ kind: 'text', text: clean(heading), dx: 0, size: SECTION_SIZE, bold: true, grey: GREY.section }],
      advance: SECTION_ADVANCE,
    },
    { draws: [{ kind: 'rule', grey: GREY.rule }], advance: RULE_ADVANCE },
  ];

  const groups: Group[] = [];

  // Title
  const title = clean(data.title || 'SIGNATURE CERTIFICATE');
  const titleWidth = measure(title, TITLE_SIZE, true);
  groups.push(group([
    {
      draws: [{
        kind: 'text',
        text: title,
        dx: Math.max(0, (usableWidth - titleWidth) / 2),
        size: TITLE_SIZE,
        bold: true,
        grey: GREY.title,
      }],
      advance: TITLE_ADVANCE,
    },
    { draws: [{ kind: 'rule', grey: GREY.rule }], advance: RULE_ADVANCE },
  ]));

  // Document details
  const pageCount = Number.isFinite(data.documentPageCount) ? Number(data.documentPageCount) : 0;
  groups.push(group([
    ...section('DOCUMENT DETAILS'),
    ...field('Document:', data.documentTitle),
    ...field('Transaction ID:', data.transactionId),
    ...field('Pages:', `${pageCount} (excluding this certificate)`),
    ...gap(SECTION_GAP),
  ]));

  // Signers. One group each, so a page break never lands inside an entry.
  const signers = normalizeSigners(data);
  signers.forEach((signer, index) => {
    const rows: Row[] = [];
    if (index === 0) rows.push(...section('SIGNER INFORMATION'));
    rows.push(...field('Signer:', signer.name));
    rows.push(...field('Role:', signer.roleLabel || 'Signer'));
    if (signer.email) rows.push(...field('Email:', signer.email));
    rows.push(...field('Signed At:', formatTimestamp(signer.completedAt)));
    rows.push(...field('IP Address:', signer.signerIp));
    const agent = truncateUserAgent(signer.signerUserAgent);
    if (agent) rows.push(...field('Device:', agent));
    rows.push(...gap(index === signers.length - 1 ? SECTION_GAP : SIGNER_GAP));
    groups.push(group(rows));
  });

  // Timeline
  groups.push(group([
    ...section('TIMELINE'),
    ...field('Session Created:', formatTimestamp(data.sessionCreatedAt)),
    ...field('Document Signed:', formatTimestamp(data.signedAt)),
    ...gap(SECTION_GAP),
  ]));

  // Document integrity. The signed hash covers the executed document AS
  // DELIVERED, which is this file without the certificate page. A page cannot
  // state the hash of the file it is bound into, and a hash of anything else is
  // worse than none: it looks checkable and is not.
  groups.push(group([
    ...section('DOCUMENT INTEGRITY'),
    ...field('Original Hash (SHA-256):', data.originalDocumentHash),
    ...field('Signed Hash (SHA-256):', data.deliveryDocumentHash),
    ...wrap(
      measure,
      'The signed hash covers the executed document as delivered, without this certificate page.',
      NOTE_SIZE,
      false,
      usableWidth,
    ).map((line, i, lines) => ({
      draws: [{ kind: 'text' as const, text: line, dx: 0, size: NOTE_SIZE, bold: false, grey: GREY.label }],
      advance: i === lines.length - 1 ? NOTE_ADVANCE : LINE_ADVANCE,
    })),
  ]));

  // Consent
  if (data.consentStatement) {
    groups.push(group([
      ...section('ELECTRONIC SIGNATURE CONSENT'),
      ...wrap(measure, `"${data.consentStatement}"`, BODY_SIZE, false, usableWidth).map((line) => ({
        draws: [{ kind: 'text' as const, text: line, dx: 0, size: BODY_SIZE, bold: false, grey: GREY.value }],
        advance: LINE_ADVANCE,
      })),
      ...gap(SECTION_GAP),
    ]));
  }

  // Footer
  groups.push(group([
    { draws: [{ kind: 'rule', grey: GREY.rule }], advance: RULE_ADVANCE },
    footerRow('Generated by Paralegix  |  paralegix.com', true, LINE_ADVANCE),
    footerRow('This certificate was automatically generated at the time of signing', false, 12),
    footerRow('and is an integral part of this document.', false, 12),
  ]));

  return groups;
}

const gap = (advance: number): Row[] => [{ draws: [], advance }];

const footerRow = (text: string, bold: boolean, advance: number): Row => ({
  draws: [{ kind: 'text', text: clean(text), dx: 0, size: NOTE_SIZE, bold, grey: GREY.footer }],
  advance,
});

/**
 * The signers this certificate names.
 *
 * REFUSED when there are none, rather than rendered without a signer section.
 * A Certificate of Completion is the evidence that particular people executed
 * this document, so one that reports a completed signing and names nobody is a
 * worse outcome than no certificate at all: it looks authoritative and proves
 * nothing. Every session carries participant rows, so an empty list here is a
 * caller defect, not a session shape.
 */
function normalizeSigners(data: CertificateData): CertificateSigner[] {
  const signers = Array.isArray(data.signers) ? data.signers : [];
  if (signers.length === 0) {
    throw new PdfCertificateError('A certificate must name at least one signer.');
  }
  return signers;
}

/** Cap a user agent for display. The full value stays on the audit record. */
function truncateUserAgent(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.length <= USER_AGENT_LIMIT ? text : `${text.slice(0, USER_AGENT_LIMIT - 3)}...`;
}

/** Everything drawn goes through the WinAnsi sanitizer the fonts can encode. */
const clean = (value: unknown): string => sanitizeForStandardFont(value);

/**
 * Break text to a width.
 *
 * A word wider than the column is broken between characters rather than left to
 * run past the margin, which is what a SHA-256 hash needs. When a single
 * character is wider than the column there is no layout at all, and that is
 * refused: drawing it anyway puts text off the page on a certificate that
 * reports success.
 */
function wrap(measure: Measure, raw: string, size: number, bold: boolean, maxWidth: number): string[] {
  const text = clean(raw);
  if (maxWidth <= 0) {
    throw new PdfCertificateError('A certificate column has no width to draw text in.');
  }

  const lines: string[] = [];
  let current = '';

  const pushWord = (word: string) => {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, size, bold) <= maxWidth) {
      current = candidate;
      return;
    }
    if (current) {
      lines.push(current);
      current = '';
    }
    if (measure(word, size, bold) <= maxWidth) {
      current = word;
      return;
    }
    // Break the word itself. A hash has no spaces to break at.
    let piece = '';
    for (const character of word) {
      if (measure(character, size, bold) > maxWidth) {
        throw new PdfCertificateError(
          `A ${size}pt character does not fit a ${round(maxWidth)}pt column.`,
        );
      }
      if (measure(piece + character, size, bold) > maxWidth) {
        lines.push(piece);
        piece = character;
      } else {
        piece += character;
      }
    }
    current = piece;
  };

  for (const word of text.split(/\s+/)) {
    if (word) pushWord(word);
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

// --- rendering ----------------------------------------------------------------

/**
 * One page's content stream.
 *
 * The cursor starts at the top of the usable box and drops by each row's
 * advance, so a baseline is never below the bottom margin: pagination has
 * already guaranteed the rows on this page sum to no more than the usable
 * height.
 */
function renderPage(rows: Row[], geometry: CertificatePageGeometry): Uint8Array {
  const left = geometry.margin;
  const right = geometry.width - geometry.margin;
  let y = geometry.height - geometry.margin;
  const parts: string[] = [];

  for (const row of rows) {
    for (const draw of row.draws) {
      if (draw.kind === 'rule') {
        parts.push(
          `q\n${fmt(draw.grey)} G\n0.5 w\n${fmt(left)} ${fmt(y)} m\n${fmt(right)} ${fmt(y)} l\nS\nQ\n`,
        );
        continue;
      }
      if (!draw.text) continue;
      const font = draw.bold ? FONT_BOLD : FONT_REGULAR;
      // Serialized as a PDF string, not interpolated. `(`, `)` and `\` in a
      // signer's name are content-stream syntax, and a name that closes its own
      // string turns the rest of the page into operators.
      const literal = serializeValue({ kind: 'string', bytes: Buffer.from(draw.text, 'latin1') });
      parts.push(
        `${fmt(draw.grey)} g\nBT\n/${font} ${fmt(draw.size)} Tf\n`
        + `${fmt(left + draw.dx)} ${fmt(y)} Td\n${literal} Tj\nET\n`,
      );
    }
    y -= row.advance;
  }

  return new Uint8Array(Buffer.from(parts.join(''), 'latin1'));
}

const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });
const name = (value: string): PdfValue => ({ kind: 'name', value });

/** A standard-14 font, declared inline: no font file, no extra object. */
const standardFont = (baseFont: string): PdfDict => dict({
  Type: name('Font'),
  Subtype: name('Type1'),
  BaseFont: name(baseFont),
  Encoding: name('WinAnsiEncoding'),
});

/**
 * The leaf page.
 *
 * `/MediaBox` is stated on the leaf rather than inherited, because the
 * certificate's geometry is its own and the document being appended to may use
 * any size. `/Parent` is deliberately absent: `planAppendedPages` fills it in,
 * since only that function knows what the parent will be.
 */
function pageDictionary(geometry: CertificatePageGeometry, contentRef: PdfRef): PdfDict {
  return dict({
    Type: name('Page'),
    MediaBox: { kind: 'array', values: [0, 0, geometry.width, geometry.height] },
    Resources: dict({
      ProcSet: { kind: 'array', values: [name('PDF'), name('Text')] },
      Font: dict({
        [FONT_REGULAR]: standardFont('Helvetica'),
        [FONT_BOLD]: standardFont('Helvetica-Bold'),
      }),
    }),
    Contents: { kind: 'ref', value: contentRef },
  });
}

/** PDF numbers, without exponent notation, which the format has no form for. */
function fmt(value: number): string {
  if (!Number.isFinite(value)) throw new PdfCertificateError(`Cannot write the number ${value}.`);
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

const round = (value: number): string => (Math.round(value * 100) / 100).toString();
