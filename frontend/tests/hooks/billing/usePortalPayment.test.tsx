/**
 * Pay Now in the client portal. On an invoice whose card fee the client pays,
 * choosing card opens our card form instead of Stripe Checkout; otherwise both
 * methods still go to Checkout.
 *
 * Driven through the real client-portal service with only the transport faked.
 * Red if a card-form invoice is sent to Checkout, if the card form's calls lose
 * the invoice or the client record, if a paid card form leaves the client where
 * they were, or if the fee wording names the wrong firm.
 */
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import usePortalPayment from '@/hooks/billingHooks/usePortalPayment';
import { ClientPortalContext } from '@/contexts/ClientPortalContext';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

let api: ApiMock;
const onError = jest.fn();
const OPTIONS_PATH = '/client-portal/lawfirm/firm-1/billing/pay/inv-1/options';
const CARD_FORM = { flow: 'card_form', stripeAccountId: 'acct_card', creditFeeCents: 750, debitCards: 'absorb', internationalCards: 'absorb' };
const methods = [
  { method: 'card', feeCents: 0, totalCents: 25_000 },
  { method: 'bank', feeCents: 0, totalCents: 25_000 },
];

beforeEach(() => {
  api = installApiMock();
  __resetDuplicateRequestGuard();
  mockNavigate.mockReset();
  onError.mockReset();
});

afterEach(() => {
  api.restore();
});

function renderPayment() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <ClientPortalContext.Provider
      value={{
        lawFirms: [{ id: 'firm-1', name: 'Portal Law LLP' }, { id: 'firm-2', name: 'Other Firm' }],
        associations: [],
        associationsLoading: false,
        activeAssociation: null,
        selectionRequired: false,
        setActiveClientRecordId: () => {},
      }}
    >
      {children}
    </ClientPortalContext.Provider>
  );
  return renderHook(() => usePortalPayment({ lawFirmId: 'firm-1', clientRecordId: 'rec-3', onError }), { wrapper });
}

it('opens the card form for a card-form invoice instead of Checkout', async () => {
  api.get(OPTIONS_PATH, { invoiceCents: 25_000, methods, card: CARD_FORM });
  const { result } = renderPayment();

  await act(() => result.current.start('inv-1'));
  act(() => result.current.dialogProps.onChoose('card'));

  expect(result.current.dialogProps.cardForm.open).toBe(true);
  expect(api.callsTo('/billing/pay/inv-1')).toEqual([]);
});

it("binds the card form's calls to this invoice and client record", async () => {
  api.get(OPTIONS_PATH, { invoiceCents: 25_000, methods, card: CARD_FORM });
  api.post('/client-portal/lawfirm/firm-1/billing/pay/inv-1/card/confirm', { status: 'succeeded' });
  const { result } = renderPayment();
  await act(() => result.current.start('inv-1'));

  await expect(result.current.dialogProps.cardForm.api.confirm('ctoken_x', 25_750)).resolves.toEqual({ status: 'succeeded' });

  const [call] = api.calls('POST');
  expect(call.query).toEqual({ clientRecordId: ['rec-3'] });
  expect(call.body).toEqual({ confirmationTokenId: 'ctoken_x', expectedTotalCents: 25_750 });
});

it('takes a paid client to their billing page with the success notice', async () => {
  api.get(OPTIONS_PATH, { invoiceCents: 25_000, methods, card: CARD_FORM });
  const { result } = renderPayment();
  await act(() => result.current.start('inv-1'));
  act(() => result.current.dialogProps.onChoose('card'));

  act(() => result.current.dialogProps.cardForm.onPaid());

  expect(mockNavigate).toHaveBeenCalledWith('/client/lawfirm/firm-1/billing?payment=success');
  expect(result.current.dialogProps.open).toBe(false);
});

it('goes back to the method choice', async () => {
  api.get(OPTIONS_PATH, { invoiceCents: 25_000, methods, card: CARD_FORM });
  const { result } = renderPayment();
  await act(() => result.current.start('inv-1'));
  act(() => result.current.dialogProps.onChoose('card'));

  act(() => result.current.dialogProps.cardForm.onBack());

  expect(result.current.dialogProps.cardForm.open).toBe(false);
  expect(result.current.dialogProps.open).toBe(true);
});

it('sends a card to Checkout when the firm pays the card fee', async () => {
  api.get(OPTIONS_PATH, { invoiceCents: 25_000, methods, card: { flow: 'checkout' } });
  api.get('/client-portal/lawfirm/firm-1/billing/pay/inv-1', { checkoutUrl: `${window.location.href.split('#')[0]}#stripe-card` });
  const { result } = renderPayment();
  await act(() => result.current.start('inv-1'));

  act(() => { result.current.dialogProps.onChoose('card'); });

  await waitFor(() => expect(window.location.hash).toBe('#stripe-card'));
  expect(result.current.dialogProps.cardForm.open).toBe(false);
  expect(api.callsTo('/billing/pay/inv-1')[0].query).toEqual({ method: ['card'], clientRecordId: ['rec-3'] });
});

it('opens the next invoice on the method choice, not a card form left open', async () => {
  api.get(OPTIONS_PATH, { invoiceCents: 25_000, methods, card: CARD_FORM });
  api.get('/client-portal/lawfirm/firm-1/billing/pay/inv-2/options', { invoiceCents: 9_000, methods, card: CARD_FORM });
  const { result } = renderPayment();
  await act(() => result.current.start('inv-1'));
  act(() => result.current.dialogProps.onChoose('card'));

  await act(() => result.current.start('inv-2'));

  expect(result.current.dialogProps.cardForm.open).toBe(false);
  expect(result.current.dialogProps.options?.invoiceCents).toBe(9_000);
});
