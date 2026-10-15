import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import {
  fillPdfForm,
  PdfFormError,
  readPdfFormFields,
  renamePdfFormFields,
} from '../../../src/modules/wordTemplates/lib/pdf-form'

// Tests for fillable-PDF template support.
//
// WHY (Rule 9): the stored PDF is the source of truth: its own field names ARE
// the template's fields, so a rename that collides or a fill that writes the
// wrong field is not recoverable from the database. These pin the two rules
// that keep that safe: no two fields may end up sharing a name, and filling is
// by name, never by position.

async function makeForm(
  fields: Array<{ name: string; kind?: 'text' | 'checkbox' }>,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const form = pdf.getForm()
  fields.forEach((f, i) => {
    const y = 700 - i * 40
    if (f.kind === 'checkbox') {
      const cb = form.createCheckBox(f.name)
      cb.addToPage(page, { x: 60, y, width: 16, height: 16 })
    } else {
      form.createTextField(f.name).addToPage(page, { x: 60, y, width: 300, height: 24 })
    }
  })
  return pdf.save()
}

// One text field with a fixed font size in its /DA, the way court forms are
// drafted: the size does not adapt to the value. The box ends at the page's
// right margin like a real form's blank, so a value that overflows it would
// also run off the page.
async function makeFixedSizeField(opts: {
  width: number
  height: number
  fontSize: number
  multiline?: boolean
}): Promise<{ bytes: Uint8Array; box: { right: number; bottom: number } }> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const field = pdf.getForm().createTextField('client_name')
  if (opts.multiline) field.enableMultiline()
  const x = 612 - 20 - opts.width
  field.addToPage(page, { x, y: 600, width: opts.width, height: opts.height })
  field.setFontSize(opts.fontSize)
  return { bytes: await pdf.save(), box: { right: x + opts.width, bottom: 600 } }
}

// The first page as a reader sees it: each run of text, where it sits and at
// what size. Read with pdfjs because a flattened page's content is compressed.
// pdfjs ships as ES modules only, which Jest's CommonJS runtime cannot load, so
// it runs in a child Node process and hands its text runs back as JSON.
const PDFJS_TEXT_SCRIPT = `
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const doc = await pdfjs.getDocument({ data: new Uint8Array(Buffer.concat(chunks)), disableFontFace: true, verbosity: 0 }).promise
const { items } = await (await doc.getPage(1)).getTextContent()
process.stdout.write(JSON.stringify(items.flatMap((item) =>
  'str' in item && item.str.trim()
    ? [{ str: item.str, right: item.transform[4] + item.width, y: item.transform[5], size: item.height }]
    : [])))
`

async function printedText(
  bytes: Uint8Array,
): Promise<Array<{ str: string; right: number; y: number; size: number }>> {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', PDFJS_TEXT_SCRIPT], {
    input: Buffer.from(bytes),
    cwd: join(__dirname, '../../..'),
  })
  return JSON.parse(out.toString('utf8'))
}

const LONG_NAME = 'Smith, John A. Jr. and Jane B. Smith-Oconnor, co-defendants in the matter'

describe('readPdfFormFields', () => {
  it('lists fields with their kinds, in order', async () => {
    const bytes = await makeForm([
      { name: 'Plaintiff Full Name' },
      { name: 'Agree', kind: 'checkbox' },
      { name: 'Case Number' },
    ])

    expect(await readPdfFormFields(bytes)).toEqual([
      { name: 'Plaintiff Full Name', kind: 'text', index: 0 },
      { name: 'Agree', kind: 'checkbox', index: 1 },
      { name: 'Case Number', kind: 'text', index: 2 },
    ])
  })

  it('returns nothing for a PDF with no form', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([612, 792])
    expect(await readPdfFormFields(await pdf.save())).toEqual([])
  })

  it('refuses a file that is not a PDF', async () => {
    await expect(readPdfFormFields(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(PdfFormError)
  })

  it('refuses a control it cannot fill rather than dropping it', async () => {
    // A dropdown would otherwise vanish from the field list, producing a
    // template that looks complete but cannot fill that field.
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([612, 792])
    pdf.getForm().createDropdown('Court').addToPage(page, { x: 60, y: 700, width: 200, height: 24 })

    await expect(readPdfFormFields(await pdf.save())).rejects.toThrow(PdfFormError)
  })
})

describe('renamePdfFormFields', () => {
  it('writes the chosen names into the PDF so it is self-describing', async () => {
    // templates.fields is a text[] with nowhere to store a name mapping, so the
    // stored file has to carry it.
    const bytes = await makeForm([{ name: 'Plaintiff Full Name' }, { name: 'Case Number' }])

    const renamed = await renamePdfFormFields(bytes, {
      'Plaintiff Full Name': 'client_name',
      'Case Number': 'case_number',
    })

    expect((await readPdfFormFields(renamed)).map((f) => f.name)).toEqual([
      'client_name',
      'case_number',
    ])
  })

  it('leaves unmapped fields alone', async () => {
    const bytes = await makeForm([{ name: 'Keep Me' }, { name: 'Rename Me' }])
    const renamed = await renamePdfFormFields(bytes, { 'Rename Me': 'renamed' })
    expect((await readPdfFormFields(renamed)).map((f) => f.name)).toEqual(['Keep Me', 'renamed'])
  })

  it('refuses a rename that would collide with another field', async () => {
    // Two fields sharing a name fill from one value and silently merge: on a
    // complaint that would put the plaintiff's name in the defendant's blank.
    const bytes = await makeForm([{ name: 'Party A' }, { name: 'Party B' }])
    await expect(renamePdfFormFields(bytes, { 'Party A': 'name', 'Party B': 'name' })).rejects.toThrow(
      PdfFormError,
    )
  })

  it('refuses a rename onto an existing untouched field name', async () => {
    const bytes = await makeForm([{ name: 'Party A' }, { name: 'name' }])
    await expect(renamePdfFormFields(bytes, { 'Party A': 'name' })).rejects.toThrow(PdfFormError)
  })
})

// Several tests below read the flattened output back with pdfjs, which is slow
// under a parallel full-suite run.
describe('fillPdfForm', () => {
  it('fills by name and flattens the result', async () => {
    const bytes = await makeForm([{ name: 'client_name' }, { name: 'case_number' }])

    const { bytes: filled } = await fillPdfForm(bytes, {
      client_name: 'Marcus T. Whitfield',
      case_number: 'CP-26-CV-004821',
    })

    // Flattened: the values are baked into the page, so the download is a
    // finished filing rather than a form someone could edit after signing.
    expect(await readPdfFormFields(filled)).toEqual([])

    // ...and the values really were applied. Read them back before flattening,
    // since a flattened page's content stream is compressed and not greppable.
    const { bytes: editable } = await fillPdfForm(bytes, {
      client_name: 'Marcus T. Whitfield',
      case_number: 'CP-26-CV-004821',
    }, { flatten: false })
    const form = (await PDFDocument.load(editable)).getForm()
    expect(form.getTextField('client_name').getText()).toBe('Marcus T. Whitfield')
    expect(form.getTextField('case_number').getText()).toBe('CP-26-CV-004821')
  })

  it('keeps the form editable when flattening is turned off', async () => {
    const bytes = await makeForm([{ name: 'client_name' }])
    const { bytes: filled } = await fillPdfForm(bytes, { client_name: 'X' }, { flatten: false })
    expect((await readPdfFormFields(filled)).map((f) => f.name)).toEqual(['client_name'])
  })

  it('ignores unknown keys and blanks instead of failing the whole fill', async () => {
    // Mirrors the docx fill's nullGetter: an unfilled field renders empty.
    const bytes = await makeForm([{ name: 'client_name' }])
    const { bytes: filled, unfilledFields } = await fillPdfForm(bytes, {
      client_name: '',
      not_a_field: 'ignored',
    })
    expect(filled).toBeInstanceOf(Uint8Array)
    // ...and the blank comes back named, so the caller can say which field the
    // flattened filing left empty instead of shipping the gap unannounced.
    expect(unfilledFields).toEqual(['client_name'])
  })

  it('clears a value the stored PDF already carries when no value is given', async () => {
    // A form uploaded half filled in would otherwise print its old values while
    // the fill reports those very fields as blank.
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([612, 792])
    const form = pdf.getForm()
    const text = form.createTextField('client_name')
    text.addToPage(page, { x: 60, y: 700, width: 300, height: 24 })
    text.setText('Previous Client')
    const box = form.createCheckBox('agree')
    box.addToPage(page, { x: 60, y: 650, width: 16, height: 16 })
    box.check()
    const bytes = await pdf.save()

    const { bytes: filled, unfilledFields } = await fillPdfForm(bytes, {}, { flatten: false })

    const refilled = (await PDFDocument.load(filled)).getForm()
    expect(unfilledFields).toEqual(['client_name', 'agree'])
    expect(refilled.getTextField('client_name').getText() ?? '').toBe('')
    expect(refilled.getCheckBox('agree').isChecked()).toBe(false)
  })

  it('ticks a checkbox on affirmatives and clears it otherwise', async () => {
    const bytes = await makeForm([
      { name: 'agree', kind: 'checkbox' },
      { name: 'decline', kind: 'checkbox' },
    ])

    const { bytes: filled } = await fillPdfForm(bytes, { agree: 'X', decline: 'no' }, { flatten: false })
    const pdf = await PDFDocument.load(filled)
    const form = pdf.getForm()

    expect(form.getCheckBox('agree').isChecked()).toBe(true)
    expect(form.getCheckBox('decline').isChecked()).toBe(false)
  })

  it('ticks a checkbox for a tick mark and leaves it clear for a cross mark', async () => {
    // Staff type a tick into a checkbox blank as often as "X"; a tick that left
    // the box empty printed the opposite of what they answered.
    const names = ['check', 'heavy_check', 'ballot_box', 'emoji_check', 'cross', 'heavy_cross']
    const bytes = await makeForm(names.map((name) => ({ name, kind: 'checkbox' as const })))

    const { bytes: filled } = await fillPdfForm(
      bytes,
      {
        check: '✓',
        heavy_check: '✔',
        ballot_box: '☑',
        emoji_check: '✔\uFE0F',
        cross: '✗',
        heavy_cross: '✘',
      },
      { flatten: false },
    )
    const form = (await PDFDocument.load(filled)).getForm()

    expect(Object.fromEntries(names.map((n) => [n, form.getCheckBox(n).isChecked()]))).toEqual({
      check: true,
      heavy_check: true,
      ballot_box: true,
      emoji_check: true,
      cross: false,
      heavy_cross: false,
    })
  })

  it('shrinks a value too wide for its field so all of it prints', async () => {
    // A party name cut off at the edge of its blank ships a signed agreement
    // that misnames the client.
    const { bytes, box } = await makeFixedSizeField({ width: 260, height: 24, fontSize: 12 })

    const { bytes: filled } = await fillPdfForm(bytes, { client_name: LONG_NAME })
    const runs = await printedText(filled)

    expect(runs.map((r) => r.str)).toEqual([LONG_NAME])
    expect(runs[0].right).toBeLessThanOrEqual(box.right)
    expect(runs[0].size).toBeLessThan(12)
  })

  it('leaves a value that already fits at the size the form was drafted with', async () => {
    // Only an overflowing value may change; every other blank keeps the look
    // the form's author gave it.
    const { bytes } = await makeFixedSizeField({ width: 260, height: 24, fontSize: 12 })

    const { bytes: filled } = await fillPdfForm(bytes, { client_name: 'Marcus T. Whitfield' })

    expect((await printedText(filled)).map((r) => [r.str, r.size])).toEqual([
      ['Marcus T. Whitfield', 12],
    ])
  })

  it('stops shrinking at 5pt rather than printing a value too small to read', async () => {
    // Text below 5pt looks filled in but cannot be read on paper; a visibly cut
    // value at least shows staff the field needs a shorter entry.
    const { bytes } = await makeFixedSizeField({ width: 120, height: 24, fontSize: 12 })

    const { bytes: filled } = await fillPdfForm(bytes, { client_name: LONG_NAME })

    expect((await printedText(filled)).map((r) => r.size)).toEqual([5])
  })

  it('shrinks a multiline value until every wrapped line sits inside its box', async () => {
    // The value wraps at the form's fixed size, but lines past the bottom of the
    // box are clipped away when the form is flattened.
    const { bytes, box } = await makeFixedSizeField({
      width: 200,
      height: 40,
      fontSize: 12,
      multiline: true,
    })
    const value = `${LONG_NAME}. ${LONG_NAME}.`

    const { bytes: filled } = await fillPdfForm(bytes, { client_name: value })
    const runs = await printedText(filled)

    expect(runs.map((r) => r.str).join(' ')).toBe(value)
    for (const run of runs) expect(run.y).toBeGreaterThanOrEqual(box.bottom)
  })

  it('prints a name the standard PDF font cannot encode instead of failing the download', async () => {
    // pdf-lib's built-in Helvetica covers only WinAnsi, so a Polish or Hungarian
    // client's name threw "WinAnsi cannot encode" and no document came out.
    const bytes = await makeForm([{ name: 'client_name' }, { name: 'case_number' }])
    const values = { client_name: 'Łukasz Żółć', case_number: 'CP-26-CV-004821' }

    const { bytes: filled } = await fillPdfForm(bytes, values)
    expect((await printedText(filled)).map((r) => r.str)).toEqual([
      'Łukasz Żółć',
      'CP-26-CV-004821',
    ])

    // Only the field that needs the fallback font gets it; a plain value keeps
    // the font the form fills with today.
    const { bytes: editable } = await fillPdfForm(bytes, values, { flatten: false })
    const form = (await PDFDocument.load(editable)).getForm()
    expect(form.getTextField('client_name').acroField.getDefaultAppearance()).toContain(
      'LiberationSans',
    )
    expect(form.getTextField('case_number').acroField.getDefaultAppearance()).toContain(
      '/Helvetica ',
    )
  })
})
