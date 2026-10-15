"use client";

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";

interface Props {
  title: string;
  message: string;
  confirmText?: string;
  onConfirm: () => void | Promise<void>;
  stacked?: boolean;
  children: (requestConfirmation: () => void, busy: boolean) => ReactNode;
}

/** Confirms an action and keeps failures visible for retry without resubmitting a busy request. */
export default function ConfirmAction({ title, message, confirmText = "Remove", onConfirm, stacked, children }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (err) {
      setError(getErrorMessage(err, "Could not complete this action. Try again."));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      {children(() => { setError(null); setOpen(true); }, busy)}
      {typeof document !== "undefined" && createPortal(<ConfirmModal
        isOpen={open}
        onClose={() => { if (!inFlight.current) setOpen(false); }}
        onConfirm={() => { void confirm(); }}
        title={title}
        message={message}
        confirmText={confirmText}
        loading={busy}
        stacked={stacked}
        extra={<ErrorNotification error={error} onClose={() => setError(null)} />}
      />, document.body)}
    </>
  );
}
