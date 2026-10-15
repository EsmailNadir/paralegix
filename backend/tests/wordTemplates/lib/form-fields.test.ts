import {
  applyFormFieldOps,
  formFieldReplacementRun,
  FormFieldScanError,
  maskFormFields,
  scanFormFields,
} from '../../../src/modules/wordTemplates/lib/auto-bracket/form-fields'

// Tests for Word form-field scanning and rewriting.
//
// WHY (Rule 9): this module deletes and rebuilds run ranges inside a legal
// document. Two failure modes matter and neither is visible in a diff:
//   • Rewriting something that is NOT a form field: page numbers, TOCs and SEQ
//     fields share the fldChar mechanism, so a loose filter silently corrupts
//     document numbering.
//   • Rewriting a real field but losing its run properties or orphaning its
//     bookmark, which changes how the filled document renders in Word.
// These pin the structural rules that prevent both.

const RPR = '<w:rPr><w:sz w:val="22"/></w:rPr>'

function formText(name: string | null, id: number): string {
  const nameEl = name === null ? '' : `<w:name w:val="${name}"/>`
  return (
    `<w:r>${RPR}<w:fldChar w:fldCharType="begin"><w:ffData>${nameEl}<w:enabled/><w:textInput/></w:ffData></w:fldChar></w:r>` +
    `<w:bookmarkStart w:id="${id}" w:name="${name ?? 'x'}"/>` +
    `<w:r>${RPR}<w:instrText xml:space="preserve"> FORMTEXT </w:instrText></w:r>` +
    `<w:r>${RPR}<w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r>${RPR}<w:t> </w:t></w:r>` +
    `<w:r>${RPR}<w:fldChar w:fldCharType="end"/></w:r>` +
    `<w:bookmarkEnd w:id="${id}"/>`
  )
}

function formCheckbox(name: string, id: number): string {
  return (
    `<w:r>${RPR}<w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="${name}"/><w:checkBox><w:default w:val="0"/></w:checkBox></w:ffData></w:fldChar></w:r>` +
    `<w:bookmarkStart w:id="${id}" w:name="${name}"/>` +
    `<w:r>${RPR}<w:instrText xml:space="preserve"> FORMCHECKBOX </w:instrText></w:r>` +
    `<w:r>${RPR}<w:fldChar w:fldCharType="end"/></w:r>` +
    `<w:bookmarkEnd w:id="${id}"/>`
  )
}

// An ordinary Word field code: self-closing begin, no ffData.
const SEQ_FIELD =
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
  `<w:r><w:instrText> SEQ CHAPTER \\h \\r 1</w:instrText></w:r>` +
  `<w:r><w:fldChar w:fldCharType="end"/></w:r>`

const doc = (body: string) => `<w:document><w:body><w:p>${body}</w:p></w:body></w:document>`

describe('scanFormFields', () => {
  it('captures a FORMTEXT field with its run properties and bookmark', () => {
    const [span] = scanFormFields(doc(formText('Text1', 1)))

    expect(span.name).toBe('Text1')
    expect(span.control).toBe('text')
    // rPr is what keeps the filled value in the field's font/size.
    expect(span.runProps).toBe(RPR)
    // The span must swallow its own bookmarkEnd, or removing the field leaves a
    // dangling marker in the document.
    expect(span.end).toBe(doc(formText('Text1', 1)).indexOf('</w:p>'))
  })

  it('recognises a FORMCHECKBOX', () => {
    const [span] = scanFormFields(doc(formCheckbox('Check1', 2)))
    expect(span.control).toBe('checkbox')
    expect(span.name).toBe('Check1')
  })

  it('ignores an ordinary Word field code', () => {
    // THE rule that separates a form blank from a page number, TOC or SEQ field.
    // If this regresses, the rewrite corrupts document numbering.
    expect(scanFormFields(doc(SEQ_FIELD))).toHaveLength(0)
  })

  it('scans real fields alongside an ordinary field code', () => {
    const spans = scanFormFields(doc(SEQ_FIELD + formText('Text1', 1) + formCheckbox('Check1', 2)))
    expect(spans.map((s) => s.name)).toEqual(['Text1', 'Check1'])
    expect(spans.map((s) => s.index)).toEqual([0, 1])
  })

  it('returns spans in ascending, non-overlapping document order', () => {
    const spans = scanFormFields(doc(formText('Text1', 1) + formText('Text2', 2) + formText('Text3', 3)))
    expect(spans).toHaveLength(3)
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end)
    }
  })

  it('tolerates a field Word did not name', () => {
    const [span] = scanFormFields(doc(formText(null, 1)))
    expect(span.name).toBeNull()
    expect(span.control).toBe('text')
  })

  it.each([
    [
      'unbalanced begin',
      doc(`<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:textInput/></w:ffData></w:fldChar></w:r>`),
    ],
    [
      'a stray end',
      doc(`<w:r><w:fldChar w:fldCharType="end"/></w:r>`),
    ],
    [
      'nested field codes',
      doc(
        `<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:textInput/></w:ffData></w:fldChar></w:r>` +
          formText('Text1', 1) +
          `<w:r><w:fldChar w:fldCharType="end"/></w:r>`,
      ),
    ],
    [
      'a dropdown control',
      doc(
        `<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="D1"/><w:ddList/></w:ffData></w:fldChar></w:r>` +
          `<w:r><w:fldChar w:fldCharType="end"/></w:r>`,
      ),
    ],
    [
      'a begin outside any run',
      doc(`<w:fldChar w:fldCharType="begin"><w:ffData><w:textInput/></w:ffData></w:fldChar><w:r><w:fldChar w:fldCharType="end"/></w:r>`),
    ],
  ])('refuses %s rather than rewriting it', (_label, xml) => {
    // Fail loud: a half-rewritten court filing is far worse than a refused upload.
    expect(() => scanFormFields(xml)).toThrow(FormFieldScanError)
  })
})

describe('applyFormFieldOps', () => {
  it('replaces a field with a tag run, keeping formatting and dropping the bookmark', () => {
    const xml = doc(`<w:r>${RPR}<w:t>Bar Number </w:t></w:r>` + formText('Text1', 1))
    const [span] = scanFormFields(xml)

    const out = applyFormFieldOps(xml, [
      { span, xml: formFieldReplacementRun(span, '{bar_number}') },
    ])

    expect(out).toContain(`<w:r>${RPR}<w:t xml:space="preserve">{bar_number}</w:t></w:r>`)
    expect(out).not.toContain('<w:ffData')
    expect(out).not.toContain('<w:fldChar')
    // No orphan bookmark markers left behind.
    expect(out).not.toContain('bookmarkStart')
    expect(out).not.toContain('bookmarkEnd')
    // Neighbouring text untouched.
    expect(out).toContain('<w:t>Bar Number </w:t>')
  })

  it('leaves an ordinary field code byte-identical', () => {
    const xml = doc(SEQ_FIELD + formText('Text1', 1))
    const [span] = scanFormFields(xml)
    const out = applyFormFieldOps(xml, [{ span, xml: formFieldReplacementRun(span, '{a}') }])
    expect(out).toContain(SEQ_FIELD)
  })

  it('rewrites multiple fields without disturbing each other', () => {
    const xml = doc(formText('Text1', 1) + `<w:r><w:t> and </w:t></w:r>` + formText('Text2', 2))
    const spans = scanFormFields(xml)
    const out = applyFormFieldOps(
      xml,
      spans.map((s) => ({ span: s, xml: formFieldReplacementRun(s, `{f${s.index}}`) })),
    )
    expect(out).toContain('{f0}')
    expect(out).toContain('{f1}')
    expect(out).toContain('<w:t> and </w:t>')
    expect(out).not.toContain('<w:ffData')
  })

  it('refuses a span that no longer points at a form field', () => {
    // The anti-drift guard: if detect and commit ever disagree about the
    // document, the edit must not land on whatever now occupies those bytes.
    const xml = doc(formText('Text1', 1))
    const [span] = scanFormFields(xml)
    const other = doc(`<w:r><w:t>${'x'.repeat(span.end)}</w:t></w:r>`)
    expect(() => applyFormFieldOps(other, [{ span, xml: '<w:r/>' }])).toThrow(FormFieldScanError)
  })

  it('refuses a span pointing at a differently-named field', () => {
    const xml = doc(formText('Text1', 1))
    const [span] = scanFormFields(xml)
    expect(() =>
      applyFormFieldOps(xml, [{ span: { ...span, name: 'Text99' }, xml: '<w:r/>' }]),
    ).toThrow(FormFieldScanError)
  })

  it('refuses overlapping edits', () => {
    const xml = doc(formText('Text1', 1))
    const [span] = scanFormFields(xml)
    expect(() =>
      applyFormFieldOps(xml, [
        { span, xml: '<w:r/>' },
        { span: { ...span, start: span.start + 1 }, xml: '<w:r/>' },
      ]),
    ).toThrow(FormFieldScanError)
  })

  it('refuses a span outside the document', () => {
    const xml = doc(formText('Text1', 1))
    const [span] = scanFormFields(xml)
    expect(() =>
      applyFormFieldOps(xml, [{ span: { ...span, end: xml.length + 50 }, xml: '<w:r/>' }]),
    ).toThrow(FormFieldScanError)
  })
})

describe('maskFormFields', () => {
  it('stands a sentinel in for each field instead of deleting it', () => {
    // Deleting could JOIN the text either side and manufacture a pattern hit
    // that does not exist in the document: e.g. an area code and a local
    // number either side of a blank becoming one phone number.
    const xml = doc(`<w:r><w:t>614</w:t></w:r>` + formText('Text1', 1) + `<w:r><w:t>-555-1234</w:t></w:r>`)
    const masked = maskFormFields(xml, scanFormFields(xml))

    expect(masked).not.toContain('<w:ffData')
    expect(masked).toContain('￼')
    expect(masked).not.toContain('614-555-1234')
  })
})
