/**
 * Writing an incremental update: the change that makes a 2 GB file signable.
 *
 * A PDF can be edited by APPENDING. The original bytes stay exactly as they
 * were, and new objects, a new cross-reference section and a new trailer are
 * written after them. The trailer's `/Prev` points back at the previous
 * cross-reference, so a reader walks the chain and sees the newest definition of
 * every object.
 *
 * That is why signing a huge document does not require holding it: the base is
 * never read, never rewritten, and never passed through this process. Only the
 * SUFFIX is built here, and a suffix is kilobytes whatever the document weighs.
 *
 * Two rules make or break it:
 *
 * OFFSETS ARE ABSOLUTE, measured from the start of the WHOLE file. The suffix
 * begins at the base's length, so every offset written here is that length plus
 * a position within the suffix. Getting this wrong produces a file that opens
 * in a forgiving viewer and fails verification, which is the worst outcome
 * available: it looks signed.
 *
 * THE BASE IS NEVER CONCATENATED IN NODE. The final object is assembled by the
 * storage service from the untouched base plus the suffix. Joining them here
 * would mean reading the base, which is the whole cost being avoided.
 */
import { AppError } from '../../../shared/errors/AppError';
import type { PdfDict, PdfRef, PdfValue } from './types';

export class PdfWriteError extends AppError {
  constructor(message: string) {
    super(message, 500, 'PDF_WRITE_ERROR');
  }
}

/** One object to append. `body` is the value; the wrapper is written here. */
export interface AppendedObject {
  ref: PdfRef;
  value: PdfValue;
  /** Raw payload for a stream object. Its `/Length` must already be correct. */
  streamBytes?: Uint8Array;
  /**
   * Marks this object as the signature dictionary, and reserves the area the
   * seal is later written into.
   *
   * `/ByteRange` and `/Contents` cannot be written as ordinary values. Both have
   * to keep a FIXED byte width from the moment the suffix is first laid out,
   * because the digest covers everything around them: patching a value that
   * changes width moves every byte after it, and the signature then covers a
   * file that no longer exists. So the writer emits both as padded fields of a
   * width it chooses, and reports where they are. This is the one construct that
   * needs it, which is why it is a named option rather than an escape hatch for
   * raw bytes.
   *
   * `contentsCapacity` is the DER blob size to reserve. The hex area is twice
   * that, plus the two angle brackets.
   */
  signaturePlaceholder?: { contentsCapacity: number };
}

/**
 * Where the two patchable fields ended up, as absolute offsets in the composed
 * file.
 *
 * `contentsStart` addresses the `<`, and `contentsLength` counts both angle
 * brackets, because the hole the ByteRange leaves is the WHOLE hex string
 * token. Excluding a bracket produces a digest that covers a delimiter the
 * signature is supposed to skip, and every verifier disagrees with it.
 */
export interface SignatureArea {
  contentsStart: number;
  contentsLength: number;
  byteRangeStart: number;
  byteRangeLength: number;
}

/** Width of one `/ByteRange` slot. Ten digits addresses just under 10 GB. */
const BYTE_RANGE_FIELD_WIDTH = 10;

/** The largest offset a ten-character field can carry. */
const MAX_SEALABLE_SIZE = 10 ** BYTE_RANGE_FIELD_WIDTH - 1;

/** Smallest useful reservation. A bare RSA-2048 CMS blob is around 2 KB. */
const MIN_CONTENTS_CAPACITY = 1024;

/** Ceiling on the reserved area, so a bad certificate chain cannot inflate it. */
const MAX_CONTENTS_CAPACITY = 128 * 1024;

/**
 * The `[ f f f f ]` region, every slot the same width.
 *
 * `values` of `null` writes the placeholder form. A real value is written left
 * aligned and padded with spaces, which is whitespace between array elements
 * and so parses as the number alone. The region's length never changes.
 */
function byteRangeRegion(values: [number, number, number, number] | null): string {
  const fields = (values ?? [0, 0, 0, 0]).map((value) => {
    if (values === null) return '0'.repeat(BYTE_RANGE_FIELD_WIDTH);
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SEALABLE_SIZE) {
      throw new PdfWriteError(`A /ByteRange value of ${value} does not fit a ${BYTE_RANGE_FIELD_WIDTH}-digit field.`);
    }
    return String(value).padEnd(BYTE_RANGE_FIELD_WIDTH, ' ');
  });
  return `[ ${fields.join(' ')} ]`;
}

/**
 * Rewrite the `/ByteRange` of an already-built suffix, in place.
 *
 * This runs BEFORE the digest, never after. The ByteRange states which bytes
 * the signature covers, so a digest taken before it is written covers a
 * different file than the one a verifier reconstructs from the final bytes.
 *
 * The replacement is length-checked against the region it overwrites rather
 * than trusted to be the same width, because a silent length change here is
 * exactly the failure that produces a document that looks signed and verifies
 * nowhere.
 */
export function patchByteRange(
  suffix: Uint8Array,
  area: SignatureArea,
  baseSize: number,
  values: [number, number, number, number],
): void {
  const text = byteRangeRegion(values);
  if (text.length !== area.byteRangeLength) {
    throw new PdfWriteError(`The /ByteRange replacement is ${text.length} bytes, but ${area.byteRangeLength} are reserved.`);
  }
  const at = area.byteRangeStart - baseSize;
  if (at < 0 || at + text.length > suffix.length) {
    throw new PdfWriteError('The /ByteRange field is not inside this suffix.');
  }
  suffix.set(Buffer.from(text, 'latin1'), at);
}

/**
 * Write the seal into the reserved hex area, in place.
 *
 * `hex` must already fill the whole reservation, zero padded. The token's
 * length is covered by the ByteRange that was digested before this ran, so
 * writing a shorter token moves every byte after it and invalidates the
 * signature being written. That is checked here rather than trusted, because
 * the result of getting it wrong is a document that opens and verifies nowhere.
 */
export function patchSignature(
  suffix: Uint8Array,
  area: SignatureArea,
  baseSize: number,
  hex: string,
): void {
  if (hex.length !== area.contentsLength - 2) {
    throw new PdfWriteError(`The seal is ${hex.length} hex characters and ${area.contentsLength - 2} are reserved.`);
  }
  if (!/^[0-9a-f]*$/.test(hex)) throw new PdfWriteError('A seal must be lowercase hexadecimal.');
  const at = area.contentsStart - baseSize;
  if (at < 0 || at + area.contentsLength > suffix.length) {
    throw new PdfWriteError('The /Contents field is not inside this suffix.');
  }
  suffix.set(Buffer.from(`<${hex}>`, 'latin1'), at);
}

export interface IncrementalUpdate {
  /** The bytes to append. The base is untouched and is not included. */
  suffix: Uint8Array;
  /** Absolute offset of the new cross-reference section. */
  xrefOffset: number;
  /** Total size once base and suffix are composed. */
  totalSize: number;
  /** Present when one object reserved a signature area. */
  signature?: SignatureArea;
}

/**
 * Build the binary payload for an uncompressed cross-reference stream.
 *
 * Each entry is three fields: type (1 byte), offset (N bytes), generation
 * (2 bytes), giving widths [1, N, 2]. Type 0 is free, type 1 is in-use.
 * An uncompressed stream is valid and avoids a zlib round-trip in the writer.
 * Every viewer that handles xref streams handles uncompressed ones.
 */
function buildXrefStreamPayload(
  entries: Array<{ objectNumber: number; offset: number; generationNumber: number; free?: boolean }>,
  offsetWidth: number,
): Uint8Array {
  const rowWidth = 1 + offsetWidth + 2;
  const buf = new Uint8Array(entries.length * rowWidth);
  let pos = 0;
  for (const entry of entries) {
    buf[pos] = entry.free ? 0 : 1;
    pos += 1;
    let offset = entry.offset;
    for (let i = offsetWidth - 1; i >= 0; i -= 1) {
      buf[pos + i] = offset & 0xff;
      offset = Math.floor(offset / 256);
    }
    pos += offsetWidth;
    buf[pos] = (entry.generationNumber >> 8) & 0xff;
    buf[pos + 1] = entry.generationNumber & 0xff;
    pos += 2;
  }
  return buf;
}

const NEWLINE = 0x0a;

/** Escape what a literal string may not carry raw. */
function serializeString(bytes: Uint8Array): string {
  let out = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b === 0x0a) out += '\\n';
    else if (b === 0x0d) out += '\\r';
    else if (b < 0x20 || b > 0x7e) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
}

/** A name, with anything outside the regular set written as `#xx`. */
function serializeName(value: string): string {
  let out = '/';
  for (const ch of Buffer.from(value, 'latin1')) {
    const regular = ch > 0x20 && ch < 0x7f
      && ![0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25, 0x23].includes(ch);
    out += regular ? String.fromCharCode(ch) : `#${ch.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/**
 * One PDF value as bytes.
 *
 * Only structured values and stream descriptors are serializable. There is no
 * escape hatch for raw text, because a caller that can inject arbitrary bytes
 * into the object graph can write a cross-reference that says anything.
 */
export function serializeValue(value: PdfValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PdfWriteError(`Cannot write the number ${value}.`);
    // PDF has no exponent notation. `1e-7` written raw is not a number a reader
    // will accept, and a viewer that shrugs at it is not the one verifying.
    return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  }
  switch (value.kind) {
    case 'name': return serializeName(value.value);
    case 'string': return serializeString(value.bytes);
    case 'ref': return `${value.value.objectNumber} ${value.value.generationNumber} R`;
    case 'array': return `[ ${value.values.map(serializeValue).join(' ')} ]`;
    case 'dict': {
      const parts: string[] = [];
      for (const [key, entry] of value.entries) {
        parts.push(`${serializeName(key)} ${serializeValue(entry)}`);
      }
      return `<< ${parts.join(' ')} >>`;
    }
    default:
      throw new PdfWriteError('Cannot write this value.');
  }
}

/** Copy a dictionary with some entries replaced. The original is not mutated. */
export function withEntries(dictionary: PdfDict, changes: Record<string, PdfValue>): PdfDict {
  const entries = new Map(dictionary.entries);
  for (const [key, value] of Object.entries(changes)) entries.set(key, value);
  return { kind: 'dict', entries };
}

/**
 * Build the bytes to append to a document.
 *
 * `baseSize` is the length of the untouched original, which is where the suffix
 * starts. Every offset written is absolute, so a reader opening the composed
 * file finds each object where the table says.
 *
 * `previousXrefOffset` becomes `/Prev`, which is what chains this revision to
 * the one before it. Omitting it orphans every earlier object.
 *
 * `xrefStyle` controls the cross-reference form this revision emits. Leave it
 * as `'classic'` (the default) for sources that already use classic tables.
 * Pass `'stream'` when the source uses cross-reference streams (PDF 1.5+,
 * typical of Word/Adobe output) so the revision's xref form matches the
 * source's. Apple CoreGraphics fails when a chain mixes both styles: a classic
 * table revision appended to a stream-based source causes the renderer to lose
 * the page tree, blanking every page except those in the incremental revision.
 */
export function buildIncrementalUpdate(options: {
  baseSize: number;
  previousXrefOffset: number;
  objects: AppendedObject[];
  /** Carried forward from the base: Root, Info, ID, Size. Encrypt is refused. */
  trailer: PdfDict;
  /**
   * The cross-reference form to emit. Defaults to `'classic'` (plain
   * `xref ... trailer` block). Use `'stream'` when the source document uses
   * PDF 1.5+ cross-reference streams so the chain stays uniform and Apple
   * CoreGraphics can walk it.
   */
  xrefStyle?: 'classic' | 'stream';
}): IncrementalUpdate {
  const { baseSize, previousXrefOffset, objects, trailer } = options;
  const xrefStyle = options.xrefStyle ?? 'classic';

  if (!Number.isSafeInteger(baseSize) || baseSize <= 0) {
    throw new PdfWriteError(`Invalid base size ${baseSize}.`);
  }
  if (!Number.isSafeInteger(previousXrefOffset) || previousXrefOffset < 0 || previousXrefOffset >= baseSize) {
    throw new PdfWriteError(`The previous cross-reference offset (${previousXrefOffset}) is not inside the base.`);
  }
  if (objects.length === 0) throw new PdfWriteError('An incremental update with no objects changes nothing.');
  if (trailer.entries.has('Encrypt')) {
    // An encrypted document's strings and streams are encrypted with a key this
    // writer does not have, so anything appended would be unreadable to a
    // viewer that decrypts the rest. Refused at admission, and again here.
    throw new PdfWriteError('An encrypted document cannot be signed incrementally.');
  }
  if (!trailer.entries.has('Root')) {
    throw new PdfWriteError('The trailer has no /Root, so the appended revision would have no catalog.');
  }

  const seen = new Set<number>();
  let placeholders = 0;
  for (const obj of objects) {
    if (!Number.isSafeInteger(obj.ref.objectNumber) || obj.ref.objectNumber <= 0) {
      throw new PdfWriteError(`Invalid object number ${obj.ref.objectNumber}.`);
    }
    if (seen.has(obj.ref.objectNumber)) {
      // Two definitions of one object in a single revision: the table can only
      // point at one, so the other is silently lost.
      throw new PdfWriteError(`Object ${obj.ref.objectNumber} is written twice in one update.`);
    }
    seen.add(obj.ref.objectNumber);
    if (!obj.signaturePlaceholder) continue;
    placeholders += 1;
    if (placeholders > 1) {
      // Two reserved areas means two holes, and a ByteRange describes exactly
      // one. The second signature would cover the first one's bytes.
      throw new PdfWriteError('An incremental update can reserve only one signature area.');
    }
    if (obj.streamBytes) throw new PdfWriteError('A signature dictionary is not a stream.');
    if (typeof obj.value !== 'object' || obj.value === null || obj.value.kind !== 'dict') {
      throw new PdfWriteError('A signature placeholder must be a dictionary.');
    }
    for (const reserved of ['Contents', 'ByteRange']) {
      if (obj.value.entries.has(reserved)) {
        // Written by this function at a fixed width. A caller-supplied value
        // would be the wrong width and would be overwritten anyway.
        throw new PdfWriteError(`/${reserved} is written by the writer and cannot be supplied.`);
      }
    }
    const capacity = obj.signaturePlaceholder.contentsCapacity;
    if (!Number.isSafeInteger(capacity) || capacity < MIN_CONTENTS_CAPACITY || capacity > MAX_CONTENTS_CAPACITY) {
      throw new PdfWriteError(
        `A reserved signature area of ${capacity} bytes is outside `
          + `${MIN_CONTENTS_CAPACITY}..${MAX_CONTENTS_CAPACITY}.`,
      );
    }
  }

  const chunks: Buffer[] = [];
  let position = 0;
  const push = (buffer: Buffer) => { chunks.push(buffer); position += buffer.length; };

  // A leading newline, because the base may not end with one and `12 0 obj`
  // glued to `%%EOF` is not a token a reader can find.
  push(Buffer.from([NEWLINE]));

  const offsets = new Map<number, number>();
  const ordered = [...objects].sort((a, b) => a.ref.objectNumber - b.ref.objectNumber);
  let signature: SignatureArea | undefined;

  for (const obj of ordered) {
    // Absolute: from the start of the COMPOSED file, not of the suffix.
    offsets.set(obj.ref.objectNumber, baseSize + position);
    push(Buffer.from(`${obj.ref.objectNumber} ${obj.ref.generationNumber} obj\n`, 'latin1'));
    if (obj.signaturePlaceholder) {
      signature = pushSignatureDictionary(push, () => baseSize + position, obj.value as PdfDict, obj.signaturePlaceholder.contentsCapacity);
    } else {
      push(Buffer.from(`${serializeValue(obj.value)}\n`, 'latin1'));
    }
    if (obj.streamBytes) {
      push(Buffer.from('stream\n', 'latin1'));
      push(Buffer.from(obj.streamBytes));
      push(Buffer.from('\nendstream\n', 'latin1'));
    }
    push(Buffer.from('endobj\n', 'latin1'));
  }

  const xrefOffset = baseSize + position;

  const maxObject = Math.max(...ordered.map((o) => o.ref.objectNumber));
  const previousSize = trailer.entries.get('Size');
  const size = Math.max(
    typeof previousSize === 'number' ? previousSize : 0,
    maxObject + 1,
  );

  if (xrefStyle === 'stream') {
    // An incremental cross-reference STREAM. The stream object's dictionary
    // doubles as the trailer (it carries /Root, /Prev, /Size, etc.), so there
    // is no separate `trailer` keyword. The object number is the next free one
    // after all appended content; it is itself free-listed in the stream so a
    // reader that walks this revision sees it deleted in the PREVIOUS revision's
    // index and ignores the tombstone. In practice viewers index the stream by
    // its own object number and are not confused by finding it referenced.
    //
    // Offset width: how many bytes are needed to represent the largest offset in
    // this revision. All offsets are absolute, so the base size plus a small
    // suffix. Four bytes (up to ~4 GB) is almost always sufficient; five covers
    // the 10 GB maximum this writer can address.
    const xrefObjectNumber = size; // first unused number
    const allEntries = [
      ...ordered.map((o) => ({
        objectNumber: o.ref.objectNumber,
        offset: offsets.get(o.ref.objectNumber)!,
        generationNumber: o.ref.generationNumber,
      })),
      // The xref stream object itself, in-use at xrefOffset.
      { objectNumber: xrefObjectNumber, offset: xrefOffset, generationNumber: 0 },
    ].sort((a, b) => a.objectNumber - b.objectNumber);

    const maxOffset = Math.max(...allEntries.map((e) => e.offset));
    let offsetWidth = 1;
    while (offsetWidth < 5 && maxOffset >= 256 ** offsetWidth) offsetWidth += 1;

    const payload = buildXrefStreamPayload(allEntries, offsetWidth);

    // The xref stream's dictionary IS the trailer for this revision.
    const xrefDict = withEntries(trailer, {
      Type: { kind: 'name', value: 'XRef' },
      Size: xrefObjectNumber + 1,
      Prev: previousXrefOffset,
      W: { kind: 'array', values: [1, offsetWidth, 2] },
      // /Index covers exactly the ranges we write; without it the reader assumes
      // "0 /Size" and expects entries for every object 0..Size-1.
      Index: {
        kind: 'array',
        values: allEntries.flatMap((_, i, arr) => {
          // Emit an /Index pair for each consecutive run.
          if (i > 0 && arr[i].objectNumber === arr[i - 1].objectNumber + 1) return [];
          let len = 1;
          while (i + len < arr.length && arr[i + len].objectNumber === arr[i].objectNumber + len) len += 1;
          return [arr[i].objectNumber, len];
        }),
      },
      Length: payload.length,
    });

    push(Buffer.from(`${xrefObjectNumber} 0 obj\n`, 'latin1'));
    push(Buffer.from(`${serializeValue(xrefDict)}\nstream\n`, 'latin1'));
    push(Buffer.from(payload));
    push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
  } else {
    // A classic table. The reader handles both forms. Classic is the safe
    // default for sources that do not use xref streams, because it keeps the
    // appended revision readable by anything that opened the base.
    push(Buffer.from('xref\n', 'latin1'));
    for (const group of groupConsecutive(ordered.map((o) => o.ref.objectNumber))) {
      push(Buffer.from(`${group[0]} ${group.length}\n`, 'latin1'));
      for (const number of group) {
        const obj = ordered.find((o) => o.ref.objectNumber === number)!;
        const offset = String(offsets.get(number)).padStart(10, '0');
        const generation = String(obj.ref.generationNumber).padStart(5, '0');
        // Exactly 20 bytes per entry, including the two-character terminator. A
        // reader indexes into this table by multiplication.
        push(Buffer.from(`${offset} ${generation} n \n`, 'latin1'));
      }
    }

    const newTrailer = withEntries(trailer, {
      Size: size,
      // Chains this revision to the one before. Without it every earlier object
      // is orphaned and the document is only what this update wrote.
      Prev: previousXrefOffset,
    });
    push(Buffer.from(`trailer\n${serializeValue(newTrailer)}\n`, 'latin1'));
  }

  push(Buffer.from(`startxref\n${xrefOffset}\n%%EOF\n`, 'latin1'));

  const suffix = Buffer.concat(chunks, position);
  const totalSize = baseSize + suffix.length;
  if (totalSize > MAX_SEALABLE_SIZE) {
    // Past this the /ByteRange fields cannot address the end of the file, so a
    // seal would be written over a range it cannot describe.
    throw new PdfWriteError(`A composed size of ${totalSize} bytes cannot be addressed by a /ByteRange.`);
  }
  return { suffix: new Uint8Array(suffix), xrefOffset, totalSize, signature };
}

/**
 * Write the signature dictionary and report where its two fixed fields are.
 *
 * The entries the caller supplied are serialized normally. The two that cannot
 * be are written afterwards, in a known order, so their offsets are known the
 * moment they are pushed rather than recovered later by searching the bytes for
 * a pattern. Searching would be one more place to be subtly wrong, and being
 * subtly wrong here produces a document that opens and does not verify.
 */
function pushSignatureDictionary(
  push: (buffer: Buffer) => void,
  absolute: () => number,
  dictionary: PdfDict,
  contentsCapacity: number,
): SignatureArea {
  const entries: string[] = [];
  for (const [key, value] of dictionary.entries) {
    entries.push(`${serializeName(key)} ${serializeValue(value)}`);
  }
  push(Buffer.from(`<< ${entries.join(' ')} /ByteRange `, 'latin1'));

  const byteRangeStart = absolute();
  const region = byteRangeRegion(null);
  push(Buffer.from(region, 'latin1'));

  push(Buffer.from(' /Contents ', 'latin1'));
  const contentsStart = absolute();
  // Zeros, not spaces. The area is a hex string until the seal replaces it, and
  // a reader that opens the document before it is sealed sees an empty
  // signature rather than a syntax error.
  const contentsLength = contentsCapacity * 2 + 2;
  push(Buffer.from(`<${'0'.repeat(contentsCapacity * 2)}>`, 'latin1'));
  push(Buffer.from(' >>\n', 'latin1'));

  return { contentsStart, contentsLength, byteRangeStart, byteRangeLength: region.length };
}

/** Runs of consecutive numbers, which is how an xref section is subdivided. */
function groupConsecutive(numbers: number[]): number[][] {
  const groups: number[][] = [];
  for (const n of numbers) {
    const last = groups[groups.length - 1];
    if (last && n === last[last.length - 1] + 1) last.push(n);
    else groups.push([n]);
  }
  return groups;
}
