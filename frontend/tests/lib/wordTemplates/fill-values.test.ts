import {
  createFieldValueResolver,
  normalizeInitialRepeaterValues,
  normalizeInitialValues,
  resolveProvidedRows,
  resolveProvidedValues,
} from '@/lib/wordTemplates/fill-values'
import { decodeUnfilledFields, encodeUnfilledFields } from '@/lib/wordTemplates/unfilled-fields'

// WHY these tests exist:
//
//   buildCaseDocumentContext fetches the case, client, firm, calendar and
//   billing data and hands FillTemplateModal a map keyed by the canonical
//   vocabulary, client_name, case_number, hearing_date. The modal used to look
//   each template tag up by exact string, so a template whose author typed
//   "{Client Name}", "{CASE_NUMBER}" or "{hearing date}" got nothing: the data
//   was fetched, carried across the wire, and then dropped one line before it
//   reached the input. That is the "it pulls the information but doesn't add it
//   to the document" complaint.
//
//   These pin the three-step match (verbatim → normalized → canonical id) and
//   the rule that keeps it from doing harm: an empty value is never treated as
//   provided, because the modal protects provided values from the alias
//   heuristics that could have filled them (see case-autofill.ts).

const CASE_CONTEXT = {
  client_name: 'Corwin Thistlewood',
  case_number: 'TRC0000551',
  hearing_date: 'March 4, 2026',
  attorney_bar_number: '0091234',
  court_division: 'Criminal Division',
}

describe('createFieldValueResolver', () => {
  it('matches a tag spelled exactly as the context keys it', () => {
    const resolve = createFieldValueResolver(CASE_CONTEXT)
    expect(resolve('client_name')).toBe('Corwin Thistlewood')
  })

  it('matches a tag the author wrote as prose', () => {
    const resolve = createFieldValueResolver(CASE_CONTEXT)
    expect(resolve('Client Name')).toBe('Corwin Thistlewood')
    expect(resolve('CASE_NUMBER')).toBe('TRC0000551')
    expect(resolve('hearing date')).toBe('March 4, 2026')
    expect(resolve('Attorney Bar Number')).toBe('0091234')
    expect(resolve('Court Division')).toBe('Criminal Division')
  })

  it('matches a tag through the canonical vocabulary when spelling alone fails', () => {
    // "Case No." normalizes to case_no, which is nothing like case_number, 
    // only the vocabulary knows the two name the same field.
    const resolve = createFieldValueResolver(CASE_CONTEXT)
    expect(resolve('Case No.')).toBe('TRC0000551')
    expect(resolve('docket number')).toBe('TRC0000551')
  })

  it('resolves a canonically-keyed tag against a context keyed by an alias', () => {
    const resolve = createFieldValueResolver({ 'Case No.': 'TRC0000551' })
    expect(resolve('case_number')).toBe('TRC0000551')
  })

  it('returns empty for a tag nothing in the context names', () => {
    const resolve = createFieldValueResolver(CASE_CONTEXT)
    expect(resolve('bond_amount')).toBe('')
    expect(resolve('')).toBe('')
  })

  it('never returns an empty context value as a match', () => {
    // An empty string would be seeded as "user-provided" and lock the modal's
    // own alias heuristics out of a field they could have filled.
    const resolve = createFieldValueResolver({ client_name: '', 'Client Name': 'Fallback' })
    expect(resolve('client_name')).toBe('Fallback')
  })

  it('tolerates no context at all', () => {
    expect(createFieldValueResolver(undefined)('client_name')).toBe('')
  })

  it('keeps the first key when two context keys normalize onto one slot', () => {
    const resolve = createFieldValueResolver({ 'Client Name': 'First', client_name: 'Second' })
    expect(resolve('CLIENT NAME')).toBe('First')
  })
})

describe('resolveProvidedValues', () => {
  it('keys the result by the template\'s own tag names', () => {
    expect(resolveProvidedValues(['Client Name', 'Case No.'], CASE_CONTEXT)).toEqual({
      'Client Name': 'Corwin Thistlewood',
      'Case No.': 'TRC0000551',
    })
  })

  it('omits fields with nothing to fill, so the result names what was provided', () => {
    expect(resolveProvidedValues(['client_name', 'bond_amount'], CASE_CONTEXT)).toEqual({
      client_name: 'Corwin Thistlewood',
    })
  })
})

describe('resolveProvidedRows', () => {
  const context = { payments: [{ payment_date: 'April 1, 2026', payment_amount: '$500.00' }] }

  it('finds a loop by its exact name', () => {
    expect(resolveProvidedRows('payments', context)).toHaveLength(1)
  })

  it('finds a loop the author spelled differently', () => {
    expect(resolveProvidedRows('Payments', context)).toHaveLength(1)
  })

  it('returns null for a loop the context has no rows for', () => {
    expect(resolveProvidedRows('payments', { payments: [] })).toBeNull()
    expect(resolveProvidedRows('hearings', context)).toBeNull()
    expect(resolveProvidedRows('payments', undefined)).toBeNull()
  })
})

describe('normalizeInitialValues', () => {
  it('seeds a differently-spelled template from the case context', () => {
    const fields = ['Client Name', 'Case No.', 'Bond Amount']

    expect(normalizeInitialValues(fields, CASE_CONTEXT)).toEqual({
      'Client Name': 'Corwin Thistlewood',
      'Case No.': 'TRC0000551',
      // No source and no alias, the user types it.
      'Bond Amount': '',
    })
  })

  it('gives every field a value even with no context at all', () => {
    expect(normalizeInitialValues(['client_name'], undefined)).toEqual({ client_name: '' })
  })
})

describe('normalizeInitialRepeaterValues', () => {
  const repeaters = [{ name: 'payments', fields: ['payment_date', 'payment_amount'] }]

  it('seeds one blank row when the context has no rows', () => {
    expect(normalizeInitialRepeaterValues(repeaters, {})).toEqual({
      payments: [{ payment_date: '', payment_amount: '' }],
    })
  })

  it('matches both the loop name and the row cells by spelling', () => {
    const result = normalizeInitialRepeaterValues(
      [{ name: 'Payments', fields: ['Payment Date', 'Payment Amount'] }],
      { payments: [{ payment_date: 'April 1, 2026', payment_amount: '$500.00' }] },
    )

    expect(result).toEqual({
      Payments: [{ 'Payment Date': 'April 1, 2026', 'Payment Amount': '$500.00' }],
    })
  })

  it('keeps a row cell blank when the context has nothing for it', () => {
    expect(
      normalizeInitialRepeaterValues(repeaters, { payments: [{ payment_date: 'April 1, 2026' }] }),
    ).toEqual({ payments: [{ payment_date: 'April 1, 2026', payment_amount: '' }] })
  })
})

// The fill routes report the placeholders they left blank on a response header,
// percent-encoded so a tag in any script survives a latin-1 header value. The
// browser decodes what the server encodes; the two must agree.
describe('unfilled-fields wire format', () => {
  it('round-trips tags in any script', () => {
    const tags = ['client_name', 'Nombre del cliente', '事件番号']
    expect(decodeUnfilledFields(encodeUnfilledFields(tags))).toEqual(tags)
  })

  it('encodes nothing left blank as an empty header', () => {
    expect(encodeUnfilledFields([])).toBe('')
    expect(decodeUnfilledFields('')).toEqual([])
  })

  it('reads a malformed header as nothing left blank rather than failing the fill', () => {
    expect(decodeUnfilledFields('%E0%A4%A')).toEqual([])
    expect(decodeUnfilledFields(encodeURIComponent('{"not":"a list"}'))).toEqual([])
  })
})
