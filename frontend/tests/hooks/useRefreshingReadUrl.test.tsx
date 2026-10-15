import { act, renderHook } from '@testing-library/react';
import { useRefreshingReadUrl } from '@/hooks/useRefreshingReadUrl';
import { deferred } from '../support/deferred';

const url = (name = 'a', generation = '1') => `https://storage.googleapis.com/bucket/${name}.pdf?generation=${generation}&Expires=${(Date.now() + 120_000) / 1000}`;
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-02T12:00:00Z')); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

it('keeps the original read until expiry when reauthorization is refused', async () => {
  const original = url();
  const refresh = jest.fn().mockRejectedValue(new Error('Access revoked'));
  const { result } = renderHook(() => useRefreshingReadUrl({ url: original, enabled: true, refresh }));
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(result.current.readUrl).toBe(original);
  expect(result.current.replacedBy).toBeNull();
  await act(async () => { jest.advanceTimersByTime(600_000); });
  expect(refresh).toHaveBeenCalledTimes(1);
});

it.each(['switch', 'close'] as const)('ignores a pending renewal after the reader %s', async (change) => {
  const pending = deferred<string>();
  const original = url();
  const refresh = jest.fn(() => pending.promise);
  const { result, rerender } = renderHook((props) => useRefreshingReadUrl({ ...props, refresh }), {
    initialProps: { url: original, enabled: true },
  });
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(refresh).toHaveBeenCalledTimes(1);
  const nextDocument = url('b');
  rerender({ url: change === 'switch' ? nextDocument : original, enabled: change === 'switch' });
  await act(async () => pending.resolve(url('a', '2')));
  expect(result.current.readUrl).toBe(change === 'switch' ? nextDocument : original);
  expect(result.current.replacedBy).toBeNull();
});

it('cancels scheduled renewal when the reader unmounts', async () => {
  const refresh = jest.fn().mockResolvedValue(url());
  const { unmount } = renderHook(() => useRefreshingReadUrl({ url: url(), enabled: true, refresh }));
  unmount();
  await act(async () => { jest.advanceTimersByTime(120_000); });
  expect(refresh).not.toHaveBeenCalled();
});

it('uses the latest authorization callback without restarting the expiry clock', async () => {
  const original = url();
  const first = jest.fn();
  const second = jest.fn().mockResolvedValue(url('a', '2'));
  const { result, rerender } = renderHook(({ refresh }) => useRefreshingReadUrl({ url: original, enabled: true, refresh }), {
    initialProps: { refresh: first },
  });
  act(() => { jest.advanceTimersByTime(30_000); });
  rerender({ refresh: second });
  await act(async () => { jest.advanceTimersByTime(30_000); });
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
  expect(result.current.replacedBy).toContain('generation=2');
  expect(result.current.readUrl).toBe(original);
});
