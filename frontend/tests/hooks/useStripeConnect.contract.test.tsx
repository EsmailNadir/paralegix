/**
 * Offline contract for `useStripeConnect`, the onboarding lifecycle shared by
 * the firm's Payments settings and each trust account row.
 *
 * The two targets differ only in which connected account they address, and
 * that is exactly the part nothing on screen reveals: a trust row that reached
 * `/stripe/connect` would onboard (or disconnect) the firm's operating account
 * while looking right. So every action is checked against the exact endpoint
 * for each target, through the real `billing.service`.
 *
 * What has to break for these to go red: a target reaching the other kind's
 * endpoint, an action that stops clearing a previous error, `connecting`
 * re-enabling before the redirect, a disconnect that does not re-read the
 * status, or a failure reported as success.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useStripeConnect, type StripeConnectTarget } from '@/hooks/useStripeConnect';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { sequence, setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';

const api = setupApiMock();

// Re-reading the status straight after an action is the behaviour under test,
// and it trips the dev-only duplicate-GET warning, which would bury real output.
beforeEach(() => {
  process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off';
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN;
});

const FIRM: StripeConnectTarget = { kind: 'firm', lawFirmId: 'firm-a' };
const TRUST: StripeConnectTarget = { kind: 'trust', lawFirmId: 'firm-a', trustAccountId: 'trust-1' };

const BASE = {
  firm: '/api/stripe/connect/firm-a',
  trust: '/api/stripe/trust-connect/firm-a/trust-1',
} as const;

function status(overrides: Record<string, unknown> = {}) {
  return { connected: false, chargesEnabled: false, payoutsEnabled: false, onboardingComplete: false, ...overrides };
}

const CONNECTED = status({ connected: true, chargesEnabled: true, onboardingComplete: true, stripeAccountId: 'acct_1' });

afterEach(() => {
  // `connect` hands the browser a same-document url so jsdom can follow it.
  window.location.hash = '';
});

describe.each([
  { kind: 'firm' as const, target: FIRM, other: 'trust' as const },
  { kind: 'trust' as const, target: TRUST, other: 'firm' as const },
])('$kind target', ({ kind, target, other }) => {
  const base = BASE[kind];

  it('reads the status from its own endpoint and no other', async () => {
    api.getExact(`${base}/status`, CONNECTED);

    const { result } = renderHook(() => useStripeConnect(target));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toEqual(CONNECTED);
    expect(result.current.error).toBeNull();
    expect(api.calls().map((c) => c.pathname)).toEqual([`${base}/status`]);
    expect(api.calls().some((c) => c.pathname.startsWith(BASE[other]))).toBe(false);
  });

  it('starts onboarding at its own endpoint and sends the browser to the link it returns', async () => {
    api.getExact(`${base}/status`, status());
    api.postExact(`${base}/create-account`, { url: `http://localhost/#onboard-${kind}`, accountId: 'acct_new' });

    const { result } = renderHook(() => useStripeConnect(target));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.connect();
    });

    expect(window.location.hash).toBe(`#onboard-${kind}`);
    // Left true on purpose: the browser is leaving, and a re-enabled button
    // would invite a second onboarding link during the redirect.
    expect(result.current.connecting).toBe(true);
    expect(result.current.busy).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('re-enables connect and reports why when onboarding cannot start', async () => {
    api.getExact(`${base}/status`, status());
    api.postExact(`${base}/create-account`, { status: 409, body: { error: 'Account already being onboarded' } });

    const { result } = renderHook(() => useStripeConnect(target));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.error).toBe('Account already being onboarded');
    expect(result.current.connecting).toBe(false);
    expect(window.location.hash).toBe('');
  });

  it('opens its own Stripe dashboard in a new tab without a referrer', async () => {
    api.getExact(`${base}/status`, CONNECTED);
    api.getExact(`${base}/dashboard-link`, { url: `https://connect.stripe.test/${kind}` });
    const open = jest.spyOn(window, 'open').mockReturnValue(null);

    try {
      const { result } = renderHook(() => useStripeConnect(target));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.openDashboard();
      });

      expect(open).toHaveBeenCalledWith(`https://connect.stripe.test/${kind}`, '_blank', 'noopener,noreferrer');
      expect(result.current.openingDashboard).toBe(false);
      expect(result.current.error).toBeNull();
    } finally {
      open.mockRestore();
    }
  });

  it('reports a dashboard link failure and opens nothing', async () => {
    api.getExact(`${base}/status`, CONNECTED);
    api.getExact(`${base}/dashboard-link`, { status: 403, body: { error: 'Only owners can open Stripe' } });
    const open = jest.spyOn(window, 'open').mockReturnValue(null);

    try {
      const { result } = renderHook(() => useStripeConnect(target));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.openDashboard();
      });

      expect(open).not.toHaveBeenCalled();
      expect(result.current.error).toBe('Only owners can open Stripe');
      expect(result.current.openingDashboard).toBe(false);
    } finally {
      open.mockRestore();
    }
  });

  it('disconnects its own account, re-reads the status, and resolves true', async () => {
    api.getExact(`${base}/status`, sequence(CONNECTED, status()));
    api.deleteExact(base, { disconnected: true });

    const { result } = renderHook(() => useStripeConnect(target));
    await waitFor(() => expect(result.current.status?.connected).toBe(true));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.disconnect();
    });

    expect(outcome).toBe(true);
    expect(api.calls('DELETE').map((c) => c.pathname)).toEqual([base]);
    expect(result.current.status?.connected).toBe(false);
    expect(result.current.disconnecting).toBe(false);
    expect(api.callsTo('/status')).toHaveLength(2);
  });

  it('resolves false and keeps the status when the disconnect is refused', async () => {
    api.getExact(`${base}/status`, CONNECTED);
    api.deleteExact(base, { status: 409, body: { error: 'Payouts are still pending' } });

    const { result } = renderHook(() => useStripeConnect(target));
    await waitFor(() => expect(result.current.status?.connected).toBe(true));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.disconnect();
    });

    expect(outcome).toBe(false);
    expect(result.current.error).toBe('Payouts are still pending');
    expect(result.current.status?.connected).toBe(true);
    // A refused disconnect changed nothing, so there is nothing to re-read.
    expect(api.callsTo('/status')).toHaveLength(1);
  });
});

describe('status load', () => {
  it("shows the caller's own copy when the status cannot be read", async () => {
    // A 500 with no message of its own, so the hook's fallback is what shows.
    api.getExact(`${BASE.firm}/status`, { status: 500, body: {} });

    const { result } = renderHook(() =>
      useStripeConnect(FIRM, { loadErrorMessage: 'Failed to load payment settings' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Failed to load payment settings');
    expect(result.current.status).toBeNull();
  });

  it('re-reads the status when the refresh key changes, as on the way back from Stripe', async () => {
    api.getExact(`${BASE.firm}/status`, sequence(status(), CONNECTED));

    const { result, rerender } = renderHook(
      ({ refreshKey }: { refreshKey: string | null }) => useStripeConnect(FIRM, { refreshKey }),
      { initialProps: { refreshKey: null as string | null } },
    );
    await waitFor(() => expect(result.current.status?.connected).toBe(false));

    rerender({ refreshKey: 'return' });

    await waitFor(() => expect(result.current.status?.connected).toBe(true));
    expect(api.callsTo('/status')).toHaveLength(2);
  });

  it('does not re-read the status when only a fresh target object of the same account arrives', async () => {
    // Callers build `target` inline, so it is a new object every render. The
    // hook depends on its primitives; depending on the object would loop.
    api.getExact(`${BASE.trust}/status`, CONNECTED);

    const { result, rerender } = renderHook(
      ({ n }: { n: number }) => useStripeConnect({ kind: 'trust', lawFirmId: 'firm-a', trustAccountId: `trust-${n}` }),
      { initialProps: { n: 1 } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ n: 1 });
    rerender({ n: 1 });

    expect(api.callsTo('/status')).toHaveLength(1);
  });

  it('clears a previous action error when the status is re-read', async () => {
    api.getExact(`${BASE.firm}/status`, CONNECTED);
    api.getExact(`${BASE.firm}/dashboard-link`, { status: 403, body: { error: 'Only owners can open Stripe' } });

    const { result } = renderHook(() => useStripeConnect(FIRM));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.openDashboard();
    });
    expect(result.current.error).toBe('Only owners can open Stripe');

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
  });
});

describe('switching connected account', () => {
  const TRUST_2 = '/api/stripe/trust-connect/firm-a/trust-2/status';

  it('ignores a previous account failure without ending the current account loading state', async () => {
    const previous = holdResponse();
    const current = holdResponse();
    api.getExact(`${BASE.trust}/status`, previous.handler);
    api.getExact(TRUST_2, current.handler);

    const { result, rerender } = renderHook(
      ({ id }) => useStripeConnect({ kind: 'trust', lawFirmId: 'firm-a', trustAccountId: id }),
      { initialProps: { id: 'trust-1' } },
    );
    await previous.untilRequested();
    rerender({ id: 'trust-2' });
    await current.untilRequested();

    await act(async () => previous.release({ status: 403, body: { error: 'Previous account refused' } }));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.status).toBeNull();

    await act(async () => current.release(status({ stripeAccountId: 'acct_two' })));
    await waitFor(() => expect(result.current.status?.stripeAccountId).toBe('acct_two'));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  // Both current callers remount per account (a keyed row, a route page), so
  // this guards the hook's own contract rather than a visible screen today.
  it("does not let a late answer for the previous account replace the current account's status", async () => {
    const first = holdResponse();
    api.getExact(`${BASE.trust}/status`, first.handler);
    api.getExact(TRUST_2, status({ connected: false, stripeAccountId: 'acct_two' }));

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useStripeConnect({ kind: 'trust', lawFirmId: 'firm-a', trustAccountId: id }),
      { initialProps: { id: 'trust-1' } },
    );
    await first.untilRequested();

    rerender({ id: 'trust-2' });
    await waitFor(() => expect(result.current.status?.stripeAccountId).toBe('acct_two'));

    await act(async () => {
      first.release(CONNECTED);
    });

    expect(result.current.status?.stripeAccountId).toBe('acct_two');
  });
});

describe('the shared Stripe status the invoice pages read', () => {
  // The invoice pages cache the firm's status for a minute. Whatever the
  // Payments page learns (a disconnect, a finished onboarding) must replace that
  // cached answer, or an invoice keeps offering a payment request for an account
  // that is gone.
  function wrapperWith(client: QueryClient) {
    function QueryWrapper({ children }: { children: React.ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    return QueryWrapper;
  }

  it('writes a fresh firm status into the shared cache, including after a disconnect', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['stripeStatus', 'firm-a'], CONNECTED);
    api.getExact(`${BASE.firm}/status`, sequence(CONNECTED, status()));
    api.deleteExact(BASE.firm, { disconnected: true });

    const { result } = renderHook(() => useStripeConnect(FIRM), { wrapper: wrapperWith(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.disconnect(); });

    expect(client.getQueryData(['stripeStatus', 'firm-a'])).toEqual(status());
  });

  it("leaves the firm's cached status alone when a trust account is read", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['stripeStatus', 'firm-a'], CONNECTED);
    api.getExact(`${BASE.trust}/status`, status());

    const { result } = renderHook(() => useStripeConnect(TRUST), { wrapper: wrapperWith(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(client.getQueryData(['stripeStatus', 'firm-a'])).toEqual(CONNECTED);
  });
});
