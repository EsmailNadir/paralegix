"use client";

import { useParams } from "next/navigation";
import TaskAnalytics from "@/components/taskComp/TaskAnalytics";
import RequirePermission from "@/components/ui/RequirePermission";

export default function TaskAnalyticsPage() {
  const params = useParams();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";
  if (!lawFirmId) return null;

  return (
    <RequirePermission permission="tasks.view" page>
      <TaskAnalytics lawFirmId={lawFirmId} />
    </RequirePermission>
  );
}
