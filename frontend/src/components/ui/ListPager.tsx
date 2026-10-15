"use client";

import { useEffect, useRef, useState } from "react";
import Dropdown from "@/components/ui/Dropdown";
import Spinner from "@/components/ui/Spinner";

/** Prev/Next button chrome, shared so every pager in the app draws the same button. */
const PAGER_BTN =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-outline px-3 text-sm font-medium text-on-surface-secondary transition-[background-color,transform] hover:bg-surface-hover active:scale-[0.96] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-40";

/** Page-size choices offered wherever the list's page size is adjustable. */
export const DEFAULT_ROWS_PER_PAGE_OPTIONS = [10, 25, 50];

/**
 * Whether a pager would draw anything for this many rows. Call sites that wrap
 * the pager in their own markup - a table row, a padded footer - guard on this so
 * the wrapper disappears along with the pager instead of leaving an empty shell.
 *
 * Mirrors the component's own threshold below: the SMALLEST page size on offer,
 * not the current one, so a reader who raises the page size past the row count
 * doesn't lose the control that would lower it again.
 */
export function pagerWillRender(
  total: number,
  rowsPerPageOptions: number[] = DEFAULT_ROWS_PER_PAGE_OPTIONS,
) {
  return total > Math.min(...rowsPerPageOptions);
}

export interface ListPagerProps {
  /** 1-based. */
  page: number;
  totalPages: number;
  /** Size of the whole matching set, not the page. */
  total: number;
  rowsPerPage: number;
  onPageChange: (page: number) => void;
  /**
   * True while the next page is in flight. Server-paged lists pass their query's
   * fetching flag; in-memory pagers leave it off.
   */
  busy?: boolean;
  /**
   * Set when changing page triggers a fetch. The clicked button then carries a
   * "Loading…" acknowledgement until the new page arrives, so the click doesn't
   * look ignored. In-memory pagers leave it off - their pages swap instantly, and
   * an acknowledgement would only flicker.
   */
  serverPaged?: boolean;
  /** Page-size control. Rendered only when both are supplied. */
  rowsPerPageOptions?: number[];
  onRowsPerPageChange?: (rowsPerPage: number) => void;
  /**
   * Reports whether a page click is still waiting on its data. A list that draws
   * its own "updating" indicator uses this to stay quiet while the pager button
   * is already carrying the wait, so one page change doesn't read as two.
   */
  onPendingChange?: (pending: boolean) => void;
}

/**
 * The Prev/Next footer for a paged list: an optional "Rows per page" control on
 * the left, and the "1–10 of 42" range plus the page buttons on the right.
 *
 * This is the only pager in the app - `ListView` draws its footer with it too - 
 * so paging looks and behaves the same on every list, matters and tasks
 * included. The wait for a server page is carried by the button that was
 * clicked rather than by a separate indicator, which is what tells the user
 * which direction is loading.
 */
export default function ListPager({
  page,
  totalPages,
  total,
  rowsPerPage,
  onPageChange,
  busy = false,
  serverPaged = false,
  rowsPerPageOptions,
  onRowsPerPageChange,
  onPendingChange,
}: ListPagerProps) {
  const [pendingDirection, setPendingDirection] = useState<"prev" | "next" | null>(null);
  const fetchStartedRef = useRef(false);

  useEffect(() => {
    if (busy) {
      fetchStartedRef.current = true;
      return;
    }
    if (!pendingDirection) {
      fetchStartedRef.current = false;
      return;
    }
    if (fetchStartedRef.current) {
      fetchStartedRef.current = false;
      setPendingDirection(null);
      return;
    }

    // Returning to a cached page may never produce an observable busy render.
    // Clear the click acknowledgement after a short window so the button cannot
    // stay stuck on "Loading…".
    const cachedPageTimer = window.setTimeout(() => setPendingDirection(null), 250);
    return () => window.clearTimeout(cachedPageTimer);
  }, [busy, pendingDirection]);

  // Held in a ref so an inline arrow from the parent doesn't re-run the report,
  // and so unmounting (the footer hiding once a filter shrinks the set) can still
  // clear a pending click that will now never resolve.
  const onPendingChangeRef = useRef(onPendingChange);
  onPendingChangeRef.current = onPendingChange;
  useEffect(() => {
    onPendingChangeRef.current?.(pendingDirection !== null);
  }, [pendingDirection]);
  useEffect(() => () => onPendingChangeRef.current?.(false), []);

  // Nothing to page through yet. The threshold is the SMALLEST page size on
  // offer, not the current one, so raising the page size past the row count
  // can't hide the control that would lower it again.
  const smallestPageSize = rowsPerPageOptions?.length
    ? Math.min(...rowsPerPageOptions)
    : rowsPerPage;
  if (total <= smallestPageSize) return null;

  const safePage = Math.min(Math.max(1, page), Math.max(1, totalPages));

  const goToPage = (next: number) => {
    const clamped = Math.max(1, Math.min(totalPages, next));
    if (clamped === safePage) return;
    if (serverPaged) {
      if (busy) return;
      fetchStartedRef.current = false;
      setPendingDirection(clamped > safePage ? "next" : "prev");
    }
    onPageChange(clamped);
  };

  const start = total === 0 ? 0 : (safePage - 1) * rowsPerPage + 1;
  const end = Math.min(safePage * rowsPerPage, total);
  const showRowsPerPage = Boolean(rowsPerPageOptions?.length && onRowsPerPageChange);
  const rangeDigits = String(total).length;
  const widestRange = `${"0".repeat(rangeDigits)}–${"0".repeat(rangeDigits)} of ${total}`;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      {showRowsPerPage ? (
        <div className="flex shrink-0 items-center gap-2">
          <span className="whitespace-nowrap text-xs text-on-surface-secondary">
            Rows per page:
          </span>
          <Dropdown
            value={String(rowsPerPage)}
            onChange={(v) => onRowsPerPageChange!(Number(v))}
            options={rowsPerPageOptions!.map((n) => ({ value: String(n), label: String(n) }))}
            busy={busy}
            // Render in a body portal and flip above the button. The footer sits at
            // the bottom of the page, so a downward menu would spill off-screen.
            portal
            menuOffset={-3}
            buttonClassName="pl-2 pr-6 py-0.5 bg-input-bg text-on-surface text-xs border-input-border rounded-md"
            className="w-auto"
          />
        </div>
      ) : (
        // Holds the buttons at the end of the row when there is no page-size
        // control. Hidden on mobile, where the row stacks and an empty first
        // child would only add a gap.
        <span aria-hidden className="hidden sm:block" />
      )}

      <div className="flex items-center gap-3">
        {/* Reserves the widest this range can ever render for this `total` (every
            digit is the same width via `tabular-nums`, so only digit COUNT matters),
            stacked under the real text via grid. Without it, "1–5 of 85" and
            "81–85 of 85" render at different widths and the Prev/Next buttons visibly
            shift sideways every time the page changes. */}
        <span className="relative inline-grid text-sm text-on-surface-secondary">
          <span aria-hidden className="invisible col-start-1 row-start-1 whitespace-nowrap tabular-nums">
            {widestRange}
          </span>
          <span className="col-start-1 row-start-1 whitespace-nowrap tabular-nums">
            {start}–{end} of {total}
          </span>
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => goToPage(safePage - 1)}
            disabled={busy || pendingDirection !== null || safePage <= 1}
            className={PAGER_BTN}
          >
            {pendingDirection === "prev" ? (
              <>
                <Spinner size={13} /> Loading…
              </>
            ) : (
              "Prev"
            )}
          </button>
          <button
            type="button"
            onClick={() => goToPage(safePage + 1)}
            disabled={busy || pendingDirection !== null || safePage >= totalPages}
            className={PAGER_BTN}
          >
            {pendingDirection === "next" ? (
              <>
                <Spinner size={13} /> Loading…
              </>
            ) : (
              "Next"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The slice of a `usePagedRows` result that `AutoPager` needs. */
export interface PagerState {
  page: number;
  totalPages: number;
  total: number;
  rowsPerPage: number;
  setPage: (page: number) => void;
}

/**
 * Draws a `ListPager` for a `usePagedRows` result. Saves every call site
 * repeating the same prop spread. (The pager itself renders nothing while the
 * set still fits on one page.)
 */
export function AutoPager({
  pager,
  busy,
  serverPaged,
}: {
  pager: PagerState;
  busy?: boolean;
  serverPaged?: boolean;
}) {
  return (
    <ListPager
      page={pager.page}
      totalPages={pager.totalPages}
      total={pager.total}
      rowsPerPage={pager.rowsPerPage}
      onPageChange={pager.setPage}
      busy={busy}
      serverPaged={serverPaged}
    />
  );
}
