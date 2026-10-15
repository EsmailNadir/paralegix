// Turns a template's raw placeholder list into something a person can read at
// a glance: fields grouped by what fills them, labelled the way every other
// Templates screen labels them (fieldLabel), and a count of how many the user
// will actually have to type.
//
// The canonical fill vocabulary decides it. A field that resolves to a
// vocabulary entry is auto-fillable (the CANONICAL_VOCABULARY contract in
// vocabulary.ts: every entry is backed by a fill layer, and the fill modal
// runs both); one that resolves to nothing is a custom field the user types.
// A field inside a section ("payment_plan.initial_payment_amount") resolves by
// its own name, the way fieldLabel reads it.

import { fieldLabel, resolveCanonicalId, vocabularyEntry, type VocabularyGroup } from '@/lib/wordTemplates/vocabulary'

export type FieldGroupKey = 'client' | 'case' | 'court' | 'firm' | 'dates' | 'billing' | 'custom'

export const FIELD_GROUPS: Record<FieldGroupKey, { label: string; hint: string }> = {
  firm: { label: 'Firm', hint: 'Always filled from firm settings' },
  case: { label: 'Matter', hint: 'Filled from the matter you pick' },
  court: { label: 'Court', hint: 'Filled from the matter’s court' },
  client: { label: 'Client', hint: 'Filled from the matter’s client' },
  dates: { label: 'Dates', hint: 'Today, hearings, and deadlines' },
  billing: { label: 'Billing', hint: 'Filled from the matter’s invoices' },
  custom: { label: 'You type', hint: 'Not in the vocabulary, so typed when filling' },
}

/** Display order: what fills itself first, what you type last. */
export const GROUP_ORDER: FieldGroupKey[] = ['firm', 'case', 'court', 'client', 'dates', 'billing', 'custom']

const GROUP_MAP: Record<VocabularyGroup, FieldGroupKey> = {
  client: 'client',
  case: 'case',
  court: 'court',
  firm: 'firm',
  date: 'dates',
  hearing: 'dates',
  deadline: 'dates',
  billing: 'billing',
}

export type SummarizedField = {
  /** What a person reads, e.g. "Judge name (UPPERCASE)". */
  label: string
  /** Every tag in the template that reads as this label, e.g. `judge_name_caps`. */
  tags: string[]
  group: FieldGroupKey
  auto: boolean
}

export type FieldSummary = {
  total: number
  autoCount: number
  typeCount: number
  fields: SummarizedField[]
  groups: { key: FieldGroupKey; count: number; fields: SummarizedField[] }[]
}

const leafOf = (tag: string) => (tag.includes('.') ? tag.slice(tag.lastIndexOf('.') + 1) : tag)

// Templates rarely change between renders, and the library summarizes every
// one of them for the header, so a summary is computed once per field list.
const cache = new Map<string, FieldSummary>()

export function summarizeFields(rawFields: string[]): FieldSummary {
  const key = rawFields.join('\u0000')
  const hit = cache.get(key)
  if (hit) return hit

  // One entry per label: a section's columns and an alias can repeat a field,
  // and a person should count it once.
  const byLabel = new Map<string, SummarizedField>()
  for (const tag of rawFields) {
    const label = fieldLabel(tag)
    const seen = byLabel.get(label)
    if (seen) {
      if (!seen.tags.includes(tag)) seen.tags.push(tag)
      continue
    }
    const id = resolveCanonicalId(leafOf(tag))
    const entry = id ? vocabularyEntry(id) : null
    byLabel.set(
      label,
      entry
        ? { label, tags: [tag], group: GROUP_MAP[entry.group], auto: true }
        : { label, tags: [tag], group: 'custom', auto: false },
    )
  }
  const fields = [...byLabel.values()]

  const groups = GROUP_ORDER.map((g) => {
    const inGroup = fields.filter((f) => f.group === g)
    return { key: g, count: inGroup.length, fields: inGroup }
  }).filter((g) => g.count > 0)

  const autoCount = fields.filter((f) => f.auto).length
  const summary: FieldSummary = {
    total: fields.length,
    autoCount,
    typeCount: fields.length - autoCount,
    fields,
    groups,
  }
  cache.set(key, summary)
  return summary
}
