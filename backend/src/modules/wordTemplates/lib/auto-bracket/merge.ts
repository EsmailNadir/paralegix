// Collapsing the detection layers into one proposal per source span.
//
// WHY this is its own module rather than three lines in the server action:
//   Getting it wrong does not produce a wrong-looking review list: it produces
//   an upload that fails outright, or a field with a worse name than the
//   detector actually knew. Both have already happened here, so the rule lives
//   somewhere it can be tested directly.
//
// THE CONSTRAINT it exists to satisfy: commitDocxBrackets rejects two literal
// edits that share a `find` (the first would consume every occurrence and the
// rest would silently no-op), and a literal CONTAINED in an earlier one is
// already rewritten by that edit, so its own op could only miss: which fails
// the whole upload with "Couldn't bracket …".
//
// THE RULE: the strongest layer wins the SPAN, the most confident layer wins the
// NAME. Those are different questions and were conflated at first. A highlight
// round "HOLLOWAY" is the better span (the author drew it), but the caption
// label "JUDGE: HOLLOWAY" is the one that knows the span is a judge. Dropping
// the label outright cost the name and left the field as field_1.
//
// Pure module: no I/O, no docx, no React.

import type { DetectedField } from './detect-patterns'

/**
 * Merge the layers' proposals, strongest first, into one edit per source span.
 *
 * `layers` is ordered by signal strength: the caller decides that order, and
 * this preserves it.
 */
export function mergeLiteralProposals(
  layers: ReadonlyArray<readonly DetectedField[]>,
): DetectedField[] {
  const kept: DetectedField[] = []

  for (const field of layers.flat()) {
    const exact = kept.find((k) => k.literal === field.literal)
    if (exact) {
      // Same span, seen twice. Keep the stronger layer's proposal but take the
      // canonical name if this is where it came from.
      if (!exact.canonical && field.canonical) {
        exact.suggestedTag = field.suggestedTag
        exact.canonical = true
      }
      exact.occurrences = Math.max(exact.occurrences, field.occurrences)
      continue
    }

    // Contained in a span already being rewritten: its own edit could only
    // miss. The containing span is the one the author marked, so it stands.
    if (kept.some((k) => k.literal.includes(field.literal))) continue

    kept.push({ ...field })
  }

  return kept
}
