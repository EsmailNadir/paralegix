'use client';

import Spinner from './Spinner';

/**
 * Fixed bottom-center pill showing that a background request is in flight.
 *
 * Use it for actions whose trigger disappears on click (a row action menu item,
 * a context menu entry) or that produce no immediate visual change, so there is
 * no button left on screen to put a `loading` spinner on. Downloads, server-built
 * zips and file exports are the usual cases. When the trigger stays mounted,
 * prefer `<Button loading>` instead so the feedback stays next to the click.
 *
 * Renders nothing when `message` is empty, so it can be dropped in unconditionally.
 *
 * Pass `onCancel` when the work is long enough that a person may change their
 * mind and stopping it is worth something: a server-built archive keeps running
 * and gets filed whether or not anyone still wants it. The action is the same
 * inline text button `<Toast>` uses for Dismiss, because it is the same pill in
 * the same place and a second style for one control would be drift.
 */
export default function BusyToast({
  message,
  onCancel,
  cancelLabel = 'Cancel',
}: {
  message?: string | null;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 bg-surface border border-outline text-on-surface px-4 py-2.5 rounded-lg shadow-xl text-sm"
    >
      <Spinner size={16} className="text-accent-emphasis" />
      {message}
      {onCancel && (
        // `pointer-events-auto` only here: the pill itself stays click-through,
        // which is why it can sit over a list without blocking a row.
        <button
          type="button"
          onClick={onCancel}
          className="pointer-events-auto ml-1 underline hover:no-underline cursor-pointer"
        >
          {cancelLabel}
        </button>
      )}
    </div>
  );
}
