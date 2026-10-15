"use client";

import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, Trash2, ChevronUp, ChevronDown, Plus } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import ListSkeleton from "@/components/ui/ListSkeleton";

import TasksService from "@/services/tasks.service";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Checkbox from "@/components/ui/Checkbox";
import { usePermissions } from "@/contexts/PermissionsContext";
import type { TaskSubtask } from "@/types";
import { getErrorMessage } from "@/lib/utils/apiErrors";

interface TaskSubtasksProps {
  lawFirmId: string;
  taskId: string;
  /** Surface errors to the parent page's ErrorNotification. */
  onError?: (msg: string) => void;
}

const ICON_BTN =
  "flex items-center justify-center size-7 rounded-md text-on-surface-muted transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:text-on-surface hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer";

const INPUT_CLASS = FULL_INPUT_CLS;

export default function TaskSubtasks({ lawFirmId, taskId, onError }: TaskSubtasksProps) {
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission("tasks.update");

  const { data: subtasks = [], isLoading } = useQuery<TaskSubtask[]>({
    queryKey: ["task-subtasks", lawFirmId, taskId],
    queryFn: () => TasksService.listSubtasks(lawFirmId, taskId),
    enabled: !!lawFirmId && !!taskId,
  });

  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskSubtask | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["task-subtasks", lawFirmId, taskId] });

  const reportError = (err: unknown, fallback: string) =>
    onError?.(getErrorMessage(err, fallback));

  const total = subtasks.length;
  const done = subtasks.filter((s) => s.isCompleted).length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const handleToggle = async (st: TaskSubtask) => {
    if (!canEdit || busyId) return;
    setBusyId(st.id);
    try {
      await TasksService.updateSubtask(lawFirmId, taskId, st.id, { isCompleted: !st.isCompleted });
      await refresh();
    } catch (err) {
      reportError(err, "Failed to update subtask");
    } finally {
      setBusyId(null);
    }
  };

  const handleAdd = async () => {
    const title = newTitle.trim();
    if (!title || !canEdit || adding) return;
    setAdding(true);
    try {
      await TasksService.createSubtask(lawFirmId, taskId, { title });
      setNewTitle("");
      await refresh();
    } catch (err) {
      reportError(err, "Failed to add subtask");
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (st: TaskSubtask) => {
    if (!canEdit) return;
    setEditingId(st.id);
    setEditingTitle(st.title);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingTitle("");
  };

  const handleSaveEdit = async (st: TaskSubtask) => {
    const title = editingTitle.trim();
    if (!title || title === st.title) {
      cancelEdit();
      return;
    }
    setBusyId(st.id);
    try {
      await TasksService.updateSubtask(lawFirmId, taskId, st.id, { title });
      cancelEdit();
      await refresh();
    } catch (err) {
      reportError(err, "Failed to rename subtask");
    } finally {
      setBusyId(null);
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    if (!canEdit || busyId) return;
    const target = index + direction;
    if (target < 0 || target >= subtasks.length) return;
    const ids = subtasks.map((s) => s.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setBusyId(subtasks[index].id);
    try {
      await TasksService.reorderSubtasks(lawFirmId, taskId, ids);
      await refresh();
    } catch (err) {
      reportError(err, "Failed to reorder subtasks");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await TasksService.deleteSubtask(lawFirmId, taskId, deleteTarget.id);
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      reportError(err, "Failed to delete subtask");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <ListChecks size={16} className="text-on-surface-secondary" />
        <h4 className="text-sm font-semibold text-on-surface">Subtasks</h4>
        {total > 0 && (
          <span className="text-xs font-medium text-on-surface-muted">
            {done}/{total} done
          </span>
        )}
      </div>

      {total > 0 && (
        <div className="mt-2 mb-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
          <div
            className="h-full rounded-full bg-accent-solid transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {isLoading ? (
        <ListSkeleton rows={3} label="Loading subtasks" />
      ) : (
        <div className="space-y-2">
          {subtasks.map((st, index) => {
            const rowBusy = busyId === st.id;
            const isEditing = editingId === st.id;
            return (
              <div
                key={st.id}
                onClick={canEdit && !isEditing ? () => handleToggle(st) : undefined}
                className={`flex items-center gap-3 p-3 rounded-lg border border-outline-subtle transition-colors ${
                  st.isCompleted ? "bg-surface" : "bg-surface-alt"
                } ${canEdit && !isEditing ? "cursor-pointer" : ""}`}
              >
                <span onClick={(e) => e.stopPropagation()} className="shrink-0 flex">
                  <Checkbox
                    checked={st.isCompleted}
                    onChange={() => handleToggle(st)}
                    disabled={!canEdit || rowBusy}
                    size="md"
                  />
                </span>

                {isEditing ? (
                  <input
                    autoFocus
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => handleSaveEdit(st)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleSaveEdit(st);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    disabled={rowBusy}
                    className={`${INPUT_CLASS} py-1.5`}
                  />
                ) : canEdit ? (
                  <div className="flex-1 min-w-0">
                    <Tooltip title="Click to rename" enterDelay={300}>
                      <button aria-label="Click to rename"
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit(st);
                        }}
                        className={`inline-block max-w-full truncate align-top text-left text-sm cursor-text ${
                          st.isCompleted
                            ? "line-through text-on-surface-muted"
                            : "text-on-surface"
                        }`}
                      >
                        {st.title}
                      </button>
                    </Tooltip>
                  </div>
                ) : (
                  <span
                    className={`flex-1 min-w-0 truncate text-sm ${
                      st.isCompleted ? "line-through text-on-surface-muted" : "text-on-surface"
                    }`}
                  >
                    {st.title}
                  </span>
                )}

                {canEdit && !isEditing && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-0.5 shrink-0"
                  >
                    <Tooltip title="Move up" enterDelay={300}>
                      <span>
                        <button
                          type="button"
                          onClick={() => handleMove(index, -1)}
                          disabled={index === 0 || !!busyId}
                          aria-label="Move subtask up"
                          className={ICON_BTN}
                        >
                          <ChevronUp size={15} />
                        </button>
                      </span>
                    </Tooltip>
                    <Tooltip title="Move down" enterDelay={300}>
                      <span>
                        <button
                          type="button"
                          onClick={() => handleMove(index, 1)}
                          disabled={index === subtasks.length - 1 || !!busyId}
                          aria-label="Move subtask down"
                          className={ICON_BTN}
                        >
                          <ChevronDown size={15} />
                        </button>
                      </span>
                    </Tooltip>
                    <Tooltip title="Delete subtask" enterDelay={300}>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(st)}
                        aria-label="Delete subtask"
                        className={`${ICON_BTN} hover:text-red-600 dark:hover:text-red-400`}
                      >
                        <Trash2 size={15} />
                      </button>
                    </Tooltip>
                  </div>
                )}
              </div>
            );
          })}

          {!isLoading && total === 0 && !canEdit && (
            <p className="text-xs text-on-surface-muted">No subtasks.</p>
          )}

          {canEdit && (
            <div className="flex items-center gap-2 pt-1">
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAdd();
                  }
                }}
                placeholder="Add a subtask..."
                disabled={adding}
                className={INPUT_CLASS}
              />
              <button
                type="button"
                onClick={handleAdd}
                disabled={!newTitle.trim() || adding}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-accent-solid px-3 text-sm font-medium text-accent-foreground transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-accent-solid-hover disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
              >
                <Plus size={15} strokeWidth={2.2} />
                Add
              </button>
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Subtask"
        message={`Are you sure you want to delete "${deleteTarget?.title ?? ""}"? This action cannot be undone.`}
        confirmText="Delete"
        confirmType="danger"
        loading={deleting}
      />
    </div>
  );
}
