"use client";

import { useParams } from "next/navigation";
import ClientsPageTabs from "@/components/clientComp/ClientsPageTabs";
import RequirePermission from "@/components/ui/RequirePermission";

export default function ClientsPage() {
  const params = useParams();
  const id = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string | undefined);
  const lawFirmId = id as string;
  if (!lawFirmId) return null;

  return (
    <RequirePermission permission="clients.view" page>
      <ClientsPageTabs lawFirmId={lawFirmId} />
    </RequirePermission>
  );
}
