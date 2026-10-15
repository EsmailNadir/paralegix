// Fillable-PDF (AcroForm) template support.
//
// WHY this is the EASY case (it inverts the intuition in the proposal):
//   A Word form names its blanks Text1…Text69 with no help text, so a human has
//   to supply the meaning of every one. A fillable PDF's fields already carry
//   meaningful names: "Plaintiff Full Name", "Case Number", "Claims and Facts
//   continued 1": so most of them map onto the canonical fill vocabulary
//   mechanically.
//
// WHY the stored PDF is REWRITTEN at commit, like the docx path:
//   templates.fields is a text[] of tag names: there is nowhere to persist a
//   {pdf field name -> tag} mapping. Rather than add a column, the accepted
//   names are written back into the PDF's own field names, so the stored file is
//   self-describing: templates.fields lists exactly the field names the file
//   contains, and fill is a straight lookup. This mirrors the docx path, where
//   the stored file is likewise the rewritten artifact.
//
// WHY structure is preserved: the original document is never rebuilt. pdf-lib
// sets values on the existing widgets and flattens them into the page, so the
// ruled lines, boxes and layout are the file's own.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import * as fontkit from '@pdf-lib/fontkit'
import {
  adjustDimsForRotation,
  cleanText,
  layoutMultilineText,
  layoutSinglelineText,
  mergeLines,
  PDFCheckBox,
  PDFDocument,
  type PDFFont,
  PDFName,
  PDFString,
  PDFTextField,
  type PDFWidgetAnnotation,
  reduceRotation,
} from 'pdf-lib'

export type PdfFormFieldKind = 'text' | 'checkbox'

export type PdfFormField = {
  /** The field's name inside the PDF: the key fill uses. */
  name: string
  kind: PdfFormFieldKind
  /** Position in the PDF's field order, for stable review ordering. */
  index: number
}

export type PdfFillResult = {
  /** The filled (and by default flattened) PDF bytes. */
  bytes: Uint8Array
  /**
   * Form fields the values had nothing for, in document order. Each one stayed
   * blank in `bytes`. Reported for the same reason as the docx path's unfilled
   * tags: a blank a nobody asked for is invisible once the form is flattened.
   */
  unfilledFields: string[]
}

/** Thrown when a PDF's form cannot be handled; fatal rather than half-applied. */
export class PdfFormError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfFormError'
  }
}

/**
 * The smallest size an overflowing value is shrunk to. Below it the value is
 * left to clip: a visibly cut value tells staff to shorten it, while text too
 * small to read on paper looks filled in when it is not.
 */
const MIN_FIT_FONT_SIZE = 5

// Liberation Sans (SIL OFL, licence beside the file) is metric-compatible with
// Helvetica and covers Latin Extended, Greek and Cyrillic. It is read from disk
// beside this module; `scripts/copy-template-fonts.ts` copies it into dist/.
const UNICODE_FONT_FILE = path.join(__dirname, 'fonts', 'LiberationSans-Regular.ttf')
let unicodeFontBytes: Uint8Array | undefined

async function embedUnicodeFont(pdf: PDFDocument): Promise<PDFFont> {
  unicodeFontBytes ??= await readFile(UNICODE_FONT_FILE)
  pdf.registerFontkit(fontkit)
  return pdf.embedFont(unicodeFontBytes, { subset: true })
}

/** Whether `font` can draw `text` as pdf-lib lays a field value out. */
function canEncode(font: PDFFont, text: string): boolean {
  const supported = new Set(font.getCharacterSet())
  return Array.from(mergeLines(cleanText(text))).every((ch) => supported.has(ch.codePointAt(0) ?? -1))
}

// pdf-lib's own pattern for the font operator in a /DA string: `/Helv 10 Tf`.
const TF_OPERATOR = /\/([^\0\t\n\f\r ]+)[\0\t\n\f\r ]+(\d*\.\d+|\d+)[\0\t\n\f\r ]+Tf/g

function lastTf(da: string): RegExpExecArray | null {
  const re = new RegExp(TF_OPERATOR)
  let last: RegExpExecArray | null = null
  for (let m = re.exec(da); m; m = re.exec(da)) last = m
  return last
}

/**
 * Shrink a text field's font size, per widget, until `text` fits its box.
 *
 * Forms carry a fixed size in /DA, and pdf-lib draws the value at that size
 * whatever its length, so an overflowing value was clipped by the widget's box
 * when flattened. A value that already fits is left untouched. Auto-size (0)
 * needs nothing, since pdf-lib fits that itself, and combed fields draw one
 * character per cell, so they are left alone too.
 */
function fitTextToWidgets(field: PDFTextField, text: string, font: PDFFont): void {
  if (field.isCombed()) return
  const fieldDa = field.acroField.getDefaultAppearance() ?? ''
  for (const widget of field.acroField.getWidgets()) {
    // Same precedence as pdf-lib's appearance provider: the widget's size, then the field's.
    const widgetDa = widget.getDefaultAppearance() ?? ''
    const ownTf = lastTf(widgetDa)
    const tf = ownTf ?? lastTf(fieldDa)
    const drafted = Number(tf?.[2] ?? 0)
    if (!tf || drafted <= 0) continue

    const bounds = textBounds(widget)
    let size = drafted
    while (size > MIN_FIT_FONT_SIZE && !fits(field, text, font, size, bounds)) {
      size = Math.ceil(size * 2 - 1) / 2 // next half point down
    }
    size = Math.max(size, MIN_FIT_FONT_SIZE)
    if (size >= drafted) continue

    // Written on the widget, which pdf-lib reads ahead of the field, so each
    // widget of a field shown in several places is sized for its own box.
    const sized = `/${tf[1]} ${size} Tf`
    widget.setDefaultAppearance(
      ownTf
        ? widgetDa.slice(0, ownTf.index) + sized + widgetDa.slice(ownTf.index + ownTf[0].length)
        : `${widgetDa} ${sized}`.trim(),
    )
  }
}

// The area pdf-lib's appearance provider lays text into: the widget's box,
// turned for its rotation, inset by the border plus a 1pt padding.
function textBounds(widget: PDFWidgetAnnotation) {
  const rotation = reduceRotation(widget.getAppearanceCharacteristics()?.getRotation())
  const { width, height } = adjustDimsForRotation(widget.getRectangle(), rotation)
  const inset = (widget.getBorderStyle()?.getWidth() ?? 0) + 1
  return { x: inset, y: inset, width: width - inset * 2, height: height - inset * 2 }
}

function fits(
  field: PDFTextField,
  text: string,
  font: PDFFont,
  fontSize: number,
  bounds: ReturnType<typeof textBounds>,
): boolean {
  const alignment = field.getAlignment()
  if (field.isMultiline()) {
    const { lines, lineHeight } = layoutMultilineText(text, { alignment, fontSize, font, bounds })
    return lines.length * lineHeight <= bounds.height
  }
  return layoutSinglelineText(text, { alignment, fontSize, font, bounds }).line.width <= bounds.width
}

function classify(field: unknown, name: string): PdfFormFieldKind {
  if (field instanceof PDFTextField) return 'text'
  if (field instanceof PDFCheckBox) return 'checkbox'
  // Radio groups, dropdowns, option lists and buttons all need their own value
  // semantics and review UI. Refuse rather than silently drop them, which would
  // produce a template that looks complete but cannot fill those fields.
  throw new PdfFormError(
    `This PDF uses a form control we don't support yet ("${name}"). Only text fields and checkboxes work.`,
  )
}

/** List the AcroForm fields of a PDF, in document order. Empty when it has none. */
export async function readPdfFormFields(bytes: Uint8Array): Promise<PdfFormField[]> {
  let pdf: PDFDocument
  try {
    pdf = await PDFDocument.load(bytes)
  } catch {
    throw new PdfFormError('This file could not be read as a PDF.')
  }
  return pdf
    .getForm()
    .getFields()
    .map((f, index) => {
      const name = f.getName()
      return { name, kind: classify(f, name), index }
    })
}

/**
 * Rename fields in place, so the stored PDF carries the names staff chose.
 *
 * `mapping` is keyed by the CURRENT field name. Names absent from it are left
 * alone. Rejects a rename that would collide with another field, because two
 * fields sharing a name would fill from one value and silently merge.
 */
export async function renamePdfFormFields(
  bytes: Uint8Array,
  mapping: Readonly<Record<string, string>>,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes)
  const fields = pdf.getForm().getFields()

  const finalNames = fields.map((f) => mapping[f.getName()] ?? f.getName())
  const seen = new Set<string>()
  for (const n of finalNames) {
    if (seen.has(n)) {
      throw new PdfFormError(`Two fields would both be named "${n}". Give each field its own name.`)
    }
    seen.add(n)
  }

  fields.forEach((f, i) => {
    if (finalNames[i] !== f.getName()) {
      // pdf-lib has no rename API; /T is the field's partial name in the AcroForm
      // dictionary, and these forms are flat (no parent field hierarchy).
      f.acroField.dict.set(PDFName.of('T'), PDFString.of(finalNames[i]))
    }
  })
  return pdf.save()
}

/**
 * Fill a PDF form by field name and flatten it.
 *
 * Flattening bakes the values into the page so the downloaded document is a
 * finished filing rather than an editable form someone could alter after
 * signing. Unknown keys are skipped and a field with no value is cleared, matching the docx fill's
 * nullGetter behaviour (an unfilled field renders empty, not as a leftover tag)
 * and, like that path, the fields left blank come back with the bytes so the
 * gaps can be shown rather than shipped unannounced.
 */
export async function fillPdfForm(
  bytes: Uint8Array,
  values: Readonly<Record<string, string>>,
  opts: { flatten?: boolean } = {},
): Promise<PdfFillResult> {
  const pdf = await PDFDocument.load(bytes)
  const form = pdf.getForm()
  const unfilledFields: string[] = []
  // pdf-lib draws every field it flattens in this font (Helvetica, WinAnsi only).
  const standardFont = form.getDefaultFont()
  let unicodeFont: PDFFont | undefined

  for (const field of form.getFields()) {
    const name = field.getName()
    const value = values[name]
    if (value === undefined || value === '') {
      unfilledFields.push(name)
      // Clear whatever the stored file already carries: a form uploaded half
      // filled in would otherwise print its old value in a field reported blank.
      if (field instanceof PDFTextField) field.setText(undefined)
      else if (field instanceof PDFCheckBox) field.uncheck()
      continue
    }

    if (field instanceof PDFTextField) {
      field.setText(value)
      if (canEncode(standardFont, value)) {
        fitTextToWidgets(field, value, standardFont)
      } else {
        // Helvetica would throw on this value and fail the whole fill, so this
        // one field is drawn now in the fallback font. That also marks it clean,
        // so flatten leaves its appearance as drawn here.
        unicodeFont ??= await embedUnicodeFont(pdf)
        fitTextToWidgets(field, value, unicodeFont)
        field.updateAppearances(unicodeFont)
      }
    } else if (field instanceof PDFCheckBox) {
      // Any of the usual affirmatives or a tick mark (with or without the emoji
      // variation selector) ticks the box. Anything else leaves it clear, and
      // that includes the cross marks ✗ and ✘, which read as "no".
      if (/^(x|y|yes|true|1|on|checked|[✓✔☑]\uFE0F?)$/i.test(value.trim())) field.check()
      else field.uncheck()
    } else {
      classify(field, name) // throws with the same message as detection
    }
  }

  if (opts.flatten !== false) form.flatten()
  return { bytes: await pdf.save(), unfilledFields }
}
