"use client";

import useActionMenu from "@/hooks/useActionMenu";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { useLastOpenValue } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";

export interface BulkAction {
  key: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * Dropdown of actions to apply to the currently-selected files. Shared by the
 * matter-detail file manager and the firm-wide files browser so both surfaces get
 * the same selection menu. The caller passes the relevant actions (share/hide,
 * download, sign, move, delete) already wired to its own handlers; falsy entries
 * are dropped so callers can conditionally include actions inline.
 *
 * Portaled to document.body and positioned from the button's rect, matching
 * ItemActionMenu/RowActionMenu: it escapes any overflow-hidden ancestor, closes
 * on scroll/resize so it never drifts from the button, and flips above the
 * trigger when there isn't room below.
 */
export default function BulkActionsMenu({
  count,
  actions,
  size = "small",
}: {
  count: number;
  actions: Array<BulkAction | false | null | undefined>;
  size?: "small" | "medium";
}) {
  const { open, setOpen, mounted, exiting, btnRef, menuRef, coords, toggle } = useActionMenu({ clampHorizontal: false });

  const visible = actions.filter(Boolean) as BulkAction[];
  // Running an action changes the selection it acts on, so the list behind this
  // menu can relabel or empty while the menu is still fading out. Render the
  // list it had when it closed; the guard below stays on the live one, since a
  // menu with nothing left to offer must still stop rendering.
  const closingActions = useLastOpenValue(open, visible);
  if (count <= 0 || visible.length === 0) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className={`inline-flex items-center gap-1.5 rounded-md bg-surface border border-outline hover:bg-surface-hover text-on-surface cursor-pointer transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 ${
          size === "small"
            ? "px-2.5 py-1.5 text-xs font-medium"
            : "px-3 py-1.5 text-sm font-medium"
        }`}
      >
        <span>{count} selected</span>
        <ChevronDown size={size === "small" ? 13 : 14} className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {mounted && coords && typeof document !== "undefined" && createPortal(
        // Anchored to the button's right edge (`coords.left`) and pulled left by
        // its own width via the transform, so it stays right-aligned without
        // needing to know its width up front.
        <div
          ref={menuRef}
          style={{ position: "fixed", top: coords.top, left: coords.left, transform: "translateX(-100%)" }}
          className={`min-w-[180px] bg-surface border border-outline-subtle rounded-xl shadow-lg z-50 p-1 origin-top-right ${menuAnim(exiting)}`}
          onClick={(e) => e.stopPropagation()}
        >
          {closingActions.map((a) => (
            <button
              key={a.key}
              type="button"
              disabled={a.disabled}
              onClick={() => {
                setOpen(false);
                a.onClick();
              }}
              className={`w-full flex items-center gap-2.5 text-left px-2.5 py-2 rounded-lg text-sm whitespace-nowrap transition-colors duration-75 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
                a.danger
                  ? "text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/30"
                  : "text-on-surface hover:bg-surface-hover"
              }`}
            >
              {a.icon && (
                <span
                  className={`shrink-0 flex items-center justify-center ${
                    a.danger
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-on-surface-secondary"
                  }`}
                >
                  {a.icon}
                </span>
              )}
              <span>{a.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
