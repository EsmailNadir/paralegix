"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLastOpenValue, useMountTransition } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";

export interface ItemMenuAction {
  key: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  /** Render as a non-clickable, dimmed info row (e.g. "Shared via folder"). */
  disabled?: boolean;
}

/**
 * Compute the trigger's anchor edges for a row's action menu: `anchorTop`/
 * `anchorBottom` bracket the kebab (or the cursor for a right-click), and
 * `right` is its right edge distance from the viewport edge. `ItemActionMenu`
 * decides at render time, from its own real measured size, whether to open
 * below `anchorBottom` or flip above `anchorTop` - this only reports the
 * trigger's geometry, not a menu position.
 */
export function menuPositionFromEvent(
  e: React.MouseEvent,
): { anchorTop: number; anchorBottom: number; right: number; left: number } {
  const vw = document.documentElement.clientWidth;
  let refRight: number;
  let refLeft: number;
  let refTop: number;
  let refBottom: number;
  if (e.type === "contextmenu") {
    refRight = e.clientX;
    refLeft = e.clientX;
    refTop = e.clientY;
    refBottom = e.clientY;
  } else {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    refRight = r.right;
    refLeft = r.left;
    refTop = r.top;
    refBottom = r.bottom;
  }
  const right = Math.max(8, vw - refRight);
  const left = Math.max(8, refLeft);
  return { anchorTop: refTop, anchorBottom: refBottom, right, left };
}

/**
 * Per-row action menu, opened by the row's kebab button or a right-click. The
 * parent owns the open position and the action list (which varies by surface and
 * permissions); falsy entries are dropped so callers can include actions inline.
 * Stays mounted through its close animation.
 *
 * A kebab that toggles this menu must carry `data-item-menu-trigger` so the
 * outside-click listener skips it (see below).
 */
// Gap between the trigger's edge and the menu, matching menuPositionFromEvent's
// previous r.bottom + 4.
const GAP = 4;

export default function ItemActionMenu({
  open,
  anchorTop,
  anchorBottom,
  right,
  left,
  align = "right",
  header,
  actions,
  onClose,
  portalContainer,
}: {
  open: boolean;
  /** Trigger's top edge, in px, from {@link menuPositionFromEvent}. Used when flipping the menu above the trigger. */
  anchorTop: number;
  /** Trigger's bottom edge, in px, from {@link menuPositionFromEvent}. Used when opening the menu below the trigger. */
  anchorBottom: number;
  /** Anchor distance from the viewport right edge, in px, from {@link menuPositionFromEvent}. Used when align is 'right'. */
  right?: number;
  /** Anchor distance from the viewport left edge, in px, from {@link menuPositionFromEvent}. Used when align is 'left'. */
  left?: number;
  /** Horizontal alignment relative to the trigger. Defaults to 'right'. */
  align?: "left" | "right";
  /** Non-clickable content pinned above the actions (e.g. an identity block), separated by a rule. */
  header?: React.ReactNode;
  actions: Array<ItemMenuAction | false | null | undefined>;
  onClose: () => void;
  /** Keep a popup within an enclosing dialog's focus trap while retaining fixed positioning. */
  portalContainer?: HTMLElement | null;
}) {
  const { mounted, exiting } = useMountTransition(open, 150);
  const ref = useRef<HTMLDivElement>(null);
  // Anchor position until the menu has rendered and its real size is known.
  const [pos, setPos] = useState<{ top: number; right?: number; left?: number }>({
    top: anchorBottom + GAP,
    ...(align === "left" ? { left: left ?? 8 } : { right: right ?? 8 }),
  });
  const [openUp, setOpenUp] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // A click on a row's kebab trigger toggles the menu via the trigger's own
      // onClick; skip it here so this listener doesn't close-then-reopen the menu
      // (this mousedown runs before the trigger's click).
      if ((e.target as Element | null)?.closest("[data-item-menu-trigger]")) return;
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Capture-phase scroll so scrolling any ancestor closes the menu (its fixed
    // coords would otherwise drift away from the trigger it was opened from).
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose]);

  // Decide below-vs-above from the menu's real rendered size (not a guess),
  // so a short menu (few permitted actions) isn't clamped as if it were the
  // tallest possible menu. Opens below the trigger by default; flips above it
  // only when there isn't room below and there's more room above than below
  // (mirrors Dropdown.tsx's portal-mode flip). Runs before paint so there's no
  // visible jump from the initial anchor position to the resolved one.
  useLayoutEffect(() => {
    if (!mounted || !ref.current) return;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const el = ref.current;
    const h = el.offsetHeight;
    const spaceBelow = vh - anchorBottom;
    const spaceAbove = anchorTop;
    const willOpenUp = spaceBelow < h + GAP && spaceAbove > spaceBelow;
    setOpenUp(willOpenUp);
    const top = willOpenUp
      ? Math.max(8, anchorTop - h - GAP)
      : Math.max(8, Math.min(anchorBottom + GAP, vh - h - 8));

    if (align === "left") {
      const l = left ?? 8;
      setPos({
        top,
        left: Math.max(8, Math.min(l, vw - el.offsetWidth - 8)),
      });
    } else {
      const r = right ?? 8;
      setPos({
        top,
        right: Math.max(8, Math.min(r, vw - el.offsetWidth - 8)),
      });
    }
  }, [mounted, anchorTop, anchorBottom, right, left, align]);

  // Actions routinely toggle the very state that names them ("Hide" becomes
  // "Unhide"), and picking one closes the menu while leaving it on screen for
  // its exit animation. Hold the list it had so it does not relabel or shrink
  // itself on the way out.
  const visible = useLastOpenValue(open, actions.filter(Boolean) as ItemMenuAction[]);
  if (!mounted || typeof document === "undefined") return null;

  const originClass =
    align === "left"
      ? openUp ? "origin-bottom-left" : "origin-top-left"
      : openUp ? "origin-bottom-right" : "origin-top-right";

  // Portaled to document.body so it escapes any overflow-hidden/scrolling
  // ancestor that would otherwise clip it, and so its z-index competes with
  // the rest of the page rather than losing stacking-order ties within a
  // nested card (e.g. against another row's menu or an in-page modal).
  return createPortal(
    <div
      ref={ref}
      className={`fixed bg-surface border border-outline-subtle rounded-xl shadow-xl z-50 p-1 min-w-[180px] ${originClass} ${menuAnim(exiting)}`}
      style={{
        top: pos.top,
        ...(pos.left !== undefined ? { left: pos.left } : { right: pos.right }),
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {header && (
        <div className="border-b border-outline-subtle mb-1 pb-1">{header}</div>
      )}
      {visible.map((a) =>
        a.disabled ? (
          <div key={a.key} className="px-2.5 py-2 rounded-lg text-sm text-on-surface-muted flex items-center gap-2.5">
            {a.icon && (
              <span className="shrink-0 w-6 h-6 rounded-md bg-surface-alt flex items-center justify-center">
                {a.icon}
              </span>
            )}
            {a.label}
          </div>
        ) : (
          <button
            key={a.key}
            onClick={() => {
              onClose();
              a.onClick();
            }}
            className={`w-full text-left px-2.5 py-2 rounded-lg text-sm cursor-pointer flex items-center gap-2.5 ${
              a.danger
                ? "text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20"
                : "text-on-surface hover:bg-surface-hover"
            }`}
          >
            {a.icon && (
              <span
                className={`shrink-0 w-6 h-6 rounded-md flex items-center justify-center ${
                  a.danger
                    ? "bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400"
                    : "bg-surface-alt text-on-surface-secondary"
                }`}
              >
                {a.icon}
              </span>
            )}
            {a.label}
          </button>
        ),
      )}
    </div>,
    portalContainer ?? document.body,
  );
}
