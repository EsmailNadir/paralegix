jest.unmock('@/services/signatures.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook } from '@testing-library/react';
import { useExecutedDocumentWait } from '@/hooks/signatureHooks/useExecutedDocumentWait';
import { setupApiMock, sequence } from '../support/apiMock';
import { holdResponse } from '../support/deferred';

const api = setupApiMock();
const url = (token: string) => `/api/signing/${token}/status`;
const completed = { sessionStatus: 'completed', participantStatus: 'completed', completedParticipants: 1, totalParticipants: 1 };
beforeEach(() => { jest.useFakeTimers(); process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off'; });
afterEach(() => { delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN; jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });
const advance = async (ms: number) => { await act(async () => { await jest.advanceTimersByTimeAsync(ms); }); };

it('stops polling once the executed document is complete', async () => {
  api.getExact(url('a'), completed);
  const { result } = renderHook(() => useExecutedDocumentWait('a'));
  act(() => result.current.setIsFinalizing(true));
  await advance(1000);
  expect(result.current.isFinalizing).toBe(false);
  expect(result.current.finalizeTimedOut).toBe(false);
  expect(api.calls('GET')).toHaveLength(1);
  await advance(60_000);
  expect(api.calls('GET')).toHaveLength(1);
});

it('discards a completed response from the previous signing token', async () => {
  const old = holdResponse();
  const next = holdResponse();
  api.getExact(url('a'), old.handler);
  api.getExact(url('b'), next.handler);
  const { result, rerender } = renderHook(({ token }) => useExecutedDocumentWait(token), { initialProps: { token: 'a' } });
  act(() => result.current.setIsFinalizing(true));
  await advance(1000);
  expect(old.requested).toBe(true);
  rerender({ token: 'b' });
  await advance(1000);
  expect(next.requested).toBe(true);
  await act(async () => old.release(completed));
  expect(result.current.isFinalizing).toBe(true);
  await act(async () => next.release(completed));
  expect(result.current.isFinalizing).toBe(false);
});

it('does not schedule another poll after a pending reader unmounts', async () => {
  const pending = holdResponse();
  api.getExact(url('a'), pending.handler);
  const { result, unmount } = renderHook(() => useExecutedDocumentWait('a'));
  act(() => result.current.setIsFinalizing(true));
  await advance(1000);
  expect(pending.requested).toBe(true);
  unmount();
  await act(async () => pending.release({ sessionStatus: 'in_progress' }));
  await advance(60_000);
  expect(api.calls('GET')).toHaveLength(1);
});

it('keeps waiting after a refused status read and stops on a later completion', async () => {
  api.getExact(url('a'), sequence({ status: 503, body: { error: 'Temporarily unavailable' } }, completed));
  const { result } = renderHook(() => useExecutedDocumentWait('a'));
  act(() => result.current.setIsFinalizing(true));
  await advance(1000);
  expect(result.current.isFinalizing).toBe(true);
  expect(result.current.finalizeTimedOut).toBe(false);
  expect(api.calls('GET')).toHaveLength(1);
  await advance(2000);
  expect(result.current.isFinalizing).toBe(false);
  expect(api.calls('GET')).toHaveLength(2);
});

it('skips status reads while hidden and resumes when the tab is visible', async () => {
  const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  api.getExact(url('a'), completed);
  const { result } = renderHook(() => useExecutedDocumentWait('a'));
  act(() => result.current.setIsFinalizing(true));
  await advance(1000);
  expect(result.current.isFinalizing).toBe(true);
  expect(api.calls('GET')).toHaveLength(0);
  hidden.mockReturnValue(false);
  await advance(2000);
  expect(result.current.isFinalizing).toBe(false);
  expect(api.calls('GET')).toHaveLength(1);
});
