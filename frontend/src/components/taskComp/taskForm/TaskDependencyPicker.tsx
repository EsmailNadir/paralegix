import StatusBadge from "@/components/ui/StatusBadge";
import EntityMultiPicker from "@/components/ui/EntityMultiPicker";
import { Link } from "lucide-react";
import { taskStatusMeta } from "@/constants/statusMeta";

/**
 * "Blocked By" dependency picker shared by the task modals: a server-backed task
 * multi-select, so a firm with thousands of tasks stays usable. `excludeTaskId`
 * drops the task being edited from the list so it can't depend on itself.
 */
export default function TaskDependencyPicker({
  lawFirmId,
  dependencies,
  setDependencies,
  excludeTaskId,
}: {
  lawFirmId: string;
  dependencies: string[];
  setDependencies: (v: string[]) => void;
  excludeTaskId?: string;
}) {
  return (
    <div>
      <label className="mb-1 flex items-center gap-1.5 text-sm font-medium text-on-surface">
        <Link size={13} /> Blocked By (Dependencies)
      </label>
      <p className="mb-2 text-xs text-on-surface-muted">Select tasks that must be completed before this task can start.</p>
      <EntityMultiPicker
        entity="tasks"
        lawFirmId={lawFirmId}
        selectedIds={dependencies}
        onChange={setDependencies}
        excludeIds={excludeTaskId ? [excludeTaskId] : undefined}
        listClassName="max-h-36"
        renderMeta={(task) => (
          <StatusBadge variant={task.status === "completed" ? "success" : "neutral"}>
            {taskStatusMeta(typeof task.status === "string" ? task.status : undefined).label}
          </StatusBadge>
        )}
      />
    </div>
  );
}
