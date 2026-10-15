/**
 * Turning a fillable AcroForm into ordinary page content.
 *
 * A signer must not be shown a document whose values can still change. A live
 * text field, checkbox or dropdown is rendered by the viewer from the field's
 * appearance stream, and the same file opened in a different viewer, or after a
 * single keystroke, shows something else. Sealing that is sealing a document
 * whose visible content is not fixed.
 *
 * Flattening removes the interactivity and leaves the picture. The appearance a
 * viewer would draw is ALREADY IN THE FILE, as a Form XObject under the widget's
 * `/AP /N`, so flattening places that same object into the page's content and
 * then drops the widget and its field. Nothing is re-rendered here: this code
 * has no font engine, and a value drawn by guesswork is this process inventing
 * the signer's own answers.
 *
 * The design constraints that shape everything below:
 *
 * IT IS AN INCREMENTAL UPDATE. Only the pages that carried widgets, the
 * AcroForm, and a few small content streams are appended. A 2 GB scan is never
 * read, let alone rewritten.
 *
 * THE SELECTED STATE MATTERS. `/AP /N` for a checkbox or radio button is a
 * dictionary of appearance states, and `/AS` names the one on show. Taking the
 * first key places the ticked mark for every box in the document, and the
 * result looks entirely plausible.
 *
 * WHAT CANNOT BE PROVED IS REFUSED. A widget with no normal appearance,
 * `/NeedAppearances true`, an XFA form, or a value that disagrees with the
 * appearance drawn for it all stop the preparation. There is no fallback path:
 * catching one of these and returning success is how a signer ends up looking
 * at an answer nobody gave.
 */
import { AppError } from '../../../shared/errors/AppError';
import { uniqueResourceName } from './appearances';
import { nextObjectNumber } from './appendPage';
import { decodeStream } from './filters';
import { resolvePages, type ResolvedPage } from './pages';
import {
  getObject,
  readStartXref,
  readStreamObject,
  type PdfDocumentIndex,
} from './reader';
import type { PdfDict, PdfRef, PdfSource, PdfStream, PdfValue } from './types';
import {
  buildIncrementalUpdate,
  serializeValue,
  withEntries,
  type AppendedObject,
  type IncrementalUpdate,
} from './writer';

/** Nodes the field tree may hold. A tree past this is refused, not truncated. */
const MAX_FORM_NODES = Number(process.env.PDF_MAX_FORM_NODES) || 50_000;

/** The largest appearance stream this will decode to check a value against. */
const MAX_APPEARANCE_BYTES = Number(process.env.PDF_MAX_APPEARANCE_BYTES) || 1024 * 1024;

/** `/Ff` bit 17: the button is a pushbutton, so it has no value and no states. */
const PUSHBUTTON_FLAG = 1 << 16;

/** `/F` bit 2: the annotation is not displayed at all. */
const HIDDEN_FLAG = 1 << 1;

/** `/F` bit 6: the annotation is displayed when printed but not on screen. */
const NO_VIEW_FLAG = 1 << 5;

/**
 * Every refusal in this file, under one code.
 *
 * One code rather than a family, because the caller's decision is the same in
 * every case: this upload cannot be prepared for signing, and the message says
 * which part of it could not be proved.
 */
export class PdfFormError extends AppError {
  constructor(message: string) {
    super(message, 400, 'PDF_UNSUPPORTED_FORM');
  }
}

const isDict = (value: PdfValue | undefined): value is PdfDict =>
  !!value && typeof value === 'object' && (value as any).kind === 'dict';

const isRef = (value: PdfValue | undefined): value is Extract<PdfValue, { kind: 'ref' }> =>
  !!value && typeof value === 'object' && (value as any).kind === 'ref';

const isArray = (value: PdfValue | undefined): value is Extract<PdfValue, { kind: 'array' }> =>
  !!value && typeof value === 'object' && (value as any).kind === 'array';

const nameOf = (value: PdfValue | undefined): string | null =>
  (value && typeof value === 'object' && (value as any).kind === 'name')
    ? (value as any).value as string
    : null;

const refValue = (r: PdfRef): PdfValue => ({ kind: 'ref', value: r });
const emptyDict = (): PdfDict => ({ kind: 'dict', entries: new Map() });
const refKey = (r: PdfRef) => `${r.objectNumber} ${r.generationNumber}`;

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

/**
 * Resolve a reference that may name either a stream or a plain dictionary.
 *
 * `/AP /N` is a Form XObject for a text or choice field and a dictionary of
 * appearance states for a checkbox or radio button, and the two are told apart
 * only by whether the object carries stream bytes. An object packed inside an
 * object stream can never be a stream itself, so that case skips the check
 * rather than asking the stream reader for something it will refuse.
 */
async function resolveMaybeStream(
  source: PdfSource,
  index: PdfDocumentIndex,
  ref: PdfRef,
  signal: AbortSignal,
): Promise<{ value: PdfValue; stream: PdfStream | null }> {
  if (index.entries.get(ref.objectNumber)?.inObjectStream) {
    return { value: await getObject(source, index, ref, signal), stream: null };
  }
  return readStreamObject(source, index, ref, signal);
}

/** The text a PDF string holds, honouring the UTF-16BE marker the format uses. */
function pdfText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return Buffer.from(bytes.subarray(2)).toString('utf16le').split('').map((c) => {
      const code = c.charCodeAt(0);
      return String.fromCharCode(((code & 0xff) << 8) | (code >> 8));
    }).join('');
  }
  return Buffer.from(bytes).toString('latin1');
}

/** A field value as text, whether it was written as a string or as a name. */
function valueText(value: PdfValue | undefined): string | null {
  if (!value || typeof value !== 'object') return null;
  if ((value as any).kind === 'string') return pdfText((value as any).bytes as Uint8Array);
  if ((value as any).kind === 'name') return (value as any).value as string;
  return null;
}

/**
 * Every literal a content stream shows, concatenated.
 *
 * This is deliberately not a content stream interpreter. Strings in an
 * appearance stream are the operands of the text-showing operators, and the
 * question being asked is only whether the value the field holds is among them.
 * Reading a little more than the shown text (the odd marked-content property)
 * makes the check more forgiving, never less, so it cannot turn a correct
 * appearance into a refusal.
 */
function shownText(bytes: Uint8Array): string {
  const escapes: Record<number, number> = {
    0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c,
    0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c,
  };
  let out = '';
  let i = 0;

  while (i < bytes.length) {
    const b = bytes[i];

    if (b === 0x28) { // literal string
      i += 1;
      let depth = 1;
      while (i < bytes.length && depth > 0) {
        const c = bytes[i];
        if (c === 0x5c) {
          const next = bytes[i + 1];
          i += 2;
          if (next === undefined) break;
          if (escapes[next] !== undefined) { out += String.fromCharCode(escapes[next]); continue; }
          if (next >= 0x30 && next <= 0x37) {
            let octal = next - 0x30;
            for (let k = 0; k < 2; k += 1) {
              const digit = bytes[i];
              if (digit === undefined || digit < 0x30 || digit > 0x37) break;
              octal = octal * 8 + (digit - 0x30);
              i += 1;
            }
            out += String.fromCharCode(octal & 0xff);
            continue;
          }
          if (next === 0x0a) continue;
          if (next === 0x0d) { if (bytes[i] === 0x0a) i += 1; continue; }
          out += String.fromCharCode(next);
          continue;
        }
        i += 1;
        if (c === 0x28) { depth += 1; out += '('; continue; }
        if (c === 0x29) { depth -= 1; if (depth > 0) out += ')'; continue; }
        out += String.fromCharCode(c);
      }
      continue;
    }

    if (b === 0x3c && bytes[i + 1] === 0x3c) { i += 2; continue; } // dictionary, not a string

    if (b === 0x3c) { // hex string
      i += 1;
      let hex = '';
      while (i < bytes.length && bytes[i] !== 0x3e) {
        const c = String.fromCharCode(bytes[i]);
        if (/[0-9a-fA-F]/.test(c)) hex += c;
        i += 1;
      }
      i += 1;
      if (hex.length % 2 === 1) hex += '0';
      for (let k = 0; k < hex.length; k += 2) {
        out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      }
      continue;
    }

    i += 1;
  }
  return out;
}

/**
 * Whitespace removed from both sides of the comparison.
 *
 * A comb field draws each character with its own positioning operator, and a
 * multi-line field breaks the value across several of them, so the shown text
 * carries spacing the value does not. What is being checked is that the same
 * characters are there in the same order, not that the layout matches.
 */
const compact = (text: string) => text.replace(/\s+/g, '');

/** One flattened widget, described well enough to audit what was placed. */
export interface FlattenedWidget {
  /** Zero-based page index the appearance was drawn onto. */
  pageIndex: number;
  /** The fully qualified field name, when the field has one. */
  fieldName: string | null;
  /** `/FT`: Tx, Btn, Ch or Sig. */
  fieldType: string;
  /** The appearance object placed, or null when the widget shows nothing. */
  appearanceRef: PdfRef | null;
  /** The `/AS` state chosen, for a widget whose appearance has states. */
  appearanceState: string | null;
  /** The name the page's content stream invokes the appearance by. */
  resourceName: string | null;
  /** `[a b c d e f]` mapping the appearance onto the widget's `/Rect`. */
  matrix: number[] | null;
}

/**
 * What to append, or that there is nothing to append.
 *
 * `no-form` is a distinct outcome rather than an update with no objects in it.
 * An empty incremental update is still an appended revision, and a prepared
 * source that gained one no longer has the digest of the upload it came from.
 */
export type FormFlattenPlan =
  | { kind: 'no-form' }
  | {
    kind: 'flatten';
    objects: AppendedObject[];
    widgets: FlattenedWidget[];
    /** The first object number still free after this plan's allocations. */
    nextObjectNumber: number;
  };

export type FormFlattenResult =
  | { flattened: false }
  | { flattened: true; update: IncrementalUpdate; widgets: FlattenedWidget[] };

/** A `[x0 y0 x1 y1]` box, normalized, since the corners may be in either order. */
async function readBox(
  source: PdfSource,
  index: PdfDocumentIndex,
  value: PdfValue | undefined,
  signal: AbortSignal,
  label: string,
): Promise<{ x0: number; y0: number; x1: number; y1: number }> {
  const resolved = await deref(source, index, value, signal);
  if (!isArray(resolved) || resolved.values.length !== 4) {
    throw new PdfFormError(`A form field's ${label} is not four numbers.`);
  }
  const numbers = await Promise.all(resolved.values.map((v) => deref(source, index, v, signal)));
  if (numbers.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new PdfFormError(`A form field's ${label} is not four numbers.`);
  }
  const [a, b, c, d] = numbers as number[];
  return { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) };
}

/** `/Matrix`, defaulting to the identity, which is what the spec says. */
async function readMatrix(
  source: PdfSource,
  index: PdfDocumentIndex,
  value: PdfValue | undefined,
  signal: AbortSignal,
): Promise<number[]> {
  const resolved = await deref(source, index, value, signal);
  if (resolved === undefined) return [1, 0, 0, 1, 0, 0];
  if (!isArray(resolved) || resolved.values.length !== 6) {
    throw new PdfFormError('An appearance stream has a /Matrix that is not six numbers.');
  }
  const numbers = await Promise.all(resolved.values.map((v) => deref(source, index, v, signal)));
  if (numbers.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new PdfFormError('An appearance stream has a /Matrix that is not six numbers.');
  }
  return numbers as number[];
}

/**
 * The transform that puts an appearance where its widget sits.
 *
 * The appearance's BBox is transformed by its own `/Matrix`, the bounding box of
 * the result is taken, and that box is scaled and shifted onto the widget's
 * `/Rect`. The `/Matrix` itself is NOT folded in here: the `Do` operator applies
 * a form's matrix on its own, so concatenating it again would apply it twice.
 *
 * Page rotation is likewise absent on purpose. An annotation rectangle is in the
 * page's own user space, exactly like page content, so a rotated page turns the
 * flattened mark by the same angle it turned the widget. Rotating it here would
 * turn it a second time.
 */
function placementMatrix(
  rect: { x0: number; y0: number; x1: number; y1: number },
  bbox: { x0: number; y0: number; x1: number; y1: number },
  matrix: number[],
): number[] {
  const [a, b, c, d, e, f] = matrix;
  const corners = [
    [bbox.x0, bbox.y0], [bbox.x1, bbox.y0], [bbox.x1, bbox.y1], [bbox.x0, bbox.y1],
  ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);

  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const tx0 = Math.min(...xs);
  const tx1 = Math.max(...xs);
  const ty0 = Math.min(...ys);
  const ty1 = Math.max(...ys);

  if (tx1 - tx0 <= 0 || ty1 - ty0 <= 0) {
    throw new PdfFormError('A form field\'s appearance collapses to nothing once its /Matrix is applied.');
  }
  if (rect.x1 - rect.x0 <= 0 || rect.y1 - rect.y0 <= 0) {
    // Refused rather than skipped. A widget with no area still holds a value,
    // and dropping it quietly is that value going missing from the document.
    throw new PdfFormError('A form field\'s /Rect has no area.');
  }

  const sx = (rect.x1 - rect.x0) / (tx1 - tx0);
  const sy = (rect.y1 - rect.y0) / (ty1 - ty0);
  return [sx, 0, 0, sy, rect.x0 - sx * tx0, rect.y0 - sy * ty0];
}

/** A field node as the tree walk sees it, with what it inherited applied. */
interface FieldContext {
  fieldType: string | null;
  value: PdfValue | undefined;
  flags: number;
  name: string | null;
}

interface WidgetTarget {
  ref: PdfRef;
  dictionary: PdfDict;
  context: FieldContext;
}

/**
 * Every widget the form declares, in the order `/Fields` lists them.
 *
 * `/FT`, `/V` and `/Ff` are INHERITABLE, and a radio group is the case that
 * matters: the selected value lives on the parent field while the buttons that
 * can show it are its kids. Reading the value off the widget alone sees nothing
 * selected, and every button then fails its consistency check.
 */
async function collectWidgets(options: {
  source: PdfSource;
  index: PdfDocumentIndex;
  signal: AbortSignal;
  fields: PdfValue[];
}): Promise<WidgetTarget[]> {
  const { source, index, signal, fields } = options;
  const widgets: WidgetTarget[] = [];
  const visited = new Set<string>();
  let nodes = 0;

  const walk = async (node: PdfDict, ref: PdfRef | null, inherited: FieldContext) => {
    nodes += 1;
    if (nodes > MAX_FORM_NODES) {
      throw new PdfFormError(`This document's form has more than ${MAX_FORM_NODES} nodes.`);
    }

    const ownType = nameOf(node.entries.get('FT'));
    const ownValue = node.entries.has('V')
      ? await deref(source, index, node.entries.get('V'), signal)
      : undefined;
    const ownFlags = await deref(source, index, node.entries.get('Ff'), signal);
    const ownName = valueText(node.entries.get('T'));

    const context: FieldContext = {
      fieldType: ownType ?? inherited.fieldType,
      value: node.entries.has('V') ? ownValue : inherited.value,
      flags: typeof ownFlags === 'number' && Number.isSafeInteger(ownFlags) ? ownFlags : inherited.flags,
      name: ownName === null
        ? inherited.name
        : [inherited.name, ownName].filter((part) => part).join('.'),
    };

    const kids = await deref(source, index, node.entries.get('Kids'), signal);
    const subtype = nameOf(node.entries.get('Subtype'));
    const isWidget = subtype === 'Widget' || (kids === undefined && node.entries.has('Rect'));

    if (isWidget) {
      if (!ref) {
        // A widget written directly inside /Fields cannot be named by a page's
        // /Annots, so there is no way to tell which page shows it.
        throw new PdfFormError('A form widget is not an indirect object.');
      }
      widgets.push({ ref, dictionary: node, context });
      return;
    }

    if (!isArray(kids)) {
      throw new PdfFormError(`The form field "${context.name ?? 'unnamed'}" has neither a widget nor kids.`);
    }
    for (const kid of kids.values) {
      if (!isRef(kid)) throw new PdfFormError('A form field kid is not an indirect reference.');
      if (visited.has(refKey(kid.value))) {
        throw new PdfFormError('This document\'s form points back at itself.');
      }
      visited.add(refKey(kid.value));
      const child = await getObject(source, index, kid.value, signal);
      if (!isDict(child)) throw new PdfFormError('A form field kid is not a dictionary.');
      await walk(child, kid.value, context);
    }
  };

  for (const entry of fields) {
    if (!isRef(entry)) throw new PdfFormError('A form field is not an indirect reference.');
    if (visited.has(refKey(entry.value))) {
      throw new PdfFormError('This document\'s form lists the same field twice.');
    }
    visited.add(refKey(entry.value));
    const node = await getObject(source, index, entry.value, signal);
    if (!isDict(node)) throw new PdfFormError('A form field is not a dictionary.');
    await walk(node, entry.value, { fieldType: null, value: undefined, flags: 0, name: null });
  }

  return widgets;
}

/** Which appearance a widget shows, having proved it matches the field's value. */
async function selectAppearance(options: {
  source: PdfSource;
  index: PdfDocumentIndex;
  signal: AbortSignal;
  widget: WidgetTarget;
}): Promise<{ ref: PdfRef; state: string | null } | null> {
  const { source, index, signal, widget } = options;
  const { dictionary, context } = widget;
  const label = context.name ?? 'unnamed';

  const appearances = await deref(source, index, dictionary.entries.get('AP'), signal);
  if (!isDict(appearances)) {
    throw new PdfFormError(`The form field "${label}" has no appearance to flatten.`);
  }
  const normal = appearances.entries.get('N');
  if (normal === undefined) {
    throw new PdfFormError(`The form field "${label}" has no normal appearance to flatten.`);
  }

  const resolved = isRef(normal)
    ? await resolveMaybeStream(source, index, normal.value, signal)
    : { value: normal, stream: null };

  const isButton = context.fieldType === 'Btn'
    && (context.flags & PUSHBUTTON_FLAG) === 0;

  if (resolved.stream) {
    if (isButton) {
      // A checkbox or radio button without appearance states gives no way to
      // tell a ticked box from a clear one, so its value cannot be proved.
      throw new PdfFormError(`The checkbox "${label}" has one appearance and no states.`);
    }
    if (!isRef(normal)) {
      throw new PdfFormError(`The form field "${label}" has an appearance that is not an indirect object.`);
    }
    await assertValueIsShown({ source, index, signal, widget, stream: resolved.stream });
    return { ref: normal.value, state: null };
  }

  if (!isDict(resolved.value)) {
    throw new PdfFormError(`The form field "${label}" has an unreadable normal appearance.`);
  }
  if (!isButton) {
    // Appearance states are a button's on/off vocabulary. On a text or choice
    // field there is no rule saying which one a viewer would draw.
    throw new PdfFormError(`The form field "${label}" has appearance states but is not a button.`);
  }

  const states = resolved.value;
  const selected = nameOf(dictionary.entries.get('AS'));
  if (selected === null) {
    // Required by the spec whenever /AP holds subdictionaries. Without it the
    // displayed state is whatever a given viewer decides, which is exactly the
    // ambiguity flattening exists to remove.
    throw new PdfFormError(`The checkbox "${label}" has appearance states and no /AS naming one.`);
  }

  const value = valueText(context.value) ?? 'Off';
  const expected = states.entries.has(value) ? value : 'Off';
  if (selected !== expected) {
    throw new PdfFormError(
      `The checkbox "${label}" holds "${value}" and displays "${selected}".`,
    );
  }

  const chosen = states.entries.get(selected);
  // A missing /Off appearance is ordinary and means the clear box draws
  // nothing. Any other missing state was ruled out by the check above.
  if (chosen === undefined) return null;
  if (!isRef(chosen)) {
    throw new PdfFormError(`The checkbox "${label}" has a state that is not an indirect object.`);
  }
  return { ref: chosen.value, state: selected };
}

/**
 * Prove the value a text or choice field holds is the value its appearance draws.
 *
 * This is the check that stops a document being sealed around a picture of the
 * wrong answer. The appearance stream was generated by whatever filled the form,
 * and nothing in the file guarantees it was regenerated when the value last
 * changed, so the two are compared rather than assumed to agree.
 */
async function assertValueIsShown(options: {
  source: PdfSource;
  index: PdfDocumentIndex;
  signal: AbortSignal;
  widget: WidgetTarget;
  stream: PdfStream;
}): Promise<void> {
  const { source, index, signal, widget, stream } = options;
  const { context } = widget;
  const label = context.name ?? 'unnamed';

  if (context.fieldType !== 'Tx' && context.fieldType !== 'Ch') return;

  const resolvedValue = await deref(source, index, context.value, signal);
  const wanted: string[] = [];
  if (isArray(resolvedValue)) {
    for (const entry of resolvedValue.values) {
      const text = valueText(entry);
      if (text) wanted.push(text);
    }
  } else {
    const text = valueText(resolvedValue);
    if (text) wanted.push(text);
  }
  if (wanted.length === 0) return;

  if (stream.length > MAX_APPEARANCE_BYTES) {
    throw new PdfFormError(
      `The appearance of "${label}" is larger than ${MAX_APPEARANCE_BYTES} bytes and cannot be checked.`,
    );
  }
  const encoded = await source.read(stream.start, stream.length, signal);
  const shown = compact(shownText(await decodeStream(stream.dictionary, encoded)));

  for (const value of wanted) {
    if (!shown.includes(compact(value))) {
      throw new PdfFormError(`The appearance of the field "${label}" does not show its value.`);
    }
  }
}

/** Every page annotation, mapped back to the page that lists it. */
async function annotationOwners(options: {
  source: PdfSource;
  index: PdfDocumentIndex;
  signal: AbortSignal;
  pages: ResolvedPage[];
}): Promise<Map<string, { page: ResolvedPage; annots: PdfValue[] }>> {
  const { source, index, signal, pages } = options;
  const owners = new Map<string, { page: ResolvedPage; annots: PdfValue[] }>();

  for (const page of pages) {
    const annots = await deref(source, index, page.dictionary.entries.get('Annots'), signal);
    if (!isArray(annots)) continue;
    for (const entry of annots.values) {
      if (isRef(entry)) owners.set(refKey(entry.value), { page, annots: annots.values });
    }
  }
  return owners;
}

/** Per-page accumulation while widgets are placed onto it. */
interface PageWork {
  page: ResolvedPage;
  annots: PdfValue[];
  removed: Set<string>;
  xobjects: PdfDict;
  drew: boolean;
  invocations: string[];
}

/**
 * Plan the objects that flatten every form field in a document.
 *
 * Returns descriptions rather than bytes, so the placement of each appearance
 * can be asserted without composing a file, and so the caller decides when the
 * suffix is built.
 */
export async function planFormFlattening(options: {
  source: PdfSource;
  index: PdfDocumentIndex;
  signal: AbortSignal;
}): Promise<FormFlattenPlan> {
  const { source, index, signal } = options;

  const rootRef = index.trailer.entries.get('Root');
  if (!isRef(rootRef)) throw new PdfFormError('This document has no catalog reference.');
  const catalog = await getObject(source, index, rootRef.value, signal);
  if (!isDict(catalog)) throw new PdfFormError('This document has no catalog.');

  const acroFormValue = catalog.entries.get('AcroForm');
  const acroForm = await deref(source, index, acroFormValue, signal);
  if (!isDict(acroForm)) return { kind: 'no-form' };

  if (acroForm.entries.has('XFA')) {
    // An XFA form's real content is an XML payload this code does not render,
    // and the AcroForm fields beside it are a fallback that may not match it.
    throw new PdfFormError('This document uses an XFA form, which cannot be prepared for signing.');
  }
  const needAppearances = await deref(source, index, acroForm.entries.get('NeedAppearances'), signal);
  if (needAppearances === true) {
    throw new PdfFormError(
      'This document expects its viewer to build the field appearances, so they are not in the file.',
    );
  }

  const fields = await deref(source, index, acroForm.entries.get('Fields'), signal);
  if (!isArray(fields) || fields.values.length === 0) return { kind: 'no-form' };

  const pages = await resolvePages(source, index, signal);
  const owners = await annotationOwners({ source, index, signal, pages });
  const widgets = await collectWidgets({ source, index, signal, fields: fields.values });

  const work = new Map<number, PageWork>();
  const flattened: FlattenedWidget[] = [];

  for (const widget of widgets) {
    const label = widget.context.name ?? 'unnamed';
    if (!widget.context.fieldType) {
      throw new PdfFormError(`The form field "${label}" does not say what kind of field it is.`);
    }
    if (widget.context.fieldType === 'Sig' && widget.context.value !== undefined) {
      // Flattening changes page content, which breaks any signature already on
      // the document. Refused rather than quietly invalidated.
      throw new PdfFormError(`The document is already signed through the field "${label}".`);
    }

    const owner = owners.get(refKey(widget.ref));
    if (!owner) {
      throw new PdfFormError(`The form field "${label}" is not shown on any page of this document.`);
    }

    let entry = work.get(owner.page.index);
    if (!entry) {
      const baseResources = owner.page.resources ?? emptyDict();
      const existing = baseResources.entries.get('XObject');
      entry = {
        page: owner.page,
        annots: owner.annots,
        removed: new Set(),
        xobjects: isDict(existing) ? withEntries(existing, {}) : emptyDict(),
        drew: false,
        invocations: [],
      };
      work.set(owner.page.index, entry);
    }
    entry.removed.add(refKey(widget.ref));

    const flags = await deref(source, index, widget.dictionary.entries.get('F'), signal);
    const annotationFlags = typeof flags === 'number' && Number.isSafeInteger(flags) ? flags : 0;
    if ((annotationFlags & HIDDEN_FLAG) !== 0 || (annotationFlags & NO_VIEW_FLAG) !== 0) {
      // A hidden widget draws nothing, which is provable from the flag alone,
      // so removing it needs no appearance and changes nothing on the page.
      flattened.push({
        pageIndex: owner.page.index,
        fieldName: widget.context.name,
        fieldType: widget.context.fieldType,
        appearanceRef: null,
        appearanceState: null,
        resourceName: null,
        matrix: null,
      });
      continue;
    }

    const selected = await selectAppearance({ source, index, signal, widget });
    if (!selected) {
      flattened.push({
        pageIndex: owner.page.index,
        fieldName: widget.context.name,
        fieldType: widget.context.fieldType,
        appearanceRef: null,
        appearanceState: null,
        resourceName: null,
        matrix: null,
      });
      continue;
    }

    const appearance = await resolveMaybeStream(source, index, selected.ref, signal);
    if (!appearance.stream) {
      throw new PdfFormError(`The appearance of the field "${label}" is not a stream.`);
    }
    const bbox = await readBox(source, index, appearance.stream.dictionary.entries.get('BBox'), signal, '/BBox');
    const matrix = await readMatrix(source, index, appearance.stream.dictionary.entries.get('Matrix'), signal);
    const rect = await readBox(source, index, widget.dictionary.entries.get('Rect'), signal, '/Rect');
    const placement = placementMatrix(rect, bbox, matrix);

    const baseResources = owner.page.resources ?? emptyDict();
    const resourceName = uniqueResourceName(
      withEntries(baseResources, { XObject: entry.xobjects }),
      'ParalegixField',
    );
    entry.xobjects = withEntries(entry.xobjects, { [resourceName]: refValue(selected.ref) });
    entry.drew = true;
    // Wrapped in q/Q so nothing the appearance sets (a colour, a clip, a
    // transform) leaks into whatever the page draws after it.
    entry.invocations.push(
      `q\n${placement.map((n) => serializeValue(n)).join(' ')} cm\n/${resourceName} Do\nQ\n`,
    );

    flattened.push({
      pageIndex: owner.page.index,
      fieldName: widget.context.name,
      fieldType: widget.context.fieldType,
      appearanceRef: selected.ref,
      appearanceState: selected.state,
      resourceName,
      matrix: placement,
    });
  }

  const objects: AppendedObject[] = [];
  let next = nextObjectNumber(index);
  const allocate = (): PdfRef => ({ objectNumber: next++, generationNumber: 0 });

  for (const entry of [...work.values()].sort((a, b) => a.page.index - b.page.index)) {
    const changes: Record<string, PdfValue> = {
      Annots: {
        kind: 'array',
        // Only the flattened widgets go. A link, a stamp or a comment on the
        // same page is unrelated to the form and stays exactly where it was.
        values: entry.annots.filter((value) => !(isRef(value) && entry.removed.has(refKey(value.value)))),
      },
    };

    if (entry.drew) {
      const baseResources = entry.page.resources ?? emptyDict();
      // Materialized onto the leaf when the resources were inherited. Editing
      // the inherited dictionary would add these XObjects to every page sharing it.
      changes.Resources = withEntries(baseResources, { XObject: entry.xobjects });

      const existing = entry.page.dictionary.entries.get('Contents');
      const previous: PdfValue[] = existing === undefined
        ? []
        : (isArray(existing) ? [...existing.values] : [existing]);

      const contents: PdfValue[] = [];
      if (previous.length > 0) {
        // The page's own content is bracketed in q/Q. A content stream that
        // leaves the graphics state changed would otherwise carry that state
        // into the appended marks, and the flattened value lands somewhere else.
        const open = allocate();
        const close = allocate();
        objects.push(streamObject(open, 'q\n'));
        contents.push(refValue(open));
        contents.push(...previous);
        objects.push(streamObject(close, 'Q\n'));
        contents.push(refValue(close));
      }

      const invocation = allocate();
      objects.push(streamObject(invocation, entry.invocations.join('')));
      contents.push(refValue(invocation));
      changes.Contents = { kind: 'array', values: contents };
    }

    objects.push({ ref: entry.page.ref, value: withEntries(entry.page.dictionary, changes) });
  }

  // Every field listed was either flattened or refused, so nothing is left to
  // fill. The rest of the AcroForm is copied through: /DR and /DA are the
  // resources and default appearance a later signature field still needs.
  const updatedAcroForm = withEntries(acroForm, { Fields: { kind: 'array', values: [] } });
  if (isRef(acroFormValue)) {
    objects.push({ ref: acroFormValue.value, value: updatedAcroForm });
  } else {
    objects.push({ ref: rootRef.value, value: withEntries(catalog, { AcroForm: updatedAcroForm }) });
  }

  return { kind: 'flatten', objects, widgets: flattened, nextObjectNumber: next };
}

/** A content stream object, with the `/Length` the writer will need. */
function streamObject(ref: PdfRef, text: string): AppendedObject {
  const bytes = new Uint8Array(Buffer.from(text, 'latin1'));
  return {
    ref,
    value: { kind: 'dict', entries: new Map<string, PdfValue>([['Length', bytes.length]]) },
    streamBytes: bytes,
  };
}

/**
 * Carry the trailer entries an appended revision needs, and nothing else.
 *
 * When the base used a cross-reference STREAM, the index's trailer is that
 * stream's dictionary, and copying it wholesale would write `/Type /XRef`,
 * `/W` and a stale `/Length` into a classic trailer. `/Encrypt` is carried on
 * purpose, so the writer refuses an encrypted document rather than appending to
 * one it cannot encrypt for.
 */
function carryTrailer(index: PdfDocumentIndex): PdfDict {
  const entries = new Map<string, PdfValue>();
  for (const key of ['Root', 'Info', 'ID', 'Size', 'Encrypt']) {
    const value = index.trailer.entries.get(key);
    if (value !== undefined) entries.set(key, value);
  }
  return { kind: 'dict', entries };
}

/**
 * Flatten a document's form and return the bytes to append.
 *
 * A document with no form returns `{ flattened: false }` and no suffix at all.
 * That is the difference between a prepared source that IS the upload and one
 * that merely contains it: an empty appended revision changes the digest, and
 * the completed PDF is required to carry the prepared bytes unchanged.
 */
export async function flattenAcroForm(options: {
  source: PdfSource;
  index: PdfDocumentIndex;
  signal: AbortSignal;
}): Promise<FormFlattenResult> {
  const { source, index, signal } = options;

  const plan = await planFormFlattening({ source, index, signal });
  if (plan.kind === 'no-form') return { flattened: false };

  const update = buildIncrementalUpdate({
    baseSize: source.ref.sizeBytes,
    previousXrefOffset: await readStartXref(source, signal),
    objects: plan.objects,
    trailer: carryTrailer(index),
  });

  return { flattened: true, update, widgets: plan.widgets };
}
