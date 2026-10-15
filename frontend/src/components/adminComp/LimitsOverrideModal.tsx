'use client';

import { useEffect, useId, useState } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorNotification from '@/components/ErrorNotification';
import adminService, { AdminLawFirm, AdminPlanData } from '@/services/admin.service';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import useSeedOnOpen from '@/hooks/useSeedOnOpen';
import FieldLabel from '@/components/ui/FieldLabel';
import TextInput from '@/components/ui/TextInput';

/**
 * Per-firm limit overrides (max matters / members / storage quota / per-file size).
 * Each field overrides the firm's plan default; leaving one blank clears that
 * override so the plan default applies again. All four live in the plan's
 * `limitOverrides` jsonb, which the backend replaces wholesale, so they are edited
 * together here and any field left blank is simply omitted (= inherit).
 */
export default function LimitsOverrideModal({
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
  const [maxMatters, setMaxMatters] = useState('');
  const [maxMembers, setMaxMembers] = useState('');
  const [storageQuotaMb, setStorageQuotaMb] = useState('');
  const [maxFileSizeMb, setMaxFileSizeMb] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Escape and the backdrop are guarded on `saving`, so a save in flight
  // can't be abandoned half-way.
  const requestClose = () => { if (!saving) onClose(); };

  // The firm's currently effective limits (plan default merged with any existing
  // override). Shown in each field's placeholder so an admin can see what the
  // firm gets today when the field is left blank to inherit.
  const [effectiveLimits, setEffectiveLimits] = useState<Record<string, number> | null>(null);

  useSeedOnOpen(open, () => {
    const o = plan?.limitOverrides || {};
    setMaxMatters(o.maxMatters != null ? String(o.maxMatters) : '');
    setMaxMembers(o.maxMembers != null ? String(o.maxMembers) : '');
    setStorageQuotaMb(o.storageQuotaBytes != null ? String(adminService.bytesToMb(o.storageQuotaBytes)) : '');
    setMaxFileSizeMb(o.maxFileSizeBytes != null ? String(adminService.bytesToMb(o.maxFileSizeBytes)) : '');
    setError(null);
  });

  // Fetch the firm's effective limits whenever the modal opens so the
  // placeholders reflect the live plan defaults rather than a hardcoded copy.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    adminService
      .getLawFirmPlan(lawFirmId)
      .then((res) => {
        if (!cancelled) setEffectiveLimits(res.limits);
      })
      .catch(() => {
        if (!cancelled) setEffectiveLimits(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, lawFirmId]);

  const UNLIMITED = -1;
  const countPlaceholder = (key: 'maxMatters' | 'maxMembers') => {
    const v = effectiveLimits?.[key];
    if (v == null) return 'Plan default';
    return v === UNLIMITED ? 'Plan default (unlimited)' : `Plan default (${v})`;
  };
  const mbPlaceholder = (key: 'storageQuotaBytes' | 'maxFileSizeBytes') => {
    const v = effectiveLimits?.[key];
    if (v == null) return 'Plan default';
    return `Plan default (${adminService.bytesToMb(v)} MB)`;
  };

  const intOrUndefined = (v: string): number | undefined => {
    const t = v.trim();
    if (t === '') return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  };

  const handleSave = async () => {
    const mm = intOrUndefined(maxMatters);
    const mb = intOrUndefined(maxMembers);
    const sq = intOrUndefined(storageQuotaMb);
    const fs = intOrUndefined(maxFileSizeMb);
    // Sizes have no unlimited sentinel. `mbToBytes` turns anything below 1 MB
    // into 0 bytes, which the server refuses without naming the field.
    if (sq !== undefined && sq < 1) {
      setError('Storage Quota must be at least 1 MB.');
      return;
    }
    if (fs !== undefined && fs < 1) {
      setError('Max File Size must be at least 1 MB.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const limitOverrides: Record<string, number> = {};
      if (mm !== undefined) limitOverrides.maxMatters = mm;
      if (mb !== undefined) limitOverrides.maxMembers = mb;
      if (sq !== undefined) limitOverrides.storageQuotaBytes = adminService.mbToBytes(sq);
      if (fs !== undefined) limitOverrides.maxFileSizeBytes = adminService.mbToBytes(fs);

      const result = await adminService.updateLawFirmPlan(lawFirmId, { limitOverrides });
      onSaved(result.lawFirm);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save overrides'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={requestClose}
      title="Limit Overrides"
      showClose={false}
      dismissible={!saving}
      size="md"
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="primary" onClick={handleSave} loading={saving}>Save Overrides</Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} />
      <p className="text-xs text-on-surface-muted">
        Leave a field blank to use the plan default. Use -1 for unlimited matters or members.
      </p>

      <NumberField label="Max Matters" value={maxMatters} onChange={setMaxMatters} placeholder={countPlaceholder('maxMatters')} />
      <NumberField label="Max Members" value={maxMembers} onChange={setMaxMembers} placeholder={countPlaceholder('maxMembers')} />
      <NumberField
        label="Storage Quota (MB)"
        value={storageQuotaMb}
        onChange={setStorageQuotaMb}
        placeholder={mbPlaceholder('storageQuotaBytes')}
        hint="1024 MB = 1 GB"
      />
      <NumberField
        label="Max File Size (MB)"
        value={maxFileSizeMb}
        onChange={setMaxFileSizeMb}
        placeholder={mbPlaceholder('maxFileSizeBytes')}
        hint="Per-file upload ceiling. 1024 MB = 1 GB"
      />
    </Modal>
  );
}

function NumberField({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  const fieldIds = useId();
  return (
    <div>
      <FieldLabel htmlFor={`${fieldIds}-value`}>{label}</FieldLabel>
      <TextInput
        id={`${fieldIds}-value`}
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {hint && <p className="mt-1 text-xs text-on-surface-muted">{hint}</p>}
    </div>
  );
}
