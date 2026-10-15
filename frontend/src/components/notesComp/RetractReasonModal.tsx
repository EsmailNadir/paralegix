"use client";

import ConfirmModal from "@/components/ui/ConfirmModal";
import ReasonField from "@/components/ui/ReasonField";

interface RetractReasonModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  reason: string;
  onReasonChange: (value: string) => void;
  placeholder: string;
  loading?: boolean;
}

/** Confirm-with-optional-reason dialog for retracting a note or a reply. */
export default function RetractReasonModal({
  isOpen, onClose, onConfirm, title, message, reason, onReasonChange, placeholder, loading,
}: RetractReasonModalProps) {
  return (
    <ConfirmModal
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      title={title}
      message={message}
      confirmText="Retract"
      loading={loading}
      extra={(
        <div className="mt-3">
          <ReasonField
            value={reason}
            onChange={onReasonChange}
            placeholder={placeholder}
          />
        </div>
      )}
    />
  );
}
