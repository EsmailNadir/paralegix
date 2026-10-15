// Template-field proposals: the union the review step renders, and the naming
// / context heuristics for Word form fields.
//
// WHY the two proposal kinds differ:
//   A 'literal' proposal (../auto-bracket/detect-patterns) is a value SHAPE found
//   in text: it knows the exact string to search for, so its edit is a
//   find-and-replace. A 'formField' proposal is an empty Word control; there is
//   nothing to search for, so its edit is bound to the field's ORDINAL, and the
//   server re-derives the byte range from its own scan. Keeping both in one
//   discriminated union lets a single review modal handle a document that has
//   both (a partially filled form).
//
// WHY context has to look at NEIGHBOURING paragraphs:
//   On the federal AO Pro Se 1 complaint the containing paragraph's own text is
//   EMPTY for 70 of 73 fields: the form is one 116-row layout table and the
//   labels live in adjacent cells, which are separate <w:p> elements. Reading
//   only the field's own paragraph would show the reviewer nothing at all.
//
// Pure module: no React, no server-only, no I/O: imported by both the server
// action and the 'use client' review component (same rationale as ../vocabulary).

import { paragraphSpans, paragraphText } from '../placeholderize-core'
import { normalizeFieldKey, resolveCanonicalId } from '../vocabulary'
import type { DetectedField } from './detect-patterns'
import type { DetectedRepeater } from './detect-repeaters'
import type { FormFieldControl, FormFieldSpan } from './form-fields'
import type { PdfFormField, PdfFormFieldKind } from '../pdf-form'

export type DetectedFormField = {
  kind: 'formField'
  /** Ordinal among form fields in document order: how an edit binds to a field. */
  index: number
  /** Word's own name ("Text12"), re-checked server-side to catch a stale scan. */
  wordName: string | null
  control: FormFieldControl
  suggestedTag: string
  canonical: boolean
  /** Document text immediately before the blank, for the reviewer to read. */
  contextBefore: string
  /** Document text immediately after the blank. */
  contextAfter: string
}

/**
 * A fillable-PDF (AcroForm) field.
 *
 * Unlike a Word form field, this one arrives with MEANING: the PDF names its
 * fields "Plaintiff Full Name", "Case Number". So there is no context to derive
 * (the name is the context), and the binding key is the name itself rather
 * than an ordinal, because the commit renames fields in the stored file.
 */
export type DetectedPdfField = {
  kind: 'pdfField'
  /** The field's current name inside the PDF: how the edit binds to it. */
  pdfName: string
  control: PdfFormFieldKind
  suggestedTag: string
  canonical: boolean
}

export type TemplateFieldProposal =
  | DetectedField
  | DetectedFormField
  | DetectedPdfField
  | DetectedRepeater

export type BracketEdit =
  | { kind: 'literal'; find: string; tag: string }
  // A schedule of rows becomes a docxtemplater loop. Bound to the block's
  // ORDINAL, never to text or offsets: the server re-derives the block from its
  // own scan, exactly as a formField edit re-derives its byte range.
  | { kind: 'repeater'; index: number; name: string; fields: string[] }
  | { kind: 'formField'; index: number; wordName: string | null; tag: string }
  | { kind: 'pdfField'; pdfName: string; tag: string }

// How much surrounding text to show. Before matters more than after: a form
// labels its blank on the left ("Bar Number ____"), so that is where meaning is.
const CONTEXT_BEFORE_CHARS = 90
const CONTEXT_AFTER_CHARS = 60
// Paragraphs that actually CONTRIBUTE text. Noise must not count against this
// budget: a court caption's ")" rail is 15 consecutive paragraphs with no
// words, and charging them would exhaust the budget before reaching the label:
// which is how the AO form's Plaintiff(s) blank ended up with no forward
// context at all.
const CONTEXT_PARAGRAPH_LIMIT = 8
// How far to LOOK for those paragraphs, so a long noise run still terminates.
const CONTEXT_SCAN_LIMIT = 40
// Longer than this is prose, not a label: the AO form's claim sections run to
// whole sentences, which would yield names like
// `write_a_short_and_plain_statement_of_the`.
const MAX_LABEL_CHARS = 48

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
// A paragraph with no letter or digit carries no meaning for a reviewer. The
// AO form's caption column is 15 consecutive paragraphs of a bare ")".
const hasWords = (s: string) => /[a-z0-9]/i.test(s)

/** Index of the paragraph containing `offset` (binary search over ascending spans). */
function paragraphAt(spans: ReadonlyArray<{ start: number; end: number }>, offset: number): number {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offset < spans[mid].start) hi = mid - 1
    else if (offset >= spans[mid].end) lo = mid + 1
    else return mid
  }
  return -1
}

// Strip a leading section marker: "A. ", "1) ", "b. ": enumeration, not a name.
const SECTION_MARKER_RE = /^[A-Za-z0-9]{1,3}[.)]\s*/

function labelToKey(label: string): string | null {
  const cleaned = collapse(label).replace(SECTION_MARKER_RE, '')
  if (!cleaned || cleaned.length > MAX_LABEL_CHARS) return null
  const key = normalizeFieldKey(cleaned)
  return key || null
}

/**
 * Build a review proposal per form field: what sits around the blank, and a
 * suggested name derived from the nearest label.
 *
 * The name is a SUGGESTION only. A resolving slug is deliberately NOT promoted
 * to its canonical id (street_address -> client_address): on a legal filing the
 * plaintiff is often not the client, and silently rebinding one to the other is
 * exactly the quiet substitution Rule 12 forbids. The review UI already shows
 * live whether a name will auto-fill.
 */
export function buildFormFieldProposals(
  documentXml: string,
  spans: readonly FormFieldSpan[],
): DetectedFormField[] {
  const paras = paragraphSpans(documentXml)
  const texts = paras.map((p) => collapse(paragraphText(p.xml)))
  const used = new Map<string, number>()

  return spans.map((span) => {
    const pi = paragraphAt(paras, span.start)
    const own = pi === -1 ? { before: '', after: '' } : {
      before: collapse(paragraphText(documentXml.slice(paras[pi].start, span.start))),
      after: collapse(paragraphText(documentXml.slice(span.end, paras[pi].end))),
    }

    // Widen into neighbouring paragraphs until there is enough to read.
    const parts: string[] = own.before ? [own.before] : []
    for (
      let i = pi - 1, taken = 0, seen = 0;
      i >= 0 && taken < CONTEXT_PARAGRAPH_LIMIT && seen < CONTEXT_SCAN_LIMIT;
      i--, seen++
    ) {
      if (parts.join(' ').length >= CONTEXT_BEFORE_CHARS) break
      if (texts[i] && hasWords(texts[i])) {
        parts.unshift(texts[i])
        taken += 1
      }
    }
    const contextBefore = parts.join(' ').slice(-CONTEXT_BEFORE_CHARS)

    const after: string[] = own.after ? [own.after] : []
    for (
      let i = pi + 1, taken = 0, seen = 0;
      i < paras.length && taken < CONTEXT_PARAGRAPH_LIMIT && seen < CONTEXT_SCAN_LIMIT;
      i++, seen++
    ) {
      if (after.join(' ').length >= CONTEXT_AFTER_CHARS) break
      if (texts[i] && hasWords(texts[i])) {
        after.push(texts[i])
        taken += 1
      }
    }
    const contextAfter = after.join(' ').slice(0, CONTEXT_AFTER_CHARS)

    // A text field is labelled on its LEFT ("Bar Number ____"); a checkbox is
    // labelled on its RIGHT ("[ ] Yes"). Verified against the AO form.
    const nearest = span.control === 'checkbox'
      ? own.after || after.find((t) => hasWords(t)) || ''
      : own.before || [...parts].reverse().find((t) => hasWords(t)) || ''

    const base = labelToKey(nearest)
    let suggestedTag = base
      ? span.control === 'checkbox' ? `check_${base}` : base
      : `field_${span.index + 1}`

    const seen = used.get(suggestedTag)
    if (seen) {
      used.set(suggestedTag, seen + 1)
      suggestedTag = `${suggestedTag}_${seen + 1}`
    } else {
      used.set(suggestedTag, 1)
    }

    return {
      kind: 'formField' as const,
      index: span.index,
      wordName: span.name,
      control: span.control,
      suggestedTag,
      canonical: resolveCanonicalId(suggestedTag) !== null,
      contextBefore,
      contextAfter,
    }
  })
}


/**
 * Turn a PDF's AcroForm fields into review proposals.
 *
 * The suggested name is the field's own name, normalised: `Plaintiff Full
 * Name` -> `plaintiff_full_name`: because whoever built the form already did
 * the naming work. That is why a fillable PDF is the easy case and a Word form
 * (Text1…Text69) is the hard one.
 *
 * As with the Word path, a name that RESOLVES to a canonical id is not silently
 * promoted to it; `canonical` just reports whether it will auto-fill, and the
 * review UI shows that live.
 */
export function buildPdfFieldProposals(fields: readonly PdfFormField[]): DetectedPdfField[] {
  const used = new Map<string, number>()

  return fields.map((f, i) => {
    let suggestedTag = normalizeFieldKey(f.name) || `field_${i + 1}`
    const seen = used.get(suggestedTag)
    if (seen) {
      used.set(suggestedTag, seen + 1)
      suggestedTag = `${suggestedTag}_${seen + 1}`
    } else {
      used.set(suggestedTag, 1)
    }

    return {
      kind: 'pdfField' as const,
      pdfName: f.name,
      control: f.kind,
      suggestedTag,
      canonical: resolveCanonicalId(suggestedTag) !== null,
    }
  })
}
