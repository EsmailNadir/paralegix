"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import FilesService, {
  type ClientVisibleDocument,
  type ClientSharedFolder,
} from "@/services/files.service";
import MattersService from "@/services/matters.service";
import { clientScope, scopeFromIds } from "@/lib/files/fileScope";
import FilePreviewModal from "./FilePreviewModal";
import type { PreviewableFile } from "@/components/filesComp/FilePreviewModal";
import FileUpload from "./FileUpload";
import ClientShareFilePicker from "./ClientShareFilePicker";
import TruncatedListNotice from "@/components/ui/TruncatedListNotice";
import ListToolbar from "@/components/ui/ListToolbar";
import { getFolderColorDef } from "./folderColors";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import { usePermissions } from "@/contexts/PermissionsContext";
import Modal from "@/components/ui/Modal";
import { formatBytes } from "@/lib/utils/format";
import { formatDate as formatDateWithFallback } from "@/lib/utils/dateUtils";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ArrowLeft,
  Search,
  Eye,
  Download,
  Upload,
  Plus,
  X,
} from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import Button from "@/components/ui/Button";

interface ClientPortalFilePreviewProps {
  lawFirmId: string;
  clientId: string;
}

// Imperative handle so a parent's own "Back" chrome (e.g. the Files page header
// arrow) can step up through this preview's internal folder trail one level at a
// time, instead of exiting the whole view. `canGoUp` is false at the source-card
// root, where the parent should fall back to leaving the preview.
export interface ClientPortalFilePreviewHandle {
  canGoUp: () => boolean;
  goUp: () => void;
}

// Top-level grouping must mirror the client's portal Documents page exactly (this
// is a preview of that page): the portal keys solely on `matterId`, so each matter
// gets its own card and EVERY non-matter document, the client's own files AND files
// shared from standalone tasks, collapses into a single "Client files" bucket.
// Grouping by contextType/entityId instead would split standalone tasks into
// their own cards, which the portal never shows.
const CLIENT_GROUP_KEY = "__client__";

function groupKey(d: { matterId?: string | null }) {
  return d.matterId || CLIENT_GROUP_KEY;
}

const baseName = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
};

const formatDate = (date: string | null) => formatDateWithFallback(date, "-");

// A portal document, in the shape the preview takes.
function toPreview(doc: ClientVisibleDocument): PreviewableFile {
  return {
    id: doc.id,
    name: baseName(doc.name),
    size: doc.size,
    contentType: doc.type,
    signedUrl: doc.downloadUrl,
  };
}

const ClientPortalFilePreview = forwardRef<ClientPortalFilePreviewHandle, ClientPortalFilePreviewProps>(
  function ClientPortalFilePreview({ lawFirmId, clientId }, ref) {
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const canUnshare = hasPermission("files.upload");

  const queryKey = ["client-portal-files", lawFirmId, clientId];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => FilesService.listClientVisibleDocuments(lawFirmId, clientId),
    enabled: !!lawFirmId && !!clientId,
  });

  // Matter titles for the per-matter group labels (cached). The "Client files" bucket
  // is labelled statically; standalone-task files live inside it (matching the
  // portal), so no task titles are needed. Failures fall back to generic labels.
  const { data: matters } = useQuery({
    queryKey: ["matters", lawFirmId, { clientId, limit: 500 }],
    queryFn: async () => {
      const result = await MattersService.getMattersPaged(lawFirmId, {
        clientId,
        limit: 500,
        sortBy: "name",
        order: "asc",
      });
      return result.matters;
    },
    enabled: !!lawFirmId && !!clientId,
  });

  const documents = useMemo<ClientVisibleDocument[]>(() => data?.documents ?? [], [data]);
  const sharedFolders = useMemo<ClientSharedFolder[]>(() => data?.sharedFolders ?? [], [data]);

  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [busyPaths, setBusyPaths] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  // "Add files for client": upload to the client's area (auto-visible) or share
  // existing matter/task/client files.
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [markingUploads, setMarkingUploads] = useState(false);

  const refetch = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient],
  );

  // After uploading into the client's own area, mark each uploaded file visible so
  // it shows up in the portal immediately.
  const handleUploadComplete = useCallback(
    async (uploaded: { fileId: string }[]) => {
      setMarkingUploads(true);
      setActionError(null);
      try {
        await Promise.all(
          (uploaded || [])
            .filter((f) => f && f.fileId)
            .map((f) =>
              FilesService.setClientVisibility({
                lawFirmId,
                scope: clientScope(clientId),
                fileId: f.fileId,
                clientVisible: true,
              }),
            ),
        );
        await refetch();
        setUploadOpen(false);
      } catch (err) {
        setActionError(getErrorMessage(err, "Uploaded, but failed to mark visible"));
      } finally {
        setMarkingUploads(false);
      }
    },
    [lawFirmId, clientId, refetch],
  );

  // Mirror the browser location (open group + folder path) into the History API
  // so the browser Back/Forward buttons walk the folder trail one level at a time
  // matching the portal documents browser and FileManager.
  //
  // We push ONE entry per genuine location change and never on mount: `lastLocRef`
  // holds the serialized location we last reflected, so the initial render just
  // records the entry we arrived on (no push), an effect re-run with an unchanged
  // location is a no-op (kills React StrictMode's double-invoke from stacking a
  // junk entry (the cause of "Back does nothing until the 3rd press"), and a
  // popstate-driven restore syncs the ref instead of re-pushing.
  const lastLocRef = useRef<string | null>(null);
  const fromPopState = useRef(false);

  useEffect(() => {
    const key = JSON.stringify({ openGroup, folderPath });
    if (lastLocRef.current === null) {
      lastLocRef.current = key; // initial location, nothing to push yet
      return;
    }
    if (fromPopState.current) {
      fromPopState.current = false;
      lastLocRef.current = key;
      return;
    }
    if (key === lastLocRef.current) return; // no real change
    lastLocRef.current = key;
    // Carry the firm Files page's own history fields (activeView/activeClientId)
    // alongside our folder location, so that page's popstate handler keeps the
    // client view active instead of treating our entries as "go to dashboard".
    // Harmless where this component has no such parent (e.g. the client detail tab).
    window.history.pushState(
      { activeView: "client", activeMatterId: null, activeTaskId: null, activeClientId: clientId, previewLoc: { openGroup, folderPath } },
      "",
    );
  }, [openGroup, folderPath, clientId]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const loc = (e.state && (e.state as { previewLoc?: { openGroup: string | null; folderPath: string[] } }).previewLoc) || null;
      fromPopState.current = true;
      setOpenGroup(loc?.openGroup ?? null);
      setFolderPath(Array.isArray(loc?.folderPath) ? loc!.folderPath : []);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const matterTitleById = useMemo(() => {
    const map = new Map<string, string>();
    (matters ?? []).forEach((c: any) => {
      const title = c.matterNumber ? `${c.name || c.title} (${c.matterNumber})` : c.name || c.title;
      if (c.id && title) map.set(c.id, title);
    });
    return map;
  }, [matters]);

  // Label a group by its key: a matter key resolves to the matter title; the merged
  // bucket is "Client files" (it holds the client's own files plus standalone-task
  // shares, exactly as the portal presents them).
  const labelForGroup = useCallback(
    (key: string) => {
      if (key === CLIENT_GROUP_KEY) return "Client files";
      return matterTitleById.get(key) || "Matter files";
    },
    [matterTitleById],
  );

  // Top-level groups (one card per matter + a single "Client files" bucket) with
  // file counts, keyed exactly like the portal.
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; docs: ClientVisibleDocument[] }>();
    for (const doc of documents) {
      const key = groupKey(doc);
      if (!map.has(key)) map.set(key, { key, docs: [] });
      map.get(key)!.docs.push(doc);
    }
    return Array.from(map.values())
      .map((g) => ({ ...g, label: labelForGroup(g.key) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [documents, labelForGroup]);

  const openGroupObj = useMemo(() => groups.find((g) => g.key === openGroup) || null, [groups, openGroup]);
  // Memoized so a closed group (no docs) can't hand the folder/file memo below a
  // fresh empty array on every render.
  const openGroupDocs = useMemo(() => openGroupObj?.docs ?? [], [openGroupObj]);

  // Shared-folder relPaths for the open group → lets a folder row offer un-share.
  // Match by the same key the docs use, so the "Client files" bucket picks up
  // shared folders from both the client area and any standalone tasks.
  const groupSharedFolders = useMemo(() => {
    if (!openGroup) return new Map<string, ClientSharedFolder>();
    const map = new Map<string, ClientSharedFolder>();
    for (const sf of sharedFolders) {
      if (groupKey(sf) === openGroup) {
        map.set(sf.relPath, sf);
      }
    }
    return map;
  }, [sharedFolders, openGroup]);

  // Immediate children (subfolders + files) of the current folder within the open group.
  const { folders, files } = useMemo(() => {
    const folderSet = new Map<string, number>();
    const fileList: { doc: ClientVisibleDocument; name: string }[] = [];
    for (const doc of openGroupDocs) {
      const segs = doc.name.split("/").filter(Boolean);
      let underPath = true;
      for (let i = 0; i < folderPath.length; i++) {
        if (segs[i] !== folderPath[i]) {
          underPath = false;
          break;
        }
      }
      if (!underPath || segs.length <= folderPath.length) continue;

      if (segs.length === folderPath.length + 1) {
        fileList.push({ doc, name: segs[segs.length - 1] });
      } else {
        const folderName = segs[folderPath.length];
        folderSet.set(folderName, (folderSet.get(folderName) || 0) + 1);
      }
    }
    const folderList = Array.from(folderSet.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    fileList.sort((a, b) => a.name.localeCompare(b.name));
    return { folders: folderList, files: fileList };
  }, [openGroupDocs, folderPath]);

  const searchResults = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    return documents
      .filter((d) => d.name.toLowerCase().includes(term))
      .sort((a, b) => baseName(a.name).localeCompare(baseName(b.name)));
  }, [documents, search]);

  const isSearching = search.trim().length > 0;

  const resetToRoot = () => {
    setOpenGroup(null);
    setFolderPath([]);
  };

  const goUp = useCallback(() => {
    if (folderPath.length > 0) {
      setFolderPath((prev) => prev.slice(0, -1));
    } else {
      setOpenGroup(null);
    }
  }, [folderPath.length]);

  // Let the parent's Back chrome drive folder navigation. At the root (no group
  // open) there's nothing to step up to, so the parent exits the preview instead.
  useImperativeHandle(
    ref,
    () => ({
      canGoUp: () => openGroup !== null,
      goUp,
    }),
    [openGroup, goUp],
  );

  const handleOpen = (doc: ClientVisibleDocument) => {
    setPreviewFile(toPreview(doc));
    setIsPreviewOpen(true);
  };

  // Remove a directly-shared file (or a shared folder marker) from the client's
  // view. Scope is routed from the source: matter→matterId, client→clientId, task→taskId.
  const unshare = useCallback(
    async (item: { id: string; contextType: string; entityId: string }) => {
      if (!canUnshare) return;
      setBusyPaths((prev) => new Set(prev).add(item.id));
      setActionError(null);
      try {
        await FilesService.setClientVisibility({
          lawFirmId,
          scope: scopeFromIds({
            matterId: item.contextType === "matter" ? item.entityId : null,
            clientId: item.contextType === "client" ? item.entityId : null,
            taskId: item.contextType === "task" ? item.entityId : null,
          }),
          fileId: item.id,
          clientVisible: false,
        });
        await queryClient.invalidateQueries({ queryKey });
      } catch (err) {
        setActionError(getErrorMessage(err, "Failed to update sharing"));
      } finally {
        setBusyPaths((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canUnshare, lawFirmId, queryClient],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner size="md" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorNotification
        error={error instanceof Error ? error.message : "Failed to load the client's visible files."}
        onClose={() => {}}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* One panel for what this view is and the two ways to add to it: the
          explanation and the actions it explains belong on the same surface,
          and the search only exists once there is something to search. */}
      <ListToolbar className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="p-1.5 rounded-lg bg-accent-soft dark:bg-accent-soft text-accent-emphasis flex-shrink-0">
              <Eye className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-on-surface">The client&apos;s portal view</p>
              <p className="text-xs text-on-surface-secondary mt-0.5">
                Exactly what this client sees: files shared from their matters, tasks, and their own file area.
              </p>
            </div>
          </div>

          {canUnshare && (
            <div className="flex flex-wrap items-center gap-2 sm:justify-end sm:flex-shrink-0">
              <Tooltip title="Upload straight into this client's file area, visible to them immediately" enterDelay={300}>
                <Button
                  type="secondary"
                  size="compact"
                  onClick={() => setUploadOpen(true)}
                  icon={<Upload size={14} />}
                >
                  Upload for client
                </Button>
              </Tooltip>
              <Tooltip title="Pick files already in a matter, task, or this client's area and make them visible" enterDelay={300}>
                <Button
                  size="compact"
                  onClick={() => setPickerOpen(true)}
                  icon={<Plus size={14} strokeWidth={2.2} />}
                >
                  Share existing files
                </Button>
              </Tooltip>
            </div>
          )}
        </div>

        {documents.length > 0 && (
          <div className="border-t border-outline-subtle pt-3">
            <div className="relative w-full sm:max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-muted" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search files the client can see…"
                className="w-full rounded-xl border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-9 pr-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
          </div>
        )}
      </ListToolbar>

      {actionError && <ErrorNotification error={actionError} onClose={() => setActionError(null)} />}

      {/* The panel claims to be exactly what the client sees, so a short scan has
          to say so rather than let that claim stand. */}
      <TruncatedListNotice truncated={!!data?.truncated} unitLabel="shared files" />

      {/* Breadcrumb */}
      {!isSearching && openGroup && (
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <button
            onClick={goUp}
            className="inline-flex items-center gap-1 rounded-lg border border-outline bg-surface px-2.5 py-1 font-medium text-on-surface hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back
          </button>
          <span className="text-on-surface-muted">·</span>
          <button onClick={resetToRoot} className="text-accent-emphasis hover:text-accent-emphasis-hover dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer">
            All sources
          </button>
          <ChevronRight className="w-3.5 h-3.5 text-on-surface-muted" />
          <button
            onClick={() => setFolderPath([])}
            className={folderPath.length === 0 ? "text-on-surface font-medium" : "text-accent-emphasis hover:text-accent-emphasis-hover dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer"}
          >
            {openGroupObj ? openGroupObj.label : ""}
          </button>
          {folderPath.map((seg, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <ChevronRight className="w-3.5 h-3.5 text-on-surface-muted" />
              <button
                onClick={() => setFolderPath((prev) => prev.slice(0, index + 1))}
                className={index === folderPath.length - 1 ? "text-on-surface font-medium" : "text-accent-emphasis hover:text-accent-emphasis-hover dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer"}
              >
                {seg}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Content */}
      {documents.length === 0 ? (
        <div className="bg-surface rounded-2xl border border-outline-subtle p-12 text-center">
          <div className="w-12 h-12 bg-surface-alt rounded-2xl flex items-center justify-center mx-auto mb-4">
            <FolderOpen className="w-5 h-5 text-on-surface-muted" />
          </div>
          <h3 className="text-base font-semibold text-on-surface">This client can&apos;t see any files yet</h3>
          <p className="text-sm text-on-surface-secondary mt-1 max-w-md mx-auto">
            Share a file or folder with the client from a matter, task, or their file area and it will appear here.
          </p>
          {canUnshare && (
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <Button
                size="compact"
                onClick={() => setPickerOpen(true)}
                icon={<Plus size={14} strokeWidth={2.2} />}
              >
                Share existing files
              </Button>
              <Button
                type="secondary"
                size="compact"
                onClick={() => setUploadOpen(true)}
                icon={<Upload size={14} />}
              >
                Upload for client
              </Button>
            </div>
          )}
        </div>
      ) : isSearching ? (
        searchResults.length === 0 ? (
          <div className="bg-surface rounded-2xl border border-outline-subtle p-12 text-center">
            <h3 className="text-base font-semibold text-on-surface">No matching files</h3>
            <p className="text-sm text-on-surface-secondary mt-1">Try a different search term.</p>
          </div>
        ) : (
          <div className="bg-surface rounded-2xl border border-outline-subtle overflow-hidden divide-y divide-outline-subtle">
            {searchResults.map((doc) => {
              const folderHint = doc.name.includes("/")
                ? `${labelForGroup(groupKey(doc))} · ${doc.name.split("/").slice(0, -1).join(" / ")}`
                : labelForGroup(groupKey(doc));
              return (
                <FileRow
                  key={doc.id}
                  doc={doc}
                  label={baseName(doc.name)}
                  subtitle={`${folderHint} · ${formatBytes(doc.size)}`}
                  canUnshare={canUnshare}
                  busy={busyPaths.has(doc.id)}
                  onOpen={() => handleOpen(doc)}
                  onUnshare={() => unshare(doc)}
                />
              );
            })}
          </div>
        )
      ) : !openGroup ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {groups.map((group) => (
            <button
              key={group.key}
              onClick={() => {
                setOpenGroup(group.key);
                setFolderPath([]);
              }}
              className="text-left bg-surface rounded-2xl border border-outline-subtle p-5 flex items-center gap-3 hover:bg-surface-hover transition-colors cursor-pointer"
            >
              <div className="p-2.5 rounded-xl bg-accent-soft dark:bg-accent-soft text-accent-emphasis flex-shrink-0">
                <FolderOpen className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-on-surface truncate">{group.label}</p>
                <p className="text-[11px] text-on-surface-muted mt-0.5">
                  {group.docs.length} file{group.docs.length !== 1 ? "s" : ""}
                </p>
              </div>
              <ChevronRight className="w-4 h-4 text-on-surface-muted flex-shrink-0" />
            </button>
          ))}
        </div>
      ) : (
        <div className="bg-surface rounded-2xl border border-outline-subtle overflow-hidden">
          {folders.length === 0 && files.length === 0 ? (
            <div className="p-12 text-center">
              <h3 className="text-base font-semibold text-on-surface">This folder is empty</h3>
            </div>
          ) : (
            <div className="divide-y divide-outline-subtle">
              {folders.map((folder) => {
                const relPath = [...folderPath, folder.name].join("/") + "/";
                const sf = groupSharedFolders.get(relPath);
                const folderColor = getFolderColorDef(sf?.folderColor);
                return (
                  <div key={`folder:${folder.name}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-surface-hover transition-colors">
                    <button
                      onClick={() => setFolderPath((prev) => [...prev, folder.name])}
                      className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer"
                    >
                      <div className={`p-2 rounded-xl flex-shrink-0 ${folderColor.bg} ${folderColor.darkBg} ${folderColor.icon}`}>
                        <Folder className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-on-surface truncate">{folder.name}</p>
                        <p className="text-[11px] text-on-surface-muted mt-0.5">
                          {folder.count} file{folder.count !== 1 ? "s" : ""}
                          {sf ? " · Shared folder" : ""}
                        </p>
                      </div>
                    </button>
                    {sf && canUnshare && (
                      <UnshareButton
                        busy={busyPaths.has(sf.id)}
                        title="Stop sharing this folder with the client"
                        onClick={() => unshare(sf)}
                      />
                    )}
                    <Tooltip title="Open folder" enterDelay={300}>
                      <button aria-label="Open folder"
                        onClick={() => setFolderPath((prev) => [...prev, folder.name])}
                        className="flex-shrink-0 p-1 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </Tooltip>
                  </div>
                );
              })}
              {files.map(({ doc, name }) => (
                <FileRow
                  key={doc.id}
                  doc={doc}
                  label={name}
                  subtitle={`${formatBytes(doc.size)} · Shared ${formatDate(doc.uploadedAt)}`}
                  canUnshare={canUnshare}
                  busy={busyPaths.has(doc.id)}
                  onOpen={() => handleOpen(doc)}
                  onUnshare={() => unshare(doc)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <FilePreviewModal
        file={previewFile}
        isOpen={isPreviewOpen}
        lawFirmId={lawFirmId}
        onClose={() => {
          setIsPreviewOpen(false);
          setPreviewFile(null);
        }}
        onDownload={async () => {
          // The listing carries no signed URL, so one is minted for the file
          // being downloaded.
          if (!previewFile) return;
          const url = previewFile.signedUrl
            || (previewFile.id ? await FilesService.refreshSignedUrl(lawFirmId, previewFile.id) : null);
          if (url) FilesService.downloadFile(url, previewFile.name);
        }}
      />

      {/* Upload to the client's area (auto-shared) */}
      <Modal
        isOpen={uploadOpen}
        onClose={() => setUploadOpen(false)}
        title="Upload files for client"
        closeIcon={<X size={18} />}
        size="lg"
      >
        <p className="text-xs text-on-surface-secondary">
          Files upload into this client&apos;s own file area and are made visible to them automatically.
        </p>
        {actionError && <ErrorNotification error={actionError} onClose={() => setActionError(null)} />}
        {markingUploads ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-on-surface-secondary">
            <LoadingSpinner size="sm" /> Sharing uploaded files…
          </div>
        ) : (
          <FileUpload
            lawFirmId={lawFirmId}
            clientId={clientId}
            // Finishing here shares the files with the client, which the
            // client's own Files tab, same scope, must not take over.
            uploadSlot="client-portal"
            onUploadComplete={handleUploadComplete}
            onError={(msg) => setActionError(msg)}
          />
        )}
      </Modal>

      {/* Browse matters / tasks / client files and mark them visible */}
      <ClientShareFilePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        lawFirmId={lawFirmId}
        clientId={clientId}
        onShared={refetch}
      />
    </div>
  );
});

ClientPortalFilePreview.displayName = "ClientPortalFilePreview";

export default ClientPortalFilePreview;

function UnshareButton({ busy, title, onClick }: { busy: boolean; title: string; onClick: () => void }) {
  return (
    <Tooltip title={title} arrow>
      <button
        onClick={onClick}
        disabled={busy}
        className="flex-shrink-0 inline-flex items-center gap-1 rounded-lg border border-emerald-500/60 bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 hover:border-emerald-500 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50"
      >
        {busy ? <LoadingSpinner size="sm" /> : <Eye className="w-3.5 h-3.5" />}
        Visible
      </button>
    </Tooltip>
  );
}

function FileRow({
  doc,
  label,
  subtitle,
  canUnshare,
  busy,
  onOpen,
  onUnshare,
}: {
  doc: ClientVisibleDocument;
  label: string;
  subtitle: string;
  canUnshare: boolean;
  busy: boolean;
  onOpen: () => void;
  onUnshare: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-3.5 hover:bg-surface-hover transition-colors">
      <button onClick={onOpen} className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer">
        <div className="p-2 rounded-xl bg-accent-soft dark:bg-accent-soft text-accent-emphasis flex-shrink-0">
          <Download className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-on-surface truncate">{label}</p>
          <p className="text-[11px] text-on-surface-muted mt-0.5">{subtitle}</p>
        </div>
      </button>
      {doc.directlyShared ? (
        canUnshare && (
          <UnshareButton busy={busy} title="Stop sharing this file with the client" onClick={onUnshare} />
        )
      ) : (
        <Tooltip
          title={`Visible because the folder "${doc.viaFolderPath ? baseName(doc.viaFolderPath.replace(/\/$/, "")) : ""}" is shared. Un-share that folder to hide this file.`}
          arrow
        >
          <span className="flex-shrink-0 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-emerald-600/70 dark:text-emerald-400/70">
            <Eye className="w-3.5 h-3.5" />
            Via folder
          </span>
        </Tooltip>
      )}
    </div>
  );
}
