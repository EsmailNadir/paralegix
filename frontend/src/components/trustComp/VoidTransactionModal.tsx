"use client";

import { useState } from "react";
import ConfirmModal from "@/components/ui/ConfirmModal";
import trustService from "@/services/trust.service";
import type { TrustTransaction } from "@/types/trust";
import { formatCents } from "@/lib/utils/currency";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import ReasonField from "@/components/ui/ReasonField";
import { TRUST_TRANSACTION_TYPES } from "./trustTransactionTypes";

interface VoidTransactionModalProps {
  open: boolean;
  lawFirmId: string;
  transaction: TrustTransaction | null;
  onClose: () => void;
  onVoided: () => void;
}

export default function VoidTransactionModal({ open, lawFirmId, transaction, onClose, onVoided }: VoidTransactionModalProps) {
  const [voidReason, setVoidReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One instance serves every row of the transaction list, so the reason is
  // cleared with the error: a reason typed for one transaction must never be
  // the one recorded against the next.
  useResetAfterClose(open, () => {
    setVoidReason("");
    setError(null);
  });

  const handleVoid = async () => {
    if (!transaction || !voidReason.trim()) return;

    setError(null);
    setSaving(true);
    try {
      await trustService.voidTransaction(lawFirmId, transaction.id, {
        voidReason: voidReason.trim(),
      });
      onVoided();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to void transaction"));
    } finally {
      setSaving(false);
    }
  };

  if (!transaction) return null;

  return (
    <ConfirmModal
      isOpen={open}
      onClose={onClose}
      onConfirm={() => void handleVoid()}
      title="Void Transaction"
      message="This action cannot be undone. The transaction will be marked as void and its balance effect reversed."
      confirmText={saving ? "Voiding..." : "Void Transaction"}
      loading={saving}
      confirmDisabled={!voidReason.trim()}
      extra={
        <div className="space-y-4">
          <ErrorNotification error={error} compact />

          <div className="bg-surface-alt rounded-lg p-3 space-y-1">
            <p className="text-xs text-on-surface-muted">Transaction Details</p>
            <p className="text-sm font-medium text-on-surface">
              {TRUST_TRANSACTION_TYPES[transaction.type]?.label ?? transaction.type}: {formatCents(transaction.amountCents)}
            </p>
            <p className="text-xs text-on-surface-secondary">
              Client: {transaction.clientName} | {formatDateOnly(transaction.date, undefined, "N/A")}
            </p>
          </div>
          <div>
            <ReasonField
              label="Reason for Voiding *"
              labelSize="xs"
              labelTone="secondary"
              value={voidReason}
              onChange={setVoidReason}
              placeholder="Explain why this transaction is being voided..."
              rows={3}
              className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 resize-none"
            />
          </div>
        </div>
      }
    />
  );
}
