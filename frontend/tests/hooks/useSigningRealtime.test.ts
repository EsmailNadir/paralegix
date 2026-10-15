/**
 * `useSigningRealtime` / `useClientSigningRealtime` / `useFirmSigningRealtime`:
 * a Supabase Realtime subscription used purely as a change trigger for
 * signing data.
 *
 * The rule worth pinning: each convenience wrapper must scope its
 * `postgres_changes` filter to the RIGHT table and column - a client
 * subscribed under the firm's filter (or vice versa) would either miss real
 * changes or fire on someone else's, and nothing on screen would say so.
 * Also worth pinning: no subscription at all while the scoping value is not
 * yet known, and the onChange debounce collapsing a burst into one call.
 */
// Next's jest transform hoists every `jest.mock()` call above ALL other
// top-level statements in the file, `const mock*` declarations included, so
// nothing the factory needs can live outside it. Build every jest.fn() and the
// fake client INSIDE the factory instead, and hand a reference back out
// through the mocked module itself for the tests below to read.
jest.mock("@/lib/supabase/realtimeClient", () => {
  const mockOn = jest.fn();
  const mockSubscribe = jest.fn();
  const mockChannel = jest.fn();
  const mockRemoveChannel = jest.fn();
  const mockRetainRealtime = jest.fn();
  const mockReleaseRealtime = jest.fn();
  const resumeListeners = new Set<() => void>();

  const chain = { on: mockOn, subscribe: mockSubscribe };
  mockOn.mockReturnValue(chain);
  mockSubscribe.mockReturnValue(chain);
  const client = {
    channel: (...args: unknown[]) => {
      mockChannel(...args);
      return chain;
    },
    removeChannel: mockRemoveChannel,
  };

  return {
    __esModule: true,
    getRealtimeClient: () => client,
    authorizeRealtime: jest.fn().mockResolvedValue(client),
    retainRealtime: (...args: unknown[]) => mockRetainRealtime(...args),
    releaseRealtime: (...args: unknown[]) => mockReleaseRealtime(...args),
    onRealtimeResume: (listener: () => void) => {
      resumeListeners.add(listener);
      return () => resumeListeners.delete(listener);
    },
    __spies: { mockOn, mockSubscribe, mockChannel, mockRemoveChannel, mockRetainRealtime, mockReleaseRealtime, resumeListeners },
  };
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { resetPageVisibility, setPageVisibility } from "../support/pageVisibility";
import {
  useSigningRealtime,
  useClientSigningRealtime,
  useFirmSigningRealtime,
} from "@/hooks/useSigningRealtime";

const { __spies: spies } = jest.requireMock("@/lib/supabase/realtimeClient") as {
  __spies: {
    mockOn: jest.Mock;
    mockSubscribe: jest.Mock;
    mockChannel: jest.Mock;
    mockRemoveChannel: jest.Mock;
    mockRetainRealtime: jest.Mock;
    mockReleaseRealtime: jest.Mock;
    resumeListeners: Set<() => void>;
  };
};
const { mockOn, mockChannel, mockRemoveChannel, mockRetainRealtime, mockReleaseRealtime, resumeListeners } = spies;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("scoping", () => {
  it("useClientSigningRealtime subscribes to signature_participants scoped by client_user_id", async () => {
    renderHook(() => useClientSigningRealtime("uid-1", jest.fn()));
    await waitFor(() => expect(mockChannel).toHaveBeenCalled());

    expect(mockOn).toHaveBeenCalledWith(
      "postgres_changes",
      expect.objectContaining({ table: "signature_participants", filter: "client_user_id=eq.uid-1" }),
      expect.any(Function),
    );
  });

  it("useFirmSigningRealtime subscribes to signature_sessions scoped by law_firm_id, never the client's table", async () => {
    renderHook(() => useFirmSigningRealtime("firm-1", jest.fn()));
    await waitFor(() => expect(mockChannel).toHaveBeenCalled());

    expect(mockOn).toHaveBeenCalledWith(
      "postgres_changes",
      expect.objectContaining({ table: "signature_sessions", filter: "law_firm_id=eq.firm-1" }),
      expect.any(Function),
    );
  });
});

describe("no value yet", () => {
  it("subscribes to nothing while the scoping value is null", () => {
    renderHook(() => useClientSigningRealtime(null, jest.fn()));
    expect(mockChannel).not.toHaveBeenCalled();
    expect(mockRetainRealtime).not.toHaveBeenCalled();
  });
});

describe("onChange debounce", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("collapses a burst of changes into a single onChange call", async () => {
    const onChange = jest.fn();
    renderHook(() =>
      useSigningRealtime({ filter: { table: "signature_sessions", column: "law_firm_id", value: "firm-1" }, onChange }),
    );
    await waitFor(() => expect(mockOn).toHaveBeenCalled());

    const trigger = mockOn.mock.calls[0][2] as () => void;
    trigger();
    trigger();
    trigger();

    jest.advanceTimersByTime(299);
    expect(onChange).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("lifecycle", () => {
  it("retains on mount and releases + removes the channel on unmount", async () => {
    const { unmount } = renderHook(() => useFirmSigningRealtime("firm-1", jest.fn()));
    await waitFor(() => expect(mockChannel).toHaveBeenCalled());
    expect(mockRetainRealtime).toHaveBeenCalledTimes(1);

    unmount();
    expect(mockReleaseRealtime).toHaveBeenCalledTimes(1);
    expect(mockRemoveChannel).toHaveBeenCalledTimes(1);
  });
});

describe("background tab", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    resetPageVisibility();
  });

  async function mountFirm(onChange: jest.Mock) {
    const hook = renderHook(() => useFirmSigningRealtime("firm-1", onChange));
    await waitFor(() => expect(mockOn).toHaveBeenCalled());
    const trigger = mockOn.mock.calls[mockOn.mock.calls.length - 1][2] as () => void;
    return { ...hook, trigger };
  }

  it("makes no onChange call for changes that arrive while the tab is hidden", async () => {
    const onChange = jest.fn();
    const { trigger } = await mountFirm(onChange);

    setPageVisibility("hidden");
    trigger();
    jest.advanceTimersByTime(60_000);
    trigger();
    jest.advanceTimersByTime(60_000);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("runs onChange exactly once when the tab becomes visible after hidden changes", async () => {
    const onChange = jest.fn();
    const { trigger } = await mountFirm(onChange);

    setPageVisibility("hidden");
    trigger();
    jest.advanceTimersByTime(1_000);
    trigger();
    jest.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();

    act(() => setPageVisibility("visible"));
    jest.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenCalledTimes(1);

    // A second visible transition with nothing new must not fetch again.
    act(() => setPageVisibility("hidden"));
    act(() => setPageVisibility("visible"));
    jest.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("makes no onChange call on becoming visible when nothing changed while hidden", async () => {
    const onChange = jest.fn();
    await mountFirm(onChange);

    act(() => setPageVisibility("hidden"));
    act(() => setPageVisibility("visible"));
    jest.advanceTimersByTime(1_000);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("still calls onChange, debounced, for changes while the tab is visible", async () => {
    const onChange = jest.fn();
    const { trigger } = await mountFirm(onChange);

    trigger();
    trigger();
    jest.advanceTimersByTime(299);
    expect(onChange).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not run a deferred onChange after unmount", async () => {
    const onChange = jest.fn();
    const { trigger, unmount } = await mountFirm(onChange);

    setPageVisibility("hidden");
    trigger();
    jest.advanceTimersByTime(1_000);
    unmount();
    act(() => setPageVisibility("visible"));
    jest.advanceTimersByTime(1_000);

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("realtime resume after the token lapsed", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("replaces the dropped channel and refetches once", async () => {
    const onChange = jest.fn();
    renderHook(() => useFirmSigningRealtime("firm-1", onChange));
    await waitFor(() => expect(mockChannel).toHaveBeenCalledTimes(1));
    expect(resumeListeners.size).toBe(1);

    await act(async () => {
      resumeListeners.forEach((listener) => listener());
    });
    await waitFor(() => expect(mockChannel).toHaveBeenCalledTimes(2));

    expect(mockRemoveChannel).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("stops listening for resumes on unmount", async () => {
    const { unmount } = renderHook(() => useFirmSigningRealtime("firm-1", jest.fn()));
    await waitFor(() => expect(mockChannel).toHaveBeenCalled());
    unmount();
    expect(resumeListeners.size).toBe(0);
  });
});
