/**
 * Adding a page to a document without rebuilding its page tree.
 *
 * A signing certificate goes on the end. Doing that with a normal PDF library
 * means loading the document, adding the page, and writing the whole thing out
 * again, which for a 2 GB scan is precisely what cannot happen.
 *
 * Incrementally it is three small objects: the new page, a replacement for the
 * root `/Pages` node with the new leaf in its `/Kids` and its `/Count` raised,
 * and the page's content. Everything else in the document is untouched.
 *
 * The care is all in the `/Pages` replacement. It has to be a COPY of the
 * original with two entries changed: `/Kids` and `/Count`. A freshly built node
 * loses whatever the original carried, and what a root `/Pages` most often
 * carries is the inherited `/MediaBox` and `/Resources` for every page under it.
 * Losing those makes every existing page sizeless, which the reader then
 * refuses. The document is broken by the act of appending to it.
 */
import { AppError } from '../../../shared/errors/AppError';
import { getObject, type PdfDocumentIndex } from './reader';
import type { PdfDict, PdfRef, PdfSource, PdfValue } from './types';
import { withEntries } from './writer';

export class PdfAppendError extends AppError {
  constructor(message: string) {
    super(message, 400, 'PDF_APPEND_ERROR');
  }
}

const isDict = (value: PdfValue | undefined): value is PdfDict =>
  !!value && typeof value === 'object' && (value as any).kind === 'dict';
const isRef = (value: PdfValue | undefined): value is Extract<PdfValue, { kind: 'ref' }> =>
  !!value && typeof value === 'object' && (value as any).kind === 'ref';
const ref = (r: PdfRef): PdfValue => ({ kind: 'ref', value: r });

export interface AppendedPagePlan {
  /** The replacement root `/Pages`, a copy with only Kids and Count changed. */
  pagesRef: PdfRef;
  pagesDictionary: PdfDict;
  /** The new leaf pages, in order. */
  pages: Array<{ ref: PdfRef; dictionary: PdfDict }>;
}

/**
 * Plan the objects that append pages to a document.
 *
 * `newPages` are leaf dictionaries WITHOUT `/Parent`, which is filled in here
 * because only this function knows what the parent will be.
 */
export async function planAppendedPages(options: {
  source: PdfSource;
  index: PdfDocumentIndex;
  signal: AbortSignal;
  /** Object numbers the new pages will be written as. */
  pageRefs: PdfRef[];
  newPages: PdfDict[];
}): Promise<AppendedPagePlan> {
  const { source, index, signal, pageRefs, newPages } = options;

  if (newPages.length === 0) throw new PdfAppendError('No pages to append.');
  if (pageRefs.length !== newPages.length) {
    throw new PdfAppendError('Every appended page needs its own object number.');
  }

  const rootRef = index.trailer.entries.get('Root');
  if (!isRef(rootRef)) throw new PdfAppendError('This document has no catalog reference.');
  const catalog = await getObject(source, index, rootRef.value, signal);
  if (!isDict(catalog)) throw new PdfAppendError('This document has no catalog.');

  const pagesRef = catalog.entries.get('Pages');
  if (!isRef(pagesRef)) {
    // A direct `/Pages` dictionary cannot be replaced by object number, so the
    // catalog would have to be rewritten too. Refused rather than half-handled.
    throw new PdfAppendError('This document\'s page tree is not an indirect object.');
  }
  const pagesNode = await getObject(source, index, pagesRef.value, signal);
  if (!isDict(pagesNode)) throw new PdfAppendError('This document\'s page tree is not a dictionary.');

  const kids = pagesNode.entries.get('Kids');
  if (!kids || typeof kids !== 'object' || (kids as any).kind !== 'array') {
    throw new PdfAppendError('The page tree root has no /Kids array.');
  }
  const count = pagesNode.entries.get('Count');
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new PdfAppendError('The page tree root has no usable /Count.');
  }

  // A COPY with two entries changed. Building a fresh node loses the inherited
  // /MediaBox and /Resources that every existing page depends on, which makes
  // them sizeless and breaks the document by the act of appending to it.
  const pagesDictionary = withEntries(pagesNode, {
    Kids: { kind: 'array', values: [...(kids as any).values, ...pageRefs.map(ref)] },
    Count: count + newPages.length,
  });

  const pages = newPages.map((dictionary, i) => ({
    ref: pageRefs[i],
    // `/Parent` is filled in here because only this function knows the parent.
    // A leaf without it is unreachable when a viewer walks UP from the page.
    dictionary: withEntries(dictionary, {
      Parent: ref(pagesRef.value),
      ...inheritedOverrides(pagesNode, dictionary),
    }),
  }));

  return { pagesRef: pagesRef.value, pagesDictionary, pages };
}

/**
 * The inheritable attributes an appended page has to state for itself.
 *
 * Four page attributes are inherited from the page tree: `/Resources`,
 * `/MediaBox`, `/CropBox` and `/Rotate`. The root that gets copied usually
 * carries them for the pages already beneath it, and a new leaf silently picks
 * them up. For a certificate page that is wrong in a way nobody sees until the
 * document is printed: appended to a rotated scan it comes out sideways, and
 * appended to a cropped one it is cropped to the scan's window, even though it
 * declared its own size.
 *
 * So a page that does not declare one of these gets an explicit neutral value
 * whenever the root declares one. `/Rotate 0` is upright and `/CropBox` equal to
 * the page's own `/MediaBox` is uncropped, which is what each attribute means
 * when nothing in the tree sets it. Nothing is added when the root sets nothing,
 * because then there is nothing to inherit and the entry would be noise.
 */
function inheritedOverrides(root: PdfDict, page: PdfDict): Record<string, PdfValue> {
  const overrides: Record<string, PdfValue> = {};
  if (root.entries.has('Rotate') && !page.entries.has('Rotate')) {
    overrides.Rotate = 0;
  }
  if (root.entries.has('CropBox') && !page.entries.has('CropBox')) {
    // The page's own size when it states one, and otherwise the size it is
    // about to inherit. Either way the crop covers the whole page, which is
    // what "uncropped" means.
    const mediaBox = page.entries.get('MediaBox') ?? root.entries.get('MediaBox');
    if (mediaBox) overrides.CropBox = mediaBox;
  }
  return overrides;
}

/**
 * The next free object number in a document.
 *
 * `/Size` is the document's own claim about how many objects it has. It is
 * checked against the highest number actually indexed, because a `/Size` that
 * is too low would have new objects overwrite existing ones.
 */
export function nextObjectNumber(index: PdfDocumentIndex): number {
  const declared = index.trailer.entries.get('Size');
  let highest = 0;
  for (const number of index.entries.keys()) highest = Math.max(highest, number);
  const fromSize = typeof declared === 'number' && Number.isSafeInteger(declared) ? declared : 0;
  return Math.max(fromSize, highest + 1);
}
