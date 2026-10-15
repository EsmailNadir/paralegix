'use client';

import { X } from 'lucide-react';
import Spinner from '@/components/ui/Spinner';

interface UploadProgressBarProps {
  /** What is happening, for the user. One general word covers the whole upload. */
  label?: string;
  /** Shows a cancel control beside the label when the upload can be stopped. */
  onCancel?: () => void;
  /** Extra classes for the block, for callers that need their own spacing. */
  className?: string;
}

/**
 * The bar every upload surface shows while it works: one label, one track.
 *
 * The track is indeterminate for the whole upload, deliberately. A percentage
 * here could only ever measure the bytes, and the bytes are not the wait: the
 * file is hashed before the first request, and the server verifies, converts
 * and records what landed after the last one. On a document of a few megabytes
 * those steps are most of the time, so a byte percentage ran to 99 in a moment
 * and then sat there, which reads as an upload that has frozen. One steady
 * indicator from start to finish says the same true thing throughout.
 *
 * Each upload panel used to hand-roll this bar, which is how they drifted into
 * showing different things for the same event.
 *
 * The sweep's movement comes from the `progress-sweep` class in global.css so
 * the reduced-motion media query there can replace it with a static bar.
 */
export default function UploadProgressBar({
  label = 'Uploading',
  onCancel,
  className = '',
}: UploadProgressBarProps) {
  return (
    <div className={`space-y-2 ${className}`.trim()}>
      <div className="flex items-center justify-between gap-3 text-sm text-on-surface-secondary">
        <span className="inline-flex min-w-0 items-center gap-2">
          <Spinner size={14} />
          <span className="truncate">{label}</span>
        </span>
        {onCancel && (
          <button
            type="button"
            aria-label="Cancel upload"
            onClick={(event) => {
              event.stopPropagation();
              onCancel();
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-on-surface-secondary transition-[background-color,transform] hover:bg-surface-hover hover:text-on-surface active:scale-95 cursor-pointer"
          >
            <X size={13} strokeWidth={2.4} />
            <span>Cancel</span>
          </button>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-alt"
      >
        <div className="progress-sweep h-full rounded-full bg-accent-solid" />
      </div>
    </div>
  );
}
