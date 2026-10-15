// Layer 4 of variable detection: recognise the firm's own data inside the
// document.
//
// WHY this layer exists:
//   The layers above find SPANS. They cannot say what a span means. A highlight
//   round a judge's surname proposes a field and then has to call it field_3,
//   because no amount of text analysis turns a surname into `judge_name`. But
//   the portal already holds the answer: that string is the judge on a case in
//   this firm's own database. Matching the document against known values is the
//   only deterministic way to arrive at a CANONICAL id, and a canonical id is
//   the difference between a field someone retypes every time and one the case
//   fills automatically.
//
// TWO JOBS, deliberately separated:
//   1. NAMING: upgrade a span another layer already proposed. Safe: the field
//      exists either way, and the worst case is a name the reviewer edits.
//   2. DETECTION: propose a span nothing else marked. Riskier: a false
//      positive brackets prose. Only values that can carry their own weight are
//      allowed to do this (see isDetectable), and a value can be barred from it
//      outright: a bare surname may name "Ms. Avery" but must never go
//      hunting for "Avery" in a sentence.
//
// Precedent documents from outside the firm match nothing here, which is
// correct and expected: this layer adds names when the data is there and stays
// silent when it is not.
//
// Pure module: the caller supplies the values (see ../firm-known-values), so
// this has no I/O and is unit-tested directly.

import { normalizeFieldKey } from '../vocabulary'
import type { DetectedField } from './detect-patterns'

export type KnownValue = {
  /** The value as it is stored: "Jordan Avery", "TRC0000001A/B/C". */
  value: string
  /** The vocabulary id it fills: client_name, case_number, judge_name, firm_phone. */
  canonicalId: string
  /**
   * Bars this value from job 2 even when it would otherwise qualify. Set for
   * values DERIVED from a record rather than stored on it: a surname split out
   * of a full name: where a loose match in prose is a real risk.
   */
  nameOnly?: boolean
  /**
   * For a derived surname, the full name it was split from. Lets the leftover
   * scan tell "this client's surname" from the same word meaning something else.
   */
  ofName?: string
}

export type KnownValueIndex = {
  /** Longest first, so the most specific match wins. */
  readonly entries: ReadonlyArray<KnownValue & { normalized: string; detectable: boolean }>
}

// How much of a span a known value must cover before it may name the whole
// thing. "IN THE EXAMPLE MUNICIPAL COURT" is 77% "Example Municipal Court" and
// is plainly about the court; a 10% match would be naming a paragraph after one
// word inside it.
const MIN_NAMING_COVERAGE = 0.4

/**
 * May this value go looking for itself in the document?
 *
 * A short single word is the dangerous case: a client legitimately named "Ohio"
 * or a case styled "State" would bracket ordinary prose in every filing. Two
 * words, or one long one, is enough to be specific.
 */
function isDetectable(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 4) return false
  return trimmed.split(/\s+/).length >= 2 || trimmed.length >= 8
}

export function buildKnownValueIndex(values: readonly KnownValue[]): KnownValueIndex {
  const seen = new Set<string>()
  const entries: Array<KnownValue & { normalized: string; detectable: boolean }> = []

  for (const v of values) {
    const value = v.value?.trim()
    if (!value) continue
    const normalized = normalizeFieldKey(value)
    if (!normalized) continue
    // First writer wins: the loader lists values strongest-first, so a name
    // stored on a record is never shadowed by one derived from it.
    const key = `${normalized}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      ...v,
      value,
      normalized,
      detectable: !v.nameOnly && isDetectable(value),
    })
  }

  entries.sort((a, b) => b.value.length - a.value.length)
  return { entries }
}

// Whole-word containment over normalized (snake_case) strings: every token is
// separated by "_", so a boundary test is a substring test with "_" fences.
function containsToken(haystack: string, needle: string): boolean {
  if (haystack === needle) return true
  return `_${haystack}_`.includes(`_${needle}_`)
}

/**
 * The canonical id this literal represents, or null.
 *
 * Exact first, then containment above the coverage floor: so a span the author
 * drew around a known value ("Jordan Avery (Client)") still resolves.
 */
export function resolveKnownValue(literal: string, index: KnownValueIndex): string | null {
  const normalized = normalizeFieldKey(literal)
  if (!normalized) return null

  for (const entry of index.entries) {
    if (entry.normalized === normalized) return entry.canonicalId
  }
  for (const entry of index.entries) {
    if (!containsToken(normalized, entry.normalized)) continue
    if (entry.value.length / literal.trim().length < MIN_NAMING_COVERAGE) continue
    return entry.canonicalId
  }
  return null
}

/**
 * Job 1: re-name proposals another layer found, where the firm's data says
 * what they are.
 *
 * A proposal that is ALREADY canonical is left alone: a detected case number
 * named case_number by its own pattern gains nothing from being renamed, and
 * silently re-pointing a field at a different vocabulary id is exactly the quiet
 * substitution Rule 12 forbids.
 */
export function nameWithKnownValues(
  fields: readonly DetectedField[],
  index: KnownValueIndex,
): DetectedField[] {
  return fields.map((f) => {
    if (f.canonical) return f
    const canonicalId = resolveKnownValue(f.literal, index)
    if (!canonicalId) return f
    return { ...f, suggestedTag: canonicalId, canonical: true }
  })
}

/**
 * Job 2: find known values the other layers did not mark.
 *
 * Matching is case-insensitive because a caption shouts the name the database
 * stores in title case, but the proposal carries the document's OWN casing: the
 * bracket edit is a literal find-and-replace, so "JORDAN AVERY" has to be
 * offered exactly as the document spells it.
 */
export function detectKnownValues(
  documentPlainText: string,
  index: KnownValueIndex,
): DetectedField[] {
  return matchEntries(
    documentPlainText,
    index.entries.filter((entry) => entry.detectable),
  )
}

type IndexEntry = KnownValueIndex['entries'][number]

// Every occurrence of the given entries in the text, one field per spelling.
// `accept` lets a caller veto a match after the fact (see findLeftoverClientText).
function matchEntries(
  documentPlainText: string,
  entries: readonly IndexEntry[],
  accept: (entry: IndexEntry, literal: string, before: string) => boolean = () => true,
): DetectedField[] {
  const lines = documentPlainText.split('\n')
  const byLiteral = new Map<string, { field: DetectedField; count: number }>()

  // Scanning every known value against every line is O(values x lines), and both
  // sides grow: a firm with 2000 clients indexes ~10k values, and a 20 MB
  // document body (MAX_DOCX_XML_BYTES) is tens of thousands of paragraphs.
  // Measured, that pairing costs seconds of CPU on one upload.
  //
  // So take one pass over the document's own words first and keep only the
  // values that could possibly match. A value whose FIRST word is absent from
  // the document cannot occur in it, and on real data almost none of the book of
  // business is mentioned in any one filing.
  //
  // Punctuation is trimmed off both ends of a token on BOTH sides: "." belongs
  // inside an email or a case number, but a full stop after one would otherwise
  // glue itself on ("…@example.com.") and hide the value from the match.
  const words = new Set(
    (documentPlainText.toLowerCase().match(/[a-z0-9@._+-]+/g) ?? []).map(trimToken),
  )
  const candidates = entries.filter((entry) => {
    const firstWord = entry.value.toLowerCase().match(/[a-z0-9@._+-]+/)?.[0]
    const key = firstWord === undefined ? '' : trimToken(firstWord)
    return key === '' || words.has(key)
  })
  if (candidates.length === 0) return []

  lines.forEach((line) => {
    const haystack = line.toLowerCase()
    // Longest-first with range claiming, so a case number is never re-proposed
    // as the shorter client reference inside it.
    const claimed: Array<[number, number]> = []

    for (const entry of candidates) {
      const needle = entry.value.toLowerCase()
      let from = 0
      for (;;) {
        const at = haystack.indexOf(needle, from)
        if (at === -1) break
        const end = at + needle.length
        from = at + 1
        if (!isWordBounded(line, at, end)) continue
        if (claimed.some(([s, e]) => at < e && end > s)) continue
        const literal = line.slice(at, end)
        if (!accept(entry, literal, line.slice(0, at))) continue
        claimed.push([at, end])

        const existing = byLiteral.get(literal)
        if (existing) {
          existing.count += 1
          continue
        }
        byLiteral.set(literal, {
          count: 1,
          field: {
            kind: 'literal',
            literal,
            category: 'known',
            suggestedTag: entry.canonicalId,
            canonical: true,
            occurrences: 1,
            contextSnippet: line.trim(),
          },
        })
      }
    }
  })

  return [...byLiteral.values()].map(({ field, count }) => ({ ...field, occurrences: count }))
}

// ── Leftover client text ─────────────────────────────────────────────────────
// The last check before a template is stored. Whatever is still plain text in
// it goes out in EVERY document generated from it, whichever client that is
// for: so a client's name left behind in a precedent is a disclosure, not a
// cosmetic miss.
//
// This is detection's job 2 run with the opposite bias. Detection must not
// bracket a bare surname in prose, because a bad bracket is permanent. Here a
// hit only produces a warning the reviewer can dismiss, so a false positive
// costs a click and a miss costs a filing: surnames and short values are in.

/**
 * The ids that identify a client or their matter. The firm's own letterhead and
 * the court belong in a template; these never do.
 *
 * client_organization is left out on purpose: it is often an employer or a
 * public body ("City of Columbus") that appears in filings for reasons that
 * have nothing to do with the client, so it would warn on documents it does not
 * disclose anything in.
 */
const CLIENT_TEXT_IDS = new Set([
  'client_name',
  'client_last_name',
  'client_email',
  'client_phone',
  'case_number',
])

/**
 * Which part of the document a leftover sits in, so the reviewer can find it.
 * The last three are not on the page but ship in the file all the same:
 * tracked deletions, field codes and the document's properties.
 */
export type LeftoverPart =
  | 'body'
  | 'header'
  | 'footer'
  | 'footnote'
  | 'comment'
  | 'deleted'
  | 'field'
  | 'properties'

export type LeftoverClientText = {
  /** As the document spells it. */
  literal: string
  canonicalId: string
  occurrences: number
  /** The line the first occurrence sits in. */
  contextSnippet: string
  parts: LeftoverPart[]
}

// A single alphabetic word is where a client's value collides with ordinary
// prose: a client surnamed May, Will or Young. Names are capitalised in a
// document and prose words mostly are not, so require the capital. Emails,
// phone numbers and case numbers are not words and are matched as they are.
const SINGLE_WORD_RE = /^[\p{L}'’-]+$/u
const STARTS_UPPER_RE = /^\p{Lu}/u

// A capital is not enough for a bare SURNAME. Across a whole book of business
// some client is surnamed Grant, Case, Street or Law, and a legal document
// capitalises all of those: so a capital-only rule warns on nearly every
// upload, and a warning that always fires is clicked through, which is the
// same as no warning. A surname counts only when something ties it to a
// person: a title or a caption's "v." before it, or that client's name in full
// somewhere in the upload (the precedent is about them, so "Vantress" in the
// prose is theirs). "In full" allows a middle name or initial the database
// does not store, and so does the caption cue: "v. JORDAN A. AVERY".
const PERSON_CUE_RE =
  /(?:\b(?:Mr|Mrs|Ms|Miss|Mx|Dr)\.?\s+|\bvs?\.\s+(?:[\p{L}'’-]+\.?\s+){0,2})$/iu

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** "Jordan Avery", "JORDAN A. AVERY" and "Jordan Allen Avery" all name Jordan Avery. */
function namesInFull(text: string, fullName: string, surname: string): boolean {
  const first = fullName.trim().split(/\s+/)[0]
  if (!first || first.toLowerCase() === surname.toLowerCase()) return false
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(first)}\\s+(?:[\\p{L}'’-]+\\.?\\s+){0,2}${escapeRegExp(surname)}(?![\\p{L}\\p{N}])`,
    'iu',
  ).test(text)
}

type TextPart = { part: LeftoverPart; text: string }

/**
 * Firm client values still present as plain text in the parts being stored.
 *
 * `uploaded` is the document as it arrived. It is only read to see which
 * clients the document is about, because their full names have usually been
 * bracketed out of `stored` by now.
 *
 * Takes the raw values rather than a prebuilt index because the index dedupes
 * on first writer: a client surname that equals a judge's would be indexed as
 * the judge and never reported here.
 */
export function findLeftoverClientText(
  stored: readonly TextPart[],
  values: readonly KnownValue[],
  uploaded: readonly TextPart[],
): LeftoverClientText[] {
  const clientValues = values.filter(
    (v) => CLIENT_TEXT_IDS.has(v.canonicalId) && v.value.trim().length >= 3,
  )
  const index = buildKnownValueIndex(clientValues)
  if (index.entries.length === 0) return []

  // Every client a surname could belong to: several can share one.
  const fullNamesBySurname = new Map<string, string[]>()
  for (const v of clientValues) {
    if (!v.nameOnly || !v.ofName) continue
    const key = normalizeFieldKey(v.value)
    fullNamesBySurname.set(key, [...(fullNamesBySurname.get(key) ?? []), v.ofName])
  }
  // Decided lazily and once per surname: only the few surnames that actually
  // occur in the stored text are ever looked up in the upload.
  const uploadedText = uploaded.map((p) => p.text).join('\n')
  const anchored = new Map<string, boolean>()
  const isAnchored = (entry: IndexEntry) => {
    let hit = anchored.get(entry.normalized)
    if (hit === undefined) {
      hit = (fullNamesBySurname.get(entry.normalized) ?? []).some((full) =>
        namesInFull(uploadedText, full, entry.value),
      )
      anchored.set(entry.normalized, hit)
    }
    return hit
  }

  const accept = (entry: IndexEntry, literal: string, before: string) => {
    if (SINGLE_WORD_RE.test(entry.value) && !STARTS_UPPER_RE.test(literal)) return false
    if (!entry.nameOnly) return true
    return PERSON_CUE_RE.test(before) || isAnchored(entry)
  }

  const byLiteral = new Map<string, LeftoverClientText>()
  for (const { part, text } of stored) {
    for (const hit of matchEntries(text, index.entries, accept)) {
      const existing = byLiteral.get(hit.literal)
      if (existing) {
        existing.occurrences += hit.occurrences
        if (!existing.parts.includes(part)) existing.parts.push(part)
        continue
      }
      byLiteral.set(hit.literal, {
        literal: hit.literal,
        canonicalId: hit.suggestedTag,
        occurrences: hit.occurrences,
        contextSnippet: hit.contextSnippet,
        parts: [part],
      })
    }
  }
  return [...byLiteral.values()]
}

const trimToken = (token: string) => token.replace(/^[._+-]+|[._+-]+$/g, '')

const ALNUM_RE = /[A-Za-z0-9]/

function isWordBounded(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : ''
  const after = end < text.length ? text[end] : ''
  return !(before && ALNUM_RE.test(before)) && !(after && ALNUM_RE.test(after))
}
