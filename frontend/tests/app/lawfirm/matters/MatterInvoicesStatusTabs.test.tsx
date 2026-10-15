/**
 * The matter invoices page's status tabs, driven through the real billing
 * service against a faked transport.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/requestDeduplicator');

const useParamsMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/matters/matter-1/invoices',
  useParams: () => useParamsMock(),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: jest.fn(), isNavigating: false }),
}));

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import MatterInvoicesPage from '@/app/lawfirm/[lawFirmId]/matters/[matterId]/invoices/page';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../../support/apiMock';
import { grantBaselineMember, resetPermissions } from '../../../support/permissions';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  api.allowUnhandled();
  __resetDuplicateRequestGuard();
  useParamsMock.mockReturnValue({ lawFirmId: 'firm-1', matterId: 'matter-1' });
  grantBaselineMember(['billing.viewInvoices']);
  api.get('/lawfirms/firm-1/billing/invoices/firm', {
    invoices: [],
    totalItems: 0,
    statusCounts: { voided: 2, outstanding: 1 },
  });
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

describe('matter invoices status tabs', () => {
  // Red if: the Voided tab is dropped, or picking it asks for another status.
  it('shows Voided last, with its count, and requests status=voided when it is picked', async () => {
    renderWithProviders(<MatterInvoicesPage />);

    const voided = await screen.findByRole('button', { name: /^Voided/ });
    expect(voided).toHaveTextContent('2');
    const tabs = screen.getAllByRole('button').filter((b) => /^(All|Unpaid|Overdue|Partial|Paid|Written Off|Voided)/.test(b.textContent || ''));
    expect(tabs[tabs.length - 1]).toBe(voided);

    fireEvent.click(voided);

    await waitFor(() =>
      expect(
        api.calls().some((c) => c.pathname.includes('/invoices/firm') && String(c.url).includes('status=voided')),
      ).toBe(true),
    );
  });
});
