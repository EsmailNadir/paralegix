/**
 * Offline contract coverage for the client Billing tab's unbilled flat fees.
 *
 * The defect this pins: the tab asked `GET /billing/flat-fees/matter/:matterId`
 * ONCE PER LINKED MATTER, unbounded. `listAllClientMatters` pages at 500, so a
 * corporate client with eighty matters fired eighty-one simultaneous requests
 * from one tab click, each holding one of the API instance's twelve shared
 * Postgres connections. `GET /billing/flat-fees/firm` ORs `clientId` with
 * `matterIds`, which is this tab's question exactly, so the request count no
 * longer tracks the size of the client.
 */
jest.unmock('@/services/billing.service');

import { act, renderHook, waitFor } from '@testing-library/react';

import useClientBillingFlatFees from '@/hooks/billingHooks/useClientBillingFlatFees';
import type { Matter } from '@/types/matter';
import type { Client } from '@/types';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';

const api = setupApiMock();

const CLIENT = { id: 'client-a', name: 'Acme Holdings' } as Client;

/** Twelve linked matters: twelve requests under the old fan-out, one under the new read. */
const TWELVE_MATTERS: Matter[] = Array.from({ length: 12 }, (_, i) => ({
  id: `matter-${i}`,
  name: `Matter ${i}`,
  clients: [{ id: 'mc-a', clientId: 'client-a', name: 'Acme Holdings' }],
}) as unknown as Matter);

const FIRM_FLAT_FEES = '/api/lawfirms/firm-a/billing/flat-fees/firm';

/** Stable identity: a fresh [] each render would re-run the load every render. */
const NO_MATTERS: Matter[] = [];

/** One fee on the client itself, plus one on each of two linked matters. */
function firmFlatFeeBody(overrides: Record<string, unknown> = {}) {
  return {
    flatFees: [
      {
        id: 'fee-direct',
        description: 'Retainer top-up',
        amount: 500,
        date: '2026-02-03',
        contextType: 'client',
        matterId: null,
        clientId: 'client-a',
        isBilled: false,
      },
      {
        id: 'fee-matter-0',
        description: 'Filing fee',
        amount: 125,
        date: '2026-02-02',
        contextType: 'matter',
        matterId: 'matter-0',
        clientId: null,
        isBilled: false,
      },
      {
        id: 'fee-matter-7',
        description: 'Court reporter',
        amount: 300,
        date: '2026-02-01',
        contextType: 'matter',
        matterId: 'matter-7',
        clientId: null,
        isBilled: false,
      },
    ],
    totalItems: 3,
    truncated: false,
    summary: { totalAmount: 925 },
    ...overrides,
  };
}

describe('useClientBillingFlatFees offline contract', () => {
  it('reads the client fees and every linked matter fee in ONE request, never one per matter', async () => {
    api.get('/billing/flat-fees/firm', firmFlatFeeBody());

    const { result } = renderHook(
      () => useClientBillingFlatFees({
        lawFirmId: 'firm-a',
        clientId: 'client-a',
        client: CLIENT,
        clientMatters: TWELVE_MATTERS,
      }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The whole point. The per-matter loop would make this thirteen, and every
    // one of those requests would be unmatched against this mock.
    expect(api.calls()).toHaveLength(1);
    expect(api.callsTo('/billing/flat-fees/matter/')).toHaveLength(0);
    expect(api.callsTo('/billing/flat-fees/client/')).toHaveLength(0);

    const [call] = api.calls();
    expect(call.pathname).toBe(FIRM_FLAT_FEES);
    expect(call.query.clientId).toEqual(['client-a']);
    expect(call.query.matterIds?.[0]?.split(',')).toEqual(TWELVE_MATTERS.map((m) => m.id));
    // Asking the server for unbilled fees only, rather than downloading a
    // long-running client's whole billed history to discard it.
    expect(call.query.billingStatus).toEqual(['unbilled']);
  });

  it('splits the one response into the same direct and linked rows the tab rendered before', async () => {
    api.get('/billing/flat-fees/firm', firmFlatFeeBody());

    const { result } = renderHook(
      () => useClientBillingFlatFees({
        lawFirmId: 'firm-a',
        clientId: 'client-a',
        client: CLIENT,
        clientMatters: TWELVE_MATTERS,
      }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.directFlatFees.map((fee) => [fee.id, fee._source])).toEqual([
      ['fee-direct', 'direct'],
    ]);
    expect(
      result.current.linkedMatterFlatFees.map((fee) => [fee.id, fee._source, fee._matterId, fee._matterName]),
    ).toEqual([
      ['fee-matter-0', 'matter', 'matter-0', 'Matter 0'],
      ['fee-matter-7', 'matter', 'matter-7', 'Matter 7'],
    ]);
    // The matter-side decoration the row renders: a sole client on the matter
    // bills to that client, so the row offers "Bill from Matter".
    expect(result.current.linkedMatterFlatFees[0]).toMatchObject({
      _isSharedMatter: false,
      _otherClientCount: 0,
      _recipientMode: 'single',
      _billingActionLabel: 'Bill from Matter',
    });
  });

  it('drops a fee whose matter is not one of this client\'s, so the tab cannot show another client\'s work', async () => {
    api.get('/billing/flat-fees/firm', {
      flatFees: [
        {
          id: 'fee-elsewhere',
          description: 'Someone else\'s matter',
          amount: 900,
          contextType: 'matter',
          matterId: 'matter-not-linked',
          clientId: null,
          isBilled: false,
        },
      ],
      totalItems: 1,
      truncated: false,
      summary: { totalAmount: 900 },
    });

    const { result } = renderHook(
      () => useClientBillingFlatFees({
        lawFirmId: 'firm-a',
        clientId: 'client-a',
        client: CLIENT,
        clientMatters: TWELVE_MATTERS,
      }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.linkedMatterFlatFees).toEqual([]);
    expect(result.current.directFlatFees).toEqual([]);
  });

  it('reports the shortfall when the page withheld fees, so the tab warns instead of presenting a page as the whole set', async () => {
    api.get('/billing/flat-fees/firm', firmFlatFeeBody({ totalItems: 412, truncated: true }));

    const { result } = renderHook(
      () => useClientBillingFlatFees({
        lawFirmId: 'firm-a',
        clientId: 'client-a',
        client: CLIENT,
        clientMatters: TWELVE_MATTERS,
      }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The tab renders <TruncatedListNotice mode="firmList"> off this flag. Rows
    // still render: a partial list plus the warning beats an empty one.
    expect(result.current.truncated).toBe(true);
    expect(result.current.linkedMatterFlatFees).toHaveLength(2);
  });

  it('leaves both lists empty and stops loading when the read fails', async () => {
    api.get('/billing/flat-fees/firm', { status: 403, body: { error: 'Forbidden' } });

    const { result } = renderHook(
      () => useClientBillingFlatFees({
        lawFirmId: 'firm-a',
        clientId: 'client-a',
        client: CLIENT,
        clientMatters: TWELVE_MATTERS,
      }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.directFlatFees).toEqual([]);
    expect(result.current.linkedMatterFlatFees).toEqual([]);
    expect(result.current.truncated).toBe(false);
  });

  // Red if: the failure is swallowed (`.catch(() => null)`), so the tab shows
  // "No direct client flat fees yet" for fees it never managed to read, and a
  // firm decides there is nothing left to bill.
  it('reports the read failure instead of passing it off as an empty list', async () => {
    api.get('/billing/flat-fees/firm', {
      status: 500, body: { error: 'Flat fee ledger unavailable', code: 'LEDGER_DOWN' },
    });

    const { result } = renderHook(
      () => useClientBillingFlatFees({
        lawFirmId: 'firm-a',
        clientId: 'client-a',
        client: CLIENT,
        clientMatters: TWELVE_MATTERS,
      }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Flat fee ledger unavailable');
  });

  it('clears the reported failure once a reload succeeds', async () => {
    let attempt = 0;
    api.get('/billing/flat-fees/firm', () => {
      attempt += 1;
      return attempt === 1
        ? { status: 403, body: { error: 'You cannot read these fees' } }
        : firmFlatFeeBody();
    });

    const { result } = renderHook(
      () => useClientBillingFlatFees({
        lawFirmId: 'firm-a',
        clientId: 'client-a',
        client: CLIENT,
        clientMatters: TWELVE_MATTERS,
      }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.error).toBe('You cannot read these fees'));
    await act(async () => { await result.current.reload(); });

    expect(attempt).toBe(2);
    expect(result.current.error).toBeNull();
    expect(result.current.directFlatFees.map((fee) => fee.id)).toEqual(['fee-direct']);
  });

  it('still asks once for a client with no matters, and never sends an empty matter filter', async () => {
    api.get('/billing/flat-fees/firm', {
      flatFees: [
        {
          id: 'fee-direct',
          description: 'Retainer top-up',
          amount: 500,
          contextType: 'client',
          matterId: null,
          clientId: 'client-a',
          isBilled: false,
        },
      ],
      totalItems: 1,
      truncated: false,
      summary: { totalAmount: 500 },
    });

    const { result } = renderHook(
      () => useClientBillingFlatFees({
        lawFirmId: 'firm-a',
        clientId: 'client-a',
        client: CLIENT,
        clientMatters: NO_MATTERS,
      }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(api.calls()).toHaveLength(1);
    // An empty `matterIds` means "these named matters", and the server answers
    // it with nothing. Omit the key instead, or the client's own fees vanish.
    expect(api.calls()[0].query.matterIds).toBeUndefined();
    expect(result.current.directFlatFees.map((fee) => fee.id)).toEqual(['fee-direct']);
  });
});
