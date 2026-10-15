import { detectHighlightedFields } from '../../../src/modules/wordTemplates/lib/auto-bracket/detect-highlights'

// Tests for highlight-driven detection (layer 2).
//
// WHY (Rule 9): staff mark what must change by highlighting it, and that mark
// is the only signal that names things no regex can: a client, a court, a
// judge, a hearing type, a sentence of reasoning. The behaviour that matters is
// therefore not "finds highlighted text" but "proposes the span the author
// drew", which means coalescing the runs Word split it into and stopping at the
// edge of the highlight. A span that is half a name is worse than no proposal:
// it brackets "JORDAN " and leaves "AVERY," in every future filing.

const rPr = (highlight: string | null) =>
  `<w:rPr><w:sz w:val="24"/>${highlight ? `<w:highlight w:val="${highlight}"/>` : ''}</w:rPr>`

const run = (text: string, highlight: string | null = null) =>
  `<w:r>${rPr(highlight)}<w:t xml:space="preserve">${text}</w:t></w:r>`

const para = (...runs: string[]) => `<w:p>${runs.join('')}</w:p>`

describe('detectHighlightedFields', () => {
  it('coalesces the runs Word split a highlighted phrase across', () => {
    // Verbatim shape from the firm's Motion to Continue, where the defendant's
    // name arrives as two sibling runs.
    const xml = para(run('JORDAN ', 'yellow'), run('AVERY,', 'yellow'), run('   Defendant'))
    const [f] = detectHighlightedFields(xml)
    expect(f.literal).toBe('JORDAN AVERY')
    expect(f.category).toBe('highlight')
  })

  it('stops the span at the first printing run that is not highlighted', () => {
    const xml = para(run('JUDGE: '), run('HOLLOWAY', 'yellow'), run(' presiding'))
    expect(detectHighlightedFields(xml).map((f) => f.literal)).toEqual(['HOLLOWAY'])
  })

  it('does not let a run with no text of its own break a span', () => {
    // Word interleaves empty runs (bookmarks, proofErr wrappers) freely.
    const xml = para(run('EXAMPLE ', 'yellow'), '<w:r><w:rPr/></w:r>', run('MUNICIPAL COURT', 'yellow'))
    expect(detectHighlightedFields(xml)[0].literal).toBe('EXAMPLE MUNICIPAL COURT')
  })

  it('never spans a paragraph boundary', () => {
    const xml = para(run('Pre-Trial', 'yellow')) + para(run('Continuance', 'yellow'))
    expect(detectHighlightedFields(xml).map((f) => f.literal)).toEqual(['Pre-Trial', 'Continuance'])
  })

  it('trims punctuation the highlight swallowed at either end', () => {
    const xml = para(run(' Pre-Trial: ', 'yellow'))
    expect(detectHighlightedFields(xml)[0].literal).toBe('Pre-Trial')
  })

  it('ignores an explicit "no highlight" run', () => {
    expect(detectHighlightedFields(para(run('plain', 'none')))).toEqual([])
  })

  it('ignores highlighting with nothing to fill in', () => {
    expect(detectHighlightedFields(para(run('   ', 'yellow')))).toEqual([])
    expect(detectHighlightedFields(para(run('\u2014', 'yellow')))).toEqual([])
  })

  it('ignores a span that is already a placeholder', () => {
    // Re-uploading an already-bracketed template must not nest {tag} in {tag}.
    expect(detectHighlightedFields(para(run('{client_name}', 'yellow')))).toEqual([])
  })

  it('ignores a highlighted block of prose: that is a section marked for review', () => {
    const long = 'x'.repeat(240)
    expect(detectHighlightedFields(para(run(long, 'yellow')))).toEqual([])
  })

  it('names a highlighted value by its own shape when it has one', () => {
    const xml = para(run('March 4, 2026', 'yellow')) + para(run('$2,500.00', 'yellow'))
    expect(detectHighlightedFields(xml).map((f) => f.suggestedTag)).toEqual(['date_1', 'amount_1'])
  })

  it('promotes a highlighted case number to its canonical id', () => {
    const [f] = detectHighlightedFields(para(run('CP-24-CR-001234', 'yellow')))
    expect(f).toMatchObject({ suggestedTag: 'case_number', canonical: true })
  })

  it('gives a shapeless value a generic, indexed slot for the reviewer to name', () => {
    const xml = para(run('HOLLOWAY', 'yellow')) + para(run('JORDAN AVERY', 'yellow'))
    const fields = detectHighlightedFields(xml)
    expect(fields.map((f) => f.suggestedTag)).toEqual(['field_1', 'field_2'])
    expect(fields.every((f) => f.canonical === false)).toBe(true)
  })

  it('dedupes a value highlighted in two places and counts both', () => {
    const xml = para(run('JORDAN AVERY', 'yellow')) + para(run('JORDAN AVERY', 'yellow'))
    const fields = detectHighlightedFields(xml)
    expect(fields).toHaveLength(1)
    expect(fields[0].occurrences).toBe(2)
  })

  it('carries the whole paragraph as context so the reviewer can read the slot', () => {
    const xml = para(run('JUDGE: '), run('HOLLOWAY', 'yellow'))
    expect(detectHighlightedFields(xml)[0].contextSnippet).toBe('JUDGE: HOLLOWAY')
  })
})
