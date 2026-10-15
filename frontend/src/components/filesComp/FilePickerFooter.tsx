"use client";

import Button from "@/components/ui/Button";

/**
 * Selection footer shared by the "browse files and select" modals
 * (`FilePickerModal`, `MessageFilePicker`). Each caller composes its own
 * count text and confirm label (pluralization, selection caps) and passes
 * the finished node through - this only owns the shared shell and buttons.
 */
export default function FilePickerFooter({
  countLabel,
  onCancel,
  onConfirm,
  confirmDisabled,
  confirmLabel,
  cancelDisabled = false,
}: {
  countLabel: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  confirmDisabled: boolean;
  confirmLabel: React.ReactNode;
  /** True while the picker has a request in flight that closing would abandon. */
  cancelDisabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-6 py-4 bg-surface-alt rounded-b-lg border-t border-outline shrink-0">
      <span className="text-xs text-on-surface-muted">{countLabel}</span>
      <div className="flex items-center gap-2">
        <Button type="secondary" onClick={onCancel} disabled={cancelDisabled}>Cancel</Button>
        <Button type="primary" onClick={onConfirm} disabled={confirmDisabled}>{confirmLabel}</Button>
      </div>
    </div>
  );
}
