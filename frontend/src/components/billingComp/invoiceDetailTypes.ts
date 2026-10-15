export interface InvoiceDetailViewProps {
  lawFirmId: string;
  entityId: string;
  invoiceId: string;
  contextType: "matter" | "client";
  backHref: string;
  backLabel: string;
}
