interface SuccessNotificationProps {
  /** The message. Renders nothing when null/empty, so drop it in unconditionally. */
  message: string | null;
  onClose?: () => void;
  className?: string;
  /** Tighter padding and type, for banners inside a dialog rather than on a page. */
  compact?: boolean;
}

/**
 * The confirmation banner that answers "did that save?" - the counterpart to
 * `ErrorNotification`, and deliberately the same shape so the two read as one pair
 * rather than two unrelated boxes.
 *
 * It exists because the same green div was hand-rolled on six settings surfaces,
 * each with its own shade (`green-700`, `green-800`, `emerald-700`) and none with a
 * dark-mode variant, so a saved change reported itself in near-black text on a
 * near-white strip in dark mode.
 */
export default function SuccessNotification({
  message,
  onClose,
  className = '',
  compact = false,
}: SuccessNotificationProps) {
  if (!message) return null;

  return (
    <div
      className={`bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700/50 rounded-lg flex items-start ${compact ? 'px-3 py-2.5' : 'p-4'} ${className}`}
      role="status"
    >
      <div className="flex-shrink-0">
        <svg
          className={`text-emerald-500 dark:text-emerald-400 ${compact ? 'h-4 w-4 mt-0.5' : 'h-5 w-5'}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
            clipRule="evenodd"
          />
        </svg>
      </div>
      <div className={`flex-1 ${compact ? 'ml-2.5' : 'ml-3'}`}>
        <p className={`text-emerald-700 dark:text-emerald-300 ${compact ? 'text-xs leading-relaxed' : 'text-sm'}`}>
          {message}
        </p>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className={`ml-auto bg-emerald-50 dark:bg-emerald-900/30 text-emerald-500 dark:text-emerald-400 rounded-lg focus-visible:ring-2 focus-visible:ring-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 inline-flex items-center justify-center cursor-pointer ${compact ? '-mr-1 -my-0.5 h-6 w-6 p-1' : '-mx-1.5 -my-1.5 h-8 w-8 p-1.5'}`}
          aria-label="Close"
        >
          <span className="sr-only">Dismiss</span>
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
