import { z } from 'zod';

const repeaterSchema = z.object({
  name: z.string().min(1),
  fields: z.array(z.string()),
});

// A textbox placement's canonical mixed-formatting rich content: an array
// of paragraph blocks, each an array of styled runs. A run with fieldName
// set is a merge-field chip (resolved from values/repeater row data at fill
// time); text is then only an authoring-time fallback label for it. bold/
// italic/color are required (not "inherits the box") so a run is always
// unambiguous on its own.
const richTextRunSchema = z.object({
  text: z.string().max(500),
  fieldName: z.string().min(1).max(120).optional(),
  bold: z.boolean(),
  italic: z.boolean(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex value like #rrggbb'),
});
const richTextBlockSchema = z.object({
  bullet: z.boolean(),
  runs: z.array(richTextRunSchema).min(1).max(200),
});

const templateAssetSchema = z.object({
  id: z.string().min(1),
  objectPath: z.string().min(1),
  mimeType: z.string().min(1),
  fileName: z.string().optional().nullable(),
  width: z.number().finite().optional().nullable(),
  height: z.number().finite().optional().nullable(),
  source: z.string().optional().nullable(),
  previewUrl: z.string().optional().nullable(),
});

export const createTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required'),
    html: z.string().min(1, 'HTML content is required'),
    fields: z.array(z.string()),
    repeaters: z.array(repeaterSchema).optional(),
    assets: z.array(templateAssetSchema).optional(),
    folderId: z.string().optional().nullable(),
  }),
});

export const updateTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').optional(),
    html: z.string().min(1, 'HTML content is required').optional(),
    fields: z.array(z.string()).optional(),
    repeaters: z.array(repeaterSchema).optional(),
    assets: z.array(templateAssetSchema).optional(),
    folderId: z.string().optional().nullable(),
  }),
});

// Caps on a fill request. A repeater's rows each become a stamped row, and on
// an overlay template every `rowCount` of them is another copy of the anchor
// page held in memory until the document is saved, so an unbounded row list is
// an unbounded allocation. The overlay stamp also caps the total number of
// continuation pages (overlayFill.service.ts), since 500 rows at one row per
// page is still too many pages.
const FILL_MAX_VALUE_KEYS = 1000;
const FILL_MAX_REPEATERS = 50;
const FILL_MAX_ROWS_PER_REPEATER = 500;

const maxKeys = (limit: number) => (record: Record<string, unknown>) => Object.keys(record).length <= limit;

const fillValuesSchema = z.record(z.string(), z.string())
  .refine(maxKeys(FILL_MAX_VALUE_KEYS), { message: `A fill can carry at most ${FILL_MAX_VALUE_KEYS} field values` });

export const fillTemplateSchema = z.object({
  body: z.object({
    values: fillValuesSchema.optional().default({}),
    repeaterValues: z.record(
      z.string(),
      z.array(fillValuesSchema).max(
        FILL_MAX_ROWS_PER_REPEATER,
        `A repeater can have at most ${FILL_MAX_ROWS_PER_REPEATER} rows. Split the rows across more than one document.`,
      ),
    ).refine(maxKeys(FILL_MAX_REPEATERS), { message: `A fill can carry at most ${FILL_MAX_REPEATERS} repeaters` })
      .optional().default({}),
    format: z.enum(['pdf', 'docx', 'odt', 'rtf', 'txt']).optional().default('pdf'),
    // Which of the two things the caller is doing with the render. Preview
    // shows it in a tab, so its link has to be `inline`; Download saves it. An
    // allow-list rather than a free string, because the value reaches a
    // Content-Disposition the storage provider builds.
    disposition: z.enum(['inline', 'attachment']).optional().default('attachment'),
  }),
});

// The browser builds the filled HTML (values substituted into the template's
// markup) and the server renders it. Its size is checked in the service, which
// answers 413 with a message the user can act on rather than a schema error.
export const exportTemplatePdfSchema = z.object({
  body: z.object({
    html: z.string().min(1),
    fileName: z.string().max(200).optional(),
    disposition: z.enum(['inline', 'attachment']).optional().default('attachment'),
  }),
});

// ── field placements (Document Overlay templates) ──────────────────────
//
// A page-relative overlay box, modeled on signature_fields. x/y/width/height
// are percent-of-page (0-100), matching getFieldBox in signingFieldValues.ts.
// 'textbox' and 'image' don't bind to a merge field: richText/
// imageObjectPath are their literal, always-the-same-on-every-fill content.
// The style fields (font*, bold, italic, color, textAlign) apply to
// text/date/textbox placements; checkbox/image ignore them. helvetica/times/
// courier are pdf-lib's built-in fonts; the rest are real TTFs fontkit-
// embedded by overlayFill.service.ts (see backend/src/modules/templates/fonts).
//
// Geometry: x/y in [0, 100], width/height in (0, 100], and the box has to end
// on the page. The editor's clampPlacementBox (templateOverlayTypes.ts) keeps
// every box it produces inside these bounds; PAGE_EDGE_EPSILON absorbs the
// float drift of `100 - width` plus `width` not summing to exactly 100.
//
// imageObjectPath is length-checked here (GCS object names are at most 1024
// bytes); WHERE it points is checked in savePlacements, which knows the
// template it must belong to.
const PAGE_EDGE_EPSILON = 1e-6;
const NAME_MAX_LENGTH = 120;
const MAX_PLACEMENTS = 1000;
const MAX_REPEATERS = 50;
const MAX_ROWS_PER_PAGE = 100;

const placementInputSchema = z.object({
  fieldName: z.string().min(1, 'Field name is required').max(NAME_MAX_LENGTH, `Field name must be at most ${NAME_MAX_LENGTH} characters`),
  fieldType: z.enum(['text', 'date', 'checkbox', 'textbox', 'image']).optional().default('text'),
  page: z.number().int().min(1),
  xPercent: z.number().finite().min(0).max(100),
  yPercent: z.number().finite().min(0).max(100),
  widthPercent: z.number().finite().positive().max(100),
  heightPercent: z.number().finite().positive().max(100),
  repeaterName: z.string().min(1).max(NAME_MAX_LENGTH).optional().nullable(),
  repeaterRowIndex: z.number().int().min(0).optional().nullable(),
  sortOrder: z.number().int().optional().default(0),
  textContent: z.string().max(2000).optional().nullable(),
  richText: z.array(richTextBlockSchema).max(200).optional().nullable(),
  imageObjectPath: z.string().min(1).max(1024, 'Image path is too long').optional().nullable(),
  imageMimeType: z.string().min(1).max(100).optional().nullable(),
  fontSize: z.number().finite().positive().max(400).optional().nullable(),
  fontFamily: z.enum(['helvetica', 'times', 'courier', 'calibri', 'cambria', 'pt-serif', 'pt-sans']).optional().default('times'),
  bold: z.boolean().optional().default(false),
  italic: z.boolean().optional().default(false),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex value like #rrggbb').optional().default('#000000'),
  textAlign: z.enum(['left', 'center', 'right']).optional().default('left'),
  bulletList: z.boolean().optional().default(false),
}).refine(
  (placement) => (placement.repeaterName
    ? (placement.repeaterRowIndex ?? 0) === 0
    : placement.repeaterRowIndex == null),
  { message: 'repeaterRowIndex must be 0 for a repeater placement and omitted otherwise' },
).refine(
  (placement) => placement.fieldType !== 'textbox'
    || Boolean(placement.richText?.some((block) => block.runs.some((run) => run.fieldName || run.text.trim()))),
  { message: 'A text box placement needs rich text content' },
).refine(
  (placement) => placement.fieldType !== 'textbox' || (placement.richText ?? []).map((block) => block.runs.map((run) => run.fieldName ? `{${run.fieldName}}` : run.text).join('')).join('\n').length <= 2000,
  { message: 'A text box placement must be at most 2000 characters' },
).refine(
  (placement) => placement.fieldType !== 'image' || Boolean(placement.imageObjectPath),
  { message: 'An image placement needs an uploaded image' },
).refine(
  (placement) => placement.xPercent + placement.widthPercent <= 100 + PAGE_EDGE_EPSILON,
  { message: 'A placement must not run off the right edge of the page' },
).refine(
  (placement) => placement.yPercent + placement.heightPercent <= 100 + PAGE_EDGE_EPSILON,
  { message: 'A placement must not run off the bottom of the page' },
);

// Overlay-only layout metadata for a repeater; templates.repeaters keeps its
// existing { name, fields } shape and gains these four keys for overlay
// templates (see templates.service.ts's savePlacements). `fields` itself is
// NOT accepted here, since it's derived server-side from the placements that
// reference this repeater, so it can never drift from the placements table.
const overlayRepeaterMetaSchema = z.object({
  name: z.string().min(1, 'Repeater name is required').max(NAME_MAX_LENGTH),
  anchorPage: z.number().int().min(1),
  anchorYPercent: z.number().finite().min(0).lt(100),
  rowHeightPercent: z.number().finite().positive().max(100),
  // Rows per page. It sets how many continuation pages a fill copies.
  rowCount: z.number().int().min(1).max(MAX_ROWS_PER_PAGE),
});

export const savePlacementsSchema = z.object({
  body: z.object({
    placements: z.array(placementInputSchema).max(MAX_PLACEMENTS, `A layout can have at most ${MAX_PLACEMENTS} placements`),
    repeaters: z.array(overlayRepeaterMetaSchema).max(MAX_REPEATERS, `A layout can have at most ${MAX_REPEATERS} repeaters`)
      .optional().default([]),
  }),
  params: z.object({ lawFirmId: z.string(), templateId: z.string() }),
});
