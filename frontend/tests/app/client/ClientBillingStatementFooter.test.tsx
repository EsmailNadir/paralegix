/**
 * The portal Statement of Account: its footer total and its load failure.
 *
 * The footer must equal the ledger's last running balance. The server's
 * `summary.totalOutstanding` clamps each invoice at zero, so an overpaid invoice
 * drops out of it while the ledger still nets the overpayment; reading the
 * summary makes the footer disagree with the Balance column right above it.
 * Red if the footer reads the summary again, or prints a credit as a negative
 * "Current Balance".
 *
 * A failed statement read offers "Try again". Red if the retry is dropped or if
 * pressing it does not request the statement again.
 */
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@react-pdf/renderer', () => ({ __esModule: true, pdf: jest.fn(), StyleSheet: { create: (s: unknown) => s } }));
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
import { fireEvent, screen, within } from '@testing-library/react';
import ClientBillingPage from '@/app/client/lawfirm/[lawFirmId]/billing/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, sequence, type ApiMock, type RecordedCall } from '../../support/apiMock';

let api: ApiMock;

const overpaid = {
  id: 'inv-over', invoiceName: 'Overpaid', status: 'paid', isPaid: true,
  totalAmount: 500, amountPaid: 600, remainingBalance: 0, invoiceDate: '2026-09-01',
  payments: [{ id: 'pmt-over', date: '2026-09-02', amount: 600 }],
};
const open = {
  id: 'inv-open', invoiceName: 'Open', status: 'outstanding',
  totalAmount: 200, amountPaid: 0, remainingBalance: 200, invoiceDate: '2026-09-05', dueDate: '2099-12-31',
  payments: [],
};

/** The list read is paged; the statement read asks for the whole history. */
const isStatementRead = (call: RecordedCall) => !String(call.url).includes('page=');

function serve(invoices: unknown[], totalOutstanding: number) {
  api.get('/billing', {
    invoices,
    totalItems: invoices.length,
    summary: { totalBilled: 700, totalPaid: 600, totalOutstanding },
    statusCounts: { paid: 1, outstanding: invoices.length - 1 },
  });
}

async function openStatement() {
  renderWithProviders(<ClientBillingPage />);
  fireEvent.click(await screen.findByRole('button', { name: /^Statement/ }));
}

function footerCells() {
  const tfoot = document.querySelector('tfoot') as HTMLElement;
  return Array.from(within(tfoot).getAllByRole('cell')).map((td) => td.textContent);
}

beforeEach(() => {
  api = installApiMock();
  api.allowUnhandled();
});

afterEach(() => api.restore());

describe('portal statement footer', () => {
  it('shows the ledger\'s final running balance, not the clamped summary', async () => {
    serve([overpaid, open], 200);
    await openStatement();

    const last = (await screen.findByText('Invoice: Open')).closest('tr')!;
    expect(last.querySelectorAll('td')[4].textContent).toBe('$100.00');
    expect(footerCells()).toEqual(['Current Balance', '$100.00']);
  });

  it('labels a negative final balance as a credit, shown as a positive amount', async () => {
    serve([overpaid], 0);
    await openStatement();

    await screen.findByText('Payment for "Overpaid"');
    expect(footerCells()).toEqual(['Credit Balance', '$100.00']);
  });
});

describe('portal statement load failure', () => {
  it('offers a retry that reads the statement again and renders the ledger', async () => {
    const page = { invoices: [open], totalItems: 1, summary: { totalBilled: 200, totalPaid: 0, totalOutstanding: 200 }, statusCounts: { outstanding: 1 } };
    const statement = sequence({ status: 500, body: { error: 'Statement unavailable' } }, page) as (call: RecordedCall) => unknown;
    api.get('/billing', (call) => (isStatementRead(call) ? statement(call) : page));
    await openStatement();

    expect(await screen.findByText('Statement unavailable')).toBeInTheDocument();
    expect(api.calls('GET').filter(isStatementRead)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));

    expect(await screen.findByText('Invoice: Open')).toBeInTheDocument();
    expect(screen.queryByText('Statement unavailable')).not.toBeInTheDocument();
    expect(api.calls('GET').filter(isStatementRead)).toHaveLength(2);
  });
});
