import {
  buildKnownValueIndex,
  detectKnownValues,
  findLeftoverClientText,
  nameWithKnownValues,
  resolveKnownValue,
  type KnownValue,
} from '../../../src/modules/wordTemplates/lib/auto-bracket/known-values'
import type { DetectedField } from '../../../src/modules/wordTemplates/lib/auto-bracket/detect-patterns'

// Tests for known-value matching (layer 4).
//
// WHY (Rule 9): this layer decides whether a proposed field auto-fills from the
// case or has to be retyped for every document, so its naming behaviour IS the
// business value. Its detection behaviour carries the opposite risk: a value
// that matches too eagerly brackets ordinary prose, and a bad bracket is
// permanent in every filing made from that template afterwards. The split
// between "may name" and "may detect" is therefore load-bearing, not a detail.

const FIRM: KnownValue[] = [
  { value: 'Hale Law LLC', canonicalId: 'firm_name' },
  { value: 'Jordan Avery', canonicalId: 'client_name' },
  { value: 'Avery', canonicalId: 'client_last_name', nameOnly: true, ofName: 'Jordan Avery' },
  { value: 'Example Municipal Court', canonicalId: 'court_name' },
  { value: 'Holloway', canonicalId: 'judge_name' },
  { value: 'TRC0000001A/B/C', canonicalId: 'case_number' },
  { value: 'Ohio', canonicalId: 'client_organization' },
]

const index = buildKnownValueIndex(FIRM)

const literal = (text: string, over: Partial<DetectedField> = {}): DetectedField => ({
  kind: 'literal',
  literal: text,
  category: 'highlight',
  suggestedTag: 'field_1',
  canonical: false,
  occurrences: 1,
  contextSnippet: text,
  ...over,
})

describe('resolveKnownValue', () => {
  it('matches a value regardless of the casing a caption shouts it in', () => {
    expect(resolveKnownValue('JORDAN AVERY', index)).toBe('client_name')
  })

  it('names a span the author drew wider than the value itself', () => {
    expect(resolveKnownValue('Jordan Avery (Client)', index)).toBe('client_name')
    expect(resolveKnownValue('IN THE EXAMPLE MUNICIPAL COURT', index)).toBe('court_name')
  })

  it('uses a surname to name a salutation', () => {
    expect(resolveKnownValue('Ms. Avery', index)).toBe('client_last_name')
  })

  it('prefers the most specific value when several match', () => {
    // "Avery" is inside "Jordan Avery": the longer one has to win, or a
    // full name would be filled from the last-name field.
    expect(resolveKnownValue('Jordan Avery', index)).toBe('client_name')
  })

  it('refuses to name a paragraph after one value buried inside it', () => {
    const prose =
      'Counsel for Defendant is currently awaiting receipt of discovery from the State of Ohio'
    expect(resolveKnownValue(prose, index)).toBeNull()
  })

  it('matches on whole words only', () => {
    expect(resolveKnownValue('Averys', index)).toBeNull()
  })
})

describe('nameWithKnownValues', () => {
  it('upgrades a generic proposal to the canonical id it turns out to be', () => {
    const [f] = nameWithKnownValues([literal('HOLLOWAY')], index)
    expect(f).toMatchObject({ suggestedTag: 'judge_name', canonical: true })
  })

  it('leaves an already-canonical proposal alone', () => {
    // Silently re-pointing a field at a different vocabulary id is exactly the
    // quiet substitution that must never happen (Rule 12).
    const input = literal('TRC0000001A/B/C', { suggestedTag: 'case_number', canonical: true })
    expect(nameWithKnownValues([input], index)[0].suggestedTag).toBe('case_number')
  })

  it('leaves a proposal it cannot place untouched', () => {
    const [f] = nameWithKnownValues([literal('Pre-Trial')], index)
    expect(f).toMatchObject({ suggestedTag: 'field_1', canonical: false })
  })
})

describe('detectKnownValues', () => {
  it('finds a known value nothing else marked, with the document’s own casing', () => {
    const fields = detectKnownValues('Defendant JORDAN AVERY appears.', index)
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({
      literal: 'JORDAN AVERY',
      suggestedTag: 'client_name',
      canonical: true,
      category: 'known',
    })
  })

  it('never hunts for a name-only value on its own', () => {
    // A bare surname in prose is the false positive that ships into every
    // future filing.
    expect(detectKnownValues('The Avery standard applies here.', index)).toEqual([])
  })

  it('never hunts for a short single-word value', () => {
    expect(detectKnownValues('filed in the State of Ohio today', index)).toEqual([])
  })

  it('claims the longest match, so a value inside another is not double-proposed', () => {
    const fields = detectKnownValues('Case No. TRC0000001A/B/C', index)
    expect(fields.map((f) => f.literal)).toEqual(['TRC0000001A/B/C'])
  })

  it('counts every occurrence of the same spelling', () => {
    const fields = detectKnownValues(
      'Hale Law LLC\nfoo\nHale Law LLC again',
      index,
    )
    expect(fields).toHaveLength(1)
    expect(fields[0].occurrences).toBe(2)
  })

  it('matches on whole words only', () => {
    expect(detectKnownValues('the Holloways own it', index)).toEqual([])
  })

  it('still matches a value whose casing differs from the document’s', () => {
    // The word pre-filter that keeps this pass cheap is case-folded; if it ever
    // stops being, a caption in capitals silently matches nothing.
    expect(detectKnownValues('HALE LAW LLC', index)[0]?.suggestedTag).toBe('firm_name')
  })

  it('scans a large document in bounded time', () => {
    // Every value against every line is O(values x lines), and both sides grow:
    // 2000 clients index ~10k values and a 20 MB body is tens of thousands of
    // paragraphs. Measured at seconds of CPU per upload before the pre-filter.
    const big = buildKnownValueIndex(
      Array.from({ length: 2000 }, (_, i) => ({
        value: `Firstname${i} Lastname${i}`,
        canonicalId: 'client_name',
      })),
    )
    const doc = Array.from({ length: 20_000 }, (_, i) => `Paragraph ${i} of ordinary prose.`).join('\n')
    const started = Date.now()
    expect(detectKnownValues(doc, big)).toEqual([])
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('returns nothing for a document that shares no data with the firm', () => {
    expect(detectKnownValues('An unrelated precedent from another state.', index)).toEqual([])
  })

  it('finds a value at the end of a sentence', () => {
    // Same pre-filter as the leftover scan; a trailing full stop must not hide
    // a case number from detection either.
    expect(detectKnownValues('Case No. TRC0000001A/B/C.', index).map((f) => f.literal)).toEqual([
      'TRC0000001A/B/C',
    ])
    const withEmail = buildKnownValueIndex([{ value: 'jordan.avery@example.com', canonicalId: 'client_email' }])
    expect(detectKnownValues('Write to jordan.avery@example.com.', withEmail)).toHaveLength(1)
  })
})

describe('findLeftoverClientText', () => {
  // WHY: this is the last look before a template is stored, and anything it
  // misses is printed into every document generated from that template: for
  // every other client. The bias is therefore the reverse of detection's: a
  // false positive costs the reviewer a click, a miss discloses a client. Up to
  // a point: a warning that fires on every upload is clicked through, which
  // protects nobody, so the surname rules below are about keeping it rare.
  const body = (text: string) => [{ part: 'body' as const, text }]
  // Stored and uploaded are the same text unless a test is about the difference.
  const scan = (text: string, values: KnownValue[] = FIRM) =>
    findLeftoverClientText(body(text), values, body(text))

  it('reports a client name that was left as plain text', () => {
    const left = scan('Defendant JORDAN AVERY appears.')
    expect(left).toEqual([
      expect.objectContaining({ literal: 'JORDAN AVERY', canonicalId: 'client_name', parts: ['body'] }),
    ])
  })

  it('says nothing about a name that was bracketed', () => {
    expect(scan('Defendant {client_name} appears.')).toEqual([])
  })

  it('catches a bare surname, which detection is not allowed to bracket', () => {
    const left = scan('Counsel met with Ms. Avery on Tuesday.')
    expect(left.map((l) => [l.literal, l.canonicalId])).toEqual([['Avery', 'client_last_name']])
  })

  it('reports nothing for a document that shares no data with the firm', () => {
    expect(scan('An unrelated precedent from another state.')).toEqual([])
  })

  it('ignores a surname with nothing tying it to the client', () => {
    // Across a whole book of business some client is surnamed Grant, Case or
    // Law, and a legal document capitalises all of those. Reporting every one
    // makes a warning that always fires: and one that always fires is
    // clicked through.
    expect(scan('The Avery standard applies here.')).toEqual([])
    expect(scan('Associate Client (Client)', [
      { value: 'Client', canonicalId: 'client_last_name', nameOnly: true, ofName: 'E2E Client' },
    ])).toEqual([])
  })

  it('reports a bare surname once the upload names that client in full', () => {
    // The full name was bracketed out of what is stored, so the upload is what
    // says whose document this is.
    const left = findLeftoverClientText(
      body('{client_name}\nAvery agreed to the terms.'),
      FIRM,
      body('Jordan Avery\nAvery agreed to the terms.'),
    )
    expect(left.map((l) => [l.literal, l.canonicalId])).toEqual([['Avery', 'client_last_name']])
  })

  it('still finds a value that ends a sentence', () => {
    // The cheap pre-filter tokenises on characters that include ".", so a
    // full stop used to glue itself to the last word and drop the value before
    // matching ran: a client's email at the end of a sentence, stored unseen.
    const values: KnownValue[] = [
      ...FIRM,
      { value: 'jordan.avery@example.com', canonicalId: 'client_email' },
      { value: '2024-CR-0012', canonicalId: 'case_number' },
    ]
    expect(scan('Email me at jordan.avery@example.com.', values).map((l) => l.canonicalId)).toEqual([
      'client_email',
    ])
    expect(scan('In case no. 2024-CR-0012.', values).map((l) => l.canonicalId)).toEqual(['case_number'])
    expect(scan('Signed by Mr. Avery.').map((l) => l.literal)).toEqual(['Avery'])
  })

  it('ties a surname to its client through a middle name or initial', () => {
    // Captions spell the client in full, often with a middle initial the
    // database does not store. Neither an exact full-name match nor a bare
    // "v. Avery" cue sees "v. JORDAN A. AVERY": the precedent passed clean.
    expect(scan('STATE OF OHIO v. JORDAN A. AVERY').map((l) => l.literal)).toEqual(['AVERY'])
    const left = findLeftoverClientText(
      body('Avery testified at the hearing.'),
      FIRM,
      body('JORDAN A. AVERY\nAvery testified at the hearing.'),
    )
    expect(left.map((l) => l.literal)).toEqual(['Avery'])
  })

  it('does not tie a surname to the client through someone else’s first name', () => {
    const left = findLeftoverClientText(
      body('Avery testified at the hearing.'),
      FIRM,
      body('Witness Dana Avery\nAvery testified at the hearing.'),
    )
    expect(left).toEqual([])
  })

  it('reports a surname in a caption', () => {
    expect(scan('State of Ohio v. Avery').map((l) => l.literal)).toEqual(['Avery'])
  })

  it('reports a case number, whichever case it belongs to', () => {
    const left = scan('Case No. TRC0000001A/B/C')
    expect(left.map((l) => l.canonicalId)).toEqual(['case_number'])
  })

  it('leaves the firm, the court and the judge alone: they belong in a template', () => {
    const text = 'Hale Law LLC\nIN THE EXAMPLE MUNICIPAL COURT\nJudge Holloway'
    expect(scan(text)).toEqual([])
  })

  it('does not mistake a lower-case prose word for a client surname', () => {
    // A client surnamed May would otherwise flag every "may" in every upload,
    // and a warning that always fires is a warning nobody reads.
    const values: KnownValue[] = [{ value: 'May', canonicalId: 'client_last_name', nameOnly: true }]
    expect(scan('The court may continue the hearing.', values)).toEqual([])
    expect(scan('Client: Mr. May', values)).toHaveLength(1)
  })

  it('still reports a client surname that is also a judge’s', () => {
    // The shared index lets the first writer win, and the loader lists judges
    // before clients: so the surname would be indexed as the judge's and
    // silently dropped from a scan that only reports client values.
    const values: KnownValue[] = [
      { value: 'Holloway', canonicalId: 'judge_name' },
      { value: 'Holloway', canonicalId: 'client_last_name', nameOnly: true },
    ]
    expect(scan('Ms. Holloway', values).map((l) => l.canonicalId)).toEqual([
      'client_last_name',
    ])
  })

  it('reports the full name once rather than the surname inside it again', () => {
    const left = scan('Jordan Avery')
    expect(left.map((l) => l.literal)).toEqual(['Jordan Avery'])
  })

  it('names every part a value sits in and counts across them', () => {
    // A caption in the header is outside what detection can bracket, so the
    // reviewer has to be told where to go and fix it by hand.
    const parts = [
      { part: 'body' as const, text: 'Jordan Avery' },
      { part: 'header' as const, text: 'State v. Jordan Avery' },
      { part: 'header' as const, text: 'Jordan Avery' },
    ]
    const left = findLeftoverClientText(parts, FIRM, parts)
    expect(left).toEqual([
      expect.objectContaining({ literal: 'Jordan Avery', occurrences: 3, parts: ['body', 'header'] }),
    ])
  })
})

describe('buildKnownValueIndex', () => {
  it('drops blank values and dedupes spellings that normalize the same', () => {
    const built = buildKnownValueIndex([
      { value: '  ', canonicalId: 'firm_name' },
      { value: 'Hale Law LLC', canonicalId: 'firm_name' },
      { value: 'HALE LAW LLC', canonicalId: 'client_organization' },
    ])
    expect(built.entries).toHaveLength(1)
    expect(built.entries[0].canonicalId).toBe('firm_name')
  })
})
