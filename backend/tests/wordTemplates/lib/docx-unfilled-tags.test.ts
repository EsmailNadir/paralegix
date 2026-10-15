import PizZip from 'pizzip'
import { fillDocxTemplate } from '../../../src/modules/wordTemplates/lib/docx'
import {
  UNFILLED_FIELDS_HEADER,
  decodeUnfilledFields,
  encodeUnfilledFields,
} from '../../../src/modules/wordTemplates/lib/unfilled-fields'

// WHY these tests exist:
//
//   The fill engine's nullGetter returns '' for a tag it has no value for. That
//   is deliberate: a partial fill is a valid document, and the alternative is a
//   download that fails outright over one stale placeholder: but it made the
//   failure INVISIBLE. Filling the representation agreement with mis-keyed values
//   produced "Dear ,This letter confirms ... defense of your  charges in the ."
//   with no error, no warning, and nothing in the UI to say which blanks were
//   the engine's rather than the user's.
//
//   The claim pinned here: the empty string still renders, and the caller is
//   handed the list of tags that produced it.

function makeDocx(bodyXml: string): Buffer {
  const zip = new PizZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${bodyXml}</w:body></w:document>`,
  )
  return zip.generate({ type: 'nodebuffer' }) as Buffer
}

function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

function extractText(docx: Buffer): string {
  return new PizZip(docx)
    .file('word/document.xml')!
    .asText()
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<[^>]+>/g, '')
}

// The shape the owner reported: a letter whose tags were keyed one way and
// whose values arrived keyed another.
const REP_AGREEMENT = makeDocx(
  para('Dear {client_name},') +
    para('This letter confirms our representation in the defense of your {charges} charges in the {court_name}.'),
)

describe('fillDocxTemplate unfilled-tag reporting', () => {
  it('reports nothing when every tag has a value', () => {
    const { unfilledFields } = fillDocxTemplate(REP_AGREEMENT, {
      client_name: 'Corwin Thistlewood',
      charges: 'OVI (M1)',
      court_name: 'Franklin County Municipal Court',
    })

    expect(unfilledFields).toEqual([])
  })

  it('names every tag it blanked instead of failing silently', () => {
    const { buffer, unfilledFields } = fillDocxTemplate(REP_AGREEMENT, {
      client_name: 'Corwin Thistlewood',
    })

    // The gap is real and still invisible in the document...
    expect(extractText(buffer)).toContain('defense of your  charges in the .')
    // ...but no longer invisible to the caller.
    expect(unfilledFields).toEqual(['charges', 'court_name'])
  })

  it('treats a supplied empty string as filled, not as a missing tag', () => {
    // A field the user deliberately left blank is their call: only a tag the
    // data has no entry for at all is an engine-side gap.
    const { unfilledFields } = fillDocxTemplate(REP_AGREEMENT, {
      client_name: 'Corwin Thistlewood',
      charges: '',
      court_name: '',
    })

    expect(unfilledFields).toEqual([])
  })

  it('reports a repeater sub-field the rows never supplied', () => {
    const schedule = makeDocx(
      para('{#payments}') + para('{payment_date} - {payment_amount}') + para('{/payments}'),
    )

    const { unfilledFields } = fillDocxTemplate(
      schedule,
      {},
      { payments: [{ payment_date: 'April 1, 2026' }] },
    )

    expect(unfilledFields).toEqual(['payment_amount'])
  })

  it('reports a tag once however many times it appears', () => {
    const { unfilledFields } = fillDocxTemplate(
      makeDocx(para('{client_name} ... {client_name} ... {client_name}')),
      {},
    )

    expect(unfilledFields).toEqual(['client_name'])
  })

  it('does not report an absent section as a blank field', () => {
    // `{^has_co_defendant}` rendering nothing is the document working as
    // written. Reporting it would train the user to ignore the warning.
    const { unfilledFields } = fillDocxTemplate(
      makeDocx(para('{^has_co_defendant}Sole defendant.{/has_co_defendant}')),
      {},
    )

    expect(unfilledFields).toEqual([])
  })
})

describe('unfilled-fields response header', () => {
  it('round-trips a report through the header', () => {
    const fields = ['client_name', 'hearing_date']
    expect(decodeUnfilledFields(encodeUnfilledFields(fields))).toEqual(fields)
  })

  it('survives tag names a latin-1 header could not carry', () => {
    // Word tags are whatever the author typed, so the header value is encoded
    // rather than assumed ASCII.
    const fields = ['Nombre del cliente', 'Número de caso']
    const encoded = encodeUnfilledFields(fields)
    expect(encoded).toMatch(/^[\x20-\x7e]*$/)
    expect(decodeUnfilledFields(encoded)).toEqual(fields)
  })

  it('reads a missing or malformed header as no report', () => {
    // A fill that succeeded must never fail on its own diagnostic.
    expect(decodeUnfilledFields(null)).toEqual([])
    expect(decodeUnfilledFields('')).toEqual([])
    expect(decodeUnfilledFields('not json')).toEqual([])
    expect(decodeUnfilledFields('%E0%A4%A')).toEqual([])
    expect(decodeUnfilledFields(encodeURIComponent('{"not":"an array"}'))).toEqual([])
  })

  it('uses a header name the routes and the client shim agree on', () => {
    expect(UNFILLED_FIELDS_HEADER).toBe('X-Unfilled-Fields')
  })
})
