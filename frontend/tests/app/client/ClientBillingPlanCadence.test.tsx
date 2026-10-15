/**
 * The client portal billing list labels a payment plan by its real cadence: weekly,
 * every two weeks, monthly, or every N days. A plan on any other cadence is never
 * called monthly.
 */
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');

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
import { screen } from '@testing-library/react';

import ClientBillingPage from '@/app/client/lawfirm/[lawFirmId]/billing/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';

let api: ApiMock;

const planInvoice = (frequencyDays: number) => ({
  invoices: [{
    id: 'inv-1', invoiceName: 'Plan Invoice', status: 'outstanding', totalAmount: 400, amountPaid: 0, remainingBalance: 400,
    dueDate: '2026-07-01', matterId: null,
    paymentPlan: { enabled: true, installmentAmount: 100, frequencyDays, expectedPayments: [] },
  }],
  totalItems: 1,
  summary: { totalBilled: 400, totalPaid: 0, totalOutstanding: 400 },
  statusCounts: { outstanding: 1 },
});

beforeEach(() => {
  api = installApiMock();
  api.allowUnhandled();
});

afterEach(() => api.restore());

it.each([
  [7, 'Payment plan: $100.00/week'],
  [14, 'Payment plan: $100.00/2 wks'],
  [30, 'Payment plan: $100.00/month'],
  [10, 'Payment plan: $100.00/10 days'],
  [21, 'Payment plan: $100.00/21 days'],
  [45, 'Payment plan: $100.00/45 days'],
])('labels a plan every %i days as "%s"', async (frequencyDays, expected) => {
  api.get('/billing', planInvoice(frequencyDays));
  renderWithProviders(<ClientBillingPage />);

  const label = await screen.findByText(/Payment plan:/);
  expect(label.textContent?.replace(/\s+/g, ' ').trim()).toBe(expected);
});
