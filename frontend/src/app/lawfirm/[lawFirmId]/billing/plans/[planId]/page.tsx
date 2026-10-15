"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import dayjs from "dayjs";
import Button from "@/components/ui/Button";
import BackButton from "@/components/ui/BackButton";
import billingService from "@/services/billing.service";
import { useNavigation } from "@/contexts/NavigationContext";
import RequirePermission from "@/components/ui/RequirePermission";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import type { BillingPlan } from "@/types";
import { formatHoursMinutes } from "@/lib/utils/format";
import {
  Calendar,
  FileText,
  ExternalLink,
  Clock3,
} from "lucide-react";
import StatusBadge from "@/components/ui/StatusBadge";
import ListEmptyState from "@/components/ui/ListEmptyState";
import TruncatedListNotice from "@/components/ui/TruncatedListNotice";
import { billingPlanStatusMeta } from '@/constants/statusMeta';
import { getErrorMessage } from "@/lib/utils/apiErrors";
import {
  formatCurrency,
  getInvoiceDestination,
} from "@/components/billingComp/utils";

export default function BillingPlanDetailPage() {
  const params = useParams();
  const { navigate } = useNavigation();

  const lawFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string);
  const planId = Array.isArray(params?.planId)
    ? params.planId[0]
    : (params?.planId as string);

  const [plan, setPlan] = useState<BillingPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingPeriodId, setCreatingPeriodId] = useState<string | null>(null);

  const loadPlan = useCallback(async () => {
    if (!lawFirmId || !planId) return;
    setLoading(true);
    setError(null);
    try {
      const nextPlan = await billingService.getPlan(lawFirmId, planId);
      setPlan(nextPlan);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load billing plan"));
    } finally {
      setLoading(false);
    }
  }, [lawFirmId, planId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: loading/result/error state set as the plan request progresses
    void loadPlan();
  }, [loadPlan]);

  const readyPeriods = useMemo(
    () => (plan?.periods || []).filter((period) => period.status === "ready_to_bill"),
    [plan]
  );

  const latestGeneratedPeriod = useMemo(
    () => (plan?.periods || []).find((period) => period.generatedInvoiceId) || null,
    [plan]
  );

  const handleCreateInvoice = useCallback(
    async (periodId: string) => {
      if (!plan) return;
      setCreatingPeriodId(periodId);
      setError(null);
      try {
        const result = await billingService.createDraftFromPlanPeriod(lawFirmId, plan.id, periodId);
        await loadPlan();
        const destination = getInvoiceDestination(lawFirmId, result.invoice);
        if (destination) {
          navigate(destination);
        }
      } catch (err) {
        setError(getErrorMessage(err, "Failed to create invoice"));
      } finally {
        setCreatingPeriodId(null);
      }
    },
    [lawFirmId, loadPlan, navigate, plan]
  );

  if (loading) {
    return <LoadingSpinner fullPage />;
  }

  if (!plan) {
    return (
      <RequirePermission permission="billing.viewPlans" page>
        <div className="min-h-screen bg-page">
          <div className="mx-auto max-w-4xl px-4 py-8">
            <Button type="secondary" onClick={() => navigate("/lawfirm/" + lawFirmId + "/billing")}>
              Back to Billing
            </Button>
            <div className="mt-6 rounded-2xl border border-outline bg-surface p-8">
              {error ? (
                <ErrorNotification error={error} onClose={() => setError(null)} />
              ) : (
                <p className="text-sm text-on-surface-secondary">Billing plan not found.</p>
              )}
            </div>
          </div>
        </div>
      </RequirePermission>
    );
  }

  return (
    <RequirePermission permission="billing.viewPlans" page>
      <div className="min-h-screen bg-page">
        <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
          <div className="mb-6 flex items-center justify-between gap-3">
            <BackButton href={`/lawfirm/${lawFirmId}/billing`} label="Back to Billing" variant="link" />
            <Button
              type="secondary"
              onClick={() => void loadPlan()}
            >
              Refresh
            </Button>
          </div>

          {error && (
            <div className="mb-4">
              <ErrorNotification error={error} onClose={() => setError(null)} />
            </div>
          )}

          <section className="rounded-2xl border border-outline bg-surface p-5 md:p-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-bold text-on-surface">
                    {plan.name || "Evergreen Retainer"}
                  </h1>
                  <StatusBadge variant="success">Recurring Retainer</StatusBadge>
                  <StatusBadge variant={billingPlanStatusMeta(plan.status).variant}>
                    {billingPlanStatusMeta(plan.status).label}
                  </StatusBadge>
                </div>
                <p className="mt-2 text-sm text-on-surface-secondary">
                  {plan.contextType === "matter" ? "Matter" : "Client"} billing plan
                  {plan.matterName || plan.clientName ? ` • ${[plan.matterName, plan.clientName].filter(Boolean).join(" • ")}` : ""}
                </p>
                <p className="mt-1 text-sm text-on-surface-secondary">
                  {formatCurrency(plan.amount)} every {plan.intervalCount} {plan.intervalUnit}
                  {plan.intervalCount === 1 ? "" : "s"}
                  {plan.includedHours > 0 ? ` • ${formatHoursMinutes(plan.includedHours)} included` : ""}
                </p>
              </div>
              <div className="rounded-xl border border-outline bg-surface-alt/60 px-4 py-3 text-sm">
                <p className="font-medium text-on-surface">Next run</p>
                <p className="mt-1 text-on-surface-secondary">
                  {plan.nextRunDate ? dayjs(plan.nextRunDate).format("MMM D, YYYY") : "TBD"}
                </p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-outline bg-surface-alt/50 p-4">
                <p className="text-xs uppercase tracking-[0.08em] text-on-surface-muted">Ready To Bill</p>
                <p className="mt-2 text-2xl font-semibold text-on-surface">{readyPeriods.length}</p>
              </div>
              <div className="rounded-xl border border-outline bg-surface-alt/50 p-4">
                <p className="text-xs uppercase tracking-[0.08em] text-on-surface-muted">Latest Invoice</p>
                <p className="mt-2 text-sm font-medium text-on-surface">
                  {latestGeneratedPeriod?.generatedInvoiceId ? "Invoice created" : "No invoice yet"}
                </p>
              </div>
              <div className="rounded-xl border border-outline bg-surface-alt/50 p-4">
                <p className="text-xs uppercase tracking-[0.08em] text-on-surface-muted">Ends</p>
                <p className="mt-2 text-sm font-medium text-on-surface">
                  {plan.endCondition === "matter_closed"
                    ? "When matter closes"
                    : plan.endCondition === "date" && plan.endDate
                      ? dayjs(plan.endDate).format("MMM D, YYYY")
                      : "Manually"}
                </p>
              </div>
            </div>
          </section>

          <section className="mt-6 rounded-2xl border border-outline bg-surface p-5 md:p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-on-surface-muted">
                  Billing Periods
                </p>
                <h2 className="mt-1 text-lg font-semibold text-on-surface">
                  Recurring retainer periods
                </h2>
              </div>
            </div>

            {/*
              The server caps the period read and drops the OLDEST periods, so
              this list can be a recent window rather than the plan's full
              billing history. Say so: a firm reads this page to decide what has
              and has not been invoiced, and a silently shortened history is a
              period that looks like it was never billed.
            */}
            <TruncatedListNotice
              truncated={plan.periodsTruncated}
              unitLabel="billing periods"
              mode="firmList"
              className="mb-3"
            />

            {(plan.periods || []).length === 0 ? (
              <ListEmptyState compact title="No billing periods yet" />
            ) : (
              <div className="space-y-3">
                {(plan.periods || []).map((period) => {
                  const invoiceDestination =
                    period.generatedInvoiceId && period.generatedInvoiceEntityId
                      ? getInvoiceDestination(lawFirmId, {
                          id: period.generatedInvoiceId,
                          contextType: period.generatedInvoiceContextType || plan.contextType,
                          entityId: period.generatedInvoiceEntityId,
                          matterId: period.generatedInvoiceContextType === "matter" ? period.generatedInvoiceEntityId : null,
                          clientContextId: period.generatedInvoiceContextType === "client" ? period.generatedInvoiceEntityId : null,
                          clientId: period.generatedInvoiceContextType === "client" ? period.generatedInvoiceEntityId : null,
                        })
                      : null;

                  return (
                    <div
                      key={period.id}
                      className="rounded-xl border border-outline bg-surface-alt/30 p-4"
                    >
                      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-on-surface">
                              {period.periodStartDate && period.periodEndDate
                                ? `${dayjs(period.periodStartDate).format("MMM D, YYYY")} to ${dayjs(period.periodEndDate).format("MMM D, YYYY")}`
                                : "Billing period"}
                            </span>
                            <span className="rounded-full bg-surface px-2.5 py-0.5 text-xs font-medium text-on-surface-secondary">
                              {period.status.replace(/_/g, " ")}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-on-surface-secondary">
                            <span className="inline-flex items-center gap-1">
                              <Calendar className="h-3.5 w-3.5" />
                              Due {period.dueDate ? dayjs(period.dueDate).format("MMM D, YYYY") : "TBD"}
                            </span>
                            <span>{formatCurrency(period.amount)}</span>
                            <span>{formatHoursMinutes(period.overageHours)} overage</span>
                            {period.generatedAt && (
                              <span className="inline-flex items-center gap-1">
                                <Clock3 className="h-3.5 w-3.5" />
                                Invoiced {dayjs(period.generatedAt).format("MMM D, YYYY")}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {invoiceDestination ? (
                            <Button
                              type="secondary"
                              onClick={() => navigate(invoiceDestination)}
                            >
                              <span className="flex items-center gap-1">
                                <FileText className="h-4 w-4" />
                                View Invoice
                              </span>
                            </Button>
                          ) : null}
                          {period.status === "ready_to_bill" && (
                            <Button
                              type="primary"
                              loading={creatingPeriodId === period.id}
                              onClick={() => void handleCreateInvoice(period.id)}
                            >
                              Create Invoice
                            </Button>
                          )}
                          {plan.contextType === "matter" ? (
                            <Button
                              type="secondary"
                              onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${plan.entityId}/invoices`)}
                            >
                              <span className="flex items-center gap-1">
                                <ExternalLink className="h-4 w-4" />
                                Matter Invoices
                              </span>
                            </Button>
                          ) : (
                            <Button
                              type="secondary"
                              onClick={() => navigate(`/lawfirm/${lawFirmId}/clients/${plan.entityId}?tab=billing`)}
                            >
                              <span className="flex items-center gap-1">
                                <ExternalLink className="h-4 w-4" />
                                Client Billing
                              </span>
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </RequirePermission>
  );
}
