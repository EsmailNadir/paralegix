"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Download,
  Eye,
  FolderInput,
  FolderPlus,
  FolderTree,
  LayoutList,
  Pencil,
  Trash2,
} from "lucide-react";
import { templatesService } from "@/services/templates.service";
import type { Template, TemplateFillDraft, TemplateFolder, TemplateWithHtml } from "@/types/template";
import ErrorNotification from "@/components/ErrorNotification";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import ConfirmModal from "@/components/ui/ConfirmModal";
import PageHeader from "@/components/ui/PageHeader";
import TabBar from "@/components/ui/TabBar";
import ItemActionMenu, { menuPositionFromEvent } from "@/components/ui/ItemActionMenu";
import AllTemplatesTab from "./AllTemplatesTab";
import FillTemplateModal from "./FillTemplateModal";
import FoldersTab from "./FoldersTab";
import MoveTemplateModal from "./MoveTemplateModal";
import TemplateCreatePanel from "./TemplateCreatePanel";
import TemplateFolderModal from "./TemplateFolderModal";
import TemplatePreviewModal from "./TemplatePreviewModal";
import useTemplatePreview from "./useTemplatePreview";
import { folderPathLabel } from "./folderPaths";
import { getErrorMessage } from "@/lib/utils/apiErrors";

export type TemplatesTab = "all" | "folders";

/** What a row's action menu is acting on. */
type MenuTarget =
  | { kind: "folder"; folder: TemplateFolder }
  | { kind: "template"; template: Template };

type WorkspaceMenu = MenuTarget & { anchorTop: number; anchorBottom: number; right: number };

interface TemplatesWorkspaceProps {
  lawFirmId: string;
  /** Which view to open on, from the `tab` query parameter. */
  initialTab: TemplatesTab;
  /** Which folder the Folders tab opens on, from the `folder` query parameter. */
  initialFolderId?: string | null;
  /** Controls shown at the right of the page header (the template version switch). */
  headerActions?: React.ReactNode;
  /** Where a picked document goes: an overlay draft (default) or straight to the full editor. */
  createMode?: "overlay" | "full-editor";
  /** A document picked in `full-editor` mode, with the folder it will be filed in. */
  onDocumentPicked?: (result: { file: File; folderId: string | null }) => void;
  /** A Document Overlay upload just created a template row; open its editor. */
  onOverlayCreated: (result: { templateId: string; template: TemplateWithHtml; sourceFile: File; folderId: string | null }) => void;
  onEditTemplate: (templateId: string, fillDraft?: TemplateFillDraft, templateType?: Template["type"]) => void;
  initialFillTemplateId?: string;
  initialFillDraft?: TemplateFillDraft;
}

/**
 * The templates library: starting a template, every template the firm has, and
 * the folders they can be filed in, as two views of one page.
 *
 * The page opens on Folders, because that is the shape the firm filed its
 * library in and browsing it a level at a time is how someone who knows where a
 * document lives goes to get it. All templates is the other half of that: one
 * flat searchable set for when the name is known but the location isn't. Folders
 * are optional, so a firm that never made one still gets a usable first screen - 
 * the Folders tab lists the whole unfiled library rather than an empty box.
 * Starting a template stays above the tabs - it is why the page gets opened, and
 * it applies to both views.
 */
export default function TemplatesWorkspace({
  lawFirmId,
  initialTab,
  initialFolderId = null,
  headerActions,
  createMode = "overlay",
  onDocumentPicked,
  onOverlayCreated,
  onEditTemplate,
  initialFillTemplateId,
  initialFillDraft,
}: TemplatesWorkspaceProps) {
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<TemplatesTab>(initialTab);
  const [folderId, setFolderId] = useState<string | null>(initialFolderId);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<WorkspaceMenu | null>(null);
  // Retain the menu's target through its close animation so it doesn't blank out.
  const menuRenderRef = useRef(menu);
  if (menu) menuRenderRef.current = menu;
  const menuRender = menu ?? menuRenderRef.current;

  const [fillTarget, setFillTarget] = useState<Template | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moveTarget, setMoveTarget] = useState<Template | null>(null);
  const [movingTemplateId, setMovingTemplateId] = useState<string | null>(null);
  const [createFolderParentId, setCreateFolderParentId] = useState<string | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [renameFolderTarget, setRenameFolderTarget] = useState<TemplateFolder | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<TemplateFolder | null>(null);
  const [deleteFolderConfirmOpen, setDeleteFolderConfirmOpen] = useState(false);
  const [deletingFolder, setDeletingFolder] = useState(false);

  // Cleared once each confirm dialog is gone, not as it closes: nulling the
  // target while it is still on screen would blank its message mid-animation.
  useResetAfterClose(deleteConfirmOpen, () => setDeleteTarget(null));
  useResetAfterClose(deleteFolderConfirmOpen, () => setDeleteFolderTarget(null));

  // Dialogs keep their content while they animate out, after the state that
  // opened them has been cleared.
  const fillRenderRef = useRef<Template | null>(null);
  if (fillTarget) fillRenderRef.current = fillTarget;
  const fillRender = fillTarget ?? fillRenderRef.current;

  const moveRenderRef = useRef<Template | null>(null);
  if (moveTarget) moveRenderRef.current = moveTarget;
  const moveRender = moveTarget ?? moveRenderRef.current;

  const renameRenderRef = useRef<TemplateFolder | null>(null);
  if (renameFolderTarget) renameRenderRef.current = renameFolderTarget;
  const renameRender = renameFolderTarget ?? renameRenderRef.current;

  const preview = useTemplatePreview(lawFirmId, setError);

  const { data: templates = [], isLoading } = useQuery<Template[]>({
    queryKey: ["templates", lawFirmId],
    queryFn: () => templatesService.list(lawFirmId),
    enabled: !!lawFirmId,
  });

  const { data: folders = [], isLoading: isFoldersLoading } = useQuery<TemplateFolder[]>({
    queryKey: ["templateFolders", lawFirmId],
    queryFn: () => templatesService.listFolders(lawFirmId),
    enabled: !!lawFirmId,
  });

  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const openFolder = folderId ? folderById.get(folderId) ?? null : null;

  /* ------------------------------ navigation ------------------------------ */

  // The tab and the open folder are part of the address, so a view can be linked
  // to and survives a reload. Neither is a route change: `navigate()` would push
  // one (and hold its loading indicator, which only clears on a pathname change)
  // for a swap of content already on the page.
  const writeHistory = (
    nextTab: TemplatesTab,
    nextFolderId: string | null,
    mode: "push" | "replace"
  ) => {
    if (typeof window === "undefined") return;

    const url = new URL(window.location.href);
    if (nextTab === "folders") url.searchParams.delete("tab");
    else url.searchParams.set("tab", nextTab);
    if (nextFolderId) url.searchParams.set("folder", nextFolderId);
    else url.searchParams.delete("folder");

    const state = {
      ...window.history.state,
      templatesTab: nextTab,
      templatesFolderId: nextFolderId,
    };
    const href = `${url.pathname}${url.search}`;

    if (mode === "push") window.history.pushState(state, "", href);
    else window.history.replaceState(state, "", href);
  };

  // Stamp the entry the page loaded on with the view it is actually showing, so
  // returning to it later restores that view rather than the default one.
  useEffect(() => {
    writeHistory(initialTab, initialFolderId, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time seeding of the entry the page arrived on
  }, []);

  const selectTab = (next: TemplatesTab) => {
    setMenu(null);
    setTab(next);
    writeHistory(next, folderId, "replace");
  };

  // Opening a folder pushes an entry, so the browser Back button walks back up
  // the path it was opened from instead of leaving the page.
  const navigateToFolder = (next: string | null) => {
    setMenu(null);
    if (next === folderId) return;
    setFolderId(next);
    writeHistory("folders", next, "push");
  };

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      // Entries carrying an editor marker belong to the template editor; the
      // templates page reopens it and unmounts this workspace.
      if (event.state?.templatesEditor) return;

      setTab(event.state?.templatesTab === "all" ? "all" : "folders");
      setFolderId(event.state?.templatesFolderId ?? null);
      setMenu(null);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // A folder deleted in another tab (or by another member) leaves this pointed at
  // something that no longer exists, so fall back to the top level.
  useEffect(() => {
    if (folderId && !isFoldersLoading && !openFolder) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- recovers from a selection whose folder is gone
      setFolderId(null);
    }
  }, [folderId, openFolder, isFoldersLoading]);

  /* ------------------------------- mutations ------------------------------ */

  const handleDeleteTemplate = async () => {
    if (!deleteTarget) return;
    setDeleting(true);

    try {
      const deletedId = deleteTarget.id;
      await templatesService.delete(lawFirmId, deletedId);
      setDeleteConfirmOpen(false);
      queryClient.setQueryData<Template[]>(
        ["templates", lawFirmId],
        (old) => old?.filter((template) => template.id !== deletedId) ?? []
      );
      queryClient.invalidateQueries({ queryKey: ["templates", lawFirmId] });
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete template."));
    } finally {
      setDeleting(false);
    }
  };

  // A refusal rejects back into the move dialog, which stays open and shows it.
  const handleMoveTemplate = async (templateId: string, destinationId: string | null) => {
    setMovingTemplateId(templateId);

    try {
      await templatesService.moveTemplateToFolder(lawFirmId, templateId, destinationId);
      setMoveTarget(null);
      queryClient.invalidateQueries({ queryKey: ["templates", lawFirmId] });
    } finally {
      setMovingTemplateId(null);
    }
  };

  const handleCreateFolder = async (name: string) => {
    await templatesService.createFolder(lawFirmId, {
      name,
      parentFolderId: createFolderParentId,
    });
    queryClient.invalidateQueries({ queryKey: ["templateFolders", lawFirmId] });
    setCreateFolderOpen(false);
  };

  const handleRenameFolder = async (name: string) => {
    if (!renameFolderTarget) return;

    await templatesService.updateFolder(lawFirmId, renameFolderTarget.id, { name });
    queryClient.invalidateQueries({ queryKey: ["templateFolders", lawFirmId] });
    setRenameFolderTarget(null);
  };

  const handleDeleteFolder = async () => {
    if (!deleteFolderTarget) return;
    setDeletingFolder(true);

    try {
      const deletedId = deleteFolderTarget.id;
      const parentId = deleteFolderTarget.parentFolderId ?? null;
      await templatesService.deleteFolder(lawFirmId, deletedId);

      if (folderId === deletedId) {
        // Rewrite the current history entry in place; pushing here would let the
        // browser Back button return to the deleted folder.
        setFolderId(parentId);
        writeHistory("folders", parentId, "replace");
      }

      setDeleteFolderConfirmOpen(false);
      queryClient.setQueryData<TemplateFolder[]>(
        ["templateFolders", lawFirmId],
        (old) => old?.filter((folder) => folder.id !== deletedId) ?? []
      );
      queryClient.setQueryData<Template[]>(
        ["templates", lawFirmId],
        (old) =>
          old?.map((template) =>
            template.folderId === deletedId ? { ...template, folderId: parentId } : template
          ) ?? []
      );
      queryClient.invalidateQueries({ queryKey: ["templateFolders", lawFirmId] });
      queryClient.invalidateQueries({ queryKey: ["templates", lawFirmId] });
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete folder."));
    } finally {
      setDeletingFolder(false);
    }
  };

  const openCreateFolder = (parentFolderId: string | null) => {
    setCreateFolderParentId(parentFolderId);
    setCreateFolderOpen(true);
  };

  /* ------------------------- fill deep link on load ----------------------- */

  // The page can hand back a template to fill (returning from the editor via the
  // fill modal); reopen it once the list it belongs to has loaded.
  const autoOpenedFillRef = useRef(false);
  useEffect(() => {
    if (!initialFillTemplateId || autoOpenedFillRef.current || isLoading) return;

    const template = templates.find((candidate) => candidate.id === initialFillTemplateId);
    if (!template) return;

    autoOpenedFillRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time reopen of the fill modal once its template loads (guarded by a ref)
    setFillTarget(template);
  }, [initialFillTemplateId, templates, isLoading]);

  /* -------------------------------- render -------------------------------- */

  const openMenuFor = (event: React.MouseEvent, next: MenuTarget) => {
    event.preventDefault();
    const sameTarget =
      menu &&
      ((menu.kind === "folder" &&
        next.kind === "folder" &&
        menu.folder.id === next.folder.id) ||
        (menu.kind === "template" &&
          next.kind === "template" &&
          menu.template.id === next.template.id));

    // Clicking the same row's kebab again toggles the menu closed; a right-click
    // re-anchors it at the cursor instead.
    if (sameTarget && event.type !== "contextmenu") {
      setMenu(null);
      return;
    }

    setMenu({ ...next, ...menuPositionFromEvent(event) });
  };

  // A template started from the Folders tab is filed where the user is standing.
  const destinationFolderId = tab === "folders" ? folderId : null;

  return (
    <div className="min-h-screen bg-page">
      <div className="mx-auto min-w-0 max-w-[1600px] space-y-5 p-4 pl-5 md:p-6">
        <PageHeader
          eyebrow="Document Templates"
          title="Templates"
          description="Build reusable documents once, then fill and download them in seconds."
          actions={headerActions}
        />

        <TemplateCreatePanel
          lawFirmId={lawFirmId}
          folderId={destinationFolderId}
          mode={createMode}
          onDocumentPicked={(file) => onDocumentPicked?.({ file, folderId: destinationFolderId })}
          onOverlayCreated={({ templateId, template, sourceFile }) =>
            onOverlayCreated({ templateId, template, sourceFile, folderId: destinationFolderId })
          }
          onUnsupportedFile={setError}
          onUploadFailed={setError}
          destinationLabel={
            destinationFolderId ? folderPathLabel(folderById, destinationFolderId) : undefined
          }
        />

        <ErrorNotification error={error} onClose={() => setError(null)} />

        <TabBar
          value={tab}
          onChange={selectTab}
          tabs={[
            { value: "folders", label: "Folders", icon: FolderTree, count: folders.length },
            { value: "all", label: "All templates", icon: LayoutList, count: templates.length },
          ]}
        />

        {tab === "all" ? (
          <AllTemplatesTab
            templates={templates}
            folders={folders}
            loading={isLoading}
            previewLoadingId={preview.loadingId}
            onPreview={(template) => void preview.open(template)}
            onFill={(template) => setFillTarget(template)}
            onOpenMenu={(event, template) => openMenuFor(event, { kind: "template", template })}
          />
        ) : (
          <FoldersTab
            templates={templates}
            folders={folders}
            // Both lists decide what this tab shows - with no folders it falls
            // back to listing every template - so it waits on both.
            loading={isFoldersLoading || isLoading}
            folderId={folderId}
            onNavigate={navigateToFolder}
            onCreateFolder={openCreateFolder}
            onOpenFolderMenu={(event, folder) => openMenuFor(event, { kind: "folder", folder })}
            previewLoadingId={preview.loadingId}
            onPreview={(template) => void preview.open(template)}
            onFill={(template) => setFillTarget(template)}
            onOpenTemplateMenu={(event, template) =>
              openMenuFor(event, { kind: "template", template })
            }
          />
        )}
      </div>

      <ItemActionMenu
        open={!!menu}
        anchorTop={menuRender?.anchorTop ?? 0}
        anchorBottom={menuRender?.anchorBottom ?? 0}
        right={menuRender?.right ?? 0}
        onClose={() => setMenu(null)}
        actions={
          !menuRender
            ? []
            : menuRender.kind === "folder"
              ? [
                  {
                    key: "open",
                    label: "Open folder",
                    icon: <ChevronRight size={14} />,
                    onClick: () => navigateToFolder(menuRender.folder.id),
                  },
                  {
                    key: "subfolder",
                    label: "New subfolder",
                    icon: <FolderPlus size={14} />,
                    onClick: () => openCreateFolder(menuRender.folder.id),
                  },
                  {
                    key: "rename",
                    label: "Rename",
                    icon: <Pencil size={14} />,
                    onClick: () => setRenameFolderTarget(menuRender.folder),
                  },
                  {
                    key: "delete",
                    label: "Delete folder",
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onClick: () => {
                      setDeleteFolderTarget(menuRender.folder);
                      setDeleteFolderConfirmOpen(true);
                    },
                  },
                ]
              : [
                  {
                    key: "fill",
                    // The same wording as the row's own button, because it is
                    // the same action - two names read as two behaviours.
                    label: "Fill",
                    icon: <Download size={14} />,
                    onClick: () => setFillTarget(menuRender.template),
                  },
                  {
                    key: "preview",
                    label: "Preview",
                    icon: <Eye size={14} />,
                    onClick: () => preview.open(menuRender.template),
                  },
                  {
                    key: "edit",
                    label: "Edit template",
                    icon: <Pencil size={14} />,
                    onClick: () => onEditTemplate(menuRender.template.id, undefined, menuRender.template.type),
                  },
                  {
                    key: "move",
                    label: "Move to folder",
                    icon: <FolderInput size={14} />,
                    onClick: () => setMoveTarget(menuRender.template),
                  },
                  {
                    key: "delete",
                    label: "Delete template",
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onClick: () => {
                      setDeleteTarget(menuRender.template);
                      setDeleteConfirmOpen(true);
                    },
                  },
                ]
        }
      />

      {fillRender && (
        <FillTemplateModal
          open={Boolean(fillTarget)}
          template={fillRender}
          lawFirmId={lawFirmId}
          onClose={() => setFillTarget(null)}
          onEdit={(templateId, fillDraft) => {
            setFillTarget(null);
            onEditTemplate(templateId, fillDraft, fillRender.type);
          }}
          initialValues={
            fillRender.id === initialFillTemplateId ? initialFillDraft?.values : undefined
          }
          initialRepeaterValues={
            fillRender.id === initialFillTemplateId
              ? initialFillDraft?.repeaterValues
              : undefined
          }
          initialSelectedMatterId={
            fillRender.id === initialFillTemplateId
              ? initialFillDraft?.selectedMatterId
              : undefined
          }
          initialSelectedClientId={
            fillRender.id === initialFillTemplateId
              ? initialFillDraft?.selectedClientId
              : undefined
          }
        />
      )}

      <TemplatePreviewModal
        open={preview.isOpen}
        content={preview.shownContent}
        name={preview.shownName}
        onClose={preview.close}
      />

      <MoveTemplateModal
        open={Boolean(moveTarget)}
        templateName={moveRender?.name ?? ""}
        folders={folders}
        currentFolderId={moveRender?.folderId ?? null}
        moving={movingTemplateId === moveRender?.id}
        onMove={async (destinationId) => {
          if (moveRender) await handleMoveTemplate(moveRender.id, destinationId);
        }}
        onClose={() => setMoveTarget(null)}
      />

      <TemplateFolderModal
        open={createFolderOpen}
        title={createFolderParentId ? "New Subfolder" : "New Folder"}
        initialName=""
        submitLabel="Create"
        contextLabel={`Location: ${folderPathLabel(folderById, createFolderParentId)}`}
        onSubmit={handleCreateFolder}
        onClose={() => setCreateFolderOpen(false)}
      />

      <TemplateFolderModal
        open={Boolean(renameFolderTarget)}
        title="Rename Folder"
        initialName={renameRender?.name ?? ""}
        submitLabel="Save"
        contextLabel={`Location: ${folderPathLabel(
          folderById,
          renameRender?.parentFolderId ?? null
        )}`}
        onSubmit={handleRenameFolder}
        onClose={() => setRenameFolderTarget(null)}
      />

      {deleteTarget && (
        <ConfirmModal
          isOpen={deleteConfirmOpen}
          title="Delete template"
          message={`Are you sure you want to delete "${deleteTarget.name}"? This cannot be undone.`}
          confirmText="Delete"
          confirmType="danger"
          loading={deleting}
          onConfirm={handleDeleteTemplate}
          onClose={() => setDeleteConfirmOpen(false)}
        />
      )}

      {deleteFolderTarget && (
        <ConfirmModal
          isOpen={deleteFolderConfirmOpen}
          title="Delete folder"
          message={`Delete "${deleteFolderTarget.name}"? Templates and subfolders inside will move to ${
            deleteFolderTarget.parentFolderId ? "the parent folder" : "the top level"
          }.`}
          confirmText="Delete"
          confirmType="danger"
          loading={deletingFolder}
          onConfirm={handleDeleteFolder}
          onClose={() => setDeleteFolderConfirmOpen(false)}
        />
      )}
    </div>
  );
}
