"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { useNavigation } from "@/contexts/NavigationContext";
import { useQueryClient } from "@tanstack/react-query";
import { useLawFirmUsers } from "@/hooks/useUsers";
import useChargeCodes from "@/hooks/chargeCodeHooks/useChargeCodes";
import { useAuth } from "@/hooks/useAuth";
import billingService, {
  type CreateBillingPlanPayload,
} from "@/services/billing.service";
import useBillingWorkbench from "@/hooks/billingHooks/useBillingWorkbench";
import useFirmUnbilledWork from "@/hooks/billingHooks/useFirmUnbilledWork";
import { invoiceComposerPath, useBillNowRedirect } from "@/hooks/billingHooks/useBillNowRedirect";
import type { EnrichedTimeEntry } from "@/hooks/billingHooks/useFirmTimeEntries";
import BillingOverview, { ATTENTION_PAGE_SIZE } from "@/components/billingComp/BillingOverview";
import TabBar from "@/components/ui/TabBar";

/** The billing workbench's top-level views, in bar order. */
type BillingTab = "upcoming" | "invoices" | "time" | "plans" | "reports" | "setup";

/**
 * Tabs whose content is a list of rows or cards, so the tab-switch wait can be
 * drawn as placeholder rows. "setup" is a settings form and has no row shape to
 * stand in for.
 */
const LIST_SHAPED_TABS = new Set<BillingTab>(["upcoming", "invoices", "time", "plans", "reports"]);
import BillingViewHeader from "@/components/billingComp/BillingViewHeader";
import BillingReportsView, { type ReportGroup } from "@/components/billingComp/BillingReportsView";
import BillingTimeEntriesView from "@/components/billingComp/BillingTimeEntriesView";
import BillingUnbilledWorkPanel, { UNBILLED_WORK_PAGE_SIZE } from "@/components/billingComp/BillingUnbilledWorkPanel";
import BillingInvoicesView from "@/components/billingComp/BillingInvoicesView";
import BillingRecurringPlansPanel from "@/components/billingComp/BillingRecurringPlansPanel";
import BillingSetupView, { type SetupSubView } from "@/components/billingComp/BillingSetupView";
import BillingUpcomingPaymentsView from "@/components/billingComp/BillingUpcomingPaymentsView";
import BillingActionsMenu from "@/components/billingComp/BillingActionsMenu";
import { BarChart3, CalendarClock, Clock, FileText, Plus, Repeat, Settings } from "lucide-react";
import TimeEntryModal, { type TimerPrefill } from "@/components/billingComp/TimeEntryModal";
import AddFlatFeeModal from "@/components/billingComp/AddFlatFeeModal";
import AddExpenseModal from "@/components/billingComp/AddExpenseModal";
import RequirePermission from "@/components/ui/RequirePermission";
import PageHeader from "@/components/ui/PageHeader";
import ErrorNotification from "@/components/ErrorNotification";
import LoadingSpinner from "@/components/LoadingSpinner";
import ListSkeleton from "@/components/ui/ListSkeleton";
import type { BillingReadyItem } from "@/types";
import type { UnbilledWorkItem } from "@/types";
import { useBillingTimer } from "@/contexts/BillingTimerContext";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import Button from "@/components/ui/Button";

interface BillingRoute {
  tab: BillingTab;
  group: ReportGroup;
  setupSub: SetupSubView;
}

// Resolves the active tab + sub-views from the URL.
function resolveBillingRoute(
  view: string | null,
  group: string | null,
  sub: string | null
): BillingRoute {
  let tab: BillingTab = "upcoming";
  let resolvedGroup: ReportGroup = "matter";
  let resolvedSetupSub: SetupSubView = "rates";

  switch (view) {
    case "upcoming":
      tab = "upcoming";
      break;
    case "invoices":
      tab = "invoices";
      break;
    case "time":
      tab = "time";
      break;
    case "plans":
      tab = "plans";
      break;
    case "reports":
      tab = "reports";
      break;
    case "setup":
      tab = "setup";
      break;
    case null:
      break;
    default:
      tab = "invoices";
  }

  if (group === "client") resolvedGroup = "client";
  else if (group === "matter") resolvedGroup = "matter";

  if (sub === "settings") resolvedSetupSub = "settings";
  else if (sub === "rates") resolvedSetupSub = "rates";

  return { tab, group: resolvedGroup, setupSub: resolvedSetupSub };
}

export default function BillingPage() {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { navigate } = useNavigation();
  const { settings } = useFirmSettings();
  const { hasPermission } = usePermissions();
  const canManageExpenses = hasPermission("billing.manageExpenses");
  const canManageInvoices = hasPermission("billing.manageInvoices");
  const canManageTimeEntries = hasPermission("billing.manageTimeEntries");
  const queryClient = useQueryClient();

  const lawFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string);

  const route = resolveBillingRoute(
    searchParams.get("view"),
    searchParams.get("group"),
    searchParams.get("sub")
  );
  const activeView = route.tab;

  const [addTimeEntryOpen, setAddTimeEntryOpen] = useState(false);
  const [addFlatFeeOpen, setAddFlatFeeOpen] = useState(false);
  const [addExpenseOpen, setAddExpenseOpen] = useState(false);
  const [timerPrefill, setTimerPrefill] = useState<TimerPrefill | null>(null);
  const [creatingPlanDraftId, setCreatingPlanDraftId] = useState<string | null>(null);
  const [tabSwitching, setTabSwitching] = useState(false);
  const [pendingTab, setPendingTab] = useState<BillingTab | null>(null);
  const [invoiceInitialFilters, setInvoiceInitialFilters] = useState<Record<string, string>>({});
  const [invoiceFilterNonce, setInvoiceFilterNonce] = useState(0);

  const billingTimer = useBillingTimer();
  const tabBarRef = useRef<HTMLDivElement>(null);
  // Set when a tab change is initiated so we scroll only after the new tab's
  // content has rendered (see the effect below), not during the brief spinner.
  const pendingScrollRef = useRef(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets transient tab-switch UI state when the active view changes
    setTabSwitching(false);
    setPendingTab(null);
  }, [activeView]);

  // Switching tabs swaps the content below the tab bar, but the viewport stays
  // scrolled at the page top (header + overview), so the new tab's content
  // starts off-screen. Once the new content has rendered (tabSwitching cleared),
  // bring the tab bar to the top of the viewport. Doing this only after the
  // spinner clears avoids scrolling while the page is momentarily short, which
  // would let the browser clamp the scroll straight back to the top.
  useEffect(() => {
    if (tabSwitching || !pendingScrollRef.current) return;
    pendingScrollRef.current = false;
    requestAnimationFrame(() => {
      tabBarRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [tabSwitching, activeView]);

  // Only the invoice draft composer (`draftItem`) needs these. The reports
  // tab reads its own server-side aggregates and never touches this list, so
  // switching to it doesn't belong here. It used to: gating the whole-page
  // spinner below on that made every first visit to Reports render a
  // full-page spinner (discarding the tab bar and scroll position) while an
  // unrelated matters fetch it doesn't need was in flight, which is what
  // made switching to Reports occasionally look like the page had reloaded
  const { users } = useLawFirmUsers(lawFirmId);
  // The "needs attention" list is paged on the server: the full list is every
  // overdue invoice plus every ready-to-bill item in the firm, which is far more
  // than the five rows on screen.
  const [attentionPage, setAttentionPage] = useState(1);
  const {
    data: workbench,
    isLoading: workbenchLoading,
    isFetching: workbenchFetching,
    error: workbenchError,
    refetch: refetchWorkbench,
  } = useBillingWorkbench(lawFirmId, {
    attentionPage,
    attentionLimit: ATTENTION_PAGE_SIZE,
  });
  const [unbilledWorkPage, setUnbilledWorkPage] = useState(1);
  const {
    data: unbilledWork,
    isLoading: unbilledWorkLoading,
    isFetching: unbilledWorkFetching,
    error: unbilledWorkError,
    refetch: refetchUnbilledWork,
  } = useFirmUnbilledWork(lawFirmId, {
    page: unbilledWorkPage,
    limit: UNBILLED_WORK_PAGE_SIZE,
  });
  const {
    chargeCodes,
    loading: chargeCodesLoading,
    refetch: refetchChargeCodes,
  } = useChargeCodes(lawFirmId, true);

  const overviewLoading = workbenchLoading || unbilledWorkLoading;

  // Every KPI on this page defaults to zero/empty when its query has no data,
  // which is exactly what a genuinely caught-up firm also looks like. Without
  // this, a failed read renders "You're all caught up" instead of telling
  // anyone the workbench never actually loaded.
  const [dismissedLoadError, setDismissedLoadError] = useState<string | null>(null);
  const loadError = (workbenchError as Error | null) || (unbilledWorkError as Error | null) || null;
  const showingLoadError = !!loadError && loadError.message !== dismissedLoadError;
  const [retryingLoad, setRetryingLoad] = useState(false);
  const retryLoad = useCallback(async () => {
    setRetryingLoad(true);
    try {
      await Promise.allSettled([refetchWorkbench(), refetchUnbilledWork()]);
    } finally {
      setRetryingLoad(false);
    }
  }, [refetchWorkbench, refetchUnbilledWork]);

  // A billing action started from the workbench (currently just "create an
  // invoice from a ready plan period") that fails outside any modal's own
  // form, so there is nowhere else for the failure to surface.
  const [planDraftError, setPlanDraftError] = useState<string | null>(null);

  const updateSearch = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(searchParams.toString());
      Object.entries(patch).forEach(([key, value]) => {
        if (value === null || value === undefined || value === "") {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      });
      const query = next.toString();
      // scroll: false stops Next's App Router from yanking the viewport to the
      // top on this same-page query change. Without it, switching billing tabs
      // jumps to the page top and then the scroll-into-view below animates back
      // down - the visible "up then down" glitch.
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  const handleTabChange = (tab: BillingTab) => {
    if (tab !== activeView) {
      setPendingTab(tab);
      setTabSwitching(true);
      pendingScrollRef.current = true;
    }
    updateSearch({ view: tab, group: null, sub: null });
  };

  const handleStatNavigate = (
    tab: BillingTab,
    options?: { invoiceFilters?: Record<string, string>; sub?: string }
  ) => {
    if (options?.invoiceFilters) {
      setInvoiceInitialFilters(options.invoiceFilters);
      setInvoiceFilterNonce((n) => n + 1);
    }
    if (tab !== activeView) {
      setPendingTab(tab);
      setTabSwitching(true);
      pendingScrollRef.current = true;
    } else {
      // Same tab already active (e.g. switching the invoice filter from Awaiting
      // to Overdue): the content swaps in place with no tab-switch spinner, so
      // the effect that scrolls on tab change won't fire. Bring the tab content
      // to the top of the viewport directly.
      requestAnimationFrame(() => {
        tabBarRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    updateSearch({ view: tab, group: null, sub: options?.sub ?? null });
  };

  // Billing data now lives in several queries (the paged invoice and time-entry
  // lists, the firm summary, the reports full-set reads), so refreshing
  // invalidates the whole `billing` key space rather than naming each one and
  // silently missing the ones added later.
  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["billing"] });
    refetchWorkbench();
    refetchUnbilledWork();
  }, [queryClient, refetchWorkbench, refetchUnbilledWork]);

  // "Save and bill now" from Log time saved ONE entry, so it bills one context
  // and opens that context's composer, the same destination as every other
  // "bill now". The workbench's own batch and ready-to-bill actions below keep
  // the firm-wide invoice run, which is the screen for billing several contexts
  // in one pass.
  const closeLogTime = useCallback(() => {
    setTimerPrefill(null);
    handleRefresh();
  }, [handleRefresh]);
  const handleTimeEntrySuccess = useBillNowRedirect(lawFirmId, closeLogTime);

  const handleBillNowFromEntry = useCallback(
    (entry: EnrichedTimeEntry) => {
      const query = new URLSearchParams({
        draftType: "time_entry",
        draftId: entry.id,
      });
      navigate(invoiceComposerPath(lawFirmId, { type: entry.context, entityId: entry.entityId }, query));
    },
    [lawFirmId, navigate]
  );

  const handleBatchBillFromEntries = useCallback(
    (entries: EnrichedTimeEntry[]) => {
      const readyItems: BillingReadyItem[] = entries.map((entry) => ({
        id: entry.id,
        itemType: "time_entry",
        contextType: entry.context,
        entityId: entry.entityId,
        matterId: entry.matterId || null,
        matterName: entry.matterName || null,
        clientId: entry.clientId || null,
        clientName: entry.clientName || entry.clientNames?.[0] || null,
        description: entry.name || entry.description || "Time entry",
        amount: typeof entry.amount === "number" ? entry.amount : undefined,
        hours: entry.hours,
        date: entry.date,
        timeEntryId: entry.id,
      }));

      const contexts = new Set(readyItems.map((item) => `${item.contextType}:${item.entityId}`));
      const timeEntryIds = readyItems.map((item) => item.timeEntryId || item.id).filter(Boolean);
      const query = new URLSearchParams({
        contexts: Array.from(contexts).join(","),
        ...(timeEntryIds.length > 0 ? { timeEntryIds: timeEntryIds.join(",") } : {}),
      });
      navigate(`/lawfirm/${lawFirmId}/billing/invoice-run?${query.toString()}`);
    },
    [lawFirmId, navigate]
  );

  const handleCreatePlan = useCallback(
    async (payload: CreateBillingPlanPayload) => {
      await billingService.createPlan(lawFirmId, payload);
      await refetchWorkbench();
    },
    [lawFirmId, refetchWorkbench]
  );

  const handleCreatePlanDraft = useCallback(
    async (item: BillingReadyItem) => {
      if (!item.planId || !item.periodId) return;
      const actionId = `${item.planId}:${item.periodId}`;
      setCreatingPlanDraftId(actionId);
      setPlanDraftError(null);
      try {
        await billingService.createDraftFromPlanPeriod(
          lawFirmId,
          item.planId,
          item.periodId
        );
        await handleRefresh();
        updateSearch({ view: "invoices", sub: null });
      } catch (error) {
        // The caller (`handleBillReadyItem`) fires this with `void`, so
        // without a local catch a failure here was an unhandled promise
        // rejection: the button stopped spinning and nothing told the user
        // the invoice was never created.
        setPlanDraftError(
          error instanceof Error ? error.message : "Failed to create the invoice draft."
        );
      } finally {
        setCreatingPlanDraftId(null);
      }
    },
    [handleRefresh, lawFirmId, updateSearch]
  );

  function handleBillReadyItem(item: BillingReadyItem) {
    if (item.itemType === "plan_period" && item.planId && item.periodId) {
      void handleCreatePlanDraft(item);
      return;
    }
    const query = new URLSearchParams({
      contexts: `${item.contextType}:${item.entityId}`,
      ...(item.timeEntryId ? { timeEntryIds: item.timeEntryId } : {}),
    });
    navigate(`/lawfirm/${lawFirmId}/billing/invoice-run?${query.toString()}`);
  }

  const handleLogUnbilledWork = (item: UnbilledWorkItem) => {
    setTimerPrefill({
      matterId: item.matterId || null,
      clientId: item.clientId || null,
      userId: user?.uid || null,
      name: item.title,
      description: item.details || undefined,
      chargeCodeId:
        item.workType === "event" && item.eventType
          ? settings.billing.eventTypeChargeCodeDefaults?.[item.eventType as keyof typeof settings.billing.eventTypeChargeCodeDefaults] || null
          : null,
      sourceTaskId: item.taskId || null,
      sourceTaskTitle: item.workType === "task" ? item.title : null,
      sourceEventId: item.eventId || null,
      sourceEventTitle: item.workType === "event" ? item.title : null,
    });
    setAddTimeEntryOpen(true);
  };

  const handleStartTimerForUnbilledWork = (item: UnbilledWorkItem) => {
    billingTimer.startTimer({
      matterId: item.matterId || null,
      clientId: item.clientId || null,
      targetLabel: item.matterName || item.clientName || item.title,
      name: item.title,
      description: item.details || "",
      chargeCodeId:
        item.workType === "event" && item.eventType
          ? settings.billing.eventTypeChargeCodeDefaults?.[item.eventType as keyof typeof settings.billing.eventTypeChargeCodeDefaults] || null
          : null,
      sourceTaskId: item.taskId || null,
      sourceTaskTitle: item.workType === "task" ? item.title : null,
      sourceEventId: item.eventId || null,
      sourceEventTitle: item.workType === "event" ? item.title : null,
    });
  };

  return (
    <RequirePermission permission="billing.viewInvoices" page>
      <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
        <PageHeader
          className="mb-6"
          eyebrow="Billing"
          title="Billing"
          description="Log your work, send invoices, and get paid."
          actions={
            <>
              {canManageTimeEntries && (
                <Button
                  size="compact"
                  onClick={() => setAddTimeEntryOpen(true)}
                  icon={<Plus size={14} strokeWidth={2.2} />}
                >
                  Log time
                </Button>
              )}
              <BillingActionsMenu
                onAddExpense={() => setAddExpenseOpen(true)}
                onAddFlatFee={() => setAddFlatFeeOpen(true)}
                onStartTimer={billingTimer.openTargetPicker}
                onBulkInvoices={() => navigate(`/lawfirm/${lawFirmId}/billing/invoice-run`)}
                timerActive={billingTimer.isActive}
                canManageExpenses={canManageExpenses}
                canManageInvoices={canManageInvoices}
              />
            </>
          }
        />

        <ErrorNotification
          error={showingLoadError ? loadError : null}
          onClose={() => setDismissedLoadError(loadError?.message ?? null)}
          onRetry={retryLoad}
          retrying={retryingLoad}
        />
        <ErrorNotification
          error={planDraftError}
          onClose={() => setPlanDraftError(null)}
        />

        <BillingOverview
          lawFirmId={lawFirmId}
          summary={workbench?.summary}
          attentionRows={workbench?.attention?.rows || []}
          attentionTotal={workbench?.attention?.totalItems ?? 0}
          page={attentionPage}
          onPageChange={setAttentionPage}
          attentionFetching={workbenchFetching}
          awaitingAmount={workbench?.summary.awaitingAmount ?? 0}
          awaitingCount={workbench?.summary.awaitingCount ?? 0}
          collectedAmount={workbench?.summary.totalCollected ?? 0}
          loading={overviewLoading}
          creatingPlanDraftId={creatingPlanDraftId}
          onViewUnbilled={() => handleTabChange("time")}
          onViewAwaiting={() => handleStatNavigate("invoices", { invoiceFilters: { status: "unpaid" } })}
          onViewOverdue={() => handleStatNavigate("invoices", { invoiceFilters: { status: "overdue" } })}
          onViewCollected={() => handleStatNavigate("invoices", { invoiceFilters: { status: "paid" } })}
          onCreatePlanDraft={handleCreatePlanDraft}
          onBillItem={handleBillReadyItem}
        />

        <div ref={tabBarRef} className="scroll-mt-4">
          <TabBar
            align="split"
            className="mb-6"
            value={pendingTab ?? activeView}
            onChange={handleTabChange}
            tabs={[
              { value: "upcoming", label: "Upcoming payments", icon: CalendarClock, count: workbench?.summary.awaitingCount ?? 0 },
              { value: "invoices", label: "Invoices", icon: FileText, count: workbench?.summary.totalInvoices ?? 0 },
              { value: "time", label: "Time entries", icon: Clock, count: workbench?.summary.uninvoicedTimeEntryCount ?? 0 },
              { value: "plans", label: "Recurring plans", icon: Repeat, count: workbench?.plans?.length || 0 },
              { value: "reports", label: "Reports", icon: BarChart3 },
              { value: "setup", label: "Rates & setup", icon: Settings, secondary: true },
            ]}
          />
        </div>

        {/* Reserve at least a viewport of height for the content area below the
            tab bar so switching to a shorter tab can't shrink the page below the
            current scroll position. If it did, the browser would clamp the
            viewport upward and the tab bar would slip below the top of the
            screen mid-switch. Stable height keeps the tab bar parked where it
            is. (The separate jump-to-top glitch is handled by `scroll: false` on
            the router navigation in updateSearch.) */}
        <div className="min-h-screen">
        {tabSwitching ? (
          // Bridge the router round-trip with the shape the incoming tab will
          // show, so a switch reads as one continuous wait rather than a
          // floating spinner followed by a differently-shaped skeleton. Only the
          // row-shaped tabs qualify; Rates & setup is a form, so it keeps the
          // panel-level spinner.
          LIST_SHAPED_TABS.has(pendingTab ?? activeView) ? (
            <div className="pt-6">
              <ListSkeleton rows={6} label="Loading" />
            </div>
          ) : (
            <div className="flex items-center justify-center py-24">
              <LoadingSpinner />
            </div>
          )
        ) : (
          <>
            {activeView === "upcoming" && (
              <>
                <BillingViewHeader
                  title="Upcoming payments"
                  description="Every unpaid invoice grouped by when it's due, from overdue to scheduled later. Filter with the tiles above, then select an invoice to see its details."
                />
                <BillingUpcomingPaymentsView lawFirmId={lawFirmId} />
              </>
            )}

            {activeView === "time" && (
              <>
                <BillingViewHeader
                  title="Time entries"
                  description="Billable work that hasn't been invoiced yet. Review uninvoiced work, log new time entries, then bill them when you're ready."
                />
                <div className="space-y-6">
                <BillingUnbilledWorkPanel
                  items={unbilledWork?.items || []}
                  total={unbilledWork?.summary.totalCount ?? 0}
                  page={unbilledWorkPage}
                  rowsPerPage={UNBILLED_WORK_PAGE_SIZE}
                  onPageChange={setUnbilledWorkPage}
                  isLoading={unbilledWorkLoading}
                  isFetching={unbilledWorkFetching}
                  onLogTime={handleLogUnbilledWork}
                  onStartTimer={handleStartTimerForUnbilledWork}
                  canManage={canManageTimeEntries}
                />
                {/* The unbilled-work panel above and this table are backed by
                    separate queries; passing the panel's loading flag in keeps
                    both revealing together instead of one showing real rows while
                    the other is still a skeleton. */}
                <BillingTimeEntriesView
                  lawFirmId={lawFirmId}
                  users={users}
                  isLoading={unbilledWorkLoading}
                  onAddTimeEntry={() => setAddTimeEntryOpen(true)}
                  onBillNow={handleBillNowFromEntry}
                  onBatchBillNow={handleBatchBillFromEntries}
                  chargeCodes={chargeCodes}
                  canManage={canManageTimeEntries}
                />
                </div>
              </>
            )}

            {activeView === "invoices" && (
              <>
                <BillingViewHeader
                  title="Invoices"
                  description="Every invoice your firm has created, across all statuses. Search or filter by matter, client, or status, then select one to see its details."
                />
                {/* Remounting on the nonce is what re-seeds the view's filters
                    when a KPI tile navigates here with a status pre-selected. */}
                <BillingInvoicesView
                  key={invoiceFilterNonce}
                  lawFirmId={lawFirmId}
                  initialFilters={invoiceInitialFilters}
                />
              </>
            )}

            {activeView === "plans" && (
              <>
                <BillingViewHeader
                  title="Recurring plans"
                  description="Retainers and recurring arrangements that generate invoices automatically on a set schedule. Create a plan or manage existing ones here."
                />
                <BillingRecurringPlansPanel
                  lawFirmId={lawFirmId}
                  plans={workbench?.plans || []}
                  loading={workbenchLoading}
                  onCreatePlan={handleCreatePlan}
                />
              </>
            )}

            {activeView === "reports" && (
              <>
                <BillingViewHeader
                  title={`Billing by ${route.group === "client" ? "client" : "matter"}`}
                  description={`A financial roll-up of every ${route.group === "client" ? "client" : "matter"}: total billed, outstanding balance, hours tracked, and the next payment due. Switch the grouping below, then select a row to open its invoices.`}
                />
                {/* The reports read their own server-side aggregates - the
                    lifetime totals they show are a GROUP BY, not something the
                    browser can build from the lists on this page. */}
                <BillingReportsView
                  lawFirmId={lawFirmId}
                  group={route.group}
                  onGroupChange={(group) => updateSearch({ group: group === "client" ? "client" : null })}
                />
              </>
            )}

            {activeView === "setup" && (
              <>
                <BillingViewHeader
                  title="Rates & setup"
                  description="Configure how your firm bills: hourly rates, charge codes, late fees, and other billing preferences. Switch between Rates and Settings below."
                />
                <BillingSetupView
                  lawFirmId={lawFirmId}
                  sub={route.setupSub}
                  onSubChange={(sub) => updateSearch({ sub: sub === "settings" ? "settings" : null })}
                  chargeCodes={chargeCodes}
                  users={users}
                  chargeCodesLoading={chargeCodesLoading}
                  onRefreshChargeCodes={() => refetchChargeCodes()}
                />
              </>
            )}
          </>
        )}
        </div>

        <TimeEntryModal
          open={addTimeEntryOpen}
          onClose={() => {
            setAddTimeEntryOpen(false);
            setTimerPrefill(null);
          }}
          lawFirmId={lawFirmId}
          users={users}
          chargeCodes={chargeCodes}
          defaultUserId={user?.uid}
          prefill={timerPrefill}
          onSuccess={handleTimeEntrySuccess}
        />

        <AddFlatFeeModal
          open={addFlatFeeOpen}
          onClose={() => setAddFlatFeeOpen(false)}
          lawFirmId={lawFirmId}
          onSuccess={handleRefresh}
        />

        <AddExpenseModal
          open={addExpenseOpen}
          onClose={() => setAddExpenseOpen(false)}
          lawFirmId={lawFirmId}
          onSuccess={handleRefresh}
        />

      </div>
    </RequirePermission>
  );
}
