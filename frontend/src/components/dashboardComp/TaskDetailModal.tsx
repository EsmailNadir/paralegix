"use client";

import { useEffect, useId, useState } from "react";
import { X, ClipboardCheck, Briefcase, CalendarClock, UserRound, Users } from "lucide-react";
import Modal from "@/components/ui/Modal";
import { useNavigation } from "@/contexts/NavigationContext";
import Button from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import type { DashboardUpcomingTask } from "@/services/dashboard.service";
import TaskPriorityBadge from "@/components/ui/TaskPriorityBadge";
import TaskStatusBadge from "@/components/ui/TaskStatusBadge";
import { formatDate as formatDateShared, toLocalDate } from "@/lib/utils/dateUtils";
import SectionLabel from "@/components/ui/SectionLabel";

interface TaskDetailModalProps {
  task: DashboardUpcomingTask | null;
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
}

/** Day-only or ISO date → "Jun 21, 2026", rendered without a timezone shift. */
function formatDate(date: string | null): string {
  return formatDateShared(date, "No due date");
}

/** Relative urgency pill for the task's due date. */
function urgency(dueDate: string | null): { label: string; classes: string } | null {
  if (!dueDate) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const due = toLocalDate(dueDate);
  if (!due) return null;
  due.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (days < 0) {
    return {
      label: days === -1 ? "1 day overdue" : `${Math.abs(days)} days overdue`,
      classes: "bg-rose-50 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400",
    };
  }
  if (days === 0) return { label: "Due Today", classes: "bg-amber-50 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400" };
  if (days === 1) return { label: "Due Tomorrow", classes: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300" };
  return { label: `Due in ${days} days`, classes: "bg-surface-alt text-on-surface-secondary" };
}


export default function TaskDetailModal({ task, open, onClose, lawFirmId }: TaskDetailModalProps) {
  const titleId = useId();
  const { navigate } = useNavigation();

  // Retain the last non-null task so the content does not blank out while the
  // exit animation plays (the parent clears `task` the moment it closes).
  const [shown, setShown] = useState<DashboardUpcomingTask | null>(task);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- retains the last non-null task so content doesn't blank during the exit animation
    if (task) setShown(task);
  }, [task]);

  if (!shown) return null;

  const goToTask = () => {
    onClose();
    navigate(`/lawfirm/${lawFirmId}/tasks/${shown.taskId || shown.id}`);
  };

  const goToMatter = () => {
    if (!shown.matterId) return;
    onClose();
    navigate(`/lawfirm/${lawFirmId}/matters/${shown.matterId}`);
  };

  const goToClient = (clientId: string) => {
    onClose();
    navigate(`/lawfirm/${lawFirmId}/clients/${clientId}`);
  };

  const assignees = Array.isArray(shown.assignedToName)
    ? shown.assignedToName.filter(Boolean)
    : [shown.assignedToName].filter(Boolean);

  // Pair client ids with names (parallel arrays). A name without an id is still
  // listed, just not linkable.
  const clientNames = shown.clientNames || [];
  const clientIds = shown.clientIds || [];
  const clients = clientNames.map((name, i) => ({ name, id: clientIds[i] || null }));

  const u = urgency(shown.dueDate);
  const priority = shown.priority || "medium";

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      labelledBy={titleId}
      showClose={false}
      size="md"
      bodyClassName={null}
    >
      <div className="flex items-start justify-between px-6 py-4 border-b border-outline shrink-0">
        <div className="min-w-0">
          <SectionLabel tone="secondary" gap="1">Task</SectionLabel>
          <h2 id={titleId} className="text-lg font-semibold text-on-surface">{shown.title}</h2>
        </div>
        <button
          onClick={onClose}
          className="text-on-surface-muted hover:text-on-surface transition-colors shrink-0 ml-3 cursor-pointer"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      <div className="px-6 py-5 space-y-5 overflow-y-auto overflow-x-hidden styled-scrollbar">
        <div className="flex flex-wrap items-center gap-2">
          {u && (
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${u.classes}`}>
              {u.label}
            </span>
          )}
          <TaskPriorityBadge priority={priority} />
          {shown.status && (
            <TaskStatusBadge status={shown.status} />
          )}
        </div>

        <dl className="space-y-3">
          <div className="flex items-start justify-between gap-4 text-sm">
            <dt className="flex items-center gap-2 text-on-surface-secondary shrink-0">
              <CalendarClock size={15} /> Due date
            </dt>
            <dd className="text-on-surface font-medium text-right">{formatDate(shown.dueDate)}</dd>
          </div>
          <div className="flex items-start justify-between gap-4 text-sm">
            <dt className="flex items-center gap-2 text-on-surface-secondary shrink-0">
              <Briefcase size={15} /> Matter
            </dt>
            <dd className="text-right ml-4 min-w-0">
              {shown.matterId ? (
                <button
                  type="button"
                  onClick={goToMatter}
                  className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium hover:underline truncate cursor-pointer max-w-full"
                >
                  {shown.matterName || "View matter"}
                </button>
              ) : (
                <span className="text-on-surface font-medium">{shown.matterName || "-"}</span>
              )}
            </dd>
          </div>
          {clients.length > 0 && (
            <div className="flex items-start justify-between gap-4 text-sm">
              <dt className="flex items-center gap-2 text-on-surface-secondary shrink-0">
                <Users size={15} /> {clients.length === 1 ? "Client" : "Clients"}
              </dt>
              <dd className="text-right ml-4 min-w-0 flex flex-col items-end gap-0.5">
                {clients.map((c, i) =>
                  c.id ? (
                    <button
                      key={c.id || i}
                      type="button"
                      onClick={() => goToClient(c.id!)}
                      className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium hover:underline truncate cursor-pointer max-w-full"
                    >
                      {c.name}
                    </button>
                  ) : (
                    <span key={i} className="text-on-surface font-medium truncate max-w-full">{c.name}</span>
                  )
                )}
              </dd>
            </div>
          )}
          <div className="flex items-start justify-between gap-4 text-sm">
            <dt className="flex items-center gap-2 text-on-surface-secondary shrink-0">
              <UserRound size={15} /> Assigned to
            </dt>
            <dd className="text-on-surface font-medium text-right ml-4">
              {assignees.length ? (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {assignees.map((name, i) => (
                    <span key={`${name}-${i}`} className="inline-flex items-center gap-1.5">
                      <Avatar size="xs" name={name} />
                      <span>{name}</span>
                    </span>
                  ))}
                </div>
              ) : (
                "Unassigned"
              )}
            </dd>
          </div>
        </dl>
      </div>

      <div className="flex items-center justify-end gap-2 px-6 py-4 bg-surface-alt rounded-b-lg border-t border-outline shrink-0">
        <Button type="secondary" onClick={onClose}>
          Close
        </Button>
        <Button type="primary" onClick={goToTask} icon={<ClipboardCheck size={15} />}>
          Go to task
        </Button>
      </div>
    </Modal>
  );
}
