// The wire types of the Word-first upload scan: what `POST .../word-templates/detect`
// proposes, what `POST .../commit` accepts, and the client details the
// leftover check reports. The detection itself runs on the server
// (backend `modules/templates/wordFirst/auto-bracket/`); the browser only
// renders proposals and sends edits back, so only the shapes are kept here.

/** Which detection layer found a literal proposal. */
export type FieldCategory =
  // An authored `[LABEL]` blank: the firm's own marker, not a value shape.
  | 'marker'
  // A span the author highlighted as "replace me".
  | 'highlight'
  // Text that matches a value in the firm's own records.
  | 'known'
  // The value beside a caption label ("JUDGE: ...").
  | 'label'
  | 'case_number'
  | 'money'
  | 'date'
  | 'time'
  | 'email'
  | 'phone'
  | 'zip'

export type FormFieldControl = 'text' | 'checkbox'

export type PdfFormFieldKind = 'text' | 'checkbox'

/** A value SHAPE found in the document text: its edit is a find-and-replace. */
export type DetectedField = {
  kind: 'literal'
  /** Exact source text to bracket. */
  literal: string
  category: FieldCategory
  /** The placeholder name proposed for the {tag}. */
  suggestedTag: string
  /** True when suggestedTag is a canonical, auto-fillable vocabulary id. */
  canonical: boolean
  /** How many times the literal occurs across the whole document. */
  occurrences: number
  /** The paragraph the first occurrence sits in, shown in the review list. */
  contextSnippet: string
}

/** An empty Word form control: its edit is bound to the field's ordinal. */
export type DetectedFormField = {
  kind: 'formField'
  /** Ordinal among form fields in document order: how an edit binds to a field. */
  index: number
  /** Word's own name ("Text12"), re-checked server-side to catch a stale scan. */
  wordName: string | null
  control: FormFieldControl
  suggestedTag: string
  canonical: boolean
  /** Document text immediately before the blank, for the reviewer to read. */
  contextBefore: string
  /** Document text immediately after the blank. */
  contextAfter: string
}

/**
 * A fillable-PDF (AcroForm) field. The PDF names its own fields, so the name is
 * the context, and the binding key is the name itself.
 */
export type DetectedPdfField = {
  kind: 'pdfField'
  /** The field's current name inside the PDF: how the edit binds to it. */
  pdfName: string
  control: PdfFormFieldKind
  suggestedTag: string
  canonical: boolean
}

/** A schedule of repeating rows that would become one loop. */
export type DetectedRepeater = {
  kind: 'repeater'
  /** Ordinal among the blocks in this document: how an edit binds to one. */
  index: number
  /** Loop tag name: {#payments} ... {/payments}. */
  suggestedTag: string
  /** Per-row field names, in the order their values appear in the row. */
  fields: string[]
  /** The rows as they read now, for the review list. */
  rowTexts: string[]
  /** The row rendered with its tags: what the loop body will say. */
  rowTemplate: string
  /** True when the field names are canonical, auto-filling vocabulary ids. */
  canonical: boolean
}

export type TemplateFieldProposal =
  | DetectedField
  | DetectedFormField
  | DetectedPdfField
  | DetectedRepeater

export type BracketEdit =
  | { kind: 'literal'; find: string; tag: string }
  | { kind: 'repeater'; index: number; name: string; fields: string[] }
  | { kind: 'formField'; index: number; wordName: string | null; tag: string }
  | { kind: 'pdfField'; pdfName: string; tag: string }

/** Where in the document a leftover client detail was found. */
export type LeftoverPart =
  | 'body'
  | 'header'
  | 'footer'
  | 'footnote'
  | 'comment'
  | 'deleted'
  | 'field'
  | 'properties'

/** A known client's detail still written into a template about to be stored. */
export type LeftoverClientText = {
  /** As the document spells it. */
  literal: string
  canonicalId: string
  occurrences: number
  /** The line the first occurrence sits in. */
  contextSnippet: string
  parts: LeftoverPart[]
}
