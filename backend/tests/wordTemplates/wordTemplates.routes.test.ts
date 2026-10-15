/**
 * The Word-first template library through its real routes: the html editor's
 * CRUD, the library list, rename and delete, the stored-file reads, the fills,
 * the asset upload and the HTML export.
 *
 * Firm isolation comes first in every group: a template is a firm's own
 * precedent, and a route that answers another firm's caller is the defect that
 * never looks wrong on screen.
 *
 *   npx jest tests/wordTemplates/wordTemplates.routes.test.ts
 */
import { installInMemoryBucket, objects, putObject } from '../support/inMemoryBucket';
import {
  createFirm,
  memberWith,
  ownerOf,
  stranger,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  DOCX_MIME,
  WT,
  docxOf,
  docxText,
  pdfForm,
  pdfFieldValues,
  stored,
  upload,
  wordTemplateCount,
  wordTemplateRow,
} from './helpers';
import { UNFILLED_FIELDS_HEADER, decodeUnfilledFields } from '../../src/modules/wordTemplates/lib/unfilled-fields';
import * as converter from '../../src/shared/documentConversion/converter';
import * as pdfRenderer from '../../src/shared/documentConversion/pdfRenderer';
import http from 'http';
import type { AddressInfo } from 'net';

const PizZip = require('pizzip');

/** A valid 1x1 transparent PNG. */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

installInMemoryBucket();

let firmA: Firm;
let firmB: Firm;
let ownerA: Actor;
let ownerB: Actor;

beforeEach(async () => {
  objects.clear();
  firmA = await createFirm();
  firmB = await createFirm();
  ownerA = await ownerOf(firmA.id);
  ownerB = await ownerOf(firmB.id);
});

afterEach(() => {
  jest.restoreAllMocks();
  installInMemoryBucket();
});

/** A docx template created through the no-review upload route. */
async function createDocxTemplate(actor: Actor, lawFirmId: string, body: Buffer, name = 'Engagement Letter') {
  const objectPath = await upload(actor, lawFirmId, body, `${name}.docx`);
  const res = await actor.api.post(`${WT(lawFirmId)}/upload-docx`).send({
    objectPath, fileName: `${name}.docx`, name,
  });
  if (res.status !== 201) throw new Error(`upload-docx answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.templateId as string;
}

/** A pdf-form template committed through the review route with no renames. */
async function createPdfTemplate(actor: Actor, lawFirmId: string, body: Buffer, name = 'Court Form') {
  const objectPath = await upload(actor, lawFirmId, body, `${name}.pdf`);
  const res = await actor.api.post(`${WT(lawFirmId)}/commit`).send({
    objectPath, fileName: `${name}.pdf`, name, edits: [],
  });
  if (res.status !== 201) throw new Error(`commit answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.templateId as string;
}

/** An editor chip: how the html editor marks a placeholder. */
const chip = (name: string) => `<span data-placeholder-chip="${name}">{${name}}</span>`;
const LETTER_HTML = `<p>Dear ${chip('client_name')},</p>`;

async function createHtmlTemplate(actor: Actor, lawFirmId: string, html = LETTER_HTML, name = 'Letter') {
  const res = await actor.api.post(WT(lawFirmId)).send({ name, html });
  if (res.status !== 201) throw new Error(`create answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.templateId as string;
}

describe('access to the module', () => {
  it('refuses a caller with no membership in the firm', async () => {
    const res = await stranger().api.get(WT(firmA.id));
    expect(res.status).toBe(403);
  });

  it('refuses a firm whose plan does not include templates', async () => {
    const starter = await createFirm({ planId: 'starter' });
    const starterOwner = await ownerOf(starter.id);
    const res = await starterOwner.api.get(WT(starter.id));
    expect(res.status).toBe(403);
  });

  it('lets a member with only the baseline read the library but not write to it', async () => {
    const reader = await memberWith(firmA.id, []);
    expect((await reader.api.get(WT(firmA.id))).status).toBe(200);
    const write = await reader.api.post(WT(firmA.id)).send({ name: 'X', html: '<p>x</p>' });
    expect(write.status).toBe(403);
    expect(await wordTemplateCount(firmA.id)).toBe(0);
  });
});

describe('html templates: create, read, update', () => {
  it('creates an html template, storing its body in storage and its fields on the row', async () => {
    const res = await ownerA.api.post(WT(firmA.id)).send({
      name: 'Welcome Letter',
      html: `<p>Dear ${chip('client_name')}, re ${chip('case_number')}.</p><p data-repeater="payments">${chip('payment_date')}</p>`,
    });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Template created successfully');
    expect(res.body.template).toMatchObject({
      id: res.body.templateId,
      name: 'Welcome Letter',
      type: 'html',
      folderId: null,
    });
    expect(res.body.template.html).toContain('Dear <span data-placeholder-chip="client_name">');
    const row = await wordTemplateRow(res.body.templateId);
    expect(row.law_firm_id).toBe(firmA.id);
    expect(row.created_by).toBe(ownerA.uid);
    expect(row.fields).toEqual(['case_number', 'client_name', 'payments.payment_date']);
    expect(row.repeaters).toEqual([{ name: 'payments', fields: ['payment_date'] }]);
    expect(row.html_object_path).toMatch(new RegExp(`^lawfirmids/${firmA.id}/word-templates/`));
    expect(stored(row.html_object_path)?.toString('utf8')).toContain('data-placeholder-chip="client_name"');
  });

  it('strips script from the stored body', async () => {
    const id = await createHtmlTemplate(ownerA, firmA.id, '<p>Hi</p><script>alert(1)</script>');
    const res = await ownerA.api.get(`${WT(firmA.id)}/${id}`);
    expect(res.body.template.html).toContain('<p>Hi</p>');
    expect(res.body.template.html).not.toContain('script');
  });

  it('reads one template with its html, and lists the library without it', async () => {
    const id = await createHtmlTemplate(ownerA, firmA.id);
    const one = await ownerA.api.get(`${WT(firmA.id)}/${id}`);
    expect(one.status).toBe(200);
    expect(one.body.template.html).toBe(LETTER_HTML);
    expect(one.body.template.assets).toEqual([]);

    const list = await ownerA.api.get(WT(firmA.id));
    expect(list.status).toBe(200);
    expect(list.body.templates).toHaveLength(1);
    expect(list.body.templates[0]).toMatchObject({ id, name: 'Letter', type: 'html', fields: ['client_name'] });
    expect(list.body.templates[0]).not.toHaveProperty('html');
  });

  it('lists templates by name', async () => {
    await createHtmlTemplate(ownerA, firmA.id, '<p>a</p>', 'Zeta');
    await createHtmlTemplate(ownerA, firmA.id, '<p>b</p>', 'Alpha');
    const list = await ownerA.api.get(WT(firmA.id));
    expect(list.body.templates.map((t: any) => t.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('updates the body and re-extracts the fields', async () => {
    const id = await createHtmlTemplate(ownerA, firmA.id);
    const res = await ownerA.api.put(`${WT(firmA.id)}/${id}`).send({
      name: 'Letter v2', html: `<p>${chip('firm_name')}</p>`,
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Template updated successfully');
    expect(res.body.template).toMatchObject({ name: 'Letter v2', fields: ['firm_name'], html: `<p>${chip('firm_name')}</p>` });
    expect((await wordTemplateRow(id)).fields).toEqual(['firm_name']);
  });

  it('refuses to write HTML over a Word template, leaving its file untouched', async () => {
    const id = await createDocxTemplate(ownerA, firmA.id, docxOf('Dear {client_name}'));
    const before = await wordTemplateRow(id);

    const res = await ownerA.api.put(`${WT(firmA.id)}/${id}`).send({ name: 'X', html: '<p>converted</p>' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEMPLATE_HTML_WRITE_REJECTED');
    expect(res.body.error).toBe(
      'This is a Word template: the uploaded .docx is its content, and it fills without losing formatting. '
      + 'Saving an HTML version over it would replace that with a converted approximation. Use Re-upload '
      + 'to change the document, or edit it in the Word editor.',
    );
    const after = await wordTemplateRow(id);
    expect(after.html_object_path).toBeNull();
    expect(after.source_object_path).toBe(before.source_object_path);
    expect(after.name).toBe(before.name);
  });

  it('refuses to write HTML over a fillable-PDF template', async () => {
    const id = await createPdfTemplate(ownerA, firmA.id, await pdfForm([{ name: 'client_name' }]));
    const res = await ownerA.api.put(`${WT(firmA.id)}/${id}`).send({ name: 'X', html: '<p>x</p>' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^This is a fillable-PDF template: the uploaded PDF is its content/);
    expect((await wordTemplateRow(id)).html_object_path).toBeNull();
  });

  it('refuses an html body over 5 MB', async () => {
    const res = await ownerA.api.post(WT(firmA.id)).send({ name: 'Big', html: `<p>${'x'.repeat(5 * 1024 * 1024)}</p>` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Template body too large.');
    expect(await wordTemplateCount(firmA.id)).toBe(0);
  });
});

describe('firm isolation of a stored template', () => {
  it('answers another firm\'s owner with not found on every per-template route', async () => {
    const docxId = await createDocxTemplate(ownerA, firmA.id, docxOf('Dear {client_name}'));
    const htmlId = await createHtmlTemplate(ownerA, firmA.id);

    // Firm B's owner, addressing firm B's own URL with firm A's template id.
    const B = WT(firmB.id);
    const reads = await Promise.all([
      ownerB.api.get(`${B}/${htmlId}`),
      ownerB.api.get(`${B}/${docxId}/fields`),
      ownerB.api.get(`${B}/${docxId}/docx-source`),
      ownerB.api.post(`${B}/${docxId}/fill-docx`).send({ values: { client_name: 'Leak' } }),
    ]);
    for (const res of reads) expect(res.status).toBe(404);

    const writes = await Promise.all([
      ownerB.api.put(`${B}/${htmlId}`).send({ name: 'Hijack', html: '<p>x</p>' }),
      ownerB.api.patch(`${B}/${docxId}`).send({ name: 'Hijack' }),
      ownerB.api.delete(`${B}/${docxId}`),
    ]);
    for (const res of writes) expect(res.status).toBe(404);

    expect((await wordTemplateRow(htmlId)).name).toBe('Letter');
    expect((await wordTemplateRow(docxId)).name).toBe('Engagement Letter');
    expect(stored((await wordTemplateRow(docxId)).source_object_path)).toBeDefined();
  });

  it('refuses firm B\'s owner on firm A\'s URL before reaching a template', async () => {
    const id = await createHtmlTemplate(ownerA, firmA.id);
    const res = await ownerB.api.delete(`${WT(firmA.id)}/${id}`);
    expect(res.status).toBe(403);
    expect(await wordTemplateRow(id)).toBeDefined();
  });

  it('lists only the caller\'s firm', async () => {
    await createHtmlTemplate(ownerA, firmA.id, '<p>a</p>', 'Firm A only');
    await createHtmlTemplate(ownerB, firmB.id, '<p>b</p>', 'Firm B only');
    const list = await ownerB.api.get(WT(firmB.id));
    expect(list.body.templates.map((t: any) => t.name)).toEqual(['Firm B only']);
  });

  it('answers a malformed id as not found rather than a server error', async () => {
    const res = await ownerA.api.get(`${WT(firmA.id)}/not-a-uuid`);
    expect(res.status).toBe(404);
  });
});

describe('rename and delete', () => {
  it('renames a template', async () => {
    const id = await createDocxTemplate(ownerA, firmA.id, docxOf('Dear {client_name}'));
    const res = await ownerA.api.patch(`${WT(firmA.id)}/${id}`).send({ name: '  Retainer Letter  ' });
    expect(res.status).toBe(200);
    expect(res.body.template.name).toBe('Retainer Letter');
    expect((await wordTemplateRow(id)).name).toBe('Retainer Letter');
  });

  it('refuses an empty name', async () => {
    const id = await createHtmlTemplate(ownerA, firmA.id);
    const res = await ownerA.api.patch(`${WT(firmA.id)}/${id}`).send({ name: '   ' });
    expect(res.status).toBe(400);
    expect((await wordTemplateRow(id)).name).toBe('Letter');
  });

  it('deletes the row and its stored file', async () => {
    const id = await createDocxTemplate(ownerA, firmA.id, docxOf('Dear {client_name}'));
    const { source_object_path: path } = await wordTemplateRow(id);
    expect(stored(path)).toBeDefined();

    const res = await ownerA.api.delete(`${WT(firmA.id)}/${id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Template deleted successfully', templateId: id });
    expect(await wordTemplateRow(id)).toBeUndefined();
    expect(objects.has(path)).toBe(false);
  });

  it('deletes an html template\'s body and its images', async () => {
    const id = await createHtmlTemplate(ownerA, firmA.id);
    const assetPath = await upload(ownerA, firmA.id, Buffer.from('\x89PNG\r\n\x1a\nimg'), 'logo.png', { purpose: 'asset', templateId: id });
    const fin = await ownerA.api.post(`${WT(firmA.id)}/${id}/assets/finalize`).send({ objectPath: assetPath, fileName: 'logo.png' });
    expect(fin.status).toBe(201);
    const row = await wordTemplateRow(id);

    await ownerA.api.delete(`${WT(firmA.id)}/${id}`).expect(200);

    expect(objects.has(row.html_object_path)).toBe(false);
    expect(objects.has(row.assets[0].object_path)).toBe(false);
  });
});

describe('the stored file', () => {
  it('re-reads the live fields from the stored .docx', async () => {
    const id = await createDocxTemplate(ownerA, firmA.id, docxOf('Dear {client_name}', '{#rows}{date}{/rows}'));
    // The row's copy lags the file: the file is what the fill form must follow.
    await testPool.query("update word_templates set fields = '{stale}' where id = $1", [id]);

    const res = await ownerA.api.get(`${WT(firmA.id)}/${id}/fields`);

    expect(res.status).toBe(200);
    expect(res.body.fillFields).toEqual({
      fields: ['client_name', 'rows.date'],
      repeaters: [{ name: 'rows', fields: ['date'] }],
    });
  });

  it('answers null fill fields for an html template', async () => {
    const id = await createHtmlTemplate(ownerA, firmA.id);
    const res = await ownerA.api.get(`${WT(firmA.id)}/${id}/fields`);
    expect(res.status).toBe(200);
    expect(res.body.fillFields).toBeNull();
  });

  it('serves the stored .docx byte for byte', async () => {
    const original = docxOf('Dear {client_name}');
    const id = await createDocxTemplate(ownerA, firmA.id, original);
    const res = await ownerA.api.get(`${WT(firmA.id)}/${id}/docx-source`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(DOCX_MIME);
    expect(Buffer.compare(res.body, original)).toBe(0);
  });

  it('answers 404 for the source of a template that is not a .docx', async () => {
    const id = await createHtmlTemplate(ownerA, firmA.id);
    const res = await ownerA.api.get(`${WT(firmA.id)}/${id}/docx-source`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not a DOCX template.');
  });
});

/** supertest parser that keeps a binary body as a Buffer. */
function binary(res: any, callback: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('filling a Word template', () => {
  it('fills the stored .docx and reports the tags left blank', async () => {
    const id = await createDocxTemplate(ownerA, firmA.id, docxOf('Dear {client_name},', 'Re: {case_number}'));

    const res = await ownerA.api.post(`${WT(firmA.id)}/${id}/fill-docx`)
      .send({ values: { client_name: 'Corwin Thistlewood' }, fileName: 'Letter to client' })
      .buffer(true).parse(binary);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(DOCX_MIME);
    expect(res.headers['content-disposition']).toBe('attachment; filename="Letter_to_client.docx"');
    expect(decodeUnfilledFields(res.headers[UNFILLED_FIELDS_HEADER.toLowerCase()])).toEqual(['case_number']);
    expect(docxText(res.body)).toBe('Dear Corwin Thistlewood,\nRe:');
  });

  it('exposes the unfilled-fields header to a cross-origin browser', async () => {
    const id = await createDocxTemplate(ownerA, firmA.id, docxOf('Dear {client_name},'));
    const res = await ownerA.api.post(`${WT(firmA.id)}/${id}/fill-docx`)
      .set('Origin', 'http://localhost:3000')
      .send({ values: {} });
    expect(res.status).toBe(200);
    expect(String(res.headers['access-control-expose-headers'])).toContain(UNFILLED_FIELDS_HEADER);
  });

  it('converts the filled document to PDF when asked', async () => {
    const id = await createDocxTemplate(ownerA, firmA.id, docxOf('Dear {client_name},'));
    const convert = jest.spyOn(converter, 'convertDocument').mockResolvedValue(Buffer.from('%PDF-filled'));

    const res = await ownerA.api.post(`${WT(firmA.id)}/${id}/fill-docx`)
      .send({ values: { client_name: 'Ada' }, format: 'pdf' })
      .buffer(true).parse(binary);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.toString()).toBe('%PDF-filled');
    expect(convert).toHaveBeenCalledTimes(1);
    const [input, format] = convert.mock.calls[0];
    expect(format).toBe('pdf');
    expect(docxText(input as Buffer)).toBe('Dear Ada,');
  });

  it('refuses to fill a template of another type through the docx route', async () => {
    const id = await createHtmlTemplate(ownerA, firmA.id);
    const res = await ownerA.api.post(`${WT(firmA.id)}/${id}/fill-docx`).send({ values: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Template is not a DOCX template.');
  });

  it('lets a baseline member fill (templates.view)', async () => {
    const id = await createDocxTemplate(ownerA, firmA.id, docxOf('Dear {client_name},'));
    const reader = await memberWith(firmA.id, []);
    const res = await reader.api.post(`${WT(firmA.id)}/${id}/fill-docx`).send({ values: { client_name: 'A' } });
    expect(res.status).toBe(200);
  });
});

describe('filling a fillable PDF', () => {
  it('fills by field name, flattens, and reports blanks', async () => {
    const id = await createPdfTemplate(ownerA, firmA.id, await pdfForm([{ name: 'client_name' }, { name: 'case_number' }]));

    const res = await ownerA.api.post(`${WT(firmA.id)}/${id}/fill-pdf`)
      .send({ values: { client_name: 'Ada Lovelace' }, fileName: 'Form' })
      .buffer(true).parse(binary);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="Form.pdf"');
    expect(decodeUnfilledFields(res.headers[UNFILLED_FIELDS_HEADER.toLowerCase()])).toEqual(['case_number']);
    // Flattened: the result has no form fields left to edit.
    expect(await pdfFieldValues(res.body)).toEqual({});
  });

  it('refuses a docx template', async () => {
    const id = await createDocxTemplate(ownerA, firmA.id, docxOf('x'));
    const res = await ownerA.api.post(`${WT(firmA.id)}/${id}/fill-pdf`).send({ values: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Template is not a PDF form template.');
  });
});

describe('preview and conversion', () => {
  it('renders a Word template\'s stored file to PDF for preview', async () => {
    const id = await createDocxTemplate(ownerA, firmA.id, docxOf('Dear {client_name}'));
    const convert = jest.spyOn(converter, 'convertDocument').mockResolvedValue(Buffer.from('%PDF-preview'));

    const res = await ownerA.api.get(`${WT(firmA.id)}/${id}/preview-pdf`).buffer(true).parse(binary);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.body.toString()).toBe('%PDF-preview');
    expect(docxText(convert.mock.calls[0][0] as Buffer)).toBe('Dear {client_name}');
  });

  it('answers 404 for a preview of a non-Word template', async () => {
    const id = await createHtmlTemplate(ownerA, firmA.id);
    const res = await ownerA.api.get(`${WT(firmA.id)}/${id}/preview-pdf`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Template is not a DOCX template.');
  });

  it('converts a settled .docx upload and deletes the upload', async () => {
    jest.spyOn(converter, 'convertDocument').mockResolvedValue(Buffer.from('%PDF-converted'));
    const objectPath = await upload(ownerA, firmA.id, docxOf('hello'), 'draft.docx', { purpose: 'convert' });

    const res = await ownerA.api.post(`${WT(firmA.id)}/convert-docx-to-pdf`)
      .send({ objectPath, fileName: 'draft.docx' })
      .buffer(true).parse(binary);

    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('%PDF-converted');
    expect(objects.has(objectPath)).toBe(false);
  });

  it('refuses to convert an upload another firm opened', async () => {
    const objectPath = await upload(ownerB, firmB.id, docxOf('secret'), 'draft.docx', { purpose: 'convert' });
    const res = await ownerA.api.post(`${WT(firmA.id)}/convert-docx-to-pdf`).send({ objectPath, fileName: 'draft.docx' });
    expect(res.status).toBe(400);
    expect(objects.has(objectPath)).toBe(true);
  });

  it('refuses conversion to a member without templates.manage', async () => {
    const reader = await memberWith(firmA.id, []);
    const res = await reader.api.post(`${WT(firmA.id)}/convert-docx-to-pdf`).send({ objectPath: 'x', fileName: 'a.docx' });
    expect(res.status).toBe(403);
  });
});

describe('exporting filled html', () => {
  it('extracts plain text', async () => {
    const res = await ownerA.api.post(`${WT(firmA.id)}/export`).send({
      html: '<style>p{color:red}</style><p>Dear Ada,</p><p>Fees &amp; costs</p>',
      format: 'txt',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-disposition']).toBe('attachment; filename="document.txt"');
    expect(res.text).toBe('Dear Ada,\nFees & costs');
  });

  it('builds a Word document', async () => {
    const res = await ownerA.api.post(`${WT(firmA.id)}/export`)
      .send({ html: '<p>Dear Ada,</p>', format: 'docx' })
      .buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(DOCX_MIME);
    expect(docxText(res.body)).toContain('Dear Ada,');
  });

  it('never fetches an image address the html points at when building a Word document', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from(TINY_PNG, 'base64'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await ownerA.api.post(`${WT(firmA.id)}/export`)
        .send({ html: `<p>Dear Ada,</p><p><img src="http://127.0.0.1:${port}/metadata.png"></p>`, format: 'docx' })
        .buffer(true).parse(binary);

      expect(res.status).toBe(200);
      expect(docxText(res.body)).toContain('Dear Ada,');
      expect(hits).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps an inline image and the template\'s own stored image in a Word export', async () => {
    const id = await createHtmlTemplate(ownerA, firmA.id);
    const objectPath = await upload(ownerA, firmA.id, Buffer.from(TINY_PNG, 'base64'), 'logo.png', { purpose: 'asset', templateId: id });
    const asset = await ownerA.api.post(`${WT(firmA.id)}/${id}/assets/finalize`).send({ objectPath, fileName: 'logo.png' });
    expect(asset.status).toBe(201);

    const res = await ownerA.api.post(`${WT(firmA.id)}/export`)
      .send({
        html: `<p><img src="data:image/png;base64,${TINY_PNG}"></p>`
          + `<p><img data-template-asset-id="${asset.body.assetId}" src="https://storage.example/signed"></p>`,
        format: 'docx',
        templateId: id,
      })
      .buffer(true).parse(binary);

    expect(res.status).toBe(200);
    const media = Object.keys(new PizZip(res.body).files).filter((n) => /^word\/media\/.+\.png$/.test(n));
    expect(media).toHaveLength(2);
  });

  it('renders a PDF through the document renderer and cleans up after itself', async () => {
    const render = jest.spyOn(pdfRenderer, 'renderHtmlToStoredPdf').mockImplementation(async ({ outputObjectPath }) => {
      putObject(outputObjectPath, { body: Buffer.from('%PDF-export') });
      return { skippedAssets: 0 };
    });

    const res = await ownerA.api.post(`${WT(firmA.id)}/export`)
      .send({ html: '<p>Dear Ada,</p>', format: 'pdf' })
      .buffer(true).parse(binary);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.toString()).toBe('%PDF-export');
    const { outputObjectPath, html } = render.mock.calls[0][0];
    expect(html).toBe('<p>Dear Ada,</p>');
    expect(outputObjectPath).toMatch(new RegExp(`^lawfirmids/${firmA.id}/`));
    expect(objects.has(outputObjectPath)).toBe(false);
  });

  it('refuses html over 2 MB', async () => {
    const res = await ownerA.api.post(`${WT(firmA.id)}/export`).send({ html: 'x'.repeat(2_000_001), format: 'txt' });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('HTML payload is too large.');
  });
});

describe('editor images', () => {
  it('settles an uploaded image into the template\'s assets with a preview link', async () => {
    const id = await createHtmlTemplate(ownerA, firmA.id);
    const objectPath = await upload(ownerA, firmA.id, Buffer.from('\x89PNG\r\n\x1a\nimg'), 'logo.png', { purpose: 'asset', templateId: id });

    const res = await ownerA.api.post(`${WT(firmA.id)}/${id}/assets/finalize`).send({ objectPath, fileName: 'logo.png' });

    expect(res.status).toBe(201);
    expect(res.body.asset).toMatchObject({ id: res.body.assetId, mimeType: 'image/png', fileName: 'logo.png' });
    expect(res.body.asset.previewUrl).toEqual(expect.any(String));
    const row = await wordTemplateRow(id);
    expect(row.assets).toEqual([expect.objectContaining({ id: res.body.assetId, mime_type: 'image/png' })]);
    expect(row.assets[0].object_path).toMatch(new RegExp(`^lawfirmids/${firmA.id}/word-templates/${id}/assets/`));
    expect(stored(row.assets[0].object_path)).toBeDefined();
    expect(objects.has(objectPath)).toBe(false);

    // Kept while the html references it, dropped (and deleted) once it does not.
    const keep = await ownerA.api.put(`${WT(firmA.id)}/${id}`).send({
      name: 'Letter', html: `<p><img data-template-asset-id="${res.body.assetId}" src="x"></p>`,
    });
    expect(keep.body.template.assets).toHaveLength(1);
    const drop = await ownerA.api.put(`${WT(firmA.id)}/${id}`).send({ name: 'Letter', html: '<p>no image</p>' });
    expect(drop.body.template.assets).toEqual([]);
    expect(objects.has(row.assets[0].object_path)).toBe(false);
  });

  it('refuses an image that is not a raster type', async () => {
    const id = await createHtmlTemplate(ownerA, firmA.id);
    const res = await ownerA.api.post(`${WT(firmA.id)}/upload-init`).send({
      fileName: 'x.svg', contentType: 'image/svg+xml', size: 10, purpose: 'asset', templateId: id,
    });
    expect(res.status).toBe(415);
  });

  it('refuses to open or settle an image for another firm\'s template', async () => {
    const idA = await createHtmlTemplate(ownerA, firmA.id);
    const init = await ownerB.api.post(`${WT(firmB.id)}/upload-init`).send({
      fileName: 'logo.png', contentType: 'image/png', size: 10, purpose: 'asset', templateId: idA,
    });
    expect(init.status).toBe(404);

    // Even an upload firm B holds under its own prefix cannot be settled into firm A's template.
    const idB = await createHtmlTemplate(ownerB, firmB.id);
    const objectPath = await upload(ownerB, firmB.id, Buffer.from('\x89PNG\r\n\x1a\nimg'), 'logo.png', { purpose: 'asset', templateId: idB });
    const res = await ownerB.api.post(`${WT(firmB.id)}/${idA}/assets/finalize`).send({ objectPath, fileName: 'logo.png' });
    expect(res.status).toBe(404);
    expect((await wordTemplateRow(idA)).assets).toEqual([]);
  });

});
