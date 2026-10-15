/**
 * Offline contract coverage for a matter's document-requests panel.
 *
 * The scoping id (`matterId`) lives in the QUERY STRING, not the path
 * (`/lawfirms/:lawFirmId/document-requests?matterId=...`), so a suffix match
 * on the pathname alone cannot distinguish two matters - this uses `getExact`.
 * Keyed via `documentRequestsKey(lawFirmId, matterId, page, limit)` with bare
 * `placeholderData: keepPreviousData`, the same shape already found and fixed
 * as a cross-entity leak in `useClientLedger`/`useMatterLedger`.
 */
jest.unmock('@/services/documentRequests.service');
jest.unmock('@/services/requestDeduplicator');

import { renderHook, waitFor } from '@testing-library/react';

import useDocumentRequests from '@/hooks/documentRequestsHooks/useDocumentRequests';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const REQUESTS_MATTER_A = '/api/lawfirms/firm-a/document-requests?matterId=matter-a&page=1&limit=10';
const REQUESTS_MATTER_B = '/api/lawfirms/firm-a/document-requests?matterId=matter-b&page=1&limit=10';

const api = setupApiMock();

describe('useDocumentRequests offline contract', () => {
  it('does not request document requests before a firm and matter exist', async () => {
    const { result } = renderHook(
      () => useDocumentRequests(undefined, undefined),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()).toHaveLength(0);
  });

  it('fetches the exact matter document-requests endpoint', async () => {
    api.getExact(REQUESTS_MATTER_A, { requests: [{ id: 'req-a' }], totalRequests: 1 });

    const { result } = renderHook(
      () => useDocumentRequests('firm-a', 'matter-a'),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.requests.map((r) => r.id)).toEqual(['req-a']));
  });

  // Matter B's request is still pending here. Matter A's document requests
  // must not render as though they belong to matter B while it loads.
  itKeepsScopeIsolated({
    title: 'does not show one matter the document requests of another after a scope change',
    mode: 'pending',
    api: () => api,
    useHook: ({ matterId }: { matterId: string }) => useDocumentRequests('firm-a', matterId),
    ids: (r) => r.requests.map((r) => r.id),
    a: { props: { matterId: 'matter-a' }, url: REQUESTS_MATTER_A, body: { requests: [{ id: 'matter-a-request' }], totalRequests: 1 }, ids: ['matter-a-request'] },
    b: { props: { matterId: 'matter-b' }, url: REQUESTS_MATTER_B, body: { requests: [{ id: 'matter-b-request' }], totalRequests: 1 }, ids: ['matter-b-request'] },
  });
});
