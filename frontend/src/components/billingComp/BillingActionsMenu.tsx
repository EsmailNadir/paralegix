"use client";

import useActionMenu from "@/hooks/useActionMenu";
import { createPortal } from "react-dom";
import {
  BadgeDollarSign,
  ChevronDown,
  Layers,
  Play,
  Plus,
  Receipt,
} from "lucide-react";
import { useLastOpenValue } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";

interface BillingActionsMenuProps {
  onAddExpense: () => void;
  onAddFlatFee: () => void;
  onStartTimer: () => void;
  onBulkInvoices: () => void;
  timerActive?: boolean;
  canManageExpenses: boolean;
  canManageInvoices: boolean;
}

// Portaled to document.body and positioned from the button's rect, matching
// ItemActionMenu/RowActionMenu/BulkActionsMenu: it escapes any overflow-hidden
// ancestor, closes on scroll/resize so it never drifts from the button, and
// flips above the trigger when there isn't room below.
export default function BillingActionsMenu({
  onAddExpense,
  onAddFlatFee,
  onStartTimer,
  onBulkInvoices,
  timerActive = false,
  canManageExpenses,
  canManageInvoices,
}: BillingActionsMenuProps) {
  const { open, setOpen, mounted, exiting, btnRef, menuRef, coords, toggle } = useActionMenu({ clampHorizontal: true });
  const shownTimerActive = useLastOpenValue(open, timerActive);

  const run = (action: () => void) => {
    action();
    setOpen(false);
  };


  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1.5 bg-white/15 border border-white/25 px-3 py-1.5 rounded-lg text-xs font-medium text-white backdrop-blur-sm hover:bg-white/25 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
      >
        <Plus size={13} />
        New
        <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {mounted && coords && typeof document !== "undefined" && createPortal(
        // Anchored to the button's right edge (`coords.left`) and pulled left by
        // its own width via the transform, so it stays right-aligned without
        // needing to know its width up front.
        <div
          ref={menuRef}
          style={{ position: "fixed", top: coords.top, left: coords.left, transform: "translateX(-100%)" }}
          className={`w-52 bg-surface border border-outline-subtle rounded-xl shadow-lg z-50 p-1 origin-top-right ${menuAnim(exiting)}`}
          onClick={(e) => e.stopPropagation()}
        >
          {canManageExpenses && (
            <MenuItem icon={<Receipt size={13} strokeWidth={2.2} />} label="Expense" onClick={() => run(onAddExpense)} />
          )}
          {canManageInvoices && (
            <MenuItem icon={<BadgeDollarSign size={13} strokeWidth={2.2} />} label="Flat Fee" onClick={() => run(onAddFlatFee)} />
          )}
          {(canManageExpenses || canManageInvoices) && <div className="border-t border-outline-subtle my-1" />}
          <button
            type="button"
            onClick={() => !timerActive && run(onStartTimer)}
            disabled={timerActive}
            className={`flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-sm transition-colors ${
              shownTimerActive
                ? "text-green-600 dark:text-green-400 cursor-default"
                : "text-on-surface hover:bg-surface-hover cursor-pointer"
            }`}
          >
            <span className={`shrink-0 w-6 h-6 rounded-md flex items-center justify-center ${shownTimerActive ? "bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400" : "bg-surface-alt text-on-surface-secondary"}`}>
              <Play size={13} strokeWidth={2.2} />
            </span>
            {shownTimerActive ? "Timer running" : "Start Timer"}
          </button>
          {canManageInvoices && (
            <>
              <div className="border-t border-outline-subtle my-1" />
              <MenuItem icon={<Layers size={13} strokeWidth={2.2} />} label="Bulk Invoices" onClick={() => run(onBulkInvoices)} />
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-sm text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
    >
      <span className="shrink-0 w-6 h-6 rounded-md bg-surface-alt flex items-center justify-center text-on-surface-secondary">
        {icon}
      </span>
      {label}
    </button>
  );
}
