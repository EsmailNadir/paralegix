"use client";

import type { ComponentProps } from "react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import ErrorNotification from "@/components/ErrorNotification";
import CreditNoteFields from "./CreditNoteFields";

type Props = ComponentProps<typeof CreditNoteFields> & {
  open: boolean;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
  invoiceName: string;
  remaining: string;
  presentation: "detail" | "client";
  titleId?: string;
  /** A refused save, drawn inside the dialog because the page banner sits under its backdrop. */
  error?: string | null;
};

/** Both invoice surfaces share the form and block dismissal while saving; only their spacing differs. */
export default function CreditNoteModal({ open, onClose, onSave, saving, invoiceName, remaining,
  presentation, titleId, error, ...fields }: Props) {
  const client = presentation === "client";
  const subtitle = <>Invoice: {invoiceName}, Remaining: {remaining}</>;
  const footer = <>
    <Button onClick={onClose} type="secondary" size="small" disabled={saving}>Cancel</Button>
    <Button onClick={onSave} type="primary" size="small" disabled={saving || !(parseFloat(fields.amount) > 0)}>
      {saving ? "Adding..." : "Add Credit Note"}
    </Button>
  </>;
  return <Modal isOpen={open} onClose={onClose} size="md" showClose={false}
    dismissible={!saving} labelledBy={client ? undefined : titleId}
    title={client ? "Add Credit Note" : undefined} subtitle={client ? subtitle : undefined}
    bodyClassName={client ? undefined : null} className={client ? undefined : "rounded-xl border border-outline"}
    footer={client ? footer : undefined}>
    {client ? <><ErrorNotification error={error ?? null} compact /><CreditNoteFields {...fields} /></> : <>
      <div className="p-6">
        <h2 id={titleId} className="text-lg font-semibold text-on-surface mb-1">Add Credit Note</h2>
        <p className="text-sm text-on-surface-secondary mb-6">{subtitle}</p>
        <div className="space-y-4"><ErrorNotification error={error ?? null} compact /><CreditNoteFields {...fields} /></div>
      </div>
      <div className="border-t border-outline px-6 py-4 flex justify-end gap-3">{footer}</div>
    </>}
  </Modal>;
}
