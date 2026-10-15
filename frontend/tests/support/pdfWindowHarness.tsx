/**
 * Driving a windowed PDF viewer under jsdom.
 *
 * jsdom performs no layout, so neither of the two observers these viewers depend
 * on ever fires on its own: a container is never measured and no page is ever
 * reported visible. Both stubs below are therefore not conveniences but the only
 * way a windowing assertion can mean anything here - without them a spec would
 * render zero pages and pass every "at most five canvases" check for the wrong
 * reason.
 *
 * `tests/setup.ts` installs a global IntersectionObserver stub that keeps only
 * the LAST constructed callback. That is enough for a single viewer, but it
 * cannot unobserve and cannot address one viewer among several, so windowing
 * specs install this one instead.
 */
import type React from 'react';

/** A width every observed element reports, so pages get a real size. */
const MEASURED_WIDTH = 800;

export interface IntersectionControl {
  /**
   * Report visibility for the given page numbers, as a scroll would.
   *
   * Pages not named are reported as no longer intersecting, which is what
   * scrolling away from them actually produces and is the half a viewer that
   * only ever ADDS pages to a set gets away with ignoring.
   */
  scrollTo: (ratios: Record<number, number>) => void;
  /** How many elements are currently observed, so a leaked observer registration shows up. */
  observedCount: () => number;
  restore: () => void;
}

/**
 * Replaces IntersectionObserver with one a spec drives by hand.
 *
 * Elements are addressed by their `data-pdf-page` / `data-testid` page number,
 * resolved at report time from the live DOM, so a page whose slot was removed
 * simply stops being reportable.
 */
export function installIntersectionControl(
  pageSelector: (page: number) => string,
): IntersectionControl {
  const original = (globalThis as any).IntersectionObserver;
  const observed = new Set<Element>();
  const callbacks = new Set<IntersectionObserverCallback>();

  class ControlledIntersectionObserver {
    constructor(private callback: IntersectionObserverCallback) {
      callbacks.add(callback);
    }
    observe(target: Element) { observed.add(target); }
    unobserve(target: Element) { observed.delete(target); }
    disconnect() {
      callbacks.delete(this.callback);
      observed.clear();
    }
    takeRecords() { return []; }
  }

  (globalThis as any).IntersectionObserver = ControlledIntersectionObserver;
  if (typeof window !== 'undefined') {
    (window as any).IntersectionObserver = ControlledIntersectionObserver;
  }

  return {
    scrollTo(ratios) {
      const named = new Map<Element, number>();
      for (const [page, ratio] of Object.entries(ratios)) {
        const element = document.querySelector(pageSelector(Number(page)));
        if (element) named.set(element, ratio);
      }

      const entries: unknown[] = [];
      for (const target of observed) {
        const ratio = named.get(target) ?? 0;
        named.delete(target);
        entries.push({ target, intersectionRatio: ratio, isIntersecting: ratio > 0 });
      }
      // A page named but never observed still gets reported, so a spec fails on a
      // viewer that forgot to register its boxes rather than passing silently.
      for (const [target, ratio] of named) {
        entries.push({ target, intersectionRatio: ratio, isIntersecting: ratio > 0 });
      }

      for (const callback of callbacks) {
        (callback as unknown as (e: unknown[]) => void)(entries);
      }
    },
    observedCount: () => observed.size,
    restore() {
      (globalThis as any).IntersectionObserver = original;
      if (typeof window !== 'undefined') (window as any).IntersectionObserver = original;
    },
  };
}

/**
 * A ResizeObserver that actually reports a width.
 *
 * These viewers draw nothing until their container has been measured, which is
 * correct: page width comes from the container. The shared harness stub never
 * fires, so without this every windowing assertion would run against a component
 * that rendered no pages at all.
 */
export function installMeasuringResizeObserver(width = MEASURED_WIDTH) {
  const original = (globalThis as any).ResizeObserver;
  class MeasuringResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb(
        [{ target, contentRect: { width, height: 1000 } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  (globalThis as any).ResizeObserver = MeasuringResizeObserver;
  return () => { (globalThis as any).ResizeObserver = original; };
}

/**
 * Gives jsdom a PointerEvent, so a pointer-driven interaction can be tested.
 *
 * jsdom implements none, and Testing Library then falls back to a plain Event
 * and DROPS the init it was given. Every field placement reads `isPrimary`,
 * `pointerType` and `pointerId` off the event, so without this a placement
 * gesture is delivered with all three undefined: the handler returns early and
 * the spec sees nothing happen, for a reason that has nothing to do with the
 * code under test.
 */
export function installPointerEvents(): () => void {
  const original = (globalThis as any).PointerEvent;
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;
    width: number;
    height: number;
    pressure: number;
    constructor(type: string, init: Record<string, any> = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? '';
      this.isPrimary = init.isPrimary ?? false;
      this.width = init.width ?? 1;
      this.height = init.height ?? 1;
      this.pressure = init.pressure ?? 0;
    }
  }
  (globalThis as any).PointerEvent = PointerEventPolyfill;
  if (typeof window !== 'undefined') (window as any).PointerEvent = PointerEventPolyfill;
  return () => {
    (globalThis as any).PointerEvent = original;
    if (typeof window !== 'undefined') (window as any).PointerEvent = original;
  };
}

/**
 * Tracks page canvases as they mount and unmount.
 *
 * The count alone is what the whole bounded-window rule rests on, and it can
 * only be measured by watching BOTH halves: a component that mounts a canvas per
 * page and merely hides the ones offscreen passes any "rendered once" check.
 */
export function createCanvasTracker() {
  const mounted = new Set<number>();
  return {
    mounted,
    count: () => mounted.size,
    /** Use inside the mocked canvas component's effect. */
    track(pageNumber: number) {
      mounted.add(pageNumber);
      return () => { mounted.delete(pageNumber); };
    },
    reset() { mounted.clear(); },
  };
}

export type CanvasTracker = ReturnType<typeof createCanvasTracker>;

/**
 * A stub canvas component that reports itself to a tracker.
 *
 * The tracker arrives as a getter because this is called from a `jest.mock`
 * factory, which runs before the spec file's own `const` bindings exist.
 */
export function trackedCanvas(
  getTracker: () => CanvasTracker,
  React: typeof import('react'),
  page: { width: number; height: number } = { width: 612, height: 792 },
): React.ComponentType<any> {
  return function TrackedCanvas({ pageNumber, onLoadSuccess }: any) {
    React.useEffect(() => getTracker().track(pageNumber), [pageNumber]);
    React.useEffect(() => {
      onLoadSuccess?.({
        width: page.width,
        height: page.height,
        originalWidth: page.width,
        originalHeight: page.height,
      });
      // The stub reports once per mount, the way a real render does.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pageNumber]);
    return React.createElement('div', { 'data-testid': `canvas-${pageNumber}` });
  };
}
