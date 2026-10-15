/**
 * The client page's header figures come from `clients/:clientId/summary`.
 *
 * It used to page through every matter (500 at a time) and every invoice (200 at
 * a time) before the page drew, only to show a count and three totals on the
 * Overview. The summary answers those in one request; the full lists now load
 * only when a tab that renders them opens.
 *
 * What has to break for these to go red: the page paging matters or invoices on
 * open again, a figure not coming from the summary (or cents shown unconverted),
 * a null section drawing something other than the zeroes an empty list drew, or
 * a list tab no longer loading its list.
 */

const mockGetMattersPaged = jest.fn();
const mockListFirmInvoicesPage = jest.fn();
const mockListPlans = jest.fn();
const mockGetClientSummary = jest.fn();
const mockGetFirmConnectStatus = jest.fn();

jest.mock('@/services/billing.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    listFirmInvoicesPage: (...args: unknown[]) => mockListFirmInvoicesPage(...args),
    listPlans: (...args: unknown[]) => mockListPlans(...args),
    getFirmConnectStatus: (...args: unknown[]) => mockGetFirmConnectStatus(...args),
  }),
);

jest.mock('@/services/clients.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    getClient: async () => ({ id: 'client-1', name: 'Dana Client', email: 'dana@example.com', clientType: 'person' }),
    getClientSummary: (...args: unknown[]) => mockGetClientSummary(...args),
    listClientCompanyRelationships: async () => [],
  }),
);

jest.mock('@/services/matters.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    getMattersPaged: (...args: unknown[]) => mockGetMattersPaged(...args),
  }),
);

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import ClientDetail from '@/components/clientComp/ClientDetail';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  api.allowUnhandled();
  __resetDuplicateRequestGuard();
  mockGetMattersPaged.mockReset().mockResolvedValue({
    matters: [{ id: 'm-1', name: 'Estate of Dana', matterIds: [], clientUserIds: ['client-1'] }],
    totalItems: 1,
  });
  mockListFirmInvoicesPage.mockReset().mockResolvedValue({ invoices: [], totalItems: 0, statusCounts: {}, summary: {} });
  mockListPlans.mockReset().mockResolvedValue([]);
  mockGetClientSummary.mockReset();
  mockGetFirmConnectStatus.mockReset().mockResolvedValue({ connected: false, chargesEnabled: false });
});

afterEach(() => {
  api.restore();
});

function snapshotLine(label: string): string {
  return screen.getByText(`${label}:`).parentElement?.textContent ?? '';
}

it('draws the header figures from the summary without paging matters or invoices', async () => {
  mockGetClientSummary.mockResolvedValue({
    clientId: 'client-1',
    matters: { count: 12 },
    billing: { invoiceCount: 4, totalBilledCents: 1234567, totalPaidCents: 34567, outstandingCents: 1200000 },
  });

  renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);

  expect(await screen.findByText('Total Billed:')).toBeInTheDocument();
  expect(mockGetClientSummary).toHaveBeenCalledWith('firm-1', 'client-1');
  expect(snapshotLine('Invoices')).toBe('Invoices: 4');
  expect(snapshotLine('Total Billed')).toBe('Total Billed: $12,345.67');
  expect(snapshotLine('Total Paid')).toBe('Total Paid: $345.67');
  expect(snapshotLine('Outstanding')).toBe('Outstanding: $12,000.00');
  // The Open Balance tile shows the same outstanding figure as the snapshot.
  expect(screen.getAllByText(/\$12,000\.00/).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByRole('button', { name: /^Matters\s*12$/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Billing\s*4$/ })).toBeInTheDocument();

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(mockGetMattersPaged).not.toHaveBeenCalled();
  expect(mockListFirmInvoicesPage).not.toHaveBeenCalled();
  expect(mockListPlans).not.toHaveBeenCalled();
});

it('draws a section the member may not see as the zeroes an empty list drew', async () => {
  mockGetClientSummary.mockResolvedValue({ clientId: 'client-1', matters: null, billing: null });

  renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);

  expect(await screen.findByText('Total Billed:')).toBeInTheDocument();
  expect(snapshotLine('Invoices')).toBe('Invoices: 0');
  expect(snapshotLine('Total Billed')).toBe('Total Billed: $0.00');
  expect(snapshotLine('Total Paid')).toBe('Total Paid: $0.00');
  expect(snapshotLine('Outstanding')).toBe('Outstanding: $0.00');
  expect(screen.getByRole('button', { name: /^Matters$/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Billing$/ })).toBeInTheDocument();
});

it('loads the full matter list only when the Matters tab opens', async () => {
  mockGetClientSummary.mockResolvedValue({ clientId: 'client-1', matters: { count: 1 }, billing: null });

  renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);
  fireEvent.click(await screen.findByRole('button', { name: /^Matters/ }));

  await waitFor(() => expect(mockGetMattersPaged).toHaveBeenCalledTimes(1));
  expect(mockGetMattersPaged).toHaveBeenCalledWith('firm-1', expect.objectContaining({ clientId: 'client-1', page: 1 }));
  expect(await screen.findByText('Estate of Dana')).toBeInTheDocument();
  expect(mockListFirmInvoicesPage).not.toHaveBeenCalled();
});

it('loads invoices and plans only when the Billing tab opens', async () => {
  mockGetClientSummary.mockResolvedValue({ clientId: 'client-1', matters: { count: 1 }, billing: null });

  renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);
  fireEvent.click(await screen.findByRole('button', { name: /^Billing/ }));

  await waitFor(() => expect(mockListPlans).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(mockListFirmInvoicesPage).toHaveBeenCalled());
  expect(mockListFirmInvoicesPage.mock.calls.some((call) => (call[1] as { relatedClientId?: string }).relatedClientId === 'client-1'
    && (call[1] as { limit?: number }).limit === 200)).toBe(true);
});

it('keeps the client invoice rows loading until their separate page request finishes', async () => {
  mockGetClientSummary.mockResolvedValue({ clientId: 'client-1', matters: { count: 0 }, billing: null });
  let releasePage: ((value: unknown) => void) | undefined;
  mockListFirmInvoicesPage.mockImplementation((_firmId: string, options: { limit?: number }) => {
    if (options.limit === 200) return Promise.resolve({ invoices: [], totalItems: 0 });
    return new Promise((resolve) => { releasePage = resolve; });
  });

  renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);
  fireEvent.click(await screen.findByRole('button', { name: /^Billing/ }));

  expect(await screen.findByRole('status', { name: 'Loading client invoices' })).toBeInTheDocument();
  expect(screen.queryByText('No invoices yet')).not.toBeInTheDocument();
  await waitFor(() => expect(releasePage).toBeDefined());
  releasePage?.({ invoices: [], totalItems: 0, statusCounts: {}, summary: {} });
  expect(await screen.findByText('No invoices yet')).toBeInTheDocument();
});

it('starts the Stripe status check without waiting for the client to load', async () => {
  let releaseClient!: () => void;
  const clientHeld = new Promise<void>((resolve) => { releaseClient = resolve; });
  const clients = jest.requireMock('@/services/clients.service') as { default: { getClient: unknown } };
  const originalGetClient = clients.default.getClient;
  (clients.default as Record<string, unknown>).getClient = async () => {
    await clientHeld;
    return { id: 'client-1', name: 'Dana Client', clientType: 'person' };
  };
  mockGetClientSummary.mockResolvedValue({ clientId: 'client-1', matters: null, billing: null });

  try {
    renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);
    await waitFor(() => expect(mockGetFirmConnectStatus).toHaveBeenCalledWith('firm-1'));
  } finally {
    releaseClient();
    (clients.default as Record<string, unknown>).getClient = originalGetClient;
  }
});
