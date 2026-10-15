import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import PizZip from 'pizzip'
import {
  buildFlatFieldList,
  fillDocxTemplate,
  parseDocxPlaceholders,
} from '../../../src/modules/wordTemplates/lib/docx'
import { documentText } from '../../../src/modules/wordTemplates/lib/placeholderize-core'

// The seven real Word files JJ seeds as test templates. Each is filled end to
// end through the same parse and fill the routes use: every tag is found, every
// tag is filled, and nothing of the template's own syntax survives into the
// document. A parser or fill change that drops a header tag, a table-row loop
// or a second loop fails here on a real file rather than on a synthetic one.

const FIXTURES = join(__dirname, '../fixtures')

function load(name: string): Buffer {
  return readFileSync(join(FIXTURES, `TEST - ${name}.docx`))
}

// All visible text in every part a reader sees: body, headers and footers.
function printedText(buffer: Buffer): string {
  const zip = new PizZip(buffer)
  return zip
    .file(/^word\/(document|header\d*|footer\d*)\.xml$/)
    .map((entry) => documentText(entry.asText()))
    .join('\n')
}

function valuesFor(fields: string[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f, `VAL_${f}`]))
}

const EXPECTED: Record<string, { fields: string[]; repeaters: Array<{ name: string; fields: string[] }> }> = {
  'Header Footer': {
    fields: ['firm_name', 'firm_phone', 'client_name', 'case_number', 'firm_address', 'firm_city_state_zip', 'firm_email'],
    repeaters: [],
  },
  'Mixed Formatting': {
    fields: ['client_name', 'case_number', 'court_name', 'charges', 'attorney_name', 'client_email'],
    repeaters: [],
  },
  'Multi Loop Invoice': {
    fields: ['client_name', 'case_reference_id', 'flat_fee_amount', 'initial_payment_amount'],
    repeaters: [
      { name: 'line_items', fields: ['description', 'amount'] },
      { name: 'payments', fields: ['payment_date', 'payment_amount'] },
    ],
  },
  'Simple Fields': {
    fields: ['client_name', 'client_email', 'client_phone', 'case_number', 'court_name', 'judge_name', 'widget_serial_number'],
    repeaters: [],
  },
  'Static Table': {
    fields: ['client_name', 'client_status', 'case_number', 'case_status', 'court_name', 'judge_name', 'flat_fee_amount', 'hourly_rate'],
    repeaters: [],
  },
  'Table Row Loop': {
    fields: ['grand_total'],
    repeaters: [{ name: 'items', fields: ['description', 'qty', 'amount'] }],
  },
}

describe('real .docx fixtures', () => {
  it.each(Object.keys(EXPECTED))('parses every tag of "%s"', (name) => {
    expect(parseDocxPlaceholders(load(name))).toEqual(EXPECTED[name])
  })

  it.each([...Object.keys(EXPECTED), 'Full Vocabulary'])('fills "%s" completely, leaving no tag behind', (name) => {
    const template = load(name)
    const parsed = parseDocxPlaceholders(template)
    const repeaterValues = Object.fromEntries(
      parsed.repeaters.map((r) => [
        r.name,
        [1, 2].map((n) => Object.fromEntries(r.fields.map((f) => [f, `ROW${n}_${f}`]))),
      ]),
    )

    const { buffer, unfilledFields } = fillDocxTemplate(template, valuesFor(parsed.fields), repeaterValues)

    expect(unfilledFields).toEqual([])
    const text = printedText(buffer)
    for (const field of parsed.fields) expect(text).toContain(`VAL_${field}`)
    for (const r of parsed.repeaters) {
      for (const f of r.fields) {
        expect(text).toContain(`ROW1_${f}`)
        expect(text).toContain(`ROW2_${f}`)
      }
    }
    expect(text).not.toMatch(/\{[#/^]?[a-zA-Z_][\w.]*\}/)
    expect(parseDocxPlaceholders(buffer)).toEqual({ fields: [], repeaters: [] })
  })

  it('reports exactly the tags left without a value', () => {
    const template = load('Simple Fields')
    const { unfilledFields } = fillDocxTemplate(template, { client_name: 'Corwin Thistlewood' })
    expect(unfilledFields).toEqual([
      'client_email', 'client_phone', 'case_number', 'court_name', 'judge_name', 'widget_serial_number',
    ])
  })

  it('flattens loop columns into loop.field entries for the stored field list', () => {
    expect(buildFlatFieldList(parseDocxPlaceholders(load('Table Row Loop')))).toEqual([
      'grand_total', 'items.description', 'items.qty', 'items.amount',
    ])
  })
})
