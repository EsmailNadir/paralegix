"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type SlidingHighlightRect = { left: number; top: number; width: number; height: number };

/**
 * Positions an absolutely-positioned highlight element behind whichever
 * sibling button is "active" in a segmented control / pill toggle, and keeps
 * it in sync via a CSS transition instead of a hard cut.
 *
 * Two distinct moments trigger a measurement, and they're handled
 * differently on purpose:
 *
 * - The container mounting into the DOM (the `containerRef` callback below)
 *   measures and positions the pill instantly. This is what actually
 *   happens on real pages: a component often sits behind a loading gate
 *   (`if (loading) return <Spinner />`) that renders nothing on the first
 *   pass, so the container can mount on a LATER render than the component's
 *   own first render. A plain `useLayoutEffect(..., [activeKey])` would
 *   miss that mount entirely whenever `activeKey` hasn't changed since the
 *   loading render, because its dependency never fires again. A mount
 *   (attach/detach of the DOM node itself) always fires the callback ref,
 *   regardless of render count, so this is the one instant that reliably
 *   means "the real DOM exists now, measure it."
 * - `activeKey` changing (the effect below) animates to the new position,
 *   deferred by one animation frame. Measuring and calling setState
 *   synchronously in a layout effect lands the new position in the same
 *   pre-paint commit as the triggering render, so the browser never
 *   actually paints the old position. The CSS transition has nothing to
 *   interpolate from and the highlight just jumps. Deferring via
 *   requestAnimationFrame lets the browser paint the old position (with the
 *   new active state's colours already applied) on one frame, then move it
 *   on the next, which is what the transition needs to see an actual
 *   before/after.
 */
export default function useSlidingHighlight<TContainer extends HTMLElement = HTMLElement>(
  // `null` means "nothing active." `''` is a real key some callers legitimately
  // use (e.g. an "All" filter option) and must still be looked up, so every
  // check below is an explicit `!== null`, never a truthiness check.
  activeKey: string | null,
) {
  const containerElRef = useRef<TContainer | null>(null);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [rect, setRect] = useState<SlidingHighlightRect | null>(null);

  const measure = () => {
    const container = containerElRef.current;
    const item = activeKey !== null ? itemRefs.current.get(activeKey) : undefined;
    if (!container || !item) return;
    // `offsetLeft`/`offsetTop` are relative to the item's nearest positioned
    // ancestor (its `offsetParent`), which every caller sets up to be this
    // same `container` - so these numbers don't change when the container
    // scrolls, unlike `getBoundingClientRect()`. That matters for a strip
    // like `TabBar`: with the rect-based approach the highlight had to
    // re-measure on every `scroll` event, and each of those re-measures ran
    // through the CSS transition meant for click transitions, so the
    // underline visibly lagged behind while a user scrolled the strip. The
    // offset-based rect is already correct mid-scroll with no remeasure.
    setRect({
      left: item.offsetLeft,
      top: item.offsetTop,
      width: item.offsetWidth,
      height: item.offsetHeight,
    });
  };

  // `containerRef` must stay referentially stable (see below), but a mount
  // can happen many renders after the one that created the closure it
  // captured on creation, e.g. the container sits behind a conditional that
  // toggled away and back with `activeKey` now pointing at something else.
  // Routing every call through a ref that's reassigned each render (a plain
  // synchronous write, not an effect) means the callback always invokes
  // whichever `measure` closure belongs to the most recent render.
  const measureRef = useRef(measure);
  measureRef.current = measure;

  const containerRef = useCallback((el: TContainer | null) => {
    containerElRef.current = el;
    // Refs attach bottom-up within a commit, so the item refs (children of
    // this container) are already populated by the time this fires.
    if (el) measureRef.current();
  }, []);

  const registerItem = (key: string) => (el: HTMLElement | null) => {
    if (el) itemRefs.current.set(key, el);
    else itemRefs.current.delete(key);
  };

  useLayoutEffect(() => {
    const container = containerElRef.current;
    const item = activeKey !== null ? itemRefs.current.get(activeKey) : undefined;
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);

    // Layout can still settle after this: most commonly a web font finishing
    // its swap-in and reflowing the label wider, which happens on its own
    // timeline and isn't caused by anything React re-rendered for, so no
    // dependency-driven effect would ever see it. A ResizeObserver instead
    // reports directly whenever the elements we actually measure change
    // size, whatever the cause, so the highlight self-corrects instead of
    // staying wrong until something else (a click) happens to remeasure it.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && container) ro.observe(container);
    if (ro && item) ro.observe(item);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `measure` is intentionally excluded: it's a fresh closure every render, so listing it would rerun this effect (and re-defer the slide) on every render instead of only when activeKey changes
  }, [activeKey]);

  return { containerRef, registerItem, rect };
}
