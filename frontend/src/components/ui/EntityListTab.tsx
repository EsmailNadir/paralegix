"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import ListView, { type ListRow } from "./ListView";
import Dropdown, { type DropdownOption } from "./Dropdown";
import Button from "@/components/ui/Button";
import SearchInput from "@/components/ui/SearchInput";

/**
 * A tab that lists one parent's matters or tasks: a search box and a status
 * dropdown over a `ListView`, with a create button on the right.
 *
 * `EntityMattersTab` and `EntityTasksTab` were the same component twice, down
 * to the toolbar markup and the "No matching x" empty state. What actually
 * differs is what a row looks like and what counts as a match, so those are the
 * props; everything else is here.
 */
export default function EntityListTab<T>({
  rows,
  getRowId,
  onRowClick,
  searchPlaceholder,
  matchesSearch,
  statusOptions,
  matchesStatus,
  create,
  renderRow,
  rowActions,
  emptyIcon,
  emptyTitle,
  emptyMessage,
  noMatchTitle,
  search,
  status,
}: {
  rows: T[];
  getRowId: (row: T) => string;
  onRowClick: (row: T) => void;
  searchPlaceholder: string;
  /** Whether a row survives the typed term. The term is already lower case. */
  matchesSearch: (row: T, term: string) => boolean;
  statusOptions: DropdownOption[];
  /** Whether a row survives the chosen status. "all" never reaches this. */
  matchesStatus: (row: T, status: string) => boolean;
  create?: { label: string; onClick: () => void };
  /** The card for one row. `term` is the live search text, for highlighting. */
  renderRow: (row: T, term: string) => ListRow;
  rowActions?: (row: T) => ReactNode;
  emptyIcon: ReactNode;
  emptyTitle: string;
  emptyMessage: string;
  /** Shown instead of `emptyTitle` once a search or filter is narrowing. */
  noMatchTitle: string;
  /**
   * Hand the search to the parent, for a list the server searches. The box then
   * shows and edits the parent's term, and `matchesSearch` is not applied: the
   * rows passed in are already the matches.
   */
  search?: { value: string; onChange: (value: string) => void };
  /**
   * Hand the status filter to the parent, for a list the server pages. Filtering
   * one server page in the browser would only narrow the rows already loaded, so
   * the dropdown shows and edits the parent's value and `matchesStatus` is not
   * applied: the rows passed in are already the matches.
   */
  status?: { value: string; onChange: (value: string) => void };
}) {
  const [localSearchTerm, setLocalSearchTerm] = useState("");
  const searchTerm = search ? search.value : localSearchTerm;
  const setSearchTerm = search ? search.onChange : setLocalSearchTerm;
  const [localStatusFilter, setLocalStatusFilter] = useState("all");
  const statusFilter = status ? status.value : localStatusFilter;
  const setStatusFilter = status ? status.onChange : setLocalStatusFilter;

  const filtered = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return rows.filter(
      (row) =>
        (search || !searchTerm || matchesSearch(row, term)) &&
        (status || statusFilter === "all" || matchesStatus(row, statusFilter)),
    );
    // The two predicates are defined inline by every caller, so depending on
    // them would rebuild this list on every render and defeat the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, searchTerm, statusFilter, search, status]);

  const narrowing = Boolean(searchTerm) || statusFilter !== "all";

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
          <SearchInput
            className="flex-1 min-w-[200px] max-w-md"
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            value={searchTerm}
            onChange={setSearchTerm}
          />
          <Dropdown
            value={statusFilter}
            onChange={setStatusFilter}
            options={statusOptions}
            className="w-40"
          />
        </div>

        {create && (
          <Button
            size="compact"
            onClick={create.onClick}
            icon={<Plus size={14} strokeWidth={2.2} />}
          >
            {create.label}
          </Button>
        )}
      </div>

      <ListView
        variant="separated"
        rows={filtered}
        getRowId={getRowId}
        onRowClick={onRowClick}
        renderRow={(row: T) => renderRow(row, searchTerm)}
        rowActions={rowActions}
        emptyIcon={emptyIcon}
        emptyTitle={narrowing ? noMatchTitle : emptyTitle}
        emptyMessage={narrowing ? "Try adjusting your search or filter settings." : emptyMessage}
      />
    </div>
  );
}
