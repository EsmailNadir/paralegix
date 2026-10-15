"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import BusyToast from "@/components/ui/BusyToast";

/**
 * The one archive being built for this person, wherever they are in the app.
 *
 * A folder or multi-file download is not a request, it is a JOB: the server
 * walks the subtree, streams entries into one object, and the browser waits and
 * then follows a link. That takes minutes on a real matter, which is long
 * enough that the person will do something else in the meantime.
 *
 * So the wait cannot live in the file browser. Held there, opening a matter
 * unmounted it and the archive was abandoned: either cancelled, or finished and
 * filed for somebody who had gone. Held here, beside the running billing timer
 * and for the same reason, it survives every move inside the firm.
 *
 * ONE at a time is deliberate, not a limitation. Browsers honour only the first
 * of several programmatic downloads fired together, so a second archive landing
 * beside the first would be a file the person never receives. Starting one while
 * another runs replaces it, which is what a person who has changed their mind
 * about which folder they wanted actually means.
 */
type FileExportContextValue = {
  /** What the pill says, or null when nothing is being built. */
  exportingLabel: string | null;
  /**
   * Build an archive and wait for it, reporting progress in the global pill.
   *
   * `run` is handed a signal that aborts on cancel, which is what reaches the
   * worker: the service cancels the JOB rather than only dropping the wait.
   */
  runExport: (label: string, run: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  /** Stop the archive being built. Safe to call when nothing is in flight. */
  cancelExport: () => void;
};

const FileExportContext = createContext<FileExportContextValue>({
  exportingLabel: null,
  runExport: async (_label, run) => { await run(new AbortController().signal); },
  cancelExport: () => {},
});

export function useFileExport() {
  return useContext(FileExportContext);
}

export function FileExportProvider({ children }: { children: React.ReactNode }) {
  const [exportingLabel, setExportingLabel] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const cancelExport = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setExportingLabel(null);
  }, []);

  // Leaving the FIRM ends it. Everything inside a firm keeps it running, but a
  // person who has signed out or switched firms is not coming back for this
  // archive, and the job would otherwise be built and filed against a firm they
  // are no longer looking at.
  useEffect(() => () => { controller.current?.abort(); }, []);

  const runExport = useCallback(async (
    label: string,
    run: (signal: AbortSignal) => Promise<void>,
  ) => {
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    setExportingLabel(label);
    try {
      await run(own.signal);
    } finally {
      // Only clear what is still OURS. A second export started while this one
      // was finishing already owns the pill, and clearing it here would leave
      // that one running with nothing on screen and no way to stop it.
      if (controller.current === own) {
        controller.current = null;
        setExportingLabel(null);
      }
    }
  }, []);

  const value = useMemo(
    () => ({ exportingLabel, runExport, cancelExport }),
    [exportingLabel, runExport, cancelExport],
  );

  return (
    <FileExportContext value={value}>
      {children}
      <BusyToast message={exportingLabel} onCancel={cancelExport} />
    </FileExportContext>
  );
}
