/**
 * Offline contracts for the billing workbench overview.
 *
 * The existing `useBillingWorkbench.test.ts` drives a live backend and is
 * excluded from `npm run test:unit`, so nothing in ordinary CI covered this
 * hook.
 *
 * The header is the part worth pinning. The workbench sorts receivables into
 * overdue and due-soon buckets, and those roll over at the VIEWER's local
 * midnight, so the route requires `X-Timezone` and refuses without it. Nothing
 * on screen shows which timezone was used: an invoice in the wrong bucket looks
 * like an invoice, and a firm in Auckland would be told work is overdue that is
 * not, or the reverse.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';

import useBillingWorkbench from '@/hooks/billingHooks/useBillingWorkbench';
import { getUserTimeZone } from '@/lib/utils/timezone';

import { setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { createQueryWrapper } from '../support/queryWrapper';

const WORKBENCH_A = '/api/lawfirms/firm-a/billing/workbench';

const api = setupApiMock();

describe('scope and credentials', () => {
  it('sends nothing before a firm id exists', async () => {
    const { result } = renderHook(() => useBillingWorkbench(undefined), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.calls()).toEqual([]);
  });

  it('sends the viewer timezone and the credential, by exact value', async () => {
    api.getExact(WORKBENCH_A, { unbilledCents: 1000, attention: [] });

    const { result } = renderHook(() => useBillingWorkbench('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());

    const [call] = api.calls();
    // Asserted by value, not by presence. A header that is merely present but
    // carries the server's zone puts every invoice in the wrong bucket.
    //
    // Sensitivity, stated honestly: TWO layers set this header independently,
    // `authenticatedHeaders` in the service layer and `prepareApiFetchOptions`
    // in the transport, and either alone keeps it on the wire. So no
    // single-line mutation turns this red; disabling both does. It pins the
    // observable contract rather than one implementation of it.
    expect(call.headers['x-timezone']).toBe(getUserTimeZone());
    expect(call.headers.authorization).toBe('Bearer mock-token');
  });

  it('asks the firm it was given, not a path that merely ends in workbench', async () => {
    api.getExact(WORKBENCH_A, { attention: [] });

    const { result } = renderHook(() => useBillingWorkbench('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(api.calls()[0].pathname).toBe(WORKBENCH_A);
  });
});

describe('the attention list page window', () => {
  it('omits the page parameters entirely when the caller gives none', async () => {
    // Omitted rather than sent as a default. A request carrying `attentionPage=1`
    // is a different cache entry from one carrying nothing, so sending a default
    // would refetch the same page under a second url.
    api.getExact(WORKBENCH_A, { attention: [] });

    const { result } = renderHook(() => useBillingWorkbench('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(api.calls()[0].search).toBe('');
  });

  it('sends both page parameters when the caller pages the list', async () => {
    api.getExact(`${WORKBENCH_A}?attentionLimit=5&attentionPage=3`, { attention: [{ id: 'inv-3' }] });

    const { result } = renderHook(
      () => useBillingWorkbench('firm-a', { attentionPage: 3, attentionLimit: 5 }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(api.calls()[0].query).toEqual({ attentionLimit: ['5'], attentionPage: ['3'] });
  });

  it('keeps the previous page on screen while the next one loads', async () => {
    // Otherwise the whole overview, not just the attention list, drops to its
    // skeleton on every page change.
    api.getExact(`${WORKBENCH_A}?attentionPage=1`, { attention: [{ id: 'first' }] });
    api.getExact(`${WORKBENCH_A}?attentionPage=2`, { status: 200, body: { attention: [{ id: 'second' }] }, delayMs: 40 });

    const { result, rerender } = renderHook(
      ({ page }: { page: number }) => useBillingWorkbench('firm-a', { attentionPage: page }),
      { wrapper: createQueryWrapper(), initialProps: { page: 1 } },
    );

    await waitFor(() => expect(result.current.data?.attention).toEqual([{ id: 'first' }]));

    rerender({ page: 2 });

    expect(result.current.data?.attention).toEqual([{ id: 'first' }]);

    await waitFor(() => expect(result.current.data?.attention).toEqual([{ id: 'second' }]));
  });
});

describe('failure and scope changes', () => {
  it('surfaces a failure rather than an empty overview', async () => {
    // An empty workbench and a failed one look the same: no unbilled work, no
    // overdue invoices, nothing needing attention. That is the most reassuring
    // screen in the product and the most dangerous one to fake.
    api.getExact(WORKBENCH_A, { status: 500, body: { error: 'Workbench unavailable' } });

    const { result } = renderHook(() => useBillingWorkbench('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('does not show one firm the workbench of another', async () => {
    api.getExact(WORKBENCH_A, { attention: [{ id: 'firm-a-invoice' }] });
    api.getExact('/api/lawfirms/firm-b/billing/workbench', { attention: [{ id: 'firm-b-invoice' }] });

    const { result, rerender } = renderHook(
      ({ firm }: { firm: string }) => useBillingWorkbench(firm),
      { wrapper: createQueryWrapper(), initialProps: { firm: 'firm-a' } },
    );

    await waitFor(() => expect(result.current.data?.attention).toEqual([{ id: 'firm-a-invoice' }]));

    rerender({ firm: 'firm-b' });

    await waitFor(() => expect(result.current.data?.attention).toEqual([{ id: 'firm-b-invoice' }]));
  });

  it('does not show firm A workbench rows as firm B while firm B is still pending', async () => {
    // The test above resolves firm B instantly, so it never actually observes
    // the pending window and cannot catch a `keepPreviousData` leak. This one
    // holds firm B pending after firm A has fully resolved, the same shape
    // that caught the identical bug in `useTasks`/`useClientLedger`.
    api.getExact(WORKBENCH_A, { attention: [{ id: 'firm-a-invoice' }] });
    const heldFirmB = holdResponse();
    api.getExact('/api/lawfirms/firm-b/billing/workbench', heldFirmB.handler);

    const { result, rerender } = renderHook(
      ({ firm }: { firm: string }) => useBillingWorkbench(firm),
      { wrapper: createQueryWrapper(), initialProps: { firm: 'firm-a' } },
    );
    await waitFor(() => expect(result.current.data?.attention).toEqual([{ id: 'firm-a-invoice' }]));

    rerender({ firm: 'firm-b' });
    await heldFirmB.untilRequested();

    // Firm B's request is still pending here. Firm A's attention list must not
    // render as though it belongs to firm B while it loads.
    expect(result.current.data?.attention).not.toEqual([{ id: 'firm-a-invoice' }]);

    await act(async () => {
      heldFirmB.release({ attention: [{ id: 'firm-b-invoice' }] });
    });

    await waitFor(() => expect(result.current.data?.attention).toEqual([{ id: 'firm-b-invoice' }]));
  });
});
