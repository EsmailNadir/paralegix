/**
 * The client Documents tab's Files/Requests toggle is ONE element that stays
 * mounted as the view changes, so its highlight slides from one segment to the
 * other. Drawn inside each view instead, every switch mounted a fresh toggle
 * with the highlight already in place, and nothing moved.
 *
 * What has to break for these to go red: the toggle being rendered per view
 * again (the element after a switch is a different node), the "Preview as
 * client" control showing on Requests, or it no longer driving the files view.
 */

jest.mock('@/services/clients.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    getClient: async () => ({ id: 'client-1', name: 'Dana Client', email: 'dana@example.com', clientType: 'person' }),
    listClientCompanyRelationships: async () => [],
  }),
);

jest.mock('@/services/matters.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    getMattersPaged: async () => ({ matters: [], totalItems: 0 }),
  }),
);

// The two views fetch and draw a great deal of their own; the subject here is
// the header row above them.
jest.mock('@/components/clientComp/ClientFilesTab', () => ({
  __esModule: true,
  default: ({ previewMode }: { previewMode: boolean }) => (
    <div data-testid="files-view">{previewMode ? 'portal preview' : 'file browser'}</div>
  ),
}));
jest.mock('@/components/clientComp/ClientDocumentRequestsTab', () => ({
  __esModule: true,
  default: () => <div data-testid="requests-view" />,
}));

import React from 'react';
import { fireEvent, screen } from '@testing-library/react';
import ClientDetail from '@/components/clientComp/ClientDetail';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  // The page's own reads (summary, events, conversations) are not the subject.
  api.allowUnhandled();
  __resetDuplicateRequestGuard();
});

afterEach(() => api.restore());

async function openDocuments() {
  renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);
  fireEvent.click(await screen.findByRole('button', { name: /^Documents/ }));
  return screen.findByRole('group', { name: 'Documents view' });
}

it('keeps one Files/Requests toggle mounted as the view switches, so its highlight can slide', async () => {
  const toggle = await openDocuments();
  expect(await screen.findByTestId('files-view')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Requests' }));
  expect(await screen.findByTestId('requests-view')).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Documents view' })).toBe(toggle);
  expect(screen.getByRole('button', { name: 'Requests' })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: 'Files' }));
  expect(await screen.findByTestId('files-view')).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Documents view' })).toBe(toggle);
});

it('offers "Preview as client" on Files only, and it swaps the files view', async () => {
  await openDocuments();
  expect(await screen.findByTestId('files-view')).toHaveTextContent('file browser');

  fireEvent.click(screen.getByRole('button', { name: 'Preview as client' }));
  expect(screen.getByTestId('files-view')).toHaveTextContent('portal preview');
  fireEvent.click(screen.getByRole('button', { name: 'Back to files' }));
  expect(screen.getByTestId('files-view')).toHaveTextContent('file browser');

  fireEvent.click(screen.getByRole('button', { name: 'Requests' }));
  expect(await screen.findByTestId('requests-view')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Preview as client' })).not.toBeInTheDocument();
});
