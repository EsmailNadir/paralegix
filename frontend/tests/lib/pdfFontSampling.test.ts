/**
 * The overlay editor's font sampler: what it reads off a pdf.js page and how
 * a selection band or a click maps onto those runs. The geometry is what
 * makes the "Selected text" readout say 11pt Calibri Bold for the line the
 * reader actually pointed at, rather than the line above it or the wrong
 * size on a condensed line.
 */
import {
  matchOverlayFontFamily,
  pdfFontDisplayFamily,
  readPageTextRuns,
  runsAtPoint,
  runsUnderBoxes,
  summarizeRuns,
  type PdfTextRun,
} from '@/lib/pdfFontSampling';

function run(overrides: Partial<PdfTextRun> = {}): PdfTextRun {
  return {
    text: 'x',
    familyLabel: 'Times New Roman',
    family: 'times',
    xPercent: 10,
    yPercent: 10,
    widthPercent: 20,
    heightPercent: 2.5,
    baselineYPercent: 12,
    sizePt: 11,
    bold: false,
    italic: false,
    faceKnown: true,
    ...overrides,
  };
}

describe('matchOverlayFontFamily', () => {
  it.each([
    ['ABCDEF+Calibri-Bold', 'calibri'],
    ['TimesNewRomanPSMT', 'times'],
    ['Arial-BoldMT', 'helvetica'],
    ['Cambria', 'cambria'],
    ['CourierNewPSMT', 'courier'],
    ['PT Sans', 'pt-sans'],
    // Nothing recognisable falls back to the same family a new box gets.
    ['Wingdings-Regular', 'times'],
  ])('maps %s to the stampable family %s', (psName, family) => {
    expect(matchOverlayFontFamily(psName)).toBe(family);
  });
});

describe('pdfFontDisplayFamily', () => {
  it.each([
    ['ABCDEF+TimesNewRomanPS-BoldMT', 'Times New Roman'],
    ['Carlito-Regular-8450', 'Carlito'],
    ['ArialMT', 'Arial'],
    ['', 'Unknown'],
  ])('reads %s as %s', (psName, label) => {
    expect(pdfFontDisplayFamily(psName)).toBe(label);
  });
});

describe('runsUnderBoxes', () => {
  // Two lines on tight leading: the first line's box (ascent to descent)
  // reaches into the second line's band, but only its baseline is in its own.
  const first = run({ text: 'first', yPercent: 10, heightPercent: 2.6, baselineYPercent: 12 });
  const second = run({ text: 'second', yPercent: 12.2, heightPercent: 2.6, baselineYPercent: 14.2 });

  it('picks the line whose baseline is inside the selection band', () => {
    const band = { xPercent: 10, yPercent: 12.1, widthPercent: 20, heightPercent: 2.3 };
    expect(runsUnderBoxes([first, second], [band]).map((r) => r.text)).toEqual(['second']);
  });

  it('ignores a run the band does not overlap horizontally', () => {
    const band = { xPercent: 40, yPercent: 10, widthPercent: 10, heightPercent: 2.6 };
    expect(runsUnderBoxes([first, second], [band])).toEqual([]);
  });
});

describe('runsAtPoint', () => {
  const line = run({ xPercent: 10, yPercent: 10, widthPercent: 20, heightPercent: 2.5 });

  it('returns the run whose box holds the point', () => {
    expect(runsAtPoint([line], { xPercent: 15, yPercent: 11 })).toEqual([line]);
  });

  it('returns nothing for a point on blank page', () => {
    expect(runsAtPoint([line], { xPercent: 15, yPercent: 20 })).toEqual([]);
    expect(runsAtPoint([line], { xPercent: 35, yPercent: 11 })).toEqual([]);
  });
});

describe('summarizeRuns', () => {
  it('reports every property the runs agree on', () => {
    expect(summarizeRuns([run({ sizePt: 11, bold: true }), run({ sizePt: 11, bold: true })])).toEqual({
      familyLabel: 'Times New Roman',
      family: 'times',
      sizePt: 11,
      bold: true,
      italic: false,
    });
  });

  it('blanks a property the runs disagree on and keeps the rest', () => {
    const sample = summarizeRuns([run({ sizePt: 11 }), run({ sizePt: 14 })]);
    expect(sample?.sizePt).toBeNull();
    expect(sample?.family).toBe('times');
  });

  it('is null with nothing selected', () => {
    expect(summarizeRuns([])).toBeNull();
  });
});

describe('readPageTextRuns', () => {
  function fakePage(options: { fontKnown: boolean }) {
    const viewport = {
      width: 612,
      height: 792,
      // PDF space has y up from the bottom; the viewport flips it.
      convertToViewportPoint: (x: number, y: number) => [x, 792 - y],
    };
    return {
      getViewport: () => viewport,
      getTextContent: async () => ({
        items: [
          // A condensed line: the x column carries the 50% horizontal scaling
          // as well as the size, the y column carries the size alone.
          { str: 'Hello', transform: [5.5, 0, 0, 11, 72, 700], width: 30, fontName: 'g_f1' },
          { str: '   ', transform: [11, 0, 0, 11, 72, 680], width: 5, fontName: 'g_f1' },
          { type: 'beginMarkedContent' },
        ],
        styles: { g_f1: { ascent: 0.9, descent: -0.2, fontFamily: 'sans-serif' } },
      }),
      commonObjs: {
        has: () => options.fontKnown,
        get: () => ({ name: 'ABCDEF+Calibri-Bold' }),
      },
    } as any;
  }

  it('reads the size off the y column, boxes the run from its baseline, and names its face', async () => {
    const [hello, ...rest] = await readPageTextRuns(fakePage({ fontKnown: true }));

    // Blank items and marked-content markers carry no text to sample.
    expect(rest).toEqual([]);
    expect(hello.text).toBe('Hello');
    expect(hello.sizePt).toBe(11);
    expect(hello.family).toBe('calibri');
    expect(hello.familyLabel).toBe('Calibri');
    expect(hello.bold).toBe(true);
    expect(hello.faceKnown).toBe(true);
    expect(hello.xPercent).toBeCloseTo((72 / 612) * 100, 5);
    expect(hello.baselineYPercent).toBeCloseTo(((792 - 700) / 792) * 100, 5);
    // The box's top is the baseline lifted by the font's ascent.
    expect(hello.yPercent).toBeCloseTo(((792 - (700 + 0.9 * 11)) / 792) * 100, 5);
    expect(hello.heightPercent).toBeCloseTo(((0.9 + 0.2) * 11 / 792) * 100, 5);
  });

  it('marks a run read before its font loaded, so the page is read again later', async () => {
    const [hello] = await readPageTextRuns(fakePage({ fontKnown: false }));

    expect(hello.faceKnown).toBe(false);
    // Only the generic fallback is available, and it is never a real name.
    expect(hello.family).toBe('helvetica');
    expect(hello.bold).toBe(false);
  });
});
