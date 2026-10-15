// Shapes of the Word-first template library (`/api/lawfirms/:lawFirmId/word-templates`).
// Separate from `types/template.ts`: Word-first rows live in their own table and
// carry their own types (`html`, `docx`, `pdf-form`), never `overlay`.

export interface WordTemplateRepeater {
  name: string
  fields: string[]
}

/** What the fill form holds while the person is between screens. */
export interface WordTemplateFillDraft {
  values?: Record<string, string>
  repeaterValues?: Record<string, Record<string, string>[]>
  selectedCaseId?: string
  selectedClientId?: string
}

export interface WordTemplateAsset {
  id: string
  objectPath: string
  mimeType: string
  fileName?: string | null
  width?: number | null
  height?: number | null
  source?: string | null
  previewUrl?: string | null
}

export type WordTemplateType = 'html' | 'docx' | 'pdf-form'

/** One row of the library, as `GET /word-templates` lists it. */
export interface WordTemplate {
  id: string
  name: string
  type?: WordTemplateType
  fields: string[]
  repeaters?: WordTemplateRepeater[]
  folderId: string | null
  createdAt: string
}

/** One template as `GET /word-templates/:id` loads it for the editor and fill form. */
export interface WordTemplateWithHtml extends WordTemplate {
  html?: string
  docxStoragePath?: string | null
  originalFileName?: string | null
  assets?: WordTemplateAsset[]
}
