/**
 * The "Verify your identity" card on the portal's firm home, through the real
 * services with only the transport faked.
 *
 * Red if the card stops showing for a person client the firm has asked to
 * verify, links anywhere but the identity page, keeps showing once they are
 * verified, shows for a firm that has not configured verification, or reads
 * the status without the active client record (or at all, for an organization).
 */
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/identityVerification.service');
jest.unmock('@/services/requestDeduplicator');

const mockNavigate = jest.fn();
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'test-uid' } }) }));
jest.mock('next/navigation', () => ({ useParams: () => ({ lawFirmId: 'firm-a' }), useSearchParams: () => new URLSearchParams() }));
jest.mock('@/contexts/NavigationContext', () => ({ useNavigation: () => ({ navigate: mockNavigate }) }));
let mockAssociation: { clientRecordId: string; clientType: 'person' | 'company' } = { clientRecordId: 'rec-a', clientType: 'person' };
jest.mock('@/contexts/ClientPortalContext', () => ({
  useClientPortal: () => ({ associations: [], associationsLoading: false, activeAssociation: mockAssociation, selectionRequired: false, setActiveClientRecordId: () => {} }),
}));

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import Firm from '@/app/client/lawfirm/[lawFirmId]/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';
import { scanAccessibility } from '../../support/accessibility';

const api = setupApiMock();
const STATUS = '/api/client-portal/lawfirm/firm-a/identity?clientRecordId=rec-a';

beforeEach(() => {
  process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off';
  api.getExact('/api/lawfirms/firm-a', { lawFirm: { id: 'firm-a', name: 'Firm A' } });
  api.get('/matters', { matters: [] });
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN;
  mockAssociation = { clientRecordId: 'rec-a', clientType: 'person' };
});

const verifiedResult = {
  verificationId: 'ver-1', method: 'mdoc_dcapi', status: 'verified',
  verifiedName: { given: 'Jane', family: 'Smith' }, issuer: 'California', docType: null,
  credentialExpiresOn: null, nameMatchesRecord: true, checks: {}, failureReason: null,
  createdAt: '2026-10-14T16:00:00.000Z', completedAt: '2026-10-14T16:01:00.000Z',
};

it('invites a client who has not verified to the identity page', async () => {
  api.getExact(STATUS, { configured: true, latest: null });
  const { container } = renderWithProviders(<Firm />);

  const link = await screen.findByRole('link', { name: 'Verify now' });
  expect(link).toHaveAttribute('href', '/client/lawfirm/firm-a/identity');
  expect(screen.getByRole('heading', { level: 2, name: 'Verify your identity' })).toBeInTheDocument();
  expect((await scanAccessibility(container)).violations).toEqual([]);
});

it('still invites a client whose last attempt failed', async () => {
  api.getExact(STATUS, { configured: true, latest: { ...verifiedResult, status: 'failed', verifiedName: null } });
  renderWithProviders(<Firm />);

  expect(await screen.findByRole('link', { name: 'Verify now' })).toBeInTheDocument();
});

it('drops the card once the client is verified', async () => {
  api.getExact(STATUS, { configured: true, latest: verifiedResult });
  renderWithProviders(<Firm />);

  await screen.findByRole('heading', { level: 1, name: 'Firm A' });
  await waitFor(() => expect(api.callsTo('/identity')).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByRole('link', { name: 'Verify now' })).not.toBeInTheDocument();
});

it('shows no card when the firm has not configured verification', async () => {
  api.getExact(STATUS, { configured: false, latest: null });
  renderWithProviders(<Firm />);

  await screen.findByRole('heading', { level: 1, name: 'Firm A' });
  await waitFor(() => expect(api.callsTo('/identity')).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByRole('link', { name: 'Verify now' })).not.toBeInTheDocument();
});

it('neither reads the status nor shows the card on an organization link', async () => {
  mockAssociation = { clientRecordId: 'rec-org', clientType: 'company' };
  api.get('/matters', { matters: [] });
  renderWithProviders(<Firm />);

  await screen.findByRole('heading', { level: 1, name: 'Firm A' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api.callsTo('/identity')).toHaveLength(0);
  expect(screen.queryByRole('link', { name: 'Verify now' })).not.toBeInTheDocument();
});
