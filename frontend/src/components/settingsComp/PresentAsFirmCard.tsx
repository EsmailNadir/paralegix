"use client";

import { useEffect, useState } from "react";
import messagesService from "@/services/messages.service";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import ToggleSwitch from "@/components/ui/ToggleSwitch";

// Personal "send as firm" preference for a firm member: when on, the clients they
// message see the law firm's name/logo as the sender instead of the member's own
// name. Applies to every conversation the member sends in. Firm colleagues always
// see the real sender.
export default function PresentAsFirmCard({ lawFirmId }: { lawFirmId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { presentAsFirm } = await messagesService.getPresentAsFirm(lawFirmId);
        if (active) setEnabled(!!presentAsFirm);
      } catch {
        // A load failure just leaves the toggle in its default (off) state.
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [lawFirmId]);

  const toggle = async () => {
    if (saving || loading) return;
    const next = !enabled;
    setEnabled(next);
    try {
      setSaving(true);
      setError(null);
      await messagesService.setPresentAsFirm(lawFirmId, next);
    } catch (err) {
      setEnabled(!next);
      setError(getErrorMessage(err, "Failed to update preference."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-surface rounded-lg border border-outline mt-4 md:mt-6">
      <div className="px-4 py-4 md:px-6 border-b border-outline">
        <h2 className="text-lg font-semibold text-on-surface">Messaging identity</h2>
        <p className="text-sm text-on-surface-secondary mt-1">
          Choose how you appear to clients in messages.
        </p>
      </div>

      <div className="px-4 py-4 md:px-6">
        <ErrorNotification error={error} onClose={() => setError(null)} className="mb-4" />

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-on-surface">Message clients as the firm</p>
            <p className="text-xs text-on-surface-muted mt-0.5">
              When on, clients see your firm&apos;s name and logo as the sender instead of
              your own name. Your colleagues always see that it was you.
            </p>
          </div>
          <ToggleSwitch
            checked={enabled}
            onChange={toggle}
            disabled={saving || loading}
            ariaLabel="Message clients as the firm"
          />
        </div>
      </div>
    </div>
  );
}
