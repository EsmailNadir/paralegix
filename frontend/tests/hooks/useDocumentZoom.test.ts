/**
 * `useDocumentZoom` / `useSettledZoom`: zoom state for a document surface,
 * driven by keyboard shortcuts, wheel, and pinch.
 *
 * Pinning the clamp bounds and the keyboard shortcuts: a zoom level outside
 * [MIN_ZOOM, MAX_ZOOM] would either shrink a document to nothing or blow it
 * off the visible canvas, silently, since nothing else validates the value.
 */
import { act, renderHook } from "@testing-library/react";
import { useDocumentZoom, useSettledZoom, MIN_ZOOM, MAX_ZOOM, ZOOM_STEP } from "@/hooks/useDocumentZoom";

describe("zoomIn / zoomOut", () => {
  it("steps by ZOOM_STEP and never exceeds MAX_ZOOM", () => {
    const { result } = renderHook(() => useDocumentZoom());
    expect(result.current.zoom).toBe(100);

    act(() => result.current.zoomIn());
    expect(result.current.zoom).toBe(100 + ZOOM_STEP);

    act(() => result.current.setZoom(MAX_ZOOM));
    act(() => result.current.zoomIn());
    expect(result.current.zoom).toBe(MAX_ZOOM);
  });

  it("steps down and never goes below MIN_ZOOM", () => {
    const { result } = renderHook(() => useDocumentZoom());
    act(() => result.current.setZoom(MIN_ZOOM));
    act(() => result.current.zoomOut());
    expect(result.current.zoom).toBe(MIN_ZOOM);
  });

  it("resets to exactly 100", () => {
    const { result } = renderHook(() => useDocumentZoom());
    act(() => result.current.setZoom(250));
    act(() => result.current.resetZoom());
    expect(result.current.zoom).toBe(100);
  });
});

describe("keyboard shortcuts", () => {
  function pressWithMeta(key: string) {
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, cancelable: true }));
    });
  }

  it("Ctrl/Cmd + '+' zooms in, '-' zooms out, '0' resets", () => {
    const { result } = renderHook(() => useDocumentZoom());

    pressWithMeta("+");
    expect(result.current.zoom).toBe(100 + ZOOM_STEP);

    pressWithMeta("-");
    pressWithMeta("-");
    expect(result.current.zoom).toBe(100 - ZOOM_STEP);

    pressWithMeta("0");
    expect(result.current.zoom).toBe(100);
  });

  it("does nothing without Ctrl/Cmd held", () => {
    const { result } = renderHook(() => useDocumentZoom());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "+", cancelable: true }));
    });
    expect(result.current.zoom).toBe(100);
  });

  it("does not bind listeners while disabled", () => {
    const { result } = renderHook(() => useDocumentZoom({ enabled: false }));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "+", ctrlKey: true, cancelable: true }));
    });
    expect(result.current.zoom).toBe(100);
  });
});

describe("useSettledZoom", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("trails the live zoom until the gesture settles", () => {
    const { result, rerender } = renderHook(({ zoom }) => useSettledZoom(zoom, 180), {
      initialProps: { zoom: 100 },
    });
    expect(result.current).toBe(100);

    rerender({ zoom: 150 });
    expect(result.current).toBe(100); // not yet settled

    act(() => jest.advanceTimersByTime(180));
    expect(result.current).toBe(150);
  });

  it("restarts the settle timer on every intermediate value during a fast gesture", () => {
    const { result, rerender } = renderHook(({ zoom }) => useSettledZoom(zoom, 180), {
      initialProps: { zoom: 100 },
    });

    rerender({ zoom: 125 });
    act(() => jest.advanceTimersByTime(100));
    rerender({ zoom: 150 });
    act(() => jest.advanceTimersByTime(100));
    // Neither intermediate value has had a full settle window uninterrupted.
    expect(result.current).toBe(100);

    act(() => jest.advanceTimersByTime(80));
    expect(result.current).toBe(150);
  });
});
