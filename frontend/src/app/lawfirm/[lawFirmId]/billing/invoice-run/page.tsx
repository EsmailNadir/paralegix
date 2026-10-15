"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "next/navigation";
import dayjs from "dayjs";
import { Building2, Check, FileText, Folder, Percent } from "lucide-react";
import BackButton from "@/components/ui/BackButton";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import DatePicker from "@/components/ui/DatePicker";
import ErrorNotification from "@/components/ErrorNotification";
import ListSkeleton from "@/components/ui/ListSkeleton";
import PageHeader from "@/components/ui/PageHeader";
import RequirePermission from "@/components/ui/RequirePermission";
import { FIELD_LABEL_BLOCK_CLS, FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useNavigation } from "@/contexts/NavigationContext";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { formatHoursMinutes } from "@/lib/utils/format";
import billingService, { type FirmUnbilledSummary } from "@/services/billing.service";
import MattersService from "@/services/matters.service";
import type { MatterClient } from "@/types";
import { formatCurrency } from "@/components/billingComp/utils";

/** One billing target on this run, and whether it is included. */
interface RunTarget extends FirmUnbilledSummary {
  selected: boolean;
  /** Payer shares, when the matter is configured for split billing. */
  splitShares: { name: string; percent: number }[];
}

/**
 * Read the `contexts` query parameter, which narrows the run to specific
 * targets. Format is `type:entityId`, comma separated. Absent means the run
 * covers everything with unbilled work.
 */
function parseRequestedContexts(raw: string | null): Set<string> | null {
  if (!raw) return null;
  const keys = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.includes(":"));
  return keys.length > 0 ? new Set(keys) : null;
}

function parseRequestedTimeEntryIds(raw: string | null): string[] | null {
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : null;
}

/**
 * Prepare invoices.
 *
 * One screen for every way a firm bills: one matter, several matters, a client's
 * direct work, or everything outstanding at once. The list of targets is what
 * varies; the settings and the commit do not. Before this existed the same job
 * was spread across two modals and two pages, and which one you got depended on
 * facts about your selection you could not see.
 *
 * A matter configured for split billing produces one invoice per payer. That is
 * shown here as a share breakdown rather than as a separate flow, because the
 * split is already decided on the matter.
 */
export default function InvoiceRunPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const { navigate } = useNavigation();

  const lawFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string);

  const requestedContexts = useMemo(
    () => parseRequestedContexts(searchParams.get("contexts")),
    [searchParams],
  );
  const requestedTimeEntryIds = useMemo(
    () => parseRequestedTimeEntryIds(searchParams.get("timeEntryIds")),
    [searchParams],
  );

  // Query rather than a hand-rolled effect: the page is a read plus a write, and
  // the read is exactly the shape React Query already manages everywhere else.
  const {
    data: loadedTargets,
    isLoading: loading,
    error: loadQueryError,
    refetch,
  } = useQuery({
    queryKey: ["billing", "invoice-run", lawFirmId, searchParams.get("contexts")],
    enabled: Boolean(lawFirmId),
    staleTime: 30_000,
    queryFn: async (): Promise<RunTarget[]> => {
      const summaries = await billingService.listFirmUnbilledSummaries(lawFirmId);
      const inScope = requestedContexts
        ? summaries.filter((summary) => requestedContexts.has(`${summary.type}:${summary.entityId}`))
        : summaries;

      // One batch request for the payer shares of every matter on the run, and
      // only for the matters actually on it, so narrowing by `contexts` narrows
      // the work too. Asking per matter meant a run over a firm's whole unbilled
      // backlog opened one simultaneous request per matter, each holding one of
      // the API instance's twelve Postgres pool connections.
      const matterIds = inScope
        .filter((summary) => summary.type === "matter")
        .map((summary) => summary.entityId);

      let clientsByMatterId: Record<string, MatterClient[]> = {};
      if (matterIds.length > 0) {
        try {
          clientsByMatterId = await MattersService.listClientsForMatters(lawFirmId, matterIds);
        } catch {
          // Matters whose clients cannot be read still bill; they just bill
          // without a split, which is what the server would do anyway.
          clientsByMatterId = {};
        }
      }

      return inScope.map((summary): RunTarget => {
        if (summary.type !== "matter") {
          return { ...summary, selected: true, splitShares: [] };
        }
        // A matter missing from the map is one this user may not read. It bills
        // whole, exactly as it did when the per-matter read answered 403.
        const clients = clientsByMatterId[summary.entityId] || [];
        const configured =
          clients.length > 1 &&
          clients.every((client) => typeof client.billingPortionBp === "number") &&
          clients.reduce((sum, client) => sum + (client.billingPortionBp as number), 0) === 10000;
        return {
          ...summary,
          selected: true,
          splitShares: configured
            ? clients.map((client) => ({
                name: client.name || client.email || client.id,
                percent: (client.billingPortionBp as number) / 100,
              }))
            : [],
        };
      });
    },
  });

  // Selection is local to this run, so it lives beside the query rather than in
  // it: refetching must not silently re-tick a target the user unticked.
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const targets = useMemo(
    () =>
      (loadedTargets || []).map((target) => ({
        ...target,
        selected: !deselected.has(`${target.type}:${target.entityId}`),
      })),
    [loadedTargets, deselected],
  );

  const loadError = loadQueryError
    ? getErrorMessage(loadQueryError, "Failed to load the work waiting to be billed")
    : null;

  const [invoiceDate, setInvoiceDate] = useState(dayjs().format("YYYY-MM-DD"));
  const [dueDate, setDueDate] = useState(() => dayjs().add(30, "day").format("YYYY-MM-DD"));
  const [invoicePrefix, setInvoicePrefix] = useState("INV-");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    created: number;
    skipped: string[];
    errors: Record<string, string>;
    createdIds?: string[];
  } | null>(null);

  const selected = targets.filter((target) => target.selected);

  // A split matter yields one invoice per payer, so the count of drafts is not
  // the count of targets. Saying "Create 2 drafts" when three will appear is the
  // kind of small lie that makes people stop trusting the number.
  const draftCount = selected.reduce(
    (sum, target) => sum + Math.max(target.splitShares.length, 1),
    0,
  );
  const totalAmount = selected.reduce((sum, target) => sum + target.unbilledAmount, 0);
  const totalHours = selected.reduce((sum, target) => sum + target.unbilledHours, 0);

  const toggleTarget = (entityId: string, type: string) => {
    const key = `${type}:${entityId}`;
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allSelected = targets.length > 0 && targets.every((target) => target.selected);

  async function handleCreate() {
    if (selected.length === 0) return;
    setCreating(true);
    setCreateError(null);
    try {
      const response = await billingService.bulkCreateInvoices(lawFirmId, {
        contexts: selected.map((target) => ({
          type: target.type,
          entityId: target.entityId,
          ...(requestedTimeEntryIds ? { timeEntryIds: requestedTimeEntryIds } : {}),
        })),
        invoiceDate,
        dueDate: dueDate || null,
        invoiceNamePrefix: invoicePrefix.trim() || "INV-",
      });

      // Say what happened, then go where the result is. One invoice has a page
      // of its own; several are only comparable in the list.
      if (response.created.length === 1 && response.failed.length === 0) {
        const inv = response.created[0] as any;
        if (inv.matterId || inv.contextType === "matter") {
          const matterId = inv.matterId || inv.entityId;
          navigate(`/lawfirm/${lawFirmId}/matters/${matterId}/invoices/${inv.id}`);
        } else {
          const clientId = inv.clientId || inv.clientContextId || inv.entityId;
          navigate(`/lawfirm/${lawFirmId}/client-invoice/${inv.id}?clientId=${clientId}`);
        }
        return;
      }

      const createdIds = (response.created || [])
        .map((inv: any) => inv.id)
        .filter(Boolean);

      setResult({
        created: response.created.length,
        skipped: response.skipped || [],
        errors: response.errors || {},
        createdIds,
      });
    } catch (err) {
      setCreateError(getErrorMessage(err, "Failed to create the invoices"));
    } finally {
      setCreating(false);
    }
  }

  return (
    <RequirePermission permission="billing.manageInvoices" page>
      <div className="p-4 md:p-6 max-w-[1100px] mx-auto">
        <BackButton href={`/lawfirm/${lawFirmId}/billing?view=time`} label="Back to billing" />

        <PageHeader
          className="mb-6"
          eyebrow="Billing"
          title="Prepare invoices"
          description={
            requestedContexts
              ? "Review the work on the matters and clients you selected, then create the drafts."
              : "Every matter and client with work waiting to be billed. Uncheck anything you are not billing yet."
          }
        />

        <ErrorNotification error={loadError} />
        <ErrorNotification error={createError} onClose={() => setCreateError(null)} />

        {result ? (
          <div className="rounded-2xl border border-outline-subtle bg-surface p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
                <Check size={18} />
              </span>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-on-surface">
                  {result.created} draft {result.created === 1 ? "invoice" : "invoices"} created
                </h2>
                {result.skipped.length > 0 && (
                  <p className="mt-1 text-sm text-on-surface-secondary">
                    {result.skipped.length} skipped, with nothing left to bill.
                  </p>
                )}
                {Object.keys(result.errors).length > 0 && (
                  <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3">
                    <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
                      {Object.keys(result.errors).length} could not be billed
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {Object.entries(result.errors).map(([entityId, message]) => (
                        <li key={entityId} className="text-xs text-on-surface-secondary">
                          {targets.find((t) => t.entityId === entityId)?.name || entityId}: {message}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="primary"
                    onClick={() => {
                      const highlightParam =
                        result.createdIds && result.createdIds.length > 0
                          ? `&highlight=${encodeURIComponent(result.createdIds.join(","))}`
                          : "";
                      navigate(`/lawfirm/${lawFirmId}/billing?view=invoices${highlightParam}`);
                    }}
                  >
                    View invoices
                  </Button>
                  <Button type="secondary" onClick={() => { setResult(null); void refetch(); }}>
                    Prepare more
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : loading ? (
          <ListSkeleton rows={4} label="Loading" />
        ) : targets.length === 0 ? (
          <div className="rounded-2xl border border-outline-subtle bg-surface p-10 text-center shadow-sm">
            <FileText size={40} className="mx-auto text-on-surface-muted" />
            <h2 className="mt-3 text-lg font-semibold text-on-surface">Nothing to bill</h2>
            <p className="mt-1 text-sm text-on-surface-secondary">
              Every matter and client is up to date. Log time or add a fee, then come back.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Checkbox
                checked={allSelected}
                onChange={(next) =>
                  setDeselected(
                    next
                      ? new Set()
                      : new Set(targets.map((target) => `${target.type}:${target.entityId}`)),
                  )
                }
                label={`${selected.length} of ${targets.length} selected`}
              />
              <p className="text-xs tabular-nums text-on-surface-secondary">
                {formatHoursMinutes(totalHours)} · {formatCurrency(totalAmount)}
              </p>
            </div>

            <div className="space-y-3">
              {targets.map((target) => (
                <div
                  key={`${target.type}-${target.entityId}`}
                  className={`rounded-2xl border bg-surface p-4 shadow-sm transition-colors ${
                    target.selected ? "border-accent-control-ring" : "border-outline-subtle"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={target.selected}
                      onChange={() => toggleTarget(target.entityId, target.type)}
                    />
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-alt text-on-surface-muted">
                      {target.type === "matter" ? <Folder size={16} /> : <Building2 size={16} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-on-surface">{target.name}</p>
                      <p className="mt-0.5 text-xs text-on-surface-muted">
                        {target.type === "matter" ? "Matter" : "Client"} ·{" "}
                        {formatHoursMinutes(target.unbilledHours)}
                        {target.unbilledFlatFees > 0 &&
                          ` · ${target.unbilledFlatFees} flat ${target.unbilledFlatFees === 1 ? "fee" : "fees"}`}
                      </p>

                      {target.splitShares.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 text-xs text-on-surface-secondary">
                            <Percent size={12} />
                            Split into {target.splitShares.length} invoices:
                          </span>
                          {target.splitShares.map((share) => (
                            <span
                              key={share.name}
                              className="inline-flex items-center rounded-full border border-outline-subtle bg-surface px-2.5 py-0.5 text-xs font-medium text-on-surface"
                            >
                              {share.name} · {share.percent}%
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <p className="shrink-0 text-sm font-semibold tabular-nums text-on-surface">
                      {formatCurrency(target.unbilledAmount)}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-outline-subtle bg-surface p-4 shadow-sm">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-on-surface-muted">
                Applies to every invoice
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label className={FIELD_LABEL_BLOCK_CLS}>Invoice date</label>
                  <DatePicker value={invoiceDate} onChange={setInvoiceDate} className="w-full" />
                </div>
                <div>
                  <label className={FIELD_LABEL_BLOCK_CLS}>Due date</label>
                  <DatePicker value={dueDate} onChange={setDueDate} className="w-full" />
                </div>
                <div>
                  <label className={FIELD_LABEL_BLOCK_CLS}>Number prefix</label>
                  <input
                    type="text"
                    value={invoicePrefix}
                    onChange={(event) => setInvoicePrefix(event.target.value)}
                    placeholder="INV-"
                    className={FULL_INPUT_CLS}
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-outline-subtle bg-surface-alt p-4">
              <p className="text-sm text-on-surface-secondary">
                Total:{" "}
                <span className="font-semibold tabular-nums text-on-surface">
                  {formatCurrency(totalAmount)}
                </span>
              </p>
              <Button
                type="primary"
                onClick={handleCreate}
                loading={creating}
                disabled={selected.length === 0}
              >
                Create {draftCount} {draftCount === 1 ? "draft" : "drafts"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </RequirePermission>
  );
}
