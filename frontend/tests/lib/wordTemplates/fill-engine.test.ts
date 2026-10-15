import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveFillEngine, htmlWriteRejection } from '@/lib/wordTemplates/fill-engine'

// WHY (Rule 9): `templates.type` and the `templates.html` column disagreed
// about which engine owns a Word template's content, and the fill path trusted
// the column. The positional editor converted a .docx to HTML on open and
// stored it on the row without changing the row's type, so a single visit
// moved that template onto html-to-docx permanently, which is what produced
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
    // column is not an input to this decision at all, hence no html argument.
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

// Source-drift guards. The pure function above can be correct while a call site
// quietly reintroduces the html-column branch, that is exactly how the bug
// survived a fix to its entrance (commit d2dcfdd closed the editor's
// convert-on-open path but left the dispatcher reading the column). These read
// the real files so a reintroduction fails here rather than in a client's
// downloaded document.
const ROOT = process.cwd()
const COMPONENTS = 'src/components/wordTemplates'

describe('fill dispatch call sites', () => {
  it('does not branch the fill path on the html column', () => {
    const modal = readFileSync(
      join(ROOT, COMPONENTS, 'FillTemplateModal.tsx'),
      'utf8',
    )
    expect(modal).toContain('resolveFillEngine(template.type)')
    // `usesEditableHtml` was the flag that made a stale column win.
    expect(modal).not.toContain('usesEditableHtml')
  })

  it('keeps the editor from opening a Word template on its stored HTML', () => {
    const editor = readFileSync(join(ROOT, COMPONENTS, 'TemplateEditor.tsx'), 'utf8')
    // A docx row goes straight to the read-only setup pane; there is no
    // `if (t.html)` branch handing it to the editable canvas.
    expect(editor).toMatch(/if \(t\.type === "docx"\) \{[\s\S]{0,1600}?openDocxSetupFallback\(t\);/)
    expect(editor).not.toContain('setExportHtml(chipifyPlaceholdersInHtml(t.html))')
  })
})
