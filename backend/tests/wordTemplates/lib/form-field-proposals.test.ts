import { scanFormFields } from '../../../src/modules/wordTemplates/lib/auto-bracket/form-fields'
import { buildFormFieldProposals, buildPdfFieldProposals } from '../../../src/modules/wordTemplates/lib/auto-bracket/proposals'

// Tests for form-field context + naming.
//
// WHY (Rule 9): Word names a form blank `Text12`, which tells a reviewer
// nothing. The only signal available is the text AROUND the blank: and on a
// real court form that text is usually in a NEIGHBOURING paragraph, because the
// form is a layout table with labels in adjacent cells. These pin the two rules
// that make the review list readable at all: look outside the field's own
// paragraph, and take a checkbox's label from the other side.

const RPR = '<w:rPr><w:sz w:val="22"/></w:rPr>'

function field(name: string, id: number, control: 'text' | 'checkbox' = 'text'): string {
  const ctl = control === 'checkbox' ? '<w:checkBox/>' : '<w:textInput/>'
  return (
    `<w:r>${RPR}<w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="${name}"/>${ctl}</w:ffData></w:fldChar></w:r>` +
    `<w:bookmarkStart w:id="${id}" w:name="${name}"/>` +
    `<w:r>${RPR}<w:fldChar w:fldCharType="end"/></w:r>` +
    `<w:bookmarkEnd w:id="${id}"/>`
  )
}
const para = (inner: string) => `<w:p>${inner}</w:p>`
const text = (t: string) => `<w:r><w:t>${t}</w:t></w:r>`
const doc = (...paras: string[]) => `<w:document><w:body>${paras.join('')}</w:body></w:document>`

function build(xml: string) {
  return buildFormFieldProposals(xml, scanFormFields(xml))
}

describe('buildFormFieldProposals', () => {
  it('names a text field from the label in the preceding cell', () => {
    // The field's OWN paragraph is empty: this is the layout-table shape that
    // makes 70 of 73 blanks on the AO form unreadable without widening.
    const [p] = build(doc(para(text('Bar Number')), para(field('Text1', 1))))

    expect(p.suggestedTag).toBe('bar_number')
    expect(p.contextBefore).toContain('Bar Number')
  })

  it('names a checkbox from the label that FOLLOWS it', () => {
    // A form labels a text blank on its left but a checkbox on its right.
    const [p] = build(doc(para(field('Check1', 1, 'checkbox')), para(text('Yes'))))

    expect(p.control).toBe('checkbox')
    expect(p.suggestedTag).toBe('check_yes')
    expect(p.contextAfter).toContain('Yes')
  })

  it('reads a label from the field own paragraph when it has one', () => {
    const [p] = build(doc(para(text('Division ') + field('Text1', 1))))
    expect(p.suggestedTag).toBe('division')
  })

  it('splits own-paragraph text on both sides of the blank', () => {
    const [p] = build(doc(para(text('Signed on ') + field('Text1', 1) + text(' by the plaintiff'))))
    expect(p.contextBefore).toContain('Signed on')
    expect(p.contextAfter).toContain('by the plaintiff')
  })

  it('strips a leading section marker from the label', () => {
    const [p] = build(doc(para(text('B. Street Address')), para(field('Text1', 1))))
    expect(p.suggestedTag).toBe('street_address')
  })

  it('falls back to a positional name when the nearest text is prose', () => {
    // Without this, a claims section yields a name like
    // `write_a_short_and_plain_statement_of_the_grounds`.
    const prose = 'Write a short and plain statement of the grounds for jurisdiction here please'
    const [p] = build(doc(para(text(prose)), para(field('Text9', 1))))

    expect(p.suggestedTag).toBe('field_1')
  })

  it('skips punctuation-only paragraphs when looking for a label', () => {
    // A court caption's ")" rail is 15 consecutive paragraphs of pure noise.
    const [p] = build(doc(para(text('Case Number')), para(text(')')), para(field('Text1', 1))))
    expect(p.suggestedTag).toBe('case_number')
  })

  it('looks past a long run of noise paragraphs to reach the label', () => {
    // REGRESSION: a court caption's ")" rail is 15 consecutive wordless
    // paragraphs. Charging those against the paragraph budget exhausted it
    // before the label was reached, and the AO form's Plaintiff(s) blank came
    // back with NO forward context: leaving the reviewer nothing to judge by.
    const rail = Array.from({ length: 15 }, () => para(text(')'))).join('')
    const [p] = build(doc(para(field('Text3', 1)), rail, para(text('Plaintiff(s)'))))

    expect(p.contextAfter).toContain('Plaintiff(s)')
  })

  it('deduplicates repeated labels so each field keeps a distinct tag', () => {
    // A complaint repeats "Name" for every defendant; collapsing them would fill
    // every defendant with the same value.
    const props = build(
      doc(para(text('Name')), para(field('Text1', 1)), para(text('Name')), para(field('Text2', 2))),
    )
    expect(props.map((p) => p.suggestedTag)).toEqual(['name', 'name_2'])
  })

  it('flags whether a suggested name will auto-fill', () => {
    // "Job or Title" has no home in the case model, so it must stay custom.
    // (Bar Number used to sit here; it became canonical once users.bar_number
    // existed: the point of that change was to move fields OUT of this state.)
    const props = build(
      doc(
        para(text('Case Number')),
        para(field('Text1', 1)),
        para(text('Job or Title')),
        para(field('Text2', 2)),
      ),
    )
    expect(props[0]).toMatchObject({ suggestedTag: 'case_number', canonical: true })
    expect(props[1]).toMatchObject({ suggestedTag: 'job_or_title', canonical: false })
  })

  it('carries the ordinal and Word name that bind an edit to a field', () => {
    const props = build(doc(para(field('Text1', 1)), para(field('Text2', 2))))
    expect(props.map((p) => [p.index, p.wordName])).toEqual([
      [0, 'Text1'],
      [1, 'Text2'],
    ])
  })
})

describe('buildPdfFieldProposals', () => {
  // WHY this is the easy case: a fillable PDF's fields already carry meaning,
  // so the suggested name is just the field's own name normalised. Contrast the
  // Word path, where Word supplies Text1…Text69 and a human must name each one.
  const f = (name: string, kind: 'text' | 'checkbox' = 'text', index = 0) => ({ name, kind, index })

  it('derives names from the PDF own field names', () => {
    const props = buildPdfFieldProposals([
      f('Plaintiff Full Name', 'text', 0),
      f('Case Number', 'text', 1),
    ])

    expect(props.map((p) => p.suggestedTag)).toEqual(['plaintiff_full_name', 'case_number'])
    expect(props.map((p) => p.pdfName)).toEqual(['Plaintiff Full Name', 'Case Number'])
  })

  it('reports which names will auto-fill', () => {
    const [a, b] = buildPdfFieldProposals([
      f('Case Number', 'text', 0),
      f('Job or Title', 'text', 1),
    ])
    expect(a.canonical).toBe(true)
    expect(b.canonical).toBe(false)
  })

  it('carries the control type through for the review chip', () => {
    const [a, b] = buildPdfFieldProposals([f('Agree', 'checkbox', 0), f('Name', 'text', 1)])
    expect(a.control).toBe('checkbox')
    expect(b.control).toBe('text')
  })

  it('keeps every tag distinct when two fields normalise the same', () => {
    // "Defendant Name" and "Defendant  name" both slug to defendant_name; a
    // collision would later be REJECTED at commit (two PDF fields cannot share
    // a name), so the proposals must not hand the user a doomed default.
    const props = buildPdfFieldProposals([
      f('Defendant Name', 'text', 0),
      f('Defendant  name', 'text', 1),
    ])
    expect(props.map((p) => p.suggestedTag)).toEqual(['defendant_name', 'defendant_name_2'])
  })

  it('falls back to a positional name when a field name normalises to nothing', () => {
    const [p] = buildPdfFieldProposals([f('***', 'text', 0)])
    expect(p.suggestedTag).toBe('field_1')
  })
})
