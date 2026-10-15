"use client";

import { useCallback, useState } from "react";
import FilesService, { type FileInfo } from "@/services/files.service";
import type { FileScope } from "@/lib/files/fileScope";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { useFileExport } from "@/contexts/FileExportContext";

export interface FileActions {
  /**
   * Message for the single-file download pill, or null.
   *
   * An ARCHIVE reports through `FileExportProvider` instead, which is what
   * keeps it on screen after the file browser is gone.
   */
  downloadingLabel: string | null;
  /** True while a move is being applied. */
  moving: boolean;
  /** True while a delete is being applied. */
  deleting: boolean;

  /** Download one row: a file directly, a folder as a zip. */
  download: (file: FileInfo) => Promise<void>;
  /** Download a selection: one plain file directly, anything else as one zip. */
  downloadMany: (items: FileInfo[]) => Promise<void>;
  /**
   * Stop an archive being built for a download nobody wants any more.
   *
   * Abandoning the wait alone would leave the worker building an archive that
   * charges the firm for storage nobody will fetch, so this cancels the job as
   * well. Safe to call when nothing is in flight. The pill's own Cancel calls
   * the same thing.
   */
  cancelDownload: () => void;
  /** Delete one row (a folder takes everything under it). */
  remove: (item: FileInfo) => Promise<void>;
  /** Delete several rows, stopping at the first failure. */
  removeMany: (items: FileInfo[]) => Promise<void>;
  rename: (item: FileInfo, newName: string) => Promise<void>;
  createFolder: (folderName: string, folderColor?: string) => Promise<void>;
  setFolderColor: (folder: FileInfo, folderColor: string) => Promise<void>;
  /**
   * Move rows into a folder, or to the scope root when given no folder. A
   * refusal rejects with the same message it reports through `onError`.
   */
  move: (items: FileInfo[], destinationFolderId: string | null) => Promise<void>;
}

/**
 * The mutations a file browser can perform.
 *
 * Every one of these takes the row's id. They used to take a path built from the
 * open folder and the row's name, which meant a whole module of rules about how
 * to address a row: a search hit had to be addressed from its own parent rather
 * than from the folder on screen, and a folder had to carry a `.folder` marker
 * suffix. None of that exists now. The row knows where it is.
 *
 * Each action reloads on success rather than patching rows: a rename can change
 * sort position, a move removes a row, and a folder delete changes counts on
 * rows that were not touched. A bulk delete or move also reloads when it stops
 * partway, since the items before the failure really did go.
 */
export function useFileActions({
  lawFirmId,
  scope,
  currentFolderId,
  reload,
  onError,
  onSuccess,
}: {
  lawFirmId: string;
  scope: FileScope;
  /** The folder currently open, or null at the scope's root. */
  currentFolderId: string | null;
  reload: () => Promise<void> | void;
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}): FileActions {
  const [downloadingLabel, setDownloadingLabel] = useState<string | null>(null);
  /**
   * Archive builds live ABOVE this hook, in `FileExportProvider`.
   *
   * A folder export outlives the click by minutes, and this hook dies with the
   * file browser. Held here, opening a matter mid-download abandoned the
   * archive. The provider owns the wait, the pill and the cancel, so moving
   * around the firm leaves it running.
   *
   * A single plain file is not a job and stays here: it is one signed url and a
   * click, over before there is anything to cancel.
   */
  const { runExport, cancelExport } = useFileExport();
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const fail = useCallback((err: unknown, fallback: string) => {
    onError?.(getErrorMessage(err, fallback));
  }, [onError]);

  /**
   * Report a batch that stopped on one item. `progress` says what already went
   * through, since those items are not coming back and a retry of the whole
   * selection would fail on the first of them.
   */
  const failPartway = useCallback((err: unknown, fallback: string, progress: string | null) => {
    const message = getErrorMessage(err, fallback);
    const reported = progress ? `${progress} ${message}` : message;
    onError?.(reported);
    return reported;
  }, [onError]);

  const download = useCallback(async (file: FileInfo) => {
    if (file.isFolder) {
      try {
        await runExport(
          `Preparing “${file.name}” for download…`,
          (signal) => FilesService.downloadFolder(lawFirmId, scope, file.id, signal),
        );
      } catch (err) {
        // A cancel is the person's own decision, not something to report back
        // to them as a failure.
        if ((err as Error)?.name !== 'AbortError') fail(err, "Failed to download");
      }
      return;
    }

    setDownloadingLabel("Downloading…");
    try {
      await FilesService.downloadFile(
        await FilesService.getDownloadUrl(lawFirmId, file.id),
        file.name,
      );
    } catch (err) {
      fail(err, "Failed to download");
    } finally {
      setDownloadingLabel(null);
    }
  }, [lawFirmId, scope, fail, runExport]);

  const downloadMany = useCallback(async (items: FileInfo[]) => {
    if (items.length === 0) return;
    // A single plain file keeps the direct signed-URL download; no need to zip it.
    if (items.length === 1 && !items[0].isFolder) {
      await download(items[0]);
      return;
    }
    // Browsers only honour the first of several programmatic downloads fired in
    // a loop, so a multi-item selection has to come back as one archive.
    try {
      await runExport(
        `Preparing ${items.length} items for download…`,
        (signal) => FilesService.downloadZip(lawFirmId, scope, items.map((i) => i.id), signal),
      );
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') fail(err, "Failed to download");
    }
  }, [lawFirmId, scope, download, fail, runExport]);

  const removeMany = useCallback(async (items: FileInfo[]) => {
    if (items.length === 0) return;
    setDeleting(true);
    let done = 0;
    try {
      // Sequential so a failure names the item it stopped on.
      for (const item of items) {
        await FilesService.deleteItem(lawFirmId, scope, item.id);
        done += 1;
      }
      await reload();
      onSuccess?.(items.length === 1 ? "Deleted successfully" : `Deleted ${items.length} items`);
    } catch (err) {
      failPartway(err, "Failed to delete", done > 0 ? `Deleted ${done} of ${items.length} items.` : null);
      // The items before the refusal are gone, so the rows on screen are stale.
      await reload();
      throw err;
    } finally {
      setDeleting(false);
    }
  }, [lawFirmId, scope, reload, failPartway, onSuccess]);

  const remove = useCallback((item: FileInfo) => removeMany([item]), [removeMany]);

  const rename = useCallback(async (item: FileInfo, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      await FilesService.rename(lawFirmId, scope, item.id, trimmed);
      await reload();
      onSuccess?.("Renamed successfully");
    } catch (err) {
      fail(err, "Failed to rename");
      // The rename dialog closes on resolve; rejecting keeps it open with the
      // name the user typed.
      throw err;
    }
  }, [lawFirmId, scope, reload, fail, onSuccess]);

  const createFolder = useCallback(async (folderName: string, folderColor?: string) => {
    const trimmed = folderName.trim();
    if (!trimmed) return;
    try {
      await FilesService.createFolder(lawFirmId, scope, {
        folderName: trimmed,
        parentId: currentFolderId ?? undefined,
        folderColor,
      });
      await reload();
      onSuccess?.("Folder created");
    } catch (err) {
      fail(err, "Failed to create folder");
      throw err;
    }
  }, [lawFirmId, scope, currentFolderId, reload, fail, onSuccess]);

  const setFolderColor = useCallback(async (folder: FileInfo, folderColor: string) => {
    try {
      await FilesService.updateFolderColor(lawFirmId, scope, folder.id, folderColor);
      await reload();
      onSuccess?.("Folder color updated");
    } catch (err) {
      fail(err, "Failed to update folder color");
      throw err;
    }
  }, [lawFirmId, scope, reload, fail, onSuccess]);

  const move = useCallback(async (items: FileInfo[], destinationFolderId: string | null) => {
    if (items.length === 0) return;
    setMoving(true);
    let done = 0;
    try {
      // Sequential so a failure names the item it stopped on.
      for (const item of items) {
        await FilesService.move(lawFirmId, scope, {
          fileId: item.id,
          destinationFolderId,
        });
        done += 1;
      }
      await reload();
      onSuccess?.("Moved successfully");
    } catch (err) {
      const message = failPartway(err, "Failed to move item", done > 0 ? `Moved ${done} of ${items.length} items.` : null);
      // The items before the refusal have left this folder, so the rows on
      // screen are stale.
      await reload();
      // Rejects with the reported wording, progress included, so the move
      // picker that is still open can show the same message inside itself.
      throw new Error(message);
    } finally {
      setMoving(false);
    }
  }, [lawFirmId, scope, reload, failPartway, onSuccess]);

  return {
    downloadingLabel,
    cancelDownload: cancelExport,
    moving,
    deleting,
    download,
    downloadMany,
    remove,
    removeMany,
    rename,
    createFolder,
    setFolderColor,
    move,
  };
}
