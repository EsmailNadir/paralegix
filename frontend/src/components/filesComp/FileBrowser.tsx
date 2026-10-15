"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import { type FileInfo } from "@/services/files.service";
import { type FileScope, scopeKey } from "@/lib/files/fileScope";
import type { FolderCrumb } from "@/lib/files/filePaths";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useFileBrowser } from "@/hooks/fileHooks/useFileBrowser";
import { useFileSelection } from "@/hooks/fileHooks/useFileSelection";
import { useFileActions } from "@/hooks/fileHooks/useFileActions";
import { useClientShare } from "@/hooks/fileHooks/useClientShare";
import ErrorNotification from "@/components/ErrorNotification";
import ConfirmModal from "@/components/ui/ConfirmModal";
import BusyToast from "@/components/ui/BusyToast";
import Spinner from "@/components/ui/Spinner";
import ListSkeleton from "@/components/ui/ListSkeleton";
import TruncatedListNotice from "@/components/ui/TruncatedListNotice";
import ListToolbar from "@/components/ui/ListToolbar";
import SignActionModal from "@/components/signaturesComp/SignActionModal";
import BulkActionsMenu from "./BulkActionsMenu";
import ClientSharePickerModal, { type ShareClient } from "./ClientSharePickerModal";
import FileBreadcrumbs from "./FileBreadcrumbs";
import ItemActionMenu, { menuPositionFromEvent } from "@/components/ui/ItemActionMenu";
import FilePreviewModal from "./FilePreviewModal";
import FileRowList, { LinkedFolderRow, type LinkedFolder } from "./FileRowList";
import MoveToFolderModal from "./MoveToFolderModal";
import ShareLinkModal, { type ShareLinkItem } from "./ShareLinkModal";
import CreateFolderModal from "./CreateFolderModal";
import RenameItemModal from "./RenameItemModal";
import FolderColorModal from "./FolderColorModal";
import { bulkActionsFor, rowActionsFor, type FileActionCapabilities } from "./fileActionMenus";
import { getFolderColorDef } from "./folderColors";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import Button from "@/components/ui/Button";

export interface FileBrowserProps {
  lawFirmId: string;
  /** Which documents to show. */
  scope: FileScope;
  /** Folder trail to open at. */
  initialTrail?: FolderCrumb[];
  /** Label for the root breadcrumb. */
  rootLabel?: string;
  /** Clients who can receive a share here; more than one prompts for recipients. */
  shareClients?: ShareClient[];
  /** Rendered between the toolbar and the rows (upload panels, notices). */
  children?: React.ReactNode;
  /** Extra controls for the right of the toolbar (e.g. an Upload button). */
  toolbarActions?: React.ReactNode;
  /**
   * Mirror folder navigation into the History API so the browser's Back button
   * walks the folder trail. Off by default: a host page that already syncs its
   * own location would otherwise push two entries per move.
   */
  syncBrowserHistory?: boolean;
  /**
   * The open folder trail, when the host owns it (see `useFileBrowser`). Pair it
   * with `onTrailChange`; omit both to let the browser keep its own trail.
   */
  trail?: FolderCrumb[];
  /** Bump to force a refetch of what is on screen (a manual Refresh button). */
  reloadToken?: number;
  onError?: (message: string) => void;
  onNotify?: (message: string) => void;
  onFileDeleted?: (fileName: string) => void;
  onTrailChange?: (trail: FolderCrumb[]) => void;
  /** Called after any mutation, so a host can refresh storage usage. */
  onMutated?: () => void;
  /** Scrolled into view and briefly flashed once it's on screen (pair with an
   *  `initialTrail`/`trail` that opens the folder it lives in). */
  highlightFileId?: string | null;
  /** Folders that open another file area, listed above this scope's own items
   *  at its root and hidden while searching (a client's matters, on the
   *  client's files). */
  rootFolders?: LinkedFolder[];
  /** The view this scope was opened from; the breadcrumb leads back to it. */
  parentCrumb?: { label: string; onOpen: () => void };
}

// Stable default so an omitted `initialTrail` doesn't produce a fresh array on
// every render and re-fire the effects that depend on it.
const EMPTY_TRAIL: FolderCrumb[] = [];
const NO_CLIENTS: ShareClient[] = [];
const NO_FOLDERS: LinkedFolder[] = [];

/**
 * The firm-side file browser: a folder listing with search, selection, per-row
 * and bulk actions, and the dialogs they open.
 *
 * There were two of these - the matter/task/client file manager and the
 * firm-wide Files page - sharing only their row list. They implemented the same
 * eleven behaviours separately and had already drifted apart on several. This is
 * the one implementation; the two surfaces now differ only in what surrounds it.
 */
export default function FileBrowser({
  lawFirmId,
  scope,
  initialTrail = EMPTY_TRAIL,
  rootLabel = "Root",
  shareClients = NO_CLIENTS,
  children,
  toolbarActions,
  syncBrowserHistory = false,
  trail,
  reloadToken = 0,
  onError,
  onNotify,
  onFileDeleted,
  onTrailChange,
  onMutated,
  highlightFileId,
  rootFolders = NO_FOLDERS,
  parentCrumb,
}: FileBrowserProps) {
  const { hasPermission } = usePermissions();
  const canViewFiles = hasPermission("files.view");
  const canDeleteFiles = hasPermission("files.delete");
  const canManageFolders = hasPermission("files.manageFolders");
  const canShareFiles = hasPermission("files.upload");

  const browser = useFileBrowser({
    lawFirmId,
    scope,
    initialTrail,
    enabled: canViewFiles,
    trail,
    onTrailChange,
    onError,
  });

  // A selection belongs to the place it was made, so it clears whenever the
  // browser moves - folder, search, or scope.
  const locationKey = `${scopeKey(scope)}|${browser.currentFolderId ?? ""}|${browser.activeQuery}`;
  const selection = useFileSelection(browser.files, locationKey);

  const notify = useCallback((message: string) => onNotify?.(message), [onNotify]);

  const reload = browser.reload;
  useEffect(() => {
    if (reloadToken === 0) return;
    void reload();
    // Only the token drives this; `reload` changes with every location change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  const afterMutation = useCallback(async () => {
    await browser.reload();
    onMutated?.();
  }, [browser, onMutated]);

  const actions = useFileActions({
    lawFirmId,
    scope,
    currentFolderId: browser.currentFolderId,
    reload: afterMutation,
    onError,
    onSuccess: notify,
  });

  const clientShare = useClientShare({
    lawFirmId,
    scope,
    shareClients,
    patchFiles: browser.patchFiles,
    onError,
    onSuccess: notify,
  });

  // --- dialog state ---
  const [menu, setMenu] = useState<{ anchorTop: number; anchorBottom: number; right: number; item: FileInfo } | null>(null);
  // Retain the menu's target through its close animation so it doesn't blank out.
  const menuRenderRef = useRef<{ anchorTop: number; anchorBottom: number; right: number; item: FileInfo } | null>(null);
  if (menu) menuRenderRef.current = menu;
  const menuRender = menu ?? menuRenderRef.current;

  const [previewFile, setPreviewFile] = useState<FileInfo | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<FileInfo | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [colorTarget, setColorTarget] = useState<FileInfo | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<FileInfo[]>([]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moveTargets, setMoveTargets] = useState<FileInfo[]>([]);
  const [moveOpen, setMoveOpen] = useState(false);
  const [signFile, setSignFile] = useState<FileInfo | null>(null);
  const [signActionOpen, setSignActionOpen] = useState(false);
  const [shareLinkItems, setShareLinkItems] = useState<ShareLinkItem[]>([]);
  const [shareLinkOpen, setShareLinkOpen] = useState(false);
  const openShareLink = (items: FileInfo[]) => {
    if (items.length === 0) return;
    setShareLinkItems(items.map((f) => ({ fileId: f.id, name: f.displayName ?? f.name, isFolder: !!f.isFolder })));
    setShareLinkOpen(true);
  };

  // Cleared once the move picker is gone, not as it closes: emptying the list
  // while it is still on screen rewrites its subject to "0 items".
  useResetAfterClose(moveOpen, () => setMoveTargets([]));

  // --- drag and drop ---
  const [draggedItem, setDraggedItem] = useState<FileInfo | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);

  // Mirror folder navigation into the History API when the host isn't already
  // doing it. The last mirrored folder is tracked by its id rather than by array
  // identity, so only a real move pushes: a re-run of this effect, or a trail
  // array rebuilt with the same crumbs, must not leave a duplicate entry behind
  // for the user to press Back through. `fromPopState` avoids re-pushing a trail
  // that a popstate event just restored.
  const folderKey = browser.currentFolderId ?? "";
  const isFirmRoot = scope.type === "firm" && browser.trail.length === 0;
  const historyFolderKey = useRef(folderKey);
  const fromPopState = useRef(false);
  const goToTrail = browser.goToTrail;
  const browserTrail = browser.trail;

  useEffect(() => {
    if (!syncBrowserHistory) return;
    if (historyFolderKey.current === folderKey) return;
    historyFolderKey.current = folderKey;
    if (fromPopState.current) {
      fromPopState.current = false;
      return;
    }
    window.history.pushState({ fbTrail: browserTrail }, "");
    // The trail is what gets stored, but only a change of FOLDER is a move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncBrowserHistory, folderKey]);

  const initialTrailRef = useRef(initialTrail);
  initialTrailRef.current = initialTrail;
  useEffect(() => {
    if (!syncBrowserHistory) return;
    const onPop = (e: PopStateEvent) => {
      const state = e.state as { fbTrail?: FolderCrumb[] } | null;
      fromPopState.current = true;
      goToTrail(Array.isArray(state?.fbTrail) ? state.fbTrail : (initialTrailRef.current ?? []));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [syncBrowserHistory, goToTrail]);

  const capabilities: FileActionCapabilities = {
    canManageFolders,
    canDeleteFiles,
    canShareFiles,
    canShareWithClient: clientShare.canShare && canShareFiles,
    inheritedShared: browser.inheritedShared,
    pendingShareIds: clientShare.pendingIds,
    onSendForSignature: (file) => { void openSignAction(file); },
    onCreateShareLink: (file) => openShareLink([file]),
  };

  /**
   * Open a row. A search hit lives wherever it was found, so opening one moves
   * the browser to that folder rather than appending its name to wherever the
   * user is standing.
   */
  const openRow = (file: FileInfo) => {
    if (file.isFolder) {
      if (browser.isSearching) {
        // The hit carries the folders above it, so opening one moves the browser
        // to where it actually is rather than to a child of the open folder.
        browser.goToTrail([...(file.trail ?? []), { id: file.id, name: file.name }]);
        return;
      }
      browser.openFolder(file);
      return;
    }
    setPreviewFile(file);
    setPreviewOpen(true);
  };

  /**
   * Open the signing flow for a file. The signing modal works from the
   * objectPath alone (conversion happens server-side), so no signed URL is
   * minted here.
   */
  const openSignAction = (file: FileInfo) => {
    setSignFile(file);
    setSignActionOpen(true);
  };

  const requireFolderPermission = (message: string) => {
    if (canManageFolders) return true;
    onError?.(message);
    return false;
  };

  const rowHandlers = {
    onOpen: openRow,
    onDownload: (file: FileInfo) => { void actions.download(file); },
    onToggleClientVisibility: (file: FileInfo) => clientShare.share([file], !file.clientVisible),
    onRename: (file: FileInfo) => {
      if (!requireFolderPermission("You do not have permission to manage folders.")) return;
      setRenameTarget(file);
      setRenameOpen(true);
    },
    onMove: (file: FileInfo) => {
      if (!requireFolderPermission("You do not have permission to move files.")) return;
      setMoveTargets([file]);
      setMoveOpen(true);
    },
    onChangeColor: (file: FileInfo) => {
      if (!requireFolderPermission("You do not have permission to manage folders.")) return;
      if (!file.isFolder) return;
      setColorTarget(file);
      setColorOpen(true);
    },
    onDelete: (file: FileInfo) => {
      if (!canDeleteFiles) {
        onError?.("You do not have permission to delete files.");
        return;
      }
      setDeleteTargets([file]);
      setDeleteOpen(true);
    },
  };

  const bulkHandlers = {
    onSetClientVisibility: (visible: boolean) =>
      clientShare.share(selection.selectedItems, visible),
    onDownload: () => { void actions.downloadMany(selection.selectedItems); },
    onCreateShareLink: () => openShareLink(selection.selectedItems),
    onSendForSignature: (file: FileInfo) => { void openSignAction(file); },
    onMove: () => {
      if (!requireFolderPermission("You do not have permission to move files.")) return;
      if (selection.selectedItems.length === 0) return;
      setMoveTargets(selection.selectedItems);
      setMoveOpen(true);
    },
    onDelete: () => {
      if (!canDeleteFiles) {
        onError?.("You do not have permission to delete files.");
        return;
      }
      if (selection.selectedItems.length === 0) return;
      setDeleteTargets(selection.selectedItems);
      setDeleteOpen(true);
    },
  };

  /**
   * A folder is its own drop target, and dropping one on itself asks the server
   * to move it inside itself. Refuse the drag rather than the drop, so the row
   * never highlights as a valid destination.
   */
  // Drop targets are folder IDS. A drop used to name the target folder, which
  // the move then resolved from the open folder plus that name; the move takes
  // the id now, and a name in its place is a folder that does not exist.
  const isSelfDrop = (folderId?: string) =>
    !!folderId && !!draggedItem?.isFolder && draggedItem.id === folderId;

  const dragProps = {
    enableDrag: !browser.isSearching,
    draggedItem,
    dragOverFolder,
    onDragStart: (e: React.DragEvent, item: FileInfo) => {
      setDraggedItem(item);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => {
      setDraggedItem(null);
      setDragOverFolder(null);
    },
    onDragOver: (e: React.DragEvent, folderId?: string) => {
      if (isSelfDrop(folderId)) {
        e.dataTransfer.dropEffect = "none";
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (folderId) setDragOverFolder(folderId);
    },
    onDragLeave: () => setDragOverFolder(null),
    onDrop: async (e: React.DragEvent, targetFolder?: string) => {
      e.preventDefault();
      setDragOverFolder(null);
      if (!draggedItem || !targetFolder) return;
      // Belt and braces: dragOver already refuses this, but a drop that slipped
      // through would send the folder into itself.
      if (isSelfDrop(targetFolder)) return;
      if (!requireFolderPermission("You do not have permission to move files.")) return;
      try {
        await actions.move([draggedItem], targetFolder);
      } catch {
        // move already reported the failure through onError.
      } finally {
        setDraggedItem(null);
      }
    },
  };

  const confirmDelete = async () => {
    try {
      await actions.removeMany(deleteTargets);
      if (deleteTargets.length === 1) onFileDeleted?.(deleteTargets[0].name);
      selection.clear();
    } catch {
      // removeMany already reported the failure through onError.
    } finally {
      setDeleteOpen(false);
    }
  };

  /**
   * Where a row sits, in the browser's own terms: a folder id, or null at the
   * scope's root. The row's `parentId` will not do, because at the root it is
   * the scope's root folder id, which the browser and the move picker both call
   * null. A search hit carries the folders above it; any other row is in the
   * folder on screen.
   */
  const locationOf = (item: FileInfo): string | null =>
    item.trail ? (item.trail[item.trail.length - 1]?.id ?? null) : browser.currentFolderId;

  // A refusal rejects back into the move picker, which stays open and shows it.
  const confirmMove = async (destinationFolderId: string | null) => {
    await actions.move(moveTargets, destinationFolderId);
    selection.clear();
    setMoveOpen(false);
    setMoveTargets([]);
  };

  if (!canViewFiles) {
    return <ErrorNotification error="You do not have permission to view files." />;
  }

  const deleteLabel = deleteTargets.length === 1
    ? `"${deleteTargets[0].displayName ?? deleteTargets[0].name}"`
    : `${deleteTargets.length} items`;
  const deletingFolder = deleteTargets.some((t) => t.isFolder);
  const visibleRootFolders = browser.trail.length === 0 && !browser.isSearching ? rootFolders : NO_FOLDERS;

  return (
    <div className="space-y-4">
      <ErrorNotification error={browser.error} onClose={() => browser.setError(null)} />

      <FileBreadcrumbs
        trail={browser.trail}
        rootLabel={rootLabel}
        onUp={browser.goUp}
        onRoot={() => browser.goToTrail([])}
        onSegment={browser.goToBreadcrumb}
        parent={parentCrumb}
      />

      <ListToolbar className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-muted" />
          <input
            type="text"
            placeholder="Search files…"
            value={browser.searchQuery}
            onChange={(e) => browser.setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
            className="w-full rounded-xl border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-9 pr-9 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
          {browser.searching && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <Spinner size={16} className="text-on-surface-muted" />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 justify-end">
          {browser.files.length > 0 && (
            <button
              type="button"
              onClick={selection.toggleAll}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-outline-subtle bg-surface text-on-surface-secondary text-xs font-medium hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              {selection.allSelected ? "Deselect all" : "Select all"}
            </button>
          )}
          {selection.selectedCount > 0 && !selection.allSelected && (
            <button
              type="button"
              onClick={selection.clear}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-outline-subtle bg-surface text-on-surface-secondary text-xs font-medium hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              Clear
            </button>
          )}
          {selection.selectedCount > 0 && (
            <BulkActionsMenu
              count={selection.selectedCount}
              actions={bulkActionsFor(selection.selectedItems, capabilities, bulkHandlers)}
            />
          )}
          {toolbarActions}
          {canManageFolders && (
            <Button
              size="compact"
              onClick={() => setCreateFolderOpen(true)}
              icon={<Plus size={14} strokeWidth={2.2} />}
            >
              New Folder
            </Button>
          )}
        </div>
      </ListToolbar>

      {children}

      <TruncatedListNotice
        truncated={!!browser.truncatedMode}
        mode={browser.truncatedMode ?? "browse"}
        className="mb-3"
      />

      {browser.loading || (browser.files.length === 0 && (browser.searching || browser.searchQuery.trim() !== browser.activeQuery)) ? (
        <ListSkeleton rows={5} label="Loading files" />
      ) : browser.files.length === 0 && visibleRootFolders.length === 0 ? (
        <div className="bg-surface rounded-2xl border border-outline-subtle p-12 text-center">
          <h3 className="text-base font-semibold text-on-surface">
            {browser.isSearching
              ? "No files found"
              : isFirmRoot
                ? "No law firm files"
                : "Empty folder"}
          </h3>
          <p className="text-sm text-on-surface-secondary mt-1">
            {browser.isSearching
              ? "Try a different search term"
              : isFirmRoot
                ? "This area only contains firm-wide files that aren't attached to a matter, client, or task. Files attached to matters, for example, appear under those matters."
                : "Get started by uploading a file or creating a folder"}
          </p>
        </div>
      ) : (
        <FileRowList
          files={browser.files}
          leadingRows={visibleRootFolders.map((folder) => (
            <LinkedFolderRow key={folder.id} folder={folder} color={getFolderColorDef(null)} />
          ))}
          getFolderColor={(f) => getFolderColorDef(f.folderColor)}
          isSearching={browser.isSearching}
          shareContext={capabilities.canShareWithClient}
          shareClientCount={shareClients.length}
          shareClients={shareClients}
          inheritedShared={browser.inheritedShared}
          canManageFolders={canManageFolders}
          highlightFileId={highlightFileId}
          // Search results are a flat list gathered from all over the scope, so
          // "drop onto that folder" has no single meaning: the drop target's real
          // parent is not the folder the browser is sitting in, and the move
          // would land somewhere neither row is. Rows stay reorder-free while
          // searching; the Move to… action still works on any of them.
          {...dragProps}
          onOpen={openRow}
          onOpenMenu={(e, item) => {
            e.preventDefault();
            // Clicking the same row's kebab again toggles the menu closed.
            if (menu && menu.item.id === item.id) {
              setMenu(null);
              return;
            }
            setMenu({ ...menuPositionFromEvent(e), item });
          }}
          selectedIds={selection.selectedIds}
          onToggleSelect={selection.toggle}
        />
      )}

      <ItemActionMenu
        open={!!menu}
        anchorTop={menuRender?.anchorTop ?? 0}
        anchorBottom={menuRender?.anchorBottom ?? 0}
        right={menuRender?.right ?? 0}
        onClose={() => setMenu(null)}
        actions={menuRender ? rowActionsFor(menuRender.item, capabilities, rowHandlers) : []}
      />

      <ConfirmModal
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={confirmDelete}
        title={deletingFolder ? "Delete Folder" : "Delete"}
        message={`Are you sure you want to delete ${deleteLabel}? ${
          deletingFolder ? "All files inside will also be deleted. " : ""
        }This action cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        loading={actions.deleting}
      />

      <CreateFolderModal
        open={createFolderOpen}
        onClose={() => setCreateFolderOpen(false)}
        onCreate={actions.createFolder}
      />

      <RenameItemModal
        open={renameOpen}
        item={renameTarget}
        onClose={() => setRenameOpen(false)}
        onRename={actions.rename}
      />

      <FolderColorModal
        open={colorOpen}
        folder={colorTarget}
        onClose={() => setColorOpen(false)}
        onSave={actions.setFolderColor}
      />

      <MoveToFolderModal
        isOpen={moveOpen}
        onClose={() => setMoveOpen(false)}
        onMove={confirmMove}
        itemName={moveTargets.length === 1
          ? (moveTargets[0].displayName ?? moveTargets[0].name)
          : `${moveTargets.length} items`}
        // Every item being moved, so none of them is offered as the place to
        // put the others (or itself).
        excludeIds={moveTargets.map((t) => t.id)}
        // Where the item being moved lives now, which the picker uses to grey
        // out "move here". For a single search hit that is where it was found,
        // not the folder the browser is sitting in.
        currentFolderId={moveTargets.length === 1
          ? locationOf(moveTargets[0])
          : browser.currentFolderId}
        lawFirmId={lawFirmId}
        scope={scope}
        moving={actions.moving}
      />

      <FilePreviewModal
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        file={previewFile}
        lawFirmId={lawFirmId}
        onDownload={() => { if (previewFile) void actions.download(previewFile); }}
      />

      <ClientSharePickerModal
        open={clientShare.picker.open}
        onClose={clientShare.picker.close}
        clients={shareClients}
        initialSelectedIds={clientShare.picker.initialSelectedIds}
        itemLabel={clientShare.picker.label}
        onConfirm={clientShare.picker.confirm}
      />

      <ConfirmModal
        isOpen={!!clientShare.warning}
        onClose={() => clientShare.warning?.close()}
        onConfirm={() => clientShare.warning?.confirm()}
        title={clientShare.warning?.kind === "no-client" ? "No client on this matter" : "Client hasn't joined the portal"}
        message={clientShare.warning?.kind === "no-client"
          ? `This matter has no client yet, so nobody can see ${clientShare.warning?.itemLabel} in the portal. Add a client, or share anyway and it will apply once one is added.`
          : `None of the clients here have a portal account yet, so they can't see ${clientShare.warning?.itemLabel} there. You can still share it now; it will apply once a client joins.`}
        confirmText="Share anyway"
        cancelText="Cancel"
        confirmType="primary"
      />

      {/* Secure external share link (no login required) - distinct from portal sharing */}
      <ShareLinkModal
        open={shareLinkOpen}
        onClose={() => setShareLinkOpen(false)}
        lawFirmId={lawFirmId}
        items={shareLinkItems}
      />

      {/* Kept mounted so its close animation plays; `signFile` holds the
          document so the dialog still has content on the way out. */}
      {signFile && (
        <SignActionModal
          isOpen={signActionOpen}
          onClose={() => setSignActionOpen(false)}
          fileName={signFile.displayName ?? signFile.name}
          objectPath={signFile.objectPath}
          lawFirmId={lawFirmId}
          fileId={signFile.id}
        />
      )}

      <BusyToast message={actions.downloadingLabel} />
      {/* The "Move to..." modal shows its own button spinner; a drag-and-drop
          move has no trigger left on screen once the drop lands, so it needs
          this toast instead. */}
      <BusyToast message={actions.moving && !moveOpen ? "Moving..." : null} />
    </div>
  );
}
