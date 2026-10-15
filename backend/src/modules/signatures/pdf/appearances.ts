/**
 * Putting a signature appearance onto an existing page.
 *
 * The appearance is imported as a FORM XOBJECT: a self-contained little
 * document with its own resources and its own coordinate system. That is what
 * keeps it from interfering with the page it lands on. Drawing the marks
 * directly into the page's content stream would mean merging two resource
 * dictionaries and hoping the names do not collide, and a collision there
 * silently replaces one of the page's own fonts or images.
 *
 * Three rules, each of which is a way the page gets corrupted otherwise:
 *
 * THE RESOURCE NAME MUST BE UNIQUE against what the page already has. `/Fm0` is
 * the obvious choice and is also the name the page most likely already uses.
 *
 * THE INVOCATION IS WRAPPED IN q/Q. Without the save and restore, whatever
 * graphics state the appearance sets (a colour, a clip, a transform) leaks into
 * everything drawn after it on that page.
 *
 * THE ORIGINAL CONTENT IS NOT REWRITTEN. `/Contents` may be one stream or an
 * array of them, and the appended stream is added to that array. Replacing it
 * would discard the page.
 */
import { AppError } from '../../../shared/errors/AppError';
import type { ResolvedPage } from './pages';
import { visibleGeometry } from './pages';
import type { PdfDict, PdfRef, PdfValue } from './types';
import { withEntries } from './writer';

export class PdfAppearanceError extends AppError {
  constructor(message: string) {
    super(message, 400, 'PDF_APPEARANCE_ERROR');
  }
}

const name = (value: string): PdfValue => ({ kind: 'name', value });
const ref = (r: PdfRef): PdfValue => ({ kind: 'ref', value: r });
const dict = (entries: Record<string, PdfValue>): PdfDict =>
  ({ kind: 'dict', entries: new Map(Object.entries(entries)) });

/** Where a signature goes, in the coordinates a viewer shows. */
export interface Placement {
  /** From the left of the VISIBLE page, in points. */
  x: number;
  /** From the BOTTOM of the visible page, in points. */
  y: number;
  width: number;
  height: number;
}

/**
 * A unique resource name for the page.
 *
 * `/Fm0` is the obvious choice and is also what the page most likely already
 * uses. Taking it replaces one of the page's own XObjects, and the page then
 * renders with a signature where a logo was.
 */
export function uniqueResourceName(existing: PdfDict | null, prefix: string): string {
  const xobjects = existing?.entries.get('XObject');
  const taken = new Set<string>();
  if (xobjects && typeof xobjects === 'object' && (xobjects as any).kind === 'dict') {
    for (const key of (xobjects as PdfDict).entries.keys()) taken.add(key);
  }
  for (let i = 0; i < 10_000; i += 1) {
    const candidate = `${prefix}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new PdfAppearanceError('Could not find a free resource name on this page.');
}

/**
 * Map a placement from visible coordinates into the page's user space.
 *
 * Two things move it. The CROP ORIGIN, because a page whose visible area starts
 * at (20, 30) needs everything shifted by that. And ROTATION, because a viewer
 * showing a page turned 90 degrees reports a width that is the page's height,
 * so a placement in what the user saw is not a placement in the page.
 *
 * Getting this wrong puts the signature off the page or on its side, and the
 * response still says success.
 */
export function placementToUserSpace(page: ResolvedPage, placement: Placement) {
  const geometry = visibleGeometry(page);
  const { x, y, width, height } = placement;

  if (width <= 0 || height <= 0) {
    throw new PdfAppearanceError('A signature placement has no area.');
  }
  if (x < 0 || y < 0 || x + width > geometry.width || y + height > geometry.height) {
    // Refused rather than clamped. A clamped placement is a signature somewhere
    // the signer did not put it, which is worse than an error.
    throw new PdfAppearanceError(
      `That signature does not fit on the page (${x},${y} ${width}x${height} `
      + `on ${geometry.width}x${geometry.height}).`,
    );
  }

  const unit = page.userUnit;
  // Undo the user unit first, so the rest is in page units.
  const px = x / unit;
  const py = y / unit;
  const pw = width / unit;
  const ph = height / unit;
  const cropWidth = page.cropBox.x1 - page.cropBox.x0;
  const cropHeight = page.cropBox.y1 - page.cropBox.y0;

  // `[a b c d e f]` is the PDF transform matrix, mapping a form point (s, t) to
  // user space as (a*s + c*t + e, b*s + d*t + f).
  //
  // The translation is the part that is easy to get wrong, because a wrong one
  // still produces a signature on the page: it is simply a box-dimension away
  // from where the signer put it, which looks like a layout quirk rather than a
  // defect. So each case below states where the form's own origin, its bottom
  // left corner, has to land.
  //
  // Under /Rotate 90 the page is displayed turned clockwise, so a visible point
  // (X, Y) is the user point (x0 + cropWidth - Y, y0 + X). The form spans
  // t in [0, ph], and the matrix sends t to DECREASING u, so `e` is the user
  // coordinate of the placement's TOP visible edge, not its bottom: subtracting
  // the height again moves the whole box off by its own height.
  switch (page.rotate) {
    case 90:
      return {
        matrix: [0, 1, -1, 0, page.cropBox.x0 + cropWidth - py, page.cropBox.y0 + px],
        width: pw,
        height: ph,
      };
    case 180:
      return {
        matrix: [-1, 0, 0, -1, page.cropBox.x0 + cropWidth - px, page.cropBox.y0 + cropHeight - py],
        width: pw,
        height: ph,
      };
    // The mirror of the 90 case: the matrix sends s to DECREASING v, so `f` is
    // the placement's far visible edge and must not have the width taken off it.
    case 270:
      return {
        matrix: [0, -1, 1, 0, page.cropBox.x0 + py, page.cropBox.y0 + cropHeight - px],
        width: pw,
        height: ph,
      };
    default:
      return {
        matrix: [1, 0, 0, 1, page.cropBox.x0 + px, page.cropBox.y0 + py],
        width: pw,
        height: ph,
      };
  }
}

export interface AppearancePlan {
  /** The Form XObject's dictionary. Its stream bytes are the caller's. */
  formDictionary: PdfDict;
  /** The content stream that invokes it, wrapped in q/Q. */
  invocation: Uint8Array;
  /** The name the invocation uses, unique on this page. */
  resourceName: string;
  /** The page dictionary with resources and contents updated. */
  updatedPage: PdfDict;
}

/**
 * Everything needed to stamp one appearance onto one page.
 *
 * Returns descriptions rather than writing anything: the caller decides which
 * object numbers to use and hands them to the writer. That separation is what
 * lets this be tested without a document.
 */
export function planAppearance(options: {
  page: ResolvedPage;
  placement: Placement;
  /** The appearance's own size, in its own coordinates. */
  bbox: { width: number; height: number };
  /** Resources the appearance needs, e.g. its fonts. */
  appearanceResources: PdfDict;
  /** Object number the form will be written as. */
  formRef: PdfRef;
  /** Object number the invocation stream will be written as. */
  contentRef: PdfRef;
  /** Byte length of the invocation stream, which the caller measures. */
}): AppearancePlan {
  const { page, placement, bbox, appearanceResources, formRef, contentRef } = options;

  if (bbox.width <= 0 || bbox.height <= 0) {
    throw new PdfAppearanceError('A signature appearance has no area.');
  }

  const resourceName = uniqueResourceName(page.resources, 'ParalegixSig');
  const { matrix, width, height } = placementToUserSpace(page, placement);

  // The form's own Matrix scales its BBox to the size the placement asks for,
  // so the appearance is authored once at a natural size and fitted here.
  const formDictionary = dict({
    Type: name('XObject'),
    Subtype: name('Form'),
    FormType: 1,
    BBox: { kind: 'array', values: [0, 0, bbox.width, bbox.height] },
    Resources: appearanceResources,
  });

  const sx = width / bbox.width;
  const sy = height / bbox.height;
  // `q` ... `Q` around everything. Without it, any graphics state the appearance
  // sets leaks into whatever the page draws after it.
  const invocation = Buffer.from(
    `q\n${matrix.map(fmt).join(' ')} cm\n${fmt(sx)} 0 0 ${fmt(sy)} 0 0 cm\n/${resourceName} Do\nQ\n`,
    'latin1',
  );

  // Resources are MATERIALIZED on the leaf when they were inherited. Editing the
  // inherited dictionary in place would add this signature's XObject to every
  // page that shares it.
  const baseResources = page.resources ?? dict({});
  const existingXObjects = baseResources.entries.get('XObject');
  const xobjects = (existingXObjects && typeof existingXObjects === 'object'
    && (existingXObjects as any).kind === 'dict')
    ? withEntries(existingXObjects as PdfDict, { [resourceName]: ref(formRef) })
    : dict({ [resourceName]: ref(formRef) });

  const updatedResources = withEntries(baseResources, { XObject: xobjects });

  // `/Contents` may be one stream or an array. The new stream is APPENDED, never
  // substituted: replacing it discards the page.
  const contents = page.dictionary.entries.get('Contents');
  let updatedContents: PdfValue;
  if (contents === undefined) {
    updatedContents = ref(contentRef);
  } else if (typeof contents === 'object' && (contents as any).kind === 'array') {
    updatedContents = { kind: 'array', values: [...(contents as any).values, ref(contentRef)] };
  } else {
    updatedContents = { kind: 'array', values: [contents, ref(contentRef)] };
  }

  const updatedPage = withEntries(page.dictionary, {
    Resources: updatedResources,
    Contents: updatedContents,
  });

  return { formDictionary, invocation: new Uint8Array(invocation), resourceName, updatedPage };
}

/** PDF numbers, without exponent notation, which the format has no form for. */
function fmt(value: number): string {
  if (!Number.isFinite(value)) throw new PdfAppearanceError(`Cannot write the number ${value}.`);
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}
