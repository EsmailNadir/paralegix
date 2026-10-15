"use client";

import { useState } from "react";
import { MoreVertical } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import ItemActionMenu, { menuPositionFromEvent, type ItemMenuAction } from "@/components/ui/ItemActionMenu";
import Toast from "@/components/ui/Toast";
import { usePermissions } from "@/contexts/PermissionsContext";
import useNoteLinks from "@/hooks/notesHooks/useNoteLinks";
import mattersService from "@/services/matters.service";
import NoteTaskModal, { NoteTaskFormValue } from "./NoteTaskModal";
import NoteLinkTaskModal from "./NoteLinkTaskModal";
import NoteClientUpdateModal from "./NoteClientUpdateModal";
import FilePickerModal from "@/components/matterComp/FilePickerModal";

/** The URL segment each parent type's detail page lives under. */
const PARENT_URL_SEGMENT: Record<'matter' | 'task' | 'client', string> = {
  matter: 'matters',
  task: 'tasks',
  client: 'clients',
};

interface NoteActionsMenuProps {
  lawFirmId: string;
  parentType: 'matter' | 'task' | 'client';
  parentId: string;
  noteId: string;
  noteSubject?: string;
  noteExcerpt?: string;
  noteContent?: string;
  pinned: boolean;
  canPin: boolean;
  canAddTime: boolean;
  /** Create task / link task / link document / send as client update - matter-only. */
  canLink: boolean;
  /** The print view only exists for matter notes. */
  canPrint: boolean;
  onAddTime: () => void;
  onTogglePin: () => Promise<void>;
  onPrint: () => void;
  /** Runs once a task has been created from this note. */
  onTaskCreated?: () => void;
}

/**
 * The note's overflow menu: connected actions, a copy-link shortcut, print,
 * and pin. Every mutation here (create task, link task, link document)
 * invalidates the notes list itself, so `NoteLinksRow` picks the result up
 * without this component holding any note state of its own.
 */
export default function NoteActionsMenu({
  lawFirmId,
  parentType,
  parentId,
  noteId,
  noteSubject,
  noteExcerpt,
  noteContent,
  pinned,
  canPin,
  canAddTime,
  canLink,
  canPrint,
  onAddTime,
  onTogglePin,
  onPrint,
  onTaskCreated,
}: NoteActionsMenuProps) {
  const { hasPermission } = usePermissions();
  // Matter-only mutations (create/link task, link file); safe to call inertly
  // for task/client notes since canLink already keeps them from ever firing.
  const links = useNoteLinks(lawFirmId, parentId);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ anchorTop: number; anchorBottom: number; right: number } | null>(null);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [linkTaskModalOpen, setLinkTaskModalOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [clientUpdateModalOpen, setClientUpdateModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pinning, setPinning] = useState(false);

  const canCreateTask = canLink && hasPermission("tasks.create");
  const canShare = canLink && hasPermission("messaging.send");

  const sendClientUpdate = useMutation({
    mutationFn: (message: string) => mattersService.sendNoteAsClientUpdate(lawFirmId, parentId, noteId, { message }),
  });

  const handleCopyLink = async () => {
    setMenuOpen(false);
    try {
      const url = `${window.location.origin}/lawfirm/${lawFirmId}/${PARENT_URL_SEGMENT[parentType]}/${parentId}?tab=notes&note=${noteId}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by the browser; there is nothing more
      // to do here than let the user copy the URL from the address bar.
    }
  };

  const handleTogglePin = async () => {
    setMenuOpen(false);
    setPinning(true);
    try {
      await onTogglePin();
    } finally {
      setPinning(false);
    }
  };

  const handleCreateTask = async (value: NoteTaskFormValue) => {
    await links.createTask.mutateAsync({ noteId, task: value });
    setTaskModalOpen(false);
    onTaskCreated?.();
  };

  const handleLinkTask = async (taskId: string) => {
    await links.linkTask.mutateAsync({ noteId, taskId });
    setLinkTaskModalOpen(false);
  };

  const handleFilesSelected = async (files: { fileId: string }[]) => {
    // Sequential rather than Promise.all: a failure on one file surfaces its
    // own error without racing the rest.
    for (const file of files) {
      await links.linkFile.mutateAsync({ noteId, fileId: file.fileId });
    }
    setFilePickerOpen(false);
  };

  const handleSendClientUpdate = async (message: string) => {
    await sendClientUpdate.mutateAsync(message);
    setClientUpdateModalOpen(false);
  };

  return (
    <>
      <button
        type="button"
        aria-label="More actions"
        data-item-menu-trigger
        onClick={(e) => {
          e.stopPropagation();
          if (menuOpen) { setMenuOpen(false); return; }
          setMenuPos(menuPositionFromEvent(e));
          setMenuOpen(true);
        }}
        className="flex-shrink-0 p-1.5 rounded-lg border border-outline-subtle bg-surface-alt text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface active:bg-surface-hover transition-[background-color,border-color,color] cursor-pointer"
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      <ItemActionMenu
        open={menuOpen}
        anchorTop={menuPos?.anchorTop ?? 0}
        anchorBottom={menuPos?.anchorBottom ?? 0}
        right={menuPos?.right ?? 0}
        onClose={() => setMenuOpen(false)}
        actions={([
          canCreateTask && { key: 'create-task', label: 'Create task', onClick: () => { setMenuOpen(false); setTaskModalOpen(true); } },
          canLink && { key: 'link-task', label: 'Link existing task', onClick: () => { setMenuOpen(false); setLinkTaskModalOpen(true); } },
          canLink && { key: 'link-file', label: 'Link document', onClick: () => { setMenuOpen(false); setFilePickerOpen(true); } },
          canAddTime && { key: 'add-time', label: 'Add time', onClick: () => { setMenuOpen(false); onAddTime(); } },
          { key: 'copy-link', label: 'Copy link', onClick: () => { void handleCopyLink(); } },
          canPrint && { key: 'print', label: 'Print', onClick: () => { setMenuOpen(false); onPrint(); } },
          canPin && { key: 'pin', label: pinned ? 'Unpin note' : 'Pin note', onClick: () => { void handleTogglePin(); }, disabled: pinning },
          canShare && { key: 'client-update', label: 'Send as client update', onClick: () => { setMenuOpen(false); setClientUpdateModalOpen(true); } },
        ] as Array<ItemMenuAction | false>).filter((a): a is ItemMenuAction => Boolean(a))}
      />

      {canCreateTask && (
        <NoteTaskModal
          lawFirmId={lawFirmId}
          isOpen={taskModalOpen}
          onClose={() => setTaskModalOpen(false)}
          onSubmit={handleCreateTask}
          submitting={links.createTask.isPending}
          defaultTitle={noteSubject}
          defaultDescription={noteExcerpt}
        />
      )}

      {canLink && (
        <NoteLinkTaskModal
          isOpen={linkTaskModalOpen}
          onClose={() => setLinkTaskModalOpen(false)}
          onSubmit={handleLinkTask}
          submitting={links.linkTask.isPending}
          lawFirmId={lawFirmId}
        />
      )}

      {canLink && (
        <FilePickerModal
          open={filePickerOpen}
          onClose={() => setFilePickerOpen(false)}
          onSelect={handleFilesSelected}
          lawFirmId={lawFirmId}
          matterId={parentId}
        />
      )}

      {canShare && (
        <NoteClientUpdateModal
          isOpen={clientUpdateModalOpen}
          onClose={() => setClientUpdateModalOpen(false)}
          onSubmit={handleSendClientUpdate}
          submitting={sendClientUpdate.isPending}
          lawFirmId={lawFirmId}
          matterId={parentId}
          defaultMessage={noteContent}
        />
      )}

      {copied && <Toast message="Link copied" tone="success" onDismiss={() => setCopied(false)} duration={2000} />}
    </>
  );
}
