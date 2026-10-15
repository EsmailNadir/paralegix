/**
 * Turning a field the signer positioned in the viewer into a spot on a real page.
 *
 * The viewer stores a field as PERCENTAGES of the page it displays, measured
 * from that page's top left corner. That is the coordinate contract the browser
 * stamper and this module both speak, and a percentage is only meaningful
 * against the page a viewer actually shows: the CROP box, turned by `/Rotate`
 * and scaled by `/UserUnit`. Reading it against the raw MediaBox agrees with the
 * viewer only for the unrotated, uncropped, unscaled case.
 *
 * So the three transforms are applied EXPLICITLY here rather than assumed away:
 *
 *   `/UserUnit` is divided back out. The percentage is scale free, so the same
 *   field on a scaled page has to resolve to the same user space rectangle.
 *
 *   THE CROP ORIGIN is added. A page whose visible area starts at (50, 30)
 *   needs every placement shifted by that.
 *
 *   ROTATION is undone. A viewer showing a page turned 90 degrees reports a
 *   width that is the page's height, so the axes have to be swapped back.
 *
 * GEOMETRY IS NEVER DEFAULTED. `resolvePages` refuses a page whose size cannot
 * be worked out rather than assuming US Letter, and this module inherits that:
 * a signature placed by percentage of a page that does not exist lands
 * somewhere arbitrary on the page that does.
 *
 * A field that cannot be resolved is never skipped. Which of the two answers is
 * right depends on where the request is:
 *
 *   BEFORE INVITATIONS GO OUT, `preflightFieldPlacements` refuses. Nobody has
 *   committed to anything yet, and the layout can still be corrected.
 *
 *   AFTER A SIGNER HAS CONSENTED, `planFieldPlacements` records the failure and
 *   carries on. Refusing there would discard consent that was legitimately
 *   given, so the failure is returned as recoverable state instead.
 */
import { AppError } from '../../../shared/errors/AppError';
import { calculateSignatureLayout } from '../signatureLayout';
import type { Placement } from './appearances';
import type { PdfRect, ResolvedPage } from './pages';
import { visibleGeometry } from './pages';

export class PdfFieldPlacementError extends AppError {
  /** Every field that could not be placed, not just the one that stopped it. */
  readonly failures: FieldPlacementFailure[];

  constructor(message: string, failures: FieldPlacementFailure[] = []) {
    super(message, 400, 'PDF_FIELD_PLACEMENT_ERROR');
    this.failures = failures;
  }
}

/** A field as the signer setup UI stores it: percent of the displayed page. */
export interface PlaceableField {
  id: string;
  /** One-based, the way the viewer numbers pages. Absent means the first page. */
  page?: number | null;
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
}

/** Why one field could not be placed. */
export interface FieldPlacementFailure {
  fieldId: string;
  /** The one-based page the field asked for, as asked for. */
  page: number;
  reason: string;
}

export interface PlacedField {
  fieldId: string;
  /** Zero-based index into the resolved pages. */
  pageIndex: number;
  page: ResolvedPage;
  /** The box in the coordinates the viewer showed, measured from the bottom. */
  placement: Placement;
  /** The same box in page user space, after crop, rotation and `/UserUnit`. */
  rect: PdfRect;
}

/** The size of a page as a viewer displays it. */
export interface VisiblePageSize {
  width: number;
  height: number;
}

/** The one-based page a field names. A field with no page is on the first one. */
function pageNumberOf(field: PlaceableField): number {
  const raw = field.page;
  if (raw === undefined || raw === null) return 1;
  return raw;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * The field's box in the coordinates the viewer showed, measured from the
 * BOTTOM of the visible page rather than the top.
 *
 * The percentages are stored from the top because that is how the browser lays
 * out an overlay; every PDF coordinate is measured from the bottom.
 */
function fieldVisibleBox(field: PlaceableField, visible: VisiblePageSize): Placement {
  const width = (field.widthPercent / 100) * visible.width;
  const height = (field.heightPercent / 100) * visible.height;
  const x = (field.xPercent / 100) * visible.width;
  const top = (field.yPercent / 100) * visible.height;
  return { x, y: visible.height - top - height, width, height };
}

/** Why this field cannot be placed on these pages, or null when it can. */
function fieldPlacementProblem(
  field: PlaceableField,
  visiblePages: VisiblePageSize[],
): string | null {
  const pageNumber = pageNumberOf(field);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return `This field names page ${String(pageNumber)}, which is not a page number.`;
  }
  if (pageNumber > visiblePages.length) {
    return `This field is on page ${pageNumber} and the document has ${visiblePages.length}.`;
  }
  for (const key of ['xPercent', 'yPercent', 'widthPercent', 'heightPercent'] as const) {
    if (!isFiniteNumber(field[key])) return `This field has no usable ${key}.`;
  }

  const visible = visiblePages[pageNumber - 1];
  const box = fieldVisibleBox(field, visible);
  if (box.width <= 0 || box.height <= 0) return 'This field has no area.';
  // Refused rather than clamped: a clamped placement is a signature somewhere
  // the signer did not put it.
  if (box.x < 0 || box.y < 0
    || box.x + box.width > visible.width + EDGE_TOLERANCE
    || box.y + box.height > visible.height + EDGE_TOLERANCE) {
    return `This field does not fit on page ${pageNumber} `
      + `(${round(box.x)},${round(box.y)} ${round(box.width)}x${round(box.height)} `
      + `on ${round(visible.width)}x${round(visible.height)}).`;
  }
  return null;
}

/**
 * How far past the edge a box may sit before it is refused.
 *
 * A field dragged flush to the right edge stores 100 percent, and the products
 * of the percentage arithmetic land a fraction of a thousandth of a point past
 * the edge. That is a rounding artefact, not a misplaced signature.
 */
const EDGE_TOLERANCE = 1e-6;

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Map a box from the coordinates a viewer showed into page user space.
 *
 * Returns the RECTANGLE the field occupies. `placementToUserSpace` in
 * `appearances.ts` answers the neighbouring question, which is the transform
 * that draws an appearance into that rectangle.
 */
export function visibleRectToUserRect(page: ResolvedPage, placement: Placement): PdfRect {
  const geometry = visibleGeometry(page);
  if (placement.width <= 0 || placement.height <= 0) {
    throw new PdfFieldPlacementError('A signature placement has no area.');
  }
  if (placement.x < 0 || placement.y < 0
    || placement.x + placement.width > geometry.width + EDGE_TOLERANCE
    || placement.y + placement.height > geometry.height + EDGE_TOLERANCE) {
    throw new PdfFieldPlacementError(
      `That placement does not fit on the page (${round(placement.x)},${round(placement.y)} `
      + `${round(placement.width)}x${round(placement.height)} `
      + `on ${round(geometry.width)}x${round(geometry.height)}).`,
    );
  }

  // `/UserUnit` first, so everything after it is in page units.
  const unit = page.userUnit;
  const x = placement.x / unit;
  const y = placement.y / unit;
  const w = placement.width / unit;
  const h = placement.height / unit;
  const { x0, y0, x1, y1 } = page.cropBox;

  // Each case is the inverse of how a viewer turns the crop box for display.
  switch (page.rotate) {
    case 90: {
      // The display's top left corner is the page's bottom left, so
      // ux = x1 - viewY and uy = y0 + viewX.
      return normalize(x1 - y, y0 + x, x1 - (y + h), y0 + x + w);
    }
    case 180: {
      // Both axes flip: ux = x1 - viewX and uy = y1 - viewY.
      return normalize(x1 - x, y1 - y, x1 - (x + w), y1 - (y + h));
    }
    case 270: {
      // The display's top left corner is the page's top right, so
      // ux = x0 + viewY and uy = y1 - viewX.
      return normalize(x0 + y, y1 - x, x0 + y + h, y1 - (x + w));
    }
    default:
      return { x0: x0 + x, y0: y0 + y, x1: x0 + x + w, y1: y0 + y + h };
  }
}

function normalize(ax: number, ay: number, bx: number, by: number): PdfRect {
  return {
    x0: Math.min(ax, bx),
    y0: Math.min(ay, by),
    x1: Math.max(ax, bx),
    y1: Math.max(ay, by),
  };
}

/**
 * Every field that cannot be placed on pages of these sizes.
 *
 * Takes plain sizes rather than resolved pages so the flattening stamper and
 * the incremental writer agree on what counts as an unplaceable field, instead
 * of one of them quietly dropping what the other refuses.
 */
export function findUnplaceableFields(
  fields: PlaceableField[],
  visiblePages: VisiblePageSize[],
): FieldPlacementFailure[] {
  const failures: FieldPlacementFailure[] = [];
  for (const field of fields || []) {
    const problem = fieldPlacementProblem(field, visiblePages);
    if (problem) failures.push({ fieldId: field.id, page: pageNumberOf(field), reason: problem });
  }
  return failures;
}

/** Place one field, or refuse. Never returns a guessed page or a clamped box. */
export function placeField(field: PlaceableField, pages: ResolvedPage[]): PlacedField {
  const visiblePages = pages.map((page) => visibleGeometry(page));
  const problem = fieldPlacementProblem(field, visiblePages);
  if (problem) {
    throw new PdfFieldPlacementError(problem, [
      { fieldId: field.id, page: pageNumberOf(field), reason: problem },
    ]);
  }

  const pageIndex = pageNumberOf(field) - 1;
  const page = pages[pageIndex];
  const placement = fieldVisibleBox(field, visiblePages[pageIndex]);
  return { fieldId: field.id, pageIndex, page, placement, rect: visibleRectToUserRect(page, placement) };
}

/**
 * Place every field, refusing the whole set if any one of them cannot be placed.
 *
 * For the path that runs BEFORE invitations go out. Nobody has committed to
 * anything, so a layout that would drop a field is worth stopping: a signer
 * asked to sign a document missing one of their fields has signed something
 * other than what was designed.
 */
export function preflightFieldPlacements(
  fields: PlaceableField[],
  pages: ResolvedPage[],
): PlacedField[] {
  const { placed, failures } = planFieldPlacements(fields, pages);
  if (failures.length > 0) {
    throw new PdfFieldPlacementError(failures[0].reason, failures);
  }
  return placed;
}

/**
 * Place what can be placed and return the rest as failures.
 *
 * For the path that runs AFTER a signer has consented. Throwing there would
 * discard consent that was legitimately given and leave the session with no way
 * forward, so the failure is carried out as recoverable state: the caller can
 * hold the session open, surface what went wrong and finalize again once the
 * layout is repaired.
 */
export function planFieldPlacements(
  fields: PlaceableField[],
  pages: ResolvedPage[],
): { placed: PlacedField[]; failures: FieldPlacementFailure[] } {
  const visiblePages = pages.map((page) => visibleGeometry(page));
  const placed: PlacedField[] = [];
  const failures: FieldPlacementFailure[] = [];

  for (const field of fields || []) {
    const problem = fieldPlacementProblem(field, visiblePages);
    if (problem) {
      failures.push({ fieldId: field.id, page: pageNumberOf(field), reason: problem });
      continue;
    }
    placed.push(placeField(field, pages));
  }

  return { placed, failures };
}

/** A signature appearance's parts, in the Form XObject's own coordinates. */
export interface SignatureFormLayout {
  imageRect: { x: number; y: number; width: number; height: number };
  line?: { x: number; y: number; width: number; thickness: number };
  xMark?: { x: number; y: number; fontSize: number };
}

/**
 * What `signatureLayout.ts` returns, measured from the box's TOP.
 *
 * Named here because that module is untyped: without it the two styles it can
 * return are an untyped union and the x-line parts read as absent.
 */
interface SharedSignatureLayout {
  style: string;
  imageRect: { x: number; y: number; width: number; height: number };
  line?: { x: number; y: number; width: number; thickness: number };
  xMark?: { x: number; y: number; fontSize: number };
}

/**
 * The shared signature layout, flipped into a Form XObject's coordinates.
 *
 * `signatureLayout.ts` measures from the box's TOP, which is how the browser
 * stamper draws and therefore what the signer was shown. A Form XObject's BBox
 * is measured from its bottom left, so every y is flipped here rather than at
 * each draw site: the executed document and the preview then agree by
 * construction instead of by two parallel edits staying in step.
 */
export function signatureFormLayout(options: {
  boxWidth: number;
  boxHeight: number;
  imageAspectRatio: number;
  style?: string;
}): SignatureFormLayout {
  const { boxWidth, boxHeight, imageAspectRatio, style } = options;
  const layout = calculateSignatureLayout({
    boxWidth, boxHeight, imageAspectRatio, style,
  }) as SharedSignatureLayout;

  const result: SignatureFormLayout = {
    imageRect: {
      x: layout.imageRect.x,
      y: boxHeight - layout.imageRect.y - layout.imageRect.height,
      width: layout.imageRect.width,
      height: layout.imageRect.height,
    },
  };
  if (layout.line) {
    result.line = {
      x: layout.line.x,
      y: boxHeight - layout.line.y,
      width: layout.line.width,
      thickness: layout.line.thickness,
    };
  }
  if (layout.xMark) {
    // The X is drawn from its BASELINE, which is one font size below the top of
    // the glyph box the shared layout reports.
    result.xMark = {
      x: layout.xMark.x,
      y: boxHeight - layout.xMark.y - layout.xMark.fontSize,
      fontSize: layout.xMark.fontSize,
    };
  }
  return result;
}
