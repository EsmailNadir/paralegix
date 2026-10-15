/**
 * `useUnsavedChangesGuard`: intercepts the browser Back button so unsaved work
 * is not silently discarded.
 *
 * Failure here is invisible until someone loses work: a guard that never
 * parks its placeholder lets Back through with no warning, one that parks a
 * fresh entry on every render corrupts history depth, and a `leave()` that
 * steps back the wrong number of entries strands the user on the placeholder
 * instead of returning them where they came from.
 */
import { renderHook, act } from "@testing-library/react";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";

// jsdom's `window.history` is one object shared by every test in this file.
// Reset its state (never its own call log - each spy is fresh per test) so an
// earlier test's parked placeholder cannot make a later test's first popstate
// look like a spurious re-fire.
beforeEach(() => {
  window.history.replaceState(null, "");
});

function fireBeforeUnload(): Event {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

/**
 * A real Back press pops the top history entry BEFORE the browser fires
 * `popstate`, so the handler observes `history.state` already moved to the
 * entry beneath. `replaceState` (not `pushState`) mimics that pop without
 * adding a new entry of its own, matching what the browser does natively.
 */
function firePopstateAfterRealBack() {
  window.history.replaceState({ real: "page-beneath-the-placeholder" }, "");
  window.dispatchEvent(new Event("popstate"));
}

/**
 * A spurious re-fire (seen on Safari) with no state change at all: `popstate`
 * fires again while `history.state` still carries the just-re-parked
 * placeholder.
 */
function firePopstateSpuriousRefire() {
  window.dispatchEvent(new Event("popstate"));
}

describe("parking the placeholder", () => {
  it("pushes one history entry once enabled becomes true", () => {
    const pushSpy = jest.spyOn(window.history, "pushState");
    const { rerender } = renderHook(
      ({ enabled }) => useUnsavedChangesGuard(enabled, jest.fn()),
      { initialProps: { enabled: false } },
    );
    expect(pushSpy).not.toHaveBeenCalled();

    rerender({ enabled: true });

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0][0]).toMatchObject({ __unsavedGuard: true });
    pushSpy.mockRestore();
  });

  it("does not park a second entry on a later render while still enabled", () => {
    const pushSpy = jest.spyOn(window.history, "pushState");
    const { rerender } = renderHook(
      ({ enabled }) => useUnsavedChangesGuard(enabled, jest.fn()),
      { initialProps: { enabled: true } },
    );
    expect(pushSpy).toHaveBeenCalledTimes(1);

    rerender({ enabled: true });

    expect(pushSpy).toHaveBeenCalledTimes(1);
    pushSpy.mockRestore();
  });

  it("parks nothing while disabled", () => {
    const pushSpy = jest.spyOn(window.history, "pushState");
    renderHook(() => useUnsavedChangesGuard(false, jest.fn()));

    expect(pushSpy).not.toHaveBeenCalled();
    pushSpy.mockRestore();
  });
});

describe("beforeunload", () => {
  it("warns before a reload or tab close while enabled", () => {
    renderHook(() => useUnsavedChangesGuard(true, jest.fn()));

    const event = fireBeforeUnload();

    expect(event.defaultPrevented).toBe(true);
  });

  it("does not warn while disabled", () => {
    renderHook(() => useUnsavedChangesGuard(false, jest.fn()));

    const event = fireBeforeUnload();

    expect(event.defaultPrevented).toBe(false);
  });

  it("stands down after release(), so an already-confirmed departure gets no second prompt", () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(true, jest.fn()));

    act(() => result.current.release());
    const event = fireBeforeUnload();

    expect(event.defaultPrevented).toBe(false);
  });
});

describe("intercepting Back", () => {
  it("re-parks the placeholder and calls onBlocked on a real Back press", () => {
    const onBlocked = jest.fn();
    const pushSpy = jest.spyOn(window.history, "pushState");
    renderHook(() => useUnsavedChangesGuard(true, onBlocked));
    expect(pushSpy).toHaveBeenCalledTimes(1); // the initial park

    firePopstateAfterRealBack();

    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledTimes(2); // re-armed
    pushSpy.mockRestore();
  });

  it("lets the press through with no callback while disabled", () => {
    const onBlocked = jest.fn();
    renderHook(() => useUnsavedChangesGuard(false, onBlocked));

    firePopstateAfterRealBack();

    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("lets the press through with no callback after release()", () => {
    const onBlocked = jest.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard(true, onBlocked));

    act(() => result.current.release());
    firePopstateAfterRealBack();

    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("does not double-fire on a spurious re-fire that lands back on the placeholder", () => {
    // Some browsers refire popstate right after a pushState issued from inside
    // a popstate handler. The guard must recognise it is already sitting on
    // the placeholder and bail rather than looping.
    const onBlocked = jest.fn();
    const pushSpy = jest.spyOn(window.history, "pushState");
    renderHook(() => useUnsavedChangesGuard(true, onBlocked));

    firePopstateAfterRealBack(); // real Back press: re-parks and calls onBlocked once
    expect(onBlocked).toHaveBeenCalledTimes(1);
    const callsAfterRealPress = pushSpy.mock.calls.length;

    firePopstateSpuriousRefire(); // no state change: still sitting on the placeholder

    expect(onBlocked).toHaveBeenCalledTimes(1); // not called again
    expect(pushSpy).toHaveBeenCalledTimes(callsAfterRealPress); // did not push again
    pushSpy.mockRestore();
  });
});

describe("leave()", () => {
  it("steps back past both the placeholder and the page when parked", () => {
    const goSpy = jest.spyOn(window.history, "go").mockImplementation(() => {});
    const { result } = renderHook(() => useUnsavedChangesGuard(true, jest.fn()));

    act(() => result.current.leave());

    expect(goSpy).toHaveBeenCalledWith(-2);
    goSpy.mockRestore();
  });

  it("steps back only one entry when nothing was ever parked", () => {
    const goSpy = jest.spyOn(window.history, "go").mockImplementation(() => {});
    const { result } = renderHook(() => useUnsavedChangesGuard(false, jest.fn()));

    act(() => result.current.leave());

    expect(goSpy).toHaveBeenCalledWith(-1);
    goSpy.mockRestore();
  });

  it("also releases, suppressing the reload/close prompt", () => {
    const goSpy = jest.spyOn(window.history, "go").mockImplementation(() => {});
    const { result } = renderHook(() => useUnsavedChangesGuard(true, jest.fn()));

    act(() => result.current.leave());
    const event = fireBeforeUnload();

    expect(event.defaultPrevented).toBe(false);
    goSpy.mockRestore();
  });
});
