"use client";

import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Pencil } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import ActionIconButton from "@/components/ui/ActionIconButton";
import Dropdown from "@/components/ui/Dropdown";
import DatePicker from "@/components/ui/DatePicker";
import DateRangePicker from "@/components/ui/DateRangePicker";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import useInterestRemittances from "@/hooks/trustHooks/useInterestRemittances";
import trustService from "@/services/trust.service";
import { usePermissions } from "@/contexts/PermissionsContext";
import { formatCents } from "@/lib/utils/currency";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import { AutoPager } from "@/components/ui/ListPager";
import usePagedRows from "@/hooks/usePagedRows";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import { trustRemittanceStatusMeta, TRUST_REMITTANCE_STATUS_META } from "@/constants/statusMeta";
import StatusBadge from "@/components/ui/StatusBadge";
import TruncatedListNotice from "@/components/ui/TruncatedListNotice";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import {
  type TrustAccount,
  type TrustInterestRemittance,
  type TrustRemittanceStatus,
} from "@/types/trust";

interface InterestRemittancesProps {
  lawFirmId: string;
  accounts: TrustAccount[];
}

const formatPeriod = (start?: string | null, end?: string | null) => {
  const fmt = (d: string) => formatDateOnly(d);
  if (start && end) return `${fmt(start)} - ${fmt(end)}`;
  if (start) return `From ${fmt(start)}`;
  if (end) return `Through ${fmt(end)}`;
  return "No period set";
};

export default function InterestRemittances({ lawFirmId, accounts }: InterestRemittancesProps) {
  const fieldIds = useId();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("trust.manage");
  const queryClient = useQueryClient();
  const { remittances, loading, truncated } = useInterestRemittances(lawFirmId);

  // Remittances are generated per account per period and never pruned, so the
  // rendered rows are windowed.
  const remittancesPager = usePagedRows(remittances, 25);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<TrustInterestRemittance | null>(null);
  const [trustAccountId, setTrustAccountId] = useState(accounts[0]?.id || "");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [interestEarned, setInterestEarned] = useState("");
  const [amountRemitted, setAmountRemitted] = useState("");
  const [remittedTo, setRemittedTo] = useState("");
  const [remittanceDate, setRemittanceDate] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<TrustRemittanceStatus>("pending");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<TrustInterestRemittance | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["trustRemittances", lawFirmId] });

  const resetForm = () => {
    setEditing(null);
    setTrustAccountId(accounts[0]?.id || "");
    setPeriodStart("");
    setPeriodEnd("");
    setInterestEarned("");
    setAmountRemitted("");
    setRemittedTo("");
    setRemittanceDate("");
    setReferenceNumber("");
    setNotes("");
    setStatus("pending");
    setError(null);
  };

  const openCreate = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (r: TrustInterestRemittance) => {
    setEditing(r);
    setTrustAccountId(r.trustAccountId);
    setPeriodStart(r.periodStart || "");
    setPeriodEnd(r.periodEnd || "");
    setInterestEarned(r.interestEarnedCents ? (r.interestEarnedCents / 100).toFixed(2) : "");
    setAmountRemitted(r.amountRemittedCents ? (r.amountRemittedCents / 100).toFixed(2) : "");
    setRemittedTo(r.remittedTo || "");
    setRemittanceDate(r.remittanceDate || "");
    setReferenceNumber(r.referenceNumber || "");
    setNotes(r.notes || "");
    setStatus(r.status);
    setError(null);
    setShowForm(true);
  };

  const closeForm = () => setShowForm(false);

  useResetAfterClose(showForm, resetForm);

  const handleSave = async () => {
    setError(null);
    if (!trustAccountId) {
      setError("Please select an account");
      return;
    }

    const parseDollars = (v: string): number | undefined => {
      if (!v.trim()) return undefined;
      const cents = Math.round(parseFloat(v) * 100);
      return isNaN(cents) ? undefined : cents;
    };

    const interestEarnedCents = parseDollars(interestEarned);
    const amountRemittedCents = parseDollars(amountRemitted);
    if (interestEarned.trim() && interestEarnedCents === undefined) {
      setError("Interest earned must be a valid number");
      return;
    }
    if (amountRemitted.trim() && amountRemittedCents === undefined) {
      setError("Amount remitted must be a valid number");
      return;
    }

    const payload = {
      trustAccountId,
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
      interestEarnedCents: interestEarnedCents ?? 0,
      amountRemittedCents: amountRemittedCents ?? 0,
      remittedTo: remittedTo || null,
      remittanceDate: remittanceDate || null,
      referenceNumber: referenceNumber || null,
      notes: notes || null,
      status,
    };

    setSaving(true);
    try {
      if (editing) {
        await trustService.updateRemittance(lawFirmId, editing.id, payload);
      } else {
        await trustService.createRemittance(lawFirmId, payload);
      }
      invalidate();
      closeForm();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save interest remittance"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setDeleteLoading(true);
    try {
      await trustService.deleteRemittance(lawFirmId, deleting.id);
      invalidate();
      setDeleting(null);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to remove interest remittance"));
    } finally {
      setDeleteLoading(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
  const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

  return (
    <div className="bg-surface rounded-xl border border-outline-subtle">
      <div className="flex items-center justify-between px-5 py-4 border-b border-outline-subtle">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">Interest Remittances</h3>
          <p className="text-xs text-on-surface-muted mt-0.5">
            Track IOLTA interest earned and amounts remitted to the bar foundation.
          </p>
        </div>
        {canManage && !showForm && (
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            <Plus size={14} />
            Add Remittance
          </button>
        )}
      </div>

      {showForm && canManage && (
        <div className="px-5 py-4 border-b border-outline-subtle bg-surface-alt/50 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Dropdown
                label="Account *"
                value={trustAccountId}
                onChange={setTrustAccountId}
                options={accounts.map((a) => ({ value: a.id, label: a.name }))}
                placeholder="Select account"
                labelClassName={labelClass}
                buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
              />
            </div>
            <div>
              <Dropdown
                label="Status"
                value={status}
                onChange={(value) => setStatus(value as TrustRemittanceStatus)}
                options={[
                  { value: "pending", label: TRUST_REMITTANCE_STATUS_META.pending.label },
                  { value: "remitted", label: TRUST_REMITTANCE_STATUS_META.remitted.label },
                ]}
                labelClassName={labelClass}
                buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Period</label>
            <DateRangePicker
              from={periodStart}
              to={periodEnd}
              onChange={(next) => { setPeriodStart(next.from ?? ""); setPeriodEnd(next.to ?? ""); }}
              className="w-full"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${fieldIds}-interestearned`} className={labelClass}>Interest earned ($)</label>
              <input
                id={`${fieldIds}-interestearned`}
                type="number"
                step="0.01"
                min="0"
                value={interestEarned}
                onChange={(e) => setInterestEarned(e.target.value)}
                placeholder="0.00"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor={`${fieldIds}-amountremitted`} className={labelClass}>Amount remitted ($)</label>
              <input
                id={`${fieldIds}-amountremitted`}
                type="number"
                step="0.01"
                min="0"
                value={amountRemitted}
                onChange={(e) => setAmountRemitted(e.target.value)}
                placeholder="0.00"
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${fieldIds}-remittedto`} className={labelClass}>Remitted to</label>
              <input
                id={`${fieldIds}-remittedto`}
                type="text"
                value={remittedTo}
                onChange={(e) => setRemittedTo(e.target.value)}
                placeholder="Bar foundation, client, etc."
                className={inputClass}
              />
            </div>
            <div>
              <label id={`${fieldIds}-remittance-date-label`} className={labelClass}>Remittance date</label>
              <DatePicker
                ariaLabelledBy={`${fieldIds}-remittance-date-label`}
                value={remittanceDate} onChange={setRemittanceDate} className="w-full" />
            </div>
          </div>

          <div>
            <label htmlFor={`${fieldIds}-referencenumber`} className={labelClass}>Reference #</label>
            <input
              id={`${fieldIds}-referencenumber`}
              type="text"
              value={referenceNumber}
              onChange={(e) => setReferenceNumber(e.target.value)}
              placeholder="Check #, wire ref"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor={`${fieldIds}-notes`} className={labelClass}>Notes</label>
            <input
              id={`${fieldIds}-notes`}
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes"
              className={inputClass}
            />
          </div>

          <ErrorNotification error={error} onClose={() => setError(null)} compact />

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={closeForm}
              className="px-3 py-1.5 text-xs font-medium text-on-surface-secondary hover:bg-surface-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !trustAccountId}
              className="px-4 py-1.5 text-xs font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              {saving ? "Saving..." : editing ? "Save Changes" : "Save Remittance"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="px-5 py-6 space-y-3 animate-pulse">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 bg-surface-alt rounded" />
          ))}
        </div>
      ) : remittances.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-on-surface-muted">
          No interest remittances recorded.
        </div>
      ) : (
        <div className="divide-y divide-outline-subtle">
          {/*
            The pager below windows what the client received; this says the
            client did not receive everything. Without it a capped history reads
            as the firm's complete IOLTA interest record, which is the one thing
            this list must never imply - it is reconciled against bar-foundation
            statements.
          */}
          <TruncatedListNotice
            truncated={truncated}
            unitLabel="interest remittances"
            mode="firmList"
            className="mx-5 my-3"
          />
          {remittancesPager.pagedRows.map((r) => (
            <div key={r.id} className="flex items-center justify-between px-5 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-on-surface truncate">
                    {r.trustAccountName || "Unknown Account"}
                  </p>
                  <StatusBadge variant={trustRemittanceStatusMeta(r.status).variant}>
                    {trustRemittanceStatusMeta(r.status).label}
                  </StatusBadge>
                </div>
                <p className="text-xs text-on-surface-muted mt-0.5">
                  {formatPeriod(r.periodStart, r.periodEnd)}
                  {r.remittedTo ? ` • To: ${r.remittedTo}` : ""}
                  {r.referenceNumber ? ` • Ref: ${r.referenceNumber}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-xs text-on-surface-muted">
                    Interest <span className="font-semibold text-on-surface tabular-nums">{formatCents(r.interestEarnedCents)}</span>
                  </p>
                  <p className="text-xs text-on-surface-muted mt-0.5">
                    Remitted <span className="font-semibold text-on-surface tabular-nums">{formatCents(r.amountRemittedCents)}</span>
                  </p>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1">
                    <Tooltip title="Edit remittance" enterDelay={300}>
                      <button aria-label="Edit remittance"
                        onClick={() => openEdit(r)}
                        className="p-1.5 rounded-lg text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                      >
                        <Pencil size={14} />
                      </button>
                    </Tooltip>
                    <ActionIconButton label="Remove remittance" onClick={() => setDeleting(r)} tone="danger">
                      <Trash2 size={14} />
                    </ActionIconButton>
                  </div>
                )}
              </div>
            </div>
          ))}
          {remittancesPager.total > remittancesPager.rowsPerPage && (
            <div className="px-5 py-3">
              <AutoPager pager={remittancesPager} />
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="Remove Interest Remittance"
        message={`Remove the interest remittance for ${deleting?.trustAccountName || "this account"}?`}
        confirmText="Remove"
        loading={deleteLoading}
      />
    </div>
  );
}
