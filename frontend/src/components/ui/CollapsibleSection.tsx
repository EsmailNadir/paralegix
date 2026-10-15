"use client";

import { type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * The one class for the header subtext line. The description and the summary
 * take turns in that single slot, so a different size or colour on either one
 * makes the line resize every time the section toggles.
 */
const SUBTEXT_CLASS = "mt-0.5 block text-xs text-on-surface-muted";

interface CollapsibleSectionProps {
  title: string;
  /** Shown under the title only while the section is open. */
  description?: string;
  /**
   * Compact stand-in for the body, shown instead of the description while the
   * section is collapsed. Must be phrasing content (text or `<span>`) because
   * it renders inside the toggle button.
   */
  summary?: ReactNode;
  /** Header controls rendered outside the toggle button (e.g. an add button). */
  actions?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** `card` is a standalone page section; `inline` nests inside another card. */
  tone?: "card" | "inline";
  className?: string;
  children: ReactNode;
}

/**
 * A titled section that collapses to a single summary row. Used to keep long
 * forms scannable: sections that are optional or already filled in stay folded
 * away until the user needs them.
 */
export default function CollapsibleSection({
  title,
  description,
  summary,
  actions,
  open,
  onToggle,
  tone = "card",
  className = "",
  children,
}: CollapsibleSectionProps) {
  const inline = tone === "inline";

  // The header padding and the body's grid row both animate over the same 300ms
  // from the same `open` flag, so a toggle is one movement. Deferring the header
  // until the body had finished instead gave closing a second, later movement.

  const shell = inline
    ? "rounded-lg border border-outline bg-surface-alt/40"
    : "bg-surface rounded-lg shadow-sm border border-outline";
  const headerPad = inline
    ? `px-3 transition-[padding] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${open ? "py-2" : "py-2.5"}`
    : `px-4 sm:px-6 pt-4 sm:pt-6 transition-[padding] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${open ? "pb-3 sm:pb-4" : "pb-4 sm:pb-6"}`;
  const bodyPad = inline
    ? "border-t border-outline px-3 py-3"
    : "px-4 sm:px-6 pb-4 sm:pb-6";

  return (
    <div className={`${shell} ${className}`}>
      <div className={`flex items-center gap-3 ${headerPad}`}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left cursor-pointer"
        >
          <ChevronRight
            size={inline ? 14 : 16}
            className="shrink-0 text-on-surface-muted transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
            style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
          />
          {inline ? (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-on-surface-secondary">
                {title}
              </span>
              {summary && (
                <span className="min-w-0 truncate text-xs text-on-surface-muted">{summary}</span>
              )}
            </span>
          ) : (
            <span className="min-w-0">
              <span className="block text-lg font-semibold text-on-surface">{title}</span>
              {open && description && (
                <span className={SUBTEXT_CLASS}>{description}</span>
              )}
              {!open && summary && (
                <span className={`${SUBTEXT_CLASS} truncate`}>{summary}</span>
              )}
            </span>
          )}
        </button>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className={bodyPad}>{children}</div>
        </div>
      </div>
    </div>
  );
}
