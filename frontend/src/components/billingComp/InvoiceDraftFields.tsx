"use client";

import type { ReactNode } from "react";
import DatePicker from "@/components/ui/DatePicker";
import FieldLabel from "@/components/ui/FieldLabel";
import type useInvoiceDraft from "@/hooks/billingHooks/useInvoiceDraft";

type Draft = ReturnType<typeof useInvoiceDraft>;

/** Shared invoice metadata controls; target-specific recipient controls stay with the composer. */
export default function InvoiceDraftFields({
  draft, nameLabel = "Invoice Name *", numberLabel = "Invoice Number", namePlaceholder,
  requiredName = false, billingEmailLabel,
}: {
  draft: Pick<Draft, "invoiceName" | "setInvoiceName" | "invoiceNumber" | "setInvoiceNumber" | "invoiceDate" | "setInvoiceDate" | "dueDate" | "setDueDate" | "billingEmail" | "setBillingEmail">;
  nameLabel?: string;
  numberLabel?: string;
  namePlaceholder: string;
  requiredName?: boolean;
  billingEmailLabel?: ReactNode;
}) {
  const { invoiceName, setInvoiceName, invoiceNumber, setInvoiceNumber, invoiceDate, setInvoiceDate, dueDate, setDueDate, billingEmail, setBillingEmail } = draft;
  return <>
    <div>
      <FieldLabel tone="secondary">{nameLabel}</FieldLabel>
      <input type="text" value={invoiceName} onChange={e => setInvoiceName(e.target.value)} placeholder={namePlaceholder}
        className="w-full border border-input-border bg-input-bg text-on-surface rounded-md px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring" required={requiredName} />
    </div>
    <div>
      <FieldLabel tone="secondary">{numberLabel}</FieldLabel>
      <input type="text" value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} placeholder="e.g. INV-001"
        className="w-full border border-input-border bg-input-bg text-on-surface rounded-md px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring" />
    </div>
    <div><FieldLabel tone="secondary">Invoice Date *</FieldLabel><DatePicker value={invoiceDate} onChange={setInvoiceDate} className="w-full" /></div>
    <div><FieldLabel tone="secondary">Due Date</FieldLabel><DatePicker value={dueDate} onChange={setDueDate} className="w-full" /></div>
    <div>
      {billingEmailLabel || <FieldLabel tone="secondary">Billing Email</FieldLabel>}
      <input type="email" value={billingEmail} onChange={e => setBillingEmail(e.target.value)} placeholder="billing@lawfirm.com"
        className="w-full border border-input-border bg-input-bg text-on-surface rounded-md px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring" />
    </div>
  </>;
}
