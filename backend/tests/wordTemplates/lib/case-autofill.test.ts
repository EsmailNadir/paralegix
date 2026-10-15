import PizZip from 'pizzip'
import {
  assembleCaseDocumentContext,
  formatCityStateZip,
  formatLegalDate,
  formatLongDate,
  formatLongDateFromDateOnly,
  formatMoneyFromCents,
  formatTimeOfDay,
  ordinalDay,
  type CaseAutofillInputs,
  summarizeCaseInvoices,
  type CaseBillingTotals,
  customFieldValues,
  EMPTY_CASE_ROW,
  pickCaseClient,
  trustClientFor,
  withCustomFieldValues,
} from '../../../src/modules/wordTemplates/lib/case-autofill'
import { resolveProvidedValues } from '../../../src/modules/wordTemplates/lib/fill-values'
import { fillDocxTemplate, parseDocxPlaceholders } from '../../../src/modules/wordTemplates/lib/docx'

// Tests for the canonical document-autofill vocabulary (document automation).
//
// WHY these tests exist (Rule 9: tests verify intent, not just behavior):
//
//   The seeded court-filing / rep-agreement / ODH templates are
//   placeholder-ized against this EXACT vocabulary (docs/document-automation.md).
//   If a key is renamed, dropped, or its format drifts (e.g. service_date_legal
//   loses its "4th day of March 2026" shape, or money loses its thousands
//   separator), every generated filing silently degrades: the fill engine
//   leaves unfilled tags blank rather than erroring. These tests pin the
//   contract between the context builder and the seeded documents.

// noon UTC → morning Eastern, same calendar day in both zones.
const MARCH_4 = new Date('2026-03-04T12:00:00Z')

function baseInputs(overrides: Partial<CaseAutofillInputs> = {}): CaseAutofillInputs {
  return {
    caseRow: {
      name: 'State v. Thistlewood',
      case_number: 'TRC0000551',
      court_name: 'Franklin County Municipal Court',
      lead_user_name: 'Morgan Hale',
      opposing_party: null,
      judge_name: 'Judge James E. Green',
      charges: 'OVI (M1), Failure to Control (MM)',
      prosecutor_name: 'Jane Smith',
      prosecutor_email: 'jsmith@columbus.gov',
    },
    client: { name: 'Corwin Thistlewood', email: 'corwin@example.com' },
    firm: {
      name: 'Hale Law LLC',
      address: '123 Main St',
      city: 'Columbus',
      state: 'Ohio',
      zip: '43209',
      phone: '(614) 555-1234',
      fax: '(614) 555-0199',
      email: 'office@halelaw.example',
    },
    nextHearing: { typeLabel: 'Hearing', date: new Date('2026-03-10T14:30:00Z') },
    installments: [],
    flatFeeTotalCents: null,
    hourlyRateCents: null,
    now: MARCH_4,
    ...overrides,
  }
}

describe('formatters', () => {
  it('formats money with thousands separators and cents', () => {
    expect(formatMoneyFromCents(150000)).toBe('$1,500.00')
    expect(formatMoneyFromCents(50)).toBe('$0.50')
  })

  it('ordinalDay handles st/nd/rd/th including the 11–13 exception', () => {
    expect(ordinalDay(1)).toBe('1st')
    expect(ordinalDay(2)).toBe('2nd')
    expect(ordinalDay(3)).toBe('3rd')
    expect(ordinalDay(4)).toBe('4th')
    expect(ordinalDay(11)).toBe('11th')
    expect(ordinalDay(12)).toBe('12th')
    expect(ordinalDay(13)).toBe('13th')
    expect(ordinalDay(21)).toBe('21st')
    expect(ordinalDay(22)).toBe('22nd')
    expect(ordinalDay(23)).toBe('23rd')
    expect(ordinalDay(31)).toBe('31st')
  })

  it('formats certificate-of-service legal dates in firm (Eastern) time', () => {
    expect(formatLegalDate(MARCH_4)).toBe('4th day of March 2026')
    // 2026-03-05T02:00Z is still March 4 in Eastern time: a UTC-based
    // formatter would say the 5th and mis-date the certificate of service.
    expect(formatLegalDate(new Date('2026-03-05T02:00:00Z'))).toBe(
      '4th day of March 2026',
    )
  })

  it('formats letter dates and times of day in firm time', () => {
    expect(formatLongDate(MARCH_4)).toBe('March 4, 2026')
    // 14:30 UTC in March (EST→EDT boundary is Mar 8; Mar 10 is EDT, UTC-4).
    expect(formatTimeOfDay(new Date('2026-03-10T14:30:00Z'))).toBe('10:30 AM')
  })

  it('formats date-only strings without a timezone shift', () => {
    // new Date('2026-03-04') is UTC midnight = March 3 in Eastern time; the
    // date-only formatter must NOT lose a day.
    expect(formatLongDateFromDateOnly('2026-03-04')).toBe('March 4, 2026')
    expect(formatLongDateFromDateOnly('2026-01-01')).toBe('January 1, 2026')
  })

  it('joins city/state/zip with sensible punctuation', () => {
    expect(formatCityStateZip('Columbus', 'Ohio', '43209')).toBe('Columbus, Ohio 43209')
    expect(formatCityStateZip('Columbus', null, null)).toBe('Columbus')
    expect(formatCityStateZip(null, 'Ohio', '43209')).toBe('Ohio 43209')
  })
})

describe('assembleCaseDocumentContext', () => {
  it('produces the full caption + signature + service vocabulary', () => {
    const { values } = assembleCaseDocumentContext(baseInputs())

    // Caption.
    expect(values.court_name).toBe('Franklin County Municipal Court')
    expect(values.court_name_caps).toBe('FRANKLIN COUNTY MUNICIPAL COURT')
    expect(values.case_number).toBe('TRC0000551')
    // Judicial title stripped: the caption prints "JUDGE:" itself, so a stored
    // "Judge James E. Green" must not double to "JUDGE: JUDGE JAMES E. GREEN".
    expect(values.judge_name).toBe('James E. Green')
    expect(values.judge_name_caps).toBe('JAMES E. GREEN')
    expect(values.defendant_name).toBe('Corwin Thistlewood')
    expect(values.defendant_name_caps).toBe('CORWIN THISTLEWOOD')
    expect(values.charges).toBe('OVI (M1), Failure to Control (MM)')

    // Signature block.
    expect(values.attorney_name).toBe('Morgan Hale')
    expect(values.firm_name).toBe('Hale Law LLC')
    expect(values.firm_city_state_zip).toBe('Columbus, Ohio 43209')
    expect(values.firm_fax).toBe('(614) 555-0199')

    // Certificate of service.
    expect(values.service_recipient).toBe('Jane Smith')
    expect(values.service_recipient_email).toBe('jsmith@columbus.gov')
    expect(values.service_date_legal).toBe('4th day of March 2026')

    // Letter fields.
    expect(values.letter_date).toBe('March 4, 2026')
    expect(values.client_salutation).toBe('Corwin')
  })

  it('falls back to the court as service recipient when no prosecutor is set', () => {
    const inputs = baseInputs()
    inputs.caseRow.prosecutor_name = null
    const { values } = assembleCaseDocumentContext(inputs)
    expect(values.service_recipient).toBe('Franklin County Municipal Court')
  })

  it('omits keys with no data instead of passing empty strings', () => {
    // FillTemplateModal treats initialValues as user-entered; an empty string
    // would suppress its own heuristic autofill for that field.
    const inputs = baseInputs({ client: null, nextHearing: null })
    inputs.caseRow.judge_name = null
    const { values } = assembleCaseDocumentContext(inputs)
    expect(values).not.toHaveProperty('judge_name')
    expect(values).not.toHaveProperty('defendant_name')
    expect(values).not.toHaveProperty('hearing_date')
    for (const v of Object.values(values)) expect(v).not.toBe('')
  })

  it('maps the ODH vocabulary (resident = client, facility = opposing party)', () => {
    const inputs = baseInputs()
    inputs.caseRow.opposing_party = 'Whetstone Care Center'
    const { values } = assembleCaseDocumentContext(inputs)
    expect(values.resident_name).toBe('Corwin Thistlewood')
    expect(values.facility_name).toBe('Whetstone Care Center')
  })

  it('splits installments into initial payment + {#payments} repeater', () => {
    const { values, repeaterValues } = assembleCaseDocumentContext(
      baseInputs({
        installments: [
          { amountCents: 100000, dueDate: '2026-03-06' },
          { amountCents: 50000, dueDate: '2026-04-01' },
          { amountCents: 50000, dueDate: '2026-05-01' },
        ],
      }),
    )
    expect(values.initial_payment_amount).toBe('$1,000.00')
    expect(values.initial_payment_date).toBe('March 6, 2026')
    // Flat fee = sum of the whole schedule.
    expect(values.flat_fee_amount).toBe('$2,000.00')
    expect(repeaterValues.payments).toEqual([
      { payment_date: 'April 1, 2026', payment_amount: '$500.00' },
      { payment_date: 'May 1, 2026', payment_amount: '$500.00' },
    ])
  })

  it('lists only installments still to come in the {#payments} repeater', () => {
    // The vocabulary promises the schedule "still to come"; a paid row printed
    // there would ask the client for money they have already paid.
    const { repeaterValues } = assembleCaseDocumentContext(
      baseInputs({
        installments: [
          { amountCents: 100000, dueDate: '2026-03-06', status: 'paid' },
          { amountCents: 50000, dueDate: '2026-04-01', status: 'paid' },
          { amountCents: 50000, dueDate: '2026-05-01', status: 'pending' },
        ],
      }),
    )
    expect(repeaterValues.payments).toEqual([
      { payment_date: 'May 1, 2026', payment_amount: '$500.00' },
    ])
  })

  it('uses the flat_fees sum when there is no installment plan', () => {
    const { values, repeaterValues } = assembleCaseDocumentContext(
      baseInputs({ installments: [], flatFeeTotalCents: 250000 }),
    )
    expect(values.flat_fee_amount).toBe('$2,500.00')
    expect(values).not.toHaveProperty('initial_payment_amount')
    expect(repeaterValues.payments).toBeUndefined()
  })

  it('fills the hearing block from the next upcoming event', () => {
    const { values } = assembleCaseDocumentContext(baseInputs())
    expect(values.hearing_type).toBe('Hearing')
    expect(values.hearing_date).toBe('March 10, 2026')
    expect(values.hearing_time).toBe('10:30 AM')
  })
})

// ── The wider vocabulary: everything else a case can already tell a document ──

describe('matter identity', () => {
  it('emits the case name, reference, description, category and practice area', () => {
    const { values } = assembleCaseDocumentContext(
      baseInputs({
        caseRow: {
          ...baseInputs().caseRow,
          case_reference_id: 'CP-000123',
          description: 'Traffic stop on Livingston Ave.',
          practice_area_name: 'Criminal Defense',
          category: 'OVI',
        },
      }),
    )
    expect(values.case_name).toBe('State v. Thistlewood')
    expect(values.case_reference_id).toBe('CP-000123')
    expect(values.case_description).toBe('Traffic stop on Livingston Ave.')
    expect(values.practice_area).toBe('Criminal Defense')
    expect(values.case_category).toBe('OVI')
  })

  it('prints the case status as English, not the stored enum spelling', () => {
    // 'on_hold' in a client letter reads like a bug; the column is snake_case
    // because Postgres is, not because a document should be.
    const { values } = assembleCaseDocumentContext(
      baseInputs({ caseRow: { ...baseInputs().caseRow, status: 'on_hold' } }),
    )
    expect(values.case_status).toBe('On Hold')
  })

  it('dates the case from created_at in firm time', () => {
    const { values } = assembleCaseDocumentContext(
      baseInputs({ caseRow: { ...baseInputs().caseRow, created_at: '2026-01-12T15:00:00Z' } }),
    )
    expect(values.case_open_date).toBe('January 12, 2026')
  })
})

describe('client contact block', () => {
  it('emits the whole contact card, not just name and email', () => {
    const { values } = assembleCaseDocumentContext(
      baseInputs({
        client: {
          name: 'Corwin Thistlewood',
          email: 'corwin@example.com',
          phone: '(614) 555-0100',
          address: '88 Oak St, Columbus, OH 43209',
          organization: 'Thistlewood Roofing LLC',
          preferredContactMethod: 'email',
        },
      }),
    )
    expect(values.client_phone).toBe('(614) 555-0100')
    expect(values.client_address).toBe('88 Oak St, Columbus, OH 43209')
    expect(values.client_organization).toBe('Thistlewood Roofing LLC')
    expect(values.client_preferred_contact_method).toBe('email')
    expect(values.client_salutation).toBe('Corwin')
    expect(values.client_last_name).toBe('Thistlewood')
  })

  it('splits a multi-part surname the way the fill modal does', () => {
    const { values } = assembleCaseDocumentContext(
      baseInputs({ client: { name: 'Ana Maria de la Cruz', email: null } }),
    )
    expect(values.client_salutation).toBe('Ana')
    expect(values.client_last_name).toBe('Maria de la Cruz')
  })
})

describe('court and firm address blocks', () => {
  it('emits the court street address, city and state', () => {
    const { values } = assembleCaseDocumentContext({
      ...baseInputs(),
      court: {
        division: 'Eastern Division',
        address: '375 S High St',
        city: 'Columbus',
        state: 'Ohio',
      },
    })
    expect(values.court_address).toBe('375 S High St')
    expect(values.court_city).toBe('Columbus')
    expect(values.court_state).toBe('Ohio')
  })

  it('emits the firm address in parts and joined', () => {
    const { values } = assembleCaseDocumentContext(baseInputs())
    expect(values.firm_city).toBe('Columbus')
    expect(values.firm_state).toBe('Ohio')
    expect(values.firm_zip).toBe('43209')
    // Comma-joined across all four parts, byte-for-byte what
    // FillTemplateModal's buildFirmValueMap writes: the same tag must not
    // render differently depending on which screen the template was filled
    // from. {firm_city_state_zip} is the signature-block form that drops the
    // comma before the ZIP.
    expect(values.firm_full_address).toBe('123 Main St, Columbus, Ohio, 43209')
    expect(values.firm_city_state_zip).toBe('Columbus, Ohio 43209')
  })

  it('emits the lead attorney email for the signature block', () => {
    const { values } = assembleCaseDocumentContext({
      ...baseInputs(),
      attorney: { barNumber: '0091234', email: 'morgan@halelaw.example' },
    })
    expect(values.attorney_email).toBe('morgan@halelaw.example')
  })
})

describe("today's date block", () => {
  it('emits short, long and part-wise dates in firm time', () => {
    const { values } = assembleCaseDocumentContext(baseInputs())
    expect(values.date).toBe('3/4/2026')
    expect(values.full_date).toBe('March 4, 2026')
    expect(values.year).toBe('2026')
    expect(values.month).toBe('March')
    expect(values.day).toBe('4')
  })
})

describe('hearing and key dates', () => {
  it('adds the legal-form hearing date and the courtroom', () => {
    const { values } = assembleCaseDocumentContext(
      baseInputs({
        nextHearing: {
          typeLabel: 'Hearing',
          date: new Date('2026-03-10T14:30:00Z'),
          location: 'Courtroom 4C',
        },
      }),
    )
    expect(values.hearing_date_legal).toBe('10th day of March 2026')
    expect(values.hearing_location).toBe('Courtroom 4C')
  })

  it('emits trial, statute-of-limitations and next-deadline dates', () => {
    const { values } = assembleCaseDocumentContext(
      baseInputs({
        keyDates: {
          trial: new Date('2026-06-01T13:00:00Z'),
          statuteOfLimitations: new Date('2026-09-01T13:00:00Z'),
          nextDeadline: { title: 'Discovery cutoff', date: new Date('2026-04-15T13:00:00Z') },
        },
      }),
    )
    expect(values.trial_date).toBe('June 1, 2026')
    expect(values.statute_of_limitations_date).toBe('September 1, 2026')
    expect(values.next_deadline_date).toBe('April 15, 2026')
    expect(values.next_deadline_title).toBe('Discovery cutoff')
  })

  it('omits key dates the case calendar does not have', () => {
    const { values } = assembleCaseDocumentContext(
      baseInputs({ keyDates: { trial: null, statuteOfLimitations: null, nextDeadline: null } }),
    )
    expect(values).not.toHaveProperty('trial_date')
    expect(values).not.toHaveProperty('statute_of_limitations_date')
    expect(values).not.toHaveProperty('next_deadline_date')
  })
})

// ── Money: stored facts only ───────────────────────────────────────────────
//
// WHY (Rule 9): a representation agreement is a contract. A blank the paralegal
// fills in is a nuisance; a plausible-looking wrong number is a client-facing
// problem. Every assertion below is about the builder REFUSING to state a
// figure it does not actually know: those are the ones that matter, because a
// wrong money value fails silently and ends up in a signed document.

function billingTotals(over: Partial<CaseBillingTotals> = {}): CaseBillingTotals {
  return {
    invoiceCount: 2,
    totalInvoicedCents: 300000,
    totalPaidCents: 100000,
    outstandingCents: 200000,
    totalHours: 6.5,
    trustBalanceCents: null,
    payments: [],
    lineItems: [],
    ...over,
  }
}

describe('billing totals', () => {
  it('states invoiced, paid, outstanding and hours once the case has an invoice', () => {
    const { values } = assembleCaseDocumentContext(baseInputs({ billing: billingTotals() }))
    expect(values.total_invoiced_amount).toBe('$3,000.00')
    expect(values.total_paid_amount).toBe('$1,000.00')
    expect(values.outstanding_balance).toBe('$2,000.00')
    expect(values.total_hours_billed).toBe('6.50')
  })

  it('says nothing at all when the case has never been invoiced', () => {
    // The hazard: "$0.00" in a letter is a STATEMENT that nothing is owed. With
    // no invoices the true answer is "unknown", so the keys must be absent and
    // surface in the modal as "needs input".
    const { values } = assembleCaseDocumentContext(
      baseInputs({
        billing: billingTotals({
          invoiceCount: 0,
          totalInvoicedCents: 0,
          totalPaidCents: 0,
          outstandingCents: 0,
          totalHours: 0,
        }),
      }),
    )
    expect(values).not.toHaveProperty('total_invoiced_amount')
    expect(values).not.toHaveProperty('total_paid_amount')
    expect(values).not.toHaveProperty('outstanding_balance')
    expect(values).not.toHaveProperty('total_hours_billed')
  })

  it('does state a zero balance when the invoices exist and are paid off', () => {
    // The mirror image: here $0.00 is the right answer and withholding it would
    // make the paralegal look it up by hand.
    const { values } = assembleCaseDocumentContext(
      baseInputs({
        billing: billingTotals({ totalPaidCents: 300000, outstandingCents: 0 }),
      }),
    )
    expect(values.outstanding_balance).toBe('$0.00')
  })

  it('omits hours on a flat-fee matter rather than printing 0.00', () => {
    const { values } = assembleCaseDocumentContext(
      baseInputs({ billing: billingTotals({ totalHours: 0 }) }),
    )
    expect(values).not.toHaveProperty('total_hours_billed')
  })

  it('emits a zero trust balance but omits it when there is no ledger', () => {
    const held = assembleCaseDocumentContext(
      baseInputs({ billing: billingTotals({ trustBalanceCents: 50000 }) }),
    )
    expect(held.values.trust_balance).toBe('$500.00')

    const drawn = assembleCaseDocumentContext(
      baseInputs({ billing: billingTotals({ trustBalanceCents: 0 }) }),
    )
    expect(drawn.values.trust_balance).toBe('$0.00')

    // Null = no single unambiguous client, or that client holds no trust ledger.
    const unknown = assembleCaseDocumentContext(
      baseInputs({ billing: billingTotals({ trustBalanceCents: null }) }),
    )
    expect(unknown.values).not.toHaveProperty('trust_balance')
  })
})

describe('installment plan terms', () => {
  const level = [
    { amountCents: 100000, dueDate: '2026-03-06', status: 'pending' },
    { amountCents: 100000, dueDate: '2026-04-01', status: 'pending' },
    { amountCents: 100000, dueDate: '2026-05-01', status: 'pending' },
  ]

  it('states the count, the level amount and the final due date', () => {
    const { values } = assembleCaseDocumentContext(baseInputs({ installments: level }))
    expect(values.installment_count).toBe('3')
    expect(values.installment_amount).toBe('$1,000.00')
    expect(values.final_payment_date).toBe('May 1, 2026')
  })

  it('omits the installment amount on an uneven schedule', () => {
    // There is no single "the installment amount" here, and naming one of the
    // three would put a wrong figure in a contract.
    const { values } = assembleCaseDocumentContext(
      baseInputs({
        installments: [
          { amountCents: 150000, dueDate: '2026-03-06' },
          { amountCents: 50000, dueDate: '2026-04-01' },
        ],
      }),
    )
    expect(values.installment_count).toBe('2')
    expect(values).not.toHaveProperty('installment_amount')
  })

  it('points the next payment at the first unpaid row', () => {
    const { values } = assembleCaseDocumentContext(
      baseInputs({
        installments: [
          { ...level[0], status: 'paid' },
          { ...level[1], status: 'pending' },
          { ...level[2], status: 'pending' },
        ],
      }),
    )
    expect(values.next_payment_amount).toBe('$1,000.00')
    expect(values.next_payment_due_date).toBe('April 1, 2026')
  })

  it('refuses to state a next payment when the next row is part-paid', () => {
    // What is still owed on a 'partial' row is not stored anywhere: the row's
    // amount_cents is the ORIGINAL figure. Printing it would overstate the debt.
    const { values } = assembleCaseDocumentContext(
      baseInputs({
        installments: [
          { ...level[0], status: 'paid' },
          { ...level[1], status: 'partial' },
          { ...level[2], status: 'pending' },
        ],
      }),
    )
    expect(values).not.toHaveProperty('next_payment_amount')
    expect(values).not.toHaveProperty('next_payment_due_date')
  })
})

describe('billing repeaters', () => {
  it('lists payments already received, dropping a blank reference', () => {
    const { repeaterValues } = assembleCaseDocumentContext(
      baseInputs({
        billing: billingTotals({
          payments: [
            { date: '2026-03-01', amountCents: 100000, method: 'zelle', reference: 'ZL-4412' },
            { date: '2026-03-02', amountCents: 25000, method: 'external', reference: null },
          ],
        }),
      }),
    )
    expect(repeaterValues.payment_history).toEqual([
      {
        payment_received_date: 'March 1, 2026',
        payment_received_amount: '$1,000.00',
        payment_method: 'Zelle',
        payment_reference: 'ZL-4412',
      },
      {
        payment_received_date: 'March 2, 2026',
        payment_received_amount: '$250.00',
        payment_method: 'External',
      },
    ])
  })

  it('lists billable charges as line items', () => {
    const { repeaterValues } = assembleCaseDocumentContext(
      baseInputs({
        billing: billingTotals({
          lineItems: [
            { date: '2026-02-20', description: 'Review discovery packet', amountCents: 45000 },
          ],
        }),
      }),
    )
    expect(repeaterValues.line_items).toEqual([
      {
        line_item_date: 'February 20, 2026',
        line_item_description: 'Review discovery packet',
        line_item_amount: '$450.00',
      },
    ])
  })

  it('omits both repeaters when there is nothing to list', () => {
    const { repeaterValues } = assembleCaseDocumentContext(baseInputs({ billing: billingTotals() }))
    expect(repeaterValues.payment_history).toBeUndefined()
    expect(repeaterValues.line_items).toBeUndefined()
  })
})

// ── docx round-trip over a placeholder-ized fixture ────────────────────────

// Minimal but real OOXML: build a .docx whose body uses the same tag styles
// the placeholder-izer produces, then fill it with the assembled context and
// assert the output text. This is the same engine (docxtemplater) the
// fill-docx route uses, so a vocabulary/engine mismatch fails here first.
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
  const xml = new PizZip(docx).file('word/document.xml')!.asText()
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<[^>]+>/g, '')
}

describe('fillDocxTemplate round-trip with the assembled context', () => {
  const fixture = makeDocx(
    para('{court_name_caps}') +
      para('Case No. {case_number}') +
      para('JUDGE: {judge_name_caps}') +
      para('Defendant {defendant_name} enters a plea regarding {charges}.') +
      para('Served on {service_recipient} this {service_date_legal}.') +
      para('Initial payment {initial_payment_amount} due {initial_payment_date}, then:') +
      // paragraphLoop: the loop open/close tags sit in their own paragraphs,
      // exactly how the placeholder-izer writes them into the rep agreement.
      para('{#payments}') +
      para('{payment_date} - {payment_amount} payment') +
      para('{/payments}'),
  )

  it('parses the fixture vocabulary the same way the seed script will', () => {
    const parsed = parseDocxPlaceholders(fixture)
    expect(parsed.fields).toEqual(
      expect.arrayContaining([
        'court_name_caps',
        'case_number',
        'judge_name_caps',
        'defendant_name',
        'charges',
        'service_recipient',
        'service_date_legal',
        'initial_payment_amount',
        'initial_payment_date',
      ]),
    )
    expect(parsed.repeaters).toEqual([
      { name: 'payments', fields: expect.arrayContaining(['payment_date', 'payment_amount']) },
    ])
  })

  it('fills the fixture with zero leftover tags and correct text', () => {
    const { values, repeaterValues } = assembleCaseDocumentContext(
      baseInputs({
        installments: [
          { amountCents: 100000, dueDate: '2026-03-06' },
          { amountCents: 50000, dueDate: '2026-04-01' },
        ],
      }),
    )
    const { buffer: filled } = fillDocxTemplate(fixture, values, repeaterValues)
    const text = extractText(filled)

    expect(text).toContain('FRANKLIN COUNTY MUNICIPAL COURT')
    expect(text).toContain('Case No. TRC0000551')
    // Caption prints "JUDGE:" itself; the stored "Judge James E. Green" is
    // de-titled so it reads once, not "JUDGE: JUDGE ...".
    expect(text).toContain('JUDGE: JAMES E. GREEN')
    expect(text).not.toContain('JUDGE: JUDGE')
    expect(text).toContain(
      'Defendant Corwin Thistlewood enters a plea regarding OVI (M1), Failure to Control (MM).',
    )
    expect(text).toContain('Served on Jane Smith this 4th day of March 2026.')
    expect(text).toContain('Initial payment $1,000.00 due March 6, 2026, then:')
    expect(text).toContain('April 1, 2026 - $500.00 payment')
    // No unfilled tags left behind.
    expect(text).not.toMatch(/\{[^}]*\}/)
  })
})

describe('court-filing fields with a data source', () => {
  // WHY (Rule 9): bar number and division were dead ends until
  // migration 20260818000020 gave them columns. The value of that change is
  // exactly that these two keys now come out of autofill: if they stop, every
  // filing silently goes back to being retyped by hand, with no error.
  it('emits the lead attorney bar number and the court division', () => {
    const ctx = assembleCaseDocumentContext({
      ...baseInputs(),
      attorney: { barNumber: '0091234' },
      court: { division: 'Eastern Division' },
    })

    expect(ctx.values.attorney_bar_number).toBe('0091234')
    expect(ctx.values.court_division).toBe('Eastern Division')
  })

  it('omits them when the firm has not filled them in', () => {
    // setIfPresent semantics: an absent key lets the fill modal report "empty
    // for this case" rather than writing a blank into a court filing.
    const ctx = assembleCaseDocumentContext({
      ...baseInputs(),
      attorney: { barNumber: null },
      court: { division: null },
    })

    expect(ctx.values.attorney_bar_number).toBeUndefined()
    expect(ctx.values.court_division).toBeUndefined()
  })

  it('works when the case has no lead attorney or court at all', () => {
    const ctx = assembleCaseDocumentContext({ ...baseInputs(), attorney: null, court: null })
    expect(ctx.values.attorney_bar_number).toBeUndefined()
    expect(ctx.values.court_division).toBeUndefined()
  })
})

// Draft invoices must never reach a generated document.
//
// WHY (Rule 9): a draft is an invoice the firm is still assembling: it has not
// been sent, and every client-facing read in the billing module hides it
// (src/lib/billing/queries.ts filters `.neq('status', 'draft')` before showing
// a client anything). The autofill fetch did not, so {outstanding_balance} on a
// representation agreement or status letter could demand money for an invoice
// the client has never seen. That is a number on firm letterhead, so it gets a
// test that fails the moment the filter is dropped.
describe('summarizeCaseInvoices: draft exclusion', () => {
  const sent = {
    id: 'a',
    total_amount_cents: 100_000,
    amount_paid_cents: 0,
    remaining_balance_cents: 100_000,
    total_hours: 4,
    is_paid: false,
    status: 'sent',
  }
  const draft = {
    id: 'b',
    total_amount_cents: 500_000,
    amount_paid_cents: 0,
    remaining_balance_cents: 500_000,
    total_hours: 20,
    is_paid: false,
    status: 'draft',
  }

  it('omits a draft invoice from every total it feeds a document', () => {
    const totals = summarizeCaseInvoices([sent, draft])
    expect(totals.outstandingCents).toBe(100_000)
    expect(totals.totalInvoicedCents).toBe(100_000)
    expect(totals.invoiceCount).toBe(1)
    expect(totals.totalHours).toBe(4)
  })

  it('reports a case whose only invoice is a draft as having no invoices', () => {
    const totals = summarizeCaseInvoices([draft])
    expect(totals.invoiceCount).toBe(0)
    expect(totals.outstandingCents).toBe(0)
    expect(totals.totalInvoicedCents).toBe(0)
  })

  it('still counts a sent invoice the client owes', () => {
    const totals = summarizeCaseInvoices([sent])
    expect(totals.outstandingCents).toBe(100_000)
    expect(totals.invoiceCount).toBe(1)
  })
})

// A client picked with no case is a real workflow (an engagement letter sent
// before the matter is opened). Without a case the builder used to produce
// nothing at all, so every client and firm field fell back to typing.
describe('client-only context (no case picked)', () => {
  it('fills client, firm and date fields and no case field', () => {
    const { values } = assembleCaseDocumentContext(
      baseInputs({ caseRow: EMPTY_CASE_ROW, nextHearing: null }),
    )
    expect(values.client_name).toBe('Corwin Thistlewood')
    expect(values.firm_name).toBe('Hale Law LLC')
    expect(values.letter_date).toBe('March 4, 2026')
    for (const caseKey of ['case_name', 'case_number', 'court_name', 'charges', 'attorney_name',
      'service_recipient', 'judge_name']) {
      expect(values).not.toHaveProperty(caseKey)
    }
  })
})

// Stored facts only (DECISIONS 2026-09-09): each money field below prints only
// when the value is recorded, never a zero or a guess.
describe('retainer and down payment', () => {
  it('prints the recorded retainer and down payment', () => {
    const { values } = assembleCaseDocumentContext(
      baseInputs({ retainerCents: 150000, downPaymentCents: 50000 }),
    )
    expect(values.retainer_amount).toBe('$1,500.00')
    expect(values.down_payment_amount).toBe('$500.00')
  })

  it('omits both when nothing is recorded', () => {
    const { values } = assembleCaseDocumentContext(
      baseInputs({ retainerCents: null, downPaymentCents: 0 }),
    )
    expect(values).not.toHaveProperty('retainer_amount')
    expect(values).not.toHaveProperty('down_payment_amount')
  })
})

// The fill form lets staff pick which of the case's clients the document is
// about. Printing the case's first client instead puts the wrong person's name
// on a contract.
describe('pickCaseClient', () => {
  const rows = [
    { id: 'cc-1', client_id: 'client-a', name: 'Alpha' },
    { id: 'cc-2', client_id: 'client-b', name: 'Bravo' },
  ]

  it('returns the case client the user picked', () => {
    expect(pickCaseClient(rows, 'client-b')?.name).toBe('Bravo')
  })

  it('falls back to the first case client when nobody was picked', () => {
    expect(pickCaseClient(rows, null)?.name).toBe('Alpha')
  })

  it('returns null for a pick that is not on the case, so the caller loads that client', () => {
    expect(pickCaseClient(rows, 'client-z')).toBeNull()
  })
})

// Firm-defined case fields (Settings > Case fields) are data the firm chose to
// record per matter; a template naming one should not make staff retype it.
describe('customFieldValues', () => {
  const defs = [
    { id: 'f1', label: 'County', field_type: 'text' as const, display_order: 1 },
    { id: 'f2', label: 'Arrest Date', field_type: 'date' as const, display_order: 2 },
    { id: 'f3', label: 'Prior Offenses', field_type: 'number' as const, display_order: 3 },
    { id: 'f4', label: 'Jury Demanded', field_type: 'checkbox' as const, display_order: 4 },
    { id: 'f5', label: 'Unanswered', field_type: 'text' as const, display_order: 5 },
  ]

  it('keys each answered field by its normalized label, formatted for print', () => {
    expect(
      customFieldValues(defs, { f1: '  Franklin ', f2: '2026-02-14', f3: 2, f4: false }),
    ).toEqual({
      county: 'Franklin',
      arrest_date: 'February 14, 2026',
      prior_offenses: '2',
      jury_demanded: 'No',
    })
  })

  it('ignores answers for fields the firm no longer defines, and a missing blob', () => {
    expect(customFieldValues(defs, { gone: 'x' })).toEqual({})
    expect(customFieldValues(defs, null)).toEqual({})
  })
})

// A trust balance belongs to one client's ledger. Printing it for a client who
// is not on the case would pair this matter's bill with someone else's money.
describe('trustClientFor', () => {
  it('uses the picked client when that client is on the case', () => {
    expect(trustClientFor(['client-a', 'client-b'], 'client-b')).toBe('client-b')
  })

  it('never uses a picked client who is not on the case', () => {
    expect(trustClientFor(['client-a'], 'client-z')).toBe('client-a')
    expect(trustClientFor(['client-a', 'client-b'], 'client-z')).toBeNull()
  })

  it('falls back to the sole case client when nobody was picked, and to none with two', () => {
    expect(trustClientFor(['client-a'], null)).toBe('client-a')
    expect(trustClientFor(['client-a', 'client-b'], null)).toBeNull()
  })
})

// A firm field whose label overlaps a built-in one ("Offense" is an alias of
// charges) must not print in place of the recorded built-in value.
describe('withCustomFieldValues', () => {
  it('keeps the built-in value for any tag that resolves to it', () => {
    const merged = withCustomFieldValues({ charges: 'OVI (M1)' }, { offense: 'Custom answer' })
    expect(resolveProvidedValues(['Charged Offenses', 'charges'], merged)).toEqual({
      'Charged Offenses': 'OVI (M1)',
      charges: 'OVI (M1)',
    })
  })

  it('fills from the firm field where no built-in value exists', () => {
    const merged = withCustomFieldValues({ charges: 'OVI (M1)' }, { county: 'Franklin' })
    expect(resolveProvidedValues(['County'], merged)).toEqual({ County: 'Franklin' })
  })
})
