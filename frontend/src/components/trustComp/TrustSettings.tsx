"use client";

import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import Dropdown from "@/components/ui/Dropdown";
import Checkbox from "@/components/ui/Checkbox";
import TrustConnectSettings from "@/components/trustComp/TrustConnectSettings";
import trustService from "@/services/trust.service";
import { usePermissions } from "@/contexts/PermissionsContext";
import type { TrustSettings as TrustSettingsType, TrustReconcileCadence, TrustAccount } from "@/types/trust";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import FieldLabel from "@/components/ui/FieldLabel";

const CADENCE_OPTIONS: { value: TrustReconcileCadence; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
];

interface TrustSettingsProps {
  lawFirmId: string;
  accounts: TrustAccount[];
  /** Bumping this value re-fetches per-account Stripe connection status (e.g. on Stripe onboarding return). */
  connectRefreshSignal?: number;
}

// Firm-wide trust accounting policy (jurisdiction defaults). Values default to
// the ABA model rules (monthly reconciliation, 5-year retention) and can be
// tuned per firm to match its state bar's requirements.
export default function TrustSettings({ lawFirmId, accounts, connectRefreshSignal }: TrustSettingsProps) {
  const fieldIds = useId();
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("trust.manage");

  const { data, isLoading } = useQuery<TrustSettingsType>({
    queryKey: ["trustSettings", lawFirmId],
    queryFn: () => trustService.getTrustSettings(lawFirmId),
    enabled: !!lawFirmId,
  });

  const [cadence, setCadence] = useState<TrustReconcileCadence>("monthly");
  const [retentionYears, setRetentionYears] = useState("5");
  // Held as the dollar string the firm types. Empty means "use the built-in
  // default", which is a different thing from zero: zero would mean no client
  // ever alerts.
  const [defaultMinimum, setDefaultMinimum] = useState("");
  const [flatFeeToOperating, setFlatFeeToOperating] = useState(false);
  const [electronicDepositsAllowed, setElectronicDepositsAllowed] = useState(false);
  const [enforceMatterBalance, setEnforceMatterBalance] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(false);

  // Sync local form state once settings load (or refetch).
  useEffect(() => {
    if (!data) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs local form state from settings once they load or refetch
    setCadence(data.reconcileCadence);
    setRetentionYears(String(data.retentionYears));
    setDefaultMinimum(data.defaultMinimumCents == null ? "" : String(data.defaultMinimumCents / 100));
    setFlatFeeToOperating(data.flatFeeToOperatingAllowed);
    setElectronicDepositsAllowed(data.electronicTrustDepositsAllowed);
    setEnforceMatterBalance(data.enforceMatterTrustBalance);
  }, [data]);

  const handleSave = async () => {
    setError(null);
    setSavedAt(false);
    setSaving(true);
    try {
      await trustService.updateTrustSettings(lawFirmId, {
        reconcileCadence: cadence,
        retentionYears: Math.max(1, Math.min(20, parseInt(retentionYears || "5", 10) || 5)),
        // Cleared means "back to the built-in default", which the API takes as
        // null. A typed figure is dollars on screen and cents on the wire, like
        // every other money field.
        defaultMinimumCents: defaultMinimum.trim() === ""
          ? null
          : Math.max(0, Math.round(parseFloat(defaultMinimum) * 100) || 0),
        flatFeeToOperatingAllowed: flatFeeToOperating,
        electronicTrustDepositsAllowed: electronicDepositsAllowed,
        enforceMatterTrustBalance: enforceMatterBalance,
      });
      await queryClient.invalidateQueries({ queryKey: ["trustSettings", lawFirmId] });
      setSavedAt(true);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save settings"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
    <div className="bg-surface rounded-xl border border-outline-subtle">
      <div className="px-5 py-4 border-b border-outline-subtle">
        <h3 className="text-sm font-semibold text-on-surface">Trust Policy</h3>
        <p className="text-xs text-on-surface-muted mt-0.5">
          Firm-wide trust accounting defaults. Adjust these to match your jurisdiction's bar rules.
        </p>
      </div>

      {isLoading ? (
        <div className="px-5 py-6 space-y-3 animate-pulse">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 bg-surface-alt rounded" />
          ))}
        </div>
      ) : (
        <div className="px-5 py-4 space-y-4 max-w-md">
          <ErrorNotification error={error} compact />

          <div>
            <Dropdown
              label="Reconciliation cadence"
              value={cadence}
              onChange={(v) => setCadence(v as TrustReconcileCadence)}
              options={CADENCE_OPTIONS}
              labelClassName="text-xs font-medium text-on-surface-secondary mb-1"
              buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
            />
            <p className="text-[11px] text-on-surface-muted mt-1">
              How often trust accounts should be reconciled. Most states require at least monthly.
            </p>
          </div>

          <div>
            <FieldLabel htmlFor={`${fieldIds}-retentionyears`} size="xs" tone="secondary">
              Record retention (years)
            </FieldLabel>
            <input
              id={`${fieldIds}-retentionyears`}
              type="number"
              min={1}
              max={20}
              value={retentionYears}
              onChange={(e) => setRetentionYears(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
            <p className="text-[11px] text-on-surface-muted mt-1">
              How long trust account records must be kept. The ABA model is 5 years; some states require more.
              {data?.retentionCutoffDate && (
                <> Records before {formatDateOnly(data.retentionCutoffDate)} fall outside this period.</>
              )}
            </p>
          </div>

          <div>
            <FieldLabel htmlFor={`${fieldIds}-defaultminimum`} size="xs" tone="secondary">
              Default low-balance alert ($)
            </FieldLabel>
            <input
              id={`${fieldIds}-defaultminimum`}
              type="number"
              min={0}
              step="0.01"
              placeholder="100.00"
              value={defaultMinimum}
              onChange={(e) => setDefaultMinimum(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
            <p className="text-[11px] text-on-surface-muted mt-1">
              A client whose trust balance falls below this is flagged, and the client is asked to
              replenish. Leave blank for the built-in $100. A minimum set for one client on the
              evergreen-retainer list overrides this for that client.
            </p>
          </div>

          <Checkbox
            checked={flatFeeToOperating}
            onChange={setFlatFeeToOperating}
            label="Allow flat fees deposited directly to operating"
            description="Some states permit a flat fee to bypass trust with written client disclosure. Leave off if unsure."
          />

          <Checkbox
            checked={enforceMatterBalance}
            onChange={setEnforceMatterBalance}
            label="Hold trust balances per matter"
            description="Refuse a withdrawal that would overdraw the matter it names, not just the client. Turn this on only if your firm takes retainers per matter, or every withdrawal against a client-level deposit will be refused."
          />

          <Checkbox
            checked={electronicDepositsAllowed}
            onChange={setElectronicDepositsAllowed}
            label="Allow electronic trust deposits (ACH)"
            description="Allow clients to fund trust accounts electronically by bank transfer (ACH). Only enable this if your jurisdiction permits electronically funding a client trust account. You are responsible for confirming this."
          />

          {canManage && (
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
              >
                <Save size={14} />
                {saving ? "Saving..." : "Save Settings"}
              </button>
              {savedAt && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved</span>}
            </div>
          )}
        </div>
      )}
    </div>

      {electronicDepositsAllowed && (
        <TrustConnectSettings
          lawFirmId={lawFirmId}
          accounts={accounts}
          refreshSignal={connectRefreshSignal}
        />
      )}
    </div>
  );
}
