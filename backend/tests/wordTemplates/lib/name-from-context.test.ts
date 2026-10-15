import { nameFromContext } from '../../../src/modules/wordTemplates/lib/auto-bracket/name-from-context'
import { detectFields, type DetectedField } from '../../../src/modules/wordTemplates/lib/auto-bracket/detect-patterns'
import { detectHighlightedFields } from '../../../src/modules/wordTemplates/lib/auto-bracket/detect-highlights'

// Tests for naming a detected value from the words before it.
//
// WHY (Rule 9): a generic name (amount_1) costs the paralegal one typed value.
// A wrong canonical name costs more: the fill engine prints the case's value
// for that field into a clause about something else, in a legal document, with
// no warning. So the negatives below matter as much as the positives, and each
// one pins a specific way a label could be misread: an ambiguous owner, a label
// in the next paragraph, a money label in front of a date, a dropped qualifier,
// and one name claimed by two different values.

function byLiteral(fields: DetectedField[]): Record<string, DetectedField> {
  return Object.fromEntries(fields.map((f) => [f.literal, f]))
}

describe('nameFromContext: names a value its label identifies', () => {
  it('reads a flat fee from the prose before the amount', () => {
    expect(nameFromContext('The client agrees to pay a flat fee of ', 'money')).toBe('flat_fee_amount')
  })

  it('reads an hourly rate', () => {
    expect(nameFromContext('Services are billed at an hourly rate of ', 'money')).toBe('hourly_rate')
  })

  it('reads an initial payment, adding the kind word the vocabulary id carries', () => {
    // The id carries the kind word, which is tried before the bare phrase.
    expect(nameFromContext('and an initial payment of ', 'money')).toBe('initial_payment_amount')
  })

  it('names the date of a payment from the payment named before its amount', () => {
    expect(nameFromContext('an initial payment of $500 due on ', 'date')).toBe('initial_payment_date')
    // The firm's own agreement says "on", not "due on".
    expect(
      nameFromContext('You have agreed to make an initial payment of $2,500.00 on ', 'date'),
    ).toBe('initial_payment_date')
  })

  it('names a phone whose label says whose it is', () => {
    expect(nameFromContext('Client phone: ', 'phone')).toBe('client_phone')
  })
})

// The retainer and the down payment are stored facts the fill can supply
// (billing_plans, invoices.down_payment_cents), so an agreement that states
// them should upload with names that auto-fill.
describe('nameFromContext: retainer and down payment', () => {
  it('names a retainer amount', () => {
    expect(nameFromContext('Client agrees to a monthly retainer of ', 'money')).toBe('retainer_amount')
  })

  it('names a down payment amount', () => {
    expect(nameFromContext('A down payment of ', 'money')).toBe('down_payment_amount')
  })

  it('never names a date after either of them', () => {
    expect(nameFromContext('A down payment of ', 'date')).toBeNull()
  })
})

describe('nameFromContext: an hourly cue right after an amount', () => {
  it('names an amount billed per hour, as the firm\'s agreement words it', () => {
    // Verbatim from the firm's representation agreement: no label before it.
    expect(
      nameFromContext('Should those become necessary, the fee for such services will be ', 'money', ' per hour.'),
    ).toBe('hourly_rate')
  })

  it('reads each spelling of the cue', () => {
    for (const after of [' an hour', '/hr', '/hour', ' hourly', ' Per Hour']) {
      expect(nameFromContext('billed at ', 'money', after)).toBe('hourly_rate')
    }
  })

  it('does not read any other period as hourly', () => {
    expect(nameFromContext('the fee will be ', 'money', ' per month')).toBeNull()
  })

  it('reads the cue only when it touches the amount, in the same paragraph', () => {
    // The cue later in the sentence belongs to the $50, not to this amount.
    expect(nameFromContext('the fee will be ', 'money', ' a month, and $50 per hour')).toBeNull()
    expect(nameFromContext('the fee will be ', 'money', '\nper hour')).toBeNull()
  })

  it('names nothing when the label and the cue disagree', () => {
    // "a flat fee of $300 per hour" contradicts itself; neither name is safe.
    expect(nameFromContext('a flat fee of ', 'money', ' per hour')).toBeNull()
  })

  it('applies to amounts only', () => {
    expect(nameFromContext('', 'date', ' per hour')).toBeNull()
  })
})

describe('nameFromContext: keeps the generic name when in doubt', () => {
  it('does not name a bare "Phone:", which could be the firm or the client', () => {
    // The vocabulary resolves "phone" to client_phone as a default for
    // hand-authored tags. On a letterhead that default is the wrong party.
    expect(nameFromContext('Phone: ', 'phone')).toBeNull()
    expect(nameFromContext('Phone Number: ', 'phone')).toBeNull()
    expect(nameFromContext('Email: ', 'email')).toBeNull()
  })

  it('never reads a label from the previous paragraph', () => {
    expect(nameFromContext('an initial payment of\n', 'money')).toBeNull()
    expect(nameFromContext('Flat fee:\n', 'money')).toBeNull()
  })

  it('does not name a date after a money field', () => {
    // "flat fee" resolves to flat_fee_amount; a date must not become it.
    expect(nameFromContext('Flat fee: ', 'date')).toBeNull()
    // Nor does a date after a flat-fee amount become a payment date.
    expect(nameFromContext('a flat fee of $2,500.00 due on ', 'date')).toBeNull()
  })

  it('does not drop a qualifier to reach a shorter name', () => {
    // Verbatim from the firm's representation agreement. "rate" alone resolves
    // to hourly_rate; this amount is the FLAT fee.
    expect(nameFromContext('This service is provided at a non-refundable flat rate of ', 'money')).not.toBe('hourly_rate')
    // "office phone" resolves to firm_phone; this one is the client's.
    expect(nameFromContext("You can reach the client's office phone at ", 'phone')).toBeNull()
  })

  it('reaches back across an amount only for that payment\'s date', () => {
    // The second amount here is not the initial payment.
    expect(nameFromContext('an initial payment of $500.00 plus ', 'money')).toBeNull()
  })

  it('does not reach back across the end of a sentence', () => {
    expect(nameFromContext('The initial payment is due. ', 'date')).toBeNull()
  })

  it('leaves ledger figures alone: in a contract the same words state a contract term', () => {
    // "remaining balance" resolves to outstanding_balance, a live ledger figure.
    expect(nameFromContext('and pay the remaining balance of ', 'money')).toBeNull()
  })
})

describe('detectFields: context names', () => {
  it('names each fee term in a sentence from its own label', () => {
    const map = byLiteral(
      detectFields('The client agrees to pay a flat fee of $2,500.00 and an initial payment of $500.00 due on March 1, 2026.'),
    )
    expect(map['$2,500.00']).toMatchObject({ suggestedTag: 'flat_fee_amount', canonical: true })
    expect(map['$500.00']).toMatchObject({ suggestedTag: 'initial_payment_amount', canonical: true })
    expect(map['March 1, 2026']).toMatchObject({ suggestedTag: 'initial_payment_date', canonical: true })
  })

  it('gives a canonical name to one value only; a second value with the same label stays generic', () => {
    const map = byLiteral(
      detectFields('A flat fee of $2,500.00 covers the trial.\nA flat fee of $3,000.00 covers an appeal.'),
    )
    expect(map['$2,500.00']).toMatchObject({ suggestedTag: 'flat_fee_amount', canonical: true })
    expect(map['$3,000.00']).toMatchObject({ suggestedTag: 'amount_1', canonical: false })
  })

  it('does not take a name an authored marker already uses, wherever the marker sits', () => {
    const map = byLiteral(detectFields('A flat fee of $2,500.00 is due.\nFee: [FLAT FEE]'))
    expect(map['[FLAT FEE]']).toMatchObject({ suggestedTag: 'flat_fee_amount', canonical: true })
    expect(map['$2,500.00']).toMatchObject({ suggestedTag: 'amount_1', canonical: false })
  })

  it('keeps the generic name when two occurrences of one value are labelled differently', () => {
    // One literal becomes one tag everywhere it occurs, so a name that fits
    // one occurrence would print the wrong value at the other.
    const map = byLiteral(detectFields('A flat fee of $500.00.\nAn initial payment of $500.00.'))
    expect(map['$500.00']).toMatchObject({ suggestedTag: 'amount_1', canonical: false })
  })

  it('names an amount from the hourly cue after it, once per document', () => {
    const map = byLiteral(
      detectFields('Services are billed at $250.00 per hour.\nTravel is billed at $100.00 per hour.'),
    )
    expect(map['$250.00']).toMatchObject({ suggestedTag: 'hourly_rate', canonical: true })
    expect(map['$100.00']).toMatchObject({ suggestedTag: 'amount_1', canonical: false })
  })

  it('keeps a bare letterhead phone generic', () => {
    const map = byLiteral(detectFields('Phone: (614) 555-0100'))
    expect(map['(614) 555-0100']).toMatchObject({ suggestedTag: 'phone_1', canonical: false })
  })
})

describe('detectHighlightedFields: a context name inside a highlight', () => {
  it('does not mark a generically named highlight as canonical', () => {
    // The highlight names itself field_1 whenever its span is more than one
    // value. Reporting it canonical would stop a later layer from renaming it.
    const run = (text: string, highlight: boolean) =>
      `<w:r><w:rPr>${highlight ? '<w:highlight w:val="yellow"/>' : ''}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`
    const xml = `<w:p>${run('Client will make ', false)}${run('an initial payment of $500.00', true)}</w:p>`
    const [f] = detectHighlightedFields(xml)
    expect(f).toMatchObject({ literal: 'an initial payment of $500.00', suggestedTag: 'field_1', canonical: false })
  })
})
