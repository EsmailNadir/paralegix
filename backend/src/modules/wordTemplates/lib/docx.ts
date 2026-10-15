// Server-side DOCX parsing + filling. Mirrors paralegix
// backend/src/modules/templates/docx.service.js.
//
// Paradigm: the user authors a .docx in Word with placeholders typed
// inline:
//
//   Dear {client_name},
//   {#line_items}
//     {description} ............ {amount}
//   {/line_items}
//
// Parsing extracts those tags. Filling renders the data back into the
// original docx: Word's formatting (fonts, margins, tables, images,
// styles) is preserved byte-for-byte because we never convert the
// document; we just substitute strings inside the XML.

import Docxtemplater from 'docxtemplater'
import InspectModule from 'docxtemplater/js/inspect-module'
import { loadDocxZip } from '../../templates/docx.service'

export type DocxRepeater = { name: string; fields: string[] }

/**
 * Rows per column when a loop is laid out across columns.
 *
 * A schedule printed as one list runs off the page, so the representation
 * agreement sets it in two table cells of at most this many rows. In Word that
 * is two loops, one per cell, but it is ONE schedule: nobody is going to type it
 * twice and keep the split right. A loop tag named `<base>_col<n>` is therefore
 * a COLUMN of `<base>`, which is the only name anything above this module sees.
 */
export const COLUMN_LOOP_ROWS = 8

const COLUMN_LOOP_RE = /^(.+)_col(\d+)$/

type LoopColumn = { base: string; index: number }

function loopColumn(name: string): LoopColumn | null {
  const m = COLUMN_LOOP_RE.exec(name)
  if (!m) return null
  const index = Number(m[2])
  return Number.isInteger(index) && index >= 1 ? { base: m[1], index } : null
}

/**
 * The rows each column tag renders, given the base loop's rows. Columns take
 * COLUMN_LOOP_ROWS each, in order; the LAST column of a document takes
 * everything from its start onwards, so a schedule longer than the template's
 * columns is printed in full rather than silently cut short.
 */
export function splitLoopColumns(
  columnNames: readonly string[],
  repeaterValues: Record<string, Array<Record<string, string>>>,
): Record<string, Array<Record<string, string>>> {
  const byBase = new Map<string, LoopColumn[]>()
  for (const name of columnNames) {
    const column = loopColumn(name)
    if (!column) continue
    byBase.set(column.base, [...(byBase.get(column.base) ?? []), column])
  }

  const out: Record<string, Array<Record<string, string>>> = {}
  for (const [base, columns] of byBase) {
    const rows = repeaterValues[base] ?? []
    const ordered = [...columns].sort((a, b) => a.index - b.index)
    const lastIndex = ordered[ordered.length - 1].index
    for (const { index } of ordered) {
      const start = (index - 1) * COLUMN_LOOP_ROWS
      out[`${base}_col${index}`] =
        index === lastIndex ? rows.slice(start) : rows.slice(start, start + COLUMN_LOOP_ROWS)
    }
  }
  return out
}
export type DocxPlaceholders = {
  fields: string[]
  repeaters: DocxRepeater[]
}

export type DocxFillResult = {
  /** The filled DOCX bytes. */
  buffer: Buffer
  /**
   * Tags the data had no value for, in document order and de-duplicated. Each
   * one rendered as an empty gap in `buffer`: a partial fill is still a valid
   * document, but the caller has to be able to tell the user where the holes
   * are instead of handing over a letter that reads "Dear ,".
   */
  unfilledFields: string[]
}

/**
 * Parse all placeholder tags from a DOCX buffer.
 *
 * Returns:
 *   - fields:    simple top-level placeholders, e.g. "client_name"
 *   - repeaters: loop blocks, e.g. { name: "line_items", fields: ["description", "amount"] }
 *
 * Throws if the buffer is not a valid DOCX or if any placeholder is
 * malformed (unclosed loop, unmatched bracket, etc).
 */
// Every loop tag as the DOCUMENT spells it, columns included. parseDocxPlaceholders
// folds columns into their base, which is right for everyone but the fill itself.
function rawLoopNames(buffer: Buffer): string[] {
  // Rejects a malformed file or a zip bomb before docxtemplater reads it.
  const zip = loadDocxZip(buffer)
  const inspect = new InspectModule()
  // Constructing the document is what runs the inspect module over it.
  // eslint-disable-next-line no-new
  new Docxtemplater(zip, { modules: [inspect], paragraphLoop: true, linebreaks: true })
  return Object.entries(inspect.getAllTags() as Record<string, unknown>)
    .filter(([, value]) => value && typeof value === 'object' && Object.keys(value).length > 0)
    .map(([key]) => key)
}

export function parseDocxPlaceholders(buffer: Buffer): DocxPlaceholders {
  // Rejects a malformed file or a zip bomb before docxtemplater reads it.
  const zip = loadDocxZip(buffer)
  const inspect = new InspectModule()
  // Constructing the document is what runs the inspect module over it.
  // eslint-disable-next-line no-new
  new Docxtemplater(zip, {
    modules: [inspect],
    paragraphLoop: true,
    linebreaks: true,
  })

  const tags = inspect.getAllTags() as Record<string, unknown>

  const fields: string[] = []
  const repeaters: DocxRepeater[] = []

  for (const [key, value] of Object.entries(tags)) {
    if (value && typeof value === 'object' && Object.keys(value).length > 0) {
      const subFields = Object.keys(value as Record<string, unknown>)
      // Columns of one loop are that loop: `{#rows_col2}` holds the same rows
      // as `{#rows_col1}`, so the caller fills `rows` once.
      const column = loopColumn(key)
      const name = column ? column.base : key
      const existing = repeaters.find((r) => r.name === name)
      if (existing) {
        for (const f of subFields) if (!existing.fields.includes(f)) existing.fields.push(f)
      } else {
        repeaters.push({ name, fields: subFields })
      }
    } else {
      fields.push(key)
    }
  }

  return { fields, repeaters }
}

/**
 * Fill a DOCX template buffer with simple values + repeater arrays.
 *
 * Returns the filled DOCX bytes plus the tags that had no value. Original
 * formatting is preserved.
 *
 * A tag the data has no entry for renders as an empty string rather than
 * throwing: a partial fill is a valid document, and the alternative is a
 * download that fails outright over one stale placeholder. That silence is why
 * the unfilled tags come back alongside the bytes: without them a mis-keyed
 * placeholder is invisible, and the user gets "Dear ," with no warning.
 */
export function fillDocxTemplate(
  buffer: Buffer,
  values: Record<string, string> = {},
  repeaterValues: Record<string, Array<Record<string, string>>> = {},
): DocxFillResult {
  const unfilled: string[] = []
  const seen = new Set<string>()

  // Column tags are rendered from the base loop's rows (see COLUMN_LOOP_ROWS).
  // Read from the document itself, because only it says how many columns there
  // are, and the last one has to take the remainder.
  const columnRows = splitLoopColumns(rawLoopNames(buffer), repeaterValues)

  // Rejects a malformed file or a zip bomb before docxtemplater reads it.
  const zip = loadDocxZip(buffer)
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: (part: { type?: string; value?: string; module?: string }) => {
      // Loop-module parts are `{#section}` / `{^section}` tags, not blanks in
      // the prose: an absent inverted section is the document working as
      // written, so reporting it would train the user to ignore the warning.
      if (part?.type === 'placeholder' && !part.module && part.value && !seen.has(part.value)) {
        seen.add(part.value)
        unfilled.push(part.value)
      }
      return ''
    },
  })

  doc.render({ ...values, ...repeaterValues, ...columnRows })
  return {
    buffer: doc.getZip().generate({ type: 'nodebuffer' }) as Buffer,
    unfilledFields: unfilled,
  }
}

/**
 * Flatten fields + repeaters into a single fields[] list for the
 * `templates.fields` column. Repeater fields use "loop.field" notation.
 */
export function buildFlatFieldList({
  fields,
  repeaters,
}: DocxPlaceholders): string[] {
  const out = [...fields]
  for (const r of repeaters) {
    for (const f of r.fields) out.push(`${r.name}.${f}`)
  }
  return out
}

/**
 * The `templates.fields` / `templates.repeaters` values for a .docx whose bytes
 * were replaced in place (the OnlyOffice save-back), in the shape the upload
 * stores. Without them a tag added or renamed in the editor has no input in
 * the fill form and prints blank.
 *
 * Returns no columns when the edited file will not parse (e.g. an unclosed tag
 * typed in the editor): the bytes are still the user's saved work, so the
 * caller's update keeps the previous field list. The parse error is logged.
 */
export function docxFieldColumns(
  buffer: Buffer,
): { fields?: string[]; repeaters?: DocxRepeater[] } {
  try {
    const parsed = parseDocxPlaceholders(buffer)
    return { fields: buildFlatFieldList(parsed), repeaters: parsed.repeaters }
  } catch (err) {
    console.error('templates: re-reading docx fields failed', err)
    return {}
  }
}
