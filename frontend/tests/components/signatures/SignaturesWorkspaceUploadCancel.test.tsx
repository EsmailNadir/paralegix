/**
 * Cancelling a document upload on the signing page.
 *
 * `/signing/upload-finalize` is what makes an uploaded PDF a document the firm
 * can send, so a cancelled upload must never reach it, and a cancel is the
 * user's own choice, so it must never come back as an error.
 *
 * What has to break for these to go red: the page not aborting its upload on
 * unmount, a second file taking the upload's controller so Cancel stops only
 * the newer one while the first still lands and opens the sign dialog, or the
 * flattened re-upload reporting its cancel as "The upload was cancelled."
 */
jest.unmock('@/services/signatures.service');
jest.unmock('@/services/requestDeduplicator');

const mockFlattenPdf = jest.fn();
jest.mock('@/lib/pdfFlatten', () => ({
  __esModule: true,
  flattenPdf: (...args: unknown[]) => mockFlattenPdf(...args),
}));

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import SignaturesWorkspace from '@/components/signaturesComp/SignaturesWorkspace';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { installXhrMock, type XhrMock } from '../../support/xhrMock';
import { renderWithProviders } from '../../support/renderWithProviders';

const FIRM = 'firm-1';
const WORKSPACE = `/api/lawfirms/${FIRM}/signature-links/workspace`;
const SESSION_URL = 'https://storage.googleapis.com/upload/sig-1';

let api: ApiMock;
let xhr: XhrMock;

const pdf = (name = 'Engagement.pdf') => new File(['%PDF-1.7'], name, { type: 'application/pdf' });

/** Resolves after `ms`, for letting an upload that should have stopped carry on. */
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  window.localStorage.clear();
  api = installApiMock();
  xhr = installXhrMock();
  api.get(WORKSPACE, {
    sessions: { sessions: [], totalItems: 0 },
    summary: { counts: {}, total: 0, notCompleted: 0 },
    pendingForUser: { needsMySignature: [], createdByMe: [] },
    templates: { templates: [] },
  });
  // Registered so an upload that failed to stop runs to completion and is
  // counted, rather than dying on an unmatched request.
  xhr.onExact('PUT', SESSION_URL, { status: 200 });
});

afterEach(() => {
  api.restore();
  xhr.restore();
});

/** `/signing/upload-init`, answered slowly enough to act while it is open. */
function slowInit() {
  let opened = 0;
  api.post('/signing/upload-init', () => {
    opened += 1;
    return {
      delayMs: 100,
      body: { objectPath: `signing-uploads/${FIRM}/obj-${opened}/a.pdf`, fileName: 'a.pdf', uploadUrl: SESSION_URL },
    };
  });
}

function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

function drop(file: File) {
  const zone = screen.getByRole('heading', { name: 'Send a document for signature' }).closest('.relative') as HTMLElement;
  fireEvent.drop(zone, { dataTransfer: { files: [file], types: ['Files'] } });
}

it('aborts the upload when the page unmounts, so nothing is finalized', async () => {
  slowInit();
  api.post('/signing/upload-finalize', { objectPath: 'p', fileName: 'a.pdf' });

  const { container, unmount } = renderWithProviders(
    <SignaturesWorkspace lawFirmId={FIRM} initialTab="activity" />,
  );
  pick(container, pdf());
  await waitFor(() => expect(api.callsTo('/signing/upload-init')).toHaveLength(1));

  unmount();
  await settle();

  expect(xhr.calls('PUT')).toHaveLength(0);
  expect(api.callsTo('/signing/upload-finalize')).toHaveLength(0);
});

it('cancels the running upload even after another file was dropped on the page', async () => {
  slowInit();
  api.post('/signing/upload-finalize', { objectPath: 'p', fileName: 'a.pdf' });

  const { container } = renderWithProviders(
    <SignaturesWorkspace lawFirmId={FIRM} initialTab="activity" />,
  );
  pick(container, pdf('First.pdf'));
  await waitFor(() => expect(api.callsTo('/signing/upload-init')).toHaveLength(1));

  drop(pdf('Second.pdf'));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
  await settle(300);

  // Nothing the user picked may land after they pressed Cancel.
  expect(api.callsTo('/signing/upload-finalize')).toHaveLength(0);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByText('Choose a file')).toBeInTheDocument();
});

it('treats a cancelled flattened re-upload as a cancel, not an error', async () => {
  let opened = 0;
  api.post('/signing/upload-init', () => {
    opened += 1;
    const body = { objectPath: `signing-uploads/${FIRM}/obj-${opened}/a.pdf`, fileName: 'a.pdf', uploadUrl: SESSION_URL };
    // The first (the original form) answers at once; the flattened copy is
    // held open so it can be cancelled.
    return opened === 1 ? { body } : { delayMs: 100, body };
  });
  api.post('/signing/upload-finalize', {
    status: 422,
    body: { error: 'This PDF has form fields we cannot prepare for signing.', code: 'PDF_UNSUPPORTED_FORM' },
  });
  mockFlattenPdf.mockResolvedValue({ file: pdf('Intake form.pdf') });

  const { container } = renderWithProviders(
    <SignaturesWorkspace lawFirmId={FIRM} initialTab="activity" />,
  );
  pick(container, pdf('Intake form.pdf'));
  fireEvent.click(await screen.findByRole('button', { name: 'Flatten and Upload' }));
  await waitFor(() => expect(api.callsTo('/signing/upload-init')).toHaveLength(2));

  fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
  await settle();

  expect(api.callsTo('/signing/upload-finalize')).toHaveLength(1);
  expect(screen.queryByText(/upload was cancelled/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Failed to upload/i)).not.toBeInTheDocument();
});
