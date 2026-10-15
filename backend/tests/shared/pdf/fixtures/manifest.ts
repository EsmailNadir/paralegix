/**
 * The corpus manifest: what each fixture IS, and what the engine is supposed to
 * do with it.
 *
 * The point of writing this down rather than deriving it is that a derived
 * expectation cannot fail. If the manifest asked the builder how many bytes it
 * produced, a builder that started emitting something else would still agree
 * with itself. So every field here is a claim recorded independently: the byte
 * length, the SHA-256, the page count, whether the engine accepts or refuses the
 * document, and the marks a signature leaves on it. `signingCorpus.test.ts`
 * checks all of them, and a builder that quietly changes what it emits turns
 * that suite red.
 *
 * This module also owns the ONE way a fixture is driven through the engine
 * (`stampSignature`). Both suites here need it, and two copies of a driver is
 * how two suites end up asserting subtly different things about the same code.
 */
import { decodeStream } from '../../../../src/modules/signatures/pdf/filters';
import { nextObjectNumber } from '../../../../src/modules/signatures/pdf/appendPage';
import { planAppearance, type Placement } from '../../../../src/modules/signatures/pdf/appearances';
import { resolvePages, type ResolvedPage } from '../../../../src/modules/signatures/pdf/pages';
import {
  readDocumentIndex,
  readStartXref,
  readStreamObject,
  type PdfDocumentIndex,
} from '../../../../src/modules/signatures/pdf/reader';
import {
  buildIncrementalUpdate,
  withEntries,
  type IncrementalUpdate,
} from '../../../../src/modules/signatures/pdf/writer';
import type { PdfDict, PdfRef, PdfSource, PdfValue } from '../../../../src/modules/signatures/pdf/types';
import {
  buildArrayContentsPage,
  buildBlankPageWithoutContents,
  buildCollidingResourceNames,
  buildHybridXref,
  buildIndirectResources,
  buildInheritedGeometry,
  buildMissingMediaBox,
  buildFormAppearances,
  buildScannedJpegPage,
  buildMultipleRevisionsWithFreeEntries,
  buildNestedThousandPageTree,
  buildNonzeroGenerations,
  buildProducerClassicXref,
  buildProducerObjectStreams,
  COLLIDING_XOBJECT_NAME,
  NESTED_TREE_PAGES,
} from './buildSigningFixtures';

/** What `/Contents` looks like on the stamped page once the update is composed. */
export type ContentsShape =
  | { kind: 'ref' }
  | { kind: 'array'; length: number };

/** The marks a signature is supposed to leave on a fixture. */
export interface ExpectedMarks {
  /** Zero-based page the corpus stamps. */
  pageIndex: number;
  /**
   * The XObject resource name the appearance must take.
   *
   * Not always `ParalegixSig0`: a page that already uses that name must push the
   * stamp onto the next one instead of overwriting what is there.
   */
  stampResourceName: string;
  contentsAfter: ContentsShape;
}

export interface CorpusFixture {
  id: string;
  /** What produced the bytes, which is what makes the corpus more than one shape. */
  producer: string;
  /** Why this document is in the corpus. */
  about: string;
  /** Pages the engine must find. Null when the engine refuses the document. */
  pageCount: number | null;
  /** Cross-reference sections in the `/Prev` chain. */
  revisions: number;
  byteLength: number;
  sha256: string;
  expectation: 'accept' | 'refuse';
  /** The message the engine refuses with, or null when it accepts. */
  refusal: string | null;
  marks: ExpectedMarks | null;
  /**
   * Whether pdf-lib, which shares no code with this engine, parses the fixture.
   *
   * A refusal has to be THIS engine's decision about a valid document, not a
   * fixture that is simply broken.
   */
  parsesInPdfLib: boolean;
  build(): Promise<Buffer>;
}

/** Where every stamped signature goes. Inside the visible area of every fixture. */
const CORPUS_PLACEMENT: Placement = { x: 72, y: 96, width: 216, height: 48 };

/** The appearance's own size, in its own coordinates. */
const CORPUS_BBOX = { width: 216, height: 48 };

/** The Form XObject's content stream. Its own font, its own coordinate system. */
const CORPUS_APPEARANCE =
  'q 0.2 w 0 0 216 48 re S BT /Helv 10 Tf 6 18 Td (Signed by Paralegix) Tj ET Q\n';

export const CORPUS: CorpusFixture[] = [
  {
    id: 'producerClassicXref',
    producer: 'pdf-lib PDFDocument, classic xref table',
    about: 'What an ordinary pre-1.5 producer emits: one text page, a plain xref table.',
    pageCount: 1,
    revisions: 1,
    byteLength: 1128,
    sha256: 'a7595931343a3cf8fa5c3fc64ed923b792a37aa47d13b1fae9e0e0c6ac8bb08b',
    expectation: 'accept',
    refusal: null,
    marks: { pageIndex: 0, stampResourceName: 'ParalegixSig0', contentsAfter: { kind: 'array', length: 2 } },
    parsesInPdfLib: true,
    build: buildProducerClassicXref,
  },
  {
    id: 'producerObjectStreams',
    producer: 'pdf-lib PDFDocument, xref stream and object streams',
    about: 'The same document stored the PDF 1.5 way, where most objects are compressed.',
    pageCount: 1,
    revisions: 1,
    byteLength: 838,
    sha256: 'e3bcd795740009bcfaa63e32f633f186132b71191821cc282694294c5099f359',
    expectation: 'accept',
    refusal: null,
    marks: { pageIndex: 0, stampResourceName: 'ParalegixSig0', contentsAfter: { kind: 'array', length: 2 } },
    parsesInPdfLib: true,
    build: buildProducerObjectStreams,
  },
  {
    id: 'arrayContentsPage',
    producer: 'pdf-lib PDFContext',
    about: 'A page whose /Contents is an array of two streams that form one graphics block.',
    pageCount: 1,
    revisions: 1,
    byteLength: 738,
    sha256: '9d4e628dbc1348743a4abb01bae5185c4a1a7364d3d5bd02ac464991b7520762',
    expectation: 'accept',
    refusal: null,
    marks: { pageIndex: 0, stampResourceName: 'ParalegixSig0', contentsAfter: { kind: 'array', length: 3 } },
    parsesInPdfLib: true,
    build: buildArrayContentsPage,
  },
  {
    id: 'blankPageWithoutContents',
    producer: 'pdf-lib PDFContext',
    about: 'A page with no /Contents at all, which is what a separator sheet looks like.',
    pageCount: 1,
    revisions: 1,
    byteLength: 344,
    sha256: 'fd56936b760949c4a3ea4534f222c970a6362bc7c4e07bb8e5a74cdc7755f59f',
    expectation: 'accept',
    refusal: null,
    marks: { pageIndex: 0, stampResourceName: 'ParalegixSig0', contentsAfter: { kind: 'ref' } },
    parsesInPdfLib: true,
    build: buildBlankPageWithoutContents,
  },
  {
    id: 'nestedThousandPageTree',
    producer: 'pdf-lib PDFContext',
    about: 'A thousand pages under real intermediate nodes, geometry stated only at the root.',
    pageCount: NESTED_TREE_PAGES,
    revisions: 1,
    byteLength: 223416,
    sha256: 'f903ee1b08ec51347fe418a9f8c5a2eb349319e70581bbabf9018e3760497916',
    expectation: 'accept',
    refusal: null,
    marks: {
      pageIndex: NESTED_TREE_PAGES - 1,
      stampResourceName: 'ParalegixSig0',
      contentsAfter: { kind: 'array', length: 2 },
    },
    parsesInPdfLib: true,
    build: buildNestedThousandPageTree,
  },
  {
    id: 'inheritedGeometry',
    producer: 'pdf-lib PDFContext',
    about: 'MediaBox, CropBox, Rotate and Resources on the ancestor only; the leaves state nothing.',
    pageCount: 3,
    revisions: 1,
    byteLength: 1073,
    sha256: 'ffc1c030c16265624395a26e30905e199aeeb897bbb2eff3fea9da25e66d4186',
    expectation: 'accept',
    refusal: null,
    marks: { pageIndex: 0, stampResourceName: 'ParalegixSig0', contentsAfter: { kind: 'array', length: 2 } },
    parsesInPdfLib: true,
    build: buildInheritedGeometry,
  },
  {
    id: 'indirectResources',
    producer: 'pdf-lib PDFContext',
    about: 'The page /Resources is an indirect object rather than a nested dictionary.',
    pageCount: 1,
    revisions: 1,
    byteLength: 679,
    sha256: '90dcb2af64073ee61df881270928e72ad7b12b21163660a77af087489a67063f',
    expectation: 'accept',
    refusal: null,
    marks: { pageIndex: 0, stampResourceName: 'ParalegixSig0', contentsAfter: { kind: 'array', length: 2 } },
    parsesInPdfLib: true,
    build: buildIndirectResources,
  },
  {
    id: 'collidingResourceNames',
    producer: 'pdf-lib PDFContext',
    about: `The page already draws an image called /${COLLIDING_XOBJECT_NAME}, the stamp's first choice.`,
    pageCount: 1,
    revisions: 1,
    byteLength: 945,
    sha256: '2aff5447ddfeaf2f59f94ba9083e465504d4f44b47e66b88cbc83a4f3b9f2112',
    expectation: 'accept',
    refusal: null,
    marks: { pageIndex: 0, stampResourceName: 'ParalegixSig1', contentsAfter: { kind: 'array', length: 2 } },
    parsesInPdfLib: true,
    build: buildCollidingResourceNames,
  },
  {
    id: 'nonzeroGenerations',
    producer: 'hand-laid bytes',
    about: 'The page is object 3 generation 2 and its content stream is object 4 generation 5.',
    pageCount: 1,
    revisions: 1,
    byteLength: 625,
    sha256: '430ad720400ee7059535ab5cbae3176d9ef1965dcb5a5d5be14295b422bd0cbf',
    expectation: 'accept',
    refusal: null,
    marks: { pageIndex: 0, stampResourceName: 'ParalegixSig0', contentsAfter: { kind: 'array', length: 2 } },
    parsesInPdfLib: true,
    build: async () => buildNonzeroGenerations(),
  },
  {
    id: 'multipleRevisionsWithFreeEntries',
    producer: 'hand-laid bytes',
    about: 'Two revisions, the second of which rewrites the page and frees its annotation.',
    pageCount: 1,
    revisions: 2,
    byteLength: 935,
    sha256: 'f8265e038f1568dd4d23a4fafddc468bb6a62ab325c4e4c979edf13018804f67',
    expectation: 'accept',
    refusal: null,
    marks: { pageIndex: 0, stampResourceName: 'ParalegixSig0', contentsAfter: { kind: 'array', length: 2 } },
    parsesInPdfLib: true,
    build: async () => buildMultipleRevisionsWithFreeEntries(),
  },
  {
    id: 'hybridXrefFullTable',
    producer: 'hand-laid bytes',
    about: 'A hybrid-reference file whose classic table still lists every object, so /XRefStm is redundant.',
    pageCount: 1,
    revisions: 1,
    byteLength: 803,
    sha256: 'c7f0ba775673a5f3a2014aef2847e19956a334b2146975d3c7e079e53edc53b3',
    expectation: 'accept',
    refusal: null,
    marks: { pageIndex: 0, stampResourceName: 'ParalegixSig0', contentsAfter: { kind: 'array', length: 2 } },
    parsesInPdfLib: true,
    build: async () => buildHybridXref({ pagesOnlyInStream: false }),
  },
  {
    id: 'hybridXrefPagesOnlyInStream',
    producer: 'hand-laid bytes',
    about:
      'The real hybrid shape: the page and its content are marked free in the classic table and '
      + 'described only by the /XRefStm section. A reader that ignores /XRefStm sees a document '
      + 'whose page was deleted and refuses bytes every other viewer opens.',
    pageCount: 1,
    revisions: 1,
    byteLength: 803,
    sha256: '93be9b83c87aaaead7bfba1281bb342925c8ea99ae1b8a3a6432c93ebe6498e1',
    expectation: 'accept',
    refusal: null,
    marks: { pageIndex: 0, stampResourceName: 'ParalegixSig0', contentsAfter: { kind: 'array', length: 2 } },
    parsesInPdfLib: true,
    build: async () => buildHybridXref({ pagesOnlyInStream: true }),
  },
  {
    id: 'formAppearances',
    producer: 'hand-laid bytes, filled form widget with a normal appearance',
    about: 'A page with /Annots and a catalog with /AcroForm. The stamp must leave '
      + 'both alone: a writer that rewrites the page dictionary deletes the form, '
      + 'and one that replaces the catalog deletes every field in the document.',
    pageCount: 1,
    revisions: 1,
    byteLength: 1090,
    sha256: 'd0ca4bec4f96609a0ddc105e35b9a3208101471c401cba7c1f23f713cceaa393',
    expectation: 'accept',
    refusal: null,
    marks: { pageIndex: 0, stampResourceName: 'ParalegixSig0', contentsAfter: { kind: 'array', length: 2 } },
    parsesInPdfLib: true,
    build: async () => buildFormAppearances(),
  },
  {
    id: 'scannedJpegPage',
    producer: 'hand-laid bytes, scanner conventions',
    about: 'A page that is only a scanned image: no text, one /DCTDecode XObject, '
      + 'and a content stream that does nothing but place it. The document the '
      + 'engine exists for, and the one where rewriting instead of appending would '
      + 'move every byte of the scan to draw a signature in one corner.',
    pageCount: 1,
    revisions: 1,
    byteLength: 1399,
    sha256: '8abdff3ea8559d5c8a11b23147faee68db1423ad9e8a0c0cb3d70dcf729def9c',
    expectation: 'accept',
    refusal: null,
    marks: { pageIndex: 0, stampResourceName: 'ParalegixSig0', contentsAfter: { kind: 'array', length: 2 } },
    parsesInPdfLib: true,
    build: async () => buildScannedJpegPage(),
  },
  {
    id: 'missingMediaBox',
    producer: 'pdf-lib PDFContext',
    about: 'No page size anywhere. Refused rather than defaulted, because a default is a guess.',
    pageCount: null,
    revisions: 1,
    byteLength: 448,
    sha256: '3ea59bd6b2ff1ed4dfcf3aea989746c9567243c75659da565a8c6f9b08a0af16',
    expectation: 'refuse',
    refusal: 'This page has no usable MediaBox.',
    marks: null,
    parsesInPdfLib: true,
    build: buildMissingMediaBox,
  },
];

// ---------------------------------------------------------------------------
// Driving a fixture through the engine.
// ---------------------------------------------------------------------------

/**
 * A bounded source over an in-memory document.
 *
 * The same contract `gcsSource` implements: windows only, and a read past the
 * end is an error rather than a short buffer, so a reader that miscalculates a
 * length fails here instead of quietly seeing zeros.
 */
export function sourceOver(bytes: Buffer, generation = '1'): PdfSource {
  return {
    ref: { objectPath: 'firm/corpus.pdf', generation, sizeBytes: bytes.length },
    async read(start, length) {
      if (start + length > bytes.length) throw new Error('read past the end');
      return new Uint8Array(bytes.subarray(start, start + length));
    },
    async *stream(start, endExclusive) {
      yield new Uint8Array(bytes.subarray(start, endExclusive));
    },
    async close() {},
  };
}

export const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });
export const name = (value: string): PdfValue => ({ kind: 'name', value });
export const ref = (target: PdfRef): PdfValue => ({ kind: 'ref', value: target });

export interface StampResult {
  index: PdfDocumentIndex;
  pages: ResolvedPage[];
  page: ResolvedPage;
  update: IncrementalUpdate;
  /** The name the appearance actually took on the page. */
  resourceName: string;
  formRef: PdfRef;
  contentRef: PdfRef;
  fontRef: PdfRef;
  /** Base plus suffix, which is what the storage service writes back. */
  composed: Buffer;
}

/**
 * Put one signature appearance on one page and compose the result.
 *
 * This is the whole path the corpus is about: read the index, walk to the page,
 * plan the appearance against that page's real geometry and resources, write an
 * incremental update, and append it. The base is never rewritten, which is why
 * the composed buffer starts with the fixture's own bytes unchanged.
 */
export async function stampSignature(
  bytes: Buffer,
  pageIndex: number,
  signal: AbortSignal,
): Promise<StampResult> {
  const source = sourceOver(bytes);
  const index = await readDocumentIndex(source, signal);
  const pages = await resolvePages(source, index, signal);
  const page = pages[pageIndex];
  if (!page) throw new Error(`This document has no page ${pageIndex}.`);

  const firstFree = nextObjectNumber(index);
  const formRef = { objectNumber: firstFree, generationNumber: 0 };
  const contentRef = { objectNumber: firstFree + 1, generationNumber: 0 };
  const fontRef = { objectNumber: firstFree + 2, generationNumber: 0 };

  const plan = planAppearance({
    page,
    placement: CORPUS_PLACEMENT,
    bbox: CORPUS_BBOX,
    // The appearance carries its OWN font under its own name. It is a
    // self-contained Form XObject, so this name cannot collide with the page's.
    appearanceResources: dict({ Font: dict({ Helv: ref(fontRef) }) }),
    formRef,
    contentRef,
  });

  const appearance = Buffer.from(CORPUS_APPEARANCE, 'latin1');
  const update = buildIncrementalUpdate({
    baseSize: bytes.length,
    previousXrefOffset: await readStartXref(source, signal),
    trailer: dict({
      Size: index.trailer.entries.get('Size') as PdfValue,
      Root: index.trailer.entries.get('Root') as PdfValue,
    }),
    objects: [
      {
        ref: formRef,
        value: withEntries(plan.formDictionary, { Length: appearance.length }),
        streamBytes: new Uint8Array(appearance),
      },
      {
        ref: contentRef,
        value: dict({ Length: plan.invocation.length }),
        streamBytes: plan.invocation,
      },
      {
        ref: fontRef,
        value: dict({
          Type: name('Font'),
          Subtype: name('Type1'),
          BaseFont: name('Helvetica'),
          Encoding: name('WinAnsiEncoding'),
        }),
      },
      // The page is REWRITTEN AT ITS OWN GENERATION. Writing the replacement at
      // generation 0 on a page that is generation 2 leaves the original
      // reference pointing at an object the new table does not describe.
      { ref: page.ref, value: plan.updatedPage },
    ],
  });

  return {
    index,
    pages,
    page,
    update,
    resourceName: plan.resourceName,
    formRef,
    contentRef,
    fontRef,
    composed: Buffer.concat([bytes, Buffer.from(update.suffix)]),
  };
}

/** The decoded payload of one stream object. */
export async function readDecodedStream(
  source: PdfSource,
  index: PdfDocumentIndex,
  target: PdfRef,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const { value, stream } = await readStreamObject(source, index, target, signal);
  if (!stream) throw new Error(`Object ${target.objectNumber} is not a stream.`);
  const raw = await source.read(stream.start, stream.length, signal);
  return decodeStream(value as PdfDict, raw);
}

/** The decoded payload of one stream object, as latin1 text. */
export async function readStreamText(
  source: PdfSource,
  index: PdfDocumentIndex,
  target: PdfRef,
  signal: AbortSignal,
): Promise<string> {
  return Buffer.from(await readDecodedStream(source, index, target, signal)).toString('latin1');
}

/** Every reference in a page's `/Contents`, whether it is one entry or an array. */
export function contentRefs(page: ResolvedPage): PdfRef[] {
  const contents = page.dictionary.entries.get('Contents');
  if (contents === undefined) return [];
  if (typeof contents === 'object' && contents !== null && contents.kind === 'array') {
    return contents.values.map((entry) => {
      if (typeof entry !== 'object' || entry === null || entry.kind !== 'ref') {
        throw new Error('A /Contents array holds something that is not a reference.');
      }
      return entry.value;
    });
  }
  if (typeof contents === 'object' && contents !== null && contents.kind === 'ref') {
    return [contents.value];
  }
  throw new Error('This page has a /Contents that is neither a reference nor an array.');
}

/** The shape of a page's `/Contents`, for comparison with what the manifest claims. */
export function contentsShape(page: ResolvedPage): ContentsShape {
  const contents = page.dictionary.entries.get('Contents');
  if (typeof contents === 'object' && contents !== null && contents.kind === 'array') {
    return { kind: 'array', length: contents.values.length };
  }
  return { kind: 'ref' };
}

/** Read a document back after composition, which is what a viewer would do. */
export async function reopen(composed: Buffer, signal: AbortSignal) {
  const source = sourceOver(composed);
  const index = await readDocumentIndex(source, signal);
  const pages = await resolvePages(source, index, signal);
  return { source, index, pages };
}
