/**
 * Tokenizing PDF syntax out of a window of bytes.
 *
 * This reads a BUFFER the caller already fetched, not the document. That is the
 * division the whole design rests on: the reader above decides which small
 * window to pull, and this turns those bytes into values. Nothing here ever asks
 * for more, so no amount of malformed input can make it read a gigabyte.
 *
 * Two rules are load-bearing and both are about not trusting the file:
 *
 * A stream's payload is located from its `/Length`, never by scanning for
 * `endstream`. Stream bytes are arbitrary binary and can contain that keyword,
 * so searching for it lets a document choose where its own object ends, and an
 * attacker choose what the parser sees next. A `/Length` that does not agree
 * with the bytes is a refusal, not a hint to go looking.
 *
 * Every container has a depth and a size limit. A PDF can nest arrays and
 * dictionaries arbitrarily, and a recursive parser with no ceiling is a stack
 * overflow that a document controls.
 */
import { AppError } from '../../../shared/errors/AppError';
import type { PdfDict, PdfValue } from './types';

/** Nesting a document may reach. Deeper is refused, not truncated. */
export const MAX_NESTING_DEPTH = Number(process.env.PDF_MAX_NESTING_DEPTH) || 64;

/** Entries one array or dictionary may hold. */
export const MAX_CONTAINER_ENTRIES = Number(process.env.PDF_MAX_CONTAINER_ENTRIES) || 100_000;

/** A PDF could not be parsed. Explicit: there is no silent fallback anywhere here. */
export class PdfSyntaxError extends AppError {
  constructor(message: string) {
    super(message, 400, 'PDF_SYNTAX_ERROR');
  }
}

const SPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const isSpace = (b: number) => SPACE.has(b);
const isDelimiter = (b: number) => DELIMITER.has(b);
const isRegular = (b: number) => !isSpace(b) && !isDelimiter(b);
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;

/** Hex nibble, or -1. */
function nibble(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  return -1;
}

/**
 * A cursor over one window of PDF bytes.
 *
 * Offsets are relative to the window. The caller knows where the window sits in
 * the document, so this never needs to.
 */
export class Lexer {
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number { return this.pos; }
  set offset(value: number) {
    if (!Number.isSafeInteger(value) || value < 0 || value > this.bytes.length) {
      throw new PdfSyntaxError(`Offset ${value} is outside this window.`);
    }
    this.pos = value;
  }

  atEnd(): boolean { return this.pos >= this.bytes.length; }

  /** Step over whitespace AND comments, which are whitespace as far as syntax goes. */
  skipSpace(): void {
    while (this.pos < this.bytes.length) {
      const b = this.bytes[this.pos];
      if (isSpace(b)) { this.pos += 1; continue; }
      if (b === 0x25) { // '%' runs to the end of the line
        while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x0a && this.bytes[this.pos] !== 0x0d) {
          this.pos += 1;
        }
        continue;
      }
      return;
    }
  }

  /** The next regular-character run, without consuming it. */
  peekKeyword(): string {
    const save = this.pos;
    this.skipSpace();
    const start = this.pos;
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos])) this.pos += 1;
    const word = Buffer.from(this.bytes.subarray(start, this.pos)).toString('latin1');
    this.pos = save;
    return word;
  }

  /** Consume an expected keyword, or refuse. */
  expectKeyword(word: string): void {
    this.skipSpace();
    const start = this.pos;
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos])) this.pos += 1;
    const found = Buffer.from(this.bytes.subarray(start, this.pos)).toString('latin1');
    if (found !== word) {
      throw new PdfSyntaxError(`Expected "${word}" and found "${found}".`);
    }
  }

  /**
   * The next value.
   *
   * An indirect reference (`12 0 R`) looks like two numbers until the `R`, so a
   * number is parsed with lookahead rather than committed to immediately.
   */
  readValue(depth = 0): PdfValue {
    // Depth travels with the CALL rather than with the lexer, so one cursor
    // walks the whole window and a nested container cannot lose its place. The
    // ceiling matters because a document chooses its own nesting, and a
    // recursive parser without one is a stack overflow the file controls.
    if (depth > MAX_NESTING_DEPTH) {
      throw new PdfSyntaxError(`This document nests deeper than ${MAX_NESTING_DEPTH} levels.`);
    }
    this.skipSpace();
    if (this.atEnd()) throw new PdfSyntaxError('Unexpected end of input.');

    const b = this.bytes[this.pos];
    if (b === 0x2f) return this.readName();
    if (b === 0x28) return this.readLiteralString();
    if (b === 0x5b) return this.readArray(depth);
    if (b === 0x3c) {
      return this.bytes[this.pos + 1] === 0x3c ? this.readDictionary(depth) : this.readHexString();
    }
    if (isDigit(b) || b === 0x2b || b === 0x2d || b === 0x2e) return this.readNumberOrRef();

    const word = this.peekKeyword();
    if (word === 'true' || word === 'false') {
      this.expectKeyword(word);
      return word === 'true';
    }
    if (word === 'null') { this.expectKeyword('null'); return null; }
    throw new PdfSyntaxError(`Unexpected token "${word || String.fromCharCode(b)}".`);
  }

  /** `/Name`, with `#xx` escapes decoded. */
  private readName(): Extract<PdfValue, { kind: 'name' }> {
    this.pos += 1; // '/'
    const out: number[] = [];
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos])) {
      let byte = this.bytes[this.pos];
      if (byte === 0x23) {
        const hi = nibble(this.bytes[this.pos + 1] ?? -1);
        const lo = nibble(this.bytes[this.pos + 2] ?? -1);
        if (hi < 0 || lo < 0) throw new PdfSyntaxError('Malformed #xx escape in a name.');
        byte = hi * 16 + lo;
        this.pos += 2;
      }
      out.push(byte);
      this.pos += 1;
    }
    return { kind: 'name', value: Buffer.from(out).toString('latin1') };
  }

  /** `(text)`, with balanced parentheses and backslash escapes. */
  private readLiteralString(): Extract<PdfValue, { kind: 'string' }> {
    this.pos += 1; // '('
    const out: number[] = [];
    let nesting = 1;
    while (this.pos < this.bytes.length) {
      const b = this.bytes[this.pos++];
      if (b === 0x5c) { // backslash
        const next = this.bytes[this.pos++];
        if (next === undefined) throw new PdfSyntaxError('String ended inside an escape.');
        const simple: Record<number, number> = {
          0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c,
          0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c,
        };
        if (simple[next] !== undefined) { out.push(simple[next]); continue; }
        if (next >= 0x30 && next <= 0x37) { // octal, up to three digits
          let value = next - 0x30;
          for (let i = 0; i < 2; i += 1) {
            const d = this.bytes[this.pos];
            if (d === undefined || d < 0x30 || d > 0x37) break;
            value = value * 8 + (d - 0x30);
            this.pos += 1;
          }
          out.push(value & 0xff);
          continue;
        }
        if (next === 0x0a) continue;            // line continuation
        if (next === 0x0d) {                    // CRLF continuation
          if (this.bytes[this.pos] === 0x0a) this.pos += 1;
          continue;
        }
        out.push(next);
        continue;
      }
      if (b === 0x28) { nesting += 1; out.push(b); continue; }
      if (b === 0x29) {
        nesting -= 1;
        if (nesting === 0) return { kind: 'string', bytes: new Uint8Array(out) };
        out.push(b);
        continue;
      }
      out.push(b);
    }
    throw new PdfSyntaxError('String was not closed.');
  }

  /** `<48656C6C6F>`, with a trailing odd nibble padded per the spec. */
  private readHexString(): Extract<PdfValue, { kind: 'string' }> {
    this.pos += 1; // '<'
    const out: number[] = [];
    let hi = -1;
    while (this.pos < this.bytes.length) {
      const b = this.bytes[this.pos++];
      if (b === 0x3e) {
        if (hi >= 0) out.push(hi * 16); // an odd final digit means a trailing zero
        return { kind: 'string', bytes: new Uint8Array(out) };
      }
      if (isSpace(b)) continue;
      const n = nibble(b);
      if (n < 0) throw new PdfSyntaxError('Malformed hex string.');
      if (hi < 0) hi = n;
      else { out.push(hi * 16 + n); hi = -1; }
    }
    throw new PdfSyntaxError('Hex string was not closed.');
  }

  private readArray(depth: number): Extract<PdfValue, { kind: 'array' }> {
    this.pos += 1; // '['
    const values: PdfValue[] = [];
    for (;;) {
      this.skipSpace();
      if (this.atEnd()) throw new PdfSyntaxError('Array was not closed.');
      if (this.bytes[this.pos] === 0x5d) { this.pos += 1; return { kind: 'array', values }; }
      if (values.length >= MAX_CONTAINER_ENTRIES) {
        throw new PdfSyntaxError(`An array holds more than ${MAX_CONTAINER_ENTRIES} entries.`);
      }
      values.push(this.readValue(depth + 1));
    }
  }

  private readDictionary(depth: number): PdfDict {
    this.pos += 2; // '<<'
    const entries = new Map<string, PdfValue>();
    for (;;) {
      this.skipSpace();
      if (this.atEnd()) throw new PdfSyntaxError('Dictionary was not closed.');
      if (this.bytes[this.pos] === 0x3e && this.bytes[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return { kind: 'dict', entries };
      }
      if (this.bytes[this.pos] !== 0x2f) {
        throw new PdfSyntaxError('Dictionary key is not a name.');
      }
      if (entries.size >= MAX_CONTAINER_ENTRIES) {
        throw new PdfSyntaxError(`A dictionary holds more than ${MAX_CONTAINER_ENTRIES} entries.`);
      }
      const key = this.readName().value;
      entries.set(key, this.readValue(depth + 1));
    }
  }

  /**
   * A number, or an indirect reference when `N G R` follows.
   *
   * The lookahead is restored when it does not match, so `1 2` in an array stays
   * two numbers rather than being half-consumed.
   */
  private readNumberOrRef(): PdfValue {
    const first = this.readNumber();
    if (!Number.isInteger(first) || first < 0) return first;

    const save = this.pos;
    this.skipSpace();
    if (this.atEnd() || !isDigit(this.bytes[this.pos])) { this.pos = save; return first; }
    const second = this.readNumber();
    this.skipSpace();
    if (this.bytes[this.pos] === 0x52 && !isRegular(this.bytes[this.pos + 1] ?? 0x20)) {
      this.pos += 1;
      return { kind: 'ref', value: { objectNumber: first, generationNumber: second } };
    }
    this.pos = save;
    return first;
  }

  private readNumber(): number {
    this.skipSpace();
    const start = this.pos;
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos])) this.pos += 1;
    const text = Buffer.from(this.bytes.subarray(start, this.pos)).toString('latin1');
    const value = Number(text);
    if (!Number.isFinite(value)) throw new PdfSyntaxError(`"${text}" is not a number.`);
    return value;
  }
}
