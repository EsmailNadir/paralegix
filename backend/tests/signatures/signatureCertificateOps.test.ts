/**
 * The text helpers behind the Signature Certificate.
 *
 * The certificate is drawn with pdf-lib's STANDARD fonts, which are WinAnsi
 * (CP1252) and THROW on any glyph outside that encoding. Every value on the
 * page is user supplied: file titles, signer names, consent text, user-agent
 * strings. A signer called 张伟, an emoji in a file name, or a Cyrillic company
 * name would crash certificate generation at the end of signing, after the
 * document is already executed. `sanitizeForStandardFont` is what prevents
 * that, `wrapText` is what keeps a long value inside its column, and
 * `formatTimestamp` is what puts the audit times in UTC.
 */
import {
  sanitizeForStandardFont,
  formatTimestamp,
  wrapText,
} from '../../src/modules/signatures/certificatePage';

const { PDFDocument, StandardFonts } = require('pdf-lib');

describe('sanitizing user text for the standard font', () => {
  it('folds smart punctuation down to ASCII the font can encode', () => {
    // Every key of SMART_PUNCTUATION that a pasted-from-Word file title or
    // consent statement actually carries. The en/em dashes and the ellipsis in
    // these INPUTS are the literal characters under test and must stay exactly
    // as written; the expected outputs are the plain ASCII they fold down to.
    expect(sanitizeForStandardFont('‘a’ “b”')).toBe("'a' \"b\"");
    expect(sanitizeForStandardFont('en–dash em—dash minus−sign')).toBe('en-dash em-dash minus-sign');
    expect(sanitizeForStandardFont('wait…')).toBe('wait...');
    expect(sanitizeForStandardFont('• bullet')).toBe('- bullet');
    expect(sanitizeForStandardFont('a b')).toBe('a b');
  });

  it('keeps Latin-1 accented characters, so real names survive intact', () => {
    // The point of the 0xA0-0xFF branch. Flattening these to '?' would mangle a
    // large share of genuine signer names.
    expect(sanitizeForStandardFont('Jérôme Nuñez Ångström')).toBe('Jérôme Nuñez Ångström');
  });

  it('replaces anything outside WinAnsi with a single question mark', () => {
    // Iterating by code point matters here: an emoji is one astral code point,
    // so it must not become two '?' from its surrogate halves.
    expect(sanitizeForStandardFont('张伟')).toBe('??');
    expect(sanitizeForStandardFont('Иван')).toBe('????');
    expect(sanitizeForStandardFont('ok 🙂')).toBe('ok ?');
  });

  it('coerces non-strings rather than throwing on them', () => {
    // Reached with whatever the session row held: a missing user agent is
    // undefined, a numeric transaction id is a number.
    expect(sanitizeForStandardFont(null)).toBe('');
    expect(sanitizeForStandardFont(undefined)).toBe('');
    expect(sanitizeForStandardFont(42)).toBe('42');
  });

  it('CHARACTERISATION: a tab becomes a space but a newline becomes "?"', () => {
    // Only '\t' has an explicit branch; '\n' (0x0A) falls past the printable
    // ASCII range and is replaced. A multi-line consent statement therefore
    // renders its line breaks as '?' rather than as spaces. Pinned, not fixed:
    // the certificate is single-paragraph today, so nothing reaches it with a
    // newline, but a caller that starts passing one will change this output.
    expect(sanitizeForStandardFont('a\tb')).toBe('a b');
    expect(sanitizeForStandardFont('a\nb')).toBe('a?b');
  });
});

describe('wrapping text to the certificate column', () => {
  let font: any;

  beforeAll(async () => {
    const doc = await PDFDocument.create();
    font = await doc.embedFont(StandardFonts.Helvetica);
  });

  it('keeps every line inside the requested width', () => {
    const maxWidth = 200;
    const lines = wrapText(
      'The parties agree that this engagement is governed by the laws of the state',
      font, 9.5, maxWidth,
    );

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, 9.5)).toBeLessThanOrEqual(maxWidth);
    }
    expect(lines.join(' ')).toBe('The parties agree that this engagement is governed by the laws of the state');
  });

  it('sanitizes BEFORE measuring, so an unencodable glyph cannot throw', () => {
    // widthOfTextAtSize raises on a non-WinAnsi character exactly as drawText
    // does. Measuring the raw string would throw here rather than wrap.
    expect(() => font.widthOfTextAtSize('契約書', 9.5)).toThrow();

    expect(wrapText('契約書 signed', font, 9.5, 200)).toEqual(['??? signed']);
  });

  it('keeps a single over-wide word rather than dropping it', () => {
    // A 64-character SHA-256 digest is one unbroken word narrower than no
    // column. It must still be printed, on a line of its own.
    const hash = 'a'.repeat(64);
    expect(wrapText(hash, font, 9.5, 40)).toEqual([hash]);
  });
});

describe('formatting the audit timestamps', () => {
  it('renders the instant in UTC, not in the server timezone', () => {
    const formatted = formatTimestamp('2026-10-15T14:30:00.000Z');

    expect(formatted).toContain('October 15, 2026');
    expect(formatted).toContain('2:30:00 PM');
    expect(formatted).toContain('UTC');
  });

  it('does not roll the date back into the previous day', () => {
    // 00:30 UTC is 16:30 the day before in America/Los_Angeles, which CI pins.
    // Dropping `timeZone: 'UTC'` would date this certificate December 31.
    expect(formatTimestamp('2026-01-01T00:30:00.000Z')).toContain('January 1, 2026');
  });

  it('answers N/A for a missing or unparseable value', () => {
    // A signer who never completed has no completedAt; the page must still draw.
    expect(formatTimestamp(null)).toBe('N/A');
    expect(formatTimestamp('')).toBe('N/A');
    expect(formatTimestamp('not-a-date')).toBe('N/A');
  });
});
