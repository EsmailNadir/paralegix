'use client';

import { useId, useState } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Checkbox from '@/components/ui/Checkbox';
import ErrorNotification from '@/components/ErrorNotification';
import adminService, { AdminLawFirm, AdminStorageSettings } from '@/services/admin.service';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import useSeedOnOpen from '@/hooks/useSeedOnOpen';
import FieldLabel from '@/components/ui/FieldLabel';
import TextInput from '@/components/ui/TextInput';

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${units[i]}`;
}

/**
 * Storage operations for a firm: the hard-limit toggle (block vs. only warn at the
 * quota), the warn-at threshold, a live read of usage, and a recount that
 * recomputes used bytes from the GCS bucket to fix any drift. The quota number
 * itself is edited in the Limit Overrides modal; this is the operational controls.
 */
export default function StorageOpsModal({
  open,
  onClose,
  lawFirmId,
  storage,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  storage: AdminStorageSettings | undefined;
  onSaved: (lawFirm: AdminLawFirm) => void;
}) {
  const fieldIds = useId();
  const [hardLimit, setHardLimit] = useState(true);
  const [warnAtPercent, setWarnAtPercent] = useState('85');
  const [usedBytes, setUsedBytes] = useState(0);
  const [quotaBytes, setQuotaBytes] = useState(0);
  const [saving, setSaving] = useState(false);
  const [recounting, setRecounting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Escape and the backdrop are guarded on the in-flight flags, so a save or
  // recount can't be abandoned half-way.
  const requestClose = () => { if (!saving && !recounting) onClose(); };

  useSeedOnOpen(open, () => {
    setHardLimit(storage?.hardLimit ?? true);
    setWarnAtPercent(String(storage?.warnAtPercent ?? 85));
    setUsedBytes(storage?.usedBytes ?? 0);
    setQuotaBytes(storage?.quotaBytes ?? 0);
    setError(null);
    setNotice(null);
  });

  const percentUsed = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const pct = Math.min(100, Math.max(1, Math.trunc(Number(warnAtPercent) || 85)));
      const result = await adminService.updateLawFirm(lawFirmId, {
        storage: { hardLimit, warnAtPercent: pct },
      });
      onSaved(result.lawFirm);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save storage settings'));
    } finally {
      setSaving(false);
    }
  };

  const handleRecount = async () => {
    setRecounting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await adminService.recountStorage(lawFirmId);
      setUsedBytes(result.usedBytes);
      setNotice(`Recounted: ${formatBytes(result.usedBytes)} across ${result.fileCount} file(s).`);
      onSaved(result.lawFirm);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to recount storage'));
    } finally {
      setRecounting(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={requestClose}
      title="Storage Settings"
      showClose={false}
      dismissible={!saving && !recounting}
      size="md"
      bodyClassName="px-6 py-5 space-y-5 overflow-y-auto overflow-x-hidden styled-scrollbar"
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={saving || recounting}>Cancel</Button>
          <Button type="primary" onClick={handleSave} loading={saving} disabled={recounting}>Save Settings</Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} />
      {notice && <p className="text-sm text-green-600 dark:text-green-400">{notice}</p>}

      <div className="rounded-md border border-outline-subtle bg-surface-alt px-4 py-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-on-surface-muted">Usage</span>
          <span className="text-on-surface font-medium">
            {formatBytes(usedBytes)} / {formatBytes(quotaBytes)} ({percentUsed}%)
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full rounded-full bg-surface-hover overflow-hidden">
          <div
            className={`h-full rounded-full ${percentUsed >= 100 ? 'bg-red-500' : percentUsed >= 85 ? 'bg-amber-500' : 'bg-accent-selection'}`}
            style={{ width: `${percentUsed}%` }}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-on-surface cursor-pointer">
        <Checkbox checked={hardLimit} onChange={setHardLimit} />
        Hard limit (block uploads at quota; off = warn only, never block)
      </label>

      <div>
        <FieldLabel htmlFor={`${fieldIds}-warnatpercent`}>Warn At (%)</FieldLabel>
        <TextInput
          id={`${fieldIds}-warnatpercent`}
          type="number"
          min={1}
          max={100}
          value={warnAtPercent}
          onChange={(e) => setWarnAtPercent(e.target.value)}
        />
        <p className="mt-1 text-xs text-on-surface-muted">Usage percentage that triggers the storage warning.</p>
      </div>

      <div className="rounded-md border border-outline-subtle px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-on-surface">Recount from bucket</p>
            <p className="text-xs text-on-surface-muted">Recompute used bytes from actual storage to fix drift.</p>
          </div>
          <Button type="secondary" size="small" onClick={handleRecount} loading={recounting} disabled={saving}>
            Recount
          </Button>
        </div>
      </div>
    </Modal>
  );
}
