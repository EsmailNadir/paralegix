/**
 * The corpus manifest, checked against the corpus.
 *
 * Two separate jobs, and both matter.
 *
 * THE FIXTURES HAVE TO BE FIXED. Every other suite that uses this corpus rests
 * on the bytes being what they were when its assertions were written. A builder
 * that starts emitting something else, because a pdf-lib upgrade changed a
 * default or because someone tuned a fixture and forgot what depends on it,
 * moves the ground under all of them at once and each failure then looks like an
 * engine bug. So the manifest records each fixture's length and SHA-256
 * independently, and this file compares them against what the builders actually
 * produce.
 *
 * THE ENGINE'S ANSWER HAS TO BE THE RECORDED ONE. For every fixture the manifest
 * states whether the engine accepts or refuses the document, how many pages it
 * finds, how many revisions the file has, and what marks a signature leaves.
 * A refusal is a decision, not an accident, so it is written down with its
 * reason and checked the same way an acceptance is.
 */
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { resolvePages } from '../../../src/modules/signatures/pdf/pages';
import { getObject, readDocumentIndex } from '../../../src/modules/signatures/pdf/reader';
import {
  contentsShape,
  CORPUS,
  reopen,
  sourceOver,
  stampSignature,
  type CorpusFixture,
} from './fixtures/manifest';
import { SCANNED_JPEG_SIZE, scannedJpegBytes } from './fixtures/buildSigningFixtures';

const signal = new AbortController().signal;

/** Build once per fixture, because the 1,000-page tree is the expensive one. */
const built = new Map<string, Buffer>();

async function bytesFor(entry: CorpusFixture): Promise<Buffer> {
  const cached = built.get(entry.id);
  if (cached) return cached;
  const bytes = await entry.build();
  built.set(entry.id, bytes);
  return bytes;
}

const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

describe('the corpus is a fixed set of bytes', () => {
  it('holds every fixture exactly once', () => {
    const ids = CORPUS.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(13);
  });

  it.each(CORPUS.map((entry) => [entry.id, entry] as const))(
    '%s matches the length and digest the manifest records',
    async (_id, entry) => {
      // Goes red whenever a builder changes what it emits, whatever the reason.
      const bytes = await bytesFor(entry);

      expect(bytes.length).toBe(entry.byteLength);
      expect(sha256(bytes)).toBe(entry.sha256);
    },
  );

  it.each(CORPUS.map((entry) => [entry.id, entry] as const))(
    '%s builds the same bytes every time',
    async (_id, entry) => {
      // The digest above is only worth pinning if the builder is deterministic.
      // A fixture that varied per run would fail there for a reason that has
      // nothing to do with the change being made.
      const first = await bytesFor(entry);
      const second = await entry.build();

      expect(second.equals(first)).toBe(true);
    },
  );

  it.each(CORPUS.map((entry) => [entry.id, entry] as const))(
    '%s is a document an independent parser opens',
    async (_id, entry) => {
      // A refusal has to be this engine's judgement about a VALID document. A
      // fixture that pdf-lib also rejects proves nothing about the engine, and
      // this is what separates the two.
      const bytes = await bytesFor(entry);

      const parsedPages = await PDFDocument.load(bytes, { updateMetadata: false })
        .then((document) => document.getPageCount(), () => null);

      expect(parsedPages !== null).toBe(entry.parsesInPdfLib);
      if (entry.parsesInPdfLib) expect(parsedPages).toBeGreaterThan(0);
    },
  );
});

describe('the engine answers what the manifest says it answers', () => {
  it.each(CORPUS.map((entry) => [entry.id, entry] as const))(
    '%s is read the way the manifest records',
    async (_id, entry) => {
      const bytes = await bytesFor(entry);
      const source = sourceOver(bytes);
      const index = await readDocumentIndex(source, signal);

      expect(index.revisions).toBe(entry.revisions);

      if (entry.expectation === 'refuse') {
        await expect(resolvePages(source, index, signal)).rejects.toThrow(entry.refusal!);
        expect(entry.pageCount).toBeNull();
        return;
      }

      const pages = await resolvePages(source, index, signal);
      expect(pages).toHaveLength(entry.pageCount!);
    },
  );

  it.each(CORPUS.filter((entry) => entry.expectation === 'refuse')
    .map((entry) => [entry.id, entry] as const))(
    '%s cannot be signed at all',
    async (_id, entry) => {
      // The refusal has to reach the caller of the whole path, not only the page
      // walk. Without this the manifest could record a refusal that some later
      // step quietly recovers from.
      const bytes = await bytesFor(entry);

      await expect(stampSignature(bytes, 0, signal)).rejects.toThrow(entry.refusal!);
    },
  );

  it.each(CORPUS.filter((entry) => entry.expectation === 'accept')
    .map((entry) => [entry.id, entry] as const))(
    '%s carries the marks the manifest describes',
    async (_id, entry) => {
      const marks = entry.marks!;
      const bytes = await bytesFor(entry);

      const stamped = await stampSignature(bytes, marks.pageIndex, signal);
      const { pages } = await reopen(stamped.composed, signal);
      const page = pages[marks.pageIndex];

      // The name the appearance took. On a page that already uses the first
      // choice this has to be the NEXT one, which is the difference between
      // adding a signature and overwriting a resource.
      expect(stamped.resourceName).toBe(marks.stampResourceName);
      expect(contentsShape(page)).toEqual(marks.contentsAfter);

      const xobjects = page.resources?.entries.get('XObject');
      if (!xobjects || typeof xobjects !== 'object' || xobjects.kind !== 'dict') {
        throw new Error(`Page ${marks.pageIndex} of ${entry.id} has no /XObject dictionary.`);
      }
      expect([...xobjects.entries.keys()]).toContain(marks.stampResourceName);

      // The page count is unchanged: stamping adds a mark, never a page.
      expect(pages).toHaveLength(entry.pageCount!);
      // And the base is still there byte for byte, which is what makes this an
      // incremental update rather than a rewrite.
      expect(stamped.composed.subarray(0, bytes.length).equals(bytes)).toBe(true);
      expect(stamped.composed.length).toBeGreaterThan(bytes.length);
    },
  );
});

/**
 * The scanned page, which is the document this engine was built for.
 *
 * A scanned contract is one enormous image per page and nothing else. Two
 * things have to be true about it, and neither is implied by the document
 * parsing: the image has to BE an image, and stamping must not touch it.
 */
describe('a page that is only a scanned image', () => {
  const entry = CORPUS.find((fixture) => fixture.id === 'scannedJpegPage')!;

  it('embeds a JPEG that a real decoder decodes', () => {
    // Filler bytes wearing a `/DCTDecode` filter would satisfy every structural
    // assertion in this file. Then the corpus would claim to cover scanned
    // documents while covering none, which is worse than not claiming it.
    const jpeg = require('jpeg-js');

    const decoded = jpeg.decode(scannedJpegBytes());

    expect({ width: decoded.width, height: decoded.height }).toEqual(SCANNED_JPEG_SIZE);
    // A decoder that returned a uniform field would mean the raster is flat and
    // proves nothing about the pixels surviving. This one is a checkerboard.
    const samples = new Set<number>();
    for (let i = 0; i < decoded.data.length; i += 4) samples.add(decoded.data[i]);
    expect(samples.size).toBeGreaterThan(1);
  });

  it('leaves every byte of the image alone when it stamps the page', async () => {
    const bytes = await bytesFor(entry);
    const image = scannedJpegBytes();
    expect(bytes.indexOf(image)).toBeGreaterThan(0);

    const stamped = await stampSignature(bytes, 0, signal);

    // Binary image data contains sequences that look like PDF syntax, which is
    // what a writer that rewrites objects gets wrong. The image must appear
    // exactly once and unchanged in the composed document.
    const at = stamped.composed.indexOf(image);
    expect(at).toBeGreaterThan(0);
    expect(stamped.composed.indexOf(image, at + 1)).toBe(-1);
    expect(stamped.composed.subarray(at, at + image.length).equals(image)).toBe(true);
  });

  it('places the mark without disturbing the image resource', async () => {
    const bytes = await bytesFor(entry);

    const stamped = await stampSignature(bytes, 0, signal);
    const { pages } = await reopen(stamped.composed, signal);
    const xobjects = pages[0].resources?.entries.get('XObject');

    // The scan's own resource name has to survive beside the new one. Losing it
    // leaves a page whose content stream draws an XObject that is not there.
    if (!xobjects || typeof xobjects !== 'object' || xobjects.kind !== 'dict') {
      throw new Error('The stamped scanned page has no /XObject dictionary.');
    }
    expect([...xobjects.entries.keys()].sort()).toEqual(['Im0', 'ParalegixSig0']);
  });
});

/**
 * The page that still has a form on it.
 *
 * Stamping is not flattening. A document can reach the stamp with an interactive
 * form still in it, and the two structures a careless writer destroys are the
 * page's `/Annots` and the catalog's `/AcroForm`. Neither loss shows up as an
 * error: the document opens, the pages are all there, and the fields are simply
 * gone.
 */
describe('a page that still carries a form', () => {
  const entry = CORPUS.find((fixture) => fixture.id === 'formAppearances')!;
  /** The widget's object number in the fixture, which both structures name. */
  const WIDGET_OBJECT = 6;

  it('keeps the widget on the page it stamps', async () => {
    const bytes = await bytesFor(entry);

    const stamped = await stampSignature(bytes, 0, signal);
    const { pages } = await reopen(stamped.composed, signal);
    const annots: any = pages[0].dictionary.entries.get('Annots');

    // The appended page dictionary carries `/Annots` forward, still naming the
    // widget object. Dropping it takes every field on the page with it, and the
    // document still opens.
    expect(annots?.kind).toBe('array');
    expect(annots.values.map((value: any) => value?.value?.objectNumber)).toEqual([WIDGET_OBJECT]);
  });

  it('leaves the catalog form alone', async () => {
    const bytes = await bytesFor(entry);

    const stamped = await stampSignature(bytes, 0, signal);
    const { source, index } = await reopen(stamped.composed, signal);
    const rootRef: any = index.trailer.entries.get('Root');
    const catalog: any = await getObject(source, index, rootRef.value, signal);
    const acroForm: any = catalog.entries.get('AcroForm');

    // `/AcroForm` is an unrelated catalog structure, and the appended revision
    // REPLACES the catalog object. Rebuilding it from only the entries the
    // signature needed deletes every field in the document at once.
    expect(acroForm?.kind).toBe('dict');
    const fields: any = acroForm.entries.get('Fields');
    expect(fields.values.map((value: any) => value?.value?.objectNumber)).toEqual([WIDGET_OBJECT]);
  });
});
