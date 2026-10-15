import type { Invoice } from "@/types";
import { getInvoiceDisplayName } from "@/components/billingComp/utils";

export interface InvoicePdfLetterhead {
  lawFirmName?: string;
  lawFirmLogoUrl?: string | null;
  lawFirmAddress?: Record<string, unknown> | null;
  billingClient?: Record<string, unknown> | null;
}

/**
 * Renders and downloads an invoice PDF. Dynamically imports `@react-pdf/renderer`
 * (a heavy dependency) so it never lands in the initial bundle of a list page.
 */
export async function downloadInvoicePdf(invoice: Invoice, letterhead: InvoicePdfLetterhead = {}) {
  const { pdf: renderPdf } = await import("@react-pdf/renderer");
  const InvoicePDFDocument = (await import("@/components/billingComp/InvoicePDFDocument")).default;
  const blob = await renderPdf(<InvoicePDFDocument invoice={invoice} {...letterhead} />).toBlob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `Invoice-${getInvoiceDisplayName(invoice).replace(/[^\w.-]+/g, "_")}.pdf`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
