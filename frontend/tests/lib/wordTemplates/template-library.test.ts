import { summarizeFields } from '@/components/wordTemplates/template-field-summary'
import { groupTemplatesByName, kindLabel, matchesTemplateSearch } from '@/components/wordTemplates/template-library'
import type { WordTemplate as Template } from '@/types/wordTemplate'

// The template library's reading of a template: which fields fill themselves
// and which someone types, how same-name templates stack, and what a search
// finds.
//
// WHY (Rule 9): "You'll type 2" is a promise to the person about to fill a
// court document. A field counted as auto-fill that the fill engine cannot
// fill comes out blank in a filing; one counted twice inflates the work. The
// stack and the search decide whether staff can find the right template in a
// library with no folders, where a name is how they tell templates apart.

const template = (over: Partial<Template> & { id: string; name: string }): Template => ({
  fields: [],
  folderId: null,
  createdAt: '2026-09-01T12:00:00Z',
  ...over,
})

describe('summarizeFields', () => {
  it('counts a vocabulary field as auto-fill and anything else as typed', () => {
    const s = summarizeFields(['client_name', 'judge_name_caps', 'motion_body'])
    expect(s.total).toBe(3)
    expect(s.autoCount).toBe(2)
    expect(s.typeCount).toBe(1)
    expect(s.fields.find((f) => f.tags.includes('motion_body'))).toMatchObject({ auto: false, group: 'custom' })
  })

  it('labels fields the way the rest of the Templates screens do', () => {
    const s = summarizeFields(['judge_name_caps', 'motion_body'])
    expect(s.fields.map((f) => f.label)).toEqual(['Judge name (UPPERCASE)', 'Motion Body'])
  })

  it('counts a field once when an alias or a repeat reads as the same label', () => {
    // `judge` is an alias of judge_name, so both read "Judge name".
    const s = summarizeFields(['judge_name', 'judge', 'judge_name'])
    expect(s.total).toBe(1)
    expect(s.fields[0].tags).toEqual(['judge_name', 'judge'])
  })

  it('resolves a field inside a section by its own name', () => {
    const s = summarizeFields(['payments.client_name'])
    expect(s.fields[0]).toMatchObject({ label: 'Client full name', auto: true, group: 'client' })
  })

  it('orders groups with what fills itself first and what you type last', () => {
    const s = summarizeFields(['motion_body', 'client_name', 'firm_name', 'court_name'])
    expect(s.groups.map((g) => g.key)).toEqual(['firm', 'court', 'client', 'custom'])
  })

  it('reports an empty template as nothing to fill', () => {
    expect(summarizeFields([])).toMatchObject({ total: 0, autoCount: 0, typeCount: 0, groups: [] })
  })
})

describe('groupTemplatesByName', () => {
  const list = [
    template({ id: 'a1', name: 'Motion to Continue', createdAt: '2026-09-01T00:00:00Z' }),
    template({ id: 'b', name: 'Engagement letter', createdAt: '2026-09-20T00:00:00Z' }),
    template({ id: 'a2', name: 'motion to continue ', createdAt: '2026-09-10T00:00:00Z' }),
  ]

  it('stacks templates that share a name, newest first, ignoring case and spacing', () => {
    const groups = groupTemplatesByName(list, 'recent')
    const motion = groups.find((g) => g.key === 'motion to continue')!
    expect(motion.versions.map((t) => t.id)).toEqual(['a2', 'a1'])
    expect(groups).toHaveLength(2)
  })

  it('sorts stacks by their newest template, or by name', () => {
    expect(groupTemplatesByName(list, 'recent').map((g) => g.key)).toEqual(['engagement letter', 'motion to continue'])
    expect(groupTemplatesByName(list, 'name').map((g) => g.key)).toEqual(['engagement letter', 'motion to continue'])
    const later = [...list, template({ id: 'c', name: 'Affidavit', createdAt: '2026-08-01T00:00:00Z' })]
    expect(groupTemplatesByName(later, 'name')[0].key).toBe('affidavit')
    expect(groupTemplatesByName(later, 'recent').at(-1)!.key).toBe('affidavit')
  })
})

describe('matchesTemplateSearch', () => {
  const t = template({ id: 'x', name: 'Notice of Appearance', fields: ['judge_name_caps', 'case_number'] })

  it('finds a template by its name', () => {
    expect(matchesTemplateSearch(t, 'appearance')).toBe(true)
  })

  it('finds a template by the readable name of a field, not only its tag', () => {
    expect(matchesTemplateSearch(t, 'judge name')).toBe(true)
    expect(matchesTemplateSearch(t, 'judge_name_caps')).toBe(true)
  })

  it('misses a template that has neither', () => {
    expect(matchesTemplateSearch(t, 'retainer')).toBe(false)
  })
})

describe('kindLabel', () => {
  it('names each template kind', () => {
    expect(kindLabel('docx')).toBe('Word')
    expect(kindLabel('pdf-form')).toBe('PDF form')
    expect(kindLabel('html')).toBe('Web')
    expect(kindLabel(undefined)).toBe('Web')
  })
})
