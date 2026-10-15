"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Check } from "lucide-react";
import ListBusyIndicator from "@/components/ui/ListBusyIndicator";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListPager from "@/components/ui/ListPager";
import ListSkeleton from "@/components/ui/ListSkeleton";
import Spinner from "@/components/ui/Spinner";
import useSlidingHighlight from "@/hooks/useSlidingHighlight";

/**
 * A billing-style card list that replaces the AG Grid `DataGrid` for list pages.
 * Instead of columns it renders each row as a stacked card (bold title line +
 * muted meta line + right-aligned content), the same look the billing views use.
 *
 * It keeps the grid features the tables relied on: row selection with a
 * select-all control, client- or server-driven sorting (via a "Sort by"
 * dropdown rather than column headers) and pagination, per-row actions, and
 * click-to-open rows. The prop surface mirrors `DataGrid` so parents can swap
 * `columns` for `renderRow` and keep their existing selection/sort/paging logic.
 */

export type ListSelectionModel = (string | number)[];

export interface ListRow {
  /** Bold primary line. */
  title: React.ReactNode;
  /** Inline badges shown right after the title (status chips, etc.). */
  badges?: React.ReactNode;
  /** Muted secondary line under the title. */
  meta?: React.ReactNode;
  /** Right-aligned content block (amount, date, etc.). */
  right?: React.ReactNode;
  /** Disclosure content rendered directly below the row's primary band. */
  details?: React.ReactNode;
  /** Controls the disclosure animation when `details` is present. */
  detailsOpen?: boolean;
  /** Optional id connecting an expandable row to its disclosure panel. */
  detailsId?: string;
}

export interface ListSortColumn {
  label: string;
  value: string;
  /**
   * Client-mode comparator describing ASCENDING order. Descending reuses it
   * negated. Required when `sortingMode === "client"`; omit on server-mode
   * columns (the parent maps the field + direction to its own query).
   */
  compare?: (a: any, b: any) => number;
  /** Direction applied the first time this column is selected. Defaults to "asc". */
  defaultDir?: "asc" | "desc";
}

/** Sort direction for a `ListSortColumn`. */
export type SortDir = "asc" | "desc";

export interface ListViewProps<T = any> {
  variant?: "connected" | "separated";
  rows: T[];
  /** Initial load: replaces the list with skeleton rows. */
  loading?: boolean;
  /**
   * Background/server-page load. The rows already on screen stay put; the
   * indicator in the control strip and the clicked pager button carry the wait,
   * so paging never blanks the list.
   */
  fetching?: boolean;
  /**
   * Whether this list draws its own background-fetch indicator. Default true.
   *
   * Pass false when the surface already shows one for the same flag, as the two
   * events tabs do: they run three lists off one status filter and put a single
   * indicator beside it. Without this each list also reserved a row for an
   * indicator that duplicated that one, which read as a gap above the first
   * card. `fetching` still marks the rows `aria-busy` either way.
   */
  showFetchIndicator?: boolean;
  getRowId: (row: T) => string | number;
  /** Maps a row to its card content. */
  renderRow: (row: T) => ListRow;
  /** Per-row trailing action buttons (edit/delete/etc.), shown on hover-friendly area. */
  rowActions?: (row: T) => React.ReactNode;
  onRowClick?: (row: T) => void;

  /**
   * Content pinned to the start of the control strip, before the select-all and
   * sort controls · the list's title/count line. Putting it here rather than in
   * a heading row of its own keeps the strip to one band instead of two.
   */
  leading?: React.ReactNode;
  /**
   * Content pinned to the end of the control strip (bulk actions on the current
   * selection). Sits left of the "Updating results…" indicator.
   */
  trailing?: React.ReactNode;

  /** Sorting. "client" sorts in-memory via the active column's `compare`. */
  sortingMode?: "client" | "server";
  sortColumns?: ListSortColumn[];
  /** Controlled active field + direction (server mode). Omit to let ListView manage. */
  sortValue?: string;
  sortDir?: SortDir;
  onSortChange?: (value: string, dir: SortDir) => void;

  /** Pagination. "client" pages in-memory; "server" calls the page callbacks. */
  paginationMode?: "client" | "server";
  pageSizeOptions?: number[];
  defaultPageSize?: number;
  /** Server mode. */
  page?: number; // 0-based
  pageSize?: number;
  rowCount?: number;
  onPageChange?: (page: number) => void; // 0-based; also fires in client mode
  onPageSizeChange?: (pageSize: number) => void;
  /** Client mode: seed the page the list opens on (read once, like a default). */
  initialPage?: number; // 0-based
  /**
   * Pad a short list up to a full page of rows with empty filler rows, so the
   * grid is the same height whether it holds 3 rows or a full page. Set it on
   * full-width list pages, where a stubby card next to the page chrome reads as
   * a broken layout. Leave it off for lists embedded in a tab, panel, or modal,
   * where a large reserved empty area is worse than a short list.
   */
  reserveFullPage?: boolean;

  /** Selection. */
  showSelection?: boolean;
  selectionModel?: ListSelectionModel;
  onSelectionChange?: (ids: ListSelectionModel) => void;
  showSelectAll?: boolean;
  isAllSelected?: boolean;
  /**
   * Called when the select-all control is switched ON. A server-paged list uses it
   * to select the whole matching set, not just the rows it holds, so the handler
   * may be async (fetching the ids); pair it with `selectAllPending` to show that.
   */
  onSelectAll?: () => void;
  onClearSelection?: () => void;
  /** Marks the select-all control busy while `onSelectAll` resolves. */
  selectAllPending?: boolean;
  /**
   * Text on the select-all control. Defaults to the whole-set count ("Select all
   * 42" / "7 selected"); pass a value only when the list can say something more
   * accurate, e.g. a server-paged list whose total the parent owns.
   */
  selectAllLabel?: string;

  /** Empty state. */
  loadFailed?: boolean;
  emptyTitle?: string;
  emptyMessage?: string;
  emptyIcon?: React.ReactNode;
}

// Uniform row height (px). Every row is floored to this so a row missing its
// `meta` (description) line is the same height as one that has it, and so the
// list body can reserve a stable full-page height (below) without the grid
// growing and shrinking as rows or pages change. Sized to fully contain the
// tallest single-line row (title + status badge + meta line) so a full page is
// never taller than a padded partial page.
const ROW_HEIGHT = 68;

/** Visual-only checkbox box (a span, so it can live inside another button). */
function CheckboxBox({ checked }: { checked: boolean }) {
  return (
    <span
      className={`flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition ${
        checked
          ? "border-accent-solid bg-accent-solid text-accent-foreground"
          : "border-input-border bg-input-bg group-hover/check:border-on-surface-muted"
      }`}
    >
      {checked && <Check size={13} strokeWidth={3} />}
    </span>
  );
}

/** Interactive checkbox button. Only use where the parent is NOT a button. */
function Checkbox({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className="group/check flex"
    >
      <CheckboxBox checked={checked} />
    </button>
  );
}

export default function ListView<T = any>({
  variant = "connected",
  rows,
  loading = false,
  fetching,
  showFetchIndicator = true,
  getRowId,
  renderRow,
  rowActions,
  onRowClick,
  leading,
  trailing,

  sortingMode = "client",
  sortColumns = [],
  sortValue,
  sortDir,
  onSortChange,

  paginationMode = "client",
  pageSizeOptions = [10, 25, 50],
  defaultPageSize = 10,
  page,
  pageSize,
  rowCount,
  onPageChange,
  onPageSizeChange,
  initialPage,
  reserveFullPage = false,

  showSelection = false,
  selectionModel = [],
  onSelectionChange,
  showSelectAll = false,
  isAllSelected = false,
  onSelectAll,
  onClearSelection,
  selectAllPending = false,
  selectAllLabel,

  loadFailed = false,
  emptyTitle = "Nothing here yet",
  emptyMessage = "There's nothing to show with the current filters.",
  emptyIcon,
}: ListViewProps<T>) {
  // Guarded once here rather than at each use below. Memoized so a non-array
  // `rows` prop can't hand the memos below a fresh array on every render.
  const safeRows = useMemo(() => (Array.isArray(rows) ? rows : []), [rows]);

  // `fetching` stays optional (rather than defaulting to false) so the component
  // can tell a list that opts into fetch feedback from one that never will, and
  // reserve the busy line's space only for the former.
  const isFetching = fetching ?? false;

  // ----- Sorting -----
  // Each column toggles asc/desc on repeated clicks (like a column header).
  const firstColumn = sortColumns[0];
  const [internalField, setInternalField] = useState<string>(
    sortValue ?? firstColumn?.value ?? ""
  );
  const [internalDir, setInternalDir] = useState<SortDir>(
    sortDir ?? firstColumn?.defaultDir ?? "asc"
  );
  const activeField = sortValue ?? internalField;
  const activeDir = sortDir ?? internalDir;
  const sortPillHighlight = useSlidingHighlight<HTMLDivElement>(sortColumns.length > 0 ? activeField : null);

  const handleSortColumn = (col: ListSortColumn) => {
    const nextDir: SortDir =
      activeField === col.value
        ? activeDir === "asc"
          ? "desc"
          : "asc"
        : col.defaultDir ?? "asc";
    if (sortValue === undefined) setInternalField(col.value);
    if (sortDir === undefined) setInternalDir(nextDir);
    onSortChange?.(col.value, nextDir);
  };

  const sortedRows = useMemo(() => {
    if (sortingMode !== "client") return safeRows;
    const col = sortColumns.find((c) => c.value === activeField);
    if (!col?.compare) return safeRows;
    const mult = activeDir === "desc" ? -1 : 1;
    return [...safeRows].sort((a, b) => mult * col.compare!(a, b));
  }, [safeRows, sortingMode, sortColumns, activeField, activeDir]);

  // ----- Pagination -----
  const [internalPage, setInternalPage] = useState(initialPage ?? 0);
  const [internalPageSize, setInternalPageSize] = useState(defaultPageSize);
  // Mirrors the footer's own click acknowledgement, so the inline indicator
  // below can stay quiet while the pager button already carries the wait.
  const [pagerPending, setPagerPending] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror the page-size default when it changes
    setInternalPageSize(defaultPageSize);
  }, [defaultPageSize]);

  const serverMode = paginationMode === "server";
  const currentPageSize = serverMode ? pageSize ?? defaultPageSize : internalPageSize;
  const currentPage = serverMode ? page ?? 0 : internalPage;
  const totalRows = serverMode ? rowCount ?? 0 : sortedRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / Math.max(1, currentPageSize)));
  const safePage = Math.min(currentPage, totalPages - 1);

  // In client mode reset to the first page whenever the row set shrinks past the
  // current page (e.g. a filter change). Server mode owns its own page state.
  useEffect(() => {
    if (serverMode) return;
    if (internalPage > totalPages - 1) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clamp the page when the filtered set shrinks
      setInternalPage(Math.max(0, totalPages - 1));
    }
  }, [serverMode, internalPage, totalPages]);

  const pageRows = serverMode
    ? sortedRows
    : sortedRows.slice(safePage * currentPageSize, (safePage + 1) * currentPageSize);

  // A list only draws visual filler rows when its caller explicitly reserves a
  // full page. Otherwise its border ends after the final real row, including on
  // a partially filled last page.
  const reservedRows = reserveFullPage ? currentPageSize : pageRows.length;
  const fillerCount = Math.max(0, reservedRows - pageRows.length);

  const goToPage = (p: number) => {
    const clamped = Math.max(0, Math.min(totalPages - 1, p));
    if (serverMode) {
      if (clamped === safePage || isFetching) return;
      onPageChange?.(clamped);
    }
    else {
      setInternalPage(clamped);
      onPageChange?.(clamped);
    }
  };
  const changePageSize = (s: number) => {
    if (serverMode) onPageSizeChange?.(s);
    else {
      setInternalPageSize(s);
      setInternalPage(0);
    }
  };

  // ----- Selection -----
  const selectedSet = useMemo(
    () => new Set(selectionModel.map(String)),
    [selectionModel]
  );
  const visibleIds = useMemo(
    () => pageRows.map((r) => String(getRowId(r))),
    [pageRows, getRowId]
  );
  // What "select all" covers. In client mode the list holds every row, so it is
  // every row across every page (never just the slice on screen). In server mode
  // the rows here ARE one page; the parent supplies `onSelectAll` to reach the rest.
  const selectAllIds = useMemo(
    () => (serverMode ? visibleIds : sortedRows.map((r) => String(getRowId(r)))),
    [serverMode, visibleIds, sortedRows, getRowId]
  );
  const isRowSelected = (id: string) => isAllSelected || selectedSet.has(id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => isRowSelected(id));

  const toggleRow = (id: string) => {
    // Effective current selection: when "all" is on, expand it to the visible
    // ids so toggling one row off produces an explicit set (and clears "all").
    const base = isAllSelected ? new Set(visibleIds) : new Set(selectedSet);
    if (base.has(id)) base.delete(id);
    else base.add(id);
    onSelectionChange?.(Array.from(base));
  };

  const toggleAll = () => {
    if (selectAllPending) return;
    // The control is whole-set, not page-scoped, in both directions: any existing
    // selection means the next click clears it, and an empty one selects
    // everything. `onSelectAll` is the server-mode escape hatch, where the rest of
    // the matching set has to be fetched before it can be selected.
    if (selectedSet.size > 0 || isAllSelected) {
      // Falling back to an empty selection matters for lists that only supply
      // `onSelectionChange`: without it, unticking the control would do nothing.
      if (onClearSelection) onClearSelection();
      else onSelectionChange?.([]);
      return;
    }
    if (showSelectAll && onSelectAll) onSelectAll();
    else onSelectionChange?.(selectAllIds);
  };

  // Says what the toggle covers, so it can't be read as "this page only". A parent
  // that owns a truer total (a server-paged list) passes its own text instead.
  const resolvedSelectAllLabel =
    selectAllLabel ??
    (selectedSet.size > 0 || isAllSelected
      ? `${isAllSelected ? selectAllIds.length : selectedSet.size} selected`
      : `Select all ${totalRows}`);

  const showSortControls = sortColumns.length > 0 && pageRows.length > 0;
  const showControlStrip =
    (showSelection && pageRows.length > 0) || showSortControls || !!leading || !!trailing;
  // Skeletons only stand in when there is nothing to show. Once rows are on
  // screen a page change keeps them until the next page arrives, so the list
  // doesn't collapse and re-expand (which reads as a full page reload).
  const showSkeleton = loading || (isFetching && pageRows.length === 0);

  // Inline "still working" line. It rides in the control strip (which is already
  // on screen and tall enough to hold it) so appearing mid-fetch doesn't push the
  // list down. A page click is acknowledged by the pager button itself, so the
  // line stays out of the way then.
  const showBusy = isFetching && !pagerPending;

  return (
    <div className="space-y-4">
      {showControlStrip && (
        // `min-h-9` reserves height for the control strip (matching standard `h-9`
        // controls/buttons), so selecting items or rendering action buttons in
        // `trailing` never causes the control strip to shrink/grow and nudge the
        // list rows up or down.
        <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
          {leading}

          {showSelection && pageRows.length > 0 && (
            <button
              type="button"
              role="checkbox"
              aria-checked={allVisibleSelected || isAllSelected}
              aria-label={resolvedSelectAllLabel}
              onClick={toggleAll}
              disabled={selectAllPending}
              className="group/check flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium text-on-surface-secondary transition hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-60"
            >
              {selectAllPending ? (
                <Spinner size={16} />
              ) : (
                <CheckboxBox checked={allVisibleSelected || isAllSelected} />
              )}
              <span>{selectAllPending ? "Selecting…" : resolvedSelectAllLabel}</span>
            </button>
          )}

          {/* Mobile: trailing sits right after select-all, before sort pills wrap to
              the next line. Pushed to the far right of the first row with ml-auto. */}
          {trailing && (
            <div className="sm:hidden ml-auto">
              {trailing}
            </div>
          )}

          {showSortControls && (
            <div
              ref={sortPillHighlight.containerRef}
              // overflow-y-hidden: setting only overflow-x leaves the y-axis's
              // used value at `auto`, so a stray pixel of vertical overflow
              // would otherwise put a scrollbar on a strip that only scrolls
              // sideways.
              className="relative flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden rounded-xl border border-outline bg-surface-alt/40 p-1 scrollbar-hide"
            >
              <span className="shrink-0 px-1.5 text-[11px] font-semibold uppercase tracking-wide text-on-surface-muted">
                Sort
              </span>
              {sortPillHighlight.rect && (
                <span
                  aria-hidden
                  className="absolute inset-y-1 left-0 rounded-lg bg-surface shadow-sm ring-1 ring-inset ring-outline transition-[transform,width] duration-200 ease-out motion-reduce:transition-none"
                  style={{
                    width: sortPillHighlight.rect.width,
                    transform: `translateX(${sortPillHighlight.rect.left}px)`,
                  }}
                />
              )}
              {sortColumns.map((col) => {
                const active = activeField === col.value;
                return (
                  <button
                    key={col.value}
                    ref={sortPillHighlight.registerItem(col.value)}
                    type="button"
                    disabled={isFetching}
                    onClick={() => handleSortColumn(col)}
                    aria-pressed={active}
                    title={
                      active
                        ? `Sorted ${activeDir === "asc" ? "ascending" : "descending"}. Click to reverse.`
                        : `Sort by ${col.label}`
                    }
                    className={`relative z-10 inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      active
                        ? "text-on-surface"
                        : "text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface"
                    }`}
                  >
                    <span>{col.label}</span>
                    {active ? (
                      activeDir === "asc" ? (
                        <ArrowUp size={13} strokeWidth={2.5} className="text-accent-emphasis" />
                      ) : (
                        <ArrowDown size={13} strokeWidth={2.5} className="text-accent-emphasis" />
                      )
                    ) : (
                      <ChevronsUpDown size={13} className="opacity-30" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Desktop (sm+): trailing at the far right after sort pills. When there is
              no trailing only the busy indicator is needed, so keep the div visible. */}
          {(trailing || fetching !== undefined) && (
            <div className={`${trailing ? "hidden sm:flex" : "flex"} ml-auto items-center gap-3`}>
              <ListBusyIndicator busy={showBusy} />
              {trailing}
            </div>
          )}
        </div>
      )}

      {/* Lists with visible rows reserve a place for background-fetch feedback so
          the rows do not shift. Empty states render flush when there are no
          controls instead of retaining an invisible control-strip gap. */}
      {!showControlStrip && showFetchIndicator && fetching !== undefined && pageRows.length > 0 && (
        <div className="flex h-5 items-center">
          <ListBusyIndicator busy={showBusy} />
        </div>
      )}

      {showSkeleton ? (
        <ListSkeleton rows={Math.min(currentPageSize, 6)} />
      ) : pageRows.length === 0 ? (
        loadFailed ? null : <ListEmptyState title={emptyTitle} message={emptyMessage} icon={emptyIcon} />
      ) : (
        <>
          <div
            className={
              variant === "separated"
                ? "space-y-3"
                : "overflow-hidden rounded-xl border border-outline bg-surface"
            }
            aria-busy={isFetching}
          >
            {pageRows.map((row) => {
              const id = String(getRowId(row));
              const { title, badges, meta, right, details, detailsOpen = false, detailsId } = renderRow(row);
              const selected = isRowSelected(id);
              const clickable = !!onRowClick;
              return (
                // transform-gpu promotes each row to its own raster layer so its
                // bottom border snaps to integer device pixels. Without it Chrome
                // leaves a bright 1px antialiasing seam between rows when the list
                // reflows (e.g. on sort). The border lives on the row (not a shared
                // `divide-y`) so a reorder can't leave a ghost line behind.
                <div
                  key={id}
                  className={
                    variant === "separated"
                      ? "group transform-gpu overflow-hidden rounded-xl border border-outline bg-surface"
                      : "group transform-gpu border-b border-outline-subtle last:border-b-0"
                  }
                >
                  <div
                    onClick={clickable ? () => onRowClick!(row) : undefined}
                    style={{ minHeight: ROW_HEIGHT }}
                    aria-expanded={details != null ? detailsOpen : undefined}
                    aria-controls={details != null ? detailsId : undefined}
                    className={`flex items-start gap-3 px-4 py-3 transition-colors sm:items-center ${
                      clickable ? "cursor-pointer hover:bg-surface-hover" : ""
                    } ${selected ? "bg-accent-row-selected" : ""}`}
                  >
                    {showSelection && (
                      <div className="pt-0.5 sm:pt-0">
                        <Checkbox
                          checked={selected}
                          onChange={() => toggleRow(id)}
                          ariaLabel={selected ? "Deselect row" : "Select row"}
                        />
                      </div>
                    )}

                    {/* Content + trailing block. Stacks vertically on mobile (the
                        due date and row actions drop onto their own line below the
                        title) and lays out horizontally from `sm` up. */}
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="truncate text-sm font-semibold text-on-surface">
                            {title}
                          </span>
                          {badges}
                        </div>
                        {meta != null && (
                          <p className="mt-0.5 truncate text-xs text-on-surface-muted">{meta}</p>
                        )}
                      </div>

                      {(right != null || rowActions) && (
                        <div className="flex items-center justify-end gap-3 sm:shrink-0">
                          {right != null && <div className="mr-auto text-left sm:mr-0 sm:text-right">{right}</div>}

                          {rowActions && (
                            <div
                              className="flex shrink-0 items-center gap-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {rowActions(row)}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {details != null && (
                    <div
                      className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
                        detailsOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                      }`}
                    >
                      <div
                        id={detailsId}
                        className="overflow-hidden"
                        inert={!detailsOpen}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {details}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Empty filler rows pad a partial page up to a full page so the grid
                keeps a constant height. They carry the same bottom divider as real
                rows so the reserved space reads as part of the list. */}
            {Array.from({ length: fillerCount }).map((_, i) => (
              <div
                key={`filler-${i}`}
                aria-hidden
                style={{ minHeight: ROW_HEIGHT }}
                className="border-b border-outline-subtle last:border-b-0"
              />
            ))}
          </div>

        </>
      )}

      {/* Keep server pagination mounted while the next page loads. This makes
          the click acknowledge immediately instead of leaving a stale-looking
          list and an apparently unresponsive Next/Prev button. */}
      <ListPager
        page={safePage + 1}
        totalPages={totalPages}
        total={totalRows}
        rowsPerPage={currentPageSize}
        onPageChange={(p) => goToPage(p - 1)}
        busy={isFetching}
        serverPaged={serverMode}
        rowsPerPageOptions={pageSizeOptions}
        onRowsPerPageChange={changePageSize}
        onPendingChange={setPagerPending}
      />
    </div>
  );
}
