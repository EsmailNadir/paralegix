"use client";

import { useState } from "react";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import ErrorNotification from "@/components/ErrorNotification";
import CardFeeSettings from "@/components/billingComp/CardFeeSettings";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import { BANK_FEE_SETTINGS, ONLINE_PAYMENT_FEES_INTRO } from "@/lib/payments/cardFeeCopy";

/**
 * Payments settings' "Online Payment Fees": whether clients pay the credit card
 * fee (its own form, saved through its own route) and, on a separate switch,
 * the bank transfer fee, which saves on change into the firm's billing
 * settings. Firm admins change them; everyone else sees them read-only.
 */
export default function OnlinePaymentFeesSettings({ lawFirmId, canEdit }: { lawFirmId: string; canEdit: boolean }) {
  const { settings, updateFirmSettings } = useFirmSettings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | Error | null>(null);
  const processingFees = settings.billing.processingFees ?? { card: "firm", bank: "firm" };

  const saveProcessingFees = async (patch: Partial<typeof processingFees>) => {
    if (!canEdit) return;
    setError(null);
    setSaving(true);
    try {
      await updateFirmSettings({
        billing: { ...settings.billing, processingFees: { ...processingFees, ...patch } },
      });
    } catch (err) {
      setError(err instanceof Error ? err : "Failed to save billing settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-outline-subtle p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-on-surface">Online Payment Fees</h3>
        <p className="text-sm text-on-surface-secondary mt-1">{ONLINE_PAYMENT_FEES_INTRO}</p>
      </div>

      <CardFeeSettings lawFirmId={lawFirmId} canEdit={canEdit} />

      <div className="pt-4 border-t border-outline-subtle flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-on-surface">{BANK_FEE_SETTINGS.toggleLabel}</p>
          <p className="text-xs text-on-surface-muted">{BANK_FEE_SETTINGS.description}</p>
        </div>
        <ToggleSwitch
          checked={processingFees.bank === "client"}
          onChange={() => saveProcessingFees({ bank: processingFees.bank === "client" ? "firm" : "client" })}
          disabled={!canEdit || saving}
          ariaLabel={BANK_FEE_SETTINGS.toggleLabel}
        />
      </div>

      <ErrorNotification error={error} onClose={() => setError(null)} compact />

      {!canEdit && (
        <p className="text-xs text-on-surface-muted">Only firm admins can change this setting.</p>
      )}
    </div>
  );
}
