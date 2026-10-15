"use client";

import { Fragment, useState, useEffect, useCallback, useMemo, useRef, startTransition } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import MattersService from "@/services/matters.service";
import TasksService from "@/services/tasks.service";
import { useMatterById } from "@/hooks/matterHooks/useMatters";
import { useClientById } from "@/hooks/clientHooks/useClients";
import { useTaskById } from "@/hooks/taskHooks/useTasks";
import useMattersTable, { type MatterSortField } from "@/hooks/matterHooks/useMattersTable";
import { matterListFilterParams } from "@/hooks/matterHooks/useMatters";
import useTasksTable from "@/hooks/taskHooks/useTasksTable";
import useClientsTable, { type ClientSortField } from "@/hooks/clientHooks/useClientsTable";
import type { ServerTableFilters } from "@/hooks/useServerTable";
import usePracticeAreas from "@/hooks/practiceHooks/usePracticeAreas";
import { useLawFirmUsers } from "@/hooks/useUsers";
import type { Client, Matter, OrderBy, Task, TaskStatus } from "@/types";
import LoadingSpinner from "@/components/LoadingSpinner";
import Spinner from "@/components/ui/Spinner";
import FileUpload from "@/components/filesComp/FileUpload";
import StorageUsageBar from "@/components/filesComp/StorageUsageBar";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Modal from "@/components/ui/Modal";
import { usePruneStaleFilters } from "@/hooks/usePruneStaleFilters";
import RequireFeature from "@/components/ui/RequireFeature";
import Button from "@/components/ui/Button";
import Tooltip from "@/components/ui/Tooltip";
import Toast from "@/components/ui/Toast";
import ListView, { ListRow, ListSelectionModel, ListSortColumn, SortDir } from "@/components/ui/ListView";
import ListSection from "@/components/ui/ListSection";
import ListToolbar from "@/components/ui/ListToolbar";
import EntityPicker from "@/components/ui/EntityPicker";
import { highlightText } from "@/components/ui/HighlightText";
import MatterStatusBadge from "@/components/ui/MatterStatusBadge";
import ClientStatusBadge from "@/components/ui/ClientStatusBadge";
import TaskStatusBadge from "@/components/ui/TaskStatusBadge";
import { MATTER_STATUS_META } from "@/constants/statusMeta";
import ErrorNotification from "@/components/ErrorNotification";
import Dropdown, { DropdownOption } from "@/components/ui/Dropdown";
import CategoryFilterDropdown from "@/components/ui/CategoryFilterDropdown";
import ClearFiltersButton from "@/components/ui/ClearFiltersButton";
import PageHeader from "@/components/ui/PageHeader";
import ClientPortalFilePreview, { type ClientPortalFilePreviewHandle } from "@/components/filesComp/ClientPortalFilePreview";
import type { ShareClient } from "@/components/filesComp/ClientSharePickerModal";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import FileBrowser from "@/components/filesComp/FileBrowser";
import { scopeFromIds, scopeKey } from "@/lib/files/fileScope";
import type { FolderCrumb } from "@/lib/files/filePaths";
import filesService from "@/services/files.service";
import { RefreshCw, Upload, Trash2, Briefcase, CheckSquare2, Users, Building2, ClipboardList, Mail, Phone, ExternalLink, FolderOpen, Eye } from 'lucide-react';
import SegmentedToggle from "@/components/ui/SegmentedToggle";
import SearchInput from "@/components/ui/SearchInput";
import useSlidingHighlight from "@/hooks/useSlidingHighlight";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useNavigation, SIDEBAR_RESELECT_EVENT } from "@/contexts/NavigationContext";

// --- Types ---

/** Stable empty path, so an unopened scope doesn't produce a new array per render. */
const EMPTY_BROWSER_TRAIL: FolderCrumb[] = [];

/**
 * Filter keys each dashboard tab persists and forwards to its server query. The
 * two sets are disjoint on purpose: matter statuses and task statuses are
 * different enums, so sharing one `status` slot would send a matter status to the
 * tasks endpoint (which rejects it) after a tab switch.
 */
const MATTER_FILTER_KEYS = ['status', 'practiceAreaId', 'leadUserId', 'category'] as const;
const TASK_FILTER_KEYS = ['taskStatus', 'assignedTo', 'matterId', 'priority'] as const;
/**
 * The clients tab sends its filters under the names its own endpoint expects, so
 * they collide by name with the other two tabs (`status` is a client status here,
 * a matter status there; `matterId` scopes clients rather than tasks). It
 * therefore persists under its own storage prefix instead of a disjoint key set.
 */
const CLIENT_FILTER_KEYS = ['status', 'matterId'] as const;

const FILTER_STORAGE_PREFIX = 'filesFilter_';
const CLIENT_FILTER_STORAGE_PREFIX = 'filesClientFilter_';

/** Restores persisted filter values for one tab. */
function readStoredFilters(
  keys: ReadonlyArray<string>,
  prefix: string = FILTER_STORAGE_PREFIX,
): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const stored: Record<string, string> = {};
  for (const key of keys) {
    try {
      const value = localStorage.getItem(`${prefix}${key}`);
      if (value) stored[key] = value;
    } catch {
      // localStorage may be unavailable (private mode); ignore.
    }
  }
  return stored;
}

/** Persists one tab's filter value. Never throws (private mode has no storage). */
function storeFilter(key: string, value: string, prefix: string = FILTER_STORAGE_PREFIX) {
  try {
    localStorage.setItem(`${prefix}${key}`, value);
  } catch {
    // localStorage may be unavailable (private mode); ignore.
  }
}

/**
 * What identifies one place on this page, for the history sync: the view, the
 * entity it has open, and the open folder. The folder trail rides along on the
 * history entry as the breadcrumb, but it is not part of the identity: the
 * Back/Forward and incoming-link handshakes know the folder they are restoring
 * to before they know its trail, so both sides of that handshake compare on
 * this key and nothing else.
 */
function locationKey(loc: {
  activeView: string;
  activeMatterId: string | null;
  activeTaskId: string | null;
  activeClientId: string | null;
  folderId: string | null;
}): string {
  return JSON.stringify([loc.activeView, loc.activeMatterId, loc.activeTaskId, loc.activeClientId, loc.folderId]);
}

/** Ordering the task list opens on, matching its first sort column. */
const TASK_DEFAULT_SORT: Array<{ field: OrderBy; sort: 'asc' | 'desc' }> = [{ field: 'title', sort: 'asc' }];

export default function FilesPage() {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const searchParams = useSearchParams();
  const { navigate } = useNavigation();
  const queryClient = useQueryClient();
  const { hasPermission, loading: permissionsLoading } = usePermissions();
  const canViewFiles = hasPermission("files.view");
  const canUploadFiles = hasPermission("files.upload");
  // Deleting a matter or task row from this page's entity grids is a
  // matters/tasks mutation, not a files one - `files.delete` (checked by
  // FileBrowser itself, separately, for the folder-browsing view) does not
  // apply here. Matches MattersGrid.tsx / TasksGrid.tsx.
  const canDeleteMatter = hasPermission("matters.delete");
  const canDeleteTask = hasPermission("tasks.delete");
  const canRequestDocuments = hasPermission("documents.request");

  // --- State Management ---

  // Folder browser state, keyed by entity id. Only entities the user has actually
  // opened get an entry; nothing here depends on the entity being present in the
  // currently loaded grid page.
  // Dashboard grid tab: Matters, Tasks, or Clients
  const [gridTab, setGridTab] = useState<'matters' | 'tasks' | 'clients' | 'lawFirm'>('matters');
  const gridTabHighlight = useSlidingHighlight<HTMLDivElement>(gridTab);

  // Navigation State, synced with browser history so back button works
  const [activeView, setActiveViewRaw] = useState<'dashboard' | 'lawFirm' | 'matter' | 'task' | 'client'>(() => {
    if (typeof window === 'undefined') return 'dashboard';
    const view = new URLSearchParams(window.location.search).get('view');
    if (view === 'matter') return 'matter';
    if (view === 'task') return 'task';
    if (view === 'client') return 'client';
    if (view === 'lawFirm') return 'lawFirm';
    return 'dashboard';
  });
  const [activeMatterId, setActiveMatterIdRaw] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('matterId') ?? null;
  });
  const [activeTaskId, setActiveTaskIdRaw] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('taskId') ?? null;
  });
  const [activeClientId, setActiveClientIdRaw] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('clientId') ?? null;
  });
  // Browser-history sync. `lastLocRef` holds the serialized location we last
  // reflected (view + entity + folder path) so we push exactly one entry per real
  // change and never duplicate; `pendingRestoreRef` suppresses pushes while a
  // Back/Forward restore settles.
  const lastLocRef = useRef<string | null>(null);
  // While restoring from Back/Forward, holds the target location key; pushes are
  // suppressed until the location settles to it.
  const pendingRestoreRef = useRef<string | null>(null);
  const isInitialRender = useRef(true);

  // Wrapper that pushes browser history when navigating
  const setActiveView = useCallback((view: 'dashboard' | 'lawFirm' | 'matter' | 'task' | 'client') => {
    setActiveViewRaw(view);
  }, []);
  const setActiveMatterId = useCallback((id: string | null) => {
    setActiveMatterIdRaw(id);
  }, []);
  const setActiveTaskId = useCallback((id: string | null) => {
    setActiveTaskIdRaw(id);
  }, []);
  const setActiveClientId = useCallback((id: string | null) => {
    setActiveClientIdRaw(id);
  }, []);

  // The open folder, kept per scope so returning to a matter lands where it was
  // left. The browser is a controlled component over this, which is what lets one
  // history entry describe view + entity + folder together.
  //
  // A trail of ids and names, not a path of names. The URL carries only the
  // open folder's ID (`?folderId=`), because that is what identifies it: two
  // folders in different parts of one matter can share a name, and a name in the
  // URL stopped meaning anything the moment someone renamed a folder above it.
  // The names for the breadcrumb are fetched once, from the folder id.
  const [trailByScope, setTrailByScope] = useState<Record<string, FolderCrumb[]>>({});
  // Bumped by the Refresh button to re-fetch what the browser is showing.
  const [browserReloadKey, setBrowserReloadKey] = useState(0);
  // The scope currently on screen is resolved further down (it depends on the
  // task file-source toggle), so the history effect reads the open folder through
  // this rather than being moved below everything it doesn't otherwise need.
  const [activeTrail, setActiveTrail] = useState<FolderCrumb[]>([]);

  // Sync the URL + history entry with view/entity AND the open folder path. One
  // entry per real location change (deduped by `lastLocRef`), so the browser Back
  // button steps up one folder, then out of the entity, then back to the grid.
  useEffect(() => {
    const activeFolderId = activeTrail.length > 0 ? activeTrail[activeTrail.length - 1].id : null;
    const state = { activeView, activeMatterId, activeTaskId, activeClientId, folderId: activeFolderId, trail: activeTrail };
    const url = new URL(window.location.href);
    if (activeView === 'matter' && activeMatterId) {
      url.searchParams.set('view', 'matter');
      url.searchParams.set('matterId', activeMatterId);
      url.searchParams.delete('taskId');
      url.searchParams.delete('clientId');
    } else if (activeView === 'task' && activeTaskId) {
      url.searchParams.set('view', 'task');
      url.searchParams.set('taskId', activeTaskId);
      url.searchParams.delete('matterId');
      url.searchParams.delete('clientId');
    } else if (activeView === 'client' && activeClientId) {
      url.searchParams.set('view', 'client');
      url.searchParams.set('clientId', activeClientId);
      url.searchParams.delete('matterId');
      url.searchParams.delete('taskId');
    } else if (activeView === 'lawFirm') {
      url.searchParams.set('view', 'lawFirm');
      url.searchParams.delete('matterId');
      url.searchParams.delete('taskId');
      url.searchParams.delete('clientId');
    } else {
      url.searchParams.delete('view');
      url.searchParams.delete('matterId');
      url.searchParams.delete('taskId');
      url.searchParams.delete('clientId');
    }
    if (activeFolderId) url.searchParams.set('folderId', activeFolderId);
    else url.searchParams.delete('folderId');

    const locKey = locationKey(state);
    if (isInitialRender.current) {
      isInitialRender.current = false;
      lastLocRef.current = locKey;
      window.history.replaceState(state, '', url.toString());
      return;
    }
    // During a Back/Forward restore, never push; just track when we've settled on
    // the restored location (the async folder reload may take a couple renders).
    // Settling rewrites the current entry rather than adding one: an incoming
    // folder link lands before its trail is fetched, so the entry written on
    // mount has neither the folder in its URL nor the trail Back needs.
    if (pendingRestoreRef.current !== null) {
      if (locKey === pendingRestoreRef.current) {
        pendingRestoreRef.current = null;
        lastLocRef.current = locKey;
        window.history.replaceState(state, '', url.toString());
      }
      return;
    }
    if (locKey === lastLocRef.current) return; // no real change (e.g. a loading flip)
    lastLocRef.current = locKey;
    window.history.pushState(state, '', url.toString());
  }, [activeView, activeMatterId, activeTaskId, activeClientId, activeTrail]);

  // Listen for browser back/forward
  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      const s = e.state as {
        activeView?: string; activeMatterId?: string | null; activeTaskId?: string | null;
        activeClientId?: string | null; folderId?: string | null; trail?: FolderCrumb[];
      } | null;
      // Compute the exact location we're restoring to and suppress pushes until the
      // sync effect observes it (covers the multi-render async folder reload).
      pendingRestoreRef.current = locationKey({
        activeView: s?.activeView ?? 'dashboard',
        activeMatterId: s?.activeMatterId ?? null,
        activeTaskId: s?.activeTaskId ?? null,
        activeClientId: s?.activeClientId ?? null,
        folderId: s?.folderId ?? null,
      });
      setActiveViewRaw((s?.activeView as any) ?? 'dashboard');
      setActiveMatterIdRaw(s?.activeMatterId ?? null);
      setActiveTaskIdRaw(s?.activeTaskId ?? null);
      setActiveClientIdRaw(s?.activeClientId ?? null);
      setIsUploading(false);
      // Put the restored folder back on the scope it belongs to, so the sync
      // effect sees the restored location immediately and doesn't re-push.
      const restoredScope = scopeFromIds({
        matterId: s?.activeView === 'matter' ? s.activeMatterId : null,
        taskId: s?.activeView === 'task' ? s.activeTaskId : null,
        clientId: s?.activeView === 'client' ? s.activeClientId : null,
      });
      // The trail rides on the history entry, so Back restores the breadcrumb
      // without a request. The id alone would name the folder but not the
      // folders above it.
      const restoredTrail = Array.isArray(s?.trail) ? s.trail : [];
      setTrailByScope((prev) => ({ ...prev, [scopeKey(restoredScope)]: restoredTrail }));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Re-sync the view from the URL on a genuine incoming navigation - a "Filed
  // in" link on a signing session, a matter's "View Files" button, anything
  // that lands here from elsewhere in the app via `router.push`.
  //
  // The view/entity/path above are otherwise seeded from `window.location`
  // only once, in the `useState` initializers above, and this page manages ITS
  // OWN history entries with raw `history.pushState`/`replaceState` (the sync
  // effect a few lines up) specifically so in-page view changes don't cost a
  // real Next.js transition. `useSearchParams()` is fed by Next's router, not
  // by those raw calls, so it never reacts to this page's own writes - only to
  // an actual incoming navigation. That is what makes it safe to resync from
  // here: if Next's router cache keeps this page instance alive across a
  // revisit (no remount, so the mount-time initializers never re-run), this is
  // the only thing left that notices the URL now points somewhere else.
  useEffect(() => {
    const view = searchParams.get('view');
    const nextView: typeof activeView =
      view === 'matter' || view === 'task' || view === 'client' || view === 'lawFirm' ? view : 'dashboard';
    const nextMatterId = nextView === 'matter' ? searchParams.get('matterId') : null;
    const nextTaskId = nextView === 'task' ? searchParams.get('taskId') : null;
    const nextClientId = nextView === 'client' ? searchParams.get('clientId') : null;
    const nextFolderId = searchParams.get('folderId');

    const nextScope = scopeFromIds({ matterId: nextMatterId, taskId: nextTaskId, clientId: nextClientId });
    const currentScopeKey = scopeKey(nextScope);
    const currentTrail = trailByScope[currentScopeKey] ?? [];
    const currentFolderId = currentTrail.length > 0 ? currentTrail[currentTrail.length - 1].id : null;

    if (
      nextView === activeView &&
      nextMatterId === activeMatterId &&
      nextTaskId === activeTaskId &&
      nextClientId === activeClientId &&
      nextFolderId === currentFolderId
    ) {
      return;
    }

    // Suppresses the sync effect's own push once it observes this exact
    // location, the same handshake `onPopState` above uses.
    const target = {
      activeView: nextView,
      activeMatterId: nextMatterId,
      activeTaskId: nextTaskId,
      activeClientId: nextClientId,
      folderId: nextFolderId,
    };
    pendingRestoreRef.current = locationKey(target);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resyncs the page's view from an incoming navigation the URL-derived initializers otherwise never see again after mount
    setActiveViewRaw(nextView);
    if (nextView === 'lawFirm') setGridTab('lawFirm');
    setActiveMatterIdRaw(nextMatterId);
    setActiveTaskIdRaw(nextTaskId);
    setActiveClientIdRaw(nextClientId);
    // An incoming link carries only the folder id, so the crumb names above it
    // are resolved once. Until they arrive the browser sits at that folder with
    // a one-crumb trail, which is where the link asked for.
    if (!nextFolderId) {
      setTrailByScope((prev) => ({ ...prev, [currentScopeKey]: [] }));
    } else {
      void filesService.folderTrail(lawFirmId, nextFolderId)
        .then((trail: FolderCrumb[]) => setTrailByScope((prev) => ({ ...prev, [currentScopeKey]: trail })))
        .catch(() => {
          // The linked folder is gone, so the page settles at the scope root
          // instead; wait for that, or pushes stay held for a folder that will
          // never open.
          if (pendingRestoreRef.current === locationKey(target)) {
            pendingRestoreRef.current = locationKey({ ...target, folderId: null });
          }
          setTrailByScope((prev) => ({ ...prev, [currentScopeKey]: [] }));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only an incoming URL change should trigger this; activeView/activeMatterId/etc. are read for comparison, not depended on
  }, [searchParams]);

  // UI State
  const [isUploading, setIsUploading] = useState(false);
  const [storageRefreshTrigger, setStorageRefreshTrigger] = useState(0);
  const [notification, setNotification] = useState<{ message: string; severity: 'success' | 'error' | 'warning' } | null>(null);
  // One search box drives all three entity lists plus the folder browser: the
  // grids forward it to their server query (each table hook debounces it), while
  // inside a folder it filters the loaded file listing.
  const [searchTerm, setSearchTerm] = useState('');

  const showPermissionError = useCallback((message: string) => {
    setNotification({ message, severity: 'error' });
  }, []);

  // ===== Server-paged entity lists =====
  // Each dashboard tab reads ONE page at a time, filtered/sorted/searched by the
  // backend. Only the tab actually on screen queries, and none of them do while a
  // folder is open, so a visit makes a single list request rather than three.
  const showingGrid = activeView === 'dashboard';
  // The dashboard's "Law Firm Files" tab has no entity list of its own - picking
  // it shows the firm-wide folder browser in place of the grid, without leaving
  // the dashboard the way opening a matter/task/client does.
  const showingEntityGrid = showingGrid && gridTab !== 'lawFirm';
  const GridSection = showingEntityGrid ? ListSection : Fragment;
  const showingFileBrowser =
    activeView === 'matter' || activeView === 'task' || activeView === 'client' || activeView === 'lawFirm' ||
    (showingGrid && gridTab === 'lawFirm');

  const [matterInitialFilters] = useState<ServerTableFilters>(() => {
    const stored = readStoredFilters(MATTER_FILTER_KEYS);
    // The status slot used to be shared with the tasks tab, so a persisted value
    // can be a task status the matters endpoint rejects. Drop anything outside
    // the matter status enum rather than sending it.
    if (stored.status && !Object.prototype.hasOwnProperty.call(MATTER_STATUS_META, stored.status)) {
      delete stored.status;
    }
    return stored;
  });
  const matterTable = useMattersTable(lawFirmId, matterInitialFilters, showingGrid && gridTab === 'matters' && canViewFiles);

  // The tasks table takes its status/priority/matter/assignee filters as external
  // values rather than owning them, so they live here and are persisted here.
  const [taskFilters, setTaskFilters] = useState<Record<string, string | undefined>>(
    () => readStoredFilters(TASK_FILTER_KEYS)
  );
  const taskExternalFilters = useMemo(
    () => ({
      assignedTo: taskFilters.assignedTo || undefined,
      status: (taskFilters.taskStatus || undefined) as TaskStatus | undefined,
      matterId: taskFilters.matterId || undefined,
      priority: taskFilters.priority || undefined,
    }),
    [taskFilters.assignedTo, taskFilters.taskStatus, taskFilters.matterId, taskFilters.priority]
  );
  const taskTable = useTasksTable(
    lawFirmId,
    taskExternalFilters,
    showingGrid && gridTab === 'tasks' && canViewFiles,
    TASK_DEFAULT_SORT
  );

  const [clientInitialFilters] = useState<ServerTableFilters>(
    () => readStoredFilters(CLIENT_FILTER_KEYS, CLIENT_FILTER_STORAGE_PREFIX)
  );
  const clientTable = useClientsTable(lawFirmId, clientInitialFilters, showingGrid && gridTab === 'clients' && canViewFiles);

  // Feed the single search box to every list's server query. Each table hook owns
  // its own debounce, and only the enabled one issues a request.
  const setMatterSearch = matterTable.setSearch;
  const setTaskSearch = taskTable.setSearch;
  const setClientSearch = clientTable.setSearch;
  useEffect(() => {
    setMatterSearch(searchTerm);
    setTaskSearch(searchTerm);
    setClientSearch(searchTerm);
  }, [searchTerm, setMatterSearch, setTaskSearch, setClientSearch]);

  // ===== The open entity, resolved by id =====
  // Resolved on its own rather than looked up in the grid rows: the grids hold one
  // server page, so an entity reached by deep link or browser Back is frequently
  // not among them, and the folder browser still has to name it and load its files.
  const { matter: activeMatter } = useMatterById(lawFirmId, activeView === 'matter' ? activeMatterId : null);
  const { task: activeTask } = useTaskById(lawFirmId, activeView === 'task' ? activeTaskId : null);
  const { client: activeClient } = useClientById(lawFirmId, activeView === 'client' ? activeClientId : null);
  // The matter of the currently active task (if any), plus its record, so the task
  // view's "Matter Files" source can be named and browsed.
  const activeTaskMatterId = activeView === 'task' ? (activeTask?.matterId || null) : null;
  const { matter: activeTaskMatter } = useMatterById(lawFirmId, activeTaskMatterId);

  // Selection State
  const [selectedIds, setSelectedIds] = useState<ListSelectionModel>([] as any);

  const selectedIdsArray = useMemo<readonly (string | number)[]>(() => {
    if (Array.isArray(selectedIds)) return selectedIds;
    try {
      return Array.from((selectedIds as unknown as Iterable<string | number>) ?? []);
    } catch {
      return [];
    }
  }, [selectedIds]);

  // Modal States
  const [matterDeleteConfirmOpen, setMatterDeleteConfirmOpen] = useState(false);
  const [matterToDelete, setMatterToDelete] = useState<string | null>(null);
  const [isDeletingMatters, setIsDeletingMatters] = useState(false);
  const [taskDeleteConfirmOpen, setTaskDeleteConfirmOpen] = useState(false);
  const [taskToDelete, setTaskToDelete] = useState<string | null>(null);
  const [isDeletingTasks, setIsDeletingTasks] = useState(false);
  // Toggle between task files and matter files when task is linked to a matter
  const [taskFileSource, setTaskFileSource] = useState<'task' | 'matter'>('task');
  // Client view: switch between the client's firm-side file area and a preview of
  // what the client can actually see in their portal.
  const [clientPreviewMode, setClientPreviewMode] = useState(false);
  // The portal-preview owns its own folder trail; this handle lets the page's
  // Back chrome step up through it one level at a time.
  const previewNavRef = useRef<ClientPortalFilePreviewHandle | null>(null);
  // Clients on the active matter/task (id + name), used to name recipients in the
  // "Visible to N of M" badge tooltip.
  const [activeShareClients, setActiveShareClients] = useState<ShareClient[]>([]);
  // The client chip clicked in the matter/task client list, if any; drives the
  // info popup below. Kept separate from `activeClientId` (the client *view*'s
  // subject) so opening the popup never changes what's on screen.
  const [clientInfoTarget, setClientInfoTarget] = useState<ShareClient | null>(null);
  const { client: clientInfoDetail, loading: clientInfoLoading } = useClientById(
    lawFirmId,
    clientInfoTarget?.id ?? null
  );

  useEffect(() => {
    if (!canUploadFiles && isUploading) {
      setIsUploading(false);
    }
  }, [canUploadFiles, isUploading]);

  // Matter and task deletes invalidate the whole domain cache rather than
  // refetching one page: every cached page, and the by-id record behind an open
  // folder, is stale once a row is gone.
  const refreshMatters = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['matters', lawFirmId] }),
    [queryClient, lawFirmId]
  );
  const refreshTasks = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['tasks', lawFirmId] }),
    [queryClient, lawFirmId]
  );

  // The grids' load errors are React Query state: they persist until their
  // query succeeds, so there is nothing to "clear" here. Dismissing one has to
  // be recorded separately (`dismissedLoadError`, keyed on message) - matching
  // the real Matters page's pattern (`MattersGrid.tsx`) - otherwise closing the
  // banner would immediately reappear as long as the same query keeps failing,
  // and there would be no way to tell "the user dismissed this" from "the
  // failure resolved".
  const loadError = matterTable.error || taskTable.error || clientTable.error || null;
  const [dismissedLoadError, setDismissedLoadError] = useState<string | null>(null);
  const showingLoadError = !!loadError && loadError !== dismissedLoadError;
  const error = showingLoadError ? loadError : null;

  // Re-run whichever grid the banner is reporting. Offered only while the
  // banner is showing a LOAD failure, matching the same rule as the Matters
  // page's `retryLoad`.
  const [retryingLoad, setRetryingLoad] = useState(false);
  const retryGridLoad = useCallback(async () => {
    setRetryingLoad(true);
    try {
      await Promise.allSettled([matterTable.refetch(), taskTable.refetch(), clientTable.refetch()]);
    } finally {
      setRetryingLoad(false);
    }
  }, [matterTable, taskTable, clientTable]);

  // Reset file source toggle when leaving task view or switching tasks
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the task file-source toggle when the active task or view changes
    setTaskFileSource('task');
  }, [activeTaskId, activeView]);

  // Reset the client portal-preview toggle when leaving the client view or
  // switching clients (default back to the firm-side file area).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the client preview toggle when the active client or view changes
    setClientPreviewMode(false);
  }, [activeClientId, activeView]);

  // Effective context IDs for file operations, accounts for taskFileSource toggle
  const fileMatterId = useMemo(() => {
    if (activeView === 'matter') return activeMatterId;
    if (activeView === 'task' && taskFileSource === 'matter' && activeTaskMatterId) return activeTaskMatterId;
    return null;
  }, [activeView, activeMatterId, taskFileSource, activeTaskMatterId]);

  const fileTaskId = useMemo(() => {
    if (activeView === 'task' && taskFileSource === 'task') return activeTaskId;
    return null;
  }, [activeView, activeTaskId, taskFileSource]);

  const fileClientId = useMemo(() => {
    if (activeView === 'client') return activeClientId;
    return null;
  }, [activeView, activeClientId]);

  /** Which documents the browser is showing, from the effective context ids. */
  const browserScope = useMemo(
    () => scopeFromIds({ matterId: fileMatterId, taskId: fileTaskId, clientId: fileClientId }),
    [fileMatterId, fileTaskId, fileClientId]
  );

  /** The open folder for the scope on screen; the browser is controlled over it. */
  const browserScopeKey = scopeKey(browserScope);
  const browserTrail = trailByScope[browserScopeKey] ?? EMPTY_BROWSER_TRAIL;
  const setBrowserTrail = useCallback(
    (trail: FolderCrumb[]) => setTrailByScope((prev) => ({ ...prev, [browserScopeKey]: trail })),
    [browserScopeKey]
  );

  // Feed the open folder to the history sync above. Only a folder view has one;
  // the dashboard grids sit at no path.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors the open folder into the location the history effect serializes
    setActiveTrail(showingFileBrowser ? browserTrail : EMPTY_BROWSER_TRAIL);
  }, [showingFileBrowser, browserTrail]);

  // The clients on the active matter/task, so a share can name its recipients.
  // The resolved task record already carries clientIds/clientNames; matters are
  // fetched on demand (the matter projection doesn't include client-record ids).
  const activeTaskClientIds = activeTask?.clientIds;
  const activeTaskClientNames = activeTask?.clientNames;
  const resolveShareClients = useCallback(async (): Promise<ShareClient[]> => {
    if (fileTaskId) {
      const ids = activeTaskClientIds || [];
      const names = activeTaskClientNames || [];
      return ids.map((id, i) => ({ id, name: names[i] || 'Client' }));
    }
    if (fileMatterId) {
      try {
        const list = await MattersService.listClients(lawFirmId, fileMatterId);
        return (list || []).map((c) => ({ id: c.id, name: c.name || 'Client', userId: c.userId }));
      } catch {
        return [];
      }
    }
    return [];
  }, [fileTaskId, fileMatterId, activeTaskClientIds, activeTaskClientNames, lawFirmId]);

  // Keep the recipient list current. A client's file area resolves to that one
  // client; a task reads them off its resolved record; a matter fetches.
  useEffect(() => {
    if (fileClientId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs the resolved recipient to the active client area
      setActiveShareClients(activeClient ? [{ id: activeClient.id, name: activeClient.name || 'Client', userId: activeClient.userId }] : []);
      return;
    }
    if (!fileMatterId && !fileTaskId) {
      setActiveShareClients([]);
      return;
    }
    let cancelled = false;
    resolveShareClients()
      .then((c) => { if (!cancelled) setActiveShareClients(c); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fileMatterId, fileTaskId, fileClientId, activeClient, resolveShareClients]);

  const handleUploadComplete = () => {
    setIsUploading(false);
    // The upload panel sits inside the browser but writes through its own
    // service call, so the listing has to be told the folder changed.
    setBrowserReloadKey((k) => k + 1);
    setStorageRefreshTrigger((prev) => prev + 1);
    setNotification({ message: 'Upload successful', severity: 'success' });
  };


  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- manual memoization is intentional
  const toggleUploadPanel = useCallback(() => {
    if (!canUploadFiles) {
      showPermissionError("You do not have permission to upload files.");
      return;
    }
    setIsUploading((prev) => !prev);
  }, [canUploadFiles, showPermissionError]);

  // --- Selection Handlers ---
  const handleSelection = useCallback((ids: ListSelectionModel) => {
    startTransition(() => setSelectedIds(ids));
  }, []);

  const handleClearSelection = useCallback(() => {
    startTransition(() => setSelectedIds([] as any));
  }, []);

  // Select every matter / task the current filters match, across all pages, so a
  // bulk delete covers what the filters describe rather than the page on screen.
  // The server resolves the ids under the same visibility rules as the list.
  const [selectAllPending, setSelectAllPending] = useState(false);
  const selectAllMatching = useCallback(async () => {
    setSelectAllPending(true);
    try {
      const { ids, truncated, limit } =
        gridTab === 'matters'
          ? await MattersService.listMatterIds(lawFirmId, {
              search: matterTable.queryParams.search,
              ...matterListFilterParams(matterTable.filters),
            })
          : await TasksService.listTaskIds(lawFirmId, {
              status: taskTable.listParams.status,
              assignee: taskTable.listParams.assignedTo,
              matterId: taskTable.listParams.matterId,
              priority: taskTable.listParams.priority,
              search: taskTable.listParams.search,
            });
      startTransition(() => setSelectedIds(ids as any));
      if (truncated) {
        setNotification({
          message: `Selection is capped at ${limit}, so the first ${limit} are selected.`,
          severity: 'warning',
        });
      }
    } catch (err) {
      setNotification({
        message: getErrorMessage(err, 'Failed to select everything matching these filters'),
        severity: 'error',
      });
    } finally {
      setSelectAllPending(false);
    }
  }, [gridTab, lawFirmId, matterTable.queryParams.search, matterTable.filters, taskTable.listParams]);

  // Drop a grid selection whenever the set it was taken from changes: a different
  // tab, filter or search term all mean the ticked ids no longer describe what the
  // list is showing. Paging and re-sorting leave it alone, since a selection now
  // spans every page of the filtered set. Folder selections are left alone too,
  // they cover a fully loaded listing.
  useEffect(() => {
    if (!showingGrid) return;
    handleClearSelection();
  }, [
    showingGrid,
    handleClearSelection,
    gridTab,
    searchTerm,
    matterTable.filters,
    taskFilters,
    clientTable.filters,
  ]);

  // --- Matter Deletion Handlers ---
  const handleDeleteMatterTrigger = (matterId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setMatterToDelete(matterId);
    setMatterDeleteConfirmOpen(true);
  };

  const handleBulkDeleteMatters = () => {
    if (selectedCount > 0) {
      setMatterToDelete(null);
      setMatterDeleteConfirmOpen(true);
    }
  };

  const confirmMatterDelete = async () => {
    try {
      setIsDeletingMatters(true);
      
      if (matterToDelete) {
        await MattersService.deleteMatter(lawFirmId, matterToDelete);
        setNotification({ message: 'Matter deleted successfully', severity: 'success' });
        await refreshMatters();
        handleClearSelection();
      } else if (selectedCount > 0) {
        // Whatever is selected, which after a select-all spans every page of the
        // filtered set rather than just the rows on screen.
        const ids = selectedIdsArray.map(String);
        const result = await MattersService.deleteMultipleMatters(lawFirmId, ids);
        // Refused items (legal hold, trust activity, billing history) come back in
        // `failed` on a 200, so the count reported has to come from the response
        // rather than from what was requested.
        const reasons = [...new Set(Object.values(result.errors || {}))];
        setNotification(
          result.failed?.length
            ? {
                message: `${result.deleted ?? 0} of ${result.requested} matter(s) deleted. ${result.failed.length} could not be: ${reasons.join(' ')}`,
                severity: 'warning',
              }
            : { message: `${result.deleted ?? ids.length} matter(s) deleted successfully`, severity: 'success' },
        );
        await refreshMatters();
        handleClearSelection();
      }
    } catch (err) {
      setNotification({ message: getErrorMessage(err, 'Failed to delete matter(s)'), severity: 'error' });
    } finally {
      setIsDeletingMatters(false);
      setMatterDeleteConfirmOpen(false);
      // matterToDelete is left set so the dialog title/message stays stable while it
      // animates closed; it's reset when the bulk-delete dialog is next opened.
    }
  };

  // --- Task Deletion Handlers ---
  const handleDeleteTaskTrigger = (taskId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setTaskToDelete(taskId);
    setTaskDeleteConfirmOpen(true);
  };

  const handleBulkDeleteTasks = () => {
    if (selectedCount > 0) {
      setTaskToDelete(null);
      setTaskDeleteConfirmOpen(true);
    }
  };

  const confirmTaskDelete = async () => {
    try {
      setIsDeletingTasks(true);
      
      if (taskToDelete) {
        await TasksService.deleteTask(lawFirmId, taskToDelete);
        setNotification({ message: 'Task deleted successfully', severity: 'success' });
        await refreshTasks();
        handleClearSelection();
      } else if (selectedCount > 0) {
        // Whatever is selected, which after a select-all spans every page of the
        // filtered set rather than just the rows on screen.
        const ids = selectedIdsArray.map(String);
        await TasksService.bulkDelete(lawFirmId, ids);
        setNotification({ message: `${ids.length} task(s) deleted successfully`, severity: 'success' });
        await refreshTasks();
        handleClearSelection();
      }
    } catch (err) {
      setNotification({ message: getErrorMessage(err, 'Failed to delete task(s)'), severity: 'error' });
    } finally {
      setIsDeletingTasks(false);
      setTaskDeleteConfirmOpen(false);
      // taskToDelete is left set so the dialog title/message stays stable while it
      // animates closed; it's reset when the bulk-delete dialog is next opened.
    }
  };

  // --- Filtering & Helpers ---

  // Filter sources for the dropdowns. They come from the firm's practice areas and
  // members rather than from the loaded rows: a server-paged list only holds one
  // page, so deriving options from it would offer whichever handful of values that
  // page happens to contain.
  const { practiceAreas, loading: practiceAreasLoading } = usePracticeAreas(canViewFiles ? lawFirmId : undefined);
  const { users, loading: usersLoading } = useLawFirmUsers(lawFirmId, canViewFiles);

  // A matters-tab filter change: persist it, re-key the server query (the table
  // hook resets to page 1 on its own) and drop the page-scoped selection.
  const handleMatterFilterChange = (key: string, value: string) => {
    storeFilter(key, value);
    startTransition(() => {
      matterTable.setFilter(key, value || undefined);
      handleClearSelection();
    });
  };

  // A tasks-tab filter change. The tasks table takes these as external values, so
  // the page also resets it to the first page.
  const handleTaskFilterChange = (key: string, value: string) => {
    storeFilter(key, value);
    startTransition(() => {
      setTaskFilters(prev => {
        const next = { ...prev, [key]: value };
        if (!value) delete next[key];
        return next;
      });
      taskTable.setPage(1);
      handleClearSelection();
    });
  };

  // A clients-tab filter change. Same shape as the matters tab (the table hook
  // owns the values and resets to page 1), under the clients storage prefix.
  const handleClientFilterChange = (key: string, value: string) => {
    storeFilter(key, value, CLIENT_FILTER_STORAGE_PREFIX);
    startTransition(() => {
      clientTable.setFilter(key, value || undefined);
      handleClearSelection();
    });
  };

  const practiceAreaOptions: DropdownOption[] = useMemo(
    () => [{ value: '', label: 'All Practice Areas' }, ...practiceAreas.map(p => ({ value: p.id, label: p.name }))],
    [practiceAreas]
  );

  const leadOptions: DropdownOption[] = useMemo(
    () => [{ value: '', label: 'All Leads' }, ...users.map(u => ({ value: u.uid, label: u.name || u.email || u.uid }))],
    [users]
  );

  const statusOptions: DropdownOption[] = useMemo(() => [
    { value: '', label: 'All Statuses' },
    { value: 'active', label: 'Active' },
    { value: 'pending', label: 'Pending' },
    { value: 'on_hold', label: 'On Hold' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'completed', label: 'Completed' },
    { value: 'blocked', label: 'Blocked' },
    { value: 'closed', label: 'Closed' },
    { value: 'archived', label: 'Archived' },
  ], []);

  const taskStatusOptions: DropdownOption[] = useMemo(() => [
    { value: '', label: 'All Statuses' },
    { value: 'open', label: 'Open' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'completed', label: 'Completed' },
    { value: 'blocked', label: 'Blocked' },
  ], []);

  const taskAssigneeOptions: DropdownOption[] = useMemo(
    () => [{ value: '', label: 'All Users' }, ...users.map(u => ({ value: u.uid, label: u.name || u.email || u.uid }))],
    [users]
  );

  const clientStatusOptions: DropdownOption[] = useMemo(() => [
    { value: '', label: 'All Statuses' },
    { value: 'active', label: 'Active' },
    { value: 'inactive', label: 'Inactive' },
    { value: 'archived', label: 'Archived' },
  ], []);

  const taskPriorityOptions: DropdownOption[] = useMemo(() => [
    { value: '', label: 'All Priorities' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'urgent', label: 'Urgent' },
  ], []);

  // Drop persisted filters whose target no longer exists (a removed practice area,
  // a member who left the firm), so a stale value can't silently hide every row
  // while its dropdown shows no selection. The matter filter needs no pruning: it
  // is a server-backed picker that resolves its own selected label.
  usePruneStaleFilters(
    [
      { key: 'practiceAreaId', value: matterTable.filters.practiceAreaId, options: practiceAreaOptions, storageKey: 'filesFilter_practiceAreaId' },
      { key: 'leadUserId', value: matterTable.filters.leadUserId, options: leadOptions, storageKey: 'filesFilter_leadUserId' },
    ],
    (keys) => {
      startTransition(() => {
        for (const k of keys) matterTable.setFilter(k, undefined);
      });
    }
  );

  usePruneStaleFilters(
    [{ key: 'assignedTo', value: taskFilters.assignedTo, options: taskAssigneeOptions, storageKey: 'filesFilter_assignedTo' }],
    (keys) => {
      startTransition(() => {
        setTaskFilters(prev => {
          const next = { ...prev };
          for (const k of keys) delete next[k];
          return next;
        });
      });
    }
  );

  // The open context's title, subtitle and file listing. Names come from the by-id
  // entity queries and files/path from the id-keyed folder state, so none of it
  // depends on the entity being present in the currently loaded grid page.
   
  const activeData = useMemo(() => {
    if (activeView === 'lawFirm' || (activeView === 'dashboard' && gridTab === 'lawFirm')) {
      return { title: 'Law Firm General Files', subtitle: 'Shared resources and templates' };
    }
    if (activeView === 'matter' && activeMatterId) {
      return {
        title: activeMatter?.name || 'Unknown Matter',
        subtitle: `Matter ID: ${activeMatter?.matterNumber || activeMatter?.matterReferenceId || activeMatter?.id || 'N/A'}`,
        href: `/lawfirm/${lawFirmId}/matters/${activeMatterId}`,
      };
    }
    if (activeView === 'task' && activeTaskId) {
      if (taskFileSource === 'matter' && activeTaskMatterId) {
        return {
          title: activeTaskMatter?.name || 'Unknown Matter',
          subtitle: `Matter files • Task: ${activeTask?.title || 'Unknown Task'}`,
          href: `/lawfirm/${lawFirmId}/matters/${activeTaskMatterId}`,
        };
      }
      return {
        title: activeTask?.title || 'Unknown Task',
        subtitle: activeTask?.matterName ? `Matter: ${activeTask.matterName}` : 'Task attachments',
        href: `/lawfirm/${lawFirmId}/tasks/${activeTaskId}`,
      };
    }
    if (activeView === 'client' && activeClientId) {
      return {
        title: activeClient?.name || 'Unknown Client',
        subtitle: activeClient?.email || 'Client files',
        href: `/lawfirm/${lawFirmId}/clients/${activeClientId}`,
      };
    }
    return null;
  }, [activeView, gridTab, activeMatterId, activeTaskId, activeClientId, activeMatter, activeTask, activeTaskMatter, activeClient, taskFileSource, activeTaskMatterId, lawFirmId]);

  // The entity grids hold an explicit id set, which a select-all fills with every
  // row matching the filters, across pages. File-row selection lives in the
  // browser, which resolves it against the rows actually on screen.
  const selectedCount = selectedIdsArray.length;

  // Hold the count shown in the bulk delete-confirmation dialogs steady while they
  // animate closed. Confirming clears the selection, which would otherwise make the
  // message flash "0 selected" during the exit transition.
  const anyBulkDeleteOpen = matterDeleteConfirmOpen || taskDeleteConfirmOpen;
  const frozenDeleteCountRef = useRef(selectedCount);
  useEffect(() => {
    if (anyBulkDeleteOpen) frozenDeleteCountRef.current = selectedCount;
  }, [anyBulkDeleteOpen, selectedCount]);
  const deleteDialogCount = anyBulkDeleteOpen ? selectedCount : frozenDeleteCountRef.current;

  /** Bulk action on the grid selection, shown in the list's own control strip. */
  const canBulkDelete = gridTab === 'matters' ? canDeleteMatter : canDeleteTask;
  const bulkDeleteButton = showingEntityGrid && gridTab !== 'clients' && canBulkDelete && selectedCount > 0 ? (
    <Button
      onClick={gridTab === 'matters' ? handleBulkDeleteMatters : handleBulkDeleteTasks}
      type="secondary"
      size="small"
      icon={<Trash2 size={15} />}
    >
      Delete Selected ({selectedCount})
    </Button>
  ) : null;

  /** Name + total of whichever entity grid the browse-by tab is showing. */
  const gridHeading =
    gridTab === 'matters'
      ? { label: 'Matters', total: matterTable.total }
      : gridTab === 'tasks'
        ? { label: 'Tasks', total: taskTable.total }
        : { label: 'Clients', total: clientTable.total };

  const renderMatterRow = useCallback((matterData: Matter): ListRow => {
    const names = matterData.clientNames || [];
    const clientsText = names.length ? names.join(", ") : null;
    const metaParts = [
      matterData.leadUserName ? `Lead: ${matterData.leadUserName}` : null,
      matterData.practiceAreaName || null,
      matterData.category || null,
      clientsText ? `Clients: ${clientsText}` : null,
    ].filter(Boolean);
    return {
      title: (
        <>
          {highlightText(matterData.name || "Untitled Matter", searchTerm)}
          {matterData.matterNumber && (
            <span className="ml-1.5 font-normal text-on-surface-muted">
              #{highlightText(matterData.matterNumber, searchTerm)}
            </span>
          )}
        </>
      ),
      badges: (
        <MatterStatusBadge status={matterData.status} />
      ),
      meta: metaParts.length ? highlightText(metaParts.join("  ·  "), searchTerm) : null,
    };
  }, [searchTerm]);

  // Ordering is done by the server, so the columns offered are exactly the fields
  // its sort whitelist accepts (matters.validation.js MATTER_SORT_FIELDS).
  const matterSortColumns: ListSortColumn[] = useMemo(
    () => [
      { label: "Name", value: "name" },
      { label: "Lead", value: "leadUser" },
      { label: "Practice Area", value: "practiceArea" },
      { label: "Category", value: "category" },
      { label: "Status", value: "status" },
    ],
    []
  );

  const [matterSortValue, setMatterSortValue] = useState<string>("name");
  const [matterSortDir, setMatterSortDir] = useState<SortDir>("asc");
  const requestMatterSort = matterTable.handleRequestSort;
  const handleMatterSortChange = useCallback(
    (value: string, dir: SortDir) => {
      setMatterSortValue(value);
      setMatterSortDir(dir);
      requestMatterSort([{ field: value as MatterSortField, sort: dir }]);
    },
    [requestMatterSort]
  );

  const handleMatterCardClick = (row: Matter) => {
    handleClearSelection();
    setSearchTerm('');
    setActiveMatterId(row.id);
    setActiveView('matter');
  };

  const handleTaskCardClick = (row: Task) => {
    handleClearSelection();
    setSearchTerm('');
    setActiveTaskId(row.taskId || row.id);
    setActiveView('task');
  };

  const handleBackToGrid = () => {
    setActiveView('dashboard');
    setActiveMatterId(null);
    setActiveTaskId(null);
    setActiveClientId(null);
    setTaskFileSource('task');
    setIsUploading(false);
    setSearchTerm('');
    handleClearSelection();
  };

  // The Files page is a single route -- entering a matter/task/client or the
  // "Law Firm Files" tab never changes the URL, so clicking "Files" in the
  // sidebar while already here can't rely on a route change to reset the
  // view. The sidebar broadcasts a reselect event in that case; reset back to
  // the default grid the same way "Back to Matters/Tasks/Clients" does.
  useEffect(() => {
    const handleReselect = (e: Event) => {
      const detail = (e as CustomEvent<{ href: string }>).detail;
      if (detail?.href !== `/lawfirm/${lawFirmId}/files`) return;
      handleBackToGrid();
      setGridTab('matters');
    };
    window.addEventListener(SIDEBAR_RESELECT_EVENT, handleReselect);
    return () => window.removeEventListener(SIDEBAR_RESELECT_EVENT, handleReselect);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleBackToGrid only closes over stable useState setters, so a stale reference behaves identically to a fresh one
  }, [lawFirmId]);

  const assignedToText = (taskData: Task): string | null => {
    const raw = taskData.assignedToName;
    const names = Array.isArray(raw) ? raw.filter(Boolean) : (raw ? [raw] : []);
    if (names.length > 0) return names.join(', ');
    return taskData.assignedToUserName || null;
  };

  const renderTaskRow = useCallback((taskData: Task): ListRow => {
    const names = taskData.clientNames || [];
    const clientsText = names.length ? names.join(", ") : null;
    const assigned = assignedToText(taskData);
    const metaParts = [
      taskData.matterName ? `Matter: ${taskData.matterName}` : null,
      assigned ? `Assigned: ${assigned}` : null,
      clientsText ? `Clients: ${clientsText}` : null,
    ].filter(Boolean);
    return {
      title: highlightText(taskData.title || "Untitled Task", searchTerm),
      badges: (
        <TaskStatusBadge status={taskData.status} />
      ),
      meta: metaParts.length ? highlightText(metaParts.join("  ·  "), searchTerm) : null,
    };
  }, [searchTerm]);

  // Server-side ordering: the `matter` alias maps to the backend's `matterId`
  // ordering field, the rest match their sort-whitelist names.
  const taskSortColumns: ListSortColumn[] = useMemo(
    () => [
      { label: "Title", value: "title" },
      { label: "Due Date", value: "dueDate", defaultDir: "asc" },
      { label: "Status", value: "status" },
      { label: "Priority", value: "priority", defaultDir: "desc" },
      { label: "Assigned To", value: "assignedTo" },
      { label: "Matter", value: "matter" },
    ],
    []
  );

  const [taskSortValue, setTaskSortValue] = useState<string>("title");
  const [taskSortDir, setTaskSortDir] = useState<SortDir>("asc");
  const requestTaskSort = taskTable.handleRequestSort;
  const handleTaskSortChange = useCallback(
    (value: string, dir: SortDir) => {
      setTaskSortValue(value);
      setTaskSortDir(dir);
      const FIELD_MAP: Record<string, OrderBy> = {
        title: "title",
        status: "status",
        priority: "priority",
        dueDate: "dueDate",
        assignedTo: "assignedTo",
        matter: "matterId",
      };
      const field = FIELD_MAP[value];
      requestTaskSort(field ? [{ field, sort: dir }] : []);
    },
    [requestTaskSort]
  );

  const renderClientRow = useCallback((clientData: Client): ListRow => {
    return {
      title: highlightText(clientData.name || "Unnamed Client", searchTerm),
      badges: <ClientStatusBadge status={clientData.status} />,
      meta: clientData.email ? highlightText(clientData.email, searchTerm) : null,
    };
  }, [searchTerm]);

  const clientSortColumns: ListSortColumn[] = useMemo(
    () => [
      { label: "Name", value: "name" },
      { label: "Email", value: "email" },
      { label: "Organization", value: "organization" },
      { label: "Added", value: "createdAt", defaultDir: "desc" },
    ],
    []
  );

  const [clientSortValue, setClientSortValue] = useState<string>("name");
  const [clientSortDir, setClientSortDir] = useState<SortDir>("asc");
  const requestClientSort = clientTable.handleRequestSort;
  const handleClientSortChange = useCallback(
    (value: string, dir: SortDir) => {
      setClientSortValue(value);
      setClientSortDir(dir);
      requestClientSort([{ field: value as ClientSortField, sort: dir }]);
    },
    [requestClientSort]
  );

  const handleClientCardClick = (row: Client) => {
    handleClearSelection();
    setSearchTerm('');
    setActiveClientId(row.id);
    setActiveView('client');
  };

  // Closes the client info popup and switches into that client's own file view.
  const handleOpenClientTab = () => {
    if (!clientInfoTarget) return;
    handleClearSelection();
    setSearchTerm('');
    setActiveClientId(clientInfoTarget.id);
    setActiveView('client');
    setClientInfoTarget(null);
  };

  // Wait for permissions to resolve before deciding access. Otherwise the
  // no-access screen flashes on reload while the member's permissions are still
  // loading (hasPermission returns false until then). The grids render their own
  // skeletons, so a page change never blanks the whole screen.
  if (permissionsLoading) return <LoadingSpinner fullPage />;
  if (!canViewFiles) {
    return (
      <div className="min-h-screen bg-page p-6">
        <ErrorNotification
          error="You do not have permission to view files for this law firm."
          onClose={() => {}}
        />
      </div>
    );
  }

  return (
    <RequireFeature feature="fileSharing">
      <div className="min-h-screen bg-page flex flex-col">
        <div className="p-4 pl-5 md:p-6 max-w-[1600px] mx-auto space-y-4 md:space-y-6 min-w-0 pb-8 md:pb-6 flex flex-col flex-1 min-h-0 w-full">

        {/* A load failure on one grid's query is a banner, not a takeover: the
            rest of the dashboard (tab switcher, other tabs, folder browsing)
            stays usable so the viewer can route around whatever's actually
            broken - the earlier `if (error) return <ErrorNotification/>` here
            blanked the whole page, including the tab switcher itself. */}
        <ErrorNotification
          error={error}
          onClose={() => setDismissedLoadError(loadError)}
          onRetry={showingLoadError ? retryGridLoad : undefined}
          retrying={retryingLoad}
        />

        <PageHeader
          eyebrow={activeView === 'dashboard' ? 'Documents' : activeView === 'lawFirm' ? 'Shared Resources' : activeView === 'client' ? 'Client Files' : activeView === 'task' ? (taskFileSource === 'matter' ? 'Matter Files' : 'Task Files') : 'Matter Files'}
          title={
            activeView === 'dashboard'
              ? 'File Manager'
              : activeData?.href ? (
                <button
                  type="button"
                  onClick={() => navigate(activeData.href!)}
                  className="inline-flex items-center gap-1.5 text-left hover:text-accent-emphasis transition-colors cursor-pointer"
                >
                  {activeData.title}
                  <ExternalLink className="w-4 h-4 shrink-0 opacity-60" />
                </button>
              ) : activeData?.title
          }
          description={activeView === 'dashboard' ? "Manage your law firm\u2019s files." : activeData?.subtitle}
          actions={!showingFileBrowser ? undefined : !(activeView === 'client' && clientPreviewMode) && (
            <>
              <Tooltip title="Refresh" enterDelay={300}>
                <button aria-label="Refresh"
                  onClick={() => setBrowserReloadKey((k) => k + 1)}
                  className="inline-flex items-center gap-1.5 p-2 rounded-xl border border-outline text-on-surface-secondary text-xs font-medium hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
              {activeView === 'matter' && activeMatterId && canRequestDocuments && (
                <Button
                  type="secondary"
                  size="compact"
                  onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${activeMatterId}?tab=requests`)}
                  icon={<ClipboardList size={14} />}
                >
                  Manage document requests
                </Button>
              )}
            </>
          )}
        />
        
        {/* VIEW 1: DASHBOARD (matters/tasks/clients list + file folder in same grid).
            The Law Firm general-files view reuses this same folder browser. */}
        {(activeView === 'dashboard' || activeView === 'matter' || activeView === 'task' || activeView === 'client' || activeView === 'lawFirm') && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 flex flex-col flex-1 min-h-0">

             {/* Storage Usage */}
             <div className="mb-6">
               <StorageUsageBar lawFirmId={lawFirmId} refreshTrigger={storageRefreshTrigger} />
             </div>

             {/* File-source picker (dashboard) or back-navigation row (inside a source) */}
             {activeView === 'dashboard' ? (
               // Which list of file owners to browse. A segmented control rather
               // than a row of tiles: it's a view switch, not a destination, and
               // the tiles pushed the list itself below the fold.
               <div key="file-source-picker" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                 {/* Named, so the control reads as "what am I browsing by" rather
                     than as three buttons that happen to sit in a box. */}
                 <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-on-surface-muted">
                   Browse by
                 </span>
                 <div
                   ref={gridTabHighlight.containerRef}
                   role="group"
                   aria-label="Browse files by"
                   // overflow-y-hidden: setting only overflow-x leaves the y-axis's
                   // used value at `auto`, so a stray pixel of vertical overflow
                   // would otherwise put a scrollbar on a strip that only scrolls
                   // sideways.
                   className="relative flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden rounded-xl border border-outline bg-surface-alt/40 p-1 scrollbar-hide"
                 >
                   {gridTabHighlight.rect && (
                     <span
                       aria-hidden
                       className="absolute inset-y-1 left-0 rounded-lg bg-accent-solid shadow-sm transition-[transform,width] duration-200 ease-out motion-reduce:transition-none"
                       style={{
                         width: gridTabHighlight.rect.width,
                         transform: `translateX(${gridTabHighlight.rect.left}px)`,
                       }}
                     />
                   )}
                   {[
                     { key: 'matters', label: 'Matters', icon: Briefcase },
                     { key: 'clients', label: 'Clients', icon: Users },
                     { key: 'tasks', label: 'Tasks', icon: CheckSquare2 },
                   ].map(({ key, label, icon: Icon }) => {
                     const active = gridTab === key;
                     return (
                       <button
                         key={key}
                         ref={gridTabHighlight.registerItem(key)}
                         onClick={() => { setGridTab(key as typeof gridTab); handleClearSelection(); }}
                         aria-pressed={active}
                         className={`relative z-10 inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                           active
                             ? 'text-white'
                             : 'text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface'
                         }`}
                       >
                         <Icon size={14} strokeWidth={2} />
                         {label}
                       </button>
                     );
                   })}
                   <span aria-hidden="true" className="relative z-10 h-5 w-px shrink-0 bg-outline-subtle" />
                   {/* Firm-wide files aren't an entity list like the three tabs
                       above, so a divider sets it apart, but picking it behaves
                       exactly like picking one of them: it swaps the grid for
                       the folder browser without leaving the dashboard. */}
                   <button
                     ref={gridTabHighlight.registerItem('lawFirm')}
                     onClick={() => { setGridTab('lawFirm'); handleClearSelection(); }}
                     aria-pressed={gridTab === 'lawFirm'}
                     className={`relative z-10 inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                       gridTab === 'lawFirm'
                         ? 'text-white'
                         : 'text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface'
                     }`}
                   >
                     <Building2 size={14} strokeWidth={2} />
                     Law Firm Files
                   </button>
                 </div>
               </div>
             ) : (
             <div key="back-nav" className="flex items-center gap-2 mb-4 overflow-x-auto scrollbar-hide -mx-1 px-1 md:mx-0 md:px-0">
               <>
               <button
                 onClick={handleBackToGrid}
                 className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover border border-outline cursor-pointer transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
               >
                 <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
                 Back to {activeView === 'lawFirm' ? 'Dashboard' : gridTab === 'matters' ? 'Matters' : gridTab === 'tasks' ? 'Tasks' : 'Clients'}
               </button>
               {activeView === 'task' && activeTaskMatterId && (
                 <SegmentedToggle
                   className="ml-auto"
                   ariaLabel="File source"
                   value={taskFileSource}
                   onChange={(value) => { setTaskFileSource(value); handleClearSelection(); setSearchTerm(''); }}
                   options={[
                     { value: 'task', label: 'Task Files', icon: CheckSquare2 },
                     { value: 'matter', label: 'Matter Files', icon: Briefcase },
                   ]}
                 />
               )}
               {activeView === 'client' && activeClientId && (
                 <SegmentedToggle
                   className="ml-auto"
                   ariaLabel="Files view"
                   value={clientPreviewMode ? 'portal' : 'firm'}
                   onChange={(value) => setClientPreviewMode(value === 'portal')}
                   options={[
                     { value: 'firm', label: "Client's files", icon: FolderOpen },
                     { value: 'portal', label: 'What the client sees', icon: Eye },
                   ]}
                 />
               )}
               </>
             </div>
             )}

             {/* Clients on the active matter/task. Reuses the recipient list already
                 resolved for the share badge so no extra fetch is needed. */}
             {(activeView === 'matter' || activeView === 'task') && activeShareClients.length > 0 && (
               <div key="matter-clients" className="mb-4 flex flex-wrap items-center gap-2">
                 <span className="inline-flex items-center gap-1.5 text-xs font-medium text-on-surface-muted">
                   <Users size={14} />
                   {activeShareClients.length === 1 ? 'Client' : 'Clients'}
                 </span>
                 {activeShareClients.map((c) => (
                   <button
                     key={c.id}
                     type="button"
                     onClick={() => setClientInfoTarget(c)}
                     className="inline-flex items-center gap-1.5 rounded-full border border-outline bg-surface px-2.5 py-1 text-xs font-medium text-on-surface hover:bg-surface-hover hover:border-accent-border-soft dark:hover:border-accent-control-ring transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                   >
                     <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[9px] font-semibold uppercase text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis">
                       {(c.name || '?').trim().charAt(0)}
                     </span>
                     {c.name || 'Client'}
                   </button>
                 ))}
               </div>
             )}

             {activeView === 'client' && clientPreviewMode && activeClientId ? (
               <ClientPortalFilePreview ref={previewNavRef} lawFirmId={lawFirmId} clientId={activeClientId} />
             ) : (
             <>
             {/* Search and filters for the entity grids. A folder view has its own
                 search box inside the browser, which queries storage rather than
                 the matter/task/client lists. */}
             {showingEntityGrid && (
             <ListToolbar className="mb-4 flex flex-col gap-3 2xl:flex-row 2xl:items-center">
               <SearchInput
                 className="w-full 2xl:min-w-64 2xl:max-w-sm 2xl:flex-1"
                 placeholder={
                   gridTab === 'matters'
                     ? "Search by matter name, number, ID, or client..."
                     : gridTab === 'tasks'
                       ? "Search by task title, matter, assignee, ID, or client..."
                       : "Search by client name or email..."
                 }
                 value={searchTerm}
                 onChange={(next) => setSearchTerm(next)}
                 onClear={() => setSearchTerm('')}
               />
               {/* Mobile: dropdowns use a 2x2 grid. From sm up the filters wrap
                   within their own row; only genuinely wide screens place that
                   row beside the search box. */}
               <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap 2xl:ml-auto 2xl:justify-end">
                 {gridTab === 'matters' ? (
                   <>
                     <Dropdown
                       placeholder="All Practice Areas"
                       value={matterTable.filters.practiceAreaId ?? ''}
                       onChange={(v) => handleMatterFilterChange('practiceAreaId', v)}
                       options={practiceAreaOptions}
                       disabled={practiceAreasLoading}
                       className="w-full sm:w-44"
                     />
                     <div className="w-full sm:w-44">
                       <CategoryFilterDropdown
                         placeholder="All Categories"
                         value={matterTable.filters.category ?? ''}
                         onChange={(v) => handleMatterFilterChange('category', v)}
                         lawFirmId={lawFirmId}
                       />
                     </div>
                     <Dropdown
                       placeholder="All Leads"
                       value={matterTable.filters.leadUserId ?? ''}
                       onChange={(v) => handleMatterFilterChange('leadUserId', v)}
                       options={leadOptions}
                       disabled={usersLoading}
                       className="w-full sm:w-44"
                     />
                     <Dropdown
                       placeholder="All Statuses"
                       value={matterTable.filters.status ?? ''}
                       onChange={(v) => handleMatterFilterChange('status', v)}
                       options={statusOptions}
                       className="w-full sm:w-40"
                     />
                   </>
                 ) : gridTab === 'tasks' ? (
                   <>
                     <Dropdown
                       placeholder="All Users"
                       value={taskFilters.assignedTo ?? ''}
                       onChange={(v) => handleTaskFilterChange('assignedTo', v)}
                       options={taskAssigneeOptions}
                       disabled={usersLoading}
                       className="w-full sm:w-44"
                     />
                     <EntityPicker
                       entity="matters"
                       lawFirmId={lawFirmId}
                       value={taskFilters.matterId ?? ''}
                       onChange={(v) => handleTaskFilterChange('matterId', v)}
                       emptyOption={{ value: '', label: 'All Matters' }}
                       className="w-full sm:w-44"
                     />
                     <Dropdown
                       placeholder="All Statuses"
                       value={taskFilters.taskStatus ?? ''}
                       onChange={(v) => handleTaskFilterChange('taskStatus', v)}
                       options={taskStatusOptions}
                       className="w-full sm:w-40"
                     />
                     <Dropdown
                       placeholder="All Priorities"
                       value={taskFilters.priority ?? ''}
                       onChange={(v) => handleTaskFilterChange('priority', v)}
                       options={taskPriorityOptions}
                       className="w-full sm:w-40"
                     />
                   </>
                 ) : (
                   <>
                     {/* The matter a client is on. Server-backed typeahead rather
                         than a loaded list: a firm's matters outgrow a dropdown. */}
                     <EntityPicker
                       entity="matters"
                       lawFirmId={lawFirmId}
                       value={clientTable.filters.matterId ?? ''}
                       onChange={(v) => handleClientFilterChange('matterId', v)}
                       emptyOption={{ value: '', label: 'All Matters' }}
                       className="w-full sm:w-44"
                     />
                     <Dropdown
                       placeholder="All Statuses"
                       value={clientTable.filters.status ?? ''}
                       onChange={(v) => handleClientFilterChange('status', v)}
                       options={clientStatusOptions}
                       className="w-full sm:w-40"
                     />
                   </>
                 )}
                 {(() => {
                   const activeCount = gridTab === 'matters'
                     ? MATTER_FILTER_KEYS.filter((k) => matterTable.filters[k]).length
                     : gridTab === 'tasks'
                       ? TASK_FILTER_KEYS.filter((k) => taskFilters[k]).length
                       : CLIENT_FILTER_KEYS.filter((k) => clientTable.filters[k]).length;
                   if (activeCount === 0) return null;
                   return (
                     <ClearFiltersButton
                       count={activeCount}
                       onClear={() => {
                         if (gridTab === 'matters') MATTER_FILTER_KEYS.forEach((k) => handleMatterFilterChange(k, ''));
                         else if (gridTab === 'tasks') TASK_FILTER_KEYS.forEach((k) => handleTaskFilterChange(k, ''));
                         else CLIENT_FILTER_KEYS.forEach((k) => handleClientFilterChange(k, ''));
                       }}
                       label="Clear"
                       className="col-span-2 justify-self-end sm:col-auto"
                     />
                   );
                 })()}
               </div>
             </ListToolbar>
             )}

             <GridSection>
               {/* Title row with inline bulk actions, matching the matters page: the
                   count sits on its own line above the list's select-all/sort strip.
                   A folder view is already named by the page header, so it keeps no
                   heading row of its own. */}
               {showingEntityGrid && (
               <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
                 <h2 className="text-lg font-semibold text-on-surface shrink-0">
                   {gridHeading.label} ({gridHeading.total})
                 </h2>
                 {bulkDeleteButton && (
                   <div className="flex flex-wrap items-center gap-2">{bulkDeleteButton}</div>
                 )}
               </div>
               )}

               {/* The entity grids, or the file browser when an entity (or the Law Firm
                   Files tab) is open. */}
               {showingFileBrowser ? (
               <FileBrowser
                 lawFirmId={lawFirmId}
                 scope={browserScope}
                 trail={browserTrail}
                 onTrailChange={setBrowserTrail}
                 reloadToken={browserReloadKey}
                 rootLabel={activeData?.title ?? 'Files'}
                 shareClients={activeShareClients}
                 onError={(message) => setNotification({ message, severity: 'error' })}
                 onNotify={(message) => setNotification({ message, severity: 'success' })}
                 /* The storage bar reads a firm-wide figure, so any mutation can move it. */
                 onMutated={() => setStorageRefreshTrigger((prev) => prev + 1)}
                 toolbarActions={canUploadFiles && (
                   <button
                     type="button"
                     onClick={toggleUploadPanel}
                     className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-outline-subtle bg-surface text-on-surface text-xs font-medium hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                   >
                     <Upload size={14} /> {isUploading ? 'Cancel' : 'Upload'}
                   </button>
                 )}
               >
                 {isUploading && canUploadFiles && (
                   <div className="p-4 border border-outline rounded-lg bg-surface">
                     <FileUpload
                       lawFirmId={lawFirmId}
                       matterId={fileMatterId ?? undefined}
                       taskId={fileTaskId ?? undefined}
                       clientId={fileClientId ?? undefined}
                       folderId={browserTrail.length ? browserTrail[browserTrail.length - 1].id : undefined}
                       onUploadComplete={handleUploadComplete}
                       onError={(msg) => setNotification({ message: msg, severity: 'error' })}
                     />
                   </div>
                 )}
               </FileBrowser>
               ) : gridTab === 'matters' ? (
               <ListView<Matter>
                 rows={matterTable.rows}
                 loading={matterTable.loading}
                 fetching={matterTable.fetching}
                 getRowId={(row) => row.id}
                 renderRow={renderMatterRow}
                 onRowClick={handleMatterCardClick}
                 rowActions={
                   canDeleteMatter
                     ? (row) => (
                         <Tooltip title="Delete" enterDelay={300}>
                           <button aria-label="Delete"
                             type="button"
                             onClick={() => handleDeleteMatterTrigger(row.id)}
                             className="rounded-md p-1.5 text-red-600 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-red-500/10 dark:text-red-400"
                           >
                             <Trash2 size={15} />
                           </button>
                         </Tooltip>
                       )
                     : undefined
                 }
                 /* Server-driven sort + pagination: the list renders just the current
                    server page and calls back to re-query. ListView pages are 0-based,
                    the table hook's are 1-based. */
                 sortingMode="server"
                 sortColumns={matterSortColumns}
                 sortValue={matterSortValue}
                 sortDir={matterSortDir}
                 onSortChange={handleMatterSortChange}
                 paginationMode="server"
                 page={matterTable.page - 1}
                 pageSize={matterTable.rowsPerPage}
                 rowCount={matterTable.total}
                 onPageChange={(p) => matterTable.setPage(p + 1)}
                 onPageSizeChange={matterTable.setRowsPerPage}
                 pageSizeOptions={[10, 25, 50]}
                 defaultPageSize={matterTable.rowsPerPage}
                 showSelection
                 selectionModel={[...selectedIds]}
                 onSelectionChange={handleSelection}
                 showSelectAll
                 onSelectAll={selectAllMatching}
                 onClearSelection={handleClearSelection}
                 selectAllPending={selectAllPending}
                 /* The toggle covers every matter the current filters match, across
                    pages, so it names that count rather than the page on screen. */
                 selectAllLabel={
                   selectedCount > 0
                     ? `${selectedCount} selected${selectedCount < matterTable.total ? ` of ${matterTable.total}` : ""}`
                     : `Select all ${matterTable.total}`
                 }
                 emptyIcon={<Briefcase size={40} />}
                 emptyTitle="No matters found"
                 emptyMessage="Try adjusting your search or filters."
               />
               ) : gridTab === 'tasks' ? (
               <ListView<Task>
                 rows={taskTable.rows}
                 loading={taskTable.loading}
                 fetching={taskTable.fetching}
                 getRowId={(row) => row.taskId || row.id}
                 renderRow={renderTaskRow}
                 onRowClick={handleTaskCardClick}
                 rowActions={
                   canDeleteTask
                     ? (row) => (
                         <Tooltip title="Delete" enterDelay={300}>
                           <button aria-label="Delete"
                             type="button"
                             onClick={() => handleDeleteTaskTrigger(row.taskId || row.id, undefined)}
                             className="rounded-md p-1.5 text-red-600 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-red-500/10 dark:text-red-400"
                           >
                             <Trash2 size={15} />
                           </button>
                         </Tooltip>
                       )
                     : undefined
                 }
                 sortingMode="server"
                 sortColumns={taskSortColumns}
                 sortValue={taskSortValue}
                 sortDir={taskSortDir}
                 onSortChange={handleTaskSortChange}
                 paginationMode="server"
                 page={taskTable.page - 1}
                 pageSize={taskTable.rowsPerPage}
                 rowCount={taskTable.total}
                 onPageChange={(p) => taskTable.setPage(p + 1)}
                 onPageSizeChange={taskTable.setRowsPerPage}
                 pageSizeOptions={[10, 25, 50]}
                 defaultPageSize={taskTable.rowsPerPage}
                 showSelection
                 selectionModel={[...selectedIds]}
                 onSelectionChange={handleSelection}
                 showSelectAll
                 onSelectAll={selectAllMatching}
                 onClearSelection={handleClearSelection}
                 selectAllPending={selectAllPending}
                 /* The toggle covers every task the current filters match, across
                    pages, so it names that count rather than the page on screen. */
                 selectAllLabel={
                   selectedCount > 0
                     ? `${selectedCount} selected${selectedCount < taskTable.total ? ` of ${taskTable.total}` : ""}`
                     : `Select all ${taskTable.total}`
                 }
                 emptyIcon={<CheckSquare2 size={40} />}
                 emptyTitle="No tasks found"
                 emptyMessage="Try adjusting your search or filters."
               />
               ) : (
               <ListView<Client>
                 rows={clientTable.rows}
                 loading={clientTable.loading}
                 fetching={clientTable.fetching}
                 getRowId={(row) => row.id}
                 renderRow={renderClientRow}
                 onRowClick={handleClientCardClick}
                 sortingMode="server"
                 sortColumns={clientSortColumns}
                 sortValue={clientSortValue}
                 sortDir={clientSortDir}
                 onSortChange={handleClientSortChange}
                 /* The page lives in the table hook, which outlives the list, so
                    returning from a client's file view lands on the same page. */
                 paginationMode="server"
                 page={clientTable.page - 1}
                 pageSize={clientTable.rowsPerPage}
                 rowCount={clientTable.total}
                 onPageChange={(p) => clientTable.setPage(p + 1)}
                 onPageSizeChange={clientTable.setRowsPerPage}
                 pageSizeOptions={[10, 25, 50]}
                 defaultPageSize={clientTable.rowsPerPage}
                 emptyIcon={<Users size={40} />}
                 emptyTitle="No clients found"
                 emptyMessage="Try adjusting your search."
               />
               )}
             </GridSection>
            </>
            )}
          </div>
        )}

        </div>

        <ConfirmModal 
          isOpen={matterDeleteConfirmOpen} 
          onClose={() => { if (!isDeletingMatters) setMatterDeleteConfirmOpen(false); }}
          onConfirm={confirmMatterDelete}
          title={matterToDelete ? "Delete Matter" : "Delete Matters"}
          message={
            matterToDelete
              ? `Are you sure you want to delete this matter? This action cannot be undone.`
              : `Are you sure you want to delete ${deleteDialogCount} selected matter(s)? This action cannot be undone.`
          }
          confirmText="Delete"
          cancelText="Cancel"
          loading={isDeletingMatters}
        />

        <ConfirmModal 
          isOpen={taskDeleteConfirmOpen} 
          onClose={() => { if (!isDeletingTasks) setTaskDeleteConfirmOpen(false); }}
          onConfirm={confirmTaskDelete}
          title={taskToDelete ? "Delete Task" : "Delete Tasks"}
          message={
            taskToDelete
              ? `Are you sure you want to delete this task? This action cannot be undone.`
              : `Are you sure you want to delete ${deleteDialogCount} selected task(s)? This action cannot be undone.`
          }
          confirmText="Delete"
          cancelText="Cancel"
          loading={isDeletingTasks}
        />

        <Modal
          isOpen={!!clientInfoTarget}
          onClose={() => setClientInfoTarget(null)}
          title="Client"
          size="sm"
          lockScroll
          bodyClassName={null}
        >
          <div className="px-6 py-5">
            {clientInfoLoading ? (
              <div className="flex justify-center py-4">
                <Spinner />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-11 h-11 rounded-full bg-accent-soft dark:bg-accent-soft text-accent-emphasis dark:text-accent-emphasis flex items-center justify-center shrink-0">
                    <span className="text-base font-bold">
                      {(clientInfoDetail?.name || clientInfoTarget?.name || '?').trim().charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-on-surface truncate">
                      {clientInfoDetail?.name || clientInfoTarget?.name || 'Client'}
                    </p>
                    {clientInfoDetail?.status && (
                      <div className="mt-1">
                        <ClientStatusBadge status={clientInfoDetail.status} />
                      </div>
                    )}
                  </div>
                </div>
                <div className="space-y-2 text-sm text-on-surface-secondary">
                  {clientInfoDetail?.email && (
                    <div className="flex items-center gap-2 min-w-0">
                      <Mail size={14} className="shrink-0" />
                      <span className="truncate">{clientInfoDetail.email}</span>
                    </div>
                  )}
                  {clientInfoDetail?.phone && (
                    <div className="flex items-center gap-2 min-w-0">
                      <Phone size={14} className="shrink-0" />
                      <span className="truncate">{clientInfoDetail.phone}</span>
                    </div>
                  )}
                  {clientInfoDetail?.organization && (
                    <div className="flex items-center gap-2 min-w-0">
                      <Building2 size={14} className="shrink-0" />
                      <span className="truncate">{clientInfoDetail.organization}</span>
                    </div>
                  )}
                  {!clientInfoDetail?.email && !clientInfoDetail?.phone && !clientInfoDetail?.organization && (
                    <p className="text-on-surface-muted">No additional details on file.</p>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-outline bg-surface-alt px-5 py-3 flex justify-end gap-2 rounded-b-lg">
            <Button onClick={() => setClientInfoTarget(null)} type="secondary" size="small">
              Close
            </Button>
            <Button onClick={handleOpenClientTab} type="primary" size="small" icon={<ExternalLink size={14} />}>
              Open in Client tab
            </Button>
          </div>
        </Modal>

        {notification && (
          <Toast
            message={notification.message}
            tone={notification.severity === 'error' ? 'danger' : notification.severity}
            duration={6000}
            onDismiss={() => setNotification(null)}
          />
        )}
      </div>
    </RequireFeature>
  );
}
