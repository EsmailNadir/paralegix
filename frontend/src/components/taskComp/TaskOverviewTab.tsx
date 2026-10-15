"use client";

import dayjs from "dayjs";
import { Link as LinkIcon, StickyNote, Paperclip, CircleDot, Flag, Briefcase } from "lucide-react";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import Button from "@/components/ui/Button";
import DetailField from "@/components/ui/DetailField";
import StatusBadge from "@/components/ui/StatusBadge";
import StatTile from "@/components/ui/StatTile";
import ListEmptyState from "@/components/ui/ListEmptyState";
import TaskStatusBadge from "@/components/ui/TaskStatusBadge";
import MatterStatusBadge from "@/components/ui/MatterStatusBadge";
import TaskSubtasks from "@/components/taskComp/TaskSubtasks";
import TaskAttachments from "@/components/taskComp/TaskAttachments";
import MatterFileQuickAdd from "@/components/filesComp/MatterFileQuickAdd";
import TasksService from "@/services/tasks.service";
import { formatHoursMinutes } from "@/lib/utils/format";
import type { Matter, Task } from "@/types";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { taskStatusMeta } from "@/constants/statusMeta";
import { taskEndSuffix } from '@/components/calendarComp/calendarTiming';

// Matches the matter/client detail pages' "quick facts" card so all three
// detail pages read as one visual language rather than three separate ones.
const CARD_CLASS = "bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm";

/**
 * Builds the one-line "Time Logged" value, for example "1h across 1 entry".
 * The billable clause appears only when part of the logged time is non-billable.
 */
function formatTimeLogged(task: Task): string {
  const parts = [formatHoursMinutes(task.loggedHours ?? 0)];
  if (task.billableLoggedHours !== undefined && task.billableLoggedHours < (task.loggedHours ?? 0)) {
    parts.push(`(${formatHoursMinutes(task.billableLoggedHours)} billable)`);
  }
  parts.push(`across ${task.timeEntryCount} ${task.timeEntryCount === 1 ? "entry" : "entries"}`);
  return parts.join(" ");
}

/**
 * The "Overview" tab of the task detail page: task info grid, subtasks,
 * dependency/blocking graph, quick-add files, and the quick-stats + related-matter
 * side column. Extracted from the task detail page to keep that route a thin shell.
 */
export default function TaskOverviewTab({
  lawFirmId,
  taskId,
  task,
  matterData,
  assignedUserNames,
  createdByUser,
  dependencyTasks,
  dependentTasks,
  canUpdateTask,
  onError,
  onViewFiles,
  onViewNotes,
  onTaskChange,
}: {
  lawFirmId: string;
  taskId: string;
  task: Task;
  matterData: Matter | null;
  assignedUserNames: string[];
  createdByUser?: { name?: string | null; email?: string | null } | null;
  dependencyTasks: Task[];
  dependentTasks: Task[];
  canUpdateTask: boolean;
  onError: (msg: string | null) => void;
  onViewFiles: () => void;
  /** Opens the page's Notes tab, so the notes quick-stat tile can jump to it. */
  onViewNotes: () => void;
  onTaskChange: (updater: (prev: Task | null) => Task | null) => void;
}) {
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canUploadFiles = hasPermission("files.upload");
  const canDeleteFiles = hasPermission("files.delete");

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Task Details */}
      <div className={`${CARD_CLASS} lg:col-span-2 min-w-0`}>
        <h3 className="text-sm font-semibold text-on-surface mb-4">Task Information</h3>
        <div className="min-w-0">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 min-w-0">
            <DetailField
              label="Due Date"
              value={task.dueDate
                ? `${task.dueDateLocalDisplay || dayjs(task.dueDate).format('MMM DD, YYYY')}${taskEndSuffix(task)}`
                : undefined}
              empty="No due date set"
            />
            <DetailField
              label="Assigned To"
              value={assignedUserNames.length > 0 ? assignedUserNames.join(', ') : undefined}
              empty="Unassigned"
            />
            <DetailField
              label="Created By"
              value={createdByUser?.name || createdByUser?.email}
              empty="Unknown"
            />
            <DetailField label="Practice Area" value={task.practiceAreaName} empty="Not specified" />
            <DetailField
              label="Time Logged"
              value={task.loggedHours ? formatTimeLogged(task) : undefined}
              empty="No time logged"
            />
            <DetailField
              label="Created"
              value={task.createdAt ? dayjs(task.createdAt).format('MMM DD, YYYY') : undefined}
              empty="Unknown"
            />
            <DetailField
              label="Last Updated"
              value={task.updatedAt ? dayjs(task.updatedAt).format('MMM DD, YYYY') : undefined}
              empty="Unknown"
            />
            <DetailField label="Clients" empty="No clients" className="md:col-span-2">
              {task.clientNames && task.clientNames.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {task.clientNames.map((name, i) => (
                    <StatusBadge key={i} variant="info">{name}</StatusBadge>
                  ))}
                </div>
              ) : undefined}
            </DetailField>
          </div>

          {task.description && (
            <div className="mt-6 pt-6 border-t border-outline">
              <span className="text-xs font-semibold text-on-surface-secondary uppercase tracking-wide block mb-2">Description</span>
              <p className="text-sm text-on-surface leading-relaxed">{task.description}</p>
            </div>
          )}

          {/* Subtasks */}
          <div className="mt-6 pt-6 border-t border-outline">
            <TaskSubtasks
              lawFirmId={lawFirmId}
              taskId={taskId}
              onError={(msg) => onError(msg)}
            />
          </div>

          {/* Dependencies */}
          {(dependencyTasks.length > 0 || dependentTasks.length > 0) && (
            <div className="mt-6 pt-6 border-t border-outline space-y-5">
              {dependencyTasks.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <LinkIcon size={16} className="text-on-surface-secondary" />
                    <h4 className="text-sm font-semibold text-on-surface">Dependencies</h4>
                  </div>
                  <p className="text-xs text-on-surface-muted mb-3">
                    This task depends on {dependencyTasks.length === 1 ? "the task below" : "the tasks below"}. It isn&apos;t ready to start until they&apos;re completed.
                  </p>
                  <div className="space-y-2">
                    {dependencyTasks.map((dep) => {
                      const incomplete = dep.status !== "completed";
                      return (
                        <button
                          key={dep.taskId || dep.id}
                          onClick={() => navigate(`/lawfirm/${lawFirmId}/tasks/${dep.taskId || dep.id}`)}
                          className="w-full flex items-center justify-between gap-3 p-3 rounded-lg border border-outline-subtle bg-surface-alt hover:bg-surface-hover transition-colors text-left cursor-pointer"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {incomplete && (
                              <span className="text-orange-500 shrink-0">
                                <LinkIcon size={14} />
                              </span>
                            )}
                            <span className="text-sm font-medium text-on-surface truncate">
                              {dep.title || "Untitled Task"}
                            </span>
                          </div>
                          <TaskStatusBadge status={dep.status} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {dependentTasks.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-on-surface mb-1">Blocking</h4>
                  <p className="text-xs text-on-surface-muted mb-3">
                    {dependentTasks.length === 1
                      ? "Another task is waiting on this one. Completing this task will unblock it."
                      : "These tasks are waiting on this one. Completing this task will unblock them."}
                  </p>
                  <div className="space-y-2">
                    {dependentTasks.map((dep) => (
                      <button
                        key={dep.taskId || dep.id}
                        onClick={() => navigate(`/lawfirm/${lawFirmId}/tasks/${dep.taskId || dep.id}`)}
                        className="w-full flex items-center justify-between gap-3 p-3 rounded-lg border border-outline-subtle bg-surface-alt hover:bg-surface-hover transition-colors text-left cursor-pointer"
                      >
                        <span className="text-sm font-medium text-on-surface truncate">
                          {dep.title || "Untitled Task"}
                        </span>
                        <TaskStatusBadge status={dep.status} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Quick Add Files */}
          <div className="mt-6 pt-6 border-t border-outline">
            {task.matterId ? (
              canUploadFiles ? (
                <MatterFileQuickAdd
                  lawFirmId={lawFirmId}
                  matterId={task.matterId}
                  taskId={taskId}
                  onError={(msg) => msg != null && onError(msg)}
                  onViewFiles={onViewFiles}
                />
              ) : (
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium text-on-surface-secondary">Quick Add Files</h4>
                  <button
                    type="button"
                    onClick={onViewFiles}
                    className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer"
                  >
                    View all files
                  </button>
                </div>
              )
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-medium text-on-surface-secondary">Quick Add Files</h4>
                  <button
                    type="button"
                    onClick={onViewFiles}
                    className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer"
                  >
                    View all files
                  </button>
                </div>
                <TaskAttachments
                  lawFirmId={lawFirmId}
                  taskId={taskId}
                  attachments={task.attachments || []}
                  // Uploading calls `files.upload-task-attachments` (needs
                  // files.upload) and deleting calls `files.delete-task-attachment`
                  // (needs files.delete); either way, persisting the resulting
                  // list back onto the task below needs tasks.update. All three
                  // are required for this control to actually work, so all three
                  // gate it - otherwise a member missing one of the files
                  // permissions would see an enabled control that 403s.
                  readOnly={!(canUpdateTask && canUploadFiles && canDeleteFiles)}
                  showFileList
                  compactUpload
                  onAttachmentsChange={async (newAttachments) => {
                    if (!canUpdateTask) return;
                    try {
                      await TasksService.updateTask({
                        lawFirmId,
                        taskId,
                        attachments: newAttachments,
                      });
                      onTaskChange((prev) => (prev ? { ...prev, attachments: newAttachments } : prev));
                    } catch (err) {
                      onError(getErrorMessage(err, "Failed to update attachments"));
                    }
                  }}
                  onError={(msg) => msg != null && onError(msg)}
                />
              </>
            )}
          </div>
        </div>
      </div>

      {/* Quick Stats and Related Matter */}
      <div className="space-y-6">
        {/* Quick Stats */}
        <div>
          <h3 className="text-sm font-semibold text-on-surface mb-4">Quick Stats</h3>
          <div className="grid grid-cols-2 gap-3">
            <StatTile label="Notes" value={task.totalNotes || 0} icon={StickyNote} onClick={onViewNotes} />
            <StatTile label="Quick Add Files" value={task.attachments?.length || 0} icon={Paperclip} onClick={onViewFiles} actionLabel="View Files" />
            <StatTile label="Status" value={taskStatusMeta(task.status).label} icon={CircleDot} />
            <StatTile label="Priority" value={task.priority ? (task.priority.charAt(0).toUpperCase() + task.priority.slice(1)) : 'Not set'} icon={Flag} />
          </div>
        </div>

        {/* Related Matter */}
        <div>
          <h3 className="text-sm font-semibold text-on-surface mb-4">Related Matter</h3>
          {matterData ? (
            <div className="bg-surface rounded-2xl border border-outline-subtle p-4">
              <h4 className="text-sm font-semibold text-on-surface mb-2">{matterData.name}</h4>

              {matterData.description && (
                <p className="text-xs text-on-surface-secondary mb-3 line-clamp-2">{matterData.description}</p>
              )}

              <div className="flex gap-2 mb-3">
                <MatterStatusBadge status={matterData.status} />
              </div>

              {matterData.practiceAreaName && (
                <p className="text-xs text-on-surface-secondary mb-3">
                  Practice Area: {matterData.practiceAreaName}
                </p>
              )}

              <Button
                type="secondary"
                size="small"
                onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${matterData.id}`)}
                className="w-full"
              >
                View Matter Details
              </Button>
            </div>
          ) : (
            <ListEmptyState
              compact
              icon={<Briefcase size={32} />}
              title="Not linked to a matter"
              message="This task is not associated with any matter."
            />
          )}
        </div>
      </div>
    </div>
  );
}
