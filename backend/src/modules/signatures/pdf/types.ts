/**
 * The contract every part of incremental signing speaks.
 *
 * The whole point of these types is that a PDF is a RANGE OF BYTES IN STORAGE,
 * not an object in this process. A 2 GB document cannot be a Buffer on a 512 MiB
 * instance, so nothing here ever holds one: a stream is a source plus an offset
 * and a length, and the reader fetches the window it needs when it needs it.
 *
 * That is why `PdfStream` carries `source`, `start` and `length` rather than
 * bytes. An eagerly populated object graph is exactly the shape that made the
 * old path cost several times the file size.
 */

/**
 * A PDF that lives in storage.
 *
 * `generation` is a STRING on purpose. A GCS generation is a 64-bit value and
 * coercing it to a JS number silently rounds past 2^53, so two different
 * versions of an object can compare equal. Every read pins this generation, so a
 * document replaced mid-signing fails loudly instead of being signed half from
 * one version and half from the next.
 */
export interface StoredPdf {
  objectPath: string;
  generation: string;
  sizeBytes: number;
}

/**
 * Bounded read access to one stored PDF.
 *
 * There is deliberately no "read the whole thing" method. A caller that wants
 * every byte has to ask for windows, which is what keeps the cost of reading a
 * document independent of its size.
 */
export interface PdfSource {
  readonly ref: StoredPdf;
  /** One window. `length` is capped by the implementation, not by the caller. */
  read(start: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
  /** A range in chunks, for work that is linear and does not need random access. */
  stream(start: number, endExclusive: number, signal: AbortSignal): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

/** An indirect reference: `12 0 R`. */
export interface PdfRef {
  objectNumber: number;
  generationNumber: number;
}

/**
 * A parsed PDF value.
 *
 * Streams are absent on purpose: a stream is not a value, it is a dictionary
 * plus a range in the source, so it has its own type below.
 */
export type PdfValue =
  | null
  | boolean
  | number
  | { kind: 'name'; value: string }
  | { kind: 'string'; bytes: Uint8Array }
  | { kind: 'ref'; value: PdfRef }
  | { kind: 'array'; values: PdfValue[] }
  | { kind: 'dict'; entries: Map<string, PdfValue> };

export type PdfDict = Extract<PdfValue, { kind: 'dict' }>;

/**
 * A stream object, as a REFERENCE to its bytes.
 *
 * `start` is the first byte of the payload, after the `stream` keyword and its
 * line ending. `length` comes from the dictionary's `/Length`, resolved and
 * validated against the source size before any read: a `/Length` that runs past
 * the end of the file is how a malformed document turns into an unbounded read.
 */
export interface PdfStream {
  dictionary: PdfDict;
  source: StoredPdf;
  start: number;
  length: number;
}

// `ProcessingReceipt` and `SealedPdf` from the plan's contract are deliberately
// NOT declared yet. The dead-export guard refuses an export nothing reads, and
// it is right to: a type written ahead of its use drifts from what its task
// actually needs. They arrive with the durable-job and signer work.

/** Every offset is a safe, nonnegative integer before it reaches any I/O. */
export function isSafeOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
