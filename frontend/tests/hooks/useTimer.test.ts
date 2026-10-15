/**
 * `useTimer`: the billable timer, persisted in one `localStorage` key shared by
 * every firm open in the browser.
 *
 * Nothing tested this hook before. Its failure mode is not a crash but silent
 * billable-time loss or a timer surfacing under the wrong firm's matter list,
 * neither of which look wrong on screen until someone checks an invoice.
 */
import { act, renderHook } from "@testing-library/react";
import useTimer from "@/hooks/billingHooks/useTimer";

const STORAGE_KEY = "paralegix_timer";

beforeEach(() => {
  window.localStorage.clear();
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
});

afterEach(() => {
  jest.useRealTimers();
});

describe("firm isolation", () => {
  it("does not adopt a timer persisted under a different firm", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        isRunning: true,
        startedAt: Date.now() - 60_000,
        accumulatedMs: 0,
        lawFirmId: "firm-a",
        matterId: "matter-a",
        clientId: null,
        targetLabel: "Matter A",
        name: "",
        description: "",
      }),
    );

    // Rendering under a DIFFERENT firm must not resume firm A's timer: doing so
    // would bill firm B's time against firm A's matter.
    const { result } = renderHook(() => useTimer("firm-b"));

    expect(result.current.isRunning).toBe(false);
    expect(result.current.matterId).toBeNull();
    expect(result.current.isActive).toBe(false);
  });

  it("adopts a timer persisted under the same firm", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        isRunning: true,
        startedAt: Date.now() - 60_000,
        accumulatedMs: 0,
        lawFirmId: "firm-a",
        matterId: "matter-a",
        clientId: null,
        targetLabel: "Matter A",
        name: "",
        description: "",
      }),
    );

    const { result } = renderHook(() => useTimer("firm-a"));

    expect(result.current.isRunning).toBe(true);
    expect(result.current.matterId).toBe("matter-a");
  });

  it("discards a persisted timer that names no firm", () => {
    // A record with no `lawFirmId` cannot be shown to belong to this firm, and
    // its matter and client ids mean nothing here. Restoring it would attribute
    // someone else's time to this firm's matter.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        isRunning: false,
        startedAt: null,
        accumulatedMs: 120_000,
        matterId: "legacy-matter",
        clientId: null,
        targetLabel: "Legacy matter",
        name: "",
        description: "",
      }),
    );

    const { result } = renderHook(() => useTimer("firm-a"));

    expect(result.current.matterId).toBeNull();
    expect(result.current.elapsedMs).toBe(0);
  });

  it("stamps the current firm onto a newly started timer", () => {
    const { result } = renderHook(() => useTimer("firm-a"));

    act(() => {
      result.current.start({ matterId: "m1", targetLabel: "Matter One" });
    });

    expect(result.current.lawFirmId).toBe("firm-a");
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    expect(stored.lawFirmId).toBe("firm-a");
  });
});

describe("corrupt or unreadable storage", () => {
  it("falls back to the empty state instead of throwing on unparseable JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");

    let result: ReturnType<typeof useTimer> | undefined;
    expect(() => {
      ({ result: { current: result } } = renderHook(() => useTimer("firm-a")));
    }).not.toThrow();

    expect(result?.isRunning).toBe(false);
    expect(result?.isActive).toBe(false);
  });
});

describe("pause and resume", () => {
  it("accumulates elapsed time across a pause and a resume without losing or doubling it", () => {
    const { result } = renderHook(() => useTimer("firm-a"));

    act(() => {
      result.current.start({ matterId: "m1", targetLabel: "Matter One" });
    });

    act(() => {
      jest.advanceTimersByTime(30_000); // 30s running
    });
    act(() => {
      result.current.pause();
    });
    expect(result.current.elapsedMs).toBe(30_000);

    // Time passes while paused; must NOT be counted.
    act(() => {
      jest.advanceTimersByTime(45_000);
    });
    expect(result.current.elapsedMs).toBe(30_000);

    act(() => {
      result.current.resume();
    });
    act(() => {
      jest.advanceTimersByTime(15_000); // another 15s running
    });

    expect(result.current.elapsedMs).toBe(45_000); // 30s + 15s, not 30 + 45 + 15
  });

  it("resume is a no-op while already running", () => {
    const { result } = renderHook(() => useTimer("firm-a"));

    act(() => {
      result.current.start({ matterId: "m1", targetLabel: "Matter One" });
    });
    act(() => {
      jest.advanceTimersByTime(10_000);
    });

    const startedAtBefore = result.current.startedAt;
    act(() => {
      result.current.resume();
    });

    expect(result.current.startedAt).toBe(startedAtBefore);
  });

  it("pause is a no-op when the timer is not running", () => {
    const { result } = renderHook(() => useTimer("firm-a"));

    act(() => {
      result.current.pause();
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.elapsedMs).toBe(0);
  });
});

describe("stopping", () => {
  it("returns the accumulated hours and clears persisted state", () => {
    const { result } = renderHook(() => useTimer("firm-a"));

    act(() => {
      result.current.start({ matterId: "m1", clientId: null, targetLabel: "Matter One" });
    });
    act(() => {
      jest.advanceTimersByTime(3_600_000); // exactly one hour
    });

    let stopResult: ReturnType<typeof result.current.stop> | undefined;
    act(() => {
      stopResult = result.current.stop();
    });

    expect(stopResult?.hours).toBe(1);
    expect(stopResult?.matterId).toBe("m1");
    expect(result.current.isRunning).toBe(false);
    expect(result.current.isActive).toBe(false);
    // The persist effect re-writes storage after the clear, so the key is not
    // literally absent; what matters is that a fresh mount reads it back as an
    // inactive timer rather than resuming the stopped one.
    const { result: reloaded } = renderHook(() => useTimer("firm-a"));
    expect(reloaded.current.isActive).toBe(false);
    expect(reloaded.current.matterId).toBeNull();
  });

  it("discard clears the timer without returning a billable result", () => {
    const { result } = renderHook(() => useTimer("firm-a"));

    act(() => {
      result.current.start({ matterId: "m1", targetLabel: "Matter One" });
    });
    act(() => {
      result.current.discard();
    });

    expect(result.current.isActive).toBe(false);
    const { result: reloaded } = renderHook(() => useTimer("firm-a"));
    expect(reloaded.current.isActive).toBe(false);
    expect(reloaded.current.matterId).toBeNull();
  });
});
