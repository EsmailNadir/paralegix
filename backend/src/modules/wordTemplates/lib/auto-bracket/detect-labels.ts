// Layer 5 of variable detection: the labels a legal caption prints next to its
// own values.
//
// WHY, given layer 4 already names things:
//   Known-value matching only works on documents about THIS firm's records. A
//   precedent borrowed from another attorney, a form pulled off a court website,
//   or a case whose judge nobody entered yet all match nothing: and those are
//   exactly the documents someone uploads to turn into a template. A caption,
//   though, labels itself in the same handful of ways no matter whose document
//   it is: "Case No.", "JUDGE:", "IN THE … COURT", "Dear …,". Reading the label
//   yields the canonical id directly.
//
// WHY the catalog is deliberately short:
//   Every pattern here captures a VALUE from prose, which is the highest-risk
//   thing this file does: capture too much and the template brackets half a
//   sentence. Only forms that are near-universal in an Ohio filing earn a slot.
//   Anything more speculative belongs in the review step, where a human is
//   already looking.
//
// Pure module: no I/O, no docx, no React: unit-tested directly on strings.

import type { DetectedField } from './detect-patterns'

type LabelPattern = {
  /** Canonical vocabulary id the captured value fills. */
  canonicalId: string
  /** Must expose the value as capture group 1. */
  regex: RegExp
}

// HORIZONTAL whitespace only. documentText() joins paragraphs with "\n", and
// \s matches a newline: so a label pattern written with \s walks straight off
// the end of its own line into the next paragraph. On a court caption that is
// not hypothetical: a "JUDGE: <surname>" line followed by the defendant's name on
// the next line was captured as one value spanning both, which then failed
// the whole upload because no such text exists as a standalone value.
const H = '[ \\t]'

// A name-shaped run: capitalised words, optional honorific/initials, at most
// four tokens. Bounded on purpose: an unbounded run swallows the rest of the
// sentence the moment a line starts with a capital.
const NAME = `(?:(?:Mr|Ms|Mrs|Dr|Hon)\\.${H}*)?[A-Z][A-Za-z.'’-]*(?:${H}+[A-Z][A-Za-z.'’-]*){0,3}`

const LABEL_PATTERNS: LabelPattern[] = [
  // "Case No.: TRC0000001A/B/C": the value runs to whitespace, so a suffixed
  // multi-count number survives whole where the shape pattern's \b does not.
  { canonicalId: 'case_number', regex: new RegExp(`\\bCase${H}*(?:No\\.?|Number|#)${H}*:?${H}*(\\S+)`, 'gi') },

  // "JUDGE: HOLLOWAY": the colon is what makes this safe; "the judge found"
  // has no colon and is not matched. Both spellings are listed rather than using
  // the /i flag, which would also case-fold NAME and let the capture start on a
  // lowercase word ("judge: the following").
  { canonicalId: 'judge_name', regex: new RegExp(`\\b(?:JUDGE|Judge)${H}*:${H}*(${NAME}|[A-Z][A-Z'’-]+)`, 'g') },

  // "IN THE EXAMPLE MUNICIPAL COURT": the caption's first line, shouted.
  { canonicalId: 'court_name', regex: new RegExp(`\\bIN${H}+THE${H}+([A-Z][A-Z ]*?COURT(?:${H}+OF${H}+[A-Z ]+?)?)${H}*$`, 'gm') },

  // "Dear Ms. Avery,": a letter's salutation, closed by its own punctuation.
  { canonicalId: 'client_salutation', regex: new RegExp(`\\bDear${H}+(${NAME})${H}*[,:]`, 'g') },

  // "Re: State v. Avery": the matter line of a letter.
  { canonicalId: 'case_name', regex: /^\s*Re\s*:\s*(.+?)\s*$/gim },
]

// Bounds on a captured value. Below the floor it is punctuation; above the
// ceiling it is a sentence that happened to start after a label.
const MIN_VALUE_CHARS = 2
const MAX_VALUE_CHARS = 60

/**
 * Propose the value beside each caption label the catalog recognises.
 *
 * A capture that is already a placeholder or an authored `[MARKER]` is skipped:
 * those layers own that span, and re-proposing it would put one source span
 * under two edits, which the commit path rejects.
 */
export function detectLabelledFields(documentPlainText: string): DetectedField[] {
  const byLiteral = new Map<string, { field: DetectedField; count: number; at: number }>()

  for (const { canonicalId, regex } of LABEL_PATTERNS) {
    regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(documentPlainText)) !== null) {
      if (m[0].length === 0) {
        regex.lastIndex += 1
        continue
      }
      const value = m[1]?.trim().replace(/[.,;:]+$/, '')
      if (!value || value.length < MIN_VALUE_CHARS || value.length > MAX_VALUE_CHARS) continue
      if (!/[a-z0-9]/i.test(value)) continue
      if (/[{}[\]]/.test(value)) continue

      const existing = byLiteral.get(value)
      if (existing) {
        existing.count += 1
        continue
      }
      // The line the value sits on, for the review list.
      const lineStart = documentPlainText.lastIndexOf('\n', m.index) + 1
      const lineEnd = documentPlainText.indexOf('\n', m.index)
      const line = documentPlainText.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)

      byLiteral.set(value, {
        count: 1,
        at: m.index,
        field: {
          kind: 'literal',
          literal: value,
          category: 'label',
          suggestedTag: canonicalId,
          canonical: true,
          occurrences: 1,
          contextSnippet: line.trim(),
        },
      })
    }
  }

  // Document order, not catalog order: the review list reads top-to-bottom
  // alongside the document, and the patterns are applied one at a time.
  return [...byLiteral.values()]
    .sort((a, b) => a.at - b.at)
    .map(({ field, count }) => ({ ...field, occurrences: count }))
}
