"use client";

import useFolderBrowser from "@/hooks/fileHooks/useFolderBrowser";
import FolderBrowserBody, { FolderBrowserRows } from "./FolderBrowserBody";

import { useCallback, useEffect, useState } from "react";
import FilesService, { type FileInfo } from "@/services/files.service";
import type { FileScope } from "@/lib/files/fileScope";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";

import { useResetAfterClose } from "@/hooks/useMountTransition";
import TruncatedListNotice from "@/components/ui/TruncatedListNotice";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import ErrorNotification from "@/components/ErrorNotification";

interface MoveToFolderModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The chosen destination, or null for the scope's root. A rejection keeps
   * the picker open and shows its message here.
   */
  onMove: (destinationFolderId: string | null) => Promise<void> | void;
  itemName: string;
  /**
   * Every item being moved. None of them is offered as a destination, so a
   * folder cannot be moved into itself or into another folder in the same move.
   */
  excludeIds: string[];
  /** The folder the item sits in now, or null when it is at the scope root. */
  currentFolderId: string | null;
  lawFirmId: string;
  /** Which documents to browse for a destination. */
  scope: FileScope;
  moving?: boolean;
  /** Label for the root level (e.g. matter name, task name). Defaults to "Root". */
  rootLabel?: string;
}

export default function MoveToFolderModal({
  isOpen,
  onClose,
  onMove,
  itemName,
  excludeIds,
  currentFolderId,
  lawFirmId,
  scope,
  moving = false,
  rootLabel = "Root",
}: MoveToFolderModalProps) {
  const { items: folders, loading, loaded: foldersLoaded, setLoaded: setFoldersLoaded,
    truncated, error, setError, load: loadFolderRows, trail: browseTrail, setTrail: setBrowseTrail,
    folderId, openFolder, navigateFolder } = useFolderBrowser("Failed to load folders");
  // Back to the root once the picker is gone, so a reopen fetches the root
  // alone instead of the folder it was last left in and then the root.
  useResetAfterClose(isOpen, () => {
    setFoldersLoaded(false);
    setBrowseTrail([]);
  });

  // A refused move, kept apart from `error`, which is a failed folder listing.
  const [moveError, setMoveError] = useState<string | null>(null);
  const handleClose = useCallback(() => {
    if (moving) return;
    onClose();
  }, [moving, onClose]);

  const browseFolderId = folderId ?? null;
  const isSameLocation = browseFolderId === currentFolderId;

  const fetchFolders = useCallback(async (folderId: string | null) => {
    await loadFolderRows(() => FilesService.listFolder(lawFirmId, scope, folderId ?? undefined),
      (folder) => !!folder.isFolder && folder.name !== "note-attachments");
  }, [lawFirmId, scope, loadFolderRows]);

  // Fetch folders when modal opens or browse path changes
  useEffect(() => {
    if (!isOpen) return;
    fetchFolders(browseFolderId);
  }, [isOpen, browseFolderId, fetchFolders]);

  // Reset when modal opens. Start browsing in the item's current folder
  // instead of at the root so the user doesn't have to navigate back down.
  // The picker opens at the ROOT rather than at the item's current folder. It
  // used to seed the trail from the item's location, which it could do while a
  // location was a path of names; a folder id on its own says nothing about the
  // folders above it, and fetching that chain to open one level deeper is not
  // worth a round trip. "Move here" is still greyed out at the item's own
  // folder, so the wasted click is the only cost.
  useEffect(() => {
    if (isOpen) {
      setBrowseTrail([]);
      setError(null);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the previous move failure when the picker opens
      setMoveError(null);
    }
  }, [isOpen, setBrowseTrail, setError]);

  // A folder cannot be moved into itself or into another folder moving with
  // it, wherever it is browsed to. The ids are the check; the name was, and two
  // folders can share one. Filtered here rather than in the fetch because the
  // caller builds `excludeIds` afresh on every render.
  const destinations = folders.filter((f) => !excludeIds.includes(f.id));

  const navigateInto = (folder: FileInfo) => {
    openFolder(folder.id, folder.name);
  };

  const navigateToBreadcrumb = (index: number) => {
    // -1 = root, 0 = first folder, etc.
    navigateFolder(index);
  };

  const handleMove = async () => {
    setMoveError(null);
    try {
      await onMove(browseFolderId);
    } catch (err) {
      setMoveError(getErrorMessage(err, "Failed to move item"));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={<>Move &ldquo;{itemName}&rdquo;</>}
      subtitle="Select a destination folder"
      dismissible={!moving}
      size="md"
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={moving}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleMove}
            disabled={isSameLocation || moving}
            loading={moving}
          >
            {moving ? "Moving..." : "Move here"}
          </Button>
        </>
      }
    >
      <ErrorNotification error={moveError} onClose={() => setMoveError(null)} compact />

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-sm flex-wrap">
        <button
          type="button"
          onClick={() => navigateToBreadcrumb(-1)}
          className={`font-medium transition-colors cursor-pointer ${
            browseTrail.length === 0
              ? "text-accent-emphasis"
              : "text-on-surface-secondary hover:text-on-surface"
          }`}
        >
          {rootLabel}
        </button>
        {browseTrail.map((crumb, i) => (
          <span key={crumb.id} className="flex items-center gap-1">
            <svg className="w-3 h-3 text-on-surface-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <button
              type="button"
              onClick={() => navigateToBreadcrumb(i)}
              className={`font-medium transition-colors cursor-pointer ${
                i === browseTrail.length - 1
                  ? "text-accent-emphasis"
                  : "text-on-surface-secondary hover:text-on-surface"
              }`}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </div>

      <TruncatedListNotice truncated={truncated} unitLabel="folders" />

      {/* Folder list */}
      <div className="border border-outline rounded-lg overflow-hidden">
        <FolderBrowserBody loading={loading || !foldersLoaded} label="Loading folders">
        {error ? (
          <div className="py-6 px-4 text-center text-sm text-red-500">{error}</div>
        ) : destinations.length === 0 ? (
          <div className="py-6 px-4 text-center text-sm text-on-surface-muted">
            No subfolders here
          </div>
        ) : (
          <div className="max-h-56 overflow-y-auto overflow-x-hidden divide-y divide-outline">
            <FolderBrowserRows folders={destinations} onOpen={navigateInto} renderRow={(folder) => (
              <button
                key={folder.id}
                type="button"
                onClick={() => navigateInto(folder)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-hover transition-colors cursor-pointer"
              >
                <svg className="w-5 h-5 text-blue-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" />
                </svg>
                <span className="text-sm font-medium text-on-surface truncate">
                  {folder.displayName || folder.name}
                </span>
                <svg className="w-4 h-4 text-on-surface-muted ml-auto flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )} />
          </div>
        )}
        </FolderBrowserBody>
      </div>

      {/* Current destination indicator */}
      {isSameLocation && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          This is the current location of the item.
        </p>
      )}
    </Modal>
  );
}
