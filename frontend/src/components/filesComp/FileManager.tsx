"use client";

import { useMemo } from "react";
import { scopeFromIds } from "@/lib/files/fileScope";
import FileBrowser from "./FileBrowser";
import type { FolderCrumb } from "@/lib/files/filePaths";
import type { ShareClient } from "./ClientSharePickerModal";
import type { LinkedFolder } from "./FileRowList";

interface FileManagerProps {
  lawFirmId: string;
  matterId?: string;
  taskId?: string; // For tasks without a matter
  clientId?: string; // For client-specific files
  onFileDeleted?: (fileName: string) => void;
  onError?: (error: string) => void;
  onTrailChange?: (trail: FolderCrumb[]) => void;
  /** Folder trail to open at. */
  initialTrail?: FolderCrumb[];
  /** Label for the root breadcrumb (defaults to "Root") */
  rootLabel?: string;
  /** Clients on this matter/task; when >1, sharing prompts the firm to pick recipients. */
  shareClients?: ShareClient[];
  /** Scrolled into view and briefly flashed once it's on screen. */
  highlightFileId?: string | null;
  /** Folders that open another file area, listed at this scope's root. */
  rootFolders?: LinkedFolder[];
  /** The view this scope was opened from; the breadcrumb leads back to it. */
  parentCrumb?: { label: string; onOpen: () => void };
  /** Bump to re-fetch what the browser is showing, in place. */
  reloadToken?: number;
}

/**
 * The file browser embedded in a matter, task or client detail page.
 *
 * Browsing, searching, selection and every mutation live in `FileBrowser`, which
 * the firm-wide Files page renders too. This resolves the three loose ids the
 * detail pages hold into the scope that describes them, and turns on the
 * folder-level browser history those pages have no location sync of their own for.
 */
export default function FileManager({
  lawFirmId,
  matterId,
  taskId,
  clientId,
  onFileDeleted,
  onError,
  onTrailChange,
  initialTrail,
  rootLabel = "Root",
  shareClients,
  highlightFileId,
  rootFolders,
  parentCrumb,
  reloadToken,
}: FileManagerProps) {
  const scope = useMemo(
    () => scopeFromIds({ matterId, taskId, clientId }),
    [matterId, taskId, clientId]
  );

  return (
    <FileBrowser
      lawFirmId={lawFirmId}
      scope={scope}
      initialTrail={initialTrail}
      rootLabel={rootLabel}
      shareClients={shareClients}
      syncBrowserHistory
      onError={onError}
      onFileDeleted={onFileDeleted}
      onTrailChange={onTrailChange}
      highlightFileId={highlightFileId}
      rootFolders={rootFolders}
      parentCrumb={parentCrumb}
      reloadToken={reloadToken}
    />
  );
}
