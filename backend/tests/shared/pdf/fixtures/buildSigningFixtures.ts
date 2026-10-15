/**
 * The signing corpus: documents whose STRUCTURE is the thing under test.
 *
 * Every builder here returns the bytes of a complete PDF. None of them reaches
 * for a template file and patches it with a regular expression, because a
 * regular expression over PDF bytes cannot see the object graph and quietly
 * produces a file whose cross-reference no longer matches its contents. A
 * fixture like that fails for a reason unrelated to the case it was written for,
 * and the failure looks like an engine bug.
 *
 * Two construction routes, and the choice is not stylistic:
 *
 *   pdf-lib's OBJECT MODEL builds anything expressible as a normal document.
 *   `PDFContext` holds the indirect objects and `PDFWriter` lays out the
 *   cross-reference, so offsets are always right by construction.
 *
 *   HAND-LAID BYTES build the three shapes pdf-lib has no way to emit: a
 *   hybrid-reference file, an object at a nonzero generation, and a second
 *   revision that frees an object. Those are laid out explicitly, with every
 *   offset computed from the assembled bytes rather than counted by hand.
 *
 * Every builder is DETERMINISTIC. The corpus manifest pins each fixture's
 * SHA-256, so a builder that silently changes what it emits turns the corpus
 * test red instead of quietly moving the ground under every other test here.
 * That is why the dates, the producer strings and the fonts are all fixed, and
 * why nothing calls `Math.random` (pdf-lib's own resource-name suffixes come
 * from a seeded generator on `PDFContext`, so they repeat run to run).
 */
import zlib from 'zlib';
import {
  PDFContext,
  PDFDocument,
  PDFRef,
  PDFStreamWriter,
  PDFWriter,
  StandardFonts,
} from 'pdf-lib';

/**
 * pdf-lib yields to the event loop every `objectsPerTick` objects while it
 * serializes. A fixture is built once and thrown away, so there is nothing to
 * keep responsive; a very large value makes the 1,000-page build one pass.
 */
const NEVER_YIELD = 1_000_000_000;

/** A fixed instant for every date a producer writes, so bytes never drift. */
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

/** Serialize a context as a classic `xref` table document. */
async function classicBytes(context: PDFContext): Promise<Buffer> {
  return Buffer.from(await PDFWriter.forContext(context, NEVER_YIELD).serializeToBuffer());
}

/** Serialize a context as a cross-reference STREAM document with object streams. */
async function objectStreamBytes(context: PDFContext): Promise<Buffer> {
  return Buffer.from(
    await PDFStreamWriter.forContext(context, NEVER_YIELD, true, 50).serializeToBuffer(),
  );
}

/** The one built-in font every fixture uses, so no font file is ever embedded. */
function helveticaFont(context: PDFContext): PDFRef {
  return context.register(context.obj({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  }));
}

/** The content stream operators for one line of visible text. */
export function textOperators(text: string): string {
  return `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n`;
}

/** A page-sized content stream drawing one line of text. */
function textStream(context: PDFContext, text: string): PDFRef {
  return context.register(context.stream(textOperators(text)));
}

export const IMAGE_WIDTH = 8;
export const IMAGE_HEIGHT = 8;

/**
 * The samples of a real 8x8 greyscale image: a one-pixel checkerboard.
 *
 * These are actual image samples, not filler. The corpus test decodes the image
 * XObject out of the composed document and checks the checkerboard, so a stream
 * of repeated bytes wearing an `/Image` subtype would fail rather than pass for
 * the wrong reason.
 */
export function checkerboardSamples(): Uint8Array {
  const samples = new Uint8Array(IMAGE_WIDTH * IMAGE_HEIGHT);
  for (let y = 0; y < IMAGE_HEIGHT; y += 1) {
    for (let x = 0; x < IMAGE_WIDTH; x += 1) {
      samples[y * IMAGE_WIDTH + x] = ((x + y) % 2) * 255;
    }
  }
  return samples;
}

/**
 * An uncompressed greyscale image XObject.
 *
 * Uncompressed on purpose: a filter would make the fixture's bytes depend on the
 * exact zlib build, and the point of the image is its samples, not its encoding.
 */
function imageXObject(context: PDFContext): PDFRef {
  return context.register(context.stream(checkerboardSamples(), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: IMAGE_WIDTH,
    Height: IMAGE_HEIGHT,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: 8,
  }));
}

// ---------------------------------------------------------------------------
// Fixtures built by pdf-lib's high-level document API, which is what an
// ordinary producer would emit.
// ---------------------------------------------------------------------------

/** A one-page text document with a classic `xref` table. */
export async function buildProducerClassicXref(): Promise<Buffer> {
  const document = await producerDocument();
  return Buffer.from(await document.save({ useObjectStreams: false, updateFieldAppearances: false }));
}

/**
 * The same document stored the PDF 1.5 way: its objects packed into object
 * streams and its cross-reference written as a stream.
 *
 * On a modern document MOST objects are reached this way, so a reader that only
 * follows file offsets sees an almost empty file.
 */
export async function buildProducerObjectStreams(): Promise<Buffer> {
  const document = await producerDocument();
  return Buffer.from(await document.save({ useObjectStreams: true, updateFieldAppearances: false }));
}

async function producerDocument(): Promise<PDFDocument> {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.setProducer('Paralegix signing corpus');
  document.setCreator('Paralegix signing corpus');
  document.setCreationDate(FIXED_DATE);
  document.setModificationDate(FIXED_DATE);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.drawText('Retainer agreement', { x: 72, y: 720, size: 12, font });
  return document;
}

// ---------------------------------------------------------------------------
// Fixtures built through pdf-lib's object model, where the page tree itself is
// the case under test.
// ---------------------------------------------------------------------------

/**
 * A page whose `/Contents` is an ARRAY of two streams.
 *
 * The two halves are one graphics block split across streams, which is legal and
 * common: a viewer concatenates them before interpreting. It is also why a
 * stamp must APPEND to the array rather than replace it, and why it must not
 * assume the entry is a single reference.
 */
export async function buildArrayContentsPage(): Promise<Buffer> {
  const context = PDFContext.create();
  const font = helveticaFont(context);
  const opening = context.register(context.stream('q 1 0 0 1 0 0 cm\n'));
  const closing = context.register(context.stream(`${textOperators('Retainer agreement')}Q\n`));
  const pagesRef = context.nextRef();
  const pageRef = context.register(context.obj({
    Type: 'Page', Parent: pagesRef, Contents: [opening, closing],
  }));
  context.assign(pagesRef, context.obj({
    Type: 'Pages',
    Count: 1,
    Kids: [pageRef],
    MediaBox: [0, 0, 612, 792],
    Resources: { Font: { F1: font } },
  }));
  context.trailerInfo.Root = context.register(context.obj({ Type: 'Catalog', Pages: pagesRef }));
  return classicBytes(context);
}

/**
 * A page with NO `/Contents` entry at all.
 *
 * An empty page is ordinary (a separator sheet, the back of a duplex scan), and
 * a stamp that assumes the entry exists either throws or drops its own mark.
 */
export async function buildBlankPageWithoutContents(): Promise<Buffer> {
  const context = PDFContext.create();
  const pagesRef = context.nextRef();
  const pageRef = context.register(context.obj({ Type: 'Page', Parent: pagesRef }));
  context.assign(pagesRef, context.obj({
    Type: 'Pages', Count: 1, Kids: [pageRef], MediaBox: [0, 0, 612, 792],
  }));
  context.trailerInfo.Root = context.register(context.obj({ Type: 'Catalog', Pages: pagesRef }));
  return classicBytes(context);
}

export const NESTED_TREE_PAGES = 1000;
const NESTED_TREE_FANOUT = 10;

/**
 * A 1,000-page document whose page tree has real intermediate nodes.
 *
 * Ten branches of ten branches of ten leaves, so the last page sits four levels
 * below the catalog. A flat `/Kids` list of a thousand references would exercise
 * none of the walk: the whole point is that reaching page 1,000 means descending
 * and backtracking, and that the geometry it needs is stated once at the root.
 *
 * Each leaf draws its own page number, so a walk that returns the right COUNT
 * but the wrong ORDER is visible in the content rather than invisible.
 */
export async function buildNestedThousandPageTree(
  options: { objectStreams?: boolean } = {},
): Promise<Buffer> {
  const context = PDFContext.create();
  const font = helveticaFont(context);

  const branchCount = NESTED_TREE_PAGES / (NESTED_TREE_FANOUT * NESTED_TREE_FANOUT);
  // Every parent has to be referenceable before its children are built, so the
  // refs are reserved top down and the dictionaries assigned bottom up.
  const rootRef = context.nextRef();
  const branchRefs = reserve(context, branchCount);
  const twigRefs = reserve(context, branchCount * NESTED_TREE_FANOUT);
  const leafRefs = reserve(context, NESTED_TREE_PAGES);

  leafRefs.forEach((leafRef, i) => {
    const contents = textStream(context, `Page ${i + 1}`);
    context.assign(leafRef, context.obj({
      Type: 'Page', Parent: twigRefs[Math.floor(i / NESTED_TREE_FANOUT)], Contents: contents,
    }));
  });

  twigRefs.forEach((twigRef, i) => {
    context.assign(twigRef, context.obj({
      Type: 'Pages',
      Parent: branchRefs[Math.floor(i / NESTED_TREE_FANOUT)],
      Count: NESTED_TREE_FANOUT,
      Kids: leafRefs.slice(i * NESTED_TREE_FANOUT, (i + 1) * NESTED_TREE_FANOUT),
    }));
  });

  branchRefs.forEach((branchRef, i) => {
    const slice = twigRefs.slice(i * NESTED_TREE_FANOUT, (i + 1) * NESTED_TREE_FANOUT);
    context.assign(branchRef, context.obj({
      Type: 'Pages',
      Parent: rootRef,
      Count: NESTED_TREE_FANOUT * NESTED_TREE_FANOUT,
      Kids: slice,
    }));
  });

  // The geometry and the font live ONLY here, so every leaf inherits across
  // three levels.
  context.assign(rootRef, context.obj({
    Type: 'Pages',
    Count: NESTED_TREE_PAGES,
    Kids: branchRefs,
    MediaBox: [0, 0, 612, 792],
    Resources: { Font: { F1: font } },
  }));
  context.trailerInfo.Root = context.register(context.obj({ Type: 'Catalog', Pages: rootRef }));
  return options.objectStreams ? objectStreamBytes(context) : classicBytes(context);
}

/**
 * The same 1,000-page tree, with every dictionary packed into object streams.
 *
 * This is how a modern producer writes a long document: page dictionaries are
 * not at file offsets but inside compressed containers of fifty objects each.
 * Resolving the tree reaches every one of them, so it is the shape that shows
 * whether a container is decoded once or once per object it holds.
 */
export function buildNestedThousandPageTreeInObjectStreams(): Promise<Buffer> {
  return buildNestedThousandPageTree({ objectStreams: true });
}

function reserve(context: PDFContext, count: number): PDFRef[] {
  return Array.from({ length: count }, () => context.nextRef());
}

export const INHERITED_MEDIA_BOX = [0, 0, 595, 842] as const;
export const INHERITED_CROP_BOX = [20, 30, 575, 812] as const;
export const INHERITED_ROTATE = 90;
export const INHERITED_PAGES = 3;

/**
 * Three pages that state NONE of their own geometry.
 *
 * `/MediaBox`, `/CropBox`, `/Rotate` and `/Resources` sit on the ancestor and
 * are inherited. A change that rebuilds the `/Pages` node instead of copying it
 * loses all four at once, which makes every existing page sizeless.
 */
export async function buildInheritedGeometry(): Promise<Buffer> {
  const context = PDFContext.create();
  const font = helveticaFont(context);
  const pagesRef = context.nextRef();
  const leafRefs = Array.from({ length: INHERITED_PAGES }, (_unused, i) => context.register(context.obj({
    Type: 'Page', Parent: pagesRef, Contents: textStream(context, `Exhibit ${i + 1}`),
  })));
  context.assign(pagesRef, context.obj({
    Type: 'Pages',
    Count: INHERITED_PAGES,
    Kids: leafRefs,
    MediaBox: [...INHERITED_MEDIA_BOX],
    CropBox: [...INHERITED_CROP_BOX],
    Rotate: INHERITED_ROTATE,
    Resources: { Font: { F1: font } },
  }));
  context.trailerInfo.Root = context.register(context.obj({ Type: 'Catalog', Pages: pagesRef }));
  return classicBytes(context);
}

/**
 * A page whose `/Resources` is an INDIRECT object rather than a nested
 * dictionary.
 *
 * Both forms are legal and both are common. Code that reads the entry without
 * resolving it sees a reference where it expected a dictionary and concludes
 * the page has no resources, which is how a stamp ends up overwriting the
 * page's own font.
 */
export async function buildIndirectResources(): Promise<Buffer> {
  const context = PDFContext.create();
  const font = helveticaFont(context);
  const resourcesRef = context.register(context.obj({ Font: { F1: font } }));
  const pagesRef = context.nextRef();
  const pageRef = context.register(context.obj({
    Type: 'Page',
    Parent: pagesRef,
    Contents: textStream(context, 'Engagement letter'),
    Resources: resourcesRef,
  }));
  context.assign(pagesRef, context.obj({
    Type: 'Pages', Count: 1, Kids: [pageRef], MediaBox: [0, 0, 612, 792],
  }));
  context.trailerInfo.Root = context.register(context.obj({ Type: 'Catalog', Pages: pagesRef }));
  return classicBytes(context);
}

/** The XObject name this page has already taken, which is the stamp's first choice. */
export const COLLIDING_XOBJECT_NAME = 'ParalegixSig0';

/**
 * A page that already uses the resource names a stamp would reach for.
 *
 * `/ParalegixSig0` is the first name the appearance planner tries, and this page
 * has an IMAGE under it that its content stream draws. A stamp that takes the
 * name anyway replaces the image with the signature: the page still renders, the
 * response still says success, and a photograph is gone.
 */
export async function buildCollidingResourceNames(): Promise<Buffer> {
  const context = PDFContext.create();
  const font = helveticaFont(context);
  const image = imageXObject(context);
  const contents = context.register(context.stream(
    `q ${IMAGE_WIDTH * 8} 0 0 ${IMAGE_HEIGHT * 8} 72 560 cm /${COLLIDING_XOBJECT_NAME} Do Q\n`
    + textOperators('Retainer agreement'),
  ));
  const pagesRef = context.nextRef();
  const pageRef = context.register(context.obj({
    Type: 'Page',
    Parent: pagesRef,
    Contents: contents,
    Resources: {
      Font: { F1: font },
      XObject: { [COLLIDING_XOBJECT_NAME]: image },
    },
  }));
  context.assign(pagesRef, context.obj({
    Type: 'Pages', Count: 1, Kids: [pageRef], MediaBox: [0, 0, 612, 792],
  }));
  context.trailerInfo.Root = context.register(context.obj({ Type: 'Catalog', Pages: pagesRef }));
  return classicBytes(context);
}

/**
 * A document that states no page size anywhere.
 *
 * There is no safe default. US Letter is a guess, and a guess puts a signature
 * at coordinates that are correct for a page which does not exist. This fixture
 * exists so the corpus records a REFUSAL as deliberate behaviour rather than an
 * untested path.
 */
export async function buildMissingMediaBox(): Promise<Buffer> {
  const context = PDFContext.create();
  const pagesRef = context.nextRef();
  const pageRef = context.register(context.obj({
    Type: 'Page', Parent: pagesRef, Contents: textStream(context, 'No geometry'),
  }));
  context.assign(pagesRef, context.obj({ Type: 'Pages', Count: 1, Kids: [pageRef] }));
  context.trailerInfo.Root = context.register(context.obj({ Type: 'Catalog', Pages: pagesRef }));
  return classicBytes(context);
}

// ---------------------------------------------------------------------------
// Fixtures laid out byte by byte, for the shapes pdf-lib cannot express.
// ---------------------------------------------------------------------------

interface RawObject {
  n: number;
  /** Generation. Omitted means 0, which is what nearly every object is. */
  g?: number;
  body: string | Buffer;
}

interface Laid {
  bytes: Buffer;
  offsets: Map<number, number>;
}

/** Lay out `n g obj ... endobj` blocks and record where each one started. */
function layObjects(objects: RawObject[], header = '%PDF-1.7\n', startAt = 0): Laid {
  const parts: Buffer[] = [];
  const offsets = new Map<number, number>();
  let at = startAt;
  if (header) {
    const head = Buffer.from(header, 'latin1');
    parts.push(head);
    at += head.length;
  }
  for (const object of objects) {
    offsets.set(object.n, at);
    const opening = Buffer.from(`${object.n} ${object.g ?? 0} obj\n`, 'latin1');
    const body = Buffer.isBuffer(object.body) ? object.body : Buffer.from(object.body, 'latin1');
    const closing = Buffer.from('\nendobj\n', 'latin1');
    parts.push(opening, body, closing);
    at += opening.length + body.length + closing.length;
  }
  return { bytes: Buffer.concat(parts), offsets };
}

/** One cross-reference row. Exactly 20 bytes, because readers index by multiplication. */
function xrefRow(offset: number, generation: number, inUse: boolean): string {
  return `${String(offset).padStart(10, '0')} ${String(generation).padStart(5, '0')} ${inUse ? 'n' : 'f'} \n`;
}

/** A stream object body, with the `/Length` the payload actually has. */
function streamBody(entries: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<< ${entries} /Length ${payload.length} >>\nstream\n`, 'latin1'),
    payload,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

/**
 * A real baseline JPEG, 16 by 16, as fixed bytes.
 *
 * Fixed rather than encoded at build time for the same reason the greyscale
 * image above is uncompressed: a fixture whose bytes depend on which version of
 * an encoder is installed moves the ground under every assertion that rests on
 * it. Encoded once with `jpeg-js` at quality 85 from a checkerboard raster, and
 * the corpus test DECODES these bytes on every run, so filler wearing a
 * `/DCTDecode` filter fails there rather than passing as a scanned page.
 */
const SCANNED_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx4BBQUFBwYHDggIDh4UERQeHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHv/AABEIABAAEAMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AE/5NO/6nL/hKf8Atw+y/Zf+/u/d9o/2cbO+eAA/5NO/6nL/AISn/tw+y/Zf+/u/d9o/2cbO+eAA/wCTTv8Aqcv+Ep/7cPsv2X/v7v3faP8AZxs754AD/k07/qcv+Ep/7cPsv2X/AL+7932j/Zxs754AP//Z';

/** The scanned page's image, as the bytes that go into the document. */
export function scannedJpegBytes(): Buffer {
  return Buffer.from(SCANNED_JPEG_BASE64, 'base64');
}

/** What that JPEG decodes to, which the corpus test checks against the real decoder. */
export const SCANNED_JPEG_SIZE = { width: 16, height: 16 };

/**
 * A page that is nothing but a scanned image.
 *
 * This is the document the whole engine exists for. A scanned contract has no
 * text, one enormous `/DCTDecode` image per page, and a content stream that does
 * nothing but place it. It is also the case where appending is most obviously
 * right: the image is the overwhelming majority of the bytes, and a stamp that
 * rewrote the document would move every one of them to draw a signature in one
 * corner.
 *
 * The image data is binary and contains byte sequences that look like PDF
 * syntax, which is exactly what a writer that rewrites objects gets wrong.
 */
export function buildScannedJpegPage(): Buffer {
  const image = scannedJpegBytes();
  const content = Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q\n', 'latin1');
  const laid = layObjects([
    { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] >>' },
    {
      n: 3,
      body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R '
        + '/Resources << /XObject << /Im0 4 0 R >> >> >>',
    },
    {
      n: 4,
      body: streamBody(
        `/Type /XObject /Subtype /Image /Width ${SCANNED_JPEG_SIZE.width} `
          + `/Height ${SCANNED_JPEG_SIZE.height} /ColorSpace /DeviceRGB `
          + '/BitsPerComponent 8 /Filter /DCTDecode',
        image,
      ),
    },
    { n: 5, body: streamBody('', content) },
  ]);

  const xrefAt = laid.bytes.length;
  let table = 'xref\n0 6\n' + xrefRow(0, 65535, false);
  for (let n = 1; n <= 5; n += 1) table += xrefRow(laid.offsets.get(n)!, 0, true);
  table += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.concat([laid.bytes, Buffer.from(table, 'latin1')]);
}

/** The appearance stream a form widget draws itself from. */
const WIDGET_APPEARANCE = 'q 0 0 1 RG 0.5 w 0 0 180 24 re S BT /Helv 12 Tf 4 7 Td (Jane Roe) Tj ET Q\n';

/**
 * A page carrying a filled form field with its own appearance.
 *
 * Two properties meet here that meet nowhere else in the corpus. The page has
 * `/Annots`, which a stamp must leave alone: a writer that rewrites the page
 * dictionary and forgets them deletes the form. And the catalog has an
 * `/AcroForm`, which is an unrelated catalog structure the appended revision
 * has to carry forward rather than replace.
 *
 * The widget is FILLED and has a normal appearance, which is the case
 * preparation flattens. Here it is left interactive on purpose: this fixture is
 * about what stamping does to a document that still has a form in it.
 */
export function buildFormAppearances(): Buffer {
  const text = Buffer.from(textOperators('Client intake form'), 'latin1');
  const appearance = Buffer.from(WIDGET_APPEARANCE, 'latin1');
  const laid = layObjects([
    { n: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] /DA (/Helv 0 Tf 0 g) >> >>' },
    { n: 2, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] >>' },
    {
      n: 3,
      body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R '
        + '/Annots [6 0 R] /Resources << /Font << /F1 5 0 R >> >> >>',
    },
    { n: 4, body: streamBody('', text) },
    { n: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
    {
      n: 6,
      body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (signerName) /V (Jane Roe) '
        + '/Rect [72 600 252 624] /P 3 0 R /F 4 /AP << /N 7 0 R >> >>',
    },
    {
      n: 7,
      body: streamBody(
        '/Type /XObject /Subtype /Form /BBox [0 0 180 24] '
          + '/Resources << /Font << /Helv 5 0 R >> >>',
        appearance,
      ),
    },
  ]);

  const xrefAt = laid.bytes.length;
  let table = 'xref\n0 8\n' + xrefRow(0, 65535, false);
  for (let n = 1; n <= 7; n += 1) table += xrefRow(laid.offsets.get(n)!, 0, true);
  table += `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.concat([laid.bytes, Buffer.from(table, 'latin1')]);
}

export const NONZERO_PAGE_GENERATION = 2;
export const NONZERO_CONTENTS_GENERATION = 5;

/**
 * A document whose page and content stream sit at NONZERO generations.
 *
 * `3 0 R` and `3 2 R` name different objects. A reader that ignores the
 * generation resolves whatever now occupies the number, and an incremental
 * update that writes the replacement at generation 0 orphans the original
 * reference while leaving a file that still opens.
 */
export function buildNonzeroGenerations(): Buffer {
  const text = Buffer.from(textOperators('Deposition transcript'), 'latin1');
  const laid = layObjects([
    { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    {
      n: 2,
      body: `<< /Type /Pages /Count 1 /Kids [3 ${NONZERO_PAGE_GENERATION} R] `
        + '/MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> >>',
    },
    {
      n: 3,
      g: NONZERO_PAGE_GENERATION,
      body: `<< /Type /Page /Parent 2 0 R /Contents 4 ${NONZERO_CONTENTS_GENERATION} R >>`,
    },
    { n: 4, g: NONZERO_CONTENTS_GENERATION, body: streamBody('', text) },
    { n: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
  ]);

  const xrefAt = laid.bytes.length;
  const generations = new Map([[3, NONZERO_PAGE_GENERATION], [4, NONZERO_CONTENTS_GENERATION]]);
  let table = 'xref\n0 6\n' + xrefRow(0, 65535, false);
  for (let n = 1; n <= 5; n += 1) {
    table += xrefRow(laid.offsets.get(n)!, generations.get(n) ?? 0, true);
  }
  table += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.concat([laid.bytes, Buffer.from(table, 'latin1')]);
}

/** The object the second revision frees. */
export const FREED_OBJECT_NUMBER = 6;

/**
 * Two revisions, the second of which DELETES an object.
 *
 * Revision one gives the page an annotation. Revision two rewrites the page
 * without it and marks the annotation's object number free. A reader that takes
 * the oldest definition it can find, or that ignores the free tombstone,
 * resurrects an annotation the document no longer has, and the same mistake on a
 * signed document resurrects a page that was signed away.
 */
export function buildMultipleRevisionsWithFreeEntries(): Buffer {
  const text = Buffer.from(textOperators('Settlement agreement'), 'latin1');
  const first = layObjects([
    { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    {
      n: 2,
      body: '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] '
        + '/Resources << /Font << /F1 5 0 R >> >> >>',
    },
    { n: 3, body: `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Annots [${FREED_OBJECT_NUMBER} 0 R] >>` },
    { n: 4, body: streamBody('', text) },
    { n: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
    { n: FREED_OBJECT_NUMBER, body: '<< /Type /Annot /Subtype /Square /Rect [10 10 40 40] >>' },
  ]);

  const firstXrefAt = first.bytes.length;
  let firstTable = 'xref\n0 7\n' + xrefRow(0, 65535, false);
  for (let n = 1; n <= 6; n += 1) firstTable += xrefRow(first.offsets.get(n)!, 0, true);
  firstTable += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${firstXrefAt}\n%%EOF\n`;
  const revisionOne = Buffer.concat([first.bytes, Buffer.from(firstTable, 'latin1')]);

  // The second revision is APPENDED. The first revision's bytes are untouched,
  // which is what makes the tombstone rather than a rewrite the only way the
  // annotation disappears.
  const second = layObjects(
    [{ n: 3, body: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>' }],
    '',
    revisionOne.length,
  );
  const secondXrefAt = revisionOne.length + second.bytes.length;
  const secondTable = 'xref\n'
    // Object 0 heads the free list and now points at the newly freed number.
    + `0 1\n${xrefRow(FREED_OBJECT_NUMBER, 65535, false)}`
    + `3 1\n${xrefRow(second.offsets.get(3)!, 0, true)}`
    // Freeing bumps the generation, so the number cannot be reused silently.
    + `${FREED_OBJECT_NUMBER} 1\n${xrefRow(0, 1, false)}`
    + `trailer\n<< /Size 7 /Root 1 0 R /Prev ${firstXrefAt} >>\n`
    + `startxref\n${secondXrefAt}\n%%EOF\n`;

  return Buffer.concat([revisionOne, second.bytes, Buffer.from(secondTable, 'latin1')]);
}

/**
 * A hybrid-reference file: a classic table PLUS an `/XRefStm` pointing at a
 * cross-reference stream that describes the same objects.
 *
 * Acrobat writes these so that a pre-1.5 reader can still open a document whose
 * newer objects live in streams. `pagesOnlyInStream` chooses which of the two
 * kinds this is:
 *
 *   false: every object appears in the classic table too, so a reader that
 *   ignores `/XRefStm` still finds everything.
 *
 *   true: the page and its content are marked FREE in the classic table and are
 *   described only by the stream, which is the shape a real hybrid file takes.
 *   A reader that ignores `/XRefStm` sees a document whose page was deleted.
 */
export function buildHybridXref(options: { pagesOnlyInStream: boolean }): Buffer {
  const text = Buffer.from(textOperators('Hybrid reference file'), 'latin1');
  const hidden = new Set(options.pagesOnlyInStream ? [3, 4] : []);

  // The stream's rows are laid out once with placeholder offsets so its encoded
  // length is known, then again with the real ones. Both passes produce the same
  // length because every row is fixed width.
  const build = (offsets: Map<number, number>) => {
    const rows = [3, 4].map((n) => xrefStreamRow(offsets.get(n) ?? 0));
    const payload = zlib.deflateSync(Buffer.concat(rows), { level: 9 });
    return layObjects([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      {
        n: 2,
        body: '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] '
          + '/Resources << /Font << /F1 5 0 R >> >> >>',
      },
      { n: 3, body: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>' },
      { n: 4, body: streamBody('', text) },
      { n: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
      {
        n: 6,
        body: streamBody(
          '/Type /XRef /W [1 2 2] /Index [3 2] /Size 7 /Root 1 0 R /Filter /FlateDecode',
          payload,
        ),
      },
    ]);
  };

  const firstPass = build(new Map());
  const laid = build(firstPass.offsets);

  const xrefAt = laid.bytes.length;
  let table = 'xref\n0 7\n' + xrefRow(0, 65535, false);
  for (let n = 1; n <= 6; n += 1) {
    table += hidden.has(n) ? xrefRow(0, 1, false) : xrefRow(laid.offsets.get(n)!, 0, true);
  }
  table += `trailer\n<< /Size 7 /Root 1 0 R /XRefStm ${laid.offsets.get(6)!} >>\n`
    + `startxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.concat([laid.bytes, Buffer.from(table, 'latin1')]);
}

/** One `/W [1 2 2]` row: in-use type, two-byte offset, two-byte generation. */
function xrefStreamRow(offset: number): Buffer {
  const row = Buffer.alloc(5);
  row.writeUInt8(1, 0);
  row.writeUInt16BE(offset, 1);
  row.writeUInt16BE(0, 3);
  return row;
}
