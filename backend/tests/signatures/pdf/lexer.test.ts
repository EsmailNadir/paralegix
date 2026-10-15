/**
 * Tokenizing PDF syntax, and what it refuses.
 *
 * The lexer reads a window the caller already fetched, never the document, so
 * no malformed input can make it read more. What it CAN do is loop, recurse
 * without end, or misread a container boundary, so the cases here are mostly
 * about those.
 */
import { Lexer, PdfSyntaxError, MAX_NESTING_DEPTH } from '../../../src/modules/signatures/pdf/lexer';
import type { PdfValue } from '../../../src/modules/signatures/pdf/types';

const lex = (text: string) => new Lexer(new Uint8Array(Buffer.from(text, 'latin1')));
const read = (text: string): PdfValue => lex(text).readValue();
const str = (v: PdfValue) => Buffer.from((v as any).bytes).toString('latin1');

describe('scalars', () => {
  it('reads numbers, booleans and null', () => {
    expect(read('42')).toBe(42);
    expect(read('-3.5')).toBe(-3.5);
    expect(read('true')).toBe(true);
    expect(read('null')).toBeNull();
  });

  it('reads a name, decoding #xx escapes', () => {
    expect(read('/Type')).toEqual({ kind: 'name', value: 'Type' });
    // `/A#20B` is the name "A B". Left undecoded, a dictionary lookup misses.
    expect(read('/A#20B')).toEqual({ kind: 'name', value: 'A B' });
  });

  it('reads an indirect reference rather than two numbers', () => {
    expect(read('12 0 R')).toEqual({ kind: 'ref', value: { objectNumber: 12, generationNumber: 0 } });
  });

  it('keeps two plain numbers apart from a reference', () => {
    // The lookahead has to be restored, or `[1 2]` half-consumes and the array
    // ends up one entry short with no error.
    const value = read('[1 2]') as any;
    expect(value.values).toEqual([1, 2]);
  });
});

describe('strings', () => {
  it('reads a literal string with escapes', () => {
    expect(str(read('(a\\(b\\)c)'))).toBe('a(b)c');
    expect(str(read('(line\\nbreak)'))).toBe('line\nbreak');
    expect(str(read('(\\101)'))).toBe('A');
  });

  it('keeps balanced parentheses inside a string', () => {
    // An unescaped pair is legal and must not end the string early.
    expect(str(read('(outer (inner) end)'))).toBe('outer (inner) end');
  });

  it('reads a hex string, padding an odd final digit', () => {
    expect(str(read('<48656C6C6F>'))).toBe('Hello');
    // The spec pads a trailing nibble with zero: `<4>` is 0x40.
    expect(Buffer.from((read('<4>') as any).bytes)[0]).toBe(0x40);
  });

  it('refuses a string that never closes', () => {
    expect(() => read('(never')).toThrow(PdfSyntaxError);
    expect(() => read('<4865')).toThrow(PdfSyntaxError);
  });
});

describe('containers', () => {
  it('reads a dictionary', () => {
    const dict = read('<< /Type /Page /Count 3 >>') as any;
    expect(dict.entries.get('Type')).toEqual({ kind: 'name', value: 'Page' });
    expect(dict.entries.get('Count')).toBe(3);
  });

  it('reads nesting', () => {
    const dict = read('<< /Kids [ << /N 1 >> << /N 2 >> ] >>') as any;
    const kids = dict.entries.get('Kids');
    expect(kids.values).toHaveLength(2);
    expect(kids.values[1].entries.get('N')).toBe(2);
  });

  it('treats a comment as whitespace', () => {
    expect(read('% a comment\n42')).toBe(42);
  });

  it('refuses nesting past the ceiling', () => {
    // A document chooses its own nesting. Without a ceiling this is a stack
    // overflow the file controls.
    const deep = '['.repeat(MAX_NESTING_DEPTH + 5) + ']'.repeat(MAX_NESTING_DEPTH + 5);

    expect(() => read(deep)).toThrow(/nests deeper/i);
  });

  it('refuses a dictionary key that is not a name', () => {
    expect(() => read('<< 1 2 >>')).toThrow(PdfSyntaxError);
  });

  it('refuses a container that never closes', () => {
    expect(() => read('[1 2')).toThrow(/not closed/i);
    expect(() => read('<< /A 1')).toThrow(/not closed/i);
  });
});

describe('the cursor', () => {
  it('reads successive values from one window', () => {
    const lexer = lex('1 2 /Three');

    expect(lexer.readValue()).toBe(1);
    expect(lexer.readValue()).toBe(2);
    expect(lexer.readValue()).toEqual({ kind: 'name', value: 'Three' });
    expect(lexer.atEnd()).toBe(true);
  });

  it('refuses an offset outside the window', () => {
    const lexer = lex('123');

    expect(() => { lexer.offset = 99; }).toThrow(/outside this window/i);
    expect(() => { lexer.offset = -1; }).toThrow(/outside this window/i);
  });

  it('refuses an unexpected keyword rather than guessing', () => {
    // Silent recovery is what lets a malformed document steer the parser.
    expect(() => read('endobj')).toThrow(PdfSyntaxError);
  });
});
