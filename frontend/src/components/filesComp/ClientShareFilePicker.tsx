"use client";

import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useState, useEffect, useCallback, useRef } from "react";
import { X, Search, Folder, FileText, ChevronRight, Check, ArrowLeft, Briefcase, ClipboardList, User } from "lucide-react";
import filesService, { type FileInfo } from "@/services/files.service";
import { matterScope, taskScope, clientScope, scopeFromIds, type FileScope } from "@/lib/files/fileScope";
import type { FolderCrumb } from "@/lib/files/filePaths";
import mattersService from "@/services/matters.service";
import tasksService from "@/services/tasks.service";
import Button from "@/components/ui/Button";
import ErrorNotification from "@/components/ErrorNotification";
import ListSkeleton from "@/components/ui/ListSkeleton";
import TruncatedListNotice from "@/components/ui/TruncatedListNotice";
import Modal from "@/components/ui/Modal";
import { LOOKUP_MAX_LIMIT, SEARCH_DEBOUNCE_MS, lookupOverflowNote } from "@/lib/constants/search";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { bulkFailureMessage, bulkProgressMessage, runBulkRequests } from "@/lib/utils/bulkRequests";

type TabScope = "matters" | "tasks" | "client";
/** The two tabs that show a picker list before drilling into a file area. */
type ListScope = Exclude<TabScope, "client">;

/** A row in a scope's picker list (a matter or a task). */
interface SourceItem {
  id: string;
  name: string;
}

/** What a scope's last lookup reported, used to describe the rows it produced. */
interface SourceMeta {
  /** The lookup returned fewer rows than exist. */
  hasMore: boolean;
  /** The term those rows were fetched with, not whatever is in the input now. */
  search: string;
}

const emptySourcesMeta = (): Record<ListScope, SourceMeta> => ({
  matters: { hasMore: false, search: "" },
  tasks: { hasMore: false, search: "" },
});

interface SelectedItem {
  fileId: string;
  isFolder: boolean;
  scope: "matter" | "task" | "client";
  scopeId: string;
}

interface ClientShareFilePickerProps {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  clientId: string;
  /** Called after files were shared, so the parent can refetch the preview. */
  onShared: () => void;
}

const INPUT_CLASS = FULL_INPUT_CLS;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ClientShareFilePicker({ open, onClose, lawFirmId, clientId, onShared }: ClientShareFilePickerProps) {
  const [tab, setTab] = useState<TabScope>("matters");
  // Picker lists per scope; null means "not fetched yet" (loaded lazily per tab).
  const [sources, setSources] = useState<Record<ListScope, SourceItem[] | null>>({ matters: null, tasks: null });
  // Per scope, what its last lookup reported. The flag and the term it describes
  // travel in one value so the truncation note keeps describing the rows on
  // screen rather than whatever the user has since typed.
  const [sourcesMeta, setSourcesMeta] = useState<Record<ListScope, SourceMeta>>(emptySourcesMeta);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourceSearch, setSourceSearch] = useState("");

  const [selectedMatter, setSelectedMatter] = useState<SourceItem | null>(null);
  const [selectedTask, setSelectedTask] = useState<SourceItem | null>(null);

  const [files, setFiles] = useState<FileInfo[]>([]);
  const [inheritedShared, setInheritedShared] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Each crumb carries the folder's row id, which is what the server lists a
  // folder by, alongside the name the breadcrumb shows.
  const [breadcrumb, setBreadcrumb] = useState<FolderCrumb[]>([]);
  const [selected, setSelected] = useState<Map<string, SelectedItem>>(new Map());
  const [sharing, setSharing] = useState(false);
  /** How far a running share has got, so the footer can count up. */
  const [shareProgress, setShareProgress] = useState<{ done: number; total: number } | null>(null);
  // Set when the server reports it stopped scanning storage early, so the file
  // rows on screen are a partial view. It records which kind of request produced
  // them, not what is in the search box now.
  const [truncatedMode, setTruncatedMode] = useState<"browse" | "search" | null>(null);
  // Id of the most recently issued file-listing request (folder click,
  // breadcrumb, tab switch, or search); guards against an older, slower
  // response overwriting the list for wherever the user has since navigated.
  const loadRequestIdRef = useRef(0);
  // Same idea, per scope, for the matters/tasks source-list lookup: guards
  // against an older, slower search overwriting a newer search's results.
  const sourceRequestIdRef = useRef<Record<ListScope, number>>({ matters: 0, tasks: 0 });

  const currentFolder = breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1].id : undefined;

  // Whether the active tab is currently browsing files (vs. showing a source list).
  const browsing = tab === "client" || (tab === "matters" && !!selectedMatter) || (tab === "tasks" && !!selectedTask);

  const loadFiles = useCallback(
    async (scope: TabScope, opts: { matterId?: string; taskId?: string; folderId?: string }) => {
      const requestId = ++loadRequestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        let res;
        if (scope === "matters" && opts.matterId) {
          res = await filesService.listFolder(lawFirmId, matterScope(opts.matterId), opts.folderId);
        } else if (scope === "tasks" && opts.taskId) {
          res = await filesService.listFolder(lawFirmId, taskScope(opts.taskId), opts.folderId);
        } else if (scope === "client") {
          res = await filesService.listFolder(lawFirmId, clientScope(clientId), opts.folderId);
        } else {
          setFiles([]);
          setInheritedShared(false);
          setLoading(false);
          return;
        }
        // A newer navigation click may have started a fetch while this one
        // was in flight; a slower response here would otherwise silently
        // replace the folder/source the user has since moved to.
        if (requestId !== loadRequestIdRef.current) return;
        setFiles(res.files || []);
        setInheritedShared(!!res.inheritedClientVisible);
        setTruncatedMode(res.truncated ? "browse" : null);
      } catch (err) {
        if (requestId !== loadRequestIdRef.current) return;
        setError(getErrorMessage(err, "Failed to load files"));
        setFiles([]);
        setTruncatedMode(null);
      } finally {
        if (requestId === loadRequestIdRef.current) setLoading(false);
      }
    },
    [lawFirmId, clientId],
  );

  /**
   * Fetch one scope's picker list from the server typeahead, scoped to this
   * client.
   *
   * This used to pull the client's complete matter and task lists on open and
   * filter them in the browser behind a 100-row render cap, so a long-running
   * client's later matters were unreachable without guessing a search term that
   * narrowed below the cap. The scope is load-bearing rather than cosmetic: an
   * unscoped lookup would offer the firm's other clients' matters as places to
   * share this client's files from.
   */
  const loadSourceList = useCallback(
    async (scope: ListScope, query = "") => {
      const requestId = ++sourceRequestIdRef.current[scope];
      setSourcesLoading(true);
      const term = query.trim();
      try {
        const opts = { search: term || undefined, clientId, limit: LOOKUP_MAX_LIMIT };
        const result = scope === "matters"
          ? await mattersService.lookupMatters(lawFirmId, opts)
          : await tasksService.lookupTasks(lawFirmId, opts);
        // A newer search for this scope may have started while this one was in
        // flight; a slower response here would otherwise silently replace the
        // results for whatever the user has since typed.
        if (requestId !== sourceRequestIdRef.current[scope]) return;
        setSources((prev) => ({ ...prev, [scope]: result.items.map((item) => ({ id: item.id, name: item.label })) }));
        setSourcesMeta((prev) => ({ ...prev, [scope]: { hasMore: result.hasMore, search: term } }));
      } catch {
        if (requestId !== sourceRequestIdRef.current[scope]) return;
        setSources((prev) => ({ ...prev, [scope]: [] }));
        setSourcesMeta((prev) => ({ ...prev, [scope]: { hasMore: false, search: term } }));
      } finally {
        if (requestId === sourceRequestIdRef.current[scope]) setSourcesLoading(false);
      }
    },
    [lawFirmId, clientId],
  );

  // Reset the picker and load the matters list when the modal opens. The tasks
  // list stays unfetched until its tab is opened.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the picker to its initial state and loads the matters list when the modal opens
    setTab("matters");
    setSourceSearch("");
    setSources({ matters: null, tasks: null });
    setSourcesMeta(emptySourcesMeta());
    setSelectedMatter(null);
    setSelectedTask(null);
    setFiles([]);
    setBreadcrumb([]);
    setSearch("");
    setSelected(new Map());
    setError(null);
    setTruncatedMode(null);
  }, [open]);

  /**
   * Single owner of every source-list fetch: the first visit to a scope, and each
   * new search term for it.
   *
   * It is one effect rather than a load-on-open plus a load-on-tab-switch plus a
   * debounce, because those three fire for overlapping reasons and each overlap
   * is a duplicate request. The guard below is what makes one effect enough: a
   * scope already showing the server's answer for the current term has nothing to
   * fetch, so re-running after the fetch lands settles instead of looping.
   */
  useEffect(() => {
    if (!open || tab === "client" || selectedMatter || selectedTask) return;
    const scope: ListScope = tab;
    const term = sourceSearch.trim();
    if (sources[scope] != null && sourcesMeta[scope].search === term) return;
    // A scope opened for the first time loads straight away; only typing waits.
    const delay = sources[scope] == null ? 0 : SEARCH_DEBOUNCE_MS;
    const id = setTimeout(() => loadSourceList(scope, sourceSearch), delay);
    return () => clearTimeout(id);
  }, [open, tab, sourceSearch, selectedMatter, selectedTask, sources, sourcesMeta, loadSourceList]);

  const switchTab = (next: TabScope) => {
    setTab(next);
    setSelectedMatter(null);
    setSelectedTask(null);
    setBreadcrumb([]);
    setSearch("");
    setSourceSearch("");
    setFiles([]);
    setInheritedShared(false);
    setTruncatedMode(null);
    // Only the client tab loads here; the matters/tasks lists are fetched by the
    // source-list effect above, which owns that decision on its own.
    if (next === "client") loadFiles("client", {});
  };

  const openMatter = (c: SourceItem) => {
    setSelectedMatter(c);
    setBreadcrumb([]);
    setSearch("");
    loadFiles("matters", { matterId: c.id });
  };

  const openTask = (t: SourceItem) => {
    setSelectedTask(t);
    setBreadcrumb([]);
    setSearch("");
    loadFiles("tasks", { taskId: t.id });
  };

  const backToSourceList = () => {
    setSelectedMatter(null);
    setSelectedTask(null);
    setBreadcrumb([]);
    setSearch("");
    setFiles([]);
    setInheritedShared(false);
    setTruncatedMode(null);
  };

  const reloadCurrent = useCallback(
    (folderId?: string) => {
      if (tab === "matters" && selectedMatter) loadFiles("matters", { matterId: selectedMatter.id, folderId });
      else if (tab === "tasks" && selectedTask) loadFiles("tasks", { taskId: selectedTask.id, folderId });
      else if (tab === "client") loadFiles("client", { folderId });
    },
    [tab, selectedMatter, selectedTask, loadFiles],
  );

  const openFolder = (folder: FileInfo) => {
    setBreadcrumb([...breadcrumb, { id: folder.id, name: folder.name }]);
    reloadCurrent(folder.id);
  };

  const goToBreadcrumb = (index: number) => {
    const next = index < 0 ? [] : breadcrumb.slice(0, index + 1);
    setBreadcrumb(next);
    reloadCurrent(next.length ? next[next.length - 1].id : undefined);
  };

  // The file scope the active tab is browsing, the same one `loadFiles` lists.
  const fileScopeForTab = (): FileScope | null => {
    if (tab === "matters" && selectedMatter) return matterScope(selectedMatter.id);
    if (tab === "tasks" && selectedTask) return taskScope(selectedTask.id);
    if (tab === "client") return clientScope(clientId);
    return null;
  };

  const scopeForTab = (): { scope: "matter" | "task" | "client"; scopeId: string } | null => {
    if (tab === "matters" && selectedMatter) return { scope: "matter", scopeId: selectedMatter.id };
    if (tab === "tasks" && selectedTask) return { scope: "task", scopeId: selectedTask.id };
    if (tab === "client") return { scope: "client", scopeId: clientId };
    return null;
  };

  const toggleSelect = (item: FileInfo) => {
    const sc = scopeForTab();
    if (!sc) return;
    const next = new Map(selected);
    if (next.has(item.id)) next.delete(item.id);
    else next.set(item.id, { fileId: item.id, isFolder: !!item.isFolder, scope: sc.scope, scopeId: sc.scopeId });
    setSelected(next);
  };

  const handleSearch = async () => {
    if (!search.trim()) {
      reloadCurrent(currentFolder);
      return;
    }
    // Search where the rows are listed from. With no scope the server searches
    // the firm's General Files, and a hit picked there would then be shared
    // under this tab's task or client and fail.
    const scope = fileScopeForTab();
    if (!scope) return;
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await filesService.search(lawFirmId, scope, search.trim());
      if (requestId !== loadRequestIdRef.current) return;
      setFiles(res.files || []);
      setInheritedShared(false);
      setTruncatedMode(res.truncated ? "search" : null);
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) return;
      setError(getErrorMessage(err, "Search failed"));
    } finally {
      if (requestId === loadRequestIdRef.current) setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (selected.size === 0) return;
    const picked = Array.from(selected.entries());
    setSharing(true);
    setShareProgress({ done: 0, total: picked.length });
    setError(null);

    // One request per SCOPE, not per file. A selection survives a tab switch, so
    // it can name a matter's documents and the client's own area at once, and
    // the scope is what the server authorizes a batch against: files from two
    // scopes in one body would ask for one of them under the other's permission.
    // In the ordinary case this is a single group and therefore a single PATCH,
    // where it used to be one PATCH per picked file.
    const groups = new Map<string, Array<[string, SelectedItem]>>();
    for (const entry of picked) {
      const it = entry[1];
      const key = `${it.scope}:${it.scopeId}`;
      const existing = groups.get(key);
      if (existing) existing.push(entry);
      else groups.set(key, [entry]);
    }

    // Every id the server said it could not apply, whatever group it was in.
    const failures = new Set<string>();
    let settled = 0;

    try {
      const run = await runBulkRequests(
        [...groups.values()],
        async (entries) => {
          const it = entries[0][1];
          try {
            const result = await filesService.setClientVisibilityBulk({
              lawFirmId,
              scope: scopeFromIds({
                matterId: it.scope === "matter" ? it.scopeId : null,
                clientId: it.scope === "client" ? it.scopeId : null,
                taskId: it.scope === "task" ? it.scopeId : null,
              }),
              fileIds: entries.map(([, item]) => item.fileId),
              clientVisible: true,
            });
            // A 200 is not "all of them shared": the route applies what it can
            // and names the rest, so the outcome is read per file.
            for (const id of result.failed || []) failures.add(id);
          } finally {
            // Counted in FILES rather than groups, and in a `finally` so a group
            // whose request failed still moves the readout on.
            settled += entries.length;
            setShareProgress({ done: settled, total: picked.length });
          }
        },
      );
      // A group whose request never landed applied nothing, so all of its files
      // failed.
      for (const { item: entries } of run.failed) {
        for (const [id] of entries) failures.add(id);
      }

      // Whatever went through really is visible to the client now, so the page
      // behind the picker is told even when the run was not clean.
      if (failures.size < picked.length) onShared();

      if (failures.size === 0) {
        onClose();
        return;
      }
      // Stay open on exactly what failed, so retrying is one more click and
      // cannot re-share a file that already went.
      setSelected(new Map(picked.filter(([id]) => failures.has(id))));
      setError(bulkFailureMessage(
        {
          succeeded: picked.filter(([id]) => !failures.has(id)),
          failed: picked.filter(([id]) => failures.has(id)).map((item) => ({ item, error: null })),
        },
        "shared",
        "files",
      ));
    } catch (err) {
      setError(getErrorMessage(err, "Failed to share files"));
    } finally {
      setSharing(false);
      setShareProgress(null);
    }
  };

  const displayFolders = files.filter((f) => f.isFolder && f.name !== ".folder");
  const displayFiles = files.filter((f) => !f.isFolder && f.name !== ".folder");
  const showSourceList = (tab === "matters" && !selectedMatter) || (tab === "tasks" && !selectedTask);
  const listScope: ListScope = tab === "tasks" ? "tasks" : "matters";
  const sourceItems = sources[listScope];
  const sourceMeta = sourcesMeta[listScope];
  // Describes the matter/task list only. The file listing is a separate read
  // with its own truncation signal, so it never carries this note.
  const sourceOverflowNote = lookupOverflowNote(sourceMeta.hasMore, sourceMeta.search);

  const renderSelectableRow = (item: FileInfo, isFolder: boolean) => {
    const alreadyVisible = item.clientVisible === true || inheritedShared;
    // Keyed by the row id, the same address `toggleSelect` stores under and
    // `handleConfirm` sends. An object path is where the bytes currently live
    // and says nothing about which row this is.
    const isSelected = selected.has(item.id);
    return (
      <div
        key={item.id}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md border transition-colors ${
          alreadyVisible
            ? "border-transparent opacity-60"
            : isSelected
              ? "bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-accent-control-ring/30"
              : "border-transparent hover:bg-surface-hover"
        }`}
      >
        <button
          onClick={() => !alreadyVisible && toggleSelect(item)}
          disabled={alreadyVisible}
          className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 ${
            isSelected ? "bg-accent-solid border-accent-control-ring" : "border-input-border"
          } ${alreadyVisible ? "cursor-not-allowed" : "cursor-pointer"}`}
          title={alreadyVisible ? "Already visible to the client" : isFolder ? "Share this whole folder" : "Share this file"}
        >
          {(isSelected || alreadyVisible) && <Check size={12} className={alreadyVisible ? "text-emerald-500" : "text-white"} />}
        </button>
        {isFolder ? (
          <button onClick={() => openFolder(item)} className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer">
            <Folder size={16} className="text-amber-500 shrink-0" />
            <span className="text-sm font-medium text-on-surface truncate">{item.displayName || item.name}</span>
            <ChevronRight size={14} className="text-on-surface-muted shrink-0 ml-auto" />
          </button>
        ) : (
          <button
            onClick={() => !alreadyVisible && toggleSelect(item)}
            disabled={alreadyVisible}
            className={`flex items-center gap-3 min-w-0 flex-1 text-left ${alreadyVisible ? "cursor-not-allowed" : "cursor-pointer"}`}
          >
            <FileText size={16} className="text-on-surface-muted shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-on-surface truncate">{item.name}</p>
              <p className="text-xs text-on-surface-muted">{formatFileSize(item.size)}</p>
            </div>
          </button>
        )}
        {alreadyVisible && <span className="text-xs text-emerald-600 dark:text-emerald-400 shrink-0">Already visible</span>}
      </div>
    );
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      dismissible={!sharing}
      title="Share files with client"
      closeIcon={<X size={18} />}
      size="2xl"
      bodyClassName={null}
      footer={
        <div className="w-full flex items-center justify-between">
          <span className="text-xs text-on-surface-muted">
            {shareProgress
              ? bulkProgressMessage("Sharing", shareProgress.done, shareProgress.total)
              : `${selected.size} item${selected.size !== 1 ? "s" : ""} selected`}
          </span>
          <div className="flex items-center gap-2">
            <Button type="secondary" onClick={onClose} disabled={sharing}>Cancel</Button>
            <Button type="primary" onClick={handleConfirm} disabled={selected.size === 0} loading={sharing}>
              Make visible to client
            </Button>
          </div>
        </div>
      }
    >
          {/* Tabs */}
          <div className="flex gap-1 px-6 pt-4 shrink-0">
            {([
              { key: "matters" as TabScope, label: "Matters", icon: Briefcase },
              { key: "tasks" as TabScope, label: "Tasks", icon: ClipboardList },
              { key: "client" as TabScope, label: "Client files", icon: User },
            ]).map((t) => (
              <button
                key={t.key}
                onClick={() => switchTab(t.key)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer ${
                  tab === t.key
                    ? "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300"
                    : "text-on-surface-muted hover:bg-surface-alt"
                }`}
              >
                <t.icon size={13} />
                {t.label}
              </button>
            ))}
          </div>

          {/* Drill-in back button */}
          {browsing && tab !== "client" && (
            <div className="px-6 pt-3 shrink-0">
              <button
                onClick={backToSourceList}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-on-surface-secondary hover:text-on-surface cursor-pointer"
              >
                <ArrowLeft size={13} />
                Back to {tab === "matters" ? "matters" : "tasks"}
              </button>
              <p className="text-sm font-medium text-on-surface mt-1">
                {tab === "matters" ? selectedMatter?.name : selectedTask?.name}
              </p>
            </div>
          )}

          {/* Search over the client's matters/tasks, before drilling into one.
              Always offered while the list is showing: the rows are a server
              page, so "no rows yet" is a reason to search rather than a reason
              to hide the box. */}
          {showSourceList && (
            <div className="px-6 pt-3 shrink-0">
              <input
                className={INPUT_CLASS}
                value={sourceSearch}
                onChange={(e) => setSourceSearch(e.target.value)}
                placeholder={tab === "matters" ? "Search matters..." : "Search tasks..."}
              />
            </div>
          )}

          {/* Search (only while browsing files) */}
          {browsing && (
            <div className="px-6 pt-3 shrink-0">
              <div className="flex gap-2">
                <input
                  className={INPUT_CLASS}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  placeholder="Search files..."
                />
                <button
                  onClick={handleSearch}
                  className="px-3 py-2 rounded-md bg-surface-alt border border-outline hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                >
                  <Search size={16} className="text-on-surface-secondary" />
                </button>
              </div>
            </div>
          )}

          {/* Breadcrumb */}
          {browsing && breadcrumb.length > 0 && (
            <div className="flex items-center gap-1 px-6 pt-3 text-xs text-on-surface-muted shrink-0 flex-wrap">
              <button onClick={() => goToBreadcrumb(-1)} className="hover:text-on-surface-secondary cursor-pointer">
                Root
              </button>
              {breadcrumb.map((crumb, i) => (
                <span key={crumb.id} className="flex items-center gap-1">
                  <ChevronRight size={12} />
                  <button onClick={() => goToBreadcrumb(i)} className="hover:text-on-surface-secondary cursor-pointer">
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="px-6 pt-2">
            <ErrorNotification error={error} onClose={() => setError(null)} />
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-3 styled-scrollbar min-h-0">
            {showSourceList ? (
              sourcesLoading || sourceItems == null ? (
                <ListSkeleton rows={4} label={`Loading ${listScope}`} bordered={false} />
              ) : sourceItems.length === 0 ? (
                <p className="py-8 text-center text-sm text-on-surface-muted">
                  {sourceMeta.search
                    ? `No ${listScope === "matters" ? "matters" : "tasks"} match your search.`
                    : listScope === "matters"
                      ? "This client isn't on any matters."
                      : "This client isn't on any standalone tasks."}
                </p>
              ) : (
                <>
                  <div className="space-y-1">
                    {sourceItems.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => (listScope === "matters" ? openMatter(item) : openTask(item))}
                        className="w-full flex items-center gap-3 px-3 py-3 rounded-md hover:bg-surface-hover transition-colors text-left cursor-pointer"
                      >
                        {listScope === "matters"
                          ? <Briefcase size={16} className="text-blue-500 shrink-0" />
                          : <ClipboardList size={16} className="text-blue-500 shrink-0" />}
                        <span className="text-sm font-medium text-on-surface truncate flex-1">{item.name}</span>
                        <ChevronRight size={14} className="text-on-surface-muted shrink-0" />
                      </button>
                    ))}
                  </div>

                  {/* Truncation note: it scrolls with the rows instead of being
                      pinned above them, so it reads as the end of the list. */}
                  {sourceOverflowNote && (
                    <p className="px-3 py-1.5 text-xs text-on-surface-muted border-t border-outline-subtle bg-surface-alt">
                      {sourceOverflowNote}
                    </p>
                  )}
                </>
              )
            ) : loading ? (
              <ListSkeleton rows={4} label="Loading files" bordered={false} />
            ) : displayFolders.length === 0 && displayFiles.length === 0 ? (
              <>
                <TruncatedListNotice truncated={!!truncatedMode} mode={truncatedMode ?? "browse"} className="mb-2" />
                <p className="py-8 text-center text-sm text-on-surface-muted">No files here.</p>
              </>
            ) : (
              <div className="space-y-1">
                <TruncatedListNotice truncated={!!truncatedMode} mode={truncatedMode ?? "browse"} className="mb-2" />
                {inheritedShared && (
                  <p className="px-1 pb-2 text-xs text-emerald-600 dark:text-emerald-400">
                    Everything in this folder is already visible because a parent folder is shared.
                  </p>
                )}
                {displayFolders.map((folder) => renderSelectableRow(folder, true))}
                {displayFiles.map((file) => renderSelectableRow(file, false))}
              </div>
            )}
          </div>
    </Modal>
  );
}
