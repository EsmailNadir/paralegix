// Shapes shared by the template library modules.

export interface TemplateRepeater {
  name: string
  fields: string[]
}

export type WordTemplateType = 'html' | 'docx' | 'pdf-form'
