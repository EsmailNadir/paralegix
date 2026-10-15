/**
 * `useBodyScrollLock`: locks page scroll behind an overlay, via a
 * module-level refcount so stacked overlays don't fight each other.
 *
 * The addendum's own named failure mode: the page stays permanently
 * unscrollable after a modal closes, because a second overlay's release
 * cleared a lock a still-open first overlay still needed.
 */
import { renderHook } from "@testing-library/react";
import useBodyScrollLock from "@/hooks/useBodyScrollLock";

beforeEach(() => {
  document.documentElement.style.overflow = "";
});

describe("stacked overlays", () => {
  it("keeps the page locked while any overlay is still active, and releases only once all are gone", () => {
    const first = renderHook(({ active }) => useBodyScrollLock(active), {
      initialProps: { active: true },
    });
    expect(document.documentElement.style.overflow).toBe("hidden");

    const second = renderHook(({ active }) => useBodyScrollLock(active), {
      initialProps: { active: true },
    });
    expect(document.documentElement.style.overflow).toBe("hidden");

    first.unmount();
    // The second overlay is still open: the page must stay locked.
    expect(document.documentElement.style.overflow).toBe("hidden");

    second.unmount();
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("never locks the page when active starts false", () => {
    renderHook(() => useBodyScrollLock(false));
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("restores the lock once toggled back on after being released", () => {
    const { rerender, unmount } = renderHook(({ active }) => useBodyScrollLock(active), {
      initialProps: { active: true },
    });
    expect(document.documentElement.style.overflow).toBe("hidden");

    rerender({ active: false });
    expect(document.documentElement.style.overflow).toBe("");

    rerender({ active: true });
    expect(document.documentElement.style.overflow).toBe("hidden");

    unmount();
    expect(document.documentElement.style.overflow).toBe("");
  });
});
