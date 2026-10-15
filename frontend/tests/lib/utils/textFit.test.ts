/**
 * The frontend copy of the text-fit algorithm that lays a signer's typed value
 * (plain and rich) into its field for the on-screen preview. The backend copy
 * stamps the final PDF and a backend parity test keeps the two textually
 * identical; this file pins what the frontend copy actually produces, so an
 * edit here goes red in the offline suite, not only in the backend run.
 *
 * Measurement is a monospace stub: every character is half the font size wide
 * (bold 0.6), so each expected line below can be checked by hand. The box
 * width loses 8 to padding before wrapping, which every case accounts for.
 */
import { fitTextToBox } from '@/lib/utils/textFit';
import { fitRichTextToBox, type RichTextBlock, type RichTextRun } from '@/lib/utils/textFitRich';

const mono = (text: string, fontSize: number) => [...text].length * fontSize * 0.5;
const monoRich = (text: string, fontSize: number, bold: boolean) =>
  [...text].length * fontSize * (bold ? 0.6 : 0.5);

describe('fitTextToBox', () => {
  it('keeps the requested size and wraps at word boundaries when height allows', () => {
    // Font 10: 5 per char; box 58 leaves 50, so 10 characters per line.
    expect(fitTextToBox('hello world', 58, 100, 10, mono)).toEqual({
      lines: ['hello', 'world'],
      fontSize: 10,
      lineHeight: 11.5,
    });
  });

  it('shrinks the font one point at a time until the text fits the height', () => {
    // Two lines at 10pt need 23; at 9pt "hello world" is 49.5 wide, one line.
    const result = fitTextToBox('hello world', 58, 12, 10, mono);
    expect(result.lines).toEqual(['hello world']);
    expect(result.fontSize).toBe(9);
    expect(result.lineHeight).toBeCloseTo(10.35);
  });

  it('breaks a single word wider than the box by character', () => {
    expect(fitTextToBox('abcdefghijklmnop', 58, 100, 10, mono).lines).toEqual(['abcdefghij', 'klmnop']);
  });

  it('starts a new line at each newline and keeps a blank paragraph as an empty line', () => {
    expect(fitTextToBox('a\n\nb', 58, 100, 10, mono).lines).toEqual(['a', '', 'b']);
  });

  it('truncates to the lines that fit at the minimum size and ends with an ellipsis', () => {
    // Font 5: 2.5 per char; box 28 leaves 20 (8 chars). Four lines, room for one.
    expect(fitTextToBox('aaaa bbbb cccc dddd', 28, 6, 5, mono)).toEqual({
      lines: ['aaaa…'],
      fontSize: 5,
      lineHeight: 5.75,
    });
  });

  it('counts the ellipsis itself, trimming a full line so the result still fits', () => {
    // "abcdefgh" is exactly 20 wide; with the ellipsis it is 22.5, so one
    // character goes.
    const { lines } = fitTextToBox('abcdefgh abcdefgh', 28, 6, 5, mono);
    expect(lines).toEqual(['abcdefg…']);
    expect(mono(lines[0], 5)).toBeLessThanOrEqual(20);
  });

  it('degrades to a lone ellipsis when not even one character fits', () => {
    expect(fitTextToBox('ab', 0, 6, 5, mono).lines).toEqual(['…']);
  });

  it('raises a maxFontSize below the floor to the floor', () => {
    expect(fitTextToBox('hi', 100, 100, 3, mono).fontSize).toBe(5);
  });

  it('honours a custom minimum font size', () => {
    // Would shrink to 5 by default; a floor of 8 stops it there and truncates.
    const result = fitTextToBox('aaaa bbbb cccc dddd', 28, 10, 10, mono, 8);
    expect(result.fontSize).toBe(8);
    expect(result.lines).toEqual(['aaaa…']);
  });

  it('returns one empty line for empty input', () => {
    expect(fitTextToBox('', 58, 100, 10, mono).lines).toEqual(['']);
  });
});

function run(text: string, style: Partial<RichTextRun> = {}): RichTextRun {
  return { text, bold: false, italic: false, color: '#111111', ...style };
}

const seg = (text: string, style: Partial<RichTextRun> = {}) => run(text, style);

describe('fitRichTextToBox', () => {
  it('keeps mixed styles on one line and merges the joining space into the previous style', () => {
    const blocks: RichTextBlock[] = [{ bullet: false, runs: [run('Hello '), run('World', { bold: true })] }];

    expect(fitRichTextToBox(blocks, 208, 100, 10, monoRich)).toEqual({
      lines: [{ segments: [seg('Hello '), seg('World', { bold: true })] }],
      fontSize: 10,
      lineHeight: 11.5,
    });
  });

  it('keeps a word whose style changes mid-word together when wrapping', () => {
    // "ab"+"cd"(bold) is one word, 22 wide; with " ef" it is 37 > 30.
    const blocks: RichTextBlock[] = [
      { bullet: false, runs: [run('ab'), run('cd', { bold: true }), run(' ef')] },
    ];

    expect(fitRichTextToBox(blocks, 38, 100, 10, monoRich, 10).lines).toEqual([
      { segments: [seg('ab'), seg('cd', { bold: true })] },
      { segments: [seg('ef')] },
    ]);
  });

  it('glues the bullet to the first word so it never sits alone on a line', () => {
    const blocks: RichTextBlock[] = [{ bullet: true, runs: [run('one two')] }];

    expect(fitRichTextToBox(blocks, 48, 100, 10, monoRich, 10).lines).toEqual([
      { segments: [seg('•  one')] },
      { segments: [seg('two')] },
    ]);
  });

  it('draws the bullet in the first run style', () => {
    const blocks: RichTextBlock[] = [{ bullet: true, runs: [run('Go', { bold: true, color: '#ff0000' })] }];

    expect(fitRichTextToBox(blocks, 208, 100, 10, monoRich).lines).toEqual([
      { segments: [seg('•  Go', { bold: true, color: '#ff0000' })] },
    ]);
  });

  it('breaks at a newline inside a run and keeps an empty paragraph as an empty line', () => {
    const blocks: RichTextBlock[] = [{ bullet: false, runs: [run('a\n\nb')] }];

    expect(fitRichTextToBox(blocks, 208, 100, 10, monoRich).lines).toEqual([
      { segments: [seg('a')] },
      { segments: [] },
      { segments: [seg('b')] },
    ]);
  });

  it('gives a block with no runs one empty line', () => {
    expect(fitRichTextToBox([{ bullet: true, runs: [] }], 208, 100, 10, monoRich).lines).toEqual([
      { segments: [] },
    ]);
  });

  it('hard-breaks an over-wide word between its styled fragments first', () => {
    // "abcd"(20) + "efg" bold (18) = 38 > 30: split at the style boundary.
    const blocks: RichTextBlock[] = [{ bullet: false, runs: [run('abcd'), run('efg', { bold: true })] }];

    expect(fitRichTextToBox(blocks, 38, 100, 10, monoRich, 10).lines).toEqual([
      { segments: [seg('abcd')] },
      { segments: [seg('efg', { bold: true })] },
    ]);
  });

  it('styles the joining space like the word before it, so it merges into that segment', () => {
    const blocks: RichTextBlock[] = [{ bullet: false, runs: [run('Hello', { bold: true }), run(' World')] }];

    expect(fitRichTextToBox(blocks, 208, 100, 10, monoRich).lines).toEqual([
      { segments: [seg('Hello ', { bold: true }), seg('World')] },
    ]);
  });

  it('keeps consecutive fragments of an over-wide word together while they fit', () => {
    // "ab"(10) + "cd" bold (12) + "efghij"(30) is one 52-wide word in 30 of
    // room: the first two fragments share a piece, the third gets its own.
    const blocks: RichTextBlock[] = [
      { bullet: false, runs: [run('ab'), run('cd', { bold: true }), run('efghij')] },
    ];

    expect(fitRichTextToBox(blocks, 38, 100, 10, monoRich, 10).lines).toEqual([
      { segments: [seg('ab'), seg('cd', { bold: true })] },
      { segments: [seg('efghij')] },
    ]);
  });

  it('hard-breaks a single over-wide fragment by character', () => {
    const blocks: RichTextBlock[] = [{ bullet: false, runs: [run('abcdefgh')] }];

    expect(fitRichTextToBox(blocks, 38, 100, 10, monoRich, 10).lines).toEqual([
      { segments: [seg('abcdef')] },
      { segments: [seg('gh')] },
    ]);
  });

  it('shrinks the font before wrapping onto more lines than fit', () => {
    const blocks: RichTextBlock[] = [{ bullet: false, runs: [run('hello world')] }];
    const result = fitRichTextToBox(blocks, 58, 12, 10, monoRich);

    expect(result.fontSize).toBe(9);
    expect(result.lines).toEqual([{ segments: [seg('hello world')] }]);
  });

  it('truncates the last kept line with an ellipsis at the minimum size', () => {
    const blocks: RichTextBlock[] = [{ bullet: false, runs: [run('aaaa bbbb')] }];

    expect(fitRichTextToBox(blocks, 28, 6, 5, monoRich)).toEqual({
      lines: [{ segments: [seg('aaaa…')] }],
      fontSize: 5,
      lineHeight: 5.75,
    });
  });

  it('drops a trailing segment with no room and puts the ellipsis on the one before', () => {
    // Font 5, room 20: "abcdef"(15) + bold "g"(3) is one 18-wide word; "zz"
    // wraps. Truncating: "g…" (6) exceeds the 5 left, so "g" goes entirely.
    const blocks: RichTextBlock[] = [
      { bullet: false, runs: [run('abcdef'), run('g', { bold: true }), run(' zz')] },
    ];

    expect(fitRichTextToBox(blocks, 28, 6, 5, monoRich).lines).toEqual([
      { segments: [seg('abcdef…')] },
    ]);
  });

  it('trims characters off the last segment when part of it still fits', () => {
    // "abcdefgh" fills the 20 exactly; with the ellipsis one character goes.
    const blocks: RichTextBlock[] = [{ bullet: false, runs: [run('abcdefgh zz')] }];

    expect(fitRichTextToBox(blocks, 28, 6, 5, monoRich).lines).toEqual([
      { segments: [seg('abcdefg…')] },
    ]);
  });

  it('falls back to a lone black ellipsis when no segment can keep a character', () => {
    const blocks: RichTextBlock[] = [{ bullet: false, runs: [run('ab')] }];

    expect(fitRichTextToBox(blocks, 0, 6, 5, monoRich).lines).toEqual([
      { segments: [{ text: '…', bold: false, italic: false, color: '#000000' }] },
    ]);
  });

  it('lays out several blocks one after another', () => {
    const blocks: RichTextBlock[] = [
      { bullet: false, runs: [run('first')] },
      { bullet: true, runs: [run('second', { italic: true })] },
    ];

    expect(fitRichTextToBox(blocks, 208, 100, 10, monoRich).lines).toEqual([
      { segments: [seg('first')] },
      { segments: [seg('•  second', { italic: true })] },
    ]);
  });
});
