"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, GitBranch, Lock, ChevronRight, Pencil, AlertTriangle } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import dayjs from "dayjs";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Checkbox from "@/components/ui/Checkbox";
import { CLOSED_MATTER_STATUSES, isTerminalMatterStatus } from "@/lib/constants/matterStatus";
import MattersService from "@/services/matters.service";
import billingService from "@/services/billing.service";
import { getInvoiceRemainingBalance, isAwaitingPayment } from "@/components/billingComp/utils";
import { formatCurrency } from "@/lib/utils/currency";
import type { Matter, MatterStage } from "@/types";
import ErrorNotification from "@/components/ErrorNotification";
import SuccessNotification from "@/components/SuccessNotification";
import ManageStagesModal from "./ManageStagesModal";
import useMatterPipelines from "@/hooks/matterConfigHooks/useMatterPipelines";

/**
 * A step as the tracker renders it. `phase` drives the enter/exit animation:
 * `exit` steps are no longer on the matter's path but stay mounted until their
 * animation finishes, so moving back a stage plays out instead of snapping.
 */
type StageStep = { stage: MatterStage; phase: "idle" | "enter" | "exit" };

/** Longest of the stage-step animations in global.css, in ms. */
const STEP_ANIM_MS = 320;

/**
 * Horizontal pipeline tracker for a matter's current stage. Stages belong to a
 * named pipeline (matter_stage_pipelines), which the matter is explicitly
 * assigned to. Clicking a stage advances the matter to it (when the viewer can
 * edit). Tracks progress through the matter's lifecycle, distinct from the
 * coarse `status` badge.
 */
export default function MatterStageBar({
  lawFirmId,
  matter,
  canEdit,
  onChanged,
}: {
  lawFirmId: string;
  matter: Matter;
  canEdit: boolean;
  onChanged?: () => void;
}) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | Error | null>(null);
  // Confirms a side effect the viewer did not ask for directly (reopening a
  // matter that its ending stage had closed), then clears itself.
  const [notice, setNotice] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  // Set when the matter lands on an ending stage while its status is still open,
  // which offers to close the matter. Kept alongside a separate `open` flag so the
  // stage name survives the modal's exit animation.
  const [closePrompt, setClosePrompt] = useState<MatterStage | null>(null);
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const [closingMatter, setClosingMatter] = useState(false);
  // Mirrors closePrompt/closePromptOpen: set when the matter moves off a closed
  // ending stage while its status is still Closed/Completed, which offers to
  // reopen it. Kept separate from closePrompt so the two prompts never fight
  // over the same state, since they can never both apply to the same click.
  const [reopenPrompt, setReopenPrompt] = useState<MatterStage | null>(null);
  const [reopenPromptOpen, setReopenPromptOpen] = useState(false);
  const [reopeningMatter, setReopeningMatter] = useState(false);
  // Unbilled work found for the close prompt, so closing doesn't silently bury
  // it. Null while unchecked/loading, so the modal shows nothing rather than a
  // wrong "no unbilled work" claim before the fetch resolves.
  const [unbilledCheck, setUnbilledCheck] = useState<{
    hours: number;
    flatFeesAmount: number;
    outstandingAmount: number;
  } | null>(null);
  // Manual "payment ongoing" override offered alongside the unbilled-work
  // warning, so closing with money still expected doesn't require a separate
  // trip to Edit Matter to flag it. Defaults on once unbilled work is found.
  const [markPaymentOngoing, setMarkPaymentOngoing] = useState(false);

  const { pipelines } = useMatterPipelines(lawFirmId);

  const currentPipeline = useMemo(
    () => pipelines.find((p) => p.id === matter.stagePipelineId) || null,
    [pipelines, matter.stagePipelineId],
  );

  // Stages in the matter's assigned pipeline.
  const stages = useMemo(
    () => [...(currentPipeline?.stages ?? [])]
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    [currentPipeline],
  );

  const byId = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);

  // The path taken = ancestor chain of the current stage (walk parentStageId up).
  const path = useMemo(() => {
    const out: MatterStage[] = [];
    let cur = matter.stageId ? byId.get(matter.stageId) : undefined;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.unshift(cur);
      cur = cur.parentStageId ? byId.get(cur.parentStageId) : undefined;
    }
    return out;
  }, [byId, matter.stageId]);

  // Raw status values are lowercase/snake_case; title-case for display copy.
  const statusLabel = (matter.status || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  // Rendered steps: the path, plus the steps that just left it. Seeded from the
  // path so a matter opened with its stages already cached renders settled
  // rather than animating in on arrival.
  const [steps, setSteps] = useState<StageStep[]>(() =>
    path.map((stage) => ({ stage, phase: "idle" as const })),
  );
  const pathRef = useRef(path);
  pathRef.current = path;
  // Identity of `path` changes on every stage refetch; its contents rarely do.
  const pathKey = path.map((s) => s.id).join(">");
  // Set by `setStage` right before it fires the update that will eventually
  // change `pathKey`. The effect below consumes (and clears) it, so a path
  // change only plays the enter/exit animation when it traces back to that
  // click - never the initial load, a background refetch, or another viewer's
  // edit landing via `onChanged`.
  const stageClickRef = useRef(false);

  useEffect(() => {
    const animate = stageClickRef.current;
    stageClickRef.current = false;
    setSteps((prev) => {
      const held = prev.filter((s) => s.phase !== "exit");
      const heldIds = new Set(held.map((s) => s.stage.id));
      const nextIds = new Set(pathRef.current.map((s) => s.id));
      if (!animate) {
        return pathRef.current.map<StageStep>((stage) => ({ stage, phase: "idle" }));
      }
      return [
        ...pathRef.current.map<StageStep>((stage) => ({
          stage,
          phase: heldIds.has(stage.id) ? "idle" : "enter",
        })),
        // Abandoned steps trail the new path so they animate off its end.
        ...held.filter((s) => !nextIds.has(s.stage.id)).map<StageStep>((s) => ({ ...s, phase: "exit" })),
      ];
    });
  }, [pathKey]);

  // Once the animations have run, drop the departed steps and settle the rest so
  // a later change to the same step can animate again.
  useEffect(() => {
    if (steps.every((s) => s.phase === "idle")) return;
    const timer = setTimeout(() => {
      setSteps((prev) =>
        prev.filter((s) => s.phase !== "exit").map((s) => (s.phase === "idle" ? s : { ...s, phase: "idle" })),
      );
    }, STEP_ANIM_MS);
    return () => clearTimeout(timer);
  }, [steps]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Readable pieces of unbilled work to call out in the close prompt, e.g.
  // ["3.5h of unbilled time", "$120.00 in unbilled flat fees"].
  const unbilledParts = useMemo(() => {
    if (!unbilledCheck) return [];
    const parts: string[] = [];
    if (unbilledCheck.hours > 0) {
      const hours = Math.round(unbilledCheck.hours * 10) / 10;
      parts.push(`${hours}h of unbilled time`);
    }
    if (unbilledCheck.flatFeesAmount > 0) {
      parts.push(`${formatCurrency(unbilledCheck.flatFeesAmount)} in unbilled flat fees`);
    }
    if (unbilledCheck.outstandingAmount > 0) {
      parts.push(`${formatCurrency(unbilledCheck.outstandingAmount)} outstanding on invoices`);
    }
    return parts;
  }, [unbilledCheck]);

  const current = matter.stageId ? byId.get(matter.stageId) : undefined;
  // Next options: children of the current stage, or the roots if no stage is set yet.
  //
  // A non-ending stage with no children would otherwise be a dead end, which is
  // what a flat pipeline looks like: every stage added with plain "New stage" is
  // a root, so nothing is anyone's child. In that case fall back to the stage's
  // siblings (its co-roots, for a flat pipeline) so the matter can still move.
  // Ending stages keep an empty list so the bar shows "Completed" instead.
  const nextOptions = useMemo(() => {
    if (!current) return stages.filter((s) => !s.parentStageId);
    const children = stages.filter((s) => s.parentStageId === current.id);
    if (children.length || current.isClosed) return children;
    const inPath = new Set(path.map((s) => s.id));
    return stages.filter(
      (s) => s.id !== current.id && !inPath.has(s.id) && (s.parentStageId ?? null) === (current.parentStageId ?? null),
    );
  }, [stages, current, path]);

  async function setStage(stageId: string) {
    // No-op when it's already the current stage, or while another change is in flight.
    if (!canEdit || saving || stageId === matter.stageId) return;
    // Marks the path change this triggers as one to animate - see `stageClickRef`.
    stageClickRef.current = true;
    const target = byId.get(stageId);
    // Moving off an ending stage back into the pipeline would otherwise leave a
    // Closed status and close date behind, contradicting the stage the matter
    // is now on. Offer to reopen it instead of doing so silently. Archived
    // matters are left alone, since archiving is a filing decision rather than
    // an outcome this pipeline recorded.
    const reopening =
      !!current?.isClosed && !target?.isClosed && CLOSED_MATTER_STATUSES.includes(matter.status || "");
    setSaving(stageId);
    setError(null);
    setNotice(null);
    try {
      await MattersService.updateMatter({ lawFirmId, matterId: matter.id, stageId });
      // Refresh the matter detail and mark the matters list stale so navigating
      // back shows the new stage instead of the cached row.
      queryClient.invalidateQueries({ queryKey: ["matters", lawFirmId] });
      onChanged?.();

      if (reopening) {
        setReopenPrompt(target ?? null);
        setReopenPromptOpen(true);
      }

      // An ending stage records the outcome; it does not close the matter on its
      // own, because closing ends retainer plans and hides the matter from open
      // counts. Offer it instead of assuming it.
      if (target?.isClosed && !isTerminalMatterStatus(matter.status)) {
        setClosePrompt(target);
        setClosePromptOpen(true);
        setUnbilledCheck(null);
        setMarkPaymentOngoing(false);
        void checkUnbilledWork();
      }
    } catch (e) {
      setError(e instanceof Error ? e : String(e));
    } finally {
      setSaving(null);
    }
  }

  /** Accept the reopen prompt: set the matter back to Active and clear its close date. */
  async function confirmReopenMatter() {
    setReopeningMatter(true);
    setError(null);
    try {
      await MattersService.updateMatter({
        lawFirmId,
        matterId: matter.id,
        status: "active",
        closeDate: null,
      });
      queryClient.invalidateQueries({ queryKey: ["matters", lawFirmId] });
      onChanged?.();
      setReopenPromptOpen(false);
      setNotice("Matter reopened and set back to Active. Recurring billing plans that ended when it closed stay ended.");
    } catch (e) {
      setError(e instanceof Error ? e : String(e));
      setReopenPromptOpen(false);
    } finally {
      setReopeningMatter(false);
    }
  }

  /**
   * Unbilled time, unbilled flat fees, and outstanding invoice balances for
   * this matter, surfaced in the close prompt so closing doesn't quietly bury
   * work nobody's billed yet. Best-effort: a failure here shouldn't block the
   * prompt itself, so it just leaves the check out of the modal.
   */
  async function checkUnbilledWork() {
    try {
      const context = { type: "matter" as const, lawFirmId, entityId: matter.id };
      const [entries, fees, invoices] = await Promise.all([
        billingService.listTimeEntries(context, undefined, { unbilledOnly: true }),
        billingService.listFlatFees(context, { unbilledOnly: true }),
        billingService.listInvoices(context),
      ]);
      const hours = entries.filter((e) => e.billable !== false).reduce((sum, e) => sum + (e.hours || 0), 0);
      const flatFeesAmount = fees.reduce((sum, f) => sum + (f.amount || 0), 0);
      const outstandingAmount = invoices
        .filter(isAwaitingPayment)
        .reduce((sum, inv) => sum + getInvoiceRemainingBalance(inv), 0);
      setUnbilledCheck({ hours, flatFeesAmount, outstandingAmount });
      // Default the override on: closing with money still on the table is the
      // usual reason to want the "payment ongoing" badge. An outstanding
      // invoice balance already flags this automatically once the matter is
      // closed, but unbilled time/flat fees have no invoice to derive it from.
      if (hours > 0 || flatFeesAmount > 0 || outstandingAmount > 0) setMarkPaymentOngoing(true);
    } catch {
      setUnbilledCheck(null);
    }
  }

  /** Accept the close prompt: set the matter closed and stamp its close date. */
  async function confirmCloseMatter() {
    setClosingMatter(true);
    setError(null);
    try {
      await MattersService.updateMatter({
        lawFirmId,
        matterId: matter.id,
        status: "closed",
        // Only stamp a close date when the matter doesn't already carry one, so an
        // explicitly recorded date isn't overwritten by today's.
        ...(matter.closeDate ? {} : { closeDate: dayjs().format("YYYY-MM-DD") }),
        // Only sent while the unbilled-work checkbox is actually shown, so this
        // never clears a "payment ongoing" flag set some other way.
        ...(unbilledParts.length > 0 ? { paymentOngoing: markPaymentOngoing } : {}),
      });
      queryClient.invalidateQueries({ queryKey: ["matters", lawFirmId] });
      onChanged?.();
      setClosePromptOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e : String(e));
      setClosePromptOpen(false);
    } finally {
      setClosingMatter(false);
    }
  }

  if (!stages.length) {
    if (!canEdit) return null;
    return (
      <>
        <div className="rounded-lg border border-dashed border-outline bg-surface-alt px-4 py-3 text-sm text-on-surface-secondary flex flex-wrap items-center justify-between gap-2">
          <span>{currentPipeline ? "This pipeline has no stages yet." : "No pipeline is assigned to this matter."}</span>
          <button
            onClick={() => setManageOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 shadow-sm dark:shadow-none cursor-pointer"
          >
            <GitBranch size={13} strokeWidth={2.2} />
            Choose pipeline
          </button>
        </div>
        <ManageStagesModal
          open={manageOpen}
          onClose={() => setManageOpen(false)}
          lawFirmId={lawFirmId}
          matter={matter}
          onChanged={onChanged}
        />
      </>
    );
  }

  return (
    <div className="rounded-xl border border-outline bg-surface px-4 py-3.5">
      <ErrorNotification error={error} />
      {notice && (
        <SuccessNotification message={notice} onClose={() => setNotice(null)} compact className="mb-3" />
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {canEdit ? (
          <Tooltip title="Change pipeline" enterDelay={300}>
            <button
              type="button"
              onClick={() => setManageOpen(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-on-surface-secondary transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-surface-hover hover:text-on-surface cursor-pointer"
            >
              <Pencil size={12} />
              Stage
              {currentPipeline && (
                <span className="normal-case font-medium text-on-surface-muted">· {currentPipeline.name}</span>
              )}
            </button>
          </Tooltip>
        ) : (
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-on-surface-muted">
            Stage
            {currentPipeline && (
              <span className="normal-case font-medium"> · {currentPipeline.name}</span>
            )}
          </span>
        )}

        {/* Progress along the path the matter has taken (ancestors -> current).
            `min-w-0 flex-1` gives this a flex-basis of 0 instead of its content
            width, so the extra steps briefly held during the enter/exit
            animation scroll inside it instead of pushing the row's wrap
            calculation over and bumping the "Advance to" cluster onto its own
            line for the duration of the animation. */}
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-hide">
          {steps.length === 0 && (
            <span className="rounded-full bg-surface-alt px-3 py-1 text-xs font-medium text-on-surface-muted">
              Not started
            </span>
          )}
          {steps.map(({ stage, phase }, i) => {
            const isCurrent = stage.id === matter.stageId;
            const color = stage.color || "#6366f1";
            const clickable = canEdit && !isCurrent && phase !== "exit";
            const step = (
              <button
                type="button"
                disabled={!clickable || saving === stage.id}
                onClick={clickable ? () => setStage(stage.id) : undefined}
                className={`group flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-3 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 ${
                  isCurrent ? "bg-surface-alt" : ""
                } ${clickable ? "cursor-pointer hover:bg-surface-hover" : "cursor-default disabled:opacity-100"}`}
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white transition-all"
                  style={{
                    backgroundColor: color,
                    boxShadow: isCurrent ? `0 0 0 3px ${color}33` : undefined,
                  }}
                >
                  {isCurrent ? (
                    stage.isClosed ? (
                      <Lock size={11} strokeWidth={2.5} />
                    ) : (
                      <span className="h-2 w-2 rounded-full bg-white" />
                    )
                  ) : (
                    <Check size={12} strokeWidth={2.75} />
                  )}
                </span>
                <span
                  className={`whitespace-nowrap text-sm ${
                    isCurrent
                      ? "font-semibold text-on-surface"
                      : "font-medium text-on-surface-secondary group-hover:text-on-surface"
                  }`}
                >
                  {stage.name}
                </span>
              </button>
            );
            return (
              <span
                key={stage.id}
                className={`flex shrink-0 items-center ${
                  phase === "enter" ? "stage-step-enter" : phase === "exit" ? "stage-step-exit pointer-events-none" : ""
                }`}
                aria-hidden={phase === "exit" || undefined}
              >
                {i > 0 && (
                  <span
                    className="stage-connector mx-1 h-0.5 w-5 shrink-0 rounded-full"
                    style={{
                      background: `linear-gradient(to right, ${steps[i - 1].stage.color || "#6366f1"}, ${color})`,
                    }}
                  />
                )}
                {clickable ? (
                  <Tooltip title="Move back to this stage" enterDelay={400}>
                    <span className="shrink-0">{step}</span>
                  </Tooltip>
                ) : (
                  step
                )}
              </span>
            );
          })}
        </div>

        {/* Right-aligned cluster: advance the matter, and manage the pipeline.
            Keyed on the current stage so the options it offers animate in with
            the tracker rather than swapping under it - but only when the steps
            beside it are actually mid-transition (a click), not on first load. */}
        <div
          key={current?.id ?? "none"}
          className={`flex flex-wrap items-center gap-2 sm:ml-auto ${
            steps.some((s) => s.phase !== "idle") ? "stage-step-enter" : ""
          }`}
        >
          {/* Advance control: a single "next" button, or a fork of outcomes to pick from. */}
          {nextOptions.length > 0 && canEdit && (
            <>
              {nextOptions.length > 1 && (
                <span className="text-[11px] font-medium uppercase tracking-wide text-on-surface-muted">
                  Advance to
                </span>
              )}
              {nextOptions.map((stage) => {
                const single = nextOptions.length === 1;
                return (
                  <button
                    key={stage.id}
                    type="button"
                    disabled={saving === stage.id}
                    onClick={() => setStage(stage.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-outline-subtle bg-surface px-3 py-1.5 text-xs font-medium text-on-surface-secondary transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:border-accent-border-soft hover:bg-accent-soft hover:text-accent-emphasis disabled:opacity-60 dark:hover:border-accent-border-soft/40 dark:hover:bg-accent-soft dark:hover:text-accent-emphasis cursor-pointer"
                  >
                    {stage.isClosed && <Lock size={12} />}
                    <span>{single ? `Advance to ${stage.name}` : stage.name}</span>
                    {single && !stage.isClosed && <ChevronRight size={14} />}
                  </button>
                );
              })}
            </>
          )}

          {/* Terminal: the matter has reached an ending, nothing further to advance to. */}
          {nextOptions.length === 0 && current?.isClosed && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300">
              <Check size={12} strokeWidth={3} /> Completed
            </span>
          )}
        </div>
      </div>

      <ManageStagesModal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        lawFirmId={lawFirmId}
        matter={matter}
        onChanged={onChanged}
      />

      <ConfirmModal
        isOpen={closePromptOpen}
        onClose={() => setClosePromptOpen(false)}
        onConfirm={() => void confirmCloseMatter()}
        title="Mark matter as closed?"
        message={`This matter reached "${closePrompt?.name || ""}", an ending stage of its pipeline, but its status is still ${statusLabel}. Set the status to Closed?`}
        confirmText="Mark as closed"
        cancelText="Not yet"
        confirmType="primary"
        loading={closingMatter}
        extra={
          <div className="space-y-2">
            {unbilledParts.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  This matter still has{" "}
                  {new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(unbilledParts)}. Closing
                  it won&apos;t bill or collect this automatically.
                </span>
              </div>
            )}
            {unbilledParts.length > 0 && (
              <Checkbox
                checked={markPaymentOngoing}
                onChange={setMarkPaymentOngoing}
                size="sm"
                label="Flag as payment ongoing"
                description={
                  <>
                    Shows a &quot;Payment ongoing&quot; badge on this closed matter and keeps it out of
                    fully-settled views until it&apos;s billed and paid.
                  </>
                }
                className="items-start rounded-md border border-outline bg-surface-alt px-3 py-2"
              />
            )}
            <div className="rounded-md border border-outline bg-surface-alt px-3 py-2 text-xs text-on-surface-secondary">
              {matter.closeDate
                ? "Any recurring billing plans on this matter set to end when the matter closes will be ended."
                : "The close date will be set to today, and any recurring billing plans on this matter set to end when the matter closes will be ended."}
            </div>
          </div>
        }
      />

      <ConfirmModal
        isOpen={reopenPromptOpen}
        onClose={() => setReopenPromptOpen(false)}
        onConfirm={() => void confirmReopenMatter()}
        title="Reopen this matter?"
        message={`This matter moved off "${reopenPrompt?.name || ""}" back into the pipeline, but its status is still ${statusLabel}. Set the status back to Active?`}
        confirmText="Reopen matter"
        cancelText="Leave closed"
        confirmType="primary"
        loading={reopeningMatter}
      />
    </div>
  );
}
