/**
 * Connecting a trust bank account to Stripe, one row per trust account.
 *
 * This is the OTHER caller of `useStripeConnect`. The firm's Payments settings
 * tab runs the same four calls against the firm's operating account, where the
 * firm's own fee income settles. Here the money is a client's: a deposit funds
 * an IOLTA, and the account it settles into is the one this row onboarded.
 *
 * So the case that matters most is the least visual one: this row must address
 * the TRUST endpoint for the trust account it is rendering. A row that reached
 * `/stripe/connect` instead would onboard, and later disconnect, the firm's
 * operating account while claiming to be managing a trust bank, and every
 * screen would still look right.
 *
 * Run against the transport, not a stubbed service: `tests/setup.ts` resolves
 * every service call to `{}`, which reads as "not connected" whatever the
 * endpoint says.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TrustConnectSettings from '@/components/trustComp/TrustConnectSettings';
import type { TrustAccount } from '@/types/trust';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantPermissions, resetPermissions } from '../../support/permissions';

const LAW_FIRM_ID = 'firm-1';
const ACCOUNT_ID = 'trust-acct-1';
const STATUS_URL = `/api/stripe/trust-connect/${LAW_FIRM_ID}/${ACCOUNT_ID}/status`;

let api: ApiMock;

const account = {
  id: ACCOUNT_ID,
  name: 'Client Trust (IOLTA)',
  bankName: 'First National',
  accountNumberLast4: '4321',
  status: 'active',
} as unknown as TrustAccount;

function connectStatus(overrides: Record<string, unknown> = {}) {
  return {
    connected: false,
    chargesEnabled: false,
    payoutsEnabled: false,
    onboardingComplete: false,
    ...overrides,
  };
}

const CONNECTED = connectStatus({ connected: true, chargesEnabled: true, onboardingComplete: true });

function render(accounts: TrustAccount[] = [account]) {
  return renderWithProviders(
    <TrustConnectSettings lawFirmId={LAW_FIRM_ID} accounts={accounts} />,
  );
}

beforeEach(() => {
  api = installApiMock();
  grantPermissions(['trust.view', 'trust.manage']);
});

afterEach(() => {
  resetPermissions();
  api.restore();
});

describe('which account the row manages', () => {
  it('reads the status of the TRUST account, not the firm operating account', async () => {
    api.getExact(STATUS_URL, connectStatus());

    render();

    await waitFor(() => expect(api.calls().length).toBeGreaterThan(0));
    const [call] = api.calls();
    // The whole safety of this row: /stripe/trust-connect and the trust account
    // id. /stripe/connect would silently manage the firm's own account instead.
    expect(call.pathname).toBe(STATUS_URL);
  });

  it('asks for each trust account separately', async () => {
    const second = { ...account, id: 'trust-acct-2', name: 'Second IOLTA' } as TrustAccount;
    api.getExact(STATUS_URL, connectStatus());
    api.getExact(`/api/stripe/trust-connect/${LAW_FIRM_ID}/trust-acct-2/status`, CONNECTED);

    render([account, second]);

    // One connected account must not make the other look connected: a firm
    // would then believe a bank it never onboarded can take client deposits.
    await waitFor(() => expect(api.calls().length).toBe(2));
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(await screen.findByText('Active')).toBeInTheDocument();
  });

  it('leaves out an inactive trust account', async () => {
    const inactive = { ...account, id: 'trust-acct-3', name: 'Retired IOLTA', status: 'inactive' } as TrustAccount;

    render([inactive]);

    // No request at all: onboarding a bank the firm has retired would invite
    // client money into an account nothing reconciles.
    await screen.findByText(/No active trust accounts/i);
    expect(api.calls()).toHaveLength(0);
  });
});

describe('permission gating', () => {
  it('shows no action to a member who cannot manage trust', async () => {
    resetPermissions();
    grantPermissions(['trust.view']);
    api.getExact(STATUS_URL, connectStatus());

    render();

    await waitFor(() => expect(screen.getByText('Not connected')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
  });
});

describe('disconnecting a trust bank', () => {
  async function openTheConfirmation() {
    api.getExact(STATUS_URL, CONNECTED);
    render();
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^Disconnect$/ }));
    return screen.findByRole('dialog');
  }

  it('deletes the TRUST connected account', async () => {
    api.delete(`/stripe/trust-connect/${LAW_FIRM_ID}/${ACCOUNT_ID}`, { disconnected: true });

    const dialog = await openTheConfirmation();
    await userEvent.click(within(dialog).getByRole('button', { name: /Disconnect/ }));

    await waitFor(() => {
      const [del] = api.calls().filter((c) => c.method === 'DELETE');
      expect(del?.pathname).toBe(`/api/stripe/trust-connect/${LAW_FIRM_ID}/${ACCOUNT_ID}`);
    });
  });

  it('keeps the confirmation open, with the reason on it, when the disconnect fails', async () => {
    api.delete(
      `/stripe/trust-connect/${LAW_FIRM_ID}/${ACCOUNT_ID}`,
      { status: 409, body: { error: 'Funds are still held here' } },
    );

    const dialog = await openTheConfirmation();
    await userEvent.click(within(dialog).getByRole('button', { name: /Disconnect/ }));

    await waitFor(() => expect(screen.getByText(/Funds are still held here/i)).toBeInTheDocument());
    // Past the modal's 100ms exit transition, so a dialog already told to close
    // is gone rather than still animating out.
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes the confirmation when the disconnect succeeds', async () => {
    api.delete(`/stripe/trust-connect/${LAW_FIRM_ID}/${ACCOUNT_ID}`, { disconnected: true });

    const dialog = await openTheConfirmation();
    await userEvent.click(within(dialog).getByRole('button', { name: /Disconnect/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
