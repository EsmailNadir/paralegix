import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import PizZip from 'pizzip'
import { applyOps, documentText } from '../../../src/modules/wordTemplates/lib/placeholderize-core'
import { detectFields } from '../../../src/modules/wordTemplates/lib/auto-bracket/detect-patterns'
import { fillDocxTemplate, parseDocxPlaceholders } from '../../../src/modules/wordTemplates/lib/docx'

// Integration test for the non-AI auto-bracketing core (Phase 1) on a REAL
// Word document.
//
// WHY (Rule 9 / project rule "browser-verify, not just type-check": this is
// the closest unit-level equivalent): the detector's own tests run on plain
// strings; this proves the whole pipeline holds on genuine OOXML, where text is
// split across <w:r> runs and entity-encoded:
//   fill a shipped template with raw values → a real "unmarked" document →
//   detect the value-shaped spans → rewrite them to {tags} (reusing the tested
//   placeholderize engine) → re-parse and confirm the tags are readable by the
//   same parser the fill engine uses. If any layer corrupts the XML, the
//   re-parse loses tags or applyOps reports a miss.

const FIXTURE = join(__dirname, '../fixtures/Sample Representation Agreement.docx',
)

function documentXmlOf(buffer: Buffer): string {
  return new PizZip(buffer).file('word/document.xml')!.asText()
}

function withDocumentXml(buffer: Buffer, xml: string): Buffer {
  const zip = new PizZip(buffer)
  zip.file('word/document.xml', xml)
  return zip.generate({ type: 'nodebuffer' }) as Buffer
}

describe('auto-bracket round-trip on a real .docx', () => {
  // A shipped template filled with raw values = a realistic unmarked document.
  // The letterhead's phone/fax/email are baked constant branding (not tags: see
  // tag-maps.ts), so the detector finds them as embedded value-shaped spans; the
  // fillable date/money fields are supplied here.
  const template = readFileSync(FIXTURE)
  const { buffer: filled } = fillDocxTemplate(template, {
    letter_date: 'March 4, 2026',
    initial_payment_amount: '$2,500.00',
    initial_payment_date: 'April 1, 2026',
    flat_fee_amount: '$5,000.00',
    hourly_rate: '$300.00',
    defendant_name: 'Corwin Thistlewood',
  })
  const filledXml = documentXmlOf(filled)
  const detected = detectFields(documentText(filledXml))

  it('detects the value-shaped spans in the document', () => {
    const byCategory = (c: string) => detected.filter((d) => d.category === c).map((d) => d.literal)
    // Phone/email come from the baked letterhead branding.
    expect(byCategory('phone')).toContain('(614) 555-0182')
    expect(byCategory('email')).toContain('halelawllc@halelaw.example')
    // Dates/money are the fields filled in above.
    expect(byCategory('date')).toEqual(expect.arrayContaining(['March 4, 2026', 'April 1, 2026']))
    expect(byCategory('money')).toEqual(
      expect.arrayContaining(['$2,500.00', '$5,000.00', '$300.00']),
    )
  })

  it('rewrites every detected span to a {tag} with no misses', () => {
    const ops = detected.map((d) => ({ find: d.literal, tag: `{${d.suggestedTag}}` }))
    const { missed } = applyOps(filledXml, ops, { wholeToken: true })
    expect(missed).toEqual([])
  })

  it('re-parses the rewritten document and finds the bracketed tags', () => {
    const ops = detected.map((d) => ({ find: d.literal, tag: `{${d.suggestedTag}}` }))
    const { xml } = applyOps(filledXml, ops, { wholeToken: true })
    const reparsed = parseDocxPlaceholders(withDocumentXml(filled, xml))
    for (const d of detected) {
      expect(reparsed.fields)
        .toContain(d.suggestedTag)
    }
  })
})
