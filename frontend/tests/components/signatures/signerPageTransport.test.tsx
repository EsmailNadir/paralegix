/**
 * The signer page hands the viewer a link and never holds the document.
 *
 * A 500 MB scan is 500 MB in the tab if the page reads it into an ArrayBuffer
 * before the first page can draw. The viewer reads ranges from a url, so the
 * page's whole job here is to obtain the url and pass it on.
 *
 * Both authenticated entry points are covered, because they used to hold the
 * document for different reasons: `objectPath` streamed it out of the API, and
 * `fileUrl` fetched it to build a blob url the viewer did not need.
 */
import React from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

jest.unmock('@/services/signatures.service');
jest.unmock('@/services/requestDeduplicator');

const params = new Map<string, string>();
jest.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: (key: string) => params.get(key) ?? null }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/signature',
}));

const placerProps: any[] = [];
jest.mock('@/components/signaturesComp/SignatureFieldPlacer', () => ({
  __esModule: true,
  default: (props: any) => { placerProps.push(props); return <div data-testid="placer" />; },
}));

const annotatorProps: any[] = [];
jest.mock('@/components/signaturesComp/PDFAnnotator', () => ({
  __esModule: true,
  default: (props: any) => { annotatorProps.push(props); return <div data-testid="annotator" />; },
}));

const restrictedProps: any[] = [];
jest.mock('@/components/signaturesComp/RestrictedSigningView', () => ({
  __esModule: true,
  default: (props: any) => { restrictedProps.push(props); return <div data-testid="restricted" />; },
}));

/**
 * The code prompt, reduced to the one thing this file needs from it: the moment
 * it reports a correct code. The real component posts the code and calls this;
 * what happens NEXT is what these cases are about.
 */
jest.mock('@/components/signaturesComp/AccessCodeGate', () => ({
  __esModule: true,
  default: ({ onVerified }: any) => (
    <button type="button" data-testid="verify-code" onClick={onVerified}>verify</button>
  ),
}));

import SignaturePage from '@/app/signature/page';

const SIGNED = 'https://storage.googleapis.com/bucket/prepared.pdf?X-Goog-Signature=abc';

let api: ApiMock;
let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  api = installApiMock();
  placerProps.length = 0;
  annotatorProps.length = 0;
  restrictedProps.length = 0;
  params.clear();
  fetchSpy = jest.spyOn(globalThis, 'fetch');
});

describe('a waiting signer whose turn arrives', () => {
  it('receives the revision from the refreshed session', async () => {
    jest.useFakeTimers();
    params.set('token', 'public-token');
    const field = {
      id: 'field-1', signerId: 'participant-1', page: 1,
      xPercent: 10, yPercent: 10, widthPercent: 20, heightPercent: 5,
      fieldType: 'signature', required: true,
    };
    api.get('/signing/public-token', sequence(
      { participantStatus: 'waiting', fileName: 'retainer.pdf', expiresAt: '2027-01-01T00:00:00.000Z' },
      { participantStatus: 'active', fileName: 'retainer.pdf', fields: [field], sourceRevision: 'revision-after-wait' },
    ));
    api.get('/signing/public-token/status', { participantStatus: 'active', sessionStatus: 'in_progress' });
    api.get('/signing/public-token/file', {
      url: SIGNED, fileName: 'retainer.pdf', contentType: 'application/pdf',
      sizeBytes: 100, generation: '1', expiresAt: '2027-01-01T00:00:00.000Z',
    });

    renderWithProviders(<SignaturePage />);
    await waitFor(() => expect(screen.getByText('Waiting for Your Turn')).toBeInTheDocument());
    await act(async () => { await jest.advanceTimersByTimeAsync(90_000); });
    await waitFor(() => expect(restrictedProps.length).toBeGreaterThan(0));

    expect(restrictedProps.at(-1).sourceRevision).toBe('revision-after-wait');
    jest.useRealTimers();
  });
});

describe('a signer behind an access code', () => {
  it('receives the revision the gated session did not carry', async () => {
    params.set('token', 'public-token');
    const field = {
      id: 'field-1', signerId: 'participant-1', page: 1,
      xPercent: 10, yPercent: 10, widthPercent: 20, heightPercent: 5,
      fieldType: 'signature', required: true,
    };
    // A gated session answers with the gate flags and a masked email, and NO
    // revision: the document is not disclosed until the code is right.
    api.get('/signing/public-token', sequence(
      { requiresAccessCode: true, accessCodeVerified: false, fileName: 'retainer.pdf' },
      {
        participantStatus: 'active', fileName: 'retainer.pdf', fields: [field],
        sourceRevision: 'revision-after-code', requiresAccessCode: true, accessCodeVerified: true,
      },
    ));
    api.get('/signing/public-token/file', {
      url: SIGNED, fileName: 'retainer.pdf', contentType: 'application/pdf',
      sizeBytes: 100, generation: '1', expiresAt: '2026-09-11T00:00:00.000Z',
    });

    renderWithProviders(<SignaturePage />);
    (await screen.findByTestId('verify-code')).click();
    await waitFor(() => expect(restrictedProps.length).toBeGreaterThan(0));

    // Without this the signer reaches a document they can fill in and cannot
    // submit: the completion refuses without a revision, and only a full page
    // reload gets them one.
    expect(restrictedProps.at(-1).sourceRevision).toBe('revision-after-code');
  });
});

afterEach(() => {
  jest.useRealTimers();
  api.restore();
  fetchSpy.mockRestore();
});

/** Every url the page asked the network for, whichever transport it used. */
const requestedUrls = () => [
  ...fetchSpy.mock.calls.map(([input]: any[]) => String(input)),
  ...api.calls().map((call) => call.url),
];

describe('designate mode reads an objectPath', () => {
  beforeEach(() => {
    params.set('mode', 'designate');
    params.set('objectPath', 'signing-uploads/firm-1/abc/retainer.pdf');
    params.set('fileName', 'retainer.pdf');
    params.set('lawFirmId', 'firm-1');
  });

  it('gives the placer the storage url and fetches no document', async () => {
    api.get('/signing/preview-url', {
      url: SIGNED,
      fileName: 'retainer.pdf',
      contentType: 'application/pdf',
      sizeBytes: 91234,
      generation: '1730000000000001',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    renderWithProviders(<SignaturePage />);

    await waitFor(() => expect(placerProps.length).toBeGreaterThan(0));
    expect(placerProps[0].file).toMatchObject({ url: SIGNED, name: 'retainer.pdf' });
    // The one thing this page must not do: pull the document into the tab.
    expect(placerProps[0].file.bytes).toBeUndefined();
    expect(requestedUrls()).not.toContain(SIGNED);
  });

  it('keeps the selected document name when storage returns an opaque object name', async () => {
    api.get('/signing/preview-url', {
      url: SIGNED,
      fileName: '5193586a-8e16-48d9-8d98-430c6581e520',
      contentType: 'application/pdf',
      sizeBytes: 91234,
      generation: '1730000000000001',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    renderWithProviders(<SignaturePage />);

    await waitFor(() => expect(placerProps.length).toBeGreaterThan(0));
    expect(placerProps[0].file.name).toBe('retainer.pdf');
  });

  it('shows the failure instead of a document when the API refuses', async () => {
    api.get('/signing/preview-url', { status: 403, body: { error: 'Access denied' } });

    const { container } = renderWithProviders(<SignaturePage />);

    // The page shows its own permission screen rather than the API's wording.
    await waitFor(() => expect(container.textContent).toMatch(/do not have permission/i));
    // A refusal must not leave the placer holding a url the API declined to
    // authorize, which is what a swallowed error would do.
    expect(placerProps).toHaveLength(0);
  });
});

describe('sign-yourself reads a fileUrl', () => {
  it('passes an allowed url straight through', async () => {
    params.set('fileUrl', SIGNED);
    params.set('fileName', 'retainer.pdf');

    renderWithProviders(<SignaturePage />);

    await waitFor(() => expect(annotatorProps.length).toBeGreaterThan(0));
    expect(annotatorProps[0].file).toMatchObject({ url: SIGNED, name: 'retainer.pdf' });
    expect(annotatorProps[0].file.bytes).toBeUndefined();
    // Nothing was fetched at all: the url is the whole answer.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a url from an origin that is not ours', async () => {
    params.set('fileUrl', 'https://evil.test/contract.pdf');
    params.set('fileName', 'contract.pdf');

    const { container } = renderWithProviders(<SignaturePage />);

    await waitFor(() => expect(container.textContent).toMatch(/not allowed/i));
    expect(annotatorProps).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
