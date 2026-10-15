/**
 * The client invoice composer is a financial write surface. A member without
 * `billing.manageInvoices` gets the app's standard denial page and the page asks
 * the API for nothing; a member with it gets the composer.
 *
 * Red if the page stops being wrapped in RequirePermission (the composer heading
 * renders for the denied member), or if the gate wraps only the JSX instead of
 * the component that owns the data hooks (the denied member's render still
 * reads the client and its time entries).
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/lawfirm/firm-a/clients/client-a/generate-invoice',
  useParams: () => ({ lawFirmId: 'firm-a', clientId: 'client-a' }),
  useSearchParams: () => new URLSearchParams(),
}));

import { screen } from '@testing-library/react';

import ClientGenerateInvoicePage from '@/app/lawfirm/[lawFirmId]/clients/[clientId]/generate-invoice/page';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { setupApiMock } from '../../../support/apiMock';
import { grantBaselineMember, resetPermissions } from '../../../support/permissions';

const api = setupApiMock();

function seedClient() {
  api.get('/api/lawfirms/firm-a/clients/client-a', {
    client: { id: 'client-a', name: 'Acme Holdings', clientType: 'individual', matterIds: [] },
  });
  api.get('/api/lawfirms/firm-a/billing/time-entries/client/client-a', { timeEntries: [] });
  api.get('/api/lawfirms/firm-a/billing/flat-fees/client/client-a', { flatFees: [] });
}

afterEach(() => resetPermissions());

describe('client generate-invoice permission gate', () => {
  it('shows the composer to a member who can manage invoices', async () => {
    grantBaselineMember(['billing.viewInvoices', 'billing.viewTimeEntries', 'billing.manageInvoices']);
    seedClient();

    renderWithProviders(<ClientGenerateInvoicePage />);

    expect(await screen.findByRole('heading', { name: 'Generate Invoice' })).toBeInTheDocument();
    expect(screen.queryByText('You do not have access to this area')).not.toBeInTheDocument();
    // The composer's own data load ran, which is what the denied case below
    // asserts the absence of.
    expect(api.callsTo('/clients/client-a')).toHaveLength(1);
  });

  it('shows the denial page, and no composer, to a member who can only read invoices', async () => {
    grantBaselineMember(['billing.viewInvoices', 'billing.viewTimeEntries']);
    seedClient();

    renderWithProviders(<ClientGenerateInvoicePage />);

    expect(await screen.findByText('You do not have access to this area')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Generate Invoice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate Invoice' })).not.toBeInTheDocument();
    expect(api.calls()).toHaveLength(0);
  });
});
