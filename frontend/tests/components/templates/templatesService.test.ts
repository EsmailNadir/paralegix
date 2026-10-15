/**
 * The templates service, tested OFFLINE against a fake transport.
 *
 * Three neighbours already own the document-heavy paths: `templateExportPdf`
 * (HTML to PDF through the worker), `templateOverlayDirectUpload` (the
 * storage-first DOCX, overlay and placement-image uploads) and
 * `templateRenderLinks` (preview and fill links as the UI consumes them). This
 * file takes the CRUD and folder surface, placements, the link envelopes'
 * failure branches, and format conversion.
 *
 * Every route is `/lawfirms/{id}/templates/...`, so each case matches the
 * COMPLETE pathname with `getExact`/`putExact`: a request that lands on another
 * firm, or on another template, matches nothing and the transport throws.
 *
 * `signatures.service` is stubbed here because `convertToFormat` delegates the
 * conversion to it; what this file pins is the File that comes back: its name,
 * extension and MIME type.
 */
jest.unmock('@/services/templates.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/services/signatures.service', () => ({
  __esModule: true,
  default: { convertDocument: jest.fn() },
}));

import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { templatesService } from '@/services/templates.service';
import signaturesService from '@/services/signatures.service';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const TEMPLATE_ID = 'template-1';
const TEMPLATES = `/api/lawfirms/${LAW_FIRM_ID}/templates`;
const TEMPLATE = `${TEMPLATES}/${TEMPLATE_ID}`;

const convertDocument = signaturesService.convertDocument as unknown as jest.Mock;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  // Several cases read the same endpoint in consecutive tests, which trips the
  // dev-only duplicate-GET warning and buries the real output.
  __resetDuplicateRequestGuard();
  convertDocument.mockReset();
});

afterEach(() => {
  api.restore();
});

function onlyCall(method: string) {
  const calls = api.calls(method);
  expect(calls).toHaveLength(1);
  return calls[0];
}

async function rejectionOf(promise: Promise<unknown>): Promise<ApiError> {
  return promise.then(
    () => { throw new Error('expected the call to reject'); },
    (error: unknown) => error as ApiError,
  );
}

describe('templates', () => {
  const TEMPLATE_BODY = { id: TEMPLATE_ID, name: 'Engagement letter', html: '<p>{{clientName}}</p>', fields: ['clientName'] };

  it('lists the firm templates from the envelope', async () => {
    api.getExact(TEMPLATES, { templates: [{ id: TEMPLATE_ID }] });

    await expect(templatesService.list(LAW_FIRM_ID)).resolves.toEqual([{ id: TEMPLATE_ID }]);
    expect(onlyCall('GET').headers.authorization).toMatch(/^Bearer /);
  });

  it('POSTs a new template with exactly the payload and unwraps it', async () => {
    api.postExact(TEMPLATES, { status: 201, body: { template: TEMPLATE_BODY } });

    const payload = { name: 'Engagement letter', html: '<p>{{clientName}}</p>', fields: ['clientName'], folderId: null };
    const created = await templatesService.create(LAW_FIRM_ID, payload);

    expect(onlyCall('POST').body).toEqual(payload);
    expect(created).toEqual(TEMPLATE_BODY);
  });

  it('reads one template by id and unwraps it', async () => {
    api.getExact(TEMPLATE, { template: TEMPLATE_BODY });

    await expect(templatesService.getById(LAW_FIRM_ID, TEMPLATE_ID)).resolves.toEqual(TEMPLATE_BODY);
  });

  it('PUTs a full edit and unwraps the saved template', async () => {
    api.putExact(TEMPLATE, { template: { ...TEMPLATE_BODY, name: 'Engagement letter v2' } });

    const payload = { name: 'Engagement letter v2', html: '<p>{{clientName}}</p>', fields: ['clientName'] };
    const saved = await templatesService.update(LAW_FIRM_ID, TEMPLATE_ID, payload);

    expect(onlyCall('PUT').body).toEqual(payload);
    expect(saved.name).toBe('Engagement letter v2');
  });

  it('renames with ONLY the name, so the content is not overwritten', async () => {
    api.putExact(TEMPLATE, { message: 'ok' });

    await expect(templatesService.renameTemplate(LAW_FIRM_ID, TEMPLATE_ID, 'Retainer')).resolves.toBeUndefined();

    expect(onlyCall('PUT').body).toEqual({ name: 'Retainer' });
  });

  it('moves to the root folder with an explicit null', async () => {
    api.putExact(TEMPLATE, { message: 'ok' });

    await templatesService.moveTemplateToFolder(LAW_FIRM_ID, TEMPLATE_ID, null);

    // Omitting the key would leave the template where it was.
    expect(onlyCall('PUT').body).toEqual({ folderId: null });
  });

  it('DELETEs a template by id', async () => {
    api.deleteExact(TEMPLATE, { status: 204 });

    await expect(templatesService.delete(LAW_FIRM_ID, TEMPLATE_ID)).resolves.toBeUndefined();
    expect(onlyCall('DELETE').pathname).toBe(TEMPLATE);
  });
});

describe('template folders', () => {
  const FOLDERS = `${TEMPLATES}/folders`;

  it('lists folders from the envelope', async () => {
    api.getExact(FOLDERS, { folders: [{ id: 'f-1', name: 'Family' }] });

    await expect(templatesService.listFolders(LAW_FIRM_ID)).resolves.toEqual([{ id: 'f-1', name: 'Family' }]);
  });

  it('creates a nested folder with exactly the payload', async () => {
    api.postExact(FOLDERS, { folder: { id: 'f-2' } });

    const folder = await templatesService.createFolder(LAW_FIRM_ID, { name: 'Divorce', color: null, parentFolderId: 'f-1' });

    expect(onlyCall('POST').body).toEqual({ name: 'Divorce', color: null, parentFolderId: 'f-1' });
    expect(folder).toEqual({ id: 'f-2' });
  });

  it('PUTs a folder edit by id', async () => {
    api.putExact(`${FOLDERS}/f-2`, { folder: { id: 'f-2', color: '#ff0000' } });

    const folder = await templatesService.updateFolder(LAW_FIRM_ID, 'f-2', { color: '#ff0000' });

    expect(onlyCall('PUT').body).toEqual({ color: '#ff0000' });
    expect(folder).toEqual({ id: 'f-2', color: '#ff0000' });
  });

  it('DELETEs a folder by id', async () => {
    api.deleteExact(`${FOLDERS}/f-2`, { status: 204 });

    await expect(templatesService.deleteFolder(LAW_FIRM_ID, 'f-2')).resolves.toBeUndefined();
  });
});

describe('overlay placements', () => {
  it('lists the placements of one template', async () => {
    api.getExact(`${TEMPLATE}/placements`, { placements: [{ id: 'pl-1', fieldName: 'clientName' }] });

    await expect(templatesService.listPlacements(LAW_FIRM_ID, TEMPLATE_ID)).resolves.toEqual([{ id: 'pl-1', fieldName: 'clientName' }]);
  });

  it('PUTs placements and repeaters together and returns only the three result keys', async () => {
    api.putExact(`${TEMPLATE}/placements`, {
      placements: [{ id: 'pl-1' }], repeaters: [], fields: ['clientName'], message: 'Saved',
    });

    const payload = { placements: [{ fieldName: 'clientName', page: 1, x: 10, y: 20 }], repeaters: [] } as never;
    const result = await templatesService.savePlacements(LAW_FIRM_ID, TEMPLATE_ID, payload);

    expect(onlyCall('PUT').body).toEqual({ placements: [{ fieldName: 'clientName', page: 1, x: 10, y: 20 }], repeaters: [] });
    expect(result).toEqual({ placements: [{ id: 'pl-1' }], repeaters: [], fields: ['clientName'] });
  });
});

describe('render links refuse a body with no link', () => {
  it('returns the preview link renamed to url, with the rest of the metadata', async () => {
    api.getExact(`${TEMPLATE}/preview`, { previewUrl: 'https://storage.test/p.pdf', fileName: 'p.pdf', sizeBytes: 1024 });

    await expect(templatesService.previewPdf(LAW_FIRM_ID, TEMPLATE_ID))
      .resolves.toEqual({ url: 'https://storage.test/p.pdf', fileName: 'p.pdf', sizeBytes: 1024 });
  });

  it('throws when a preview answers 200 with no previewUrl', async () => {
    api.getExact(`${TEMPLATE}/preview`, { fileName: 'p.pdf' });

    await expect(templatesService.previewPdf(LAW_FIRM_ID, TEMPLATE_ID)).rejects.toThrow('The server did not return a preview link.');
  });

  it('asks for the preview again when the converter was busy, and returns the link', async () => {
    // A DOCX preview is converted on the way out; a full converter refuses
    // before starting anything, so the same request can simply be sent again.
    api.getExact(`${TEMPLATE}/preview`, sequence(
      { status: 503, headers: { 'Retry-After': '0' }, body: { error: 'Too many documents are being prepared right now. Please try again in a moment.', code: 'CONVERSION_BUSY' } },
      { previewUrl: 'https://storage.test/p.pdf', fileName: 'p.pdf' },
    ));

    const link = await templatesService.previewPdf(LAW_FIRM_ID, TEMPLATE_ID);

    expect(api.calls('GET')).toHaveLength(2);
    expect(link.url).toBe('https://storage.test/p.pdf');
  });

  it('fills with the default pdf format and attachment disposition', async () => {
    api.postExact(`${TEMPLATE}/fill`, { downloadUrl: 'https://storage.test/f.pdf', contentType: 'application/pdf' });

    const link = await templatesService.fillDocxTemplate(LAW_FIRM_ID, TEMPLATE_ID, { clientName: 'Jane Roe' }, { parties: [{ name: 'A' }] });

    expect(onlyCall('POST').body).toEqual({
      values: { clientName: 'Jane Roe' },
      repeaterValues: { parties: [{ name: 'A' }] },
      format: 'pdf',
      disposition: 'attachment',
    });
    expect(link).toEqual({ url: 'https://storage.test/f.pdf', contentType: 'application/pdf' });
  });

  it('fills again when the render queue was full, and returns the link', async () => {
    // Retry-After 0 keeps the case off the clock; the helper's own spec owns timing.
    api.postExact(`${TEMPLATE}/fill`, sequence(
      { status: 503, headers: { 'Retry-After': '0' }, body: { error: 'Too many documents are being prepared right now. Please try again in a moment.', code: 'TEMPLATE_FILL_BUSY' } },
      { downloadUrl: 'https://storage.test/f.pdf', contentType: 'application/pdf' },
    ));

    const link = await templatesService.fillDocxTemplate(LAW_FIRM_ID, TEMPLATE_ID, {}, {});

    expect(api.calls('POST')).toHaveLength(2);
    expect(link.url).toBe('https://storage.test/f.pdf');
  });

  it('does not fill again when this person already has renders in flight', async () => {
    api.postExact(`${TEMPLATE}/fill`, sequence(
      { status: 429, body: { error: 'You already have documents being prepared. Please wait for them to finish.', code: 'TEMPLATE_RENDER_IN_PROGRESS' } },
      { downloadUrl: 'https://storage.test/f.pdf' },
    ));

    const error = await rejectionOf(templatesService.fillDocxTemplate(LAW_FIRM_ID, TEMPLATE_ID, {}, {}));

    expect(error.code).toBe('TEMPLATE_RENDER_IN_PROGRESS');
    expect(api.calls('POST')).toHaveLength(1);
  });

  it('throws when a fill answers 200 with no downloadUrl', async () => {
    api.postExact(`${TEMPLATE}/fill`, { contentType: 'application/pdf' });

    await expect(templatesService.fillDocxTemplate(LAW_FIRM_ID, TEMPLATE_ID, {}, {}))
      .rejects.toThrow('The server did not return a link to the filled template.');
  });
});

describe('format conversion keeps the name and sets the type', () => {
  const docx = () => new File(['x'], 'Engagement Letter.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  it('converts to PDF, swapping the extension', async () => {
    convertDocument.mockResolvedValue(new Blob(['%PDF']));

    const pdf = await templatesService.convertToPdf(docx());

    expect(convertDocument).toHaveBeenCalledWith(expect.any(File), 'pdf', 'Engagement Letter.docx');
    expect(pdf.name).toBe('Engagement Letter.pdf');
    expect(pdf.type).toBe('application/pdf');
  });

  it('appends the extension to a name that has none', async () => {
    convertDocument.mockResolvedValue(new Blob(['%PDF']));

    const pdf = await templatesService.convertToPdf(new File(['x'], 'README', { type: 'text/plain' }));

    expect(pdf.name).toBe('README.pdf');
  });

  it('derives the MIME type from the format when none is given', async () => {
    convertDocument.mockResolvedValue(new Blob(['{\\rtf1}']));

    const rtf = await templatesService.convertToFormat(docx(), 'rtf');

    expect(rtf.name).toBe('Engagement Letter.rtf');
    expect(rtf.type).toBe('application/rtf');
  });

  it('honours an explicit MIME type over the derived one', async () => {
    convertDocument.mockResolvedValue(new Blob(['text']));

    const txt = await templatesService.convertToFormat(docx(), 'txt', 'text/plain;charset=utf-8');

    expect(txt.name).toBe('Engagement Letter.txt');
    expect(txt.type).toBe('text/plain;charset=utf-8');
  });
});

/**
 * Each method checks `response.ok` itself. When the server sends no reason,
 * the message the user reads is the method's own fallback, so each row pins
 * that its OWN guard ran rather than an error body being unwrapped as data.
 */
describe('a refusal with no server reason throws the method\'s own message', () => {
  const rows: Array<[string, 'get' | 'post' | 'put' | 'delete', string, () => Promise<unknown>, string]> = [
    ['create', 'post', TEMPLATES, () => templatesService.create(LAW_FIRM_ID, { name: 'n', html: '', fields: [] }), 'Failed to save template.'],
    ['getById', 'get', TEMPLATE, () => templatesService.getById(LAW_FIRM_ID, TEMPLATE_ID), 'Failed to load template.'],
    ['update', 'put', TEMPLATE, () => templatesService.update(LAW_FIRM_ID, TEMPLATE_ID, { name: 'n', html: '', fields: [] }), 'Failed to update template.'],
    ['previewPdf', 'get', `${TEMPLATE}/preview`, () => templatesService.previewPdf(LAW_FIRM_ID, TEMPLATE_ID), 'Failed to open template preview.'],
    ['delete', 'delete', TEMPLATE, () => templatesService.delete(LAW_FIRM_ID, TEMPLATE_ID), 'Failed to delete template.'],
    ['createFolder', 'post', `${TEMPLATES}/folders`, () => templatesService.createFolder(LAW_FIRM_ID, { name: 'n' }), 'Failed to create folder.'],
    ['updateFolder', 'put', `${TEMPLATES}/folders/f-1`, () => templatesService.updateFolder(LAW_FIRM_ID, 'f-1', {}), 'Failed to update folder.'],
    ['deleteFolder', 'delete', `${TEMPLATES}/folders/f-1`, () => templatesService.deleteFolder(LAW_FIRM_ID, 'f-1'), 'Failed to delete folder.'],
    ['renameTemplate', 'put', TEMPLATE, () => templatesService.renameTemplate(LAW_FIRM_ID, TEMPLATE_ID, 'n'), 'Failed to rename template.'],
    ['moveTemplateToFolder', 'put', TEMPLATE, () => templatesService.moveTemplateToFolder(LAW_FIRM_ID, TEMPLATE_ID, 'f-1'), 'Failed to move template.'],
    ['savePlacements', 'put', `${TEMPLATE}/placements`, () => templatesService.savePlacements(LAW_FIRM_ID, TEMPLATE_ID, { placements: [], repeaters: [] }), 'Failed to save field placements.'],
    ['fillDocxTemplate', 'post', `${TEMPLATE}/fill`, () => templatesService.fillDocxTemplate(LAW_FIRM_ID, TEMPLATE_ID, {}, {}), 'Failed to fill template.'],
  ];

  it.each(rows)('%s', async (_name, method, path, run, message) => {
    ({ get: api.getExact, post: api.postExact, put: api.putExact, delete: api.deleteExact })[method](path, { status: 422, body: {} });

    const error = await rejectionOf(run());

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(message);
    expect(error.status).toBe(422);
  });

  it('surfaces a refused list read as an ApiError', async () => {
    api.getExact(TEMPLATES, { status: 403, body: { error: 'Forbidden' } });

    const error = await rejectionOf(templatesService.list(LAW_FIRM_ID));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
  });
});
