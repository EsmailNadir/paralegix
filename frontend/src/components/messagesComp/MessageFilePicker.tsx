"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { X, ChevronRight, ArrowLeft, Briefcase, FolderOpen, Users, ListChecks } from "lucide-react";
import filesService, { type FileInfo } from "@/services/files.service";
import type { FolderCrumb } from "@/lib/files/filePaths";
import { scopeFromIds } from "@/lib/files/fileScope";
import mattersService from "@/services/matters.service";
import clientsService from "@/services/clients.service";
import tasksService from "@/services/tasks.service";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import LoadingSpinner from "@/components/LoadingSpinner";
import Modal from "@/components/ui/Modal";
import { formatFileSize } from "@/lib/utils/format";
import { SEARCH_DEBOUNCE_MS, lookupOverflowNote } from "@/lib/constants/search";
import TruncatedListNotice from "@/components/ui/TruncatedListNotice";
import FilePickerBreadcrumb from "@/components/filesComp/FilePickerBreadcrumb";
import { FilePickerFileRow, FilePickerFolderRow } from "@/components/filesComp/FilePickerRow";
import FilePickerFooter from "@/components/filesComp/FilePickerFooter";
import FilePickerSearchRow, { FILE_PICKER_INPUT_CLASS } from "@/components/filesComp/FilePickerSearchRow";

// "firm" browses the firm-general file root directly; the other three first show
// a picker list (of matters/clients/tasks) and then browse the chosen one's files.
type TabScope = "firm" | "matters" | "clients" | "tasks";
type ListScope = Exclude<TabScope, "firm">;

// A row in a scope's picker list (a matter, client, or task).
interface SourceItem {
  id: string;
  name: string;
}

// What a scope's last lookup reported, used to describe the rows it produced.
interface SourceMeta {
  /** The lookup returned fewer rows than exist. */
  hasMore: boolean;
  /** The term those rows were fetched with, not whatever is in the input now. */
  search: string;
}

const emptySourcesMeta = (): Record<ListScope, SourceMeta> => ({
  matters: { hasMore: false, search: "" },
  clients: { hasMore: false, search: "" },
  tasks: { hasMore: false, search: "" },
});

const TABS: { key: TabScope; label: string; icon: typeof FolderOpen }[] = [
  { key: "firm", label: "Firm files", icon: FolderOpen },
  { key: "matters", label: "Matters", icon: Briefcase },
  { key: "clients", label: "Clients", icon: Users },
  { key: "tasks", label: "Tasks", icon: ListChecks },
];

// Icon shown next to each row in a scope's picker list.
const LIST_ICON: Record<ListScope, typeof FolderOpen> = {
  matters: Briefcase,
  clients: Users,
  tasks: ListChecks,
};

// Search is only server-side for firm-wide and matter scopes; client/task file
// areas filter the loaded listing client-side instead (see displayFolders/Files).
const SERVER_SEARCH_SCOPES: TabScope[] = ["firm", "matters"];

export interface PickedFile {
  fileId: string;
  name: string;
  size: number;
}

interface MessageFilePickerProps {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  /** How many more attachments the message can still take (message cap is 5). */
  maxSelectable: number;
  /** Called with the chosen files when the user confirms. */
  onConfirm: (files: PickedFile[]) => void;
}

export default function MessageFilePicker({ open, onClose, lawFirmId, maxSelectable, onConfirm }: MessageFilePickerProps) {
  const [tab, setTab] = useState<TabScope>("firm");
  // Picker lists per scope; null means "not fetched yet" (loaded lazily per tab).
  const [sources, setSources] = useState<Record<ListScope, SourceItem[] | null>>({ matters: null, clients: null, tasks: null });
  // Per scope, what its last lookup reported. The flag and the term it describes
  // travel in one value because this picker only refetches on an explicit search,
  // so the live input can be ahead of the rows on screen. Reading the term from
  // here keeps the truncation note describing the list the user is looking at.
  const [sourcesMeta, setSourcesMeta] = useState<Record<ListScope, SourceMeta>>(emptySourcesMeta);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [selectedSource, setSelectedSource] = useState<SourceItem | null>(null);
  // Separate from `search` below: this is the matters/clients/tasks typeahead,
  // which searches as the user types (like every other lookup box in the app),
  // not the file-content search, which stays submit-only.
  const [sourceSearch, setSourceSearch] = useState("");
  // Id of the most recently issued source-list request, per scope; guards
  // against an older, slower lookup overwriting a newer search's results.
  const sourceRequestIdRef = useRef<Record<ListScope, number>>({ matters: 0, clients: 0, tasks: 0 });

  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [breadcrumb, setBreadcrumb] = useState<FolderCrumb[]>([]);
  // Set when the server reports it stopped scanning storage early, so the rows on
  // screen are a partial view. It records which kind of request produced them,
  // not what is in the search box now, so the advice matches the list shown.
  const [truncatedMode, setTruncatedMode] = useState<"browse" | "search" | null>(null);
  // Keyed by file id so a selection survives folder navigation.
  const [selected, setSelected] = useState<Map<string, PickedFile>>(new Map());
  // Id of the most recently issued file-listing request (folder click,
  // breadcrumb, tab switch, or search); guards against an older, slower
  // response overwriting the list for wherever the user has since navigated.
  const loadRequestIdRef = useRef(0);

  // Whether the active tab is currently browsing files (vs. showing its picker list).
  const browsing = tab === "firm" || !!selectedSource;
  const supportsServerSearch = SERVER_SEARCH_SCOPES.includes(tab);

  const loadFiles = useCallback(
    async (scope: TabScope, opts: { sourceId?: string; folderId?: string }) => {
      const requestId = ++loadRequestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await filesService.listFolder(
          lawFirmId,
          scopeFromIds({
            matterId: scope === "matters" ? opts.sourceId ?? null : null,
            taskId: scope === "tasks" ? opts.sourceId ?? null : null,
            clientId: scope === "clients" ? opts.sourceId ?? null : null,
          }),
          opts.folderId,
        );
        // A newer navigation click may have started a fetch while this one
        // was in flight; a slower response here would otherwise silently
        // replace the folder/source the user has since moved to.
        if (requestId !== loadRequestIdRef.current) return;
        setFiles(res.files || []);
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
    [lawFirmId],
  );

  // Fetch a scope's picker list (matters/clients/tasks): the first time its tab
  // opens, and again as the user types (debounced below).
  const loadSourceList = useCallback(
    async (scope: ListScope, query = "") => {
      const requestId = ++sourceRequestIdRef.current[scope];
      setSourcesLoading(true);
      const term = query.trim();
      try {
        const opts = { search: term || undefined, limit: 50 };
        const result = scope === "matters"
          ? await mattersService.lookupMatters(lawFirmId, opts)
          : scope === "clients"
            ? await clientsService.lookupClients(lawFirmId, opts)
            : await tasksService.lookupTasks(lawFirmId, opts);
        // A newer search for this scope may have started while this one was in
        // flight; a slower response here would otherwise silently replace the
        // results for whatever the user has since typed.
        if (requestId !== sourceRequestIdRef.current[scope]) return;
        const items = result.items.map((item) => ({ id: item.id, name: item.label }));
        setSources((prev) => ({ ...prev, [scope]: items }));
        setSourcesMeta((prev) => ({ ...prev, [scope]: { hasMore: result.hasMore, search: term } }));
      } catch {
        if (requestId !== sourceRequestIdRef.current[scope]) return;
        setSources((prev) => ({ ...prev, [scope]: [] }));
        setSourcesMeta((prev) => ({ ...prev, [scope]: { hasMore: false, search: term } }));
      } finally {
        if (requestId === sourceRequestIdRef.current[scope]) setSourcesLoading(false);
      }
    },
    [lawFirmId],
  );

  // Reset and load the firm-general root when opened; scope lists load lazily.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the picker and loads the firm root when the modal opens
    setTab("firm");
    setSelectedSource(null);
    setSources({ matters: null, clients: null, tasks: null });
    setSourcesMeta(emptySourcesMeta());
    setBreadcrumb([]);
    setSearch("");
    setSourceSearch("");
    setSelected(new Map());
    setError(null);
    loadFiles("firm", {});
  }, [open, lawFirmId, loadFiles]);

  /**
   * Single owner of every source-list fetch: the first visit to a scope, and each
   * new search term for it (searches as the user types, like every other lookup
   * box in the app). One effect rather than a load-on-open plus a
   * load-on-tab-switch plus a debounce, because those three fire for
   * overlapping reasons and each overlap is a duplicate request.
   */
  useEffect(() => {
    if (!open || tab === "firm" || selectedSource) return;
    const scope = tab as ListScope;
    const term = sourceSearch.trim();
    if (sources[scope] != null && sourcesMeta[scope].search === term) return;
    // A scope opened for the first time loads straight away; only typing waits.
    const delay = sources[scope] == null ? 0 : SEARCH_DEBOUNCE_MS;
    const id = setTimeout(() => loadSourceList(scope, sourceSearch), delay);
    return () => clearTimeout(id);
  }, [open, tab, selectedSource, sourceSearch, sources, sourcesMeta, loadSourceList]);

  const switchTab = (next: TabScope) => {
    setTab(next);
    setSelectedSource(null);
    setBreadcrumb([]);
    setSearch("");
    setSourceSearch("");
    setFiles([]);
    // Only Firm files loads here; the matters/clients/tasks lists are fetched
    // by the source-list effect above, which owns that decision on its own.
    if (next === "firm") loadFiles("firm", {});
  };

  const openSource = (item: SourceItem) => {
    setSelectedSource(item);
    setBreadcrumb([]);
    setSearch("");
    loadFiles(tab, { sourceId: item.id });
  };

  const backToList = () => {
    setSelectedSource(null);
    setBreadcrumb([]);
    setSearch("");
    setFiles([]);
  };

  const reloadCurrent = useCallback(
    (folderId?: string) => {
      if (tab !== "firm" && selectedSource) loadFiles(tab, { sourceId: selectedSource.id, folderId });
      else if (tab === "firm") loadFiles("firm", { folderId });
    },
    [tab, selectedSource, loadFiles],
  );

  const openFolder = (folder: FileInfo) => {
    const next = [...breadcrumb, { id: folder.id, name: folder.name }];
    setBreadcrumb(next);
    reloadCurrent(folder.id);
  };

  const goToBreadcrumb = (index: number) => {
    const next = index < 0 ? [] : breadcrumb.slice(0, index + 1);
    setBreadcrumb(next);
    reloadCurrent(next.length ? next[next.length - 1].id : undefined);
  };

  const atLimit = selected.size >= maxSelectable;

  const toggleSelect = (item: FileInfo) => {
    const next = new Map(selected);
    if (next.has(item.id)) {
      next.delete(item.id);
    } else {
      if (next.size >= maxSelectable) return;
      next.set(item.id, { fileId: item.id, name: item.name, size: item.size });
    }
    setSelected(next);
  };

  const handleSearch = async () => {
    // Client/task scopes filter the loaded listing client-side; nothing to fetch.
    if (!supportsServerSearch) return;
    if (!search.trim()) {
      reloadCurrent(breadcrumb.length ? breadcrumb[breadcrumb.length - 1].id : undefined);
      return;
    }
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const matterScoped = tab === "matters" && selectedSource ? selectedSource.id : null;
      const res = await filesService.search(lawFirmId, scopeFromIds({ matterId: matterScoped }), search.trim());
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

  const handleConfirm = () => {
    if (selected.size === 0) return;
    onConfirm(Array.from(selected.values()));
    onClose();
  };

  const showList = tab !== "firm" && !selectedSource;
  const listScope = tab as ListScope; // valid whenever showList is true
  const activeTabLabel = TABS.find((t) => t.key === tab)?.label ?? "";

  // Client/task areas have no server search, so filter their listing by name here.
  const clientFilter = (arr: FileInfo[]) => {
    const q = search.trim().toLowerCase();
    if (supportsServerSearch || !q) return arr;
    return arr.filter((f) => (f.displayName || f.name).toLowerCase().includes(q));
  };
  const displayFolders = clientFilter(files.filter((f) => f.isFolder && f.name !== ".folder"));
  const displayFiles = clientFilter(files.filter((f) => !f.isFolder && f.name !== ".folder"));

  const renderFileRow = (item: FileInfo) => {
    const isSelected = selected.has(item.id);
    const disabled = !isSelected && atLimit;
    return (
      <FilePickerFileRow
        key={item.id}
        file={item}
        selected={isSelected}
        disabled={disabled}
        onToggle={toggleSelect}
        formatSize={formatFileSize}
      />
    );
  };

  const renderFolderRow = (item: FileInfo) => (
    <FilePickerFolderRow key={item.id} folder={item} onOpen={openFolder} alignWithCheckbox />
  );

  const renderSourceList = () => {
    const items = sources[listScope];
    if (sourcesLoading || items == null) {
      return <div className="py-8 flex justify-center"><LoadingSpinner /></div>;
    }
    if (items.length === 0) {
      return <p className="py-8 text-center text-sm text-on-surface-muted">No {activeTabLabel.toLowerCase()} available.</p>;
    }
    const RowIcon = LIST_ICON[listScope];
    // Describes the matter/client/task list only. The file listing is a separate
    // read and is not capped by the lookup limit, so it never carries this note.
    const meta = sourcesMeta[listScope];
    const overflowNote = lookupOverflowNote(meta.hasMore, meta.search);
    return (
      <>
        <div className="space-y-1">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => openSource(item)}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-md hover:bg-surface-hover transition-colors text-left cursor-pointer"
            >
              <RowIcon size={16} className="text-blue-500 shrink-0" />
              <span className="text-sm font-medium text-on-surface truncate flex-1">{item.name}</span>
              <ChevronRight size={14} className="text-on-surface-muted shrink-0" />
            </button>
          ))}
        </div>

        {/* Truncation note: it scrolls with the rows instead of being pinned
            above them, so it reads as the end of the list. */}
        {overflowNote && (
          <p className="px-3 py-1.5 text-xs text-on-surface-muted border-t border-outline-subtle bg-surface-alt">
            {overflowNote}
          </p>
        )}
      </>
    );
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Attach from file manager"
      closeIcon={<X size={18} />}
      size="2xl"
      height="fill"
      bodyClassName={null}
    >
      {/* Tabs */}
      <div className="flex gap-1 px-6 pt-4 shrink-0">
        {TABS.map((t) => (
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

      {/* Drill-in back button (matter / client / task) */}
      {browsing && tab !== "firm" && selectedSource && (
        <div className="px-6 pt-3 shrink-0">
          <button
            onClick={backToList}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-on-surface-secondary hover:text-on-surface cursor-pointer"
          >
            <ArrowLeft size={13} />
            Back to {activeTabLabel.toLowerCase()}
          </button>
          <p className="text-sm font-medium text-on-surface mt-1">{selectedSource.name}</p>
        </div>
      )}

      {/* Search over the matters/clients/tasks picker list, before drilling into
          one. Searches as the user types, unlike the file-content search below. */}
      {showList && (
        <div className="px-6 pt-3 shrink-0">
          <input
            className={FILE_PICKER_INPUT_CLASS}
            value={sourceSearch}
            onChange={(e) => setSourceSearch(e.target.value)}
            placeholder={`Search ${activeTabLabel.toLowerCase()}...`}
          />
        </div>
      )}

      {/* Search (only while browsing files) */}
      {browsing && (
        <div className="px-6 pt-3 shrink-0">
          <FilePickerSearchRow
            value={search}
            onChange={setSearch}
            onSubmit={handleSearch}
            placeholder="Search files..."
          />
        </div>
      )}

      {/* Breadcrumb */}
      {browsing && (
        <FilePickerBreadcrumb segments={breadcrumb.map((c) => c.name)} onNavigate={goToBreadcrumb} />
      )}

      <div className="px-6 pt-2">
        <ErrorNotification error={error} onClose={() => setError(null)} />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-3 styled-scrollbar min-h-0">
        {showList ? (
          renderSourceList()
        ) : loading ? (
          <div className="py-8 flex justify-center"><LoadingSpinner /></div>
        ) : displayFolders.length === 0 && displayFiles.length === 0 ? (
          <>
            <TruncatedListNotice truncated={!!truncatedMode} mode={truncatedMode ?? "browse"} className="mb-2" />
            <p className="py-8 text-center text-sm text-on-surface-muted">No files here.</p>
          </>
        ) : (
          <div className="space-y-1">
            <TruncatedListNotice truncated={!!truncatedMode} mode={truncatedMode ?? "browse"} className="mb-2" />
            {displayFolders.map(renderFolderRow)}
            {displayFiles.map(renderFileRow)}
          </div>
        )}
      </div>

      {/* Footer */}
      <FilePickerFooter
        countLabel={`${selected.size} selected${maxSelectable < 5 ? ` (max ${maxSelectable})` : ""}`}
        onCancel={onClose}
        onConfirm={handleConfirm}
        confirmDisabled={selected.size === 0}
        confirmLabel={`Attach ${selected.size > 0 ? selected.size : ""}`}
      />
    </Modal>
  );
}
