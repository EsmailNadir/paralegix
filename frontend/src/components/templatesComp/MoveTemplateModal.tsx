"use client";

import { useEffect, useId, useState } from "react";
import { ChevronRight, Folder, Home, Search } from "lucide-react";
import type { TemplateFolder } from "@/types/template";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { buildFolderPath, folderPathLabel, groupFoldersByParent } from "./folderPaths";

/**
 * Picks the folder a template moves to.
 *
 * Move used to be a dropdown hanging off each template card, which meant the
 * whole destination tree had to be walked inside a 288px popover pinned to a
 * grid cell. As a dialog it gets the room to show a breadcrumb, a filter, and
 * the destination's contents at once.
 */
export default function MoveTemplateModal({
  open,
  templateName,
  folders,
  currentFolderId,
  moving,
  onMove,
  onClose,
}: {
  open: boolean;
  templateName: string;
  folders: TemplateFolder[];
  currentFolderId: string | null;
  moving: boolean;
  /** A rejection keeps the dialog open and shows its message here. */
  onMove: (folderId: string | null) => Promise<void> | void;
  onClose: () => void;
}) {
  // The folder being browsed for a destination, which starts where the template
  // already lives so a nearby move is a short trip.
  const [browseFolderId, setBrowseFolderId] = useState<string | null>(currentFolderId);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-seeds the browse position each time the dialog opens
    setBrowseFolderId(currentFolderId);
    setQuery("");
    setError(null);
  }, [open, currentFolderId]);

  const handleMove = async () => {
    setError(null);
    try {
      await onMove(browseFolderId);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to move template."));
    }
  };

  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const childrenByParent = groupFoldersByParent(folders);
  const browsePath = buildFolderPath(folderById, browseFolderId);

  const normalizedQuery = query.trim().toLowerCase();
  const isFiltering = normalizedQuery.length > 0;

  // Filtering searches the whole library, since the point of searching for a
  // destination is to reach one that isn't in the folder being browsed.
  const options = isFiltering
    ? folders
        .filter(
          (folder) =>
            folder.name.toLowerCase().includes(normalizedQuery) ||
            folderPathLabel(folderById, folder.parentFolderId)
              .toLowerCase()
              .includes(normalizedQuery)
        )
        .sort((left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
        )
    : childrenByParent.get(browseFolderId) ?? [];

  const isCurrentLocation = browseFolderId === currentFolderId;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      dismissible={!moving}
      labelledBy={titleId}
      showClose={false}
      size="md"
      className="relative"
      bodyClassName={null}
      footer={
        <div className="w-full flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-on-surface-secondary">
            {browseFolderId ? (
              <Folder size={13} className="shrink-0 text-amber-500 dark:text-amber-400" />
            ) : (
              <Home size={13} className="shrink-0" />
            )}
            <span className="truncate">{folderPathLabel(folderById, browseFolderId)}</span>
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="primary"
              loading={moving}
              disabled={isCurrentLocation}
              onClick={handleMove}
            >
              {isCurrentLocation ? "Already here" : "Move here"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="shrink-0 border-b border-outline px-6 py-4">
        <h2 id={titleId} className="text-lg font-semibold text-on-surface">
          Move template
        </h2>
        <p className="mt-1 truncate text-xs text-on-surface-muted">
          Choose a new location for “{templateName}”.
        </p>
        <ErrorNotification
          error={error}
          onClose={() => setError(null)}
          compact
          className="mt-3"
        />
        <div className="relative mt-3">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted"
          />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search folders by name or location..."
            className="w-full rounded-md border border-input-border bg-input-bg py-2 pl-9 pr-3 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        </div>
      </div>

      {!isFiltering && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-outline-subtle px-6 py-2.5 text-[11px] text-on-surface-muted">
          <button
            type="button"
            onClick={() => setBrowseFolderId(null)}
            className={`cursor-pointer rounded px-1 py-0.5 transition-colors ${
              browseFolderId === null
                ? "font-medium text-on-surface"
                : "hover:text-on-surface"
            }`}
          >
            Root
          </button>
          {browsePath.map((folder) => (
            <span key={folder.id} className="flex items-center gap-1">
              <ChevronRight size={11} />
              <button
                type="button"
                onClick={() => setBrowseFolderId(folder.id)}
                className={`cursor-pointer rounded px-1 py-0.5 transition-colors ${
                  browseFolderId === folder.id
                    ? "font-medium text-on-surface"
                    : "hover:text-on-surface"
                }`}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden styled-scrollbar px-3 py-2">
        {options.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-on-surface-muted">
            {isFiltering
              ? `No folders match “${query.trim()}”.`
              : "No subfolders here. Move the template into this folder, or pick another location above."}
          </p>
        ) : (
          options.map((folder) => {
            // Browsing steps into a folder; a filtered hit is somewhere else
            // in the library, so selecting it jumps there instead.
            const disabled = isFiltering && folder.id === currentFolderId;

            return (
              <button
                key={folder.id}
                type="button"
                disabled={disabled}
                onClick={() => {
                  setBrowseFolderId(folder.id);
                  setQuery("");
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
                  disabled
                    ? "cursor-not-allowed opacity-60"
                    : "cursor-pointer hover:bg-surface-hover"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Folder
                    size={15}
                    className="shrink-0 text-amber-500 dark:text-amber-400"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-on-surface">
                      {folder.name}
                    </span>
                    {isFiltering && (
                      // Browsing shows one level at a time, so the
                      // breadcrumb already says where these folders are.
                      // Filtered hits are flat and can come from anywhere.
                      <span className="block truncate text-[11px] text-on-surface-muted">
                        {folderPathLabel(folderById, folder.parentFolderId)}
                      </span>
                    )}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-[11px] text-on-surface-muted">
                  {disabled && <span>Current</span>}
                  <ChevronRight size={14} />
                </span>
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
}
