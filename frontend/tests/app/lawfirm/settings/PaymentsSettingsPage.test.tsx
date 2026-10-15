/**
 * The firm's Payments settings tab (Stripe Connect for the firm's OPERATING
 * account, distinct from `TrustConnectSettings.tsx`, which connects a trust
 * bank account). Both now run the same lifecycle through `useStripeConnect`.
 *
 * PERMISSION GATING. `settings/layout.tsx` gates the whole Settings area on
 * `settings.viewFirm`, which is a baseline permission every firm member
 * holds, so every member can reach this tab. But
 * `backend/src/modules/stripe/stripe.routes.ts` requires `settings.manageFirm`
 * (firm administration) for connecting, viewing the Stripe dashboard link, and
 * disconnecting; only the read-only `status` route accepts the lower
 * `billing.viewInvoices`. Before this fix, the page never checked
 * `settings.manageFirm` at all, so any member reaching Settings could see and
 * click Connect/Complete Onboarding/View Dashboard/Disconnect, all of which
 * the backend would 403.
 *
 * These cases run against the TRANSPORT, not a stubbed service. `tests/setup.ts`
 * resolves every service call to `{}`, which reads as "not connected" no matter
 * what the endpoint says, so the connected cases below could not fail under it.
 */
const mockUpdateFirmSettings = jest.fn();

jest.mock('@/services/settings.service', () =>
  require('../../../support/mockServiceModule').mockServiceModule({
    updateFirmSettings: (...args: unknown[]) => mockUpdateFirmSettings(...args),
  }),
);
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

const useParamsMock = jest.fn();
const useSearchParamsMock = jest.fn();
jest.mock('next/navigation', () => ({
  useParams: () => useParamsMock(),
  useSearchParams: () => useSearchParamsMock(),
}));

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PaymentsSettingsPage from '@/app/lawfirm/[lawFirmId]/settings/payments/page';
import { setupApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, grantPermissions, resetPermissions } from '../../../support/permissions';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';

const LAW_FIRM_ID = 'firm-1';
const STATUS_URL = `/api/stripe/connect/${LAW_FIRM_ID}/status`;
const CARD_FEES_URL = `/api/lawfirms/${LAW_FIRM_ID}/billing/card-fees`;

const api = setupApiMock();

function connectStatus(overrides: Record<string, unknown> = {}) {
  return {
    connected: false,
    stripeAccountId: null,
    chargesEnabled: false,
    payoutsEnabled: false,
    onboardingComplete: false,
    ...overrides,
  };
}

const CONNECTED = connectStatus({
  connected: true,
  stripeAccountId: 'acct_123',
  chargesEnabled: true,
  payoutsEnabled: true,
  onboardingComplete: true,
});

function cardFeeState(reasons: string[] = ['not_confirmed']) {
  return {
    clientPays: false,
    debitCards: 'absorb',
    internationalCards: 'absorb',
    ratePercent: 2.9,
    fixedCents: 30,
    confirmation: null,
    eligibility: { eligible: false, reasons, state: 'TX', capPercent: 3, availableFrom: null },
  };
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: LAW_FIRM_ID });
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
  // The Online Payment Fees section reads the card fee setting on every render of the page.
  api.getExact(CARD_FEES_URL, cardFeeState());
  mockUpdateFirmSettings.mockReset();
  mockUpdateFirmSettings.mockResolvedValue({ message: 'ok' });
});

afterEach(() => {
  resetPermissions();
});

describe('permission gating', () => {
  it('hides Connect Stripe Account for a member without settings.manageFirm', async () => {
    api.getExact(STATUS_URL, connectStatus());
    grantPermissions(['settings.viewFirm', 'billing.viewInvoices']);
    renderWithProviders(<PaymentsSettingsPage />);

    await waitFor(() => expect(screen.getByText('Not connected')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Connect Stripe Account/ })).not.toBeInTheDocument();
  });

  it('shows Connect Stripe Account for a member with settings.manageFirm', async () => {
    api.getExact(STATUS_URL, connectStatus());
    grantPermissions(['settings.viewFirm', 'billing.viewInvoices', 'settings.manageFirm']);
    renderWithProviders(<PaymentsSettingsPage />);

    await waitFor(() => expect(screen.getByText('Not connected')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Connect Stripe Account/ })).toBeInTheDocument();
  });

  it('hides View Stripe Dashboard and Disconnect for a member without settings.manageFirm, once connected', async () => {
    api.getExact(STATUS_URL, CONNECTED);
    grantPermissions(['settings.viewFirm', 'billing.viewInvoices']);
    renderWithProviders(<PaymentsSettingsPage />);

    await waitFor(() => expect(screen.getByText('Connected & Active')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /View Stripe Dashboard/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
  });
});

describe('a member without billing.viewInvoices', () => {
  it('explains the tab instead of firing the reads the backend refuses', async () => {
    // The built-in Staff role: the settings baseline and no billing grant. Both
    // the Stripe status and the card fee reads require billing.viewInvoices.
    grantBaselineMember();
    api.allowUnhandled();
    renderWithProviders(<PaymentsSettingsPage />);

    expect(await screen.findByText(/need billing access to view payment settings/)).toBeInTheDocument();
    expect(api.calls()).toHaveLength(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('the status the page reads', () => {
  it('asks the firm connect status endpoint for THIS firm', async () => {
    api.getExact(STATUS_URL, connectStatus());
    grantPermissions(['settings.viewFirm', 'billing.viewInvoices']);
    renderWithProviders(<PaymentsSettingsPage />);

    await waitFor(() => expect(api.calls().length).toBeGreaterThan(0));
    // The firm's operating account, not a trust one: /stripe/connect against
    // /stripe/trust-connect is the difference between the firm's own payouts
    // and a client's IOLTA money.
    const [call] = api.calls();
    expect(call.pathname).toBe(STATUS_URL);
  });

  it('reports charges and payouts separately once connected', async () => {
    api.getExact(STATUS_URL, connectStatus({
      connected: true, stripeAccountId: 'acct_123', chargesEnabled: true, payoutsEnabled: false, onboardingComplete: true,
    }));
    grantPermissions(['settings.viewFirm', 'billing.viewInvoices']);
    renderWithProviders(<PaymentsSettingsPage />);

    await waitFor(() => expect(screen.getByText('Charges')).toBeInTheDocument());
    // Stripe enables the two independently. A firm can take a client's card and
    // still have no way to be paid out, and collapsing them into one "connected"
    // state hides exactly that.
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('Not Ready')).toBeInTheDocument();
  });

  it('surfaces a refused status read instead of showing "not connected"', async () => {
    api.getExact(STATUS_URL, { status: 403, body: { error: 'Forbidden' } });
    grantPermissions(['settings.viewFirm', 'billing.viewInvoices']);
    renderWithProviders(<PaymentsSettingsPage />);

    // A failed read rendered as "Not connected" would invite a firm that IS
    // connected to onboard a second account.
    await waitFor(() => expect(screen.getByText(/Forbidden/i)).toBeInTheDocument());
  });
});

describe('disconnecting', () => {
  async function openTheConfirmation() {
    grantPermissions(['settings.viewFirm', 'billing.viewInvoices', 'settings.manageFirm']);
    renderWithProviders(<PaymentsSettingsPage />);
    await waitFor(() => expect(screen.getByText('Connected & Active')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Disconnect$/ }));
    return screen.findByRole('dialog');
  }

  it('calls DELETE on the firm connect endpoint', async () => {
    api.getExact(STATUS_URL, CONNECTED);
    api.delete(`/stripe/connect/${LAW_FIRM_ID}`, { disconnected: true });

    const dialog = await openTheConfirmation();
    await userEvent.click(within(dialog).getByRole('button', { name: /Disconnect/ }));

    await waitFor(() => expect(
      api.calls().filter((c) => c.method === 'DELETE').length,
    ).toBe(1));
  });

  it('keeps the confirmation open, with the reason on it, when the disconnect fails', async () => {
    api.getExact(STATUS_URL, CONNECTED);
    api.delete(`/stripe/connect/${LAW_FIRM_ID}`, { status: 409, body: { error: 'Outstanding payouts' } });

    const dialog = await openTheConfirmation();
    await userEvent.click(within(dialog).getByRole('button', { name: /Disconnect/ }));

    // A dialog that closed itself here would read as a completed disconnect,
    // while the account is still connected and still taking payments.
    await waitFor(() => expect(screen.getByText(/Outstanding payouts/i)).toBeInTheDocument());
    // Past the modal's 100ms exit transition. Asserting immediately would pass
    // on a dialog that HAS been told to close and is still animating out.
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes the confirmation when the disconnect succeeds', async () => {
    api.getExact(STATUS_URL, CONNECTED);
    api.delete(`/stripe/connect/${LAW_FIRM_ID}`, { disconnected: true });

    const dialog = await openTheConfirmation();
    await userEvent.click(within(dialog).getByRole('button', { name: /Disconnect/ }));

    // The other half of the pair: without it, a page that never closed the
    // dialog at all would satisfy the failure case above.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('How it works', () => {
  it('says how the client pays, and that debit cards never carry a card fee', async () => {
    api.getExact(STATUS_URL, connectStatus());
    renderWithProviders(<PaymentsSettingsPage />);

    expect(await screen.findByText(
      'The client gets a secure link and pays by card or bank transfer. If you pass on card fees, credit card payments include the fee and debit cards never do.',
    )).toBeInTheDocument();
    expect(screen.queryByText(/Pay Now/)).not.toBeInTheDocument();
  });
});

describe('Online Payment Fees', () => {
  const bankSwitch = () => screen.getByRole('switch', { name: 'Clients pay the bank transfer fee' });

  function renderWithFirmSettings(initialSettings: Record<string, unknown> = {}) {
    return renderWithProviders(
      <FirmSettingsProvider lawFirmId={LAW_FIRM_ID} initialSettings={initialSettings}>
        <PaymentsSettingsPage />
      </FirmSettingsProvider>,
    );
  }

  it('sits below the Stripe account, with its intro, the card fee setting and an off bank switch', async () => {
    api.getExact(STATUS_URL, CONNECTED);
    renderWithFirmSettings();

    const heading = await screen.findByRole('heading', { name: 'Online Payment Fees' });
    const stripe = screen.getByRole('heading', { name: 'Stripe Account' });
    expect(stripe.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Your firm pays online processing fees unless you pass them on.')).toBeVisible();
    expect(await screen.findByText('Clients pay a fee on credit cards')).toBeVisible();
    expect(bankSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('0.8% (max $5) plus 0.9%. You receive the full amount.')).toBeVisible();
    expect(screen.queryByText('Only firm admins can change this setting.')).not.toBeInTheDocument();
  });

  it('points up to the Stripe connection rather than linking away', async () => {
    api.getExact(STATUS_URL, connectStatus());
    api.getExact(CARD_FEES_URL, cardFeeState(['stripe_not_connected', 'not_confirmed']));
    renderWithFirmSettings();

    expect(await screen.findByText('Connect Stripe above first.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Connect Stripe/ })).not.toBeInTheDocument();
  });

  it('passes the bank transfer fee on by itself, through the firm settings', async () => {
    api.getExact(STATUS_URL, CONNECTED);
    renderWithFirmSettings();

    await userEvent.click(await screen.findByRole('switch', { name: 'Clients pay the bank transfer fee' }));

    await waitFor(() => expect(mockUpdateFirmSettings).toHaveBeenCalledTimes(1));
    const [firmId, partial] = mockUpdateFirmSettings.mock.calls[0];
    expect(firmId).toBe(LAW_FIRM_ID);
    expect(partial.billing.processingFees).toEqual({ card: 'firm', bank: 'client' });
  });

  it('turns the bank fee back to the firm and leaves the card fee as it is', async () => {
    api.getExact(STATUS_URL, CONNECTED);
    renderWithFirmSettings({ billing: { processingFees: { card: 'client', bank: 'client' } } });

    expect(await screen.findByRole('switch', { name: 'Clients pay the bank transfer fee' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(bankSwitch());

    await waitFor(() => expect(mockUpdateFirmSettings).toHaveBeenCalledTimes(1));
    expect(mockUpdateFirmSettings.mock.calls[0][1].billing.processingFees).toEqual({ card: 'client', bank: 'firm' });
  });

  it('is read-only, with a note, for a member who cannot manage firm settings', async () => {
    api.getExact(STATUS_URL, CONNECTED);
    grantBaselineMember(['billing.viewInvoices']);
    renderWithFirmSettings();

    expect(await screen.findByRole('switch', { name: 'Clients pay the bank transfer fee' })).toBeDisabled();
    expect(screen.getByText('Only firm admins can change this setting.')).toBeVisible();
    await userEvent.click(bankSwitch());
    expect(mockUpdateFirmSettings).not.toHaveBeenCalled();
    // The card fee form is read-only too: no Save for a member who cannot save.
    await screen.findByText('Clients pay a fee on credit cards');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
