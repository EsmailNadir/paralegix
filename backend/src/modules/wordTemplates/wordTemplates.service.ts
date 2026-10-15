/**
 * The Word-first template library (ported from the JJ portal's templates
 * server actions and route handlers).
 *
 * Three template types, decided once and never changed:
 *   - docx: an uploaded Word file, stored byte for byte and filled in place by
 *     docxtemplater, so its formatting survives;
 *   - pdf-form: an uploaded fillable PDF whose form fields are renamed to the
 *     chosen tags and filled in place;
 *   - html: authored in the editor, its body kept in storage.
 * HTML is never written onto a docx or pdf-form row (`htmlWriteRejection`).
 *
 * Refusals keep JJ's exact sentences, because the review dialog shows them.
 * Every read and write is scoped to the caller's firm.
 */
import { randomUUID } from 'crypto';
import PizZip from 'pizzip';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/AppError';
import { settleDirectUpload, beginDirectUpload } from '../../shared/storage/directUpload';
import { renderHtmlToStoredPdf } from '../../shared/documentConversion/pdfRenderer';
import { EXPORT_HTML_MAX_BYTES } from '../../shared/documentConversion/htmlPdf';
import { isConversionBusy } from '../../shared/documentConversion/scratchSource';
import {
  buildFlatFieldList as buildFlatFieldListDocx,
  docxFieldColumns,
  fillDocxTemplate,
  parseDocxPlaceholders,
} from './lib/docx';
import { applyOps, documentText, type TagOp } from './lib/placeholderize-core';
import { detectFields } from './lib/auto-bracket/detect-patterns';
import { detectHighlightedFields } from './lib/auto-bracket/detect-highlights';
import { detectLabelledFields } from './lib/auto-bracket/detect-labels';
import { mergeLiteralProposals } from './lib/auto-bracket/merge';
import {
  detectRepeaters,
  isConsumedByRepeaters,
  type DetectedRepeater,
} from './lib/auto-bracket/detect-repeaters';
import {
  buildKnownValueIndex,
  detectKnownValues,
  nameWithKnownValues,
} from './lib/auto-bracket/known-values';
import {
  applyFormFieldOps,
  formFieldReplacementRun,
  FormFieldScanError,
  maskFormFields,
  scanFormFields,
} from './lib/auto-bracket/form-fields';
import {
  buildFormFieldProposals,
  buildPdfFieldProposals,
  type BracketEdit,
  type TemplateFieldProposal,
} from './lib/auto-bracket/proposals';
import { fillPdfForm, PdfFormError, readPdfFormFields, renamePdfFormFields } from './lib/pdf-form';
import {
  buildFlatFieldList as buildFlatFieldListHtml,
  extractPlaceholders,
  extractRepeaters,
} from './lib/placeholders';
import { htmlWriteRejection } from './lib/fill-engine';
import { prepareHtmlForDocx } from './lib/docx-html';
import { uniqueCopyName } from './lib/duplicates';
import { assembleFirmKnownValues } from './lib/firm-known-values';
import type { WordTemplateType } from './lib/types';
import * as repo from './wordTemplates.repository';
import { loadFirmKnownValueRows } from './knownValues.repository';
import { assertNoLeftoverClientText, readDocxTextParts, readPdfTextParts, MAX_DOCX_XML_BYTES } from './clientTextGuard';
import { duplicateRefusal } from './wordTemplates.errors';
import * as storage from './wordTemplates.storage';

const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { sanitizeTemplateHtml } = require('../../shared/utils/htmlSanitizer');
const { withTemplateFillSlot, withTemplateExportSlot, withPersonRenderCap } = require('../templates/templateFillSlot');

// ── limits and grammar (JJ's values) ─────────────────────────────────────────

// Placeholder names start with a letter or underscore and are dotted
// alphanumerics: the tag grammar the fill engine parses.
const PLACEHOLDER_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*$/;
// Commit does one whole-document pass per edit, so both the edit count and each
// source span are bounded. A real document has a few dozen fields.
const MAX_BRACKET_EDITS = 500;
const MAX_FIND_LENGTH = 500;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_NAME_LENGTH = 200;
const MAX_EXPORT_HTML_BYTES = 2_000_000;

// Raster images only. An SVG can carry script, and these images are served
// back into the editor, so accepting one would be a stored-XSS vector.
const IMAGE_MIME_ALLOWLIST = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
// Group 1 stops BEFORE `src=` so the replacement leaves no dangling `src=`.
const IMG_DATA_URL_RE = /<img\b([^>]*\b)src=["']data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)["']([^>]*)>/gi;

type Ctx = { lawFirmId: string; userId: string };

/** A JJ `{ ok: false, error }` refusal, as the 400 the browser shows verbatim. */
const refuse = (message: string) => new ValidationError(message);

function extFromMime(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'bin';
}

const isPdfName = (fileName: string) => fileName.toLowerCase().endsWith('.pdf');
const isDocxName = (fileName: string) => fileName.toLowerCase().endsWith('.docx');

/** The name the caller gave, else the file name without its extension, else "Untitled". */
function baseNameFor(fileName: string, name?: string | null): string {
  const given = (name ?? '').trim().slice(0, MAX_NAME_LENGTH);
  if (given) return given;
  return fileName.replace(/\.[^.]+$/, '').trim().slice(0, MAX_NAME_LENGTH) || 'Untitled';
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 100) || 'template';
}

async function getTemplateOr404(lawFirmId: string, templateId: string) {
  const row = await repo.findWordTemplate(lawFirmId, templateId);
  if (!row) throw new NotFoundError('Template');
  return row;
}

// ── shaping ──────────────────────────────────────────────────────────────────

/** What the editor loads: the library row plus its body and image previews. */
async function editorShape(row: repo.WordTemplateRow, html?: string | null) {
  let body: string | null = null;
  if (row.type === 'html' && row.htmlObjectPath) {
    body = html ?? (await storage.readObject(row.htmlObjectPath, MAX_HTML_BYTES * 2)).toString('utf8');
  }
  const assets = await Promise.all(repo.rowAssets(row).map(async (a) => ({
    id: a.id,
    objectPath: a.object_path,
    mimeType: a.mime_type,
    fileName: a.file_name ?? null,
    previewUrl: await storage.signAssetUrl(a.object_path),
  })));
  return {
    ...repo.formatWordTemplate(row),
    html: body,
    docxStoragePath: row.sourceObjectPath ?? null,
    assets,
  };
}

// ── uploads ──────────────────────────────────────────────────────────────────

/**
 * Open a direct upload. `source` takes a .docx or .pdf template file,
 * `convert` a .docx to turn into a PDF, `asset` an editor image for an
 * existing template of this firm.
 */
export async function openUpload({
  lawFirmId, userId, fileName, contentType, size, purpose, templateId, origin,
}: Ctx & {
  fileName: string; contentType?: string; size?: number; purpose: 'source' | 'asset' | 'convert';
  templateId?: string; origin?: string;
}) {
  await assertLawFirmMembership(lawFirmId, userId);
  if (purpose === 'asset') {
    if (!templateId) throw refuse('Missing or invalid templateId.');
    await getTemplateOr404(lawFirmId, templateId);
    const type = String(contentType || '').toLowerCase();
    return beginDirectUpload({
      objectPath: storage.newUploadPath(lawFirmId, userId, 'asset', extFromMime(type), templateId),
      contentType: type,
      uploadedBy: userId,
      maxBytes: storage.MAX_ASSET_BYTES,
      allowedContentTypes: IMAGE_MIME_ALLOWLIST,
      fileName,
      declaredSize: size,
      origin,
      metadata: { lawFirmId, templateId, wordTemplateAsset: 'true' },
    });
  }
  if (purpose === 'convert' && !isDocxName(fileName)) throw refuse('Only .docx files can be converted.');
  if (purpose === 'source' && !isDocxName(fileName) && !isPdfName(fileName)) {
    throw refuse('Only .docx and .pdf files are accepted.');
  }
  const ext = isPdfName(fileName) ? 'pdf' : 'docx';
  return beginDirectUpload({
    objectPath: storage.newUploadPath(lawFirmId, userId, purpose, ext),
    contentType: String(contentType || (ext === 'pdf' ? storage.PDF_CONTENT_TYPE : storage.DOCX_CONTENT_TYPE)),
    uploadedBy: userId,
    maxBytes: storage.MAX_SOURCE_BYTES,
    tooLargeMessage: () => 'File too large (max 50 MB).',
    fileName,
    declaredSize: size,
    origin,
    metadata: { lawFirmId, wordTemplateUpload: purpose },
  });
}

/** Settle the caller's own upload and read it whole. */
async function readUpload(
  { lawFirmId, userId }: Ctx,
  objectPath: string,
  fileName: string,
  opts: { templateId?: string; maxBytes?: number; allowedContentTypes?: string[] } = {},
) {
  storage.assertOwnUpload(lawFirmId, userId, objectPath, opts.templateId);
  const maxBytes = opts.maxBytes ?? storage.MAX_SOURCE_BYTES;
  const settled = await settleDirectUpload({
    objectPath,
    uploadedBy: userId,
    maxBytes,
    tooLargeMessage: () => 'File too large (max 50 MB).',
    allowedContentTypes: opts.allowedContentTypes,
    fileName,
  });
  if (settled.size === 0) throw refuse('File is empty.');
  const buffer = await storage.readObject(objectPath, maxBytes);
  return { buffer, settled };
}

async function readDocxUpload(ctx: Ctx, objectPath: string, fileName: string) {
  if (!isDocxName(fileName)) throw refuse('Only .docx files are accepted.');
  return (await readUpload(ctx, objectPath, fileName)).buffer;
}

async function readPdfUpload(ctx: Ctx, objectPath: string, fileName: string) {
  if (!isPdfName(fileName)) throw refuse('Only .pdf files are accepted.');
  return (await readUpload(ctx, objectPath, fileName)).buffer;
}

// ── Word body ────────────────────────────────────────────────────────────────

/**
 * Open a .docx and return its zip and body XML. The body size declared in the
 * zip's directory is a cheap early refusal; the inflated length is the real
 * guard against a zip bomb.
 */
function openDocxBody(buffer: Buffer): { zip: PizZip; bodyXml: string } {
  let zip: PizZip;
  try {
    zip = new PizZip(buffer);
  } catch {
    throw refuse('Not a valid Word document.');
  }
  const entry = zip.file('word/document.xml');
  if (!entry) throw refuse('Not a valid Word document (missing document.xml).');
  const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof declared === 'number' && declared > MAX_DOCX_XML_BYTES) {
    throw refuse('Document body is too large to process.');
  }
  let bodyXml: string;
  try {
    bodyXml = entry.asText();
  } catch (err) {
    throw refuse(`Failed to read DOCX: ${err instanceof Error ? err.message : 'Unknown DOCX read error.'}`);
  }
  if (bodyXml.length > MAX_DOCX_XML_BYTES) throw refuse('Document body is too large to process.');
  return { zip, bodyXml };
}

function parseOrRefuse(buffer: Buffer, prefix: string) {
  try {
    return parseDocxPlaceholders(buffer);
  } catch (err) {
    throw refuse(`${prefix}: ${err instanceof Error ? err.message : 'Unknown DOCX parse error.'}`);
  }
}

// Re-render a detected block's row with the column names the reviewer chose.
// Positional, so renaming two columns to each other's names cannot clobber one.
function buildRepeaterRowTemplate(block: DetectedRepeater, fields: readonly string[]): string {
  let i = 0;
  return block.rowTemplate.replace(/\{[^}]+\}/g, () => `{${fields[i++] ?? ''}}`);
}

// ── detect ───────────────────────────────────────────────────────────────────

/**
 * Inspect an upload and propose what to bracket. Writes nothing; the caller
 * reviews the proposals and commits. A .pdf goes to the form-field scan.
 */
export async function detect({
  lawFirmId, userId, objectPath, fileName,
}: Ctx & { objectPath: string; fileName: string }): Promise<{ proposals: TemplateFieldProposal[] }> {
  await assertLawFirmMembership(lawFirmId, userId);
  const ctx = { lawFirmId, userId };

  if (isPdfName(fileName)) {
    const buffer = await readPdfUpload(ctx, objectPath, fileName);
    let fields;
    try {
      fields = await readPdfFormFields(buffer);
    } catch (err) {
      if (err instanceof PdfFormError) throw refuse(err.message);
      throw err;
    }
    if (fields.length === 0) {
      throw refuse(
        'This PDF has no fillable form fields, so there is nothing to name. Rebuild it as a Word document and upload that instead.',
      );
    }
    if (fields.length > MAX_BRACKET_EDITS) {
      throw refuse(`This PDF has ${fields.length} fields (max ${MAX_BRACKET_EDITS}).`);
    }
    return { proposals: buildPdfFieldProposals(fields) };
  }

  const buffer = await readDocxUpload(ctx, objectPath, fileName);
  const body = openDocxBody(buffer);

  let spans;
  try {
    spans = scanFormFields(body.bodyXml);
  } catch (err) {
    if (err instanceof FormFieldScanError) throw refuse(err.message);
    throw err;
  }
  // Refuse rather than truncate: reviewing 500 of 900 fields would strand the
  // rest with no signal that they were dropped.
  if (spans.length > MAX_BRACKET_EDITS) {
    throw refuse(`This document has ${spans.length} form fields (max ${MAX_BRACKET_EDITS}).`);
  }

  // Mask the form fields first so the two proposal sets are disjoint: a filled
  // field's value is offered once, as the field.
  const maskedXml = spans.length > 0 ? maskFormFields(body.bodyXml, spans) : body.bodyXml;
  const text = documentText(maskedXml);
  // The caller's firm only, read for this request and never cached.
  const known = buildKnownValueIndex(assembleFirmKnownValues(await loadFirmKnownValueRows(lawFirmId)));

  // Strongest signal first; the firm's records name what the layers locate.
  const highlighted = nameWithKnownValues(detectHighlightedFields(maskedXml), known);
  const knownHits = detectKnownValues(text, known);
  const labelled = nameWithKnownValues(detectLabelledFields(text), known);
  const shaped = nameWithKnownValues(detectFields(text), known);
  const literals = mergeLiteralProposals([highlighted, knownHits, labelled, shaped]);

  // A schedule is a loop, proposed separately, and it consumes its rows.
  const repeaters = detectRepeaters(text);
  const standalone = literals.filter((f) => !isConsumedByRepeaters(f.literal, text, repeaters));

  return { proposals: [...buildFormFieldProposals(body.bodyXml, spans), ...repeaters, ...standalone] };
}

// ── commit (.docx) ───────────────────────────────────────────────────────────

function parseEdits(raw: unknown): BracketEdit[] {
  if (raw === undefined || raw === null) return [];
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw refuse('Invalid bracket edits.');
    }
  }
  if (!Array.isArray(parsed)) throw refuse('Invalid bracket edits.');
  return parsed as BracketEdit[];
}

/** Apply the accepted edits to the upload's body; returns the bytes to store. */
function rewriteDocx(buffer: Buffer, edits: BracketEdit[]): { rewritten: Buffer; fieldTags: string[] } {
  if (edits.length === 0) return { rewritten: buffer, fieldTags: [] };
  if (edits.length > MAX_BRACKET_EDITS) throw refuse(`Too many bracket edits (max ${MAX_BRACKET_EDITS}).`);

  const literalEdits: Array<{ find: string; tag: string }> = [];
  const repeaterEdits: Array<{ index: number; name: string; fields: string[] }> = [];
  const fieldEdits: Array<{ index: number; wordName: string | null; tag: string }> = [];
  const seenFind = new Set<string>();
  const seenIndex = new Set<number>();
  const seenRepeater = new Set<number>();

  for (const e of edits as any[]) {
    if (e && e.kind === 'repeater') {
      if (!Number.isInteger(e.index) || e.index < 0) throw refuse('A schedule edit has no valid position.');
      if (seenRepeater.has(e.index)) throw refuse('The same schedule was bracketed twice.');
      if (typeof e.name !== 'string' || !PLACEHOLDER_NAME_RE.test(e.name)) {
        throw refuse(`Invalid schedule name: "${e.name ?? ''}".`);
      }
      if (!Array.isArray(e.fields) || e.fields.length === 0) throw refuse('A schedule edit has no columns.');
      for (const f of e.fields) {
        if (typeof f !== 'string' || !PLACEHOLDER_NAME_RE.test(f)) throw refuse(`Invalid column name: "${String(f)}".`);
      }
      seenRepeater.add(e.index);
      repeaterEdits.push({ index: e.index, name: e.name, fields: e.fields });
      continue;
    }
    if (!e || typeof e.tag !== 'string' || !PLACEHOLDER_NAME_RE.test(e.tag)) {
      throw refuse(`Invalid field name: "${e?.tag ?? ''}".`);
    }
    if (e.kind === 'literal') {
      if (typeof e.find !== 'string' || e.find.length === 0) throw refuse('A bracket edit is missing its source text.');
      if (e.find.length > MAX_FIND_LENGTH) throw refuse('A bracket source span is too long.');
      // A duplicate find would be silently consumed by the first op.
      if (seenFind.has(e.find)) throw refuse(`The same text was bracketed twice: "${e.find}".`);
      seenFind.add(e.find);
      literalEdits.push({ find: e.find, tag: e.tag });
    } else if (e.kind === 'formField') {
      if (!Number.isInteger(e.index) || e.index < 0) throw refuse('A form field edit has no valid position.');
      if (seenIndex.has(e.index)) throw refuse('The same form field was bracketed twice.');
      seenIndex.add(e.index);
      fieldEdits.push({ index: e.index, wordName: typeof e.wordName === 'string' ? e.wordName : null, tag: e.tag });
    } else {
      throw refuse('Unrecognised bracket edit.');
    }
    // Duplicate TAGS are allowed: two blanks named {client_name} both fill.
  }

  const body = openDocxBody(buffer);
  let rewritten: Buffer;
  try {
    let xml = body.bodyXml;

    // Form fields first, by byte range re-derived from this server's own scan.
    if (fieldEdits.length > 0) {
      const spans = scanFormFields(xml);
      for (const fe of fieldEdits) {
        const span = spans[fe.index];
        if (!span || (fe.wordName !== null && span.name !== null && fe.wordName !== span.name)) {
          throw refuse('This document changed since it was scanned: upload it again.');
        }
      }
      xml = applyFormFieldOps(xml, fieldEdits.map((fe) => ({
        span: spans[fe.index],
        xml: formFieldReplacementRun(spans[fe.index], `{${fe.tag}}`),
      })));
    }

    // Schedules before literals, so a loop claims its rows before a literal op
    // can rewrite every row's amount. Blocks are re-derived from the same
    // masked text detect scanned, so an ordinal means the same block on both sides.
    if (repeaterEdits.length > 0) {
      const scanned = scanFormFields(body.bodyXml);
      const blocks = detectRepeaters(
        documentText(scanned.length > 0 ? maskFormFields(body.bodyXml, scanned) : body.bodyXml),
      );
      const loopOps: TagOp[] = [];
      for (const re of repeaterEdits) {
        const block = blocks[re.index];
        if (!block || block.fields.length !== re.fields.length) {
          throw refuse('This document changed since it was scanned: upload it again.');
        }
        loopOps.push({
          loop: {
            name: re.name,
            firstRowMatch: block.rowTexts[0],
            rowTemplate: buildRepeaterRowTemplate(block, re.fields),
            deleteRowMatches: block.rowTexts.slice(1),
          },
        });
      }
      const applied = applyOps(xml, loopOps);
      if (applied.missed.length > 0) {
        throw refuse(
          "Couldn't bracket the repeating rows: the schedule wasn't found where it was scanned. Upload the document again.",
        );
      }
      xml = applied.xml;
    }

    if (literalEdits.length > 0) {
      // Longest first, and only where a literal stands alone, so an accepted
      // "$500" never corrupts a "$500.00" elsewhere.
      const ops = [...literalEdits]
        .sort((a, b) => b.find.length - a.find.length)
        .map((e) => ({ find: e.find, tag: `{${e.tag}}` }));
      const applied = applyOps(xml, ops, { wholeToken: true });
      if (applied.missed.length > 0) {
        const names = applied.missed.map((op) => ('find' in op ? `"${op.find}"` : op.loop.name)).join(', ');
        throw refuse(
          `Couldn't bracket ${names}: the text wasn't found as a standalone value, or it sat inside a form field you also replaced. Edit the document or deselect it.`,
        );
      }
      xml = applied.xml;
    }

    body.zip.file('word/document.xml', xml);
    rewritten = body.zip.generate({ type: 'nodebuffer' }) as Buffer;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof FormFieldScanError) throw refuse(err.message);
    throw refuse(`Failed to bracket DOCX: ${err instanceof Error ? err.message : 'Unknown DOCX rewrite error.'}`);
  }

  // A range op cannot "miss", so confirm with the fill engine's own parser that
  // every accepted form field became a readable tag.
  if (fieldEdits.length > 0) {
    let placed: Set<string>;
    try {
      placed = new Set(parseDocxPlaceholders(rewritten).fields);
    } catch (err) {
      throw refuse(`Failed to read the bracketed DOCX: ${err instanceof Error ? err.message : 'Unknown DOCX parse error.'}`);
    }
    const missing = [...new Set(fieldEdits.map((f) => f.tag))].filter((t) => !placed.has(t));
    if (missing.length > 0) {
      throw refuse(
        `Couldn't bracket ${missing.map((m) => `"${m}"`).join(', ')}: the form field was replaced but the tag isn't readable. Upload the document again.`,
      );
    }
  }
  return { rewritten, fieldTags: fieldEdits.map((f) => f.tag) };
}

/** True when the error is the same-name unique index refusing the insert. */
function isSameNameViolation(error: any): boolean {
  const e = error?.code === '23505' ? error : error?.cause;
  return e?.code === '23505' && String(e?.constraint || '').includes('word_templates_firm_type_name_key');
}

/**
 * Store a new source-backed template. The object is written first and removed
 * again if the row cannot be inserted, so a failed insert leaves nothing behind.
 */
async function persistSourceTemplate(
  { lawFirmId, userId }: Ctx,
  { type, name, buffer, fields, repeaters, originalFileName, duplicateMessage }: {
    type: 'docx' | 'pdf-form'; name: string; buffer: Buffer; fields: string[];
    repeaters: repo.StoredRepeater[]; originalFileName: string; duplicateMessage: (name: string) => string;
  },
) {
  const templateId = randomUUID();
  const path = storage.sourceObjectPath(lawFirmId, templateId, type === 'docx' ? 'docx' : 'pdf');
  await storage.saveObject(lawFirmId, path, buffer, type === 'docx' ? storage.DOCX_CONTENT_TYPE : storage.PDF_CONTENT_TYPE);
  let row: repo.WordTemplateRow;
  try {
    row = await repo.insertWordTemplate(lawFirmId, {
      id: templateId,
      name,
      type,
      sourceObjectPath: path,
      originalFileName: originalFileName.slice(0, 255),
      fields,
      repeaters,
      assets: [],
      createdBy: userId,
    });
  } catch (error) {
    await storage.deleteObjects(lawFirmId, [path]);
    // Two concurrent uploads of one name: the index let only one through.
    if (isSameNameViolation(error)) {
      const existing = await repo.findSameNameTemplate(lawFirmId, name, type);
      if (existing) throw duplicateRefusal(duplicateMessage(name), { id: existing.id, name });
    }
    throw error;
  }
  return row;
}

/**
 * Point a source-backed template at new bytes, crash-safe: write a new
 * versioned object, repoint the row, and only then delete the old object.
 */
async function replaceSource(
  { lawFirmId }: Ctx,
  row: repo.WordTemplateRow,
  { buffer, fields, repeaters, originalFileName }: {
    buffer: Buffer; fields: string[]; repeaters?: repo.StoredRepeater[]; originalFileName: string;
  },
) {
  const ext = row.type === 'pdf-form' ? 'pdf' : 'docx';
  const newPath = storage.sourceObjectPath(lawFirmId, row.id, ext, randomUUID());
  await storage.saveObject(lawFirmId, newPath, buffer, ext === 'pdf' ? storage.PDF_CONTENT_TYPE : storage.DOCX_CONTENT_TYPE);
  let updated: repo.WordTemplateRow | null;
  try {
    updated = await repo.updateWordTemplate(lawFirmId, row.id, {
      fields,
      ...(repeaters ? { repeaters } : {}),
      sourceObjectPath: newPath,
      originalFileName: originalFileName.slice(0, 255),
    });
  } catch (error) {
    await storage.deleteObjects(lawFirmId, [newPath]);
    throw error;
  }
  // Zero rows: the template was deleted since it was read. Drop the new object.
  if (!updated) {
    await storage.deleteObjects(lawFirmId, [newPath]);
    throw refuse('That template no longer exists.');
  }
  if (row.sourceObjectPath && row.sourceObjectPath !== newPath) {
    await storage.deleteObjects(lawFirmId, [row.sourceObjectPath]);
  }
  return updated;
}

const docxDuplicateMessage = (name: string) => `A template named “${name}” already exists.`;
const pdfDuplicateMessage = (name: string) => `A PDF template named "${name}" already exists.`;

/**
 * Resolve the same-name decision for a source template. Returns the row to
 * replace, or the name to insert under; throws the chooser refusal when the
 * caller has not decided yet.
 */
async function resolveSameName(
  lawFirmId: string,
  type: 'docx' | 'pdf-form',
  baseName: string,
  strategy: 'copy' | 'replace' | null | undefined,
): Promise<{ replace: repo.WordTemplateRow } | { name: string }> {
  const existing = await repo.findSameNameTemplate(lawFirmId, baseName, type);
  if (!existing) return { name: baseName };
  if (strategy === 'replace') return { replace: existing };
  if (strategy === 'copy') {
    // Checked against templates of the SAME type, as the unique index is.
    const name = await uniqueCopyName(baseName, async (candidate) =>
      Boolean(await repo.findSameNameTemplate(lawFirmId, candidate, type)));
    return { name };
  }
  const message = type === 'docx' ? docxDuplicateMessage(baseName) : pdfDuplicateMessage(baseName);
  throw duplicateRefusal(message, { id: existing.id, name: baseName });
}

async function storedResult(row: repo.WordTemplateRow, created: boolean) {
  return {
    status: created ? 201 : 200,
    body: {
      message: created ? 'Template created successfully' : 'Template updated successfully',
      templateId: row.id,
      template: await editorShape(row),
    },
  };
}

/**
 * Store a reviewed upload as a template: a .docx with its accepted brackets
 * applied, or a fillable PDF with its accepted field names. On a same-name
 * clash the caller chooses Replace or Save as a copy; while a firm client's
 * details would stay in the file, the caller must acknowledge each one.
 */
export async function commit({
  lawFirmId, userId, objectPath, fileName, name, edits, duplicateStrategy, acknowledgedLeftovers,
}: Ctx & {
  objectPath: string; fileName: string; name?: string; edits?: unknown;
  duplicateStrategy?: 'copy' | 'replace' | null; acknowledgedLeftovers?: string[];
}) {
  await assertLawFirmMembership(lawFirmId, userId);
  const ctx = { lawFirmId, userId };
  const result = isPdfName(fileName)
    ? await commitPdf(ctx, { objectPath, fileName, name, edits, duplicateStrategy, acknowledgedLeftovers })
    : await commitDocx(ctx, { objectPath, fileName, name, edits, duplicateStrategy, acknowledgedLeftovers });
  await storage.discardUpload(objectPath);
  return result;
}

type CommitInput = {
  objectPath: string; fileName: string; name?: string; edits?: unknown;
  duplicateStrategy?: 'copy' | 'replace' | null; acknowledgedLeftovers?: string[];
};

async function commitDocx(ctx: Ctx, input: CommitInput) {
  const uploaded = await readDocxUpload(ctx, input.objectPath, input.fileName);
  const edits = parseEdits(input.edits);
  const { rewritten } = rewriteDocx(uploaded, edits);
  const baseName = baseNameFor(input.fileName, input.name);

  // Scanned on the REWRITTEN bytes: what is actually stored.
  const storedParts = readDocxTextParts(rewritten);
  await assertNoLeftoverClientText({
    ...ctx,
    stored: storedParts,
    uploaded: rewritten === uploaded ? storedParts : readDocxTextParts(uploaded),
    acknowledged: input.acknowledgedLeftovers,
  });

  const parsed = parseOrRefuse(rewritten, 'Failed to read DOCX');
  const decision = await resolveSameName(ctx.lawFirmId, 'docx', baseName, input.duplicateStrategy);
  if ('replace' in decision) {
    const row = await replaceSource(ctx, decision.replace, {
      buffer: rewritten,
      fields: buildFlatFieldListDocx(parsed),
      repeaters: parsed.repeaters,
      originalFileName: input.fileName,
    });
    return storedResult(row, false);
  }
  const row = await persistSourceTemplate(ctx, {
    type: 'docx',
    name: decision.name,
    buffer: rewritten,
    fields: buildFlatFieldListDocx(parsed),
    repeaters: parsed.repeaters,
    originalFileName: input.fileName,
    duplicateMessage: docxDuplicateMessage,
  });
  return storedResult(row, true);
}

async function commitPdf(ctx: Ctx, input: CommitInput) {
  const uploaded = await readPdfUpload(ctx, input.objectPath, input.fileName);
  const edits = parseEdits(input.edits);
  if (edits.length > MAX_BRACKET_EDITS) throw refuse(`Too many field names (max ${MAX_BRACKET_EDITS}).`);

  const mapping: Record<string, string> = {};
  const seenSource = new Set<string>();
  const seenTag = new Set<string>();
  for (const e of edits as any[]) {
    if (!e || e.kind !== 'pdfField') throw refuse('Unrecognised field edit.');
    if (typeof e.pdfName !== 'string' || e.pdfName.length === 0) throw refuse('A field edit is missing its source field.');
    if (typeof e.tag !== 'string' || !PLACEHOLDER_NAME_RE.test(e.tag)) throw refuse(`Invalid field name: "${e?.tag ?? ''}".`);
    if (seenSource.has(e.pdfName)) throw refuse(`The same field was named twice: "${e.pdfName}".`);
    // A tag becomes the field's name inside the PDF, and two fields sharing a
    // name fill from one value and silently merge.
    if (seenTag.has(e.tag)) throw refuse(`Two fields would both be named "${e.tag}". Give each its own name.`);
    seenSource.add(e.pdfName);
    seenTag.add(e.tag);
    mapping[e.pdfName] = e.tag;
  }

  let stored: Buffer;
  let fieldNames: string[];
  try {
    const present = new Set((await readPdfFormFields(uploaded)).map((f) => f.name));
    if (Object.keys(mapping).some((n) => !present.has(n))) {
      throw refuse('This PDF changed since it was scanned: upload it again.');
    }
    stored = Buffer.from(await renamePdfFormFields(uploaded, mapping));
    // Every field stays fillable, renamed or not, so all of them are fields.
    fieldNames = (await readPdfFormFields(stored)).map((f) => f.name);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof PdfFormError) throw refuse(err.message);
    throw refuse(`Failed to prepare the PDF: ${err instanceof Error ? err.message : 'Unknown PDF error.'}`);
  }

  // A PDF uploaded half filled in can carry a client's name in a field value.
  const storedParts = await readPdfTextParts(stored);
  await assertNoLeftoverClientText({
    ...ctx, stored: storedParts, uploaded: await readPdfTextParts(uploaded), acknowledged: input.acknowledgedLeftovers,
  });

  const baseName = baseNameFor(input.fileName, input.name);
  const decision = await resolveSameName(ctx.lawFirmId, 'pdf-form', baseName, input.duplicateStrategy);
  if ('replace' in decision) {
    const row = await replaceSource(ctx, decision.replace, { buffer: stored, fields: fieldNames, originalFileName: input.fileName });
    return storedResult(row, false);
  }
  const row = await persistSourceTemplate(ctx, {
    type: 'pdf-form',
    name: decision.name,
    buffer: stored,
    fields: fieldNames,
    repeaters: [],
    originalFileName: input.fileName,
    duplicateMessage: pdfDuplicateMessage,
  });
  return storedResult(row, true);
}

/**
 * The editor's Word import: stores the file unchanged, with the same
 * client-text guard and the same same-name chooser as a reviewed upload.
 */
export async function uploadDocx({
  lawFirmId, userId, objectPath, fileName, name, duplicateStrategy, acknowledgedLeftovers,
}: Ctx & {
  objectPath: string; fileName: string; name?: string;
  duplicateStrategy?: 'copy' | 'replace' | null; acknowledgedLeftovers?: string[];
}) {
  await assertLawFirmMembership(lawFirmId, userId);
  const ctx = { lawFirmId, userId };
  const result = await commitDocx(ctx, { objectPath, fileName, name, edits: [], duplicateStrategy, acknowledgedLeftovers });
  await storage.discardUpload(objectPath);
  return result;
}

/** Re-upload: replace a docx (or pdf-form) template's file. */
export async function replaceTemplateSource({
  lawFirmId, userId, templateId, objectPath, fileName, acknowledgedLeftovers,
}: Ctx & { templateId: string; objectPath: string; fileName: string; acknowledgedLeftovers?: string[] }) {
  await assertLawFirmMembership(lawFirmId, userId);
  const ctx = { lawFirmId, userId };
  const row = await getTemplateOr404(lawFirmId, templateId);
  if (row.type !== 'docx' && row.type !== 'pdf-form') throw refuse('Only DOCX templates can be re-uploaded.');

  let updated: repo.WordTemplateRow;
  if (row.type === 'pdf-form') {
    const buffer = await readPdfUpload(ctx, objectPath, fileName);
    let fields: string[];
    try {
      fields = (await readPdfFormFields(buffer)).map((f) => f.name);
    } catch (err) {
      if (err instanceof PdfFormError) throw refuse(err.message);
      throw err;
    }
    const parts = await readPdfTextParts(buffer);
    await assertNoLeftoverClientText({ ...ctx, stored: parts, uploaded: parts, acknowledged: acknowledgedLeftovers });
    updated = await replaceSource(ctx, row, { buffer, fields, originalFileName: fileName });
  } else {
    const buffer = await readUpload(ctx, objectPath, fileName).then((r) => r.buffer);
    const parsed = parseOrRefuse(buffer, 'Failed to read placeholders');
    const parts = readDocxTextParts(buffer);
    await assertNoLeftoverClientText({ ...ctx, stored: parts, uploaded: parts, acknowledged: acknowledgedLeftovers });
    updated = await replaceSource(ctx, row, {
      buffer,
      fields: buildFlatFieldListDocx(parsed),
      repeaters: parsed.repeaters,
      originalFileName: fileName,
    });
  }
  await storage.discardUpload(objectPath);
  return {
    message: 'Template updated successfully',
    templateId: updated.id,
    template: await editorShape(updated),
  };
}

// ── html templates ───────────────────────────────────────────────────────────

/**
 * Move every embedded `data:` image into storage as one of the template's
 * assets, keep the assets the body still references, and report the ones it
 * no longer does so they can be deleted after the save.
 */
async function normalizeHtmlAssets(lawFirmId: string, templateId: string, html: string, existing: repo.StoredAsset[]) {
  const existingById = new Map(existing.map((a) => [a.id, a]));
  const retained = new Set<string>();
  const next: repo.StoredAsset[] = [];
  let normalized = html;
  const written: string[] = [];

  for (const m of [...html.matchAll(IMG_DATA_URL_RE)]) {
    const [whole, before = '', mime = 'image/png', b64 = '', after = ''] = m;
    if (!IMAGE_MIME_ALLOWLIST.includes(mime)) {
      await storage.deleteObjects(lawFirmId, written);
      throw refuse('Unsupported embedded image type. Use PNG, JPEG, WEBP, or GIF.');
    }
    const assetId = randomUUID();
    const path = storage.assetObjectPath(lawFirmId, templateId, assetId, extFromMime(mime));
    try {
      await storage.saveObject(lawFirmId, path, Buffer.from(b64, 'base64'), mime);
    } catch (err) {
      await storage.deleteObjects(lawFirmId, written);
      throw new AppError(`Failed to store embedded image: ${err instanceof Error ? err.message : 'unknown error'}`, 502, 'TEMPLATE_ASSET_STORAGE_FAILED');
    }
    written.push(path);
    next.push({ id: assetId, object_path: path, mime_type: mime, file_name: null });
    retained.add(assetId);
    normalized = normalized.replace(whole, `<img${before}data-template-asset-id="${assetId}"${after}>`);
  }

  for (const match of normalized.matchAll(/data-template-asset-id=["']([^"']+)["']/g)) {
    const id = match[1];
    if (id && existingById.has(id) && !retained.has(id)) {
      retained.add(id);
      next.push(existingById.get(id)!);
    }
  }
  const removed = existing.filter((a) => !retained.has(a.id)).map((a) => a.object_path);
  return { html: normalized, assets: next, removed, written };
}

function checkHtmlInput(name: string, html: string) {
  const trimmed = (name ?? '').trim().slice(0, MAX_NAME_LENGTH);
  if (!trimmed) throw refuse('Name is required.');
  if (html.length > MAX_HTML_BYTES) throw refuse('Template body too large.');
  return trimmed;
}

/** Create an html template from the editor. */
export async function createHtmlTemplate({ lawFirmId, userId, name, html }: Ctx & { name: string; html: string }) {
  await assertLawFirmMembership(lawFirmId, userId);
  const cleanName = checkHtmlInput(name, html);
  const templateId = randomUUID();
  const normalized = await normalizeHtmlAssets(lawFirmId, templateId, sanitizeTemplateHtml(html), []);
  const fields = extractPlaceholders(normalized.html);
  const repeaters = extractRepeaters(normalized.html);
  const htmlPath = storage.htmlObjectPath(lawFirmId, templateId);

  let row: repo.WordTemplateRow;
  try {
    await storage.saveObject(lawFirmId, htmlPath, Buffer.from(normalized.html, 'utf8'), 'text/html; charset=utf-8');
    row = await repo.insertWordTemplate(lawFirmId, {
      id: templateId,
      name: cleanName,
      type: 'html',
      htmlObjectPath: htmlPath,
      fields: buildFlatFieldListHtml({ fields, repeaters }),
      repeaters,
      assets: normalized.assets,
      createdBy: userId,
    });
  } catch (error) {
    await storage.deleteObjects(lawFirmId, [htmlPath, ...normalized.written]);
    throw error;
  }
  return {
    message: 'Template created successfully',
    templateId: row.id,
    template: await editorShape(row, normalized.html),
  };
}

/** Save the editor's html over an html template. Refused for docx and pdf-form. */
export async function updateHtmlTemplate({
  lawFirmId, userId, templateId, name, html,
}: Ctx & { templateId: string; name: string; html: string }) {
  await assertLawFirmMembership(lawFirmId, userId);
  const existing = await getTemplateOr404(lawFirmId, templateId);
  // Only an html template keeps its content as html. Writing html onto a file
  // template used to reroute its fill through a lossy conversion for good.
  const rejection = htmlWriteRejection(existing.type as WordTemplateType);
  if (rejection) throw new AppError(rejection, 400, 'TEMPLATE_HTML_WRITE_REJECTED');
  const cleanName = checkHtmlInput(name, html);

  const normalized = await normalizeHtmlAssets(lawFirmId, templateId, sanitizeTemplateHtml(html), repo.rowAssets(existing));
  const fields = extractPlaceholders(normalized.html);
  const repeaters = extractRepeaters(normalized.html);
  const htmlPath = existing.htmlObjectPath || storage.htmlObjectPath(lawFirmId, templateId);
  await storage.saveObject(lawFirmId, htmlPath, Buffer.from(normalized.html, 'utf8'), 'text/html; charset=utf-8');
  const updated = await repo.updateWordTemplate(lawFirmId, templateId, {
    name: cleanName,
    htmlObjectPath: htmlPath,
    fields: buildFlatFieldListHtml({ fields, repeaters }),
    repeaters,
    assets: normalized.assets,
  });
  if (!updated) {
    await storage.deleteObjects(lawFirmId, normalized.written);
    throw new NotFoundError('Template');
  }
  await storage.deleteObjects(lawFirmId, normalized.removed);
  return { message: 'Template updated successfully', template: await editorShape(updated, normalized.html) };
}

export async function listTemplates({ lawFirmId, userId }: Ctx) {
  await assertLawFirmMembership(lawFirmId, userId);
  const rows = await repo.listWordTemplates(lawFirmId);
  return { templates: rows.map(repo.formatWordTemplate) };
}

export async function getTemplate({ lawFirmId, userId, templateId }: Ctx & { templateId: string }) {
  await assertLawFirmMembership(lawFirmId, userId);
  return { template: await editorShape(await getTemplateOr404(lawFirmId, templateId)) };
}

export async function renameTemplate({ lawFirmId, userId, templateId, name }: Ctx & { templateId: string; name: string }) {
  await assertLawFirmMembership(lawFirmId, userId);
  const trimmed = (name ?? '').trim().slice(0, MAX_NAME_LENGTH);
  if (!trimmed) throw refuse('Name is required.');
  await getTemplateOr404(lawFirmId, templateId);
  let updated: repo.WordTemplateRow | null;
  try {
    updated = await repo.updateWordTemplate(lawFirmId, templateId, { name: trimmed });
  } catch (error) {
    if (isSameNameViolation(error)) throw refuse(`A template named “${trimmed}” already exists.`);
    throw error;
  }
  if (!updated) throw new NotFoundError('Template');
  return { message: 'Template updated successfully', template: repo.formatWordTemplate(updated) };
}

/** Delete the row first, and its objects only once the row is gone. */
export async function deleteTemplate({ lawFirmId, userId, templateId }: Ctx & { templateId: string }) {
  await assertLawFirmMembership(lawFirmId, userId);
  const deleted = await repo.deleteWordTemplate(lawFirmId, templateId);
  if (!deleted) throw new NotFoundError('Template');
  await storage.deleteObjects(lawFirmId, [
    deleted.sourceObjectPath,
    deleted.htmlObjectPath,
    ...repo.rowAssets(deleted).map((a) => a.object_path),
  ]);
  return { message: 'Template deleted successfully', templateId: deleted.id };
}

/** Settle an editor image into an html template's assets. */
export async function finalizeAsset({
  lawFirmId, userId, templateId, objectPath, fileName,
}: Ctx & { templateId: string; objectPath: string; fileName: string }) {
  await assertLawFirmMembership(lawFirmId, userId);
  const row = await getTemplateOr404(lawFirmId, templateId);
  storage.assertOwnUpload(lawFirmId, userId, objectPath, templateId);
  const settled = await settleDirectUpload({
    objectPath,
    uploadedBy: userId,
    maxBytes: storage.MAX_ASSET_BYTES,
    tooLargeMessage: () => 'Image too large (max 10 MB).',
    allowedContentTypes: IMAGE_MIME_ALLOWLIST,
    fileName,
  });
  const assetId = randomUUID();
  const path = storage.assetObjectPath(lawFirmId, templateId, assetId, extFromMime(settled.contentType));
  await storage.copyObject(lawFirmId, objectPath, path, settled.size, settled.contentType);
  const asset: repo.StoredAsset = {
    id: assetId, object_path: path, mime_type: settled.contentType, file_name: fileName.slice(0, 255),
  };
  const updated = await repo.updateWordTemplate(lawFirmId, templateId, { assets: [...repo.rowAssets(row), asset] });
  await storage.discardUpload(objectPath);
  if (!updated) {
    await storage.deleteObjects(lawFirmId, [path]);
    throw new NotFoundError('Template');
  }
  return {
    message: 'Asset uploaded successfully',
    assetId,
    asset: {
      id: assetId,
      objectPath: path,
      mimeType: settled.contentType,
      fileName: asset.file_name,
      previewUrl: await storage.signAssetUrl(path),
    },
  };
}

// ── the stored file ──────────────────────────────────────────────────────────

/**
 * The fields actually inside a Word template's stored file. The fill form
 * builds its inputs from these, because the row's copy can lag the file. Null
 * when the template is not a Word template or its file cannot be read.
 */
export async function liveFields({ lawFirmId, userId, templateId }: Ctx & { templateId: string }) {
  await assertLawFirmMembership(lawFirmId, userId);
  const row = await getTemplateOr404(lawFirmId, templateId);
  if (row.type !== 'docx' || !row.sourceObjectPath) return { fillFields: null };
  let buffer: Buffer;
  try {
    buffer = await storage.readObject(row.sourceObjectPath);
  } catch (error: any) {
    console.error('[word-templates] reading the stored file for fill fields failed:', error?.message);
    return { fillFields: null };
  }
  const { fields, repeaters } = docxFieldColumns(buffer);
  return { fillFields: fields ? { fields, repeaters: repeaters ?? [] } : null };
}

/** The stored .docx itself, for the browser's own preview. */
export async function docxSource({ lawFirmId, userId, templateId }: Ctx & { templateId: string }) {
  await assertLawFirmMembership(lawFirmId, userId);
  const row = await repo.findWordTemplate(lawFirmId, templateId);
  if (!row || row.type !== 'docx' || !row.sourceObjectPath) throw new AppError('Not a DOCX template.', 404, 'NOT_FOUND');
  return storage.readObject(row.sourceObjectPath);
}

/** A converter failure as the error the browser sees; a busy queue passes through. */
function conversionFailure(error: any, prefix: string) {
  if (isConversionBusy(error) || error instanceof AppError) return error;
  return new AppError(`${prefix}: ${error instanceof Error ? error.message : 'Unknown error'}`, 502, 'TEMPLATE_CONVERSION_FAILED');
}

async function convertToPdf(buffer: Buffer, inputFilename: string, prefix: string): Promise<Buffer> {
  const { convertDocument } = require('../signatures/signatures.service');
  try {
    return await convertDocument(buffer, 'pdf', inputFilename);
  } catch (error) {
    throw conversionFailure(error, prefix);
  }
}

export type BinaryResult = {
  body: Buffer;
  contentType: string;
  disposition: string;
  unfilledFields?: string[];
};

/** Fill a Word template; optionally convert the filled document to PDF. */
export async function fillDocx({
  lawFirmId, userId, templateId, values, repeaterValues, fileName, format,
}: Ctx & {
  templateId: string; values?: Record<string, string>; repeaterValues?: Record<string, Array<Record<string, string>>>;
  fileName?: string; format?: 'docx' | 'pdf';
}): Promise<BinaryResult> {
  await assertLawFirmMembership(lawFirmId, userId);
  const row = await getTemplateOr404(lawFirmId, templateId);
  if (row.type !== 'docx' || !row.sourceObjectPath) throw refuse('Template is not a DOCX template.');
  const sourcePath = row.sourceObjectPath;
  const baseName = sanitizeFilename(fileName || row.name);

  return withPersonRenderCap(userId, () => withTemplateFillSlot(async () => {
    const source = await storage.readObject(sourcePath);
    let filled: Buffer;
    let unfilledFields: string[];
    try {
      ({ buffer: filled, unfilledFields } = fillDocxTemplate(source, values ?? {}, repeaterValues ?? {}));
    } catch (err) {
      throw new AppError(`DOCX fill failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 422, 'TEMPLATE_FILL_FAILED');
    }
    if (format === 'pdf') {
      const pdf = await convertToPdf(filled, `${baseName}.docx`, 'DOCX→PDF conversion failed');
      return {
        body: pdf, contentType: storage.PDF_CONTENT_TYPE, disposition: `attachment; filename="${baseName}.pdf"`, unfilledFields,
      };
    }
    return {
      body: filled, contentType: storage.DOCX_CONTENT_TYPE, disposition: `attachment; filename="${baseName}.docx"`, unfilledFields,
    };
  }));
}

/** Fill a fillable-PDF template in place and flatten it. */
export async function fillPdf({
  lawFirmId, userId, templateId, values, fileName,
}: Ctx & { templateId: string; values?: Record<string, string>; fileName?: string }): Promise<BinaryResult> {
  await assertLawFirmMembership(lawFirmId, userId);
  const row = await getTemplateOr404(lawFirmId, templateId);
  if (row.type !== 'pdf-form' || !row.sourceObjectPath) throw refuse('Template is not a PDF form template.');
  const sourcePath = row.sourceObjectPath;
  const baseName = sanitizeFilename(fileName || row.name);

  return withPersonRenderCap(userId, () => withTemplateFillSlot(async () => {
    const source = await storage.readObject(sourcePath);
    try {
      const { bytes, unfilledFields } = await fillPdfForm(source, values ?? {});
      return {
        body: Buffer.from(bytes), contentType: storage.PDF_CONTENT_TYPE,
        disposition: `attachment; filename="${baseName}.pdf"`, unfilledFields,
      };
    } catch (err) {
      throw new AppError(`PDF fill failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 422, 'TEMPLATE_FILL_FAILED');
    }
  }));
}

/** A Word template's stored file rendered to PDF, for inline preview. */
export async function previewPdf({ lawFirmId, userId, templateId }: Ctx & { templateId: string }): Promise<BinaryResult> {
  await assertLawFirmMembership(lawFirmId, userId);
  const row = await getTemplateOr404(lawFirmId, templateId);
  if (row.type !== 'docx' || !row.sourceObjectPath) throw new AppError('Template is not a DOCX template.', 404, 'NOT_FOUND');
  const sourcePath = row.sourceObjectPath;
  return withPersonRenderCap(userId, () => withTemplateFillSlot(async () => {
    const source = await storage.readObject(sourcePath);
    const pdf = await convertToPdf(source, `${row.name}.docx`, 'DOCX preview failed');
    return { body: pdf, contentType: storage.PDF_CONTENT_TYPE, disposition: 'inline' };
  }));
}

/** Convert a settled .docx upload to PDF (the editor's import step). */
export async function convertUploadToPdf({
  lawFirmId, userId, objectPath, fileName,
}: Ctx & { objectPath: string; fileName: string }): Promise<BinaryResult> {
  await assertLawFirmMembership(lawFirmId, userId);
  if (!isDocxName(fileName)) throw refuse('Only .docx files can be converted.');
  const ctx = { lawFirmId, userId };
  return withPersonRenderCap(userId, () => withTemplateFillSlot(async () => {
    const { buffer } = await readUpload(ctx, objectPath, fileName);
    try {
      const pdf = await convertToPdf(buffer, fileName, 'DOCX→PDF conversion failed');
      return { body: pdf, contentType: storage.PDF_CONTENT_TYPE, disposition: 'inline' };
    } finally {
      await storage.discardUpload(objectPath);
    }
  }));
}

// ── html export ──────────────────────────────────────────────────────────────

// html-to-docx and the text extractor would print raw <script>/<style> source
// as document text; Chromium (the PDF path) runs them, so only these two strip.
function stripNonRenderable(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

const tooLarge = () => new AppError('HTML payload is too large.', 413, 'TEMPLATE_EXPORT_TOO_LARGE');

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const INLINE_IMAGE_SRC_RE = /\bsrc\s*=\s*(["'])data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+\1/i;
const ASSET_ID_RE = /\bdata-template-asset-id\s*=\s*(["'])([^"']+)\1/i;
const SRC_ATTR_RE = /\bsrc\s*=\s*(["'])[^"']*\1|\bsrc\s*=\s*[^\s>]+/i;

/**
 * html-to-docx downloads every http(s) image address it meets (image-to-base64),
 * so a caller could point the server at an internal address and read the reply
 * back out of the document. Only bytes already in hand reach it: an inline
 * `data:image/...;base64` image is kept, an image carrying one of `assets`' ids
 * is replaced with that stored object's bytes, and every other image is dropped.
 */
async function inlineDocxImages(html: string, assets: repo.StoredAsset[]): Promise<string> {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const replacements = new Map<string, string>();
  for (const [tag] of html.matchAll(IMG_TAG_RE)) {
    if (replacements.has(tag)) continue;
    const asset = byId.get(tag.match(ASSET_ID_RE)?.[2] ?? '');
    if (asset && /^image\/(png|jpe?g|gif|webp)$/i.test(asset.mime_type)) {
      const bytes = await storage.readObject(asset.object_path, storage.MAX_ASSET_BYTES);
      const src = `src="data:${asset.mime_type};base64,${bytes.toString('base64')}"`;
      replacements.set(tag, SRC_ATTR_RE.test(tag) ? tag.replace(SRC_ATTR_RE, src) : tag.replace(/^<img\b/i, `<img ${src}`));
    } else {
      replacements.set(tag, INLINE_IMAGE_SRC_RE.test(tag) ? tag : '');
    }
  }
  return html.replace(IMG_TAG_RE, (tag) => replacements.get(tag) ?? '');
}

/**
 * Export filled html as PDF (Chromium, through the document renderer), Word
 * (html-to-docx) or plain text. `templateId`, when given, lends the render that
 * template's own stored images; nothing else the html points at is fetched.
 */
export async function exportHtml({
  lawFirmId, userId, html, format, templateId,
}: Ctx & { html: string; format?: 'pdf' | 'docx' | 'txt'; templateId?: string }): Promise<BinaryResult> {
  await assertLawFirmMembership(lawFirmId, userId);
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_EXPORT_HTML_BYTES) throw tooLarge();
  const chosen = format ?? 'pdf';

  if (chosen === 'txt') {
    return {
      body: Buffer.from(htmlToPlainText(html), 'utf8'),
      contentType: 'text/plain; charset=utf-8',
      disposition: 'attachment; filename="document.txt"',
    };
  }

  if (chosen === 'docx') {
    const htmlToDocx = require('html-to-docx');
    const template = templateId ? await repo.findWordTemplate(lawFirmId, templateId) : null;
    const safeHtml = await inlineDocxImages(stripNonRenderable(html), template ? repo.rowAssets(template) : []);
    try {
      const out = await htmlToDocx(prepareHtmlForDocx(safeHtml), undefined, { table: { row: { cantSplit: true } } });
      const body = Buffer.isBuffer(out) ? out : Buffer.from(await (out as Blob).arrayBuffer());
      return { body, contentType: storage.DOCX_CONTENT_TYPE, disposition: 'attachment; filename="document.docx"' };
    } catch (err: any) {
      console.error('[word-templates] DOCX export failed:', err?.message);
      throw new AppError('DOCX conversion failed.', 500, 'TEMPLATE_EXPORT_FAILED');
    }
  }

  // The renderer reads the staged html back with its own 1 MB ceiling.
  if (bytes > EXPORT_HTML_MAX_BYTES) throw tooLarge();
  const template = templateId ? await repo.findWordTemplate(lawFirmId, templateId) : null;
  const assets = template ? repo.rowAssets(template).map((a) => ({ id: a.id, objectPath: a.object_path })) : [];
  const outputObjectPath = storage.exportRenderPath(lawFirmId);
  return withPersonRenderCap(userId, () => withTemplateExportSlot(async () => {
    try {
      await renderHtmlToStoredPdf({ html, assets, outputObjectPath });
      const pdf = await storage.readObject(outputObjectPath);
      return { body: pdf, contentType: storage.PDF_CONTENT_TYPE, disposition: 'attachment; filename="document.pdf"' };
    } finally {
      await storage.discardUpload(outputObjectPath);
    }
  }));
}
