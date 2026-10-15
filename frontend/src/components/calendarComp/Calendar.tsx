"use client";

import dayjs from "dayjs";
import { Settings2, User as UserIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { getMonthDays, getDefaultDateTimeLocalValue } from "@/lib/utils/dateUtils";
import { getCalendarWindow } from "@/lib/utils/calendarWindow";
import MattersService from "@/services/matters.service";
import matterEventsService from "@/services/matterEvents.service";
import clientsService from "@/services/clients.service";
import calendarEventsService from "@/services/calendarEvents.service";
import TasksService from "@/services/tasks.service";
import AuthService from "@/services/auth.service";
import { useAuth } from "@/hooks/useAuth";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import { useNavigation } from "@/contexts/NavigationContext";
import { useQueryClient } from "@tanstack/react-query";
import { useLawFirmUsers } from "@/hooks/useUsers";
import useCourts from "@/hooks/courtHooks/useCourts";
import useCalendarWindowData from "@/hooks/calendarHooks/useCalendarWindowData";
import { eventCourtName } from "@/components/eventComp/eventCourt";
import useNextUpTask from "@/hooks/calendarHooks/useNextUpTask";
import useSlidingHighlight from "@/hooks/useSlidingHighlight";
import CalendarSkeleton from "./CalendarSkeleton";
import { readSavedCalendarView, saveCalendarView, type CalendarViewMode } from "./calendarViewPreference";
import CalendarLoadingBar from "./CalendarLoadingBar";
import settingsService from "@/services/settings.service";
import { GoogleCalendarSync } from "@/services/googleCalendarSync.service";
import { OutlookCalendarSync } from "@/services/outlookCalendarSync.service";
import useUserSyncSettings from "@/hooks/calendarHooks/useUserSyncSettings";
import { useCalendarSyncStatus } from "@/contexts/CalendarSyncContext";
import type { Task, SyncFlags, Event, PaymentDate } from "@/types";
import Tooltip from "@/components/ui/Tooltip";
import CalendarSidePanel, { type CalendarDetailRequest } from './CalendarSidePanel';
import { canPreviewCalendarConnections } from './calendarConnectionPreview';
import { getTaskColor } from './calendarColors';
import { paymentMonthCellLabel, paymentTooltipTitle } from './paymentLabels';
import { paymentDateRemaining } from '@/lib/billing/paymentDateBalance';
import { taskMinuteOfDay, eventMinuteOfDay, eventDayKeys, DEFAULT_TIMED_BLOCK_MS, endsAtPayloadFor, providerEndFromForm, taskDayKeys, eventTimeLabel } from './calendarTiming';
import ErrorNotification from "@/components/ErrorNotification";
import Modal from "@/components/ui/Modal";
import SectionLabel from "@/components/ui/SectionLabel";
import ActionIconButton from "@/components/ui/ActionIconButton";
import Button from "@/components/ui/Button";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import Dropdown from "@/components/ui/Dropdown";
import { useResetAfterClose } from "@/hooks/useMountTransition";

type CalendarProps = {
  /** When true, renders without outer card wrapper (for embedding in page-level card) */
  embedded?: boolean;
};

/* ─── Helper functions ─── */

const formatHour = (hour: number) => {
  if (hour === 0) return '12 AM';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
};

const HOURS = Array.from({ length: 24 }, (_, i) => i);

// Stable empty arrays returned by the per-day lookups when a date has no items,
// so callers never receive a fresh `[]` reference that would bust memoization.
const EMPTY_TASKS: Task[] = [];
const EMPTY_EVENTS: Event[] = [];
const EMPTY_PAYMENTS: PaymentDate[] = [];

// Fixed pixel height of a timed block in the day/week grid.
const BLOCK_HEIGHT = 56;

// Max all-day chips rendered per day cell before collapsing the rest into a
// "+N" chip, so the fixed-height row never scrolls. Phone columns fit one pill
// per line; wide columns fit a couple of lines of small pills.
// All-day row caps (week view). Full-width task/event rows show one line; small
// payment pills pack several per line, so they get a higher cap. Beyond these,
// the remainder collapses into a "+N" chip. The row is fixed-height and never
// scrolls, so these keep it within ~2 lines.
const ALL_DAY_BIG_CAP = 1;
const ALL_DAY_PAY_CAP_NARROW = 1;
const ALL_DAY_PAY_CAP_WIDE = 3;

// A single positioned item in the time grid, either a task or a matter event.
// Both are laid out together so overlapping items pack side-by-side.
type TimeGridBlock =
  | { kind: 'task'; top: number; task: Task }
  | { kind: 'event'; top: number; event: Event };

// A positioned entry returned by getBlockLayout: either a rendered block with
// its column offset/width, or a "+N" overflow badge (phone week view) standing
// in for the hidden blocks of an overlap cluster.
type LayoutItem =
  | { kind: 'block'; block: TimeGridBlock; left: string; width: string }
  | { kind: 'overflow'; top: number; count: number; keys: string[]; left?: string; width?: string };

// Side-panel highlight key for a timed grid block (matches the panel's item keys).
const blockKeyOf = (b: TimeGridBlock): string =>
  b.kind === 'task' ? `task-${b.task.taskId || b.task.id}` : `event-${b.event.id}`;

// Max side-by-side event columns in wide week view before overlapping events
// collapse into a "+N" column. Beyond this, day columns are too narrow to keep
// blocks legible.
const WEEK_MAX_COLS = 3;

/**
 * The start, end and all-day flag a Google or Outlook event's update sends
 * once its schedule changed. The provider takes bounds rather than form
 * values: timed inputs are viewer-local instants, all-day bounds are calendar
 * dates with an exclusive end, independent of the viewer's zone.
 *
 * A start moved with no end picked is sent alone: the server carries the
 * stored end along with it, keeping a length that may be newer than this
 * cached copy's. Flipping all-day is the exception, since the server drops an
 * end that cannot be read in the other shape and the providers require one,
 * so that update brings an end of its own.
 */
function providerSchedule(event: Event, updates: { date?: string; endsAt?: string; allDay?: boolean }) {
  const rawStart = updates.date || event.start || null;
  const allDay = updates.allDay ?? !!event.allDay;
  const start = rawStart
    ? (allDay ? rawStart.slice(0, 10) : dayjs(rawStart).toISOString())
    : null;
  if (start && updates.endsAt) {
    return { start, end: providerEndFromForm(allDay, updates.endsAt), allDay };
  }
  if (allDay === !!event.allDay) {
    return { start, ...(updates.allDay !== undefined ? { allDay } : {}) };
  }
  // A length in one shape does not carry into the other, so the toggled
  // event takes the default: one day, or one block after a timed start.
  const end = !start ? null
    : allDay ? dayjs(start).add(1, 'day').format('YYYY-MM-DD')
      : dayjs(start).add(DEFAULT_TIMED_BLOCK_MS, 'millisecond').toISOString();
  return { start, end, allDay };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- `embedded` is accepted for call sites, but the layout fills its container either way
export default function Calendar(_props: CalendarProps) {
  const params = useParams();
  const { user: currentUser } = useAuth();
  const { loading: permissionsLoading, hasPermission } = usePermissions();
  const { features, isLocked } = useFirmSettings();
  const { navigate } = useNavigation();
  const lawFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string | undefined);
  const calendarSyncEnabled = features.calendarSync;
  const calendarSyncLocked = isLocked("calendarSyncEnabled") && !hasPermission("settings.manageLocked");
  const canViewBilling = !permissionsLoading && hasPermission("billing.viewInvoices");
  const goToCalendarSettings = useCallback(() => {
    if (lawFirmId) navigate(`/lawfirm/${lawFirmId}/settings/general`);
  }, [lawFirmId, navigate]);

  // The anchor the whole calendar is drawn around. Declared before the data hooks
  // because the date window every read is bounded to is derived from it.
  const [currentDate, setCurrentDate] = useState(dayjs());

  // Every dataset the calendar draws, bounded to the date window around the
  // current anchor. Events carry their own matter and client names, so the
  // calendar no longer loads the firm's whole matter and client lists to label
  // them.
  const queryClient = useQueryClient();
  const { users: lawFirmUsers } = useLawFirmUsers(lawFirmId || "");
  // The court list itself loads inside the side panel, when a task modal opens;
  // only the address update is needed here, which reads nothing.
  const { updateCourt } = useCourts(lawFirmId, false);
  const updateCourtAddress = (courtId: string, address: string) => updateCourt(courtId, { address });
  const {
    matterEvents: allMatterEvents,
    clientEvents: allStandaloneClientEvents,
    externalEvents,
    tasks,
    paymentDates,
    loading: calendarLoading,
    fetching: calendarFetching,
    rangeUnloaded,
    error: calendarError,
    refreshTasks,
    retryLoad,
  } = useCalendarWindowData(lawFirmId, currentDate, {
    includePaymentDates: canViewBilling && !permissionsLoading,
  });

  // "Next Up" is a firm-wide fact, so it is resolved on its own rather than
  // scanned out of the window on screen: the next item is often months away.
  const { nextUpTask, loading: nextUpLoading } = useNextUpTask(lawFirmId);

  // Single refresh entry point for the task mutation handlers and the side panel.
  const onTasksRefresh = refreshTasks;

  // Nothing drawn yet: show the skeleton rather than an empty grid that would then
  // reflow. Gated on every source the first paint depends on so nothing pops in
  // after the grid appears; a later range change never reaches here, because the
  // previous window stays rendered while the new one loads.
  const showSkeleton = calendarLoading || nextUpLoading;

  // Stepping a month keeps the neighbouring days already loaded, so the grid is
  // correct the moment it moves. Jumping further lands on days nothing loaded
  // covers: fade the grid and stop it taking clicks, so the blank days read as
  // "still loading" rather than "nothing scheduled", and a day panel can't be
  // opened on data that has not arrived.
  const gridLoadingClass = rangeUnloaded
    ? "opacity-40 pointer-events-none transition-opacity duration-200"
    : "transition-opacity duration-200";

  // Until its query resolves the window hook returns a fresh `[]` on every render.
  // The overlay sync below keys off identity, so the empty case is pinned to one
  // stable reference; without it the effect would re-fire on every render forever.
  const windowTasks = tasks.length ? tasks : EMPTY_TASKS;

  const [localTasks, setLocalTasks] = useState<Task[]>(windowTasks);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs a locally-mutated overlay copy of the fetched window
  useEffect(() => setLocalTasks(windowTasks), [windowTasks]);

  /* ─── Existing state (UNCHANGED) ─── */
  const [panelOpen, setPanelOpen] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches
  );
  const [selectedDate, setSelectedDate] = useState<dayjs.Dayjs | null>(dayjs());
  // True on phone-width viewports (Tailwind `sm` breakpoint). Week view collapses
  // overlapping time-grid events into a single legible block + "+N" badge here,
  // since 7 day-columns leave too little width to pack overlaps side-by-side.
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
  );
  const [, setExpandedKey] = useState<string | null>(null);
  // Which time-grid block the user last clicked, so it can be highlighted.
  const [selectedBlockKey, setSelectedBlockKey] = useState<string | null>(null);
  const detailRequestId = useRef(0);
  const lastGridClick = useRef<{ key: string; item: CalendarDetailRequest['item']; at: number; x: number; y: number } | null>(null);
  const gridPanelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (gridPanelTimer.current) clearTimeout(gridPanelTimer.current);
  }, []);
  const returnToMobilePanel = useRef(false);
  const [detailRequest, setDetailRequest] = useState<(CalendarDetailRequest & { target: 'desktop' | 'mobile' }) | null>(null);
  const clearGridPanelTimer = () => {
    if (gridPanelTimer.current) clearTimeout(gridPanelTimer.current);
    gridPanelTimer.current = null;
  };
  const requestGridDetail = (item: CalendarDetailRequest['item']) => {
    clearGridPanelTimer();
    lastGridClick.current = null;
    const desktop = window.matchMedia('(min-width: 1280px)').matches;
    if (!desktop) setPanelOpen(false);
    detailRequestId.current += 1;
    setDetailRequest({ id: detailRequestId.current, item, target: desktop ? 'desktop' : 'mobile' });
  };
  const showPanelAfterGridClick = (key: string, item: CalendarDetailRequest['item'], clickCount: number, x: number, y: number) => {
    if (window.matchMedia('(min-width: 1280px)').matches || clickCount === 0) {
      setPanelOpen(true);
      return;
    }
    const now = Date.now();
    if (clickCount > 0 && lastGridClick.current?.key === key && now - lastGridClick.current.at <= 450) {
      requestGridDetail(item);
      return;
    }
    clearGridPanelTimer();
    lastGridClick.current = { key, item, at: now, x, y };
    gridPanelTimer.current = setTimeout(() => {
      gridPanelTimer.current = null;
      setPanelOpen(true);
    }, 180);
  };
  const handleOverlaySecondClick = (e: MouseEvent<HTMLElement>) => {
    const lastClick = lastGridClick.current;
    if (!lastClick || Date.now() - lastClick.at > 450) return;
    if (Math.abs(e.clientX - lastClick.x) > 32 || Math.abs(e.clientY - lastClick.y) > 32) return;
    e.preventDefault();
    e.stopPropagation();
    requestGridDetail(lastClick.item);
  };
  const hideMobilePanelForDetail = () => {
    returnToMobilePanel.current = panelOpen;
    setPanelOpen(false);
  };
  const restoreMobilePanelAfterDetail = () => {
    if (returnToMobilePanel.current) setPanelOpen(true);
    returnToMobilePanel.current = false;
  };
  // Which empty time-slot (week/day view) is selected, as `YYYY-MM-DD|HH`, so
  // the clicked hour cell is highlighted until another day/slot is picked.
  const [selectedSlotKey, setSelectedSlotKey] = useState<string | null>(null);
  // Week view folds overflowing items into "+N" chips (the all-day row and each
  // overlap cluster in the time grid). Clicking one opens the day panel and
  // highlights the items it stands for; these are their block keys
  // (`task-<id>` / `event-<id>` / `payment-<id>`).
  const [highlightedKeys, setHighlightedKeys] = useState<string[]>([]);

  const [matterMembersByMatterId, setMatterMembersByMatterId] = useState<Record<string, string[]>>({});
  const [, setFormOpen] = useState(false);
  const [newTaskDueDate, setNewTaskDueDate] = useState(() => getDefaultDateTimeLocalValue());
  const [selectedMatterId] = useState("");
  const [editTaskMatterId] = useState("");

  const [deletingTask, setDeletingTask] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const closeDeleteConfirm = () => setShowDeleteConfirm(null);
  const deleteTitleId = useId();

  // Local overlay of the user's sync preferences, seeded from the shared
  // useUserSyncSettings cache below so a sync-direction save can update it
  // optimistically. The connection flags in it are derived by the API.
  const [syncFlags, setSyncFlags] = useState<SyncFlags | null>(null);
  const [devPreview, setDevPreview] = useState<SyncFlags>({});
  const [calendarSettingsOpen, setCalendarSettingsOpen] = useState(false);
  const [syncDirectionSaving, setSyncDirectionSaving] = useState(false);
  const [calendarSettingsError, setCalendarSettingsError] = useState<string | null>(null);
  useResetAfterClose(calendarSettingsOpen, () => setCalendarSettingsError(null));
  // Calendar sync is owned by the layout-level background engine; the calendar
  // reads its live status (and the user's sync preferences) instead of running
  // its own duplicate sync + settings fetch.
  const { syncingGoogle, syncingOutlook, outlookError: outlookSyncError } = useCalendarSyncStatus();
  const { syncFlags: fetchedSyncFlags } = useUserSyncSettings(lawFirmId, calendarSyncEnabled);
  const devPreviewEnabled = process.env.NODE_ENV === 'development'
    && canPreviewCalendarConnections(process.env.NODE_ENV, typeof window === 'undefined' ? '' : window.location.hostname);
  const devPreviewKey = devPreviewEnabled && lawFirmId ? `paralegix-calendar-preview-${lawFirmId}` : null;
  const simulatedGoogle = devPreviewEnabled && !!devPreview.loggedInWithGoogle && !syncFlags?.loggedInWithGoogle;
  const simulatedOutlook = devPreviewEnabled && !!devPreview.loggedInWithMicrosoft && !syncFlags?.loggedInWithMicrosoft;
  const googleConnected = !!syncFlags?.loggedInWithGoogle || simulatedGoogle;
  const outlookConnected = !!syncFlags?.loggedInWithMicrosoft || simulatedOutlook;

  useEffect(() => {
    if (!devPreviewKey) return;
    try {
      const saved = window.sessionStorage.getItem(devPreviewKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restores this firm's local calendar preview after navigation
      setDevPreview(saved ? JSON.parse(saved) as SyncFlags : {});
    } catch {
      setDevPreview({});
    }
  }, [devPreviewKey]);

  const updateDevPreview = (changes: Partial<SyncFlags>) => {
    if (!devPreviewKey) return;
    const next = { ...devPreview, ...changes };
    setDevPreview(next);
    try { window.sessionStorage.setItem(devPreviewKey, JSON.stringify(next)); } catch {}
  };

  /* ─── New UI state ─── */
  // Resolved through the shared preference helper so the loading skeleton draws
  // the same view this is about to render.
  const [viewMode, setViewMode] = useState<CalendarViewMode>(readSavedCalendarView);
  const viewModeToggle = useSlidingHighlight<HTMLDivElement>(viewMode);
  const [currentTimePosition, setCurrentTimePosition] = useState(0);

  // Drop the multi-item all-day highlight when navigating weeks or switching views.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the transient all-day highlight on navigation/view change
    setHighlightedKeys([]);
  }, [currentDate, viewMode]);

  const timeGridRef = useRef<HTMLDivElement>(null);
  // Tracks the last (view, date) we auto-scrolled for, and whether that scroll
  // landed on real content. Async-loaded data can trigger one re-scroll, but
  // later background refetches never yank the user's manual scroll position.
  const lastAutoScrollKey = useRef<string | null>(null);
  const autoScrolledWithContent = useRef(false);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);

  /* ─── All existing effects (UNCHANGED) ─── */

  // Seed the local sync-flag overlay from the shared settings cache (one fetch,
  // shared with the layout-level background sync). When sync is disabled there
  // are no flags to display.
  useEffect(() => {
    if (!calendarSyncEnabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds local sync-flag overlay from an async settings fetch
      setSyncFlags(null);
      return;
    }
    if (fetchedSyncFlags) setSyncFlags(fetchedSyncFlags);
  }, [fetchedSyncFlags, calendarSyncEnabled]);

  // Load matter members on-demand
  useEffect(() => {
    const ensureMatterMembersLoaded = async (matterId?: string) => {
      if (!lawFirmId || !matterId || matterMembersByMatterId[matterId]) return;
      try {
        const c: any = await MattersService.getMatterById(matterId, lawFirmId);
        const memberIds: string[] = Array.isArray(c?.memberUserIds)
          ? c.memberUserIds
          : Array.isArray(c?.members)
            ? c.members.map((m: any) => m?.userId || m?.id).filter(Boolean)
            : [];
        setMatterMembersByMatterId((prev) => ({ ...prev, [matterId]: memberIds }));
      } catch (e) {
        console.error("Failed to load matter members:", e);
        setMatterMembersByMatterId((prev) => ({ ...prev, [matterId]: [] }));
      }
    };
    ensureMatterMembersLoaded(selectedMatterId);
    ensureMatterMembersLoaded(editTaskMatterId);
  }, [lawFirmId, selectedMatterId, editTaskMatterId, matterMembersByMatterId]);

  // Escape key handler
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPanelOpen(false);
        setExpandedKey(null);
        setFormOpen(false);
        setSelectedBlockKey(null);
      }
    };
    if (panelOpen) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  // Track the phone-width breakpoint so the week grid can collapse overlaps.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const handler = () => setIsNarrow(mq.matches);
    handler();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Current time position updater. The "now" line only renders in week/day
  // view, so the 60s tick (which re-renders the whole calendar) is pointless in
  // month view, only run it where the value is actually used.
  useEffect(() => {
    if (viewMode !== 'week' && viewMode !== 'day') return;
    const update = () => {
      const now = dayjs();
      setCurrentTimePosition(now.hour() * 60 + now.minute());
    };
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, [viewMode]);

  // Re-measure scrollbar width when the grid resizes (e.g. sidebar toggle)
  useEffect(() => {
    if (!timeGridRef.current) return;
    const el = timeGridRef.current;
    const observer = new ResizeObserver(() => {
      setScrollbarWidth(el.offsetWidth - el.clientWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewMode]);

  /* ─── Existing computed values (UNCHANGED) ─── */

  /* ─── Existing handlers (UNCHANGED) ─── */

  const openPanelForDay = (day: dayjs.Dayjs, showPanel = true) => {
    setSelectedDate(day);
    setExpandedKey(null);
    setSelectedSlotKey(null);
    setHighlightedKeys([]);
    setNewTaskDueDate(getDefaultDateTimeLocalValue(day.toDate()));
    if (showPanel) setPanelOpen(true);
  };

  const year = currentDate.year();
  const month = currentDate.month();
  const days = getMonthDays(year, month);
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const getTaskKey = (t: Task, idx?: number) =>
    `${t.taskId ?? t.lawFirmId ?? "noid"}|${t.dueDate ?? "nodate"}|${idx ?? "x"}`;

  const getTaskDateValue = useCallback((task: Task) => task.dueDateLocalInput || task.dueDate || '', []);

  const isExternalCalendarTask = useCallback(
    (task: Task) => {
      const source = typeof task.source === 'string' ? task.source.toLowerCase() : '';
      // Paralegix-created tasks should stay tasks even if they have external IDs.
      if (source === 'app' || source === 'recurrence') return false;

      // Tasks created from external providers are treated as external events.
      if (source === 'google_calendar' || source === 'outlook_calendar') return true;

      return false;
    },
    []
  );

  const calendarTasks = useMemo(
    () => (Array.isArray(localTasks) ? localTasks.filter(t => !isExternalCalendarTask(t)) : []),
    [localTasks, isExternalCalendarTask]
  );

  // Bucket tasks by 'YYYY-MM-DD' once per data change. The month/mini grids
  // probe ~42 days every render (and a 60s tick re-renders the whole tree), so
  // a per-day O(n) filter with dayjs().format() per task was O(days × tasks) of
  // dayjs work each render. Lookups are now O(1).
  const tasksByDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    const bounds = getCalendarWindow(currentDate);
    for (const t of calendarTasks) {
      // A multi-day all-day task is drawn on each day it covers, like an event.
      for (const key of taskDayKeys(t, bounds)) {
        const bucket = map.get(key);
        if (bucket) bucket.push(t);
        else map.set(key, [t]);
      }
    }
    return map;
  }, [calendarTasks, currentDate]);

  const findTasksForDay = useCallback(
    (date: dayjs.Dayjs) => tasksByDate.get(date.format('YYYY-MM-DD')) ?? EMPTY_TASKS,
    [tasksByDate]
  );

  // Memoized so it isn't rebuilt with a new reference on every render (the 60s
  // current-time tick re-renders the whole component), which would otherwise
  // bust the downstream `allCalendarEvents`/`selectedDayEvents` memos.
  //
  // The matter and client names are read straight off each event: they are
  // resolved server-side, so no firm-wide matter or client list is needed here.
  const matterDateEvents: Event[] = useMemo(() => [
    ...allMatterEvents
      .filter(e => e.date)
      .map(e => ({
        id: e.id, title: e.title, start: e.date!, end: e.endsAt ?? undefined,
        startLocalDisplay: e.dateLocalDisplay, endLocalDisplay: e.endsAtLocalDisplay,
        startTimeZone: e.timeZone, recurrenceGroupId: e.recurrenceGroupId,
        clientNames: e.clientNames?.length ? e.clientNames : undefined,
        source: 'matter' as const, matterId: e.matterId,
        matterName: e.matterName ?? undefined,
        eventType: e.type, notes: e.notes, eventStatus: e.status,
        location: [e.locationName, e.location].filter(Boolean).join(' · ') || null,
        locationName: e.locationName ?? null, locationAddress: e.location ?? null,
        court: eventCourtName('matter', e),
        allDay: e.allDay,
      })),
    ...allStandaloneClientEvents
      .filter(e => e.date)
      .map(e => ({
        id: e.id, title: e.title, start: e.date!, end: e.endsAt ?? undefined,
        startLocalDisplay: e.dateLocalDisplay, endLocalDisplay: e.endsAtLocalDisplay,
        startTimeZone: e.timeZone, recurrenceGroupId: e.recurrenceGroupId,
        clientNames: e.clientName ? [e.clientName] : undefined,
        source: 'client' as const, clientId: e.clientId,
        eventType: e.type, notes: e.notes, eventStatus: e.status,
        location: [e.locationName, e.location].filter(Boolean).join(' · ') || null,
        locationName: e.locationName ?? null, locationAddress: e.location ?? null,
        court: eventCourtName('client', e),
        allDay: e.allDay,
      })),
  ], [allMatterEvents, allStandaloneClientEvents]);

  // A provider's events show exactly while importing from it is on ("Import
  // Events from ..." or "Two-Way Sync"). There is no separate display switch.
  const showGoogleEvents = Boolean((simulatedGoogle ? devPreview : syncFlags)?.allowGoogleToParalegixSync);
  const showOutlookEvents = Boolean((simulatedOutlook ? devPreview : syncFlags)?.allowOutlookToParalegixSync);

  const externalCalendarEvents: Event[] = useMemo(() => {
    const fromApi = Array.isArray(externalEvents)
      ? externalEvents.filter(ev => (ev.provider !== 'google' || showGoogleEvents) && (ev.provider !== 'outlook' || showOutlookEvents))
      : [];
    const fromTasks = Array.isArray(localTasks)
      ? localTasks
          .filter(isExternalCalendarTask)
          .filter(t => (!t.googleEventId || showGoogleEvents) && (t.googleEventId || !t.outlookId || showOutlookEvents))
          .map((t) => {
            const start = getTaskDateValue(t);
            return {
              id: t.taskId || t.id,
              title: t.title,
              description: t.description,
              start: start || undefined,
              end: t.endsAt || undefined,
              allDay: taskMinuteOfDay(t) === null,
              notes: t.description || null,
              location: t.location || null,
              source: 'external' as const,
              provider: t.googleEventId ? 'google' : (t.outlookId ? 'outlook' : undefined),
            } as Event;
          })
      : [];

    const map = new Map<string, Event>();
    for (const ev of [...fromApi, ...fromTasks]) {
      if (ev?.id) map.set(ev.id, ev);
    }
    return Array.from(map.values());
  }, [externalEvents, localTasks, getTaskDateValue, isExternalCalendarTask, showGoogleEvents, showOutlookEvents]);

  const allCalendarEvents: Event[] = useMemo(
    () => [...matterDateEvents, ...externalCalendarEvents],
    [matterDateEvents, externalCalendarEvents]
  );

  const eventsByDate = useMemo(() => {
    const map = new Map<string, Event[]>();
    const bounds = getCalendarWindow(currentDate);
    for (const e of allCalendarEvents) {
      for (const key of eventDayKeys(e, bounds)) {
        const bucket = map.get(key);
        if (bucket) bucket.push(e);
        else map.set(key, [e]);
      }
    }
    return map;
  }, [allCalendarEvents, currentDate]);

  const findEventsForDay = useCallback(
    (date: dayjs.Dayjs) => eventsByDate.get(date.format('YYYY-MM-DD')) ?? EMPTY_EVENTS,
    [eventsByDate]
  );

  // Auto-scroll the day/week time grid to a useful position + measure scrollbar
  // width. A view that includes today opens on the current hour; any other view
  // opens on its earliest timed item so it never starts on an empty stretch.
  useEffect(() => {
    if (viewMode !== 'week' && viewMode !== 'day') return;
    // The grid is not mounted while the skeleton shows, so a scroll recorded
    // then would never reach it.
    if (showSkeleton) return;

    const key = `${viewMode}|${currentDate.format('YYYY-MM-DD')}`;
    const daysShown = viewMode === 'day'
      ? [currentDate]
      : Array.from({ length: 7 }, (_, i) => currentDate.startOf('week').add(i, 'day'));

    // Minute-offset (top position, since 1 minute === 1px in the grid) of every
    // timed task/event on the shown day(s); all-day items live in a separate row.
    const timedMinutes: number[] = [];
    for (const day of daysShown) {
      for (const t of findTasksForDay(day)) {
        const minutes = taskMinuteOfDay(t);
        if (minutes !== null) timedMinutes.push(minutes);
      }
      for (const e of findEventsForDay(day)) {
        const minutes = eventMinuteOfDay(e);
        if (minutes !== null) timedMinutes.push(minutes);
      }
    }
    const hasContent = timedMinutes.length > 0;

    // Re-scroll only when switching view/date, or when content first arrives for
    // a view we previously scrolled with none (data loads async after mount).
    // A plain background refetch must never override the user's manual scroll.
    const isNewKey = lastAutoScrollKey.current !== key;
    if (!isNewKey && (autoScrolledWithContent.current || !hasContent)) return;
    lastAutoScrollKey.current = key;
    autoScrolledWithContent.current = hasContent;

    requestAnimationFrame(() => {
      const grid = timeGridRef.current;
      if (!grid) return;

      const now = dayjs();
      const todayShown = daysShown.some(d => d.isSame(now, 'day'));
      const nowScroll = Math.max(0, (now.hour() - 1) * 60);

      // The earliest item gets an hour of breathing room above it.
      const scrollTo = todayShown
        ? nowScroll
        : hasContent ? Math.max(0, Math.min(...timedMinutes) - 60) : 0;
      grid.scrollTop = scrollTo;
      setScrollbarWidth(grid.offsetWidth - grid.clientWidth);
    });
  }, [viewMode, currentDate, findTasksForDay, findEventsForDay, getTaskDateValue, showSkeleton]);

  // A payment shows on its dueDate and/or its nextPaymentDate (money owed), or on
  // its paidDate (money received), so it can land in multiple buckets, but only
  // once per day (a `Set` of keys dedupes the matter where dates coincide).
  const paymentsByDate = useMemo(() => {
    const map = new Map<string, PaymentDate[]>();
    if (!Array.isArray(paymentDates)) return map;
    for (const p of paymentDates) {
      const keys = new Set<string>();
      if (p.paidDate) keys.add(dayjs(p.paidDate).format('YYYY-MM-DD'));
      if (p.dueDate) keys.add(dayjs(p.dueDate).format('YYYY-MM-DD'));
      if (p.nextPaymentDate) keys.add(dayjs(p.nextPaymentDate).format('YYYY-MM-DD'));
      for (const key of keys) {
        const bucket = map.get(key);
        if (bucket) bucket.push(p);
        else map.set(key, [p]);
      }
    }
    return map;
  }, [paymentDates]);

  const findPaymentDatesForDay = useCallback(
    (date: dayjs.Dayjs) => paymentsByDate.get(date.format('YYYY-MM-DD')) ?? EMPTY_PAYMENTS,
    [paymentsByDate]
  );

  const selectedDayTasks = useMemo(
    () => (selectedDate
      ? [...findTasksForDay(selectedDate)].sort(
          (a, b) => dayjs(getTaskDateValue(a)).valueOf() - dayjs(getTaskDateValue(b)).valueOf()
        )
      : []),
    [selectedDate, findTasksForDay, getTaskDateValue]
  );

  const selectedDayPaymentDates = useMemo(
    () => (selectedDate ? findPaymentDatesForDay(selectedDate) : []),
    [selectedDate, findPaymentDatesForDay]
  );

  const selectedDayEvents = useMemo(
    () => (selectedDate
      ? [...findEventsForDay(selectedDate)].sort(
          (a, b) => dayjs(a.start ?? 0).valueOf() - dayjs(b.start ?? 0).valueOf()
        )
      : []),
    [selectedDate, findEventsForDay]
  );

  const goToPrevMonth = () => setCurrentDate((prev) => prev.subtract(1, "month"));
  const goToNextMonth = () => setCurrentDate((prev) => prev.add(1, "month"));

  const handleDeleteTask = async (taskId: string) => {
    if (!lawFirmId || !taskId) return;
    setDeletingTask(taskId);
    setDeleteError(null);
    setShowDeleteConfirm(null);
    try {
      await TasksService.deleteTask(lawFirmId, taskId);
      onTasksRefresh?.();
    } catch (e: unknown) {
      console.error("Error deleting task:", e);
      setDeleteError(e instanceof Error ? e.message : "Failed to delete task");
      // The real confirm-and-delete UI lives in `CalendarSidePanel`
      // (`confirmDeleteTask`), which awaits this handler and needs the
      // rejection to show the failure - swallowing it here left a refused
      // delete with no feedback at all.
      throw e;
    } finally {
      setDeletingTask(null);
    }
  };

  const googleDirectionFlags = simulatedGoogle ? devPreview : syncFlags;
  const outlookDirectionFlags = simulatedOutlook ? devPreview : syncFlags;
  const googleSyncDirection = googleDirectionFlags?.allowParalegixToGoogleSync && googleDirectionFlags?.allowGoogleToParalegixSync
    ? 'both'
    : googleDirectionFlags?.allowParalegixToGoogleSync ? 'paralegix-to-google'
      : googleDirectionFlags?.allowGoogleToParalegixSync ? 'google-to-paralegix' : 'none';
  const outlookSyncDirection = outlookDirectionFlags?.allowParalegixToOutlookSync && outlookDirectionFlags?.allowOutlookToParalegixSync
    ? 'both'
    : outlookDirectionFlags?.allowParalegixToOutlookSync ? 'paralegix-to-outlook'
      : outlookDirectionFlags?.allowOutlookToParalegixSync ? 'outlook-to-paralegix' : 'none';

  const changeSyncDirection = async (provider: 'google' | 'outlook', direction: string) => {
    if (!lawFirmId || calendarSyncLocked || syncDirectionSaving) return;
    if (provider === 'google' ? !googleConnected : !outlookConnected) return;

    const nextFlags = provider === 'google'
      ? {
          allowParalegixToGoogleSync: direction === 'paralegix-to-google' || direction === 'both',
          allowGoogleToParalegixSync: direction === 'google-to-paralegix' || direction === 'both',
        }
      : {
          allowParalegixToOutlookSync: direction === 'paralegix-to-outlook' || direction === 'both',
          allowOutlookToParalegixSync: direction === 'outlook-to-paralegix' || direction === 'both',
        };
    if (provider === 'google' ? simulatedGoogle : simulatedOutlook) {
      updateDevPreview(nextFlags);
      return;
    }
    const previousFlags = syncFlags;
    setSyncFlags(prev => ({ ...(prev || {}), ...nextFlags }));
    setSyncDirectionSaving(true);
    setCalendarSettingsError(null);
    try {
      await settingsService.updateUserSettings(nextFlags, lawFirmId);
      void queryClient.invalidateQueries({ queryKey: ['userSyncSettings', lawFirmId] });
      if (provider === 'google') {
        if ('allowGoogleToParalegixSync' in nextFlags && nextFlags.allowGoogleToParalegixSync) {
          void GoogleCalendarSync.enableSilentSync(lawFirmId).catch(() => {});
        } else {
          void GoogleCalendarSync.disableSilentSync().catch(() => {});
        }
      } else if ('allowOutlookToParalegixSync' in nextFlags && nextFlags.allowOutlookToParalegixSync) {
        void OutlookCalendarSync.enableSilentSync(lawFirmId).catch(() => {});
      } else {
        void OutlookCalendarSync.disableSilentSync().catch(() => {});
      }
    } catch (error) {
      setSyncFlags(previousFlags);
      setCalendarSettingsError(error instanceof Error ? error.message : 'Failed to save calendar sync settings');
    } finally {
      setSyncDirectionSaving(false);
    }
  };

  // Wrapper functions for CalendarSidePanel
  const refreshExternalEvents = async () => {
    if (!lawFirmId) return;
    await queryClient.invalidateQueries({ queryKey: ['externalEvents', lawFirmId] });
  };

  // Prefix invalidation, so every cached window is refreshed rather than only the
  // one on screen. A user who edits an event then steps back a month must not see
  // a stale copy served from the previous window's cache.
  const refreshEvents = async () => {
    if (!lawFirmId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['matterEvents', lawFirmId] }),
      queryClient.invalidateQueries({ queryKey: ['clientEvents', lawFirmId] }),
      queryClient.invalidateQueries({ queryKey: ['externalEvents', lawFirmId] }),
    ]);
  };

  const handleEventUpdate = async (event: Event, updates: { title: string; date?: string; endsAt?: string; eventType: string; notes: string | null; location: string | null; eventStatus: string; allDay?: boolean; confirmNotifyAttendees?: boolean }) => {
    if (!lawFirmId) return;
    // The schedule fields the caller sent, converted for the API. Each is sent
    // only when present: an absent one is a part of the schedule the user did
    // not change, and the server keeps what it stores for it.
    const effectiveAllDay = updates.allDay ?? event.allDay === true;
    const schedule = {
      ...(updates.date !== undefined ? { date: updates.date } : {}),
      ...(updates.endsAt !== undefined ? { endsAt: endsAtPayloadFor(effectiveAllDay, updates.endsAt) } : {}),
      ...(updates.allDay !== undefined ? { allDay: updates.allDay } : {}),
    };
    if (event.source === 'matter' && event.matterId) {
      await matterEventsService.updateEvent(lawFirmId, event.matterId, event.id, {
        title: updates.title,
        ...schedule,
        type: updates.eventType as import('@/types/matterEvent').MatterEventType,
        notes: updates.notes,
        location: updates.location,
        status: updates.eventStatus as import('@/types/matterEvent').MatterEventStatus,
      });
    } else if (event.source === 'client' && event.clientId) {
      await clientsService.updateClientEvent(lawFirmId, event.clientId, event.id, {
        source: 'client',
        title: updates.title,
        ...schedule,
        type: updates.eventType as import('@/types/matterEvent').MatterEventType,
        notes: updates.notes,
        location: updates.location,
        status: updates.eventStatus as import('@/types/matterEvent').MatterEventStatus,
      });
    } else if (event.source === 'external') {
      const scheduleChanged = updates.date !== undefined || updates.endsAt !== undefined || updates.allDay !== undefined;
      await calendarEventsService.updateExternalEvent(lawFirmId, event.id, {
        title: updates.title,
        notes: updates.notes,
        location: updates.location,
        ...(scheduleChanged ? providerSchedule(event, updates) : {}),
        confirmNotifyAttendees: updates.confirmNotifyAttendees,
      });
      await refreshExternalEvents();
      return;
    }
    await refreshEvents();
  };

  const handleEventDelete = async (event: Event, wholeSeries = false) => {
    if (!lawFirmId) return;
    if (event.source === 'matter' && event.matterId) {
      if (wholeSeries && event.recurrenceGroupId) await matterEventsService.deleteRecurrenceGroup(lawFirmId, event.matterId, event.recurrenceGroupId);
      else await matterEventsService.deleteEvent(lawFirmId, event.matterId, event.id);
    } else if (event.source === 'client' && event.clientId) {
      await clientsService.deleteClientEvent(lawFirmId, event.clientId, event.id, 'client');
    } else if (event.source === 'external') {
      await calendarEventsService.deleteExternalEvent(lawFirmId, event.id);
      await refreshExternalEvents();
      return;
    }
    await refreshEvents();
  };

  const handleTaskUpdate = async (task: Task) => {
    if (!lawFirmId) return;
    try {
      // The panel's status toggle is the only caller, so only the status is
      // sent. The rest of `task` is the calendar's cached copy, and resending
      // it would undo any newer change on the server (a due date moved in
      // Google, an assignee changed elsewhere).
      await TasksService.updateTask({
        lawFirmId,
        taskId: task.taskId || task.id,
        status: task.status,
      });
      onTasksRefresh?.();
    } catch (error) {
      console.error("Error updating task:", error);
      throw error;
    }
  };

  const handleEventCreate = async (eventData: {
    title: string;
    date: string;
    eventType: string;
    notes?: string | null;
    location?: string | null;
    linkType: 'matter' | 'client';
    matterId?: string;
    clientId?: string;
    allDay?: boolean;
    endsAt?: string | null;
  }) => {
    if (!lawFirmId) return;
    try {
      const payload = {
        type: eventData.eventType as import('@/types/matterEvent').MatterEventType,
        title: eventData.title,
        date: eventData.date,
        endsAt: eventData.endsAt ?? undefined,
        notes: eventData.notes || undefined,
        location: eventData.location || undefined,
        status: 'upcoming' as const,
        allDay: eventData.allDay === true,
      };

      if (eventData.linkType === 'matter' && eventData.matterId) {
        await matterEventsService.createEvent(lawFirmId, eventData.matterId, payload);
      } else if (eventData.linkType === 'client' && eventData.clientId) {
        await clientsService.createClientEvent(lawFirmId, eventData.clientId, payload);
      }

      await refreshEvents();
    } catch (error) {
      console.error("Error creating event:", error);
      throw error;
    }
  };

  /* ─── New navigation helpers ─── */

  const goToPrev = () => {
    if (viewMode === 'month') goToPrevMonth();
    else if (viewMode === 'week') setCurrentDate(prev => prev.subtract(1, 'week'));
    else setCurrentDate(prev => prev.subtract(1, 'day'));
  };

  const goToNext = () => {
    if (viewMode === 'month') goToNextMonth();
    else if (viewMode === 'week') setCurrentDate(prev => prev.add(1, 'week'));
    else setCurrentDate(prev => prev.add(1, 'day'));
  };

  const goToToday = () => setCurrentDate(dayjs());

  const openPanelForTimeSlot = (day: dayjs.Dayjs, hour: number) => {
    const dateWithTime = day.hour(hour).minute(0).second(0);
    setSelectedDate(dateWithTime);
    setExpandedKey(null);
    setSelectedBlockKey(null);
    setHighlightedKeys([]);
    setSelectedSlotKey(`${day.format('YYYY-MM-DD')}|${hour}`);
    setNewTaskDueDate(dateWithTime.format("YYYY-MM-DDTHH:mm"));
    setPanelOpen(true);
  };

  // Selecting the all-day row of a day highlights it (like an hour slot) using a
  // dedicated `<date>|allday` slot key.
  const openPanelForAllDay = (day: dayjs.Dayjs) => {
    setSelectedDate(day);
    setExpandedKey(null);
    setSelectedBlockKey(null);
    setHighlightedKeys([]);
    setSelectedSlotKey(`${day.format('YYYY-MM-DD')}|allday`);
    setNewTaskDueDate(getDefaultDateTimeLocalValue(day.toDate()));
    setPanelOpen(true);
  };

  // Selecting an existing timed task/event block. Highlights the block and seeds
  // the create forms' default time with that item's time, so "New Task"/"New
  // Event" start at the selected item's hour rather than midday.
  const openPanelForBlock = (day: dayjs.Dayjs, blockKey: string, when: string, showPanel = true) => {
    setSelectedDate(day);
    setExpandedKey(null);
    setSelectedSlotKey(null);
    setSelectedBlockKey(blockKey);
    setHighlightedKeys([]);
    setNewTaskDueDate(when || getDefaultDateTimeLocalValue(day.toDate()));
    if (showPanel) setPanelOpen(true);
  };

  /* ─── New computed values ─── */

  const weekDays = useMemo(() => {
    const startOfWeek = currentDate.startOf('week');
    return Array.from({ length: 7 }, (_, i) => startOfWeek.add(i, 'day'));
  }, [currentDate]);

  const miniCalDays = useMemo(() => getMonthDays(currentDate.year(), currentDate.month()), [currentDate]);

  const upcomingTask = nextUpTask;

  // The days currently on screen, as inclusive 'YYYY-MM-DD' bounds: a whole
  // calendar month in month view, the anchor's week in week view, one day in day
  // view. Always inside the loaded window, which is padded a month either side.
  const visibleRange = useMemo(() => {
    const unit = viewMode === 'month' ? 'month' : viewMode === 'week' ? 'week' : 'day';
    return {
      from: currentDate.startOf(unit).format('YYYY-MM-DD'),
      to: currentDate.endOf(unit).format('YYYY-MM-DD'),
    };
  }, [currentDate, viewMode]);

  // Status breakdown of the tasks due in the period on screen, so the bars answer
  // "what is this month's work like" and move as the user navigates. Counted off
  // the same buckets the grid draws from, so the numbers can never disagree with
  // the days below them. `categoryTotal` is the denominator for the bars.
  const { categoryCounts, categoryTotal } = useMemo(() => {
    const counts: Record<string, number> = { open: 0, in_progress: 0, completed: 0, blocked: 0 };
    let total = 0;
    const counted = new Set<string>();
    // Day keys are 'YYYY-MM-DD', so a lexical comparison is a chronological one.
    for (const [date, dayTasks] of tasksByDate) {
      if (date < visibleRange.from || date > visibleRange.to) continue;
      for (const task of dayTasks) {
        if (counted.has(task.id)) continue;
        counted.add(task.id);
        if (task.status in counts) counts[task.status] += 1;
        total += 1;
      }
    }
    return { categoryCounts: counts, categoryTotal: total };
  }, [tasksByDate, visibleRange]);

  // Overlap layout for the time grid. Tasks AND matter events are packed in a
  // single pass so overlapping items sit side-by-side instead of stacking on
  // top of one another. Stacked translucent blocks compounded their fills into
  // a muddy "darker purple" and made overlapping times unreadable.
  const getBlockLayout = useCallback((blocks: TimeGridBlock[], opts: { collapse?: boolean; maxCols?: number } = {}): LayoutItem[] => {
    const { collapse = false, maxCols } = opts;
    const sorted = [...blocks].sort((a, b) => a.top - b.top);

    const groups: TimeGridBlock[][] = [];
    let current: TimeGridBlock[] = [];
    let groupBottom = -Infinity;
    sorted.forEach(item => {
      // Group whenever the next block starts before the current cluster ends
      // (each block is BLOCK_HEIGHT tall), so chains of overlaps pack together.
      if (current.length === 0 || item.top < groupBottom) {
        current.push(item);
        groupBottom = Math.max(groupBottom, item.top + BLOCK_HEIGHT);
      } else {
        groups.push(current);
        current = [item];
        groupBottom = item.top + BLOCK_HEIGHT;
      }
    });
    if (current.length > 0) groups.push(current);

    // Collapsed (phone) mode: too little column width to pack overlaps, so show
    // only the earliest block of each cluster at full width and surface the rest
    // as a "+N" corner badge that opens the day panel.
    if (collapse) {
      return groups.flatMap(group => {
        const items: LayoutItem[] = [
          { kind: 'block', block: group[0], left: '0%', width: '100%' },
        ];
        if (group.length > 1) {
          const hidden = group.slice(1);
          items.push({ kind: 'overflow', top: group[0].top, count: hidden.length, keys: hidden.map(blockKeyOf) });
        }
        return items;
      });
    }

    return groups.flatMap(group => {
      // Cap side-by-side columns (wide week view): pack up to maxCols and, when a
      // cluster exceeds it, keep the first maxCols-1 legible and replace the tail
      // with a "+N" column so blocks never shrink into unreadable slivers.
      if (maxCols && group.length > maxCols) {
        const visibleCount = maxCols - 1;
        const items: LayoutItem[] = group.slice(0, visibleCount).map((item, idx): LayoutItem => ({
          kind: 'block',
          block: item,
          left: `${(idx / maxCols) * 100}%`,
          width: `${(1 / maxCols) * 100}%`,
        }));
        const hidden = group.slice(visibleCount);
        items.push({
          kind: 'overflow',
          top: Math.min(...hidden.map(h => h.top)),
          count: hidden.length,
          keys: hidden.map(blockKeyOf),
          left: `${(visibleCount / maxCols) * 100}%`,
          width: `${(1 / maxCols) * 100}%`,
        });
        return items;
      }

      return group.map((item, idx): LayoutItem => ({
        kind: 'block',
        block: item,
        left: `${(idx / group.length) * 100}%`,
        width: `${(1 / group.length) * 100}%`,
      }));
    });
  }, []);

  // Title for center header
  const headerTitle = useMemo(() => {
    if (viewMode === 'day') return currentDate.format('MMMM D, YYYY');
    if (viewMode === 'week') {
      const start = weekDays[0];
      const end = weekDays[6];
      if (start.month() === end.month()) return `${start.format('MMM D')} \u2013 ${end.format('D, YYYY')}`;
      if (start.year() === end.year()) return `${start.format('MMM D')} \u2013 ${end.format('MMM D, YYYY')}`;
      return `${start.format('MMM D, YYYY')} \u2013 ${end.format('MMM D, YYYY')}`;
    }
    return currentDate.format('MMMM YYYY');
  }, [viewMode, currentDate, weekDays]);

  const closePanel = () => {
    setPanelOpen(false);
    setExpandedKey(null);
    setFormOpen(false);
    setSelectedBlockKey(null);
    setSelectedSlotKey(null);
  };

  /* ─── Render helpers ─── */

  const renderTimeGridBlocks = (day: dayjs.Dayjs, dayIdx: number) => {
    const taskBlocks: TimeGridBlock[] = findTasksForDay(day)
      .map((t): TimeGridBlock | null => {
        const minutes = taskMinuteOfDay(t);
        if (minutes === null) return null;
        return { kind: 'task', top: minutes, task: t };
      })
      .filter((x): x is TimeGridBlock => x !== null);

    const eventBlocks: TimeGridBlock[] = findEventsForDay(day)
      .filter(e => !e.allDay && e.start)
      .map((e): TimeGridBlock => ({ kind: 'event', top: eventMinuteOfDay(e, day.format('YYYY-MM-DD')) as number, event: e }));

    // Phone-width week view collapses each overlap cluster to one legible block
    // plus a "+N" corner badge. Wide week view keeps side-by-side packing but
    // caps the columns, spilling the tail into a "+N" column. Day view (full
    // width) always packs everything.
    const layoutOpts = viewMode === 'week'
      ? (isNarrow ? { collapse: true } : { maxCols: WEEK_MAX_COLS })
      : {};
    const layout = getBlockLayout([...taskBlocks, ...eventBlocks], layoutOpts);

    return layout.map((item, idx) => {
      if (item.kind === 'overflow') {
        // Wide-view overflow occupies its own column (left/width set); phone
        // overflow is a compact corner badge over the single visible block.
        if (item.left && item.width) {
          return (
            <button
              key={`overflow-${dayIdx}-${item.top}`}
              type="button"
              className="absolute z-10 flex items-center justify-center rounded-lg bg-surface-hover border border-outline-subtle text-[11px] font-semibold text-on-surface-secondary pointer-events-auto cursor-pointer hover:bg-surface-alt transition-colors"
              style={{ top: `${item.top}px`, left: item.left, width: item.width, height: `${BLOCK_HEIGHT}px`, minHeight: '28px' }}
              onClick={(e) => { e.stopPropagation(); openPanelForDay(day); setSelectedBlockKey(null); setHighlightedKeys(item.keys); }}
              aria-label={`Highlight ${item.count} more item${item.count === 1 ? '' : 's'} in the day panel`}
            >
              +{item.count}
            </button>
          );
        }
        return (
          <button
            key={`overflow-${dayIdx}-${item.top}`}
            type="button"
            className="absolute right-1 z-10 rounded-full bg-surface/95 border border-outline-subtle shadow-sm px-1.5 py-0.5 text-[10px] font-semibold text-on-surface-secondary leading-none pointer-events-auto cursor-pointer hover:bg-surface-hover"
            style={{ top: `${item.top + 2}px` }}
            onClick={(e) => { e.stopPropagation(); openPanelForDay(day); setSelectedBlockKey(null); setHighlightedKeys(item.keys); }}
            aria-label={`Highlight ${item.count} more event${item.count === 1 ? '' : 's'} in the day panel`}
          >
            +{item.count}
          </button>
        );
      }
      const { block, left, width } = item;
      if (block.kind === 'task') {
        const task = block.task;
        const colors = getTaskColor(task);
        const assigneeIds = Array.isArray(task.assignedTo) ? task.assignedTo : (task.assignedTo ? [task.assignedTo] : []);
        const assigneeName = assigneeIds.map(id => lawFirmUsers.find(u => u.uid === id)?.name).filter(Boolean).join(', ');
        const blockKey = `task-${task.taskId || task.id}`;
        const isSelected = selectedBlockKey === blockKey;
        return (
          <Tooltip
            key={`event-${getTaskKey(task, idx)}-${dayIdx}`}
            title={task.clientNames?.length ? `${task.title}: ${task.clientNames.join(', ')}` : task.title}
            enterDelay={300}
          >
          <div
            role="button"
            tabIndex={0}
            className={`absolute pointer-events-auto cursor-pointer touch-manipulation rounded-lg border-l-[3px] ${colors.border} ${colors.bg} px-2 py-1 overflow-hidden transition-shadow hover:shadow-lg hover:z-10 ${isSelected ? `ring-2 ring-offset-1 ring-offset-surface ${colors.ring} shadow-lg z-10` : ''}`}
            style={{ top: `${block.top}px`, left, width, height: `${BLOCK_HEIGHT}px`, minHeight: '28px' }}
            onClick={(e) => { e.stopPropagation(); openPanelForBlock(day, blockKey, dayjs(getTaskDateValue(task)).format('YYYY-MM-DDTHH:mm'), false); showPanelAfterGridClick(blockKey, { kind: 'task', task }, e.detail, e.clientX, e.clientY); }}
            onDoubleClick={(e) => { e.stopPropagation(); if (window.matchMedia('(min-width: 1280px)').matches) requestGridDetail({ kind: 'task', task }); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                openPanelForBlock(day, blockKey, dayjs(getTaskDateValue(task)).format('YYYY-MM-DDTHH:mm'));
              }
            }}
          >
            <p className={`text-[11px] font-medium ${colors.text} truncate leading-tight`}>{task.title}</p>
            <p className={`text-[10px] font-medium ${colors.text} opacity-90 truncate mt-0.5`}>
              {dayjs(getTaskDateValue(task)).format('h:mm A')}
            </p>
            {task.clientNames?.length ? (
              <p className={`text-[10px] ${colors.text} opacity-80 flex items-center gap-0.5 mt-0.5 overflow-hidden`}>
                <UserIcon size={9} className="shrink-0" />
                <span className="truncate">{task.clientNames.join(', ')}</span>
              </p>
            ) : assigneeName ? (
              <div className="mt-0.5 flex items-center">
                <div className="w-4 h-4 rounded-full bg-surface border border-outline-subtle flex items-center justify-center">
                  <span className="text-[7px] font-bold text-on-surface-secondary">{assigneeName.charAt(0).toUpperCase()}</span>
                </div>
              </div>
            ) : null}
          </div>
          </Tooltip>
        );
      }

      const ev = block.event;
      const blockKey = `event-${ev.id}`;
      const isSelected = selectedBlockKey === blockKey;
      return (
        <Tooltip key={`cev-${ev.id}-${dayIdx}`} title={ev.title} enterDelay={300}>
        <div
          role="button"
          tabIndex={0}
          className={`absolute pointer-events-auto cursor-pointer touch-manipulation rounded-lg border-l-[3px] border-l-violet-500 bg-violet-500/15 dark:bg-violet-500/20 px-2 py-1 overflow-hidden transition-shadow hover:shadow-lg hover:z-10 ${isSelected ? 'ring-2 ring-offset-1 ring-offset-surface ring-violet-500 shadow-lg z-10' : ''}`}
          style={{ top: `${block.top}px`, left, width, height: `${BLOCK_HEIGHT}px`, minHeight: '28px' }}
          onClick={(e) => { e.stopPropagation(); openPanelForBlock(day, blockKey, dayjs(ev.start).format('YYYY-MM-DDTHH:mm'), false); showPanelAfterGridClick(blockKey, { kind: 'event', event: ev }, e.detail, e.clientX, e.clientY); }}
          onDoubleClick={(e) => { e.stopPropagation(); if (window.matchMedia('(min-width: 1280px)').matches) requestGridDetail({ kind: 'event', event: ev }); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              openPanelForBlock(day, blockKey, dayjs(ev.start).format('YYYY-MM-DDTHH:mm'));
            }
          }}
        >
          <p className="text-[11px] font-medium truncate leading-tight text-violet-700 dark:text-violet-300">{ev.title}</p>
          <p className="text-[10px] font-medium text-violet-600 dark:text-violet-300 truncate mt-0.5">
            {eventTimeLabel(ev, day.format('YYYY-MM-DD'))}
          </p>
          {ev.clientNames?.length ? (
            <p className="text-[10px] text-violet-600 dark:text-violet-400 flex items-center gap-0.5 mt-0.5 overflow-hidden">
              <UserIcon size={9} className="shrink-0" />
              <span className="truncate">{ev.clientNames.join(', ')}</span>
            </p>
          ) : null}
        </div>
        </Tooltip>
      );
    });
  };

  const renderAllDayItems = (day: dayjs.Dayjs) => {
    const allDayTasks = findTasksForDay(day).filter(t => taskMinuteOfDay(t) === null);
    const payments = findPaymentDatesForDay(day);
    const allDayMatterEvents = findEventsForDay(day).filter(e => e.allDay);
    const getEventStyles = (selected: boolean) =>
      `${selected ? 'bg-violet-500/30 dark:bg-violet-500/40' : 'bg-violet-500/15 dark:bg-violet-500/20'} text-violet-700 dark:text-violet-300`;

    const bigChips: ReactNode[] = [
      ...allDayTasks.map((task, idx) => {
        const colors = getTaskColor(task);
        // Same key format the timed grid blocks use, so selecting an all-day chip
        // also highlights (and scrolls to) its card in the side panel.
        const blockKey = `task-${task.taskId || task.id}`;
        const isSelected = selectedBlockKey === blockKey;
        return (
          <Tooltip
            key={`allday-${getTaskKey(task, idx)}`}
            title={task.clientNames?.length ? `${task.title}: ${task.clientNames.join(', ')}` : task.title}
            enterDelay={300}
          >
          <div
            role="button"
            tabIndex={0}
            className={`basis-full min-w-0 text-[10px] px-1.5 py-0.5 rounded-md ${isSelected ? colors.selectedBg : colors.bg} ${colors.text} overflow-hidden cursor-pointer touch-manipulation flex items-center gap-1 ${isSelected ? `ring-2 ring-inset ${colors.ring} font-semibold` : 'font-medium'}`}
            onClick={(e) => { e.stopPropagation(); setSelectedBlockKey(blockKey); openPanelForDay(day, false); showPanelAfterGridClick(blockKey, { kind: 'task', task }, e.detail, e.clientX, e.clientY); }}
            onDoubleClick={(e) => { e.stopPropagation(); if (window.matchMedia('(min-width: 1280px)').matches) requestGridDetail({ kind: 'task', task }); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                setSelectedBlockKey(blockKey);
                openPanelForDay(day);
              }
            }}
          >
            {task.clientNames?.length ? <UserIcon size={9} className="shrink-0" /> : null}
            <span className="truncate min-w-0">{task.title}</span>
          </div>
          </Tooltip>
        );
      }),
      ...allDayMatterEvents.map(ev => {
        const blockKey = `event-${ev.id}`;
        const isSelected = selectedBlockKey === blockKey;
        return (
          <Tooltip
            key={`allday-ev-${ev.id}`}
            title={ev.clientNames?.length ? `${ev.title}: ${ev.clientNames.join(', ')}` : ev.title}
            enterDelay={300}
          >
          <div
            role="button"
            tabIndex={0}
            className={`basis-full min-w-0 text-[10px] px-1.5 py-0.5 rounded-md overflow-hidden cursor-pointer touch-manipulation flex items-center gap-1 ${getEventStyles(isSelected)} ${isSelected ? 'ring-2 ring-inset ring-violet-500 font-semibold' : 'font-medium'}`}
            onClick={(e) => { e.stopPropagation(); setSelectedBlockKey(blockKey); openPanelForDay(day, false); showPanelAfterGridClick(blockKey, { kind: 'event', event: ev }, e.detail, e.clientX, e.clientY); }}
            onDoubleClick={(e) => { e.stopPropagation(); if (window.matchMedia('(min-width: 1280px)').matches) requestGridDetail({ kind: 'event', event: ev }); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                setSelectedBlockKey(blockKey);
                openPanelForDay(day);
              }
            }}
          >
            {ev.clientNames?.length ? <UserIcon size={9} className="shrink-0" /> : null}
            <span className="truncate min-w-0">{ev.title}</span>
          </div>
          </Tooltip>
        );
      }),
    ];

    const payChips: ReactNode[] = payments.map(p => {
        // Matches the payment card's key in the side panel, so selecting an
        // all-day payment chip highlights (and scrolls to) that card.
        const blockKey = `payment-${p.id}`;
        const isSelected = selectedBlockKey === blockKey;
        const isReceived = p.billingItemType === 'payment_received';
        const amount = isReceived
          ? (p.paidAmount ?? 0)
          : (p.scheduledAmount ?? paymentDateRemaining(p));
        // Green = money received on this day, orange = money owed/upcoming.
        const styles = isReceived
          ? `${isSelected ? 'bg-emerald-500/30 dark:bg-emerald-500/40' : 'bg-emerald-500/15 dark:bg-emerald-500/20'} text-emerald-700 dark:text-emerald-300 ${isSelected ? 'ring-2 ring-inset ring-emerald-500 font-semibold' : ''}`
          : `${isSelected ? 'bg-orange-500/30 dark:bg-orange-500/40' : 'bg-orange-500/15 dark:bg-orange-500/20'} text-orange-700 dark:text-orange-300 ${isSelected ? 'ring-2 ring-inset ring-orange-500 font-semibold' : ''}`;
        return (
          <Tooltip
            key={`allday-pay-${p.id}`}
            title={paymentTooltipTitle(p)}
            enterDelay={300}
          >
          <div
            role="button"
            tabIndex={0}
            className={`text-[10px] px-1.5 py-0.5 rounded-md truncate cursor-pointer touch-manipulation ${isSelected ? '' : 'font-medium'} ${styles}`}
            onClick={(e) => { e.stopPropagation(); setSelectedBlockKey(blockKey); openPanelForDay(day, false); showPanelAfterGridClick(blockKey, { kind: 'payment', payment: p }, e.detail, e.clientX, e.clientY); }}
            onDoubleClick={(e) => { e.stopPropagation(); if (window.matchMedia('(min-width: 1280px)').matches) requestGridDetail({ kind: 'payment', payment: p }); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                setSelectedBlockKey(blockKey);
                openPanelForDay(day);
              }
            }}
          >
            {isReceived ? '+' : ''}${amount.toLocaleString()}
          </div>
          </Tooltip>
        );
    });

    // Week view caps the all-day row to ~2 lines (it never scrolls): one
    // full-width task/event row, OR a line of small payment pills, with the
    // remainder collapsed into a "+N" chip that opens the day panel. Payments
    // pack several per line, so they get a higher cap than the full-width rows.
    // A full-width row, when present, takes priority and the rest (extra rows +
    // all payments) fold into the "+N".
    if (viewMode === 'week') {
      const payCap = isNarrow ? ALL_DAY_PAY_CAP_NARROW : ALL_DAY_PAY_CAP_WIDE;
      let shown: ReactNode[];
      let hidden: number;
      if (bigChips.length > 0) {
        shown = bigChips.slice(0, ALL_DAY_BIG_CAP);
        hidden = (bigChips.length - shown.length) + payChips.length;
      } else {
        shown = payChips.slice(0, payCap);
        hidden = payChips.length - shown.length;
      }

      // Block keys for every all-day item on this day, so the "+N" chip can open
      // the day panel and highlight them all at once.
      const allDayKeys = [
        ...allDayTasks.map(t => `task-${t.taskId || t.id}`),
        ...allDayMatterEvents.map(e => `event-${e.id}`),
        ...payments.map(p => `payment-${p.id}`),
      ];

      return (
        <>
          {shown}
          {hidden > 0 && (
            <button
              key="allday-overflow"
              type="button"
              className="text-[10px] px-1.5 py-0.5 rounded-md bg-surface-hover border border-outline-subtle text-on-surface-secondary font-semibold truncate cursor-pointer hover:bg-surface-alt"
              onClick={(e) => {
                e.stopPropagation();
                openPanelForDay(day);
                setSelectedBlockKey(null);
                setHighlightedKeys(allDayKeys);
              }}
              aria-label={`Highlight ${hidden} more all-day item${hidden === 1 ? '' : 's'} in the day panel`}
            >
              +{hidden}
            </button>
          )}
        </>
      );
    }

    return <>{[...bigChips, ...payChips]}</>;
  };

  /* ═══════════════════════════════════════════════════════════
     JSX RETURN: 3-column layout
     ═══════════════════════════════════════════════════════════ */

  if (showSkeleton) return <CalendarSkeleton view={viewMode} />;

  return (
    <div className="flex h-full overflow-hidden bg-page" aria-busy={calendarFetching}>

      {/* ═══ LEFT SIDEBAR ═══ */}
      <aside className="hidden lg:flex lg:flex-col w-[272px] shrink-0 bg-surface border-r border-outline overflow-y-auto overflow-x-hidden styled-scrollbar">

        {/* Mini Month Calendar */}
        <div className="p-4 border-b border-outline-subtle">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-on-surface">{currentDate.format('MMMM YYYY')}</h4>
            <div className="flex gap-0.5">
              <button onClick={goToPrevMonth} aria-label="Previous month" className="p-1 rounded-md hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer text-on-surface-muted hover:text-on-surface">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              </button>
              <button onClick={goToNextMonth} aria-label="Next month" className="p-1 rounded-md hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer text-on-surface-muted hover:text-on-surface">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
              </button>
            </div>
          </div>
          {/* The mini calendar's dots come from the same window, so it fades with
              the grid. It keeps taking clicks: jumping again is the one thing
              still worth doing while a range loads. */}
          <div className={`grid grid-cols-7 gap-0 ${rangeUnloaded ? "opacity-40" : ""} transition-opacity duration-200`}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <div key={`mini-h-${i}`} className="text-[10px] font-semibold text-on-surface-muted text-center py-1 uppercase">{d}</div>
            ))}
            {miniCalDays.map((day, i) => {
              if (!day) return <div key={`mini-e-${i}`} className="w-8 h-8" />;
              const isToday = day.isSame(dayjs(), 'day');
              const isSelected = !!selectedDate && selectedDate.isSame(day, 'day');
              const isTodayGlow = isToday && !isSelected;
              const isInCurrentWeek = viewMode === 'week' && weekDays.some(wd => wd.isSame(day, 'day'));
              const hasEvents = findTasksForDay(day).length > 0 || findPaymentDatesForDay(day).length > 0 || findEventsForDay(day).length > 0;
              return (
                <button
                  key={`mini-d-${day.valueOf()}`}
                  onClick={() => {
                    setCurrentDate(day);
                    openPanelForDay(day);
                  }}
                  className={`w-8 h-8 flex items-center justify-center text-xs rounded-full transition-all cursor-pointer relative
                    ${isSelected ? 'bg-accent-solid text-accent-foreground font-bold shadow-sm' : ''}
                    ${isTodayGlow ? 'bg-accent-soft dark:bg-accent-soft text-accent-emphasis dark:text-accent-emphasis font-semibold' : ''}
                    ${isInCurrentWeek && !isSelected && !isTodayGlow ? 'bg-blue-50/80 dark:bg-white/5' : ''}
                    ${!isSelected && !isTodayGlow && !isInCurrentWeek ? 'hover:bg-surface-hover text-on-surface' : ''}
                  `}
                >
                  {day.date()}
                  {hasEvents && !isToday && (
                    <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-blue-500 dark:bg-blue-400" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Upcoming Task */}
        {upcomingTask && (
          <div className="p-4 border-b border-outline-subtle">
            <SectionLabel as="h4" gap="2">Next Up</SectionLabel>
            <div className="bg-surface-alt rounded-xl p-3 border border-outline-subtle">
              <p className="text-[11px] text-on-surface-secondary font-medium">
                {dayjs(getTaskDateValue(upcomingTask)).format('ddd, MMM D \u00B7 h:mm A')}
              </p>
              <p className="text-sm font-semibold text-on-surface mt-1 truncate">{upcomingTask.title}</p>
              {upcomingTask.matterName && (
                <p className="text-[11px] text-on-surface-muted mt-0.5 truncate">{upcomingTask.matterName}</p>
              )}
              <div className="flex gap-2 mt-2.5">
                <button
                  className="text-[11px] px-2.5 py-1 rounded-lg bg-blue-50 dark:bg-blue-900/25 text-accent-emphasis hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer font-medium"
                  onClick={() => {
                    const taskDateValue = getTaskDateValue(upcomingTask);
                    if (taskDateValue) openPanelForDay(dayjs(taskDateValue));
                  }}
                >
                  Details
                </button>
              </div>
            </div>
          </div>
        )}

        {calendarSyncEnabled && (
          <div className="p-4 border-b border-outline-subtle relative">
            <SectionLabel as="h4" gap="3">Connected Calendars</SectionLabel>
            <ActionIconButton label="Calendar settings" size="sm" className="absolute top-3 right-3" onClick={() => setCalendarSettingsOpen(true)}>
              <Settings2 size={16} />
            </ActionIconButton>
            <div className="space-y-2.5">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <svg className="w-4 h-4" viewBox="0 0 24 24">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    <span className="text-sm text-on-surface font-medium">Google</span>
                  </div>
                  {googleConnected ? (
                    <span className={`text-[11px] font-medium ${simulatedGoogle ? 'text-on-surface-muted' : syncingGoogle ? 'text-yellow-600 dark:text-yellow-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                      {simulatedGoogle ? 'Simulated' : syncingGoogle ? 'Syncing...' : 'Connected'}
                    </span>
                  ) : (
                    <Tooltip title="Go to Settings to connect Google Calendar" enterDelay={300}>
                      <button
                        type="button"
                        onClick={goToCalendarSettings}
                        className="text-[11px] text-on-surface-muted hover:text-on-surface hover:underline transition-colors cursor-pointer"
                      >
                        Not connected
                      </button>
                    </Tooltip>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <svg className="w-4 h-4" viewBox="0 0 24 24">
                    <path d="M11.5 2L2 7.5V22h9.5V2z" fill="#0078D4"/>
                    <path d="M11.5 2L22 7.5V22h-10.5V2z" fill="#00BCF2"/>
                    <path d="M2 7.5h9.5V15H2z" fill="#00BCF2" opacity=".6"/>
                    <path d="M11.5 7.5H22V15h-10.5z" fill="#0078D4" opacity=".6"/>
                  </svg>
                  <span className="text-sm text-on-surface font-medium">Outlook</span>
                </div>
                <div className="flex items-center gap-1">
                  {outlookConnected ? (
                    <span className={`text-[11px] font-medium ${simulatedOutlook ? 'text-on-surface-muted' : syncingOutlook ? 'text-yellow-600 dark:text-yellow-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                      {simulatedOutlook ? 'Simulated' : syncingOutlook ? 'Syncing...' : 'Connected'}
                    </span>
                  ) : (
                    <Tooltip title="Go to Settings to connect Outlook Calendar" enterDelay={300}>
                      <button
                        type="button"
                        onClick={goToCalendarSettings}
                        className="text-[11px] text-on-surface-muted hover:text-on-surface hover:underline transition-colors cursor-pointer"
                      >
                        Not connected
                      </button>
                    </Tooltip>
                  )}
                  {outlookSyncError && syncFlags?.loggedInWithMicrosoft && (
                    <button
                      onClick={async () => {
                        try {
                          await AuthService.connectMicrosoftCalendar(window.location.href);
                        } catch (e) {
                          console.error('Microsoft re-auth failed:', e);
                        }
                      }}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 hover:bg-orange-200 dark:hover:bg-orange-900/50 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                    >
                      Reconnect
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Categories */}
        <div className="p-4">
          <SectionLabel as="h4" gap="3">Categories</SectionLabel>
          <div className="space-y-2.5">
            {[
              { label: 'Open', count: categoryCounts.open, color: 'bg-blue-500' },
              { label: 'In Progress', count: categoryCounts.in_progress, color: 'bg-amber-500' },
              { label: 'Completed', count: categoryCounts.completed, color: 'bg-emerald-500' },
            ].map(cat => {
              const total = Math.max(categoryTotal, 1);
              const pct = (cat.count / total) * 100;
              return (
                <div key={cat.label}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${cat.color}`} />
                      <span className="text-xs text-on-surface-secondary">{cat.label}</span>
                    </div>
                    <span className="text-xs text-on-surface-muted tabular-nums">{cat.count}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-surface-hover overflow-hidden">
                    {cat.count > 0 && (
                      <div className={`h-full rounded-full ${cat.color} transition-all`} style={{ width: `${pct}%` }} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </aside>

      {/* ═══ CENTER COLUMN ═══ */}
      <div className="flex-1 min-w-0 flex flex-col">

        {/* Header Bar */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between px-4 py-3 md:py-3 border-b border-outline bg-surface shrink-0">
          {/* Title - full width on mobile so it doesn't fight for space */}
          <div className="flex items-center gap-2 min-w-0 order-1 md:order-none">
            <h2 className="text-lg font-semibold text-on-surface min-w-0 truncate">{headerTitle}</h2>
          </div>

          {/* View Toggle + Navigation - wrap on mobile */}
          <div className="flex flex-wrap items-center justify-between gap-2 order-2 md:order-none md:flex-nowrap md:justify-end">
            <div
              ref={viewModeToggle.containerRef}
              className="relative flex items-center gap-0.5 bg-surface-alt rounded-lg p-0.5 border border-outline-subtle shrink-0"
            >
              {viewModeToggle.rect && (
                <span
                  aria-hidden
                  className="absolute inset-y-0.5 left-0 rounded-md bg-surface shadow-sm transition-[transform,width] duration-200 ease-out motion-reduce:transition-none"
                  style={{
                    width: viewModeToggle.rect.width,
                    transform: `translateX(${viewModeToggle.rect.left}px)`,
                  }}
                />
              )}
              {(['month', 'week', 'day'] as const).map(mode => (
                <button
                  key={mode}
                  ref={viewModeToggle.registerItem(mode)}
                  onClick={() => { setViewMode(mode); saveCalendarView(mode); }}
                  className={`relative z-10 px-3 py-2 md:py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer touch-manipulation ${
                    viewMode === mode
                      ? 'text-on-surface'
                      : 'text-on-surface-secondary hover:text-on-surface'
                  }`}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>

            {/* Navigation */}
            <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={goToPrev} className="p-2 md:p-1.5 rounded-lg hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer text-on-surface-muted hover:text-on-surface touch-manipulation" aria-label="Previous">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </button>
            <button onClick={goToToday} className="px-3 py-2 md:py-1.5 text-xs font-medium rounded-lg bg-surface-alt hover:bg-surface-hover border border-outline-subtle transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer text-on-surface touch-manipulation">
              Today
            </button>
            <button onClick={goToNext} className="p-2 md:p-1.5 rounded-lg hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer text-on-surface-muted hover:text-on-surface touch-manipulation" aria-label="Next">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </button>
            {/* Add event button (mobile) */}
            <Tooltip title="Add event" enterDelay={300}>
              <button
                onClick={() => {
                  const now = dayjs();
                  openPanelForTimeSlot(now, now.hour());
                }}
                className="p-2 md:p-1.5 rounded-lg bg-accent-solid hover:bg-accent-solid-hover text-accent-foreground transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer xl:hidden touch-manipulation"
                aria-label="Add event"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              </button>
            </Tooltip>
          </div>
          </div>
        </div>

        <CalendarLoadingBar active={calendarFetching} rangeLabel={currentDate.format('MMMM YYYY')} />

        {calendarError && (
          <div className="px-4 pt-3 shrink-0">
            {/* No onClose: the banner reflects live query state, so a dismiss
                control would be a dead affordance. It clears when a read succeeds. */}
            <ErrorNotification error={calendarError} onRetry={() => void retryLoad()} compact />
          </div>
        )}

        {/* ─── WEEK VIEW ─── */}
        {viewMode === 'week' && (
          <div className={`flex-1 flex flex-col overflow-hidden ${gridLoadingClass}`}>
            {/* Day column headers, fixed, never scrolls */}
            <div className="flex border-b border-outline shrink-0 bg-surface" style={{ paddingRight: scrollbarWidth }}>
              <div className="w-14 shrink-0" />
              {weekDays.map((day, i) => {
                const isToday = day.isSame(dayjs(), 'day');
                const isSelected = !!selectedDate && selectedDate.isSame(day, 'day');
                const isTodayGlow = isToday && !isSelected;
                return (
                  <button
                    type="button"
                    onClick={() => openPanelForAllDay(day)}
                    key={`wh-${i}`}
                    className={`flex-1 text-center py-2.5 border-l transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-accent-solid dark:bg-accent-soft border-accent-border-soft dark:border-accent-border-soft/40'
                        : isTodayGlow
                        ? 'border-outline-subtle hover:bg-surface-hover'
                        : 'border-outline-subtle hover:bg-surface-hover'
                    }`}
                  >
                    <div className={`text-[10px] font-semibold uppercase tracking-widest ${isSelected ? 'text-accent-foreground dark:text-accent-emphasis' : isTodayGlow ? 'text-accent-emphasis' : 'text-on-surface-muted'}`}>
                      {day.format('ddd')}
                    </div>
                    <div className={`text-xl mt-0.5 ${isSelected ? 'text-accent-foreground dark:text-accent-emphasis font-semibold' : isTodayGlow ? 'text-accent-emphasis font-semibold' : 'text-on-surface font-light'}`}>
                      {day.date()}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* All-day row, fixed, never scrolls */}
            <div className="flex border-b border-outline shrink-0 bg-surface min-h-[28px]" style={{ paddingRight: scrollbarWidth }}>
              <div className="w-14 shrink-0 text-[9px] font-semibold text-on-surface-muted text-right pr-2 pt-1.5 uppercase tracking-wider">all day</div>
              {weekDays.map((day, i) => {
                const isAllDaySelected = selectedSlotKey === `${day.format('YYYY-MM-DD')}|allday`;
                return (
                  <div
                    key={`ad-${i}`}
                    className={`flex-1 border-l border-outline p-1 flex flex-wrap content-start items-start gap-0.5 overflow-hidden max-h-[56px] cursor-pointer transition-colors ${isAllDaySelected ? 'bg-accent-soft dark:bg-accent-soft ring-2 ring-inset ring-focus-ring/60' : 'hover:bg-surface-hover/30'}`}
                    onClick={() => openPanelForAllDay(day)}
                  >
                    {renderAllDayItems(day)}
                  </div>
                );
              })}
            </div>

            {/* Scrollable time grid only */}
            <div className="flex-1 overflow-y-scroll styled-scrollbar" ref={timeGridRef}>
              {/* Time grid */}
              <div className="relative" style={{ height: `${24 * 60}px` }}>
                {/* Hour lines */}
                {HOURS.map(hour => (
                  <div key={`hl-${hour}`} className="absolute left-0 right-0 flex" style={{ top: `${hour * 60}px`, height: '60px' }}>
                    <div className="w-14 shrink-0 text-[10px] font-medium text-on-surface-muted text-right pr-2 -translate-y-[7px] select-none">
                      {hour > 0 ? formatHour(hour) : ''}
                    </div>
                    <div className="flex-1 border-t border-outline" />
                  </div>
                ))}

                {/* Day columns (clickable areas) */}
                <div className="absolute inset-0 flex">
                  <div className="w-14 shrink-0" />
                  {weekDays.map((day, i) => {
                    const isToday = day.isSame(dayjs(), 'day');
                    const dayKey = day.format('YYYY-MM-DD');
                    return (
                      <div
                        key={`col-${i}`}
                        className={`flex-1 border-l border-outline relative ${isToday ? 'bg-blue-50/60 dark:bg-white/[0.015]' : ''}`}
                      >
                        {/* Clickable hour cells */}
                        {HOURS.map(hour => {
                          const isSlotSelected = selectedSlotKey === `${dayKey}|${hour}`;
                          return (
                            <div
                              key={`cell-${i}-${hour}`}
                              className={`absolute left-0 right-0 transition-colors cursor-pointer ${isSlotSelected ? 'bg-accent-soft dark:bg-accent-soft ring-2 ring-inset ring-focus-ring/60' : 'hover:bg-surface-hover/40'}`}
                              style={{ top: `${hour * 60}px`, height: '60px' }}
                              onClick={() => openPanelForTimeSlot(day, hour)}
                            />
                          );
                        })}
                        {/* Tasks + matter events, packed side-by-side */}
                        {renderTimeGridBlocks(day, i)}
                      </div>
                    );
                  })}
                </div>

                {/* Current time indicator */}
                {weekDays.some(d => d.isSame(dayjs(), 'day')) && (
                  <div
                    className="absolute left-14 right-0 flex items-center z-20 pointer-events-none"
                    style={{ top: `${currentTimePosition}px` }}
                  >
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500 -ml-[5px] shadow-sm" />
                    <div className="flex-1 h-[2px] bg-red-500/60" />
                  </div>
                )}
              </div>
            </div>{/* end scroll container */}

            {/* No events message */}
            {calendarTasks.length === 0 && paymentDates.length === 0 && allCalendarEvents.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-center p-6 bg-surface/80 backdrop-blur-sm rounded-2xl border border-outline-subtle">
                  <svg className="w-10 h-10 mx-auto mb-2 text-on-surface-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <p className="text-sm font-medium text-on-surface">No events this week</p>
                  <p className="text-xs text-on-surface-muted mt-1">Click a time slot to create a task</p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── MONTH VIEW ─── */}
        {viewMode === 'month' && (
          <div className={`flex-1 overflow-hidden sm:overflow-y-auto sm:styled-scrollbar flex flex-col sm:block p-0 sm:p-4 ${gridLoadingClass}`}>
            {/* Weekday headers */}
            <div className="grid grid-cols-7 gap-0 sm:gap-1.5 mb-0 sm:mb-2 shrink-0 border-b border-outline-subtle sm:border-0">
              {weekdays.map((d) => (
                <div key={`wd-${d}`} className="text-center py-2 sm:py-0">
                  <div className="text-[11px] font-semibold text-on-surface-muted uppercase tracking-wide sm:tracking-widest sm:py-1.5">
                    <span className="sm:hidden">{d[0]}</span>
                    <span className="hidden sm:inline">{d}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Calendar grid */}
            <div className="flex-1 sm:flex-none min-h-0 grid grid-cols-7 gap-0 sm:gap-1.5 [grid-auto-rows:minmax(52px,1fr)] sm:[grid-auto-rows:120px]">
              {days.map((day, index) => {
                if (!day) {
                  return <div key={`empty-${index}`} className="border-b border-outline-subtle/20 sm:border-0 sm:h-full sm:rounded-xl sm:bg-surface-alt/30" />;
                }
                const tasksForDay = findTasksForDay(day);
                const eventsForDay = findEventsForDay(day);
                const paymentsForDay = findPaymentDatesForDay(day);
                const isToday = day.isSame(dayjs(), "day");
                const isSelected = !!selectedDate && selectedDate.isSame(day, "day");
                const isTodayGlow = isToday && !isSelected;
                const isCurrentMonth = day.month() === currentDate.month();
                const totalCount = tasksForDay.length + eventsForDay.length + paymentsForDay.length;

                return (
                  <button
                    type="button"
                    onClick={() => openPanelForDay(day)}
                    key={`day-${day.valueOf()}`}
                    className={`h-full text-left focus:outline-none cursor-pointer border-b border-outline-subtle/20 transition-transform duration-100 active:scale-[0.94]
                      sm:active:scale-100 sm:rounded-xl sm:border sm:focus-visible:ring-2 sm:focus-visible:ring-focus-ring/50 sm:focus-visible:ring-offset-1 sm:focus-visible:ring-offset-surface sm:transition-all sm:duration-150 ${
                      isSelected
                        ? "sm:bg-accent-solid sm:text-accent-foreground sm:border-accent-border-soft sm:shadow-md dark:sm:bg-accent-solid/90"
                        : isTodayGlow
                        ? "sm:bg-surface sm:text-on-surface sm:border-accent-border-soft/70 sm:shadow-[0_0_12px_rgba(59,102,224,0.4)] sm:hover:bg-surface-hover"
                        : isCurrentMonth
                        ? "sm:bg-surface sm:border-outline-subtle sm:text-on-surface sm:hover:bg-surface-hover sm:hover:border-outline"
                        : "sm:bg-surface-alt/40 sm:text-on-surface-muted sm:border-transparent sm:hover:bg-surface-hover/50"
                    }`}
                    aria-label={`Open tasks for ${day.format("MMMM D, YYYY")}`}
                  >
                    {/* ── Mobile: Google Calendar style (number + bars) ── */}
                    <div className="sm:hidden h-full flex flex-col items-center pt-1.5 overflow-hidden">
                      <div className={`w-8 h-8 flex items-center justify-center rounded-full text-sm font-semibold ${
                        isSelected
                          ? 'bg-accent-solid text-accent-foreground'
                          : isTodayGlow
                          ? 'text-accent-emphasis ring-2 ring-focus-ring/40'
                          : isCurrentMonth
                          ? 'text-on-surface'
                          : 'text-on-surface-muted/40'
                      }`}>
                        {day.date()}
                      </div>
                      {totalCount > 0 && (
                        <div className="w-full px-1 mt-1 space-y-[3px] overflow-hidden">
                          {tasksForDay.slice(0, 2).map((task, idx) => (
                            <div key={`mb-bar-${getTaskKey(task, idx)}`} className={`h-[3px] w-full rounded-full ${getTaskColor(task).dot}`} />
                          ))}
                          {eventsForDay.slice(0, Math.max(0, 2 - tasksForDay.length)).map(ev => (
                            <div key={`me-bar-${ev.id}`} className="h-[3px] w-full rounded-full bg-violet-500" />
                          ))}
                          {paymentsForDay.slice(0, Math.max(0, 2 - tasksForDay.length - eventsForDay.length)).map(p => (
                            <div key={`mp-bar-${p.id}`} className={`h-[3px] w-full rounded-full ${p.billingItemType === 'payment_received' ? 'bg-emerald-500' : 'bg-orange-500'}`} />
                          ))}
                        </div>
                      )}
                    </div>

                    {/* ── Desktop: box style ── */}
                    <div className="hidden sm:flex h-full p-2.5 flex-col overflow-hidden">
                      <div className="flex items-center justify-between shrink-0 mb-1.5">
                        <span className={`text-sm font-semibold ${isSelected ? "text-accent-foreground" : isTodayGlow ? "text-accent-emphasis" : ""}`}>{day.date()}</span>
                        {totalCount > 0 && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                            isSelected ? "bg-accent-foreground/20 text-accent-foreground" : "bg-accent-soft text-accent-emphasis"
                          }`}>
                            {totalCount}
                          </span>
                        )}
                      </div>
                      {(() => {
                        const maxVisible = totalCount > 3 ? 2 : 3;
                        let shown = 0;
                        const items: React.ReactNode[] = [];
                        for (const task of tasksForDay) {
                          if (shown >= maxVisible) break;
                          const idx = shown;
                          items.push(
                            <Tooltip key={`mb-${getTaskKey(task, idx)}`} title={task.clientNames?.length ? `${task.title}: ${task.clientNames.join(', ')}` : task.title} enterDelay={300}>
                            <div className="text-[10px] flex items-center gap-1.5 overflow-hidden rounded px-1 py-0.5 shrink-0">
                              <div className={`w-1.5 h-1.5 rounded-full ${getTaskColor(task).dot} shrink-0`} />
                              <span className={`truncate ${isSelected ? 'text-white/90' : 'text-on-surface'}`}>{task.title}</span>
                              {task.clientNames?.length ? <UserIcon size={9} className={`shrink-0 ${isSelected ? 'text-white/70' : 'text-on-surface-muted'}`} /> : null}
                            </div>
                            </Tooltip>
                          );
                          shown++;
                        }
                        for (const ev of eventsForDay) {
                          if (shown >= maxVisible) break;
                          items.push(
                            <Tooltip key={`me-${ev.id}`} title={ev.clientNames?.length ? `${ev.title}: ${ev.clientNames.join(', ')}` : ev.title} enterDelay={300}>
                            <div className="text-[10px] flex items-center gap-1.5 overflow-hidden rounded px-1 py-0.5 shrink-0">
                              <div className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0" />
                              <span className={`truncate ${isSelected ? 'text-white/90' : 'text-on-surface'}`}>{ev.title}</span>
                              {ev.clientNames?.length ? <UserIcon size={9} className={`shrink-0 ${isSelected ? 'text-white/70' : 'text-violet-500'}`} /> : null}
                            </div>
                            </Tooltip>
                          );
                          shown++;
                        }
                        for (const p of paymentsForDay) {
                          if (shown >= maxVisible) break;
                          const received = p.billingItemType === 'payment_received';
                          items.push(
                            <Tooltip key={`mp-${p.id}`} title={paymentTooltipTitle(p)} enterDelay={300}>
                            <div className="text-[10px] flex items-center gap-1.5 overflow-hidden rounded px-1 py-0.5 shrink-0">
                              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${received ? 'bg-emerald-500' : 'bg-orange-500'}`} />
                              <span className={`truncate ${isSelected ? 'text-white/90' : 'text-on-surface'}`}>{paymentMonthCellLabel(p)}</span>
                            </div>
                            </Tooltip>
                          );
                          shown++;
                        }
                        return (
                          <div className="flex flex-col gap-0.5 flex-1 min-h-0 overflow-hidden">
                            {items}
                            {totalCount > 3 && (
                              <div className={`text-[10px] px-1 shrink-0 ${isSelected ? 'text-white/70' : 'text-on-surface-muted'}`}>+{totalCount - maxVisible} more</div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── DAY VIEW ─── */}
        {viewMode === 'day' && (
          <div className={`flex-1 flex flex-col overflow-hidden ${gridLoadingClass}`}>
            {/* Day header, fixed, never scrolls */}
            <div style={{ paddingRight: scrollbarWidth }} className={`text-center py-4 md:py-3 px-2 border-b shrink-0 ${currentDate.isSame(dayjs(), 'day') ? 'bg-accent-solid dark:bg-surface dark:border-accent-border-soft/40 border-accent-border-soft' : 'bg-surface border-outline'}`}>
              <div className={`text-[10px] font-semibold uppercase tracking-widest ${currentDate.isSame(dayjs(), 'day') ? 'text-accent-foreground dark:text-accent-emphasis' : 'text-on-surface-muted'}`}>
                {currentDate.format('dddd')}
              </div>
              <div className={`text-2xl mt-0.5 ${currentDate.isSame(dayjs(), 'day') ? 'text-accent-foreground dark:text-accent-emphasis font-semibold' : 'text-on-surface font-light'}`}>
                {currentDate.date()}
              </div>
            </div>

            {/* All-day row, fixed, never scrolls */}
            <div style={{ paddingRight: scrollbarWidth }} className={`flex border-b shrink-0 min-h-[32px] md:min-h-[28px] ${currentDate.isSame(dayjs(), 'day') ? 'bg-accent-solid dark:bg-surface dark:border-accent-border-soft/40 border-accent-border-soft' : 'bg-surface border-outline'}`}>
              <div className={`w-14 shrink-0 text-[9px] font-semibold text-right pr-2 pt-2 md:pt-1.5 uppercase tracking-wider ${currentDate.isSame(dayjs(), 'day') ? 'text-accent-foreground dark:text-accent-emphasis' : 'text-on-surface-muted'}`}>all day</div>
              <div
                className={`flex-1 border-l p-1 flex flex-wrap content-start items-start gap-0.5 overflow-hidden max-h-[56px] overflow-y-auto styled-scrollbar cursor-pointer transition-colors ${currentDate.isSame(dayjs(), 'day') ? 'border-accent-border-soft dark:border-accent-border-soft/40' : 'border-outline'} ${selectedSlotKey === `${currentDate.format('YYYY-MM-DD')}|allday` ? 'bg-accent-soft dark:bg-accent-soft ring-2 ring-inset ring-focus-ring/60' : (currentDate.isSame(dayjs(), 'day') ? 'hover:bg-accent-soft dark:hover:bg-accent-soft' : 'hover:bg-surface-hover/30')}`}
                onClick={() => openPanelForAllDay(currentDate)}
              >
                {renderAllDayItems(currentDate)}
              </div>
            </div>

            {/* Scrollable time grid only */}
            <div className="flex-1 overflow-y-scroll styled-scrollbar" ref={timeGridRef}>
              {/* Time grid */}
              <div className="relative" style={{ height: `${24 * 60}px` }}>
                {HOURS.map(hour => (
                  <div key={`dhl-${hour}`} className="absolute left-0 right-0 flex" style={{ top: `${hour * 60}px`, height: '60px' }}>
                    <div className="w-14 shrink-0 text-[10px] font-medium text-on-surface-muted text-right pr-2 -translate-y-[7px] select-none">
                      {hour > 0 ? formatHour(hour) : ''}
                    </div>
                    <div className="flex-1 border-t border-outline" />
                  </div>
                ))}

                <div className="absolute inset-0 flex">
                  <div className="w-14 shrink-0" />
                  <div className={`flex-1 border-l border-outline relative ${currentDate.isSame(dayjs(), 'day') ? 'bg-blue-50/60 dark:bg-white/[0.015]' : ''}`}>
                    {HOURS.map(hour => {
                      const isSlotSelected = selectedSlotKey === `${currentDate.format('YYYY-MM-DD')}|${hour}`;
                      return (
                        <div
                          key={`dcell-${hour}`}
                          className={`absolute left-0 right-0 transition-colors cursor-pointer ${isSlotSelected ? 'bg-accent-soft dark:bg-accent-soft ring-2 ring-inset ring-focus-ring/60' : 'hover:bg-surface-hover/40'}`}
                          style={{ top: `${hour * 60}px`, height: '60px' }}
                          onClick={() => openPanelForTimeSlot(currentDate, hour)}
                        />
                      );
                    })}
                    {renderTimeGridBlocks(currentDate, 0)}
                  </div>
                </div>

                {currentDate.isSame(dayjs(), 'day') && (
                  <div
                    className="absolute left-14 right-0 flex items-center z-20 pointer-events-none"
                    style={{ top: `${currentTimePosition}px` }}
                  >
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500 -ml-[5px] shadow-sm" />
                    <div className="flex-1 h-[2px] bg-red-500/60" />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ═══ RIGHT PANEL ═══ */}
      {/* Desktop: always-present side panel */}
      <aside className="hidden xl:flex xl:flex-col w-[348px] shrink-0 bg-surface border-l border-outline">
        <CalendarSidePanel
          panelOpen
          selectedDate={selectedDate ?? dayjs()}
          selectedDayTasks={selectedDayTasks}
          selectedDayEvents={selectedDayEvents}
          selectedDayPaymentDates={selectedDayPaymentDates}
          lawFirmId={lawFirmId || null}
          lawFirmUsers={lawFirmUsers}
          syncFlags={syncFlags}
          onClose={closePanel}
          onTasksRefresh={onTasksRefresh}
          onTaskUpdate={handleTaskUpdate}
          onTaskDelete={handleDeleteTask}
          onEventUpdate={handleEventUpdate}
          onEventDelete={handleEventDelete}
          onEventCreate={handleEventCreate}
          initialDueDate={newTaskDueDate}
          currentUserId={currentUser?.uid}
          selectedItemKey={selectedBlockKey}
          highlightedItemKeys={highlightedKeys}
          showClose={false}
          detailRequest={detailRequest?.target === 'desktop' ? detailRequest : null}
          updateCourtAddress={updateCourtAddress}
        />
      </aside>

      {/* Mobile: overlay side panel */}
      <div className="xl:hidden">
        <div
          className={`fixed inset-0 bg-black/40 backdrop-blur-sm z-40 transition-opacity duration-300 ease-in-out ${
            panelOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          onClickCapture={handleOverlaySecondClick}
          onClick={closePanel}
          aria-hidden="true"
        />
        <aside
          role="dialog"
          aria-modal={panelOpen}
          aria-labelledby="tasks-panel-title"
          onClickCapture={handleOverlaySecondClick}
          className={`fixed top-0 right-0 h-full w-full sm:w-[420px] bg-surface shadow-2xl z-50 border-l border-outline transition-transform duration-300 ease-in-out ${
            panelOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
        >
          {selectedDate && (
            <CalendarSidePanel
              panelOpen={panelOpen}
              selectedDate={selectedDate}
              selectedDayTasks={selectedDayTasks}
              selectedDayEvents={selectedDayEvents}
              selectedDayPaymentDates={selectedDayPaymentDates}
              lawFirmId={lawFirmId || null}
              lawFirmUsers={lawFirmUsers}
              syncFlags={syncFlags}
              onClose={closePanel}
              onTasksRefresh={onTasksRefresh}
              onTaskUpdate={handleTaskUpdate}
              onTaskDelete={handleDeleteTask}
              onEventUpdate={handleEventUpdate}
              onEventDelete={handleEventDelete}
              onEventCreate={handleEventCreate}
              initialDueDate={newTaskDueDate}
              currentUserId={currentUser?.uid}
              selectedItemKey={selectedBlockKey}
              highlightedItemKeys={highlightedKeys}
              detailRequest={detailRequest?.target === 'mobile' ? detailRequest : null}
              onDetailOpen={hideMobilePanelForDetail}
              onDetailClose={restoreMobilePanelAfterDetail}
            />
          )}
        </aside>
      </div>

      <Modal
        isOpen={calendarSettingsOpen}
        onClose={() => setCalendarSettingsOpen(false)}
        title="Calendar settings"
        size="md"
      >
        <div className="space-y-4">
          <ErrorNotification error={calendarSettingsError} />
          {devPreviewEnabled && (
            <div className="space-y-3 rounded-lg border border-outline-subtle bg-surface-alt p-4">
              <p className="text-sm font-medium text-on-surface">Development connection preview</p>
              <p className="text-xs text-on-surface-secondary">Preview connected calendar controls in this browser session. No account connection or sync runs.</p>
              {!syncFlags?.loggedInWithGoogle && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm text-on-surface">Simulate Google connection</span>
                  <ToggleSwitch checked={simulatedGoogle} onChange={() => updateDevPreview({ loggedInWithGoogle: !simulatedGoogle })} ariaLabel="Simulate Google connection" />
                </div>
              )}
              {!syncFlags?.loggedInWithMicrosoft && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm text-on-surface">Simulate Outlook connection</span>
                  <ToggleSwitch checked={simulatedOutlook} onChange={() => updateDevPreview({ loggedInWithMicrosoft: !simulatedOutlook })} ariaLabel="Simulate Outlook connection" />
                </div>
              )}
            </div>
          )}
          <Dropdown
            label="Google Calendar Sync"
            value={googleSyncDirection}
            onChange={direction => changeSyncDirection('google', direction)}
            options={[
              { value: 'none', label: 'None' },
              { value: 'paralegix-to-google', label: 'Send Events to Google' },
              { value: 'google-to-paralegix', label: 'Import Events from Google' },
              { value: 'both', label: 'Two-Way Sync' },
            ]}
            disabled={!googleConnected || calendarSyncLocked || syncDirectionSaving}
          />
          <Dropdown
            label="Outlook Calendar Sync"
            value={outlookSyncDirection}
            onChange={direction => changeSyncDirection('outlook', direction)}
            options={[
              { value: 'none', label: 'None' },
              { value: 'paralegix-to-outlook', label: 'Send Events to Outlook' },
              { value: 'outlook-to-paralegix', label: 'Import Events from Outlook' },
              { value: 'both', label: 'Two-Way Sync' },
            ]}
            disabled={!outlookConnected || calendarSyncLocked || syncDirectionSaving}
          />
          {calendarSyncLocked && <p className="text-xs text-on-surface-secondary">Calendar sync is managed by your firm administrator.</p>}
          <div className="pt-4 border-t border-outline-subtle">
            <Button type="secondary" onClick={goToCalendarSettings}>More calendar settings</Button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!showDeleteConfirm}
        onClose={closeDeleteConfirm}
        labelledBy={deleteTitleId}
        showClose={false}
        size="md"
        className="rounded-2xl p-6 shadow-2xl border border-outline"
        bodyClassName={null}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center">
            <svg className="w-6 h-6 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <div>
            <h3 id={deleteTitleId} className="text-lg font-semibold text-on-surface">Delete Task</h3>
            <p className="text-sm text-on-surface-secondary">This action cannot be undone</p>
          </div>
        </div>
        <p className="text-on-surface mb-6">
          Are you sure you want to delete this task? This will remove it from both Paralegix and any synced calendars.
        </p>
        <ErrorNotification error={deleteError} className="mb-4" />
        <div className="flex gap-3">
          <button
            onClick={() => showDeleteConfirm && handleDeleteTask(showDeleteConfirm)}
            disabled={deletingTask === showDeleteConfirm}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2.5 px-4 rounded-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            {deletingTask === showDeleteConfirm ? "Deleting..." : "Delete Task"}
          </button>
          <button
            onClick={() => setShowDeleteConfirm(null)}
            disabled={deletingTask === showDeleteConfirm}
            className="px-6 py-2.5 border border-outline text-on-surface rounded-lg hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </Modal>
    </div>
  );
}
