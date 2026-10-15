"use client";

import { useParams } from "next/navigation";
import ClientDetail from "@/components/clientComp/ClientDetail";
import RequirePermission from "@/components/ui/RequirePermission";

export default function ClientDetailPage() {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const clientId = Array.isArray(params?.clientId) ? params.clientId[0] : (params?.clientId as string);

  if (!lawFirmId || !clientId) return null;

  return (
    <RequirePermission permission="clients.view" page>
      <ClientDetail lawFirmId={lawFirmId} clientId={clientId} />
    </RequirePermission>
  );
}
