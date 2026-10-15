import { mergeLiteralProposals } from '../../../src/modules/wordTemplates/lib/auto-bracket/merge'
import type { DetectedField } from '../../../src/modules/wordTemplates/lib/auto-bracket/detect-patterns'

// Tests for collapsing the detection layers (see ../merge for the rule).
//
// WHY (Rule 9): this is where composition goes wrong, and both of its failure
// modes have already been observed. Emit two edits for one span and
// commitDocxBrackets fails the entire upload; drop the wrong duplicate and the
// field keeps a generic name and silently stops auto-filling. Neither is
// visible in a proposal list that merely looks plausible.

const f = (literal: string, over: Partial<DetectedField> = {}): DetectedField => ({
  kind: 'literal',
  literal,
  category: 'highlight',
  suggestedTag: 'field_1',
  canonical: false,
  occurrences: 1,
  contextSnippet: literal,
  ...over,
})

describe('mergeLiteralProposals', () => {
  it('keeps one edit per source span', () => {
    const merged = mergeLiteralProposals([[f('HOLLOWAY')], [f('HOLLOWAY')]])
    expect(merged).toHaveLength(1)
  })

  it('takes the span from the stronger layer and the name from the confident one', () => {
    // The author highlighted "HOLLOWAY"; the caption label is what knows it
    // is a judge. Dropping the label outright left the field as field_1.
    const merged = mergeLiteralProposals([
      [f('HOLLOWAY')],
      [f('HOLLOWAY', { category: 'label', suggestedTag: 'judge_name', canonical: true })],
    ])
    expect(merged[0]).toMatchObject({
      category: 'highlight',
      suggestedTag: 'judge_name',
      canonical: true,
    })
  })

  it('does not let a weaker layer re-point an already canonical name', () => {
    const merged = mergeLiteralProposals([
      [f('X1234', { suggestedTag: 'case_number', canonical: true })],
      [f('X1234', { suggestedTag: 'client_name', canonical: true })],
    ])
    expect(merged[0].suggestedTag).toBe('case_number')
  })

  it('drops a literal contained in a span already being rewritten', () => {
    // The containing span's edit rewrites this text, so the inner op could only
    // miss: and a miss fails the whole upload.
    const merged = mergeLiteralProposals([
      [f('March 4, 2026, at 8:00 a.m.')],
      [f('March 4, 2026', { category: 'date' })],
    ])
    expect(merged.map((m) => m.literal)).toEqual(['March 4, 2026, at 8:00 a.m.'])
  })

  it('keeps two different spans that happen to resolve to the same field', () => {
    // A caption and a certificate of service both name the court. Duplicate
    // TAGS are legitimate; duplicate SOURCES are not.
    const merged = mergeLiteralProposals([
      [f('[COURT NAME]', { suggestedTag: 'court_name', canonical: true })],
      [f('EXAMPLE MUNICIPAL COURT', { suggestedTag: 'court_name', canonical: true })],
    ])
    expect(merged).toHaveLength(2)
  })

  it('preserves layer order, so the review list reads strongest first', () => {
    const merged = mergeLiteralProposals([[f('a')], [f('b')], [f('c')]])
    expect(merged.map((m) => m.literal)).toEqual(['a', 'b', 'c'])
  })

  it('keeps the higher occurrence count when layers disagree', () => {
    const merged = mergeLiteralProposals([
      [f('X1234', { occurrences: 1 })],
      [f('X1234', { occurrences: 3 })],
    ])
    expect(merged[0].occurrences).toBe(3)
  })

  it('never mutates the proposals it was handed', () => {
    const original = f('HOLLOWAY')
    mergeLiteralProposals([
      [original],
      [f('HOLLOWAY', { suggestedTag: 'judge_name', canonical: true })],
    ])
    expect(original).toMatchObject({ suggestedTag: 'field_1', canonical: false })
  })
})
