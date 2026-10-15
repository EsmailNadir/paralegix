"use client";

import { useId } from "react";
import type { ReactNode } from "react";
import dayjs from "dayjs";
import { AlertTriangle } from "lucide-react";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import DatePicker from "@/components/ui/DatePicker";
import Dropdown from "@/components/ui/Dropdown";
import Modal from "@/components/ui/Modal";
import ErrorNotification from "@/components/ErrorNotification";
import { useLastOpenValue } from "@/hooks/useMountTransition";
import { formatCurrency } from "@/components/billingComp/utils";
import { INPUT_CLS } from "@/components/ui/inputClasses";
import FieldLabel from "@/components/ui/FieldLabel";
import FieldError from "@/components/ui/FieldError";

interface RecordPaymentModalProps {
  open: boolean;
  onClose: () => void;
  /** Invoice name shown in the subheading. */
  invoiceLabel: string;
  totalAmount: number;
  amountPaid: number;
  remainingBalance: number;

  amount: string;
  onAmountChange: (value: string) => void;
  allowOverpayment: boolean;
  onAllowOverpaymentChange: (value: boolean) => void;
  note: string;
  onNoteChange: (value: string) => void;

  /** Pass both to show the optional invoice-number field. */
  invoiceNumber?: string;
  onInvoiceNumberChange?: (value: string) => void;
  /** Pass both to show the optional next-payment-due-date field. */
  nextPaymentDate?: string;
  onNextPaymentDateChange?: (value: string) => void;

  /**
   * Unpaid installments this payment can be applied to. When present the modal
   * offers an "Apply to" picker, so a plan payment can be recorded here instead
   * of only from the schedule's per-row Record button. Selecting one prefills
   * the amount with that installment's amount.
   */
  installments?: { index: number; dueDate: string; amount: number }[];
  selectedInstallmentIndex?: number | null;
  onSelectedInstallmentChange?: (index: number | null) => void;

  /** Extra fields rendered above the due-date field (e.g. the trust-account block). */
  extraFields?: ReactNode;
  /** Render above another open dialog (e.g. an invoice detail modal) instead of beside it. */
  stacked?: boolean;
  error?: string | null;
  /** A problem with the typed amount, shown under the amount field. */
  amountError?: string | null;

  submitting: boolean;
  onSubmit: () => void;
}

/**
 * The Record Payment dialog, shared by the invoice detail view and the client
 * billing tab. Presentational: validation and the service call stay at the call
 * site, which owns the payment context.
 */
export default function RecordPaymentModal(props: RecordPaymentModalProps) {
  const { open, onClose } = props;
  // Callers clear the note, the invoice number and the trust block, and drop
  // `submitting`, in the same update that closes this. Render the props it had
  // while open so it fades out showing what the user last saw.
  const {
    invoiceLabel,
    totalAmount,
    amountPaid,
    remainingBalance,
    amount,
    onAmountChange,
    allowOverpayment,
    onAllowOverpaymentChange,
    note,
    onNoteChange,
    invoiceNumber,
    onInvoiceNumberChange,
    nextPaymentDate,
    onNextPaymentDateChange,
    installments,
    selectedInstallmentIndex,
    onSelectedInstallmentChange,
    extraFields,
    stacked,
    error,
    amountError,
    submitting,
    onSubmit,
  } = useLastOpenValue(open, props);
  const fieldIds = useId();
  // Saving closes the dialog itself on success. Dismissing it first would drop a
  // failure the caller is about to report, so close waits for the save, the same
  // rule EditPaymentModal follows.
  const handleClose = () => {
    if (!props.submitting) onClose();
  };

  const parsedAmount = parseFloat(amount);
  const isOverpayment = !isNaN(parsedAmount) && parsedAmount > remainingBalance && remainingBalance > 0;

  return (
    <Modal
      isOpen={open}
      onClose={handleClose}
      dismissible={!props.submitting}
      stacked={stacked}
      title="Record Payment"
      subtitle={
        <>
          Invoice: {invoiceLabel} · Total: {formatCurrency(totalAmount)}
          {amountPaid > 0 && <> · Paid: {formatCurrency(amountPaid)}</>}
          {remainingBalance > 0 && <> · Remaining: {formatCurrency(remainingBalance)}</>}
        </>
      }
      showClose={false}
      size="md"
      footer={
        <>
          <Button onClick={handleClose} type="secondary" disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            type="primary"
            disabled={submitting || !amount || isNaN(parsedAmount) || parsedAmount <= 0}
          >
            {submitting ? "Saving..." : "Record Payment"}
          </Button>
        </>
      }
    >
      <ErrorNotification error={error ?? null} compact />

      {installments && installments.length > 0 && onSelectedInstallmentChange && (
        <div>
          <FieldLabel id={`${fieldIds}-apply-to-label`}>Apply to</FieldLabel>
          <Dropdown
            ariaLabelledBy={`${fieldIds}-apply-to-label`}
            value={selectedInstallmentIndex == null ? "" : String(selectedInstallmentIndex)}
            onChange={(value) => {
              if (!value) {
                onSelectedInstallmentChange(null);
                return;
              }
              const index = Number(value);
              onSelectedInstallmentChange(index);
              const picked = installments.find((i) => i.index === index);
              if (picked) onAmountChange(picked.amount.toFixed(2));
            }}
            options={[
              { value: "", label: "Invoice balance (no installment)" },
              ...installments.map((installment, position) => ({
                value: String(installment.index),
                label: `Installment ${position + 1} · due ${dayjs(installment.dueDate).format("MMM D, YYYY")} · ${formatCurrency(installment.amount)}`,
              })),
            ]}
            buttonClassName="w-full border-input-border bg-input-bg"
            portal
          />
          <p className="mt-1 text-xs text-on-surface-muted">
            Linking marks that installment paid on the payment schedule.
          </p>
        </div>
      )}

      <div>
        <FieldLabel htmlFor={`${fieldIds}-amount`}>Payment Amount *</FieldLabel>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted">$</span>
          <input
            id={`${fieldIds}-amount`}
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => {
              onAmountChange(e.target.value);
              onAllowOverpaymentChange(false);
            }}
            className={`${INPUT_CLS} w-full pl-7`}
            placeholder="0.00"
            autoFocus
          />
        </div>
        <FieldError message={amountError} />
        {isOverpayment && (
          <div className="mt-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-amber-800 dark:text-amber-300">
                <p className="font-medium">
                  Overpayment of {formatCurrency(parsedAmount - remainingBalance)}
                </p>
                <p className="mt-1">
                  This amount exceeds the remaining balance of {formatCurrency(remainingBalance)}.
                </p>
                <Checkbox
                  checked={allowOverpayment}
                  onChange={onAllowOverpaymentChange}
                  label="Allow overpayment"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {onInvoiceNumberChange && (
        <div>
          <FieldLabel htmlFor={`${fieldIds}-invoice-number`}>
            Invoice Number
          </FieldLabel>
          <input
            id={`${fieldIds}-invoice-number`}
            type="text"
            value={invoiceNumber ?? ""}
            onChange={(e) => onInvoiceNumberChange(e.target.value)}
            className={INPUT_CLS}
            placeholder="e.g. INV-001"
          />
        </div>
      )}

      <div>
        <FieldLabel htmlFor={`${fieldIds}-note`}>
          Note
        </FieldLabel>
        <input
          id={`${fieldIds}-note`}
          type="text"
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          className={INPUT_CLS}
          placeholder="e.g. Check #1234, Wire transfer, etc."
        />
      </div>

      {extraFields}

      {onNextPaymentDateChange && (
        <div>
          <FieldLabel id={`${fieldIds}-next-payment-due-date-label`}>
            Next Payment Due Date
          </FieldLabel>
          <DatePicker
            ariaLabelledBy={`${fieldIds}-next-payment-due-date-label`}
            value={nextPaymentDate ?? ""}
            onChange={onNextPaymentDateChange}
            className="w-full"
          />
        </div>
      )}
    </Modal>
  );
}
