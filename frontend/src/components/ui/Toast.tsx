'use client';

import { useEffect, useRef } from 'react';
import { STATUS_VARIANTS, type StatusVariant } from '@/constants/statusMeta';

export interface ToastProps {
  message: string;
  onDismiss: () => void;
  /** What the message *is*: a failure, a confirmation, something to watch. */
  tone?: StatusVariant;
  /** Auto-dismiss delay in ms (default 5000) */
  duration?: number;
}

/**
 * Fixed bottom-centre notice for something that has already happened and has no
 * button left on screen to report against - an upload that finished, a delete
 * that failed.
 *
 * For work still in flight use `<BusyToast>`; for a message that belongs next to
 * the field that caused it use `<FieldError>`.
 */
export default function Toast({ message, onDismiss, tone = 'danger', duration = 5000 }: ToastProps) {
  // Track the latest onDismiss in a ref so callers can pass inline arrows
  // without resetting the auto-dismiss timer on every parent re-render.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    const timer = setTimeout(() => onDismissRef.current(), duration);
    return () => clearTimeout(timer);
  }, [message, duration]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 ${STATUS_VARIANTS[tone].solid} text-white px-5 py-3 rounded-lg shadow-xl text-sm max-w-md text-center`}
    >
      {message}
      <button
        onClick={onDismiss}
        className="ml-3 underline hover:no-underline cursor-pointer"
      >
        Dismiss
      </button>
    </div>
  );
}
