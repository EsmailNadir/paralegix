/**
 * Exporting a filled HTML template to PDF goes through the API.
 *
 * The browser still builds the filled HTML, but the render moved off the
 * frontend's own `/api/export` route (Chromium in a Vercel function) to the
 * backend, which renders on the document worker and answers with a storage
 * link. The service turns that into the Blob the three callers need: download,
 * save to files, and conversion to another format.
 */
jest.unmock('@/services/templates.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { templatesService, skippedImagesNotice } from '@/services/templates.service';

const FIRM = 'firm-1';
const TEMPLATE = 'template-1';
const EXPORT = `/lawfirms/${FIRM}/templates/${TEMPLATE}/export-pdf`;
const RENDER_PATH = `/lawfirms/lawfirmids/${FIRM}/template-renders/${TEMPLATE}/user-1/export.pdf`;
const SIGNED = `https://storage.googleapis.com${RENDER_PATH}?X-Goog-Signature=abc`;
const HTML = '<div class="pdf-page"><p>Dear Jane Smith,</p></div>';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

it('asks the API to render the filled HTML, then reads the PDF from the link it answers with', async () => {
  api.postExact(`/api${EXPORT}`, { downloadUrl: SIGNED, fileName: 'Smith Letter.pdf' });
  api.get(RENDER_PATH, {
    status: 200, text: '%PDF-1.7 rendered', headers: { 'content-type': 'application/pdf' },
  });

  const { blob, skippedImages } = await templatesService.renderPdf(FIRM, TEMPLATE, HTML, { fileName: 'Smith Letter' });

  // jsdom's Blob has no text(); the length is the body the storage read answered with.
  expect(blob.size).toBe('%PDF-1.7 rendered'.length);
  expect(skippedImages).toBe(0);
  const [request] = api.callsTo(EXPORT);
  expect(request.body).toEqual({ html: HTML, fileName: 'Smith Letter', disposition: 'attachment' });
  expect(request.headers.authorization).toMatch(/^Bearer /);
  // The signed link is the authorization for the read. The user's API
  // credential has no business going to the storage host.
  const [read] = api.callsTo(RENDER_PATH);
  expect(read.url).toBe(SIGNED);
  expect(read.headers.authorization).toBeUndefined();
});

it('surfaces the API refusal, and never reads storage', async () => {
  api.postExact(`/api${EXPORT}`, {
    status: 413,
    body: {
      error: 'This document is too large to export. Try removing large images or splitting it into multiple templates.',
      code: 'TEMPLATE_EXPORT_TOO_LARGE',
    },
  });

  await expect(templatesService.renderPdf(FIRM, TEMPLATE, HTML)).rejects.toThrow(/too large to export/);
  expect(api.callsTo(RENDER_PATH)).toHaveLength(0);
});

it('exports again when the render queue was full, then reads the PDF', async () => {
  api.postExact(`/api${EXPORT}`, sequence(
    { status: 503, headers: { 'Retry-After': '0' }, body: { error: 'Too many documents are being prepared right now. Please try again in a moment.', code: 'TEMPLATE_FILL_BUSY' } },
    { downloadUrl: SIGNED },
  ));
  api.get(RENDER_PATH, { status: 200, text: '%PDF-1.7', headers: { 'content-type': 'application/pdf' } });

  const { blob } = await templatesService.renderPdf(FIRM, TEMPLATE, HTML);

  expect(api.callsTo(EXPORT)).toHaveLength(2);
  expect(blob.size).toBe('%PDF-1.7'.length);
});

it('does not export again when this person already has renders in flight', async () => {
  api.postExact(`/api${EXPORT}`, sequence(
    { status: 429, body: { error: 'You already have documents being prepared. Please wait for them to finish.', code: 'TEMPLATE_RENDER_IN_PROGRESS' } },
    { downloadUrl: SIGNED },
  ));

  await expect(templatesService.renderPdf(FIRM, TEMPLATE, HTML)).rejects.toThrow(/already have documents/);
  expect(api.callsTo(EXPORT)).toHaveLength(1);
});

it('fails when storage does not hand back the PDF', async () => {
  api.postExact(`/api${EXPORT}`, { downloadUrl: SIGNED });
  api.get(RENDER_PATH, { status: 403, text: 'expired', headers: { 'content-type': 'text/plain' } });

  await expect(templatesService.renderPdf(FIRM, TEMPLATE, HTML)).rejects.toThrow(/PDF/);
});

it('passes on how many template images the PDF had to go without', async () => {
  api.postExact(`/api${EXPORT}`, { downloadUrl: SIGNED, skippedImages: 2 });
  api.get(RENDER_PATH, { status: 200, text: '%PDF-1.7', headers: { 'content-type': 'application/pdf' } });

  const { skippedImages } = await templatesService.renderPdf(FIRM, TEMPLATE, HTML);

  expect(skippedImages).toBe(2);
});

it('words the missing-image notice for one image and for several', () => {
  expect(skippedImagesNotice(1)).toBe(
    "The PDF was created, but 1 image couldn't be included. It may be too large or no longer available.",
  );
  expect(skippedImagesNotice(3)).toBe(
    "The PDF was created, but 3 images couldn't be included. They may be too large or no longer available.",
  );
});

