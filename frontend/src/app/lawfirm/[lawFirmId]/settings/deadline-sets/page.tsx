"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Plus, Pencil, Trash2, CalendarClock, ArrowRight } from "lucide-react";
import deadlineSetsService from "@/services/deadlineSets.service";
import type { DeadlineSet, CreateDeadlineSetRequest } from "@/types/deadlineSet";
import { matterEventTypeMeta } from "@/constants/statusMeta";
import { AutoPager } from "@/components/ui/ListPager";
import usePagedRows from "@/hooks/usePagedRows";
import Button from "@/components/ui/Button";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import { usePermissions } from "@/contexts/PermissionsContext";
import DeadlineSetEditorModal from "@/components/deadlineSetsComp/DeadlineSetEditorModal";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import ListEmptyState from "@/components/ui/ListEmptyState";
import PanelLoadingSpinner from "@/components/ui/PanelLoadingSpinner";
import SectionLabel from "@/components/ui/SectionLabel";

export default function DeadlineSetsPage() {
  const params = useParams();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string)) || "";
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("settings.manageFirm");

  const [list, setList] = useState<DeadlineSet[]>([]);

  // Each set renders its rules expanded, so the row count is the product of
  // sets and rules. Windowed.
  const listPager = usePagedRows(list, 15);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<DeadlineSet | null>(null);
  const [saving, setSaving] = useState(false);

  const [toDelete, setToDelete] = useState<DeadlineSet | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!lawFirmId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await deadlineSetsService.list(lawFirmId);
      setList(res.deadlineSets || []);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [lawFirmId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: list/loading/error set as the request progresses
    load();
  }, [load]);

  const openNew = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (ds: DeadlineSet) => {
    setEditing(ds);
    setEditorOpen(true);
  };

  // A refused save rejects back to the editor, which shows the reason inside
  // the dialog. The page banner sits under the dialog's backdrop, so an error
  // written there would be hidden while the editor stays open.
  const handleSave = async (payload: CreateDeadlineSetRequest) => {
    if (!lawFirmId) return;
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await deadlineSetsService.update(lawFirmId, editing.id, payload);
      } else {
        await deadlineSetsService.create(lawFirmId, payload);
      }
    } finally {
      setSaving(false);
    }
    setEditorOpen(false);
    setEditing(null);
    await load();
  };

  const confirmDelete = async () => {
    if (!lawFirmId || !toDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await deadlineSetsService.remove(lawFirmId, toDelete.id);
      setToDelete(null);
      await load();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <SectionLabel gap="1">Deadline Sets</SectionLabel>
          <p className="text-sm text-on-surface-secondary max-w-2xl">
            Reusable deadline recipes. Set one up here, then on any matter&apos;s Events tab pick a trigger date and the whole
            chain of deadlines is created at once. Days are plain calendar days, with an optional weekend roll-forward.
          </p>
        </div>
        {canManage && (
          <Button
            size="compact"
            onClick={openNew}
            icon={<Plus size={14} strokeWidth={2.2} />}
          >
            New deadline set
          </Button>
        )}
      </div>

      <ErrorNotification error={error} onClose={() => setError(null)} className="mt-4" />

      {!canManage && (
        <div className="mt-4 rounded-lg border border-outline bg-surface-alt px-4 py-3 text-sm text-on-surface-secondary">
          You can view deadline sets, but editing them requires the firm settings management permission.
        </div>
      )}

      <div className="mt-6">
        {loading ? (
          <PanelLoadingSpinner label="Loading deadline sets" />
        ) : list.length === 0 ? (
          <ListEmptyState
            compact
            icon={<CalendarClock size={32} />}
            title="No deadline sets yet"
            message="Create one to turn a single trigger date into a full set of matter deadlines."
          />
        ) : (
          <ul className="space-y-3">
            {listPager.pagedRows.map((ds) => (
              <li key={ds.id} className="rounded-xl border border-outline bg-surface overflow-hidden">
                <div className="flex items-start justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-on-surface">{ds.name}</span>
                      <span className="text-xs text-on-surface-muted">
                        {ds.items.length} {ds.items.length === 1 ? "deadline" : "deadlines"}
                      </span>
                      {ds.adjustForWeekends && (
                        <span className="text-[11px] rounded-full bg-surface-alt border border-outline-subtle px-2 py-0.5 text-on-surface-secondary">
                          Skips weekends
                        </span>
                      )}
                    </div>
                    {ds.description && <p className="mt-0.5 text-sm text-on-surface-secondary">{ds.description}</p>}
                  </div>
                  {canManage && (
                    <div className="flex gap-2 shrink-0">
                      <Button type="secondary" size="small" onClick={() => openEdit(ds)}>
                        <Pencil size={13} className="mr-1" /> Edit
                      </Button>
                      <Button type="secondary" size="small" onClick={() => setToDelete(ds)}>
                        <Trash2 size={13} className="mr-1" /> Delete
                      </Button>
                    </div>
                  )}
                </div>
                {/* Item preview */}
                <ul className="border-t border-outline-subtle divide-y divide-outline-subtle bg-surface-alt/40">
                  {ds.items.map((it, i) => (
                    <li key={i} className="flex items-center gap-2 px-4 py-2 text-sm">
                      <ArrowRight size={13} className="text-on-surface-muted shrink-0" />
                      <span className="text-on-surface">{it.title}</span>
                      <span className="text-xs rounded-full bg-surface border border-outline-subtle px-2 py-0.5 text-on-surface-secondary">
                        {matterEventTypeMeta(it.type).label}
                      </span>
                      <span className="ml-auto text-xs text-on-surface-muted">
                        {it.offsetDays} {it.offsetDays === 1 ? "day" : "days"} {it.offsetDirection}{" "}
                        {it.relativeTo === "previous" ? "the previous deadline" : "the trigger date"}
                      </span>
                    </li>
                  ))}
                </ul>
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

      <DeadlineSetEditorModal
        open={editorOpen}
        editing={editing}
        saving={saving}
        onClose={() => {
          if (!saving) {
            setEditorOpen(false);
            setEditing(null);
          }
        }}
        onSave={handleSave}
      />

      <ConfirmModal
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={confirmDelete}
        title="Delete deadline set"
        message={`Delete "${toDelete?.name ?? ""}"? This does not remove events already created from it.`}
        confirmText="Delete"
        confirmType="danger"
        loading={deleting}
      />
    </div>
  );
}
