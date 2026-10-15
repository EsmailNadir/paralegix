"use client";

import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import Button from "@/components/ui/Button";
import ActionIconButton from "@/components/ui/ActionIconButton";
import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import DateRangePicker from "@/components/ui/DateRangePicker";
import ListToolbar from "@/components/ui/ListToolbar";
import ClearFiltersButton from "@/components/ui/ClearFiltersButton";
import ListView, { type ListRow, type ListSortColumn, type SortDir } from "@/components/ui/ListView";
import { DEFAULT_ROWS_PER_PAGE_OPTIONS } from "@/components/ui/ListPager";
import useFirmTimeEntriesTable, {
  type FirmTimeEntriesTableOptions,
  type FirmTimeEntrySortField,
} from "@/hooks/billingHooks/useFirmTimeEntriesTable";
import type { EnrichedTimeEntry } from "@/hooks/billingHooks/useFirmTimeEntries";
import type { TimerStartParams } from "@/hooks/billingHooks/useTimer";
import useCanActOnTimeEntry from "@/hooks/billingHooks/useCanActOnTimeEntry";
import BulkActionsMenu from "@/components/filesComp/BulkActionsMenu";
import TimeEntryModal, { type TimerPrefill } from "@/components/billingComp/TimeEntryModal";
import { invoiceComposerPath, useBillNowRedirect } from "@/hooks/billingHooks/useBillNowRedirect";
import TimerWidget from "@/components/billingComp/TimerWidget";
import billingService from "@/services/billing.service";
import useChargeCodes from "@/hooks/chargeCodeHooks/useChargeCodes";
import { useLawFirmUsers } from "@/hooks/useUsers";
import { useBillingTimer } from "@/contexts/BillingTimerContext";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useAuth } from "@/hooks/useAuth";
import type { BillingContext, User } from "@/types";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { bulkFailureMessage } from "@/lib/utils/bulkRequests";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { Clock3, Play, Trash2, Pencil, Clock, Receipt } from "lucide-react";
import { formatHoursMinutes } from "@/lib/utils/format";
import { formatCurrency } from "@/components/billingComp/utils";
import FieldLabel from "@/components/ui/FieldLabel";

/** The fields the shared list reads off every row, whatever else a parent adds. */
export type EntityTimeEntryRow = { id: string; billable?: boolean | null; userId?: string | null };

/** Charge code id -> "CODE - Name", for the row meta and the row mapping. */
export type ChargeCodeLabels = Record<string, string>;

/**
 * What the time-entry tab is listing time for. The matter page and the client
 * page both show a parent's unbilled time with the same header, filters, list,
 * row actions, bulk delete and log-time modal, so the flow lives here once and
 * each parent supplies only the parts that are genuinely its own.
 */
export type EntityTimeEntriesTarget<TRow extends EntityTimeEntryRow> = {
  /** Scope and billing-status defaults for the paged firm time-entry read. */
  tableOptions: FirmTimeEntriesTableOptions;
  /**
   * Reshapes a served entry into the row this parent renders. Absent: the
   * served entries are the rows.
   */
  toRow?: (entry: EnrichedTimeEntry, chargeCodeLabels: ChargeCodeLabels) => TRow;
  /** The card for one row. */
  renderRow: (row: TRow, chargeCodeLabels: ChargeCodeLabels) => ListRow;
  /** The time entry's own id, which the delete routes take. */
  entryIdOf: (row: TRow) => string;
  /** A locked row cannot be edited, deleted or billed, and bulk delete skips it. */
  isLocked: (row: TRow) => boolean;
  /** The billing context a single delete is sent under. */
  deleteContextOf: (row: TRow) => BillingContext;
  /** The `type:id` context whose invoice composer the Bill action opens. */
  billContextOf: (row: TRow) => string;
  /** Whether a running timer belongs to this parent, so it shows inline here. */
  ownsTimer: (timer: { matterId?: string | null; clientId?: string | null }) => boolean;
  /** What Start Timer starts. */
  timerStart: TimerStartParams;
  /** Shows the "keeps running in the background" note under the inline timer. */
  showTimerNote: boolean;
  /** Label of the header button that leads to the parent's billing. */
  goToBillingLabel: string;
  /** The Member filter's choices, after its "All Members" entry. */
  memberOptions: DropdownOption[];
  /** Maps a picked Member value to the filter value. Absent: the value as picked. */
  normalizeMemberFilter?: (value: string) => string;
  /** How the log/edit modal is scoped. */
  modal: {
    defaultTarget: `matter:${string}` | `client:${string}`;
    scopeMatterId?: string;
    scopeClientId?: string;
    /**
     * The members the modal offers. Absent: the firm roster, loaded the first
     * time the modal opens rather than with the list.
     */
    users?: User[];
  };
  /** Prefills the form that Log Time opens. */
  logTimePrefill?: (userId: string | null) => TimerPrefill;
  /** Log Time also dismisses the error banner. */
  logTimeClearsError?: boolean;
  /** Replaces the list's own refetch after a mutation. */
  reload?: () => Promise<void>;
  /** Called after every reload that follows a mutation. */
  onRefresh?: () => void;
};

type Props<TRow extends EntityTimeEntryRow> = {
  lawFirmId: string;
  target: EntityTimeEntriesTarget<TRow>;
  onGoToBilling?: () => void;
};

type TimeEntryModalProps = ComponentProps<typeof TimeEntryModal>;

/**
 * The modal over the firm roster. The roster feeds only this modal, so it loads
 * when the modal first opens. The cache key is shared, so reopening does not
 * refetch.
 */
function FirmRosterTimeEntryModal(props: Omit<TimeEntryModalProps, "users">) {
  const { users } = useLawFirmUsers(props.lawFirmId, props.open);
  return <TimeEntryModal {...props} users={users} />;
}

// Sorting is the server's: each of these maps to a comparator that orders the
// whole match set. No `compare` functions - a browser-side comparator on a
// paged list can only reorder the rows already downloaded, which would present
// "sort by amount" while sorting one page.
const TABLE_SORT_COLUMNS: ListSortColumn[] = [
  { label: "Date", value: "date", defaultDir: "desc" },
  { label: "Member", value: "member" },
  { label: "Hours", value: "hours", defaultDir: "desc" },
  { label: "Amount", value: "amount", defaultDir: "desc" },
];

export default function EntityTimeEntriesTab<TRow extends EntityTimeEntryRow>({
  lawFirmId,
  target,
  onGoToBilling,
}: Props<TRow>) {
  const billingTimer = useBillingTimer();
  const { user } = useAuth();
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canManageTimeEntries = hasPermission("billing.manageTimeEntries");
  // The list read answers 403 without this, and a failed read is shown here as an
  // error banner, so the table is not requested at all for a member who lacks it.
  const canViewTimeEntries = hasPermission("billing.viewTimeEntries");
  // Bill opens the invoice composer, which needs invoice rights that time-entry rights do not imply.
  const canBill = hasPermission("billing.manageInvoices");
  const { canActOnEntry } = useCanActOnTimeEntry();
  const { chargeCodes } = useChargeCodes(lawFirmId);
  const { toRow, renderRow } = target;

  const [error, setError] = useState<string | null>(null);
  const [addTimeEntryOpen, setAddTimeEntryOpen] = useState(false);
  const [timeEntryPrefill, setTimeEntryPrefill] = useState<TimerPrefill | null>(null);
  const [editingEntry, setEditingEntry] = useState<TRow | null>(null);

  // Table filters
  const [filterUserId, setFilterUserId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<(string | number)[]>([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  /**
   * How many entries a running bulk delete is removing, so the dialog names the
   * work rather than leaving its question up beside a spinner. A count, not a
   * progress figure: the whole selection goes in ONE request, so there is no
   * per-item settling to count up.
   */
  const [bulkPendingCount, setBulkPendingCount] = useState<number | null>(null);

  // Delete confirmation state
  const [entryToDelete, setEntryToDelete] = useState<TRow | null>(null);
  const [deletingEntry, setDeletingEntry] = useState(false);
  const [showBulkDelete, setShowBulkDelete] = useState(false);

  const chargeCodeMap = useMemo(() => {
    const map: ChargeCodeLabels = {};
    for (const cc of chargeCodes) {
      map[cc.id] = `${cc.code} - ${cc.name}`;
    }
    return map;
  }, [chargeCodes]);

  const table = useFirmTimeEntriesTable(lawFirmId, {
    ...target.tableOptions,
    enabled: (target.tableOptions.enabled ?? true) && canViewTimeEntries,
  });
  const { setFilter, handleRequestSort, refetch } = table;

  const rows = useMemo(
    () => (toRow ? table.rows.map((entry) => toRow(entry, chargeCodeMap)) : (table.rows as unknown as TRow[])),
    [table.rows, toRow, chargeCodeMap],
  );

  const [sortValue, setSortValue] = useState<string>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const handleSortChange = useCallback(
    (value: string, dir: SortDir) => {
      setSortValue(value);
      setSortDir(dir);
      handleRequestSort([{ field: value as FirmTimeEntrySortField, sort: dir }]);
    },
    [handleRequestSort],
  );

  // Date range and member are server filters, so they narrow every entry the
  // parent has rather than the ones a first request happened to load.
  useEffect(() => { setFilter("dateFrom", dateFrom || undefined); }, [dateFrom, setFilter]);
  useEffect(() => { setFilter("dateTo", dateTo || undefined); }, [dateTo, setFilter]);
  useEffect(() => { setFilter("userId", filterUserId.trim() || undefined); }, [filterUserId, setFilter]);

  /** Reloads the list after a mutation, by the parent's own rule. */
  const reloadAfterMutation = async () => {
    if (target.reload) await target.reload();
    else await refetch();
    setSelectedIds([]);
    target.onRefresh?.();
  };

  const handleLogTime = () => {
    if (!canManageTimeEntries) return;
    if (target.logTimePrefill) setTimeEntryPrefill(target.logTimePrefill(user?.uid || null));
    if (target.logTimeClearsError) setError(null);
    setAddTimeEntryOpen(true);
  };

  const handleStartTimer = () => {
    if (!canManageTimeEntries) return;
    billingTimer.startTimer(target.timerStart);
  };

  const handleEdit = (row: TRow) => {
    if (target.isLocked(row)) {
      setError("Billed entries are read-only from this view.");
      return;
    }
    setEditingEntry(row);
  };

  /**
   * Billing is a property of the whole context, not of the row that was clicked:
   * an invoice covers a context's outstanding work, and the composer is where
   * what goes on it is confirmed. The parent names which context a row bills
   * through. One context, so the context's own composer, the same screen
   * "bill now" in the modal opens.
   */
  const handleBill = (row: TRow) => {
    const [type, entityId] = target.billContextOf(row).split(":");
    if (!entityId || (type !== "matter" && type !== "client")) return;
    navigate(invoiceComposerPath(lawFirmId, { type, entityId }));
  };

  const handleDelete = (row: TRow) => {
    if (target.isLocked(row)) {
      setError("Billed entries are read-only from this view.");
      return;
    }
    setEntryToDelete(row);
  };

  const confirmDelete = async () => {
    if (!entryToDelete) return;
    setDeletingEntry(true);
    try {
      await billingService.deleteTimeEntry(target.deleteContextOf(entryToDelete), target.entryIdOf(entryToDelete));
      await reloadAfterMutation();
      setEntryToDelete(null);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete time entry"));
    } finally {
      setDeletingEntry(false);
    }
  };

  const handleBulkDelete = () => {
    if (selectedIds.length === 0) return;
    setShowBulkDelete(true);
  };

  const confirmBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setBulkDeleting(true);
    const selectedEntries = selectedIds
      .map((id) => rows.find((row) => String(row.id) === String(id)))
      .filter((row): row is TRow => Boolean(row));
    // Locked rows are read-only wherever they are listed, which is why their own
    // row Delete button is disabled. They are skipped rather than attempted, so
    // they never come back as failures: they were never sent. Same rule as
    // `billingComp/BillingTimeEntriesView`.
    // Another member's entry is skipped too when the viewer may not delete other
    // members' time: the API refuses a selection that contains one outright.
    const unlocked = selectedEntries.filter((row) => !target.isLocked(row));
    const deletable = unlocked.filter((row) => canActOnEntry(row));
    const nonDeletableCount = selectedEntries.length - unlocked.length;
    const othersCount = unlocked.length - deletable.length;
    // A row id can differ from the entry id (one entry can be listed under more
    // than one attribution), so the route gets the entry ids and the answer is
    // mapped back through them.
    const entryIdOf = (row: TRow) => String(target.entryIdOf(row));
    setBulkPendingCount(deletable.length);
    try {
      // ONE request for the whole selection, answering per entry so a run that
      // half-succeeds can still be reported as one.
      const outcome = await billingService.bulkDeleteTimeEntries(
        lawFirmId,
        deletable.map(entryIdOf),
      );
      const refused = new Set(outcome.failed);
      const result = {
        succeeded: deletable.filter((row) => !refused.has(entryIdOf(row))),
        failed: outcome.failed.map((id) => ({ item: id, error: outcome.errors?.[id] })),
      };
      const readOnlyNote = nonDeletableCount > 0
        ? nonDeletableCount === 1
          ? "1 billed entry is read-only and was not deleted."
          : `${nonDeletableCount} billed entries are read-only and were not deleted.`
        : "";
      const othersNote = othersCount > 0
        ? `${othersCount} ${othersCount === 1 ? "entry" : "entries"} logged by other members ${othersCount === 1 ? "was" : "were"} not deleted.`
        : "";
      const failureNote = result.failed.length
        ? bulkFailureMessage(result, "deleted", "time entries")
        : "";
      // Only the entries that failed stay selected, so a retry cannot re-send a
      // delete that already went through. A skipped row drops out of the
      // selection with the rows that did delete: reselecting it would not make
      // it any more deletable.
      await reloadAfterMutation();
      // After the reload, not before: the reload empties the selection on its
      // own, so the entries that failed have to be put back afterwards to stay
      // available for a retry. Put back by ROW id, since that is what the list
      // selects by.
      setSelectedIds(deletable.filter((row) => refused.has(entryIdOf(row))).map((row) => row.id));
      setShowBulkDelete(false);
      setError([readOnlyNote, othersNote, failureNote].filter(Boolean).join(" ") || null);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete entries"));
    } finally {
      setBulkDeleting(false);
      setBulkPendingCount(null);
    }
  };

  // Hours and value of every entry matching the current filters, computed by the
  // server over the whole set. Deliberately NOT a reduce over `rows`: that would
  // total the rows on screen and label the result the parent's.
  const totalHours = table.summary.totalHours;
  const totalAmount = table.summary.totalAmount;

  const inlineTimerVisible = billingTimer.isActive && target.ownsTimer(billingTimer);

  useEffect(() => {
    billingTimer.setFloatingSuppressed(inlineTimerVisible);
    return () => billingTimer.setFloatingSuppressed(false);
  }, [billingTimer, inlineTimerVisible]);

  const renderTableRow = useCallback(
    (row: TRow): ListRow => renderRow(row, chargeCodeMap),
    [renderRow, chargeCodeMap],
  );

  const activeFilterCount = (filterUserId ? 1 : 0) + (dateFrom || dateTo ? 1 : 0);
  const clearAllFilters = () => {
    setFilterUserId("");
    setDateFrom("");
    setDateTo("");
  };

  const canBulkSelect = canManageTimeEntries && rows.length > 0;

  useEffect(() => {
    if (!canBulkSelect && selectedIds.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears stale selection when bulk-select becomes unavailable
      setSelectedIds([]);
    }
  }, [canBulkSelect, selectedIds.length]);

  // Drop the selection whenever the rows are replaced. Bulk actions resolve the
  // ticked ids against the rows on screen, so an id from a page that has been
  // paged, sorted or filtered away would be silently skipped while still being
  // counted in the confirmation.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the selection describes one page of rows; a new page is a different set
    setSelectedIds([]);
  }, [table.page, table.rowsPerPage, table.sortModel, table.filters]);

  const inlineTimer = (
    <TimerWidget
      variant="inline"
      isActive={billingTimer.isActive}
      isRunning={billingTimer.isRunning}
      targetLabel={billingTimer.targetLabel}
      formattedTime={billingTimer.formattedTime}
      description={billingTimer.description}
      onPause={billingTimer.pauseTimer}
      onResume={billingTimer.resumeTimer}
      onStop={billingTimer.stopTimer}
      onDiscard={billingTimer.discardTimer}
      onUpdateDescription={billingTimer.updateTimerDescription}
    />
  );

  const closeTimeEntryModal = useCallback(() => {
    setAddTimeEntryOpen(false);
    setEditingEntry(null);
    setTimeEntryPrefill(null);
  }, []);
  // Closes the modal, then opens the composer when the save chose "bill now".
  const billNowRedirect = useBillNowRedirect(lawFirmId, closeTimeEntryModal);

  const timeEntryModalProps: Omit<TimeEntryModalProps, "users"> = {
    open: addTimeEntryOpen || Boolean(editingEntry),
    entry: editingEntry as unknown as EnrichedTimeEntry | null,
    onClose: closeTimeEntryModal,
    lawFirmId,
    chargeCodes,
    defaultUserId: user?.uid,
    defaultTarget: target.modal.defaultTarget,
    scopeMatterId: target.modal.scopeMatterId,
    scopeClientId: target.modal.scopeClientId,
    prefill: timeEntryPrefill,
    onSuccess: async (result) => {
      await reloadAfterMutation();
      billNowRedirect(result);
    },
  };

  return (
    <div>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-0 mb-6">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-on-surface">Time Entries</h3>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-on-surface-secondary">
            <span>
              Total Hours: <strong className="text-on-surface">{formatHoursMinutes(totalHours)}</strong>
            </span>
            <span>
              Total Amount: <strong className="text-on-surface">{formatCurrency(totalAmount)}</strong>
            </span>
          </div>
        </div>
        {canManageTimeEntries && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {onGoToBilling && (
              <Button
                type="secondary"
                size="compact"
                onClick={onGoToBilling}
                icon={<Receipt size={14} />}
                className="w-full sm:w-auto"
              >
                {target.goToBillingLabel}
              </Button>
            )}
            <Button
              type="secondary"
              size="compact"
              onClick={handleStartTimer}
              icon={<Play size={14} />}
              className="w-full sm:w-auto"
            >
              Start Timer
            </Button>
            <Button
              size="compact"
              onClick={handleLogTime}
              icon={<Clock3 size={14} />}
              className="w-full sm:w-auto"
            >
              Log Time
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-6 md:space-y-4">
      {inlineTimerVisible && (
        target.showTimerNote ? (
          <div>
            {inlineTimer}
            {billingTimer.isActive && (
              <p className="text-xs text-on-surface-muted mt-1.5 ml-1">
                Timer keeps running in the background, even if you navigate away or close the tab. You can stop it from anywhere using the floating timer.
              </p>
            )}
          </div>
        ) : (
          inlineTimer
        )
      )}

      {(error || table.error) && (
        <div className="mb-5 md:mb-4">
          <ErrorNotification
            error={error || (table.error instanceof Error ? table.error.message : "Failed to load time entries")}
            onClose={() => setError(null)}
          />
        </div>
      )}

      <ListToolbar>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <Dropdown
            label="Member"
            value={filterUserId}
            onChange={(value) =>
              setFilterUserId(target.normalizeMemberFilter ? target.normalizeMemberFilter(value) : value || "")
            }
            options={[{ value: "", label: "All Members" }, ...target.memberOptions]}
            className="w-full sm:w-44"
          />
          <div className="flex flex-col gap-1">
            <FieldLabel>Date Range</FieldLabel>
            <DateRangePicker
              from={dateFrom}
              to={dateTo}
              onChange={(next) => {
                setDateFrom(next.from ?? "");
                setDateTo(next.to ?? "");
              }}
              className="w-full sm:w-[280px]"
            />
          </div>
          <ClearFiltersButton count={activeFilterCount} onClear={clearAllFilters} className="sm:mb-0.5" />
        </div>
      </ListToolbar>

      <ListView<TRow>
        rows={rows}
        loading={table.loading}
        fetching={table.fetching}
        getRowId={(row) => row.id}
        renderRow={renderTableRow}
        rowActions={
          canManageTimeEntries
            ? (row) => {
                const locked = target.isLocked(row);
                const ownsEntry = canActOnEntry(row);
                return (
                  <>
                    {canBill && !locked && row.billable !== false && (
                      <Button
                        type="secondary"
                        size="small"
                        icon={<Receipt size={14} />}
                        onClick={() => handleBill(row)}
                      >
                        Bill
                      </Button>
                    )}
                    {ownsEntry && (
                      <>
                        <ActionIconButton
                          label={locked ? "Invoiced time cannot be edited" : "Edit"}
                          disabled={locked}
                          onClick={() => handleEdit(row)}
                        >
                          <Pencil size={15} />
                        </ActionIconButton>
                        <ActionIconButton
                          label={locked ? "Invoiced time cannot be deleted" : "Delete"}
                          tone="danger"
                          disabled={locked}
                          onClick={() => handleDelete(row)}
                        >
                          <Trash2 size={15} />
                        </ActionIconButton>
                      </>
                    )}
                  </>
                );
              }
            : undefined
        }
        // Server-driven sort and pagination: the table renders the current
        // server page and re-queries on a sort or page change, so both act on
        // every entry rather than the ones already downloaded. ListView pages
        // are 0-based; the table hook's are 1-based.
        sortingMode="server"
        sortColumns={TABLE_SORT_COLUMNS}
        sortValue={sortValue}
        sortDir={sortDir}
        onSortChange={handleSortChange}
        paginationMode="server"
        page={table.page - 1}
        pageSize={table.rowsPerPage}
        rowCount={table.total}
        onPageChange={(p) => table.setPage(p + 1)}
        onPageSizeChange={table.setRowsPerPage}
        defaultPageSize={table.rowsPerPage}
        pageSizeOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
        showSelection={canBulkSelect}
        selectionModel={selectedIds}
        onSelectionChange={(ids) => setSelectedIds(ids)}
        trailing={
          selectedIds.length > 0 ? (
            <BulkActionsMenu
              count={selectedIds.length}
              actions={[
                {
                  key: "delete",
                  label: `Delete (${selectedIds.length})`,
                  icon: <Trash2 size={15} />,
                  danger: true,
                  disabled: bulkDeleting,
                  onClick: handleBulkDelete,
                },
              ]}
            />
          ) : undefined
        }
        emptyIcon={<Clock size={40} />}
        emptyTitle="No time entries"
        emptyMessage="No time entries match your filters."
      />
      </div>

      {target.modal.users ? (
        <TimeEntryModal {...timeEntryModalProps} users={target.modal.users} />
      ) : (
        <FirmRosterTimeEntryModal {...timeEntryModalProps} />
      )}

      <ConfirmModal
        isOpen={entryToDelete !== null}
        onClose={() => setEntryToDelete(null)}
        onConfirm={confirmDelete}
        title="Delete time entry"
        message="Are you sure you want to delete this time entry? This cannot be undone."
        confirmText="Delete"
        loading={deletingEntry}
      />

      <ConfirmModal
        isOpen={showBulkDelete}
        onClose={() => setShowBulkDelete(false)}
        onConfirm={confirmBulkDelete}
        title="Delete time entries"
        message={bulkPendingCount !== null
          ? `Deleting ${bulkPendingCount} time ${bulkPendingCount === 1 ? "entry" : "entries"}…`
          : `Delete ${selectedIds.length} time ${selectedIds.length === 1 ? "entry" : "entries"}? This cannot be undone.`}
        confirmText="Delete"
        loading={bulkDeleting}
      />
    </div>
  );
}
