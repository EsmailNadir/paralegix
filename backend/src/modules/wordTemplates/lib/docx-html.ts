// Whitespace repair for the HTML → DOCX export path.
//
// html-to-docx silently drops any text node made only of whitespace: a lone
// space between two inline elements, or a <span> whose entire content is a
// space. Whitespace only survives when it shares a text node with real text,
// in which case the run is emitted as <w:t xml:space="preserve">. Measured
// against the pinned html-to-docx@1.8:
//
//   <span>Dear</span> <span>Mr. Goddard</span>   ->  "DearMr. Goddard"
//   <span>Dear </span><span>Mr. Goddard</span>   ->  "Dear Mr. Goddard"
//
// That is fatal here because pdf-to-html.ts renders PDF text one <span> per
// CHARACTER (renderStyledCharacters) and emits word gaps as a bare space
// between those spans (renderHorizontalGap). EVERY space in a PDF-derived
// template is therefore whitespace-only, and Word received a whole paragraph
// as one unbreakable token: "Thisletterconfirmsthatouroffice…", broken
// mid-word wherever the right margin happened to fall.
//
// The fix is to give each space some text to travel with: merge adjacent
// same-style spans back into real runs, and fold an orphaned gap into the run
// before it. NBSP would also survive conversion and is deliberately NOT used
// as the general fix: it is non-breaking, so paragraphs would run off the
// right margin instead of wrapping. It stays only as the fallback for a blank
// span with no run to attach to, where the choice is NBSP or nothing.
//
// Only the PDF path is faithful to the original page. html-to-docx ignores the
// absolute positioning pdf-to-html lays out with, so DOCX is always a reflow;
// this makes it a readable reflow instead of a corrupt one.

// The exact shape pdf-to-html emits: a <span> carrying nothing but a style
// attribute, wrapping markup-free text. Anything richer: the data-pdf-gap
// spacers, placeholder chips, editor spans with extra attributes: does not
// match and is passed through untouched.
const SIMPLE_SPAN = /<span style="([^"]*)">([^<]*)<\/span>/g

// ASCII whitespace only. U+00A0 is excluded on purpose: an NBSP already
// survives conversion and carries a non-breaking intent, so it must not be
// folded away into an ordinary space.
const BLANK = /^[ \t\r\n]+$/

type Chunk =
  | { kind: 'span'; style: string; text: string }
  | { kind: 'raw'; text: string }

/**
 * Rewrite filled template HTML so html-to-docx cannot lose its spaces.
 *
 * Pure and idempotent. Everything it does not recognise is copied through
 * byte-for-byte, so a template that never went through pdf-to-html (a DOCX
 * conversion, hand-authored HTML) is unaffected.
 */
export function prepareHtmlForDocx(html: string): string {
  const chunks: Chunk[] = []
  let cursor = 0
  SIMPLE_SPAN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SIMPLE_SPAN.exec(html)) !== null) {
    if (match.index > cursor) {
      chunks.push({ kind: 'raw', text: html.slice(cursor, match.index) })
    }
    chunks.push({ kind: 'span', style: match[1], text: match[2] })
    cursor = match.index + match[0].length
  }
  if (cursor < html.length) chunks.push({ kind: 'raw', text: html.slice(cursor) })

  const merged: Chunk[] = []
  for (const chunk of chunks) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : undefined

    if (prev && prev.kind === 'span') {
      // An orphaned gap: a bare space between spans, or a span holding only
      // a space. Collapsed to a single space on the way in, because that is
      // what a browser would have rendered it as anyway; preserving the raw
      // run would turn pretty-printed source into visible extra spacing.
      if (BLANK.test(chunk.text)) {
        prev.text += ' '
        continue
      }
      // Per-character spans from one PDF text item all carry the same style,
      // so rejoining them reconstructs the original word: which also rescues
      // the spaces inside it.
      if (chunk.kind === 'span' && prev.style === chunk.style) {
        prev.text += chunk.text
        continue
      }
    }

    merged.push(
      chunk.kind === 'span'
        ? { kind: 'span', style: chunk.style, text: chunk.text }
        : { kind: 'raw', text: chunk.text },
    )
  }

  return merged
    .map((chunk) =>
      chunk.kind === 'span'
        // A blank span still here had no run in front of it to fold into, so
        // a plain space would simply be dropped again. NBSP is the only thing
        // that survives on its own, and a leading indent is not a wrap point
        // anyway.
        ? `<span style="${chunk.style}">${BLANK.test(chunk.text) ? '\u00A0' : chunk.text}</span>`
        : chunk.text,
    )
    .join('')
}
