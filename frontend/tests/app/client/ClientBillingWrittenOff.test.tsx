/**
 * A portal invoice the firm closed with a write-off. The serializer reports it
 * as status 'credited' with isPaid false, and the portal invoice detail page
 * badges it "Written Off" through `getInvoiceStatus`. The list row must say the
 * same thing.
 *
 * Red if the list treats 'credited' as paid again (the row reads "Paid"), or if
 * a write-off covering a partial payment is relabelled "Outstanding" although
 * nothing is left to pay.
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
import { screen } from '@testing-library/react';
import ClientBillingPage from '@/app/client/lawfirm/[lawFirmId]/billing/page';
import { getInvoiceStatus } from '@/components/billingComp/utils';
import type { Invoice } from '@/types';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';

let api: ApiMock;

function creditedInvoice(amountPaid: number, totalWrittenOff: number) {
  return {
    id: 'inv-credited',
    totalAmount: 500,
    amountPaid,
    totalWrittenOff,
    remainingBalance: 0,
    isPaid: false,
    status: 'credited',
    creditNotes: [{ id: 'cn-1', amount: totalWrittenOff, type: 'write_off' }],
    dueDate: '2026-09-30',
    payments: amountPaid > 0 ? [{ id: 'pmt-1', date: '2026-09-01', amount: amountPaid }] : [],
  };
}

function serve(invoice: ReturnType<typeof creditedInvoice>) {
  api.get('/billing', {
    invoices: [invoice],
    totalItems: 1,
    summary: { totalBilled: 500, totalPaid: invoice.amountPaid, totalOutstanding: 0 },
    statusCounts: { credited: 1 },
  });
}

/** The row's status column: the badges under the invoice name's row. */
async function rowStatusText() {
  const name = await screen.findByText('INV-CRED');
  const row = name.closest('.grid') as HTMLElement;
  return row.textContent || '';
}

beforeEach(() => {
  api = installApiMock();
  api.allowUnhandled();
});

afterEach(() => api.restore());

describe('portal billing list, written-off invoice', () => {
  it('badges a fully written-off invoice "Written Off", as the detail page does', async () => {
    const invoice = creditedInvoice(0, 500);
    serve(invoice);
    // The detail page renders exactly this label for the same payload.
    expect(getInvoiceStatus(invoice as unknown as Invoice).label).toBe('Written Off');

    renderWithProviders(<ClientBillingPage />);

    const text = await rowStatusText();
    expect(text).toContain('Written Off');
    expect(text).not.toMatch(/Paid/);
    expect(text).not.toMatch(/Outstanding/);
    expect(text).not.toMatch(/Adjusted/);
  });

  it('badges a write-off that settled a partial payment "Written Off", not "Outstanding"', async () => {
    const invoice = creditedInvoice(200, 300);
    serve(invoice);
    expect(getInvoiceStatus(invoice as unknown as Invoice).label).toBe('Written Off');

    renderWithProviders(<ClientBillingPage />);

    const text = await rowStatusText();
    expect(text).toContain('Written Off');
    expect(text).not.toMatch(/Outstanding/);
    expect(text).not.toMatch(/Paid/);
    // Closed: no "of $500.00 paid" progress line and no remaining balance.
    expect(text).not.toMatch(/remaining/);
  });
});
