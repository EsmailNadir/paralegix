"use client";

import { useParams } from "next/navigation";
import MattersGrid from "@/components/matterComp/MattersGrid";
import RequirePermission from "@/components/ui/RequirePermission";

export default function LawFirmMattersPage() {
  const params = useParams();
  const id = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string | undefined);
  const lawFirmId = id as string;
  if (!lawFirmId) return null;

  return (
    <RequirePermission permission="matters.view" page>
      <MattersGrid lawFirmId={lawFirmId} />
    </RequirePermission>
  );
}
