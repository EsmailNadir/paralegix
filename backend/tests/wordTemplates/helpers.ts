/**
 * Shared fixtures for the Word-first template route specs.
 *
 * Every spec that imports this must also call `installInMemoryBucket()` at its
 * own module scope, before the app is first required (see inMemoryBucket.ts).
 */
import { randomUUID } from 'crypto';
import { PDFDocument, PDFTextField } from 'pdf-lib';
import { landUpload, objects } from '../support/inMemoryBucket';
import { testPool, type Actor } from '../support/setupInProcess';

const PizZip = require('pizzip');

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const WT = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/word-templates`;

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A run of text, optionally highlighted the way an author marks a blank in Word. */
export const run = (text: string, highlight?: string) => (highlight
  ? `<w:r><w:rPr><w:highlight w:val="${highlight}"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
  : `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`);

export const para = (...runs: string[]) => `<w:p>${runs.join('')}</w:p>`;

/** The smallest package Word and docxtemplater both accept, plus optional extra parts. */
export function buildDocx(bodyXml: string, extraParts: Record<string, string> = {}): Buffer {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${bodyXml}</w:body></w:document>`);
  for (const [path, xml] of Object.entries(extraParts)) zip.file(path, xml);
  return zip.generate({ type: 'nodebuffer' });
}

/** A .docx whose body is one plain paragraph per line. */
export const docxOf = (...lines: string[]) => buildDocx(lines.map((l) => para(run(l))).join(''));

/** The visible body text of a stored .docx, paragraph per line. */
export function docxText(buffer: Buffer): string {
  const xml: string = new PizZip(buffer).file('word/document.xml').asText();
  return xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .trim();
}

/** A fillable PDF with the given text fields (and optional preset values). */
export async function pdfForm(fields: Array<{ name: string; value?: string; checkbox?: boolean }>): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const form = pdf.getForm();
  fields.forEach((f, i) => {
    const y = 700 - i * 40;
    if (f.checkbox) {
      form.createCheckBox(f.name).addToPage(page, { x: 60, y, width: 16, height: 16 });
    } else {
      const text = form.createTextField(f.name);
      text.addToPage(page, { x: 60, y, width: 300, height: 24 });
      if (f.value) text.setText(f.value);
    }
  });
  return Buffer.from(await pdf.save());
}

/** The fields of a stored PDF form and their current values. */
export async function pdfFieldValues(bytes: Buffer): Promise<Record<string, string | undefined>> {
  const form = (await PDFDocument.load(bytes)).getForm();
  return Object.fromEntries(form.getFields()
    .filter((f): f is PDFTextField => f instanceof PDFTextField)
    .map((f) => [f.getName(), f.getText()]));
}

/**
 * Play the browser's part of a direct upload: open the session through the
 * route, then land the bytes where it points. Returns the settled-to-be path.
 */
export async function upload(
  actor: Actor,
  lawFirmId: string,
  body: Buffer,
  fileName: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const contentType = fileName.endsWith('.pdf') ? 'application/pdf'
    : fileName.endsWith('.png') ? 'image/png'
      : DOCX_MIME;
  const res = await actor.api.post(`${WT(lawFirmId)}/upload-init`).send({
    fileName,
    contentType,
    size: body.length,
    purpose: 'source',
    ...extra,
  });
  if (res.status !== 200) throw new Error(`upload-init answered ${res.status}: ${JSON.stringify(res.body)}`);
  landUpload(res.body.objectPath, { body });
  return res.body.objectPath;
}

/** The bytes stored at an object path, or undefined. */
export const stored = (path: string): Buffer | undefined => objects.get(path)?.body;

export async function wordTemplateRow(id: string) {
  const { rows } = await testPool.query('select * from word_templates where id = $1', [id]);
  return rows[0];
}

export async function wordTemplateCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int n from word_templates where law_firm_id = $1',
    [lawFirmId],
  );
  return rows[0].n;
}

/** A matter with optional court, number and lead attorney, seeded through SQL. */
export async function seedMatter(lawFirmId: string, overrides: {
  name?: string; matterNumber?: string | null; courtId?: string | null; leadUserId?: string | null;
  description?: string | null; status?: string; openDate?: string | null; statuteOfLimitationsDate?: string | null;
  customFields?: Record<string, unknown>; matterReferenceId?: string;
} = {}): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status, matter_number, court_id,
                          lead_user_id, description, open_date, statute_of_limitations_date, custom_fields)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      lawFirmId,
      overrides.name ?? `Matter ${id.slice(0, 6)}`,
      overrides.matterReferenceId ?? `M-${id.slice(0, 8)}`,
      overrides.status ?? 'active',
      overrides.matterNumber ?? null,
      overrides.courtId ?? null,
      overrides.leadUserId ?? null,
      overrides.description ?? null,
      overrides.openDate ?? null,
      overrides.statuteOfLimitationsDate ?? null,
      JSON.stringify(overrides.customFields ?? {}),
    ],
  );
  return id;
}

export async function linkClient(lawFirmId: string, matterId: string, clientId: string): Promise<void> {
  await testPool.query(
    'insert into matter_clients (law_firm_id, matter_id, client_id) values ($1, $2, $3)',
    [lawFirmId, matterId, clientId],
  );
}

export async function addMatterMember(lawFirmId: string, matterId: string, userId: string): Promise<void> {
  await testPool.query(
    'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
    [lawFirmId, matterId, userId],
  );
}

export async function seedCourt(lawFirmId: string, fields: { name: string; address?: string; city?: string; state?: string }): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into courts (id, law_firm_id, name, address, city, state)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, lawFirmId, fields.name, fields.address ?? null, fields.city ?? null, fields.state ?? null],
  );
  return id;
}

/** A directory contact attached to a matter in one role (judge, opposing_party, ...). */
export async function seedMatterContact(
  lawFirmId: string,
  matterId: string,
  role: string,
  fields: { name: string; email?: string },
): Promise<string> {
  const contactId = randomUUID();
  await testPool.query(
    `insert into contacts (id, law_firm_id, name, category, email) values ($1, $2, $3, $4, $5)`,
    [contactId, lawFirmId, fields.name, role, fields.email ?? null],
  );
  await testPool.query(
    `insert into matter_contacts (law_firm_id, matter_id, contact_id, role) values ($1, $2, $3, $4)`,
    [lawFirmId, matterId, contactId, role],
  );
  return contactId;
}
