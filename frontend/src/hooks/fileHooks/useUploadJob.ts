"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  isUploadCancel,
  useFileUploads,
  type UploadJob,
  type UploadListener,
  type UploadRun,
} from "@/contexts/FileUploadContext";
import type { UploadResponse } from "@/services/files.service";

/**
 * One surface's upload, held in `FileUploadProvider` so it outlives the surface.
 *
 * Every place that uploads into a matter, task or client uses this: the file
 * manager's dropzone, the overview quick-adds, the file picker and the note
 * composer. They used to each hold their upload in local state, so each lost it
 * on a tab switch in its own way, and each told the user something different
 * about the same event. The lifecycle lives here once; each surface decides only
 * what to upload and what to do when it lands.
 *
 * `jobKey` must be stable for the life of the surface, and unique to what its
 * completion does: a surface mounting mid-upload takes over the upload running
 * under its key, including the `onDone` it will run.
 */
export function useUploadJob({
  jobKey,
  onDone,
  onFailed,
  onCancelled,
  visible = true,
}: {
  jobKey: string;
  /** The upload landed, possibly with `failures` for the files that did not. */
  onDone: (response: UploadResponse) => void;
  /** Nothing landed. Not called for a cancel, which the user asked for. */
  onFailed?: (message: string) => void;
  /** The user cancelled it. Nothing to report, but a surface may have state to release. */
  onCancelled?: () => void;
  /**
   * Whether this surface is showing the upload. While it is, the provider's
   * floating pill stands down. A modal that stays mounted while closed passes
   * its open state, so a closed picker hands the upload to the pill.
   */
  visible?: boolean;
}) {
  const uploads = useFileUploads();
  // An upload started here before the surface unmounted is still running in
  // the provider; mounting again picks it up where it is.
  const [job, setJob] = useState<UploadJob | null>(() => uploads.jobFor(jobKey));
  const [finalizing, setFinalizing] = useState(() => job?.finalizing ?? false);

  // The upload can settle after this surface has re-rendered or unmounted, so
  // it reports through the handlers of the latest render.
  const handlers = useRef({ onDone, onFailed, onCancelled });
  handlers.current = { onDone, onFailed, onCancelled };

  const listener = useMemo<UploadListener>(() => ({
    onFinalizing: () => setFinalizing(true),
    onDone: (response) => {
      setJob(null);
      setFinalizing(false);
      handlers.current.onDone(response);
    },
    onFailed: (error) => {
      setJob(null);
      setFinalizing(false);
      if (isUploadCancel(error)) {
        handlers.current.onCancelled?.();
        return;
      }
      handlers.current.onFailed?.(error instanceof Error && error.message ? error.message : "Upload failed");
    },
  }), []);

  useEffect(() => (visible ? uploads.show(jobKey) : undefined), [uploads, jobKey, visible]);
  useEffect(() => { job?.listen(listener); }, [job, listener]);

  /** Start uploading `files`. Ignored while an upload is already running here. */
  const start = (files: File[], run: UploadRun) => {
    if (job || files.length === 0) return;
    setFinalizing(false);
    setJob(uploads.startUpload(jobKey, files, run, listener));
  };

  return {
    /** The running upload, or null. `job.files` is what it is uploading. */
    job,
    uploading: job !== null,
    /** Past the point a cancel can stop it; hide the cancel. */
    finalizing,
    start,
    cancel: () => job?.cancel(),
  };
}
