/**
 * How the preview overlay decides to load a document.
 *
 * `PdfPreview` is stubbed by the harness (react-pdf does not run under jsdom),
 * so the stub here records the props it was handed. The overlay's decision is
 * the subject: a PDF of any size arrives as a URL for pdf.js to read in page
 * ranges, and a large text file is refused with a download hint. Every wrong
 * answer looks fine on a 40 KB sample and crashes the tab on a 3 GB one.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import DocumentPreviewOverlay, {
  TEXT_PREVIEW_BYTES_LIMIT,
} from '@/components/filesComp/DocumentPreviewOverlay';
const pdfPreviewProps: Array<Record<string, unknown>> = [];

jest.mock('@/components/filesComp/PdfPreview', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    pdfPreviewProps.push(props);
    return <div data-testid="pdf-preview" />;
  },
}));

const URL_ = 'https://storage.googleapis.com/signed/document.pdf';

let fetchSpy: jest.SpyInstance;

/** A response whose headers a HEAD probe can read a size out of. */
function respond(headers: Record<string, string> = {}) {
  return {
    ok: true,
    headers: new Headers(headers),
    arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
    text: async () => 'hello',
    blob: async () => new Blob(['fake-bytes']),
  } as unknown as Response;
}

beforeEach(() => {
  pdfPreviewProps.length = 0;
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(respond());
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function open(props: Partial<React.ComponentProps<typeof DocumentPreviewOverlay>>) {
  return render(
    <DocumentPreviewOverlay
      open
      onClose={() => {}}
      name="document"
      contentType="application/pdf"
      fileUrl={URL_}
      {...props}
    />,
  );
}

it('never fetches a small PDF whole either', async () => {
  open({ sizeBytes: 40 * 1024 });

  await waitFor(() => expect(pdfPreviewProps.length).toBeGreaterThan(0));
  // A small PDF read whole is still a second copy of the document in the tab
  // beside pdf.js's own, and the ranged reader works at every size.
  expect(fetchSpy).not.toHaveBeenCalled();
  const last = pdfPreviewProps[pdfPreviewProps.length - 1];
  expect(last.url).toBe(URL_);
  expect(last.bytes).toBeUndefined();
});

it('hands a large PDF to pdf.js by URL and never fetches it whole', async () => {
  open({ sizeBytes: 50 * 1024 * 1024 + 1 });

  await waitFor(() => expect(pdfPreviewProps.length).toBeGreaterThan(0));
  // One whole-file fetch here is the tab crash. pdf.js reads page ranges
  // through its own requests, which the stub does not make.
  expect(fetchSpy).not.toHaveBeenCalled();
  const last = pdfPreviewProps[pdfPreviewProps.length - 1];
  expect(last.url).toBe(URL_);
  expect(last.bytes).toBeUndefined();
});

it('does not probe the size with a HEAD when the caller has none', async () => {
  // The public share preview has no size to give. With one path for every
  // size, the size decides nothing, so there is nothing to ask the host for.
  open({});

  await waitFor(() => expect(pdfPreviewProps.length).toBeGreaterThan(0));
  expect(fetchSpy).not.toHaveBeenCalled();
  const last = pdfPreviewProps[pdfPreviewProps.length - 1];
  expect(last.url).toBe(URL_);
  expect(last.bytes).toBeUndefined();
});

it('refuses a large text file with a download hint instead of reading it', async () => {
  open({ contentType: 'text/plain', sizeBytes: TEXT_PREVIEW_BYTES_LIMIT + 1, onDownload: () => {} });

  await waitFor(() => expect(screen.getByText(/too large to preview/i)).toBeInTheDocument());
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('reads a small text file', async () => {
  open({ contentType: 'text/plain', sizeBytes: 5 });

  await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument());
});

jest.mock('heic2any', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(async () => new Blob(['fake-jpeg'], { type: 'image/jpeg' })),
}));

// Provide object URL stubs for jsdom if needed
if (!global.URL.createObjectURL) {
  global.URL.createObjectURL = jest.fn(() => 'blob:mock-image-url');
}
if (!global.URL.revokeObjectURL) {
  global.URL.revokeObjectURL = jest.fn();
}

it('automatically converts an HEIC photo for preview in non-Safari browsers', async () => {
  open({ contentType: 'image/heic', name: 'IMG_0412.HEIC', onDownload: () => {} });

  await waitFor(() => {
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toMatch(/^blob:/);
  });
  expect(screen.queryByText('Preview Not Available')).toBeNull();
  expect(screen.queryByText('HEIC Image')).toBeNull();
});

it('still previews a JPEG in an <img> directly', () => {
  open({ contentType: 'image/jpeg', name: 'photo.jpg' });
  const img = document.querySelector('img');
  expect(img).not.toBeNull();
  expect(img?.getAttribute('src')).toBe(URL_);
});

it('shows centered Preview Not Available with download button for unsupported formats', () => {
  open({ contentType: 'application/zip', name: 'archive.zip', onDownload: () => {} });
  expect(screen.getByText('Preview Not Available')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /download/i })).toHaveLength(2);
  expect(document.querySelector('img')).toBeNull();
});

it('scales image dimensions when zoom controls are used', () => {
  open({ contentType: 'image/jpeg', name: 'photo.jpg' });
  const img = document.querySelector('img') as HTMLImageElement;
  expect(img).not.toBeNull();

  // Simulate image load with natural dimensions
  Object.defineProperty(img, 'naturalWidth', { value: 800 });
  Object.defineProperty(img, 'naturalHeight', { value: 600 });
  fireEvent.load(img);

  const initialWidth = parseInt(img.style.width, 10);
  expect(initialWidth).toBeGreaterThan(0);

  // Click zoom in button
  const zoomInBtn = screen.getByRole('button', { name: /zoom in/i });
  fireEvent.click(zoomInBtn);

  const zoomedWidth = parseInt(img.style.width, 10);
  expect(zoomedWidth).toBeGreaterThan(initialWidth);
  expect(zoomedWidth).toBe(Math.round(initialWidth * 1.25));

  // Reset zoom
  const resetBtn = screen.getByRole('button', { name: /reset zoom/i });
  fireEvent.click(resetBtn);
  expect(parseInt(img.style.width, 10)).toBe(initialWidth);
});

it('embeds viewer iframe without top zoom controls for docx files', () => {
  open({
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    name: 'contract.docx',
  });
  expect(screen.queryByRole('button', { name: /zoom in/i })).toBeNull();
  const iframe = document.querySelector('iframe');
  expect(iframe).not.toBeNull();
  expect(iframe?.src).toContain('docs.google.com/gview');
});

it('embeds viewer iframe without top zoom controls for non-docx office docs', () => {
  open({
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    name: 'slides.pptx',
  });
  expect(screen.queryByRole('button', { name: /zoom in/i })).toBeNull();
  const iframe = document.querySelector('iframe');
  expect(iframe).not.toBeNull();
});

// "opendocument" contains "doc", so a substring match sent OpenDocument
// graphics to Google's viewer, which answered with the raw file and the browser
// downloaded it under the name "gview".
it('does not send an OpenDocument graphics file to the Google viewer', () => {
  open({
    contentType: 'application/vnd.oasis.opendocument.graphics',
    name: 'diagram.odg',
    onDownload: () => {},
  });
  expect(document.querySelector('iframe')).toBeNull();
  expect(screen.getByText('Preview Not Available')).toBeInTheDocument();
});

it('does not send a file whose type merely contains "doc" to the Google viewer', () => {
  open({ contentType: 'application/x-docbook+zip', name: 'manual.bin', onDownload: () => {} });
  expect(document.querySelector('iframe')).toBeNull();
});

it('still sends an OpenDocument text file to the Google viewer', () => {
  open({ contentType: 'application/vnd.oasis.opendocument.text', name: 'letter.odt' });
  expect(document.querySelector('iframe')?.src).toContain('docs.google.com/gview');
});

it('recognises an Office document by extension when the type is generic', () => {
  open({ contentType: 'application/octet-stream', name: 'Budget.XLSX' });
  expect(document.querySelector('iframe')?.src).toContain('docs.google.com/gview');
});

it('sandboxes the viewer iframe so a file Google cannot render is never downloaded', () => {
  open({
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    name: 'contract.docx',
  });
  const sandbox = document.querySelector('iframe')?.getAttribute('sandbox');
  expect(sandbox).not.toBeNull();
  const tokens = (sandbox ?? '').split(/\s+/);
  expect(tokens).toEqual(expect.arrayContaining(['allow-scripts', 'allow-same-origin']));
  expect(tokens).not.toContain('allow-downloads');
});

