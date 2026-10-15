/**
 * The Word-first template library's transport: every call the ported JJ screens
 * make, against `/api/lawfirms/:lawFirmId/word-templates`.
 *
 * Red if a call misses its route, if a body drops or renames a field the route
 * reads, if the domain key of an answer is not read, if a fill's
 * unfilled-field header is not decoded, or if a refusal from the client-details
 * check stops being a ClientTextCheckError carrying the leftovers. That last one
 * matters most: the editor treats an ordinary upload failure as non-fatal, so a
 * refusal read as a plain error would carry client text on into the template.
 */
import { installApiMock, type ApiMock } from '../support/apiMock';
import { installXhrMock, type XhrMock } from '../support/xhrMock';
import { ApiError } from '@/lib/utils/apiErrors';
import {
  ClientTextCheckError,
  wordTemplatesService,
} from '@/services/wordTemplates.service';

const FIRM = 'firm-1';
const BASE = `/api/lawfirms/${FIRM}/word-templates`;
const SESSION = 'https://storage.googleapis.com/upload/word-template-1';
const OBJECT = 'word-templates/firm-1/uploads/precedent.docx';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';


// jsdom's Blob has no text(); FileReader is what it does implement.
const readText = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

const editorTemplate = {
  id: 'tpl-1',
  name: 'Engagement letter',
  type: 'docx',
  fields: ['client_name'],
  repeaters: [],
  folderId: null,
  createdAt: '2026-10-01T12:00:00.000Z',
  html: null,
  docxStoragePath: 'word-templates/firm-1/tpl-1.docx',
  originalFileName: 'Engagement.docx',
  assets: [],
};

const leftover = {
  literal: 'Quillon Vantress',
  canonicalId: 'client_name',
  occurrences: 2,
  contextSnippet: 'Dear Quillon Vantress,',
  parts: ['body'],
};

let api: ApiMock;
let xhr: XhrMock;

beforeEach(() => {
  api = installApiMock();
  xhr = installXhrMock();
});

afterEach(() => {
  api.restore();
  xhr.restore();
});

function openUpload(purpose: string) {
  api.postExact(`${BASE}/upload-init`, (request) => {
    expect((request.body as { purpose?: string }).purpose).toBe(purpose);
    return { uploadUrl: SESSION, objectPath: OBJECT, contentType: (request.body as { contentType: string }).contentType };
  });
  xhr.onExact('PUT', SESSION, { status: 200 });
}

describe('library reads and writes', () => {
  it('lists the library from the data envelope', async () => {
    api.getExact(BASE, { templates: [{ id: 'tpl-1', name: 'Letter', type: 'html', fields: [], folderId: null, createdAt: 'x' }] });

    await expect(wordTemplatesService.list(FIRM)).resolves.toEqual([
      { id: 'tpl-1', name: 'Letter', type: 'html', fields: [], folderId: null, createdAt: 'x' },
    ]);
  });

  it('loads one template for the editor, with nulls read as absent', async () => {
    api.getExact(`${BASE}/tpl-1`, {
      template: {
        ...editorTemplate,
        assets: [{ id: 'a1', objectPath: 'p', mimeType: 'image/png', fileName: null, previewUrl: 'https://signed' }],
      },
    });

    const template = await wordTemplatesService.getById(FIRM, 'tpl-1');

    expect(template.html).toBeUndefined();
    expect(template.docxStoragePath).toBe('word-templates/firm-1/tpl-1.docx');
    expect(template.assets).toEqual([
      { id: 'a1', objectPath: 'p', mimeType: 'image/png', fileName: undefined, previewUrl: 'https://signed' },
    ]);
  });

  it('creates and updates with only the name and the html: the server re-extracts the fields', async () => {
    api.postExact(BASE, { status: 201, body: { message: 'created', templateId: 'tpl-1', template: { ...editorTemplate, type: 'html', html: '<p>{a}</p>' } } });
    api.putExact(`${BASE}/tpl-1`, { message: 'saved', template: { ...editorTemplate, type: 'html', html: '<p>{b}</p>' } });

    await wordTemplatesService.create(FIRM, { name: 'Letter', html: '<p>{a}</p>', fields: ['a'], repeaters: [] });
    await wordTemplatesService.update(FIRM, 'tpl-1', { name: 'Letter', html: '<p>{b}</p>', fields: ['b'] });

    expect(api.callsTo(BASE)[0].body).toEqual({ name: 'Letter', html: '<p>{a}</p>' });
    expect(api.callsTo(`${BASE}/tpl-1`).find((c) => c.method === 'PUT')?.body).toEqual({
      name: 'Letter',
      html: '<p>{b}</p>',
    });
  });

  it('refuses an html write onto a Word template with the server reason', async () => {
    api.putExact(`${BASE}/tpl-1`, {
      status: 400,
      body: { error: 'This is a Word template: the uploaded .docx is its content.', code: 'TEMPLATE_HTML_WRITE_REJECTED' },
    });

    await expect(
      wordTemplatesService.update(FIRM, 'tpl-1', { name: 'Letter', html: '<p/>' }),
    ).rejects.toThrow('This is a Word template: the uploaded .docx is its content.');
  });

  it('renames with PATCH and reloads the row', async () => {
    api.patchExact(`${BASE}/tpl-1`, { message: 'renamed', template: { id: 'tpl-1', name: 'Renamed' } });
    api.getExact(`${BASE}/tpl-1`, { template: { ...editorTemplate, name: 'Renamed' } });

    const renamed = await wordTemplatesService.renameTemplate(FIRM, 'tpl-1', 'Renamed');

    expect(api.calls('PATCH')[0].body).toEqual({ name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');
  });

  it('deletes by id', async () => {
    api.deleteExact(`${BASE}/tpl-1`, { message: 'deleted', templateId: 'tpl-1' });

    await wordTemplatesService.delete(FIRM, 'tpl-1');

    expect(api.calls('DELETE')).toHaveLength(1);
  });
});

describe('upload, scan and commit', () => {
  it('uploads the source straight to storage, then scans the settled object', async () => {
    openUpload('source');
    api.postExact(`${BASE}/detect`, { proposals: [{ kind: 'literal', literal: '$500.00' }] });
    const file = new File(['PK'], 'precedent.docx', { type: DOCX_TYPE });

    const scan = await wordTemplatesService.detect(FIRM, file);

    expect(api.callsTo(`${BASE}/upload-init`)[0].body).toEqual({
      fileName: 'precedent.docx',
      contentType: DOCX_TYPE,
      size: 2,
      purpose: 'source',
    });
    expect(xhr.calls('PUT')[0].headers.authorization).toBeUndefined();
    expect(api.callsTo(`${BASE}/detect`)[0].body).toEqual({ objectPath: OBJECT, fileName: 'precedent.docx' });
    expect(scan).toEqual({ objectPath: OBJECT, proposals: [{ kind: 'literal', literal: '$500.00' }] });
  });

  it('sends a scan error back as the server worded it', async () => {
    openUpload('source');
    api.postExact(`${BASE}/detect`, {
      status: 400,
      body: { error: 'This PDF has no fillable form fields, so there is nothing to name.', code: 'VALIDATION_ERROR' },
    });

    await expect(
      wordTemplatesService.detect(FIRM, new File(['%PDF'], 'form.pdf', { type: 'application/pdf' })),
    ).rejects.toThrow('This PDF has no fillable form fields, so there is nothing to name.');
  });

  it('commits the reviewed edits against the scanned object', async () => {
    api.postExact(`${BASE}/commit`, { status: 201, body: { message: 'saved', templateId: 'tpl-9', template: { id: 'tpl-9' } } });
    const edits = [{ kind: 'literal' as const, find: '$500.00', tag: 'flat_fee_amount' }];

    const result = await wordTemplatesService.commit(FIRM, {
      objectPath: OBJECT,
      fileName: 'precedent.docx',
      name: 'Precedent',
      edits,
      duplicateStrategy: 'copy',
      acknowledgedLeftovers: ['Quillon Vantress'],
    });

    expect(result).toEqual({ templateId: 'tpl-9' });
    expect(api.callsTo(`${BASE}/commit`)[0].body).toEqual({
      objectPath: OBJECT,
      fileName: 'precedent.docx',
      name: 'Precedent',
      edits,
      duplicateStrategy: 'copy',
      acknowledgedLeftovers: ['Quillon Vantress'],
    });
  });

  it('reports the 409 same-name refusal as a duplicate so the person can choose', async () => {
    api.postExact(`${BASE}/commit`, {
      status: 409,
      body: {
        error: 'A template with this name already exists.',
        code: 'TEMPLATE_DUPLICATE',
        details: { duplicate: { id: 'tpl-2', name: 'Precedent' } },
      },
    });

    await expect(
      wordTemplatesService.commit(FIRM, { objectPath: OBJECT, fileName: 'p.docx', name: 'Precedent', edits: [] }),
    ).resolves.toEqual({ duplicate: { id: 'tpl-2', name: 'Precedent' } });
  });

  it('turns the 409 client-text refusal into a ClientTextCheckError carrying its leftovers', async () => {
    api.postExact(`${BASE}/commit`, {
      status: 409,
      body: {
        error: 'Client details would stay in this template. Review them before saving.',
        code: 'TEMPLATE_CLIENT_TEXT',
        details: { leftovers: [leftover], clientTextRefused: true },
      },
    });

    const failure = await wordTemplatesService
      .commit(FIRM, { objectPath: OBJECT, fileName: 'p.docx', name: 'P', edits: [] })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ClientTextCheckError);
    expect((failure as ClientTextCheckError).leftovers).toEqual([leftover]);
    expect((failure as Error).message).toBe('Client details would stay in this template. Review them before saving.');
  });

  it('keeps a could-not-check refusal a ClientTextCheckError with no leftovers', async () => {
    api.postExact(`${BASE}/commit`, {
      status: 403,
      body: {
        error: "This template can't be checked for client details, because your role can't see all client and matter records. Ask an admin to save it.",
        code: 'TEMPLATE_CLIENT_TEXT_UNCHECKABLE',
        details: { clientTextRefused: true },
      },
    });

    const failure = await wordTemplatesService
      .commit(FIRM, { objectPath: OBJECT, fileName: 'p.docx', name: 'P', edits: [] })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ClientTextCheckError);
    expect((failure as ClientTextCheckError).leftovers).toBeNull();
  });

  it('leaves any other failure an ordinary ApiError', async () => {
    api.postExact(`${BASE}/commit`, { status: 500, body: { error: 'Storage upload failed.', code: 'INTERNAL' } });

    const failure = await wordTemplatesService
      .commit(FIRM, { objectPath: OBJECT, fileName: 'p.docx', name: 'P', edits: [] })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).not.toBeInstanceOf(ClientTextCheckError);
  });

  it("uploads a .docx without review for the editor and loads what it created", async () => {
    openUpload('source');
    api.postExact(`${BASE}/upload-docx`, { status: 201, body: { message: 'saved', templateId: 'tpl-1', template: { id: 'tpl-1' } } });
    api.getExact(`${BASE}/tpl-1`, { template: editorTemplate });

    const template = await wordTemplatesService.uploadDocxTemplate(
      FIRM,
      new File(['PK'], 'precedent.docx', { type: DOCX_TYPE }),
      'Precedent',
      { acknowledgedLeftovers: ['Quillon Vantress'] },
    );

    expect(api.callsTo(`${BASE}/upload-docx`)[0].body).toEqual({
      objectPath: OBJECT,
      fileName: 'precedent.docx',
      name: 'Precedent',
      acknowledgedLeftovers: ['Quillon Vantress'],
    });
    expect(template.id).toBe('tpl-1');
  });

  it('refuses an editor upload that still holds client text as a ClientTextCheckError', async () => {
    openUpload('source');
    api.postExact(`${BASE}/upload-docx`, {
      status: 409,
      body: {
        error: 'Client details would stay.',
        code: 'TEMPLATE_CLIENT_TEXT',
        details: { leftovers: [leftover], clientTextRefused: true },
      },
    });

    await expect(
      wordTemplatesService.uploadDocxTemplate(FIRM, new File(['PK'], 'p.docx', { type: DOCX_TYPE }), 'P'),
    ).rejects.toBeInstanceOf(ClientTextCheckError);
    expect(api.callsTo(`${BASE}/tpl-1`)).toHaveLength(0);
  });

  it('replaces the stored source of an existing Word template', async () => {
    openUpload('source');
    api.postExact(`${BASE}/tpl-1/replace-source`, { message: 'replaced', templateId: 'tpl-1', template: { id: 'tpl-1' } });
    api.getExact(`${BASE}/tpl-1`, { template: editorTemplate });

    await wordTemplatesService.replaceDocx(FIRM, 'tpl-1', new File(['PK'], 'v2.docx', { type: DOCX_TYPE }));

    expect(api.callsTo(`${BASE}/tpl-1/replace-source`)[0].body).toEqual({
      objectPath: OBJECT,
      fileName: 'v2.docx',
    });
  });
});

describe('filling', () => {
  it('fills a Word template and decodes the unfilled-field header', async () => {
    const header = encodeURIComponent(JSON.stringify(['client_name', 'Nombre del cliente']));
    api.postExact(`${BASE}/tpl-1/fill-docx`, {
      status: 200,
      text: 'PK-filled',
      headers: { 'Content-Type': DOCX_TYPE, 'X-Unfilled-Fields': header },
    });

    const filled = await wordTemplatesService.fillDocxTemplate(
      FIRM, 'tpl-1', { case_number: 'CR-1' }, { payments: [{ payment_amount: '$5' }] }, 'docx', 'Letter.docx',
    );

    expect(api.callsTo(`${BASE}/tpl-1/fill-docx`)[0].body).toEqual({
      values: { case_number: 'CR-1' },
      repeaterValues: { payments: [{ payment_amount: '$5' }] },
      fileName: 'Letter.docx',
      format: 'docx',
    });
    expect(filled.unfilledFields).toEqual(['client_name', 'Nombre del cliente']);
    expect(await readText(filled.blob)).toBe('PK-filled');
  });

  it('reads a missing unfilled-field header as nothing left blank', async () => {
    api.postExact(`${BASE}/tpl-1/fill-pdf`, { status: 200, text: '%PDF', headers: { 'Content-Type': 'application/pdf' } });

    const filled = await wordTemplatesService.fillPdfFormTemplate(FIRM, 'tpl-1', { client_name: 'A' });

    expect(api.callsTo(`${BASE}/tpl-1/fill-pdf`)[0].body).toEqual({ values: { client_name: 'A' } });
    expect(filled.unfilledFields).toEqual([]);
  });

  it('carries a fill refusal as the server worded it', async () => {
    api.postExact(`${BASE}/tpl-1/fill-docx`, {
      status: 400,
      body: { error: 'PDF export is not available (document converter is off).', code: 'VALIDATION_ERROR' },
    });

    await expect(
      wordTemplatesService.fillDocxTemplate(FIRM, 'tpl-1', {}, {}, 'pdf'),
    ).rejects.toThrow('PDF export is not available (document converter is off).');
  });

  it('reads the live field list of the stored file', async () => {
    api.getExact(`${BASE}/tpl-1/fields`, { fillFields: { fields: ['client_name', 'payments.payment_amount'], repeaters: [{ name: 'payments', fields: ['payment_amount'] }] } });

    await expect(wordTemplatesService.fetchFillFields(FIRM, 'tpl-1')).resolves.toEqual({
      fields: ['client_name', 'payments.payment_amount'],
      repeaters: [{ name: 'payments', fields: ['payment_amount'] }],
    });
  });

  it('asks for a matter and a client document context by query', async () => {
    const context = { values: { case_number: 'CR-1' }, repeaterValues: {}, billingIncomplete: false };
    api.getExact(`${BASE}/document-context?matterId=matter-1&clientId=client-2`, { context });

    await expect(
      wordTemplatesService.documentContext(FIRM, { matterId: 'matter-1', clientId: 'client-2' }),
    ).resolves.toEqual(context);
  });

  it('asks for a client-only context without a matter', async () => {
    api.getExact(`${BASE}/document-context?clientId=client-2`, { context: { values: {}, repeaterValues: {}, billingIncomplete: false } });

    await wordTemplatesService.documentContext(FIRM, { matterId: null, clientId: 'client-2' });

    expect(api.calls('GET')).toHaveLength(1);
  });

  it('does not ask for a context with neither a matter nor a client', async () => {
    await expect(
      wordTemplatesService.documentContext(FIRM, { matterId: null, clientId: null }),
    ).resolves.toBeNull();
    expect(api.calls()).toHaveLength(0);
  });

  it('exports filled html to a file', async () => {
    api.postExact(`${BASE}/export`, { status: 200, text: '%PDF-1.7', headers: { 'Content-Type': 'application/pdf' } });

    const blob = await wordTemplatesService.exportHtml(FIRM, '<p>Hi</p>', 'pdf');

    expect(api.callsTo(`${BASE}/export`)[0].body).toEqual({ html: '<p>Hi</p>', format: 'pdf' });
    expect(await readText(blob)).toBe('%PDF-1.7');
  });
});

describe('previews and conversion', () => {
  it('fetches the stored .docx and the converted preview with the person\'s credentials', async () => {
    api.getExact(`${BASE}/tpl-1/docx-source`, { status: 200, text: 'PK-source', headers: { 'Content-Type': DOCX_TYPE } });
    api.getExact(`${BASE}/tpl-1/preview-pdf`, { status: 200, text: '%PDF-preview', headers: { 'Content-Type': 'application/pdf' } });

    const source = await wordTemplatesService.docxSource(FIRM, 'tpl-1');
    const preview = await wordTemplatesService.previewPdf(FIRM, 'tpl-1');

    expect(new TextDecoder().decode(source)).toBe('PK-source');
    expect(await readText(preview)).toBe('%PDF-preview');
    expect(api.calls('GET').every((call) => /^Bearer /.test(call.headers.authorization ?? ''))).toBe(true);
  });

  it('converts a .docx to a PDF file through a convert upload', async () => {
    openUpload('convert');
    api.postExact(`${BASE}/convert-docx-to-pdf`, { status: 200, text: '%PDF-converted', headers: { 'Content-Type': 'application/pdf' } });

    const pdf = await wordTemplatesService.convertToPdf(FIRM, new File(['PK'], 'Engagement.docx', { type: DOCX_TYPE }));

    expect(api.callsTo(`${BASE}/convert-docx-to-pdf`)[0].body).toEqual({ objectPath: OBJECT, fileName: 'Engagement.docx' });
    expect(pdf.name).toBe('Engagement.pdf');
    expect(pdf.type).toBe('application/pdf');
  });
});
