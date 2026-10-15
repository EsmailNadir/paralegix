import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { fillOverlayTemplate, drawStyledText, drawRichText } from '../../src/modules/templates/overlayFill.service';

const VALID_1X1_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('drawStyledText: date field formatting', () => {
  // Stubbed so the drawn text is captured directly rather than re-parsed out
  // of a rendered PDF. `widthOfTextAtSize` returns a small constant so
  // `fitTextToBox` keeps the date on one line.
  const stubFont = { widthOfTextAtSize: jest.fn(() => 10) };
  const box = { x: 0, y: 0, boxWidth: 300, boxHeight: 40 };

  function drawnLines(fieldType: string, value: string) {
    const lines: string[] = [];
    const page = { drawText: jest.fn((line: string) => lines.push(line)) };
    drawStyledText(page, stubFont, { fieldType }, value, box);
    return lines;
  }

  // Both the parse and the format are pinned to UTC now (see the doc comment
  // on the source), so this no longer depends on the SERVER PROCESS's local
  // time zone the way an ambient-zone round trip did.
  it('formats a day-only date value as the literal calendar date', () => {
    expect(drawnLines('date', '2026-08-31')).toEqual(['8/31/2026']);
  });

  it('formats a leap-day date correctly', () => {
    expect(drawnLines('date', '2028-02-29')).toEqual(['2/29/2028']);
  });

  it('leaves a non-date-shaped value for a date field untouched', () => {
    expect(drawnLines('date', 'signed in person')).toEqual(['signed in person']);
  });
});

describe('Document Overlay Fill Service', () => {
  let samplePdfBuffer: Buffer;

  beforeEach(async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]); // Page 1
    doc.addPage([600, 800]); // Page 2
    samplePdfBuffer = Buffer.from(await doc.save());
  });

  it('stamps basic text fields, date fields, checkboxes, and textboxes', async () => {
    const placements = [
      {
        id: 'p-text',
        page: 1,
        fieldType: 'text',
        fieldName: 'clientName',
        fontFamily: 'helvetica',
        fontSize: 14,
        color: '#1a56db',
        textAlign: 'left',
        xPercent: 10,
        yPercent: 10,
        widthPercent: 40,
        heightPercent: 5,
      },
      {
        id: 'p-date',
        page: 1,
        fieldType: 'date',
        fieldName: 'closingDate',
        fontFamily: 'times',
        fontSize: 12,
        xPercent: 10,
        yPercent: 20,
        widthPercent: 30,
        heightPercent: 5,
      },
      {
        id: 'p-check',
        page: 1,
        fieldType: 'checkbox',
        fieldName: 'isConfidential',
        xPercent: 10,
        yPercent: 30,
        widthPercent: 5,
        heightPercent: 5,
      },
      {
        id: 'p-box',
        page: 1,
        fieldType: 'textbox',
        richText: [{ bullet: false, runs: [{ text: 'Static notice disclaimer', bold: true, italic: false, color: '#000000' }] }],
        fontFamily: 'courier',
        bold: true,
        fontSize: 10,
        textAlign: 'center',
        xPercent: 10,
        yPercent: 40,
        widthPercent: 80,
        heightPercent: 8,
      },
    ];

    const values = {
      clientName: 'Acme Corporation',
      closingDate: '2026-08-31',
      isConfidential: true,
    };

    const filledBuffer = await fillOverlayTemplate({
      pdfBuffer: samplePdfBuffer,
      placements,
      values,
    });

    expect(filledBuffer).toBeInstanceOf(Buffer);
    expect(filledBuffer.length).toBeGreaterThan(samplePdfBuffer.length);

    const resultDoc = await PDFDocument.load(filledBuffer);
    expect(resultDoc.getPageCount()).toBe(2);
  });

  it('stamps rich text boxes with field chip substitutions and styles', async () => {
    const placements = [
      {
        id: 'p-rich',
        page: 1,
        fieldType: 'textbox',
        fontFamily: 'helvetica',
        fontSize: 12,
        xPercent: 10,
        yPercent: 10,
        widthPercent: 80,
        heightPercent: 15,
        richText: [
          {
            bullet: true,
            runs: [
              { text: 'Client Name: ', bold: true, color: '#000000' },
              { fieldName: 'clientName', bold: false, color: '#333333' },
            ],
          },
          {
            bullet: false,
            runs: [
              { text: 'Matter Ref: ', bold: true, color: '#000000' },
              { fieldName: 'matterRef', italic: true, color: '#666666' },
            ],
          },
        ],
      },
    ];

    const values = {
      clientName: 'Global Enterprises Inc',
      matterRef: 'MAT-9901',
    };

    const filledBuffer = await fillOverlayTemplate({
      pdfBuffer: samplePdfBuffer,
      placements,
      values,
    });

    const resultDoc = await PDFDocument.load(filledBuffer);
    expect(resultDoc.getPageCount()).toBe(2);
  });

  it('stamps images from imageBuffers and handles missing/corrupt image buffers gracefully', async () => {
    const pngBuffer = Buffer.from(VALID_1X1_PNG_BASE64, 'base64');
    const placements = [
      {
        id: 'p-img-1',
        page: 1,
        fieldType: 'image',
        imageObjectPath: 'firms/1/logo.png',
        imageMimeType: 'image/png',
        xPercent: 70,
        yPercent: 5,
        widthPercent: 20,
        heightPercent: 10,
      },
      {
        id: 'p-img-missing',
        page: 1,
        fieldType: 'image',
        imageObjectPath: 'firms/1/nonexistent.png',
        imageMimeType: 'image/png',
        xPercent: 70,
        yPercent: 20,
        widthPercent: 20,
        heightPercent: 10,
      },
      {
        id: 'p-img-corrupt',
        page: 1,
        fieldType: 'image',
        imageObjectPath: 'firms/1/corrupt.png',
        imageMimeType: 'image/png',
        xPercent: 70,
        yPercent: 35,
        widthPercent: 20,
        heightPercent: 10,
      },
    ];

    const imageBuffers = {
      'firms/1/logo.png': pngBuffer,
      'firms/1/corrupt.png': Buffer.from('not an image at all'),
    };

    const filledBuffer = await fillOverlayTemplate({
      pdfBuffer: samplePdfBuffer,
      placements,
      imageBuffers,
    });

    const resultDoc = await PDFDocument.load(filledBuffer);
    expect(resultDoc.getPageCount()).toBe(2);
  });

  it('renders repeater rows across multiple continuation pages when rows exceed rowCount', async () => {
    const repeaters = [
      {
        name: 'lineItems',
        anchorPage: 1,
        anchorYPercent: 30,
        rowHeightPercent: 10,
        rowCount: 3, // 3 rows per page
      },
    ];

    const placements = [
      {
        id: 'rep-col-desc',
        repeaterName: 'lineItems',
        fieldName: 'description',
        fieldType: 'text',
        fontFamily: 'helvetica',
        fontSize: 11,
        xPercent: 10,
        widthPercent: 50,
        heightPercent: 8,
      },
      {
        id: 'rep-col-amount',
        repeaterName: 'lineItems',
        fieldName: 'amount',
        fieldType: 'text',
        fontFamily: 'helvetica',
        fontSize: 11,
        textAlign: 'right',
        xPercent: 65,
        widthPercent: 25,
        heightPercent: 8,
      },
    ];

    // 8 rows -> requires 3 pages total (page 1 + 2 continuation pages) + existing page 2
    const repeaterValues = {
      lineItems: [
        { description: 'Item 1', amount: '$100.00' },
        { description: 'Item 2', amount: '$200.00' },
        { description: 'Item 3', amount: '$300.00' },
        { description: 'Item 4', amount: '$400.00' },
        { description: 'Item 5', amount: '$500.00' },
        { description: 'Item 6', amount: '$600.00' },
        { description: 'Item 7', amount: '$700.00' },
        { description: 'Item 8', amount: '$800.00' },
      ],
    };

    const filledBuffer = await fillOverlayTemplate({
      pdfBuffer: samplePdfBuffer,
      placements,
      repeaters,
      repeaterValues,
    });

    const resultDoc = await PDFDocument.load(filledBuffer);
    // Original had 2 pages. Anchor page (1) had 8 rows with 3 per page => needed 2 continuation pages => 4 total pages.
    expect(resultDoc.getPageCount()).toBe(4);
  });

  it('handles empty placements and missing values gracefully without crashing', async () => {
    const placements = [
      {
        id: 'p-unresolved',
        page: 1,
        fieldType: 'text',
        fieldName: 'nonExistentField',
        xPercent: 10,
        yPercent: 10,
        widthPercent: 20,
        heightPercent: 5,
      },
      {
        id: 'p-bad-page',
        page: 999, // Nonexistent page
        fieldType: 'text',
        fieldName: 'someField',
        xPercent: 10,
        yPercent: 10,
        widthPercent: 20,
        heightPercent: 5,
      },
    ];

    const filledBuffer = await fillOverlayTemplate({
      pdfBuffer: samplePdfBuffer,
      placements,
      values: {},
    });

    const resultDoc = await PDFDocument.load(filledBuffer);
    expect(resultDoc.getPageCount()).toBe(2);
  });
});

/**
 * The text operators a page's content streams carry, with everything else
 * stripped. pdf-lib deflates its content streams on save, so the drawn text
 * can only be counted after inflating them; a `Tj` per drawn line is what
 * `page.drawText` emits.
 */
async function drawnTextOperatorCount(pdfBuffer: Buffer, pageIndex = 0) {
  const doc = await PDFDocument.load(pdfBuffer);
  const contents = doc.getPage(pageIndex).node.Contents();
  const streams = contents instanceof PDFArray
    ? contents.asArray().map((ref) => doc.context.lookup(ref) as PDFRawStream)
    : [contents as PDFRawStream];
  let text = '';
  for (const stream of streams) {
    text += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  }
  return (text.match(/\bTj\b/g) || []).length;
}

/** The /BaseFont of every font dictionary in the document, subset prefix and all. */
async function embeddedFontNames(pdfBuffer: Buffer) {
  const doc = await PDFDocument.load(pdfBuffer);
  const names: string[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    const type = object.get(PDFName.of('Type'));
    const baseFont = object.get(PDFName.of('BaseFont'));
    if (type instanceof PDFName && type.decodeText() === 'Font' && baseFont instanceof PDFName) {
      names.push(baseFont.decodeText());
    }
  }
  return names;
}

describe('fillOverlayTemplate: one bad value does not sink the document', () => {
  it('still stamps every other field when a value has a glyph the font cannot encode', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    const pdfBuffer = Buffer.from(await doc.save());

    const field = (fieldName: string, yPercent: number) => ({
      id: `p-${fieldName}`,
      page: 1,
      fieldType: 'text',
      fieldName,
      fontFamily: 'helvetica',
      fontSize: 12,
      xPercent: 10,
      yPercent,
      widthPercent: 60,
      heightPercent: 5,
    });

    const filled = await fillOverlayTemplate({
      pdfBuffer,
      placements: [field('before', 10), field('company', 20), field('after', 30)],
      // A CJK company name. Helvetica is a WinAnsi standard font, so the width
      // measurement inside the fit throws before any drawText is reached.
      values: { before: 'Acme Corp', company: '株式会社', after: 'Signed' },
    });

    // The two Latin values each draw one line, and the CJK value no longer
    // aborts its own box or theirs: it prints with "?" where no bundled font
    // has the glyph, and the fill reports it.
    expect(await drawnTextOperatorCount(filled)).toBe(3);
  });

  it('still stamps the remaining repeater rows when one row carries a bad glyph', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    const pdfBuffer = Buffer.from(await doc.save());

    const filled = await fillOverlayTemplate({
      pdfBuffer,
      placements: [{
        id: 'col',
        repeaterName: 'items',
        fieldName: 'label',
        fieldType: 'text',
        fontFamily: 'times',
        fontSize: 11,
        xPercent: 10,
        widthPercent: 60,
        heightPercent: 5,
      }],
      repeaters: [{ name: 'items', anchorPage: 1, anchorYPercent: 20, rowHeightPercent: 6, rowCount: 10 }],
      values: {},
      repeaterValues: { items: [{ label: 'First' }, { label: '第二' }, { label: 'Third' }] },
    });

    expect(await drawnTextOperatorCount(filled)).toBe(3);
  });
});

describe('drawStyledText: automatic size', () => {
  // A wide, tall box so neither the width nor the height forces a shrink:
  // the drawn size is then exactly the automatic maximum.
  const box = { x: 0, y: 0, boxWidth: 400, boxHeight: 100 };
  const stubFont = { widthOfTextAtSize: jest.fn(() => 10) };

  function drawnSize(fieldType: string) {
    let size: number | null = null;
    const page = { drawText: jest.fn((_line: string, options: any) => { size = options.size; }) };
    drawStyledText(page, stubFont, { fieldType, fontSize: null }, 'value', box);
    return size;
  }

  it('uses the same automatic maximum for a date as for a text field', () => {
    // The editor previews every field type with one automatic rule, capped at
    // 18pt. A date that stamps smaller than it previews is a layout the author
    // never saw.
    expect(drawnSize('date')).toBe(18);
    expect(drawnSize('text')).toBe(18);
    expect(drawnSize('textbox')).toBe(18);
  });

  it('derives the automatic size from the box height on a short box', () => {
    const shortBox = { x: 0, y: 0, boxWidth: 400, boxHeight: 20 };
    const page = { drawText: jest.fn() };
    drawStyledText(page, stubFont, { fieldType: 'text', fontSize: null }, 'value', shortBox);
    // 55% of 20pt is 11pt, above the 10pt floor.
    expect(page.drawText.mock.calls[0][1].size).toBe(11);
  });
});

describe('drawRichText', () => {
  // Every variant is a distinct object with a deterministic width, so the
  // test can tell WHICH face a segment was drawn in, not only that one was.
  const variant = (name: string) => ({ name, widthOfTextAtSize: (text: string, size: number) => text.length * size * 0.5 });
  const variants: Record<string, any> = {
    'false:false': variant('regular'),
    'true:false': variant('bold'),
    'false:true': variant('italic'),
    'true:true': variant('boldItalic'),
  };
  const getFont = async (_family: string, bold: boolean, italic: boolean) => variants[`${Boolean(bold)}:${Boolean(italic)}`];
  const box = { x: 100, y: 100, boxWidth: 400, boxHeight: 60 };

  async function draw(richText: any[], values: Record<string, string>) {
    const calls: any[] = [];
    const page = { drawText: jest.fn((text: string, options: any) => calls.push({ text, ...options })) };
    await drawRichText(page, getFont, { fontFamily: 'helvetica', fontSize: 12, textAlign: 'left', richText }, (name: string) => values[name], box);
    return calls;
  }

  it('draws each run in its own face and color, with the field chip resolved', async () => {
    const calls = await draw([{
      bullet: true,
      runs: [
        { text: 'Client: ', bold: true, italic: false, color: '#000000' },
        { fieldName: 'clientName', bold: false, italic: true, color: '#1a56db' },
      ],
    }], { clientName: 'Global Enterprises' });

    expect(calls.map((c) => c.text)).toEqual(['•  Client: ', 'Global Enterprises']);
    expect(calls.map((c) => c.font.name)).toEqual(['bold', 'italic']);
    // pdf-lib colors are 0..1 components.
    expect(calls[1].color).toMatchObject({ red: 26 / 255, green: 86 / 255, blue: 219 / 255 });
    // The second segment starts where the first one ends, on the same baseline.
    expect(calls[1].x).toBeCloseTo(calls[0].x + '•  Client: '.length * 12 * 0.5, 5);
    expect(calls[1].y).toBe(calls[0].y);
  });

  it('starts each paragraph block on a new line', async () => {
    const calls = await draw([
      { bullet: false, runs: [{ text: 'First', bold: false, italic: false, color: '#000000' }] },
      { bullet: false, runs: [{ text: 'Second', bold: false, italic: false, color: '#000000' }] },
    ], {});

    expect(calls.map((c) => c.text)).toEqual(['First', 'Second']);
    expect(calls[1].y).toBeLessThan(calls[0].y);
    expect(calls[1].x).toBe(calls[0].x);
  });

  it('draws nothing for a box whose only content is an unresolved chip', async () => {
    const calls = await draw([{ bullet: false, runs: [{ fieldName: 'missing', bold: false, italic: false, color: '#000000' }] }], {});
    expect(calls).toEqual([]);
  });
});

describe('fillOverlayTemplate: embedded font families', () => {
  it.each([
    ['calibri', 'Carlito-Bold'],
    ['cambria', 'Caladea-BoldItalic'],
    ['pt-serif', 'PTSerif-Bold'],
    ['pt-sans', 'PTSans-Bold'],
  ])('embeds the real %s face for a bold placement', async (family, expectedBaseFont) => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    const pdfBuffer = Buffer.from(await doc.save());

    const filled = await fillOverlayTemplate({
      pdfBuffer,
      placements: [{
        id: 'p',
        page: 1,
        fieldType: 'text',
        fieldName: 'name',
        fontFamily: family,
        fontSize: 12,
        bold: true,
        italic: family === 'cambria',
        xPercent: 10,
        yPercent: 10,
        widthPercent: 60,
        heightPercent: 5,
      }],
      values: { name: 'Embedded' },
    });

    // The embedded font's /BaseFont names the face that was actually used, so
    // a fake bold (the regular file drawn twice, or the wrong file) shows up
    // here as the wrong name.
    // A fontkit-embedded face is a Type0 font plus its CIDFont descendant,
    // both naming the same /BaseFont, hence the de-duplication.
    expect([...new Set(await embeddedFontNames(filled))]).toEqual([expect.stringContaining(expectedBaseFont)]);
    expect(await drawnTextOperatorCount(filled)).toBe(1);
  });
});

describe('fillOverlayTemplate: characters the chosen font cannot draw', () => {
  async function blankPdf() {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    return Buffer.from(await doc.save());
  }

  const field = (fieldName: string, fontFamily: string, extra: Record<string, unknown> = {}) => ({
    id: `p-${fieldName}`,
    page: 1,
    fieldType: 'text',
    fieldName,
    fontFamily,
    fontSize: 12,
    xPercent: 10,
    yPercent: 10,
    widthPercent: 60,
    heightPercent: 5,
    ...extra,
  });

  async function fill(placements: any[], values: Record<string, string>) {
    const incomplete: Array<{ fieldName: string; characters: string[] }> = [];
    const filled = await fillOverlayTemplate({
      pdfBuffer: await blankPdf(),
      placements,
      values,
      onIncompleteField: (fieldName: string, characters: string[]) => incomplete.push({ fieldName, characters }),
    });
    return { filled, incomplete, fonts: [...new Set(await embeddedFontNames(filled))] };
  }

  it('keeps the standard font for a value it can draw', async () => {
    const { filled, incomplete, fonts } = await fill([field('name', 'times')], { name: 'Jane Smith' });

    expect(fonts).toEqual(['Times-Roman']);
    expect(await drawnTextOperatorCount(filled)).toBe(1);
    expect(incomplete).toEqual([]);
  });

  it('draws a Polish name in Times with the bundled serif instead of leaving the box blank', async () => {
    const { filled, incomplete, fonts } = await fill([field('name', 'times')], { name: 'Łukasz Żółć' });

    expect(fonts).toEqual([expect.stringContaining('PTSerif-Regular')]);
    expect(await drawnTextOperatorCount(filled)).toBe(1);
    expect(incomplete).toEqual([]);
  });

  it('keeps the bold face when it falls back', async () => {
    const { fonts } = await fill([field('name', 'helvetica', { bold: true })], { name: 'Dvořák' });

    expect(fonts).toEqual([expect.stringContaining('PTSans-Bold')]);
  });

  it('keeps the standard font for an accent typed as a separate combining mark', async () => {
    // "Café" as macOS input often sends it: e followed by U+0301. Helvetica
    // has no glyph for the bare mark, but it does have the composed é.
    const { filled, incomplete, fonts } = await fill([field('name', 'helvetica')], { name: 'Cafe\u0301 Rene\u0301' });

    expect(fonts).toEqual(['Helvetica']);
    expect(await drawnTextOperatorCount(filled)).toBe(1);
    expect(incomplete).toEqual([]);
  });

  it('goes on to Carlito for a Greek name the PT faces do not cover', async () => {
    const { filled, incomplete, fonts } = await fill([field('name', 'times')], { name: 'Αλέξανδρος' });

    expect(fonts).toEqual([expect.stringContaining('Carlito-Regular')]);
    expect(await drawnTextOperatorCount(filled)).toBe(1);
    expect(incomplete).toEqual([]);
  });

  it('prints what it can and reports the characters no bundled font has', async () => {
    const { filled, incomplete } = await fill([field('company', 'helvetica')], { company: 'Acme 株式会社' });

    expect(await drawnTextOperatorCount(filled)).toBe(1);
    expect(incomplete).toEqual([{ fieldName: 'company', characters: ['株', '式', '会', '社'] }]);
  });

  it('falls back for a non-Latin value inside a rich text box', async () => {
    const richText = [{ bullet: false, runs: [
      { text: 'Client: ', bold: false, italic: false, color: '#000000' },
      { fieldName: 'clientName', bold: true, italic: false, color: '#000000' },
    ] }];
    const { filled, incomplete, fonts } = await fill(
      [field('Client', 'times', { fieldType: 'textbox', richText })],
      { clientName: 'Łukasz Żółć' },
    );

    expect(fonts).toEqual(expect.arrayContaining([expect.stringContaining('PTSerif-Bold')]));
    expect(fonts).not.toContain('Times-Bold');
    expect(await drawnTextOperatorCount(filled)).toBe(2);
    expect(incomplete).toEqual([]);
  });
});
