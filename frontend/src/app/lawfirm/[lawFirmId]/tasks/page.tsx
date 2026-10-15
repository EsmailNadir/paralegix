"use client";

import { useParams } from "next/navigation";
import TasksGrid from "@/components/taskComp/TasksGrid";
import RequirePermission from "@/components/ui/RequirePermission";

export default function LawFirmTasksPage() {
  const params = useParams();
  const id = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string | undefined);
  const lawFirmId = id || "";
  if (!lawFirmId) return null;
  
  return (
    <RequirePermission permission="tasks.view" page>
      <TasksGrid lawFirmId={lawFirmId} />
    </RequirePermission>
  );
}
