// Matching server-supplied autofill values onto a template's own tag names.
//
// WHY this exists:
//   buildCaseDocumentContext (case-autofill.ts) emits canonical snake_case keys
//  : `client_name`, `case_number`, `hearing_date`. A template author types
//   whatever reads well in Word: `{Client Name}`, `{CASE_NUMBER}`,
//   `{hearing date}`. An exact-string lookup drops every one of those, so the
//   fill modal opens blank on data the server fetched milliseconds earlier.
//
//   These resolvers try the tag verbatim, then its normalized form, then the
//   canonical vocabulary id it maps to: the same three-step match the modal's
//   client-side alias layer already performs, so both autofill layers agree on
//   what a tag means.
//
// Only NON-EMPTY values are returned. FillTemplateModal treats a supplied value
// as user-provided and protects it from the alias heuristics, so an empty
// string would mask a value the heuristics could have filled: see the note at
// the top of case-autofill.ts.
//
// Pure module: no React, no I/O: importable from a client component and from a
// unit test alike.

import { normalizeFieldKey, resolveCanonicalId } from './vocabulary'
import type { TemplateRepeater } from './types'

/**
 * Build a lookup over `source` that tolerates the spelling a template author
 * used for a tag. Returns '' when nothing matches or the match is empty.
 *
 * The index is built once per source so resolving a whole field list stays
 * linear rather than rescanning the context for every tag.
 */
export function createFieldValueResolver(
  source: Readonly<Record<string, string>> | undefined,
): (field: string) => string {
  const byNormalized = new Map<string, string>()
  const byCanonical = new Map<string, string>()

  for (const [key, value] of Object.entries(source ?? {})) {
    if (!value) continue
    const normalized = normalizeFieldKey(key)
    // First writer wins, so an exact canonical key is never shadowed by a later
    // key that happens to normalize onto the same slot.
    if (normalized && !byNormalized.has(normalized)) byNormalized.set(normalized, value)
    const canonical = resolveCanonicalId(key)
    if (canonical && !byCanonical.has(canonical)) byCanonical.set(canonical, value)
  }

  return (field: string): string => {
    const exact = source?.[field]
    if (exact) return exact

    const normalized = normalizeFieldKey(field)
    const normalizedMatch = normalized ? byNormalized.get(normalized) : undefined
    if (normalizedMatch) return normalizedMatch

    const canonical = resolveCanonicalId(field)
    return (canonical ? byCanonical.get(canonical) : undefined) ?? ''
  }
}

/**
 * Resolve a template's field names against a supplied value map, keyed by the
 * template's OWN names. Fields with nothing to fill are omitted entirely, so the
 * result doubles as "which fields the server actually provided".
 */
export function resolveProvidedValues(
  fields: readonly string[],
  source?: Readonly<Record<string, string>>,
): Record<string, string> {
  const resolve = createFieldValueResolver(source)
  const provided: Record<string, string> = {}
  for (const field of fields) {
    const value = resolve(field)
    if (value) provided[field] = value
  }
  return provided
}

/**
 * Find a repeater's rows in a supplied context, tolerating the spelling of the
 * loop tag itself (`{#Payment Schedule}` vs the context's `payment_schedule`).
 * Returns null when the context has no rows for that loop.
 */
export function resolveProvidedRows(
  name: string,
  source: Readonly<Record<string, Record<string, string>[]>> | undefined,
): Record<string, string>[] | null {
  if (!source) return null

  const exact = source[name]
  if (exact && exact.length > 0) return exact

  const target = normalizeFieldKey(name)
  if (!target) return null
  for (const [key, rows] of Object.entries(source)) {
    if (rows && rows.length > 0 && normalizeFieldKey(key) === target) return rows
  }
  return null
}

// ── Seeding the fill modal's initial state ────────────────────────────────

/** Every field present and blank: the shape the modal's inputs bind to. */
export function createEmptyValues(fields: string[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field, '']))
}

/** One repeater row, optionally seeded from a source keyed by the loop's own fields. */
export function createEmptyRepeaterRow(
  fields: string[],
  source?: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field, source?.[field] ?? '']))
}

/** Every loop present with one blank row. */
export function createEmptyRepeaterValues(
  repeaters: TemplateRepeater[],
): Record<string, Record<string, string>[]> {
  return Object.fromEntries(
    repeaters.map((repeater) => [repeater.name, [createEmptyRepeaterRow(repeater.fields)]]),
  )
}

/**
 * Seed the modal's field values from a supplied context (the case-page
 * Documents tab's server-assembled values, or a restored fill draft), matched
 * onto the template's own tag names.
 */
export function normalizeInitialValues(
  fields: string[],
  initialValues?: Record<string, string>,
): Record<string, string> {
  return { ...createEmptyValues(fields), ...resolveProvidedValues(fields, initialValues) }
}

/** The repeater equivalent: loop names and row cells both matched by spelling. */
export function normalizeInitialRepeaterValues(
  repeaters: TemplateRepeater[],
  initialRepeaterValues?: Record<string, Record<string, string>[]>,
): Record<string, Record<string, string>[]> {
  const defaults = createEmptyRepeaterValues(repeaters)
  if (!initialRepeaterValues) return defaults

  for (const repeater of repeaters) {
    const restoredRows = resolveProvidedRows(repeater.name, initialRepeaterValues)
    if (!restoredRows) continue
    defaults[repeater.name] = restoredRows.map((row) =>
      createEmptyRepeaterRow(repeater.fields, resolveProvidedValues(repeater.fields, row)),
    )
  }

  return defaults
}
