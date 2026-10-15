/**
 * Turning one signer's field value into the content stream that draws it.
 *
 * `signingPipeline.ts` appends both executed artifacts, so no document is ever
 * held. What it needs per field is a `FieldAppearance`: a small stream in the
 * appearance's own coordinates, the resources it names, and any objects those
 * resources point at. This produces them.
 *
 * The behaviour is the shipping pdf-lib renderer's (`signingFieldValues.ts`),
 * reproduced rather than reinvented. The signer approved a preview, and the
 * executed document only agrees with that preview if the same wrapping, the
 * same font sizing, the same date reformatting and the same signature layout
 * land here. `fitTextToBox` and `signatureFormLayout` are therefore shared with
 * that path instead of re-derived.
 *
 * Four rules carry the weight.
 *
 * EVERY STRING IS SERIALIZED, NEVER INTERPOLATED. `(`, `)` and `\` are content
 * stream syntax and a signer's name is typed by the person signing. A name that
 * closes its own string object turns the rest of the appearance into operators.
 * Text goes through the writer's string serializer, the same one the object
 * graph uses.
 *
 * A PNG IS DECODED, NOT PASSED THROUGH. A PDF image XObject holds RAW SAMPLES.
 * A PNG's IDAT holds zlib-compressed scanlines, each carrying a leading filter
 * tag, so handing the inflated IDAT to PDF as `/FlateDecode` data leaves a stray
 * byte at the start of every row and the signature renders as a diagonal smear.
 * The row filters are undone here, and the samples are recompressed. Only the
 * narrow shape a browser canvas produces is accepted; everything else is
 * refused by name.
 *
 * AN ALPHA CHANNEL BECOMES AN `/SMask`. PDF has no four-channel RGB image. A
 * signature captured on a transparent canvas whose alpha is dropped renders as
 * a black rectangle over the page it was supposed to sit on.
 *
 * NOTHING IS EVER DRAWN AS A PLACEHOLDER. A value that cannot be rendered is
 * refused with a stable code. An executed document that quietly shows nothing
 * where a signature belongs is worse than one that fails, because nobody finds
 * out until it matters.
 */
import zlib from 'zlib';
import type { PDFFont } from 'pdf-lib';

import { AppError } from '../../../shared/errors/AppError';
import { fitTextToBox } from '../textFit';
import { SIGNING_PROFILE } from '../signingProfile';
import { decodeStreamSync } from './filters';
import { signatureFormLayout } from './fieldPlacement';
import { serializeValue, type AppendedObject } from './writer';
import type { FieldAppearance } from '../signingPipeline';
import type { PdfDict, PdfRef, PdfValue } from './types';

export class PdfFieldAppearanceError extends AppError {
  constructor(message: string, code = 'SIGNING_FIELD_APPEARANCE_FAILED') {
    super(message, 400, code);
  }
}

/** Resource names for the appearance's own form. Nothing else shares them. */
const FONT_REGULAR = 'PxHelv';
const FONT_BOLD = 'PxHelvB';
const IMAGE_NAME = 'PxSigImg';

/** The field types this draws. Anything else is refused, never coerced. */
const DRAWABLE = new Set(['signature', 'initials', 'date', 'text', 'checkbox']);

/**
 * Standard 14 metrics, borrowed from pdf-lib.
 *
 * Wrapping text needs glyph widths, and pdf-lib already carries the standard 14
 * width tables. They are read from an empty throwaway document rather than
 * copied into this repo as a second table that would then have to be kept
 * correct. Nothing is embedded: only the widths and the WinAnsi encoder are
 * used, and the appearance declares its fonts inline.
 */
export interface FieldAppearanceFonts {
  regular: PDFFont;
  bold: PDFFont;
}

let fontsPromise: Promise<FieldAppearanceFonts> | null = null;

/** The metrics, loaded once per process. */
export async function loadFieldAppearanceFonts(): Promise<FieldAppearanceFonts> {
  if (!fontsPromise) {
    fontsPromise = (async () => {
      // Required here, not at the top: pdf-lib is megabytes once loaded and is
      // needed only when the first document is signed.
      const { PDFDocument, StandardFonts } = require('pdf-lib') as typeof import('pdf-lib');
      const document = await PDFDocument.create();
      return {
        regular: await document.embedFont(StandardFonts.Helvetica),
        bold: await document.embedFont(StandardFonts.HelveticaBold),
      };
    })().catch((error) => {
      // A failed load must not be cached, or every later field in this process
      // fails with the first one's error.
      fontsPromise = null;
      throw error;
    });
  }
  return fontsPromise;
}

export interface BuildFieldAppearanceOptions {
  /** `signature`, `initials`, `date`, `text` or `checkbox`. */
  fieldType: string;
  /** The value the signer submitted, exactly as stored. */
  value: unknown;
  /** The field's box, in the coordinates the viewer showed. */
  boxWidth: number;
  boxHeight: number;
  /** `x-line` draws a rule and an X beside the image; anything else is plain. */
  style?: string | null;
  fonts: FieldAppearanceFonts;
  /** Hands out the next free object number, for an image and its mask. */
  allocate: () => PdfRef;
}

/**
 * One field's mark, ready for `planAppearance`.
 *
 * The appearance is authored at the field's own box size, so `bbox` is that box
 * and the form's matrix scales it by one. That is what lets the layout helpers
 * be shared with the renderer that produced the signer's preview.
 */
export function buildFieldAppearance(options: BuildFieldAppearanceOptions): FieldAppearance {
  const { fieldType, value, boxWidth, boxHeight } = options;

  if (!DRAWABLE.has(fieldType)) {
    throw new PdfFieldAppearanceError(
      `A "${fieldType}" field has no mark this service knows how to draw.`,
      'SIGNING_FIELD_TYPE_UNSUPPORTED',
    );
  }
  if (!Number.isFinite(boxWidth) || !Number.isFinite(boxHeight) || boxWidth <= 0 || boxHeight <= 0) {
    throw new PdfFieldAppearanceError(
      `This field's box is ${boxWidth} by ${boxHeight} and has no area to draw in.`,
      'SIGNING_FIELD_BOX_INVALID',
    );
  }

  const bbox = { width: boxWidth, height: boxHeight };

  if (fieldType === 'signature' || fieldType === 'initials') {
    return { ...drawSignature(options), bbox };
  }
  if (fieldType === 'checkbox') {
    return { ...drawCheckboxMark(options), bbox };
  }
  return { ...drawText(options), bbox };
}

// --- text and date ------------------------------------------------------------

/**
 * The value as text, with a bare `YYYY-MM-DD` date reformatted for display.
 *
 * Both the parse and the format are pinned to UTC rather than left to the
 * server process's ambient zone: a bare date has no time of day to roll across
 * a zone boundary, so anchoring in UTC always reproduces the literal date.
 */
function displayText(fieldType: string, value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (fieldType !== 'date' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC' });
}

function drawText(options: BuildFieldAppearanceOptions): Omit<FieldAppearance, 'bbox'> {
  const { fieldType, boxWidth, boxHeight, fonts } = options;
  const text = displayText(fieldType, options.value);
  if (!text) {
    throw new PdfFieldAppearanceError(
      'This field has no value to draw.',
      'SIGNING_FIELD_VALUE_EMPTY',
    );
  }

  // The same ceiling the shipping renderer applies, so a date and a text field
  // of the same size do not disagree about how large their value is drawn.
  const maxFontSize = Math.max(10, Math.min(boxHeight * 0.55, fieldType === 'text' ? 18 : 16));

  // A standard 14 font is WinAnsi, which is Latin-1 plus a handful of
  // punctuation, and a legal name is under no obligation to fit that. pdf-lib
  // throws from the WIDTH measurement, which is inside the fit, so the whole
  // fit is guarded rather than the draw.
  let fitted;
  let encoded: Uint8Array[];
  try {
    fitted = fitTextToBox(
      text,
      boxWidth,
      boxHeight,
      maxFontSize,
      (line: string, size: number) => fonts.regular.widthOfTextAtSize(line, size),
    );
    encoded = fitted.lines.map((line) => fonts.regular.encodeText(line).asBytes());
  } catch (error: any) {
    throw new PdfFieldAppearanceError(
      `This value cannot be drawn with the document's fonts: ${error.message}`,
      'SIGNING_FIELD_TEXT_UNRENDERABLE',
    );
  }

  const { lines, fontSize, lineHeight } = fitted;
  const blockHeight = lines.length * lineHeight;
  let y = Math.max(2, (boxHeight - blockHeight) / 2) + blockHeight - fontSize;

  const parts: string[] = ['q\n0 g\n'];
  lines.forEach((line, index) => {
    const lineWidth = fonts.regular.widthOfTextAtSize(line, fontSize);
    const x = Math.max(4, Math.min(boxWidth * 0.1, (boxWidth - lineWidth) / 2));
    // Serialized, not interpolated. A name carrying `(`, `)` or `\` would
    // otherwise close its own string and turn the rest of the stream into
    // operators.
    const literal = serializeValue({ kind: 'string', bytes: encoded[index] });
    parts.push(
      `BT\n/${FONT_REGULAR} ${fmt(fontSize)} Tf\n${fmt(x)} ${fmt(y)} Td\n${literal} Tj\nET\n`,
    );
    y -= lineHeight;
  });
  parts.push('Q\n');

  return {
    content: latin1(parts.join('')),
    resources: dict({
      ProcSet: array([name('PDF'), name('Text')]),
      Font: dict({ [FONT_REGULAR]: standardFont('Helvetica') }),
    }),
  };
}

// --- checkbox -----------------------------------------------------------------

const CHECKED = new Set<unknown>([true, 'true', 1, '1']);

function drawCheckboxMark(options: BuildFieldAppearanceOptions): Omit<FieldAppearance, 'bbox'> {
  const { boxWidth, boxHeight } = options;
  if (!CHECKED.has(options.value)) {
    throw new PdfFieldAppearanceError(
      'This checkbox is not checked, so it has no mark to draw.',
      'SIGNING_FIELD_VALUE_EMPTY',
    );
  }

  // The proportions the shipping renderer draws, measured from the box's own
  // bottom left because a Form XObject's coordinates start there.
  const startX = boxWidth * 0.2;
  const midX = boxWidth * 0.45;
  const endX = boxWidth * 0.82;
  const startY = boxHeight * 0.45;
  const midY = boxHeight * 0.2;
  const endY = boxHeight * 0.78;
  const thickness = Math.max(1.5, boxHeight * 0.06);

  // Two separate stroked paths rather than one polyline, which is what the
  // renderer's two `drawLine` calls produce: a joined path would round or mitre
  // the corner the tick turns at.
  const content = `q\n0 0 0 RG\n${fmt(thickness)} w\n`
    + `${fmt(startX)} ${fmt(startY)} m\n${fmt(midX)} ${fmt(midY)} l\nS\n`
    + `${fmt(midX)} ${fmt(midY)} m\n${fmt(endX)} ${fmt(endY)} l\nS\n`
    + 'Q\n';

  return {
    content: latin1(content),
    resources: dict({ ProcSet: array([name('PDF')]) }),
  };
}

// --- signature and initials ---------------------------------------------------

function drawSignature(options: BuildFieldAppearanceOptions): Omit<FieldAppearance, 'bbox'> {
  const { boxWidth, boxHeight, fonts, allocate } = options;
  const image = decodePngValue(options.value);

  const layout = signatureFormLayout({
    boxWidth,
    boxHeight,
    imageAspectRatio: image.width / image.height,
    style: options.style === 'x-line' ? 'x-line' : 'standard',
  });

  const imageRef = allocate();
  const maskRef = image.alpha ? allocate() : null;
  const objects: AppendedObject[] = [];

  const imageEntries: Record<string, PdfValue> = {
    Type: name('XObject'),
    Subtype: name('Image'),
    Width: image.width,
    Height: image.height,
    ColorSpace: name(image.colourSpace),
    BitsPerComponent: 8,
    Filter: name('FlateDecode'),
    Length: image.colour.length,
  };
  if (maskRef) imageEntries.SMask = { kind: 'ref', value: maskRef };

  objects.push({ ref: imageRef, value: dict(imageEntries), streamBytes: image.colour });
  if (maskRef && image.alpha) {
    // The alpha channel is its own single-component image of the SAME
    // dimensions. A mask of a different size stretches across the signature.
    objects.push({
      ref: maskRef,
      value: dict({
        Type: name('XObject'),
        Subtype: name('Image'),
        Width: image.width,
        Height: image.height,
        ColorSpace: name('DeviceGray'),
        BitsPerComponent: 8,
        Filter: name('FlateDecode'),
        Length: image.alpha.length,
      }),
      streamBytes: image.alpha,
    });
  }

  // The order the shipping renderer draws in: the X, then the rule, then the
  // image on top of both.
  const parts: string[] = ['q\n'];
  if (layout.xMark) {
    const literal = serializeValue({ kind: 'string', bytes: fonts.bold.encodeText('X').asBytes() });
    parts.push(
      `0 g\nBT\n/${FONT_BOLD} ${fmt(layout.xMark.fontSize)} Tf\n`
      + `${fmt(layout.xMark.x)} ${fmt(layout.xMark.y)} Td\n${literal} Tj\nET\n`,
    );
  }
  if (layout.line) {
    parts.push(
      `0 0 0 RG\n${fmt(layout.line.thickness)} w\n`
      + `${fmt(layout.line.x)} ${fmt(layout.line.y)} m\n`
      + `${fmt(layout.line.x + layout.line.width)} ${fmt(layout.line.y)} l\nS\n`,
    );
  }
  const { x, y, width, height } = layout.imageRect;
  parts.push(
    `q\n${fmt(width)} 0 0 ${fmt(height)} ${fmt(x)} ${fmt(y)} cm\n/${IMAGE_NAME} Do\nQ\n`,
  );
  parts.push('Q\n');

  const resources: Record<string, PdfValue> = {
    ProcSet: array([name('PDF'), name('Text'), name('ImageC')]),
    XObject: dict({ [IMAGE_NAME]: { kind: 'ref', value: imageRef } }),
  };
  if (layout.xMark) resources.Font = dict({ [FONT_BOLD]: standardFont('Helvetica-Bold') });

  return { content: latin1(parts.join('')), resources: dict(resources), objects };
}

// --- PNG ----------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Samples per pixel for each PNG colour type this accepts. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

interface DecodedImage {
  width: number;
  height: number;
  colourSpace: 'DeviceGray' | 'DeviceRGB';
  /** Deflated colour samples, ready to be a `/FlateDecode` image stream. */
  colour: Uint8Array;
  /** Deflated alpha samples, or null when the PNG carries none. */
  alpha: Uint8Array | null;
}

/** The bytes behind a `data:` URL, or null when the value is not one. */
function dataUrlBytes(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !value.startsWith('data:')) return null;
  const comma = value.indexOf(',');
  if (comma < 0) return null;
  const payload = value.slice(comma + 1);
  if (!payload) return null;
  const bytes = Buffer.from(payload, 'base64');
  return bytes.length > 0 ? bytes : null;
}

/**
 * A signer's submitted PNG, as raw samples PDF can hold.
 *
 * The accepted shape is deliberately narrow: 8 bits per channel, no interlace,
 * greyscale or truecolour with or without alpha. That is what a browser canvas
 * produces, and every other shape is refused by name rather than decoded
 * approximately. A palette image drawn as if it were truecolour is not a
 * degraded signature, it is a different picture.
 */
function decodePngValue(value: unknown): DecodedImage {
  const bytes = dataUrlBytes(value);
  if (!bytes) {
    throw new PdfFieldAppearanceError(
      'A signature must be submitted as a PNG data URL.',
      'SIGNING_IMAGE_NOT_PNG',
    );
  }

  // Measured before anything parses the file, because the byte length is the
  // one thing known without reading it.
  const maxBytes = SIGNING_PROFILE.maxSignatureImageBytes;
  if (bytes.length > maxBytes) {
    throw new PdfFieldAppearanceError(
      `That signature image is ${bytes.length} bytes and the limit is ${maxBytes}.`,
      'SIGNING_IMAGE_TOO_LARGE',
    );
  }
  if (bytes.length < PNG_MAGIC.length + 25 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new PdfFieldAppearanceError(
      'A signature must be submitted as a PNG data URL.',
      'SIGNING_IMAGE_NOT_PNG',
    );
  }

  const header = readHeader(bytes);
  const idat = collectIdat(bytes, header);

  const channels = CHANNELS[header.colourType];
  // Inflate and undo the row filters in one step: a PNG's IDAT is exactly a
  // Flate stream carrying PDF's own predictor 15, so the reader's decoder does
  // both, with the output bounded DURING decompression rather than after.
  let samples: Uint8Array;
  try {
    samples = decodeStreamSync(
      dict({
        Filter: name('FlateDecode'),
        DecodeParms: dict({
          Predictor: 15,
          Colors: channels,
          BitsPerComponent: 8,
          Columns: header.width,
        }),
      }),
      idat,
    );
  } catch (error: any) {
    throw new PdfFieldAppearanceError(
      `That signature image could not be decoded: ${error.message}`,
      'SIGNING_IMAGE_MALFORMED',
    );
  }

  const expected = header.width * header.height * channels;
  if (samples.length !== expected) {
    throw new PdfFieldAppearanceError(
      `That signature image decoded to ${samples.length} samples and declares ${expected}.`,
      'SIGNING_IMAGE_MALFORMED',
    );
  }

  const hasAlpha = header.colourType === 4 || header.colourType === 6;
  const colourChannels = channels - (hasAlpha ? 1 : 0);
  const pixels = header.width * header.height;

  let colour: Uint8Array;
  let alpha: Uint8Array | null = null;
  if (!hasAlpha) {
    colour = samples;
  } else {
    colour = new Uint8Array(pixels * colourChannels);
    alpha = new Uint8Array(pixels);
    for (let p = 0; p < pixels; p += 1) {
      const from = p * channels;
      for (let c = 0; c < colourChannels; c += 1) colour[p * colourChannels + c] = samples[from + c];
      alpha[p] = samples[from + colourChannels];
    }
  }

  return {
    width: header.width,
    height: header.height,
    colourSpace: colourChannels === 1 ? 'DeviceGray' : 'DeviceRGB',
    colour: new Uint8Array(zlib.deflateSync(Buffer.from(colour))),
    alpha: alpha ? new Uint8Array(zlib.deflateSync(Buffer.from(alpha))) : null,
  };
}

interface PngHeader {
  width: number;
  height: number;
  colourType: number;
}

/**
 * The IHDR, which a PNG is required to carry first.
 *
 * The pixel count is checked HERE, from the 24 bytes of the header, because a
 * few hundred bytes of zlib can declare a bitmap of hundreds of millions of
 * pixels and cost gigabytes the moment anything decodes it. A bomb is refused on
 * what it declares, before a decoder is handed a single byte of it.
 */
function readHeader(bytes: Buffer): PngHeader {
  if (bytes.toString('latin1', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) {
    throw new PdfFieldAppearanceError(
      'That PNG does not begin with an image header.',
      'SIGNING_IMAGE_MALFORMED',
    );
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colourType = bytes[25];
  const compression = bytes[26];
  const filterMethod = bytes[27];
  const interlace = bytes[28];

  if (width < 1 || height < 1) {
    throw new PdfFieldAppearanceError(
      'That PNG declares no pixels.',
      'SIGNING_IMAGE_MALFORMED',
    );
  }

  const maxPixels = SIGNING_PROFILE.maxImagePixels;
  if (width * height > maxPixels) {
    throw new PdfFieldAppearanceError(
      `That signature image declares ${width} by ${height} pixels and the limit is ${maxPixels}.`,
      'SIGNING_IMAGE_TOO_MANY_PIXELS',
    );
  }

  if (bitDepth !== 8) {
    throw new PdfFieldAppearanceError(
      `That PNG is ${bitDepth} bits per channel and only 8 is supported. `
      + 'Re-save the signature as an 8 bit PNG.',
      'SIGNING_IMAGE_UNSUPPORTED',
    );
  }
  if (CHANNELS[colourType] === undefined) {
    throw new PdfFieldAppearanceError(
      `That PNG uses colour type ${colourType}, which is not supported. `
      + 'Re-save the signature as a greyscale or truecolour PNG.',
      'SIGNING_IMAGE_UNSUPPORTED',
    );
  }
  if (interlace !== 0) {
    throw new PdfFieldAppearanceError(
      'That PNG is interlaced, which is not supported. Re-save it without interlacing.',
      'SIGNING_IMAGE_UNSUPPORTED',
    );
  }
  if (compression !== 0 || filterMethod !== 0) {
    throw new PdfFieldAppearanceError(
      'That PNG uses a compression or filter method this service does not read.',
      'SIGNING_IMAGE_UNSUPPORTED',
    );
  }

  return { width, height, colourType };
}

/** The most chunks one signature PNG may carry before it is refused. */
const MAX_PNG_CHUNKS = 4096;

/**
 * Every IDAT payload, joined.
 *
 * A PNG may split its data across any number of IDAT chunks and they are one
 * zlib stream between them, so reading only the first produces a truncated
 * image. `tRNS` is refused rather than ignored: it carries transparency this
 * does not translate, and a signature that silently loses it is drawn over the
 * page instead of on it.
 */
function collectIdat(bytes: Buffer, header: PngHeader): Uint8Array {
  const parts: Buffer[] = [];
  let offset = PNG_MAGIC.length;
  let chunks = 0;

  while (offset + 12 <= bytes.length) {
    chunks += 1;
    if (chunks > MAX_PNG_CHUNKS) {
      throw new PdfFieldAppearanceError(
        'That PNG carries more chunks than this service will read.',
        'SIGNING_IMAGE_MALFORMED',
      );
    }
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    if (length > bytes.length - start - 4) {
      throw new PdfFieldAppearanceError(
        `That PNG's ${type} chunk runs past the end of the file.`,
        'SIGNING_IMAGE_MALFORMED',
      );
    }
    if (type === 'IDAT') parts.push(bytes.subarray(start, start + length));
    if (type === 'tRNS') {
      throw new PdfFieldAppearanceError(
        'That PNG carries a transparency chunk this service does not translate. '
        + 'Re-save the signature with a real alpha channel.',
        'SIGNING_IMAGE_UNSUPPORTED',
      );
    }
    if (type === 'IEND') break;
    offset = start + length + 4;
  }

  if (parts.length === 0) {
    throw new PdfFieldAppearanceError(
      `That PNG declares ${header.width} by ${header.height} pixels and carries no image data.`,
      'SIGNING_IMAGE_MALFORMED',
    );
  }
  return new Uint8Array(Buffer.concat(parts));
}

// --- small helpers ------------------------------------------------------------

const name = (value: string): PdfValue => ({ kind: 'name', value });
const array = (values: PdfValue[]): PdfValue => ({ kind: 'array', values });
const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });

/** A standard 14 font, declared inline: no font file, no extra object. */
const standardFont = (baseFont: string): PdfDict => dict({
  Type: name('Font'),
  Subtype: name('Type1'),
  BaseFont: name(baseFont),
  Encoding: name('WinAnsiEncoding'),
});

const latin1 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));

/** PDF numbers, without exponent notation, which the format has no form for. */
function fmt(value: number): string {
  if (!Number.isFinite(value)) {
    throw new PdfFieldAppearanceError(`Cannot write the number ${value}.`);
  }
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
