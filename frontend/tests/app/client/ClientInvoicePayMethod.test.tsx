/**
 * Pay Now on a client portal invoice, when the firm passes a processing fee
 * on: the client sees what card and bank transfer each cost, picks one, and is
 * sent to the checkout minted for that method. Driven through the real page
 * and the real service, with only the transport faked.
 *
 * Red if Pay Now goes straight to Stripe without the choice, or if the choice
 * does not reach the server as `method`.
 */
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@react-pdf/renderer', () => ({ __esModule: true, pdf: jest.fn(), StyleSheet: { create: (s: unknown) => s } }));
const mockUser = { uid: 'test-uid' };
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('next/navigation', () => ({ useParams: () => ({ lawFirmId: 'firm-a', invoiceId: 'invoice-a' }) }));
jest.mock('@/contexts/NavigationContext', () => ({ useNavigation: () => ({ navigate: jest.fn() }) }));
const mockFirms = [{ id: 'firm-a', name: 'Firm A' }];
jest.mock('@/contexts/ClientPortalContext', () => ({ useClientPortal: () => ({ lawFirms: mockFirms, associations: [], associationsLoading: false, activeAssociation: { clientRecordId: 'record-a' }, selectionRequired: false }) }));
import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InvoicePage from '@/app/client/lawfirm/[lawFirmId]/billing/[invoiceId]/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';

const api = setupApiMock();
const BASE = '/api/client-portal/lawfirm/firm-a';
// The page leaves for Stripe by assigning `window.location.href`. jsdom cannot
// load another origin, but it does follow a same-page hash, so each checkout
// url here is this page plus a hash naming where the client was sent.
let startUrl: string;

/** The checkout requests, as opposed to the quote, which shares the path prefix. */
const checkoutCalls = () => api.calls('GET').filter((call) => call.url.includes('/billing/pay/invoice-a')
  && !call.url.includes('/options'));

beforeEach(() => {
  startUrl = window.location.href.split('#')[0];
  api.getExact(`${BASE}/invoices/invoice-a?clientRecordId=record-a`, { invoice: {
    id: 'invoice-a', invoiceName: 'INV-101', status: 'outstanding', totalAmount: 380, amountPaid: 0, remainingBalance: 380,
    stripePaymentRequested: true, invoiceDate: '2026-10-01', payments: [],
  } });
});

afterEach(() => {
  window.history.replaceState(null, '', startUrl);
});

it('shows what each method costs and sends the client to the checkout for the one they pick', async () => {
  api.getExact(`${BASE}/billing/pay/invoice-a/options?clientRecordId=record-a`, {
    invoiceCents: 38_000,
    methods: [
      { method: 'card', feeCents: 1_532, totalCents: 39_532 },
      { method: 'bank', feeCents: 0, totalCents: 38_000 },
    ],
  });
  api.getExact(`${BASE}/billing/pay/invoice-a?method=card&clientRecordId=record-a`, { checkoutUrl: `${startUrl}#stripe-card` });
  const user = userEvent.setup();
  renderWithProviders(<InvoicePage />);

  await user.click(await screen.findByRole('button', { name: 'Pay Now' }));

  const dialog = await screen.findByRole('dialog', { name: 'How would you like to pay?' });
  // Nothing has been minted yet: the client is still choosing.
  expect(checkoutCalls()).toHaveLength(0);
  const card = within(dialog).getByRole('button', { name: /Card/ });
  expect(card).toHaveTextContent('+ $15.32 processing fee');
  expect(card).toHaveTextContent('You pay $395.32');

  await user.click(card);

  await waitFor(() => expect(window.location.hash).toBe('#stripe-card'));
  expect(checkoutCalls().map((call) => new URL(call.url, 'http://x').searchParams.get('method'))).toEqual(['card']);
});

it('shows a refused checkout on the page and closes the chooser', async () => {
  api.getExact(`${BASE}/billing/pay/invoice-a/options?clientRecordId=record-a`, {
    invoiceCents: 38_000,
    methods: [
      { method: 'card', feeCents: 0, totalCents: 38_000 },
      { method: 'bank', feeCents: 0, totalCents: 38_000 },
    ],
  });
  api.getExact(`${BASE}/billing/pay/invoice-a?method=bank&clientRecordId=record-a`, {
    status: 400, body: { error: 'Payment unavailable', details: { stripe: ['This firm has not finished connecting Stripe.'] } },
  });
  const user = userEvent.setup();
  renderWithProviders(<InvoicePage />);

  await user.click(await screen.findByRole('button', { name: 'Pay Now' }));
  const dialog = await screen.findByRole('dialog', { name: 'How would you like to pay?' });
  await user.click(within(dialog).getByRole('button', { name: /Bank transfer/ }));

  expect(await screen.findByRole('alert')).toHaveTextContent('This firm has not finished connecting Stripe.');
  expect(window.location.hash).toBe('');
  // The chooser closes so the page's error is what the client reads.
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'How would you like to pay?' })).not.toBeInTheDocument());
});
