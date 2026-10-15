import { useEffect } from "react";

/**
 * Locks document scroll while `active` is true so the page behind a
 * modal/overlay can't scroll.
 *
 * Uses a module-level refcount so stacked overlays don't fight each other: the
 * first active lock applies the styles and the last one to release restores the
 * original inline styles.
 *
 * The lock targets `<html>` (the scroll container that owns the gutter). The
 * global `html { scrollbar-gutter: stable }` rule keeps that gutter reserved
 * even while overflow is hidden, so the scrollbar's space never collapses and
 * no `padding-right` compensation is needed. Adding any would double-count the
 * still-reserved gutter and shift the page sideways.
 *
 * SSR-safe: no-ops when `document`/`window` are unavailable.
 */

let lockCount = 0;
let previousOverflow = "";

function applyLock() {
  const root = document.documentElement;
  previousOverflow = root.style.overflow;
  root.style.overflow = "hidden";
}

function releaseLock() {
  document.documentElement.style.overflow = previousOverflow;
}

export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (typeof document === "undefined" || typeof window === "undefined") return;

    if (lockCount === 0) applyLock();
    lockCount += 1;

    return () => {
      // Clamp so a Strict-Mode / fast-remount cleanup can't underflow the
      // refcount and leave the body permanently locked.
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount === 0) releaseLock();
    };
  }, [active]);
}

export default useBodyScrollLock;
