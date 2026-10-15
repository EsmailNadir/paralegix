/**
 * Flattening an AcroForm so the signer never sees an editable field.
 *
 * The failure this file exists to catch is not a crash. It is a flattened
 * document that still LOOKS right from inside this codebase: the field count
 * dropped to zero, the response said success, and the page now shows an
 * unchecked box where the client had ticked "I agree". Counting fields before
 * and after proves nothing about that, so every case below compares the
 * DISPLAYED value with what was actually placed on the page.
 *
 * The specific defects being pinned:
 *
 *   `/AS` IGNORED. `/AP /N` for a checkbox or a radio button is a dictionary of
 *   appearance states, and `/AS` names the one on show. An implementation that
 *   takes the first key places the ON appearance for every box in the document.
 *
 *   INHERITED VALUES LOST. A radio group's `/V` lives on the parent field, not
 *   on the button that is selected, and a text field's `/V` frequently does too.
 *
 *   `/Matrix` AND A SHIFTED BBOX DROPPED. An appearance is placed by mapping its
 *   transformed bounding box onto the widget's `/Rect`. Assuming an identity
 *   matrix and an origin of (0, 0) puts the mark somewhere else on the page.
 *
 *   A MISSING APPEARANCE GUESSED. `/NeedAppearances true` says the viewer was
 *   expected to build appearances that are not in the file. Rendering something
 *   plausible instead is inventing the signer's own answers.
 */
import {
  planFormFlattening,
  flattenAcroForm,
  PdfFormError,
} from '../../../src/modules/signatures/pdf/forms';
import type {
  FlattenedWidget,
  FormFlattenPlan,
} from '../../../src/modules/signatures/pdf/forms';
import { readDocumentIndex, getObject } from '../../../src/modules/signatures/pdf/reader';
import type { PdfDict, PdfSource, PdfValue } from '../../../src/modules/signatures/pdf/types';

const signal = new AbortController().signal;

function sourceOver(bytes: Buffer): PdfSource {
  return {
    ref: { objectPath: 'firm/upload.pdf', generation: '1', sizeBytes: bytes.length },
    async read(start, length) {
      if (start + length > bytes.length) throw new Error('read past the end');
      return new Uint8Array(bytes.subarray(start, start + length));
    },
    async *stream(start, endExclusive) { yield new Uint8Array(bytes.subarray(start, endExclusive)); },
    async close() {},
  };
}

interface ObjectSpec { n: number; body: string }

/** A stream object whose `/Length` is measured rather than guessed. */
function streamObject(n: number, entries: string, payload: string): ObjectSpec {
  return { n, body: `<< ${entries} /Length ${payload.length} >>\nstream\n${payload}\nendstream` };
}

/** A Form XObject standing in for a field's normal appearance. */
function appearance(n: number, bbox = '[0 0 20 20]', extras = '', payload = '0 0 1 rg 0 0 20 20 re f') {
  return streamObject(n, `/Type /XObject /Subtype /Form /BBox ${bbox} ${extras}`, payload);
}

/** A classic-xref document from a list of object bodies. */
function document(objects: ObjectSpec[]): Buffer {
  let out = '%PDF-1.7\n';
  const offsets = new Map<number, number>();
  for (const object of objects) {
    offsets.set(object.n, out.length);
    out += `${object.n} 0 obj\n${object.body}\nendobj\n`;
  }
  const xrefAt = out.length;
  const max = Math.max(...objects.map((o) => o.n));
  out += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= max; n += 1) {
    out += offsets.has(n)
      ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`
      : '0000000000 65535 f \n';
  }
  out += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * A one-page document carrying a form.
 *
 * The page keeps its own content stream and its own font resource throughout,
 * because "resources other content still uses stay" is one of the things
 * flattening has to not break.
 */
function formDocument(options: {
  annots: string;
  fields: string;
  acroForm?: string;
  extra: ObjectSpec[];
}): Buffer {
  const { annots, fields, acroForm = '', extra } = options;
  return document([
    { n: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm 20 0 R >>' },
    { n: 2, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>' },
    {
      n: 3,
      body: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R '
        + '/Resources << /Font << /F1 5 0 R >> >> '
        + `/Annots [${annots}] >>`,
    },
    streamObject(4, '', 'BT /F1 12 Tf 72 720 Td (Retainer agreement) Tj ET'),
    { n: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    { n: 20, body: `<< /Fields [${fields}] ${acroForm} >>` },
    ...extra,
  ]);
}

const planOf = async (bytes: Buffer): Promise<FormFlattenPlan> => {
  const source = sourceOver(bytes);
  return planFormFlattening({ source, index: await readDocumentIndex(source, signal), signal });
};

/** The plan, refusing to type-narrow silently when the document had no form. */
async function flattenPlan(bytes: Buffer) {
  const plan = await planOf(bytes);
  if (plan.kind !== 'flatten') throw new Error(`expected a flatten plan and got "${plan.kind}"`);
  return plan;
}

const widgetNamed = (widgets: FlattenedWidget[], field: string) => {
  const found = widgets.find((w) => w.fieldName === field);
  if (!found) throw new Error(`no flattened widget for the field "${field}"`);
  return found;
};

/** A widget the plan actually placed, with its appearance and transform present. */
function drawn(widget: FlattenedWidget) {
  const { appearanceRef, resourceName, matrix } = widget;
  if (!appearanceRef || !resourceName || !matrix) {
    throw new Error(`the widget for "${widget.fieldName}" drew nothing`);
  }
  return { ...widget, appearanceRef, resourceName, matrix };
}

const isDict = (value: PdfValue | undefined): value is PdfDict =>
  !!value && typeof value === 'object' && (value as any).kind === 'dict';

/** The XObject resource dictionary of the page object the plan rewrote. */
function pageXObjects(objects: Array<{ ref: { objectNumber: number }; value: PdfValue }>, pageNumber = 3) {
  const page = objects.find((o) => o.ref.objectNumber === pageNumber);
  if (!page || !isDict(page.value)) throw new Error('the plan did not rewrite the page');
  const resources = page.value.entries.get('Resources');
  if (!isDict(resources)) throw new Error('the rewritten page has no resources');
  const xobjects = resources.entries.get('XObject');
  if (!isDict(xobjects)) throw new Error('the rewritten page has no XObject resources');
  return xobjects;
}

/** Which object a resource name on the page now points at. */
function resourceTarget(xobjects: PdfDict, resourceName: string): number {
  const entry = xobjects.entries.get(resourceName);
  if (!entry || typeof entry !== 'object' || (entry as any).kind !== 'ref') {
    throw new Error(`the resource /${resourceName} is not an indirect reference`);
  }
  return (entry as any).value.objectNumber as number;
}

/** Everything the plan appended as content stream bytes, joined. */
function appendedContent(objects: Array<{ streamBytes?: Uint8Array }>): string {
  return objects
    .filter((o) => o.streamBytes)
    .map((o) => Buffer.from(o.streamBytes!).toString('latin1'))
    .join('\n');
}

describe('appearance states', () => {
  /**
   * Two checkboxes sharing one pair of appearance streams: object 12 is the ON
   * mark and object 13 is the empty box. Sharing them is what makes the
   * assertion sharp, because an implementation that ignores `/AS` places 12 for
   * both and the two boxes become indistinguishable on the page.
   */
  const twoCheckboxes = (agreeState = '/Yes', declineState = '/Off') => formDocument({
    annots: '10 0 R 11 0 R',
    fields: '10 0 R 11 0 R',
    extra: [
      {
        n: 10,
        body: '<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /V /Yes '
          + `/AS ${agreeState} /Rect [100 100 120 120] /P 3 0 R `
          + '/AP << /N << /Yes 12 0 R /Off 13 0 R >> >> >>',
      },
      {
        n: 11,
        body: '<< /Type /Annot /Subtype /Widget /FT /Btn /T (decline) /V /Off '
          + `/AS ${declineState} /Rect [100 200 120 220] /P 3 0 R `
          + '/AP << /N << /Yes 12 0 R /Off 13 0 R >> >> >>',
      },
      appearance(12, '[0 0 20 20]', '', '0 0 0 rg 4 4 m 16 16 l S'),
      appearance(13, '[0 0 20 20]', '', '0.5 G 0 0 20 20 re S'),
    ],
  });

  it('places the ON appearance for a ticked box and the OFF appearance for a clear one', async () => {
    // Goes red the moment /AS is ignored and the first key of /AP /N wins:
    // both widgets then resolve to object 12 and the page shows two ticks.
    const plan = await flattenPlan(twoCheckboxes());

    const agree = drawn(widgetNamed(plan.widgets, 'agree'));
    const decline = drawn(widgetNamed(plan.widgets, 'decline'));

    expect(agree.appearanceState).toBe('Yes');
    expect(decline.appearanceState).toBe('Off');
    expect(agree.appearanceRef.objectNumber).toBe(12);
    expect(decline.appearanceRef.objectNumber).toBe(13);

    const xobjects = pageXObjects(plan.objects);
    expect(agree.resourceName).not.toBe(decline.resourceName);
    expect(resourceTarget(xobjects, agree.resourceName)).toBe(12);
    expect(resourceTarget(xobjects, decline.resourceName)).toBe(13);

    const content = appendedContent(plan.objects);
    expect(content).toContain(`/${agree.resourceName} Do`);
    expect(content).toContain(`/${decline.resourceName} Do`);
  });

  it('refuses a box whose /AS disagrees with its value', async () => {
    // /V says /Yes and /AS shows the empty box. The document cannot be shown to
    // the signer as an accurate picture of what it holds, so it is refused
    // rather than flattened to one of the two answers.
    await expect(flattenPlan(twoCheckboxes('/Off'))).rejects.toMatchObject({
      code: 'PDF_UNSUPPORTED_FORM',
    });
  });

  it('refuses a box with appearance states and no /AS at all', async () => {
    const bytes = formDocument({
      annots: '10 0 R',
      fields: '10 0 R',
      extra: [
        {
          n: 10,
          body: '<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /V /Yes '
            + '/Rect [100 100 120 120] /P 3 0 R /AP << /N << /Yes 12 0 R /Off 13 0 R >> >> >>',
        },
        appearance(12),
        appearance(13),
      ],
    });

    await expect(flattenPlan(bytes)).rejects.toBeInstanceOf(PdfFormError);
  });

  it('selects one button of a radio group from the value on the parent field', async () => {
    // The group's /V lives on field 30. Only kid 32 carries a /Courier state, so
    // an implementation that reads /V off the widget sees no value, expects
    // every button to be /Off, and refuses kid 32 outright.
    const bytes = formDocument({
      annots: '31 0 R 32 0 R 33 0 R',
      fields: '30 0 R',
      extra: [
        { n: 30, body: '<< /FT /Btn /Ff 32768 /T (delivery) /V /Courier /Kids [31 0 R 32 0 R 33 0 R] >>' },
        {
          n: 31,
          body: '<< /Type /Annot /Subtype /Widget /Parent 30 0 R /Rect [100 100 120 120] /P 3 0 R '
            + '/AS /Off /AP << /N << /Mail 40 0 R /Off 43 0 R >> >> >>',
        },
        {
          n: 32,
          body: '<< /Type /Annot /Subtype /Widget /Parent 30 0 R /Rect [100 140 120 160] /P 3 0 R '
            + '/AS /Courier /AP << /N << /Courier 41 0 R /Off 43 0 R >> >> >>',
        },
        {
          n: 33,
          body: '<< /Type /Annot /Subtype /Widget /Parent 30 0 R /Rect [100 180 120 200] /P 3 0 R '
            + '/AS /Off /AP << /N << /Fax 42 0 R /Off 43 0 R >> >> >>',
        },
        appearance(40), appearance(41), appearance(42), appearance(43),
      ],
    });

    const plan = await flattenPlan(bytes);

    expect(plan.widgets).toHaveLength(3);
    expect(plan.widgets.map((w) => w.appearanceState)).toEqual(['Off', 'Courier', 'Off']);
    expect(plan.widgets.map((w) => drawn(w).appearanceRef.objectNumber)).toEqual([43, 41, 43]);
    expect(plan.widgets.every((w) => w.fieldName === 'delivery')).toBe(true);
  });

  it('refuses a radio button that shows a state the group did not select', async () => {
    const bytes = formDocument({
      annots: '31 0 R 32 0 R',
      fields: '30 0 R',
      extra: [
        { n: 30, body: '<< /FT /Btn /Ff 32768 /T (delivery) /V /Courier /Kids [31 0 R 32 0 R] >>' },
        {
          n: 31,
          // Shows /Mail while the group's value is /Courier.
          body: '<< /Type /Annot /Subtype /Widget /Parent 30 0 R /Rect [100 100 120 120] /P 3 0 R '
            + '/AS /Mail /AP << /N << /Mail 40 0 R /Off 43 0 R >> >> >>',
        },
        {
          n: 32,
          body: '<< /Type /Annot /Subtype /Widget /Parent 30 0 R /Rect [100 140 120 160] /P 3 0 R '
            + '/AS /Courier /AP << /N << /Courier 41 0 R /Off 43 0 R >> >> >>',
        },
        appearance(40), appearance(41), appearance(43),
      ],
    });

    await expect(flattenPlan(bytes)).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED_FORM' });
  });
});

describe('text and choice values', () => {
  const textField = (value: string, shown: string, extras = '') => formDocument({
    annots: '51 0 R',
    fields: '50 0 R',
    extra: [
      { n: 50, body: `<< /FT /Tx /T (client) /V (${value}) ${extras} /Kids [51 0 R] >>` },
      {
        n: 51,
        body: '<< /Type /Annot /Subtype /Widget /Parent 50 0 R /Rect [72 600 300 620] /P 3 0 R '
          + '/AP << /N 52 0 R >> >>',
      },
      streamObject(
        52,
        '/Type /XObject /Subtype /Form /BBox [0 0 228 20]',
        `/Tx BMC q BT /F1 10 Tf 2 5 Td (${shown}) Tj ET Q EMC`,
      ),
    ],
  });

  it('flattens a text field whose value lives on the parent', async () => {
    const plan = await flattenPlan(textField('Acme Holdings', 'Acme Holdings'));

    const widget = drawn(widgetNamed(plan.widgets, 'client'));
    expect(widget.fieldType).toBe('Tx');
    expect(widget.appearanceRef.objectNumber).toBe(52);
    expect(resourceTarget(pageXObjects(plan.objects), widget.resourceName)).toBe(52);
  });

  it('refuses when the appearance shows something other than the value', async () => {
    // The value the document holds and the value the signer would see disagree.
    // Placing the appearance signs a picture of the wrong answer.
    await expect(flattenPlan(textField('Acme Holdings', 'Beta Partners')))
      .rejects.toMatchObject({ code: 'PDF_UNSUPPORTED_FORM' });
  });

  it('accepts a comb appearance that draws the value one glyph at a time', async () => {
    const bytes = formDocument({
      annots: '51 0 R',
      fields: '50 0 R',
      extra: [
        { n: 50, body: '<< /FT /Tx /T (ref) /V (AB12) /Kids [51 0 R] >>' },
        {
          n: 51,
          body: '<< /Type /Annot /Subtype /Widget /Parent 50 0 R /Rect [72 560 200 580] /P 3 0 R '
            + '/AP << /N 52 0 R >> >>',
        },
        streamObject(
          52,
          '/Type /XObject /Subtype /Form /BBox [0 0 128 20]',
          'BT /F1 10 Tf 2 5 Td (A) Tj 10 0 Td (B) Tj 10 0 Td (1) Tj 10 0 Td (2) Tj ET',
        ),
      ],
    });

    const plan = await flattenPlan(bytes);

    expect(drawn(widgetNamed(plan.widgets, 'ref')).appearanceRef.objectNumber).toBe(52);
  });

  it('flattens a read-only text field like any other', async () => {
    // Read-only means the signer cannot retype it. It is still a live form
    // field that a viewer renders from /AP, so it still has to be flattened.
    const plan = await flattenPlan(textField('Matter 2231', 'Matter 2231', '/Ff 1'));

    expect(drawn(widgetNamed(plan.widgets, 'client')).appearanceRef.objectNumber).toBe(52);
  });

  it('flattens a choice field showing its selected option', async () => {
    const bytes = formDocument({
      annots: '61 0 R',
      fields: '61 0 R',
      extra: [
        {
          n: 61,
          body: '<< /Type /Annot /Subtype /Widget /FT /Ch /T (state) /V (California) '
            + '/Opt [(California) (Nevada)] /Rect [72 500 220 520] /P 3 0 R /AP << /N 62 0 R >> >>',
        },
        streamObject(
          62,
          '/Type /XObject /Subtype /Form /BBox [0 0 148 20]',
          'q BT /F1 10 Tf 2 5 Td (California) Tj ET Q',
        ),
      ],
    });

    const plan = await flattenPlan(bytes);

    const widget = drawn(widgetNamed(plan.widgets, 'state'));
    expect(widget.fieldType).toBe('Ch');
    expect(widget.appearanceRef.objectNumber).toBe(62);
  });

  it('refuses a choice field whose appearance shows an option it did not select', async () => {
    const bytes = formDocument({
      annots: '61 0 R',
      fields: '61 0 R',
      extra: [
        {
          n: 61,
          body: '<< /Type /Annot /Subtype /Widget /FT /Ch /T (state) /V (California) '
            + '/Opt [(California) (Nevada)] /Rect [72 500 220 520] /P 3 0 R /AP << /N 62 0 R >> >>',
        },
        streamObject(
          62,
          '/Type /XObject /Subtype /Form /BBox [0 0 148 20]',
          'q BT /F1 10 Tf 2 5 Td (Nevada) Tj ET Q',
        ),
      ],
    });

    await expect(flattenPlan(bytes)).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED_FORM' });
  });
});

describe('placing the appearance', () => {
  it('maps a transformed BBox onto the widget rectangle', async () => {
    /**
     * BBox [10 20 60 45], so 50 wide by 25 high with its origin away from zero.
     * /Matrix [0 1 -1 0 0 0] maps (x, y) to (-y, x), which turns those corners
     * into (-20, 10), (-20, 60), (-45, 60) and (-45, 10). The bounding box of
     * that is x from -45 to -20 (25 wide) and y from 10 to 60 (50 high).
     *
     * /Rect [100 200 150 300] is 50 wide by 100 high, so the scale is 50/25 = 2
     * across and 100/50 = 2 up. The translation places the transformed box's
     * lower left corner on the rectangle's:
     *
     *   e = 100 - 2 * (-45) = 190
     *   f = 200 - 2 * 10    = 180
     *
     * The form's own /Matrix is applied by the Do operator, so the content
     * stream carries only this mapping: [2 0 0 2 190 180].
     */
    const bytes = formDocument({
      annots: '70 0 R',
      fields: '70 0 R',
      extra: [
        {
          n: 70,
          body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (initials) '
            + '/Rect [100 200 150 300] /P 3 0 R /AP << /N 71 0 R >> >>',
        },
        appearance(71, '[10 20 60 45]', '/Matrix [0 1 -1 0 0 0]'),
      ],
    });

    const plan = await flattenPlan(bytes);
    const widget = drawn(widgetNamed(plan.widgets, 'initials'));

    expect(widget.matrix).toEqual([2, 0, 0, 2, 190, 180]);
    expect(appendedContent(plan.objects)).toContain(`2 0 0 2 190 180 cm\n/${widget.resourceName} Do`);
  });

  it('places an identity appearance exactly on its rectangle', async () => {
    const bytes = formDocument({
      annots: '70 0 R',
      fields: '70 0 R',
      extra: [
        {
          n: 70,
          body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (initials) '
            + '/Rect [72 100 172 140] /P 3 0 R /AP << /N 71 0 R >> >>',
        },
        appearance(71, '[0 0 50 20]'),
      ],
    });

    const plan = await flattenPlan(bytes);

    // 100 / 50 across, 40 / 20 up, and the origin moves to the rectangle's.
    expect(drawn(widgetNamed(plan.widgets, 'initials')).matrix).toEqual([2, 0, 0, 2, 72, 100]);
  });
});

describe('refusing what cannot be proved', () => {
  it('refuses a widget with no normal appearance', async () => {
    const bytes = formDocument({
      annots: '10 0 R',
      fields: '10 0 R',
      extra: [{
        n: 10,
        body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (client) /V (Acme) '
          + '/Rect [72 600 300 620] /P 3 0 R >>',
      }],
    });

    await expect(flattenPlan(bytes)).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED_FORM' });
  });

  it('refuses /NeedAppearances true', async () => {
    // The flag says the viewer was expected to build appearances that are not
    // in this file. Anything placed instead is this code inventing the answer.
    const bytes = formDocument({
      annots: '10 0 R',
      fields: '10 0 R',
      acroForm: '/NeedAppearances true',
      extra: [
        {
          n: 10,
          body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (client) /V (Acme) '
            + '/Rect [72 600 300 620] /P 3 0 R /AP << /N 12 0 R >> >>',
        },
        appearance(12, '[0 0 228 20]', '', 'BT /F1 10 Tf 2 5 Td (Acme) Tj ET'),
      ],
    });

    await expect(flattenPlan(bytes)).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED_FORM' });
  });

  it('refuses an XFA form', async () => {
    const bytes = formDocument({
      annots: '10 0 R',
      fields: '10 0 R',
      acroForm: '/XFA [(preamble) 30 0 R]',
      extra: [
        {
          n: 10,
          body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (client) /V (Acme) '
            + '/Rect [72 600 300 620] /P 3 0 R /AP << /N 12 0 R >> >>',
        },
        appearance(12, '[0 0 228 20]', '', 'BT /F1 10 Tf 2 5 Td (Acme) Tj ET'),
        streamObject(30, '', '<xdp/>'),
      ],
    });

    await expect(flattenPlan(bytes)).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED_FORM' });
  });

  it('refuses a widget that no page shows', async () => {
    // A field listed in /Fields whose widget is on no page cannot be proved to
    // display anything, and dropping it silently is a value going missing.
    const bytes = formDocument({
      annots: '',
      fields: '10 0 R',
      extra: [
        {
          n: 10,
          body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (client) /V (Acme) '
            + '/Rect [72 600 300 620] /AP << /N 12 0 R >> >>',
        },
        appearance(12, '[0 0 228 20]', '', 'BT /F1 10 Tf 2 5 Td (Acme) Tj ET'),
      ],
    });

    await expect(flattenPlan(bytes)).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED_FORM' });
  });

  it('removes a hidden widget without drawing anything', async () => {
    // /F bit 2 is Hidden. The widget shows nothing, which is provable, so the
    // absence of an appearance is not a refusal here.
    const bytes = formDocument({
      annots: '10 0 R',
      fields: '10 0 R',
      extra: [{
        n: 10,
        body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (audit) /V (internal) '
          + '/F 2 /Rect [72 600 300 620] /P 3 0 R >>',
      }],
    });

    const plan = await flattenPlan(bytes);

    expect(widgetNamed(plan.widgets, 'audit').appearanceRef).toBeNull();
    expect(appendedContent(plan.objects)).not.toContain(' Do');
  });
});

describe('what stays behind', () => {
  const linkAndWidget = () => formDocument({
    annots: '10 0 R 80 0 R',
    fields: '10 0 R',
    extra: [
      {
        n: 10,
        body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (client) /V (Acme) '
          + '/Rect [72 600 300 620] /P 3 0 R /AP << /N 12 0 R >> >>',
      },
      appearance(12, '[0 0 228 20]', '', 'BT /F1 10 Tf 2 5 Td (Acme) Tj ET'),
      {
        n: 80,
        body: '<< /Type /Annot /Subtype /Link /Rect [72 700 300 720] '
          + '/A << /S /URI /URI (https://example.test/terms) >> >>',
      },
    ],
  });

  it('keeps a link annotation and drops only the widget', async () => {
    const plan = await flattenPlan(linkAndWidget());

    const page = plan.objects.find((o) => o.ref.objectNumber === 3);
    const annots = isDict(page?.value) ? page!.value.entries.get('Annots') : undefined;
    expect(annots && (annots as any).kind).toBe('array');
    const numbers = ((annots as any).values as PdfValue[])
      .map((v) => (v as any).value.objectNumber as number);
    expect(numbers).toEqual([80]);
  });

  it('keeps the font the page content already uses', async () => {
    const plan = await flattenPlan(linkAndWidget());

    const page = plan.objects.find((o) => o.ref.objectNumber === 3);
    const resources = isDict(page?.value) ? page!.value.entries.get('Resources') : undefined;
    expect(isDict(resources) && isDict(resources.entries.get('Font'))).toBe(true);
  });

  it('appends to the page content rather than replacing it', async () => {
    const plan = await flattenPlan(linkAndWidget());

    const page = plan.objects.find((o) => o.ref.objectNumber === 3);
    const contents = isDict(page?.value) ? page!.value.entries.get('Contents') : undefined;
    expect((contents as any).kind).toBe('array');
    const numbers = ((contents as any).values as PdfValue[])
      .map((v) => (v as any).value.objectNumber as number);
    // The original stream is still in the list, and nothing was written over it.
    expect(numbers).toContain(4);
    expect(numbers.indexOf(4)).toBeLessThan(numbers.length - 1);
  });
});

describe('a document with no form', () => {
  const noForm = () => document([
    { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>' },
    { n: 3, body: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>' },
    streamObject(4, '', 'BT /F1 12 Tf 72 720 Td (Retainer agreement) Tj ET'),
  ]);

  it('reports nothing to do rather than an empty update', async () => {
    // An empty incremental update is still an appended revision, and a source
    // that gains one has a different digest than the upload it came from.
    expect(await planOf(noForm())).toEqual({ kind: 'no-form' });
  });

  it('produces no suffix at all', async () => {
    const source = sourceOver(noForm());
    const result = await flattenAcroForm({
      source,
      index: await readDocumentIndex(source, signal),
      signal,
    });

    expect(result.flattened).toBe(false);
    expect(result).not.toHaveProperty('update');
  });

  it('reports nothing to do for an AcroForm with no fields', async () => {
    const bytes = formDocument({ annots: '', fields: '', extra: [] });

    expect(await planOf(bytes)).toEqual({ kind: 'no-form' });
  });
});

describe('the flattened document, read back', () => {
  const bytes = () => formDocument({
    annots: '10 0 R 80 0 R',
    fields: '10 0 R',
    extra: [
      {
        n: 10,
        body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (client) /V (Acme Holdings) '
          + '/Rect [72 600 300 620] /P 3 0 R /AP << /N 12 0 R >> >>',
      },
      streamObject(
        12,
        '/Type /XObject /Subtype /Form /BBox [0 0 228 20]',
        'BT /F1 10 Tf 2 5 Td (Acme Holdings) Tj ET',
      ),
      {
        n: 80,
        body: '<< /Type /Annot /Subtype /Link /Rect [72 700 300 720] '
          + '/A << /S /URI /URI (https://example.test/terms) >> >>',
      },
    ],
  });

  /** Base plus suffix, opened with the real reader, the way a viewer does. */
  async function composed() {
    const base = bytes();
    const source = sourceOver(base);
    const result = await flattenAcroForm({
      source,
      index: await readDocumentIndex(source, signal),
      signal,
    });
    if (!result.flattened) throw new Error('expected a flattened document');

    const whole = Buffer.concat([base, Buffer.from(result.update.suffix)]);
    // The base has to survive byte for byte, or the prepared source is not the
    // upload with a revision appended, it is a different document.
    expect(whole.subarray(0, base.length).equals(base)).toBe(true);

    const reopened = sourceOver(whole);
    return { source: reopened, index: await readDocumentIndex(reopened, signal), result };
  }

  it('no longer lists the flattened field on the AcroForm', async () => {
    const { source, index } = await composed();

    const acroForm = await getObject(source, index, { objectNumber: 20, generationNumber: 0 }, signal);
    const fields = isDict(acroForm) ? acroForm.entries.get('Fields') : undefined;
    expect((fields as any).values).toEqual([]);
  });

  it('no longer lists the widget on the page, and still lists the link', async () => {
    const { source, index } = await composed();

    const page = await getObject(source, index, { objectNumber: 3, generationNumber: 0 }, signal);
    const annots = isDict(page) ? page.entries.get('Annots') : undefined;
    const numbers = ((annots as any).values as PdfValue[])
      .map((v) => (v as any).value.objectNumber as number);
    expect(numbers).toEqual([80]);
  });

  it('shows the value as page content, through the appearance the field carried', async () => {
    const { source, index } = await composed();

    const page = await getObject(source, index, { objectNumber: 3, generationNumber: 0 }, signal);
    const resources = isDict(page) ? page.entries.get('Resources') : undefined;
    const xobjects = isDict(resources) ? resources.entries.get('XObject') : undefined;
    if (!isDict(xobjects)) throw new Error('the flattened page has no XObject resources');

    const targets = [...xobjects.entries.values()]
      .map((v) => (v as any).value.objectNumber as number);
    // Object 12 is the stream that draws "Acme Holdings". The page reaches it
    // directly now, so the value is content rather than a field a viewer fills.
    expect(targets).toContain(12);
  });

  it('leaves the original appearance stream in place for the page to use', async () => {
    const { source, index } = await composed();

    const appearanceObject = await getObject(
      source,
      index,
      { objectNumber: 12, generationNumber: 0 },
      signal,
    );
    expect(isDict(appearanceObject) && appearanceObject.entries.get('Subtype')).toEqual({
      kind: 'name',
      value: 'Form',
    });
  });
});
