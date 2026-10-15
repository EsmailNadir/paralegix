"use client";

import { useParams } from "next/navigation";
import InvoiceDetailView from "@/components/billingComp/InvoiceDetailView";

export default function InvoiceDetailPage() {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string);
  const matterId = Array.isArray(params?.matterId)
    ? params.matterId[0]
    : (params?.matterId as string);
  const invoiceId = Array.isArray(params?.invoiceId)
    ? params.invoiceId[0]
    : (params?.invoiceId as string);

  return (
    <InvoiceDetailView
      lawFirmId={lawFirmId}
      entityId={matterId}
      invoiceId={invoiceId}
      contextType="matter"
      backHref={`/lawfirm/${lawFirmId}/matters/${matterId}?tab=billing`}
      backLabel="Back to Matter Billing"
    />
  );
}
