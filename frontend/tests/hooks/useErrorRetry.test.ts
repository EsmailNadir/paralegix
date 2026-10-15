/**
 * `useErrorRetry`: the retry handler behind a route's `error.tsx`.
 *
 * The rule worth pinning: a second failure on the SAME route within the
 * retry window must escalate to a hard `window.location.reload()` instead of
 * repeating the same soft `router.refresh()` that already failed to fix it -
 * a soft retry loop that never escalates leaves the user stuck with nothing
 * on screen but a spinning retry button.
 *
 * jsdom does not implement `location.reload()` and its `location` property
 * cannot be stubbed out in this environment, so the escalation is proven
 * indirectly: on the escalated path the hook returns before ever calling
 * `router.refresh()`/`reset()`, so those call counts staying flat IS the
 * proof it took the reload branch instead of the soft-retry one.
 */
const mockRefresh = jest.fn();
let mockPathname = "/lawfirm/firm-1/matters";

jest.mock("next/navigation", () => ({
  __esModule: true,
  useRouter: () => ({ refresh: (...args: unknown[]) => mockRefresh(...args) }),
  usePathname: () => mockPathname,
}));

import { act, renderHook } from "@testing-library/react";
import { useErrorRetry } from "@/hooks/useErrorRetry";

let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  mockPathname = "/lawfirm/firm-1/matters";
  mockRefresh.mockReset();
  window.sessionStorage.clear();
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
  // jsdom logs "Not implemented: navigation" whenever the escalation branch
  // really calls `window.location.reload()`; expected here, so keep it out of
  // the test output.
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  consoleErrorSpy.mockRestore();
});

describe("a first failure on a route", () => {
  it("soft-retries: router.refresh and reset", () => {
    const reset = jest.fn();
    const { result } = renderHook(() => useErrorRetry(reset));

    act(() => result.current.retry());

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("a second failure on the same route inside the retry window", () => {
  it("takes the escalation branch instead of repeating the soft retry", () => {
    const reset = jest.fn();
    const { result } = renderHook(() => useErrorRetry(reset));

    act(() => result.current.retry());
    jest.setSystemTime(new Date("2026-09-03T12:00:05.000Z")); // 5s later, inside the 20s window
    act(() => result.current.retry());

    // A second call to the soft path would bring these to 2; staying at 1
    // proves the second retry short-circuited into the reload branch instead.
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("a second failure outside the retry window", () => {
  it("soft-retries again rather than escalating", () => {
    const reset = jest.fn();
    const { result } = renderHook(() => useErrorRetry(reset));

    act(() => result.current.retry());
    jest.setSystemTime(new Date("2026-09-03T12:00:25.000Z")); // 25s later, outside the 20s window
    act(() => result.current.retry());

    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(2);
  });
});

describe("two different routes", () => {
  it("does not let a failure on one route escalate a retry on another", () => {
    const reset = jest.fn();
    const { result, rerender } = renderHook(() => useErrorRetry(reset));

    act(() => result.current.retry());

    mockPathname = "/lawfirm/firm-1/tasks";
    rerender();
    jest.setSystemTime(new Date("2026-09-03T12:00:05.000Z"));
    act(() => result.current.retry());

    // The second route's own first failure must soft-retry, not escalate.
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(2);
  });
});
