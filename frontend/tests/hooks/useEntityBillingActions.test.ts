/**
 * `useEntityBillingActions`: builds the time-entry prefill and timer-start
 * payload shared by every "Log time" / "Start timer" button on a matter,
 * client, or task.
 *
 * The rule worth pinning: when a matter is present, the entry must bill to
 * the MATTER, never also carry a `clientId` - a time entry with both would
 * double-count on both the matter's and the client's own billing views.
 */
const mockStartTimer = jest.fn();

jest.mock("@/contexts/BillingTimerContext", () => ({
  __esModule: true,
  useBillingTimer: () => ({ startTimer: mockStartTimer }),
}));

import { act, renderHook } from "@testing-library/react";
import { useEntityBillingActions, type EntityBillingContext } from "@/hooks/useEntityBillingActions";

beforeEach(() => {
  mockStartTimer.mockReset();
});

function context(overrides: Partial<EntityBillingContext> = {}): EntityBillingContext {
  return { title: "Estate Plan", ...overrides };
}

describe("logging time against a matter", () => {
  it("suppresses clientId even when the matter also carries clients", () => {
    const { result } = renderHook(() =>
      useEntityBillingActions(context({ matterId: "matter-1", clientId: "client-1" })),
    );
    act(() => result.current.handleLogTime());

    expect(result.current.timeEntryPrefill?.matterId).toBe("matter-1");
    expect(result.current.timeEntryPrefill?.clientId).toBeNull();
  });

  it("starts the timer scoped to the matter, not the client", () => {
    const { result } = renderHook(() =>
      useEntityBillingActions(context({ matterId: "matter-1", clientId: "client-1" })),
    );
    act(() => result.current.handleStartTimer());

    expect(mockStartTimer).toHaveBeenCalledWith(
      expect.objectContaining({ matterId: "matter-1", clientId: null }),
    );
  });
});

describe("logging time against a client directly (no matter)", () => {
  it("carries the client id through to the prefill", () => {
    const { result } = renderHook(() =>
      useEntityBillingActions(context({ clientId: "client-1" })),
    );
    act(() => result.current.handleLogTime());

    expect(result.current.timeEntryPrefill?.matterId).toBeNull();
    expect(result.current.timeEntryPrefill?.clientId).toBe("client-1");
  });

  it("falls back to the first of several client ids when none is primary", () => {
    const { result } = renderHook(() =>
      useEntityBillingActions(context({ clientIds: ["client-a", "client-b"] })),
    );
    act(() => result.current.handleLogTime());

    expect(result.current.timeEntryPrefill?.clientId).toBe("client-a");
    expect(result.current.timeEntryPrefill?.sourceClientIds).toEqual(["client-a", "client-b"]);
  });
});

describe("a null context", () => {
  it("does nothing rather than throwing", () => {
    const { result } = renderHook(() => useEntityBillingActions(null));
    expect(() => act(() => result.current.handleLogTime())).not.toThrow();
    expect(() => act(() => result.current.handleStartTimer())).not.toThrow();
    expect(result.current.addTimeEntryOpen).toBe(false);
    expect(mockStartTimer).not.toHaveBeenCalled();
  });
});

describe("starting a timer with no single billing target", () => {
  // Red if: the hook goes back to timing against the first of several clients.
  it("starts nothing for a matter-less context with two clients", () => {
    const { result } = renderHook(() =>
      useEntityBillingActions(context({ clientIds: ["client-a", "client-b"] })),
    );
    act(() => result.current.handleStartTimer());

    expect(mockStartTimer).not.toHaveBeenCalled();
  });

  it("labels a timer on the only client with that client's name", () => {
    const { result } = renderHook(() =>
      useEntityBillingActions(context({ clientIds: ["client-a"], clientNames: ["Ada Client"] })),
    );
    act(() => result.current.handleStartTimer());

    expect(mockStartTimer).toHaveBeenCalledWith(
      expect.objectContaining({ matterId: null, clientId: "client-a", targetLabel: "Ada Client" }),
    );
  });
});
