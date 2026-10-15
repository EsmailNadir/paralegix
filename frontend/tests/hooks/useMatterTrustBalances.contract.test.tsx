/**
 * Offline contract coverage for the matter billing tab's trust callout.
 *
 * The defect this pins: the matter page used to fan out one
 * `GET /trust/clients/:clientId/balance` per client on the matter, so a matter
 * with eight clients fired eight simultaneous requests from one tab click, each
 * holding one of the API instance's twelve Postgres pool connections. The
 * firm-wide `GET /trust/balances` report already carries per-client balances, so
 * the whole callout is one request regardless of how many clients a matter has.
 */
jest.unmock('@/services/trust.service');

import { renderHook, waitFor } from '@testing-library/react';

import useMatterTrustBalances from '@/hooks/trustHooks/useMatterTrustBalances';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';

const api = setupApiMock();

/** Eight clients: the size the per-client fan-out was worst at. */
const EIGHT_CLIENTS = Array.from({ length: 8 }, (_, i) => ({
  id: `client-${i}`,
  name: `Client ${i}`,
}));

describe('useMatterTrustBalances offline contract', () => {
  it('reads every client balance from ONE firm-wide report, never one request per client', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/balances', {
      balances: EIGHT_CLIENTS.map((client, i) => ({
        clientId: client.id,
        clientName: `Ledger name ${i}`,
        trustAccountId: 'account-a',
        balanceCents: 1000 + i,
      })),
    });

    const { result } = renderHook(
      () => useMatterTrustBalances('firm-a', EIGHT_CLIENTS, true),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.balances).toHaveLength(8));

    // The whole point. A per-client map would make this eight, and would also
    // make every one of those requests unhandled against this mock.
    expect(api.calls()).toEqual([
      expect.objectContaining({ pathname: '/api/lawfirms/firm-a/trust/balances', method: 'GET' }),
    ]);
    expect(api.callsTo('/trust/clients/')).toHaveLength(0);
  });

  it('totals a client across accounts, keeps matter order and the matter-side name, and drops a client with no trust money', async () => {
    const clients = [
      { id: 'client-multi', name: 'Multi Account Co' },
      { id: 'client-none', name: 'No Trust Co' },
      { id: 'client-zero', name: 'Zeroed Out Co' },
      { id: 'client-email', name: '', email: 'billing@example.com' },
      { id: 'client-anon', name: '' },
    ];

    api.getExact('/api/lawfirms/firm-a/trust/balances', {
      balances: [
        // Another matter's client. Must not reach this matter's callout.
        { clientId: 'client-elsewhere', clientName: 'Other Matter Co', trustAccountId: 'account-a', balanceCents: 999999 },
        { clientId: 'client-multi', clientName: 'Ledger Name', trustAccountId: 'account-a', balanceCents: 125050 },
        { clientId: 'client-multi', clientName: 'Ledger Name', trustAccountId: 'account-b', balanceCents: 74950 },
        // Nets to zero across two accounts: real rows, no money to apply.
        { clientId: 'client-zero', clientName: 'Zeroed Out Co', trustAccountId: 'account-a', balanceCents: 5000 },
        { clientId: 'client-zero', clientName: 'Zeroed Out Co', trustAccountId: 'account-b', balanceCents: -5000 },
        { clientId: 'client-email', clientName: 'Ledger Name', trustAccountId: 'account-a', balanceCents: 2500 },
        { clientId: 'client-anon', clientName: 'Ledger Name', trustAccountId: 'account-a', balanceCents: 100 },
      ],
    });

    const { result } = renderHook(
      () => useMatterTrustBalances('firm-a', clients, true),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.balances.length).toBeGreaterThan(0));

    expect(result.current.balances).toEqual([
      // Summed across both accounts, in integer cents.
      { clientId: 'client-multi', clientName: 'Multi Account Co', totalBalanceCents: 200000 },
      // `client-none` (absent from the report) and `client-zero` (nets to zero)
      // are both gone, and matter order is otherwise preserved.
      { clientId: 'client-email', clientName: 'billing@example.com', totalBalanceCents: 2500 },
      { clientId: 'client-anon', clientName: 'Client', totalBalanceCents: 100 },
    ]);
  });

  it('asks for nothing while the billing tab is closed or the plan lacks trust accounting', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useMatterTrustBalances('firm-a', EIGHT_CLIENTS, enabled),
      { initialProps: { enabled: false }, wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.balances).toEqual([]));
    expect(api.calls()).toHaveLength(0);

    api.getExact('/api/lawfirms/firm-a/trust/balances', {
      balances: [{ clientId: 'client-0', clientName: 'Ledger Name', trustAccountId: 'account-a', balanceCents: 4200 }],
    });
    rerender({ enabled: true });

    await waitFor(() => expect(result.current.balances).toEqual([
      { clientId: 'client-0', clientName: 'Client 0', totalBalanceCents: 4200 },
    ]));
    expect(api.calls()).toHaveLength(1);
  });

  it('stays silent when the report fails, so a trust outage cannot break the billing tab', async () => {
    api.getExact('/api/lawfirms/firm-a/trust/balances', {
      status: 403,
      body: { error: 'Forbidden' },
    });

    const { result } = renderHook(
      () => useMatterTrustBalances('firm-a', EIGHT_CLIENTS, true),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(api.calls()).toHaveLength(1));
    expect(result.current.balances).toEqual([]);
  });

  it('requests nothing before the matter has clients', async () => {
    const { result } = renderHook(
      () => useMatterTrustBalances('firm-a', [], true),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.balances).toEqual([]));
    expect(api.calls()).toHaveLength(0);
  });
});
