"use client";

import { useParams } from "next/navigation";
import InvoiceDetailView from "@/components/billingComp/InvoiceDetailView";

export default function ClientInvoiceDetailPage() {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string);
  const clientId = Array.isArray(params?.clientId)
    ? params.clientId[0]
    : (params?.clientId as string);
  const invoiceId = Array.isArray(params?.invoiceId)
    ? params.invoiceId[0]
    : (params?.invoiceId as string);

  return (
    <InvoiceDetailView
      lawFirmId={lawFirmId}
      entityId={clientId}
      invoiceId={invoiceId}
      contextType="client"
      backHref={`/lawfirm/${lawFirmId}/clients/${clientId}?tab=billing`}
      backLabel="Back to Client Billing"
    />
  );
}
