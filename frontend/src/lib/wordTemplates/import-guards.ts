// Import guards for the positional (PDF→HTML) template editor.
//
// WHY this module exists:
//   The portal has two template engines, and only one of them preserves
//   structure:
//
//     A. Native DOCX (type='docx'), the file is stored byte-for-byte and
//        filled in place by docxtemplater. Formatting survives exactly,
//        because the document is never rebuilt (see docx.ts).
//
//     B. The positional editor (/templates/new), EVERY upload is converted
//        to PDF first, then HTML is reconstructed from pdfjs text runs at x/y
//        coordinates (see pdf-to-html.ts). A PDF carries no paragraphs,
//        tables, lists, or fields, only glyphs at positions, so path B is a
//        heuristic reconstruction, not a conversion.
//
//   For prose documents the reconstruction is good enough. For documents whose
//   structure IS their content, court fill-in forms, it cannot work, and the
//   failure is total rather than cosmetic:
//     • pdf-to-html.ts drops every annotation that isn't a Link, so an
//       AcroForm's fields are discarded on arrival.
//     • It reads getTextContent() only, so the ruled lines and boxes a form is
//       made of (vector `re` ops) never come through either.
//   The user is left with floating labels over an empty page.
//
//   These guards recognise that class of document UP FRONT so the editor can
//   route it to the lossless path instead of silently mangling it. A .docx form
//   has somewhere to go (path A); a PDF-only form does not, and is refused with
//   the reason rather than half-imported.
//
// Scope: word/document.xml only, matching the body-only scope documented on
// openDocxBody() in app/(app)/templates/actions.ts. Form fields in headers or
// footers are rare and are not worth a second inflate here.

import PizZip from 'pizzip'

export type ImportGuardVerdict = {
  /** false → do NOT put this file through the PDF→HTML rebuild. */
  ok: boolean
  /** User-facing sentence explaining the block. Empty string when ok. */
  reason: string
  /** Non-blocking notes worth surfacing alongside a successful import. */
  warnings: string[]
}

const OK: ImportGuardVerdict = { ok: true, reason: '', warnings: [] }

// A single table this large is a page-layout scaffold, not data. The seeded
// templates' real data tables (the Rep Agreement payment schedule, the ODH cc
// list) sit well under this; the federal AO Pro Se complaint form is one table
// of 116 rows. Advisory only, a long data table is legitimate, it just tends
// to reflow badly, so we warn instead of blocking.
const LAYOUT_TABLE_ROW_WARN = 40
// Tab stops are how a Word form draws its fill-in rules. Dense tabbing survives
// the PDF hop as arbitrary whitespace runs. Advisory for the same reason.
const TAB_STOP_WARN = 100

/** Count non-overlapping matches without building the match array. */
function count(xml: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  let n = 0
  while (re.exec(xml) !== null) n += 1
  return n
}

// Legacy Word form fields (Developer ▸ Legacy Forms). The control element lives
// inside <w:ffData>, so these tags appear only in a form field, matching them
// directly avoids the false positives that counting <w:fldChar> would bring in
// (fldChar also wraps page numbers, TOCs, and every other Word field code).
const LEGACY_CONTROL_RE = /<w:(?:textInput|checkBox|ddList)[ />]/g
// Modern content controls. <w:sdt> alone is NOT a form field, Word wraps TOCs
// and headings in it too, so we look inside <w:sdtPr> for an actual input type.
const SDT_PROPS_RE = /<w:sdtPr>([\s\S]*?)<\/w:sdtPr>/g
const SDT_CONTROL_RE = /<w:(?:text|comboBox|dropDownList|date)[ />]|<w14:checkbox[ />]/

function countContentControls(xml: string): number {
  let n = 0
  let match: RegExpExecArray | null
  const re = new RegExp(SDT_PROPS_RE.source, SDT_PROPS_RE.flags)
  while ((match = re.exec(xml)) !== null) {
    if (SDT_CONTROL_RE.test(match[1])) n += 1
  }
  return n
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * Decide whether a .docx should go through the PDF→HTML rebuild.
 *
 * Blocks when the document is a fill-in form (legacy form fields or content
 * controls). Such a document has to keep its structure to be worth anything,
 * and the caller has a lossless place to put it, the native DOCX template.
 *
 * Returns ok:true with warnings for merely awkward documents (big layout
 * tables, dense tab stops): those import, they just may need cleanup.
 *
 * Never throws, an unreadable file is left to the real parser downstream,
 * which reports the failure properly.
 */
export function inspectDocxForImport(bytes: Uint8Array): ImportGuardVerdict {
  let xml: string
  try {
    const entry = new PizZip(bytes).file('word/document.xml')
    if (!entry) return OK
    xml = entry.asText()
  } catch {
    return OK
  }

  const legacyFields = count(xml, LEGACY_CONTROL_RE)
  const contentControls = countContentControls(xml)
  const total = legacyFields + contentControls

  if (total > 0) {
    const kind =
      legacyFields > 0 && contentControls > 0
        ? 'form fields'
        : legacyFields > 0
          ? 'legacy Word form fields'
          : 'content controls'
    return {
      ok: false,
      reason:
        `This Word document is a fill-in form: it contains ${plural(total, kind.replace(/s$/, ''), kind)}. ` +
        `Rebuilding it in the visual editor would drop those fields and the layout that positions them. ` +
        `Import it as a Word template instead: that keeps the file exactly as-is and lets you name the form's blanks.`,
      warnings: [],
    }
  }

  const warnings: string[] = []
  const rows = count(xml, /<w:tr[ >]/g)
  if (rows >= LAYOUT_TABLE_ROW_WARN) {
    warnings.push(
      `This document is built on a ${rows}-row table. Tables are rebuilt from text positions, ` +
        `so rows and column alignment may need cleanup after import.`,
    )
  }
  const tabs = count(xml, /<w:tab\/>/g)
  if (tabs >= TAB_STOP_WARN) {
    warnings.push(
      `This document uses ${tabs} tab stops for layout. Tabs become plain spacing after import ` +
        `and may not line up.`,
    )
  }
  return { ok: true, reason: '', warnings }
}

/**
 * Decide whether a PDF should go through the PDF→HTML rebuild, given the
 * AcroForm field names pdfjs extracted (pdf.getFieldObjects() keys).
 *
 * Pure, so the policy is unit-testable without loading a PDF; the extraction
 * itself lives in convertPdfToHtml, which already has the document open.
 *
 * Unlike the .docx case there is no lossless fallback, the portal cannot fill
 * a PDF in place, so this is a dead end by design. Saying so plainly beats
 * importing a page of labels with the fields silently removed.
 */
export function inspectPdfFormFields(fieldNames: string[]): ImportGuardVerdict {
  if (fieldNames.length === 0) return OK
  const sample = fieldNames.slice(0, 3).join(', ')
  return {
    ok: false,
    reason:
      `This PDF is a fillable form: it has ${plural(fieldNames.length, 'field', 'fields')} ` +
      `(${sample}${fieldNames.length > 3 ? ', …' : ''}). ` +
      `The editor rebuilds a PDF from its text positions, which drops the form fields and the ` +
      `lines they sit on. Upload it from Templates → New Template instead: that keeps the PDF ` +
      `itself and lets you name its fields.`,
    warnings: [],
  }
}
