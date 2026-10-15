// Layer 2 of variable detection: the firm's own yellow-highlight convention.
//
// WHY this is a signal at all:
//   Staff mark the parts of a precedent document that must change by
//   highlighting them, then hand the file to the next person. The repo already
//   knew this: stripHighlights() in ../placeholderize-core says "the source
//   docs use yellow highlight as a manual 'replace me' marker": but nothing
//   ever read it, so the detector threw away the most reliable statement of
//   intent in the document.
//
// WHY value shapes could not cover it:
//   A highlight names things no regex can. On the firm's own Motion to Continue
//   the highlighted spans are the court's caption line, a multi-count case
//   number, the judge, the defendant's name, the hearing type, the continuance
//   reason, and the service recipient. A person's name has no shape; neither
//   does a court, a judge, a hearing type or a sentence of prose. Every one of
//   those was missed.
//
// WHY spans, not runs:
//   Word splits a highlighted phrase across runs for reasons of its own:
//   a defendant's name arrives as "JORDAN " + "AVERY," in two sibling runs.
//   Proposing each run separately would offer half a name. Consecutive
//   highlighted runs are therefore coalesced into one span, and a run that
//   contributes no text (a tab, a bookmark wrapper) neither joins nor breaks it.
//
// Scope: word/document.xml only, matching openDocxBody() in the templates
// actions: the same scope as the form-field scanner.
//
// Pure module: no I/O, no docx, no React: unit-tested directly on XML strings.

import { paragraphSpans, paragraphText } from '../placeholderize-core'
import { detectFields, type DetectedField } from './detect-patterns'

const RUN_RE = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g
// `w:val="none"` is Word's explicit "no highlight": it appears when someone
// clears highlighting from part of a run's formatting, and it is not a marker.
const HIGHLIGHT_RE = /<w:highlight\s[^>]*w:val="(?!none")[^"]*"/

// A highlighted span longer than this is a highlighted PAGE, not a field:
// someone marked a whole section for review. Generous on purpose: the Motion to
// Continue's continuance reason is a 73-character sentence and is a real field.
const MAX_SPAN_CHARS = 200

// Punctuation a highlight routinely swallows at either end ("JORDAN AVERY,",
// "Pre-Trial:"). Trimmed so the tag replaces the value and leaves the sentence's
// own punctuation in the document.
const EDGE_PUNCTUATION = /^[\s,.;:\u2014\u2013-]+|[\s,.;:\u2014\u2013-]+$/g

const hasContent = (s: string) => /[a-z0-9]/i.test(s)

type RawSpan = { text: string; order: number; context: string }

/**
 * Coalesced highlighted text spans, in document order, with the paragraph each
 * one sits in for context.
 */
function scanHighlightSpans(documentXml: string): RawSpan[] {
  const out: RawSpan[] = []
  let order = 0

  for (const para of paragraphSpans(documentXml)) {
    const context = paragraphText(para.xml).replace(/\s+/g, ' ').trim()
    let open: string[] | null = null

    const flush = () => {
      if (!open) return
      const text = open.join('').replace(EDGE_PUNCTUATION, '')
      open = null
      if (!hasContent(text) || text.length > MAX_SPAN_CHARS) return
      // A span that already holds a placeholder has been bracketed before:
      // re-proposing it would nest {tag} inside {tag}.
      if (text.includes('{') || text.includes('}')) return
      out.push({ text, order: order++, context })
    }

    for (const run of para.xml.match(RUN_RE) ?? []) {
      const text = paragraphText(run)
      if (HIGHLIGHT_RE.test(run)) {
        open = open ?? []
        open.push(text)
      } else if (text.length > 0) {
        // Only a run that actually prints something breaks the span.
        flush()
      }
    }
    flush()
  }

  return out
}

/**
 * Name a highlighted span.
 *
 * The span is a VALUE ("HOLLOWAY"), so unlike a `[LABEL]` marker it cannot
 * name itself. Two sources, in order:
 *   1. its own value shape, when it has one: a highlighted date is date_1, the
 *      same name the shape detector would have given it;
 *   2. otherwise a generic slot, because the honest answer is "this is a
 *      variable and a human has to say what it means". Guessing from nearby
 *      prose produced names like `now_comes_the_undersigned` on real filings.
 *
 * Deriving a canonical id from surrounding labels is layer 5's job and is
 * deliberately not attempted here.
 */
function nameFor(span: RawSpan, counters: Map<string, number>): { tag: string; shape?: DetectedField } {
  const [shape] = detectFields(span.text)
  const stem = shape && shape.literal === span.text ? shape.suggestedTag.replace(/_\d+$/, '') : 'field'

  // A canonical shape id (case_number) is a name, not a stem: don't index it.
  if (shape && shape.canonical && shape.literal === span.text) {
    return { tag: shape.suggestedTag, shape }
  }

  const n = (counters.get(stem) ?? 0) + 1
  counters.set(stem, n)
  return { tag: `${stem}_${n}`, shape }
}

/**
 * Propose a field for every highlighted span in the document.
 *
 * Emitted as ordinary `literal` proposals so the commit path needs no new edit
 * kind: a span is exact source text, and bracketing it is the same
 * find-and-replace the shape detector's hits already use.
 */
export function detectHighlightedFields(documentXml: string): DetectedField[] {
  const spans = scanHighlightSpans(documentXml)

  // Dedup by text: the same highlighted value in the caption and the signature
  // block is one field, matching the shape detector's contract.
  const byText = new Map<string, { span: RawSpan; count: number }>()
  for (const span of spans) {
    const existing = byText.get(span.text)
    if (existing) existing.count += 1
    else byText.set(span.text, { span, count: 1 })
  }

  const counters = new Map<string, number>()
  return [...byText.values()]
    .sort((a, b) => a.span.order - b.span.order)
    .map(({ span, count }) => {
      const { tag, shape } = nameFor(span, counters)
      return {
        kind: 'literal' as const,
        literal: span.text,
        category: 'highlight' as const,
        suggestedTag: tag,
        // Canonical only when the tag IS the shape's canonical name. A span
        // holding more than one value is field_N whatever its shape says.
        canonical: !!shape?.canonical && tag === shape.suggestedTag,
        occurrences: count,
        contextSnippet: span.context,
      }
    })
}
