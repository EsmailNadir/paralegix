"use client";

import { CheckSquare2, Trash2, Pencil } from "lucide-react";
import { useNavigation } from "@/contexts/NavigationContext";
import type { Task, TaskStatus } from "@/types/task";
import TaskStatusBadge from "@/components/ui/TaskStatusBadge";
import TaskPriorityBadge from "@/components/ui/TaskPriorityBadge";
import EntityListTab from "@/components/ui/EntityListTab";
import ActionIconButton from "@/components/ui/ActionIconButton";
import { highlightText } from "@/components/ui/HighlightText";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import { taskEndSuffix } from "@/components/calendarComp/calendarTiming";

export interface EntityTasksTabProps {
  lawFirmId: string;
  tasks: Task[];
  canManageTasks?: boolean;
  onCreateTaskClick?: () => void;
  onEditTask?: (task: Task) => void;
  onDeleteTask?: (task: Task) => void;
  emptyTitle?: string;
  emptyMessage?: string;
  /** A search the parent runs on the server; see `EntityListTab`. */
  search?: { value: string; onChange: (value: string) => void };
  /**
   * A status filter the parent runs on the server; see `EntityListTab`. Values
   * are `all`, `open`, `in_progress` and `blocked`.
   */
  status?: { value: string; onChange: (value: string) => void };
  /**
   * Every task the parent holds, for the "All" option, when `tasks` is only one
   * server page of them. Defaults to the rows passed in.
   */
  total?: number;
}

/**
 * The start of a row's due line. A task with an end is a span, so its start
 * takes the format of the end after it: the time too when timed ("May 10,
 * 2026, 1:00 PM – 3:30 PM"), the same date style when all-day.
 */
function dueStartText(task: Task): string {
  if (!task.endsAt) return formatDateOnly(task.dueDate);
  if (!task.allDay && task.dueDateLocalDisplay) return task.dueDateLocalDisplay;
  return formatDateOnly(task.dueDate, { month: "short", day: "numeric", year: "numeric" });
}

export default function EntityTasksTab({
  lawFirmId,
  tasks,
  canManageTasks = false,
  onCreateTaskClick,
  onEditTask,
  onDeleteTask,
  emptyTitle = "No tasks found",
  emptyMessage = "There are no tasks associated with this entity yet.",
  search,
  status,
  total,
}: EntityTasksTabProps) {
  const { navigate } = useNavigation();

  return (
    <EntityListTab<Task>
      rows={tasks}
      getRowId={(task) => task.taskId || task.id}
      onRowClick={(task) => {
        const id = task.taskId || task.id;
        if (id) {
          navigate(`/lawfirm/${lawFirmId}/tasks/${id}`);
        }
      }}
      searchPlaceholder="Search tasks..."
      search={search}
      status={status}
      matchesSearch={(task, term) =>
        task.title.toLowerCase().includes(term) ||
        Boolean(task.description?.toLowerCase().includes(term))
      }
      statusOptions={[
        { value: "all", label: `All Tasks (${total ?? tasks.length})` },
        { value: "open", label: "Open Tasks" },
        { value: "in_progress", label: "In Progress" },
        { value: "blocked", label: "Blocked" },
      ]}
      // Each option is one stored status, the same rule the server applies when
      // a paged parent filters there, so the chip means the same on every tab.
      matchesStatus={(task, status) => task.status === status}
      create={
        canManageTasks && onCreateTaskClick
          ? { label: "New Task", onClick: onCreateTaskClick }
          : undefined
      }
      renderRow={(task, searchTerm) => ({
        title: (
          <span className="flex items-center gap-2 font-medium text-on-surface">
            <CheckSquare2 size={15} className="text-on-surface-muted shrink-0" />
            {highlightText(task.title, searchTerm)}
          </span>
        ),
        badges: (
          <div className="flex items-center gap-1.5">
            {task.priority && <TaskPriorityBadge priority={task.priority} />}
            {task.status && <TaskStatusBadge status={task.status as TaskStatus} />}
          </div>
        ),
        meta: highlightText(
          [
            task.dueDate ? `Due ${dueStartText(task)}${taskEndSuffix(task)}` : null,
            task.assignedToUserName || (task.assignedToUserId ? "Assigned" : null),
          ]
            .filter(Boolean)
            .join("  ·  "),
          searchTerm
        ),
      })}
      // Each action is present only when the parent passed its handler, and the
      // parent gates each on its own permission (tasks.update, tasks.delete).
      rowActions={
        onEditTask || onDeleteTask
          ? (task) => (
              <div className="flex items-center gap-1">
                {onEditTask && (
                  <ActionIconButton
                    label={`Edit ${task.title}`}
                    tooltip="Edit"
                    tone="info"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditTask(task);
                    }}
                  >
                    <Pencil size={15} />
                  </ActionIconButton>
                )}
                {onDeleteTask && (
                  <ActionIconButton
                    label={`Delete ${task.title}`}
                    tooltip="Delete"
                    tone="danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteTask(task);
                    }}
                  >
                    <Trash2 size={15} />
                  </ActionIconButton>
                )}
              </div>
            )
          : undefined
      }
      emptyIcon={<CheckSquare2 size={36} />}
      emptyTitle={emptyTitle}
      emptyMessage={emptyMessage}
      noMatchTitle="No matching tasks"
    />
  );
}
