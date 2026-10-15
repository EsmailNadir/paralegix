/**
 * Finding objects in a stored PDF without loading it.
 *
 * A PDF ends with a cross-reference table saying where every object lives, and
 * a document that has been edited carries a CHAIN of them: each revision points
 * back at the one before with `/Prev`. Reading a document therefore means
 * reading a few small windows near the end, not the file.
 *
 * The rules here are all about not letting a document steer the reader:
 *
 * REVISIONS ARE NEWEST FIRST, and the first definition of an object wins. A
 * later revision that deleted an object records a free-entry tombstone, and
 * honouring that is what stops an older version of a signed page being
 * resurrected by walking past it.
 *
 * GENERATIONS MUST MATCH. `12 0 R` and `12 1 R` are different objects. Ignoring
 * the generation lets a freed and reused object number resolve to whatever
 * happens to sit there now.
 *
 * EVERY OFFSET IS CHECKED against the document size before it is used. An xref
 * entry is a number the file chose, and an unchecked one is an out-of-range
 * read at best.
 *
 * There is no recovery scan. When the structure does not parse, this refuses.
 * Rebuilding an xref by searching the file for `obj` means reading all of it,
 * which is the cost the whole design exists to avoid, and it means trusting
 * bytes that already proved untrustworthy.
 */
import { AppError } from '../../../shared/errors/AppError';
import { decodeStream, MAX_ENCODED_BYTES } from './filters';
import { Lexer, PdfSyntaxError } from './lexer';
import type { PdfDict, PdfRef, PdfSource, PdfStream, PdfValue } from './types';

/** Bytes read from the tail when looking for `startxref`. */
const TAIL_WINDOW = 2048;

/** Revisions the `/Prev` chain may have. A cycle or a chain of thousands is refused. */
export const MAX_REVISIONS = Number(process.env.PDF_MAX_REVISIONS) || 64;

/** Entries the whole cross-reference may hold, across every revision. */
/**
 * The byte budget for one document's cross-reference index.
 *
 * The index is the one structure here whose size follows the document rather
 * than the window being read, so it is the one that can still put a large PDF
 * on the heap after every other read was bounded. A `Map` entry with a small
 * object value costs about 77 bytes measured, so this budget is what actually
 * decides the entry ceiling below. The container is 512 MiB with Node's heap
 * inside it, so 48 MiB of index is generous and 400 MiB is not survivable.
 */
export const MAX_XREF_BYTES = Number(process.env.PDF_MAX_XREF_BYTES) || 48 * 1024 * 1024;

/** Measured cost of one entry in the index, used to turn the budget into a count. */
const XREF_ENTRY_BYTES = 96;

/**
 * The most objects one document may declare.
 *
 * Derived from the byte budget rather than chosen, because a count picked on
 * its own is a guess about memory that nothing checks. For scale: a 3 GB
 * scanned document runs to a few tens of thousands of objects, and a
 * 10,000-page text document to a few hundred thousand, so this refuses nothing
 * anyone actually signs. A document past it gets an explicit refusal, never a
 * silent truncation.
 */
export const MAX_XREF_ENTRIES = Number(process.env.PDF_MAX_XREF_ENTRIES)
  || Math.floor(MAX_XREF_BYTES / XREF_ENTRY_BYTES);

/** The most one object's definition may span. */
const MAX_OBJECT_BYTES = Number(process.env.PDF_MAX_OBJECT_BYTES) || 2 * 1024 * 1024;

export class PdfStructureError extends AppError {
  constructor(message: string, code = 'PDF_STRUCTURE_ERROR') {
    super(message, 400, code);
  }
}

/** Where one object lives, or that it was freed. */
export interface XrefEntry {
  objectNumber: number;
  generationNumber: number;
  /** Byte offset of the definition, or null for a free entry or a compressed one. */
  offset: number | null;
  /**
   * For an object stored INSIDE an object stream: which stream, and where in it.
   *
   * Kept separate from `offset` because it is not a file offset. Conflating the
   * two would send a read to an arbitrary place in the document.
   */
  inObjectStream?: { streamObjectNumber: number; indexInStream: number };
}

export interface PdfDocumentIndex {
  /** Object number to entry. The NEWEST definition wins. */
  entries: Map<number, XrefEntry>;
  trailer: PdfDict;
  revisions: number;
  /**
   * Decoded object streams, by container object number, for the life of THIS
   * index. An index is built per operation and dropped with it, which bounds
   * the cache in time; `budgetBytes` bounds it in space. Map order is
   * insertion order, which is the eviction order. Created on first use, so an
   * index built by hand in a test needs none.
   */
  objectStreams?: ObjectStreamCache;
}

interface ObjectStreamCache {
  entries: Map<number, { container: PdfStream; decoded: Uint8Array }>;
  bytes: number;
  budgetBytes: number;
}

/**
 * The most decoded object-stream data one index keeps. 16 MiB.
 *
 * A modern PDF keeps most small objects, page dictionaries included, packed
 * into object streams of a few hundred objects each. Without a cache, resolving
 * a 1,000-page tree re-read and re-inflated the same container for every page
 * it held. Four containers at the 4 MiB a real producer writes fit here; a
 * single container past the budget is decoded per object, as before, rather
 * than evicting everything else to make room.
 */
export const OBJECT_STREAM_CACHE_BYTES = Number(process.env.PDF_OBJECT_STREAM_CACHE_BYTES) || 16 * 1024 * 1024;

const asDict = (value: PdfValue): PdfDict | null =>
  (value && typeof value === 'object' && (value as any).kind === 'dict') ? value as PdfDict : null;

/** Read a window and hand back a lexer over it. */
async function window(source: PdfSource, start: number, length: number, signal: AbortSignal) {
  const capped = Math.min(length, source.ref.sizeBytes - start);
  if (capped <= 0) throw new PdfStructureError(`Nothing to read at offset ${start}.`);
  return new Lexer(await source.read(start, capped, signal));
}

/**
 * The window an object read STARTS at, before it grows.
 *
 * Almost every object is a dictionary of a few hundred bytes. Reading the full
 * ceiling for each one is bounded, so it never threatens memory, and it is
 * still enormously wasteful: resolving a thousand-page tree would transfer
 * gigabytes to read a few hundred kilobytes of dictionaries. The window grows
 * only when what it holds does not parse.
 */
const FIRST_WINDOW_BYTES = Number(process.env.PDF_FIRST_WINDOW_BYTES) || 16 * 1024;

/**
 * Parse at `start`, widening the window until the value fits or the ceiling is
 * reached.
 *
 * A truncated window and a malformed object both surface as a syntax error, and
 * telling them apart from here would mean teaching the lexer to distinguish
 * "ran out of input" from "this is not a PDF value" at every call site. Growing
 * instead costs one extra read on a genuinely malformed object, which is a page
 * nobody can sign either way, and saves a whole window on every good one.
 */
async function readAt<T>(
  source: PdfSource,
  start: number,
  signal: AbortSignal,
  parse: (lexer: Lexer) => T,
): Promise<T> {
  const remaining = source.ref.sizeBytes - start;
  let size = Math.min(FIRST_WINDOW_BYTES, remaining, MAX_OBJECT_BYTES);
  for (;;) {
    const lexer = await window(source, start, size, signal);
    try {
      return parse(lexer);
    } catch (err: any) {
      const ceiling = Math.min(remaining, MAX_OBJECT_BYTES);
      if (size >= ceiling || !(err instanceof PdfSyntaxError)) throw err;
      size = Math.min(size * 8, ceiling);
    }
  }
}

/**
 * The byte offset of the last cross-reference section.
 *
 * Read from a bounded TAIL window. A document that does not end with a
 * `startxref` is refused rather than searched, because searching means reading
 * the whole file.
 */
export async function readStartXref(source: PdfSource, signal: AbortSignal): Promise<number> {
  const size = source.ref.sizeBytes;
  const start = Math.max(0, size - TAIL_WINDOW);
  const bytes = await source.read(start, size - start, signal);
  const text = Buffer.from(bytes).toString('latin1');

  const at = text.lastIndexOf('startxref');
  if (at < 0) {
    throw new PdfStructureError('This file does not end with a cross-reference pointer.');
  }
  const match = /startxref\s+(\d+)/.exec(text.slice(at));
  if (!match) throw new PdfStructureError('The cross-reference pointer is malformed.');

  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) {
    throw new PdfStructureError(`The cross-reference pointer (${match[1]}) is outside the file.`);
  }
  return offset;
}

/**
 * Parse one classic `xref` section and its trailer.
 *
 * Returns the entries it declares plus the trailer dictionary, which is where
 * `/Prev` lives.
 */
async function readClassicSection(
  source: PdfSource,
  offset: number,
  signal: AbortSignal,
): Promise<{ entries: XrefEntry[]; trailer: PdfDict }> {
  const lexer = await window(source, offset, MAX_OBJECT_BYTES, signal);
  lexer.expectKeyword('xref');

  const entries: XrefEntry[] = [];
  for (;;) {
    lexer.skipSpace();
    if (lexer.peekKeyword() === 'trailer') break;

    const first = lexer.readValue();
    const count = lexer.readValue();
    if (typeof first !== 'number' || typeof count !== 'number'
      || !Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count < 0) {
      throw new PdfStructureError('A cross-reference subsection header is malformed.');
    }
    if (entries.length + count > MAX_XREF_ENTRIES) {
      throw new PdfStructureError(
        `This document declares more than ${MAX_XREF_ENTRIES} objects, which is more index than `
          + `the ${Math.round(MAX_XREF_BYTES / (1024 * 1024))} MiB budget holds.`,
        'PDF_RESOURCE_LIMIT',
      );
    }

    for (let i = 0; i < count; i += 1) {
      const entryOffset = lexer.readValue();
      const generation = lexer.readValue();
      lexer.skipSpace();
      const kind = lexer.peekKeyword();
      lexer.expectKeyword(kind);
      if (typeof entryOffset !== 'number' || typeof generation !== 'number') {
        throw new PdfStructureError('A cross-reference entry is malformed.');
      }
      if (kind !== 'n' && kind !== 'f') {
        throw new PdfStructureError(`A cross-reference entry is marked "${kind}".`);
      }
      entries.push({
        objectNumber: first + i,
        generationNumber: generation,
        // A free entry is a TOMBSTONE, not an absence. Kept, because it is what
        // stops an older revision's definition of this object being used.
        offset: kind === 'f' ? null : entryOffset,
      });
    }
  }

  lexer.expectKeyword('trailer');
  const trailer = asDict(lexer.readValue());
  if (!trailer) throw new PdfStructureError('The trailer is not a dictionary.');
  return { entries, trailer };
}

/**
 * One cross-reference section, whichever of the two forms it takes.
 *
 * A PDF 1.5 document replaces the classic `xref` table with an OBJECT that holds
 * the same information, compressed. Both are still in use, often in the same
 * file, so a reader that handles only one refuses most modern documents.
 */
async function readSection(
  source: PdfSource,
  offset: number,
  signal: AbortSignal,
): Promise<{ entries: XrefEntry[]; trailer: PdfDict }> {
  const probe = await window(source, offset, Math.min(64, source.ref.sizeBytes - offset), signal);
  probe.skipSpace();
  return probe.peekKeyword() === 'xref'
    ? readClassicSection(source, offset, signal)
    : readXrefStreamSection(source, offset, signal);
}

/**
 * A cross-reference STREAM: the same table, as a compressed object.
 *
 * `/W` gives the byte width of each of the three fields per entry, and `/Index`
 * says which object numbers the entries cover. Both come from the document, so
 * both are checked: a width of zero for the type field means "assume type 1",
 * which is in the spec, but an entry that does not fit its declared widths is a
 * refusal.
 *
 * The stream's own dictionary IS the trailer, which is where `/Prev` lives, so
 * the chain walk above works the same way for both forms.
 */
async function readXrefStreamSection(
  source: PdfSource,
  offset: number,
  signal: AbortSignal,
): Promise<{ entries: XrefEntry[]; trailer: PdfDict }> {
  const lexer = await window(source, offset, MAX_OBJECT_BYTES, signal);
  lexer.readValue();
  lexer.readValue();
  lexer.expectKeyword('obj');

  const dictionary = asDict(lexer.readValue());
  if (!dictionary) throw new PdfStructureError('A cross-reference stream has no dictionary.');
  lexer.skipSpace();
  if (lexer.peekKeyword() !== 'stream') {
    throw new PdfStructureError('This offset is neither an xref table nor an xref stream.');
  }
  lexer.expectKeyword('stream');

  let payloadStart = offset + lexer.offset;
  const eol = await source.read(payloadStart, Math.min(2, source.ref.sizeBytes - payloadStart), signal);
  if (eol[0] === 0x0d && eol[1] === 0x0a) payloadStart += 2;
  else if (eol[0] === 0x0a) payloadStart += 1;
  else throw new PdfStructureError('A stream keyword is not followed by a line ending.');

  const length = dictionary.entries.get('Length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    // An INDIRECT /Length cannot be resolved here: resolving it needs the index
    // this section is building. A cross-reference stream is required to use a
    // direct length for exactly that reason.
    throw new PdfStructureError('A cross-reference stream needs a direct /Length.');
  }
  if (length > MAX_ENCODED_BYTES) {
    throw new PdfStructureError(`A cross-reference stream is larger than ${MAX_ENCODED_BYTES} bytes.`);
  }
  if (payloadStart + length > source.ref.sizeBytes) {
    throw new PdfStructureError('A cross-reference stream runs past the end of the file.');
  }

  const decoded = await decodeStream(dictionary, await source.read(payloadStart, length, signal));

  const widths = dictionary.entries.get('W');
  if (!widths || typeof widths !== 'object' || (widths as any).kind !== 'array') {
    throw new PdfStructureError('A cross-reference stream has no /W widths.');
  }
  const w = (widths as any).values.map((v: PdfValue) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 8) {
      throw new PdfStructureError('A /W width is not a small non-negative integer.');
    }
    return v;
  });
  if (w.length < 3) throw new PdfStructureError('/W does not describe three fields.');

  const entryWidth = w[0] + w[1] + w[2];
  if (entryWidth === 0) throw new PdfStructureError('/W describes a zero-width entry.');
  if (decoded.length % entryWidth !== 0) {
    throw new PdfStructureError('A cross-reference stream is not a whole number of entries.');
  }

  // `/Index` is pairs of (first object number, count). Absent, it covers
  // `0 /Size`, which is the common single-range case.
  const declaredSize = dictionary.entries.get('Size');
  const index = dictionary.entries.get('Index');
  let ranges: Array<[number, number]>;
  if (index === undefined) {
    if (typeof declaredSize !== 'number' || !Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      throw new PdfStructureError('A cross-reference stream has no usable /Size.');
    }
    ranges = [[0, declaredSize]];
  } else {
    if (typeof index !== 'object' || (index as any).kind !== 'array' || (index as any).values.length % 2 !== 0) {
      throw new PdfStructureError('/Index is not a list of first/count pairs.');
    }
    ranges = [];
    const values = (index as any).values as PdfValue[];
    for (let i = 0; i < values.length; i += 2) {
      const first = values[i];
      const count = values[i + 1];
      if (typeof first !== 'number' || typeof count !== 'number'
        || !Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count < 0) {
        throw new PdfStructureError('An /Index pair is not two non-negative integers.');
      }
      ranges.push([first, count]);
    }
  }

  const declared = ranges.reduce((sum, [, count]) => sum + count, 0);
  if (declared * entryWidth !== decoded.length) {
    throw new PdfStructureError('A cross-reference stream declares more entries than it holds.');
  }
  if (declared > MAX_XREF_ENTRIES) {
    throw new PdfStructureError(
      `This document declares more than ${MAX_XREF_ENTRIES} objects, which is more index than `
        + `the ${Math.round(MAX_XREF_BYTES / (1024 * 1024))} MiB budget holds.`,
      'PDF_RESOURCE_LIMIT',
    );
  }

  const readField = (at: number, width: number, fallback: number): number => {
    if (width === 0) return fallback;
    let value = 0;
    for (let i = 0; i < width; i += 1) value = value * 256 + decoded[at + i];
    return value;
  };

  const entries: XrefEntry[] = [];
  let cursor = 0;
  for (const [first, count] of ranges) {
    for (let i = 0; i < count; i += 1) {
      // A zero-width type field means type 1, per the spec.
      const type = readField(cursor, w[0], 1);
      const second = readField(cursor + w[0], w[1], 0);
      const third = readField(cursor + w[0] + w[1], w[2], 0);
      cursor += entryWidth;

      if (type === 0) {
        // Free: a tombstone, kept so an earlier revision's definition stays
        // hidden.
        entries.push({ objectNumber: first + i, generationNumber: third, offset: null });
      } else if (type === 1) {
        entries.push({ objectNumber: first + i, generationNumber: third, offset: second });
      } else if (type === 2) {
        // Inside an object stream. `second` names the containing stream and
        // `third` is the position within it, NEITHER of which is a file offset,
        // so they are recorded separately.
        entries.push({
          objectNumber: first + i,
          generationNumber: 0,
          offset: null,
          inObjectStream: { streamObjectNumber: second, indexInStream: third },
        });
      } else {
        throw new PdfStructureError(`A cross-reference entry has unknown type ${type}.`);
      }
    }
  }

  return { entries, trailer: dictionary };
}

/**
 * Walk the revision chain and build one index.
 *
 * Newest first, and the first definition of an object number wins, so a later
 * revision always overrides an earlier one and a tombstone hides what came
 * before it.
 */
export async function readDocumentIndex(
  source: PdfSource,
  signal: AbortSignal,
): Promise<PdfDocumentIndex> {
  const entries = new Map<number, XrefEntry>();
  let trailer: PdfDict | null = null;
  let revisions = 0;

  const seen = new Set<number>();
  let offset: number | null = await readStartXref(source, signal);

  while (offset !== null) {
    // A `/Prev` pointing at a section already visited is a cycle, and following
    // it is an unbounded walk the document controls.
    if (seen.has(offset)) {
      throw new PdfStructureError('The cross-reference chain points back at itself.');
    }
    seen.add(offset);

    revisions += 1;
    if (revisions > MAX_REVISIONS) {
      throw new PdfStructureError(`This document has more than ${MAX_REVISIONS} revisions.`);
    }

    let section;
    try {
      section = await readSection(source, offset, signal);
    } catch (err: any) {
      if (err instanceof PdfSyntaxError || err instanceof PdfStructureError) {
        // No recovery scan on purpose. Rebuilding an index by searching for
        // `obj` means reading the whole file, which is the cost this design
        // exists to avoid, and trusting bytes that already failed to parse.
        // The CODE is carried across. A resource ceiling and a malformed table
        // are different answers for the user: one says the document is too big
        // for this service, the other says saving it again may fix it.
        throw new PdfStructureError(
          `This document's cross-reference table could not be read: ${err.message}`,
          err.code,
        );
      }
      throw err;
    }

    // A HYBRID file: the classic table marks certain objects free and defines
    // them in a cross-reference STREAM instead, named by /XRefStm. Acrobat
    // writes these so an old reader that cannot parse a stream still opens the
    // document, seeing a smaller version of it. A reader that ignores /XRefStm
    // sees those objects as deleted and refuses a document every other viewer
    // opens.
    const hybrid = section.trailer.entries.get('XRefStm');
    let revisionEntries = section.entries;
    if (hybrid !== undefined) {
      if (typeof hybrid !== 'number' || !Number.isSafeInteger(hybrid) || hybrid < 0 || hybrid >= source.ref.sizeBytes) {
        throw new PdfStructureError(`An /XRefStm pointer (${String(hybrid)}) is outside the file.`);
      }
      if (seen.has(hybrid)) {
        throw new PdfStructureError('The cross-reference chain points back at itself.');
      }
      seen.add(hybrid);
      const stream = await readSection(source, hybrid, signal);
      revisionEntries = mergeHybrid(section.entries, stream.entries);
      // The stream's own /Prev is deliberately not followed. It chains earlier
      // cross-reference STREAMS, which the classic /Prev chain already reaches,
      // and walking both visits every revision twice.
    }

    for (const entry of revisionEntries) {
      // FIRST definition wins, and revisions arrive newest first.
      if (!entries.has(entry.objectNumber)) entries.set(entry.objectNumber, entry);
    }
    if (entries.size > MAX_XREF_ENTRIES) {
      throw new PdfStructureError(
        `This document declares more than ${MAX_XREF_ENTRIES} objects, which is more index than `
          + `the ${Math.round(MAX_XREF_BYTES / (1024 * 1024))} MiB budget holds.`,
        'PDF_RESOURCE_LIMIT',
      );
    }
    if (!trailer) trailer = section.trailer;

    const prev = section.trailer.entries.get('Prev');
    if (prev === undefined) { offset = null; break; }
    if (typeof prev !== 'number' || !Number.isSafeInteger(prev) || prev < 0 || prev >= source.ref.sizeBytes) {
      throw new PdfStructureError(`A /Prev pointer (${String(prev)}) is outside the file.`);
    }
    offset = prev;
  }

  if (!trailer) throw new PdfStructureError('This document has no trailer.');
  return {
    entries,
    trailer,
    revisions,
    objectStreams: { entries: new Map(), bytes: 0, budgetBytes: OBJECT_STREAM_CACHE_BYTES },
  };
}

/**
 * One revision's entries, with the hybrid stream filling the table's gaps.
 *
 * The two describe the SAME revision, so neither is newer. The classic table
 * wins wherever it actually defines an object, and the stream supplies the ones
 * the table marks free, which is exactly the split a hybrid file is written
 * with. Letting the stream override an in-use table entry would be the reverse
 * of what the file says.
 */
function mergeHybrid(table: XrefEntry[], stream: XrefEntry[]): XrefEntry[] {
  const merged = new Map<number, XrefEntry>();
  for (const entry of table) {
    if (!merged.has(entry.objectNumber)) merged.set(entry.objectNumber, entry);
  }
  for (const entry of stream) {
    const existing = merged.get(entry.objectNumber);
    // `offset === null` is the free tombstone the table writes for an object the
    // stream defines.
    if (!existing || existing.offset === null) merged.set(entry.objectNumber, entry);
  }
  return [...merged.values()];
}

/**
 * Read one object by reference.
 *
 * The GENERATION has to match. `12 0 R` and `12 1 R` are different objects, and
 * resolving without checking lets a freed and reused number return whatever now
 * occupies it.
 */
export async function readObject(
  source: PdfSource,
  index: PdfDocumentIndex,
  ref: PdfRef,
  signal: AbortSignal,
): Promise<PdfValue> {
  const entry = index.entries.get(ref.objectNumber);
  if (!entry) throw new PdfStructureError(`Object ${ref.objectNumber} is not in this document.`);
  if (entry.offset === null) {
    throw new PdfStructureError(`Object ${ref.objectNumber} was deleted in a later revision.`);
  }
  if (entry.generationNumber !== ref.generationNumber) {
    throw new PdfStructureError(
      `Object ${ref.objectNumber} is generation ${entry.generationNumber}, not ${ref.generationNumber}.`,
    );
  }
  if (entry.offset >= source.ref.sizeBytes) {
    throw new PdfStructureError(`Object ${ref.objectNumber} points outside the file.`);
  }

  return readAt(source, entry.offset, signal, (lexer) => {
    const objectNumber = lexer.readValue();
    const generation = lexer.readValue();
    lexer.expectKeyword('obj');
    if (objectNumber !== ref.objectNumber || generation !== ref.generationNumber) {
      // The table said one thing and the object header says another. Trusting
      // either would mean reading an object the reference did not ask for.
      throw new PdfStructureError(
        `Object ${ref.objectNumber} ${ref.generationNumber} is not at the offset the table gives.`,
      );
    }
    return lexer.readValue();
  });
}

/**
 * Read an object that may be a STREAM, keeping its payload as a range.
 *
 * The payload is located from the dictionary's `/Length`, never by scanning for
 * `endstream`. Stream bytes are arbitrary binary and can contain that keyword,
 * so searching for it lets the document choose where its own object ends, and
 * therefore what the parser sees next. A `/Length` that does not fit the file is
 * a refusal rather than a hint to go looking.
 *
 * `/Length` may itself be an indirect reference, which is resolved here. That
 * resolution is bounded to one hop: a chain of references is a document steering
 * the reader in a loop.
 *
 * The bytes are NOT read. A stream comes back as `{ source, start, length }`, so
 * a caller decides whether it ever wants them and in what pieces. Returning a
 * Buffer here would put a 500 MB image in the process on a document that merely
 * mentions one.
 */
export async function readStreamObject(
  source: PdfSource,
  index: PdfDocumentIndex,
  ref: PdfRef,
  signal: AbortSignal,
): Promise<{ value: PdfValue; stream: PdfStream | null }> {
  const entry = index.entries.get(ref.objectNumber);
  if (!entry || entry.offset === null) {
    throw new PdfStructureError(`Object ${ref.objectNumber} is not readable.`);
  }
  if (entry.generationNumber !== ref.generationNumber) {
    throw new PdfStructureError(
      `Object ${ref.objectNumber} is generation ${entry.generationNumber}, not ${ref.generationNumber}.`,
    );
  }

  // Only the HEADER is read. A stream's payload stays where it is: keeping it as
  // a range is what makes reading a 500 MB image cost nothing until something
  // actually asks for its bytes.
  const header = await readAt(source, entry.offset, signal, (lexer) => {
    lexer.readValue();
    lexer.readValue();
    lexer.expectKeyword('obj');
    const parsed = lexer.readValue();
    lexer.skipSpace();
    const isStream = !lexer.atEnd() && lexer.peekKeyword() === 'stream';
    if (isStream) lexer.expectKeyword('stream');
    return { value: parsed, isStream, offset: lexer.offset };
  });

  const value = header.value;
  if (!header.isStream) {
    return { value, stream: null };
  }

  const dictionary = asDict(value);
  if (!dictionary) throw new PdfStructureError('A stream is not preceded by a dictionary.');

  // The payload starts after the keyword's line ending: CRLF or LF, never CR
  // alone. Getting this wrong shifts every byte of the stream by one.
  let payloadStart = entry.offset + header.offset;
  const eol = await source.read(payloadStart, Math.min(2, source.ref.sizeBytes - payloadStart), signal);
  if (eol[0] === 0x0d && eol[1] === 0x0a) payloadStart += 2;
  else if (eol[0] === 0x0a) payloadStart += 1;
  else throw new PdfStructureError('A stream keyword is not followed by a line ending.');

  const length = await resolveLength(source, index, dictionary, signal);
  if (payloadStart + length > source.ref.sizeBytes) {
    throw new PdfStructureError(
      `A stream declares ${length} bytes at ${payloadStart}, which runs past the end of the file.`,
    );
  }

  return {
    value,
    stream: { dictionary, source: source.ref, start: payloadStart, length },
  };
}

/** `/Length`, resolving ONE indirect hop. A chain is a document steering the reader. */
async function resolveLength(
  source: PdfSource,
  index: PdfDocumentIndex,
  dictionary: PdfDict,
  signal: AbortSignal,
): Promise<number> {
  let length = dictionary.entries.get('Length');
  if (length && typeof length === 'object' && (length as any).kind === 'ref') {
    length = await readObject(source, index, (length as any).value, signal);
  }
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new PdfStructureError(`A stream has no usable /Length (${String(length)}).`);
  }
  return length;
}

/**
 * Read an object that lives inside an object stream.
 *
 * PDF 1.5 packs many small objects into one compressed stream to save space, so
 * on a modern document most objects are reached this way rather than by a file
 * offset.
 *
 * The stream begins with `/N` pairs of (object number, relative offset), then
 * the objects themselves starting at `/First`. Every one of those numbers comes
 * from the document, so each is checked against the decoded length before it is
 * used as an index.
 *
 * The decoded container is cached on the INDEX (`objectStreams`), which lives
 * exactly as long as the operation that built it and holds at most its byte
 * budget. A cache any longer-lived than that, or unbounded, is what turns a
 * bounded reader into an unbounded one.
 */
export async function readCompressedObject(
  source: PdfSource,
  index: PdfDocumentIndex,
  ref: PdfRef,
  signal: AbortSignal,
): Promise<PdfValue> {
  const entry = index.entries.get(ref.objectNumber);
  if (!entry?.inObjectStream) {
    throw new PdfStructureError(`Object ${ref.objectNumber} is not in an object stream.`);
  }
  // An object inside a stream is always generation 0 by definition, so a
  // reference asking for another generation is asking for a different object.
  if (ref.generationNumber !== 0) {
    throw new PdfStructureError(
      `Object ${ref.objectNumber} is compressed, so it is generation 0, not ${ref.generationNumber}.`,
    );
  }

  const { streamObjectNumber, indexInStream } = entry.inObjectStream;
  const { container, decoded } = await decodedObjectStream(source, index, streamObjectNumber, signal);
  const dictionary = container.dictionary;
  const count = dictionary.entries.get('N');
  const first = dictionary.entries.get('First');
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new PdfStructureError('An object stream has no usable /N.');
  }
  if (typeof first !== 'number' || !Number.isSafeInteger(first) || first < 0) {
    throw new PdfStructureError('An object stream has no usable /First.');
  }
  if (indexInStream >= count) {
    throw new PdfStructureError(
      `Object ${ref.objectNumber} claims position ${indexInStream} in a stream holding ${count}.`,
    );
  }

  if (first > decoded.length) {
    throw new PdfStructureError('An object stream /First is past the end of its own data.');
  }

  // The header is `N` pairs, read from the front of the decoded data.
  const header = new Lexer(decoded.subarray(0, first));
  let foundOffset: number | null = null;
  for (let i = 0; i < count; i += 1) {
    const number = header.readValue();
    const offset = header.readValue();
    if (typeof number !== 'number' || typeof offset !== 'number'
      || !Number.isSafeInteger(number) || !Number.isSafeInteger(offset) || offset < 0) {
      throw new PdfStructureError('An object stream header entry is malformed.');
    }
    if (i === indexInStream) {
      if (number !== ref.objectNumber) {
        // The table said this position holds one object and the stream says
        // another. Trusting either reads an object the reference did not ask for.
        throw new PdfStructureError(
          `Object stream position ${indexInStream} holds object ${number}, not ${ref.objectNumber}.`,
        );
      }
      foundOffset = offset;
    }
  }
  if (foundOffset === null) {
    throw new PdfStructureError(`Object ${ref.objectNumber} was not found in its object stream.`);
  }

  const at = first + foundOffset;
  if (at >= decoded.length) {
    throw new PdfStructureError('An object stream entry points past the end of its own data.');
  }
  return new Lexer(decoded.subarray(at)).readValue();
}

/** One object stream's container and decoded payload, from the index cache when it is there. */
async function decodedObjectStream(
  source: PdfSource,
  index: PdfDocumentIndex,
  streamObjectNumber: number,
  signal: AbortSignal,
): Promise<{ container: PdfStream; decoded: Uint8Array }> {
  if (!index.objectStreams) {
    index.objectStreams = { entries: new Map(), bytes: 0, budgetBytes: OBJECT_STREAM_CACHE_BYTES };
  }
  const cache = index.objectStreams;
  const hit = cache.entries.get(streamObjectNumber);
  if (hit) return hit;

  const read = await readStreamObject(
    source, index, { objectNumber: streamObjectNumber, generationNumber: 0 }, signal,
  );
  if (!read.stream) {
    throw new PdfStructureError(`Object ${streamObjectNumber} is not a stream.`);
  }
  const encoded = await source.read(read.stream.start, read.stream.length, signal);
  const decoded = await decodeStream(read.stream.dictionary, encoded);
  const entry = { container: read.stream, decoded };

  if (decoded.length <= cache.budgetBytes) {
    while (cache.bytes + decoded.length > cache.budgetBytes && cache.entries.size > 0) {
      const oldest = cache.entries.keys().next().value as number;
      cache.bytes -= cache.entries.get(oldest)!.decoded.length;
      cache.entries.delete(oldest);
    }
    cache.entries.set(streamObjectNumber, entry);
    cache.bytes += decoded.length;
  }
  return entry;
}

/**
 * Read any object, wherever it lives.
 *
 * The one entry point a caller should use: a modern document reaches most of its
 * objects through object streams, and which storage form was used is not
 * something the caller should have to know.
 */
export async function getObject(
  source: PdfSource,
  index: PdfDocumentIndex,
  ref: PdfRef,
  signal: AbortSignal,
): Promise<PdfValue> {
  const entry = index.entries.get(ref.objectNumber);
  if (!entry) throw new PdfStructureError(`Object ${ref.objectNumber} is not in this document.`);
  return entry.inObjectStream
    ? readCompressedObject(source, index, ref, signal)
    : readObject(source, index, ref, signal);
}
