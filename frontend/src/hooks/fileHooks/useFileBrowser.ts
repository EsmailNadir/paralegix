"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FilesService, { type FileInfo } from "@/services/files.service";
import { type FileScope, scopeKey } from "@/lib/files/fileScope";
import { sortFileRows, type FolderCrumb } from "@/lib/files/filePaths";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants/search";
import { getErrorMessage } from "@/lib/utils/apiErrors";

/** How the rows on screen were produced, which decides what "truncated" means. */
export type BrowseMode = "browse" | "search";

export interface FileBrowserState {
  /** Rows to render: folders first, then files, each alphabetical. */
  files: FileInfo[];
  /** The trail from the scope root to the open folder. Empty at the root. */
  trail: FolderCrumb[];
  /** The open folder's id, or null at the scope root. */
  currentFolderId: string | null;
  /** Initial load / folder change. Search keeps the previous rows visible instead. */
  loading: boolean;
  /** A search request is in flight (rows on screen are the previous answer). */
  searching: boolean;
  error: string | null;
  /** The raw search box value (updates on every keystroke). */
  searchQuery: string;
  /** The debounced value the server was actually asked about. */
  activeQuery: string;
  /** True when the rows are search hits rather than a folder listing. */
  isSearching: boolean;
  /** Set when the server stopped short of a complete answer. Always null now. */
  truncatedMode: BrowseMode | null;
  /** True when the open folder (or an ancestor) is shared with the client. */
  inheritedShared: boolean;

  setSearchQuery: (value: string) => void;
  setError: (value: string | null) => void;
  /** Navigate into a folder row. */
  openFolder: (folder: FileInfo) => void;
  /** Jump to a folder anywhere in the scope, given its full trail. */
  goToTrail: (trail: FolderCrumb[]) => void;
  /** Up one level. */
  goUp: () => void;
  /** Truncate the trail at `index` (breadcrumb click). */
  goToBreadcrumb: (index: number) => void;
  /** Re-fetch whatever is on screen - the folder, or the active search. */
  reload: () => Promise<void>;
  /** Patch loaded rows in place, for optimistic updates. */
  patchFiles: (updater: (files: FileInfo[]) => FileInfo[]) => void;
}

/**
 * The state behind a file browser: what folder it is showing, what was searched
 * for, and the rows that came back.
 *
 * Both firm-side browsers grew their own copy of this, and they drifted - the
 * two answered the same query differently, and a fix to one silently left the
 * other broken. The pickers each had a third of it.
 *
 * Navigation and search are deliberately exclusive: a search reads the whole
 * scope, so a hit can live anywhere under it, and opening one has to move the
 * browser to where the hit actually is rather than to a child of wherever the
 * user happens to be standing.
 *
 * The browser moves by FOLDER ID. It used to move by a path of folder names,
 * which meant every listing request rebuilt that path and the server walked it
 * back to a row; a rename anywhere above the open folder broke the trail the
 * browser was holding.
 */
export function useFileBrowser({
  lawFirmId,
  scope,
  initialTrail,
  enabled = true,
  trail: controlledTrail,
  onTrailChange,
  onError,
}: {
  lawFirmId: string;
  scope: FileScope;
  /** Folder trail to open at. */
  initialTrail?: FolderCrumb[];
  /** When false the browser holds no rows and issues no requests. */
  enabled?: boolean;
  /**
   * The open folder trail, when the host owns it. Supply it together with
   * `onTrailChange` to keep navigation in the host's own location model (the
   * Files page mirrors view + entity + folder into one history entry). Omit
   * both and the browser keeps its own trail.
   */
  trail?: FolderCrumb[];
  onTrailChange?: (trail: FolderCrumb[]) => void;
  onError?: (message: string) => void;
}): FileBrowserState {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [internalTrail, setInternalTrail] = useState<FolderCrumb[]>(initialTrail ?? []);
  const controlled = controlledTrail !== undefined;
  const trail = controlled ? controlledTrail : internalTrail;
  const currentFolderId = trail.length > 0 ? trail[trail.length - 1].id : null;
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [truncatedMode, setTruncatedMode] = useState<BrowseMode | null>(null);
  const [inheritedShared, setInheritedShared] = useState(false);

  // The scope is usually built inline by the caller, so it is a new object on
  // every render. Effects key on its serialization instead, or they re-fetch
  // forever.
  const key = scopeKey(scope);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const initialTrailKey = (initialTrail ?? []).map((c) => c.id).join("/");

  // Held in a ref rather than closed over: callers pass an inline arrow, so a
  // handler in `load`'s dependency list would give it a new identity on every
  // render and turn the fetch effect into a render loop.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const reportError = useCallback((err: unknown, fallback: string) => {
    const message = getErrorMessage(err, fallback);
    setError(message);
    onErrorRef.current?.(message);
  }, []);

  // Debounce the search box: one request when typing stops, not one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setActiveQuery(searchQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Bumped at the START of every `load()` call, whichever of its two callers
  // started it. A response is applied only if this still matches the id it
  // captured when it began, so starting a NEWER load - whether the location
  // effect below re-firing, or an explicit `reload()` - invalidates whatever
  // older call is still in flight.
  //
  // `reload()` is what closes the gap the effect's own cleanup cannot: it is
  // what `useFileActions` calls after a delete/move/rename resolves, and by
  // then the user may already have navigated elsewhere. That call captured
  // `currentPath` at the render it was created in, so without this guard its
  // answer - for a folder nobody is looking at anymore - would land on
  // whatever folder is on screen when it finally resolves.
  const loadIdRef = useRef(0);

  /**
   * Fetch the rows for the current location.
   *
   * Search keeps the previous rows on screen while the new answer is in flight
   * (typing should not blank the list); navigating clears them, because the
   * previous folder's contents are not a stale version of this folder's, they
   * are someone else's.
   */
  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    const isCurrent = () => loadIdRef.current === loadId;

    if (!enabled) {
      setFiles([]);
      setLoading(false);
      setSearching(false);
      setError(null);
      return;
    }

    const query = activeQuery;
    const isSearch = query.length > 0;
    if (isSearch) {
      setSearching(true);
    } else {
      setLoading(true);
      setFiles([]);
    }
    setError(null);

    try {
      const response = isSearch
        ? await FilesService.search(lawFirmId, scopeRef.current, query)
        : await FilesService.listFolder(lawFirmId, scopeRef.current, currentFolderId ?? undefined);
      if (!isCurrent()) return;
      setFiles(sortFileRows(response.files ?? []));
      // A search spans the whole scope, so folder-level inheritance says nothing
      // about the hits; only a folder listing reports it.
      setInheritedShared(isSearch ? false : !!response.inheritedClientVisible);
      setTruncatedMode(response.truncated ? (isSearch ? "search" : "browse") : null);
    } catch (err) {
      if (!isCurrent()) return;
      reportError(err, "Failed to load files");
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setSearching(false);
      }
    }
  }, [enabled, lawFirmId, currentFolderId, activeQuery, reportError]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: loading/result state is set as the request progresses
    load();
  }, [load, key]);

  // Switching to a different matter/task/client puts the browser back at that
  // scope's root; the trail it was on belongs to the entity it just left.
  // Guarded on the scope it last reset for, because the path it writes is a new
  // array even when the segments are unchanged: running this on mount would
  // count as a move everywhere downstream - a second listing request for the
  // folder just fetched, and a history entry for a folder nobody opened.
  const resetKey = `${key}|${initialTrailKey}`;
  const lastResetKey = useRef(resetKey);
  const initialTrailRef = useRef(initialTrail);
  initialTrailRef.current = initialTrail;
  useEffect(() => {
    if (lastResetKey.current === resetKey) return;
    lastResetKey.current = resetKey;
    if (!controlled) setInternalTrail(initialTrailRef.current ?? []);
  }, [resetKey, controlled]);

  // The search is cleared during render rather than in the effect above: the
  // fetch effect runs in the same commit as that one, so a query cleared there
  // would still reach the new scope's first request as the old scope's search.
  const [queryResetKey, setQueryResetKey] = useState(resetKey);
  if (queryResetKey !== resetKey) {
    setQueryResetKey(resetKey);
    setSearchQuery("");
    setActiveQuery("");
  }

  const goToTrail = useCallback((next: FolderCrumb[]) => {
    // Controlled: the host owns the trail, so moving means asking it to move.
    // Uncontrolled: we own it, and the effect below reports where we ended up.
    if (controlled) onTrailChange?.(next);
    else setInternalTrail(next);
    // A search spans the scope, so leaving one to open a folder means the rows
    // on screen no longer describe where the browser now is. The debounced query
    // clears at once too, or the new folder's first load re-runs the old search
    // and its hits sit under the new breadcrumb until the debounce catches up.
    setSearchQuery("");
    setActiveQuery("");
  }, [controlled, onTrailChange]);

  // Report the open folder while we own it - on mount too, not only on
  // navigation, because a browser that opens at `initialPath` is already
  // somewhere, and a host that uploads into "the current folder" needs to know
  // where that is before the user has moved.
  const onTrailChangeRef = useRef(onTrailChange);
  onTrailChangeRef.current = onTrailChange;
  useEffect(() => {
    if (controlled) return;
    onTrailChangeRef.current?.(internalTrail);
  }, [controlled, internalTrail]);

  const openFolder = useCallback(
    (folder: FileInfo) => goToTrail([...trail, { id: folder.id, name: folder.name }]),
    [goToTrail, trail]
  );

  const goUp = useCallback(
    () => goToTrail(trail.slice(0, -1)),
    [goToTrail, trail]
  );

  const goToBreadcrumb = useCallback(
    (index: number) => goToTrail(trail.slice(0, index + 1)),
    [goToTrail, trail]
  );

  const patchFiles = useCallback((updater: (files: FileInfo[]) => FileInfo[]) => {
    setFiles((prev) => updater(prev));
  }, []);

  // Stable, and reads the LATEST `load` when called. A mutation's reload is the
  // one captured by the render the action started in; if the user navigates
  // before it resolves, that reload starts after the navigation's own load and
  // so wins the `loadIdRef` race. Calling through the ref makes it fetch the
  // folder or search on screen now rather than the one the action began in.
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => loadRef.current(), []);

  return {
    files,
    trail,
    currentFolderId,
    loading,
    searching,
    error,
    searchQuery,
    activeQuery,
    isSearching: activeQuery.length > 0,
    truncatedMode,
    inheritedShared,
    setSearchQuery,
    setError,
    openFolder,
    goToTrail,
    goUp,
    goToBreadcrumb,
    reload,
    patchFiles,
  };
}
