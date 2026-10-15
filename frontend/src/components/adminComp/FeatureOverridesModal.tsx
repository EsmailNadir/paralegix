'use client';

import { useState } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Dropdown from '@/components/ui/Dropdown';
import ErrorNotification from '@/components/ErrorNotification';
import adminService, { AdminLawFirm, AdminPlanData } from '@/services/admin.service';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import useSeedOnOpen from '@/hooks/useSeedOnOpen';

const FEATURES: { key: string; label: string }[] = [
  { key: 'clientPortal', label: 'Client Portal' },
  { key: 'messaging', label: 'Messaging' },
  { key: 'calendarSync', label: 'Calendar Sync' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'flatFees', label: 'Flat Fees' },
  { key: 'fileSharing', label: 'File Sharing' },
  { key: 'templates', label: 'Templates' },
  { key: 'trustAccounting', label: 'Trust Accounting' },
  { key: 'documentSigning', label: 'Document Signing' },
];

// 'inherit' = use the plan default; 'on'/'off' = force regardless of plan.
type TriState = 'inherit' | 'on' | 'off';

/**
 * Per-firm feature overrides. Each feature can inherit the plan default or be
 * forced on/off for this firm. The forced values live in the plan's
 * `featureOverrides` jsonb (replaced wholesale by the backend), so only the
 * features set to on/off are sent; 'inherit' features are omitted (= plan default).
 */
export default function FeatureOverridesModal({
  open,
  onClose,
  lawFirmId,
  plan,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  plan: AdminPlanData | undefined;
  onSaved: (lawFirm: AdminLawFirm) => void;
}) {
  const [states, setStates] = useState<Record<string, TriState>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useSeedOnOpen(open, () => {
    const overrides = plan?.featureOverrides || {};
    const next: Record<string, TriState> = {};
    FEATURES.forEach(({ key }) => {
      if (typeof overrides[key] === 'boolean') next[key] = overrides[key] ? 'on' : 'off';
      else next[key] = 'inherit';
    });
    setStates(next);
    setError(null);
  });

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const featureOverrides: Record<string, boolean> = {};
      FEATURES.forEach(({ key }) => {
        const s = states[key];
        if (s === 'on') featureOverrides[key] = true;
        else if (s === 'off') featureOverrides[key] = false;
      });
      const result = await adminService.updateLawFirmPlan(lawFirmId, { featureOverrides });
      onSaved(result.lawFirm);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save feature overrides'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={() => { if (!saving) onClose(); }}
      dismissible={!saving}
      showClose={false}
      title="Feature Overrides"
      className="relative"
      bodyClassName="px-6 py-5 space-y-3 overflow-y-auto overflow-x-hidden styled-scrollbar"
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="primary" onClick={handleSave} loading={saving}>Save Features</Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} />
      <p className="text-xs text-on-surface-muted">
        Force a feature on or off for this firm regardless of its plan, or inherit the plan default.
      </p>
      {FEATURES.map(({ key, label }) => (
        <div key={key} className="flex items-center justify-between gap-3">
          <span className="text-sm text-on-surface">{label}</span>
          <div className="w-36 shrink-0">
            <Dropdown
              portal
              value={states[key] || 'inherit'}
              onChange={(v) => setStates((prev) => ({ ...prev, [key]: v as TriState }))}
              options={[
                { value: 'inherit', label: 'Plan default' },
                { value: 'on', label: 'Enabled' },
                { value: 'off', label: 'Disabled' },
              ]}
            />
          </div>
        </div>
      ))}
    </Modal>
  );
}
