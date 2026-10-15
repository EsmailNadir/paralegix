"use client";

import UploadProgressBar from "@/components/ui/UploadProgressBar";

/**
 * What every upload surface shows while its upload runs, and what it shows for
 * the files that did not land. Shared so the file manager, the quick-adds, the
 * file picker and the note composer say the same thing about the same event.
 */

/** The bar, its cancel while a cancel can still stop anything, and the leave-safe note. */
export function UploadInProgress({
  finalizing,
  onCancel,
}: {
  /** Past the point a cancel stops anything: the server files what landed regardless. */
  finalizing: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-1.5">
      {/* Once the bytes have landed the server files them whatever a cancel
          says, so the control goes rather than doing nothing. */}
      <UploadProgressBar onCancel={finalizing ? undefined : onCancel} />
      {/* The upload is held above the page, so leaving it is safe, but it runs
          in this browser tab and stops if the tab closes. */}
      <p className="text-xs text-on-surface-muted">
        You can keep using Paralegix while this uploads. Closing the Paralegix tab or your browser will stop it.
      </p>
    </div>
  );
}

/** The files that did not land, each with its reason. Renders nothing when there are none. */
export function UploadFailures({
  failures,
  summary,
}: {
  failures: Array<{ name: string; error: string }>;
  /** Replaces the default headline, for a surface that did something with what landed. */
  summary?: string;
}) {
  if (failures.length === 0) return null;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-700/50 dark:bg-red-900/20" role="alert">
      <p className="text-sm font-medium text-red-700 dark:text-red-300">
        {summary ?? `${failures.length} file${failures.length === 1 ? '' : 's'} could not be uploaded.`}
      </p>
      <ul className="mt-1.5 space-y-0.5 text-xs text-red-600 dark:text-red-300/90">
        {failures.map((failure, index) => (
          <li key={`${failure.name}-${index}`}>{failure.name}: {failure.error}</li>
        ))}
      </ul>
    </div>
  );
}
