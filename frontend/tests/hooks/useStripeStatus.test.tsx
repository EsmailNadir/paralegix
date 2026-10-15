/**
 * `useStripeStatus`: the firm's Stripe readiness as one status every billing
 * surface renders from.
 *
 * Driven through the real billing service with only the transport faked.
 * RED IF: a failed status read looks like "not connected" or like "still
 * loading"; an account that cannot take charges reads as ready; "Try again"
 * does not ask Stripe again; or a second surface for the same firm fetches
 * the status again instead of reading the cached answer.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';

import { useStripeStatus } from '@/hooks/billingHooks/useStripeStatus';
import { installApiMock, sequence, type ApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { createQueryWrapper } from '../support/queryWrapper';
import { makeTestQueryClient } from '../support/renderWithProviders';

const FIRM = 'firm-a';
const STATUS_URL = `http://localhost:5001/api/stripe/connect/${FIRM}/status`;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

function renderStatus(wrapper = createQueryWrapper()) {
  return renderHook(() => useStripeStatus(FIRM), { wrapper });
}

it('is loading until the status read answers, then ready for an account that can take charges', async () => {
  const held = holdResponse();
  api.getExact(STATUS_URL, held.handler);
  const { result } = renderStatus();

  await held.untilRequested();
  expect(result.current.status).toBe('loading');

  await act(async () => held.release({ connected: true, chargesEnabled: true, onboardingComplete: true, directCharges: true }));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(result.current.directCharges).toBe(true);
});

it('reads an account that cannot take charges yet as needing setup', async () => {
  api.getExact(STATUS_URL, { connected: true, chargesEnabled: false, onboardingComplete: false });
  const { result } = renderStatus();

  await waitFor(() => expect(result.current.status).toBe('needs_setup'));
});

it('reads a firm with no Stripe account as not connected', async () => {
  api.getExact(STATUS_URL, { connected: false, chargesEnabled: false, onboardingComplete: false });
  const { result } = renderStatus();

  await waitFor(() => expect(result.current.status).toBe('not_connected'));
});

it('reports a failed read as an error, and Try again asks Stripe again', async () => {
  const retryHeld = holdResponse();
  api.getExact(STATUS_URL, sequence(
    { status: 500, body: { error: 'Stripe unavailable' } },
    retryHeld.handler,
  ));
  const { result } = renderStatus();

  await waitFor(() => expect(result.current.status).toBe('error'));
  expect(api.callsTo(`/stripe/connect/${FIRM}/status`)).toHaveLength(1);

  act(() => result.current.retry());
  await retryHeld.untilRequested();
  // The second attempt is in flight: a retry is a wait, not a standing failure.
  expect(result.current.status).toBe('loading');

  await act(async () => retryHeld.release({ connected: true, chargesEnabled: true }));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(api.callsTo(`/stripe/connect/${FIRM}/status`)).toHaveLength(2);
});

it('answers a second surface for the same firm from the cache', async () => {
  api.getExact(STATUS_URL, { connected: true, chargesEnabled: true });
  // One client for both, as the app shares one across pages; the test client
  // would otherwise drop the entry the moment the first hook unmounts.
  const client = makeTestQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, gcTime: 60_000 } });
  const wrapper = createQueryWrapper(client);

  const first = renderStatus(wrapper);
  await waitFor(() => expect(first.result.current.status).toBe('ready'));
  first.unmount();

  const second = renderStatus(wrapper);
  expect(second.result.current.status).toBe('ready');
  expect(api.callsTo(`/stripe/connect/${FIRM}/status`)).toHaveLength(1);
});
