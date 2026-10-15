import { useMemo, useState } from "react";

/**
 * Pages a list that is already fully in memory.
 *
 * Billing's derived views compute their rows, and the money totals shown above
 * them, from the whole loaded set. Only the slice on screen is windowed, so the
 * totals stay firm-wide while the list stays a bounded length.
 *
 * The page is clamped on read rather than reset in an effect, so a filter that
 * shrinks the set lands on the last page still holding rows instead of
 * flickering through an out-of-range render.
 *
 * `resetKey` is what the caller is filtered/scoped by: a search string, a status
 * filter, the id of the folder being browsed. When it changes the list becomes a
 * different list, so paging restarts at the top. Without it, refining a search
 * from page 3 would silently show the third page of the new matches instead of
 * the best ones. Pass every input the row set depends on, joined into one value.
 */
export default function usePagedRows<T>(
  rows: T[],
  rowsPerPage = 10,
  resetKey?: unknown
) {
  const [page, setPage] = useState(1);

  // Adjusting state during render (rather than in an effect) so the new page is
  // used by this very render, with no intermediate frame on the stale page.
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    setPage(1);
  }

  const size = Math.max(1, rowsPerPage);
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const pagedRows = useMemo(
    () => rows.slice((safePage - 1) * size, safePage * size),
    [rows, safePage, size]
  );

  return { pagedRows, page: safePage, setPage, totalPages, total, rowsPerPage: size };
}
