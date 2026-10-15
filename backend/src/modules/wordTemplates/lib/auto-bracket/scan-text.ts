// Every piece of text a stored .docx part carries, for the leftover-client-text
// guard (checkLeftoverClientText in templates/actions).
//
// WHY not documentText (placeholderize-core): that is the visible text as
// detection and the fill engine see it, and it misses text that still ships in
// every file generated from the template:
//   - a name deleted with Track Changes on (<w:delText>): the usual way a
//     precedent gets "redacted" by accident;
//   - field codes (<w:instrText>), e.g. a HYPERLINK to a docket page;
//   - text after a text box in the same paragraph: its paragraph regex is
//     non-greedy, so the text box's own </w:p> ends the outer paragraph early.
// This reads runs in document order and breaks lines on every </w:p>, so
// nesting cannot hide anything. documentText stays as it is: detection and
// RAG depend on its output.
//
// Pure module: no I/O.

import { xmlUnescape } from '../placeholderize-core'

export type DocxPartText = {
  /** What a reader sees, text boxes included. */
  visible: string
  /** Deleted under Track Changes: hidden on screen, still in the file. */
  deleted: string
  /** Field instructions, e.g. a HYPERLINK target. */
  fieldCodes: string
}

// A self-closing <w:t/> carries no text; the lookahead keeps it from opening a
// match that runs on to the next real closing tag.
const RUN_TEXT_RE = /<w:(t|delText|instrText)\b(?![^>]*\/>)[^>]*>([\s\S]*?)<\/w:\1>|<\/w:p>/g

// Word writes a text box twice: once for current readers (mc:Choice) and once
// for old ones (mc:Fallback). Reading both would count every name in it twice.
const FALLBACK_RE = /<mc:Fallback\b[^>]*>[\s\S]*?<\/mc:Fallback>/g

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')

export function docxPartText(xml: string): DocxPartText {
  const buf = { t: '', delText: '', instrText: '' }
  for (const m of xml.replace(FALLBACK_RE, '').matchAll(RUN_TEXT_RE)) {
    const kind = m[1] as keyof typeof buf | undefined
    if (!kind) {
      buf.t += '\n'
      buf.delText += '\n'
      buf.instrText += '\n'
      continue
    }
    buf[kind] += xmlUnescape(m[2])
  }
  return { visible: lines(buf.t), deleted: lines(buf.delText), fieldCodes: lines(buf.instrText) }
}

/**
 * Text of a metadata part (docProps/core.xml, app.xml, custom.xml,
 * customXml/item*.xml): title, subject, keywords, custom properties and data
 * bound to content controls. One value per line.
 */
export function propertyPartText(xml: string): string {
  return lines(xmlUnescape(xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<[^>]*>/g, '\n')))
}
