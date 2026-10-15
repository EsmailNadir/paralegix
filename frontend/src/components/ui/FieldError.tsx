interface FieldErrorProps {
  /** Message to show; renders nothing when empty, so callers can pass state directly. */
  message?: string | null;
  className?: string;
}

/**
 * Validation message for a single form control, rendered directly beneath it.
 *
 * Use this for errors that belong to one field (a name that is already taken, a
 * malformed amount). Errors about the form as a whole, including failed saves,
 * belong in an `ErrorNotification` next to the submit button instead.
 */
export default function FieldError({ message, className = '' }: FieldErrorProps) {
  if (!message) return null;

  return (
    <p
      role="alert"
      className={`mt-1.5 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400 ${className}`}
    >
      <svg
        className="h-3.5 w-3.5 shrink-0 mt-px"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-4a1 1 0 011 1v3a1 1 0 11-2 0V7a1 1 0 011-1zm0 8a1 1 0 100-2 1 1 0 000 2z"
          clipRule="evenodd"
        />
      </svg>
      <span>{message}</span>
    </p>
  );
}
