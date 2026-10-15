import { fitRichTextToBox, type RichTextBlock } from '../../src/modules/signatures/textFitRich';

describe('Signatures: textFitRich', () => {
  // Simple deterministic measure function: each character is (fontSize * 0.5) wide,
  // bold characters are (fontSize * 0.6) wide.
  const measure = (text: string, fontSize: number, bold: boolean, _italic: boolean) => {
    const charWidth = bold ? fontSize * 0.6 : fontSize * 0.5;
    return text.length * charWidth;
  };

  it('fits a single unstyled block without wrapping when box is wide enough', () => {
    const blocks: RichTextBlock[] = [
      {
        bullet: false,
        runs: [{ text: 'Hello World', bold: false, italic: false, color: '#000000' }],
      },
    ];

    const result = fitRichTextToBox(blocks, 200, 100, 16, measure);

    expect(result.fontSize).toBe(16);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].segments).toHaveLength(1);
    expect(result.lines[0].segments[0].text).toBe('Hello World');
  });

  it('wraps multiple words across lines when text exceeds width', () => {
    const blocks: RichTextBlock[] = [
      {
        bullet: false,
        runs: [
          { text: 'The quick brown fox jumps over the lazy dog', bold: false, italic: false, color: '#000000' },
        ],
      },
    ];

    // Width = 100 (availableWidth = 92). At fontSize 12, each char is 6px.
    // Line fits ~15 characters before wrapping.
    const result = fitRichTextToBox(blocks, 100, 150, 12, measure);

    expect(result.lines.length).toBeGreaterThan(1);
    const fullText = result.lines
      .map((l) => l.segments.map((s) => s.text).join(''))
      .join(' ');
    expect(fullText).toContain('quick');
    expect(fullText).toContain('lazy dog');
  });

  it('preserves mixed styled runs on the same line', () => {
    const blocks: RichTextBlock[] = [
      {
        bullet: false,
        runs: [
          { text: 'Normal ', bold: false, italic: false, color: '#000000' },
          { text: 'Bold ', bold: true, italic: false, color: '#ff0000' },
          { text: 'Italic', bold: false, italic: true, color: '#0000ff' },
        ],
      },
    ];

    const result = fitRichTextToBox(blocks, 300, 100, 14, measure);

    expect(result.lines).toHaveLength(1);
    const segments = result.lines[0].segments;
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(segments.find((s) => s.bold && s.text.includes('Bold'))).toBeDefined();
    expect(segments.find((s) => s.italic && s.text.includes('Italic'))).toBeDefined();
  });

  it('reduces font size when text exceeds available height', () => {
    const blocks: RichTextBlock[] = [
      {
        bullet: false,
        runs: [
          {
            text: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6',
            bold: false,
            italic: false,
            color: '#000000',
          },
        ],
      },
    ];

    // Box height 40 cannot fit 6 lines at fontSize 16, so fontSize must shrink.
    const result = fitRichTextToBox(blocks, 200, 40, 16, measure, 5);

    expect(result.fontSize).toBeLessThan(16);
    expect(result.fontSize).toBeGreaterThanOrEqual(5);
  });

  it('truncates with ellipsis when minimum font size is reached and height is exceeded', () => {
    const blocks: RichTextBlock[] = [
      {
        bullet: false,
        runs: [
          {
            text: 'Extremely long paragraph that will definitely exceed both the width and the tiny height constraint even at the smallest allowed font size.',
            bold: false,
            italic: false,
            color: '#000000',
          },
        ],
      },
    ];

    // Tiny height box allowing only 1 line
    const result = fitRichTextToBox(blocks, 60, 15, 12, measure, 5);

    expect(result.fontSize).toBe(5);
    expect(result.lines.length).toBeLessThanOrEqual(2);
    const lastLine = result.lines[result.lines.length - 1];
    const lastSegment = lastLine.segments[lastLine.segments.length - 1];
    expect(lastSegment.text).toContain('…');
  });

  it('handles bulleted blocks with glued bullet prefix', () => {
    const blocks: RichTextBlock[] = [
      {
        bullet: true,
        runs: [{ text: 'First item in bullet list', bold: false, italic: false, color: '#000000' }],
      },
    ];

    const result = fitRichTextToBox(blocks, 250, 100, 14, measure);

    expect(result.lines).toHaveLength(1);
    const firstSegment = result.lines[0].segments[0];
    expect(firstSegment.text).toMatch(/^•\s+/);
  });

  it('hard breaks words that are wider than available width', () => {
    const blocks: RichTextBlock[] = [
      {
        bullet: false,
        runs: [
          {
            text: 'Supercalifragilisticexpialidocious',
            bold: false,
            italic: false,
            color: '#000000',
          },
        ],
      },
    ];

    // Width 40 is narrower than the long word at fontSize 10 (34 chars * 5px = 170px)
    const result = fitRichTextToBox(blocks, 40, 200, 10, measure, 5);

    expect(result.lines.length).toBeGreaterThan(1);
  });

  it('handles empty blocks without crashing', () => {
    const blocks: RichTextBlock[] = [
      { bullet: false, runs: [] },
      { bullet: false, runs: [{ text: '', bold: false, italic: false, color: '#000000' }] },
    ];

    const result = fitRichTextToBox(blocks, 100, 100, 12, measure);
    expect(result.lines).toBeDefined();
  });
});
