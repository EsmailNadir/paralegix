export interface TemplateRepeater {
  name: string;
  fields: string[];
  // Document Overlay only: where the authored row sits and how many slots it
  // repeats for. Absent for html/docx repeaters, which have no page geometry.
  anchorPage?: number;
  anchorYPercent?: number;
  rowHeightPercent?: number;
  rowCount?: number;
}

/** A field/repeater-column box placed on a Document Overlay template's PDF,
 *  as a percentage of the page it sits on. Mirrors `SignatureField` in
 *  `@/types/signature`, the same shape `signature_fields` uses.
 *  'textbox' and 'image' don't bind to a merge field: their content
 *  (`textContent` / `imageObjectPath`) is literal and stamped the same way
 *  on every filled document. */
export type TemplateFieldPlacementType = "text" | "date" | "checkbox" | "textbox" | "image";

/** helvetica/times/courier are pdf-lib's built-in fonts; calibri/cambria/
 *  pt-serif/pt-sans are real TTFs fontkit-embedded by the fill path (backend
 *  `overlayFill.service.ts`, fonts bundled in `backend/src/modules/templates/fonts`). */
export type TemplatePlacementFontFamily = "helvetica" | "times" | "courier" | "calibri" | "cambria" | "pt-serif" | "pt-sans";
export type TemplatePlacementTextAlign = "left" | "center" | "right";

/** Text styling shared by text/date/textbox placements (checkbox/image
 *  ignore it). `fontSize: null` keeps the historical auto-fit-to-box
 *  behavior placements had before styling existed. */
export interface TemplatePlacementStyle {
  fontSize: number | null;
  fontFamily: TemplatePlacementFontFamily;
  bold: boolean;
  italic: boolean;
  color: string;
  textAlign: TemplatePlacementTextAlign;
  /** Each non-blank line gets a bullet prefix before layout. A plain boolean
   *  rather than real list markup, since the placement's content is a single
   *  string, not HTML. */
  bulletList: boolean;
}

/** One styled span within a rich-text 'textbox' paragraph block. A run with
 *  `fieldName` set is a merge-field chip, resolved from the fill values (or,
 *  inside a repeater column, that row's own data first) at fill time:
 *  `text` is then only an authoring-time fallback label for it. bold/
 *  italic/color are always explicit (never "inherits the box"). */
export interface TemplateRichTextRun {
  text: string;
  fieldName?: string;
  bold: boolean;
  italic: boolean;
  color: string;
}

/** One paragraph of a 'textbox' placement's mixed-formatting rich content.
 *  `bullet` replaces the whole-placement `bulletList` for rich content: it's
 *  per-paragraph instead of per-box. */
export interface TemplateRichTextBlock {
  bullet: boolean;
  runs: TemplateRichTextRun[];
}

export interface TemplateFieldPlacement extends TemplatePlacementStyle {
  id: string;
  fieldName: string;
  fieldType: TemplateFieldPlacementType;
  page: number;
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  repeaterName: string | null;
  repeaterRowIndex: number | null;
  sortOrder: number;
  /** Plain value for text/date placements. Null for textboxes. */
  textContent: string | null;
  /** Canonical styled paragraph content for a textbox; null for other types. */
  richText: TemplateRichTextBlock[] | null;
  /** GCS object path + mime type for an 'image' placement. Null for other types. */
  imageObjectPath: string | null;
  imageMimeType: string | null;
  /** Signed preview URL for an 'image' placement's uploaded bytes, present
   *  whenever the server can sign one. Not persisted; re-derived per request. */
  imagePreviewUrl?: string | null;
}

/** What the editor sends on a full-replace save: no `id` (server assigns
 *  one) and `repeaterRowIndex` is always 0 when `repeaterName` is set, since
 *  the user authors exactly one row per repeater. */
export interface TemplateFieldPlacementInput extends Partial<TemplatePlacementStyle> {
  fieldName: string;
  fieldType?: TemplateFieldPlacementType;
  page: number;
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  repeaterName?: string | null;
  repeaterRowIndex?: number | null;
  sortOrder?: number;
  textContent?: string | null;
  richText?: TemplateRichTextBlock[] | null;
  imageObjectPath?: string | null;
  imageMimeType?: string | null;
}

/** Overlay-only repeater layout metadata for a save call. `fields` is never
 *  sent here: the server derives it from which placements reference this
 *  repeater by name, so it can never drift from the placements table. */
export interface TemplateOverlayRepeaterInput {
  name: string;
  anchorPage: number;
  anchorYPercent: number;
  rowHeightPercent: number;
  rowCount: number;
}

export interface TemplateFillDraft {
  values?: Record<string, string>;
  repeaterValues?: Record<string, Record<string, string>[]>;
  selectedMatterId?: string;
  selectedClientId?: string;
}

export interface TemplateAsset {
  id: string;
  objectPath: string;
  mimeType: string;
  fileName?: string | null;
  width?: number | null;
  height?: number | null;
  source?: string | null;
  previewUrl?: string | null;
}

export interface Template {
  id: string;
  name: string;
  type?: 'html' | 'docx' | 'overlay';
  fields: string[];
  repeaters?: TemplateRepeater[];
  folderId: string | null;
  createdAt: string;
}

export interface TemplateWithHtml extends Template {
  html?: string;
  docxStoragePath?: string | null;
  assets?: TemplateAsset[];
  // Document Overlay only, present once hydrated (getById or upload finalization).
  overlaySourceObjectPath?: string | null;
  overlayPdfObjectPath?: string | null;
  /** Signed, short-lived URL react-pdf renders the overlay canvas from. */
  overlayPdfUrl?: string | null;
}

export interface TemplateFolder {
  id: string;
  name: string;
  color: string | null;
  parentFolderId: string | null;
  order: number;
  createdAt: string;
}
