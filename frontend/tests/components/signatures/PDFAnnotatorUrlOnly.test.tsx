/**
 * The open-signing annotator draws from a url and reads the document's bytes
 * only when it has to stamp them.
 *
 * The signer page hands over a url, never bytes, because the viewer reads page
 * ranges on its own. An annotator that waited for bytes before rendering showed
 * nothing at all and left the signer with no way to submit. Stamping is the one
 * step that needs the whole document, in the tab, through pdf-lib, so that read
 * happens at submit and is refused above a fixed cap.
 */
const mockSubmitSignedDocument = jest.fn();
const mockStampAnnotationsOntoPdf = jest.fn();
const viewerProps: any[] = [];

jest.mock('@/services/signatures.service', () => ({
  __esModule: true,
  default: {
    submitSignedDocument: (...args: unknown[]) => mockSubmitSignedDocument(...args),
  },
}));

jest.mock('@/components/signaturesComp/pdfStamper', () => ({
  __esModule: true,
  stampAnnotationsOntoPdf: (...args: unknown[]) => mockStampAnnotationsOntoPdf(...args),
  downloadPdf: jest.fn(),
}));

// The suite-wide stub renders nothing; this one records what the annotator
// handed the viewer, which is the claim under test.
jest.mock('@/components/signaturesComp/PDFPageViewer', () => ({
  __esModule: true,
  default: (props: any) => {
    viewerProps.push(props);
    return <div data-testid="pdf-viewer" />;
  },
}));

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PDFAnnotator, { ANNOTATOR_MAX_BYTES } from '@/components/signaturesComp/PDFAnnotator';

const URL_ = 'https://storage.googleapis.com/bucket/doc.pdf?X-Goog-Signature=abc';
const DOCUMENT = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const STAMPED = new Uint8Array([9, 9, 9]);

let fetchSpy: jest.SpyInstance;

function respond(body: Uint8Array, headers: Record<string, string> = {}) {
  return {
    ok: true,
    headers: new Headers(headers),
    arrayBuffer: async () => body.slice().buffer,
  } as unknown as Response;
}

beforeEach(() => {
  viewerProps.length = 0;
  mockSubmitSignedDocument.mockReset().mockResolvedValue({ success: true });
  mockStampAnnotationsOntoPdf.mockReset().mockResolvedValue(STAMPED);
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(respond(DOCUMENT));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

async function consentAndSubmit() {
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  fireEvent.click(screen.getByRole('checkbox'));
  await userEvent.type(screen.getByPlaceholderText('Enter your full legal name'), 'Jane Doe');
  fireEvent.click(screen.getByRole('button', { name: /sign & submit/i }));
}

it('renders the viewer from the url when it was given no bytes', async () => {
  render(
    <PDFAnnotator
      file={{ url: URL_, name: 'doc.pdf', sizeBytes: 1024 }}
      token="t"
      sourceRevision="r1"
    />,
  );

  expect(await screen.findByTestId('pdf-viewer')).toBeInTheDocument();
  expect(viewerProps.at(-1).file.url).toBe(URL_);
  expect(viewerProps.at(-1).file.bytes).toBeUndefined();
  // Rendering is ranged reads by pdf.js; the annotator itself fetched nothing.
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('refuses a document above the annotator cap and says why', () => {
  render(
    <PDFAnnotator
      file={{ url: URL_, name: 'doc.pdf', sizeBytes: ANNOTATOR_MAX_BYTES + 1 }}
      token="t"
      sourceRevision="r1"
    />,
  );

  expect(screen.getByText(/too large to sign in the browser/i)).toBeInTheDocument();
  // A size limit, not a failure: the screen must not call it an unexpected error.
  expect(screen.getByText('File too large')).toBeInTheDocument();
  expect(screen.queryByText('Unexpected error')).not.toBeInTheDocument();
  expect(screen.queryByTestId('pdf-viewer')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('reads the bytes once, at submit, and uploads the stamped copy', async () => {
  render(
    <PDFAnnotator
      file={{ url: URL_, name: 'doc.pdf', sizeBytes: DOCUMENT.byteLength }}
      token="t"
      sourceRevision="r1"
    />,
  );
  await screen.findByTestId('pdf-viewer');

  await consentAndSubmit();

  await waitFor(() => expect(mockSubmitSignedDocument).toHaveBeenCalledTimes(1));
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy).toHaveBeenCalledWith(URL_);
  // The document stamped is the one read from the url, and what is uploaded is
  // the stamper's output.
  expect(Array.from(mockStampAnnotationsOntoPdf.mock.calls[0][0] as Uint8Array)).toEqual(Array.from(DOCUMENT));
  const [token, uploaded, fileName, consent] = mockSubmitSignedDocument.mock.calls[0];
  expect(token).toBe('t');
  expect(uploaded).toBe(STAMPED);
  expect(fileName).toBe('doc.pdf');
  expect(consent).toMatchObject({ consentAgreed: true, consentName: 'Jane Doe', sourceRevision: 'r1' });
});

it('refuses at submit when a url of unknown size turns out to be over the cap', async () => {
  // The sign-yourself entry arrives with a url and no size, so the cap can only
  // be applied once the read starts. The response names its length before its
  // body is read, which is where the refusal belongs.
  fetchSpy.mockResolvedValue(respond(DOCUMENT, { 'content-length': String(ANNOTATOR_MAX_BYTES + 1) }));
  render(<PDFAnnotator file={{ url: URL_, name: 'doc.pdf' }} token="t" sourceRevision="r1" />);
  await screen.findByTestId('pdf-viewer');

  await consentAndSubmit();

  expect(await screen.findByText(/too large to sign in the browser/i)).toBeInTheDocument();
  expect(mockStampAnnotationsOntoPdf).not.toHaveBeenCalled();
  expect(mockSubmitSignedDocument).not.toHaveBeenCalled();
});
