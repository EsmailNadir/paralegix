"use client";

import { useId, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import ActionIconButton from "@/components/ui/ActionIconButton";
import Dropdown from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import { AutoPager } from "@/components/ui/ListPager";
import usePagedRows from "@/hooks/usePagedRows";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import useMinimumBalances from "@/hooks/trustHooks/useMinimumBalances";
import trustService from "@/services/trust.service";
import { usePermissions } from "@/contexts/PermissionsContext";
import { formatCents } from "@/lib/utils/currency";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { TrustAccount, TrustMinimumBalance, ClientTrustBalance } from "@/types/trust";
import FieldLabel from "@/components/ui/FieldLabel";

interface MinimumBalancesProps {
  lawFirmId: string;
  accounts: TrustAccount[];
  /** Live per-(client, account) balances, used to flag thresholds currently breached. */
  balances: ClientTrustBalance[];
}

export default function MinimumBalances({ lawFirmId, accounts, balances }: MinimumBalancesProps) {
  const fieldIds = useId();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("trust.manage");
  const queryClient = useQueryClient();
  const { minimums, loading } = useMinimumBalances(lawFirmId);

  // One row per (client, trust account) minimum, so a firm that sets retainer
  // minimums as policy has one per active client. Windowed.
  const minimumsPager = usePagedRows(minimums, 25);

  const [showForm, setShowForm] = useState(false);
  const [clientId, setClientId] = useState("");
  const [trustAccountId, setTrustAccountId] = useState(accounts[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TrustMinimumBalance | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Per-(client, account) live balance lookup for the breach indicator.
  const balanceKey = (cId: string, aId: string) => `${cId}::${aId}`;
  const balanceMap = useMemo(() => {
    const map = new Map<string, number>();
    balances.forEach((b) => map.set(balanceKey(b.clientId, b.trustAccountId), b.balanceCents));
    return map;
  }, [balances]);

  const resetForm = () => {
    setClientId("");
    setTrustAccountId(accounts[0]?.id || "");
    setAmount("");
    setError(null);
  };

  const handleSave = async () => {
    setError(null);
    const minimumCents = Math.round(parseFloat(amount) * 100);
    if (!clientId) { setError("Please select a client"); return; }
    if (!trustAccountId) { setError("Please select an account"); return; }
    if (isNaN(minimumCents) || minimumCents < 0) { setError("Minimum must be a non-negative number"); return; }

    setSaving(true);
    try {
      await trustService.upsertMinimumBalance(lawFirmId, { clientId, trustAccountId, minimumCents });
      queryClient.invalidateQueries({ queryKey: ["trustMinimumBalances", lawFirmId] });
      setShowForm(false);
      resetForm();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save minimum balance"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setDeleteLoading(true);
    try {
      await trustService.deleteMinimumBalance(lawFirmId, deleting.id);
      queryClient.invalidateQueries({ queryKey: ["trustMinimumBalances", lawFirmId] });
      setDeleting(null);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to remove minimum balance"));
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="bg-surface rounded-xl border border-outline-subtle">
      <div className="flex items-center justify-between px-5 py-4 border-b border-outline-subtle">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">Retainer Minimums</h3>
          <p className="text-xs text-on-surface-muted mt-0.5">
            Alert thresholds for evergreen client retainers.
          </p>
        </div>
        {canManage && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            <Plus size={14} />
            Add Minimum
          </button>
        )}
      </div>

      {showForm && canManage && (
        <div className="px-5 py-4 border-b border-outline-subtle bg-surface-alt/50 space-y-3">
          <div>
            {/* Archived clients are no longer transacted with, so they must not be
                offered for a new retainer minimum. */}
            <EntityPicker
              entity="clients"
              lawFirmId={lawFirmId}
              value={clientId}
              onChange={setClientId}
              excludeArchived
              label="Client *"
              placeholder="Select client"
              labelClassName="block text-xs font-medium text-on-surface-secondary mb-1"
              buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Dropdown
                label="Account *"
                value={trustAccountId}
                onChange={setTrustAccountId}
                options={accounts.map((a) => ({ value: a.id, label: a.name }))}
                placeholder="Select account"
                labelClassName="block text-xs font-medium text-on-surface-secondary mb-1"
                buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
              />
            </div>
            <div>
              <FieldLabel htmlFor={`${fieldIds}-amount`} size="xs" tone="secondary">Minimum ($) *</FieldLabel>
              <input
                id={`${fieldIds}-amount`}
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
          </div>

          <ErrorNotification error={error} onClose={() => setError(null)} compact />

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => { setShowForm(false); resetForm(); }}
              className="px-3 py-1.5 text-xs font-medium text-on-surface-secondary hover:bg-surface-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !clientId || !trustAccountId || !amount}
              className="px-4 py-1.5 text-xs font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              {saving ? "Saving..." : "Save Minimum"}
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
      ) : minimums.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-on-surface-muted">
          No retainer minimums configured.
        </div>
      ) : (
        <div className="divide-y divide-outline-subtle">
          {minimumsPager.pagedRows.map((min) => {
            const current = balanceMap.get(balanceKey(min.clientId, min.trustAccountId));
            const belowMinimum = current != null && current < min.minimumCents;
            const shortfall = belowMinimum ? min.minimumCents - (current ?? 0) : 0;
            return (
              <div key={min.id} className="flex items-center justify-between px-5 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-on-surface truncate">
                      {min.clientName || "Unknown Client"}
                    </p>
                    {belowMinimum && (
                      <Tooltip title={`Short by ${formatCents(shortfall)}`} enterDelay={300}>
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
                          <AlertTriangle size={10} />
                          Below minimum
                        </span>
                      </Tooltip>
                    )}
                  </div>
                  <p className="text-xs text-on-surface-muted mt-0.5">
                    {min.trustAccountName || "Unknown Account"}
                    {current != null ? ` • Current: ${formatCents(current)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <p className="text-sm font-semibold text-on-surface tabular-nums">
                    {formatCents(min.minimumCents)}
                  </p>
                  {canManage && (
                    <ActionIconButton label="Remove minimum" onClick={() => setDeleting(min)} tone="danger">
                      <Trash2 size={14} />
                    </ActionIconButton>
                  )}
                </div>
              </div>
            );
          })}
          {minimumsPager.total > minimumsPager.rowsPerPage && (
            <div className="px-5 py-3">
              <AutoPager pager={minimumsPager} />
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="Remove Minimum Balance"
        message={`Remove the retainer minimum for ${deleting?.clientName || "this client"}?`}
        confirmText="Remove"
        loading={deleteLoading}
      />
    </div>
  );
}
