"use client";

import { useState } from "react";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import SuccessNotification from "@/components/SuccessNotification";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import { useLawFirm } from "@/contexts/LawFirmContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { getPlanFeatures } from "@/lib/plans/featureAccess";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import settingsService from "@/services/settings.service";
import { FIRM_TOGGLEABLE_FEATURES } from "@/types/preferences";
import type { FirmFeatureKey } from "@/types/preferences";

/**
 * Lets a firm switch off a feature its plan includes but it does not practise.
 *
 * Two different answers drive this panel and they must not be conflated. The
 * PLAN decides whether a row appears at all: a feature the plan does not sell is
 * not the firm's to switch, so it is left out entirely rather than shown
 * disabled with an upgrade prompt (the pricing table above already sells it).
 * The RESOLVED feature decides the switch position, because that is what the
 * rest of the app renders against.
 *
 * Turning one off hides an entire area of the product for everyone in the firm,
 * so it confirms first. The backend can still refuse: trust accounting cannot be
 * switched off while client funds are on deposit, and that refusal arrives as a
 * plain validation message which is shown as-is.
 */
export default function FirmFeatureToggles() {
  const { lawFirm } = useLawFirm();
  const { features, refresh } = useFirmSettings();
  const { hasPermission } = usePermissions();

  const [pending, setPending] = useState<FirmFeatureKey | null>(null);
  const [confirming, setConfirming] = useState<FirmFeatureKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const canManage = hasPermission("settings.manageFirm");
  const planFeatures = getPlanFeatures(lawFirm?.plan);

  const rows = (Object.keys(FIRM_TOGGLEABLE_FEATURES) as FirmFeatureKey[])
    .filter((key) => planFeatures[key]);

  // Nothing to offer a firm whose plan sells none of the toggleable features.
  if (!lawFirm || rows.length === 0) return null;

  const apply = async (feature: FirmFeatureKey, enabled: boolean) => {
    setPending(feature);
    setError(null);
    setSuccess(null);
    try {
      await settingsService.setFirmFeature(lawFirm.id, feature, enabled);
      // The context seeds from the firm record, so re-read the canonical copy
      // rather than guessing the new resolved value locally.
      await refresh();
      setSuccess(
        `${FIRM_TOGGLEABLE_FEATURES[feature].label} ${enabled ? "turned on" : "turned off"}.`,
      );
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update this feature"));
    } finally {
      setPending(null);
      setConfirming(null);
    }
  };

  const handleToggle = (feature: FirmFeatureKey) => {
    // Switching ON is additive and needs no confirmation. Switching OFF removes
    // a whole area of the product from every member, so it asks first.
    if (features[feature]) setConfirming(feature);
    else apply(feature, true);
  };

  return (
    <div>
      <h3 className="text-base font-semibold text-on-surface mb-4">
        Features
      </h3>

      {error && <ErrorNotification error={error} onClose={() => setError(null)} />}
      {success && (
        <SuccessNotification message={success} onClose={() => setSuccess(null)} />
      )}

      <div className="space-y-4">
        {rows.map((key) => {
          const { label, description } = FIRM_TOGGLEABLE_FEATURES[key];
          return (
            <div key={key} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-on-surface">{label}</p>
                <p className="text-xs text-on-surface-muted">{description}</p>
              </div>
              <ToggleSwitch
                checked={features[key]}
                onChange={() => handleToggle(key)}
                disabled={!canManage || pending !== null}
                ariaLabel={label}
              />
            </div>
          );
        })}
      </div>

      <ConfirmModal
        isOpen={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && apply(confirming, false)}
        title={`Turn off ${confirming ? FIRM_TOGGLEABLE_FEATURES[confirming].label.toLowerCase() : ""}?`}
        message={
          "This hides the feature for everyone in your firm and blocks its pages and actions. "
          + "Nothing is deleted, and turning it back on restores everything exactly as it was."
        }
        confirmText="Turn it off"
        confirmType="danger"
        loading={pending !== null}
      />
    </div>
  );
}
