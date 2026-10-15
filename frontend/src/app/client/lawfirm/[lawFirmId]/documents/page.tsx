"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import clientPortalService, { type PortalFolderColor } from "@/services/client-portal.service";
import filesService from "@/services/files.service";
import { getFolderColorDef } from "@/components/filesComp/folderColors";
import { formatBytes } from "@/lib/utils/format";
import { formatDate as formatDateWithFallback } from "@/lib/utils/dateUtils";
import LoadingSpinner from "@/components/LoadingSpinner";
import ListSkeleton from "@/components/ui/ListSkeleton";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ErrorNotification from "@/components/ErrorNotification";
import { AutoPager } from "@/components/ui/ListPager";
import TruncatedListNotice from "@/components/ui/TruncatedListNotice";
import ListToolbar from "@/components/ui/ListToolbar";
import usePagedRows from "@/hooks/usePagedRows";
import FilePreviewModal from "@/components/filesComp/FilePreviewModal";
import type { PreviewableFile } from "@/components/filesComp/FilePreviewModal";
import RequestedDocumentsPanel from "@/components/portalComp/RequestedDocumentsPanel";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import UploadDocumentModal from "@/components/portalComp/UploadDocumentModal";
import { useClientPortal } from "@/contexts/ClientPortalContext";
import ClientRecordPicker from "@/components/portalComp/ClientRecordPicker";
import Card from "@/components/ui/Card";
import {
  FileText,
  FileImage,
  FileSpreadsheet,
  FileArchive,
  File as FileIcon,
  Folder,
  Download,
  Upload,
  Search,
  FolderOpen,
  ChevronRight,
  ArrowLeft,
} from "lucide-react";
import Button from "@/components/ui/Button";

interface PortalDocument {
  id: string;
  matterId?: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: string | null;
  downloadUrl: string;
  objectPath?: string | null;
  sourceLabel?: string;
  // True until the client first opens this shared document (drives the New badge).
  isNew?: boolean;
}

interface MatterLite {
  id: string;
  title: string;
  matterNumber?: string;
}

// Group key for files not tied to a matter (client-scoped shares).
const CLIENT_GROUP_KEY = "__client__";

const formatDate = (date: unknown) => formatDateWithFallback(date, "-");

// The portal returns each document's `name` as its full path within the matter
// (e.g. "contracts/2024/nda.pdf"). The basename is the last segment.
const baseName = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
};

// Pick a file icon from the mime type or filename extension.
const getFileIcon = (doc: PortalDocument) => {
  const type = (doc.type || "").toLowerCase();
  const name = baseName(doc.name || "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() || "" : "";

  if (type.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"].includes(ext)) {
    return FileImage;
  }
  if (
    type.includes("spreadsheet") ||
    type.includes("excel") ||
    type === "text/csv" ||
    ["xls", "xlsx", "csv"].includes(ext)
  ) {
    return FileSpreadsheet;
  }
  if (type.includes("zip") || type.includes("compressed") || ["zip", "rar", "7z", "tar", "gz"].includes(ext)) {
    return FileArchive;
  }
  if (
    type === "application/pdf" ||
    type.includes("word") ||
    type.startsWith("text/") ||
    ["pdf", "doc", "docx", "txt", "rtf"].includes(ext)
  ) {
    return FileText;
  }
  return FileIcon;
};

export default function ClientDocumentsPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";
  const { associations, associationsLoading, activeAssociation, selectionRequired, setActiveClientRecordId } = useClientPortal();
  const clientRecordId = activeAssociation?.clientRecordId;
  // Optional `?matter=<id>` deep-link: open straight into that matter's folder.
  const initialMatterParam = searchParams.get("matter");
  // Optional `?highlight=<objectPath>` deep-link (from a share notification): open
  // straight to that document's folder and briefly ring it.
  const highlightPath = searchParams.get("highlight");

  const [documents, setDocuments] = useState<PortalDocument[]>([]);
  const [folderColors, setFolderColors] = useState<PortalFolderColor[]>([]);
  // True when the server could not scan every shared location, so this list is
  // short. A client who cannot see a document assumes it was never sent, which
  // is exactly the wrong conclusion to leave them with.
  const [documentsTruncated, setDocumentsTruncated] = useState(false);
  const [matters, setMatters] = useState<MatterLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // Document opened in the in-app preview modal (image/PDF/doc/…).
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);
  // Id of the most recently clicked document's signed-url fetch; guards
  // against an older, slower fetch overwriting a newer one's preview.
  const openDocRequestRef = useRef<string | null>(null);
  // Free-upload modal (pick a matter, then files).
  const [uploadOpen, setUploadOpen] = useState(false);

  // Folder-browser location: which matter/group is open (null = top level showing
  // the list of matters) and the folder path within it. A `?matter=` deep-link opens
  // that matter's folder straight away.
  const [openGroup, setOpenGroup] = useState<string | null>(initialMatterParam || null);
  const [folderPath, setFolderPath] = useState<string[]>([]);
  // The document id to briefly ring after a ?highlight deep-link, and a guard so
  // we only auto-navigate to it once (the client can browse away freely after).
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightHandled = useRef(false);

  // Mirror the in-page browser location into the History API so the browser's
  // Back/Forward buttons walk the folder trail. `firstSync` skips the initial
  // mount (no entry to push yet) and `fromPopState` avoids re-pushing a location
  // that a popstate event just restored.
  const firstSync = useRef(true);
  const fromPopState = useRef(false);

  useEffect(() => {
    if (firstSync.current) {
      firstSync.current = false;
      return;
    }
    if (fromPopState.current) {
      fromPopState.current = false;
      return;
    }
    window.history.pushState({ docLoc: { openGroup, folderPath } }, "");
  }, [openGroup, folderPath]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const loc = (e.state && e.state.docLoc) || { openGroup: null, folderPath: [] };
      fromPopState.current = true;
      setOpenGroup(loc.openGroup ?? null);
      setFolderPath(Array.isArray(loc.folderPath) ? loc.folderPath : []);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!lawFirmId || !user || associationsLoading || selectionRequired) return;

    let active = true;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        // Matters are only used to label/group documents by matter title. Failing to
        // load them shouldn't block the document list, so swallow that error.
        const [docsRes, mattersRes] = await Promise.all([
          clientPortalService.getDocuments(lawFirmId, clientRecordId),
          clientPortalService.getMatters(lawFirmId, clientRecordId).catch(() => ({ matters: [] as MatterLite[] })),
        ]);
        if (!active) return;
        setDocuments(Array.isArray(docsRes?.documents) ? (docsRes.documents as PortalDocument[]) : []);
        setFolderColors(Array.isArray(docsRes?.folders) ? docsRes.folders : []);
        setDocumentsTruncated(!!docsRes?.truncated);
        setMatters(Array.isArray(mattersRes?.matters) ? (mattersRes.matters as MatterLite[]) : []);
      } catch (err) {
        if (!active) return;
        const message = getErrorMessage(err, "Failed to load documents");
        if (!message.toLowerCase().includes("not associated")) setError(message);
      } finally {
        if (active) setLoading(false);
      }
    };

    load();
    return () => {
      active = false;
    };
  }, [lawFirmId, user, associationsLoading, selectionRequired, clientRecordId]);

  // Once documents are loaded, honor a ?highlight=<objectPath> deep-link: open the
  // document's group/folder and ring it. Runs once so the client can browse away.
  useEffect(() => {
    if (highlightHandled.current || !highlightPath || documents.length === 0) return;
    const target = documents.find((d) => d.objectPath && d.objectPath === highlightPath);
    if (!target) return;
    highlightHandled.current = true;
    const segs = (target.name || "").split("/").filter(Boolean);
    /* eslint-disable react-hooks/set-state-in-effect -- one-time sync of the ?highlight URL param into browse location */
    setOpenGroup(target.matterId || CLIENT_GROUP_KEY);
    setFolderPath(segs.slice(0, -1));
    setHighlightId(target.id);
    /* eslint-enable react-hooks/set-state-in-effect */
    const t = setTimeout(() => setHighlightId(null), 4000);
    return () => clearTimeout(t);
  }, [documents, highlightPath]);

  const matterTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of matters) {
      map.set(c.id, c.matterNumber ? `${c.title} (${c.matterNumber})` : c.title);
    }
    return map;
  }, [matters]);

  const groupLabel = useCallback(
    (key: string) => {
      if (key === CLIENT_GROUP_KEY) return "Client files";
      return matterTitleById.get(key) || "Matter documents";
    },
    [matterTitleById],
  );

  // Documents grouped by matter (or the client-files bucket), each as a top-level
  // "folder" the client opens to browse.
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; docs: PortalDocument[] }>();
    for (const doc of documents) {
      const key = doc.matterId || CLIENT_GROUP_KEY;
      if (!map.has(key)) map.set(key, { key, docs: [] });
      map.get(key)!.docs.push(doc);
    }
    return Array.from(map.values())
      .map((g) => ({ ...g, label: groupLabel(g.key) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [documents, groupLabel]);

  const openGroupDocs = useMemo(
    () => (openGroup ? groups.find((g) => g.key === openGroup)?.docs ?? [] : []),
    [groups, openGroup],
  );

  // Folder color keyed by `${group}::${relPath}`, so each browsed folder can show
  // the color the firm chose for it (matching the firm-side file views). Folders
  // without a chosen color fall back to the shared default.
  const folderColorByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const fc of folderColors) {
      if (!fc.folderColor) continue;
      const group = fc.matterId ?? CLIENT_GROUP_KEY;
      map.set(`${group}::${fc.relPath}`, fc.folderColor);
    }
    return map;
  }, [folderColors]);

  // Immediate children (subfolders + files) of the current folder within the open
  // group, derived from each document's full relative path.
  const { folders, files } = useMemo(() => {
    const folderSet = new Map<string, number>(); // folder name -> contained file count
    const fileList: { doc: PortalDocument; name: string }[] = [];
    for (const doc of openGroupDocs) {
      const segs = doc.name.split("/").filter(Boolean);
      // Skip docs that aren't under the current folder path.
      let underPath = true;
      for (let i = 0; i < folderPath.length; i++) {
        if (segs[i] !== folderPath[i]) {
          underPath = false;
          break;
        }
      }
      if (!underPath || segs.length <= folderPath.length) continue;

      if (segs.length === folderPath.length + 1) {
        // A file directly in this folder.
        fileList.push({ doc, name: segs[segs.length - 1] });
      } else {
        // A nested folder: count it and tally its descendants.
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

  // Folders and files share one pager, so a page holds a fixed number of rows
  // whatever the mix, and folders keep their place ahead of files across pages.
  const browserEntries = useMemo(
    () => [
      ...folders.map((folder) => ({ kind: "folder" as const, folder })),
      ...files.map((file) => ({ kind: "file" as const, file })),
    ],
    [folders, files],
  );

  // Flat, cross-group search results (path shown for context).
  const searchResults = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    return documents
      .filter((d) => d.name.toLowerCase().includes(term))
      .sort((a, b) => baseName(a.name).localeCompare(baseName(b.name)));
  }, [documents, search]);

  const isSearching = search.trim().length > 0;

  // One pager per view: the matter/client groups at the root, the contents of the
  // folder being browsed, and the search results. Each restarts at page 1 when
  // the set it is showing becomes a different set.
  const groupsPager = usePagedRows(groups, 9);
  const browserPager = usePagedRows(
    browserEntries,
    15,
    `${openGroup ?? ""}::${folderPath.join("/")}`,
  );
  const searchPager = usePagedRows(searchResults, 15, search.trim().toLowerCase());

  const resetToRoot = () => {
    setOpenGroup(null);
    setFolderPath([]);
  };

  // Up one level: into the parent folder, or back to the matter list at the root.
  const goUp = () => {
    if (folderPath.length > 0) {
      setFolderPath((prev) => prev.slice(0, -1));
    } else {
      setOpenGroup(null);
    }
  };

  // A shared portal document, in the shape the preview takes.
  const toPreview = (doc: PortalDocument, url: string): PreviewableFile => ({
    name: baseName(doc.name),
    size: doc.size,
    contentType: doc.type,
    signedUrl: url,
  });

  // Re-pull the shared-documents list after an upload or request fulfillment so
  // newly added files show up without a full page reload.
  const refreshDocuments = useCallback(async () => {
    try {
      const docsRes = await clientPortalService.getDocuments(lawFirmId, clientRecordId);
      setDocuments(Array.isArray(docsRes?.documents) ? (docsRes.documents as PortalDocument[]) : []);
      setFolderColors(Array.isArray(docsRes?.folders) ? docsRes.folders : []);
    } catch {
      // Non-fatal: the upload UI already surfaced any error it hit.
    }
  }, [lawFirmId, clientRecordId]);

  const handleOpen = async (doc: PortalDocument) => {
    setOpeningId(doc.id);
    openDocRequestRef.current = doc.id;
    setError(null);
    try {
      // Listings carry no URL, so one is signed for the document being opened.
      // Works for every source (matter, client area, standalone task); the old
      // matter-only path left client and task documents with nothing to open.
      let url = doc.downloadUrl;
      if (doc.objectPath) {
        const refreshed = await clientPortalService.refreshDocumentUrl(lawFirmId, doc.objectPath, clientRecordId);
        url = refreshed.downloadUrl;
      }
      if (!url) throw new Error("This document is no longer available.");
      // A newer click may have started a fetch for a different document while
      // this one was in flight; a slower response here would otherwise
      // silently replace whatever the user has since opened.
      if (openDocRequestRef.current !== doc.id) return;
      setPreviewFile(toPreview(doc, url));
    } catch (err) {
      if (openDocRequestRef.current === doc.id) {
        setError(getErrorMessage(err, "Failed to open document"));
      }
    } finally {
      setOpeningId((current) => (current === doc.id ? null : current));
    }
  };

  // Save the document to the device (re-signing a fresh URL first, like open).
  const handleDownload = async (doc: PortalDocument) => {
    setDownloadingId(doc.id);
    setError(null);
    try {
      let url = doc.downloadUrl;
      if (doc.objectPath) {
        const refreshed = await clientPortalService.refreshDocumentUrl(lawFirmId, doc.objectPath, clientRecordId);
        url = refreshed.downloadUrl;
      }
      if (!url) throw new Error("This document is no longer available.");
      await filesService.downloadFile(url, baseName(doc.name));
    } catch (err) {
      setError(getErrorMessage(err, "Failed to download document"));
    } finally {
      setDownloadingId(null);
    }
  };

  if (selectionRequired) {
    return <ClientRecordPicker associations={associations} onSelect={setActiveClientRecordId} />;
  }

  if (loading) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto min-w-0">
        <ListSkeleton rows={8} label="Loading your documents" />
      </div>
    );
  }

  const renderFolderRow = (folder: { name: string; count: number }) => {
    const relPath = [...folderPath, folder.name].join("/");
    const fc = getFolderColorDef(
      openGroup ? folderColorByKey.get(`${openGroup}::${relPath}`) : null,
    );
    return (
      <button
        key={`folder:${folder.name}`}
        onClick={() => setFolderPath((prev) => [...prev, folder.name])}
        className="w-full text-left px-5 py-3.5 flex items-center gap-3 hover:bg-surface-hover transition-colors"
      >
        <div className={`p-2 rounded-xl flex-shrink-0 ${fc.bg} ${fc.darkBg} ${fc.icon}`}>
          <Folder className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-on-surface truncate">{folder.name}</p>
          <p className="text-[11px] text-on-surface-muted mt-0.5">
            {folder.count} file{folder.count !== 1 ? "s" : ""}
          </p>
        </div>
        <ChevronRight className="w-4 h-4 text-on-surface-muted flex-shrink-0" />
      </button>
    );
  };

  const renderFileRow = (doc: PortalDocument, label: string, subtitle: string) => {
    const Icon = getFileIcon(doc);
    const isOpening = openingId === doc.id;
    const isDownloading = downloadingId === doc.id;
    const highlighted = highlightId === doc.id;
    return (
      <div
        key={doc.id}
        ref={highlighted ? (el) => el?.scrollIntoView({ block: "center", behavior: "smooth" }) : undefined}
        className={`w-full flex items-center transition-colors ${
          highlighted
            ? "bg-accent-soft ring-2 ring-inset ring-focus-ring"
            : "hover:bg-surface-hover"
        }`}
      >
        {/* Click the row to open the document in the preview modal. */}
        <button
          onClick={() => handleOpen(doc)}
          disabled={isOpening}
          className="min-w-0 flex-1 text-left pl-5 py-3.5 flex items-center gap-3 disabled:opacity-60 cursor-pointer"
        >
          <div className="p-2 rounded-xl bg-accent-soft dark:bg-accent-soft text-accent-emphasis flex-shrink-0">
            <Icon className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <p className="text-sm font-medium text-on-surface truncate">{label}</p>
              {doc.isNew && (
                <span className="flex-shrink-0 inline-flex items-center rounded-md bg-accent-selection text-accent-foreground dark:bg-accent-solid text-[10px] font-bold px-1.5 py-0.5 leading-none uppercase tracking-wide">
                  New
                </span>
              )}
            </div>
            <p className="text-[11px] text-on-surface-muted mt-0.5">{subtitle}</p>
          </div>
        </button>
        {/* Dedicated download button (separate from opening the preview). */}
        <div className="flex-shrink-0 pr-4 pl-2 py-3.5">
          <button
            onClick={() => handleDownload(doc)}
            disabled={isDownloading}
            aria-label={`Download ${label}`}
            title="Download"
            className="p-2 rounded-lg text-on-surface-muted hover:bg-accent-soft dark:hover:bg-accent-soft hover:text-accent-emphasis dark:hover:text-accent-emphasis transition-[background-color,color,transform] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed active:scale-[0.96] motion-reduce:active:scale-100"
          >
            {isDownloading ? <LoadingSpinner size="sm" /> : <Download className="w-4 h-4" />}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="p-8 pb-16 max-w-[1600px] mx-auto min-w-0">
      {/* Header */}
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-on-surface">Documents</h1>
          <p className="text-sm text-on-surface-muted mt-1">
            Files your legal team has shared with you. Click any document to open or download it.
          </p>
        </div>
        {matters.length > 0 && (
          <Button
            size="compact"
            onClick={() => setUploadOpen(true)}
            icon={<Upload size={14} strokeWidth={2.2} />}
          >
            Upload
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-6">
          <ErrorNotification error={error} onClose={() => setError(null)} />
        </div>
      )}

      <TruncatedListNotice truncated={documentsTruncated} unitLabel="documents" className="mb-6" />

      {/* Documents the firm has asked this client to provide. */}
      <RequestedDocumentsPanel
        lawFirmId={lawFirmId}
        clientRecordId={clientRecordId}
        matterTitleById={matterTitleById}
        onFulfilled={refreshDocuments}
      />

      {/* Search */}
      {documents.length > 0 && (
        <ListToolbar className="mb-6">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-muted" />
            <input
              aria-label="Search documents"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search documents…"
              className="w-full rounded-xl border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-9 pr-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </div>
        </ListToolbar>
      )}

      {/* Breadcrumb (only while browsing, not searching) */}
      {!isSearching && openGroup && (
        <div className="mb-4 flex items-center gap-2 text-sm flex-wrap">
          <button
            onClick={goUp}
            className="inline-flex items-center gap-1 rounded-lg border border-outline bg-surface px-2.5 py-1 font-medium text-on-surface hover:bg-surface-hover transition-[background-color,border-color,color,transform] cursor-pointer active:scale-[0.96] motion-reduce:active:scale-100"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back
          </button>
          <span className="text-on-surface-muted">·</span>
          <button onClick={resetToRoot} className="text-accent-emphasis hover:text-accent-emphasis-hover dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer">
            Documents
          </button>
          <ChevronRight className="w-3.5 h-3.5 text-on-surface-muted" />
          <button
            onClick={() => setFolderPath([])}
            className={folderPath.length === 0 ? "text-on-surface font-medium" : "text-accent-emphasis hover:text-accent-emphasis-hover dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer"}
          >
            {groupLabel(openGroup)}
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

      {/* Empty state */}
      {documents.length === 0 ? (
        <ListEmptyState
          icon={<FolderOpen className="w-8 h-8" />}
          title="No documents yet"
          message="When your legal team shares a file with you, it will appear here."
        />
      ) : isSearching ? (
        /* ---- Search results (flat, across all matters) ---- */
        searchResults.length === 0 ? (
          <ListEmptyState
            icon={<Search className="w-8 h-8" />}
            title="No matching documents"
            message="Try a different search term."
          />
        ) : (
          <Card className="divide-y divide-outline-subtle">
            {searchPager.pagedRows.map((doc) => {
              const folderHint = doc.name.includes("/")
                ? `${groupLabel(doc.matterId || CLIENT_GROUP_KEY)} · ${doc.name.split("/").slice(0, -1).join(" / ")}`
                : groupLabel(doc.matterId || CLIENT_GROUP_KEY);
              return renderFileRow(
                doc,
                baseName(doc.name),
                `${folderHint} · ${formatBytes(doc.size)}`,
              );
            })}
            {searchPager.total > searchPager.rowsPerPage && (
              <div className="px-5 py-3">
                <AutoPager pager={searchPager} />
              </div>
            )}
          </Card>
        )
      ) : !openGroup ? (
        /* ---- Top level: list of matters / client-files group ---- */
        <>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {groupsPager.pagedRows.map((group) => (
            <button
              key={group.key}
              onClick={() => {
                setOpenGroup(group.key);
                setFolderPath([]);
              }}
              className="text-left bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-5 flex items-center gap-3 hover:bg-surface-hover transition-colors"
            >
              <div className="p-2.5 rounded-xl bg-accent-soft dark:bg-accent-soft text-accent-emphasis flex-shrink-0">
                <FolderOpen className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-sm font-semibold text-on-surface truncate">{group.label}</p>
                  {(() => {
                    const newCount = group.docs.filter((d) => d.isNew).length;
                    return newCount > 0 ? (
                      <span className="flex-shrink-0 inline-flex items-center rounded-md bg-accent-selection text-accent-foreground dark:bg-accent-solid text-[10px] font-bold px-1.5 py-0.5 leading-none">
                        {newCount} new
                      </span>
                    ) : null;
                  })()}
                </div>
                <p className="text-[11px] text-on-surface-muted mt-0.5">
                  {group.docs.length} file{group.docs.length !== 1 ? "s" : ""}
                </p>
              </div>
              <ChevronRight className="w-4 h-4 text-on-surface-muted flex-shrink-0" />
            </button>
          ))}
        </div>
        {groupsPager.total > groupsPager.rowsPerPage && (
          <div className="mt-4 bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] px-5 py-3">
            <AutoPager pager={groupsPager} />
          </div>
        )}
        </>
      ) : (
        /* ---- Inside a matter: folder browser ---- */
        <Card>
          {browserEntries.length === 0 ? (
            <ListEmptyState
              compact
              icon={<FolderOpen className="w-8 h-8" />}
              title="This folder is empty"
              className="border-0"
            />
          ) : (
            <div className="divide-y divide-outline-subtle">
              {browserPager.pagedRows.map((entry) =>
                entry.kind === "folder"
                  ? renderFolderRow(entry.folder)
                  : renderFileRow(
                      entry.file.doc,
                      entry.file.name,
                      `${formatBytes(entry.file.doc.size)} · Shared ${formatDate(entry.file.doc.uploadedAt)}`,
                    ),
              )}
              {browserPager.total > browserPager.rowsPerPage && (
                <div className="px-5 py-3">
                  <AutoPager pager={browserPager} />
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      <FilePreviewModal
        file={previewFile}
        isOpen={!!previewFile}
        onClose={() => { openDocRequestRef.current = null; setPreviewFile(null); }}
        onDownload={() => {
          if (previewFile?.signedUrl) {
            filesService.downloadFile(previewFile.signedUrl, previewFile.name);
          }
        }}
      />

      <UploadDocumentModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        lawFirmId={lawFirmId}
        clientRecordId={clientRecordId}
        matters={matters}
        onUploaded={refreshDocuments}
      />
    </div>
  );
}
