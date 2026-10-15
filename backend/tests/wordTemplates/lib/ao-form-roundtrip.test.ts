import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import PizZip from 'pizzip'
import {
  applyFormFieldOps,
  formFieldReplacementRun,
  maskFormFields,
  scanFormFields,
} from '../../../src/modules/wordTemplates/lib/auto-bracket/form-fields'
import { buildFormFieldProposals } from '../../../src/modules/wordTemplates/lib/auto-bracket/proposals'
import { detectFields } from '../../../src/modules/wordTemplates/lib/auto-bracket/detect-patterns'
import { documentText } from '../../../src/modules/wordTemplates/lib/placeholderize-core'
import { fillDocxTemplate, parseDocxPlaceholders } from '../../../src/modules/wordTemplates/lib/docx'

// Integration test for form-field bracketing on a REAL blank court form: the
// federal AO Pro Se 1 "Complaint for a Civil Case".
//
// WHY (Rule 9 / the project's browser-verify rule, at unit level): this is the
// document that motivated the feature. Uploaded as-is it produces a template
// with ZERO fillable fields: parseDocxPlaceholders returns {} without throwing,
// so the failure is silent. The single claim this file has to prove is that the
// same document comes out the other side with all 73 blanks fillable, and that
// nothing else in it was disturbed.

const FIXTURE = join(__dirname, '../fixtures/ao-pro-se-complaint-form.docx')

function bodyXmlOf(buffer: Buffer): string {
  return new PizZip(buffer).file('word/document.xml')!.asText()
}

const source = readFileSync(FIXTURE)
const sourceXml = bodyXmlOf(source)
const spans = scanFormFields(sourceXml)

/** Rewrite every field to {field_N} and repackage, as commitDocxBrackets does. */
function bracketAll(): Buffer {
  const zip = new PizZip(readFileSync(FIXTURE))
  zip.file(
    'word/document.xml',
    applyFormFieldOps(
      sourceXml,
      spans.map((s) => ({ span: s, xml: formFieldReplacementRun(s, `{field_${s.index + 1}}`) })),
    ),
  )
  return zip.generate({ type: 'nodebuffer' }) as Buffer
}

describe('AO Pro Se 1 complaint form', () => {
  it('is silently unusable as a template today', () => {
    // The bug this feature exists to fix: no throw, no warning, no fields.
    expect(parseDocxPlaceholders(source).fields).toHaveLength(0)
  })

  it('exposes all 73 blanks, typed', () => {
    expect(spans).toHaveLength(73)
    expect(spans.filter((s) => s.control === 'text')).toHaveLength(69)
    expect(spans.filter((s) => s.control === 'checkbox')).toHaveLength(4)
    // Word's default names: the reason a human has to supply the meaning.
    expect(spans.every((s) => /^(Text|Check)\d+$/.test(s.name ?? ''))).toBe(true)
    // Every field carries run properties, so filled values keep the form's font.
    expect(spans.every((s) => s.runProps.length > 0)).toBe(true)
  })

  it('leaves the document ordinary Word field code alone', () => {
    // The form opens with a SEQ CHAPTER field. It shares the fldChar mechanism
    // with form fields; rewriting it would corrupt the document's numbering.
    const out = bodyXmlOf(bracketAll())
    expect(out.match(/<w:ffData/g)).toBeNull()
    expect(out.match(/<w:fldChar/g)).toHaveLength(2) // the SEQ field's begin + end
    expect(out).toContain('SEQ CHAPTER')
  })

  it('leaves no orphaned bookmark markers', () => {
    const out = bodyXmlOf(bracketAll())
    // Only the document-wide _GoBack bookmark should survive, still balanced.
    expect(out.match(/<w:bookmarkStart/g)).toHaveLength(1)
    expect(out.match(/<w:bookmarkEnd/g)).toHaveLength(1)
    expect(out).toContain('_GoBack')
  })

  it('turns the form into a template with 73 fillable fields', () => {
    const parsed = parseDocxPlaceholders(bracketAll())
    expect(parsed.fields).toHaveLength(73)
    // Flat fields, not loops: a checkbox rendered as a section would give the
    // fill modal a repeating-row UI (see proposals.ts).
    expect(parsed.repeaters).toHaveLength(0)
  })

  it('actually fills every field through the real fill engine', () => {
    // The end-to-end claim: 0 fillable fields in, 73 filled values out.
    const values = Object.fromEntries(spans.map((s) => [`field_${s.index + 1}`, `VALUE_${s.index + 1}`]))
    const filledXml = bodyXmlOf(fillDocxTemplate(bracketAll(), values).buffer)

    const missing = Object.values(values).filter((v) => !filledXml.includes(v))
    expect(missing).toEqual([])
    expect(filledXml).not.toContain('{field_')
  })

  it('suggests a usable name for most blanks, and a positional one otherwise', () => {
    const props = buildFormFieldProposals(sourceXml, spans)
    expect(props).toHaveLength(73)

    const generic = props.filter((p) => /^(check_)?field_\d+$/.test(p.suggestedTag))
    // Names come from nearby labels; prose sections fall back. If the heuristic
    // regresses, this ratio collapses and the review list stops being useful.
    expect(generic.length).toBeLessThanOrEqual(15)

    const byName = Object.fromEntries(props.map((p) => [p.wordName, p.suggestedTag]))
    expect(byName.Text7).toBe('street_address')
    expect(byName.Text10).toBe('telephone_number')
    // Checkboxes take their label from the RIGHT.
    expect(byName.Check1).toBe('check_yes')
    expect(byName.Check2).toBe('check_no')

    // Every tag is distinct, or two blanks would collapse onto one value.
    expect(new Set(props.map((p) => p.suggestedTag)).size).toBe(73)
  })

  it('keeps the value detector honest once the blanks are masked', () => {
    // Masking must not eat prose. The single surviving hit is the statutory
    // diversity threshold in the form's instructions: a documented FALSE
    // POSITIVE that a reviewer is expected to uncheck, not a real variable.
    const hits = detectFields(documentText(maskFormFields(sourceXml, spans)))
    expect(hits.map((h) => h.literal)).toEqual(['$75,000'])
  })
})
