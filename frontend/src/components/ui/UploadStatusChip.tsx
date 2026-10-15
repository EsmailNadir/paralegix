'use client';

import { X } from 'lucide-react';
import Spinner from '@/components/ui/Spinner';

interface UploadStatusChipProps {
  /** What is happening, for the user. One general word covers the whole upload. */
  label?: string;
  /** Shown when the upload can be stopped. */
  onCancel?: () => void;
}

/**
 * The busy state of a drop panel: what is happening, a cancel, and a thin track
 * under both.
 *
 * The signing page and the templates page have the same drop panel, so they had
 * the same busy chip twice. One copy means the wording and the bar behaviour
 * cannot drift apart again.
 *
 * The track is indeterminate throughout, for the reason spelled out in
 * `UploadProgressBar`: a byte percentage measures only the transfer, which on a
 * normal document is over long before the upload is, so the number ran to 99
 * and stopped while the server was still working.
 *
 * The chip sits inside a panel that is itself a button, so the cancel control
 * stops both the click and the key event rather than opening a file picker
 * behind the cancel the user just asked for.
 */
export default function UploadStatusChip({ label = 'Uploading', onCancel }: UploadStatusChipProps) {
  return (
    <div className="inline-flex flex-col gap-1.5 rounded-xl bg-accent-solid px-4 py-2 text-sm font-medium text-accent-foreground shadow-sm dark:shadow-none">
      <div className="inline-flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 font-semibold">
          <Spinner size={16} />
          <span>{label}</span>
        </span>
        {onCancel && (
          <button
            type="button"
            aria-label="Cancel upload"
            onClick={(event) => {
              event.stopPropagation();
              onCancel();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
            }}
            className="relative z-10 inline-flex items-center gap-1 rounded-lg bg-accent-foreground/15 px-2.5 py-1 text-xs font-semibold text-accent-foreground transition-[background-color,transform] hover:bg-accent-foreground/25 active:scale-95 cursor-pointer"
          >
            <X size={13} strokeWidth={2.4} />
            <span>Cancel</span>
          </button>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        className="h-1 w-full overflow-hidden rounded-full bg-accent-foreground/25"
      >
        <div className="progress-sweep h-full rounded-full bg-accent-foreground" />
      </div>
    </div>
  );
}
