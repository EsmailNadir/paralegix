// Which engine turns a template into a filled document, and which templates
// are allowed to store editable HTML.
//
// `templates.type` is the authority for both questions, never the `html`
// column. A `type='docx'` row fills losslessly through docxtemplater against
// the original OOXML: fonts, margins, tables, tab stops, headers, footers and
// absolutely-positioned text survive byte-for-byte. An HTML template renders
// its `html` column and exports through html-to-docx / Chromium.
//
// The `html` column on a DOCX row is NOT a second source of truth. Rows written
// before the editor stopped converting Word documents to HTML still carry one,
// and treating that as "this template is HTML now" silently reroutes a
// byte-perfect Word document through html-to-docx, which drops absolute
// positioning, collapses tab-stop layout into run-on text and mangles headers
// and footers. Dispatching on the column meant a single visit to the editor
// permanently downgraded the document.
//
// `docx_storage_path` is deliberately not part of the decision. Every docx row
// carries one (both the upload and the replace paths write it, and nothing
// clears it), and the client-side template shape maps a null path to
// `undefined`, so it cannot distinguish "no source" from "not loaded yet". A
// docx row that somehow has no source fails loudly at /api/templates/[id]/
// fill-docx ("Template is not a DOCX template.") instead of silently taking the
// lossy HTML path.

export type TemplateContentType = 'html' | 'docx' | 'pdf-form'

export type TemplateFillEngine =
  // Native docxtemplater fill against the stored .docx.
  | 'docx'
  // Server-side AcroForm fill + flatten of the stored PDF.
  | 'pdf-form'
  // Hydrate the `html` column and render it via /api/templates/export.
  | 'html'

export function resolveFillEngine(
  type: TemplateContentType | null | undefined,
): TemplateFillEngine {
  if (type === 'docx') return 'docx'
  if (type === 'pdf-form') return 'pdf-form'
  return 'html'
}

/**
 * Reason a template of this type must not have HTML written onto its row, or
 * `null` when the write is allowed. The string is shown to the user verbatim.
 *
 * Only browser-authored HTML templates keep their content in the `html`
 * column. For a DOCX or fillable-PDF template the uploaded file IS the content;
 * storing an HTML rendering next to it creates a second, lossy copy that the
 * fill path used to prefer.
 */
export function htmlWriteRejection(
  type: TemplateContentType | null | undefined,
): string | null {
  if (type === 'docx') {
    return (
      'This is a Word template: the uploaded .docx is its content, and it fills ' +
      'without losing formatting. Saving an HTML version over it would replace ' +
      'that with a converted approximation. Use Re-upload to change the document, ' +
      'or edit it in the Word editor.'
    )
  }
  if (type === 'pdf-form') {
    return (
      'This is a fillable-PDF template: the uploaded PDF is its content and its ' +
      'form fields are filled in place. Replace the file from the template page ' +
      'instead of saving an HTML version over it.'
    )
  }
  return null
}
