"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

export interface AnchoredMenuPosition {
  top: number;
  left: number;
  width: number;
}

interface Options {
  /** Measure only while true. */
  open: boolean;
  /** The control the menu hangs from (a button or an input). */
  anchorRef: RefObject<HTMLElement | null>;
  /** The rendered menu, measured for its real height once it has mounted. */
  menuRef: RefObject<HTMLElement | null>;
  /** Height to plan with before the menu has mounted and can be measured. */
  estimatedHeight: number;
  /** Gap in px between the anchor and the menu. */
  offset?: number;
  align?: "left" | "right";
  clampHorizontal?: boolean;
  /** Anything else that changes the menu's height (option count, a filter row). */
  deps?: unknown[];
}

/**
 * Viewport position for a menu rendered in a `document.body` portal with
 * `position: fixed`, so a parent with `overflow: hidden` cannot clip it.
 *
 * The menu sits flush under the anchor at the anchor's width and follows it on
 * scroll and resize while open. When there is not room below and there is more
 * room above, it flips above the anchor. Returns null until the first
 * measurement, so a caller can skip rendering rather than flash at (0,0).
 */
export default function useAnchoredMenuPosition({
  open,
  anchorRef,
  menuRef,
  estimatedHeight,
  offset = 4,
  deps = [],
  align = "left",
  clampHorizontal = false,
}: Options): AnchoredMenuPosition | null {
  const [pos, setPos] = useState<AnchoredMenuPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!anchorRef.current) return;
      const r = anchorRef.current.getBoundingClientRect();
      const menuH = menuRef.current?.offsetHeight ?? estimatedHeight;
      const spaceBelow = (document.documentElement.clientHeight || window.innerHeight) - r.bottom;
      const openUp = spaceBelow < menuH + 8 && r.top > spaceBelow;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const width = menuRef.current?.offsetWidth || r.width;
      setPos({
        top: openUp ? Math.max(8, r.top - menuH - offset) : Math.max(8, Math.min(r.bottom + offset, viewportHeight - menuH - 8)),
        left: align === "right"
          ? (clampHorizontal ? Math.max(width + 8, Math.min(r.right, viewportWidth - 8)) : r.right)
          : r.left,
        width: r.width,
      });
    };
    update();
    // Refine once the menu has actually rendered and its height can be read.
    const raf = requestAnimationFrame(update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
    // `deps` is the caller's list of height inputs, spread in on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, estimatedHeight, offset, align, clampHorizontal, Boolean(pos), ...deps]);

  return pos;
}
