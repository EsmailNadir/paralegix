jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');
const mockUser = { uid: 'test-uid' };
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('next/navigation', () => ({ useParams: () => ({ lawFirmId: 'firm-a' }), useSearchParams: () => new URLSearchParams() }));
jest.mock('@/contexts/ClientPortalContext', () => ({ useClientPortal: () => ({ associations: [], associationsLoading: false, activeAssociation: { clientRecordId: 'record-a' }, selectionRequired: false }) }));
import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Documents from '@/app/client/lawfirm/[lawFirmId]/documents/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';
const api = setupApiMock();
it('names document search and distinguishes downloads after filtering real documents', async () => {
  api.get('/documents', { documents: [
    { id: 'doc-a', name: 'Estate.pdf', type: 'application/pdf', size: 111, uploadedAt: '2026-10-04T12:00:00Z', downloadUrl: '', objectPath: 'docs/a.pdf' },
    { id: 'doc-b', name: 'Lease.pdf', type: 'application/pdf', size: 222, uploadedAt: '2026-10-04T12:00:00Z', downloadUrl: '', objectPath: 'docs/b.pdf' },
  ], folders: [], truncated: false });
  api.get('/matters', { matters: [] });
  api.get('/document-requests', { requests: [] });
  renderWithProviders(<Documents />);
  const search = await screen.findByRole('textbox', { name: 'Search documents' });
  await userEvent.type(search, 'Estate');
  expect(screen.getByRole('button', { name: 'Download Estate.pdf' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Download Lease.pdf' })).not.toBeInTheDocument();
  expect(search).toHaveFocus();
  await userEvent.clear(search);
  await userEvent.type(search, 'Lease');
  expect(screen.getByRole('button', { name: 'Download Lease.pdf' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Download Estate.pdf' })).not.toBeInTheDocument();
  expect(api.callsTo('/documents')[0].url).toContain('clientRecordId=record-a');
});
