import { detectLabelledFields } from '../../../src/modules/wordTemplates/lib/auto-bracket/detect-labels'

// Tests for caption-label detection (layer 5).
//
// WHY (Rule 9): this is the only layer that names a caption on a document the
// firm has no records for: a borrowed precedent, a form off a court website.
// It is also the riskiest, because every pattern captures a VALUE out of prose:
// a capture that runs long brackets half a sentence into the template, and that
// bracket is then in every filing made from it. The bounded-capture tests below
// are the ones that keep that from happening.

describe('detectLabelledFields', () => {
  it('reads the case number beside its label, suffix and all', () => {
    // The shape detector's \b cannot hold "TRC0000001A/B/C" together; the label
    // can, because the value simply runs to whitespace.
    const [f] = detectLabelledFields('Case No.: TRC0000001A/B/C')
    expect(f).toMatchObject({ literal: 'TRC0000001A/B/C', suggestedTag: 'case_number', canonical: true })
  })

  it('accepts the spellings a caption actually uses', () => {
    for (const label of ['Case No. X1234', 'Case Number X1234', 'Case #X1234', 'case no: X1234']) {
      expect(detectLabelledFields(label)[0]?.literal).toBe('X1234')
    }
  })

  it('reads the judge from a labelled caption line', () => {
    const [f] = detectLabelledFields('VS                    :        JUDGE: HOLLOWAY')
    expect(f).toMatchObject({ literal: 'HOLLOWAY', suggestedTag: 'judge_name' })
  })

  it('requires the colon, so prose about a judge is not captured', () => {
    expect(detectLabelledFields('The judge found otherwise at the hearing.')).toEqual([])
  })

  it('reads the court from the caption’s first line', () => {
    const [f] = detectLabelledFields('IN THE EXAMPLE MUNICIPAL COURT\nState of Ohio,')
    expect(f).toMatchObject({ literal: 'EXAMPLE MUNICIPAL COURT', suggestedTag: 'court_name' })
  })

  it('reads a letter’s salutation', () => {
    const [f] = detectLabelledFields('Dear Ms. Avery,\nThis letter confirms')
    expect(f).toMatchObject({ literal: 'Ms. Avery', suggestedTag: 'client_salutation' })
  })

  it('stops a name capture at four words rather than running into the sentence', () => {
    const [f] = detectLabelledFields('Dear Ms. Avery, This letter confirms that our office will')
    expect(f.literal).toBe('Ms. Avery')
  })

  it('reads the matter line of a letter', () => {
    const [f] = detectLabelledFields('Re: State v. Avery\nDear Ms. Avery,')
    expect(f.literal).toBe('State v. Avery')
  })

  it('skips a value that is already a placeholder or an authored blank', () => {
    // Those layers own the span; proposing it twice puts one source under two
    // edits, which the commit path rejects.
    expect(detectLabelledFields('Case No.: {case_number}')).toEqual([])
    expect(detectLabelledFields('Judge: [JUDGE NAME]')).toEqual([])
  })

  it('drops a capture too long to be a caption value', () => {
    expect(detectLabelledFields(`Re: ${'x'.repeat(80)}`)).toEqual([])
  })

  it('counts a value labelled in more than one place', () => {
    const fields = detectLabelledFields('Case No. X1234\nfoo\nCase No. X1234')
    expect(fields).toHaveLength(1)
    expect(fields[0].occurrences).toBe(2)
  })

  it('never lets a capture run off the end of its own line', () => {
    // documentText() joins paragraphs with "\n" and \s matches a newline, so a
    // pattern written with \s walks into the next paragraph. On a real caption
    // this captured "HOLLOWAY JORDAN AVERY" as one value, which then
    // failed the whole upload: no such text exists as a standalone value.
    const caption = 'JUDGE: HOLLOWAY\nJORDAN AVERY,   Defendant'
    expect(detectLabelledFields(caption)[0].literal).toBe('HOLLOWAY')
  })

  it('does not let a salutation or a case number cross a line break either', () => {
    expect(detectLabelledFields('Dear Ms. Avery\nJORDAN AVERY,')[0]?.literal).toBeUndefined()
    expect(detectLabelledFields('Case No.\nTRC0000001')).toEqual([])
  })

  it('returns nothing for a document with no caption labels', () => {
    expect(detectLabelledFields('A plain letter with no caption at all.')).toEqual([])
  })
})
