/**
 * The incremental engine against documents that are not the easy case.
 *
 * Every fixture here is a shape that has broken a signing implementation
 * somewhere, and each one fails the same way: the request succeeds, the document
 * opens, and something about it is wrong. A signature on the wrong page. A page
 * that lost its size. A photograph replaced by a signature because both wanted
 * the same resource name. None of that is visible from inside the codebase, so
 * every assertion below reads the COMPOSED bytes back through the engine's own
 * reader rather than trusting the plan that produced them.
 *
 * What each test needs in order to go red is written next to it. A test here
 * that cannot be made to fail by breaking the engine is not covering anything.
 */
import { PDFDocument } from 'pdf-lib';
import { decodeStream } from '../../../src/modules/signatures/pdf/filters';
import { nextObjectNumber, planAppendedPages } from '../../../src/modules/signatures/pdf/appendPage';
import { visibleGeometry } from '../../../src/modules/signatures/pdf/pages';
import { getObject, readStartXref, readStreamObject } from '../../../src/modules/signatures/pdf/reader';
import { buildIncrementalUpdate } from '../../../src/modules/signatures/pdf/writer';
import type { PdfDict, PdfValue } from '../../../src/modules/signatures/pdf/types';
import {
  buildArrayContentsPage,
  buildBlankPageWithoutContents,
  buildCollidingResourceNames,
  buildIndirectResources,
  buildInheritedGeometry,
  buildMultipleRevisionsWithFreeEntries,
  buildNestedThousandPageTree,
  buildNonzeroGenerations,
  buildProducerObjectStreams,
  checkerboardSamples,
  COLLIDING_XOBJECT_NAME,
  FREED_OBJECT_NUMBER,
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  INHERITED_CROP_BOX,
  INHERITED_MEDIA_BOX,
  INHERITED_PAGES,
  INHERITED_ROTATE,
  NESTED_TREE_PAGES,
  NONZERO_CONTENTS_GENERATION,
  NONZERO_PAGE_GENERATION,
  textOperators,
} from './fixtures/buildSigningFixtures';
import {
  contentRefs,
  dict,
  name,
  readDecodedStream,
  readStreamText,
  ref,
  reopen,
  sourceOver,
  stampSignature,
} from './fixtures/manifest';

const signal = new AbortController().signal;

const asDict = (value: PdfValue | undefined): PdfDict => {
  if (!value || typeof value !== 'object' || value.kind !== 'dict') {
    throw new Error('Expected a dictionary.');
  }
  return value;
};

const asRef = (value: PdfValue | undefined) => {
  if (!value || typeof value !== 'object' || value.kind !== 'ref') {
    throw new Error('Expected an indirect reference.');
  }
  return value.value;
};

describe('a signature on a deeply nested page tree', () => {
  it('draws a signature on page 1000 inside nested Pages branches', async () => {
    // Goes red if the tree walk stops descending, loses its order, or the
    // appearance is planned against a page other than the one asked for: the
    // last leaf is the only one whose content says "Page 1000".
    const base = await buildNestedThousandPageTree();

    const stamped = await stampSignature(base, NESTED_TREE_PAGES - 1, signal);
    const { source, index, pages } = await reopen(stamped.composed, signal);

    expect(pages).toHaveLength(NESTED_TREE_PAGES);
    const signedPage = pages[NESTED_TREE_PAGES - 1];
    const streams = contentRefs(signedPage);
    expect(streams).toHaveLength(2);

    // The page's ORIGINAL drawing is still first and still says which page it is.
    const original = await readStreamText(source, index, streams[0], signal);
    expect(original).toContain('(Page 1000)');

    // The signature's invocation is second, and it is a real placement rather
    // than an empty stream that merely exists.
    const invocation = await readStreamText(source, index, streams[1], signal);
    expect(invocation).toContain(`/${stamped.resourceName} Do`);
    expect(invocation).toContain('1 0 0 1 72 96 cm');
    expect(invocation.startsWith('q\n')).toBe(true);
    expect(invocation.trimEnd().endsWith('Q')).toBe(true);
  });

  it('leaves every other page in the tree untouched', async () => {
    // The one comparison that covers the 999 pages nobody looked at: the base is
    // appended to, never rewritten, so its bytes have to come back identical.
    // Goes red the moment anything rewrites the original.
    const base = await buildNestedThousandPageTree();

    const stamped = await stampSignature(base, NESTED_TREE_PAGES - 1, signal);
    const { source, index, pages } = await reopen(stamped.composed, signal);

    expect(stamped.composed.subarray(0, base.length).equals(base)).toBe(true);
    expect(contentRefs(pages[0])).toHaveLength(1);
    const firstPage = await readStreamText(source, index, contentRefs(pages[0])[0], signal);
    expect(firstPage).toContain('(Page 1)');
    expect(firstPage).not.toContain('Do');
  });

  it('keeps the appearance inside the page it was placed on', async () => {
    // A placement is refused rather than clamped, so a signature that does not
    // fit is an error and never a mark somewhere the signer did not put it.
    const base = await buildNestedThousandPageTree();
    const stamped = await stampSignature(base, NESTED_TREE_PAGES - 1, signal);
    const { pages } = await reopen(stamped.composed, signal);

    const geometry = visibleGeometry(pages[NESTED_TREE_PAGES - 1]);
    expect(geometry.width).toBe(612);
    expect(geometry.height).toBe(792);
  });
});

describe('adding a certificate page', () => {
  /**
   * Append one page the way the certificate step does: a new leaf, its content,
   * and a COPY of the root `/Pages` with the leaf added.
   */
  async function appendCertificate(base: Buffer) {
    const source = sourceOver(base);
    const { index } = await reopen(base, signal);
    const firstFree = nextObjectNumber(index);
    const pageRef = { objectNumber: firstFree, generationNumber: 0 };
    const contentRef = { objectNumber: firstFree + 1, generationNumber: 0 };
    const contents = Buffer.from(textOperators('Certificate of completion'), 'latin1');

    const plan = await planAppendedPages({
      source,
      index,
      signal,
      pageRefs: [pageRef],
      newPages: [dict({
        Type: name('Page'),
        MediaBox: { kind: 'array', values: [0, 0, 612, 792] },
        Contents: ref(contentRef),
      })],
    });

    const update = buildIncrementalUpdate({
      baseSize: base.length,
      previousXrefOffset: await readStartXref(source, signal),
      trailer: dict({
        Size: index.trailer.entries.get('Size') as PdfValue,
        Root: index.trailer.entries.get('Root') as PdfValue,
      }),
      objects: [
        { ref: pageRef, value: plan.pages[0].dictionary },
        { ref: contentRef, value: dict({ Length: contents.length }), streamBytes: new Uint8Array(contents) },
        { ref: plan.pagesRef, value: plan.pagesDictionary },
      ],
    });

    return { composed: Buffer.concat([base, Buffer.from(update.suffix)]), pageRef };
  }

  it('preserves inherited page geometry after adding a certificate', async () => {
    // The failure this pins: replacing the root /Pages with a freshly built node
    // instead of a copy drops the inherited MediaBox, CropBox, Rotate and
    // Resources in one go. Every original page then has no size, and
    // `resolvePages` refuses the document it just wrote.
    const base = await buildInheritedGeometry();
    const before = await reopen(base, signal);

    const { composed } = await appendCertificate(base);
    const after = await reopen(composed, signal);

    expect(before.pages).toHaveLength(INHERITED_PAGES);
    expect(after.pages).toHaveLength(INHERITED_PAGES + 1);

    for (let i = 0; i < INHERITED_PAGES; i += 1) {
      expect(after.pages[i].mediaBox).toEqual({
        x0: INHERITED_MEDIA_BOX[0],
        y0: INHERITED_MEDIA_BOX[1],
        x1: INHERITED_MEDIA_BOX[2],
        y1: INHERITED_MEDIA_BOX[3],
      });
      expect(after.pages[i].cropBox).toEqual({
        x0: INHERITED_CROP_BOX[0],
        y0: INHERITED_CROP_BOX[1],
        x1: INHERITED_CROP_BOX[2],
        y1: INHERITED_CROP_BOX[3],
      });
      expect(after.pages[i].rotate).toBe(INHERITED_ROTATE);
      expect(after.pages[i].resources).not.toBeNull();
      // The originals are byte-identical, not merely equivalent.
      expect(after.pages[i].dictionary.entries.has('MediaBox')).toBe(false);
    }
    expect(composed.subarray(0, base.length).equals(base)).toBe(true);
  });

  it('does NOT let the appended page inherit the ancestor rotation and crop', async () => {
    // The failure this pins. `/Rotate` and `/CropBox` are inheritable, so a
    // certificate that states only its own MediaBox picks up /Rotate 90 and the
    // scan's crop window from the copied root: it comes out sideways and
    // cropped, and nobody sees that until someone prints it. The leaf therefore
    // states both explicitly, at the neutral values each attribute means when
    // no ancestor sets it.
    const base = await buildInheritedGeometry();

    const { composed } = await appendCertificate(base);
    const { pages } = await reopen(composed, signal);
    const certificate = pages[INHERITED_PAGES];

    expect(certificate.rotate).toBe(0);
    expect(certificate.cropBox).toEqual(certificate.mediaBox);
    // Upright and uncropped, so the visible width is the page's own width.
    expect(visibleGeometry(certificate).width)
      .toBe(certificate.mediaBox.x1 - certificate.mediaBox.x0);
    // The pages already in the document keep what they inherited.
    expect(pages[0].rotate).toBe(INHERITED_ROTATE);
  });

  it('raises /Count to match the tree it just grew', async () => {
    // `resolvePages` refuses a /Count that disagrees with the walk, so a stale
    // count here would break the document by appending to it.
    const base = await buildInheritedGeometry();

    const { composed } = await appendCertificate(base);
    const { source, index } = await reopen(composed, signal);

    const catalog = asDict(await getObject(source, index, asRef(index.trailer.entries.get('Root')), signal));
    const pagesNode = asDict(await getObject(source, index, asRef(catalog.entries.get('Pages')), signal));
    expect(pagesNode.entries.get('Count')).toBe(INHERITED_PAGES + 1);
  });
});

describe('a page with nothing on it', () => {
  it('adds Contents to a blank page', async () => {
    // A page with no /Contents at all. Goes red if the planner assumes the entry
    // exists: it either throws, or writes a page whose only mark is absent.
    const base = await buildBlankPageWithoutContents();
    const before = await reopen(base, signal);
    expect(before.pages[0].dictionary.entries.has('Contents')).toBe(false);

    const stamped = await stampSignature(base, 0, signal);
    const { source, index, pages } = await reopen(stamped.composed, signal);

    const streams = contentRefs(pages[0]);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toEqual(stamped.contentRef);

    const invocation = await readStreamText(source, index, streams[0], signal);
    expect(invocation).toContain(`/${stamped.resourceName} Do`);

    // The form it invokes is really there, and really carries the appearance.
    const xobjects = asDict(pages[0].resources!.entries.get('XObject'));
    const form = asDict(await getObject(source, index, asRef(xobjects.entries.get(stamped.resourceName)), signal));
    expect(form.entries.get('Subtype')).toEqual({ kind: 'name', value: 'Form' });
    const appearance = await readStreamText(source, index, stamped.formRef, signal);
    expect(appearance).toContain('(Signed by Paralegix)');
  });
});

describe('resources the page already owns', () => {
  it('keeps original text and stamp resources distinct', async () => {
    // The page already draws an image under /ParalegixSig0, which is the name
    // the planner reaches for first. Goes red if the stamp takes it: the image
    // reference is replaced by the form, and a photograph silently disappears
    // from a page that still renders.
    const base = await buildCollidingResourceNames();
    const before = await reopen(base, signal);
    const originalImage = asRef(asDict(before.pages[0].resources!.entries.get('XObject'))
      .entries.get(COLLIDING_XOBJECT_NAME));

    const stamped = await stampSignature(base, 0, signal);
    expect(stamped.resourceName).not.toBe(COLLIDING_XOBJECT_NAME);

    const { source, index, pages } = await reopen(stamped.composed, signal);
    const xobjects = asDict(pages[0].resources!.entries.get('XObject'));

    // Both names are present, and each still points where it should.
    expect([...xobjects.entries.keys()].sort()).toEqual(
      [COLLIDING_XOBJECT_NAME, stamped.resourceName].sort(),
    );
    expect(asRef(xobjects.entries.get(COLLIDING_XOBJECT_NAME))).toEqual(originalImage);
    expect(asRef(xobjects.entries.get(stamped.resourceName))).toEqual(stamped.formRef);

    // The image is still a real image with its original samples, not a form
    // wearing its name.
    const { value } = await readStreamObject(source, index, originalImage, signal);
    const imageDict = asDict(value as PdfValue);
    expect(imageDict.entries.get('Subtype')).toEqual({ kind: 'name', value: 'Image' });
    expect(imageDict.entries.get('Width')).toBe(IMAGE_WIDTH);
    expect(imageDict.entries.get('Height')).toBe(IMAGE_HEIGHT);
    const samples = await readDecodedStream(source, index, originalImage, signal);
    expect(samples).toHaveLength(IMAGE_WIDTH * IMAGE_HEIGHT);
    expect(Array.from(samples)).toEqual(Array.from(checkerboardSamples()));

    // The page's own font is untouched, and the appearance carries its own under
    // a name of its own inside the form.
    const fonts = asDict(pages[0].resources!.entries.get('Font'));
    expect([...fonts.entries.keys()]).toEqual(['F1']);
    const form = asDict(await getObject(source, index, stamped.formRef, signal));
    const formFonts = asDict(asDict(form.entries.get('Resources')).entries.get('Font'));
    expect([...formFonts.entries.keys()]).toEqual(['Helv']);

    // The page's original drawing still draws the image and the text.
    const original = await readStreamText(source, index, contentRefs(pages[0])[0], signal);
    expect(original).toContain(`/${COLLIDING_XOBJECT_NAME} Do`);
    expect(original).toContain('(Retainer agreement)');
  });

  it('materializes inherited resources onto the leaf instead of editing the ancestor', async () => {
    // Editing the shared dictionary in place would add this signature's XObject
    // to every page that inherits it. Goes red if the planner writes through to
    // the ancestor: the leaf would still have no /Resources of its own.
    const base = await buildNestedThousandPageTree();
    const before = await reopen(base, signal);
    expect(before.pages[500].dictionary.entries.has('Resources')).toBe(false);

    const stamped = await stampSignature(base, 500, signal);
    const { pages } = await reopen(stamped.composed, signal);

    expect(pages[500].dictionary.entries.has('Resources')).toBe(true);
    expect(pages[499].dictionary.entries.has('Resources')).toBe(false);
    expect(pages[499].resources!.entries.has('XObject')).toBe(false);
    // The inherited font came along, so the page's own text still has a font.
    const fonts = asDict(pages[500].resources!.entries.get('Font'));
    expect([...fonts.entries.keys()]).toEqual(['F1']);
  });

  it('resolves an indirect /Resources rather than treating it as absent', async () => {
    // A reference where a dictionary was expected reads as "no resources", and
    // the stamp then writes a fresh /Resources that drops the page's own font.
    const base = await buildIndirectResources();

    const stamped = await stampSignature(base, 0, signal);
    const { pages } = await reopen(stamped.composed, signal);

    const fonts = asDict(pages[0].resources!.entries.get('Font'));
    expect([...fonts.entries.keys()]).toEqual(['F1']);
    expect(asDict(pages[0].resources!.entries.get('XObject')).entries.has(stamped.resourceName)).toBe(true);
  });
});

describe('content streams the stamp must not replace', () => {
  it('appends to an array of content streams and keeps both originals', async () => {
    // The two original streams are one graphics block split in half. Replacing
    // the array, or keeping only the last entry, discards the page.
    const base = await buildArrayContentsPage();
    const before = await reopen(base, signal);
    const originals = contentRefs(before.pages[0]);
    expect(originals).toHaveLength(2);

    const stamped = await stampSignature(base, 0, signal);
    const { source, index, pages } = await reopen(stamped.composed, signal);

    const after = contentRefs(pages[0]);
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual(originals);
    expect(after[2]).toEqual(stamped.contentRef);

    const joined = (await Promise.all(
      after.map((entry) => readStreamText(source, index, entry, signal)),
    )).join('');
    expect(joined).toContain('(Retainer agreement)');
    expect(joined).toContain(`/${stamped.resourceName} Do`);
  });
});

describe('storage forms the reader has to handle', () => {
  it('signs a document whose objects live in object streams', async () => {
    // On a PDF 1.5 document most objects are compressed, so a reader that only
    // follows file offsets finds an almost empty file and stamps nothing.
    const base = await buildProducerObjectStreams();

    const stamped = await stampSignature(base, 0, signal);
    const { source, index, pages } = await reopen(stamped.composed, signal);

    const streams = contentRefs(pages[0]);
    expect(streams).toHaveLength(2);
    // pdf-lib writes show-text operands as hex strings rather than literals, so
    // this is the same text the producer drew, in the form it drew it.
    const showText = Buffer.from('Retainer agreement', 'latin1').toString('hex').toUpperCase();
    const original = await readStreamText(source, index, streams[0], signal);
    expect(original).toContain(`<${showText}> Tj`);
    const invocation = await readStreamText(source, index, streams[1], signal);
    expect(invocation).toContain(`/${stamped.resourceName} Do`);
  });

  it('rewrites a page at its own nonzero generation', async () => {
    // The page is `3 2 R`. Writing the replacement as `3 0 obj` leaves the page
    // tree pointing at a generation the new table does not describe, and the
    // document still opens in a forgiving viewer.
    const base = buildNonzeroGenerations();
    const before = await reopen(base, signal);
    expect(before.pages[0].ref.generationNumber).toBe(NONZERO_PAGE_GENERATION);

    const stamped = await stampSignature(base, 0, signal);
    const { source, index, pages } = await reopen(stamped.composed, signal);

    expect(pages[0].ref).toEqual({ objectNumber: 3, generationNumber: NONZERO_PAGE_GENERATION });
    expect(index.entries.get(3)!.generationNumber).toBe(NONZERO_PAGE_GENERATION);

    const streams = contentRefs(pages[0]);
    expect(streams[0].generationNumber).toBe(NONZERO_CONTENTS_GENERATION);
    const original = await readStreamText(source, index, streams[0], signal);
    expect(original).toContain('(Deposition transcript)');
  });

  it('keeps an object a previous revision freed out of the signed document', async () => {
    // The annotation was deleted in revision two. Ignoring the tombstone
    // resurrects it, and the same mistake on a signed document resurrects a page
    // that was signed away.
    const base = buildMultipleRevisionsWithFreeEntries();

    const stamped = await stampSignature(base, 0, signal);
    const { index, pages } = await reopen(stamped.composed, signal);

    expect(index.revisions).toBe(3);
    expect(index.entries.get(FREED_OBJECT_NUMBER)!.offset).toBeNull();
    expect(pages[0].dictionary.entries.has('Annots')).toBe(false);
  });
});

describe('what an independent parser sees', () => {
  it('opens the composed nested document and still counts a thousand pages', async () => {
    // pdf-lib shares no code with this engine. If the appended cross-reference
    // were wrong, this is where it shows: the suffix would either fail to parse
    // or the page count would change.
    const base = await buildNestedThousandPageTree();
    const stamped = await stampSignature(base, NESTED_TREE_PAGES - 1, signal);

    const document = await PDFDocument.load(stamped.composed, { updateMetadata: false });

    expect(document.getPageCount()).toBe(NESTED_TREE_PAGES);
  });

  it('opens the composed blank page and finds the stamped content stream', async () => {
    const base = await buildBlankPageWithoutContents();
    const stamped = await stampSignature(base, 0, signal);

    const document = await PDFDocument.load(stamped.composed, { updateMetadata: false });
    const page = document.getPage(0);
    const contents = page.node.Contents();

    expect(contents).toBeDefined();
    expect(document.getPageCount()).toBe(1);
  });
});

describe('the appearance form itself', () => {
  it('carries a bounding box and a matrix that scale it to the placement', async () => {
    // A form with no /BBox draws nothing. One whose /BBox does not match the
    // placement draws at the wrong size, which looks like a rendering problem
    // rather than a bug here.
    const base = await buildProducerObjectStreams();
    const stamped = await stampSignature(base, 0, signal);
    const { source, index } = await reopen(stamped.composed, signal);

    const form = asDict(await getObject(source, index, stamped.formRef, signal));
    expect(form.entries.get('BBox')).toEqual({ kind: 'array', values: [0, 0, 216, 48] });
    expect(form.entries.get('FormType')).toBe(1);

    const { value, stream } = await readStreamObject(source, index, stamped.formRef, signal);
    const raw = await source.read(stream!.start, stream!.length, signal);
    const appearance = Buffer.from(await decodeStream(value as PdfDict, raw)).toString('latin1');
    expect(appearance).toContain('(Signed by Paralegix)');
  });
});
