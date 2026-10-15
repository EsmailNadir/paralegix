/**
 * `useMountTransition`, `useResetAfterClose`, `useLastOpenValue`: the shared
 * exit-animation plumbing behind every modal.
 *
 * A silent failure here doesn't crash - it shows the wrong content for the
 * length of a close animation ("Delete ""?" instead of the real name) or runs
 * cleanup too early, blanking a dialog the user can still see closing.
 */
import { act, renderHook } from "@testing-library/react";
import { useMountTransition, useResetAfterClose, useLastOpenValue } from "@/hooks/useMountTransition";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("useMountTransition", () => {
  it("stays mounted through the exit animation, then unmounts once it finishes", () => {
    const { result, rerender } = renderHook(({ open }) => useMountTransition(open, 200), {
      initialProps: { open: true },
    });
    expect(result.current.mounted).toBe(true);
    expect(result.current.exiting).toBe(false);

    rerender({ open: false });
    expect(result.current.mounted).toBe(true);
    expect(result.current.exiting).toBe(true);

    act(() => {
      jest.advanceTimersByTime(199);
    });
    expect(result.current.mounted).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.mounted).toBe(false);
    expect(result.current.exiting).toBe(false);
  });

  it("cancels an in-progress exit when reopened before the animation finishes", () => {
    const { result, rerender } = renderHook(({ open }) => useMountTransition(open, 200), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current.exiting).toBe(true);

    rerender({ open: true });
    expect(result.current.mounted).toBe(true);
    expect(result.current.exiting).toBe(false);
  });
});

describe("useResetAfterClose", () => {
  it("runs reset only after the close delay, not at the moment of closing", () => {
    const reset = jest.fn();
    const { rerender } = renderHook(({ open }) => useResetAfterClose(open, reset, 200), {
      initialProps: { open: true },
    });

    rerender({ open: false });
    expect(reset).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending reset if reopened inside the delay", () => {
    const reset = jest.fn();
    const { rerender } = renderHook(({ open }) => useResetAfterClose(open, reset, 200), {
      initialProps: { open: true },
    });

    rerender({ open: false });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    rerender({ open: true });
    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(reset).not.toHaveBeenCalled();
  });

  it("never resets before the dialog has ever been opened", () => {
    const reset = jest.fn();
    renderHook(() => useResetAfterClose(false, reset, 200));
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(reset).not.toHaveBeenCalled();
  });
});

describe("useLastOpenValue", () => {
  it("holds the value the dialog last had while open, through its exit animation", () => {
    const { result, rerender } = renderHook(
      ({ open, value }) => useLastOpenValue(open, value),
      { initialProps: { open: true, value: "Invoice #1042" } },
    );
    expect(result.current).toBe("Invoice #1042");

    // Parent blanks the value in the same handler that closes the dialog.
    rerender({ open: false, value: "" });
    expect(result.current).toBe("Invoice #1042");

    rerender({ open: true, value: "Invoice #1055" });
    expect(result.current).toBe("Invoice #1055");
  });
});
