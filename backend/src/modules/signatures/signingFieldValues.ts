// pdf-lib is required inside the functions below that draw or embed, not here:
// the validators in this module run on every signing submission and need none
// of it, and loading it at boot costs every instance its memory.
import { fitTextToBox } from './textFit';
import {
  type FieldPlacementFailure,
} from './pdf/fieldPlacement';

function normalizeFieldType(fieldType: any) {
  return ['signature', 'initials', 'date', 'text', 'checkbox'].includes(fieldType)
    ? fieldType
    : 'signature';
}

// The image limits live beside the other signing limits, where the profile and
// the appearance engine read them too. Re-exported so existing callers keep
// importing them from here.
const {
  SIGNING_IMAGE_MAX_BYTES,
  SIGNING_IMAGE_TOTAL_MAX_BYTES,
  SIGNING_IMAGE_MAX_PIXELS,
  SIGNING_TEXT_VALUE_MAX_CHARS,
} = require('./signing.validation');

export {
  SIGNING_IMAGE_MAX_BYTES, SIGNING_IMAGE_TOTAL_MAX_BYTES, SIGNING_IMAGE_MAX_PIXELS, SIGNING_TEXT_VALUE_MAX_CHARS,
};

// Whether a submitted value would actually render for its field type. Mirrors
// the draw logic in stampSessionFieldsOntoPdf so a "required" field is only
// considered satisfied when it produces visible output on the signed PDF.
// A signature/initials value must be a PNG data URL (finalize embeds it via
// embedPng). Validating the PNG magic bytes here means a malformed value counts
// as "not filled", so the submit path rejects it as a missing required field
// rather than letting it through to wedge finalization for every co-signer.
function isValidSignatureImage(value: any) {
  if (typeof value !== 'string') return false;
  const comma = value.indexOf(',');
  if (comma < 0) return false;
  const b64 = value.slice(comma + 1);
  if (!b64) return false;
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return false; }
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}




const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The decoded bytes behind a `data:` URL value, or null when it is not one. */
function decodeDataUrlValue(value: any): Buffer | null {
  if (typeof value !== 'string' || !value.startsWith('data:')) return null;
  const comma = value.indexOf(',');
  if (comma < 0) return null;
  const b64 = value.slice(comma + 1);
  if (!b64) return null;
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

/**
 * The pixel count a PNG's IHDR claims, read from the 24-byte header alone.
 *
 * Deliberately trusts nothing else about the file and decodes none of it: the
 * header is the only part that has to be read to know what decoding would cost,
 * and a bomb is refused on what it declares. Returns null for anything that is
 * not a PNG header, which the caller treats as "no dimension claim to check".
 */
function declaredPngPixels(bytes: Buffer | null): number | null {
  if (!bytes || bytes.length < 24) return null;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) return null;
  return width * height;
}

export type ImageLimitViolation =
  | { kind: 'bytes'; fieldId: any; bytes: number }
  | { kind: 'pixels'; fieldId: any; pixels: number }
  | { kind: 'total'; bytes: number };

/**
 * The first image limit a submission breaks, or null when it breaks none.
 *
 * Runs on the raw values, before anything embeds or decodes them, and returns
 * on the first violation so an oversized submission is never walked twice. It
 * measures every `data:` value rather than only the ones on signature fields:
 * a caller is free to aim a megabyte at a text field, and the memory cost is
 * identical.
 */
export function findImageLimitViolation(submittedValues: any[] = []): ImageLimitViolation | null {
  let total = 0;
  for (const item of submittedValues || []) {
    if (!item || item.fieldId == null) continue;
    const bytes = decodeDataUrlValue(item.value);
    if (!bytes) continue;
    if (bytes.length > SIGNING_IMAGE_MAX_BYTES) {
      return { kind: 'bytes', fieldId: item.fieldId, bytes: bytes.length };
    }
    const pixels = declaredPngPixels(bytes);
    if (pixels !== null && pixels > SIGNING_IMAGE_MAX_PIXELS) {
      return { kind: 'pixels', fieldId: item.fieldId, pixels };
    }
    total += bytes.length;
    if (total > SIGNING_IMAGE_TOTAL_MAX_BYTES) {
      return { kind: 'total', bytes: total };
    }
  }
  return null;
}

function isFieldValueFilled(fieldType: any, value: any) {
  const type = normalizeFieldType(fieldType);
  if (type === 'signature' || type === 'initials') {
    return isValidSignatureImage(value);
  }
  if (type === 'checkbox') {
    return value === true || value === 'true' || value === 1 || value === '1';
  }
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  return text.length > 0;
}

// Return the required fields assigned to `participantId` that the submitted
// values leave unfilled. A field is required unless it is explicitly
// `required === false` (fields are created required by default in the signer
// setup UI). Fields assigned to other signers are ignored.
export function findMissingRequiredFields(fields: any[] = [], participantId: string, submittedValues: any[] = []) {
  const submitted = new Map();
  for (const item of submittedValues) {
    if (item && item.fieldId != null) submitted.set(item.fieldId, item.value);
  }
  return (fields || []).filter((field) =>
    field.signerId === participantId
    && field.required !== false
    && !isFieldValueFilled(field.fieldType, submitted.get(field.id))
  );
}

// Build a fieldId -> owning signerId (participantId) lookup. A field whose
// signerId is empty is unowned and may be filled by any participant.
function buildFieldOwnerMap(fields: any[] = []) {
  const owner = new Map();
  for (const field of fields || []) {
    if (field && field.id != null) owner.set(field.id, field.signerId || null);
  }
  return owner;
}

// Return the fieldIds a participant submitted values for that are actually
// assigned to a DIFFERENT signer. A signer may only submit values for their own
// fields (or unowned fields); anything else is another signer's field and would
// be a forgery attempt.
export function findForeignFieldSubmissions(fields: any[] = [], participantId: string, submittedValues: any[] = []) {
  const owner = buildFieldOwnerMap(fields);
  const foreign = [];
  for (const item of submittedValues || []) {
    if (!item || item.fieldId == null) continue;
    const signerId = owner.get(item.fieldId);
    if (signerId && signerId !== participantId) foreign.push(item.fieldId);
  }
  return foreign;
}

// Drop any submitted value targeting a field the participant does not own, so a
// stored participant.fieldValues array can never carry another signer's value.
/**
 * The first non-image value longer than a field can hold, or null.
 *
 * Signature and initials values are images and are bounded by the image caps;
 * every other field type is text by the time it is drawn.
 */
export function findOversizedTextValue(
  fields: any[] = [],
  submittedValues: any[] = [],
): { fieldId: string; length: number } | null {
  const types = new Map((fields || []).map((f: any) => [String(f.id), String(f.fieldType || '')]));
  for (const item of submittedValues || []) {
    const type = types.get(String(item?.fieldId));
    if (type === 'signature' || type === 'initials') continue;
    if (typeof item?.value === 'string' && item.value.length > SIGNING_TEXT_VALUE_MAX_CHARS) {
      return { fieldId: String(item.fieldId), length: item.value.length };
    }
  }
  return null;
}

export function filterValuesToParticipant(fields: any[] = [], participantId: string, submittedValues: any[] = []) {
  const owner = buildFieldOwnerMap(fields);
  return (submittedValues || []).filter((item) => {
    if (!item || item.fieldId == null) return false;
    const signerId = owner.get(item.fieldId);
    return !signerId || signerId === participantId;
  });
}

// Exported so overlayFill.service.ts (templates module) can reuse the same
// percent-of-page box math and text-fit/font-sizing approach for Document
// Overlay template stamping instead of re-deriving it.
export function getFieldBox(field: any, pageWidth: any, pageHeight: any) {
  const x = (field.xPercent / 100) * pageWidth;
  const boxWidth = (field.widthPercent / 100) * pageWidth;
  const boxHeight = (field.heightPercent / 100) * pageHeight;
  const top = pageHeight - (field.yPercent / 100) * pageHeight;
  return {
    x,
    boxWidth,
    boxHeight,
    top,
    y: top - boxHeight,
  };
}

export function drawCheckbox(page: any, box: any) {
  const { rgb } = require('pdf-lib');
  const startX = box.x + box.boxWidth * 0.2;
  const midX = box.x + box.boxWidth * 0.45;
  const endX = box.x + box.boxWidth * 0.82;
  const startY = box.y + box.boxHeight * 0.45;
  const midY = box.y + box.boxHeight * 0.2;
  const endY = box.y + box.boxHeight * 0.78;

  page.drawLine({
    start: { x: startX, y: startY },
    end: { x: midX, y: midY },
    thickness: Math.max(1.5, box.boxHeight * 0.06),
    color: rgb(0, 0, 0),
  });
  page.drawLine({
    start: { x: midX, y: midY },
    end: { x: endX, y: endY },
    thickness: Math.max(1.5, box.boxHeight * 0.06),
    color: rgb(0, 0, 0),
  });
}

/**
 * Draw a value into a field box with pdf-lib.
 *
 * Nothing in the signing path calls this: an executed document is composed as
 * an appended revision through `pdf/`, which never loads a whole document. What
 * this is now is the INDEPENDENT REFERENCE `pdf/fieldAppearance.ts` is measured
 * against, in `tests/signatures/pdf/fieldAppearance.test.ts`. Two
 * implementations that agree line for line is evidence; one implementation
 * agreeing with itself is not. Keep it in step with the appearance engine, or
 * delete the parity tests with it.
 */
export function drawTextValue(page: any, font: any, fieldType: any, value: any, box: any) {
  const { rgb } = require('pdf-lib');
  let text = typeof value === 'string' ? value.trim() : String(value || '').trim();
  if (fieldType === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
    // Both the parse and the format are pinned to UTC (not left to the SERVER
    // PROCESS's ambient local zone): a bare 'YYYY-MM-DD' has no time-of-day to
    // roll across a zone boundary, so anchoring in UTC always reproduces the
    // literal date, the same way a same-zone round trip would - but without
    // depending on which zone the process happens to be running in.
    const parsed = new Date(`${text}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) {
      text = parsed.toLocaleDateString('en-US', { timeZone: 'UTC' });
    }
  }
  if (!text) return;

  // Identical layout to the frontend stamper (pdfStamper.ts), which produces
  // the preview the signer approved and the copy they downloaded: wrap onto
  // multiple lines and shrink first, then truncate with an ellipsis at the
  // smallest readable size. A single shrunk-to-fit line here would make the
  // executed document disagree with what the signer was shown.
  const maxFontSize = Math.max(10, Math.min(box.boxHeight * 0.55, fieldType === 'text' ? 18 : 16));
  const { lines, fontSize, lineHeight } = fitTextToBox(
    text,
    box.boxWidth,
    box.boxHeight,
    maxFontSize,
    (line: string, size: number) => font.widthOfTextAtSize(line, size),
  );
  const blockHeight = lines.length * lineHeight;
  let y = box.y + Math.max(2, (box.boxHeight - blockHeight) / 2) + blockHeight - fontSize;

  for (const line of lines) {
    const lineWidth = font.widthOfTextAtSize(line, fontSize);
    const x = box.x + Math.max(4, Math.min(box.boxWidth * 0.1, (box.boxWidth - lineWidth) / 2));

    try {
      page.drawText(line, {
        x,
        y,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
      });
    } catch {
      // Skip unsupported glyphs in WinAnsi fonts.
    }
    y -= lineHeight;
  }
}

// Whether a stored value would be stamped at all. A field nobody filled in is
// not a placement failure, so it stays out of the placement report.
function hasStampableValue(value: any) {
  return value !== undefined && value !== null && value !== '';
}

// Return the ids of submitted signature/initials fields whose PNG value passes the
// magic-byte check but cannot actually be embedded (corrupt body / truncated data).
// isValidSignatureImage only inspects the 8-byte header, so such a value clears the
// required-field submit check, is stored, then throws at finalize (embedPng) — which
// leaves the session stuck in_progress and the recovery cron re-throwing on it
// forever. Running the SAME embed here (a throwaway PDFDocument) rejects it at submit.
export async function findUnembeddableSignatureFields(fields: any[] = [], submittedValues: any[] = []) {
  const { PDFDocument } = require('pdf-lib');
  const typeById = new Map((fields || []).map((f) => [f.id, normalizeFieldType(f.fieldType)]));
  const bad = [];
  for (const item of submittedValues || []) {
    if (!item || item.fieldId == null) continue;
    const type = typeById.get(item.fieldId);
    if (type !== 'signature' && type !== 'initials') continue;
    if (!isValidSignatureImage(item.value)) continue; // caught upstream as "not filled"
    try {
      const doc = await PDFDocument.create();
      const bytes = Uint8Array.from(Buffer.from(String(item.value).split(',')[1], 'base64'));
      await doc.embedPng(bytes);
    } catch {
      bad.push(item.fieldId);
    }
  }
  return bad;
}
