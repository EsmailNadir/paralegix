'use client';

import Toast from './Toast';

interface ErrorToastProps {
  message: string;
  onDismiss: () => void;
  /** Auto-dismiss delay in ms (default 5000) */
  duration?: number;
}

/** `<Toast>` fixed to the failure tone - the common case, kept under its own name. */
export default function ErrorToast({ message, onDismiss, duration = 5000 }: ErrorToastProps) {
  return <Toast message={message} onDismiss={onDismiss} tone="danger" duration={duration} />;
}
