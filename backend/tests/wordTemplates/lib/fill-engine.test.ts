import { resolveFillEngine, htmlWriteRejection } from '../../../src/modules/wordTemplates/lib/fill-engine'

// WHY (Rule 9): `templates.type` and the `templates.html` column disagreed
// about which engine owns a Word template's content, and the fill path trusted
// the column. The positional editor converted a .docx to HTML on open and
// stored it on the row without changing the row's type, so a single visit
// moved that template onto html-to-docx permanently: which is what produced
// the run-on payment list, the tripled footer firm name and the logo turning
// into a watermark on the firm's representation agreement.
//
// These tests pin BOTH halves of the fix: the type decides the engine, and a
// file-backed row refuses HTML writes so it cannot re-enter that state.

describe('resolveFillEngine', () => {
  it('sends a Word template to the native docx fill', () => {
    expect(resolveFillEngine('docx')).toBe('docx')
  })

  it('still sends a Word template to the native fill when the row carries HTML', () => {
    // The regression: the dispatcher used to read `Boolean(template.html)` and
    // route a docx row through html-to-docx the moment the column was set. The
    // column is not an input to this decision at all: hence no html argument.
    expect(resolveFillEngine('docx')).toBe('docx')
  })

  it('sends a fillable PDF to the in-place AcroForm fill', () => {
    expect(resolveFillEngine('pdf-form')).toBe('pdf-form')
  })

  it('sends a browser-authored template to the HTML export route', () => {
    expect(resolveFillEngine('html')).toBe('html')
  })

  it('treats a missing type as HTML', () => {
    // Template.type is optional in the legacy client-side shape; the HTML path
    // is the only one that can work without a stored source file.
    expect(resolveFillEngine(undefined)).toBe('html')
    expect(resolveFillEngine(null)).toBe('html')
  })
})

describe('htmlWriteRejection', () => {
  it('refuses to store HTML on a Word template and says why', () => {
    const reason = htmlWriteRejection('docx')
    expect(reason).not.toBeNull()
    expect(reason).toMatch(/\.docx/)
  })

  it('refuses to store HTML on a fillable-PDF template and says why', () => {
    const reason = htmlWriteRejection('pdf-form')
    expect(reason).not.toBeNull()
    expect(reason).toMatch(/PDF/)
  })

  it('allows an HTML template to store HTML', () => {
    expect(htmlWriteRejection('html')).toBeNull()
  })

  it('allows a brand-new row with no type yet', () => {
    // editorSaveTemplate also creates templates; a create inserts type='html'.
    expect(htmlWriteRejection(undefined)).toBeNull()
    expect(htmlWriteRejection(null)).toBeNull()
  })
})

// The frontend half of JJ's source-drift guards (the fill modal and the editor
// must not branch on stored HTML) belongs to the frontend suite. The server
// half is behavioural here: tests/wordTemplates/wordTemplates.routes.test.ts
// proves PUT refuses HTML on a docx and a pdf-form row.
