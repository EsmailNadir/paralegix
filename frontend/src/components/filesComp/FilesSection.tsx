"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import FileUpload from "./FileUpload";
import FileManager from "./FileManager";
import RequireFeature from "@/components/ui/RequireFeature";
import ErrorNotification from "@/components/ErrorNotification";
import { usePermissions } from "@/contexts/PermissionsContext";
import type { ShareClient } from "./ClientSharePickerModal";
import type { FolderCrumb } from "@/lib/files/filePaths";
import type { LinkedFolder } from "./FileRowList";

interface FilesSectionProps {
  lawFirmId: string;
  matterId?: string;
  taskId?: string; // For tasks without a matter - use task-scoped storage
  clientId?: string; // For client-specific files
  onError?: (error: string) => void;
  /** Folder to open at. Empty opens the scope's root. */
  initialTrail?: FolderCrumb[];
  /** Label for the root breadcrumb (defaults to "Root") */
  rootLabel?: string;
  /** Clients on this task; when >1, sharing a task file prompts for recipients. */
  shareClients?: ShareClient[];
  /** Scrolled into view and briefly flashed once it's on screen. Pair with
   *  `initialTrail` set to the folder it lives in. */
  highlightFileId?: string | null;
  /** Folders that open another file area, listed at this scope's root. */
  rootFolders?: LinkedFolder[];
  /** The view this scope was opened from; the breadcrumb leads back to it. */
  parentCrumb?: { label: string; onOpen: () => void };
}

// Stable default so an omitted trail is not a fresh array on every render.
const EMPTY_TRAIL: FolderCrumb[] = [];

export default function FilesSection({
  lawFirmId,
  matterId,
  taskId,
  clientId,
  onError,
  initialTrail,
  rootLabel,
  shareClients,
  highlightFileId,
  rootFolders,
  parentCrumb,
}: FilesSectionProps) {
  const { hasPermission } = usePermissions();
  const canViewFiles = hasPermission("files.view");
  const canUploadFiles = hasPermission("files.upload");

  // Bumped when an upload lands, to re-fetch the folder on screen. It is a
  // reload token, not part of the browser's key: remounting would reopen it at
  // `startTrail`, dropping the folder, search and selection the user is on.
  const [reloadToken, setReloadToken] = useState(0);
  const startTrail = useMemo(() => initialTrail ?? EMPTY_TRAIL, [initialTrail]);
  const [trail, setTrail] = useState<FolderCrumb[]>(startTrail);

  // Reset the trail when switching between matter, task and client context.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets user-navigable trail state when the matter/task/client context changes
    setTrail(startTrail);
  }, [matterId, taskId, clientId, startTrail]);

  // A delete needs nothing here: the browser re-fetches after its own mutations.
  const handleUploadComplete = useCallback(() => {
    setReloadToken(prev => prev + 1);
  }, []);

  const handleTrailChange = useCallback((next: FolderCrumb[]) => {
    setTrail(next);
  }, []);

  const handleError = (error: string) => {
    onError?.(error);
  };

  const folderId = trail.length > 0 ? trail[trail.length - 1].id : undefined;
  const uploadLocationLabel = [rootLabel || "Root", ...trail.map((c) => c.name)].join(" / ");

  return (
    <RequireFeature feature="fileSharing">
      <div className="bg-surface rounded-lg shadow-sm border border-outline">
        <div className="p-4 md:p-6 space-y-6">
          {!canViewFiles ? (
            <ErrorNotification
              error="You do not have permission to view files."
              onClose={() => {}}
            />
          ) : (
            <>
              {canUploadFiles && (
                <FileUpload
                  lawFirmId={lawFirmId}
                  matterId={matterId}
                  taskId={taskId}
                  clientId={clientId}
                  folderId={folderId}
                  locationLabel={uploadLocationLabel}
                  onUploadComplete={handleUploadComplete}
                  onError={handleError}
                />
              )}

              <FileManager
                key={startTrail.map((c) => c.id).join('/') || 'root'}
                lawFirmId={lawFirmId}
                matterId={matterId}
                taskId={taskId}
                clientId={clientId}
                initialTrail={startTrail}
                reloadToken={reloadToken}
                onError={handleError}
                onTrailChange={handleTrailChange}
                rootLabel={rootLabel}
                shareClients={shareClients}
                highlightFileId={highlightFileId}
                rootFolders={rootFolders}
                parentCrumb={parentCrumb}
              />
            </>
          )}
        </div>
      </div>
    </RequireFeature>
  );
} 
