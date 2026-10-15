import { RefreshCw } from 'lucide-react';
import Spinner from '@/components/ui/Spinner';
import { getErrorMessage, getFieldErrors } from '@/lib/utils/apiErrors';

interface ErrorNotificationProps {
  /** Accepts the plain string most callers pass today, or a thrown Error/ApiError
   *  for richer output (field-level validation messages). */
  error: string | Error | null;
  onClose?: () => void;
  className?: string;
  /**
   * Tighter padding and type, for banners that sit inside a dialog (typically the
   * footer, beside the submit button) rather than at the top of a page.
   */
  compact?: boolean;
  /**
   * Offer to run the failed request again, in the banner itself.
   *
   * Pass this wherever the error means "we could not load this" rather than "what
   * you submitted was wrong": a timeout or an unreachable server leaves a list
   * empty, and without an action here the only ways back are a browser refresh or
   * nudging a filter. Validation failures should NOT pass it - retrying the same
   * bad input just fails again.
   */
  onRetry?: () => void;
  /** Whether that retry is currently in flight. */
  retrying?: boolean;
}

export default function ErrorNotification({
  error,
  onClose,
  className = '',
  compact = false,
  onRetry,
  retrying = false
}: ErrorNotificationProps) {
  if (!error) return null;

  const message = getErrorMessage(error);
  // Skip field errors that just repeat the headline message.
  const fieldErrors = getFieldErrors(error).filter((m) => m !== message);

  return (
    <div
      className={`bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/50 rounded-lg flex items-start ${compact ? 'px-3 py-2.5' : 'p-4'} ${className}`}
      role="alert"
    >
      <div className="flex-shrink-0">
        <svg
          className={`text-red-400 dark:text-red-400 ${compact ? 'h-4 w-4 mt-0.5' : 'h-5 w-5'}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
            clipRule="evenodd"
          />
        </svg>
      </div>
      <div className={`flex-1 ${compact ? 'ml-2.5' : 'ml-3'}`}>
        <p className={`text-red-700 dark:text-red-300 ${compact ? 'text-xs leading-relaxed' : 'text-sm'}`}>{message}</p>
        {fieldErrors.length > 0 && (
          <ul className="mt-1.5 list-disc pl-4 space-y-0.5">
            {fieldErrors.map((msg) => (
              <li key={msg} className={`text-red-600 dark:text-red-300/90 ${compact ? 'text-xs' : 'text-sm'}`}>{msg}</li>
            ))}
          </ul>
        )}
      </div>
      {(onRetry || onClose) && (
      <div className={`ml-auto flex items-center flex-shrink-0 ${compact ? 'gap-0.5' : 'gap-1'}`}>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className={`bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 font-medium rounded-lg focus-visible:ring-2 focus-visible:ring-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${compact ? 'text-[11px] px-1.5 py-1' : 'text-xs px-2 py-1.5'}`}
        >
          {retrying ? <Spinner size={13} /> : <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />}
          {retrying ? 'Retrying' : 'Try again'}
        </button>
      )}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className={`bg-red-50 dark:bg-red-900/30 text-red-500 dark:text-red-400 rounded-lg focus-visible:ring-2 focus-visible:ring-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 inline-flex items-center justify-center cursor-pointer ${compact ? '-mr-1 -my-0.5 h-6 w-6 p-1' : '-mr-1.5 -my-1.5 h-8 w-8 p-1.5'}`}
          aria-label="Close"
        >
          <span className="sr-only">Dismiss</span>
          <svg
            className="w-4 h-4"
            fill="currentColor"
            viewBox="0 0 20 20"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      )}
      </div>
      )}
    </div>
  );
}
