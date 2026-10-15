/**
 * Decoding stream payloads, with the output bounded before it is allocated.
 *
 * A compressed stream is the one place in a PDF where a small number of bytes
 * chooses how much memory this process uses. A few kilobytes of zlib can inflate
 * to gigabytes, so the size limit has to be enforced DURING decompression, not
 * checked afterwards: by the time `inflateSync` has returned, the allocation
 * that was supposed to be prevented has already happened.
 *
 * Node's `maxOutputLength` does exactly that, which is why it is used rather
 * than a length check on the result.
 *
 * Unsupported filters are REFUSED rather than passed through. A stream this
 * cannot decode is one whose contents are unknown, and treating unknown bytes as
 * a valid xref table or object stream is how a malformed document gets to choose
 * what the reader believes.
 */
import zlib from 'zlib';
import { promisify } from 'util';
import { AppError } from '../../../shared/errors/AppError';
import type { PdfDict, PdfValue } from './types';

/** The most one stream may decode to. */
export const MAX_DECODED_BYTES = Number(process.env.PDF_MAX_DECODED_BYTES) || 64 * 1024 * 1024;

/** The most one stream may occupy compressed, checked before any work. */
export const MAX_ENCODED_BYTES = Number(process.env.PDF_MAX_ENCODED_BYTES) || 8 * 1024 * 1024;

export class PdfFilterError extends AppError {
  constructor(message: string) {
    super(message, 400, 'PDF_FILTER_ERROR');
  }
}

const nameOf = (value: PdfValue | undefined): string | null =>
  (value && typeof value === 'object' && (value as any).kind === 'name')
    ? (value as any).value as string
    : null;

/** `/Filter` as a list. A single name and an array of names are both legal. */
export function filterNames(dictionary: PdfDict): string[] {
  const filter = dictionary.entries.get('Filter');
  if (filter === undefined) return [];
  const single = nameOf(filter);
  if (single) return [single];
  if (filter && typeof filter === 'object' && (filter as any).kind === 'array') {
    return (filter as any).values.map((v: PdfValue) => {
      const name = nameOf(v);
      if (!name) throw new PdfFilterError('A /Filter entry is not a name.');
      return name;
    });
  }
  throw new PdfFilterError('/Filter is neither a name nor an array of names.');
}

/** `/DecodeParms` for one filter position. */
function decodeParms(dictionary: PdfDict, index: number): PdfDict | null {
  const parms = dictionary.entries.get('DecodeParms') ?? dictionary.entries.get('DP');
  if (parms === undefined || parms === null) return null;
  if (typeof parms === 'object' && (parms as any).kind === 'dict') {
    return index === 0 ? parms as PdfDict : null;
  }
  if (typeof parms === 'object' && (parms as any).kind === 'array') {
    const entry = (parms as any).values[index];
    return (entry && typeof entry === 'object' && entry.kind === 'dict') ? entry as PdfDict : null;
  }
  return null;
}

const intOf = (dictionary: PdfDict | null, key: string, fallback: number): number => {
  const value = dictionary?.entries.get(key);
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PdfFilterError(`${key} is not an integer.`);
  }
  return value;
};

/**
 * Undo a PNG predictor.
 *
 * Xref streams almost always use one, because their columns are highly
 * repetitive and predicting each byte from its neighbour compresses well. Every
 * row carries a leading tag saying which rule was used, so this is not optional
 * for reading a modern document.
 */
function undoPngPredictor(data: Uint8Array, colours: number, bpc: number, columns: number): Uint8Array {
  const bytesPerPixel = Math.max(1, Math.ceil((colours * bpc) / 8));
  const rowLength = Math.ceil((colours * bpc * columns) / 8);
  if (rowLength <= 0) throw new PdfFilterError('A predictor row would be empty.');

  const stride = rowLength + 1; // the tag byte
  if (data.length % stride !== 0) {
    throw new PdfFilterError('Predicted data is not a whole number of rows.');
  }
  const rows = data.length / stride;
  const out = new Uint8Array(rows * rowLength);

  let prior = new Uint8Array(rowLength);
  for (let r = 0; r < rows; r += 1) {
    const tag = data[r * stride];
    const row = data.subarray(r * stride + 1, r * stride + 1 + rowLength);
    const current = out.subarray(r * rowLength, (r + 1) * rowLength);
    current.set(row);

    for (let i = 0; i < rowLength; i += 1) {
      const left = i >= bytesPerPixel ? current[i - bytesPerPixel] : 0;
      const up = prior[i];
      const upLeft = i >= bytesPerPixel ? prior[i - bytesPerPixel] : 0;
      switch (tag) {
        case 0: break;                                     // None
        case 1: current[i] = (current[i] + left) & 0xff; break;  // Sub
        case 2: current[i] = (current[i] + up) & 0xff; break;    // Up
        case 3: current[i] = (current[i] + ((left + up) >> 1)) & 0xff; break; // Average
        case 4: {                                          // Paeth
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const best = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : upLeft);
          current[i] = (current[i] + best) & 0xff;
          break;
        }
        default:
          throw new PdfFilterError(`Unknown predictor tag ${tag}.`);
      }
    }
    prior = current;
  }
  return out;
}

const inflateAsync = promisify(zlib.inflate);

const isFlate = (filter: string) => filter === 'FlateDecode' || filter === 'Fl';

function assertEncodedSize(encoded: Uint8Array) {
  if (encoded.length > MAX_ENCODED_BYTES) {
    throw new PdfFilterError(
      `That stream is ${encoded.length} bytes and the limit is ${MAX_ENCODED_BYTES}.`,
    );
  }
}

/** Every filter but Flate, which has a sync and an async form. */
function applyOtherFilter(filter: string, data: Uint8Array): Uint8Array {
  switch (filter) {
    case 'ASCIIHexDecode':
    case 'AHx':
      return decodeAsciiHex(data);
    default:
      // Refused rather than passed through. A stream that cannot be decoded is
      // one whose contents are unknown, and treating unknown bytes as an xref
      // table lets a malformed document choose what the reader believes.
      throw new PdfFilterError(`Unsupported stream filter "${filter}".`);
  }
}

/** The predictor that follows the filter at `index`, if any. */
function applyPredictor(dictionary: PdfDict, index: number, data: Uint8Array): Uint8Array {
  const parms = decodeParms(dictionary, index);
  const predictor = intOf(parms, 'Predictor', 1);
  if (predictor >= 10) {
    return undoPngPredictor(
      data,
      intOf(parms, 'Colors', 1),
      intOf(parms, 'BitsPerComponent', 8),
      intOf(parms, 'Columns', 1),
    );
  }
  if (predictor !== 1) throw new PdfFilterError(`Unsupported predictor ${predictor}.`);
  return data;
}

/**
 * Decode one stream payload, with Flate on the threadpool.
 *
 * The caller has already read the encoded bytes, and `MAX_ENCODED_BYTES` is what
 * bounds THAT read. This bounds what they may become. A stream may inflate to
 * `MAX_DECODED_BYTES`, and doing that synchronously would stall every request on
 * the instance while zlib runs; the asynchronous form lets the loop keep serving.
 */
export async function decodeStream(dictionary: PdfDict, encoded: Uint8Array): Promise<Uint8Array> {
  assertEncodedSize(encoded);
  const filters = filterNames(dictionary);
  let data = encoded;
  for (let index = 0; index < filters.length; index += 1) {
    const filter = filters[index];
    data = isFlate(filter)
      // Enforced DURING decompression. Checking the length afterwards means
      // the allocation this prevents has already happened.
      ? new Uint8Array(await inflateAsync(Buffer.from(data), { maxOutputLength: MAX_DECODED_BYTES }))
      : applyOtherFilter(filter, data);
    data = applyPredictor(dictionary, index, data);
  }
  return data;
}

/**
 * The synchronous form, for a caller inside a synchronous chain.
 *
 * Only signature-image samples use it. Those are bounded by the image caps in
 * `signing.validation.ts` (four million pixels), far below what a document
 * stream may decode to, so blocking for them is brief.
 */
export function decodeStreamSync(dictionary: PdfDict, encoded: Uint8Array): Uint8Array {
  assertEncodedSize(encoded);
  const filters = filterNames(dictionary);
  let data = encoded;
  for (let index = 0; index < filters.length; index += 1) {
    const filter = filters[index];
    data = isFlate(filter)
      ? new Uint8Array(zlib.inflateSync(Buffer.from(data), { maxOutputLength: MAX_DECODED_BYTES }))
      : applyOtherFilter(filter, data);
    data = applyPredictor(dictionary, index, data);
  }
  return data;
}

function decodeAsciiHex(data: Uint8Array): Uint8Array {
  // Two input digits make one byte, so half the input is the most it can be.
  // A typed array of that size, rather than a growing array of numbers, which
  // cost about eight bytes per decoded byte.
  const out = new Uint8Array(Math.ceil(data.length / 2));
  let written = 0;
  let hi = -1;
  for (const b of data) {
    if (b === 0x3e) break; // '>'
    if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09) continue;
    const n = b >= 0x30 && b <= 0x39 ? b - 0x30
      : b >= 0x41 && b <= 0x46 ? b - 0x37
        : b >= 0x61 && b <= 0x66 ? b - 0x57 : -1;
    if (n < 0) throw new PdfFilterError('Malformed ASCIIHex data.');
    if (hi < 0) hi = n; else { out[written] = hi * 16 + n; written += 1; hi = -1; }
    if (written > MAX_DECODED_BYTES) throw new PdfFilterError('ASCIIHex data is too large.');
  }
  if (hi >= 0) { out[written] = hi * 16; written += 1; }
  return out.subarray(0, written);
}
