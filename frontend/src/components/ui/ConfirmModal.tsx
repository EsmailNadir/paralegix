"use client";

import { useCallback, useEffect, useId, useRef } from 'react';
import Button from './Button';
import Modal from './Modal';
import ErrorNotification from '@/components/ErrorNotification';
import { useLastOpenValue } from "@/hooks/useMountTransition";

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmType?: "primary" | "secondary" | "danger" | "success";
  loading?: boolean;
  /** Optional content rendered between the message and the action buttons. */
  extra?: React.ReactNode;
  /**
   * Why the last confirm failed. Shown inside the dialog, because a page-level
   * banner sits behind the backdrop where the user cannot read it. Callers keep
   * the dialog open on failure and clear this when it next opens.
   */
  error?: string | Error | null;
  /**
   * Disables the confirm button, e.g. while required content in `extra` (a
   * reason field, a target picker) is empty or invalid. Omit to leave the
   * confirm button enabled, as every existing caller does.
   */
  confirmDisabled?: boolean;
  /** Render above another open dialog instead of beside it. */
  stacked?: boolean;
}

export default function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  confirmType = "danger",
  loading,
  extra,
  error,
  confirmDisabled,
  stacked,
}: ConfirmModalProps) {
  // Callers routinely clear the record being confirmed in the same handler that
  // closes this ("Delete task X" → setOpen(false); setTaskToDelete(null)), which
  // would empty the wording out mid-fade. Hold the last open values instead, so
  // it closes still reading the way it did.
  const shownTitle = useLastOpenValue(isOpen, title);
  const shownMessage = useLastOpenValue(isOpen, message);
  const shownExtra = useLastOpenValue(isOpen, extra);
  const shownError = useLastOpenValue(isOpen, error);
  // The buttons too. A confirm handler that sets a busy flag before its first
  // await relabels the button ("Remove" to "Removing...") in the same click that
  // closes the dialog, and a caller that closes as `loading` drops would stop
  // the spinner mid-fade. Both should leave looking as they did when clicked.
  const shownConfirmText = useLastOpenValue(isOpen, confirmText);
  const shownCancelText = useLastOpenValue(isOpen, cancelText);
  const shownConfirmType = useLastOpenValue(isOpen, confirmType);
  const shownLoading = useLastOpenValue(isOpen, loading);
  const shownConfirmDisabled = useLastOpenValue(isOpen, confirmDisabled);

  // Escape, the backdrop and the close button must not close the modal while a
  // confirm is in flight, so every close path goes through this guard. `Modal`
  // owns the focus trap, focus restore, and the Escape handling it is handed.
  const handleClose = useCallback(() => {
    if (loading) return;
    onClose();
  }, [loading, onClose]);

  const titleId = useId();
  const headerRef = useRef<HTMLDivElement | null>(null);

  // Override the dialog's default (first focusable) so the primary action keeps
  // initial focus: the last enabled button in the footer.
  useEffect(() => {
    if (!isOpen) return;
    if (typeof document === "undefined") return;
    const panel = headerRef.current?.closest('[role="dialog"]');
    const buttons = panel?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
    buttons?.[buttons.length - 1]?.focus();
  }, [isOpen]);

  const handleConfirm = () => {
    if (confirmDisabled) return;
    onConfirm();
    // If loading is managed externally, let the parent close the modal
    if (loading === undefined) onClose();
  };

  // The header, body and footer keep the confirm dialog's own markup (no rule
  // under the heading, no rule over the actions), so it renders as it always
  // has while `Modal` supplies the overlay, animation and focus handling.
  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      labelledBy={titleId}
      showClose={false}
      dismissible={!loading}
      stacked={stacked}
      lockScroll
      className="border border-outline"
      bodyClassName={null}
    >
      <div ref={headerRef} className="flex items-center justify-between px-6 py-4">
        <h2 id={titleId} className="text-lg font-semibold text-on-surface">{shownTitle}</h2>
        <button
          type="button"
          onClick={handleClose}
          disabled={!!shownLoading}
          className="text-on-surface-muted hover:text-on-surface-secondary focus:outline-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="px-6 py-5 min-w-0 space-y-3">
        <p className="text-sm text-on-surface-secondary break-words overflow-hidden line-clamp-4">
          {shownMessage}
        </p>
        {shownExtra}
        <ErrorNotification error={shownError ?? null} compact />
      </div>

      <div className="flex items-center justify-end gap-2 px-6 py-4 bg-surface-alt rounded-b-lg max-sm:rounded-b-none">
        <Button type="secondary" onClick={handleClose} disabled={!!shownLoading}>
          {shownCancelText}
        </Button>
        <Button type={shownConfirmType} onClick={handleConfirm} loading={shownLoading} disabled={shownConfirmDisabled}>
          {shownConfirmText}
        </Button>
      </div>
    </Modal>
  );
}
