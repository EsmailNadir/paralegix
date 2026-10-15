/**
 * Submitting a FIELDLESS signature from the annotator, when the first answer is
 * not a plain success.
 *
 * Two failures this pins, both of which told a signer whose signature had
 * landed that it had not:
 *
 *   A RETRY MUST NOT OPEN A SECOND UPLOAD. Once the signature is recorded the
 *   token is consumed, and `complete-upload-init` answers 404 for it. A retry
 *   that asked again read to the signer as "this link has expired". The stored
 *   object from the first attempt is named again instead, with the same
 *   idempotency key, so the server replays the outcome.
 *
 *   A RECORDED SIGNATURE WHOSE DOCUMENT IS STILL BEING PRODUCED IS NOT A
 *   FAILURE, AND NOT YET A FINISHED DOCUMENT. `processing` and
 *   `recoverable_failure` both mean the signer is done; the page waits for the
 *   executed document the way the field-driven view does.
 */
const mockSubmitSignedDocument = jest.fn();
const mockGetSigningStatus = jest.fn();
const mockStampAnnotationsOntoPdf = jest.fn();
const viewerProps: any[] = [];

jest.mock('@/services/signatures.service', () => ({
  __esModule: true,
  default: {
    submitSignedDocument: (...args: unknown[]) => mockSubmitSignedDocument(...args),
    getSigningStatus: (...args: unknown[]) => mockGetSigningStatus(...args),
  },
}));

jest.mock('@/components/signaturesComp/pdfStamper', () => ({
  __esModule: true,
  stampAnnotationsOntoPdf: (...args: unknown[]) => mockStampAnnotationsOntoPdf(...args),
  downloadPdf: jest.fn(),
}));

jest.mock('@/components/signaturesComp/PDFPageViewer', () => ({
  __esModule: true,
  default: (props: any) => {
    viewerProps.push(props);
    return <div data-testid="pdf-viewer" />;
  },
}));

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import PDFAnnotator from '@/components/signaturesComp/PDFAnnotator';
import { ApiError } from '@/lib/utils/apiErrors';

const DOCUMENT = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const STAMPED = new Uint8Array([9, 9, 9]);
const OBJECT_PATH = 'lawfirmids/firm-1/signing-work/s-1/completion/abc.pdf';

beforeEach(() => {
  viewerProps.length = 0;
  mockSubmitSignedDocument.mockReset().mockResolvedValue({ success: true, state: 'completed' });
  mockGetSigningStatus.mockReset().mockResolvedValue({ sessionStatus: 'in_progress', participantStatus: 'completed' });
  mockStampAnnotationsOntoPdf.mockReset().mockResolvedValue(STAMPED);
});

function renderAnnotator() {
  return render(
    <PDFAnnotator
      file={{ url: 'blob:doc', name: 'doc.pdf', sizeBytes: DOCUMENT.byteLength, bytes: DOCUMENT }}
      token="t"
      sourceRevision="r1"
    />,
  );
}

/** Open the consent modal and fill it, without userEvent, whose delays run on faked timers. */
function consent() {
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByPlaceholderText('Enter your full legal name'), { target: { value: 'Jane Doe' } });
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: /sign & submit/i }));

/** A first attempt that stored the document and then got a failure back. */
function failAfterUpload() {
  mockSubmitSignedDocument.mockImplementationOnce(async (_t, _b, _n, _c, options) => {
    options?.onUploaded?.(OBJECT_PATH);
    throw new ApiError('Something went wrong', { status: 500 });
  });
}

describe('retrying a submission', () => {
  it('focuses the existing submission error and the successful outcome without adding actions', async () => {
    failAfterUpload();
    renderAnnotator();
    consent();
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).toHaveFocus();
    expect(screen.getByPlaceholderText('Enter your full legal name')).toHaveValue('Jane Doe');
    submit();
    const heading = await screen.findByRole('heading', { name: 'Document Submitted' });
    expect(heading).toHaveFocus();
  });
  it('names the document already uploaded instead of opening a second upload', async () => {
    failAfterUpload();
    renderAnnotator();
    consent();

    submit();
    await screen.findByText(/something went wrong on our end/i);
    submit();
    await waitFor(() => expect(mockSubmitSignedDocument).toHaveBeenCalledTimes(2));

    const [, , , firstConsent, firstOptions] = mockSubmitSignedDocument.mock.calls[0];
    const [, , , retryConsent, retryOptions] = mockSubmitSignedDocument.mock.calls[1];
    expect(firstOptions?.signedObjectPath).toBeUndefined();
    expect(retryOptions?.signedObjectPath).toBe(OBJECT_PATH);
    expect(retryConsent.idempotencyKey).toBe(firstConsent.idempotencyKey);
    expect(await screen.findByText('Document Submitted')).toBeInTheDocument();
  });

  it('uploads again once the signer has changed the marks since the failed attempt', async () => {
    failAfterUpload();
    renderAnnotator();
    consent();
    submit();
    await screen.findByText(/something went wrong on our end/i);

    // Back in the editor, a new text mark goes on the page.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    act(() => { viewerProps.at(-1).onPageClick(1, 20, 20); });
    // Consent and name are kept across closing the modal, so only reopen it.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    submit();
    await waitFor(() => expect(mockSubmitSignedDocument).toHaveBeenCalledTimes(2));

    // The stored object holds the OLD marks. Naming it would file a document
    // without what the signer just added.
    expect(mockSubmitSignedDocument.mock.calls[1][4]?.signedObjectPath).toBeUndefined();
  });
});

describe('a recorded signature whose executed document is not ready', () => {
  afterEach(() => jest.useRealTimers());

  it.each(['processing', 'recoverable_failure'])(
    'reports a %s answer as submitted and waits for the document',
    async (state) => {
      jest.useFakeTimers();
      mockSubmitSignedDocument.mockResolvedValue({ success: false, state, consentRecorded: true });
      mockGetSigningStatus.mockResolvedValue({ sessionStatus: 'completed', participantStatus: 'completed' });
      renderAnnotator();
      consent();

      submit();
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });

      expect(screen.getByText('Document Submitted')).toBeInTheDocument();
      expect(screen.getByText(/still being produced/i)).toBeInTheDocument();
      expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();

      // The first status read finds the session sealed, and the wait ends.
      await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
      expect(mockGetSigningStatus).toHaveBeenCalledWith('t');
      expect(screen.queryByText(/still being produced/i)).not.toBeInTheDocument();
    },
  );

  it('reports a permanent refusal as a recorded signature the sender has to act on', async () => {
    mockSubmitSignedDocument.mockResolvedValue({ success: false, state: 'permanent_refusal', consentRecorded: true });
    renderAnnotator();
    consent();

    submit();

    expect(await screen.findByText(/cannot be finalized/i)).toBeInTheDocument();
    expect(screen.queryByText('Document Submitted')).not.toBeInTheDocument();
  });
});
