import ListSection from "@/components/ui/ListSection";
import { getMatterLeadNames } from '@/lib/matters/leadNames';
import { useMemo, useState, useEffect, useCallback, useRef, startTransition } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Lock } from 'lucide-react';
import Button from "@/components/ui/Button";
import ActionIconButton from "@/components/ui/ActionIconButton";
import PageHeader from "@/components/ui/PageHeader";
import ListView, { ListRow, ListSelectionModel, ListSortColumn, SortDir } from "@/components/ui/ListView";
import MatterStatusBadge from "@/components/ui/MatterStatusBadge";
import PaymentOngoingBadge from "@/components/ui/PaymentOngoingBadge";
import { MATTER_STATUS_META, MATTER_STATUS_OPTIONS } from "@/constants/statusMeta";
import { highlightText } from "@/components/ui/HighlightText";
import type { ExportColumn } from "@/utils/csvExport";
import ErrorNotification from "@/components/ErrorNotification";

import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { PAYMENT_ONGOING_FILTER, matterListFilterParams } from "@/hooks/matterHooks/useMatters";
import useMattersTable, { type MatterSortField } from "@/hooks/matterHooks/useMattersTable";
import type { ServerTableFilters } from "@/hooks/useServerTable";
import usePracticeAreas from "@/hooks/practiceHooks/usePracticeAreas";
import { useLawFirmUsers } from "@/hooks/useUsers";
import type { Matter } from "@/types";
import CreateMatterModal from "@/components/matterComp/CreateMatterModal";
import EditMatterModal from "@/components/matterComp/EditMatterModal";
import BulkAssignMemberModal from "@/components/matterComp/BulkAssignMemberModal";
import ConfirmModal from "@/components/ui/ConfirmModal";
import MattersService from "@/services/matters.service";
import { serverBulkFailureMessage } from "@/lib/utils/bulkRequests";
import Modal from "@/components/ui/Modal";
import { usePruneStaleFilters } from "@/hooks/usePruneStaleFilters";

import Dropdown, { DropdownOption } from "../ui/Dropdown";
import CategoryFilterDropdown from "../ui/CategoryFilterDropdown";
import ClearFiltersButton from "../ui/ClearFiltersButton";
import ListToolbar from "../ui/ListToolbar";
import { Plus, Download, CircleDot, Briefcase, UserPlus, Trash2, Pencil, Briefcase as BriefcaseIcon } from "lucide-react";
import { exportToCSV } from "@/utils/csvExport";
import BulkActionsMenu from "@/components/filesComp/BulkActionsMenu";
import SearchInput from "@/components/ui/SearchInput";

type Props = {
  lawFirmId: string;
};


/** Filter keys the grid persists and forwards to the server. */
const MATTER_FILTER_KEYS = ["status", "practiceAreaId", "leadUserId", "category"] as const;

/**
 * Filter values the grid opens on. A `?status=` URL param wins outright (a
 * bookmarked link should land on exactly that view); otherwise the previously
 * persisted selection is restored. An unrecognized persisted status is dropped
 * rather than sent, since the server rejects anything outside its status enum.
 */
function readInitialFilters(urlStatus: string | null): ServerTableFilters {
  if (typeof window === "undefined") return {};
  const isKnownStatus = (v: string) =>
    v === PAYMENT_ONGOING_FILTER || Object.prototype.hasOwnProperty.call(MATTER_STATUS_META, v);
  if (urlStatus) return isKnownStatus(urlStatus) ? { status: urlStatus } : {};

  const f: ServerTableFilters = {};
  for (const key of MATTER_FILTER_KEYS) {
    let v: string | null = null;
    try {
      v = localStorage.getItem(`mattersFilter_${key}`);
    } catch {
      // localStorage may be unavailable (private mode); ignore.
    }
    if (!v) continue;
    if (key === "status" && !isKnownStatus(v)) continue;
    f[key] = v;
  }
  return f;
}



export default function MattersGrid({ lawFirmId }: Props) {
  const { navigate } = useNavigation();
  const searchParams = useSearchParams();
  const { hasPermission } = usePermissions();

  const canCreateMatter = hasPermission("matters.create");
  const canUpdateMatter = hasPermission("matters.update");
  const canDeleteMatter = hasPermission("matters.delete");
  const canManageMembers = hasPermission("matters.manageMembers");
  const canUseBulkActions = canUpdateMatter || canDeleteMatter || canManageMembers;

  const queryClient = useQueryClient();

  // Read once, as a seed for the table's filter state, so a bookmarked
  // `?status=open` (or a persisted selection) lands on that filtered view.
  const [initialFilters] = useState<ServerTableFilters>(() => readInitialFilters(searchParams.get('status')));

  // ===== data =====
  const table = useMattersTable(lawFirmId, initialFilters);
  const {
    rows,
    total,
    loading: rowsLoading,
    fetching: rowsFetching,
    error: rowsError,
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    filters,
    setFilter,
    clearFilters,
    handleRequestSort,
    queryParams,
    search: searchTerm,
    setSearch: setSearchTerm,
  } = table;

  const { practiceAreas, loading: paLoading, error: paError, refetch: refetchPracticeAreas } = usePracticeAreas(lawFirmId);
  const { users, loading: usersLoading, error: usersError, refresh: refreshUsers } = useLawFirmUsers(lawFirmId);

  // Matter mutations elsewhere in the app invalidate ['matters', lawFirmId]; doing
  // the same here refreshes the paged list.
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['matters', lawFirmId] });
  }, [queryClient, lawFirmId]);

  const [localError, setLocalError] = useState<string | null>(null);

  // The rows / matters / practice-area / users errors are React Query state:
  // they persist until their query succeeds, so there is nothing to "clear".
  // Dismissing one has to be recorded here instead, otherwise closing the banner
  // only clears `localError` and a load failure reappears immediately. Keying the
  // record on the message rather than a boolean means a DIFFERENT load failure
  // still reaches the banner after the user has closed the previous one.
  const [dismissedLoadError, setDismissedLoadError] = useState<string | null>(null);
  const loadError = rowsError || paError || usersError || null;
  const showingLoadError = !!loadError && loadError !== dismissedLoadError;
  const error = localError || (showingLoadError ? loadError : null);

  // Re-run every read the banner could be reporting. `refresh` invalidates the
  // ['matters'] key, covering the paged list. Only
  // offered while the banner is showing a LOAD failure: an action failure is not
  // fixed by fetching the list again, and offering to would suggest it might be.
  const [retryingLoad, setRetryingLoad] = useState(false);
  const retryLoad = useCallback(async () => {
    setRetryingLoad(true);
    try {
      await Promise.allSettled([refresh(), refetchPracticeAreas(), refreshUsers()]);
    } finally {
      setRetryingLoad(false);
    }
  }, [refresh, refetchPracticeAreas, refreshUsers]);

  // Memoized on `loadError` so the callbacks that report through it (select-all,
  // delete) keep a stable identity between renders.
  const setError = useCallback((e: string | null) => {
    if (e === null) {
      setLocalError(null);
      setDismissedLoadError(loadError);
      return;
    }
    // Only surface errors meant for the page banner; modals show their own
    // validation messages, which are recognised by the "missing …" wording.
    if (!e.includes('missing')) {
      setLocalError(e);
    }
  }, [loadError]);

  const handleTopFieldChange = (key: string, value: string) => {
    try {
      localStorage.setItem(`mattersFilter_${key}`, value);
    } catch {
      // localStorage may be unavailable (private mode); ignore.
    }
    startTransition(() => setFilter(key, value || undefined));
  };

  // ===== selection & bulk actions =====
  // Selection spans the whole filtered set, not the page on screen: "select all"
  // asks the server for every matching matter id (see `selectAllMatching` below),
  // so a bulk action covers what the filters describe. Individually ticked rows
  // survive paging for the same reason.
  const [selectedIds, setSelectedIds] = useState<ListSelectionModel>([] as any);
  const [selectAllPending, setSelectAllPending] = useState(false);
  // Set when a select-all was capped by the server's ceiling, so the count in the
  // bulk bar isn't read as "everything".
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);

  const selectedIdsArray = useMemo<readonly (string | number)[]>(() => {
    if (Array.isArray(selectedIds)) return selectedIds;
    try {
      return Array.from((selectedIds as unknown as Iterable<string | number>) ?? []);
    } catch {
      return [];
    }
  }, [selectedIds]);

  const selectedMatterIds = useMemo(() => selectedIdsArray.map(String), [selectedIdsArray]);
  const selectedCount = selectedMatterIds.length;

  const handleSelection = useCallback((ids: ListSelectionModel) => {
    startTransition(() => setSelectedIds(ids));
  }, []);

  const handleClearSelection = useCallback(() => {
    startTransition(() => setSelectedIds([] as any));
    setSelectionNotice(null);
  }, []);

  // Select every matter the current filters + search match, across all pages. The
  // server resolves the ids under the same visibility rules as the list, so this
  // can never select a matter the user cannot see.
  const selectAllMatching = useCallback(async () => {
    setSelectAllPending(true);
    setSelectionNotice(null);
    try {
      const { ids, truncated, limit } = await MattersService.listMatterIds(lawFirmId, {
        search: queryParams.search,
        ...matterListFilterParams(filters),
      });
      startTransition(() => setSelectedIds(ids as any));
      if (truncated) {
        setSelectionNotice(
          `Selection is capped at ${limit} matters, so the first ${limit} of ${total} are selected.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to select all matters");
    } finally {
      setSelectAllPending(false);
    }
  }, [lawFirmId, queryParams.search, filters, total, setError]);

  // Drop the selection whenever the set it was taken from changes. Paging and
  // re-sorting leave it alone: the same matters still match, and the ids stay valid
  // whether or not their row is on screen.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the selection describes a filtered set; a new filter/search describes a different one
    setSelectedIds([] as any);
    setSelectionNotice(null);
  }, [filters, queryParams.search]);

  // single row actions
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<Matter | null>(null);

  const handleEdit = (row: Matter) => {
    if (!canUpdateMatter) return;
    setEditing(row);
    setEditOpen(true);
  };

  // Single row delete confirmation
  const [deleteMatterDialogOpen, setDeleteMatterDialogOpen] = useState(false);
  const [matterToDelete, setMatterToDelete] = useState<Matter | null>(null);
  const [deletingMatter, setDeletingMatter] = useState(false);

  const handleDelete = (row: Matter) => {
    if (!canDeleteMatter) return;
    setMatterToDelete(row);
    setDeleteMatterDialogOpen(true);
  };

  const confirmDeleteMatter = async () => {
    if (!matterToDelete || !canDeleteMatter) return;
    setDeletingMatter(true);
    try {
      await MattersService.deleteMatter(lawFirmId, matterToDelete.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete matter");
    } finally {
      setDeletingMatter(false);
      // Keep matterToDelete set so its name stays visible during the close
      // animation; it is overwritten the next time the dialog opens.
      setDeleteMatterDialogOpen(false);
    }
  };

  const handleViewMatter = (row: Matter) => {
    navigate(`/lawfirm/${lawFirmId}/matters/${row.id}`);
  };

  // bulk dialogs
  const [statusDlgOpen, setStatusDlgOpen] = useState(false);
  const [statusToSet, setStatusToSet] = useState<string>("active");

  const [paDlgOpen, setPaDlgOpen] = useState(false);
  const [paToSet, setPaToSet] = useState<string | "">("");

  const [confirmDelOpen, setConfirmDelOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const closeStatusDlg = useCallback(() => setStatusDlgOpen(false), []);
  const closePaDlg = useCallback(() => setPaDlgOpen(false), []);
  const closeConfirmDel = useCallback(() => setConfirmDelOpen(false), []);
  const closeDeleteMatter = useCallback(() => setDeleteMatterDialogOpen(false), []);

  // Hold the count shown in the bulk-delete title steady while the dialog animates
  // closed. Confirming clears the selection, which would otherwise make the title
  // flash "0 matters" during the exit transition.
  const bulkDeleteCountRef = useRef(selectedCount);
  useEffect(() => {
    if (confirmDelOpen) bulkDeleteCountRef.current = selectedCount;
  }, [confirmDelOpen, selectedCount]);
  const bulkDeleteCount = confirmDelOpen ? selectedCount : bulkDeleteCountRef.current;

  const applyBulkStatus = async () => {
    if (!canUpdateMatter || selectedMatterIds.length === 0) return;
    setBusy(true);
    try {
      const result = await MattersService.bulkUpdateStatus(lawFirmId, selectedMatterIds, statusToSet);
      setSelectedIds([] as any);
      setStatusDlgOpen(false);
      await refresh();
      // Answers 200 even when matters were refused (no write access, say), so
      // the count of what changed is read from the body, not assumed.
      const refused = serverBulkFailureMessage(result, "updated", "matters");
      if (refused) setError(refused);
    } catch (error) {
      // Closed with the page banner showing, so the failure is visible and the
      // spinner does not outlive the request.
      setStatusDlgOpen(false);
      setError(error instanceof Error ? error.message : "Failed to update status");
    } finally {
      setBusy(false);
    }
  };

  const applyBulkPracticeArea = async () => {
    if (!canUpdateMatter || selectedMatterIds.length === 0) return;
    setBusy(true);
    try {
      const result = await MattersService.bulkUpdatePracticeArea(lawFirmId, selectedMatterIds, paToSet);
      setSelectedIds([] as any);
      setPaDlgOpen(false);
      await refresh();
      const refused = serverBulkFailureMessage(result, "updated", "matters");
      if (refused) setError(refused);
    } catch (error) {
      setPaDlgOpen(false);
      setError(error instanceof Error ? error.message : "Failed to update practice area");
    } finally {
      setBusy(false);
    }
  };

  const applyBulkDelete = async () => {
    if (!canDeleteMatter || selectedMatterIds.length === 0) return;
    setBusy(true);
    try {
      const result = await MattersService.deleteMultipleMatters(lawFirmId, selectedMatterIds);

      setSelectedIds([] as any);
      setConfirmDelOpen(false);
      await refresh();
      // A bulk delete answers 200 even when items were refused (legal hold, trust
      // activity, billing history). Report those, otherwise the refused matters
      // just reappear in the list with no explanation.
      if (result.failed?.length) {
        const reasons = [...new Set(Object.values(result.errors || {}))];
        setError(
          `${result.deleted ?? 0} of ${result.requested} matters deleted. ${result.failed.length} could not be: ${reasons.join(" ")}`,
        );
      }
    } catch (error) {
      console.error("Error deleting multiple matters:", error);
      setError(error instanceof Error ? error.message : "Failed to delete multiple matters");
    } finally {
      setBusy(false);
    }
  };

  // Column set used only for the CSV export (field + header). The on-screen list
  // is rendered by `renderRow` below, not by these columns.
  const exportColumns: ExportColumn[] = useMemo(
    () => [
      { field: "name", headerName: "Matter" },
      { field: "matterNumber", headerName: "Matter Number" },
      { field: "leadUserName", headerName: "Lead" },
      { field: "practiceAreaName", headerName: "Practice Area" },
      { field: "category", headerName: "Category" },
      { field: "clientNames", headerName: "Clients" },
      { field: "description", headerName: "Description" },
      { field: "status", headerName: "Status" },
    ],
    []
  );

  const renderRow = useCallback((matterItem: Matter): ListRow => {
    const names =
      matterItem.clientNames ?? (matterItem.clients?.map((c) => c.name).filter(Boolean) ?? []);
    const total = matterItem.clientCount ?? names.length;
    // Show up to the first four client names before collapsing the rest into "+N".
    const shownClients = names.slice(0, 4);
    const extraClients = total - shownClients.length;
    const clientsText =
      total === 0 && names.length === 0
        ? null
        : extraClients > 0
        ? `${shownClients.join(", ")}, +${extraClients}`
        : shownClients.join(", ");

    const leadNames = getMatterLeadNames(matterItem);
    const shownLeads = leadNames.slice(0, 3);
    const extraLeads = leadNames.length - shownLeads.length;
    const leadText = leadNames.length
      ? `${leadNames.length > 1 ? "Leads" : "Lead"}: ${shownLeads.join(", ")}${extraLeads > 0 ? `, +${extraLeads}` : ""}`
      : null;

    const metaParts = [
      leadText,
      matterItem.practiceAreaName || null,
      matterItem.category || null,
      clientsText ? `Clients: ${clientsText}` : null,
    ].filter(Boolean);

    const metaText = metaParts.length
      ? metaParts.join("  ·  ")
      : matterItem.description || "No description";

    return {
      title: (
        <>
          {highlightText(matterItem.name || "Untitled Matter", searchTerm)}
          {matterItem.matterNumber && (
            <span className="ml-1.5 font-normal text-on-surface-muted">
              #{highlightText(matterItem.matterNumber, searchTerm)}
            </span>
          )}
        </>
      ),
      badges: (
        <>
          <MatterStatusBadge status={matterItem.status} />
          {matterItem.stageName && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-outline-subtle bg-surface-alt px-2 py-0.5 text-[11px] font-medium text-on-surface-secondary">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: matterItem.stageColor || "#6366f1" }}
              />
              {matterItem.stageName}
              {matterItem.stageIsClosed && <Lock size={10} className="text-on-surface-muted" />}
            </span>
          )}
          {matterItem.paymentOngoing && <PaymentOngoingBadge />}
        </>
      ),
      meta: highlightText(metaText, searchTerm),
    };
  }, [searchTerm]);

  // Ordering is done by the server, so the columns offered here are exactly the
  // fields its sort whitelist accepts (matters.validation.js MATTER_SORT_FIELDS).
  const sortColumns: ListSortColumn[] = useMemo(
    () => [
      { label: "Name", value: "name" },
      { label: "Matter Number", value: "matterNumber" },
      { label: "Practice Area", value: "practiceArea" },
      { label: "Lead", value: "leadUser" },
      { label: "Category", value: "category" },
      { label: "Status", value: "status" },
      { label: "Created", value: "createdAt", defaultDir: "desc" },
    ],
    []
  );

  const [sortValue, setSortValue] = useState<string>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const handleSortChange = useCallback(
    (value: string, dir: SortDir) => {
      setSortValue(value);
      setSortDir(dir);
      handleRequestSort([{ field: value as MatterSortField, sort: dir }]);
    },
    [handleRequestSort]
  );

  // Create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);

  // Check URL params for auto-opening create modal
  useEffect(() => {
    const shouldCreate = searchParams.get('create');
    if (shouldCreate === 'true' && canCreateMatter) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- opens the create modal from a URL query param and rewrites history
      setCreateOpen(true);
      // Remove the query parameter from URL without triggering navigation
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('create');
      window.history.replaceState({}, '', newUrl.toString());
    }
  }, [searchParams, canCreateMatter]);

  // options for the custom filter row + dialogs
  const practiceOptions: DropdownOption[] = useMemo(
    () => [{ value: "", label: "All Practice Areas" }, ...practiceAreas.map((p) => ({ value: p.id, label: p.name }))],
    [practiceAreas]
  );
  const leadOptions: DropdownOption[] = useMemo(
    () => [{ value: "", label: "All Leads" }, ...users.map((u) => ({ value: u.uid, label: u.name || u.email || u.uid }))],
    [users]
  );
  const statusOptions: DropdownOption[] = useMemo(
    () => [
      { value: "", label: "All Statuses" },
      ...MATTER_STATUS_OPTIONS,
      // Not a status: it shares this control but travels to the server as its
      // own `paymentOngoing` param (see matterListFilterParams).
      { value: PAYMENT_ONGOING_FILTER, label: "Payment Ongoing" },
    ],
    []
  );


  // Drop persisted filters whose target no longer exists (a removed lead, a
  // deleted practice area), so a stale value can't silently hide every matter
  // while its dropdown shows no selection.
  usePruneStaleFilters(
    [
      { key: "practiceAreaId", value: filters.practiceAreaId, options: practiceOptions, storageKey: "mattersFilter_practiceAreaId" },
      { key: "leadUserId", value: filters.leadUserId, options: leadOptions, storageKey: "mattersFilter_leadUserId" },
    ],
    (keys) => {
      startTransition(() => {
        for (const k of keys) setFilter(k, undefined);
      });
    }
  );

  // Active filter count (drives the Clear button / indicator) and a one-click
  // reset that also wipes the persisted values from localStorage.
  const activeFilterCount = MATTER_FILTER_KEYS.filter((k) => filters[k]).length;
  const clearAllFilters = () => {
    for (const key of MATTER_FILTER_KEYS) {
      try {
        localStorage.removeItem(`mattersFilter_${key}`);
      } catch {
        // localStorage may be unavailable (private mode); ignore.
      }
    }
    startTransition(() => clearFilters());
  };

  // CSV export covers the WHOLE filtered result set, not just the page on screen.
  // The list view only holds one server page, so the export re-requests the same
  // filter/sort/search in backend-max windows and concatenates them.
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const handleExportCsv = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const EXPORT_PAGE_SIZE = 500;   // the backend's maximum `limit`
      const MAX_EXPORT_PAGES = 40;    // hard stop, so a bad total can't loop forever
      const collected: Matter[] = [];
      let truncated = false;
      for (let pageNumber = 1; pageNumber <= MAX_EXPORT_PAGES; pageNumber += 1) {
        const { matters: batch, totalItems } = await MattersService.getMattersPaged(lawFirmId, {
          page: pageNumber,
          limit: EXPORT_PAGE_SIZE,
          sort: queryParams.sort,
          search: queryParams.search,
          ...matterListFilterParams(filters),
        });
        collected.push(...batch);
        if (batch.length < EXPORT_PAGE_SIZE || collected.length >= totalItems) break;
        // Reaching the cap with rows still unfetched means the file is short of
        // what the filters actually match. Say so, rather than handing over a
        // partial export that looks complete.
        if (pageNumber === MAX_EXPORT_PAGES) truncated = true;
      }
      exportToCSV(collected, exportColumns, "matters");
      if (truncated) {
        setExportNotice(
          `Export stopped at the first ${collected.length} matters. Narrow the filters or search to export the rest.`
        );
      }
    } catch (e) {
      setExportNotice(e instanceof Error ? e.message : "Failed to export matters");
    } finally {
      setExporting(false);
    }
  }, [exporting, exportColumns, lawFirmId, queryParams, filters]);

  return (
    <div className="min-h-screen bg-page">
      <div className="p-4 pl-5 md:p-6 max-w-[1600px] mx-auto space-y-6 min-w-0">
        <ErrorNotification
          error={error}
          onClose={() => setError(null)}
          onRetry={showingLoadError ? retryLoad : undefined}
          retrying={retryingLoad}
        />

        {/* Export outcome (a failure, or a file cut short by the page cap) gets
            its own dismissible banner, separate from the grid's load errors. */}
        <ErrorNotification error={exportNotice} onClose={() => setExportNotice(null)} />

        {/* A select-all the server had to cap, so the bulk bar's count is never
            mistaken for "every matching matter". */}
        <ErrorNotification error={selectionNotice} onClose={() => setSelectionNotice(null)} />

        <PageHeader
          eyebrow="Matter Management"
          title="Matters"
          description="Manage your law firm's matters."
          actions={
            canCreateMatter && (
              <Button
                size="compact"
                onClick={() => setCreateOpen(true)}
                icon={<Plus size={14} strokeWidth={2.2} />}
              >
                New Matter
              </Button>
            )
          }
        />

      <ListToolbar className="mb-4">
        <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center">
          <SearchInput
            className="w-full 2xl:min-w-64 2xl:max-w-sm 2xl:flex-1"
            placeholder="Search by matter name, matter number, matter ID, or client..."
            value={searchTerm}
            onChange={(next) => setSearchTerm(next)}
            onClear={() => setSearchTerm("")}
          />
          <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap 2xl:ml-auto 2xl:justify-end">
            <Dropdown
              placeholder="All Practice Areas"
              value={filters.practiceAreaId ?? ""}
              onChange={(v) => handleTopFieldChange("practiceAreaId", v)}
              options={practiceOptions}
              disabled={paLoading}
              className="w-full sm:w-44 text-sm"
            />
            <CategoryFilterDropdown
              placeholder="All Categories"
              value={filters.category ?? ""}
              onChange={(v) => handleTopFieldChange("category", v)}
              lawFirmId={lawFirmId}
              className="w-full sm:w-40 text-sm"
            />
            <Dropdown
              placeholder="All Leads"
              value={filters.leadUserId ?? ""}
              onChange={(v) => handleTopFieldChange("leadUserId", v)}
              options={leadOptions}
              disabled={usersLoading}
              className="w-full sm:w-40 text-sm"
            />
            <Dropdown
              placeholder="All Statuses"
              value={filters.status ?? ""}
              onChange={(v) => handleTopFieldChange("status", v)}
              options={statusOptions}
              className="w-full sm:w-40 text-sm"
            />
          </div>
        </div>
        {activeFilterCount > 0 && (
          <div className="mt-3 flex justify-end">
            <ClearFiltersButton count={activeFilterCount} onClear={clearAllFilters} />
          </div>
        )}
      </ListToolbar>

      {/* Title row with inline bulk actions */}
      <ListSection>
        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
          <h2 className="text-lg font-semibold text-on-surface shrink-0">Matters ({total})</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="secondary"
              size="compact"
              onClick={handleExportCsv}
              disabled={exporting}
              icon={<Download size={14} strokeWidth={2.2} />}
            >
              {exporting ? "Exporting..." : "Export CSV"}
            </Button>

          </div>
        </div>

        <ListView<Matter>
          rows={rows}
          loading={rowsLoading}
          loadFailed={!!rowsError}
          fetching={rowsFetching}
          getRowId={(row) => row.id || (row as any).matterId}
          renderRow={renderRow}
          onRowClick={handleViewMatter}
          rowActions={
            canUpdateMatter || canDeleteMatter
              ? (matterItem) => (
                  <>
                    {canUpdateMatter && (
                      <ActionIconButton label="Edit" onClick={() => handleEdit(matterItem)}>
                        <Pencil size={15} />
                      </ActionIconButton>
                    )}
                    {canDeleteMatter && (
                      <ActionIconButton label="Delete" tone="danger" emphasis onClick={() => handleDelete(matterItem)}>
                        <Trash2 size={15} />
                      </ActionIconButton>
                    )}
                  </>
                )
              : undefined
          }
          // Server-driven sort + pagination: the list renders just the current
          // server page and calls back to re-query on sort/page changes. ListView
          // pages are 0-based, the table hook's are 1-based.
          sortingMode="server"
          sortColumns={sortColumns}
          sortValue={sortValue}
          sortDir={sortDir}
          onSortChange={handleSortChange}
          paginationMode="server"
          page={page - 1}
          pageSize={rowsPerPage}
          rowCount={total}
          onPageChange={(p) => setPage(p + 1)}
          onPageSizeChange={setRowsPerPage}
          pageSizeOptions={[10, 25, 50]}
          defaultPageSize={rowsPerPage}
          showSelection={canUseBulkActions}
          selectionModel={[...selectedIds]}
          onSelectionChange={handleSelection}
          showSelectAll={canUseBulkActions}
          onSelectAll={canUseBulkActions ? selectAllMatching : undefined}
          onClearSelection={canUseBulkActions ? handleClearSelection : undefined}
          selectAllPending={selectAllPending}
          // The toggle covers every matter the current filters match, across pages,
          // so it names that count rather than the page in front of the user.
          selectAllLabel={
            selectedCount > 0
              ? `${selectedCount} selected${selectedCount < total ? ` of ${total}` : ""}`
              : `Select all ${total}`
          }
          emptyIcon={<BriefcaseIcon size={40} />}
          emptyTitle="No matters found"
          emptyMessage="Try adjusting your search or filters."
          trailing={
            selectedCount > 0 && canUseBulkActions ? (
              <BulkActionsMenu
                count={selectedCount}
                actions={[
                  canUpdateMatter && {
                    key: "status",
                    label: "Change Status",
                    icon: <CircleDot size={15} />,
                    onClick: () => setStatusDlgOpen(true),
                  },
                  canUpdateMatter && {
                    key: "practiceArea",
                    label: "Change Practice Area",
                    icon: <Briefcase size={15} />,
                    onClick: () => setPaDlgOpen(true),
                  },
                  canManageMembers && {
                    key: "assignMember",
                    label: "Assign Member",
                    icon: <UserPlus size={15} />,
                    onClick: () => setBulkAssignOpen(true),
                  },
                  canDeleteMatter && {
                    key: "delete",
                    label: "Delete",
                    icon: <Trash2 size={15} />,
                    danger: true,
                    onClick: () => setConfirmDelOpen(true),
                  },
                ]}
              />
            ) : undefined
          }
        />
      </ListSection>

      {/* Create Matter */}
      {canCreateMatter && (
        <CreateMatterModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          lawFirmId={lawFirmId}
          users={users}
          onAfter={async () => {
            await refresh();
            setCreateOpen(false);
          }}
        />
      )}

      {/* Edit Matter */}
      <EditMatterModal
        open={editOpen}
        onClose={() => {
          setEditOpen(false);
        }}
        lawFirmId={lawFirmId}
        users={users}
        matterItem={editing}
        // Refresh only: the modal closes itself once everything saved, and stays
        // open on a partial save so its message can be read.
        onAfter={async () => {
          await refresh();
        }}
      />

      {/* Bulk Assign Member */}
      {canManageMembers && (
        <BulkAssignMemberModal
          open={bulkAssignOpen}
          onClose={() => setBulkAssignOpen(false)}
          lawFirmId={lawFirmId}
          selectedMatterIds={selectedMatterIds}
          users={users || []}
          // Refresh only: the dialog stays open on its result, which is the one
          // place a matter the server refused is reported. "Done" closes it.
          onAfter={async () => {
            setSelectedIds([] as any);
            await refresh();
          }}
        />
      )}

      {/* ===== Bulk Dialogs (using Dropdown component) ===== */}

      {/* Change Status */}
      {canUpdateMatter && (
        <Modal
          isOpen={statusDlgOpen}
          onClose={closeStatusDlg}
          title="Change Status"
          size="md"
          dismissible={!busy}
          footer={
            <>
              <Button type="secondary" onClick={closeStatusDlg} disabled={busy}>
                Cancel
              </Button>
              <Button
                type="primary"
                onClick={applyBulkStatus}
                loading={busy}
                disabled={busy}
              >
                {busy ? "Applying..." : "Apply"}
              </Button>
            </>
          }
        >
          <Dropdown
            label="Status"
            value={statusToSet}
            onChange={(v) => setStatusToSet(v)}
            options={statusOptions}
            className="text-sm"
            portal
          />
        </Modal>
      )}

      {/* Change Practice Area */}
      {canUpdateMatter && (
        <Modal
          isOpen={paDlgOpen}
          onClose={closePaDlg}
          title="Change Practice Area"
          size="md"
          dismissible={!busy}
          footer={
            <>
              <Button type="secondary" onClick={closePaDlg} disabled={busy}>
                Cancel
              </Button>
              <Button
                type="primary"
                onClick={applyBulkPracticeArea}
                loading={busy}
                disabled={busy}
              >
                {busy ? "Applying..." : "Apply"}
              </Button>
            </>
          }
        >
          <Dropdown
            label="Practice Area"
            value={paToSet}
            onChange={(v) => setPaToSet(v)}
            options={practiceOptions}
            className="text-sm"
            portal
          />
        </Modal>
      )}

      {/* Confirm Delete */}
      {canDeleteMatter && (
        <ConfirmModal
          isOpen={confirmDelOpen}
          onClose={closeConfirmDel}
          onConfirm={applyBulkDelete}
          title={`Delete ${bulkDeleteCount} matter${bulkDeleteCount === 1 ? "" : "s"}?`}
          message="This action cannot be undone."
          confirmText="Delete"
          loading={busy}
        />
      )}

      {/* Single Matter Delete Confirmation */}
      {canDeleteMatter && (
        <ConfirmModal
          isOpen={deleteMatterDialogOpen}
          onClose={closeDeleteMatter}
          onConfirm={confirmDeleteMatter}
          title="Delete Matter?"
          message={`Are you sure you want to delete "${matterToDelete?.name}"? This action cannot be undone.`}
          confirmText="Delete"
          loading={deletingMatter}
        />
      )}
      </div>
    </div>
  );
}
