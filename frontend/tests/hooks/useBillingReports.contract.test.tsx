/**
 * Offline contract coverage for the "billing by client" and "billing by matter"
 * report hooks.
 *
 * The two are separate implementations with the same contract, so one case list
 * runs against both. Each shares the `[..., lawFirmId, {...}]` query-key shape
 * and bare `placeholderData: keepPreviousData` already found and fixed as a
 * cross-tenant leak in `useTasks`/`useClients`/`useClientLedger`/
 * `useMatterLedger`/`useTrustTransactions`.
 */
jest.unmock('@/services/billing.service');

import { renderHook, waitFor } from '@testing-library/react';

import useBillingByClientReport from '@/hooks/billingHooks/useBillingByClientReport';
import useBillingByMatterReport from '@/hooks/billingHooks/useBillingByMatterReport';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated, itSendsNothingWithoutScope } from '../support/scopeIsolation';

const api = setupApiMock();

const REPORTS = [
  {
    name: 'useBillingByClientReport',
    useReport: useBillingByClientReport as (lawFirmId: string | undefined) => { rows: any[]; loading: boolean },
    path: 'by-client',
    rowKey: 'clientId',
    entity: 'client',
  },
  {
    name: 'useBillingByMatterReport',
    useReport: useBillingByMatterReport as (lawFirmId: string | undefined) => { rows: any[]; loading: boolean },
    path: 'by-matter',
    rowKey: 'id',
    entity: 'matter',
  },
];

describe.each(REPORTS)('$name offline contract', ({ useReport, path, rowKey, entity }) => {
  const reportUrl = (firm: string) => `/api/lawfirms/${firm}/billing/reports/${path}?limit=10&page=1`;
  const row = (id: string) => ({ [rowKey]: id });
  const ids = (r: { rows: any[] }) => r.rows.map((x) => x[rowKey]);

  itSendsNothingWithoutScope({
    title: 'does not request the report before a firm scope exists',
    api: () => api,
    useHook: () => useReport(undefined),
    settled: (r) => r.loading === false,
  });

  it('fetches the exact firm/page endpoint', async () => {
    api.getExact(reportUrl('firm-a'), { rows: [row(`${entity}-a`)], totalItems: 1 });

    const { result } = renderHook(() => useReport('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(ids(result.current)).toEqual([`${entity}-a`]));
  });

  itKeepsScopeIsolated({
    title: 'does not show firm A rows as firm B rows after firm A already resolved',
    mode: 'pending',
    api: () => api,
    useHook: ({ lawFirmId }: { lawFirmId: string }) => useReport(lawFirmId),
    ids,
    a: {
      props: { lawFirmId: 'firm-a' },
      url: reportUrl('firm-a'),
      body: { rows: [row(`firm-a-${entity}`)], totalItems: 1 },
      ids: [`firm-a-${entity}`],
    },
    b: {
      props: { lawFirmId: 'firm-b' },
      url: reportUrl('firm-b'),
      body: { rows: [row(`firm-b-${entity}`)], totalItems: 1 },
      ids: [`firm-b-${entity}`],
    },
  });
});
