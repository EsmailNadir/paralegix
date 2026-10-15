/**
 * Offline contract coverage for a client's aggregated document requests, on
 * the FIRM side (`ClientDocumentRequestsTab`).
 *
 * Had zero test coverage before this. Unlike `useDocumentRequests` (the
 * per-matter, paginated sibling that already needed a `keepPreviousData`
 * fix), this hook sets no `placeholderData` at all, so switching the active
 * client cannot render the old client's requests under the new client's
 * identity - React Query resets to `pending` on a genuinely new query key.
 * That is checked here rather than assumed.
 *
 * The consumer (`ClientDocumentRequestsTab`) calls `documentRequestsService`
 * mutations directly and then `queryClient.invalidateQueries` with
 * `firmClientDocumentRequestsKey` after every one of them (set item
 * status/link file/unlink file/request status/delete/create) - the
 * "fulfillment refresh" scenario the plan names. That invalidation contract
 * is exercised at the hook level here: a mutation lands out of band, the key
 * is invalidated the same way the component does it, and the hook must
 * refetch and surface the fresh state rather than keep showing the request
 * as still pending.
 */
jest.unmock('@/services/documentRequests.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import useFirmClientDocumentRequests, {
  firmClientDocumentRequestsKey,
} from '@/hooks/documentRequestsHooks/useFirmClientDocumentRequests';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { makeTestQueryClient } from '../support/renderWithProviders';
import { setupApiMock, sequence } from '../support/apiMock';
import { holdResponse } from '../support/deferred';

const REQUESTS_CLIENT_A = '/api/lawfirms/firm-a/document-requests/clients/client-a';
const REQUESTS_CLIENT_B = '/api/lawfirms/firm-a/document-requests/clients/client-b';

const api = setupApiMock();

function createWrapper() {
  const queryClient = makeTestQueryClient();
  function TestWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { TestWrapper, queryClient };
}

beforeEach(() => {
  __resetDuplicateRequestGuard();
});

describe('useFirmClientDocumentRequests offline contract', () => {
  it('does not request a client aggregate before a firm and client exist', async () => {
    const { TestWrapper } = createWrapper();
    const { result } = renderHook(
      () => useFirmClientDocumentRequests(undefined, undefined),
      { wrapper: TestWrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.requests).toEqual([]);
    expect(api.calls()).toHaveLength(0);
  });

  it('does not request with only one of the two ids present', async () => {
    const { TestWrapper } = createWrapper();
    const { result } = renderHook(
      () => useFirmClientDocumentRequests('firm-a', undefined),
      { wrapper: TestWrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.calls()).toHaveLength(0);
  });

  it('fetches the exact client-aggregate endpoint', async () => {
    api.getExact(REQUESTS_CLIENT_A, { requests: [{ id: 'req-a', matterId: null }] });
    const { TestWrapper } = createWrapper();

    const { result } = renderHook(
      () => useFirmClientDocumentRequests('firm-a', 'client-a'),
      { wrapper: TestWrapper },
    );

    await waitFor(() => expect(result.current.requests.map((r) => r.id)).toEqual(['req-a']));
    expect(result.current.error).toBeNull();
    expect(api.calls()).toEqual([expect.objectContaining({
      method: 'GET',
      pathname: '/api/lawfirms/firm-a/document-requests/clients/client-a',
    })]);
  });

  it('renders a client with no requests as an actual empty list, not an error', async () => {
    api.getExact(REQUESTS_CLIENT_A, { requests: [] });
    const { TestWrapper } = createWrapper();

    const { result } = renderHook(
      () => useFirmClientDocumentRequests('firm-a', 'client-a'),
      { wrapper: TestWrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.requests).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a failed fetch as an error rather than a silent empty list', async () => {
    api.getExact(REQUESTS_CLIENT_A, { status: 500, body: { error: 'boom' } });
    const { TestWrapper } = createWrapper();

    const { result } = renderHook(
      () => useFirmClientDocumentRequests('firm-a', 'client-a'),
      { wrapper: TestWrapper },
    );

    await waitFor(() => expect(result.current.error).toHaveProperty('message', 'boom'));
    expect(result.current.requests).toEqual([]);
  });

  it('recovers on refresh after a failed fetch', async () => {
    api.getExact(REQUESTS_CLIENT_A, sequence(
      { status: 500, body: { error: 'boom' } },
      { requests: [{ id: 'req-a', matterId: null }] },
    ));
    const { TestWrapper } = createWrapper();

    const { result } = renderHook(
      () => useFirmClientDocumentRequests('firm-a', 'client-a'),
      { wrapper: TestWrapper },
    );

    await waitFor(() => expect(result.current.error).toHaveProperty('message', 'boom'));

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.requests.map((r) => r.id)).toEqual(['req-a']));
    expect(result.current.error).toBeFalsy();
  });

  it('keys the client and firm dimensions independently', () => {
    expect(firmClientDocumentRequestsKey('firm-a', 'client-a'))
      .not.toEqual(firmClientDocumentRequestsKey('firm-a', 'client-b'));
    expect(firmClientDocumentRequestsKey('firm-a', 'client-a'))
      .not.toEqual(firmClientDocumentRequestsKey('firm-b', 'client-a'));
  });

  it('does not show one client the document requests of another after a scope change', async () => {
    api.getExact(REQUESTS_CLIENT_A, { requests: [{ id: 'client-a-request', matterId: null }] });
    const heldClientB = holdResponse();
    api.getExact(REQUESTS_CLIENT_B, heldClientB.handler);
    const { TestWrapper } = createWrapper();

    const { result, rerender } = renderHook(
      ({ clientId }: { clientId: string }) => useFirmClientDocumentRequests('firm-a', clientId),
      { initialProps: { clientId: 'client-a' }, wrapper: TestWrapper },
    );
    await waitFor(() => expect(result.current.requests.map((r) => r.id)).toEqual(['client-a-request']));

    rerender({ clientId: 'client-b' });
    await heldClientB.untilRequested();

    // Client B's aggregate is still pending here. Client A's requests must
    // not go on rendering as though they belong to client B while it loads -
    // this hook sets no placeholderData, so the correct behaviour is to show
    // nothing (or loading), never a leaked prior identity's rows.
    expect(result.current.requests.map((r) => r.id)).not.toContain('client-a-request');

    await act(async () => {
      heldClientB.release({ requests: [{ id: 'client-b-request', matterId: null }] });
    });

    await waitFor(() => expect(result.current.requests.map((r) => r.id)).toEqual(['client-b-request']));
  });

  it('refetches and clears a stale pending status once an item is fulfilled and the panel invalidates the key', async () => {
    api.getExact(REQUESTS_CLIENT_A, sequence(
      {
        requests: [{
          id: 'req-a',
          matterId: null,
          items: [{ id: 'item-1', status: 'pending' }],
        }],
      },
      {
        requests: [{
          id: 'req-a',
          matterId: null,
          items: [{ id: 'item-1', status: 'received' }],
        }],
      },
    ));
    const { TestWrapper, queryClient } = createWrapper();

    const { result } = renderHook(
      () => useFirmClientDocumentRequests('firm-a', 'client-a'),
      { wrapper: TestWrapper },
    );

    await waitFor(() => expect(result.current.requests[0]?.items[0]?.status).toBe('pending'));

    // Mimics ClientDocumentRequestsTab.invalidate() after
    // documentRequestsService.setItemStatus resolves: the mutation itself is
    // a separate direct call the component makes, not something this hook
    // owns, so it is invalidated the same way here rather than re-fetched
    // directly.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: firmClientDocumentRequestsKey('firm-a', 'client-a') });
    });

    await waitFor(() => expect(result.current.requests[0]?.items[0]?.status).toBe('received'));
    expect(api.callsTo('/document-requests/clients/client-a')).toHaveLength(2);
  });

  it('does not invalidate a different client sharing the same firm', async () => {
    api.getExact(REQUESTS_CLIENT_A, { requests: [{ id: 'req-a', matterId: null }] });
    const { TestWrapper, queryClient } = createWrapper();

    const { result } = renderHook(
      () => useFirmClientDocumentRequests('firm-a', 'client-a'),
      { wrapper: TestWrapper },
    );
    await waitFor(() => expect(result.current.requests.map((r) => r.id)).toEqual(['req-a']));

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: firmClientDocumentRequestsKey('firm-a', 'client-b') });
    });

    // Only one request ever went out: invalidating client B's key must not
    // refetch client A's.
    expect(api.callsTo('/document-requests/clients/client-a')).toHaveLength(1);
  });

  it('does not warn or throw when unmounted while a request is still in flight', async () => {
    const heldRequest = holdResponse();
    api.getExact(REQUESTS_CLIENT_A, heldRequest.handler);
    const { TestWrapper } = createWrapper();

    const { unmount } = renderHook(
      () => useFirmClientDocumentRequests('firm-a', 'client-a'),
      { wrapper: TestWrapper },
    );
    await heldRequest.untilRequested();

    unmount();

    await act(async () => {
      heldRequest.release({ requests: [{ id: 'req-a', matterId: null }] });
    });
  });
});
