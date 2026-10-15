/**
 * The identity badge's place on the client detail header.
 *
 * Red if the badge is dropped from the header beside the client's status, or
 * if an organization client (which has no ID to verify) still asks the firm
 * route for a verification.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/identityVerification.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/clients/client-1',
  useParams: () => ({ lawFirmId: 'firm-1', clientId: 'client-1' }),
  useSearchParams: () => new URLSearchParams(),
}));

import React from 'react';
import { screen, within } from '@testing-library/react';
import ClientDetailPage from '@/app/lawfirm/[lawFirmId]/clients/[clientId]/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

let api: ApiMock;
const IDENTITY = '/api/lawfirms/firm-1/clients/client-1/identity-verification';

function serveClient(body: Record<string, unknown>) {
  api.getExact('http://localhost:5001/api/lawfirms/firm-1/clients/client-1', { client: { id: 'client-1', name: 'Dana Client', ...body } });
  api.get('/lawfirms/firm-1/clients/client-1/summary', { clientId: 'client-1', matters: null, billing: null });
}

beforeEach(() => {
  api = installApiMock();
  // The page also reads tasks, conversations, relationships and lookups this spec does not examine.
  api.allowUnhandled();
  __resetDuplicateRequestGuard();
});

afterEach(() => api.restore());

it("shows the verified badge in the client's header", async () => {
  serveClient({ clientType: 'person', status: 'active' });
  api.getExact(IDENTITY, {
    verified: {
      verificationId: 'ver-1', method: 'mdoc_dcapi', status: 'verified',
      verifiedName: { given: 'Dana', family: 'Client' }, issuer: 'California', docType: null,
      credentialExpiresOn: null, nameMatchesRecord: true, checks: {}, failureReason: null,
      createdAt: '2026-10-14T16:00:00.000Z', completedAt: '2026-10-14T16:01:00.000Z',
    },
    latestAttempt: null,
  });

  renderWithProviders(<ClientDetailPage />);

  const heading = await screen.findByRole('heading', { name: /Dana Client/ });
  expect(await within(heading).findByText('ID verified Oct 14, 2026 · California')).toBeInTheDocument();
});

it('does not ask for a verification for an organization client', async () => {
  serveClient({ clientType: 'company', status: 'active' });

  renderWithProviders(<ClientDetailPage />);

  await screen.findByRole('heading', { name: /Dana Client/ });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(api.callsTo('/identity-verification')).toHaveLength(0);
});
