"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreVertical } from "lucide-react";
import { useLastOpenValue, useMountTransition } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";

export interface RowAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
}

interface RowActionMenuProps {
  actions: RowAction[];
  ariaLabel?: string;
  buttonClassName?: string;
}

// Gap between the trigger's edge and the menu.
const GAP = 4;

// A compact "three dots" (kebab) action menu for list rows. The menu is portalled
// to document.body and positioned with fixed coordinates from the button's rect,
// so it escapes any overflow-hidden / scrolling ancestor (e.g. a rounded list
// card) that would otherwise clip an inline dropdown. Closes on outside click,
// scroll, resize, or Escape.
export default function RowActionMenu({ actions, ariaLabel = "More actions", buttonClassName = "" }: RowActionMenuProps) {
  const [open, setOpen] = useState(false);
  // Trigger's edges, captured at click time.
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; right: number } | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { mounted, exiting } = useMountTransition(open, 150);
  // Actions routinely toggle the very state that names them ("Archive" becomes
  // "Unarchive", a row disappears from the selection). Picking one closes the
  // menu but leaves it on screen for its exit animation, so the live list would
  // relabel or shrink itself on the way out. Fade out what was clicked.
  const closingActions = useLastOpenValue(open, actions);

  const MENU_MIN_WIDTH = 168;

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      // Compute the anchor at click time (not in an effect) so there's no
      // flicker and no useLayoutEffect SSR warning. The initial coords open
      // below the trigger, pending the real-size correction below.
      const r = btnRef.current.getBoundingClientRect();
      setAnchor({ top: r.top, bottom: r.bottom, right: r.right });
      setCoords({ top: r.bottom + GAP, left: r.right });
    }
    setOpen((v) => !v);
  };

  // Decide below-vs-above from the menu's real rendered height (not a guess),
  // mirroring ItemActionMenu.tsx: opens below the trigger by default, flips
  // above it only when there isn't room below and there's more room above
  // than below. Runs before paint so there's no visible jump.
  useLayoutEffect(() => {
    if (!mounted || !anchor || !menuRef.current) return;
    const vh = document.documentElement.clientHeight;
    const h = menuRef.current.offsetHeight;
    const spaceBelow = vh - anchor.bottom;
    const spaceAbove = anchor.top;
    const openUp = spaceBelow < h + GAP && spaceAbove > spaceBelow;
    setCoords({
      top: openUp
        ? Math.max(8, anchor.top - h - GAP)
        : Math.max(8, Math.min(anchor.bottom + GAP, vh - h - 8)),
      left: anchor.right,
    });
  }, [mounted, anchor]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onDismiss = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    // Capture-phase scroll so scrolling any ancestor closes the menu (its fixed
    // coords would otherwise drift away from the button).
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`p-1.5 rounded-md border border-input-border text-on-surface-muted hover:bg-surface-hover hover:text-on-surface transition-[background-color,border-color,color] cursor-pointer ${open ? "bg-surface-hover text-on-surface" : ""} ${buttonClassName}`}
      >
        <MoreVertical size={16} />
      </button>

      {mounted && coords && typeof document !== "undefined" && createPortal(
        // Positioning lives on this wrapper, not on the animated element: the
        // menu's keyframes end at `transform: none`, which would wipe out a
        // translate used for alignment and make the menu jump sideways.
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            top: coords.top,
            left: coords.left,
            transform: "translateX(-100%)",
            maxWidth: "min(20rem, calc(100vw - 1rem))",
          }}
          className="z-[60]"
          onClick={(e) => e.stopPropagation()}
        >
          <div
            role="menu"
            style={{ minWidth: MENU_MIN_WIDTH }}
            className={`rounded-xl border border-outline-subtle bg-surface shadow-xl p-1 origin-top-right ${menuAnim(exiting)}`}
          >
            {closingActions.map((a, i) => (
              <button
                key={i}
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); a.onClick(); }}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-left whitespace-nowrap transition-colors cursor-pointer ${
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
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
