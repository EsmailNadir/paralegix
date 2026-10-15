/**
 * DOCX template boundaries: what happens when the uploaded bytes are not a
 * usable DOCX, and what a fill produces when a declared merge field has no
 * value.
 *
 * `docx.service.ts`'s `loadDocxZip` already guards against a handful of
 * malformed shapes (not a zip at all, too many entries, an oversized
 * uncompressed payload, a zip missing `word/document.xml`) by catching PizZip
 * and rejecting before Docxtemplater ever sees the buffer. None of those
 * guards had ever been driven through the real upload routes. Every existing template test
 * seeds rows with SQL specifically because GCS is inert in the harness, which
 * means the create/update service functions that actually call
 * `parseDocxPlaceholders`/`fillDocxTemplate` on caller-supplied bytes had zero
 * coverage. This file swaps in an in-memory bucket (mirroring
 * `templateHtmlStorage.test.ts`) so those real code paths run end to end.
 *
 * It also pins a real defect found while building the malformed-upload
 * fixtures: `fillDocxTemplate` never passed a `nullGetter` to Docxtemplater,
 * so its library default takes over - which returns the literal STRING
 * `"undefined"` for any simple tag with no matching key in the fill data
 * (`node_modules/docxtemplater/js/doc-utils.js`'s `getDefaults().nullGetter`).
 * A firm filling a template that references a field the caller forgot to
 * supply - a common mistake, not an attack - got a delivered document with
 * the word "undefined" typed into a client-facing legal document instead of a
 * blank or a clear error. The fix passes a `nullGetter` that renders empty.
 *
 *   __TEST_TOKEN__=offline npx jest tests/templates/templateDocxUpload.test.ts
 */
import { randomUUID } from 'crypto';
const PizZip = require('pizzip');
import { objects, landUpload, installInMemoryBucket } from '../support/inMemoryBucket';

import {
  testPool,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const T = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/templates`;

installInMemoryBucket();

/**
 * The smallest zip PizZip/Docxtemplater will accept as a real DOCX: a content
 * types part, a package relationship, and `word/document.xml` with one
 * paragraph. `extraEntries` pads the archive with cheap junk files to build
 * the zip-bomb-by-entry-count fixture without needing real bulk.
 */
function buildDocx(bodyXml: string, extraEntries = 0): Buffer {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`);
  for (let i = 0; i < extraEntries; i += 1) {
    zip.file(`junk/${i}.txt`, 'x');
  }
  return zip.generate({ type: 'nodebuffer' });
}

const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const templateRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select name, type, fields, docx_object_path from templates where id = $1',
    [id],
  );
  return rows[0];
};

const templateCount = async (lawFirmId: string) => {
  const { rows } = await testPool.query(
    'select count(*)::int n from templates where law_firm_id = $1',
    [lawFirmId],
  );
  return rows[0].n;
};

async function uploadDocx(
  actor: Actor,
  lawFirmId: string,
  buffer: Buffer,
  fileName: string,
  name: string,
) {
  const init = await actor.api.post(`${T(lawFirmId)}/upload-docx-init`).send({
    fileName,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: buffer.length,
  });
  expect(init.status).toBe(200);
  landUpload(init.body.objectPath, { body: buffer });
  return actor.api.post(`${T(lawFirmId)}/upload-docx-finalize`).send({
    objectPath: init.body.objectPath,
    fileName,
    name,
  });
}

/** The document.xml text inside a returned/stored DOCX buffer. */
const documentXmlOf = (docxBuffer: Buffer) => new PizZip(docxBuffer).files['word/document.xml'].asText();

/**
 * The document a fill produced, read out of storage.
 *
 * The fill route answers with a signed URL rather than the bytes, so the
 * document is in the bucket rather than in the response. What each case below
 * asserts about the filled XML is unchanged; only where it picks the bytes up
 * has moved.
 */
function filledDocument(): Buffer {
  const rendered = [...objects.entries()].filter(([path]) => path.includes('/template-renders/'));
  if (rendered.length !== 1) {
    throw new Error(`Expected exactly one render, found ${rendered.length}`);
  }
  const body = rendered[0][1].body;
  if (!body) throw new Error('Expected the render to contain bytes');
  return body;
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('uploading a DOCX through storage', () => {
  const upload = (buffer: Buffer, filename = 'agreement.docx', name = 'Agreement') =>
    uploadDocx(owner, firm.id, buffer, filename, name);

  it('rejects bytes that are not a zip at all, and creates no template row', async () => {
    const res = await upload(Buffer.from('this is plain text, not a docx'));

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Invalid DOCX/i);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('rejects a truncated DOCX (valid header, body cut short) instead of crashing', async () => {
    const whole = buildDocx(paragraph('Hello {client_name}'));
    const truncated = whole.subarray(0, Math.floor(whole.length / 2));

    const res = await upload(truncated);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Invalid DOCX/i);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('rejects a valid zip that is missing word/document.xml (e.g. a renamed non-Word file)', async () => {
    // A minimal zip that parses fine as an archive but carries none of the
    // Word package parts - the shape you get from renaming an .xlsx to .docx.
    const zip = new PizZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('xl/workbook.xml', '<workbook/>');
    const notWord = zip.generate({ type: 'nodebuffer' });

    const res = await upload(notWord);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Invalid DOCX/i);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('rejects a zip bomb of thousands of entries before ever handing it to the parser', async () => {
    // MAX_ZIP_ENTRIES is 2000 in docx.service.ts; comfortably over that with
    // near-zero real bytes per entry, so this stays fast to build and run.
    const bomb = buildDocx(paragraph('Hello {client_name}'), 2500);

    const res = await upload(bomb);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Invalid DOCX/i);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('accepts a real DOCX and extracts its placeholder as a fillable field', async () => {
    const docx = buildDocx(paragraph('Dear {client_name}, welcome.'));

    const res = await upload(docx, 'agreement.docx', 'Engagement Letter');

    expect(res.status).toBe(201);
    expect(res.body.template.fields).toEqual(['client_name']);
    const row = await templateRow(res.body.templateId);
    expect(row.type).toBe('docx');
    expect(objects.get(row.docx_object_path)?.body?.length).toBe(docx.length);
  });
});

describe('re-uploading a DOCX onto an existing template through storage', () => {
  it('leaves the previous document and fields untouched when the new upload is corrupt', async () => {
    const original = buildDocx(paragraph('Dear {client_name}, welcome.'));
    const created = await uploadDocx(owner, firm.id, original, 'agreement.docx', 'Engagement Letter');
    expect(created.status).toBe(201);
    const templateId = created.body.templateId;
    const before = await templateRow(templateId);
    const storedBefore = objects.get(before.docx_object_path)?.body;

    const replacement = Buffer.from('garbage, not a docx');
    const init = await owner.api.post(`${T(firm.id)}/${templateId}/upload-docx-init`).send({
      fileName: 'replacement.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: replacement.length,
    });
    expect(init.status).toBe(200);
    landUpload(init.body.objectPath, { body: replacement });
    const res = await owner.api.post(`${T(firm.id)}/${templateId}/upload-docx-finalize`).send({
      objectPath: init.body.objectPath,
      fileName: 'replacement.docx',
      name: 'Engagement Letter',
    });

    expect(res.status).toBe(400);
    const after = await templateRow(templateId);
    expect(after.docx_object_path).toBe(before.docx_object_path);
    expect(after.fields).toEqual(before.fields);
    // The storage object itself was never overwritten either - the parse
    // failure happens before updateDocxTemplate ever calls saveTemplateObject.
    expect(objects.get(after.docx_object_path)?.body).toEqual(storedBefore);
  });
});

describe('filling a DOCX template', () => {
  async function createFilledTemplate(bodyXml: string) {
    const docx = buildDocx(bodyXml);
    const created = await uploadDocx(owner, firm.id, docx, 'agreement.docx', 'Fill Target');
    expect(created.status).toBe(201);
    return created.body.templateId as string;
  }

  it('renders a blank instead of the literal word "undefined" when a declared field has no value', async () => {
    // Two fields declared; only one is supplied at fill time, exactly like a
    // firm member skipping an optional field in the fill form.
    const templateId = await createFilledTemplate(
      paragraph('Hello {client_name}, your matter number is {matter_number}.'),
    );

    const res = await owner.api
      .post(`${T(firm.id)}/${templateId}/fill`)
      .send({ values: { client_name: 'Alice Chen' }, format: 'docx' });

    expect(res.status).toBe(200);
    const xml = documentXmlOf(filledDocument());
    expect(xml).toContain('Alice Chen');
    // This is the defect: Docxtemplater's own default nullGetter renders the
    // JS string "undefined" for any tag absent from the data object, so a
    // real client-facing document used to come back reading "matter number is
    // undefined." fillDocxTemplate now passes an explicit nullGetter so a
    // missing field resolves to an empty string instead.
    expect(xml).not.toMatch(/undefined/);
    expect(xml).toContain('your matter number is .');
  });

  it('safely escapes CJK text and HTML-special characters into the DOCX XML without corrupting it or injecting markup', async () => {
    const templateId = await createFilledTemplate(paragraph('Client: {client_name}'));
    // Mirrors the real non-Latin failure mode from the signing PDF finalize fix
    // (B09.4), plus a literal tag/quote/ampersand to confirm the substituted
    // value is escaped as XML text rather than spliced in as raw markup.
    const adversarial = '田中太郎 <script>alert(1)</script> & "quoted" \'value\'';

    const res = await owner.api
      .post(`${T(firm.id)}/${templateId}/fill`)
      .send({ values: { client_name: adversarial }, format: 'docx' });

    expect(res.status).toBe(200);
    const xml = documentXmlOf(filledDocument());
    // The zip has to still be a valid, single-part document - PizZip parsing
    // it back out (via documentXmlOf) and finding the CJK text is itself proof
    // the archive round-tripped intact.
    expect(xml).toContain('田中太郎');
    // No raw, executable-looking markup was spliced into the XML: the angle
    // brackets from the value are escaped entities, not a real element.
    expect(xml).not.toContain('<script>');
    expect(xml).toContain('&lt;script&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;quoted&quot;');
  });
});
