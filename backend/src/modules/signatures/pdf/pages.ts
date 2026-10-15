/**
 * Finding a page in a stored PDF, and working out its real geometry.
 *
 * A PDF's pages are a TREE, not a list. `/Pages` holds `/Kids`, each of which is
 * either a page or another node, and several attributes are inherited from
 * ancestors rather than repeated on every leaf. So "page 3" is a walk, and a
 * page's size may be stated three levels up.
 *
 * What this refuses, and why each matters:
 *
 * `/Count` IS A NAVIGATION AID, NOT A TRUTH. It says how many pages a subtree
 * holds, and a corrupt or hostile file can say anything. It is used to skip
 * subtrees quickly and then checked against what was actually found, so a wrong
 * count is an error rather than a silently short document.
 *
 * A VISITED SET bounds the walk. `/Kids` can point back at an ancestor, and a
 * tree that loops is an unbounded traversal the document controls.
 *
 * UNKNOWN GEOMETRY IS AN ERROR. Defaulting a missing `/MediaBox` to US Letter
 * puts a signature at coordinates that are right for a page that does not exist,
 * which lands it somewhere arbitrary on the real one and looks fine in the
 * response.
 */
import { AppError } from '../../../shared/errors/AppError';
import { getObject, type PdfDocumentIndex } from './reader';
import type { PdfDict, PdfRef, PdfSource, PdfValue } from './types';

/** Nodes the page tree may hold. A tree past this is refused, not truncated. */
export const MAX_PAGE_TREE_NODES = Number(process.env.PDF_MAX_PAGE_TREE_NODES) || 200_000;

export class PdfPageError extends AppError {
  constructor(message: string) {
    super(message, 400, 'PDF_PAGE_ERROR');
  }
}

/** A rectangle in PDF user space, normalized so lower <= upper. */
export interface PdfRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ResolvedPage {
  /** Zero-based index in the document. */
  index: number;
  ref: PdfRef;
  dictionary: PdfDict;
  /** The page's own box, after inheritance. */
  mediaBox: PdfRect;
  /** What a viewer actually shows. Defaults to MediaBox when absent. */
  cropBox: PdfRect;
  /** Normalized to 0, 90, 180 or 270. */
  rotate: number;
  /** Inherited resources, or null when the page genuinely has none. */
  resources: PdfDict | null;
  /** `/UserUnit`, which scales user space. 1 unless the page says otherwise. */
  userUnit: number;
}

const isDict = (value: PdfValue | undefined): value is PdfDict =>
  !!value && typeof value === 'object' && (value as any).kind === 'dict';

const isRef = (value: PdfValue | undefined): value is Extract<PdfValue, { kind: 'ref' }> =>
  !!value && typeof value === 'object' && (value as any).kind === 'ref';

const nameOf = (value: PdfValue | undefined): string | null =>
  (value && typeof value === 'object' && (value as any).kind === 'name')
    ? (value as any).value as string
    : null;

/** Follow one level of indirection, if there is one. */
async function deref(
  source: PdfSource,
  index: PdfDocumentIndex,
  value: PdfValue | undefined,
  signal: AbortSignal,
): Promise<PdfValue | undefined> {
  if (!isRef(value)) return value;
  return getObject(source, index, value.value, signal);
}

/** A `[x0 y0 x1 y1]` box, normalized. A malformed one is an error, never a default. */
async function readRect(
  source: PdfSource,
  index: PdfDocumentIndex,
  value: PdfValue | undefined,
  signal: AbortSignal,
  label: string,
): Promise<PdfRect> {
  const resolved = await deref(source, index, value, signal);
  if (!resolved || typeof resolved !== 'object' || (resolved as any).kind !== 'array') {
    throw new PdfPageError(`This page has no usable ${label}.`);
  }
  const raw = await Promise.all(
    ((resolved as any).values as PdfValue[]).map((v) => deref(source, index, v, signal)),
  );
  if (raw.length !== 4 || raw.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new PdfPageError(`This page's ${label} is not four numbers.`);
  }
  const [a, b, c, d] = raw as number[];
  // Normalized because the spec allows the corners in either order, and layout
  // code that assumes x0 < x1 places a signature off the page when they are not.
  const rect = { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) };
  if (rect.x1 - rect.x0 <= 0 || rect.y1 - rect.y0 <= 0) {
    throw new PdfPageError(`This page's ${label} has no area.`);
  }
  return rect;
}

/** Attributes a page may inherit from any ancestor. */
const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;

/**
 * Walk the page tree and return every page in order.
 *
 * The whole tree is walked once. That is bounded by node COUNT rather than by
 * document size: a page node is a small dictionary, and the pages of even a
 * 2 GB scan are a few thousand of them. The page CONTENT, which is what is
 * actually large, is never touched here.
 */
export async function resolvePages(
  source: PdfSource,
  index: PdfDocumentIndex,
  signal: AbortSignal,
): Promise<ResolvedPage[]> {
  const rootRef = index.trailer.entries.get('Root');
  const root = await deref(source, index, rootRef, signal);
  if (!isDict(root)) throw new PdfPageError('This document has no catalog.');

  const pagesRoot = await deref(source, index, root.entries.get('Pages'), signal);
  if (!isDict(pagesRoot)) throw new PdfPageError('This document has no page tree.');

  const pages: ResolvedPage[] = [];
  const visited = new Set<string>();
  let nodes = 0;

  /** Inherited attributes flow down; a leaf's own value always wins. */
  type Inherited = Partial<Record<(typeof INHERITABLE)[number], PdfValue>>;

  const walk = async (node: PdfDict, ref: PdfRef | null, inherited: Inherited) => {
    nodes += 1;
    if (nodes > MAX_PAGE_TREE_NODES) {
      throw new PdfPageError(`This document's page tree has more than ${MAX_PAGE_TREE_NODES} nodes.`);
    }

    const next: Inherited = { ...inherited };
    for (const key of INHERITABLE) {
      const own = node.entries.get(key);
      if (own !== undefined) next[key] = own;
    }

    const type = nameOf(node.entries.get('Type'));
    const kids = await deref(source, index, node.entries.get('Kids'), signal);
    const isLeaf = type === 'Page' || (type !== 'Pages' && kids === undefined);

    if (isLeaf) {
      if (!ref) throw new PdfPageError('A page is not an indirect object.');
      const mediaBox = await readRect(source, index, next.MediaBox, signal, 'MediaBox');
      // CropBox defaults to MediaBox, which IS in the spec. A missing MediaBox
      // does not default to anything.
      const cropBox = next.CropBox === undefined
        ? mediaBox
        : await readRect(source, index, next.CropBox, signal, 'CropBox');

      const rotateRaw = await deref(source, index, next.Rotate, signal);
      const rotate = rotateRaw === undefined ? 0 : rotateRaw;
      if (typeof rotate !== 'number' || !Number.isInteger(rotate) || rotate % 90 !== 0) {
        throw new PdfPageError(`This page's /Rotate (${String(rotate)}) is not a multiple of 90.`);
      }

      const userUnitRaw = await deref(source, index, node.entries.get('UserUnit'), signal);
      const userUnit = userUnitRaw === undefined ? 1 : userUnitRaw;
      if (typeof userUnit !== 'number' || !Number.isFinite(userUnit) || userUnit <= 0) {
        throw new PdfPageError(`This page's /UserUnit (${String(userUnit)}) is not a positive number.`);
      }

      const resources = await deref(source, index, next.Resources, signal);
      pages.push({
        index: pages.length,
        ref,
        dictionary: node,
        mediaBox,
        cropBox,
        // Normalized into 0/90/180/270. A negative or over-360 value is legal
        // and layout code that does not fold it rotates the wrong way.
        rotate: ((rotate % 360) + 360) % 360,
        resources: isDict(resources) ? resources : null,
        userUnit,
      });
      return;
    }

    if (!kids || typeof kids !== 'object' || (kids as any).kind !== 'array') {
      throw new PdfPageError('A page tree node has no /Kids array.');
    }
    for (const kid of (kids as any).values as PdfValue[]) {
      if (!isRef(kid)) throw new PdfPageError('A page tree kid is not an indirect reference.');
      const key = `${kid.value.objectNumber} ${kid.value.generationNumber}`;
      // A tree that points back at an ancestor is an unbounded walk the
      // document controls.
      if (visited.has(key)) throw new PdfPageError('This document\'s page tree points back at itself.');
      visited.add(key);

      const child = await getObject(source, index, kid.value, signal);
      if (!isDict(child)) throw new PdfPageError('A page tree kid is not a dictionary.');
      await walk(child, kid.value, next);
    }
  };

  await walk(pagesRoot, isRef(rootRef) ? undefined as any : null, {});

  // `/Count` is checked AFTER the walk rather than trusted before it. A wrong
  // count is then an error instead of a silently short document.
  const declared = await deref(source, index, pagesRoot.entries.get('Count'), signal);
  if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared !== pages.length) {
    throw new PdfPageError(
      `This document says it has ${declared} pages and its tree holds ${pages.length}.`,
    );
  }
  if (pages.length === 0) throw new PdfPageError('This document has no pages.');
  return pages;
}

/**
 * The visible size of a page, as a viewer shows it.
 *
 * Rotation swaps width and height, which is why a signature placed with raw
 * MediaBox numbers lands off the page on a rotated scan. The crop origin is
 * carried too: a page whose CropBox does not start at (0, 0) needs every
 * placement shifted by it.
 */
export function visibleGeometry(page: ResolvedPage) {
  const width = (page.cropBox.x1 - page.cropBox.x0) * page.userUnit;
  const height = (page.cropBox.y1 - page.cropBox.y0) * page.userUnit;
  const swapped = page.rotate === 90 || page.rotate === 270;
  return {
    width: swapped ? height : width,
    height: swapped ? width : height,
    originX: page.cropBox.x0,
    originY: page.cropBox.y0,
    rotate: page.rotate,
    userUnit: page.userUnit,
  };
}
