"use client";

import { useId, useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Tags, CheckCircle, CreditCard, DollarSign, ExternalLink, AlertCircle, Scale, Mail, Clock, Percent } from "lucide-react";
import Dropdown from "@/components/ui/Dropdown";
import ConfirmModal from "@/components/ui/ConfirmModal";
import BusyToast from "@/components/ui/BusyToast";
import { apiFetch } from "@/lib/utils/fetchWithTokenRefresh";
import { getFirebaseToken } from "@/lib/utils/auth";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import useChargeCodes from "@/hooks/chargeCodeHooks/useChargeCodes";
import { MATTER_EVENT_TYPE_OPTIONS } from "@/constants/statusMeta";
import Checkbox from "@/components/ui/Checkbox";
import { INPUT_CLS } from "@/components/ui/inputClasses";
import billingService, { type BillingSettings } from "@/services/billing.service";
import ErrorNotification from "@/components/ErrorNotification";
import Spinner from "@/components/ui/Spinner";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import FieldLabel from "@/components/ui/FieldLabel";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5001/api";

interface ConnectStatus {
  connected: boolean;
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingComplete: boolean;
}

interface BillingSettingsViewProps {
  lawFirmId: string;
}

export default function BillingSettingsView({ lawFirmId }: BillingSettingsViewProps) {
  const fieldIds = useId();
  const { settings, updateFirmSettings } = useFirmSettings();
  const { hasPermission } = usePermissions();
  const { chargeCodes } = useChargeCodes(lawFirmId);
  const canManageFirmSettings = hasPermission("settings.manageFirm");
  const queryClient = useQueryClient();

  // ── Firm billing settings (client-facing payment emails) ──────────────────────
  const canManageInvoices = hasPermission("billing.manageInvoices");
  const { data: billingSettings } = useQuery<BillingSettings>({
    queryKey: ["billingSettings", lawFirmId],
    queryFn: () => billingService.getBillingSettings(lawFirmId),
    enabled: !!lawFirmId,
  });
  // Default to true until the fetch resolves so the toggle mirrors the server default.
  const clientPaymentEmails = billingSettings?.clientPaymentEmails ?? true;
  const [savingEmails, setSavingEmails] = useState(false);
  const [emailsSaved, setEmailsSaved] = useState(false);
  const [emailsError, setEmailsError] = useState<string | Error | null>(null);

  const handleClientPaymentEmailsChange = async (checked: boolean) => {
    if (!canManageInvoices) return;
    setEmailsError(null);
    setEmailsSaved(false);
    setSavingEmails(true);
    try {
      await billingService.updateBillingSettings(lawFirmId, { clientPaymentEmails: checked });
      await queryClient.invalidateQueries({ queryKey: ["billingSettings", lawFirmId] });
      setEmailsSaved(true);
    } catch (err) {
      setEmailsError(err instanceof Error ? err : "Failed to update billing settings");
    } finally {
      setSavingEmails(false);
    }
  };

  // ── Stripe ──────────────────────────────────────────────────────────────────
  const [stripeStatus, setStripeStatus] = useState<ConnectStatus | null>(null);
  const [stripeLoading, setStripeLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [stripeError, setStripeError] = useState<string | null>(null);

  // ── Load firm billing settings ──────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const token = await getFirebaseToken();
        const res = await apiFetch(`${API_URL}/lawfirms/${lawFirmId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) await res.json();
      } catch {
        // non-blocking
      }
    })();
  }, [lawFirmId]);

  // ── Load Stripe status ──────────────────────────────────────────────────────
  const fetchStripeStatus = useCallback(async () => {
    try {
      setStripeLoading(true);
      const token = await getFirebaseToken();
      const res = await apiFetch(`${API_URL}/stripe/connect/${lawFirmId}/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setStripeStatus(await res.json());
    } catch {
      // non-blocking
    } finally {
      setStripeLoading(false);
    }
  }, [lawFirmId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- triggers an async data fetch on mount
  useEffect(() => { fetchStripeStatus(); }, [fetchStripeStatus]);

  // ── Handlers ────────────────────────────────────────────────────────────────
  const eventTypeChargeCodeDefaults = settings.billing.eventTypeChargeCodeDefaults || {};
  const timeRounding = settings.billing.timeRounding ?? { enabled: false, incrementMinutes: 6 };

  // Every control on this page writes on change rather than behind a Save
  // button, so the one the user just touched is tracked by key and shows its own
  // spinner. A single shared flag would spin all of them at once.
  const [savingKeys, setSavingKeys] = useState<Set<string>>(() => new Set());
  const [settingsError, setSettingsError] = useState<string | Error | null>(null);
  const withSaving = async (key: string, run: () => Promise<void>) => {
    setSettingsError(null);
    setSavingKeys((current) => new Set(current).add(key));
    try {
      await run();
    } catch (err) {
      setSettingsError(err instanceof Error ? err : "Failed to save billing settings");
    } finally {
      setSavingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const handleTimeRoundingChange = async (next: { enabled: boolean; incrementMinutes: number }) => {
    if (!canManageFirmSettings) return;
    await withSaving("timeRounding", () =>
      updateFirmSettings({
        billing: { ...settings.billing, timeRounding: next },
      }),
    );
  };

  const lateFee = settings.billing.lateFee ?? { enabled: false, flatAmount: 0, percent: 0, graceDays: 0, autoApply: false };
  const [flatAmountInput, setFlatAmountInput] = useState("");
  const [percentInput, setPercentInput] = useState("");
  const [graceDaysInput, setGraceDaysInput] = useState("");

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mirror persisted settings into the editable inputs */
    setFlatAmountInput(lateFee.flatAmount ? String(lateFee.flatAmount) : "");
    setPercentInput(lateFee.percent ? String(lateFee.percent) : "");
    setGraceDaysInput(lateFee.graceDays ? String(lateFee.graceDays) : "");
    /* eslint-enable react-hooks/set-state-in-effect */
     
  }, [lateFee.flatAmount, lateFee.percent, lateFee.graceDays]);

  const saveLateFee = async (patch: Partial<typeof lateFee>) => {
    if (!canManageFirmSettings) return;
    await withSaving("lateFee", () =>
      updateFirmSettings({
        billing: { ...settings.billing, lateFee: { ...lateFee, ...patch } },
      }),
    );
  };

  const tax = settings.billing.tax ?? { enabled: false, defaultRate: 0, label: "Tax" };
  const [taxRateInput, setTaxRateInput] = useState("");
  const [taxLabelInput, setTaxLabelInput] = useState("");

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mirror persisted settings into the editable inputs */
    setTaxRateInput(String(tax.defaultRate ?? 0));
    setTaxLabelInput(tax.label && tax.label !== "Tax" ? tax.label : "");
    /* eslint-enable react-hooks/set-state-in-effect */
     
  }, [tax.defaultRate, tax.label]);

  const saveTax = async (patch: Partial<typeof tax>) => {
    if (!canManageFirmSettings) return;
    await withSaving("tax", () =>
      updateFirmSettings({
        billing: { ...settings.billing, tax: { ...tax, ...patch } },
      }),
    );
  };

  const handleEventTypeChargeCodeChange = async (eventType: string, chargeCodeId: string) => {
    const nextDefaults = {
      ...eventTypeChargeCodeDefaults,
      [eventType]: chargeCodeId || null,
    };
    await withSaving(`eventChargeCode:${eventType}`, () =>
      updateFirmSettings({
        billing: {
          ...settings.billing,
          eventTypeChargeCodeDefaults: nextDefaults,
        },
      }),
    );
  };


  const handleStripeConnect = async () => {
    try {
      setConnecting(true);
      setStripeError(null);
      const token = await getFirebaseToken();
      const res = await apiFetch(`${API_URL}/stripe/connect/${lawFirmId}/create-account`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create Stripe account");
      }
      const data = await res.json() as { url: string };
      window.location.href = data.url;
    } catch (err) {
      setStripeError(getErrorMessage(err, "Failed to connect Stripe"));
      setConnecting(false);
    }
  };

  const handleStripeDashboard = async () => {
    try {
      const token = await getFirebaseToken();
      const res = await apiFetch(`${API_URL}/stripe/connect/${lawFirmId}/dashboard-link`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to get dashboard link");
      const data = await res.json() as { url: string };
      window.open(data.url, "_blank");
    } catch (err) {
      setStripeError(getErrorMessage(err, "Failed to open Stripe dashboard"));
    }
  };

  const handleStripeDisconnect = async () => {
    try {
      setDisconnecting(true);
      setStripeError(null);
      const token = await getFirebaseToken();
      await apiFetch(`${API_URL}/stripe/connect/${lawFirmId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      setConfirmDisconnect(false);
      await fetchStripeStatus();
    } catch (err) {
      setStripeError(getErrorMessage(err, "Failed to disconnect Stripe"));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Firm Default Billing Rate + Time Rounding ───────────────────────── */}
      <div className="bg-surface border border-outline rounded-lg overflow-hidden">
        <div className="p-6">
          <div className="flex items-center gap-2 mb-1">
            <DollarSign className="w-4 h-4 text-on-surface-muted" />
            <h3 className="text-sm font-semibold text-on-surface">Firm Default Billing Rate</h3>
          </div>
          <p className="text-sm text-on-surface-secondary mb-4">
            Fallback hourly rate applied when no matter, client, charge code, or member default rate is set. This is the lowest-priority rate in the billing hierarchy.
          </p>
          <div className="flex items-center gap-3">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted pointer-events-none">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={settings.billing.defaultRate ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  const parsed = val === "" ? null : parseFloat(val);
                  if (parsed !== null && isNaN(parsed)) return;
                  updateFirmSettings({
                    billing: { ...settings.billing, defaultRate: parsed },
                  });
                }}
                disabled={!canManageFirmSettings}
                className={`${INPUT_CLS} w-32 pl-7 py-1.5 disabled:opacity-50`}
              />
            </div>
            <span className="text-sm text-on-surface-secondary">per hour</span>
          </div>
          {!canManageFirmSettings && (
            <p className="mt-3 text-xs text-on-surface-muted">
              Only firm admins can change this setting.
            </p>
          )}
        </div>

        <div className="p-6 border-t border-outline-subtle">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-4 h-4 text-on-surface-muted" />
            <h3 className="text-sm font-semibold text-on-surface">Time Rounding</h3>
          </div>
          <p className="text-sm text-on-surface-secondary mb-4">
            Round each time entry up to a fixed billing increment when it is saved. A common practice is to bill in 6 minute (0.1 hour) increments.
          </p>
          <Checkbox
            checked={timeRounding.enabled}
            onChange={(checked) =>
              handleTimeRoundingChange({ enabled: checked, incrementMinutes: timeRounding.incrementMinutes || 6 })
            }
            disabled={!canManageFirmSettings}
            label="Round time entries up to a fixed increment"
          />
          {timeRounding.enabled && (
            <div className="mt-4 max-w-xs">
              <Dropdown
                label="Rounding increment"
                value={String(timeRounding.incrementMinutes || 6)}
                onChange={(val) =>
                  handleTimeRoundingChange({ enabled: true, incrementMinutes: parseInt(val, 10) || 6 })
                }
                disabled={!canManageFirmSettings}
                busy={savingKeys.has("timeRounding")}
                options={[
                  { label: "6 minutes (0.1 hour)", value: "6" },
                  { label: "10 minutes", value: "10" },
                  { label: "12 minutes (0.2 hour)", value: "12" },
                  { label: "15 minutes (0.25 hour)", value: "15" },
                  { label: "30 minutes (0.5 hour)", value: "30" },
                ]}
              />
            </div>
          )}
          {!canManageFirmSettings && (
            <p className="mt-3 text-xs text-on-surface-muted">
              Only firm admins can change this setting.
            </p>
          )}
        </div>
      </div>

      {/* ── Late Fees + Tax ──────────────────────────────────────────────────── */}
      <div className="bg-surface border border-outline rounded-lg overflow-hidden">
        <div className="p-6">
          <div className="flex items-center gap-2 mb-1">
            <Percent className="w-4 h-4 text-on-surface-muted" />
            <h3 className="text-sm font-semibold text-on-surface">Late Fees</h3>
          </div>
          <p className="text-sm text-on-surface-secondary mb-4">
            Add a one time late fee to an invoice once it is overdue past the grace period. This is a flat charge and/or a percentage of the balance, not interest. The two stack.
          </p>
          <Checkbox
            checked={lateFee.enabled}
            onChange={(checked) => saveLateFee({ enabled: checked })}
            disabled={!canManageFirmSettings}
            label="Charge a late fee on overdue invoices"
            description="Off by default. While off, no late fee is added to any invoice, automatically or by hand."
          />
          {lateFee.enabled && (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <FieldLabel>Flat amount</FieldLabel>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted pointer-events-none">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={flatAmountInput}
                      onChange={(e) => setFlatAmountInput(e.target.value)}
                      onBlur={() => saveLateFee({ flatAmount: flatAmountInput.trim() === "" ? 0 : Math.max(0, parseFloat(flatAmountInput) || 0) })}
                      disabled={!canManageFirmSettings}
                      className={`${INPUT_CLS} w-full pl-7 disabled:opacity-50`}
                    />
                  </div>
                </div>
                <div>
                  <FieldLabel>Percentage of balance</FieldLabel>
                  <div className="relative">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      placeholder="0"
                      value={percentInput}
                      onChange={(e) => setPercentInput(e.target.value)}
                      onBlur={() => saveLateFee({ percent: percentInput.trim() === "" ? 0 : Math.min(100, Math.max(0, parseFloat(percentInput) || 0)) })}
                      disabled={!canManageFirmSettings}
                      className="w-full pl-3 pr-8 py-2 text-sm rounded-md border border-input-border bg-input-bg text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted pointer-events-none">%</span>
                  </div>
                </div>
                <div>
                  <FieldLabel>Grace period</FieldLabel>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      placeholder="0"
                      value={graceDaysInput}
                      onChange={(e) => setGraceDaysInput(e.target.value)}
                      onBlur={() => saveLateFee({ graceDays: graceDaysInput.trim() === "" ? 0 : Math.max(0, parseInt(graceDaysInput, 10) || 0) })}
                      disabled={!canManageFirmSettings}
                      className="w-full px-3 py-2 text-sm rounded-md border border-input-border bg-input-bg text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
                    />
                    <span className="text-sm text-on-surface-secondary whitespace-nowrap">days past due</span>
                  </div>
                </div>
              </div>
              <Checkbox
                checked={lateFee.autoApply}
                onChange={(checked) => saveLateFee({ autoApply: checked })}
                disabled={!canManageFirmSettings}
                label="Apply the late fee automatically"
                description="When on, an overdue invoice past the grace period is charged the late fee automatically. When off, you apply it to each invoice yourself. A late fee is only ever charged once per invoice."
              />
            </div>
          )}
          {!canManageFirmSettings && (
            <p className="mt-3 text-xs text-on-surface-muted">
              Only firm admins can change this setting.
            </p>
          )}
        </div>

        <div className="p-6 border-t border-outline-subtle">
          <div className="flex items-center gap-2 mb-1">
            <Percent className="w-4 h-4 text-on-surface-muted" />
            <h3 className="text-sm font-semibold text-on-surface">Tax</h3>
          </div>
          <p className="text-sm text-on-surface-secondary mb-4">
            Add a sales or gross-receipts tax to invoices. Most US states exempt legal services, so leave this off unless your state taxes them. The rate prefills new invoices and can be changed per invoice.
          </p>
          <Checkbox
            checked={tax.enabled}
            onChange={(checked) => saveTax({ enabled: checked })}
            disabled={!canManageFirmSettings}
            label="Apply tax to invoices"
          />
          {tax.enabled && (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <FieldLabel>Default tax rate</FieldLabel>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.001"
                    placeholder="0"
                    value={taxRateInput}
                    onChange={(e) => setTaxRateInput(e.target.value)}
                    onBlur={() => saveTax({ defaultRate: taxRateInput.trim() === "" ? 0 : Math.min(100, Math.max(0, parseFloat(taxRateInput) || 0)) })}
                    disabled={!canManageFirmSettings}
                    className="w-full pl-3 pr-8 py-2 text-sm rounded-md border border-input-border bg-input-bg text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted pointer-events-none">%</span>
                </div>
              </div>
              <div>
                <FieldLabel htmlFor={`${fieldIds}-taxlabelinput`}>Label on invoices</FieldLabel>
                <input
                  id={`${fieldIds}-taxlabelinput`}
                  type="text"
                  maxLength={40}
                  placeholder="Tax"
                  value={taxLabelInput}
                  onChange={(e) => setTaxLabelInput(e.target.value)}
                  onBlur={() => saveTax({ label: taxLabelInput.trim() || "Tax" })}
                  disabled={!canManageFirmSettings}
                  className="w-full px-3 py-2 text-sm rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
                />
              </div>
            </div>
          )}
          {!canManageFirmSettings && (
            <p className="mt-3 text-xs text-on-surface-muted">
              Only firm admins can change this setting.
            </p>
          )}
        </div>
      </div>

      {/* ── Default Event Charge Codes + UTBMS Codes ────────────────────────── */}
      <div className="bg-surface border border-outline rounded-lg overflow-hidden">
        <div className="p-6">
          <div className="flex items-center gap-2 mb-1">
            <Tags className="w-4 h-4 text-on-surface-muted" />
            <h3 className="text-sm font-semibold text-on-surface">Default Event Charge Codes</h3>
          </div>
          <p className="text-sm text-on-surface-secondary mb-4">
            Pick the default charge code to preselect when logging time from a matter event. The charge code is still saved on the time entry, not on the event itself.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {MATTER_EVENT_TYPE_OPTIONS.map(({ value: eventType, label }) => (
              <div key={eventType}>
                <Dropdown
                  label={label}
                  value={eventTypeChargeCodeDefaults[eventType as keyof typeof eventTypeChargeCodeDefaults] || ""}
                  onChange={(val) => handleEventTypeChargeCodeChange(eventType, val)}
                  disabled={!canManageFirmSettings}
                  busy={savingKeys.has(`eventChargeCode:${eventType}`)}
                  searchable
                  searchPlaceholder="Search charge codes…"
                  options={[
                    { label: "No default", value: "" },
                    ...chargeCodes.map((code) => ({
                      label: `${code.code} - ${code.name}`,
                      value: code.id,
                    })),
                  ]}
                />
              </div>
            ))}
          </div>
          {!canManageFirmSettings && (
            <p className="mt-3 text-xs text-on-surface-muted">
              You can view these defaults, but only firm admins can change them.
            </p>
          )}
        </div>

        <div className="p-6 border-t border-outline-subtle">
          <div className="flex items-center gap-2 mb-1">
            <Scale className="w-4 h-4 text-on-surface-muted" />
            <h3 className="text-sm font-semibold text-on-surface">UTBMS Codes</h3>
          </div>
          <p className="text-sm text-on-surface-secondary mb-4">
            Enable UTBMS (Uniform Task-Based Management System) task and activity codes on time entries for standardized billing and LEDES export compatibility.
          </p>
          <Checkbox
            checked={settings.billing.utbmsEnabled || false}
            onChange={async (checked) => {
              if (!canManageFirmSettings) return;
              await updateFirmSettings({
                billing: { ...settings.billing, utbmsEnabled: checked },
              });
            }}
            disabled={!canManageFirmSettings}
            label="Enable UTBMS task and activity codes on time entries"
          />
          {!canManageFirmSettings && (
            <p className="mt-3 text-xs text-on-surface-muted">
              Only firm admins can change this setting.
            </p>
          )}
        </div>
      </div>

      {/* ── Online Payments (Stripe) + Client Payment Emails ────────────────── */}
      <div className="bg-surface border border-outline rounded-lg overflow-hidden">
        <div className="p-6">
        <div className="flex items-center gap-2 mb-1">
          <CreditCard className="w-4 h-4 text-on-surface-muted" />
          <h3 className="text-sm font-semibold text-on-surface">Online Payments</h3>
        </div>
        <p className="text-sm text-on-surface-secondary mb-4">
          Connect your Stripe account to collect invoice payments online from clients.
        </p>

        {stripeError && (
          <div className="mb-4 flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {stripeError}
          </div>
        )}

        {stripeLoading ? (
          <div className="flex items-center gap-2 text-on-surface-muted py-2">
            <Spinner size={16} />
            <span className="text-sm">Loading...</span>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Status row */}
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                stripeStatus?.connected && stripeStatus?.chargesEnabled
                  ? "bg-emerald-100 dark:bg-emerald-500/15"
                  : "bg-surface-alt"
              }`}>
                <CreditCard className={`w-4 h-4 ${
                  stripeStatus?.connected && stripeStatus?.chargesEnabled
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-on-surface-muted"
                }`} />
              </div>
              <div>
                <p className="text-sm font-medium text-on-surface">Stripe Account</p>
                {stripeStatus?.connected ? (
                  stripeStatus.chargesEnabled ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      <CheckCircle className="w-3 h-3" />
                      Connected &amp; Active
                    </span>
                  ) : stripeStatus.onboardingComplete ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                      <AlertCircle className="w-3 h-3" />
                      Pending Verification
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                      <AlertCircle className="w-3 h-3" />
                      Onboarding Incomplete
                    </span>
                  )
                ) : (
                  <p className="text-xs text-on-surface-muted">Not connected</p>
                )}
              </div>
            </div>

            {/* Charges / Payouts badges */}
            {stripeStatus?.connected && (
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-surface-alt p-3">
                  <p className="text-[10px] uppercase tracking-wider text-on-surface-muted font-medium">Online Payments</p>
                  <p className={`text-sm font-semibold mt-1 ${stripeStatus.chargesEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                    {stripeStatus.chargesEnabled ? "Clients Can Pay Online" : "Not Ready"}
                  </p>
                </div>
                <div className="rounded-lg bg-surface-alt p-3">
                  <p className="text-[10px] uppercase tracking-wider text-on-surface-muted font-medium">Bank Account</p>
                  <p className={`text-sm font-semibold mt-1 ${stripeStatus.payoutsEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                    {stripeStatus.payoutsEnabled ? "Verified" : "Not Verified"}
                  </p>
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-3">
              {!stripeStatus?.connected ? (
                <button
                  onClick={handleStripeConnect}
                  disabled={connecting}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-accent-solid hover:bg-accent-solid-hover text-accent-foreground text-sm font-semibold rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 cursor-pointer"
                >
                  {connecting ? <Spinner size={16} /> : <CreditCard className="w-4 h-4" />}
                  {connecting ? "Setting up..." : "Connect Stripe Account"}
                </button>
              ) : !stripeStatus.onboardingComplete ? (
                <button
                  onClick={handleStripeConnect}
                  disabled={connecting}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-accent-solid hover:bg-accent-solid-hover text-accent-foreground text-sm font-semibold rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 cursor-pointer"
                >
                  {connecting ? <Spinner size={16} /> : <CreditCard className="w-4 h-4" />}
                  {connecting ? "Setting up..." : "Complete Onboarding"}
                </button>
              ) : (
                <>
                  <button
                    onClick={handleStripeDashboard}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-surface hover:bg-surface-hover text-on-surface text-sm font-medium rounded-lg border border-outline-subtle transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                  >
                    <ExternalLink className="w-4 h-4" />
                    View Stripe Dashboard
                  </button>
                  <button
                    onClick={() => setConfirmDisconnect(true)}
                    disabled={disconnecting}
                    className="inline-flex items-center gap-2 px-4 py-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 text-sm font-medium rounded-lg border border-red-200 dark:border-red-500/20 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 cursor-pointer"
                  >
                    {disconnecting ? <Spinner size={16} /> : <CreditCard className="w-4 h-4" />}
                    {disconnecting ? "Disconnecting..." : "Disconnect"}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        </div>

        <div className="p-6 border-t border-outline-subtle">
          <div className="flex items-center gap-2 mb-1">
            <Mail className="w-4 h-4 text-on-surface-muted" />
            <h3 className="text-sm font-semibold text-on-surface">Client Payment Emails</h3>
          </div>
          <p className="text-sm text-on-surface-secondary mb-4">
            Control the receipts and notices Paralegix emails your clients about their payments.
          </p>

          <ErrorNotification error={emailsError} onClose={() => setEmailsError(null)} />
          <ErrorNotification error={settingsError} onClose={() => setSettingsError(null)} />
          <BusyToast message={savingKeys.size > 0 ? "Saving billing settings…" : null} />

          <Checkbox
            checked={clientPaymentEmails}
            onChange={handleClientPaymentEmailsChange}
            disabled={!canManageInvoices || savingEmails}
            label="Email clients payment receipts and refund notices"
            description="When on, clients receive an emailed receipt each time they pay, and a notice if a payment is later refunded or reversed. Turn off to send nothing to clients (your payment processor may still send its own card receipts)."
          />

          <div className="mt-3 flex items-center gap-3">
            {savingEmails && (
              <span className="inline-flex items-center gap-1.5 text-xs text-on-surface-muted">
                <Spinner />
                Saving...
              </span>
            )}
            {emailsSaved && !savingEmails && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle className="w-3.5 h-3.5" />
                Saved
              </span>
            )}
          </div>

          {!canManageInvoices && (
            <p className="mt-3 text-xs text-on-surface-muted">
              Only firm members with invoice management access can change this setting.
            </p>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={handleStripeDisconnect}
        title="Disconnect Stripe"
        message="Are you sure you want to disconnect your Stripe account? You can reconnect later."
        confirmText="Disconnect"
        confirmType="danger"
        loading={disconnecting}
      />
    </div>
  );
}
