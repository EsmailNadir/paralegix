'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Tooltip from "@/components/ui/Tooltip";
import { chargeCodesService } from '@/services/chargeCodes.service';
import type { ChargeCode } from '@/types';
import { AutoPager } from '@/components/ui/ListPager';
import usePagedRows from '@/hooks/usePagedRows';
import Button from '@/components/ui/Button';
import ConfirmModal from '@/components/ui/ConfirmModal';
import ErrorNotification from '@/components/ErrorNotification';
import UtbmsPickerModal from '@/components/billingComp/UtbmsPickerModal';
import { validateRequiredFields, ValidationField } from '@/utils/formValidation';
import { usePermissions } from '@/contexts/PermissionsContext';
import { Library } from 'lucide-react';
import Spinner from '@/components/ui/Spinner';
import PanelLoadingSpinner from '@/components/ui/PanelLoadingSpinner';
import { formatCurrency } from '@/lib/utils/currency';
import SectionLabel from '@/components/ui/SectionLabel';

export default function ChargeCodesPage() {
  const params = useParams();
  const id = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const lawFirmId = id;
  const { hasPermission } = usePermissions();
  // Charge codes are gated on the billing rate permissions, matching expense
  // categories.
  const canManageChargeCodes = hasPermission('billing.manageRates');
  const canViewRates = canManageChargeCodes || hasPermission('billing.viewRates');

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [newDefaultRate, setNewDefaultRate] = useState('');
  const [list, setList] = useState<ChargeCode[]>([]);

  // A firm can bulk-paste a whole UTBMS/ABA code set in one action, so the
  // rendered rows are windowed.
  const listPager = usePagedRows(list, 25);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [chargeCodeToDelete, setChargeCodeToDelete] = useState<ChargeCode | null>(null);
  // Shown inside the confirm dialog, which stays open on a refusal.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingCode, setEditingCode] = useState('');
  const [editingName, setEditingName] = useState('');
  const [editingDefaultRate, setEditingDefaultRate] = useState('');
  const [updating, setUpdating] = useState(false);

  // Inline rate editing (for non-editing rows)
  const [rateEditingId, setRateEditingId] = useState<string | null>(null);
  const [savingRate, setSavingRate] = useState(false);
  const [rateEditingValue, setRateEditingValue] = useState('');

  // UTBMS catalog picker
  const [showUtbms, setShowUtbms] = useState(false);

  // Bulk import state
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ success: number; failed: number; errors: string[] } | null>(null);

  const load = useCallback(async () => {
    if (!lawFirmId || !canViewRates) return;
    setLoading(true);
    setError(null);
    try {
      const res = await chargeCodesService.getChargeCodes(lawFirmId, false); // Only active
      setList(res.chargeCodes || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load charge codes');
    } finally {
      setLoading(false);
    }
  }, [lawFirmId, canViewRates]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: charge-codes list/loading/error state set as the request progresses
    load();
  }, [load]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lawFirmId || !canManageChargeCodes) return;
    
    // Validate required fields
    const validationFields: ValidationField[] = [
      { name: 'code', value: code, required: true, label: 'Code' },
      { name: 'name', value: name, required: true, label: 'Name' }
    ];

    const validationError = validateRequiredFields(validationFields);
    if (validationError) {
      setError(validationError);
      return;
    }

    // Validate code format
    if (!/^[A-Z0-9]{3,10}$/.test(code)) {
      setError('Code must be 3-10 characters, uppercase letters and numbers only');
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const parsedRate = newDefaultRate.trim() ? parseFloat(newDefaultRate) : null;
      await chargeCodesService.createChargeCode(lawFirmId, {
        code: code.toUpperCase(),
        name: name.trim(),
        defaultRate: parsedRate && parsedRate > 0 ? parsedRate : null,
      });
      setCode('');
      setName('');
      setNewDefaultRate('');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to create charge code');
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (!lawFirmId || !chargeCodeToDelete) return;
    const chargeCodeId = chargeCodeToDelete.id;
    setDeletingId(chargeCodeId);
    setDeleteError(null);
    try {
      await chargeCodesService.deleteChargeCode(chargeCodeId, lawFirmId);
      setChargeCodeToDelete(null);
      await load();
    } catch (e: any) {
      setDeleteError(e?.message || 'Failed to delete charge code');
    } finally {
      setDeletingId(null);
    }
  };

  const startEdit = (chargeCode: ChargeCode) => {
    if (!canManageChargeCodes) return;
    setEditingId(chargeCode.id);
    setEditingCode(chargeCode.code);
    setEditingName(chargeCode.name);
    setEditingDefaultRate(typeof chargeCode.defaultRate === 'number' ? String(chargeCode.defaultRate) : '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingCode('');
    setEditingName('');
    setEditingDefaultRate('');
  };

  const onUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lawFirmId || !editingId || !canManageChargeCodes) return;

    const validationFields: ValidationField[] = [
      { name: 'code', value: editingCode, required: true, label: 'Code' },
      { name: 'name', value: editingName, required: true, label: 'Name' }
    ];
    const validationError = validateRequiredFields(validationFields);
    if (validationError) { setError(validationError); return; }
    if (!/^[A-Z0-9]{3,10}$/.test(editingCode)) {
      setError('Code must be 3-10 characters, uppercase letters and numbers only');
      return;
    }

    setUpdating(true);
    setError(null);
    try {
      const parsedRate = editingDefaultRate.trim() ? parseFloat(editingDefaultRate) : null;
      await chargeCodesService.updateChargeCode(editingId, lawFirmId, {
        code: editingCode.toUpperCase(),
        name: editingName.trim(),
        defaultRate: parsedRate && parsedRate > 0 ? parsedRate : null,
      });
      setEditingId(null);
      setEditingCode('');
      setEditingName('');
      setEditingDefaultRate('');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to update charge code');
    } finally {
      setUpdating(false);
    }
  };

  const saveInlineRate = async (cc: ChargeCode) => {
    if (!lawFirmId || !canManageChargeCodes) return;
    const parsedRate = rateEditingValue.trim() ? parseFloat(rateEditingValue) : null;
    setSavingRate(true);
    try {
      await chargeCodesService.updateChargeCode(cc.id, lawFirmId, {
        defaultRate: parsedRate && parsedRate > 0 ? parsedRate : null,
      });
      setRateEditingId(null);
      setRateEditingValue('');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to update rate');
    } finally {
      setSavingRate(false);
    }
  };


  const onBulkImport = async () => {
    if (!lawFirmId || !canManageChargeCodes || !bulkText.trim()) return;
    setBulkImporting(true);
    setBulkResult(null);
    setError(null);

    const lines = bulkText.split('\n').map(l => l.trim()).filter(Boolean);
    let success = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const line of lines) {
      const parts = line.split(',').map(p => p.trim());
      const lineCode = parts[0] || '';
      const lineName = parts[1] || '';
      const lineRate = parts[2] ? parseFloat(parts[2]) : null;

      if (!lineCode || !lineName) {
        failed++;
        errors.push(`"${line}": missing code or name`);
        continue;
      }
      if (!/^[A-Z0-9]{3,10}$/.test(lineCode.toUpperCase())) {
        failed++;
        errors.push(`"${lineCode}": code must be 3-10 uppercase letters/numbers`);
        continue;
      }

      try {
        await chargeCodesService.createChargeCode(lawFirmId, {
          code: lineCode.toUpperCase(),
          name: lineName,
          defaultRate: lineRate && lineRate > 0 ? lineRate : null,
        });
        success++;
      } catch (e: any) {
        failed++;
        errors.push(`"${lineCode}": ${e?.message || 'failed to create'}`);
      }
    }

    setBulkResult({ success, failed, errors });
    setBulkImporting(false);
    if (success > 0) await load();
  };

  if (!lawFirmId) return null;
  if (!canViewRates) {
    return (
      <div className="p-6">
        <ErrorNotification
          error="You do not have permission to view charge codes."
          onClose={() => {}}
        />
      </div>
    );
  }

  const inputClass =
    'rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';

  return (
    <div className="p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <SectionLabel gap="1">Charge Codes</SectionLabel>
          <p className="text-sm text-on-surface-secondary">
            Organize your billing codes for better time tracking. Create and manage the charge codes used to categorize your work.
          </p>
        </div>
        {canManageChargeCodes && (
          <Button
            type="secondary"
            size="small"
            onClick={() => setShowUtbms(true)}
            className="shrink-0 inline-flex items-center gap-1.5"
          >
            <Library size={14} /> Import from UTBMS
          </Button>
        )}
      </div>

      <ErrorNotification
        error={error}
        onClose={() => setError(null)}
        className="mt-4"
      />

      {!canManageChargeCodes && (
        <div className="mt-4 rounded-lg border border-outline bg-surface-alt px-4 py-3 text-sm text-on-surface-secondary">
          You can view charge codes, but you need <code>billing.manageRates</code> permission to create, edit, or delete them.
        </div>
      )}

      <form onSubmit={onCreate} className="mt-6 flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="e.g. LIT001"
          className={`w-32 ${inputClass}`}
          maxLength={10}
          disabled={!canManageChargeCodes || creating}
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Litigation - Research"
          className={`flex-1 min-w-[200px] ${inputClass}`}
          disabled={!canManageChargeCodes || creating}
        />
        <div className="relative w-32">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted pointer-events-none">$</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={newDefaultRate}
            onChange={(e) => setNewDefaultRate(e.target.value)}
            placeholder="Rate/hr"
            className={`w-full pl-6 ${inputClass}`}
            disabled={!canManageChargeCodes || creating}
          />
        </div>
        <Button
          type="primary"
          htmlType="submit"
          disabled={!canManageChargeCodes || creating || !code.trim() || !name.trim()}
          loading={creating}
        >
          Add
        </Button>
      </form>

      {/* Bulk Import */}
      {canManageChargeCodes && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => { setShowBulkImport(!showBulkImport); setBulkResult(null); }}
            className="text-sm text-accent-emphasis hover:underline"
          >
            {showBulkImport ? 'Hide Bulk Import' : 'Bulk Import Codes'}
          </button>

          {showBulkImport && (
            <div className="mt-3 p-4 rounded-lg border border-outline bg-surface-alt space-y-3">
              <p className="text-sm text-on-surface-secondary">
                Paste one charge code per line: <code className="text-xs bg-surface px-1 py-0.5 rounded">CODE, Name, Rate</code> (rate is optional)
              </p>
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={"LIT001, Litigation - Research, 250\nLIT002, Litigation - Court Filing, 300\nFAM001, Family Law - Consultation"}
                rows={6}
                className={`w-full ${inputClass} font-mono text-xs`}
                disabled={bulkImporting}
              />
              {bulkResult && (
                <div className="text-sm space-y-1">
                  <p className="text-on-surface">
                    <span className="text-green-600 dark:text-green-400 font-medium">{bulkResult.success} created</span>
                    {bulkResult.failed > 0 && (
                      <span className="text-red-500 ml-2">{bulkResult.failed} failed</span>
                    )}
                  </p>
                  {bulkResult.errors.length > 0 && (
                    <ul className="text-xs text-red-500 space-y-0.5">
                      {bulkResult.errors.map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className="flex justify-end">
                <Button
                  type="primary"
                  disabled={bulkImporting || !bulkText.trim()}
                  loading={bulkImporting}
                  onClick={onBulkImport}
                >
                  Import All
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-6">
        {loading ? (
          <PanelLoadingSpinner label="Loading charge codes" />
        ) : list.length === 0 ? (
          <p className="text-sm text-on-surface-secondary">No charge codes yet.</p>
        ) : (
          <ul className="rounded-xl border border-outline overflow-hidden divide-y divide-outline-subtle">
            {listPager.pagedRows.map((cc) => (
              <li key={cc.id} className="px-4 py-3 bg-surface">
                {editingId === cc.id ? (
                  <form onSubmit={onUpdate} className="flex items-center gap-3 flex-wrap">
                    <input
                      type="text"
                      value={editingCode}
                      onChange={(e) => setEditingCode(e.target.value.toUpperCase())}
                      className={`w-32 ${inputClass}`}
                      maxLength={10}
                      autoFocus
                      disabled={!canManageChargeCodes || updating}
                    />
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      className={`flex-1 min-w-[200px] ${inputClass}`}
                      disabled={!canManageChargeCodes || updating}
                    />
                    <div className="relative w-32">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted pointer-events-none">$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={editingDefaultRate}
                        onChange={(e) => setEditingDefaultRate(e.target.value)}
                        placeholder="Rate/hr"
                        className={`w-full pl-6 ${inputClass}`}
                        disabled={!canManageChargeCodes || updating}
                      />
                    </div>
                    {canManageChargeCodes && (
                      <div className="flex gap-2">
                        <Button type="primary" htmlType="submit" size="small"
                          disabled={updating || !editingCode.trim() || !editingName.trim()} loading={updating}>
                          Save
                        </Button>
                        <Button type="secondary" size="small" onClick={cancelEdit} disabled={updating}>
                          Cancel
                        </Button>
                      </div>
                    )}
                  </form>
                ) : (
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex items-center gap-4">
                      <div>
                        <div className="font-medium text-on-surface">{cc.name}</div>
                        <div className="text-sm text-on-surface-secondary font-mono">{cc.code}</div>
                      </div>
                      {/* Inline rate display/edit */}
                      {canViewRates && (
                        rateEditingId === cc.id ? (
                          <div className="relative w-28">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted pointer-events-none">$</span>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={rateEditingValue}
                              onChange={(e) => setRateEditingValue(e.target.value)}
                              onBlur={() => saveInlineRate(cc)}
                              onKeyDown={(e) => { if (e.key === 'Enter') saveInlineRate(cc); if (e.key === 'Escape') { setRateEditingId(null); setRateEditingValue(''); } }}
                              autoFocus
                              disabled={savingRate}
                              placeholder="0.00"
                              className={`w-full pl-6 pr-7 text-sm rounded-md border border-accent-border-soft bg-input-bg text-on-surface px-3 py-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring disabled:opacity-60`}
                            />
                            {savingRate && (
                              <Spinner size={13} className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-muted" />
                            )}
                          </div>
                        ) : (
                          <Tooltip title={canManageChargeCodes ? 'Click to set default rate' : ''} enterDelay={300}>
                            <button
                              type="button"
                              onClick={() => { if (canManageChargeCodes) { setRateEditingId(cc.id); setRateEditingValue(typeof cc.defaultRate === 'number' ? String(cc.defaultRate) : ''); } }}
                              className={`text-sm px-2 py-1 rounded-md ${typeof cc.defaultRate === 'number' ? 'text-on-surface font-medium hover:bg-surface-hover' : 'text-on-surface-muted hover:text-on-surface hover:bg-surface-hover'} ${canManageChargeCodes ? 'cursor-pointer' : 'cursor-default'}`}
                            >
                              {typeof cc.defaultRate === 'number' ? `${formatCurrency(cc.defaultRate)}/hr` : 'Set rate'}
                            </button>
                          </Tooltip>
                        )
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {canManageChargeCodes && (
                        <>
                          <Button type="secondary" size="small" onClick={() => startEdit(cc)} disabled={deletingId === cc.id}>
                            Edit
                          </Button>
                          <Button type="secondary" size="small" onClick={() => { setDeleteError(null); setChargeCodeToDelete(cc); }}
                            disabled={deletingId === cc.id} loading={deletingId === cc.id}>
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
            {listPager.total > listPager.rowsPerPage && (
              <li className="px-4 py-3">
                <AutoPager pager={listPager} />
              </li>
            )}
          </ul>
        )}
      </div>

      <ConfirmModal
        isOpen={!!chargeCodeToDelete}
        onClose={() => setChargeCodeToDelete(null)}
        onConfirm={confirmDelete}
        title="Delete charge code"
        message={`Are you sure you want to delete the charge code "${chargeCodeToDelete?.code ?? ''}"? This cannot be undone.`}
        confirmText="Delete"
        confirmType="danger"
        loading={deletingId === chargeCodeToDelete?.id}
        error={deleteError}
      />

      <UtbmsPickerModal
        open={showUtbms}
        lawFirmId={lawFirmId}
        codeType="task"
        title="Import charge codes from UTBMS"
        onClose={() => setShowUtbms(false)}
        onAdopted={load}
      />
    </div>
  );
}
