// Deterministic (non-AI) variable detection for template auto-bracketing.
//
// Given the plain text of an uploaded document (one paragraph per line, as
// produced by documentText() in ../placeholderize-core), find the spans a
// template author would want to turn into fillable placeholders.
//
// TWO KINDS OF SIGNAL, and the first one outranks the second:
//
//   1. AUTHORED MARKERS: `[COURT NAME]`, `[CLIENT NAME]`, `[CASE NO.]`. A blank
//      template says outright what goes where, and the label normalizes onto a
//      canonical fill id for free. This is intent, not inference.
//
//   2. VALUE SHAPES: dollar amounts, dates, case numbers, emails, phones,
//      ZIPs, found in a document someone already filled in.
//
//   Shapes alone were the whole detector, and that is why an UNFILLED template
//   came back almost empty: a blank has no shape to match. On the firm's
//   Demand for Discovery the shape pass found the filled-in firm phone, fax,
//   ZIP and email and missed every one of `[COURT NAME]`, `[CASE NO.]`,
//   `[JUDGE NAME]`, `[CLIENT NAME]`, `[METHOD OF FILING]`,
//   `[FILING EMAIL/ADDRESS]` and `[DATE]`.
//
// Shapes get high precision on the classes a pattern can name confidently (a
// case number is unambiguous), a canonical name when the words before the value
// identify it (see ./name-from-context), and category-generic names (amount_1,
// date_1) for the rest, renamed by the user in the review step. A marker keeps
// its own label, resolved to a canonical id when the vocabulary knows it.
//
// Pure module: no I/O, no docx, no React: unit-tested directly on strings.

import { normalizeFieldKey, resolveCanonicalId } from '../vocabulary'
import { nameFromContext, type ContextShape } from './name-from-context'

export type FieldCategory =
  // An authored `[LABEL]` blank: the firm's own marker, not a value shape.
  | 'marker'
  // A span the author highlighted as "replace me": see ./detect-highlights.
  | 'highlight'
  // Text that matches a value in the firm's own records: see ./known-values.
  | 'known'
  // The value beside a caption label ("JUDGE: …"): see ./detect-labels.
  | 'label'
  | 'case_number'
  | 'money'
  | 'date'
  | 'time'
  | 'email'
  | 'phone'
  | 'zip'

export type DetectedField = {
  // Discriminant: this proposal came from matching a value SHAPE in the text.
  // The sibling kind is 'formField' (see ./proposals): an empty Word form
  // control, which has no literal to search for.
  kind: 'literal'
  // Exact source text to bracket (the literal applyReplace will find).
  literal: string
  category: FieldCategory
  // The placeholder name proposed for the {tag}. A canonical fill id when the
  // category maps to one confidently (case_number) or the value's label names
  // one (flat_fee_amount); otherwise category-generic (amount_1, date_2) which
  // the review step lets the user rename.
  suggestedTag: string
  // True when suggestedTag is a canonical, auto-fillable vocabulary id.
  canonical: boolean
  // How many times the literal occurs across the whole document.
  occurrences: number
  // The paragraph the first occurrence sits in: shown in the review list.
  contextSnippet: string
}

// Ordered pattern catalog. Case numbers run first so a token like "TRC0000551"
// is claimed as a case number, never as a bare number by a later pattern.
// Each regex is global + anchored on word boundaries where practical.
const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)'

type PatternDef = {
  category: FieldCategory
  regex: RegExp
  // Canonical fill id this category maps to, when unambiguous.
  canonicalId?: string
  // Match-level veto, for classes whose precision cannot be expressed as a
  // regex. Returning true drops the hit AND leaves its characters unclaimed, so
  // a later pattern may still match inside the rejected span.
  reject?: (match: string) => boolean
}

// Bracketed editorial asides that are NOT blanks. A legal brief quotes with
// them constantly, and bracketing "[sic]" would put a {sic} tag in the middle
// of a quotation. Compared after normalizeFieldKey, so punctuation and case do
// not matter.
const EDITORIAL_MARKERS = new Set([
  'sic',
  'id',
  'supra',
  'infra',
  'emphasis_added',
  'emphasis_in_original',
  'emphasis_supplied',
  'citation_omitted',
  'citations_omitted',
  'internal_citation_omitted',
  'internal_citations_omitted',
  'internal_quotation_marks_omitted',
  'quotation_marks_omitted',
  'footnote_omitted',
  'footnotes_omitted',
  'alteration_in_original',
  'alterations_in_original',
  'brackets_in_original',
  'ellipsis_in_original',
  'cleaned_up',
])

// Is `[…]` an authored blank rather than an editorial aside or a citation?
//
// The costly error here is a false POSITIVE: a bracket inside quoted authority
// becomes a tag in the finished filing. Three guards, each earned from the
// firm's own documents:
//   - two letters minimum: kills the `[E]` in `"[E]vidence that would diminish
//     the credibility"`, which the Demand for Discovery quotes verbatim;
//   - short all-digit / all-roman tokens are enumeration (`[1]`, `[iii]`, `[IV]`).
//     Capped at 4 characters so a real label made only of roman letters
//     (`[CIVIL]`, `[CLI]`) is not swept up;
//   - the editorial stop-list above.
// A label longer than eight words is prose, not a blank.
function isEditorialBracket(match: string): boolean {
  const inner = match.slice(1, -1).trim()
  const letters = inner.replace(/[^A-Za-z]/g, '')
  if (letters.length < 2) return true
  if (/^[\divxlcdm]{1,4}$/i.test(inner)) return true
  if (inner.split(/\s+/).length > 8) return true
  return EDITORIAL_MARKERS.has(normalizeFieldKey(inner))
}

const PATTERNS: PatternDef[] = [
  // Authored `[LABEL]` blanks FIRST, so a marker that happens to contain a
  // value shape ("[HEARING DATE 03/04/2026]") is claimed whole rather than
  // shredded into a tag inside a leftover bracket.
  {
    category: 'marker',
    regex: /\[[^[\]\n]{2,60}\]/g,
    reject: isEditorialBracket,
  },

  // Case numbers: Ohio municipal/traffic (TRC/TRD/CRB + digits, or
  // 2-digit-year + letters + digits) and common-pleas CP-YY-XX-###### form.
  // Data-driven so new court formats are added here, not in the engine.
  { category: 'case_number', canonicalId: 'case_number',
    regex: /\bCP-\d{2}-[A-Z]{2}-\d{4,}\b/g },
  // The trailing group carries a multi-count suffix. "TRC0000001A/B/C" is one
  // number covering three counts, and a bare \b after the digits split it into
  // "TRC0000001" plus stray letters: so the firm's own Motion to Continue
  // detected no case number at all.
  { category: 'case_number', canonicalId: 'case_number',
    regex: /\b[A-Z]{2,4}\d{7,}(?:[A-Z](?:\/[A-Z])*)?\b/g },
  { category: 'case_number', canonicalId: 'case_number',
    regex: /\b\d{2}[A-Z]{2,4}\d{5,}(?:[A-Z](?:\/[A-Z])*)?\b/g },

  // Email (before phone/zip so an address isn't shredded into digit runs).
  { category: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },

  // Money.
  { category: 'money', regex: /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b|\$\s?\d+(?:\.\d{2})?/g },

  // Dates: long form, "Nth day of Month YYYY", numeric, and ISO.
  { category: 'date', regex: new RegExp(`\\b${MONTH}\\s+\\d{1,2},\\s*\\d{4}\\b`, 'g') },
  { category: 'date', regex: new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)\\s+day\\s+of\\s+${MONTH}\\s+\\d{4}\\b`, 'g') },
  { category: 'date', regex: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g },
  { category: 'date', regex: /\b\d{4}-\d{2}-\d{2}\b/g },

  // Times: "8:00 a.m.", "8:00 AM", "8:00". A hearing time is a variable on
  // every continuance, and it must run before the phone pattern so "8:00" is
  // never read as part of a digit run.
  { category: 'time', regex: /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]\.?\s?m\.?)?/gi },

  // US phone: (614) 555-1234 / 614-555-1234 / 614.555.1234.
  { category: 'phone', regex: /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g },

  // Unpunctuated 10-digit phone: "Phone 6145550142", exactly how the firm's
  // own letterhead came out of the generated Demand for Discovery. Runs after
  // the punctuated form so a formatted number is matched there first, and
  // before ZIP so it is never shredded into 5-digit runs.
  { category: 'phone', regex: /\b\d{10}\b/g },

  // ZIP: 5-digit or ZIP+4. High false-positive risk (any 5-digit number), so
  // it runs last and the review step is expected to prune it.
  { category: 'zip', regex: /\b\d{5}(?:-\d{4})?\b/g },
]

// A generic, unique tag name for a category occurrence, e.g. amount_1.
const CATEGORY_STEM: Record<FieldCategory, string> = {
  // Only reached when a marker's label normalizes to nothing ("[###]").
  marker: 'field',
  // Highlight spans are named by ./detect-highlights, never by this pass.
  highlight: 'field',
  // Known values are named by their canonical id, never by this pass.
  known: 'field',
  // Labelled values are named by their label, never by this pass.
  label: 'field',
  case_number: 'case_number',
  money: 'amount',
  date: 'date',
  time: 'time',
  email: 'email',
  phone: 'phone',
  zip: 'zip',
}

type RawHit = {
  literal: string
  category: FieldCategory
  canonicalId?: string
  line: string
  index: number
  // Offset of the hit within `line`: the words around it are its label.
  start: number
}

const CONTEXT_SHAPES: ReadonlySet<FieldCategory> = new Set<ContextShape>([
  'money', 'date', 'time', 'email', 'phone', 'zip',
])
const isContextShape = (c: FieldCategory): c is ContextShape => CONTEXT_SHAPES.has(c)

// The canonical id the words around this occurrence name, if any.
function contextName(hit: RawHit): string | null {
  if (!isContextShape(hit.category)) return null
  const end = hit.start + hit.literal.length
  return nameFromContext(hit.line.slice(0, hit.start), hit.category, hit.line.slice(end))
}

// The canonical id a marker's label or a pattern names outright. These never
// yield to a context name, which is the weaker signal.
function fixedCanonicalId(hit: RawHit): string | null {
  if (hit.category === 'marker') return resolveCanonicalId(hit.literal.slice(1, -1).trim())
  return hit.canonicalId && resolveCanonicalId(hit.canonicalId) ? hit.canonicalId : null
}

// Detects the value-shaped fields in a document's plain text (paragraph per
// line). Returns proposals in document order, deduplicated by literal.
/** One pattern hit, with where it sits: what ./detect-repeaters needs. */
export type LineHit = {
  literal: string
  category: FieldCategory
  canonicalId?: string
  start: number
  end: number
}

/**
 * Every value span in ONE line, in pattern-catalog order.
 *
 * Exported so the repeating-row detector reads the same catalog rather than
 * growing a second copy of it (Rule 7). Catalog order is preserved rather than
 * sorted by position, because that order is what gives detectFields its stable
 * amount_1 / date_2 numbering; a caller that needs positional order sorts.
 */
export function scanLine(line: string): LineHit[] {
  const hits: LineHit[] = []
  // Claimed character ranges so a later, broader pattern (zip) can't re-claim
  // characters already taken by a case number / phone / date.
  const claimed: Array<[number, number]> = []
  const overlaps = (s: number, e: number) => claimed.some(([cs, ce]) => s < ce && e > cs)

  for (const { category, regex, canonicalId, reject } of PATTERNS) {
    regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(line)) !== null) {
      const start = m.index
      const end = start + m[0].length
      if (m[0].length === 0) { regex.lastIndex += 1; continue }
      if (overlaps(start, end)) continue
      // Deliberately does NOT claim the span: a rejected bracket is ordinary
      // prose, and a value inside it ("[as of 03/04/2026]") is still fair game.
      if (reject?.(m[0])) continue
      claimed.push([start, end])
      hits.push({ literal: m[0], category, canonicalId, start, end })
    }
  }
  return hits
}

export function detectFields(documentPlainText: string): DetectedField[] {
  const lines = documentPlainText.split('\n')
  const raw: RawHit[] = []
  let globalOrder = 0

  lines.forEach((line) => {
    for (const hit of scanLine(line)) {
      raw.push({
        literal: hit.literal,
        category: hit.category,
        canonicalId: hit.canonicalId,
        line,
        index: globalOrder++,
        start: hit.start,
      })
    }
  })

  // Dedup by literal (first occurrence keeps its context + order), counting
  // total occurrences across the document. Every occurrence's context name is
  // kept, because one literal becomes one tag everywhere it appears.
  const byLiteral = new Map<string, { hit: RawHit; count: number; names: Set<string> }>()
  for (const hit of raw) {
    let entry = byLiteral.get(hit.literal)
    if (entry) entry.count += 1
    else byLiteral.set(hit.literal, (entry = { hit, count: 1, names: new Set() }))
    const name = contextName(hit)
    if (name) entry.names.add(name)
  }

  // Assign category-generic indices in document order for non-canonical fields.
  const categoryCounters: Partial<Record<FieldCategory, number>> = {}
  const ordered = [...byLiteral.values()].sort((a, b) => a.hit.index - b.hit.index)

  // A canonical name belongs to one value per document: two different amounts
  // both tagged flat_fee_amount would print the same figure twice. Ids a
  // marker or a pattern claims anywhere in the document are taken up front.
  const taken = new Set<string>()
  for (const { hit } of ordered) {
    const id = fixedCanonicalId(hit)
    if (id) taken.add(id)
  }

  return ordered.map(({ hit, count, names }) => {
    // Prefer the pattern's canonical id (case_number), then the one the value's
    // label names; fall back to a generic stem with a per-category index.
    let suggestedTag: string
    let canonical: boolean
    if (hit.category === 'marker') {
      // The label IS the name: "[CASE NO.]" resolves through the vocabulary's
      // aliases to case_number, so the field auto-fills without anyone renaming
      // it. A label the catalog does not know keeps its own slug
      // ("[METHOD OF FILING]" -> method_of_filing) and fills manually.
      const inner = hit.literal.slice(1, -1).trim()
      const resolved = resolveCanonicalId(inner)
      if (resolved) {
        suggestedTag = resolved
        canonical = true
      } else {
        const key = normalizeFieldKey(inner)
        const n = (categoryCounters.marker ?? 0) + 1
        categoryCounters.marker = n
        // A tag must satisfy PLACEHOLDER_NAME_RE on the way back in, which
        // forbids a leading digit ("[2ND HEARING]" -> 2nd_hearing).
        suggestedTag = !key ? `${CATEGORY_STEM.marker}_${n}` : /^\d/.test(key) ? `field_${key}` : key
        canonical = false
      }
    } else if (hit.canonicalId && resolveCanonicalId(hit.canonicalId)) {
      suggestedTag = hit.canonicalId
      canonical = true
    } else if (names.size === 1 && !taken.has([...names][0])) {
      // Its label names it ("a flat fee of $2,500.00" -> flat_fee_amount). Only
      // when every labelled occurrence agrees: two different names mean the
      // same text stands for two different values, and either name is a guess.
      suggestedTag = [...names][0]
      canonical = true
      taken.add(suggestedTag)
    } else {
      const n = (categoryCounters[hit.category] ?? 0) + 1
      categoryCounters[hit.category] = n
      suggestedTag = `${CATEGORY_STEM[hit.category]}_${n}`
      canonical = false
    }
    return {
      kind: 'literal' as const,
      literal: hit.literal,
      category: hit.category,
      suggestedTag,
      canonical,
      occurrences: count,
      contextSnippet: hit.line.trim(),
    }
  })
}
