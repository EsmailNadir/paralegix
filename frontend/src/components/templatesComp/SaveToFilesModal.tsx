"use client";

import useFileDestinationLookup from "@/hooks/fileHooks/useFileDestinationLookup";

import useFolderBrowser from "@/hooks/fileHooks/useFolderBrowser";
import FolderBrowserBody, { FolderBrowserRows } from "@/components/filesComp/FolderBrowserBody";

import { useId, useState, useEffect, useCallback } from "react";
import { X, ChevronRight, FolderUp, BriefcaseBusiness, ListChecks, UserRound, Search, FolderPlus, Check } from "lucide-react";
import filesService, { FileInfo } from "@/services/files.service";
import { type FileScope, scopeFromIds } from "@/lib/files/fileScope";

import type { Matter, Task, Client } from "@/types";
import Button from "@/components/ui/Button";
import ErrorNotification from "@/components/ErrorNotification";
import ListSkeleton from "@/components/ui/ListSkeleton";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import Modal from "@/components/ui/Modal";
import { lookupOverflowNote } from "@/lib/constants/search";
import TruncatedListNotice from "@/components/ui/TruncatedListNotice";
import { taskStatusMeta } from "@/constants/statusMeta";
import Spinner from "@/components/ui/Spinner";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";

export interface SaveDestination {
  scope: "matter" | "task" | "client" | "general";
  matterId?: string;
  taskId?: string;
  clientId?: string;
  folderId?: string;
  fileName: string;
}

interface SaveToFilesModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (destination: SaveDestination) => void;
  lawFirmId: string;
  defaultMatterId?: string;
  defaultFileName: string;
  saving?: boolean;
}

type TabScope = "matters" | "tasks" | "clients" | "general";

/** The file scope one of this modal's destination tabs addresses. */
const folderScope = (tab: TabScope, entityId: string | null): FileScope =>
  scopeFromIds({
    matterId: tab === "matters" ? entityId : null,
    taskId: tab === "tasks" ? entityId : null,
    clientId: tab === "clients" ? entityId : null,
  });

export default function SaveToFilesModal({
  open,
  onClose,
  onConfirm,
  lawFirmId,
  defaultMatterId,
  defaultFileName,
  saving = false,
}: SaveToFilesModalProps) {
  const fieldIds = useId();
  const lookupDestination = useFileDestinationLookup(lawFirmId);
  const [tab, setTab] = useState<TabScope>("matters");

  // Entity lists
  const [matters, setMatters] = useState<Matter[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listLoaded, setListLoaded] = useState(false);
  // Whether the lookup that filled the currently displayed entity list reported
  // more rows than it returned. One flag, because only one of the three lists is
  // ever on screen at a time.
  const [listHasMore, setListHasMore] = useState(false);

  // Selected entity
  const [selectedId, setSelectedId] = useState<string | null>(defaultMatterId ?? null);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  // Folder browsing
  const { items: folders, setItems: setFolders, truncated: foldersTruncated,
    loading, loaded: foldersLoaded, setLoaded: setFoldersLoaded, error, setError, load: loadFolderRows, trail: breadcrumb, setTrail: setBreadcrumb, folderId: currentFolder, openFolder, navigateFolder } = useFolderBrowser("Failed to load folders");
  useResetAfterClose(open, () => { setListLoaded(false); setFoldersLoaded(false); });

  const [fileName, setFileName] = useState(defaultFileName);
  const [search, setSearch] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [savingFolder, setSavingFolder] = useState(false);

  // Are we inside a folder browser (not on entity list)?
  const isBrowsingFiles = tab === "general" || selectedId !== null;

  const filteredMatters = matters;
  const filteredTasks = tasks;
  const filteredClients = clients;

  // --- Load entity lists ---

  const loadMattersList = useCallback(async (query = "", ids?: string[]) => {
    setLoadingList(true);
    try {
      const result = await lookupDestination("matters", {
        search: ids?.length ? undefined : query.trim() || undefined,
        ids,
        limit: 50,
        full: true,
      });
      setMatters(result.items as unknown as Matter[]);
      // An `ids` request resolves one already-selected name rather than filling
      // the browsable list, so it can never mean the list was truncated.
      setListHasMore(ids?.length ? false : result.hasMore);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load matters"));
      setListHasMore(false);
    } finally {
      setLoadingList(false);
      setListLoaded(true);
    }
  }, [lookupDestination, setError]);

  const loadTasksList = useCallback(async (query = "") => {
    setLoadingList(true);
    try {
      const result = await lookupDestination("tasks", {
        search: query.trim() || undefined,
        limit: 50,
      });
      setTasks(result.items.map((item) => ({
        id: item.id,
        taskId: item.id,
        title: item.label,
        status: item.status,
      })) as Task[]);
      setListHasMore(result.hasMore);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load tasks"));
      setListHasMore(false);
    } finally {
      setLoadingList(false);
      setListLoaded(true);
    }
  }, [lookupDestination, setError]);

  const loadClientsList = useCallback(async (query = "") => {
    setLoadingList(true);
    try {
      const result = await lookupDestination("clients", {
        search: query.trim() || undefined,
        limit: 50,
        full: true,
      });
      setClients(result.items as unknown as Client[]);
      setListHasMore(result.hasMore);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load clients"));
      setListHasMore(false);
    } finally {
      setLoadingList(false);
      setListLoaded(true);
    }
  }, [lookupDestination, setError]);

  // --- Load folders for a given scope ---

  const loadFolders = useCallback(async (
    scope: TabScope,
    entityId: string | null,
    folderId?: string,
  ) => {
    await loadFolderRows(async () => {
      if (scope === "matters" && !folderId) return filesService.listMatterFiles(lawFirmId, entityId!);
      if (scope === "general" && !folderId) return filesService.listLawFirmFiles(lawFirmId);
      return filesService.listFolder(lawFirmId, folderScope(scope, entityId), folderId);
    }, (folder) => !!folder.isFolder);
  }, [lawFirmId, loadFolderRows]);

  // --- Reset on open ---

  useEffect(() => {
    if (!open) return;
    setError(null);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the modal form and kicks off async matter/folder loads when the modal opens
    setFileName(defaultFileName);
    setSearch("");
    setBreadcrumb([]);
    setFolders([]);
    setListHasMore(false);

    if (defaultMatterId) {
      setTab("matters");
      setSelectedId(defaultMatterId);
      setSelectedName(null);
      loadFolders("matters", defaultMatterId);
      loadMattersList("", [defaultMatterId]); // resolve the selected name directly
    } else {
      setTab("matters");
      setSelectedId(null);
      setSelectedName(null);
      loadMattersList();
    }
  }, [open, defaultMatterId, defaultFileName, loadMattersList, loadFolders, setBreadcrumb, setError, setFolders]);

  // Browse and search the active directory on the server. Selected entities are
  // browsing folders and therefore do not need the directory list refreshed.
  useEffect(() => {
    if (!open || selectedId || tab === "general") return;
    const timer = window.setTimeout(() => {
      if (tab === "matters") void loadMattersList(search);
      else if (tab === "tasks") void loadTasksList(search);
      else if (tab === "clients") void loadClientsList(search);
    }, search.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [open, selectedId, tab, search, loadMattersList, loadTasksList, loadClientsList]);

  // Resolve selected name from loaded list
  useEffect(() => {
    if (!selectedId || selectedName) return;
    if (tab === "matters") {
      const found = matters.find((c) => c.id === selectedId);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resolves the selected item's display name once its async-loaded list is available
      if (found) setSelectedName(found.name);
    } else if (tab === "tasks") {
      const found = tasks.find((t) => t.id === selectedId);
      if (found) setSelectedName(found.title || "Untitled Task");
    } else if (tab === "clients") {
      const found = clients.find((c) => c.id === selectedId);
      if (found) setSelectedName(found.name || "Unnamed Client");
    }
  }, [matters, tasks, clients, selectedId, selectedName, tab]);

  // --- Tab switching ---

  const handleTabChange = (newTab: TabScope) => {
    setListLoaded(false);
    setFoldersLoaded(false);
    setTab(newTab);
    setSearch("");
    setCreatingFolder(false);
    setNewFolderName("");
    setBreadcrumb([]);
    setSelectedId(null);
    setSelectedName(null);
    setFolders([]);
    setError(null);
    // Clear before the new tab's lookup lands so the previous tab's truncation
    // note cannot sit over the incoming list.
    setListHasMore(false);

    if (newTab === "general") loadFolders("general", null);
  };

  // --- Entity click (matter/task/client) ---

  const handleEntityClick = (id: string, name: string) => {
    setSelectedId(id);
    setSelectedName(name);
    setBreadcrumb([]);
    loadFolders(tab, id);
  };

  // --- Folder navigation ---

  const handleFolderClick = (folder: FileInfo) => {
    const folderName = folder.displayName || folder.name;
    openFolder(folder.id, folderName);
    loadFolders(tab, selectedId, folder.id);
  };

  const handleBreadcrumbRoot = () => {
    if (tab === "general") {
      setBreadcrumb([]);
      loadFolders("general", null);
    } else {
      // Go back to entity list
      setSelectedId(null);
      setSelectedName(null);
      setBreadcrumb([]);
      setFolders([]);
    }
  };

  const handleBreadcrumbEntity = () => {
    setBreadcrumb([]);
    loadFolders(tab, selectedId);
  };

  const handleBreadcrumbClick = (index: number) => {
    const folderId = navigateFolder(index);
    loadFolders(tab, selectedId, folderId);
  };

  // --- Create folder ---

  const handleCreateFolder = async () => {
    // Enter can fire again before the first create answers; a second request
    // would be refused as a duplicate of the folder the first one made.
    if (savingFolder) return;
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    setSavingFolder(true);
    setError(null);
    try {
      await filesService.createFolder(lawFirmId, folderScope(tab, selectedId), {
        folderName: trimmed,
        parentId: currentFolder,
      });
      setCreatingFolder(false);
      setNewFolderName("");
      // Reload current folder to show the new one
      loadFolders(tab, selectedId, currentFolder);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to create folder"));
    } finally {
      setSavingFolder(false);
    }
  };

  // --- Save ---

  const handleSave = () => {
    const trimmed = fileName.trim();
    if (!trimmed) return;
    const finalName = trimmed.endsWith(".pdf") ? trimmed : `${trimmed}.pdf`;

    if (tab === "matters" && selectedId) {
      onConfirm({ scope: "matter", matterId: selectedId, folderId: currentFolder, fileName: finalName });
    } else if (tab === "tasks" && selectedId) {
      onConfirm({ scope: "task", taskId: selectedId, folderId: currentFolder, fileName: finalName });
    } else if (tab === "clients" && selectedId) {
      onConfirm({ scope: "client", clientId: selectedId, folderId: currentFolder, fileName: finalName });
    } else {
      onConfirm({ scope: "general", folderId: currentFolder, fileName: finalName });
    }
  };

  // --- Location label ---

  let locationLabel = "Firm Files (root)";
  if (tab !== "general" && selectedId && selectedName) {
    locationLabel = selectedName;
    if (breadcrumb.length > 0) {
      locationLabel += ` / ${breadcrumb[breadcrumb.length - 1].name}`;
    } else {
      locationLabel += " (root)";
    }
  } else if (tab === "general" && breadcrumb.length > 0) {
    locationLabel = `Firm Files / ${breadcrumb[breadcrumb.length - 1].name}`;
  }

  const showEntityList = tab !== "general" && !selectedId;

  // --- Determine which entity list to show ---

  const entityListContent = () => {
    if (loadingList || !listLoaded) {
      return <ListSkeleton rows={4} label={`Loading ${tab}`} bordered={false} />;
    }

    if (tab === "matters") {
      return filteredMatters.length === 0 ? (
        <p className="py-8 text-center text-sm text-on-surface-muted">{search.trim() ? "No matching matters" : "No matters found"}</p>
      ) : (
        <div className="space-y-1">
          {filteredMatters.map((c) => {
            const names = c.clientNames?.length ? c.clientNames : c.clients?.map((cl) => cl.name).filter(Boolean);
            return (
              <button
                key={c.id}
                onClick={() => handleEntityClick(c.id, c.name)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-surface-hover transition-colors text-left cursor-pointer"
              >
                <BriefcaseBusiness size={16} className="text-blue-500 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-on-surface truncate">{c.name}</p>
                  {c.matterNumber && <p className="text-xs text-on-surface-muted truncate">{c.matterNumber}</p>}
                  {names && names.length > 0 && (
                    <p className="text-xs text-on-surface-muted truncate mt-0.5">
                      <UserRound size={10} className="inline -mt-px mr-1" />
                      {names.join(", ")}
                    </p>
                  )}
                </div>
                <ChevronRight size={14} className="text-on-surface-muted shrink-0" />
              </button>
            );
          })}
        </div>
      );
    }

    if (tab === "tasks") {
      return filteredTasks.length === 0 ? (
        <p className="py-8 text-center text-sm text-on-surface-muted">{search.trim() ? "No matching tasks" : "No tasks found"}</p>
      ) : (
        <div className="space-y-1">
          {filteredTasks.map((t) => {
            const taskId = t.id ?? (t as { taskId?: string }).taskId ?? "";
            const taskName = t.title || "Untitled Task";
            return (
              <button
                key={taskId}
                onClick={() => handleEntityClick(taskId, taskName)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-surface-hover transition-colors text-left cursor-pointer"
              >
                <ListChecks size={16} className="text-emerald-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-on-surface truncate">{taskName}</p>
                  {t.status && <p className="text-xs text-on-surface-muted truncate">{taskStatusMeta(t.status).label}</p>}
                </div>
                <ChevronRight size={14} className="text-on-surface-muted shrink-0" />
              </button>
            );
          })}
        </div>
      );
    }

    if (tab === "clients") {
      return filteredClients.length === 0 ? (
        <p className="py-8 text-center text-sm text-on-surface-muted">{search.trim() ? "No matching clients" : "No clients found"}</p>
      ) : (
        <div className="space-y-1">
          {filteredClients.map((c) => (
            <button
              key={c.id}
              onClick={() => handleEntityClick(c.id, c.name || "Unnamed Client")}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-surface-hover transition-colors text-left cursor-pointer"
            >
              <UserRound size={16} className="text-violet-500 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-on-surface truncate">{c.name || "Unnamed Client"}</p>
                {c.email && <p className="text-xs text-on-surface-muted truncate">{c.email}</p>}
              </div>
              <ChevronRight size={14} className="text-on-surface-muted shrink-0" />
            </button>
          ))}
        </div>
      );
    }

    return null;
  };

  const entityOverflowNote = lookupOverflowNote(listHasMore, search);

  // --- Tab label for breadcrumb root ---
  const tabLabel = tab === "matters" ? "Matters" : tab === "tasks" ? "Tasks" : tab === "clients" ? "Clients" : "Firm Files";

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Save to Files"
      subtitle="Choose where to save the generated document"
      closeIcon={<X size={18} />}
      size="lg"
      bodyClassName={null}
      footer={
        <>
          <Button type="secondary" onClick={onClose}>Cancel</Button>
          {isBrowsingFiles && (
            <Button
              type="primary"
              onClick={handleSave}
              loading={saving}
              disabled={!fileName.trim()}
              icon={<FolderUp size={14} />}
            >
              Save Here
            </Button>
          )}
        </>
      }
    >
      {error && (
        <div className="px-6 pt-4 shrink-0">
          <ErrorNotification error={error} onClose={() => setError(null)} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 px-6 pt-4 shrink-0">
        {([
          { key: "matters" as TabScope, label: "Matters" },
          { key: "tasks" as TabScope, label: "Tasks" },
          { key: "clients" as TabScope, label: "Clients" },
          { key: "general" as TabScope, label: "Firm Files" },
        ]).map((t) => (
          <button
            key={t.key}
            onClick={() => handleTabChange(t.key)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
              tab === t.key
                ? "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300"
                : "text-on-surface-muted hover:bg-surface-alt"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 px-6 pt-3 text-xs text-on-surface-muted shrink-0 flex-wrap">
        <button onClick={handleBreadcrumbRoot} className="hover:text-on-surface-secondary cursor-pointer">
          {tabLabel}
        </button>
        {selectedId && selectedName && (
          <>
            <ChevronRight size={12} />
            <button onClick={handleBreadcrumbEntity} className="hover:text-on-surface-secondary cursor-pointer">
              {selectedName}
            </button>
          </>
        )}
        {breadcrumb.map((bc, i) => (
          <span key={bc.id} className="flex items-center gap-1">
            <ChevronRight size={12} />
            <button onClick={() => handleBreadcrumbClick(i)} className="hover:text-on-surface-secondary cursor-pointer">
              {bc.name}
            </button>
          </span>
        ))}
      </div>

      {/* Search (entity list only). Stays mounted while the list loads so the
          debounced fetch doesn't unmount the input and drop keyboard focus
          mid-typing; the list area below shows the spinner. */}
      {showEntityList && (
        <div className="px-6 pt-3 shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${tab}...`}
              className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-8 pr-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-3 styled-scrollbar min-h-[180px] max-h-[280px]">
        {showEntityList ? (
          <>
            {entityListContent()}
            {/* Truncation note: it scrolls with the rows instead of being
                pinned above them, so it reads as the end of the list. */}
            {!loadingList && entityOverflowNote && (
              <p className="px-3 py-1.5 text-xs text-on-surface-muted border-t border-outline-subtle bg-surface-alt">
                {entityOverflowNote}
              </p>
            )}
          </>
        ) : (
          <FolderBrowserBody loading={loading || !foldersLoaded} label="Loading folders">
          <div className="space-y-1">
            {/* New folder row */}
            {creatingFolder ? (
              <div className="flex items-center gap-2 px-3 py-2">
                <FolderPlus size={16} className="text-blue-500 shrink-0" />
                <input
                  type="text"
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateFolder();
                    if (e.key === "Escape") { setCreatingFolder(false); setNewFolderName(""); }
                  }}
                  placeholder="Folder name"
                  className="flex-1 min-w-0 rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
                <button
                  onClick={handleCreateFolder}
                  disabled={!newFolderName.trim() || savingFolder}
                  className="p-1 rounded text-blue-500 hover:bg-surface-hover disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                >
                  {savingFolder ? <Spinner size={16} /> : <Check size={16} />}
                </button>
                <button
                  onClick={() => { setCreatingFolder(false); setNewFolderName(""); }}
                  className="p-1 rounded text-on-surface-muted hover:bg-surface-hover cursor-pointer transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreatingFolder(true)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-surface-hover transition-colors text-left cursor-pointer text-blue-500"
              >
                <FolderPlus size={16} className="shrink-0" />
                <span className="text-sm font-medium">New Folder</span>
              </button>
            )}

            <TruncatedListNotice truncated={foldersTruncated} unitLabel="folders" className="mb-2" />

            {folders.length === 0 && !creatingFolder ? (
              <p className="py-6 text-center text-sm text-on-surface-muted">
                No subfolders here. The file will be saved in this location.
              </p>
            ) : (
              <FolderBrowserRows folders={folders} onOpen={handleFolderClick} trailingAuto />
            )}
          </div>
          </FolderBrowserBody>
        )}
      </div>

      {/* File name + location (only when browsing files) */}
      {isBrowsingFiles && (
        <div className="px-6 pb-4 space-y-3 border-t border-outline pt-4 shrink-0">
          <div>
            <FieldLabel htmlFor={`${fieldIds}-filename`}>File name *</FieldLabel>
            <TextInput
              id={`${fieldIds}-filename`}
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
            />
          </div>
          <p className="text-xs text-on-surface-muted">
            Saving to: <span className="font-medium text-on-surface-secondary">{locationLabel}</span>
          </p>
        </div>
      )}
    </Modal>
  );
}
