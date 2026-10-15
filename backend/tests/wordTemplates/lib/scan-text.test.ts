import { docxPartText, propertyPartText } from '../../../src/modules/wordTemplates/lib/auto-bracket/scan-text'
import { documentText } from '../../../src/modules/wordTemplates/lib/placeholderize-core'

// The leftover-client-text guard reads a template part with docxPartText, not
// documentText.
//
// WHY (Rule 9): the guard is only as good as the text it reads. Each case below
// is text that stays in every generated file but that documentText does not
// return, so a client named there passed the guard clean. Each test also shows
// documentText missing it, so a later "simplify back to documentText" fails
// here rather than reopening the hole silently.

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const doc = (body: string) => `<w:document ${W}><w:body>${body}</w:body></w:document>`
const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`
const p = (inner: string) => `<w:p>${inner}</w:p>`

describe('docxPartText', () => {
  it('reads a name deleted under Track Changes into `deleted`, not `visible`', () => {
    const xml = doc(p(run('the ') + `<w:del w:id="1"><w:r><w:delText>Jordan Avery</w:delText></w:r></w:del>` + run('Defendant')))
    expect(documentText(xml)).not.toContain('Jordan Avery')
    const text = docxPartText(xml)
    expect(text.deleted).toBe('Jordan Avery')
    expect(text.visible).toBe('the Defendant')
  })

  it('reads field instructions into `fieldCodes`', () => {
    const xml = doc(
      p(
        `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
          `<w:r><w:instrText xml:space="preserve"> HYPERLINK "https://courts.example/CR2024-000123" </w:instrText></w:r>` +
          `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
          run('docket'),
      ),
    )
    expect(documentText(xml)).not.toContain('CR2024-000123')
    expect(docxPartText(xml).fieldCodes).toContain('CR2024-000123')
  })

  it('keeps the text after a text box in the same paragraph', () => {
    const box = `<w:r><w:drawing><wps:txbx><w:txbxContent>${p(run('Logo'))}</w:txbxContent></wps:txbx></w:drawing></w:r>`
    const xml = doc(p(box + run('Re: Jordan Avery, CR2024-000123')))
    expect(documentText(xml)).not.toContain('Jordan Avery')
    expect(docxPartText(xml).visible.split('\n')).toEqual(['Logo', 'Re: Jordan Avery, CR2024-000123'])
  })

  it("reads a text box once, not again from Word's fallback copy", () => {
    const inBox = `<w:txbxContent>${p(run('Jordan Avery'))}</w:txbxContent>`
    const xml = doc(
      p(
        `<w:r><mc:AlternateContent><mc:Choice Requires="wps">${inBox}</mc:Choice>` +
          `<mc:Fallback><w:pict>${inBox}</w:pict></mc:Fallback></mc:AlternateContent></w:r>`,
      ),
    )
    expect(docxPartText(xml).visible).toBe('Jordan Avery')
  })

  it('decodes entities and ignores an empty self-closing run', () => {
    const xml = doc(p(`<w:r><w:t/></w:r>` + run('Avery &amp; Sons')))
    expect(docxPartText(xml).visible).toBe('Avery & Sons')
  })
})

describe('propertyPartText', () => {
  it('reads the title and custom properties, one per line', () => {
    const core =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties><dc:title>Avery &amp; Co rep agreement</dc:title><dc:creator>Firm</dc:creator></cp:coreProperties>'
    expect(propertyPartText(core).split('\n')).toEqual(['Avery & Co rep agreement', 'Firm'])
  })
})
