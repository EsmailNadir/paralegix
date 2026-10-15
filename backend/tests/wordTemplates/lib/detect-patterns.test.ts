import { detectFields, type DetectedField } from '../../../src/modules/wordTemplates/lib/auto-bracket/detect-patterns'

// Tests for the regex auto-bracketing detector (Phase 1, non-AI).
//
// WHY (Rule 9): the detector proposes which literals in an uploaded document
// become {tags}. Precision matters: a wrong or overlapping bracket ships into
// every future document. These pin: category recognition, no-overlap between a
// case number and a bare-number pattern, canonical vs generic naming, and
// document-order + dedup so the review list is stable.

function byLiteral(fields: DetectedField[]): Record<string, DetectedField> {
  return Object.fromEntries(fields.map((f) => [f.literal, f]))
}

describe('detectFields: categories', () => {
  it('detects a case number and maps it to the canonical case_number id', () => {
    const [f] = detectFields('Case No. TRC0000551 in the Municipal Court')
    expect(f.category).toBe('case_number')
    expect(f.suggestedTag).toBe('case_number')
    expect(f.canonical).toBe(true)
  })

  it('detects the common-pleas CP-YY-XX-###### form', () => {
    const [f] = detectFields('Docket CP-24-CR-001234 filed today')
    expect(f).toMatchObject({ category: 'case_number', suggestedTag: 'case_number', canonical: true })
  })

  it('detects money with a generic, indexed tag', () => {
    // No identifying label before either amount, so this stays on the generic path.
    const fields = detectFields('The client will pay $2,500.00 then $1,000 monthly.')
    const map = byLiteral(fields)
    expect(map['$2,500.00']).toMatchObject({ category: 'money', suggestedTag: 'amount_1', canonical: false })
    expect(map['$1,000']).toMatchObject({ category: 'money', suggestedTag: 'amount_2' })
  })

  it('detects long, legal, numeric, and ISO dates', () => {
    expect(detectFields('Dated March 4, 2026.')[0]).toMatchObject({ category: 'date', literal: 'March 4, 2026' })
    expect(detectFields('this 4th day of March 2026')[0]).toMatchObject({ category: 'date', literal: '4th day of March 2026' })
    expect(detectFields('on 03/04/2026 at noon')[0]).toMatchObject({ category: 'date', literal: '03/04/2026' })
    expect(detectFields('col: 2026-03-04 end')[0]).toMatchObject({ category: 'date', literal: '2026-03-04' })
  })

  it('detects email and phone', () => {
    const map = byLiteral(detectFields('Reach me at jane@example.com or (614) 555-1234.'))
    expect(map['jane@example.com']).toMatchObject({ category: 'email' })
    expect(map['(614) 555-1234']).toMatchObject({ category: 'phone' })
  })

  it('detects a ZIP', () => {
    const [f] = detectFields('Columbus, Ohio 43209')
    expect(f).toMatchObject({ category: 'zip', literal: '43209' })
  })
})

describe('detectFields: no overlap / precedence', () => {
  it('does not re-detect a case number as a bare ZIP or phone', () => {
    const fields = detectFields('Case No. TRC0000551')
    expect(fields).toHaveLength(1)
    expect(fields[0].category).toBe('case_number')
  })

  it('does not shred an email into digit runs', () => {
    const fields = detectFields('billing2026@firm.com')
    // Exactly one detection, the whole email: not a stray date/zip inside it.
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ category: 'email', literal: 'billing2026@firm.com' })
  })

  it('keeps a phone number whole rather than detecting its trailing 4+ digits', () => {
    const fields = detectFields('Call 614-555-1234 now')
    expect(fields.filter((f) => f.category === 'phone')).toHaveLength(1)
    expect(fields.some((f) => f.category === 'zip')).toBe(false)
  })
})

describe('detectFields: dedup, counting, ordering', () => {
  it('dedupes by literal and counts occurrences across the document', () => {
    const fields = detectFields('Pay $500 now.\nAnother line.\nPay $500 again.')
    const money = fields.filter((f) => f.category === 'money')
    expect(money).toHaveLength(1)
    expect(money[0]).toMatchObject({ literal: '$500', occurrences: 2 })
  })

  it('returns proposals in document order with a trimmed context snippet', () => {
    const fields = detectFields('Header line\n  Amount: $99.00 due  \nCase No. TRC0000551')
    expect(fields.map((f) => f.category)).toEqual(['money', 'case_number'])
    expect(fields[0].contextSnippet).toBe('Amount: $99.00 due')
  })

  it('returns nothing for a document with no value-shaped text', () => {
    expect(detectFields('Dear Client, thank you for your business.')).toEqual([])
  })
})

// Authored `[LABEL]` blanks: layer 1 of detection.
//
// WHY (Rule 9): these carry the author's own statement of what belongs in a
// slot, so they are the only signal that survives an UNFILLED template. Before
// this layer the detector read a blank Demand for Discovery and returned only
// the firm's own filled-in phone/fax/ZIP/email, leaving every real variable as
// literal text in the generated filing. The precision tests matter just as much
// as the recall ones: a false positive puts a {tag} inside quoted authority.
describe('detectFields: authored [LABEL] markers', () => {
  it('resolves a marker label to its canonical fill id', () => {
    const map = byLiteral(
      detectFields('IN THE [COURT NAME]\nCase No.: [CASE NO.]\nJudge: [JUDGE NAME]\n[CLIENT NAME],'),
    )
    expect(map['[COURT NAME]']).toMatchObject({ category: 'marker', suggestedTag: 'court_name', canonical: true })
    expect(map['[CASE NO.]']).toMatchObject({ suggestedTag: 'case_number', canonical: true })
    expect(map['[JUDGE NAME]']).toMatchObject({ suggestedTag: 'judge_name', canonical: true })
    expect(map['[CLIENT NAME]']).toMatchObject({ suggestedTag: 'client_name', canonical: true })
  })

  it('keeps an unknown label as its own slug, filled by hand rather than auto-filled', () => {
    const [f] = detectFields('served via [COURIER NAME] today')
    expect(f).toMatchObject({ category: 'marker', suggestedTag: 'courier_name', canonical: false })
  })

  it('resolves the certificate-of-service filing labels, which a court now stores', () => {
    // Were hand-typed until courts gained filing_method / filing_address
    // (20260924000010); the case packet fills them from the case's court.
    const map = byLiteral(detectFields('via [METHOD OF FILING] to [FILING EMAIL/ADDRESS] on'))
    expect(map['[METHOD OF FILING]']).toMatchObject({ suggestedTag: 'filing_method', canonical: true })
    expect(map['[FILING EMAIL/ADDRESS]']).toMatchObject({ suggestedTag: 'filing_address', canonical: true })
  })

  it('prefixes a label that would start with a digit, so the tag stays valid', () => {
    const [f] = detectFields('set for the [2ND HEARING] of record')
    expect(f.suggestedTag).toBe('field_2nd_hearing')
  })

  it('claims the whole marker, never a value shape inside it', () => {
    const fields = detectFields('continued to [HEARING DATE 03/04/2026] by entry')
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ category: 'marker', literal: '[HEARING DATE 03/04/2026]' })
  })

  it('ignores a bracketed letter inside quoted authority', () => {
    // Verbatim from the firm's Demand for Discovery, which quotes Crim. R. 16.
    const fields = detectFields('“[E]vidence that would diminish the credibility of any witness”')
    expect(fields).toEqual([])
  })

  it('ignores editorial asides and enumeration', () => {
    for (const aside of ['[sic]', '[emphasis added]', '[citations omitted]', '[1]', '[iii]', '[IV]']) {
      expect(detectFields(`the statute ${aside} applies`)).toEqual([])
    }
  })

  it('still detects a value shape sitting inside a rejected bracket', () => {
    // Rejecting a bracket must not also swallow the characters inside it.
    const fields = detectFields('[1] dated March 4, 2026')
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ category: 'date', literal: 'March 4, 2026' })
  })

  it('treats a long bracketed span as prose, not a blank', () => {
    expect(detectFields('[a parenthetical running well past any plausible field label here]')).toEqual([])
  })

  it('dedupes a marker that appears in both the caption and the certificate of service', () => {
    const fields = detectFields('IN THE [COURT NAME]\nserved upon the [COURT NAME], via email')
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ literal: '[COURT NAME]', occurrences: 2 })
  })
})

// Shape-pattern gaps found by running the detector over the firm's own filings.
describe('detectFields: shapes the firm’s documents actually contain', () => {
  it('keeps a multi-count case number whole', () => {
    // One number covering three counts. A bare \b after the digits split this
    // into "TRC0000001" plus stray letters, so the Motion to Continue detected
    // no case number at all.
    const [f] = detectFields('Case No. TRC0000001A/B/C')
    expect(f).toMatchObject({ category: 'case_number', literal: 'TRC0000001A/B/C', canonical: true })
  })

  it('still reads a plain case number', () => {
    expect(detectFields('Case No. TRC0000001')[0].literal).toBe('TRC0000001')
  })

  it('detects a hearing time', () => {
    const map = byLiteral(detectFields('set for 8:00 a.m. and 1:30 PM'))
    expect(map['8:00 a.m.']).toMatchObject({ category: 'time', suggestedTag: 'time_1' })
    expect(map['1:30 PM']).toMatchObject({ category: 'time', suggestedTag: 'time_2' })
  })

  it('does not read a time as a phone number or a ZIP', () => {
    const fields = detectFields('continued to 03/04/2026, at 8:00 a.m.')
    expect(fields.map((f) => f.category).sort()).toEqual(['date', 'time'])
  })

  it('detects an unpunctuated 10-digit phone', () => {
    // Exactly how the firm's letterhead came out of a generated filing.
    const [f] = detectFields('Phone 6145550142')
    expect(f).toMatchObject({ category: 'phone', literal: '6145550142' })
  })

  it('prefers the punctuated phone form when both could match', () => {
    const fields = detectFields('Call 614-555-1234 now')
    expect(fields).toHaveLength(1)
    expect(fields[0].literal).toBe('614-555-1234')
  })
})
