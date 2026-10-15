/**
 * Drawing one signer's field value as a PDF content stream.
 *
 * The failures this suite exists for are all invisible in a response body.
 *
 * A PNG handed to PDF as raw Flate data renders as a diagonal smear, because a
 * PDF image XObject holds raw samples and a PNG's IDAT holds filtered scanlines
 * each carrying a leading tag byte. So the image tests INFLATE the emitted
 * streams back and assert the individual sample bytes, against a fixture whose
 * rows deliberately use different PNG row filters. A pass-through would produce
 * different bytes, and nothing else would notice.
 *
 * A signature drawn on a transparent canvas with no `/SMask` comes out as a
 * black rectangle, so the alpha channel is asserted as its own image with its
 * own dimensions rather than as "transparency is handled".
 *
 * A signer's name can carry `(`, `)` and `\`, which are content-stream syntax.
 * Everything is therefore read back through the REAL lexer: a regular
 * expression over `(...)` cannot tell an escaped parenthesis from a closing one,
 * which is the exact defect being tested for.
 *
 * And the executed document has to agree with the preview the signer approved,
 * so the text and checkbox cases are compared against what the shipping pdf-lib
 * renderer draws today rather than against numbers restated here.
 */
import zlib from 'zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { Lexer } from '../../../src/modules/signatures/pdf/lexer';
import { signatureFormLayout } from '../../../src/modules/signatures/pdf/fieldPlacement';
import { SIGNING_PROFILE } from '../../../src/modules/signatures/signingProfile';
import { drawCheckbox, drawTextValue } from '../../../src/modules/signatures/signingFieldValues';
import {
  buildFieldAppearance,
  loadFieldAppearanceFonts,
  PdfFieldAppearanceError,
  type FieldAppearanceFonts,
} from '../../../src/modules/signatures/pdf/fieldAppearance';
import type { PdfDict, PdfRef, PdfValue } from '../../../src/modules/signatures/pdf/types';
import type { AppendedObject } from '../../../src/modules/signatures/pdf/writer';

let fonts: FieldAppearanceFonts;

beforeAll(async () => {
  fonts = await loadFieldAppearanceFonts();
});

// --- object number allocation -------------------------------------------------

function allocator(start = 40) {
  let next = start;
  return {
    allocate: (): PdfRef => {
      const ref = { objectNumber: next, generationNumber: 0 };
      next += 1;
      return ref;
    },
    used: () => next - start,
  };
}

// --- reading a content stream back -------------------------------------------

type Token = { t: 'op'; v: string } | { t: 'value'; v: PdfValue };

/**
 * Tokenize a content stream with the REAL lexer.
 *
 * A content stream is postfix: operands, then an operator. The lexer reads
 * operands, and an operator is a bare keyword it would refuse as a value, so the
 * two are told apart here rather than by a regular expression.
 */
function tokenize(bytes: Uint8Array): Token[] {
  const lexer = new Lexer(bytes);
  const out: Token[] = [];
  for (;;) {
    lexer.skipSpace();
    if (lexer.atEnd()) break;
    const b = bytes[lexer.offset];
    if (b === 0x28 || b === 0x2f || b === 0x5b || b === 0x3c) {
      out.push({ t: 'value', v: lexer.readValue() });
      continue;
    }
    const word = lexer.peekKeyword();
    if (!word) {
      lexer.offset = lexer.offset + 1;
      continue;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      out.push({ t: 'value', v: lexer.readValue() });
      continue;
    }
    lexer.expectKeyword(word);
    out.push({ t: 'op', v: word });
  }
  return out;
}

interface Operation {
  op: string;
  operands: PdfValue[];
}

/** Every operator in the stream, with the operands standing in front of it. */
function operations(bytes: Uint8Array): Operation[] {
  const out: Operation[] = [];
  let stack: PdfValue[] = [];
  for (const token of tokenize(bytes)) {
    if (token.t === 'value') {
      stack.push(token.v);
      continue;
    }
    out.push({ op: token.v, operands: stack });
    stack = [];
  }
  return out;
}

interface Drawn {
  text: string;
  x: number;
  y: number;
  font: string;
  size: number;
}

/**
 * Every `Tj`, with the font, size and position it was drawn at.
 *
 * Handles both positioning operators, because this reads streams from two
 * producers: the appearance builder writes `Td`, and pdf-lib writes `Tm`.
 */
function drawnText(bytes: Uint8Array): Drawn[] {
  const out: Drawn[] = [];
  let x = 0;
  let y = 0;
  let font = '';
  let size = 0;
  for (const { op, operands } of operations(bytes)) {
    if (op === 'Tf') {
      const nameValue = operands[0];
      font = nameValue && typeof nameValue === 'object' && nameValue.kind === 'name' ? nameValue.value : '';
      size = operands[1] as number;
    } else if (op === 'Td') {
      x = operands[0] as number;
      y = operands[1] as number;
    } else if (op === 'Tm') {
      x = operands[4] as number;
      y = operands[5] as number;
    } else if (op === 'Tj') {
      const stringValue = operands[0];
      if (!stringValue || typeof stringValue !== 'object' || stringValue.kind !== 'string') {
        throw new Error('Tj without a string operand.');
      }
      out.push({ text: Buffer.from(stringValue.bytes).toString('latin1'), x, y, font, size });
    }
  }
  return out;
}

interface Stroke {
  from: [number, number];
  to: [number, number];
  width: number;
}

/** Every stroked segment, as the pair of points `S` closed over. */
function strokes(bytes: Uint8Array): Stroke[] {
  const out: Stroke[] = [];
  let width = 0;
  let current: [number, number] | null = null;
  let pending: Stroke[] = [];
  for (const { op, operands } of operations(bytes)) {
    if (op === 'w') {
      width = operands[0] as number;
    } else if (op === 'm') {
      current = [operands[0] as number, operands[1] as number];
    } else if (op === 'l') {
      const to: [number, number] = [operands[0] as number, operands[1] as number];
      if (current) pending.push({ from: current, to, width });
      current = to;
    } else if (op === 'S') {
      out.push(...pending);
      pending = [];
      current = null;
    }
  }
  return out;
}

/** The `cm` immediately in front of each `Do`, which is where an image lands. */
function imagePlacements(bytes: Uint8Array): Array<{ name: string; matrix: number[] }> {
  const out: Array<{ name: string; matrix: number[] }> = [];
  let matrix: number[] = [1, 0, 0, 1, 0, 0];
  for (const { op, operands } of operations(bytes)) {
    if (op === 'cm') {
      matrix = operands.map((v) => v as number);
    } else if (op === 'Do') {
      const nameValue = operands[0];
      const name = nameValue && typeof nameValue === 'object' && nameValue.kind === 'name'
        ? nameValue.value
        : '';
      out.push({ name, matrix });
    }
  }
  return out;
}

// --- dictionary helpers -------------------------------------------------------

const isDict = (value: PdfValue | undefined): value is PdfDict =>
  !!value && typeof value === 'object' && (value as any).kind === 'dict';

function entry(dictionary: PdfDict, key: string): PdfValue | undefined {
  return dictionary.entries.get(key);
}

function nameOf(value: PdfValue | undefined): string {
  if (!value || typeof value !== 'object' || (value as any).kind !== 'name') {
    throw new Error(`Expected a name and found ${JSON.stringify(value)}.`);
  }
  return (value as any).value as string;
}

function refOf(value: PdfValue | undefined): PdfRef {
  if (!value || typeof value !== 'object' || (value as any).kind !== 'ref') {
    throw new Error(`Expected a reference and found ${JSON.stringify(value)}.`);
  }
  return (value as any).value as PdfRef;
}

function subDict(dictionary: PdfDict, key: string): PdfDict {
  const value = entry(dictionary, key);
  if (!isDict(value)) throw new Error(`Expected /${key} to be a dictionary.`);
  return value;
}

function objectFor(objects: AppendedObject[] | undefined, ref: PdfRef): AppendedObject {
  const found = (objects || []).find((o) => o.ref.objectNumber === ref.objectNumber);
  if (!found) throw new Error(`No appended object numbered ${ref.objectNumber}.`);
  return found;
}

function dictOf(object: AppendedObject): PdfDict {
  if (!isDict(object.value)) throw new Error('That appended object is not a dictionary.');
  return object.value;
}

/** The samples an image stream actually carries, decompressed. */
const inflate = (object: AppendedObject): Buffer =>
  zlib.inflateSync(Buffer.from(object.streamBytes as Uint8Array));

// --- building PNG fixtures ----------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = -1;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function ihdrChunk(options: {
  width: number;
  height: number;
  bitDepth?: number;
  colourType: number;
  interlace?: number;
}): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(options.width, 0);
  data.writeUInt32BE(options.height, 4);
  data[8] = options.bitDepth ?? 8;
  data[9] = options.colourType;
  data[10] = 0; // deflate
  data[11] = 0; // adaptive filtering
  data[12] = options.interlace ?? 0;
  return pngChunk('IHDR', data);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Apply one PNG row filter, so the fixture exercises the filter undo rather
 * than only the inflate.
 */
function filterRow(tag: number, row: Buffer, prior: Buffer, bytesPerPixel: number): Buffer {
  const out = Buffer.alloc(row.length + 1);
  out[0] = tag;
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
    const up = prior[i];
    let value: number;
    switch (tag) {
      case 0: value = row[i]; break;
      case 1: value = row[i] - left; break;
      case 2: value = row[i] - up; break;
      default: throw new Error(`This fixture builder does not encode filter ${tag}.`);
    }
    out[i + 1] = value & 0xff;
  }
  return out;
}

/**
 * A PNG carrying exactly `rows` of samples.
 *
 * `filters` chooses the row filter per row, which is what makes a fixture that
 * a pass-through decode gets visibly wrong.
 */
function buildPng(options: {
  width: number;
  height: number;
  colourType: number;
  rows: number[][];
  filters?: number[];
  extraChunks?: Buffer[];
}): Buffer {
  const { width, height, colourType, rows } = options;
  const channels = CHANNELS[colourType];
  const bytesPerPixel = channels;
  const filters = options.filters ?? rows.map(() => 0);

  let prior = Buffer.alloc(width * channels);
  const filtered: Buffer[] = [];
  rows.forEach((row, index) => {
    const raw = Buffer.from(row);
    if (raw.length !== width * channels) {
      throw new Error(`Row ${index} is ${raw.length} bytes and should be ${width * channels}.`);
    }
    filtered.push(filterRow(filters[index], raw, prior, bytesPerPixel));
    prior = raw;
  });

  return Buffer.concat([
    PNG_MAGIC,
    ihdrChunk({ width, height, colourType }),
    ...(options.extraChunks ?? []),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(filtered))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const dataUrl = (png: Buffer): string => `data:image/png;base64,${png.toString('base64')}`;

/**
 * A 3x2 RGBA signature fixture with known samples.
 *
 * Row 0 is stored unfiltered and row 1 with the Up filter, so a decoder that
 * skips the filter stage returns row 1 as the DIFFERENCE between the two rows
 * rather than as its samples.
 */
const RGBA_ROWS = [
  [10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0],
  [11, 21, 31, 254, 41, 51, 61, 127, 71, 81, 91, 1],
];

const rgbaPng = () => buildPng({
  width: 3, height: 2, colourType: 6, rows: RGBA_ROWS, filters: [0, 2],
});

/** The same samples without an alpha channel. */
const rgbPng = () => buildPng({
  width: 3,
  height: 2,
  colourType: 2,
  rows: RGBA_ROWS.map((row) => row.filter((_, i) => i % 4 !== 3)),
  filters: [0, 2],
});

// --- what the shipping pdf-lib renderer draws ---------------------------------

/** The box `getFieldBox` would produce for a 200x40 field at (50, 100). */
const PARITY_BOX = { x: 50, y: 100, top: 140, boxWidth: 200, boxHeight: 40 };

/**
 * Render one value through `signingFieldValues.ts` and read the page's own
 * content stream back.
 *
 * pdf-lib keeps each `drawText`/`drawLine` call in an appended content stream,
 * and `getUnencodedContents` is the stream before it is compressed. Reading it
 * here means the parity assertions compare against what that renderer actually
 * emits rather than against a copy of its arithmetic.
 */
async function pdfLibStream(draw: (page: any, font: any) => void): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  draw(page, font);
  const contents = page.node.Contents() as any;
  const parts: Buffer[] = [];
  for (let i = 0; i < contents.size(); i += 1) {
    parts.push(Buffer.from(contents.lookup(i).getUnencodedContents()));
  }
  return new Uint8Array(Buffer.concat(parts));
}

// --- the five field types produce a stream that parses ------------------------

describe('every field type draws a parseable content stream', () => {
  const cases: Array<{ fieldType: string; value: unknown }> = [
    { fieldType: 'text', value: 'Amelia Okonkwo' },
    { fieldType: 'date', value: '2026-03-28' },
    { fieldType: 'checkbox', value: true },
    { fieldType: 'signature', value: null },
    { fieldType: 'initials', value: null },
  ];

  test.each(cases)('$fieldType', ({ fieldType, value }) => {
    const { allocate } = allocator();
    const appearance = buildFieldAppearance({
      fieldType,
      value: value ?? dataUrl(rgbaPng()),
      boxWidth: 180,
      boxHeight: 60,
      fonts,
      allocate,
    });

    const ops = operations(appearance.content);
    expect(ops.length).toBeGreaterThan(0);

    // A stream whose graphics state is not balanced leaks a colour, a width or a
    // transform into everything the page draws after the appearance.
    const opened = ops.filter((o) => o.op === 'q').length;
    const closed = ops.filter((o) => o.op === 'Q').length;
    expect(opened).toBe(closed);
    expect(opened).toBeGreaterThan(0);

    // Every operator this module is allowed to emit. An unexpected one means the
    // tokenizer read an operand as a keyword, which is how a broken string
    // escape shows up.
    const allowed = new Set(['q', 'Q', 'g', 'RG', 'w', 'm', 'l', 'S', 'cm', 'Do', 'BT', 'ET', 'Tf', 'Td', 'Tj']);
    for (const { op } of ops) expect(allowed.has(op)).toBe(true);

    expect(appearance.bbox).toEqual({ width: 180, height: 60 });
  });
});

// --- text ---------------------------------------------------------------------

describe('text and date', () => {
  test('draws the value with a standard 14 font declared inline', () => {
    const { allocate, used } = allocator();
    const appearance = buildFieldAppearance({
      fieldType: 'text',
      value: 'Amelia Okonkwo',
      boxWidth: 200,
      boxHeight: 40,
      fonts,
      allocate,
    });

    const drawn = drawnText(appearance.content);
    expect(drawn.map((d) => d.text)).toEqual(['Amelia Okonkwo']);

    const font = subDict(subDict(appearance.resources, 'Font'), drawn[0].font);
    expect(nameOf(entry(font, 'Subtype'))).toBe('Type1');
    expect(nameOf(entry(font, 'BaseFont'))).toBe('Helvetica');
    expect(nameOf(entry(font, 'Encoding'))).toBe('WinAnsiEncoding');

    // A standard 14 font is described inline, so nothing is embedded and no
    // object number is spent.
    expect(appearance.objects ?? []).toEqual([]);
    expect(used()).toBe(0);
  });

  test('reformats a YYYY-MM-DD date the way the shipping renderer does', () => {
    const { allocate } = allocator();
    const appearance = buildFieldAppearance({
      fieldType: 'date',
      value: '2026-03-28',
      boxWidth: 200,
      boxHeight: 40,
      fonts,
      allocate,
    });

    expect(drawnText(appearance.content).map((d) => d.text)).toEqual(['3/28/2026']);
  });

  test('leaves a date that is not YYYY-MM-DD exactly as submitted', () => {
    const { allocate } = allocator();
    const appearance = buildFieldAppearance({
      fieldType: 'date',
      value: 'March 28, 2026',
      boxWidth: 260,
      boxHeight: 40,
      fonts,
      allocate,
    });

    expect(drawnText(appearance.content).map((d) => d.text)).toEqual(['March 28, 2026']);
  });

  test('caps a date at 16pt and text at 18pt in the same box', () => {
    const { allocate } = allocator();
    const box = { boxWidth: 240, boxHeight: 60, fonts, allocate };
    const asText = buildFieldAppearance({ fieldType: 'text', value: '3/28/2026', ...box });
    const asDate = buildFieldAppearance({ fieldType: 'date', value: '2026-03-28', ...box });

    expect(drawnText(asText.content)[0].size).toBe(18);
    expect(drawnText(asDate.content)[0].size).toBe(16);
  });

  test('a value carrying ( ) and a backslash still parses, with the text intact', () => {
    const hostile = 'Ada (Jr.) \\ O\'Brien) Tj ET Q 0 0 612 792 re f';
    const { allocate } = allocator();
    const appearance = buildFieldAppearance({
      fieldType: 'text',
      value: hostile,
      boxWidth: 300,
      boxHeight: 80,
      fonts,
      allocate,
    });

    const ops = operations(appearance.content);
    // The injected `re` and `f` would appear as operators if the string had
    // closed itself. They must not.
    expect(ops.some((o) => o.op === 're' || o.op === 'f')).toBe(false);

    // The text survives the escaping, across however many lines it wraps to.
    expect(drawnText(appearance.content).map((d) => d.text).join(' ')).toBe(hostile);
  });

  test('wraps onto several lines, each descending by the line height', () => {
    const { allocate } = allocator();
    const appearance = buildFieldAppearance({
      fieldType: 'text',
      value: 'Amelia Okonkwo of Okonkwo Ferrara and Bright LLP',
      boxWidth: 120,
      boxHeight: 90,
      fonts,
      allocate,
    });

    const drawn = drawnText(appearance.content);
    expect(drawn.length).toBeGreaterThan(1);
    const gaps = drawn.slice(1).map((d, i) => drawn[i].y - d.y);
    for (const gap of gaps) expect(gap).toBeCloseTo(drawn[0].size * 1.15, 3);
  });
});

// --- images -------------------------------------------------------------------

describe('signature and initials images', () => {
  test('places the image exactly where signatureFormLayout puts it', () => {
    const png = buildPng({
      width: 200,
      height: 50,
      colourType: 6,
      rows: Array.from({ length: 50 }, () => Array(200 * 4).fill(200)),
    });
    const { allocate } = allocator();
    const appearance = buildFieldAppearance({
      fieldType: 'signature',
      value: dataUrl(png),
      boxWidth: 180,
      boxHeight: 60,
      fonts,
      allocate,
    });

    // Worked through for this box and this image, from signatureLayout.ts:
    //   maxWidth  = 180 * 0.72 = 129.6, maxHeight = 60 * 0.68 = 40.8
    //   the bounds sit at ((180 - 129.6) / 2, (60 - 40.8) / 2) = (25.2, 9.6)
    //   the bounds aspect is 129.6 / 40.8 = 3.176, the image aspect is 200 / 50 = 4,
    //   so the image is width limited: 129.6 wide and 129.6 / 4 = 32.4 tall
    //   top-down that is x = 25.2, y = 9.6 + (40.8 - 32.4) / 2 = 13.8
    //   flipped into the form's bottom-up box: y = 60 - 13.8 - 32.4 = 13.8
    const layout = signatureFormLayout({
      boxWidth: 180, boxHeight: 60, imageAspectRatio: 200 / 50, style: 'standard',
    });
    expect(layout.imageRect.x).toBeCloseTo(25.2, 6);
    expect(layout.imageRect.y).toBeCloseTo(13.8, 6);
    expect(layout.imageRect.width).toBeCloseTo(129.6, 6);
    expect(layout.imageRect.height).toBeCloseTo(32.4, 6);

    const placements = imagePlacements(appearance.content);
    expect(placements).toHaveLength(1);
    const [a, b, c, d, e, f] = placements[0].matrix;
    expect([b, c]).toEqual([0, 0]);
    expect(a).toBeCloseTo(129.6, 4);
    expect(d).toBeCloseTo(32.4, 4);
    expect(e).toBeCloseTo(25.2, 4);
    expect(f).toBeCloseTo(13.8, 4);

    // The name the stream draws has to be the one the resources declare.
    const xobjects = subDict(appearance.resources, 'XObject');
    const imageRef = refOf(entry(xobjects, placements[0].name));
    expect(objectFor(appearance.objects, imageRef)).toBeDefined();
  });

  test('undoes the PNG row filters rather than handing PDF the IDAT', () => {
    const { allocate } = allocator();
    const appearance = buildFieldAppearance({
      fieldType: 'signature',
      value: dataUrl(rgbaPng()),
      boxWidth: 180,
      boxHeight: 60,
      fonts,
      allocate,
    });

    const xobjects = subDict(appearance.resources, 'XObject');
    const imageObject = objectFor(appearance.objects, refOf(entry(xobjects, 'PxSigImg')));
    const image = dictOf(imageObject);

    expect(nameOf(entry(image, 'Subtype'))).toBe('Image');
    expect(entry(image, 'Width')).toBe(3);
    expect(entry(image, 'Height')).toBe(2);
    expect(entry(image, 'BitsPerComponent')).toBe(8);
    expect(nameOf(entry(image, 'ColorSpace'))).toBe('DeviceRGB');
    expect(nameOf(entry(image, 'Filter'))).toBe('FlateDecode');
    expect(entry(image, 'Length')).toBe((imageObject.streamBytes as Uint8Array).length);

    // Row 1 was stored with the Up filter. Handing the IDAT straight to PDF
    // returns it as the difference from row 0 (1, 1, 1, ...) instead of these
    // samples, and every row would carry a leading tag byte.
    expect([...inflate(imageObject)]).toEqual([
      10, 20, 30, 40, 50, 60, 70, 80, 90,
      11, 21, 31, 41, 51, 61, 71, 81, 91,
    ]);
  });

  test('carries the alpha channel as an SMask of matching dimensions', () => {
    const { allocate } = allocator();
    const appearance = buildFieldAppearance({
      fieldType: 'signature',
      value: dataUrl(rgbaPng()),
      boxWidth: 180,
      boxHeight: 60,
      fonts,
      allocate,
    });

    const xobjects = subDict(appearance.resources, 'XObject');
    const image = dictOf(objectFor(appearance.objects, refOf(entry(xobjects, 'PxSigImg'))));

    const maskObject = objectFor(appearance.objects, refOf(entry(image, 'SMask')));
    const mask = dictOf(maskObject);
    expect(nameOf(entry(mask, 'Subtype'))).toBe('Image');
    expect(entry(mask, 'Width')).toBe(entry(image, 'Width'));
    expect(entry(mask, 'Height')).toBe(entry(image, 'Height'));
    expect(nameOf(entry(mask, 'ColorSpace'))).toBe('DeviceGray');
    expect(entry(mask, 'BitsPerComponent')).toBe(8);
    expect(entry(mask, 'Length')).toBe((maskObject.streamBytes as Uint8Array).length);

    // Without this the transparent background renders as a black rectangle.
    expect([...inflate(maskObject)]).toEqual([255, 128, 0, 254, 127, 1]);
  });

  test('omits the SMask for a PNG that has no alpha channel', () => {
    const { allocate, used } = allocator();
    const appearance = buildFieldAppearance({
      fieldType: 'initials',
      value: dataUrl(rgbPng()),
      boxWidth: 90,
      boxHeight: 40,
      fonts,
      allocate,
    });

    const xobjects = subDict(appearance.resources, 'XObject');
    const image = dictOf(objectFor(appearance.objects, refOf(entry(xobjects, 'PxSigImg'))));
    expect(entry(image, 'SMask')).toBeUndefined();
    // One object number for the image, none for a mask that is not there.
    expect(used()).toBe(1);
    expect(appearance.objects).toHaveLength(1);
  });

  test('draws the x-line rule and its X mark alongside the image', () => {
    const { allocate } = allocator();
    const appearance = buildFieldAppearance({
      fieldType: 'signature',
      value: dataUrl(rgbaPng()),
      boxWidth: 220,
      boxHeight: 60,
      style: 'x-line',
      fonts,
      allocate,
    });

    const layout = signatureFormLayout({
      boxWidth: 220, boxHeight: 60, imageAspectRatio: 3 / 2, style: 'x-line',
    });
    expect(layout.line).toBeDefined();
    expect(layout.xMark).toBeDefined();

    const [rule] = strokes(appearance.content);
    expect(rule.from[0]).toBeCloseTo(layout.line!.x, 4);
    expect(rule.from[1]).toBeCloseTo(layout.line!.y, 4);
    expect(rule.to[0]).toBeCloseTo(layout.line!.x + layout.line!.width, 4);
    expect(rule.to[1]).toBeCloseTo(layout.line!.y, 4);
    expect(rule.width).toBeCloseTo(layout.line!.thickness, 4);

    const [mark] = drawnText(appearance.content);
    expect(mark.text).toBe('X');
    expect(mark.size).toBeCloseTo(layout.xMark!.fontSize, 4);
    expect(mark.x).toBeCloseTo(layout.xMark!.x, 4);
    expect(mark.y).toBeCloseTo(layout.xMark!.y, 4);

    // The X is bold, so the form has to declare a bold standard 14 font.
    expect(nameOf(entry(subDict(subDict(appearance.resources, 'Font'), mark.font), 'BaseFont')))
      .toBe('Helvetica-Bold');
  });

  test('the standard style draws neither a rule nor an X', () => {
    const { allocate } = allocator();
    const appearance = buildFieldAppearance({
      fieldType: 'signature',
      value: dataUrl(rgbaPng()),
      boxWidth: 220,
      boxHeight: 60,
      style: 'standard',
      fonts,
      allocate,
    });

    expect(strokes(appearance.content)).toHaveLength(0);
    expect(drawnText(appearance.content)).toHaveLength(0);
  });
});

// --- refusals -----------------------------------------------------------------

/** The AppError code a call refuses with, or a failure if it does not refuse. */
function refusalCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof PdfFieldAppearanceError) return error.code;
    throw error;
  }
  throw new Error('That value was drawn instead of refused.');
}

describe('refusals', () => {
  const build = (overrides: Record<string, unknown>) => () => buildFieldAppearance({
    fieldType: 'signature',
    value: dataUrl(rgbaPng()),
    boxWidth: 180,
    boxHeight: 60,
    fonts,
    allocate: allocator().allocate,
    ...overrides,
  } as any);

  test('an image over the byte cap is refused', () => {
    // The cap applies to the DECODED bytes, which is what a decoder allocates.
    const oversized = Buffer.concat([
      PNG_MAGIC,
      ihdrChunk({ width: 10, height: 10, colourType: 6 }),
      pngChunk('IDAT', Buffer.alloc(SIGNING_PROFILE.maxSignatureImageBytes, 7)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(oversized.length).toBeGreaterThan(SIGNING_PROFILE.maxSignatureImageBytes);

    expect(refusalCode(build({ value: dataUrl(oversized) }))).toBe('SIGNING_IMAGE_TOO_LARGE');
  });

  test('an image over the pixel cap is refused from its header, without decoding', () => {
    // 30000 x 30000 is 900 million pixels declared by a file of a few dozen
    // bytes. The IDAT is deliberately garbage: if the refusal came from
    // decoding, the code would be the filter error instead of this one.
    const declared = Math.ceil(Math.sqrt(SIGNING_PROFILE.maxImagePixels)) + 30000;
    const bomb = Buffer.concat([
      PNG_MAGIC,
      ihdrChunk({ width: declared, height: declared, colourType: 6 }),
      pngChunk('IDAT', Buffer.from([1, 2, 3, 4])),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(bomb.length).toBeLessThan(100);
    expect(declared * declared).toBeGreaterThan(SIGNING_PROFILE.maxImagePixels);

    const inflateSpy = jest.spyOn(zlib, 'inflateSync');
    try {
      expect(refusalCode(build({ value: dataUrl(bomb) }))).toBe('SIGNING_IMAGE_TOO_MANY_PIXELS');
      expect(inflateSpy).not.toHaveBeenCalled();
    } finally {
      inflateSpy.mockRestore();
    }
  });

  test.each([
    ['a value that is not a data URL', 'Amelia Okonkwo'],
    ['a data URL with no payload', 'data:image/png;base64,'],
    ['a non-string value', 42],
  ])('%s is refused rather than drawn', (_label, value) => {
    expect(refusalCode(build({ value }))).toBe('SIGNING_IMAGE_NOT_PNG');
  });

  test('a JPEG payload is refused rather than mislabelled as PNG', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
    expect(refusalCode(build({ value: `data:image/jpeg;base64,${jpeg.toString('base64')}` })))
      .toBe('SIGNING_IMAGE_NOT_PNG');
  });

  test.each([
    ['an interlaced PNG', { interlace: 1, colourType: 6, bitDepth: 8 }],
    ['a 16 bit PNG', { interlace: 0, colourType: 6, bitDepth: 16 }],
    ['a palette PNG', { interlace: 0, colourType: 3, bitDepth: 8 }],
  ])('%s is refused with a reason a user can act on', (_label, shape) => {
    const png = Buffer.concat([
      PNG_MAGIC,
      ihdrChunk({ width: 3, height: 2, ...shape } as any),
      pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(30))),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(refusalCode(build({ value: dataUrl(png) }))).toBe('SIGNING_IMAGE_UNSUPPORTED');
  });

  test('a PNG whose IDAT does not decode is refused, not drawn empty', () => {
    const png = Buffer.concat([
      PNG_MAGIC,
      ihdrChunk({ width: 3, height: 2, colourType: 6 }),
      pngChunk('IDAT', Buffer.from([9, 9, 9, 9, 9, 9])),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(refusalCode(build({ value: dataUrl(png) }))).toBe('SIGNING_IMAGE_MALFORMED');
  });

  test('a PNG whose samples do not match its declared size is refused', () => {
    const png = Buffer.concat([
      PNG_MAGIC,
      ihdrChunk({ width: 3, height: 5, colourType: 6 }),
      // Two rows of samples for a file claiming five.
      pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(2 * (3 * 4 + 1)))),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(refusalCode(build({ value: dataUrl(png) }))).toBe('SIGNING_IMAGE_MALFORMED');
  });

  test('an empty text value is refused rather than drawn as nothing', () => {
    expect(refusalCode(build({ fieldType: 'text', value: '   ' })))
      .toBe('SIGNING_FIELD_VALUE_EMPTY');
  });

  test('an unchecked checkbox is refused rather than stamped blank', () => {
    expect(refusalCode(build({ fieldType: 'checkbox', value: false })))
      .toBe('SIGNING_FIELD_VALUE_EMPTY');
  });

  test('text the standard 14 fonts cannot encode is refused, not silently blank', () => {
    // The shipping renderer catches the width measurement and leaves the field
    // empty. A document that quietly shows nothing where a signer typed their
    // name is worse than one that fails.
    expect(refusalCode(build({ fieldType: 'text', value: '田中 太郎' })))
      .toBe('SIGNING_FIELD_TEXT_UNRENDERABLE');
  });

  test('an unknown field type is refused rather than treated as a signature', () => {
    expect(refusalCode(build({ fieldType: 'radio', value: 'on' })))
      .toBe('SIGNING_FIELD_TYPE_UNSUPPORTED');
  });

  test('a box with no area is refused', () => {
    expect(refusalCode(build({ boxHeight: 0 }))).toBe('SIGNING_FIELD_BOX_INVALID');
  });
});

// --- parity with the shipping renderer ----------------------------------------

describe('parity with signingFieldValues', () => {
  test('text lands at the same place, size and content', async () => {
    const value = 'Amelia (Amy) Okonkwo \\ Partner';

    const theirs = drawnText(await pdfLibStream((page, font) => {
      drawTextValue(page, font, 'text', value, PARITY_BOX);
    }));

    const { allocate } = allocator();
    const ours = drawnText(buildFieldAppearance({
      fieldType: 'text',
      value,
      boxWidth: PARITY_BOX.boxWidth,
      boxHeight: PARITY_BOX.boxHeight,
      fonts,
      allocate,
    }).content);

    expect(ours).toHaveLength(theirs.length);
    expect(theirs.length).toBeGreaterThan(0);
    ours.forEach((line, i) => {
      expect(line.text).toBe(theirs[i].text);
      expect(line.size).toBeCloseTo(theirs[i].size, 3);
      // The appearance draws in the form's own box, which sits at the field's
      // origin on the page.
      expect(line.x + PARITY_BOX.x).toBeCloseTo(theirs[i].x, 3);
      expect(line.y + PARITY_BOX.y).toBeCloseTo(theirs[i].y, 3);
    });
  });

  test('a wrapped multi-line text value stays in step line for line', async () => {
    const value = 'Okonkwo Ferrara and Bright LLP, Attorneys at Law, Columbus Ohio';

    const theirs = drawnText(await pdfLibStream((page, font) => {
      drawTextValue(page, font, 'text', value, PARITY_BOX);
    }));

    const { allocate } = allocator();
    const ours = drawnText(buildFieldAppearance({
      fieldType: 'text',
      value,
      boxWidth: PARITY_BOX.boxWidth,
      boxHeight: PARITY_BOX.boxHeight,
      fonts,
      allocate,
    }).content);

    expect(theirs.length).toBeGreaterThan(1);
    expect(ours.map((d) => d.text)).toEqual(theirs.map((d) => d.text));
    ours.forEach((line, i) => {
      expect(line.x + PARITY_BOX.x).toBeCloseTo(theirs[i].x, 3);
      expect(line.y + PARITY_BOX.y).toBeCloseTo(theirs[i].y, 3);
    });
  });

  // Two heights on purpose. The renderer floors the stroke at 1.5pt, and that
  // floor only bites below 25pt of box: at 40pt the proportional width wins, so
  // a test at that size alone would not notice the floor going missing.
  test.each([
    ['a 40pt box, where the proportional width wins', 40],
    ['a 16pt box, where the 1.5pt floor wins', 16],
  ])('the checkbox mark traces the same two segments at the same width in %s', async (_label, boxHeight) => {
    const box = { ...PARITY_BOX, boxHeight, y: PARITY_BOX.top - boxHeight };

    const theirs = strokes(await pdfLibStream((page) => {
      drawCheckbox(page, box);
    }));

    const { allocate } = allocator();
    const ours = strokes(buildFieldAppearance({
      fieldType: 'checkbox',
      value: true,
      boxWidth: box.boxWidth,
      boxHeight: box.boxHeight,
      fonts,
      allocate,
    }).content);

    expect(theirs).toHaveLength(2);
    expect(ours).toHaveLength(2);
    ours.forEach((segment, i) => {
      expect(segment.from[0] + box.x).toBeCloseTo(theirs[i].from[0], 3);
      expect(segment.from[1] + box.y).toBeCloseTo(theirs[i].from[1], 3);
      expect(segment.to[0] + box.x).toBeCloseTo(theirs[i].to[0], 3);
      expect(segment.to[1] + box.y).toBeCloseTo(theirs[i].to[1], 3);
      expect(segment.width).toBeCloseTo(theirs[i].width, 3);
    });
  });

  test.each(['true', 1, '1', true])('a checkbox value of %p is treated as checked', (value) => {
    const { allocate } = allocator();
    const appearance = buildFieldAppearance({
      fieldType: 'checkbox',
      value,
      boxWidth: 40,
      boxHeight: 40,
      fonts,
      allocate,
    });
    expect(strokes(appearance.content)).toHaveLength(2);
  });
});
