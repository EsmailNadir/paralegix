"use client";

import { useId } from "react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import DatePicker from "@/components/ui/DatePicker";
import ErrorNotification from "@/components/ErrorNotification";
import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";

export interface EditingPayment {
  index: number;
  date: string;
  amount: string;
  invoiceNumber: string;
  note: string;
}

interface Props {
  open: boolean;
  payment: EditingPayment | null;
  /** A Stripe-collected payment's amount is owned by Stripe, so it is read-only here. */
  amountLocked: boolean;
  saving: boolean;
  error: string | Error | null;
  onClearError: () => void;
  onChange: (next: EditingPayment) => void;
  onClose: () => void;
  onSave: () => void;
}

const LABEL_CLS = "block text-sm font-medium text-on-surface mb-1";

/**
 * Edit a recorded payment's date, amount, invoice number and note.
 *
 * Recording a payment has always been a modal (RecordPaymentModal); editing one
 * used to be an inline row inside the payments table, which left four fields
 * sharing five narrow columns with no labels of their own - the note truncated
 * mid-word, and which field was which depended on a header that scrolls away.
 */
export default function EditPaymentModal({
  open,
  payment,
  amountLocked,
  saving,
  error,
  onClearError,
  onChange,
  onClose,
  onSave,
}: Props) {
  const titleId = useId();

  return (
    <Modal
      isOpen={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      labelledBy={titleId}
      size="md"
      showClose={false}
      dismissible={!saving}
      lockScroll
      bodyClassName={null}
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="primary"
            loading={saving}
            onClick={onSave}
            disabled={saving || !payment?.date?.trim() || !payment?.amount?.trim()}
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="px-6 py-4 border-b border-outline">
        <h2 id={titleId} className="text-base font-semibold text-on-surface">
          Edit payment
        </h2>
      </div>

      <div className="px-6 py-5 overflow-y-auto styled-scrollbar space-y-4">
        <ErrorNotification error={error} onClose={onClearError} compact />

        <div>
          <label className={LABEL_CLS}>
            Payment date *
          </label>
          <DatePicker
            value={payment?.date ?? ""}
            onChange={(value) => payment && onChange({ ...payment, date: value })}
            aria-label="Payment date"
          />
        </div>

        <div>
          <label className={LABEL_CLS} htmlFor="edit-payment-amount">
            Payment amount *
          </label>
          <input
            id="edit-payment-amount"
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            disabled={amountLocked}
            className={`${FULL_INPUT_CLS} text-right tabular-nums ${
              amountLocked ? "opacity-50 cursor-not-allowed" : ""
            }`}
            value={payment?.amount ?? ""}
            onChange={(e) => payment && onChange({ ...payment, amount: e.target.value })}
          />
          {amountLocked && (
            <p className="mt-1 text-xs text-on-surface-muted">
              Stripe owns the amount on a card payment, so it cannot be changed here.
            </p>
          )}
        </div>

        <div>
          <label className={LABEL_CLS} htmlFor="edit-payment-invoice-number">
            Invoice #
          </label>
          <input
            id="edit-payment-invoice-number"
            type="text"
            placeholder="e.g. INV-001"
            className={FULL_INPUT_CLS}
            value={payment?.invoiceNumber ?? ""}
            onChange={(e) => payment && onChange({ ...payment, invoiceNumber: e.target.value })}
          />
        </div>

        <div>
          <label className={LABEL_CLS} htmlFor="edit-payment-note">
            Note
          </label>
          <input
            id="edit-payment-note"
            type="text"
            placeholder="e.g. Check #1234, Wire transfer, etc."
            className={FULL_INPUT_CLS}
            value={payment?.note ?? ""}
            onChange={(e) => payment && onChange({ ...payment, note: e.target.value })}
          />
        </div>
      </div>
    </Modal>
  );
}
