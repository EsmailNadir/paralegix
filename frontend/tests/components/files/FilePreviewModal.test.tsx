/**
 * What the authenticated file preview hands the shared overlay.
 *
 * The overlay resolves nothing itself: it is given a url and, for a document
 * long enough to outlive one, a way to mint another. This file is about that
 * second half. A remint has to go back through the API, because the point of it
 * is that access is checked AGAIN, minutes after the reader opened the document,
 * rather than a url being extended on the strength of the grant that produced
 * it. Minting one locally, or reusing the first one, would look identical on
 * screen for as long as anyone tested it.
 *
 * The transport is faked rather than the service, so the service's own url
 * building, auth headers and response parsing all really run.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { installApiMock } from '../../support/apiMock';

jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

/** Props the shared overlay was last given. */
let overlayProps: Record<string, any> | null = null;

jest.mock('@/components/filesComp/DocumentPreviewOverlay', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    overlayProps = props;
    return <div data-testid="overlay" />;
  },
}));

import FilePreviewModal from '@/components/filesComp/FilePreviewModal';

const LAW_FIRM_ID = '11111111-1111-1111-1111-111111111111';
const FILE_ID = '22222222-2222-2222-2222-222222222222';

let api: ReturnType<typeof installApiMock>;

beforeEach(() => {
  overlayProps = null;
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

function open(file: Record<string, unknown> = {}) {
  return render(
    <FilePreviewModal
      isOpen
      onClose={() => {}}
      onDownload={() => {}}
      lawFirmId={LAW_FIRM_ID}
      file={{
        id: FILE_ID,
        name: 'production.pdf',
        contentType: 'application/pdf',
        size: 3_000_000_000,
        signedUrl: 'https://storage.googleapis.com/bucket/production.pdf?sig=first',
        ...file,
      }}
    />,
  );
}

it('gives the overlay a reminter that reauthorizes through the API', async () => {
  api.get(`/lawfirms/${LAW_FIRM_ID}/files/refresh-url`, {
    signedUrl: 'https://storage.googleapis.com/bucket/production.pdf?sig=second',
  });

  open();
  await screen.findByTestId('overlay');
  await waitFor(() => expect(overlayProps!.fileUrl).toBeTruthy());

  const minted = await overlayProps!.onRefreshUrl();

  expect(minted).toBe('https://storage.googleapis.com/bucket/production.pdf?sig=second');
  const calls = api.callsTo('/refresh-url');
  expect(calls).toHaveLength(1);
  // Scoped to the firm and the file, which is what the route checks membership
  // and permission against.
  expect(calls[0].url).toContain(`lawFirmId=${LAW_FIRM_ID}`);
  expect(calls[0].url).toContain(`fileId=${FILE_ID}`);
});

it('offers no reminter for a file with no record to reauthorize against', async () => {
  // A message or note attachment arrives with a url and nothing else. There is
  // no file row to check access on, so there is nothing to remint either, and
  // the overlay must be told that rather than handed a call that would 400.
  render(
    <FilePreviewModal
      isOpen
      onClose={() => {}}
      onDownload={() => {}}
      file={{
        name: 'note.pdf',
        contentType: 'application/pdf',
        size: 1000,
        signedUrl: 'https://storage.googleapis.com/bucket/note.pdf?sig=first',
      }}
    />,
  );

  await screen.findByTestId('overlay');
  expect(overlayProps!.onRefreshUrl).toBeUndefined();
});

it('passes the size through, so the overlay never has to probe for it', async () => {
  open();
  await screen.findByTestId('overlay');

  expect(overlayProps!.sizeBytes).toBe(3_000_000_000);
});
