/**
 * Offline contracts for a portal client's document-request feed.
 *
 * The active client record is an authorization scope, not a display filter. A
 * portal identity can represent a person and one or more organizations in the
 * same firm, so changing that record must never leave the prior record's
 * requests in React Query while the new association is loading.
 */
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';

import useClientDocumentRequests, { clientDocumentRequestsKey } from '@/hooks/documentRequestsHooks/useClientDocumentRequests';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { createQueryWrapper } from '../support/queryWrapper';

const api = setupApiMock();

beforeEach(() => {
  __resetDuplicateRequestGuard();
});

describe('useClientDocumentRequests offline contract', () => {
  it('waits for a firm scope before requesting a portal feed', async () => {
    const { result } = renderHook(
      () => useClientDocumentRequests(undefined, 'matter-a', 'client-record-a'),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.requests).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(api.calls()).toEqual([]);
  });

  it('sends the firm, matter, and active client record on the exact portal request', async () => {
    api.getExact(
      '/api/client-portal/lawfirm/firm-a/document-requests?clientRecordId=client-record-a&matterId=matter-a',
      { requests: [{ id: 'request-a' }] },
    );

    const { result } = renderHook(
      () => useClientDocumentRequests('firm-a', 'matter-a', 'client-record-a'),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.requests.map((request) => request.id)).toEqual(['request-a']));
    expect(api.calls()).toEqual([expect.objectContaining({
      method: 'GET',
      pathname: '/api/client-portal/lawfirm/firm-a/document-requests',
      query: { matterId: ['matter-a'], clientRecordId: ['client-record-a'] },
    })]);
    expect(result.current.error).toBeNull();
  });

  it('uses an independent cache entry and request when the active client record changes', async () => {
    api.getExact('/api/client-portal/lawfirm/firm-a/document-requests?clientRecordId=client-record-a', {
      requests: [{ id: 'request-a' }],
    });
    api.getExact('/api/client-portal/lawfirm/firm-a/document-requests?clientRecordId=client-record-b', {
      requests: [{ id: 'request-b' }],
    });

    const { result, rerender } = renderHook(
      ({ clientRecordId }: { clientRecordId: string }) => useClientDocumentRequests('firm-a', undefined, clientRecordId),
      { initialProps: { clientRecordId: 'client-record-a' }, wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.requests.map((request) => request.id)).toEqual(['request-a']));

    rerender({ clientRecordId: 'client-record-b' });

    await waitFor(() => expect(result.current.requests.map((request) => request.id)).toEqual(['request-b']));
    expect(api.calls('GET').map((call) => call.query.clientRecordId)).toEqual([
      ['client-record-a'],
      ['client-record-b'],
    ]);
  });

  it('does not replace the new association with a delayed old-association result', async () => {
    const heldOldAssociation = holdResponse();
    api.getExact('/api/client-portal/lawfirm/firm-a/document-requests?clientRecordId=client-record-a', heldOldAssociation.handler);
    api.getExact('/api/client-portal/lawfirm/firm-a/document-requests?clientRecordId=client-record-b', {
      requests: [{ id: 'request-b' }],
    });

    const { result, rerender } = renderHook(
      ({ clientRecordId }: { clientRecordId: string }) => useClientDocumentRequests('firm-a', undefined, clientRecordId),
      { initialProps: { clientRecordId: 'client-record-a' }, wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(api.callsTo('/lawfirm/firm-a/document-requests')).toHaveLength(1));

    rerender({ clientRecordId: 'client-record-b' });
    await waitFor(() => expect(result.current.requests.map((request) => request.id)).toEqual(['request-b']));

    await act(async () => {
      heldOldAssociation.release({ requests: [{ id: 'request-a' }] });
    });

    expect(result.current.requests.map((request) => request.id)).toEqual(['request-b']);
  });

  it('treats a revoked association as an empty authorized view, but surfaces other failures', async () => {
    api.getExact('/api/client-portal/lawfirm/firm-a/document-requests?clientRecordId=client-record-a', {
      status: 403,
      body: { error: 'Client is not associated with this law firm' },
    });

    const associationGone = renderHook(
      () => useClientDocumentRequests('firm-a', undefined, 'client-record-a'),
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(associationGone.result.current.loading).toBe(false));
    expect(associationGone.result.current.requests).toEqual([]);
    expect(associationGone.result.current.error).toBeNull();

    api.getExact('/api/client-portal/lawfirm/firm-a/document-requests?clientRecordId=client-record-b', {
      status: 500,
      body: { error: 'Document requests unavailable' },
    });
    const failed = renderHook(
      () => useClientDocumentRequests('firm-a', undefined, 'client-record-b'),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(failed.result.current.error).toMatch(/Document requests unavailable/i));
    expect(failed.result.current.requests).toEqual([]);
  });

  it('keys every association dimension independently', () => {
    expect(clientDocumentRequestsKey('firm-a', undefined, 'client-record-a'))
      .not.toEqual(clientDocumentRequestsKey('firm-a', undefined, 'client-record-b'));
    expect(clientDocumentRequestsKey('firm-a', 'matter-a', 'client-record-a'))
      .not.toEqual(clientDocumentRequestsKey('firm-b', 'matter-a', 'client-record-a'));
  });
});
