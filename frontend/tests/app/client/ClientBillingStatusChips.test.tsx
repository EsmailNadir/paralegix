/**
 * The portal billing page's status chips, driven through the real portal
 * service against a faked transport.
 */
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');

// The page only calls `pdf` on a download; the ESM renderer is not loadable here.
jest.mock('@react-pdf/renderer', () => ({
  __esModule: true,
  pdf: jest.fn(),
  StyleSheet: { create: (styles: unknown) => styles },
}));

jest.mock('next/navigation', () => ({
  useParams: () => ({ lawFirmId: 'firm-1' }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/client/lawfirm/firm-1/billing',
}));

jest.mock('@/contexts/ClientPortalContext', () => ({
  __esModule: true,
  useClientPortal: () => ({
    associations: [],
    associationsLoading: false,
    activeAssociation: { clientRecordId: 'record-1' },
    selectionRequired: false,
    setActiveClientRecordId: jest.fn(),
  }),
}));

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import ClientBillingPage from '@/app/client/lawfirm/[lawFirmId]/billing/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  api.allowUnhandled();
  api.get('/billing', {
    invoices: [],
    totalItems: 0,
    summary: { totalBilled: 0, totalPaid: 0, totalOutstanding: 0 },
    statusCounts: { voided: 3, outstanding: 1 },
  });
});

afterEach(() => api.restore());

describe('portal billing status chips', () => {
  // Red if: the Voided chip is dropped, or picking it asks for another status.
  it('shows Voided last, with its count, and requests status=voided when it is picked', async () => {
    renderWithProviders(<ClientBillingPage />);

    const voided = await screen.findByRole('button', { name: /^Voided/ });
    expect(voided).toHaveTextContent('3');
    const chips = screen
      .getAllByRole('button')
      .filter((b) => /^(All|Unpaid|Overdue|Partial|Paid|Voided)/.test(b.textContent || ''));
    expect(chips[chips.length - 1]).toBe(voided);

    fireEvent.click(voided);

    await waitFor(() =>
      expect(api.calls().some((c) => c.pathname.endsWith('/billing') && String(c.url).includes('status=voided'))).toBe(true),
    );
  });
});

describe('the written-off chip', () => {
  // Red if: written-off invoices are folded into the Paid count while the Paid
  // filter only returns status=paid, so the chip promises rows it never shows.
  it('counts written-off invoices on their own chip and requests status=credited for it', async () => {
    api.get('/billing', {
      invoices: [],
      totalItems: 0,
      summary: { totalBilled: 0, totalPaid: 0, totalOutstanding: 0 },
      statusCounts: { paid: 2, credited: 1, voided: 1 },
    });
    renderWithProviders(<ClientBillingPage />);

    const paid = await screen.findByRole('button', { name: /^Paid/ });
    expect(paid).toHaveTextContent('2');
    const writtenOff = screen.getByRole('button', { name: /^Written Off/ });
    expect(writtenOff).toHaveTextContent('1');

    fireEvent.click(writtenOff);
    await waitFor(() =>
      expect(api.calls().some((c) => c.pathname.endsWith('/billing') && String(c.url).includes('status=credited'))).toBe(true),
    );
  });
});
