"use client";

import useFolderBrowser from "@/hooks/fileHooks/useFolderBrowser";
import FolderBrowserBody, { FolderBrowserRows } from "@/components/filesComp/FolderBrowserBody";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { X, Search, ChevronRight, ClipboardList, ArrowLeft, Upload, FolderPlus } from "lucide-react";
import filesService, { FileInfo } from "@/services/files.service";
import { FIRM_SCOPE, matterScope, scopeFromIds } from "@/lib/files/fileScope";
import tasksService from "@/services/tasks.service";
import type { Task } from "@/types/task";
import ErrorNotification from "@/components/ErrorNotification";
import ListSkeleton from "@/components/ui/ListSkeleton";
import Modal from "@/components/ui/Modal";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import usePagedRows from "@/hooks/usePagedRows";
import { AutoPager } from "@/components/ui/ListPager";
import TruncatedListNotice from "@/components/ui/TruncatedListNotice";
import { styleOf, taskPriorityMeta, taskStatusMeta } from "@/constants/statusMeta";
import FilePickerBreadcrumb from "@/components/filesComp/FilePickerBreadcrumb";
import { FilePickerFileRow } from "@/components/filesComp/FilePickerRow";
import FilePickerFooter from "@/components/filesComp/FilePickerFooter";
import FilePickerSearchRow, { FILE_PICKER_INPUT_CLASS } from "@/components/filesComp/FilePickerSearchRow";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { uploadJobKey } from "@/contexts/FileUploadContext";
import { useUploadJob } from "@/hooks/fileHooks/useUploadJob";
import { UploadFailures, UploadInProgress } from "@/components/filesComp/UploadStatus";

export interface SelectedFile {
  /** The document. Everything else here is a snapshot for display. */
  fileId: string;
  name: string;
  size: number;
  contentType: string;
  scope: "matter" | "task" | "client" | "general";
  scopeId?: string;
}

interface FilePickerModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (files: SelectedFile[]) => void;
  lawFirmId: string;
  /** Omit for a caller with no matter to scope to (e.g. a standalone client
   *  event): the "Matter Files" and "Task Files" tabs drop out and the
   *  picker opens straight to firm-wide files. */
  matterId?: string;
  alreadyLinked?: string[]; // file ids already linked
}

type TabScope = "matter" | "tasks" | "general";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilePickerModal({ open, onClose, onSelect, lawFirmId, matterId = "", alreadyLinked = [] }: FilePickerModalProps) {
  const hasMatter = !!matterId;
  const [tab, setTab] = useState<TabScope>(hasMatter ? "matter" : "general");
  const { items: files, setItems: setFiles, loading, setLoading, loaded: filesLoaded, setLoaded: setFilesLoaded,
    error, setError, requestIdRef: loadRequestIdRef, load: loadFolderRows, trail: breadcrumb, setTrail: setBreadcrumb, folderId: currentFolder, openFolder, navigateFolder } = useFolderBrowser("Failed to load files");
  const [uploadFailures, setUploadFailures] = useState<Array<{ name: string; error: string }>>([]);
  useResetAfterClose(open, () => { setError(null); setFilesLoaded(false); setUploadFailures([]); });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Map<string, SelectedFile>>(new Map());
  // Set when the server reports it stopped scanning storage early, so the rows on
  // screen are a partial view. It records which kind of request produced them,
  // not what is in the search box now, so the advice matches the list shown.
  const [truncatedMode, setTruncatedMode] = useState<"browse" | "search" | null>(null);

  // Task-specific state
  const [matterTasks, setMatterTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  // Filters the already-loaded task list in place. Kept separate from `search`,
  // which queries files on the server and only applies on submit.
  const [taskSearch, setTaskSearch] = useState("");

  // Upload & folder creation state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [savingFolder, setSavingFolder] = useState(false);

  const loadFiles = useCallback(async (scope: TabScope, folderId?: string, taskId?: string) => {
    if (scope !== "matter" && scope !== "general" && !(scope === "tasks" && taskId) && !folderId) {
      ++loadRequestIdRef.current;
      setError(null); setFiles([]); setTruncatedMode(null); setLoading(false); setFilesLoaded(true);
      return;
    }
    await loadFolderRows(async () => {
      let res;
      if (scope === "tasks" && taskId) res = await filesService.listFolder(lawFirmId, matterScope(matterId, taskId), folderId);
      else if (folderId) res = await filesService.listFolder(lawFirmId, scopeFromIds({ matterId: scope === "matter" ? matterId : null }), folderId);
      else if (scope === "matter") res = await filesService.listMatterFiles(lawFirmId, matterId);
      else res = await filesService.listLawFirmFiles(lawFirmId);
      return res;
    }, undefined, (response) => setTruncatedMode(response?.truncated ? "browse" : null));
  }, [lawFirmId, matterId, loadFolderRows, loadRequestIdRef, setError, setFiles, setLoading, setFilesLoaded]);

  const loadMatterTasks = useCallback(async () => {
    setTasksLoading(true);
    setError(null);
    try {
      const tasks = await tasksService.listMatterTasks(lawFirmId, matterId);
      setMatterTasks(tasks);
    } catch (err) {
      setMatterTasks([]);
      setError(getErrorMessage(err, "Failed to load tasks"));
    } finally {
      setTasksLoading(false);
    }
  }, [lawFirmId, matterId, setError]);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets modal state and fetches files when it opens
      setSelected(new Map());
      setSearch("");
      setBreadcrumb([]);
      const initialTab = hasMatter ? "matter" : "general";
      setTab(initialTab);
      setSelectedTask(null);
      setMatterTasks([]);
      setTaskSearch("");
      loadFiles(initialTab);
    }
  }, [open, loadFiles, hasMatter, setBreadcrumb]);

  const handleTabChange = (newTab: TabScope) => {
    setTab(newTab);
    setBreadcrumb([]);
    setSearch("");
    setSelectedTask(null);
    setTaskSearch("");
    setFiles([]);
    if (newTab === "tasks") {
      loadMatterTasks();
    } else {
      loadFiles(newTab);
    }
  };

  const handleTaskClick = (task: Task) => {
    setSelectedTask(task);
    setBreadcrumb([]);
    loadFiles("tasks", undefined, task.id);
  };

  const handleBackToTasks = () => {
    setSelectedTask(null);
    setBreadcrumb([]);
    setTaskSearch("");
    setFiles([]);
  };

  const handleFolderClick = (folder: FileInfo) => {
    const folderName = folder.displayName || folder.name;
    openFolder(folder.id, folderName);
    if (tab === "tasks" && selectedTask) {
      loadFiles("tasks", folder.id, selectedTask.id);
    } else {
      loadFiles(tab, folder.id);
    }
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index < 0) {
      setBreadcrumb([]);
      if (tab === "tasks" && selectedTask) {
        loadFiles("tasks", undefined, selectedTask.id);
      } else {
        loadFiles(tab);
      }
    } else {
      const path = navigateFolder(index);
      if (tab === "tasks" && selectedTask) {
        loadFiles("tasks", path, selectedTask.id);
      } else {
        loadFiles(tab, path);
      }
    }
  };

  const handleSearch = async () => {
    if (!search.trim()) {
      if (tab === "tasks" && selectedTask) {
        loadFiles("tasks", currentFolder, selectedTask.id);
      } else {
        loadFiles(tab, currentFolder);
      }
      return;
    }
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      // A task's search narrows the matter to that task, the scope its listing
      // is read with: a plain matter scope leaves out every task-owned file.
      const scope = tab === "tasks" && selectedTask
        ? matterScope(matterId, selectedTask.id)
        : scopeFromIds({ matterId: tab === "matter" || tab === "tasks" ? matterId : null });
      const res = await filesService.search(lawFirmId, scope, search.trim());
      if (requestId !== loadRequestIdRef.current) return;
      setFiles(res.files || []);
      setTruncatedMode(res.truncated ? "search" : null);
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) return;
      setError(getErrorMessage(err, "Search failed"));
    } finally {
      if (requestId === loadRequestIdRef.current) setLoading(false);
    }
  };

  const refreshCurrentView = () => {
    if (tab === "tasks" && selectedTask) {
      loadFiles("tasks", currentFolder, selectedTask.id);
    } else {
      loadFiles(tab, currentFolder);
    }
  };

  // The picker's upload is held above it, the way the file manager's is: closing
  // the picker leaves it running under the floating pill, and reopening picks
  // it back up. Every picker for this matter shares the one slot, since each
  // does the same thing with what lands: shows it in the list to pick from.
  const upload = useUploadJob({
    jobKey: uploadJobKey(lawFirmId, { matterId: matterId || undefined }, "picker"),
    visible: open && tab !== "tasks",
    onDone: (response) => {
      setUploadFailures(response.failures || []);
      refreshCurrentView();
    },
    onFailed: (message) => setError(message),
  });

  const handleUpload = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || tab === "tasks") return;
    const filesArray = Array.from(fileList);
    // Into the folder on screen, on either tab, as the file manager files it.
    const scope = tab === "matter" ? matterScope(matterId) : FIRM_SCOPE;
    const folderId = currentFolder;
    setError(null);
    setUploadFailures([]);
    upload.start(filesArray, (signal, onFinalizing) =>
      filesService.upload(lawFirmId, scope, filesArray, undefined, folderId, signal, onFinalizing));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleCreateFolder = async () => {
    // Enter can fire again before the first create answers; a second request
    // would be refused as a duplicate of the folder the first one made.
    if (savingFolder) return;
    if (!newFolderName.trim() || tab === "tasks") return;
    setSavingFolder(true);
    setError(null);
    try {
      await filesService.createFolder(
        lawFirmId,
        scopeFromIds({ matterId: tab === "matter" ? matterId : null }),
        { folderName: newFolderName.trim(), parentId: currentFolder },
      );
      setCreatingFolder(false);
      setNewFolderName("");
      refreshCurrentView();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to create folder"));
    } finally {
      setSavingFolder(false);
    }
  };

  const toggleFile = (file: FileInfo) => {
    const key = file.id;
    const next = new Map(selected);
    if (next.has(key)) {
      next.delete(key);
    } else {
      const scope = tab === "tasks" ? "task" as const : tab;
      next.set(key, {
        fileId: file.id,
        name: file.name,
        size: file.size,
        contentType: file.contentType,
        scope,
        scopeId: tab === "tasks" ? selectedTask?.id : tab === "matter" ? matterId : undefined,
      });
    }
    setSelected(next);
  };

  const handleConfirm = () => {
    onSelect(Array.from(selected.values()));
    onClose();
  };

  // A matter can carry hundreds of tasks, so the list the user scrolls is both
  // filterable and windowed.
  const taskQuery = taskSearch.trim().toLowerCase();
  const filteredTasks = useMemo(
    () => (taskQuery ? matterTasks.filter((t) => (t.title || "").toLowerCase().includes(taskQuery)) : matterTasks),
    [matterTasks, taskQuery],
  );
  const taskPager = usePagedRows(filteredTasks, 10, taskQuery);

  const displayFiles = files.filter(f => !f.isFolder);
  const displayFolders = files.filter(f => f.isFolder);
  const showTaskList = tab === "tasks" && !selectedTask;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Link Files"
      closeIcon={<X size={18} />}
      size="2xl"
      dismissible={!savingFolder}
      bodyClassName={null}
    >
          {error && (
            <div className="px-6 pt-4 shrink-0">
              <ErrorNotification error={error} onClose={() => setError(null)} />
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-1 px-6 pt-4 shrink-0">
            {([
              { key: "matter" as TabScope, label: "Matter Files" },
              { key: "tasks" as TabScope, label: "Task Files" },
              { key: "general" as TabScope, label: "Firm Files" },
            ].filter((t) => hasMatter || t.key === "general")).map((t) => (
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

          {/* Task back button */}
          {tab === "tasks" && selectedTask && (
            <div className="px-6 pt-3 shrink-0">
              <button
                onClick={handleBackToTasks}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-on-surface-secondary hover:text-on-surface cursor-pointer"
              >
                <ArrowLeft size={13} />
                Back to tasks
              </button>
              <p className="text-sm font-medium text-on-surface mt-1">{selectedTask.title}</p>
            </div>
          )}

          {/* Task search (the file search below searches files, not tasks) */}
          {showTaskList && (
            <div className="px-6 pt-3 shrink-0">
              <div className="relative">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted pointer-events-none" />
                <input
                  className={`${FILE_PICKER_INPUT_CLASS} pl-9`}
                  value={taskSearch}
                  onChange={(e) => setTaskSearch(e.target.value)}
                  placeholder="Search tasks..."
                />
              </div>
            </div>
          )}

          {/* Search + actions (hidden when showing task list) */}
          {!showTaskList && (
            <div className="px-6 pt-3 space-y-2 shrink-0">
              <FilePickerSearchRow value={search} onChange={setSearch} onSubmit={handleSearch} placeholder="Search files..." />
              {tab !== "tasks" && (
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => handleUpload(e.target.files)}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={upload.uploading}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-outline text-xs font-medium text-on-surface-secondary hover:bg-surface-alt transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Upload size={13} />
                    {upload.uploading ? "Uploading" : "Upload Files"}
                  </button>
                  {creatingFolder ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        className="rounded-md border border-input-border bg-input-bg text-on-surface px-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring w-36"
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
                        placeholder="Folder name"
                        autoFocus
                      />
                      <button onClick={handleCreateFolder} disabled={!newFolderName.trim() || savingFolder} className="px-2 py-1 rounded-md bg-accent-solid text-accent-foreground text-xs font-medium hover:bg-accent-solid-hover active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 cursor-pointer">Create</button>
                      <button onClick={() => { setCreatingFolder(false); setNewFolderName(""); }} className="px-2 py-1 rounded-md text-xs text-on-surface-muted hover:bg-surface-alt active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer">Cancel</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setCreatingFolder(true)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-outline text-xs font-medium text-on-surface-secondary hover:bg-surface-alt transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                    >
                      <FolderPlus size={13} />
                      New Folder
                    </button>
                  )}
                </div>
              )}
              {tab !== "tasks" && upload.uploading && (
                <UploadInProgress finalizing={upload.finalizing} onCancel={upload.cancel} />
              )}
              {tab !== "tasks" && <UploadFailures failures={uploadFailures} />}
            </div>
          )}

          {/* Breadcrumb */}
          {!showTaskList && (
            <FilePickerBreadcrumb segments={breadcrumb.map((bc) => bc.name)} onNavigate={handleBreadcrumbClick} />
          )}

          {/* Content area */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-3 styled-scrollbar min-h-0">
            {showTaskList ? (
              // Task list view
              tasksLoading ? (
                <ListSkeleton rows={4} label="Loading tasks" bordered={false} />
              ) : matterTasks.length === 0 ? (
                // After a failed load the banner above says so; the list was
                // never read, so claiming the matter has no tasks would be false.
                error ? null : (
                  <p className="py-8 text-center text-sm text-on-surface-muted">No tasks linked to this matter</p>
                )
              ) : filteredTasks.length === 0 ? (
                <p className="py-8 text-center text-sm text-on-surface-muted">No tasks match your search</p>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1">
                    {taskPager.pagedRows.map((task) => (
                      <button
                        key={task.id}
                        onClick={() => handleTaskClick(task)}
                        className="w-full flex items-center gap-3 px-3 py-3 rounded-md hover:bg-surface-hover transition-colors text-left cursor-pointer"
                      >
                        <ClipboardList size={16} className="text-blue-500 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-on-surface truncate">{task.title}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className={`text-xs font-medium ${styleOf(taskPriorityMeta(task.priority)).text}`}>
                              {taskPriorityMeta(task.priority).label}
                            </span>
                            <span className="text-xs text-on-surface-muted">{taskStatusMeta(task.status).label}</span>
                            {task.attachments && task.attachments.length > 0 && (
                              <span className="text-xs text-on-surface-muted">{task.attachments.length} attachment{task.attachments.length !== 1 ? "s" : ""}</span>
                            )}
                          </div>
                        </div>
                        <ChevronRight size={14} className="text-on-surface-muted shrink-0" />
                      </button>
                    ))}
                  </div>
                  <AutoPager pager={taskPager} />
                </div>
              )
            ) : (
              // File list view
              <FolderBrowserBody loading={loading || !filesLoaded} label="Loading files">
              {displayFolders.length === 0 && displayFiles.length === 0 ? (
                <>
                  <TruncatedListNotice truncated={!!truncatedMode} mode={truncatedMode ?? "browse"} className="mb-2" />
                  <p className="py-8 text-center text-sm text-on-surface-muted">No files found</p>
                </>
              ) : (
                <div className="space-y-1">
                  <TruncatedListNotice truncated={!!truncatedMode} mode={truncatedMode ?? "browse"} className="mb-2" />

                  {/* Folders */}
                  <FolderBrowserRows folders={displayFolders} onOpen={handleFolderClick} showFileCount />

                  {/* Files */}
                  {displayFiles.map((file) => {
                    const isSelected = selected.has(file.id);
                    const isAlready = alreadyLinked.includes(file.id);

                    return (
                      <FilePickerFileRow
                        key={file.id}
                        file={file}
                        selected={isSelected}
                        disabled={isAlready}
                        disabledNote={isAlready ? "Already linked" : undefined}
                        onToggle={toggleFile}
                        formatSize={formatFileSize}
                      />
                    );
                  })}
                </div>
              )}
              </FolderBrowserBody>
            )}
          </div>

          {/* Footer */}
          <FilePickerFooter
            countLabel={`${selected.size} file${selected.size !== 1 ? "s" : ""} selected`}
            onCancel={onClose}
            cancelDisabled={savingFolder}
            onConfirm={handleConfirm}
            confirmDisabled={selected.size === 0}
            confirmLabel="Link Selected"
          />
    </Modal>
  );
}
