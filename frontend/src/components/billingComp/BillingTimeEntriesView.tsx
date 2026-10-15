"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import { Clock, Pencil, Receipt, Trash2 } from "lucide-react";
import ActionIconButton from "@/components/ui/ActionIconButton";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import Button from "@/components/ui/Button";
import ClearFiltersButton from "@/components/ui/ClearFiltersButton";
import DateRangePicker from "@/components/ui/DateRangePicker";
import Dropdown from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import ListToolbar from "@/components/ui/ListToolbar";
import ListView, { type ListRow, type ListSelectionModel } from "@/components/ui/ListView";
import { DEFAULT_ROWS_PER_PAGE_OPTIONS } from "@/components/ui/ListPager";
import StatusBadge from "@/components/ui/StatusBadge";
import TruncatedListNotice from "@/components/ui/TruncatedListNotice";
import { highlightText } from "@/components/ui/HighlightText";
import { FIELD_CLS, FIELD_LABEL_CLS, INPUT_CLS } from "@/components/ui/inputClasses";
import { timeEntryBillingStatusMeta } from "@/constants/statusMeta";
import { usePermissions } from "@/contexts/PermissionsContext";
import useFirmTimeEntriesTable from "@/hooks/billingHooks/useFirmTimeEntriesTable";
import useCanActOnTimeEntry from "@/hooks/billingHooks/useCanActOnTimeEntry";
import billingService from "@/services/billing.service";
import TimeEntryModal from "./TimeEntryModal";
import BulkActionsMenu from "@/components/filesComp/BulkActionsMenu";
import { formatCurrency, getTimeEntryClientAttribution, getTimeEntryContext, isTimeEntryLocked, UNINVOICED_TIME_STATUSES } from "./utils";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { bulkFailureMessage } from "@/lib/utils/bulkRequests";
import { formatHoursMinutes } from "@/lib/utils/format";
import type { EnrichedTimeEntry } from "@/hooks/billingHooks/useFirmTimeEntries";
import type { User } from "@/types";
import type { ChargeCode } from "@/types/chargeCode";

interface BillingTimeEntriesViewProps {
  lawFirmId: string;
  users: User[];
  /**
   * Loading state of the panels rendered alongside this one, so the whole time
   * tab can reveal at once instead of one panel at a time.
   */
  isLoading?: boolean;
  onAddTimeEntry: () => void;
  onBillNow?: (entry: EnrichedTimeEntry) => void;
  onBatchBillNow?: (entries: EnrichedTimeEntry[]) => void;
  chargeCodes?: ChargeCode[];
  hideAddButton?: boolean;
  addButtonLabel?: string;
  /**
   * `billing.manageTimeEntries` - required by the backend for every mutation
   * this view can trigger (create, update, delete a time entry). Without it,
   * Add/Edit/Delete/Bill and bulk-select must not be offered at all, matching
   * `ClientBillingTimeEntriesSection.tsx`'s gating of the same actions.
   */
  canManage: boolean;
}

export default function BillingTimeEntriesView({
  lawFirmId,
  users,
  isLoading = false,
  onAddTimeEntry,
  onBillNow,
  onBatchBillNow,
  chargeCodes = [],
  hideAddButton = false,
  addButtonLabel = "+ Add Time Entry",
  canManage,
}: BillingTimeEntriesViewProps) {
  const fieldIds = useId();
  const { canActOnEntry } = useCanActOnTimeEntry();
  // Billing opens the invoice composer, which needs invoice rights that time-entry
  // rights do not imply.
  const { hasPermission } = usePermissions();
  const canBill = hasPermission("billing.manageInvoices");
  const [selectedIds, setSelectedIds] = useState<ListSelectionModel>([]);

  // Search, filtering, ordering and paging all happen on the server, so a filter
  // covers every time entry in the firm rather than the page on screen.
  const {
    rows: pagedEntries,
    total,
    loading,
    fetching,
    page: currentPage,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    filters,
    setFilter,
    clearFilters,
    search,
    setSearch,
    refetch,
  } = useFirmTimeEntriesTable(lawFirmId, { defaultBillingStatus: UNINVOICED_TIME_STATUSES });

  const [editingEntry, setEditingEntry] = useState<EnrichedTimeEntry | null>(null);
  const [entryToDelete, setEntryToDelete] = useState<EnrichedTimeEntry | null>(null);
  const [deletingEntry, setDeletingEntry] = useState(false);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  /**
   * How many entries a running bulk delete is removing, so the dialog names the
   * work rather than leaving its question up beside a spinner. A count, not a
   * progress figure: the whole selection goes in ONE request now, so there is no
   * per-item settling to count up and a number that never moved would be worse
   * than none.
   */
  const [bulkPendingCount, setBulkPendingCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectAllPending, setSelectAllPending] = useState(false);
  /**
   * The last select-all could not reach every matching entry. The endpoint serves
   * a bounded window, so "select all" walks it and stops at a cap; when it stops
   * short, the count and the bulk actions describe a subset and the user has to
   * be told that before they invoice or delete it.
   */
  const [selectionTruncated, setSelectionTruncated] = useState(false);
  const allFetchedEntriesMap = useRef<Map<string, EnrichedTimeEntry>>(new Map());

  // Cache entries on screen into the lookup map so individual checks preserve details
  useEffect(() => {
    for (const entry of pagedEntries) {
      allFetchedEntriesMap.current.set(entry.id, entry);
    }
  }, [pagedEntries]);

  const activeFilterCount = (search ? 1 : 0) + Object.values(filters).filter(Boolean).length;
  const hasFilters = activeFilterCount > 0;

  // Drop the selection whenever the set it was taken from changes. Paging leaves
  // it alone: the same entries still match, and the ids stay valid whether or not
  // their row is on screen.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the selection describes a filtered set; a new filter/search describes a different one
    setSelectedIds([]);
    setSelectionTruncated(false);
  }, [filters, search]);

  /**
   * Hand-picking a row leaves the selection partial in a way the user chose, so
   * the shortfall warning only survives while the select-all set it describes is
   * still standing. Emptying the selection retires it.
   */
  const handleSelectionChange = useCallback((ids: ListSelectionModel) => {
    setSelectedIds(ids);
    if (ids.length === 0) setSelectionTruncated(false);
  }, []);

  const handleSelectAll = useCallback(async () => {
    setSelectAllPending(true);
    try {
      const pageResult = await billingService.listFirmTimeEntriesAll(lawFirmId, {
        search,
        context: filters.context,
        matterId: filters.matterId,
        clientId: filters.clientId,
        clientScope: filters.clientScope,
        userId: filters.userId,
        chargeCodeId: filters.chargeCodeId,
        billingStatus: filters.billingStatus ?? UNINVOICED_TIME_STATUSES,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      });

      const enriched: EnrichedTimeEntry[] = pageResult.timeEntries.map((entry) => ({
        ...entry,
        matterId: entry.matterId || "",
        matterName: entry.matterName || "",
        clientId: entry.clientId || "",
        clientName: entry.clientName || "",
        clientNames: entry.clientNames || [],
        memberName: entry.userName || "Unknown",
        hourlyRate: typeof entry.hourlyRate === "number" ? entry.hourlyRate : null,
        context: entry.contextType,
        sourceLabel: entry.sourceTaskTitle || entry.sourceEventTitle || "",
      }));

      for (const entry of enriched) {
        allFetchedEntriesMap.current.set(entry.id, entry);
      }
      setSelectedIds(enriched.map((e) => e.id));
      // What was actually gathered, not what matched. The two differ once a firm
      // has more matching entries than one select-all can walk, and every count
      // and bulk action below is then about the gathered set alone.
      setSelectionTruncated(pageResult.truncated);
    } catch (e) {
      console.error("Failed to select all matching time entries", e);
    } finally {
      setSelectAllPending(false);
    }
  }, [lawFirmId, search, filters]);

  const selectedEntries = useMemo(
    () =>
      selectedIds
        .map((id) => allFetchedEntriesMap.current.get(String(id)))
        .filter((e): e is EnrichedTimeEntry => e != null),
    [selectedIds],
  );
  const selectedCount = selectedIds.length;

  const billableSelected = useMemo(
    () => selectedEntries.filter((entry) => entry.billable !== false),
    [selectedEntries],
  );
  const nonBillableSelectedCount = selectedEntries.length - billableSelected.length;

  const totalSelectedHours = selectedEntries.reduce(
    (sum, entry) => sum + (typeof entry.hours === "number" ? entry.hours : 0),
    0,
  );
  const totalSelectedAmount = selectedEntries.reduce(
    (sum, entry) => sum + (typeof entry.amount === "number" ? entry.amount : 0),
    0,
  );

  // Only unbilled time can be deleted. Invoiced time is part of a document the
  // client already has; removing it here would leave the invoice referencing a
  // row that no longer exists. Another member's entry is left out too when the
  // viewer may not delete other members' time: the API refuses a selection
  // that contains one, so it is never sent.
  const deletableSelected = useMemo(
    () => selectedEntries.filter((entry) => !isTimeEntryLocked(entry) && canActOnEntry(entry)),
    [selectedEntries, canActOnEntry],
  );

  const confirmDelete = async () => {
    if (!entryToDelete) return;
    setDeletingEntry(true);
    try {
      await billingService.deleteTimeEntry(getTimeEntryContext(lawFirmId, entryToDelete), entryToDelete.id);
      setEntryToDelete(null);
      await refetch();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete time entry"));
    } finally {
      setDeletingEntry(false);
    }
  };

  const confirmBulkDelete = async () => {
    if (deletableSelected.length === 0) return;
    setBulkDeleting(true);
    setBulkPendingCount(deletableSelected.length);
    try {
      // ONE request for the whole selection. Selecting all reaches 1,000 rows
      // here, and one DELETE per row was a thousand round trips against an
      // instance holding twelve Postgres connections for the entire firm.
      const outcome = await billingService.bulkDeleteTimeEntries(
        lawFirmId,
        deletableSelected.map((entry) => entry.id),
      );
      // The route answers PER ENTRY, so a 200 is not "all of them went". The
      // ids it refused are the ones that stay selected; everything else is gone.
      const refused = new Set(outcome.failed);
      const result = {
        succeeded: deletableSelected.filter((entry) => !refused.has(entry.id)),
        failed: outcome.failed.map((id) => ({ item: id, error: outcome.errors?.[id] })),
      };
      // Whatever went through is gone, so the list is reloaded either way and
      // only the entries that failed stay selected: retrying is one more click
      // and cannot re-send a delete that already succeeded. Locked entries were
      // never part of this action, so they drop out of the selection with the
      // rows that did delete.
      setSelectedIds(outcome.failed);
      setSelectionTruncated(false);
      setShowBulkDelete(false);
      setError(result.failed.length ? bulkFailureMessage(result, "deleted", "time entries") : null);
      await refetch();
    } catch (err) {
      // The request never reached a decision, so nothing was deleted and the
      // whole selection stays put, ready to retry.
      setError(getErrorMessage(err, "Failed to delete entries"));
    } finally {
      setBulkDeleting(false);
      setBulkPendingCount(null);
    }
  };

  const handleBatchBillClick = () => {
    if (!onBatchBillNow || billableSelected.length === 0) return;
    onBatchBillNow(billableSelected);
  };

  // Card row mapping (title=matter, badges=billing status, meta=date · client ·
  // member · charge code, right=hours + amount). The billed client is resolved
  // from the ids the entry stores rather than guessed from the matter's clients.
  const renderRow = useCallback((entry: EnrichedTimeEntry): ListRow => {
    const status = timeEntryBillingStatusMeta(entry.billingStatus);
    const hasAmount = typeof entry.amount === "number";
    const attribution = getTimeEntryClientAttribution(entry, entry.matterClients || []);

    const sourceLabel = entry.sourceTaskTitle
      ? `Task: ${entry.sourceTaskTitle}`
      : entry.sourceEventTitle
        ? `Event: ${entry.sourceEventTitle}`
        : null;

    const metaParts = [
      entry.date ? dayjs(entry.date).format("MMM D, YYYY") : null,
      attribution.name || (attribution.isAmbiguous ? "Multiple clients" : null),
      entry.memberName || null,
      entry.chargeCodeLabel || null,
      sourceLabel,
    ].filter(Boolean);

    return {
      title: highlightText(entry.matterName || "Direct client work", search),
      badges: (
        <>
          <StatusBadge variant={status.variant}>{status.label}</StatusBadge>
          {entry.billable === false && <StatusBadge variant="neutral">Non-billable</StatusBadge>}
          {!hasAmount && entry.billable !== false && (
            <StatusBadge variant="warning">No rate</StatusBadge>
          )}
        </>
      ),
      meta: metaParts.length ? highlightText(metaParts.join("  ·  "), search) : null,
      right: (
        <>
          <p className="text-sm font-semibold text-on-surface tabular-nums">
            {formatHoursMinutes(entry.hours)}
          </p>
          <p className="text-xs text-on-surface-secondary tabular-nums">
            {hasAmount ? formatCurrency(entry.amount as number) : "-"}
          </p>
        </>
      ),
    };
  }, [search]);

  return (
    <div className="space-y-4">
      <ErrorNotification error={error} onClose={() => setError(null)} compact />

      <ListToolbar className="space-y-3">
        <div className="flex flex-wrap gap-3">
          <div className={FIELD_CLS}>
            <label htmlFor={`${fieldIds}-search`} className={FIELD_LABEL_CLS}>Search</label>
            <input
              id={`${fieldIds}-search`}
              type="text"
              placeholder="Search entries..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`${INPUT_CLS} w-[200px]`}
            />
          </div>
          <Dropdown
            label="Linked to"
            value={filters.context || ""}
            onChange={(v) => setFilter("context", v)}
            options={[
              { value: "", label: "All" },
              { value: "matter", label: "Matter" },
              { value: "client", label: "Client" },
            ]}
            className="w-[130px]"
          />
          <EntityPicker
            entity="matters"
            lawFirmId={lawFirmId}
            label="Matter"
            value={filters.matterId || ""}
            onChange={(v) => setFilter("matterId", v)}
            emptyOption={{ value: "", label: "All" }}
            placeholder="All"
            className="w-[160px]"
          />
          {/* Backed by the client typeahead, not by the entries on screen: a
              dropdown built from one page would only offer that page's clients.
              Matches work billed to the client, whether logged against the client
              directly or against a matter naming them. */}
          <EntityPicker
            entity="clients"
            lawFirmId={lawFirmId}
            label="Client"
            value={filters.clientId || ""}
            onChange={(v) => setFilter("clientId", v)}
            emptyOption={{ value: "", label: "All" }}
            placeholder="All"
            className="w-[160px]"
          />
          <Dropdown
            label="Member"
            value={filters.userId || ""}
            onChange={(v) => setFilter("userId", v)}
            options={[
              { value: "", label: "All" },
              ...users.map((u) => ({ value: u.uid || "", label: u.name || u.email || "Unknown" })),
            ]}
            className="w-[150px]"
          />
          {chargeCodes.length > 0 && (
            <Dropdown
              label="Charge Code"
              value={filters.chargeCodeId || ""}
              onChange={(v) => setFilter("chargeCodeId", v)}
              options={[
                { value: "", label: "All" },
                ...chargeCodes.map((c) => ({ value: c.id, label: `${c.code} - ${c.name}` })),
              ]}
              className="w-[170px]"
            />
          )}
          <Dropdown
            label="Billing Status"
            value={filters.billingStatus || ""}
            onChange={(v) => setFilter("billingStatus", v)}
            options={[
              { value: "", label: "All" },
              { value: "unbilled", label: "Unbilled" },
              { value: "queued", label: "On a draft invoice" },
              { value: "billed", label: "Billed" },
              { value: "covered_by_retainer", label: "Included in plan" },
            ]}
            className="w-[170px]"
          />
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-on-surface-muted">Date Range</label>
            <DateRangePicker
              from={filters.dateFrom || ""}
              to={filters.dateTo || ""}
              onChange={(next) => {
                setFilter("dateFrom", next.from ?? "");
                setFilter("dateTo", next.to ?? "");
              }}
              className="w-[300px]"
            />
          </div>
          <ClearFiltersButton
            count={activeFilterCount}
            onClear={() => {
              clearFilters();
              setSearch("");
              setSelectedIds([]);
              setSelectionTruncated(false);
            }}
            className="mb-0.5"
          />
          {!hideAddButton && canManage && (
            <Button type="primary" onClick={onAddTimeEntry} className="ml-auto mb-0.5">
              {addButtonLabel}
            </Button>
          )}
        </div>
      </ListToolbar>

      <TruncatedListNotice
        truncated={selectionTruncated && selectedCount > 0}
        unitLabel="time entries"
        mode="selection"
      />

      <ListView<EnrichedTimeEntry>
        rows={pagedEntries}
        loading={loading || isLoading}
        fetching={fetching}
        getRowId={(row) => row.id}
        renderRow={renderRow}
        reserveFullPage
        rowActions={
          canManage
            ? (entry) => {
                const locked = isTimeEntryLocked(entry);
                const ownsEntry = canActOnEntry(entry);
                return (
                  <div className="flex items-center gap-1.5 justify-end">
                    {ownsEntry && (
                      <>
                        <ActionIconButton
                          label={locked ? "Invoiced time cannot be edited" : "Edit time entry"}
                          disabled={locked}
                          onClick={() => setEditingEntry(entry)}
                        >
                          <Pencil size={15} />
                        </ActionIconButton>

                        <ActionIconButton
                          label={locked ? "Invoiced time cannot be deleted" : "Delete time entry"}
                          tone="danger"
                          disabled={locked}
                          onClick={() => setEntryToDelete(entry)}
                        >
                          <Trash2 size={15} />
                        </ActionIconButton>
                      </>
                    )}

                    {onBillNow && canBill && !locked && entry.billable !== false && (
                      <Button
                        type="secondary"
                        size="small"
                        icon={<Receipt size={14} />}
                        onClick={() => onBillNow(entry)}
                      >
                        Bill now
                      </Button>
                    )}
                  </div>
                );
              }
            : undefined
        }
        showSelection={canManage}
        selectionModel={selectedIds}
        onSelectionChange={handleSelectionChange}
        showSelectAll={canManage}
        onSelectAll={handleSelectAll}
        selectAllPending={selectAllPending}
        // Names the real total alongside the count whenever the selection fell
        // short of it, so "1000 selected" can never be read as "all of them".
        selectAllLabel={
          selectedCount > 0
            ? selectionTruncated
              ? `${selectedCount} of ${total} selected`
              : `${selectedCount} selected`
            : `Select all ${total} time ${total === 1 ? "entry" : "entries"}`
        }
        trailing={
          selectedCount > 0 ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-on-surface-muted">
                <span className="tabular-nums">
                  {formatHoursMinutes(totalSelectedHours)} · {formatCurrency(totalSelectedAmount)}
                </span>
                {nonBillableSelectedCount > 0 &&
                  ` · ${nonBillableSelectedCount} non-billable excluded`}
              </span>
              {onBatchBillNow && canBill && (
                <Button
                  type="primary"
                  size="small"
                  icon={<Receipt size={14} />}
                  disabled={billableSelected.length === 0}
                  onClick={handleBatchBillClick}
                >
                  Bill {billableSelected.length}
                </Button>
              )}
              <BulkActionsMenu
                count={selectedCount}
                actions={[
                  {
                    key: "delete",
                    label: `Delete ${deletableSelected.length}`,
                    icon: <Trash2 size={15} />,
                    danger: true,
                    disabled: deletableSelected.length === 0,
                    onClick: () => setShowBulkDelete(true),
                  },
                ]}
              />
            </div>
          ) : undefined
        }
        paginationMode="server"
        page={currentPage - 1}
        pageSize={rowsPerPage}
        rowCount={total}
        onPageChange={(p) => setPage(p + 1)}
        onPageSizeChange={setRowsPerPage}
        defaultPageSize={rowsPerPage}
        pageSizeOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
        emptyIcon={<Clock size={40} />}
        emptyTitle={hasFilters ? "No time entries match these filters" : "No time entries yet"}
        emptyMessage={
          hasFilters
            ? "Try adjusting the search, matter, member, or status."
            : "Time you log against a matter or client will show up here."
        }
      />

      <TimeEntryModal
        open={Boolean(editingEntry)}
        onClose={() => setEditingEntry(null)}
        entry={editingEntry}
        lawFirmId={lawFirmId}
        users={users}
        chargeCodes={chargeCodes}
        onSuccess={() => refetch()}
      />

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
          : `Delete ${deletableSelected.length} time ${deletableSelected.length === 1 ? "entry" : "entries"}? This cannot be undone.`}
        confirmText="Delete"
        loading={bulkDeleting}
      />
    </div>
  );
}
