"use client";

import {
  Download,
  Eye,
  EyeOff,
  FolderInput,
  FolderOpen,
  Link2,
  Palette,
  PenLine,
  Pencil,
  Trash2,
} from "lucide-react";
import type { FileInfo } from "@/services/files.service";
import type { ItemMenuAction } from "@/components/ui/ItemActionMenu";

/** File types the signing flow can produce a signable document from. */
const SIGNABLE_EXTENSIONS = [".pdf", ".docx", ".doc", ".odt", ".rtf", ".txt"];

export function isSignableFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SIGNABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** What a surface lets the user do, so the menus offer only actions that exist there. */
export interface FileActionCapabilities {
  canManageFolders: boolean;
  canDeleteFiles: boolean;
  canShareFiles: boolean;
  /** This scope can share with the client portal at all. */
  canShareWithClient: boolean;
  /** The open folder (or an ancestor) is shared, so items inside inherit it. */
  inheritedShared: boolean;
  /** Object paths with a share request in flight. */
  pendingShareIds: Set<string>;
  /** Omitted on surfaces without a signing entry point. */
  onSendForSignature?: (file: FileInfo) => void;
  /** Omitted on surfaces without external share links. A folder can be shared too. */
  onCreateShareLink?: (file: FileInfo) => void;
}

export interface RowActionHandlers {
  onOpen: (file: FileInfo) => void;
  onDownload: (file: FileInfo) => void;
  onToggleClientVisibility: (file: FileInfo) => void;
  onRename: (file: FileInfo) => void;
  onMove: (file: FileInfo) => void;
  onChangeColor: (file: FileInfo) => void;
  onDelete: (file: FileInfo) => void;
}

/**
 * The per-row action menu for one file or folder.
 *
 * Falsy entries are dropped by `ItemActionMenu`, so a permission or a surface that
 * doesn't offer an action simply contributes nothing.
 */
export function rowActionsFor(
  item: FileInfo,
  caps: FileActionCapabilities,
  handlers: RowActionHandlers
): Array<ItemMenuAction | false | null | undefined> {
  const isFolder = !!item.isFolder;
  // Visible through an ancestor folder, so it cannot be unshared on its own.
  const sharedViaFolder = caps.canShareWithClient && caps.inheritedShared && !item.clientVisible;
  const effectivelyVisible =
    caps.canShareWithClient && (!!item.clientVisible || caps.inheritedShared);

  return [
    {
      key: "open",
      label: isFolder ? "Open" : "Preview",
      icon: isFolder ? <FolderOpen size={15} /> : <Eye size={15} />,
      onClick: () => handlers.onOpen(item),
    },
    {
      key: "download",
      label: isFolder ? "Download as ZIP" : "Download",
      icon: <Download size={15} />,
      onClick: () => handlers.onDownload(item),
    },
    !isFolder && !!caps.onSendForSignature && isSignableFile(item.name) && {
      key: "sign",
      label: "Send for signature",
      icon: <PenLine size={15} />,
      onClick: () => caps.onSendForSignature?.(item),
    },
    caps.canShareFiles && !!caps.onCreateShareLink && {
      key: "share-link",
      label: "Create share link",
      icon: <Link2 size={15} />,
      onClick: () => caps.onCreateShareLink?.(item),
    },
    caps.canShareWithClient && (sharedViaFolder
      ? {
        key: "shared-via-folder",
        label: "Shared via folder",
        icon: <Eye size={15} />,
        disabled: true,
        onClick: () => {},
      }
      : {
        key: "client-visibility",
        label: effectivelyVisible ? "Hide from client" : "Make visible to client",
        icon: effectivelyVisible ? <EyeOff size={15} /> : <Eye size={15} />,
        disabled: caps.pendingShareIds.has(item.id),
        onClick: () => handlers.onToggleClientVisibility(item),
      }),
    caps.canManageFolders && {
      key: "rename",
      label: "Rename",
      icon: <Pencil size={15} />,
      onClick: () => handlers.onRename(item),
    },
    caps.canManageFolders && {
      key: "move",
      label: "Move to…",
      icon: <FolderInput size={15} />,
      onClick: () => handlers.onMove(item),
    },
    caps.canManageFolders && isFolder && {
      key: "color",
      label: "Change color",
      icon: <Palette size={15} />,
      onClick: () => handlers.onChangeColor(item),
    },
    caps.canDeleteFiles && {
      key: "delete",
      label: "Delete",
      icon: <Trash2 size={15} />,
      danger: true,
      onClick: () => handlers.onDelete(item),
    },
  ];
}

export interface BulkActionHandlers {
  onSetClientVisibility: (visible: boolean) => void;
  onDownload: () => void;
  onSendForSignature: (file: FileInfo) => void;
  onMove: () => void;
  onDelete: () => void;
  /** One external link to the whole selection. */
  onCreateShareLink: () => void;
}

/**
 * The bulk-action menu for the current selection.
 *
 * "Send for signature" is offered only for a single signable file, because the
 * signing flow takes one document.
 */
export function bulkActionsFor(
  selected: FileInfo[],
  caps: FileActionCapabilities,
  handlers: BulkActionHandlers
): Array<ItemMenuAction | false | null | undefined> {
  const anyHidden = selected.some((f) => !f.clientVisible);
  const anyVisible = selected.some((f) => f.clientVisible);
  const signable =
    selected.length === 1 && !selected[0].isFolder && isSignableFile(selected[0].name)
      ? selected[0]
      : null;

  return [
    caps.canShareWithClient && caps.canShareFiles && {
      key: "share",
      label: "Make visible to client",
      icon: <Eye size={15} />,
      disabled: !anyHidden,
      onClick: () => handlers.onSetClientVisibility(true),
    },
    caps.canShareWithClient && caps.canShareFiles && {
      key: "hide",
      label: "Hide from client",
      icon: <EyeOff size={15} />,
      disabled: !anyVisible,
      onClick: () => handlers.onSetClientVisibility(false),
    },
    {
      key: "download",
      label: "Download",
      icon: <Download size={15} />,
      onClick: handlers.onDownload,
    },
    !!signable && !!caps.onSendForSignature && {
      key: "sign",
      label: "Send for signature",
      icon: <PenLine size={15} />,
      onClick: () => handlers.onSendForSignature(signable),
    },
    caps.canShareFiles && !!caps.onCreateShareLink && {
      key: "share-link",
      label: "Create share link",
      icon: <Link2 size={15} />,
      onClick: handlers.onCreateShareLink,
    },
    caps.canManageFolders && {
      key: "move",
      label: "Move to…",
      icon: <FolderInput size={15} />,
      onClick: handlers.onMove,
    },
    caps.canDeleteFiles && {
      key: "delete",
      label: "Delete",
      icon: <Trash2 size={15} />,
      danger: true,
      onClick: handlers.onDelete,
    },
  ];
}
