"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import BusyToast from "@/components/ui/BusyToast";
import Toast from "@/components/ui/Toast";
import type { StatusVariant } from "@/constants/statusMeta";
import type { UploadResponse } from "@/services/files.service";

/**
 * The uploads running for this person, wherever they are in the firm.
 *
 * An upload is minutes long on a real document, and the dropzone that starts
 * one sits inside a tab: a matter's Documents, a client's Files, the files
 * page's upload panel. Held in the dropzone, switching tabs unmounted it and
 * the upload carried on with nothing on screen: no bar, no cancel, the file
 * list never told it had finished, and a dropzone that looked idle and invited
 * the same file again. Held here, beside `FileExportProvider` and for the same
 * reason, the upload outlives the tab and the dropzone picks it back up when
 * the person returns.
 *
 * While no dropzone for an upload is on screen, the pill says it is still
 * running and offers the cancel the dropzone would have. When it settles
 * unseen, a toast says how it went, because the dropzone that would have said
 * so is gone.
 */

/** Who hears how an upload ended. Swapped when a dropzone takes the upload over. */
export interface UploadListener {
  onDone: (response: UploadResponse) => void;
  onFailed: (error: unknown) => void;
  /** Every byte has landed and the server is filing it; a cancel no longer stops it. */
  onFinalizing: () => void;
}

export interface UploadJob {
  readonly files: File[];
  /** True once the upload is past the point a cancel can stop it. */
  readonly finalizing: boolean;
  cancel: () => void;
  /** Hand the outcome to a different listener, the dropzone now on screen. */
  listen: (listener: UploadListener) => void;
}

/** Runs the upload. The signal aborts on cancel; `onFinalizing` is the service's. */
export type UploadRun = (signal: AbortSignal, onFinalizing: () => void) => Promise<UploadResponse>;

type FileUploadContextValue = {
  /** Start an upload under `key`, one per key. */
  startUpload: (key: string, files: File[], run: UploadRun, listener: UploadListener) => UploadJob;
  /** The upload running under `key`, for a dropzone mounting mid-upload. */
  jobFor: (key: string) => UploadJob | null;
  /** Mark `key` as on screen. Returns the release. */
  show: (key: string) => () => void;
};

/** The upload ended because the user cancelled it, which is not a failure to report. */
export const isUploadCancel = (error: unknown) =>
  error instanceof Error && (error.name === "UploadCancelledError" || error.name === "AbortError");

type Outcome = { response?: UploadResponse; error?: unknown };

/**
 * One upload and its controller. The provider's hooks run before the listener,
 * so the job is already gone from the provider when the dropzone reacts.
 */
function createJob(
  files: File[],
  run: UploadRun,
  listener: UploadListener,
  hooks: { onFinalizing?: () => void; onSettled?: (outcome: Outcome) => void } = {},
): UploadJob {
  const controller = new AbortController();
  let current = listener;
  let finalizing = false;
  /**
   * How it ended, kept for a listener that arrives after. A dropzone mounting
   * mid-upload reads the job in render but listens in an effect; one that
   * settled in between had already reported to the dropzone that left, and the
   * new one showed "Uploading..." for good.
   */
  let settled: { ok: true; response: UploadResponse } | { ok: false; error: unknown } | null = null;
  /** Who has been told, so a listener that listens twice hears it once. */
  const told = new Set<UploadListener>();
  const tell = (target: UploadListener) => {
    if (!settled || told.has(target)) return;
    told.add(target);
    if (settled.ok) target.onDone(settled.response);
    else target.onFailed(settled.error);
  };
  const job: UploadJob = {
    files,
    get finalizing() { return finalizing; },
    cancel: () => controller.abort(),
    listen: (next) => {
      current = next;
      tell(next);
    },
  };
  run(controller.signal, () => {
    finalizing = true;
    hooks.onFinalizing?.();
    current.onFinalizing();
  }).then(
    (response) => {
      settled = { ok: true, response };
      hooks.onSettled?.({ response });
      tell(current);
    },
    (error: unknown) => {
      settled = { ok: false, error };
      hooks.onSettled?.({ error });
      tell(current);
    },
  );
  return job;
}

/**
 * Outside a provider the upload still runs and reports to the dropzone that
 * started it; there is just nowhere for it to outlive that dropzone.
 */
const FileUploadContext = createContext<FileUploadContextValue>({
  startUpload: (_key, files, run, listener) => createJob(files, run, listener),
  jobFor: () => null,
  show: () => () => {},
});

export function useFileUploads() {
  return useContext(FileUploadContext);
}

/** The key a dropzone files its upload under: its scope, and which surface it is. */
export function uploadJobKey(
  lawFirmId: string,
  ids: { matterId?: string; taskId?: string; clientId?: string },
  slot = "files",
): string {
  return [lawFirmId, ids.matterId ?? "", ids.taskId ?? "", ids.clientId ?? "", slot].join(":");
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function describeOutcome(outcome: Outcome) {
  const { response, error } = outcome;
  if (error !== undefined) {
    return {
      message: error instanceof Error && error.message ? error.message : "Upload failed",
      tone: "danger" as StatusVariant,
    };
  }
  const landed = response?.files.length ?? 0;
  const failed = response?.failures?.length ?? 0;
  if (failed > 0) {
    return {
      message: `${failed} of ${landed + failed} files could not be uploaded.`,
      tone: "warning" as StatusVariant,
    };
  }
  // What the server named, never what was picked: the service reports every
  // file that did not land as a failure, so a count taken from the selection
  // could only ever claim a file the server did not keep.
  const count = landed;
  return {
    message: `Uploaded ${count} file${count === 1 ? "" : "s"}`,
    tone: "success" as StatusVariant,
  };
}

export function FileUploadProvider({ children }: { children: React.ReactNode }) {
  // The refs are the truth, because an upload settles outside any render and
  // must see a dropzone that mounted a moment ago. The state copies exist only
  // to re-render the pill.
  const jobsRef = useRef<Record<string, UploadJob>>({});
  const shownRef = useRef<Record<string, number>>({});
  const [jobs, setJobs] = useState<Record<string, UploadJob>>({});
  const [shown, setShown] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<{ message: string; tone: StatusVariant } | null>(null);

  // Leaving the FIRM ends them, as it does an archive: a person who signed out
  // or switched firms is not coming back for these files.
  useEffect(() => () => {
    for (const job of Object.values(jobsRef.current)) job.cancel();
  }, []);

  const startUpload = useCallback<FileUploadContextValue["startUpload"]>((key, files, run, listener) => {
    const job = createJob(files, run, listener, {
      // Re-render so the pill drops a cancel that can no longer stop anything.
      onFinalizing: () => setJobs({ ...jobsRef.current }),
      onSettled: (outcome) => {
        if (jobsRef.current[key] === job) {
          jobsRef.current = without(jobsRef.current, key);
          setJobs(jobsRef.current);
        }
        if ((shownRef.current[key] ?? 0) > 0) return;
        if (outcome.error !== undefined && isUploadCancel(outcome.error)) return;
        setNotice(describeOutcome(outcome));
      },
    });
    jobsRef.current = { ...jobsRef.current, [key]: job };
    setJobs(jobsRef.current);
    return job;
  }, []);

  const jobFor = useCallback((key: string) => jobsRef.current[key] ?? null, []);

  const show = useCallback((key: string) => {
    shownRef.current = { ...shownRef.current, [key]: (shownRef.current[key] ?? 0) + 1 };
    setShown(shownRef.current);
    return () => {
      const left = (shownRef.current[key] ?? 0) - 1;
      shownRef.current = left > 0 ? { ...shownRef.current, [key]: left } : without(shownRef.current, key);
      setShown(shownRef.current);
    };
  }, []);

  const unseen = Object.entries(jobs).filter(([key]) => !shown[key]).map(([, job]) => job);
  const unseenFiles = unseen.reduce((sum, job) => sum + job.files.length, 0);
  const stoppable = unseen.filter((job) => !job.finalizing);
  const cancelUnseen = () => {
    for (const job of stoppable) job.cancel();
  };

  const value = useMemo(() => ({ startUpload, jobFor, show }), [startUpload, jobFor, show]);

  return (
    <FileUploadContext value={value}>
      {children}
      {unseen.length > 0 ? (
        <BusyToast
          message={`Uploading ${unseenFiles} file${unseenFiles === 1 ? "" : "s"}`}
          onCancel={stoppable.length > 0 ? cancelUnseen : undefined}
        />
      ) : notice ? (
        <Toast message={notice.message} tone={notice.tone} onDismiss={() => setNotice(null)} />
      ) : null}
    </FileUploadContext>
  );
}
