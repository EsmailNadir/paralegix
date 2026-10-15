/** Overlay templates upload to storage before the API creates the template row. */
jest.unmock('@/services/templates.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { installXhrMock, type XhrMock } from '../../support/xhrMock';
import { templatesService } from '@/services/templates.service';
import { UploadCancelledError } from '@/lib/files/resumableUpload';

const FIRM = 'firm-1';
const SESSION = 'https://storage.googleapis.com/upload/template-overlay-1';
const OBJECT = 'template-uploads/firm-1/user-1/upload/source.pdf';

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

it('sends an overlay PDF directly to its resumable session before finalizing the template', async () => {
  api.post(`/lawfirms/${FIRM}/templates/upload-overlay-init`, { uploadUrl: SESSION, objectPath: OBJECT });
  xhr.onExact('PUT', SESSION, { status: 200 });
  api.post(`/lawfirms/${FIRM}/templates/upload-overlay-finalize`, {
    templateId: 'template-1', template: { id: 'template-1', type: 'overlay' },
  });

  const result = await templatesService.uploadOverlay(
    FIRM,
    new File(['%PDF-1.4'], 'court-form.pdf', { type: 'application/pdf' }),
    'Court Form',
    'folder-1',
  );

  expect(result.templateId).toBe('template-1');
  expect(api.callsTo(`/lawfirms/${FIRM}/templates/upload-overlay-init`)[0].body).toEqual({
    fileName: 'court-form.pdf', contentType: 'application/pdf', size: 8,
  });
  const put = xhr.calls('PUT')[0];
  expect(put.url).toBe(SESSION);
  expect(put.headers.authorization).toBeUndefined();
  expect(api.callsTo(`/lawfirms/${FIRM}/templates/upload-overlay-finalize`)[0].body).toEqual({
    objectPath: OBJECT,
    fileName: 'court-form.pdf',
    name: 'Court Form',
    folderId: 'folder-1',
  });
});

it('finalizes again when the converter was busy, without uploading the file a second time', async () => {
  // The server keeps the uploaded source when it refuses as busy, so only the
  // finalize call is repeated; the bytes already sit in storage.
  api.post(`/lawfirms/${FIRM}/templates/upload-overlay-init`, { uploadUrl: SESSION, objectPath: OBJECT });
  xhr.onExact('PUT', SESSION, { status: 200 });
  api.post(`/lawfirms/${FIRM}/templates/upload-overlay-finalize`, sequence(
    { status: 503, headers: { 'Retry-After': '0' }, body: { error: 'Too many documents are being prepared right now. Please try again in a moment.', code: 'CONVERSION_BUSY' } },
    { templateId: 'template-1', template: { id: 'template-1', type: 'overlay' } },
  ));

  const result = await templatesService.uploadOverlay(
    FIRM,
    new File(['PK'], 'engagement.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
  );

  expect(result.templateId).toBe('template-1');
  expect(api.callsTo(`/lawfirms/${FIRM}/templates/upload-overlay-finalize`)).toHaveLength(2);
  expect(api.callsTo(`/lawfirms/${FIRM}/templates/upload-overlay-init`)).toHaveLength(1);
  expect(xhr.calls('PUT')).toHaveLength(1);
});

it('aborts overlay upload when signal is cancelled', async () => {
  api.post(`/lawfirms/${FIRM}/templates/upload-overlay-init`, { uploadUrl: SESSION, objectPath: OBJECT });
  const controller = new AbortController();
  controller.abort();

  await expect(
    templatesService.uploadOverlay(
      FIRM,
      new File(['%PDF-1.4'], 'court-form.pdf', { type: 'application/pdf' }),
      'Court Form',
      'folder-1',
      { signal: controller.signal }
    )
  ).rejects.toThrow(UploadCancelledError);
});

it('reports progress when uploading an overlay document', async () => {
  api.post(`/lawfirms/${FIRM}/templates/upload-overlay-init`, { uploadUrl: SESSION, objectPath: OBJECT });
  xhr.onExact('PUT', SESSION, { status: 200 });
  api.post(`/lawfirms/${FIRM}/templates/upload-overlay-finalize`, {
    templateId: 'template-1', template: { id: 'template-1', type: 'overlay' },
  });

  const progressUpdates: number[] = [];
  await templatesService.uploadOverlay(
    FIRM,
    new File(['%PDF-1.4'], 'court-form.pdf', { type: 'application/pdf' }),
    'Court Form',
    'folder-1',
    {
      onProgress: (pct) => progressUpdates.push(pct),
    }
  );

  expect(progressUpdates).toContain(100);
});

it('sends a DOCX directly to storage before the API parses its placeholders', async () => {
  const session = 'https://storage.googleapis.com/upload/template-docx-1';
  const objectPath = 'template-docx-uploads/firm-1/user-1/upload/source.docx';
  api.post(`/lawfirms/${FIRM}/templates/upload-docx-init`, { uploadUrl: session, objectPath });
  xhr.onExact('PUT', session, { status: 200 });
  api.post(`/lawfirms/${FIRM}/templates/upload-docx-finalize`, {
    template: { id: 'template-docx-1', type: 'docx' },
  });

  await templatesService.uploadDocxTemplate(
    FIRM,
    new File(['docx'], 'retainer.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    'Retainer',
    { folderId: 'folder-1', html: '<p>Summary</p>' },
  );

  expect(xhr.calls('PUT')[0].url).toBe(session);
  expect(xhr.calls('PUT')[0].headers.authorization).toBeUndefined();
  expect(api.callsTo(`/lawfirms/${FIRM}/templates/upload-docx-finalize`)[0].body).toEqual({
    objectPath,
    fileName: 'retainer.docx',
    name: 'Retainer',
    folderId: 'folder-1',
    html: '<p>Summary</p>',
  });
});

it('reuploads a DOCX through storage before the API updates the template', async () => {
  const session = 'https://storage.googleapis.com/upload/template-docx-replacement';
  const objectPath = 'template-docx-uploads/firm-1/user-1/template-1/upload/source.docx';
  api.post(`/lawfirms/${FIRM}/templates/template-1/upload-docx-init`, { uploadUrl: session, objectPath });
  xhr.onExact('PUT', session, { status: 200 });
  api.post(`/lawfirms/${FIRM}/templates/template-1/upload-docx-finalize`, { template: { id: 'template-1', type: 'docx' } });

  await templatesService.reuploadDocxTemplate(
    FIRM,
    'template-1',
    new File(['docx'], 'revised.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    { name: 'Revised', html: '<p>Summary</p>' },
  );

  expect(xhr.calls('PUT')[0].url).toBe(session);
  expect(api.callsTo(`/lawfirms/${FIRM}/templates/template-1/upload-docx-finalize`)[0].body).toEqual({
    objectPath, fileName: 'revised.docx', name: 'Revised', html: '<p>Summary</p>',
  });
});

it('uploads a placement image directly to storage before attaching it', async () => {
  const session = 'https://storage.googleapis.com/upload/template-image';
  const objectPath = 'template-placement-uploads/firm-1/template-1/user-1/upload/source';
  api.post(`/lawfirms/${FIRM}/templates/template-1/placement-images-init`, { uploadUrl: session, objectPath });
  xhr.onExact('PUT', session, { status: 200 });
  api.post(`/lawfirms/${FIRM}/templates/template-1/placement-images-finalize`, {
    imageObjectPath: 'templates/firm-1/templates/template-1/placement-images/image.png', imageMimeType: 'image/png', imagePreviewUrl: null,
  });

  await templatesService.uploadPlacementImage(
    FIRM,
    'template-1',
    new File(['png'], 'seal.png', { type: 'image/png' }),
  );

  expect(xhr.calls('PUT')[0].url).toBe(session);
  expect(api.callsTo(`/lawfirms/${FIRM}/templates/template-1/placement-images-finalize`)[0].body).toEqual({ objectPath, fileName: 'seal.png' });
});

// A DOCX import creates a template row at finalize, so a cancelled import (the
// editor closed mid-upload) must stop the transfer and never reach finalize.
// Goes red if `uploadDocxTemplate` ignores its signal: the PUT then completes
// and finalize files a template nobody asked for.
it('stops a cancelled DOCX upload before finalize creates the template', async () => {
  const session = 'https://storage.googleapis.com/upload/template-docx-cancel';
  const objectPath = 'template-docx-uploads/firm-1/user-1/upload/cancel.docx';
  const controller = new AbortController();
  api.post(`/lawfirms/${FIRM}/templates/upload-docx-init`, { uploadUrl: session, objectPath });
  xhr.onExact('PUT', session, () => {
    controller.abort();
    return { status: 200 };
  });
  api.post(`/lawfirms/${FIRM}/templates/upload-docx-finalize`, { template: { id: 'orphan', type: 'docx' } });

  await expect(
    templatesService.uploadDocxTemplate(
      FIRM,
      new File(['docx'], 'retainer.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      'Retainer',
      { signal: controller.signal },
    ),
  ).rejects.toBeInstanceOf(UploadCancelledError);

  expect(xhr.calls('PUT')).toHaveLength(1);
  expect(api.callsTo(`/lawfirms/${FIRM}/templates/upload-docx-finalize`)).toHaveLength(0);
});

// Cancelled while the session was still being opened: nothing is sent at all.
it('sends no bytes for a DOCX upload cancelled while its session opens', async () => {
  const controller = new AbortController();
  api.post(`/lawfirms/${FIRM}/templates/upload-docx-init`, {
    delayMs: 50, body: { uploadUrl: 'https://storage.googleapis.com/upload/never', objectPath: 'p' },
  });

  const pending = templatesService.uploadDocxTemplate(
    FIRM,
    new File(['docx'], 'retainer.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    'Retainer',
    { signal: controller.signal },
  );
  controller.abort();

  await expect(pending).rejects.toBeInstanceOf(UploadCancelledError);
  expect(xhr.calls('PUT')).toHaveLength(0);
  expect(api.callsTo(`/lawfirms/${FIRM}/templates/upload-docx-finalize`)).toHaveLength(0);
});
