/**
 * What the standalone client-invoice page asks the API for on load.
 *
 * The defect this pins: the page issued its own
 * `GET /lawfirms/:lawFirmId` for the firm record, although the firm layout it
 * renders inside has already resolved that firm and publishes it through
 * `LawFirmContext`. One redundant request per invoice open, holding one of the
 * API instance's twelve Postgres pool connections for nothing.
 * `InvoiceDetailView` (the sibling invoice surface) already reads the context
 * instead; this page now does the same.
 *
 * The absence assertion is only worth anything if the code that used to make
 * the request ran at all, so this also pins the Stripe status read that sits
 * immediately after it in the same `loadSupportData` call.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/hooks/useUsers', () => ({
  __esModule: true,
  useLawFirmUsers: () => ({ users: [], loading: false }),
}));

const useParamsMock = jest.fn();
const useSearchParamsMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/lawfirm/firm-a/client-invoice/inv-1',
  useParams: () => useParamsMock(),
  useSearchParams: () => useSearchParamsMock(),
}));

import { screen } from '@testing-library/react';

import ClientInvoiceDetailPage from '@/app/lawfirm/[lawFirmId]/client-invoice/[invoiceId]/page';
import { setupApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import type { Invoice } from '@/types';

const FIRM = 'firm-a';
const CLIENT = 'client-1';
const INVOICE = 'inv-1';
const API = 'http://localhost:5001/api';

/** The firm record's own endpoint. Nothing else on this page shares the path. */
const FIRM_RECORD_PATH = `/api/lawfirms/${FIRM}`;

const api = setupApiMock();

function invoice(): Invoice {
  return {
    id: INVOICE,
    invoiceName: 'March Retainer',
    invoiceNumber: 'INV-1001',
    invoiceDate: '2026-03-01',
    dueDate: null,
    clientId: CLIENT,
    clientName: 'Acme Co',
    status: 'unpaid',
    isPaid: false,
    totalAmount: 100,
    flatFeesAmount: 0,
    amountPaid: 0,
    totalWrittenOff: 0,
    remainingBalance: 100,
    payments: [],
    creditNotes: [],
    timeEntries: [{ id: 'te-1', description: 'Drafted motion', hours: 2, rate: 50, amount: 100 }],
    flatFees: [],
    expenses: [],
    auditLog: [],
    createdAt: '2026-03-01T00:00:00.000Z',
  } as unknown as Invoice;
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM, invoiceId: INVOICE });
  useSearchParamsMock.mockReturnValue(new URLSearchParams(`clientId=${CLIENT}`));
  // Deliberately no handler for FIRM_RECORD_PATH: a request for it would be
  // recorded as unhandled and fail this spec at `restore()` even if the
  // assertion below were somehow missed.
  api.getExact(`${API}/lawfirms/${FIRM}/billing/invoices/client/${CLIENT}`, { invoices: [invoice()] });
  api.getExact(`${API}/stripe/connect/${FIRM}/status`, { connected: false, chargesEnabled: false });
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('the client-invoice page and the firm record', () => {
  it('loads its support data without asking the API for a firm the layout already holds', async () => {
    renderWithProviders(<ClientInvoiceDetailPage />);

    expect(await screen.findByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();

    // Proves the support-data load actually ran: the Stripe check is the very
    // next request in the same function the firm fetch used to lead.
    expect(api.callsTo(`/stripe/connect/${FIRM}/status`)).toHaveLength(1);
    expect(api.calls().filter((call) => call.pathname === FIRM_RECORD_PATH)).toHaveLength(0);
  });
});
