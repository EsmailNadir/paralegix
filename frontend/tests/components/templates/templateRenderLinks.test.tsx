/**
 * A rendered template travels as a LINK, not as a response body.
 *
 * The three routes that produce a document (preview, fill, and the fill behind
 * Download) used to answer with the bytes. Every render therefore existed
 * twice on the API instance, once as the buffer the transform produced and
 * once as the body being written out, and a third time in the tab as a Blob.
 * These specs pin the transport itself: what the service returns, what the
 * request asks for, and what the browser is handed.
 *
 * They fail on the old implementation. `previewPdf` and `fillDocxTemplate`
 * returned `res.blob()`, so there was no `url` to read, no `disposition` in
 * the request, and Download built an object URL from bytes it held.
 */
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

jest.unmock('@/services/templates.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/components/templatesComp/SaveToFilesModal', () => ({
  __esModule: true,
  default: () => null,
}));

// isomorphic-dompurify's transitive ESM deps do not transform under Jest, and
// the sanitizer's output is not what these specs are about.
jest.mock('@/lib/utils/sanitizeHtml', () => ({
  __esModule: true,
  sanitizeRichHtml: (html?: string | null) => html ?? '',
}));

import { templatesService } from '@/services/templates.service';
import FillTemplateModal from '@/components/templatesComp/FillTemplateModal';

const FIRM = 'firm-1';
const TEMPLATE_ID = 'template-1';
const SIGNED = 'https://storage.example.com/renders/filled.pdf?X-Goog-Signature=abc';

/** An overlay template: no HTML of its own, so it always fills server-side. */
const overlayTemplate = {
  id: TEMPLATE_ID,
  name: 'Retainer',
  type: 'overlay' as const,
  fields: [],
  repeaters: [],
  folderId: null,
  createdAt: '2026-09-01T00:00:00.000Z',
};

/**
 * The Download button, addressed by its own text.
 *
 * Its tooltip puts "Download as PDF" on the element, and the neighbouring
 * chevron is named "More download formats", so a name match on /download/
 * finds three buttons and the wrong one.
 */
async function downloadButton(): Promise<HTMLElement> {
  const buttons = await screen.findAllByRole('button');
  const found = buttons.find((button) => button.textContent === 'Download');
  if (!found) throw new Error('The Download button is not on screen.');
  return found;
}

describe('a rendered template travels as a link', () => {
  let api: ApiMock;

  beforeEach(() => {
    api = installApiMock();
  });

  afterEach(() => {
    api.restore();
    jest.restoreAllMocks();
  });

  it('returns the preview link instead of the document', async () => {
    api.get(`/templates/${TEMPLATE_ID}/preview`, {
      previewUrl: SIGNED,
      fileName: 'Retainer.pdf',
      contentType: 'application/pdf',
      sizeBytes: 91_234,
      generation: '17590000000001',
      urlExpiresAt: '2026-09-09T12:15:00.000Z',
    });

    const link = await templatesService.previewPdf(FIRM, TEMPLATE_ID);

    expect(link.url).toBe(SIGNED);
    expect(link.sizeBytes).toBe(91_234);
    // The generation is what makes the link name one version of the object.
    expect(link.generation).toBe('17590000000001');
  });

  it('refuses a preview response that carries no link', async () => {
    api.get(`/templates/${TEMPLATE_ID}/preview`, { fileName: 'Retainer.pdf' });

    // Silently returning an empty link would put a preview dialog in front of
    // the user with nothing in it and no error to explain why.
    await expect(templatesService.previewPdf(FIRM, TEMPLATE_ID)).rejects.toThrow(
      /did not return a preview link/i,
    );
  });

  it('asks for the disposition the caller needs and returns the link', async () => {
    api.post(`/templates/${TEMPLATE_ID}/fill`, {
      downloadUrl: SIGNED,
      fileName: 'Retainer.pdf',
      contentType: 'application/pdf',
      disposition: 'inline',
    });

    const link = await templatesService.fillDocxTemplate(
      FIRM, TEMPLATE_ID, { name: 'Jane' }, {}, 'pdf', undefined, 'inline',
    );

    expect(link.url).toBe(SIGNED);
    const [call] = api.callsTo(`/templates/${TEMPLATE_ID}/fill`);
    expect(call.body).toMatchObject({
      format: 'pdf',
      disposition: 'inline',
      values: { name: 'Jane' },
    });
  });

  it('defaults a fill to a download, because that is what most callers want', async () => {
    api.post(`/templates/${TEMPLATE_ID}/fill`, { downloadUrl: SIGNED });

    await templatesService.fillDocxTemplate(FIRM, TEMPLATE_ID, {}, {}, 'docx');

    const [call] = api.callsTo(`/templates/${TEMPLATE_ID}/fill`);
    expect((call.body as any).disposition).toBe('attachment');
  });

  it('refuses a fill response that carries no link', async () => {
    api.post(`/templates/${TEMPLATE_ID}/fill`, { fileName: 'Retainer.pdf' });

    await expect(
      templatesService.fillDocxTemplate(FIRM, TEMPLATE_ID, {}, {}, 'pdf'),
    ).rejects.toThrow(/did not return a link/i);
  });

  it('hands Download the storage link and builds no object URL', async () => {
    api.get(`/templates/${TEMPLATE_ID}`, {
      template: { ...overlayTemplate, html: null },
    });
    api.post(`/templates/${TEMPLATE_ID}/fill`, { downloadUrl: SIGNED });

    // What the browser is actually given. An object URL here would mean the
    // whole document came through this tab to save a file storage can serve.
    const hrefs: string[] = [];
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(this.href);
    });
    const createObjectURL = jest.fn(() => 'blob:never');
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });

    renderWithProviders(
      <FillTemplateModal template={overlayTemplate} lawFirmId={FIRM} onClose={() => {}} />,
    );

    await userEvent.click(await downloadButton());

    await waitFor(() => expect(hrefs).toEqual([SIGNED]));
    expect(createObjectURL).not.toHaveBeenCalled();

    const [call] = api.callsTo(`/templates/${TEMPLATE_ID}/fill`);
    expect((call.body as any).disposition).toBe('attachment');
  });

  it('points the preview tab at an inline link', async () => {
    api.get(`/templates/${TEMPLATE_ID}`, {
      template: { ...overlayTemplate, html: null },
    });
    api.post(`/templates/${TEMPLATE_ID}/fill`, { downloadUrl: SIGNED });

    // jsdom's window.open answers null, which the component reads as a blocked
    // pop-up, so the spec has to supply the window it would have received.
    const opened = {
      document: { write: jest.fn(), close: jest.fn() },
      location: { href: '' },
      close: jest.fn(),
    };
    jest.spyOn(window, 'open').mockReturnValue(opened as unknown as Window);

    renderWithProviders(
      <FillTemplateModal template={overlayTemplate} lawFirmId={FIRM} onClose={() => {}} />,
    );

    await userEvent.click(await screen.findByRole('button', { name: /preview filled document/i }));

    await waitFor(() => expect(opened.location.href).toBe(SIGNED));
    // An `attachment` link would download the file instead of showing it, and
    // the tab opened for it would sit empty.
    const [call] = api.callsTo(`/templates/${TEMPLATE_ID}/fill`);
    expect((call.body as any).disposition).toBe('inline');
  });
});
