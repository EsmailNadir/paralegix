/**
 * The last look before a template's file is stored. A template is printed into
 * every document made from it, for every client, so any firm client's detail
 * still in plain text is disclosed to all of them. Every way of storing a source
 * runs this on the bytes it is about to store: the reviewed upload (commit),
 * the editor's import (upload-docx) and Re-upload (replace-source), including a
 * save with no fields, and a fillable PDF's stored field values too.
 *
 * The acknowledgement names the exact values the reviewer was shown, and the
 * scan runs again regardless: anything that surfaces after the warning is
 * warned about in turn rather than riding along. It is a guard against an
 * accident, not an authorization check.
 */
import PizZip from 'pizzip';
import { PDFDocument, PDFTextField } from 'pdf-lib';
import {
  findLeftoverClientText,
  type LeftoverPart,
} from './lib/auto-bracket/known-values';
import { docxPartText, propertyPartText } from './lib/auto-bracket/scan-text';
import { assembleFirmKnownValues } from './lib/firm-known-values';
import { loadFirmKnownValueRows } from './knownValues.repository';
import { clientTextUncheckable, leftoverRefusal } from './wordTemplates.errors';

const { loadResolvedMember } = require('../lawfirms/roles/requirePermission');
const { hasPermission } = require('../lawfirms/roles/permissions');

/** The body may reach this; every other text part together gets the same again. */
export const MAX_DOCX_XML_BYTES = 20 * 1024 * 1024;
const MAX_DOCX_TEXT_PARTS_BYTES = 2 * MAX_DOCX_XML_BYTES;

const TEMPLATE_TEXT_PARTS: ReadonlyArray<[RegExp, LeftoverPart]> = [
  [/^word\/document\.xml$/, 'body'],
  [/^word\/header\d*\.xml$/, 'header'],
  [/^word\/footer\d*\.xml$/, 'footer'],
  [/^word\/(?:footnotes|endnotes)\.xml$/, 'footnote'],
  [/^word\/comments\.xml$/, 'comment'],
  // Title, subject, keywords, custom properties, content-control data: rarely
  // looked at, copied into every generated file.
  [/^docProps\/(?:core|app|custom)\.xml$/, 'properties'],
  [/^customXml\/item\d+\.xml$/, 'properties'],
];

type TextParts = Array<{ part: LeftoverPart; text: string }>;
type PartsResult = { ok: true; parts: TextParts } | { ok: false; error: string };

/** Every part of a .docx whose text is printed in a generated document. */
export function readDocxTextParts(buffer: Buffer): PartsResult {
  let zip: PizZip;
  try {
    zip = new PizZip(buffer);
  } catch {
    return { ok: false, error: 'Not a valid Word document.' };
  }
  const parts: TextParts = [];
  // Bounded in TOTAL, not just per part: a crafted file can carry thousands of
  // header parts. Over the limit is a refusal, never a skipped part reported clean.
  const tooLarge = { ok: false as const, error: 'Document is too large to check before saving.' };
  let total = 0;
  for (const [pattern, part] of TEMPLATE_TEXT_PARTS) {
    for (const entry of zip.file(pattern)) {
      const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
      if (typeof declared === 'number' && total + declared > MAX_DOCX_TEXT_PARTS_BYTES) return tooLarge;
      const xml = entry.asText();
      total += xml.length;
      if (total > MAX_DOCX_TEXT_PARTS_BYTES) return tooLarge;
      if (part === 'properties') {
        parts.push({ part, text: propertyPartText(xml) });
        continue;
      }
      const text = docxPartText(xml);
      parts.push({ part, text: text.visible });
      if (text.deleted) parts.push({ part: 'deleted', text: text.deleted });
      if (text.fieldCodes) parts.push({ part: 'field', text: text.fieldCodes });
    }
  }
  return { ok: true, parts };
}

/** The values a fillable PDF already carries in its fields, one per line. */
export async function readPdfTextParts(bytes: Uint8Array): Promise<PartsResult> {
  try {
    const form = (await PDFDocument.load(bytes)).getForm();
    const lines: string[] = [];
    for (const field of form.getFields()) {
      // Only a text field can carry a name; a checkbox holds a tick.
      if (!(field instanceof PDFTextField)) continue;
      const text = field.getText();
      if (text) lines.push(text);
    }
    return { ok: true, parts: lines.length ? [{ part: 'body', text: lines.join('\n') }] : [] };
  } catch {
    return { ok: false, error: 'This file could not be read as a PDF.' };
  }
}

/**
 * Refuse to store `stored` while it names a firm client the caller has not
 * acknowledged. `uploaded` is the file as it arrived, read only to see which
 * clients the document is about (their full names have usually been bracketed
 * out of `stored` by now).
 *
 * Throws a refusal carrying `clientTextRefused`, whether it found client
 * details or could not check: the caller must stop on either.
 */
export async function assertNoLeftoverClientText({
  lawFirmId,
  userId,
  stored,
  uploaded,
  acknowledged,
}: {
  lawFirmId: string;
  userId: string;
  stored: PartsResult;
  uploaded: PartsResult;
  acknowledged: readonly string[] | undefined;
}): Promise<void> {
  // The guard reads every client and matter of the firm. A role that cannot
  // see those records cannot have a template checked against them.
  const member = await loadResolvedMember(lawFirmId, userId);
  if (!hasPermission(member, 'clients.view') || !hasPermission(member, 'matters.view')) {
    throw clientTextUncheckable(
      "This template can't be checked for client details, because your role can't see all client and case records. Ask an admin to save it.",
      403,
      'TEMPLATE_CLIENT_TEXT_UNCHECKABLE',
    );
  }
  if (!stored.ok) throw clientTextUncheckable(stored.error, 400, 'TEMPLATE_CLIENT_TEXT_CHECK_FAILED');
  if (!uploaded.ok) throw clientTextUncheckable(uploaded.error, 400, 'TEMPLATE_CLIENT_TEXT_CHECK_FAILED');

  let values;
  try {
    values = assembleFirmKnownValues(await loadFirmKnownValueRows(lawFirmId, { strict: true }));
  } catch (error: any) {
    console.error('[word-templates] could not load firm records for the client-text check:', error?.message);
    throw clientTextUncheckable(
      "Couldn't check this template for client details. Try saving again.",
      503,
      'TEMPLATE_CLIENT_TEXT_CHECK_FAILED',
    );
  }

  const leftovers = findLeftoverClientText(stored.parts, values, uploaded.parts);
  if (leftovers.length === 0) return;
  const seen = new Set(acknowledged ?? []);
  if (leftovers.some((l) => !seen.has(l.literal))) throw leftoverRefusal(leftovers);
}
