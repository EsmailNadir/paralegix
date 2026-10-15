import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import PizZip from 'pizzip'
import { inspectDocxForImport, inspectPdfFormFields } from '../../../src/modules/wordTemplates/lib/import-guards'

// Tests for the positional-editor import guards.
//
// WHY (Rule 9): the guards decide which uploads are allowed through the
// PDF→HTML rebuild. Both directions of that decision are expensive to get
// wrong, in opposite ways:
//   • A false negative silently mangles a court form: the failure the guards
//     exist to prevent, and the one a user reported after importing the federal
//     AO Pro Se complaint form.
//   • A false positive blocks a template the firm can legitimately author in
//     the visual editor, which is the only way to build a template from
//     scratch. Every shipped seed template must stay importable.
// So the form fixture must block, and a real prose template must not.

const FORM_FIXTURE = join(__dirname, '../fixtures/ao-pro-se-complaint-form.docx')
// A shipped template: prose + a payment-schedule table, no form fields.
const PROSE_FIXTURE = join(__dirname, '../fixtures/Sample Representation Agreement.docx',
)

function bytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path))
}

describe('inspectDocxForImport', () => {
  it('blocks a Word fill-in form and names the reason', () => {
    const verdict = inspectDocxForImport(bytes(FORM_FIXTURE))

    expect(verdict.ok).toBe(false)
    // The user has to learn WHY without reading the code: that it's a form, and
    // that there is a lossless door to use instead.
    expect(verdict.reason).toMatch(/fill-in form/i)
    expect(verdict.reason).toMatch(/Word template/i)
    // The fixture carries 69 FORMTEXT + 4 FORMCHECKBOX legacy controls. Pin the
    // real count: if the detector regresses to matching <w:fldChar> it would
    // report 74 (begin markers), and if it stops matching at all, 0.
    expect(verdict.reason).toContain('73')
  })

  it('lets a real prose template through', () => {
    const verdict = inspectDocxForImport(bytes(PROSE_FIXTURE))

    expect(verdict.ok).toBe(true)
    expect(verdict.reason).toBe('')
  })

  it('does not mistake ordinary Word field codes for form fields', () => {
    // <w:fldChar> wraps page numbers, TOCs, and every other field code. A
    // document full of them is not a form; only <w:ffData> controls are.
    const xml = `<w:document><w:body>
      <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>
      <w:r><w:instrText>PAGE</w:instrText></w:r>
      <w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
    </w:body></w:document>`

    expect(inspectDocxForImport(docxWith(xml)).ok).toBe(true)
  })

  it('does not mistake a table-of-contents <w:sdt> for a content control', () => {
    // Word wraps a TOC in <w:sdt>. Counting <w:sdt> alone would block any
    // document with one; only an input type inside <w:sdtPr> is a form control.
    const xml = `<w:document><w:body>
      <w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr>
      <w:sdtContent><w:p><w:r><w:t>Contents</w:t></w:r></w:p></w:sdtContent></w:sdt>
    </w:body></w:document>`

    expect(inspectDocxForImport(docxWith(xml)).ok).toBe(true)
  })

  it('blocks a content-control form', () => {
    const xml = `<w:document><w:body>
      <w:sdt><w:sdtPr><w:alias w:val="Client"/><w:text/></w:sdtPr>
      <w:sdtContent><w:p><w:r><w:t>name</w:t></w:r></w:p></w:sdtContent></w:sdt>
    </w:body></w:document>`

    const verdict = inspectDocxForImport(docxWith(xml))
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/content control/i)
  })

  it('warns without blocking on a layout-scale table', () => {
    const rows = '<w:tr><w:tc><w:p/></w:tc></w:tr>'.repeat(45)
    const xml = `<w:document><w:body><w:tbl>${rows}</w:tbl></w:body></w:document>`

    const verdict = inspectDocxForImport(docxWith(xml))
    // Awkward is not the same as impossible: this still imports.
    expect(verdict.ok).toBe(true)
    expect(verdict.warnings).toHaveLength(1)
    expect(verdict.warnings[0]).toContain('45-row table')
  })

  it('warns without blocking on dense tab-stop layout', () => {
    const xml = `<w:document><w:body><w:p>${'<w:r><w:tab/></w:r>'.repeat(120)}</w:p></w:body></w:document>`

    const verdict = inspectDocxForImport(docxWith(xml))
    expect(verdict.ok).toBe(true)
    expect(verdict.warnings.join(' ')).toMatch(/120 tab stops/)
  })

  it('stays out of the way of an unreadable file', () => {
    // Not the guard's job to report a corrupt upload: the real parser
    // downstream produces a proper error. Failing open here avoids a second,
    // worse error message for the same problem.
    expect(inspectDocxForImport(new Uint8Array([1, 2, 3, 4])).ok).toBe(true)
  })
})

describe('inspectPdfFormFields', () => {
  it('passes a PDF with no form fields', () => {
    expect(inspectPdfFormFields([]).ok).toBe(true)
  })

  it('blocks a fillable PDF and names fields the user will recognise', () => {
    // Real field names from the Ohio civil-complaint form a user imported.
    const verdict = inspectPdfFormFields([
      'Plaintiff Full Name',
      'Defendant',
      'Case Number',
      'Claims and Facts line 1',
    ])

    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('4 fields')
    // Naming real fields is what makes the message credible rather than generic.
    expect(verdict.reason).toContain('Plaintiff Full Name')
    expect(verdict.reason).toContain('…')
    // The guidance must point at the door that keeps the PDF (New Template),
    // not at the rebuild path the user just tried.
    expect(verdict.reason).toMatch(/New Template/i)
  })

  it('does not append an ellipsis when every field is named', () => {
    const verdict = inspectPdfFormFields(['Case Number'])
    expect(verdict.reason).toContain('1 field')
    expect(verdict.reason).not.toContain('…')
  })
})

// Build a minimal .docx around a document.xml body, so a structural case can be
// pinned without checking a binary fixture in for each one.
function docxWith(documentXml: string): Uint8Array {
  const zip = new PizZip()
  zip.file('word/document.xml', documentXml)
  return zip.generate({ type: 'uint8array' })
}
