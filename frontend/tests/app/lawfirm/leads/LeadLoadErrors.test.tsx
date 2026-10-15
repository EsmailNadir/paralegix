jest.unmock('@/services/leads.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  useParams: () => ({ lawFirmId: 'firm-a', leadId: 'lead-a' }),
  usePathname: () => '/lawfirm/firm-a/leads/lead-a',
  useSearchParams: () => new URLSearchParams(),
}));

import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import LeadDetailPage from '@/app/lawfirm/[lawFirmId]/leads/[leadId]/page';
import LeadsGrid from '@/components/leadComp/LeadsGrid';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../../support/apiMock';
import { grantPermissions, resetPermissions } from '../../../support/permissions';

let api: ApiMock;
beforeEach(() => { api = installApiMock(); api.allowUnhandled(); grantPermissions(['leads.view']); });
afterEach(() => { api.restore(); resetPermissions(); });

it('retries the lead detail read through the real service', async () => {
  let attempts = 0;
  api.getExact('http://localhost:5001/api/lawfirms/firm-a/leads/lead-a', () => {
    attempts += 1;
    return attempts === 1 ? { status: 500, body: { error: 'lead read unavailable' } }
      : { lead: { id: 'lead-a', name: 'Recovered Prospect', stageId: null, notes: [] } };
  });
  renderWithProviders(<LeadDetailPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('lead read unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { name: 'Recovered Prospect' })).toBeInTheDocument();
  expect(attempts).toBe(2);
});

it('shows the lead load error without the successful empty-list message', async () => {
  api.get('/lawfirms/firm-a/leads', { status: 500, body: { error: 'lead list unavailable' } });
  renderWithProviders(<LeadsGrid lawFirmId="firm-a" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('lead list unavailable');
  expect(screen.queryByText('No leads yet')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
});
