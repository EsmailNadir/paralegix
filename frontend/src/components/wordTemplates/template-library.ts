// The template library's list logic, kept apart from its rendering: how
// same-name templates stack, how the stacks sort, and what a search matches.
//
// The library is flat (it has no folders), so a name is
// how staff tell templates apart. Uploads with a taken name now offer Replace
// or Save as a copy; templates that already share a name, typically ones that
// lived in different folders, stack into one card, newest first.

import { fieldLabel } from '@/lib/wordTemplates/vocabulary'
import type { WordTemplate as Template } from '@/types/wordTemplate'

export type TemplateSort = 'recent' | 'name'

export type TemplateGroup = { key: string; name: string; versions: Template[] }

const createdTime = (t: Template) => (t.createdAt ? new Date(t.createdAt).getTime() : 0)

/** Same-named templates (ignoring case and outer spaces) collapse into one stack, newest first. */
export function groupTemplatesByName(list: Template[], sort: TemplateSort): TemplateGroup[] {
  const byKey = new Map<string, TemplateGroup>()
  for (const t of list) {
    const key = t.name.trim().toLowerCase()
    const group = byKey.get(key)
    if (group) group.versions.push(t)
    else byKey.set(key, { key, name: t.name.trim(), versions: [t] })
  }
  const groups = [...byKey.values()]
  groups.forEach((g) => g.versions.sort((a, b) => createdTime(b) - createdTime(a)))
  if (sort === 'name') {
    groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  } else {
    groups.sort((a, b) => createdTime(b.versions[0]) - createdTime(a.versions[0]))
  }
  return groups
}

/**
 * Name, field tags and field names all match, so "judge" finds a template
 * whose field is judge_name_caps. `query` is already trimmed and lowercased.
 */
export function matchesTemplateSearch(template: Template, query: string): boolean {
  return [template.name, ...template.fields, ...template.fields.map(fieldLabel)].some((value) =>
    value.toLowerCase().includes(query),
  )
}

export function kindLabel(type: Template['type']): string {
  if (type === 'docx') return 'Word'
  if (type === 'pdf-form') return 'PDF form'
  return 'Web'
}
