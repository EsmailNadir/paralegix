// Word form-field (FORMTEXT / FORMCHECKBOX) scanning and rewriting.
//
// WHY this module exists:
//   The value detector in ./detect-patterns matches value SHAPES: money, dates,
//   case numbers: in a document someone already filled in. A blank court form
//   has no values: its blanks are empty Word form fields carrying no text at
//   all. On the federal AO Pro Se 1 complaint the detector finds exactly one
//   hit ($75,000, from the statutory jurisdiction threshold: a false positive
//   that must never be bracketed) and misses all 73 real blanks.
//
//   Those blanks do not need to be FOUND. They are <w:ffData> controls at known
//   positions, and this module enumerates them so the review step can ask a
//   human what each one means, then rewrites each into a {tag}. The result is an
//   ordinary native-docx template the existing docxtemplater fill path handles:
//   structure survives because the document is never rebuilt, only spliced.
//
// WHY a new primitive was needed:
//   Every replace path in ../placeholderize-core rewrites the inner text of a
//   <w:t> node. A form field is not text: it is a RANGE of sibling runs
//   (begin fldChar -> instrText -> separate -> result -> end fldChar) that has
//   to be removed wholesale and replaced by one new run. Nothing in the repo
//   could do that, and nothing could build a <w:r> from scratch.
//
// Scope: word/document.xml only, matching openDocxBody() in the templates
// actions. The AO form (and every seed template) has zero ffData in headers,
// footers or footnotes.
//
// Pure module: no I/O, no docx, no React: unit-tested directly on XML strings.

import { xmlEscape } from '../placeholderize-core'

export type FormFieldControl = 'text' | 'checkbox'

export type FormFieldSpan = {
  /** 0-based ordinal among form fields, in document order. */
  index: number
  /** Absolute offset of the `<w:r…>` that opens the field's begin run. */
  start: number
  /** Absolute offset just past the field, including its trailing bookmarkEnd. */
  end: number
  /** `<w:name w:val="Text12"/>`: null when Word omitted it. */
  name: string | null
  control: FormFieldControl
  /** The begin run's `<w:rPr>…</w:rPr>`, copied verbatim, or ''. */
  runProps: string
}

/**
 * Thrown when the document's field structure is not the shape this module
 * knows how to rewrite. Deliberately fatal: a half-rewritten legal document is
 * far worse than a refused upload (Rule 12).
 */
export class FormFieldScanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FormFieldScanError'
  }
}

// Matches an opening <w:r>: NOT <w:rPr>, because the optional group requires
// whitespace or an immediate '>' after "<w:r".
const RUN_OPEN_RE = /<w:r(?:\s[^>]*)?>/g
const FLD_CHAR_RE = /<w:fldChar\b([^>]*?)(\/)?>/g
const RUN_CLOSE = '</w:r>'

function lastRunOpenBefore(xml: string, limit: number): number {
  RUN_OPEN_RE.lastIndex = 0
  let found = -1
  let m: RegExpExecArray | null
  while ((m = RUN_OPEN_RE.exec(xml)) !== null) {
    if (m.index >= limit) break
    found = m.index
  }
  return found
}

/**
 * Enumerate every Word form field in document order.
 *
 * Only a `begin` fldChar carrying `<w:ffData` is a form field. Ordinary field
 * codes: page numbers, TOC entries, the SEQ CHAPTER field this fixture opens
 * with: share the fldChar mechanism and MUST be left untouched; that single
 * rule is the whole filter, and it mirrors LEGACY_CONTROL_RE in ../import-guards.
 */
export function scanFormFields(documentXml: string): FormFieldSpan[] {
  const spans: FormFieldSpan[] = []
  let depth = 0
  // The innermost open begin, when it is a form field we intend to capture.
  let pending: { fldCharStart: number; ffData: string } | null = null

  FLD_CHAR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FLD_CHAR_RE.exec(documentXml)) !== null) {
    const attrs = m[1] ?? ''
    const selfClosing = m[2] === '/'
    const type = /w:fldCharType="(\w+)"/.exec(attrs)?.[1]
    if (type !== 'begin' && type !== 'end') continue

    if (type === 'begin') {
      depth += 1
      if (depth > 1) {
        throw new FormFieldScanError(
          'This document nests Word field codes, which cannot be rewritten safely.',
        )
      }
      let ffData = ''
      if (!selfClosing) {
        const close = documentXml.indexOf('</w:fldChar>', m.index)
        if (close === -1) {
          throw new FormFieldScanError('A Word field code is not closed.')
        }
        ffData = documentXml.slice(FLD_CHAR_RE.lastIndex, close)
      }
      pending = ffData.includes('<w:ffData') ? { fldCharStart: m.index, ffData } : null
      continue
    }

    depth -= 1
    if (depth < 0) {
      throw new FormFieldScanError('This document has an unbalanced Word field code.')
    }
    if (!pending) continue

    const { fldCharStart, ffData } = pending
    pending = null

    const start = lastRunOpenBefore(documentXml, fldCharStart)
    if (start === -1) {
      throw new FormFieldScanError('A form field is not inside a run.')
    }
    // The begin fldChar must live in THAT run: a </w:r> between them means the
    // run we found already closed, so our start offset is wrong.
    if (documentXml.slice(start, fldCharStart).includes(RUN_CLOSE)) {
      throw new FormFieldScanError('A form field is not inside a run.')
    }

    const runClose = documentXml.indexOf(RUN_CLOSE, FLD_CHAR_RE.lastIndex)
    if (runClose === -1) {
      throw new FormFieldScanError('A form field run is not closed.')
    }
    let end = runClose + RUN_CLOSE.length

    // Swallow the field's own bookmark markers so no orphan bookmarkEnd is left
    // behind. Only ids opened INSIDE the span qualify, which is why an unrelated
    // document-wide bookmark such as _GoBack is never touched.
    const openedIds = new Set(
      Array.from(documentXml.slice(start, end).matchAll(/<w:bookmarkStart\s[^>]*w:id="(\d+)"/g)).map(
        (b) => b[1],
      ),
    )
    for (;;) {
      const next = /^<w:bookmarkEnd\s[^>]*w:id="(\d+)"\s*\/>/.exec(documentXml.slice(end))
      if (!next || !openedIds.has(next[1])) break
      end += next[0].length
    }

    let control: FormFieldControl
    if (ffData.includes('<w:textInput')) control = 'text'
    else if (ffData.includes('<w:checkBox')) control = 'checkbox'
    else if (ffData.includes('<w:ddList')) {
      throw new FormFieldScanError(
        'This document uses a drop-down form field, which is not supported yet.',
      )
    } else {
      throw new FormFieldScanError('This document uses an unrecognised Word form field.')
    }

    spans.push({
      index: spans.length,
      start,
      end,
      name: /<w:name\s[^>]*w:val="([^"]*)"/.exec(ffData)?.[1] ?? null,
      control,
      // Search only the run PREFIX: <w:ffData> lives inside <w:fldChar>, which
      // always follows <w:rPr>, so the first match here is the run's own props.
      runProps: /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(documentXml.slice(start, fldCharStart))?.[0] ?? '',
    })
  }

  if (depth !== 0) {
    throw new FormFieldScanError('This document has an unbalanced Word field code.')
  }
  return spans
}

/**
 * Build the run that replaces a form field.
 *
 * `runProps` is copied verbatim from the source run, so the filled value keeps
 * the field's font and size: without it, every value would render in the
 * paragraph default.
 */
export function formFieldReplacementRun(span: FormFieldSpan, tag: string): string {
  return `<w:r>${span.runProps}<w:t xml:space="preserve">${xmlEscape(tag)}</w:t></w:r>`
}

/**
 * Replace each span's byte range with new XML.
 *
 * Applied right-to-left so earlier offsets stay valid. Every op is re-checked
 * against the document it is about to edit: offsets are recomputed server-side
 * from a fresh scan and never accepted from a client, and these assertions are
 * the last line of defence if a scan and an edit ever disagree.
 */
export function applyFormFieldOps(
  documentXml: string,
  ops: ReadonlyArray<{ span: FormFieldSpan; xml: string }>,
): string {
  const ordered = [...ops].sort((a, b) => b.span.start - a.span.start)
  let out = documentXml
  let previousStart = Number.POSITIVE_INFINITY

  for (const { span, xml } of ordered) {
    if (span.start < 0 || span.end > out.length || span.start >= span.end) {
      throw new FormFieldScanError('A form field edit points outside the document.')
    }
    if (span.end > previousStart) {
      throw new FormFieldScanError('Two form field edits overlap.')
    }
    const slice = out.slice(span.start, span.end)
    if (!slice.startsWith('<w:r')) {
      throw new FormFieldScanError('A form field edit does not start on a run.')
    }
    if (!slice.includes('<w:ffData')) {
      throw new FormFieldScanError('A form field edit no longer points at a form field.')
    }
    if (span.name !== null && !slice.includes(`<w:name w:val="${span.name}"`)) {
      throw new FormFieldScanError('A form field edit points at a different field than it named.')
    }
    out = out.slice(0, span.start) + xml + out.slice(span.end)
    previousStart = span.start
  }
  return out
}

// U+FFFC OBJECT REPLACEMENT CHARACTER: stands in for a form field so the value
// detector sees a placeholder rather than nothing.
const FIELD_SENTINEL = '￼'

/**
 * Blank out every form field before running the value detector over the text.
 *
 * A sentinel rather than deletion: removing a field could JOIN the text either
 * side of it ("614" + field + "-555-1234") and manufacture a pattern hit that
 * does not exist in the document. U+FFFC is non-alphanumeric and is neither '.'
 * nor ',', so isStandaloneOccurrence in ../placeholderize-core reaches the same
 * verdict here that it will reach at commit time against a '{' or '}' neighbour.
 */
export function maskFormFields(documentXml: string, spans: readonly FormFieldSpan[]): string {
  return applyFormFieldOps(
    documentXml,
    spans.map((span) => ({ span, xml: `<w:r><w:t>${FIELD_SENTINEL}</w:t></w:r>` })),
  )
}
