// app/lawfirm/[id]/settings/practice-area/page.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import practiceAreaService from '@/services/practiceArea.service';
import type { PracticeArea } from '@/types';
import { AutoPager } from '@/components/ui/ListPager';
import usePagedRows from '@/hooks/usePagedRows';
import Button from '@/components/ui/Button';
import ConfirmModal from '@/components/ui/ConfirmModal';
import ErrorNotification from '@/components/ErrorNotification';
import { usePermissions } from '@/contexts/PermissionsContext';
import { validateRequiredFields, ValidationField } from '@/utils/formValidation';
import PanelLoadingSpinner from '@/components/ui/PanelLoadingSpinner';
import SectionLabel from '@/components/ui/SectionLabel';

// * add something later to make sure they cant delete a practice area if its linked to a matter
export default function PracticeAreasPage() {
  const params = useParams();
  const id = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const lawFirmId = id;
  const { hasPermission } = usePermissions();
  const canManagePracticeAreas = hasPermission('practiceAreas.manage');

  const [name, setName] = useState('');
  const [list, setList] = useState<PracticeArea[]>([]);

  // Windowed so the page height stays bounded as the firm adds areas.
  const listPager = usePagedRows(list, 25);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [areaToDelete, setAreaToDelete] = useState<PracticeArea | null>(null);
  // Shown inside the confirm dialog, which stays open on a refusal.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    if (!lawFirmId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await practiceAreaService.listPracticeAreas(lawFirmId);
      setList(res.practiceAreas || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load practice areas');
    } finally {
      setLoading(false);
    }
  }, [lawFirmId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: practice-areas list/loading/error state set as the request progresses
    load();
  }, [load]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lawFirmId || !canManagePracticeAreas) return;
    
    // Validate required fields
    const validationFields: ValidationField[] = [
      { name: 'name', value: name, required: true, label: 'Name' }
    ];

    const validationError = validateRequiredFields(validationFields);
    if (validationError) {
      setError(validationError);
      return;
    }

    setCreating(true);
    setError(null);
    try {
      await practiceAreaService.createPracticeArea(lawFirmId, name.trim());
      setName('');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to create practice area');
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (!lawFirmId || !canManagePracticeAreas || !areaToDelete) return;
    const practiceAreaId = areaToDelete.id;
    setDeletingId(practiceAreaId);
    setDeleteError(null);
    try {
      await practiceAreaService.deletePracticeArea(lawFirmId, practiceAreaId);
      setAreaToDelete(null);
      await load();
    } catch (e: any) {
      setDeleteError(e?.message || 'Failed to delete practice area');
    } finally {
      setDeletingId(null);
    }
  };

  const startEdit = (practiceArea: PracticeArea) => {
    if (!canManagePracticeAreas) return;
    setEditingId(practiceArea.id);
    setEditingName(practiceArea.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingName('');
  };

  const onUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lawFirmId || !editingId || !canManagePracticeAreas) return;
    
    // Validate required fields
    const validationFields: ValidationField[] = [
      { name: 'name', value: editingName, required: true, label: 'Name' }
    ];

    const validationError = validateRequiredFields(validationFields);
    if (validationError) {
      setError(validationError);
      return;
    }

    setUpdating(true);
    setError(null);
    try {
      await practiceAreaService.updatePracticeArea(lawFirmId, editingId, editingName.trim());
      setEditingId(null);
      setEditingName('');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to update practice area');
    } finally {
      setUpdating(false);
    }
  };

  if (!lawFirmId) return null;

  const inputClass =
    'rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';

  return (
    <div className="p-6">
      <div className="mb-5">
        <SectionLabel gap="1">Practice Areas</SectionLabel>
        <p className="text-sm text-on-surface-secondary">
          Organize your matters by practice areas for better management. Create and manage the practice areas used to categorize your matters.
        </p>
      </div>

      <ErrorNotification
        error={error}
        onClose={() => setError(null)}
        className="mt-4"
      />

      {!canManagePracticeAreas && (
        <div className="mt-4 rounded-lg border border-outline bg-surface-alt px-4 py-3 text-sm text-on-surface-secondary">
          You need <code>practiceAreas.manage</code> permission to create, edit, or delete practice areas.
        </div>
      )}

      <form onSubmit={onCreate} className="mt-6 flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Personal Injury"
          className={`flex-1 min-w-[200px] max-w-md ${inputClass}`}
          disabled={!canManagePracticeAreas || creating}
        />
        <Button
          type="primary"
          htmlType="submit"
          disabled={!canManagePracticeAreas || creating || !name.trim()}
          loading={creating}
        >
          Add
        </Button>
      </form>

      <div className="mt-6">
        {loading ? (
          <PanelLoadingSpinner label="Loading practice areas" />
        ) : list.length === 0 ? (
          <p className="text-sm text-on-surface-secondary">No practice areas yet.</p>
        ) : (
          <ul className="rounded-xl border border-outline overflow-hidden divide-y divide-outline-subtle">
            {listPager.pagedRows.map((pa) => (
              <li key={pa.id} className="px-4 py-3 bg-surface">
                {editingId === pa.id ? (
                  <form onSubmit={onUpdate} className="flex items-center gap-3 flex-wrap">
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      className={`flex-1 min-w-[200px] ${inputClass}`}
                      autoFocus
                    />
                    {canManagePracticeAreas && (
                      <div className="flex gap-2">
                        <Button
                          type="primary"
                          htmlType="submit"
                          size="small"
                          disabled={updating || !editingName.trim()}
                          loading={updating}
                        >
                          Save
                        </Button>
                        <Button
                          type="secondary"
                          size="small"
                          onClick={cancelEdit}
                          disabled={updating}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </form>
                ) : (
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-medium text-on-surface">{pa.name}</div>
                    </div>
                    {canManagePracticeAreas && (
                      <div className="flex gap-2">
                        <Button
                          type="secondary"
                          size="small"
                          onClick={() => startEdit(pa)}
                          disabled={deletingId === pa.id}
                        >
                          Edit
                        </Button>
                        <Button
                          type="secondary"
                          size="small"
                          onClick={() => {
                            setDeleteError(null);
                            setAreaToDelete(pa);
                          }}
                          disabled={deletingId === pa.id}
                          loading={deletingId === pa.id}
                        >
                          Delete
                        </Button>
                      </div>
                    )}
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
        isOpen={!!areaToDelete}
        onClose={() => setAreaToDelete(null)}
        onConfirm={confirmDelete}
        title="Delete practice area"
        message={`Are you sure you want to delete the practice area "${areaToDelete?.name ?? ''}"? This cannot be undone.`}
        confirmText="Delete"
        confirmType="danger"
        loading={deletingId === areaToDelete?.id}
        error={deleteError}
      />
    </div>
  );
}
