"use client";

import type React from "react";
import { useEffect, useRef } from "react";
import dayjs from "dayjs";
import Tooltip from "@/components/ui/Tooltip";
import FilesService, { type FileInfo } from "@/services/files.service";
import { MoreVertical, Eye, ChevronRight, Folder as FolderIcon, FileText, Image as ImageIcon, AlertTriangle } from "lucide-react";
import Checkbox from "@/components/ui/Checkbox";
import { AutoPager } from "@/components/ui/ListPager";
import usePagedRows from "@/hooks/usePagedRows";

import type { FolderColorDef } from "./folderColors";
export type { FolderColorDef };

interface SharedRowProps {
  getFolderColor: (f: FileInfo) => FolderColorDef;
  isSearching: boolean;
  /** True in a matter/task context, where files can be shared with the client portal. */
  shareContext: boolean;
  /** Number of clients on the matter/task; lets a directly-shared row show whether
   *  it's limited to specific clients ("Visible to N of M"). */
  shareClientCount?: number;
  /** Clients on the matter/task (id + name); used to name the recipients in the
   *  share-badge tooltip when an item is shared with only some of them. */
  shareClients?: { id: string; name: string }[];
  /** True when the current folder (or an ancestor) is shared, so items inherit visibility. */
  inheritedShared: boolean;
  canManageFolders: boolean;
  // Drag-and-drop (folders are drop targets). Optional. Pass enableDrag to turn
  // it on along with the handlers; surfaces without move-by-drag omit these.
  enableDrag?: boolean;
  draggedItem?: FileInfo | null;
  dragOverFolder?: string | null;
  onDragStart?: (e: React.DragEvent, f: FileInfo) => void;
  onDragEnd?: () => void;
  onDragOver?: (e: React.DragEvent, folderId?: string) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent, folderId?: string) => void;
  // Open (preview a file / navigate into a folder) and the per-row action menu
  onOpen: (f: FileInfo) => void;
  onOpenMenu: (e: React.MouseEvent, f: FileInfo) => void;
  // Per-row selection for bulk actions (checkbox reveals on hover / when checked)
  selectedIds: Set<string>;
  onToggleSelect: (f: FileInfo) => void;
  /** Scrolled into view and briefly flashed once, e.g. when arriving from a
   *  document request's fulfillment list. */
  highlightFileId?: string | null;
}

interface FileRowListProps extends SharedRowProps {
  files: FileInfo[];
  /** Rows listed above the files, e.g. `LinkedFolderRow`s. */
  leadingRows?: React.ReactNode;
}

/**
 * A folder that opens another file area rather than a folder in this one: a
 * client's matters, listed at the root of the client's own files. It looks like
 * a folder row but carries no checkbox or action menu, since it is not an item
 * this browser can select, move, share or delete.
 */
export interface LinkedFolder {
  id: string;
  name: string;
  /** The muted second line, where a real folder shows its counts. */
  subtitle: string;
  /** Says what kind of area the folder opens, at the row's right. */
  badge?: React.ReactNode;
  onOpen: () => void;
}

export function LinkedFolderRow({ folder, color }: { folder: LinkedFolder; color: FolderColorDef }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={folder.onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          folder.onOpen();
        }
      }}
      className="group flex items-center gap-3 px-4 sm:px-5 py-3.5 transition-colors cursor-pointer hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset"
    >
      <div className={`p-2 rounded-xl ${color.bg} ${color.darkBg} flex-shrink-0`}>
        <FolderIcon className={`w-4 h-4 ${color.icon}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-on-surface truncate">{folder.name}</p>
        <p className="text-[11px] text-on-surface-muted mt-0.5 truncate">{folder.subtitle}</p>
      </div>
      {folder.badge && <span className="flex-shrink-0">{folder.badge}</span>}
      <ChevronRight className="w-4 h-4 text-on-surface-muted flex-shrink-0" />
    </div>
  );
}

function FileTypeIcon({ type }: { type: string }) {
  const cls = "w-4 h-4";
  let icon = <FileText className={`${cls} text-blue-500`} />;
  if (type.includes("image")) icon = <ImageIcon className={`${cls} text-purple-500`} />;
  else if (type.includes("pdf")) icon = <FileText className={`${cls} text-rose-500`} />;
  return <div className="p-2 rounded-xl bg-surface-alt flex-shrink-0">{icon}</div>;
}

function rowSubtitle(file: FileInfo, isSearching: boolean): string {
  if (file.isFolder) {
    if (isSearching && file.folderPath) return `in ${file.folderPath}`;
    const parts: string[] = [];
    if (file.fileCount) parts.push(`${file.fileCount} file${file.fileCount === 1 ? "" : "s"}`);
    if (file.folderCount) parts.push(`${file.folderCount} folder${file.folderCount === 1 ? "" : "s"}`);
    return parts.join(" · ") || "Empty";
  }
  const size = FilesService.formatFileSize(file.size);
  const date = dayjs(file.updated).format("MMM D, YYYY");
  if (isSearching && file.folderPath) return `in ${file.folderPath} · ${size}`;
  return `${size} · ${date}`;
}

function FileRow({ file, ...props }: SharedRowProps & { file: FileInfo }) {
  const {
    getFolderColor,
    isSearching,
    shareContext,
    shareClientCount,
    shareClients,
    inheritedShared,
    canManageFolders,
    enableDrag = false,
    draggedItem,
    dragOverFolder,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDragLeave,
    onDrop,
    onOpen,
    onOpenMenu,
    selectedIds,
    onToggleSelect,
    highlightFileId,
  } = props;

  const isFolder = !!file.isFolder;
  const color = isFolder ? getFolderColor(file) : null;
  const selected = selectedIds.has(file.id);
  const dragOn = enableDrag && canManageFolders;
  const highlighted = !!highlightFileId && file.id === highlightFileId;
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);

  // Visible to the client if shared directly OR via an ancestor folder; an
  // inherited item shows a muted "Via folder" hint and can't be unshared alone.
  const sharedViaFolder = shareContext && inheritedShared && !file.clientVisible;
  const effectiveVisible = shareContext && (!!file.clientVisible || inheritedShared);
  // Explicit ids restrict the item to a subset of clients; a directly-shared item
  // with no explicit ids reaches every client on the matter/task, so its recipients
  // are the full client list.
  const explicitIds =
    !!file.clientVisible && Array.isArray(file.visibleClientIds) && file.visibleClientIds.length > 0
      ? file.visibleClientIds
      : null;
  // The actual people who can see this item, resolved to names. Empty when the
  // matter/task has no client on it (or when the caller didn't provide the list).
  const recipientNames = explicitIds
    ? explicitIds
        .map((id) => shareClients?.find((c) => c.id === id)?.name)
        .filter((n): n is string => !!n)
    : (shareClients ?? []).map((c) => c.name);
  // True when limited to some (not all) of the matter/task's clients.
  const restrictedToSome =
    explicitIds !== null && !!shareClientCount && explicitIds.length < shareClientCount;
  // Marked visible to all clients, but there's no client on the matter/task to
  // receive it, so no one can actually see the file. Surface it instead of
  // implying a real recipient. (Explicit ids always mean real clients were
  // chosen, so this only applies to the share-with-everyone case.)
  const noRecipient =
    !!file.clientVisible && !sharedViaFolder && explicitIds === null && recipientNames.length === 0;

  const visibleLabel = sharedViaFolder
    ? "Via folder"
    : noRecipient
      ? "No client"
      : recipientNames.length === 1
        ? `Visible to ${recipientNames[0]}`
        : recipientNames.length > 1
          ? `Visible to ${recipientNames[0]} +${recipientNames.length - 1}`
          : "Visible";

  return (
    <div
      ref={rowRef}
      draggable={dragOn}
      onDragStart={(e) => dragOn && onDragStart?.(e, file)}
      onDragEnd={() => dragOn && onDragEnd?.()}
      onDragOver={(e) => dragOn && onDragOver?.(e, isFolder ? file.id : undefined)}
      onDragLeave={() => dragOn && onDragLeave?.()}
      onDrop={(e) => dragOn && isFolder && onDrop?.(e, file.id)}
      onContextMenu={(e) => onOpenMenu(e, file)}
      onClick={() => onOpen(file)}
      className={`group flex items-center gap-3 px-4 sm:px-5 py-3.5 transition-colors cursor-pointer ${
        dragOverFolder === file.id
          ? "bg-blue-50 dark:bg-blue-900/20"
          : selected
            ? "bg-blue-50/60 dark:bg-blue-900/20"
            : "hover:bg-surface-hover"
      } ${draggedItem?.name === file.name ? "opacity-50" : ""} ${highlighted ? "file-row-highlight" : ""}`}
    >
      <label
        onClick={(e) => e.stopPropagation()}
        className="flex-shrink-0 flex items-center justify-center p-1.5 -m-1.5 cursor-pointer"
      >
        <Checkbox
          checked={selected}
          onChange={() => onToggleSelect(file)}
          size="md"
        />
      </label>

      {isFolder && color ? (
        <div className={`p-2 rounded-xl ${color.bg} ${color.darkBg} flex-shrink-0`}>
          <FolderIcon className={`w-4 h-4 ${color.icon}`} />
        </div>
      ) : (
        <FileTypeIcon type={file.contentType || ""} />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-on-surface truncate">{file.displayName ?? file.name}</p>
          {file.taskTitle && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border border-blue-200 dark:border-blue-700 whitespace-nowrap shrink-0">
              {file.taskTitle}
            </span>
          )}
        </div>
        <p className="text-[11px] text-on-surface-muted mt-0.5 truncate">{rowSubtitle(file, isSearching)}</p>
      </div>

      {effectiveVisible && (() => {
        const badge = (
          <span
            className={`flex-shrink-0 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium max-w-[13rem] ${
              noRecipient
                ? "text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border border-amber-500/40"
                : sharedViaFolder
                  ? "text-emerald-600/70 dark:text-emerald-400/70"
                  : "text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-500/40"
            }`}
          >
            {noRecipient ? <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> : <Eye className="w-3.5 h-3.5 shrink-0" />}
            <span className="truncate">{visibleLabel}</span>
          </span>
        );
        // Always explain the badge on hover so a new user understands who the item is
        // shared with; name the specific clients, warn when no client can see it, and
        // note inheritance when it's shared through a parent folder.
        const tooltip = sharedViaFolder
          ? "Visible to the client, shared through a parent folder"
          : noRecipient
            ? "Marked visible to clients, but no client is assigned here yet, so no one can see it."
            : recipientNames.length > 0
              ? `${restrictedToSome ? "Visible only to" : "Visible to"}: ${recipientNames.join(", ")}`
              : "Visible to the client";
        return (
          <Tooltip title={tooltip} enterDelay={300}>
            {badge}
          </Tooltip>
        );
      })()}

      {/* No tooltip: the button opens a menu that names every action it holds,
          so a hover label only covers it. */}
      <button
        type="button"
        aria-label="More actions"
        // The outside-click close listener (on document) skips this element so a
        // second click toggles the menu shut instead of closing-then-reopening it.
        // A plain stopPropagation can't do that here: React's event root is the
        // document, so the sibling native listener still fires.
        data-item-menu-trigger
        onClick={(e) => {
          e.stopPropagation();
          onOpenMenu(e, file);
        }}
        className="flex-shrink-0 p-1.5 rounded-lg border border-outline-subtle bg-surface-alt text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface active:bg-surface-hover transition-[background-color,border-color,color] cursor-pointer"
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {isFolder && <ChevronRight className="w-4 h-4 text-on-surface-muted flex-shrink-0" />}
    </div>
  );
}

export default function FileRowList({ files, leadingRows, ...shared }: FileRowListProps) {
  // A firm-wide document root or a discovery-heavy matter folder routinely holds
  // thousands of entries, and `/list-folder` returns a whole folder at once, so
  // the rows are paged here. Paging inside this component covers both the Files
  // page and the matter/client file managers without either passing a prop.
  // Navigating into a folder or running a search replaces the list entirely, so
  // paging restarts. This component isn't told which folder it is showing, so
  // the scope is derived from the list itself: a different first entry, or a
  // different length, means a different listing.
  const pager = usePagedRows(files, 50, `${files.length}:${files[0]?.id ?? ""}`);

  return (
    <div className="bg-surface rounded-2xl border border-outline-subtle overflow-hidden min-h-[16rem] h-full">
      <div className="divide-y divide-outline-subtle">
        {leadingRows}
        {pager.pagedRows.map((file) => (
          <FileRow key={file.id} file={file} {...shared} />
        ))}
      </div>
      {pager.total > pager.rowsPerPage && (
        <div className="border-t border-outline-subtle px-4 py-3">
          <AutoPager pager={pager} />
        </div>
      )}
    </div>
  );
}
