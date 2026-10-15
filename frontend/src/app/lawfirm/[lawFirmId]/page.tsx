"use client";

import Tooltip from "@/components/ui/Tooltip";
import { useEffect, useState, useMemo, useRef, useCallback, Fragment } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { useAuth } from "@/hooks/useAuth";
import { useNavigation } from "@/contexts/NavigationContext";
import { useLastOpenValue, useMountTransition } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";
import signaturesService from "@/services/signatures.service";
import { useDashboardSummary } from "@/hooks/dashboardHooks/useDashboardSummary";
import { useDashboardSearch } from "@/hooks/dashboardHooks/useDashboardSearch";
import { toLocalDate, formatAgendaWhen, formatRelativeDay } from "@/lib/utils/dateUtils";
import { formatHoursMinutes } from "@/lib/utils/format";
import { formatCents } from "@/lib/utils/currency";
import type {
  DashboardMyAssignments,
  DashboardRecentMatter,
  DashboardUpcomingTask,
  DashboardRecentConversation,
  DashboardPendingSignature,
  DashboardAgingInvoice,
  DashboardUpcomingPayment,
  DashboardUpcomingEvent,
  DashboardTodayTimeEntry,
} from "@/services/dashboard.service";
import LoadingSpinner from "@/components/LoadingSpinner";
import Spinner from "@/components/ui/Spinner";
import UpcomingPaymentModal from "@/components/dashboardComp/UpcomingPaymentModal";
import TaskDetailModal from "@/components/dashboardComp/TaskDetailModal";
import DashboardCalendarWidget from "@/components/dashboardComp/DashboardCalendarWidget";
import ErrorNotification from "@/components/ErrorNotification";
import RequirePermission from "@/components/ui/RequirePermission";
import { Avatar } from "@/components/ui/Avatar";
import RoleBadge from "@/components/ui/RoleBadge";
import ResourceNotFoundPage from "@/components/ui/ResourceNotFoundPage";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useLawFirm } from "@/contexts/LawFirmContext";
import { useFirmSigningRealtime } from "@/hooks/useSigningRealtime";
import type { LawFirm as LawFirmBase, User } from "@/types";
import type { LawFirm as LawFirmExtended } from "@/types/lawfirm";
import {
  Briefcase,
  ClipboardCheck,
  MessageSquare,
  Search,
  TrendingUp,
  AlertTriangle,
  ChevronRight,
  Users,
  Sun,
  Moon,
  Eye,
  EyeOff,
  GripVertical,
  Pencil,
  Check,
  PanelRightOpen,
  PanelLeft,
  PanelRight,
  Settings2,
  X,
  Hash,
  UserRound,
  PenLine,
  DollarSign,
  Clock,
  CalendarClock,
  Play,
  Pause,
  Square,
} from "lucide-react";
import { matterEventTypeMeta, matterStatusMeta, styleOf, taskPriorityMeta } from "@/constants/statusMeta";
import { usePreferences } from "@/contexts/PreferencesContext";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import { useBillingTimer } from "@/contexts/BillingTimerContext";
import type { DashboardWidgetKey, DashboardWidget, StatCardKey } from "@/types/preferences";
import { DASHBOARD_WIDGET_LABELS, STAT_CARD_LABELS, DEFAULT_STAT_CARDS } from "@/types/preferences";
import Card from "@/components/ui/Card";
import SectionLabel from "@/components/ui/SectionLabel";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  pointerWithin,
  rectIntersection,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";

// The grip's drag props (dnd-kit attributes + listeners), typed loosely so we
// don't depend on dnd-kit's deep internal type paths.
type DragHandle = {
  // dnd-kit's DraggableAttributes / listener map don't have index signatures, so
  // `any` keeps them spreadable without importing the internal types.
  attributes?: any;  
  listeners?: any;  
};

type LawFirm = LawFirmBase & LawFirmExtended;

// ─── Helpers ────────────────────────────────────────────────

// Max tasks shown per day group in the "Tasks: Next 7 Days" widget before collapsing into "+N more".
const TASKS_PER_DAY_LIMIT = 5;

// Max rows a list widget renders before the user has to follow its header link
// to the full page. Matches TASKS_PER_DAY_LIMIT so widgets stay the same height.
const WIDGET_ROW_LIMIT = 5;

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning";
  if (h < 17) return "Good Afternoon";
  return "Good Evening";
}

function getFirstName(name: string | null | undefined): string {
  if (!name) return "there";
  return name.split(" ")[0];
}

function formatDueDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "No date";
  // Task due dates are day-only ('YYYY-MM-DD'); parse in local time so the shown
  // day (and the Overdue/Today/Tomorrow label) is not pulled back a day for
  // viewers behind UTC.
  const d = toLocalDate(dateStr);
  if (!d) return "No date";
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const due = new Date(d);
  due.setHours(0, 0, 0, 0);
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  const formatted = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (diffDays < 0) return `Overdue · ${formatted}`;
  if (diffDays === 0) return `Today · ${formatted}`;
  if (diffDays === 1) return `Tomorrow · ${formatted}`;
  return formatted;
}

/** Integer cents → compact USD for stat cards (e.g. 1234567 → "$12.3k"). */
function formatCentsShort(cents: number | null | undefined): string {
  const dollars = (cents ?? 0) / 100;
  const abs = Math.abs(dollars);
  if (abs >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(dollars / 1_000).toFixed(1)}k`;
  return `$${dollars.toFixed(0)}`;
}

/** Integer cents → full USD for widget detail rows (e.g. 1234567 → "$12,345.67"). */
function formatCentsFull(cents: number | null | undefined): string {
  return formatCents(cents ?? 0);
}

/** Decimal hours → short label (e.g. 3.5 → "3.5h", 4 → "4h"). */
function formatHours(hours: number | null | undefined): string {
  return formatHoursMinutes(hours);
}


// The dashboard tags matters and tasks with smaller pills than the app-wide badges,
// so they fit inside compact widgets. Only the shape is local - the word and the
// colour come from the shared vocabularies in @/constants/statusMeta, so a matter
// reads the same here as it does on the matters grid.

// ─── Stat Card ──────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
  onClick,
  compact,
  loading,
}: {
  icon: typeof Briefcase;
  label: string;
  value: number | string;
  accent: string;
  onClick?: () => void;
  compact?: boolean;
  loading?: boolean;
}) {
  const colorMap: Record<string, { bg: string; darkBg: string; iconColor: string; darkIconColor: string; ring: string }> = {
    indigo: { bg: "bg-accent-soft", darkBg: "dark:bg-accent-soft", iconColor: "text-accent-emphasis", darkIconColor: "dark:text-accent-emphasis", ring: "hover:ring-focus-ring dark:hover:ring-focus-ring" },
    emerald: { bg: "bg-emerald-50", darkBg: "dark:bg-emerald-500/20", iconColor: "text-emerald-600", darkIconColor: "dark:text-emerald-400", ring: "hover:ring-emerald-100 dark:hover:ring-emerald-500/30" },
    amber: { bg: "bg-amber-50", darkBg: "dark:bg-amber-500/20", iconColor: "text-amber-600", darkIconColor: "dark:text-amber-400", ring: "hover:ring-amber-100 dark:hover:ring-amber-500/30" },
    rose: { bg: "bg-rose-50", darkBg: "dark:bg-rose-500/20", iconColor: "text-rose-600", darkIconColor: "dark:text-rose-400", ring: "hover:ring-rose-100 dark:hover:ring-rose-500/30" },
    violet: { bg: "bg-accent-soft", darkBg: "dark:bg-accent-soft", iconColor: "text-accent-emphasis", darkIconColor: "dark:text-accent-emphasis", ring: "hover:ring-focus-ring dark:hover:ring-focus-ring" },
    slate: { bg: "bg-slate-100", darkBg: "dark:bg-slate-500/20", iconColor: "text-slate-600", darkIconColor: "dark:text-slate-400", ring: "hover:ring-slate-200 dark:hover:ring-slate-500/30" },
    blue: { bg: "bg-blue-50", darkBg: "dark:bg-blue-500/20", iconColor: "text-accent-emphasis", darkIconColor: "dark:text-accent-emphasis", ring: "hover:ring-blue-100 dark:hover:ring-focus-ring" },
  };
  const c = colorMap[accent] || colorMap.indigo;
  const isInteractive = Boolean(onClick) && !loading;

  const skeleton = (
    <div className="flex items-center gap-3 md:gap-4 animate-pulse">
      <div className={`w-8 h-8 md:w-9 md:h-9 rounded-lg md:rounded-xl ${c.bg} ${c.darkBg} flex items-center justify-center flex-shrink-0`}>
        <div className="h-3.5 w-3.5 md:h-4 md:w-4 rounded-sm bg-white/40 dark:bg-white/10" />
      </div>
      <div className="flex-1 min-w-0 md:hidden space-y-1.5">
        <div className="h-3 w-20 rounded bg-surface-alt" />
        <div className="h-2.5 w-14 rounded bg-surface-alt/70" />
      </div>
      <div className="hidden md:block flex-1 min-w-0 space-y-2">
        <div className="h-5 w-10 rounded bg-surface-alt" />
        <div className="h-2.5 w-24 rounded bg-surface-alt/70" />
      </div>
    </div>
  );

  if (compact) {
    return (
      <div
        onClick={isInteractive ? onClick : undefined}
        className={`bg-surface rounded-xl border border-outline-subtle px-3.5 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition-all duration-200 ${isInteractive ? "cursor-pointer hover:shadow-md" : ""}`}
      >
        {loading ? skeleton : (
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg ${c.bg} ${c.darkBg} flex items-center justify-center flex-shrink-0`}>
              <Icon size={15} className={`${c.iconColor} ${c.darkIconColor}`} />
            </div>
            <p className="text-[11px] text-on-surface-secondary font-medium flex-1 min-w-0 truncate">{label}</p>
            <p className="text-lg font-bold text-on-surface leading-none flex-shrink-0">{value}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      onClick={isInteractive ? onClick : undefined}
      className={`bg-surface border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition-all duration-200 rounded-xl px-3.5 py-3 md:rounded-2xl md:px-4 md:py-3.5 ${isInteractive ? `cursor-pointer hover:shadow-md md:hover:ring-2 ${c.ring}` : ""}`}
    >
      {loading ? skeleton : (
        <div className="flex items-center gap-3 md:gap-4">
          <div className={`w-8 h-8 md:w-9 md:h-9 rounded-lg md:rounded-xl ${c.bg} ${c.darkBg} flex items-center justify-center flex-shrink-0`}>
            <Icon size={15} className={`${c.iconColor} ${c.darkIconColor} md:hidden`} />
            <Icon size={17} className={`${c.iconColor} ${c.darkIconColor} hidden md:block`} />
          </div>
          {/* Mobile: inline row */}
          <p className="text-[11px] text-on-surface-secondary font-medium flex-1 min-w-0 truncate md:hidden">{label}</p>
          <p className="text-lg font-bold text-on-surface leading-none flex-shrink-0 md:hidden">{value}</p>
          {/* Desktop: stacked */}
          <div className="hidden md:block">
            <p className="text-xl font-bold text-on-surface leading-none">{value}</p>
            <p className="text-[11px] text-on-surface-secondary font-medium mt-1 whitespace-nowrap">{label}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Widget Wrapper ──────────────────────────────────────────
// Presentational wrapper around each dashboard widget. In edit mode it shows the
// toolbar (drag handle + label + configure/visibility toggles). The drag itself
// is driven by dnd-kit: the enclosing SortableItem supplies the grip's
// attributes/listeners (spread onto the grip) and the isDragging flag.

function SortableWidget({
  editMode,
  label,
  visible,
  onToggleVisibility,
  onEdit,
  compact,
  isDragging,
  dragHandle,
  zone,
  onMoveZone,
  children,
}: {
  id?: string;
  editMode: boolean;
  label: string;
  visible: boolean;
  onToggleVisibility: () => void;
  onEdit?: () => void;
  compact?: boolean;
  isDragging?: boolean;
  dragHandle?: DragHandle;
  zone?: "main" | "sidebar";
  onMoveZone?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`relative rounded-2xl transition-shadow ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      {/* Edit-mode toolbar */}
      {editMode && (
        <div className="flex items-center gap-2 mb-2">
          <button
            {...(dragHandle?.attributes ?? {})}
            {...(dragHandle?.listeners ?? {})}
            className="p-1 rounded-md text-on-surface-muted hover:bg-surface-hover hover:text-on-surface-secondary transition-all cursor-grab active:cursor-grabbing"
            aria-label="Drag to reorder"
          >
            <GripVertical size={compact ? 14 : 16} />
          </button>
          <span className={`font-semibold text-on-surface-secondary uppercase tracking-wide ${compact ? "text-[10px]" : "text-xs"}`}>{label}</span>
          <div className="ml-auto flex items-center gap-1">
            {onMoveZone && (
              <Tooltip title={zone === "sidebar" ? "Move to main area" : "Move to sidebar"} enterDelay={300}>
                <button
                  onClick={onMoveZone}
                  className="p-1.5 rounded-lg transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer text-on-surface-muted hover:bg-surface-hover hover:text-on-surface-secondary"
                >
                  {zone === "sidebar" ? <PanelLeft size={compact ? 13 : 15} /> : <PanelRight size={compact ? 13 : 15} />}
                </button>
              </Tooltip>
            )}
            {onEdit && (
              <Tooltip title="Configure cards" enterDelay={300}>
                <button aria-label="Configure cards"
                  data-stat-picker-toggle
                  onClick={onEdit}
                  className="p-1.5 rounded-lg transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer text-on-surface-muted hover:bg-surface-hover hover:text-on-surface-secondary"
                >
                  <Settings2 size={compact ? 13 : 15} />
                </button>
              </Tooltip>
            )}
            <Tooltip title={visible ? "Hide widget" : "Show widget"} enterDelay={300}>
              <button
                onClick={onToggleVisibility}
                className={`p-1.5 rounded-lg transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                  visible
                    ? "text-accent-emphasis hover:bg-accent-soft dark:hover:bg-accent-soft"
                    : "text-on-surface-muted hover:bg-surface-hover"
                }`}
              >
                {visible ? <Eye size={compact ? 13 : 15} /> : <EyeOff size={compact ? 13 : 15} />}
              </button>
            </Tooltip>
          </div>
        </div>
      )}
      {/* Widget content: shown dimmed if hidden in edit mode */}
      <div className={editMode && !visible ? "opacity-30 pointer-events-none" : ""}>
        {children}
      </div>
    </div>
  );
}

// ─── dnd-kit sortable item wrapper ───────────────────────────
// Wraps each widget as a dnd-kit sortable node. Crucially it does NOT apply the
// sortable transform, so widgets never move during a drag - the layout stays
// still, which keeps the pointer-based collision stable (no oscillation) and
// avoids the reflow loops that plagued earlier attempts. The drag preview is the
// DragOverlay chip; the drop position is shown by an InsertionBar.
function SortableItem({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: (args: {
    setNodeRef: (el: HTMLElement | null) => void;
    dragHandle: DragHandle;
    isDragging: boolean;
  }) => React.ReactNode;
}) {
  const { setNodeRef, attributes, listeners, isDragging } = useSortable({ id, disabled });
  return <>{children({ setNodeRef, dragHandle: { attributes, listeners: listeners ?? undefined }, isDragging })}</>;
}

// A thin bar marking where the dragged widget will drop. Rendered at zero layout
// height (the visible bar is absolutely positioned in the gap above the card) so
// showing/moving it never reflows the list - which keeps the pointer collision
// stable and avoids layout thrash during a drag.
function InsertionBar() {
  return (
    <div className="relative h-0" aria-hidden>
      <div className="absolute inset-x-0 -top-2 h-1.5 rounded-full bg-accent-soft0" />
    </div>
  );
}

// A column drop target. Its id ("main-zone" / "sidebar-zone") lets the collision
// detection resolve which COLUMN the pointer is over.
function DropZone({ id, className, children }: { id: string; className: string; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={className}>
      {children}
    </div>
  );
}

// The small chip shown in the DragOverlay while dragging (instead of the full
// widget), so it reads clearly and never overflows the narrow sidebar.
function DragChip({ label }: { label: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 bg-surface border border-accent-border-soft dark:border-accent-border-soft rounded-xl px-3 py-2 shadow-xl shadow-black/10 -rotate-1 cursor-grabbing">
      <GripVertical size={13} className="text-accent-emphasis shrink-0" />
      <span className="text-xs font-semibold text-on-surface whitespace-nowrap">{label}</span>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────

export default function LawFirmDashboardPage() {
  const params = useParams() as Record<string, string | string[] | undefined>;
  const { user } = useAuth();
  const { loading: permissionsLoading, hasPermission } = usePermissions();
  const { navigate } = useNavigation();

  const rawId = params?.lawFirmId;
  const id = useMemo(() => (Array.isArray(rawId) ? rawId[0] : rawId) ?? "", [rawId]);

  // The lawfirm layout already fetches the firm and exposes it via
  // LawFirmContext (and blocks rendering until it resolves). Consume that
  // instead of issuing a second GET /api/lawfirms/{id} from the page.
  const { lawFirm: contextLawFirm } = useLawFirm();
  const lawFirm = contextLawFirm as LawFirm | null;

  // Single aggregate dashboard read (replaces the former Promise.all of
  // listLawFirmTasks/getMatters/getFirmConversations/getUnreadCount + the
  // separate my-assignments fetch). React Query caches it so a revisit
  // paints instantly from cache instead of a full-page spinner.
  const {
    data: summary,
    isLoading: summaryLoading,
    error: summaryError,
    refetch: refetchSummary,
  } = useDashboardSummary(id || undefined);

  const [error, setError] = useState<string | null>(null);
  // Team roster + pending signatures are now folded into the dashboard summary
  // aggregate (no separate cold-load GETs). `pendingSignatures` is kept as local
  // state so the realtime subscription + fallback poll can still push live
  // updates after the initial paint; it is seeded from the summary below.
  const teamMembers: User[] = useMemo(() => summary?.teamMembers ?? [], [summary]);
  const teamLoading = summaryLoading && !summary;
  const [pendingSignatures, setPendingSignatures] = useState<DashboardPendingSignature[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  // Cache of each widget's rendered content, keyed by widget key. While a drag is
  // active, dnd-kit's context changes on every pointer move and re-renders every
  // sortable item; returning the cached (same-reference) content lets React skip
  // re-rendering the heavy widget subtrees, so dragging stays smooth. The cache
  // is refreshed on every non-drag render, so content is always current.
  const widgetNodeCacheRef = useRef<Map<string, React.ReactNode>>(new Map());
  const [editMode, setEditMode] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [heroLogoFailed, setHeroLogoFailed] = useState(false);
  const { dashboard, updateDashboardPreferences, updateTheme, loading: preferencesLoading } = usePreferences();
  const canViewMatters = hasPermission("matters.view");
  const canViewTasks = hasPermission("tasks.view");
  const canViewMessages = hasPermission("messaging.view");
  const canViewMembers = hasPermission("members.view");
  const canViewSignatures = hasPermission("signatures.view");
  // Signing is plan-gated on top of the permission. The pending-signature
  // endpoint sits behind `requireFeature('documentSigning')`, so on a plan
  // without it the poll and the realtime refresh below are guaranteed 403s and
  // the widget has nothing it could ever show.
  const { features } = useFirmSettings();
  const signingEnabled = canViewSignatures && features.documentSigning;
  const canViewInvoices = hasPermission("billing.viewInvoices");
  const canViewTimeEntries = hasPermission("billing.viewTimeEntries");
  const canViewCalendar = hasPermission("calendar.view");
  const billingTimer = useBillingTimer();
  const [statPickerOpen, setStatPickerOpen] = useState(false);
  const { mounted: statPickerMounted, exiting: statPickerExiting } = useMountTransition(statPickerOpen, 150);
  const statPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => setIsDark(document.documentElement.classList.contains("dark"));
    update();
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the logo-load-failed flag when the logo URL changes
    setHeroLogoFailed(false);
  }, [lawFirm?.logoUrl]);

  const handleToggleWidget = async (key: DashboardWidgetKey) => {
    const updated = dashboard.widgets.map((w) =>
      w.key === key ? { ...w, visible: !w.visible } : w
    );
    await updateDashboardPreferences({ ...dashboard, widgets: updated });
  };

  // Move a widget to the other column. Dragging only reorders within a column
  // (the two columns are very different widths, so cross-column dragging is
  // awkward); switching columns is this toolbar button instead. The widget lands
  // at the end of the target column, ready to be dragged into place there.
  const handleMoveZone = async (key: DashboardWidgetKey) => {
    const widget = dashboard.widgets.find((w) => w.key === key);
    if (!widget) return;
    const nextZone: "main" | "sidebar" = widget.zone === "sidebar" ? "main" : "sidebar";
    const others = dashboard.widgets.filter((w) => w.key !== key);
    await updateDashboardPreferences({
      ...dashboard,
      widgets: [...others, { ...widget, zone: nextZone }],
    });
  };

  const selectedStatCards = dashboard.statCards ?? DEFAULT_STAT_CARDS;

  const handleToggleStatCard = async (key: StatCardKey) => {
    const isSelected = selectedStatCards.includes(key);
    let updated: StatCardKey[];
    if (isSelected) {
      updated = selectedStatCards.filter((k) => k !== key);
    } else {
      if (selectedStatCards.length >= 6) return; // max 6 cards
      updated = [...selectedStatCards, key];
    }
    await updateDashboardPreferences({ ...dashboard, statCards: updated });
  };

  // ─── DnD setup (dnd-kit) ───────────────────────────────────
  const mainWidgets = useMemo(
    () => dashboard.widgets.filter((w) => !w.zone || w.zone === "main"),
    [dashboard.widgets]
  );
  const sidebarWidgets = useMemo(
    () => dashboard.widgets.filter((w) => w.zone === "sidebar"),
    [dashboard.widgets]
  );

  // Whether to render the sidebar column at all. In edit mode it's always shown
  // (so you can move widgets into it and re-enable hidden ones). When not
  // editing, it's only shown if it has at least one VISIBLE widget - otherwise a
  // column holding only hidden widgets would reserve its 320px width and leave an
  // empty strip on the right instead of letting the main column expand.
  const showSidebar = useMemo(
    () => editMode || sidebarWidgets.some((w) => w.visible),
    [editMode, sidebarWidgets]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // Cursor-based collision: the COLUMN is whichever zone the POINTER is inside
  // (not the dragged card's centre), so a card switches columns exactly when the
  // cursor crosses. Within that column, the drop slot is the first card whose
  // vertical midpoint is below the pointer (so gaps between cards are reliable
  // targets). Widgets never move mid-drag, so these rects are stable and this
  // never oscillates.
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointer = args.pointerCoordinates;
    const isZone = (dId: string | number) => dId === "main-zone" || dId === "sidebar-zone";
    if (!pointer) {
      const c = closestCenter(args);
      return c.length ? c : rectIntersection(args);
    }
    const zoneHit = pointerWithin(args).find((c) => isZone(c.id));
    if (!zoneHit) return [];
    const zoneRect = args.droppableRects.get(zoneHit.id);
    const inZone = args.droppableContainers
      .filter((c) => !isZone(c.id))
      .map((c) => ({ id: c.id, r: args.droppableRects.get(c.id) }))
      .filter((x) => {
        if (!x.r || !zoneRect) return false;
        const cx = x.r.left + x.r.width / 2;
        return cx >= zoneRect.left && cx <= zoneRect.left + zoneRect.width;
      })
      .sort((a, b) => a.r!.top - b.r!.top);
    for (const x of inZone) {
      if (pointer.y < x.r!.top + x.r!.height / 2) return [{ id: x.id }];
    }
    return [{ id: zoneHit.id }];
  }, []);

  const handleDragStart = useCallback((e: DragStartEvent) => {
    setActiveId(e.active.id as string);
    setOverId(e.active.id as string);
  }, []);
  const handleDragOver = useCallback((e: DragOverEvent) => {
    setOverId((e.over?.id as string) ?? null);
  }, []);
  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOverId(null);
  }, []);

  // Resolve the drop target (zone + the widget to insert before, or END) from
  // the id the pointer is over. Mirrors handleDragEnd so the InsertionBar shows
  // exactly where the widget will land.
  const dropTarget = useMemo<{ zone: "main" | "sidebar"; beforeKey: string | null } | null>(() => {
    if (!activeId || !overId || overId === activeId) return null;
    let zone: "main" | "sidebar";
    let beforeKey: string | null;
    if (overId === "main-zone") {
      zone = "main";
      beforeKey = null;
    } else if (overId === "sidebar-zone") {
      zone = "sidebar";
      beforeKey = null;
    } else {
      const over = dashboard.widgets.find((w) => w.key === overId);
      if (!over) return null;
      zone = over.zone === "sidebar" ? "sidebar" : "main";
      beforeKey = over.key;
    }
    // Hide the indicator when dropping here wouldn't change the order (i.e. the
    // widget's own current spot): same zone, and the target is either the widget
    // right after it or the end while it's already last.
    const activeWidget = dashboard.widgets.find((w) => w.key === activeId);
    const activeZone = activeWidget?.zone === "sidebar" ? "sidebar" : "main";
    if (zone === activeZone) {
      const zoneList = dashboard.widgets.filter((w) => (w.zone ?? "main") === zone);
      const wi = zoneList.findIndex((w) => w.key === activeId);
      const noMove = beforeKey === null ? wi === zoneList.length - 1 : zoneList[wi + 1]?.key === beforeKey;
      if (noMove) return null;
    }
    return { zone, beforeKey };
  }, [activeId, overId, dashboard.widgets]);

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      const activeKey = e.active.id as string;
      const overIdEnd = e.over?.id as string | undefined;
      setActiveId(null);
      setOverId(null);
      if (!overIdEnd) return;

      const activeWidget = dashboard.widgets.find((w) => w.key === activeKey);
      if (!activeWidget) return;

      let targetZone: "main" | "sidebar";
      let beforeKey: string | null;
      if (overIdEnd === "main-zone" || overIdEnd === "sidebar-zone") {
        targetZone = overIdEnd === "sidebar-zone" ? "sidebar" : "main";
        beforeKey = null;
      } else {
        if (overIdEnd === activeKey) return; // dropped on its own slot -> no change
        const over = dashboard.widgets.find((w) => w.key === overIdEnd);
        if (!over) return;
        targetZone = over.zone === "sidebar" ? "sidebar" : "main";
        beforeKey = over.key;
      }

      // Skip the reorder (and the persist) when the drop wouldn't change the
      // order: same zone, and the target is the widget right after it or the end
      // while it's already last.
      const activeZone = activeWidget.zone === "sidebar" ? "sidebar" : "main";
      if (targetZone === activeZone) {
        const zoneList = dashboard.widgets.filter((w) => (w.zone ?? "main") === targetZone);
        const wi = zoneList.findIndex((w) => w.key === activeKey);
        const noMove = beforeKey === null ? wi === zoneList.length - 1 : zoneList[wi + 1]?.key === beforeKey;
        if (noMove) return;
      }

      const main = mainWidgets.filter((w) => w.key !== activeKey).map((w) => ({ ...w }));
      const side = sidebarWidgets.filter((w) => w.key !== activeKey).map((w) => ({ ...w }));
      const list = targetZone === "main" ? main : side;
      const insertAt =
        beforeKey === null ? list.length : (() => {
          const i = list.findIndex((w) => w.key === beforeKey);
          return i === -1 ? list.length : i;
        })();
      list.splice(insertAt, 0, { ...activeWidget, zone: targetZone });
      updateDashboardPreferences({ ...dashboard, widgets: [...main, ...side] });
    },
    [mainWidgets, sidebarWidgets, dashboard, updateDashboardPreferences]
  );

  // Close search dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchFocused(false);
      }
      if (statPickerRef.current && !statPickerRef.current.contains(e.target as Node) && !(e.target as HTMLElement).closest("[data-stat-picker-toggle]")) {
        setStatPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Core dashboard data now comes from the single aggregate endpoint via
  // useDashboardSummary. Surface its load/error state to the existing UI.
  useEffect(() => {
    if (!id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- surfaces the dashboard summary query's load/error state into the shared error banner
      setError("Missing law firm id.");
      return;
    }
    setError(summaryError ? "Failed to load dashboard data." : null);
  }, [id, summaryError]);

  // `dataLoaded` gates every widget's skeleton -> content swap, exactly as
  // before. With React Query, data is "loaded" once a fetch has resolved at
  // least once (i.e. we have a `summary` object).
  const dataLoaded = !!summary;

  // Preserve the original "instant paint" behavior: a full-page spinner shows
  // only on the very first visit to a firm's dashboard this session. Once data
  // has resolved (or was resolved earlier this session), revisits paint
  // skeleton widgets immediately instead of the full-page spinner, even on a
  // hard refresh, where React Query's cache is empty.
  useEffect(() => {
    if (id && dataLoaded) {
      try { sessionStorage.setItem(`dashboardLoaded:${id}`, "1"); } catch { /* ignore */ }
    }
  }, [id, dataLoaded]);

  const hasPaintedThisSession = (() => {
    if (typeof window === "undefined") return false;
    try { return !!id && !!sessionStorage.getItem(`dashboardLoaded:${id}`); } catch { return false; }
  })();

  // Show the full-page spinner only on a true cold load (summary still
  // loading, never painted before this session).
  const loading = summaryLoading && !dataLoaded && !hasPaintedThisSession;

  // The team roster now arrives inside the dashboard summary (derived above from
  // `summary.teamMembers`), so there is no separate `GET /lawfirm/:id/users`.

  // Seed the local `pendingSignatures` state from the summary aggregate on every
  // (re)load instead of a separate cold-load GET. Realtime + the fallback poll
  // below keep it fresh after first paint. When the user lacks signatures.view,
  // or the firm's plan lacks signing, the summary omits the section, so this
  // resolves to an empty list.
  useEffect(() => {
    if (!signingEnabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds pending-signatures state from the summary aggregate; realtime/poll keep it fresh after
      setPendingSignatures([]);
      return;
    }
    if (summary) setPendingSignatures(summary.pendingSignatures ?? []);
  }, [summary, signingEnabled]);

  // The pending-signatures section is "loaded" once the summary has resolved.
  const pendingSignaturesLoading = summaryLoading && !summary;

  useEffect(() => {
    if (permissionsLoading) return;
    if (!id || !signingEnabled) return;

    let cancelled = false;

    const fetchPendingSignatures = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const result = await signaturesService.getPendingForUser(id);
        if (!cancelled) {
          setPendingSignatures(result.needsMySignature || []);
        }
      } catch {
        // Non-critical; the summary seed / realtime push remains in place.
      }
    };

    // No immediate fetch on mount. The summary seed above already populated the
    // list. Realtime drives updates (see useFirmSigningRealtime below); this is a
    // slow fallback poll in matter the websocket drops.
    const interval = setInterval(fetchPendingSignatures, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // Depend on the stable `signingEnabled` boolean, not the `hasPermission`
    // function, so an unstable function identity can't tear down/recreate the
    // interval (and re-fire an immediate fetch) on every render.
  }, [id, permissionsLoading, signingEnabled]);

  // Realtime: refresh pending signatures when any of the firm's signing
  // sessions change, instead of an always-firing poll.
  const refreshPendingSignatures = useCallback(async () => {
    if (!id || !signingEnabled) return;
    try {
      const result = await signaturesService.getPendingForUser(id);
      setPendingSignatures(result.needsMySignature || []);
    } catch {
      // Non-critical; the fallback poll will retry.
    }
  }, [id, signingEnabled]);

  useFirmSigningRealtime(
    !permissionsLoading && signingEnabled ? id : undefined,
    refreshPendingSignatures
  );

  // My assignments now arrive inside the dashboard summary (null = no
  // tasks.view permission, mirroring the old getMyAssignments behavior).
  const myAssignments: DashboardMyAssignments | null = summary?.myAssignments ?? null;
  const myAssignmentsLoading = summaryLoading;

  // ─── Summary-backed slices for widgets / search ─────────────
  // The aggregate endpoint already scopes each section by permission (returns
  // null stats / empty arrays where the user lacks access), pre-sorts, and
  // slices. We map field names to what the widgets/search already expect.
  const stats = summary?.stats;
  const recentMattersData: DashboardRecentMatter[] = useMemo(() => summary?.recentMatters ?? [], [summary]);
  const upcomingTasksData: DashboardUpcomingTask[] = useMemo(() => summary?.upcomingTasks ?? [], [summary]);
  const recentConversationsData: DashboardRecentConversation[] = useMemo(() => summary?.recentConversations ?? [], [summary]);
  const overdueTasksData: DashboardUpcomingTask[] = useMemo(() => summary?.overdueTasks ?? [], [summary]);
  const agingInvoicesData: DashboardAgingInvoice[] = useMemo(() => summary?.agingInvoices ?? [], [summary]);
  const upcomingPaymentsData: DashboardUpcomingPayment[] = useMemo(() => summary?.upcomingPayments ?? [], [summary]);
  // Invoice whose detail modal is open from the Upcoming Payments widget (null = closed).
  const [selectedPayment, setSelectedPayment] = useState<DashboardUpcomingPayment | null>(null);
  // Task whose detail modal is open from the Tasks: Next 7 Days widget (null = closed).
  const [selectedTask, setSelectedTask] = useState<DashboardUpcomingTask | null>(null);
  const upcomingEventsData: DashboardUpcomingEvent[] = useMemo(() => summary?.upcomingEvents ?? [], [summary]);
  const todayTimeEntriesData: DashboardTodayTimeEntry[] = useMemo(() => summary?.todayTimeEntries ?? [], [summary]);

  // Scalar stats used by the hero copy (null = no permission -> treat as 0,
  // same as the old empty-array .length).
  const activeMattersCount = stats?.openMatters ?? 0;
  const pendingTasksCount = stats?.pendingTasks ?? 0;
  const upcomingDeadlinesCount = stats?.upcomingDeadlines ?? 0;
  const unreadCount = stats?.unreadMessages ?? 0;

  // Recent matters. Backend returns top 6 by updatedAt desc; the widget renders
  // at most 4, so keep the original slice for an identical layout.
  const recentMatters = useMemo(() => recentMattersData.slice(0, 4), [recentMattersData]);

  // Upcoming tasks (next 7 days) grouped by day, same grouping/sort as before,
  // now over the summary's pre-filtered `upcomingTasks` list.
  const tasksByDay = useMemo(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    // Group by day
    const groups: { label: string; dateKey: string; dueQuery: string; tasks: DashboardUpcomingTask[] }[] = [];
    const dayMap = new Map<string, DashboardUpcomingTask[]>();

    for (const task of upcomingTasksData) {
      if (!task.dueDate) continue;
      // dueDate is day-only ('YYYY-MM-DD'); use it directly as the bucket key.
      // Round-tripping through `new Date().toISOString()` would shift the day
      // across the UTC boundary for viewers behind UTC. The label logic below
      // (`key + "T00:00:00"`) already parses the key in local time.
      const key = String(task.dueDate).slice(0, 10);
      if (!dayMap.has(key)) dayMap.set(key, []);
      dayMap.get(key)!.push(task);
    }

    // Sort keys chronologically and build labels
    const sortedKeys = [...dayMap.keys()].sort();
    for (const key of sortedKeys) {
      const d = new Date(key + "T00:00:00");
      const diffDays = Math.round((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      let label: string;
      // The tasks page's `?due=` bucket link only has dedicated "today"/"tomorrow"
      // buckets; every later day goes through the generic `date` bucket instead
      // (see `dueWindowForBucket` in TasksGrid.tsx).
      let dueQuery: string;
      if (diffDays === 0) { label = "Today"; dueQuery = "due=today"; }
      else if (diffDays === 1) { label = "Tomorrow"; dueQuery = "due=tomorrow"; }
      else {
        label = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
        dueQuery = `due=date&date=${key}`;
      }

      const tasks = dayMap.get(key)!.sort((a, b) => {
        const pOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
        return (pOrder[a.priority] ?? 2) - (pOrder[b.priority] ?? 2);
      });
      groups.push({ label, dateKey: key, dueQuery, tasks });
    }

    return groups;
  }, [upcomingTasksData]);

  // Combined assignments sorted by due date (soonest first)
  const combinedAssignments = useMemo(() => {
    if (!myAssignments) return [];
    type AssignmentItem = { type: 'task'; data: DashboardUpcomingTask };
    const items: AssignmentItem[] = [
      ...myAssignments.tasks.map((t) => ({ type: 'task' as const, data: t })),
    ];
    items.sort((a, b) => {
      const aDate = toLocalDate(a.data.dueDate)?.getTime() ?? Infinity;
      const bDate = toLocalDate(b.data.dueDate)?.getTime() ?? Infinity;
      return aDate - bDate;
    });
    return items.slice(0, WIDGET_ROW_LIMIT);
  }, [myAssignments]);

  // Backend returns top 6 conversations; the widget renders at most 4.
  const recentConversations = useMemo(
    () => recentConversationsData.slice(0, 4),
    [recentConversationsData]
  );

  // A section that was PERMITTED (so it ran) but FAILED at runtime on the backend
  // reports `sectionErrors.<name>`. Each widget keys off its own flag to show a
  // "couldn't load, retry" state instead of a misleading empty state. Optional/
  // additive fields, absent on older payloads (treated as no error).
  //
  // Note the backend section names: matter STATS + recentMatters share the `matters`
  // section; the "Recent Matters" widget therefore keys off `matters`. Upcoming
  // tasks and my-assignments are their own sections (`upcomingTasks` /
  // `myAssignments`). The stat cards span several sections, so they intentionally
  // keep their permissive 0-fallback rather than a single error state.
  const sectionErrors = summary?.sectionErrors;
  const mattersSectionFailed = sectionErrors?.matters === true;
  const upcomingTasksSectionFailed = sectionErrors?.upcomingTasks === true;
  const myAssignmentsSectionFailed = sectionErrors?.myAssignments === true;
  const messagingSectionFailed = sectionErrors?.messaging === true;
  const teamSectionFailed = sectionErrors?.members === true;
  const signaturesSectionFailed = sectionErrors?.signatures === true;
  const overdueTasksSectionFailed = sectionErrors?.overdueTasks === true;
  const financialSectionFailed = sectionErrors?.financial === true;
  const upcomingPaymentsSectionFailed = sectionErrors?.upcomingPayments === true;
  const eventsSectionFailed = sectionErrors?.events === true;
  const myTimeSectionFailed = sectionErrors?.myTime === true;

  // Team widget data
  const sortedTeamMembers = useMemo(() => {
    if (!user) return teamMembers;
    return [...teamMembers].sort((a, b) => {
      const aIsCurrentUser = a.uid === user.uid || a.email === user.email;
      const bIsCurrentUser = b.uid === user.uid || b.email === user.email;
      if (aIsCurrentUser && !bIsCurrentUser) return -1;
      if (!aIsCurrentUser && bIsCurrentUser) return 1;
      return 0;
    });
  }, [teamMembers, user]);

  // Stat card registry, maps each key to its display config and live value.
  // Values come straight from the aggregate `stats` payload. A `null` stat
  // means the user lacks permission for that section; render it as 0, which
  // matches the old behavior (those sections returned empty arrays -> .length
  // of 0 when the user couldn't view them).
  const statCardRegistry = useMemo(() => {
    const registry: Record<StatCardKey, { label: string; value: number | string; icon: typeof Briefcase; accent: string; link?: string }> = {
      openMatters: { label: "Open Matters", value: stats?.openMatters ?? 0, icon: Briefcase, accent: "indigo", link: `/lawfirm/${id}/matters` },
      totalMatters: { label: "Total Matters", value: stats?.totalMatters ?? 0, icon: TrendingUp, accent: "emerald", link: `/lawfirm/${id}/matters` },
      closedMatters: { label: "Closed Matters", value: stats?.closedMatters ?? 0, icon: Briefcase, accent: "slate", link: `/lawfirm/${id}/matters` },
      pendingTasks: { label: "Pending Tasks", value: stats?.pendingTasks ?? 0, icon: ClipboardCheck, accent: "amber", link: `/lawfirm/${id}/tasks` },
      completedTasks: { label: "Completed Tasks", value: stats?.completedTasks ?? 0, icon: Check, accent: "emerald", link: `/lawfirm/${id}/tasks` },
      totalTasks: { label: "Total Tasks", value: stats?.totalTasks ?? 0, icon: Hash, accent: "indigo", link: `/lawfirm/${id}/tasks` },
      upcomingDeadlines: { label: "Upcoming Deadlines", value: stats?.upcomingDeadlines ?? 0, icon: AlertTriangle, accent: "rose", link: `/lawfirm/${id}/tasks` },
      overdueTasks: { label: "Overdue Tasks", value: stats?.overdueTasks ?? 0, icon: AlertTriangle, accent: "rose", link: `/lawfirm/${id}/tasks` },
      unreadMessages: { label: "Unread Messages", value: stats?.unreadMessages ?? 0, icon: MessageSquare, accent: "violet", link: `/lawfirm/${id}/messages` },
      totalConversations: { label: "Conversations", value: stats?.conversationCount ?? 0, icon: MessageSquare, accent: "indigo", link: `/lawfirm/${id}/messages` },
      teamSize: { label: "Team Members", value: stats?.teamSize ?? teamMembers.length, icon: Users, accent: "blue" },
      outstandingAR: { label: "Outstanding A/R", value: formatCentsShort(stats?.outstandingArCents), icon: DollarSign, accent: "indigo", link: `/lawfirm/${id}/billing` },
      overdueInvoices: { label: "Overdue Invoices", value: formatCentsShort(stats?.overdueInvoiceCents), icon: AlertTriangle, accent: "rose", link: `/lawfirm/${id}/billing` },
      collectedThisMonth: { label: "Collected This Month", value: formatCentsShort(stats?.collectedThisMonthCents), icon: TrendingUp, accent: "emerald", link: `/lawfirm/${id}/billing` },
      unbilledWip: { label: "Unbilled WIP", value: formatCentsShort(stats?.unbilledWipCents), icon: Clock, accent: "amber", link: `/lawfirm/${id}/billing` },
      hoursToday: { label: "Hours Today", value: formatHours(stats?.hoursToday), icon: Clock, accent: "blue", link: `/lawfirm/${id}/billing` },
      hoursThisWeek: { label: "Hours This Week", value: formatHours(stats?.hoursThisWeek), icon: Clock, accent: "violet", link: `/lawfirm/${id}/billing` },
    };
    return registry;
  }, [stats, teamMembers, id]);

  // Firm-wide search, one server query per section. The dashboard summary above
  // only carries a few recent rows per section, so filtering those in memory made
  // the bar look firm-wide while only ever searching what the page had rendered.
  const { results: searchResults, loading: searchLoading } = useDashboardSearch(id, searchQuery);

  const showDropdown = searchFocused && searchQuery.trim().length > 0;
  const { mounted: searchDropdownMounted, exiting: searchDropdownExiting } = useMountTransition(showDropdown, 150);
  // The clear button empties the query as it closes the menu. Keep the term the
  // fading menu was showing, or it reads 'No results for ""'.
  const shownSearchQuery = useLastOpenValue(showDropdown, searchQuery);
  const hasResults = searchResults.matters.length > 0 || searchResults.tasks.length > 0 || searchResults.conversations.length > 0 || searchResults.clients.length > 0;
  const renderFirmIdentity = (firm: LawFirm, compact: boolean) => {
    if (firm.logoUrl && !heroLogoFailed) {
      return (
        <div className={compact ? "mb-1 h-6" : "mb-2 h-8"}>
          <Image
            // Display size is driven entirely by CSS (h-full + w-auto). These
            // intrinsic props only set the aspect ratio and the HTML width/height
            // attributes; they're kept larger than the rendered box (≤180×32) on
            // purpose so neither rendered dimension can exactly equal a prop,
            // which is what triggers Next's "width or height modified" dev warning.
            src={firm.logoUrl}
            alt={firm.name}
            width={360}
            height={64}
            className="h-full w-auto max-w-[180px] object-contain object-left"
            onError={() => setHeroLogoFailed(true)}
          />
        </div>
      );
    }

    return (
      <p className={compact
        ? "text-[9px] font-semibold uppercase tracking-[0.15em] text-accent-foreground/75 mb-1"
        : "text-[10px] font-semibold uppercase tracking-[0.15em] text-accent-foreground/75 mb-2"}
      >
        {firm.name}
      </p>
    );
  };

  // Shared "section failed to load, retry" state for widgets whose backend
  // section reported a runtime failure via `sectionErrors`. Refetching the
  // aggregate re-runs every section, which re-attempts the failed one. Matches
  // the messaging widget's existing error/retry affordance.
  const renderWidgetError = (message: string, compact: boolean) => (
    <div className={`bg-surface rounded-2xl border border-outline-subtle text-center shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${compact ? "p-5" : "p-8"}`}>
      <AlertTriangle size={compact ? 24 : 32} className="text-amber-500 mx-auto mb-2" />
      <p className="text-sm text-on-surface-secondary mb-2">{message}</p>
      <button
        type="button"
        onClick={() => { void refetchSummary(); }}
        className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover transition-colors"
      >
        Retry
      </button>
    </div>
  );

  // ─── Widget renderer (main vs compact sidebar) ─────────────
  // Note: only called after lawFirm null guard in the JSX
  const renderWidget = (
    widget: DashboardWidget,
    compact: boolean,
    dragHandle?: DragHandle,
    isDragging?: boolean,
  ) => {
    const firm = lawFirm!;
    const sharedProps = {
      editMode,
      label: DASHBOARD_WIDGET_LABELS[widget.key] || widget.key,
      visible: widget.visible,
      onToggleVisibility: () => handleToggleWidget(widget.key),
      compact,
      dragHandle,
      isDragging,
      zone: (widget.zone === "sidebar" ? "sidebar" : "main") as "main" | "sidebar",
      onMoveZone: () => handleMoveZone(widget.key),
    };

    switch (widget.key) {
      case "hero":
        return (
          <SortableWidget key="hero" id="hero" {...sharedProps}>
            {compact ? (
              /* Compact hero, just greeting */
              <div className="rounded-2xl bg-accent-solid p-4 text-accent-foreground shadow-md">
                {renderFirmIdentity(firm, true)}
                <p className="text-sm font-bold leading-snug">{getGreeting()}, {getFirstName(user?.displayName)}</p>
                {dataLoaded ? (
                  <p className="text-[11px] text-accent-foreground/75 mt-1">
                    {activeMattersCount} matter{activeMattersCount !== 1 ? "s" : ""} · {pendingTasksCount} task{pendingTasksCount !== 1 ? "s" : ""}
                  </p>
                ) : (
                  <div className="h-3.5 w-28 rounded bg-accent-foreground/15 animate-pulse mt-1" />
                )}
              </div>
            ) : (
              <div className="relative overflow-hidden rounded-2xl bg-accent-solid p-7 text-accent-foreground shadow-lg">
                <div className="absolute top-0 right-0 w-64 h-64 bg-accent-foreground/5 rounded-full -translate-y-1/2 translate-x-1/4" />
                <div className="absolute bottom-0 left-1/3 w-48 h-48 bg-accent-foreground/5 rounded-full translate-y-1/2" />
                <div className="relative z-10">
                  {renderFirmIdentity(firm, false)}
                  <h1 className="text-2xl font-bold mb-2 leading-snug">{getGreeting()}, {getFirstName(user?.displayName)}</h1>
                  {dataLoaded ? (
                    <p className="text-accent-foreground/75 text-sm leading-relaxed max-w-lg">
                      You have{" "}
                      <span className="font-semibold text-accent-foreground">{activeMattersCount} active matter{activeMattersCount !== 1 ? "s" : ""}</span>{" "}
                      and{" "}
                      <span className="font-semibold text-accent-foreground">{pendingTasksCount} pending task{pendingTasksCount !== 1 ? "s" : ""}</span>
                      {upcomingDeadlinesCount > 0 && (
                        <>
                          {" "}with{" "}
                          <span className="font-semibold text-accent-foreground">{upcomingDeadlinesCount} deadline{upcomingDeadlinesCount !== 1 ? "s" : ""} this week</span>
                        </>
                      )}
                      .
                    </p>
                  ) : (
                    <div className="space-y-1.5 mt-1 max-w-lg">
                      <div className="h-4 w-3/4 rounded bg-accent-foreground/15 animate-pulse" />
                      <div className="h-4 w-1/2 rounded bg-accent-foreground/15 animate-pulse" />
                    </div>
                  )}
                  {unreadCount > 0 && canViewMessages && (
                    <Link
                      href={`/lawfirm/${id}/messages`}
                      onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/messages`); }}
                      className="mt-3 inline-flex items-center gap-1.5 bg-accent-foreground/15 px-3 py-1.5 rounded-lg text-xs font-medium backdrop-blur-sm hover:bg-accent-foreground/25 transition-colors cursor-pointer"
                    >
                      <MessageSquare size={13} />
                      {unreadCount} unread message{unreadCount !== 1 ? "s" : ""}
                    </Link>
                  )}
                </div>
              </div>
            )}
          </SortableWidget>
        );

      case "stats":
        return (
          <SortableWidget key="stats" id="stats" {...sharedProps} onEdit={() => setStatPickerOpen((o) => !o)}>
            <div className="relative">
              <p className={`font-semibold text-on-surface-secondary uppercase tracking-[0.1em] mb-4 ${compact ? "text-[10px]" : "text-[10px]"}`}>Stats</p>
              {/* Stat card picker popover */}
              {editMode && statPickerMounted && (
                <div ref={statPickerRef} className={`absolute top-0 right-0 z-50 w-72 bg-surface border border-outline-subtle rounded-xl shadow-xl shadow-black/10 p-4 origin-top-right ${menuAnim(statPickerExiting)}`}>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-semibold text-on-surface">Choose cards</p>
                    <button onClick={() => setStatPickerOpen(false)} className="p-1 rounded-md text-on-surface-muted hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer">
                      <X size={14} />
                    </button>
                  </div>
                  <p className="text-[10px] text-on-surface-muted mb-3">Select up to 6 stats to display.</p>
                  <div className="space-y-1">
                    {(Object.keys(STAT_CARD_LABELS) as StatCardKey[]).map((key) => {
                      const entry = statCardRegistry[key];
                      const isSelected = selectedStatCards.includes(key);
                      const atMax = selectedStatCards.length >= 6 && !isSelected;
                      return (
                        <button
                          key={key}
                          onClick={() => handleToggleStatCard(key)}
                          disabled={atMax}
                          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors cursor-pointer ${
                            isSelected
                              ? "bg-accent-soft dark:bg-accent-soft text-accent-emphasis dark:text-accent-emphasis"
                              : atMax
                                ? "opacity-40 cursor-not-allowed"
                                : "hover:bg-surface-hover text-on-surface-secondary"
                          }`}
                        >
                          <entry.icon size={14} className="flex-shrink-0" />
                          <span className="text-xs font-medium flex-1">{entry.label}</span>
                          {isSelected && <Check size={14} className="text-accent-emphasis flex-shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Rendered stat cards */}
              <div className={compact ? "space-y-3" : "flex flex-col gap-3 md:grid"} style={!compact ? { gridTemplateColumns: `repeat(${selectedStatCards.length === 4 ? 2 : Math.min(selectedStatCards.length || 1, 3)}, minmax(0, 1fr))` } : undefined}>
                {selectedStatCards.map((key) => {
                  const entry = statCardRegistry[key];
                  if (!entry) return null;
                  return (
                    <StatCard
                      key={key}
                      icon={entry.icon}
                      label={entry.label}
                      value={entry.value}
                      accent={entry.accent}
                      compact={compact}
                      loading={!dataLoaded}
                      onClick={entry.link ? () => navigate(entry.link!) : undefined}
                    />
                  );
                })}
              </div>
            </div>
          </SortableWidget>
        );

      case "recentMatters":
        if (!canViewMatters) return null;
        return (
          <SortableWidget key="recentMatters" id="recentMatters" {...sharedProps}>
            <div>
              <div className="flex items-center justify-between mb-4">
                <SectionLabel tone="secondary">Recent Matters</SectionLabel>
                <Link href={`/lawfirm/${id}/matters`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/matters`); }} className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover flex items-center gap-1 transition-colors">
                  See all <ChevronRight size={14} />
                </Link>
              </div>
              {!dataLoaded ? (
                <div className={`bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden ${compact ? "" : "p-5"}`}>
                  <div className={compact ? "divide-y divide-outline-subtle" : "grid grid-cols-1 md:grid-cols-2 gap-4"}>
                    {[1, 2, 3, 4].slice(0, compact ? 3 : 4).map((i) => (
                      <div key={i} className={`animate-pulse ${compact ? "px-4 py-2.5" : ""}`}>
                        <div className="h-3.5 bg-surface-alt rounded w-3/4 mb-2" />
                        <div className="h-2.5 bg-surface-alt rounded w-1/2" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : mattersSectionFailed ? (
                renderWidgetError("Couldn't load matters", compact)
              ) : recentMatters.length === 0 ? (
                <div className={`bg-surface rounded-2xl border border-outline-subtle text-center shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${compact ? "p-5" : "p-8"}`}>
                  <Briefcase size={compact ? 24 : 32} className="text-on-surface-secondary mx-auto mb-2" />
                  <p className="text-sm text-on-surface-secondary mb-1">No matters yet</p>
                </div>
              ) : compact ? (
                /* Compact: simple list */
                <Card>
                  {recentMatters.map((c) => {
                    const status = matterStatusMeta(c.status);
                    return (
                      <Link key={c.id} href={`/lawfirm/${id}/matters/${c.id}`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/matters/${c.id}`); }} className="flex items-center gap-2 px-4 py-2.5 border-b border-outline-subtle last:border-b-0 hover:bg-surface-hover transition-colors group">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-on-surface truncate group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors">{c.name}</p>
                        </div>
                        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-md flex-shrink-0 ${styleOf(status).tint} ${styleOf(status).text}`}>{status.label}</span>
                      </Link>
                    );
                  })}
                </Card>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {recentMatters.map((c) => {
                    const status = matterStatusMeta(c.status);
                    return (
                      <Link key={c.id} href={`/lawfirm/${id}/matters/${c.id}`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/matters/${c.id}`); }} className="group bg-surface rounded-2xl border border-outline-subtle p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] hover:shadow-md hover:border-accent-border-soft dark:hover:border-accent-border-soft transition-all duration-200">
                        <div className="flex items-start justify-between mb-3">
                          <h3 className="text-sm font-semibold text-on-surface group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors truncate pr-3">{c.name}</h3>
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md flex-shrink-0 ${styleOf(status).tint} ${styleOf(status).text}`}>{status.label}</span>
                        </div>
                        {c.matterReferenceId && <p className="text-[11px] text-on-surface-muted font-mono mb-1.5">{c.matterReferenceId}</p>}
                        <div className="flex items-center justify-between mt-2">
                          <div className="flex items-center gap-1.5">
                            {c.clients && c.clients.length > 0 ? (
                              <span className="text-[11px] text-on-surface-secondary truncate max-w-[140px]">{c.clients[0].name}{c.clients.length > 1 && ` +${c.clients.length - 1}`}</span>
                            ) : (
                              <span className="text-[11px] text-on-surface-muted">No client</span>
                            )}
                          </div>
                          <span className="text-[10px] text-on-surface-muted">{formatRelativeDay(c.updatedAt)}</span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </SortableWidget>
        );

      case "upcomingTasks":
        if (!canViewTasks) return null;
        return (
          <SortableWidget key="upcomingTasks" id="upcomingTasks" {...sharedProps}>
            <div>
              <div className="flex items-center justify-between mb-4">
                <SectionLabel tone="secondary">Tasks: Next 7 Days</SectionLabel>
                <Link href={`/lawfirm/${id}/tasks`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/tasks`); }} className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover flex items-center gap-1 transition-colors">
                  See all <ChevronRight size={14} />
                </Link>
              </div>
              {!dataLoaded ? (
                <div className={`bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden ${compact ? "" : "p-5"}`}>
                  <div className={compact ? "divide-y divide-outline-subtle" : "space-y-3"}>
                    {[1, 2, 3].map((i) => (
                      <div key={i} className={`animate-pulse ${compact ? "px-4 py-2.5" : ""}`}>
                        <div className="h-3.5 bg-surface-alt rounded w-2/3 mb-2" />
                        <div className="h-2.5 bg-surface-alt rounded w-1/3" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : upcomingTasksSectionFailed ? (
                renderWidgetError("Couldn't load tasks", compact)
              ) : tasksByDay.length === 0 ? (
                <div className={`bg-surface rounded-2xl border border-outline-subtle text-center shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${compact ? "p-5" : "p-8"}`}>
                  <ClipboardCheck size={compact ? 24 : 32} className="text-on-surface-secondary mx-auto mb-2" />
                  <p className="text-sm text-on-surface-secondary mb-1">No upcoming tasks</p>
                </div>
              ) : compact ? (
                /* Compact: flat list of tasks */
                <Card>
                  {tasksByDay.flatMap((group) =>
                    group.tasks.slice(0, 3).map((task) => {
                      const priority = styleOf(taskPriorityMeta(task.priority));
                      return (
                        <button key={task.taskId || task.id} type="button" onClick={() => setSelectedTask(task)} className="w-full text-left flex items-center gap-2 px-4 py-2.5 border-b border-outline-subtle last:border-b-0 hover:bg-surface-hover transition-colors group cursor-pointer">
                          <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priority.dot}`} />
                          <span className="text-xs text-on-surface font-medium truncate flex-1 group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors">{task.title}</span>
                          <span className="text-[10px] text-on-surface-muted flex-shrink-0">{formatDueDate(task.dueDate)}</span>
                        </button>
                      );
                    })
                  ).slice(0, 6)}
                </Card>
              ) : (
                <div className="space-y-4">
                  {tasksByDay.map((group) => {
                    const dayHref = `/lawfirm/${id}/tasks?${group.dueQuery}`;
                    return (
                    <Card key={group.dateKey}>
                      <Link href={dayHref} onClick={(e) => { e.preventDefault(); navigate(dayHref); }} className="px-5 py-3 border-b border-outline-subtle bg-surface-alt/50 flex items-center justify-between hover:bg-surface-hover transition-colors group/day">
                        <span className="text-xs font-semibold text-on-surface group-hover/day:text-accent-emphasis dark:group-hover/day:text-accent-emphasis transition-colors">{group.label}</span>
                        <span className="text-[10px] text-on-surface-muted font-medium">{group.tasks.length} task{group.tasks.length !== 1 ? "s" : ""}</span>
                      </Link>
                      {group.tasks.slice(0, TASKS_PER_DAY_LIMIT).map((task) => {
                        const priority = styleOf(taskPriorityMeta(task.priority));
                        return (
                          <button key={task.taskId || task.id} type="button" onClick={() => setSelectedTask(task)} className="w-full text-left flex items-center gap-3 px-5 py-3.5 border-b border-outline-subtle last:border-b-0 hover:bg-surface-hover transition-colors group cursor-pointer">
                            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${priority.dot}`} />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm text-on-surface font-medium truncate block group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors">{task.title}</span>
                              {task.matterName && <span className="text-[11px] text-on-surface-muted truncate block">{task.matterName}</span>}
                            </div>
                            {/* Percentage rather than a fixed cap: the task title
                                beside this is flex-1, so widening the column
                                unconditionally would cost every row title width,
                                whether or not the assignee name needed it. */}
                            <span className="text-xs text-on-surface-secondary truncate flex-shrink-0 max-w-[min(160px,30%)]">{(Array.isArray(task.assignedToName) ? task.assignedToName.filter(Boolean).join(', ') : task.assignedToName) || "Unassigned"}</span>
                            <span className="text-[11px] text-on-surface-muted flex-shrink-0 whitespace-nowrap">{formatDueDate(task.dueDate)}</span>
                          </button>
                        );
                      })}
                      {group.tasks.length > TASKS_PER_DAY_LIMIT && (
                        <Link href={dayHref} onClick={(e) => { e.preventDefault(); navigate(dayHref); }} className="w-full text-center block px-5 py-2.5 text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover hover:bg-surface-hover transition-colors">
                          +{group.tasks.length - TASKS_PER_DAY_LIMIT} more
                        </Link>
                      )}
                    </Card>
                    );
                  })}
                </div>
              )}
            </div>
          </SortableWidget>
        );

      case "myAssignments":
        if (!canViewTasks) return null;
        return (
          <SortableWidget key="myAssignments" id="myAssignments" {...sharedProps}>
            <div>
              <div className="flex items-center justify-between mb-4">
                <SectionLabel tone="secondary">My Assignments</SectionLabel>
                <Link href={`/lawfirm/${id}/tasks`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/tasks`); }} className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover flex items-center gap-1 transition-colors">
                  View All <ChevronRight size={14} />
                </Link>
              </div>
              {myAssignmentsLoading ? (
                <Card>
                  <div className={compact ? "divide-y divide-outline-subtle" : "p-5 space-y-3"}>
                    {[1, 2, 3].map((i) => (
                      <div key={i} className={`animate-pulse ${compact ? "px-4 py-2.5" : ""}`}>
                        <div className="h-3.5 bg-surface-alt rounded w-2/3 mb-2" />
                        <div className="h-2.5 bg-surface-alt rounded w-1/3" />
                      </div>
                    ))}
                  </div>
                </Card>
              ) : myAssignmentsSectionFailed ? (
                renderWidgetError("Couldn't load assignments", compact)
              ) : combinedAssignments.length === 0 ? (
                <div className={`bg-surface rounded-2xl border border-outline-subtle text-center shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${compact ? "p-5" : "p-8"}`}>
                  <ClipboardCheck size={compact ? 24 : 32} className="text-on-surface-secondary mx-auto mb-2" />
                  <p className="text-sm text-on-surface-secondary mb-1">No assignments</p>
                  <p className="text-xs text-on-surface-muted">You&apos;re all caught up!</p>
                </div>
              ) : (
                <Card>
                  {combinedAssignments.map((item) => {
                    const title = item.data.title;
                    const matterName = item.data.matterName;
                    const priority = item.data.priority || 'medium';
                    const pConfig = styleOf(taskPriorityMeta(priority));
                    const dueDate = item.data.dueDate;
                    const itemId = item.data.taskId || item.data.id;

                    return (
                      <button
                        key={`${item.type}-${itemId}`}
                        type="button"
                        onClick={() => setSelectedTask(item.data)}
                        className="w-full text-left flex items-center gap-2 px-4 py-2.5 border-b border-outline-subtle last:border-b-0 hover:bg-surface-hover transition-colors group cursor-pointer"
                      >
                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${pConfig.dot}`} />
                        <span className="text-[10px] font-medium uppercase px-1.5 py-0.5 rounded flex-shrink-0 bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis">
                          Task
                        </span>
                        <div className="flex-1 min-w-0">
                          <span className="text-xs text-on-surface font-medium truncate block group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors">{title}</span>
                          {matterName && <span className="text-[10px] text-on-surface-muted truncate block">{matterName}</span>}
                        </div>
                        {dueDate && (
                          <span className="text-[10px] text-on-surface-muted flex-shrink-0">{formatDueDate(dueDate)}</span>
                        )}
                      </button>
                    );
                  })}
                </Card>
              )}
            </div>
          </SortableWidget>
        );

      case "messages":
        if (!canViewMessages) return null;
        return (
          <SortableWidget key="messages" id="messages" {...sharedProps}>
            <div>
              <div className="flex items-center justify-between mb-4">
                <SectionLabel tone="secondary">Messages</SectionLabel>
                <Link href={`/lawfirm/${id}/messages`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/messages`); }} className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover flex items-center gap-1 transition-colors">
                  See all <ChevronRight size={14} />
                </Link>
              </div>
              {!dataLoaded ? (
                <div className="bg-surface rounded-2xl border border-outline-subtle p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] animate-pulse">
                  <div className="space-y-4">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="flex items-center gap-3">
                        <div className={`${compact ? "w-7 h-7" : "w-9 h-9"} bg-surface-alt rounded-full`} />
                        <div className="flex-1">
                          <div className="h-3 bg-surface-alt rounded w-32 mb-1.5" />
                          {!compact && <div className="h-2.5 bg-surface-alt rounded w-48" />}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : messagingSectionFailed ? (
                renderWidgetError("Couldn't load messages", compact)
              ) : recentConversations.length === 0 ? (
                <div className={`bg-surface rounded-2xl border border-outline-subtle text-center shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${compact ? "p-5" : "p-8"}`}>
                  <MessageSquare size={compact ? 24 : 32} className="text-on-surface-secondary mx-auto mb-2" />
                  <p className="text-sm text-on-surface-secondary mb-1">No messages yet</p>
                </div>
              ) : compact ? (
                /* Compact: avatar + name + time */
                <Card>
                  {recentConversations.map((conv) => {
                    const hasUnread = conv.unreadCountFirm > 0;
                    return (
                      <Link key={conv.conversationId} href={`/lawfirm/${id}/messages/${conv.conversationId}`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/messages/${conv.conversationId}`); }} className="flex items-center gap-2.5 px-4 py-2.5 border-b border-outline-subtle last:border-b-0 hover:bg-surface-hover transition-colors group">
                        <Avatar size="xs" photoUrl={(conv as any).clientPhotoUrl} name={conv.clientName} />
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs truncate ${hasUnread ? "font-semibold text-on-surface" : "font-medium text-on-surface"} group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors`}>{conv.clientName}</p>
                        </div>
                        {hasUnread && (
                          <span className="flex items-center justify-center min-w-[18px] h-4 px-1 text-[9px] font-bold text-accent-foreground bg-accent-solid rounded-full flex-shrink-0">{conv.unreadCountFirm > 99 ? "99+" : conv.unreadCountFirm}</span>
                        )}
                        <span className="text-[10px] text-on-surface-muted flex-shrink-0">{formatRelativeDay(conv.lastMessageAt as string)}</span>
                      </Link>
                    );
                  })}
                </Card>
              ) : (
                <div className="space-y-3">
                  {recentConversations.map((conv) => {
                    const hasUnread = conv.unreadCountFirm > 0;
                    return (
                      <Link key={conv.conversationId} href={`/lawfirm/${id}/messages/${conv.conversationId}`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/messages/${conv.conversationId}`); }} className="group flex items-center gap-3.5 px-5 py-4 bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] hover:shadow-md hover:border-accent-border-soft dark:hover:border-accent-border-soft transition-all duration-200">
                        <Avatar size="sm" photoUrl={(conv as any).clientPhotoUrl} name={conv.clientName} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <p className={`text-sm truncate pr-2 ${hasUnread ? "font-semibold text-on-surface" : "font-medium text-on-surface"} group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors`}>{conv.clientName}</p>
                            <span className="text-[10px] text-on-surface-muted whitespace-nowrap flex-shrink-0">{formatRelativeDay(conv.lastMessageAt as string)}</span>
                          </div>
                          <p className={`text-xs truncate ${hasUnread ? "text-on-surface-secondary" : "text-on-surface-muted"}`}>{conv.lastMessagePreview || "No messages yet"}</p>
                        </div>
                        {hasUnread && (
                          <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[10px] font-bold text-accent-foreground bg-accent-solid rounded-full flex-shrink-0">{conv.unreadCountFirm > 99 ? "99+" : conv.unreadCountFirm}</span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </SortableWidget>
        );

      case "pendingSignatures":
        if (!signingEnabled) return null;
        return (
          <SortableWidget key="pendingSignatures" id="pendingSignatures" {...sharedProps}>
            <div className={`rounded-2xl border border-accent-border-soft bg-surface ${compact ? "p-4" : "p-5"} space-y-4`}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-xl bg-accent-soft dark:bg-accent-soft flex items-center justify-center flex-shrink-0">
                    <PenLine size={17} className="text-accent-emphasis dark:text-accent-emphasis" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-on-surface">Pending Signatures</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-accent-solid px-2 text-xs font-semibold text-accent-foreground">
                    {pendingSignatures.length}
                  </span>
                  {/* The list above shows the first few; the count beside it is the
                      real total, so without this the rest were visible as a number
                      and unreachable. Violet rather than the dashboard's indigo to
                      match this card's own accent. */}
                  <Link
                    href={`/lawfirm/${id}/signatures`}
                    onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/signatures`); }}
                    className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis dark:text-accent-emphasis dark:hover:text-accent-emphasis flex items-center gap-1 transition-colors"
                  >
                    See all <ChevronRight size={14} />
                  </Link>
                </div>
              </div>

              {pendingSignaturesLoading ? (
                <div className="space-y-2">
                  {[0, 1].map((index) => (
                    <div key={index} className="h-16 rounded-xl bg-white/70 dark:bg-white/5 animate-pulse" />
                  ))}
                </div>
              ) : signaturesSectionFailed && pendingSignatures.length === 0 ? (
                <div className="rounded-xl border border-dashed border-accent-border-soft dark:border-accent-border-soft px-4 py-5 text-center">
                  <AlertTriangle size={24} className="text-amber-500 mx-auto mb-2" />
                  <p className="text-sm text-on-surface-secondary mb-2">Couldn&apos;t load signatures</p>
                  <button
                    type="button"
                    onClick={() => { void refetchSummary(); }}
                    className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis dark:text-accent-emphasis transition-colors"
                  >
                    Retry
                  </button>
                </div>
              ) : pendingSignatures.length === 0 ? (
                <div className="rounded-xl border border-dashed border-accent-border-soft dark:border-accent-border-soft px-4 py-5 text-sm text-on-surface-muted">
                  Nothing needs your signature right now.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {pendingSignatures.slice(0, compact ? 2 : 4).map((item) => (
                    <div
                      key={item.sessionToken}
                      className="rounded-xl border border-white/80 dark:border-white/5 bg-white/80 dark:bg-white/5 px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-on-surface truncate">{item.fileName}</p>
                          <p className="text-xs text-on-surface-muted mt-1">
                            {item.participantRole} · {item.completedParticipants} of {item.totalParticipants} signed
                            {item.routingMode === "parallel" ? " (parallel)" : ""}
                          </p>
                        </div>
                        <button
                          onClick={() => navigate(`/signature?token=${encodeURIComponent(item.publicToken || item.sessionToken)}`)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-accent-solid px-3 py-1.5 text-xs font-medium text-accent-foreground hover:bg-accent-solid-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                        >
                          <PenLine size={12} />
                          Sign Now
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SortableWidget>
        );

      case "team":
        if (!canViewMembers) return null;
        return (
          <SortableWidget key="team" id="team" {...sharedProps}>
            <div>
              <div className="flex items-center justify-between mb-4">
                <SectionLabel tone="secondary">Your Team</SectionLabel>
                <Link href={`/lawfirm/${id}/settings/members`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/settings/members`); }} className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover flex items-center gap-1 transition-colors">
                  See all <ChevronRight size={14} />
                </Link>
              </div>
              {teamLoading ? (
                <div className={`bg-surface rounded-2xl border border-outline-subtle p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${compact ? "space-y-3" : "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"}`}>
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex items-center gap-3 animate-pulse">
                      <div className={`${compact ? "w-7 h-7" : "w-8 h-8"} bg-surface-alt rounded-full`} />
                      <div className="flex-1">
                        <div className="h-3 bg-surface-alt rounded w-24 mb-1" />
                        <div className="h-2.5 bg-surface-alt rounded w-16" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : teamSectionFailed ? (
                renderWidgetError("Couldn't load team", compact)
              ) : teamMembers.length === 0 ? (
                <div className={`bg-surface rounded-2xl border border-outline-subtle text-center shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${compact ? "p-5" : "p-8"}`}>
                  <Users size={compact ? 24 : 32} className="text-on-surface-secondary mx-auto mb-2" />
                  <p className="text-sm text-on-surface-secondary mb-1">No team members yet</p>
                </div>
              ) : (
                <div className={`bg-surface rounded-2xl border border-outline-subtle p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${compact ? "space-y-2" : "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"}`}>
                  {sortedTeamMembers.map((member) => {
                    const isCurrentUser = user && (member.uid === user.uid || member.email === user.email);
                    const roleStr = member.role || "member";
                    const roleLabel = roleStr.charAt(0).toUpperCase() + roleStr.slice(1);
                    return (
                      <div key={member.uid} className="flex items-center gap-3 py-1">
                        <Avatar size={compact ? "xs" : "sm"} photoUrl={member.photoUrl} name={member.name} email={member.email} />

                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-on-surface truncate">
                            {member.name || "Unnamed"}{isCurrentUser ? " (You)" : ""}
                          </p>
                          <RoleBadge roleName={roleLabel} className="mt-0.5" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </SortableWidget>
        );

      case "financial": {
        if (!canViewInvoices) return null;
        const figures = [
          { label: "Outstanding A/R", value: formatCentsFull(stats?.outstandingArCents), color: "text-on-surface" },
          { label: "Overdue", value: formatCentsFull(stats?.overdueInvoiceCents), color: "text-rose-600 dark:text-rose-400", sub: (stats?.overdueInvoiceCount ?? 0) > 0 ? `${stats?.overdueInvoiceCount} invoice${(stats?.overdueInvoiceCount ?? 0) !== 1 ? "s" : ""}` : undefined },
          { label: "Collected this month", value: formatCentsFull(stats?.collectedThisMonthCents), color: "text-emerald-600 dark:text-emerald-400" },
          { label: "Unbilled WIP", value: formatCentsFull(stats?.unbilledWipCents), color: "text-on-surface", sub: (stats?.unbilledHours ?? 0) > 0 ? `${formatHours(stats?.unbilledHours)} unbilled` : undefined },
        ];
        return (
          <SortableWidget key="financial" id="financial" {...sharedProps}>
            <div>
              <div className="flex items-center justify-between mb-4">
                <SectionLabel tone="secondary">Financial Snapshot</SectionLabel>
                <Link href={`/lawfirm/${id}/billing`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/billing`); }} className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover flex items-center gap-1 transition-colors">
                  Billing <ChevronRight size={14} />
                </Link>
              </div>
              {!dataLoaded ? (
                <div className="bg-surface rounded-2xl border border-outline-subtle p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                  <div className="grid grid-cols-2 gap-4 animate-pulse">
                    {[1, 2, 3, 4].map((i) => (
                      <div key={i}>
                        <div className="h-2.5 bg-surface-alt rounded w-20 mb-2" />
                        <div className="h-4 bg-surface-alt rounded w-24" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : financialSectionFailed ? (
                renderWidgetError("Couldn't load financials", compact)
              ) : (
                <Card>
                  <div className="grid grid-cols-2 divide-x divide-y divide-outline-subtle">
                    {figures.map((f) => (
                      <div key={f.label} className="px-4 py-3.5">
                        <p className="text-[10px] font-medium text-on-surface-muted uppercase tracking-wide mb-1">{f.label}</p>
                        <p className={`text-base font-bold leading-none ${f.color}`}>{f.value}</p>
                        {/* Always render the sub-line slot (non-breaking space when empty) so
                            every cell is the same height regardless of which figures have a sub. */}
                        <p className="text-[10px] text-on-surface-muted mt-1">{f.sub || " "}</p>
                      </div>
                    ))}
                  </div>
                  {agingInvoicesData.length > 0 && (
                    <div className="border-t border-outline-subtle">
                      <SectionLabel className="px-4 pt-3 pb-1.5">Oldest Overdue</SectionLabel>
                      {agingInvoicesData.slice(0, compact ? 3 : 6).map((inv) => (
                        <Link
                          key={inv.id}
                          href={`/lawfirm/${id}/billing`}
                          onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/billing`); }}
                          className="flex items-center gap-3 px-4 py-2.5 border-t border-outline-subtle hover:bg-surface-hover transition-colors group"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-on-surface truncate group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors">{inv.clientName}</p>
                            {inv.invoiceNumber && <p className="text-[10px] text-on-surface-muted font-mono truncate">{inv.invoiceNumber}</p>}
                          </div>
                          <span className="text-[10px] font-semibold text-rose-600 dark:text-rose-400 flex-shrink-0">{inv.daysOverdue}d</span>
                          <span className="text-xs font-semibold text-on-surface flex-shrink-0 whitespace-nowrap">{formatCentsFull(inv.balanceDueCents)}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </Card>
              )}
            </div>
          </SortableWidget>
        );
      }

      case "upcomingPayments": {
        if (!canViewInvoices) return null;
        return (
          <SortableWidget key="upcomingPayments" id="upcomingPayments" {...sharedProps}>
            <div>
              <div className="flex items-center justify-between mb-4">
                <SectionLabel tone="secondary">Upcoming Payments</SectionLabel>
                <Link href={`/lawfirm/${id}/billing`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/billing`); }} className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover flex items-center gap-1 transition-colors">
                  Billing <ChevronRight size={14} />
                </Link>
              </div>
              {!dataLoaded ? (
                <Card>
                  <div className="divide-y divide-outline-subtle">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="animate-pulse px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="h-5 w-20 bg-surface-alt rounded-full" />
                          <div className="flex-1">
                            <div className="h-3 bg-surface-alt rounded w-1/2 mb-1.5" />
                            <div className="h-2.5 bg-surface-alt rounded w-1/3" />
                          </div>
                          <div className="h-3.5 bg-surface-alt rounded w-16" />
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              ) : upcomingPaymentsSectionFailed ? (
                renderWidgetError("Couldn't load upcoming payments", compact)
              ) : upcomingPaymentsData.length === 0 ? (
                <div className={`bg-surface rounded-2xl border border-outline-subtle text-center shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${compact ? "p-5" : "p-8"}`}>
                  <Check size={compact ? 24 : 32} className="text-emerald-500 mx-auto mb-2" />
                  <p className="text-sm text-on-surface-secondary mb-1">No upcoming payments</p>
                  <p className="text-xs text-on-surface-muted">All invoices are paid or have no due date.</p>
                </div>
              ) : (
                <Card>
                  {upcomingPaymentsData.slice(0, compact ? 4 : WIDGET_ROW_LIMIT).map((inv) => {
                    const days = inv.daysRelative;
                    let urgencyLabel: string;
                    let urgencyClasses: string;
                    if (days > 0) {
                      urgencyLabel = days === 1 ? "1d overdue" : `${days}d overdue`;
                      urgencyClasses = "bg-rose-50 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400";
                    } else if (days === 0) {
                      urgencyLabel = "Due Today";
                      urgencyClasses = "bg-amber-50 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400";
                    } else if (days === -1) {
                      urgencyLabel = "Due Tomorrow";
                      urgencyClasses = "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300";
                    } else {
                      const d = new Date(inv.dueDate + "T00:00:00");
                      urgencyLabel = `Due ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
                      urgencyClasses = "bg-surface-alt text-on-surface-secondary";
                    }
                    return (
                      <button
                        key={inv.id}
                        type="button"
                        onClick={() => setSelectedPayment(inv)}
                        className="w-full text-left flex items-center gap-3 px-4 py-3 border-b border-outline-subtle last:border-b-0 hover:bg-surface-hover transition-colors group cursor-pointer"
                      >
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap flex-shrink-0 ${urgencyClasses}`}>
                          {urgencyLabel}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-on-surface truncate group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors">{inv.clientName}</p>
                          {inv.invoiceNumber && <p className="text-[10px] text-on-surface-muted font-mono truncate">{inv.invoiceNumber}</p>}
                        </div>
                        <span className="text-xs font-semibold text-on-surface flex-shrink-0 whitespace-nowrap">{formatCentsFull(inv.balanceDueCents)}</span>
                      </button>
                    );
                  })}
                </Card>
              )}
            </div>
          </SortableWidget>
        );
      }

      case "upcomingEvents":
        if (!canViewCalendar) return null;
        return (
          <SortableWidget key="upcomingEvents" id="upcomingEvents" {...sharedProps}>
            <div>
              <div className="flex items-center justify-between mb-4">
                <SectionLabel tone="secondary">Upcoming Events: Next 7 Days</SectionLabel>
                <Link href={`/lawfirm/${id}/calendar`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/calendar`); }} className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover flex items-center gap-1 transition-colors">
                  Calendar <ChevronRight size={14} />
                </Link>
              </div>
              {!dataLoaded ? (
                <div className="bg-surface rounded-2xl border border-outline-subtle p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                  <div className="space-y-3 animate-pulse">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-surface-alt rounded-lg" />
                        <div className="flex-1">
                          <div className="h-3 bg-surface-alt rounded w-2/3 mb-1.5" />
                          <div className="h-2.5 bg-surface-alt rounded w-1/3" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : eventsSectionFailed ? (
                renderWidgetError("Couldn't load events", compact)
              ) : upcomingEventsData.length === 0 ? (
                <div className={`bg-surface rounded-2xl border border-outline-subtle text-center shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${compact ? "p-5" : "p-8"}`}>
                  <CalendarClock size={compact ? 24 : 32} className="text-on-surface-secondary mx-auto mb-2" />
                  <p className="text-sm text-on-surface-secondary mb-1">No upcoming events</p>
                </div>
              ) : (
                <Card>
                  {upcomingEventsData.slice(0, compact ? 4 : 8).map((ev) => {
                    const context = ev.source === "matter" ? ev.matterName : ev.clientName;
                    const href = ev.source === "matter" && ev.matterId ? `/lawfirm/${id}/matters/${ev.matterId}` : `/lawfirm/${id}/calendar`;
                    return (
                      <Link
                        key={`${ev.source}-${ev.id}`}
                        href={href}
                        onClick={(e) => { e.preventDefault(); navigate(href); }}
                        className="flex items-center gap-3 px-4 py-3 border-b border-outline-subtle last:border-b-0 hover:bg-surface-hover transition-colors group"
                      >
                        <div className="w-8 h-8 rounded-lg bg-accent-soft dark:bg-accent-soft flex items-center justify-center flex-shrink-0">
                          <CalendarClock size={15} className="text-accent-emphasis" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-on-surface truncate group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors">{ev.title}</p>
                          <p className="text-[10px] text-on-surface-muted truncate">
                            {ev.type ? matterEventTypeMeta(ev.type).label : ev.source === "matter" ? "Matter event" : "Client event"}
                            {context ? ` · ${context}` : ""}
                            {ev.locationName ? ` · ${ev.locationName}` : ""}
                          </p>
                        </div>
                        <span className="text-[10px] text-on-surface-muted flex-shrink-0 whitespace-nowrap text-right">{formatAgendaWhen(ev.date, ev.allDay === true)}</span>
                      </Link>
                    );
                  })}
                </Card>
              )}
            </div>
          </SortableWidget>
        );

      case "calendar":
        if (!canViewCalendar) return null;
        return (
          <SortableWidget key="calendar" id="calendar" {...sharedProps}>
            <DashboardCalendarWidget lawFirmId={id} compact={compact} onNavigate={navigate} />
          </SortableWidget>
        );

      case "overdueItems":
        if (!canViewTasks) return null;
        return (
          <SortableWidget key="overdueItems" id="overdueItems" {...sharedProps}>
            <div>
              <div className="flex items-center justify-between mb-4">
                <SectionLabel tone="secondary">Overdue Tasks</SectionLabel>
                <Link href={`/lawfirm/${id}/tasks`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/tasks`); }} className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover flex items-center gap-1 transition-colors">
                  See all <ChevronRight size={14} />
                </Link>
              </div>
              {!dataLoaded ? (
                <Card>
                  <div className="divide-y divide-outline-subtle">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="animate-pulse px-4 py-2.5">
                        <div className="h-3.5 bg-surface-alt rounded w-2/3 mb-2" />
                        <div className="h-2.5 bg-surface-alt rounded w-1/3" />
                      </div>
                    ))}
                  </div>
                </Card>
              ) : overdueTasksSectionFailed ? (
                renderWidgetError("Couldn't load overdue tasks", compact)
              ) : overdueTasksData.length === 0 ? (
                <div className={`bg-surface rounded-2xl border border-outline-subtle text-center shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${compact ? "p-5" : "p-8"}`}>
                  <Check size={compact ? 24 : 32} className="text-emerald-500 mx-auto mb-2" />
                  <p className="text-sm text-on-surface-secondary mb-1">Nothing overdue</p>
                  <p className="text-xs text-on-surface-muted">You&apos;re on top of your deadlines.</p>
                </div>
              ) : (
                <div className="bg-surface rounded-2xl border border-rose-200/70 dark:border-rose-500/20 shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden">
                  {overdueTasksData.slice(0, compact ? 4 : 8).map((task) => {
                    const priority = styleOf(taskPriorityMeta(task.priority));
                    const taskHref = `/lawfirm/${id}/tasks/${task.taskId || task.id}`;
                    return (
                      <Link key={task.taskId || task.id} href={taskHref} onClick={(e) => { e.preventDefault(); navigate(taskHref); }} className="flex items-center gap-3 px-4 py-3 border-b border-outline-subtle last:border-b-0 hover:bg-surface-hover transition-colors group">
                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priority.dot}`} />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs text-on-surface font-medium truncate block group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors">{task.title}</span>
                          {task.matterName && <span className="text-[10px] text-on-surface-muted truncate block">{task.matterName}</span>}
                        </div>
                        <span className="text-[10px] font-semibold text-rose-600 dark:text-rose-400 flex-shrink-0 whitespace-nowrap">{formatDueDate(task.dueDate)}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </SortableWidget>
        );

      case "myTime": {
        if (!canViewTimeEntries) return null;
        const timerRunning = billingTimer.isRunning;
        const timerActive = billingTimer.isActive;
        return (
          <SortableWidget key="myTime" id="myTime" {...sharedProps}>
            <div>
              <div className="flex items-center justify-between mb-4">
                <SectionLabel tone="secondary">My Time</SectionLabel>
                <Link href={`/lawfirm/${id}/billing`} onClick={(e) => { e.preventDefault(); navigate(`/lawfirm/${id}/billing`); }} className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover flex items-center gap-1 transition-colors">
                  Billing <ChevronRight size={14} />
                </Link>
              </div>
              {!dataLoaded ? (
                <div className="bg-surface rounded-2xl border border-outline-subtle p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                  <div className="animate-pulse space-y-3">
                    <div className="h-8 bg-surface-alt rounded w-full" />
                    <div className="h-3 bg-surface-alt rounded w-1/2" />
                  </div>
                </div>
              ) : (
                <Card>
                  {/* Hours figures */}
                  <div className="grid grid-cols-2 divide-x divide-outline-subtle">
                    <div className="px-4 py-3.5 text-center">
                      <p className="text-xl font-bold text-on-surface leading-none">{formatHours(stats?.hoursToday)}</p>
                      <p className="text-[10px] text-on-surface-muted uppercase tracking-wide mt-1">Today</p>
                    </div>
                    <div className="px-4 py-3.5 text-center">
                      <p className="text-xl font-bold text-on-surface leading-none">{formatHours(stats?.hoursThisWeek)}</p>
                      <p className="text-[10px] text-on-surface-muted uppercase tracking-wide mt-1">This Week</p>
                    </div>
                  </div>
                  {/* Timer control */}
                  <div className="border-t border-outline-subtle px-4 py-3">
                    {timerActive ? (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-on-surface tabular-nums leading-none">{billingTimer.formattedTime}</p>
                          {billingTimer.targetLabel && <p className="text-[10px] text-on-surface-muted truncate mt-0.5">{billingTimer.targetLabel}</p>}
                        </div>
                        {timerRunning ? (
                          <Tooltip title="Pause timer" enterDelay={300}>
                            <button aria-label="Pause timer" onClick={() => billingTimer.pauseTimer()} className="w-8 h-8 rounded-lg bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center hover:bg-amber-100 dark:hover:bg-amber-500/25 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer">
                              <Pause size={15} />
                            </button>
                          </Tooltip>
                        ) : (
                          <Tooltip title="Resume timer" enterDelay={300}>
                            <button aria-label="Resume timer" onClick={() => billingTimer.resumeTimer()} className="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center hover:bg-emerald-100 dark:hover:bg-emerald-500/25 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer">
                              <Play size={15} />
                            </button>
                          </Tooltip>
                        )}
                        <Tooltip title="Stop & log time" enterDelay={300}>
                          <button aria-label="Stop & log time" onClick={() => billingTimer.stopTimer()} className="w-8 h-8 rounded-lg bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-400 flex items-center justify-center hover:bg-rose-100 dark:hover:bg-rose-500/25 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer">
                            <Square size={14} />
                          </button>
                        </Tooltip>
                      </div>
                    ) : (
                      <button onClick={() => billingTimer.openTargetPicker()} className="w-full inline-flex items-center justify-center gap-2 py-2 rounded-lg bg-accent-solid text-accent-foreground text-xs font-semibold hover:bg-accent-solid-hover transition-[background-color,border-color,color,transform] duration-100 active:scale-[0.99] motion-reduce:active:scale-100 cursor-pointer">
                        <Play size={13} /> Start timer
                      </button>
                    )}
                  </div>
                  {/* Today's entries */}
                  {myTimeSectionFailed ? (
                    <div className="border-t border-outline-subtle px-4 py-3 text-center">
                      <p className="text-xs text-on-surface-secondary mb-1.5">Couldn&apos;t load today&apos;s entries</p>
                      <button type="button" onClick={() => { void refetchSummary(); }} className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis dark:text-accent-emphasis transition-colors">Retry</button>
                    </div>
                  ) : todayTimeEntriesData.length > 0 ? (
                    <div className="border-t border-outline-subtle">
                      <SectionLabel className="px-4 pt-3 pb-1.5">Logged Today</SectionLabel>
                      {todayTimeEntriesData.slice(0, compact ? 3 : 6).map((te) => (
                        <div key={te.id} className="flex items-center gap-3 px-4 py-2.5 border-t border-outline-subtle">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-on-surface truncate">{te.description || te.contextName || "Time entry"}</p>
                            {te.contextName && te.description && <p className="text-[10px] text-on-surface-muted truncate">{te.contextName}</p>}
                          </div>
                          <span className="text-xs font-semibold text-on-surface flex-shrink-0">{formatHours(te.hours)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </Card>
              )}
            </div>
          </SortableWidget>
        );
      }

      default:
        return null;
    }
  };

  // Widget content, frozen during a drag so its heavy subtree isn't re-rendered
  // on every pointer move (dnd-kit's context changes each move). Outside a drag
  // it's rebuilt every render, so it always reflects current data.
  const getWidgetNode = (
    widget: DashboardWidget,
    compact: boolean,
    dragHandle: DragHandle,
    isDragging: boolean,
  ): React.ReactNode => {
    if (activeId) {
      const cached = widgetNodeCacheRef.current.get(widget.key);
      if (cached !== undefined) return cached;
    }
    const node = renderWidget(widget, compact, dragHandle, isDragging);
    widgetNodeCacheRef.current.set(widget.key, node);
    return node;
  };

  if (loading || permissionsLoading) {
    return <LoadingSpinner fullPage />;
  }

  if (!lawFirm) {
    return (
      <ResourceNotFoundPage
        resourceLabel="law firm"
        title="This law firm dashboard is unavailable"
        description="The workspace could not be found or your access to it has changed."
      />
    );
  }

  return (
    <RequirePermission
      permission="dashboard.view"
      page
      deniedTitle="You do not have permission to view this dashboard"
      deniedDescription="Your role can sign into the firm, but it does not include access to the dashboard overview."
    >
    <div className="min-h-screen bg-page">
      <div className="p-6 max-w-[1600px] mx-auto">
        <main className="space-y-6">
          {/* Search Bar + Customize */}
          <div className="flex items-center gap-3">
          <div className="relative flex-1" ref={searchRef}>
            <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-muted z-10" />
            <input
              type="text"
              placeholder="Search matters, tasks, clients, or messages..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              className="w-full rounded-2xl border border-input-border bg-surface py-3 pl-11 pr-10 text-sm text-on-surface shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition-all placeholder-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring dark:focus-visible:ring-focus-ring dark:"
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(""); setSearchFocused(false); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-surface-alt hover:bg-surface-hover flex items-center justify-center transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 z-10"
              >
                <span className="text-on-surface-secondary text-xs leading-none">&times;</span>
              </button>
            )}

            {/* Search Dropdown */}
            {searchDropdownMounted && (
              <div className={`absolute top-full left-0 right-0 mt-1 bg-surface rounded-2xl border border-outline-subtle shadow-lg shadow-black/8 dark:shadow-black/40 overflow-hidden z-50 max-h-[420px] overflow-y-auto styled-scrollbar outline-none focus:outline-none focus-visible:outline-none [&_button]:outline-none [&_button]:focus:outline-none [&_button]:focus-visible:outline-none origin-top ${menuAnim(searchDropdownExiting)}`}>
                {searchLoading ? (
                  <div className="px-5 py-6 flex items-center justify-center gap-2">
                    <Spinner size={16} className="text-on-surface-muted" />
                    <p className="text-sm text-on-surface-secondary">Searching…</p>
                  </div>
                ) : !hasResults ? (
                  <div className="px-5 py-6 text-center">
                    <Search size={24} className="text-on-surface-muted mx-auto mb-2" />
                    <p className="text-sm text-on-surface-secondary">No results for &ldquo;{shownSearchQuery}&rdquo;</p>
                    <p className="text-xs text-on-surface-muted mt-0.5">Try a different search term</p>
                  </div>
                ) : (
                  <>
                    {/* Matters */}
                    {searchResults.matters.length > 0 && (
                      <div>
                        <div className="px-4 pt-3 pb-1.5">
                          <SectionLabel className="flex items-center gap-1.5">
                            <Briefcase size={11} />
                            Matters
                          </SectionLabel>
                        </div>
                        {searchResults.matters.map((c) => {
                          const status = matterStatusMeta(c.status);
                          return (
                            <button
                              key={c.id}
                              onClick={() => { setSearchFocused(false); navigate(`/lawfirm/${id}/matters/${c.id}`); }}
                              className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-hover focus:bg-surface-hover focus-visible:bg-surface-hover active:bg-surface-hover transition-colors w-full text-left cursor-pointer"
                            >
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-on-surface truncate">{c.name}</p>
                                {c.matterReferenceId && (
                                  <p className="text-[11px] text-on-surface-muted font-mono truncate">{c.matterReferenceId}</p>
                                )}
                              </div>
                              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md flex-shrink-0 ${styleOf(status).tint} ${styleOf(status).text}`}>
                                {status.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Clients */}
                    {searchResults.clients.length > 0 && (
                      <div className={searchResults.matters.length > 0 ? "border-t border-outline-subtle" : ""}>
                        <div className="px-4 pt-3 pb-1.5">
                          <SectionLabel className="flex items-center gap-1.5">
                            <UserRound size={11} />
                            Clients
                          </SectionLabel>
                        </div>
                        {searchResults.clients.map((client) => (
                          <button
                            key={client.id}
                            onClick={() => { setSearchFocused(false); navigate(`/lawfirm/${id}/clients/${client.id}`); }}
                            className="px-4 py-2.5 flex items-center gap-2 w-full text-left hover:bg-surface-hover focus:bg-surface-hover focus-visible:bg-surface-hover active:bg-surface-hover transition-colors cursor-pointer"
                          >
                            <Avatar size="xs" name={client.name} email={client.email} />
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-on-surface truncate">{client.name}</p>
                              {client.email && <p className="text-[11px] text-on-surface-muted truncate">{client.email}</p>}
                            </div>
                            <span className="text-[11px] text-on-surface-muted ml-auto flex-shrink-0">
                              {client.matterCount} {client.matterCount === 1 ? 'matter' : 'matters'}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Tasks */}
                    {searchResults.tasks.length > 0 && (
                      <div className={(searchResults.matters.length > 0 || searchResults.clients.length > 0) ? "border-t border-outline-subtle" : ""}>
                        <div className="px-4 pt-3 pb-1.5">
                          <SectionLabel className="flex items-center gap-1.5">
                            <ClipboardCheck size={11} />
                            Tasks
                          </SectionLabel>
                        </div>
                        {searchResults.tasks.map((t) => {
                          const priority = styleOf(taskPriorityMeta(t.priority));
                          return (
                            <button
                              key={t.id}
                              onClick={() => { setSearchFocused(false); navigate(`/lawfirm/${id}/tasks`); }}
                              className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-hover focus:bg-surface-hover focus-visible:bg-surface-hover active:bg-surface-hover transition-colors w-full text-left cursor-pointer"
                            >
                              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${priority.dot}`} />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-on-surface truncate">{t.title}</p>
                                {t.matterName && (
                                  <p className="text-[11px] text-on-surface-muted truncate">{t.matterName}</p>
                                )}
                              </div>
                              <span className="text-[11px] text-on-surface-muted flex-shrink-0">
                                {formatDueDate(t.dueDate)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Messages */}
                    {searchResults.conversations.length > 0 && (
                      <div className={(searchResults.matters.length > 0 || searchResults.clients.length > 0 || searchResults.tasks.length > 0) ? "border-t border-outline-subtle" : ""}>
                        <div className="px-4 pt-3 pb-1.5">
                          <SectionLabel className="flex items-center gap-1.5">
                            <MessageSquare size={11} />
                            Messages
                          </SectionLabel>
                        </div>
                        {searchResults.conversations.map((conv) => (
                          <button
                            key={conv.conversationId}
                            onClick={() => { setSearchFocused(false); navigate(`/lawfirm/${id}/messages/${conv.conversationId}`); }}
                            className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-hover focus:bg-surface-hover focus-visible:bg-surface-hover active:bg-surface-hover transition-colors w-full text-left cursor-pointer"
                          >
                            <Avatar size="xs" photoUrl={(conv as any).clientPhotoUrl} name={conv.clientName} />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-on-surface truncate">{conv.clientName}</p>
                              <p className="text-[11px] text-on-surface-muted truncate">{conv.lastMessagePreview || "No messages"}</p>
                            </div>
                            <span className="text-[10px] text-on-surface-muted flex-shrink-0">
                              {formatRelativeDay(conv.lastMessageAt as string)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          <Tooltip title={isDark ? "Switch to light mode" : "Switch to dark mode"} enterDelay={300}>
            <button
              // updateTheme rolls its own optimistic change back when the save fails,
              // so the rejection only needs absorbing to avoid an unhandled promise.
              onClick={() => { void updateTheme(isDark ? "light" : "dark").catch(() => {}); }}
              className="flex-shrink-0 w-10 h-10 rounded-2xl bg-surface border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] flex items-center justify-center text-on-surface-muted hover:text-accent-emphasis dark:hover:text-accent-emphasis hover:border-accent-border-soft dark:hover:border-accent-border-soft transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              {isDark ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </Tooltip>
          <Tooltip title={editMode ? "Done editing" : "Customize dashboard"} enterDelay={300}>
            <button
              onClick={() => {
                // The layout isn't reliably known until the user's saved
                // widget order has loaded; entering edit mode any earlier
                // risks a reorder/toggle being saved against the default
                // layout instead of the real one.
                if (preferencesLoading) return;
                setEditMode((prev) => !prev);
              }}
              disabled={preferencesLoading}
              className={`flex-shrink-0 h-10 rounded-2xl border shadow-[0_1px_3px_rgba(0,0,0,0.04)] flex items-center justify-center transition-all active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                editMode
                  ? "bg-accent-solid border-accent-solid text-accent-foreground hover:bg-accent-solid-hover px-4 gap-2"
                  : "bg-surface border-outline-subtle text-on-surface-muted hover:text-accent-emphasis dark:hover:text-accent-emphasis hover:border-accent-border-soft dark:hover:border-accent-border-soft w-10"
              }`}
            >
            {editMode ? (
              <>
                <Check size={16} />
                <span className="text-xs font-semibold">Done</span>
              </>
            ) : (
              <Pencil size={16} />
            )}
            </button>
          </Tooltip>
          </div>

          {/* Error */}
          <ErrorNotification error={error} onClose={() => setError(null)} />

          {/* ─── Two-Zone Layout (dnd-kit) ─── */}
          {/* Drag to reorder within a column or across to the other. The dragged
              preview is a small chip (DragOverlay); the drop spot is an
              InsertionBar. The column is chosen by the CURSOR's position, and
              widgets don't move mid-drag, so it's stable and cursor-accurate. The
              toolbar move button is a second way to switch columns. */}
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <div className={`flex gap-6 ${showSidebar ? "flex-col lg:flex-row" : ""}`}>
              {/* ─── Main Zone ─── */}
              <DropZone id="main-zone" className="flex-1 min-w-0">
                <SortableContext
                  items={(editMode ? mainWidgets : mainWidgets.filter((w) => w.visible)).map((w) => w.key)}
                  strategy={verticalListSortingStrategy}
                >
                  {(editMode ? mainWidgets : mainWidgets.filter((w) => w.visible)).map((widget) => (
                    <Fragment key={widget.key}>
                      {dropTarget?.zone === "main" && dropTarget.beforeKey === widget.key && <InsertionBar />}
                      <SortableItem id={widget.key} disabled={!editMode}>
                        {({ setNodeRef, dragHandle, isDragging }) => (
                          <div ref={setNodeRef} className={`mb-6 ${isDragging ? "opacity-40" : ""}`}>
                            {getWidgetNode(widget, false, dragHandle, isDragging)}
                          </div>
                        )}
                      </SortableItem>
                    </Fragment>
                  ))}
                  {dropTarget?.zone === "main" && dropTarget.beforeKey === null && <InsertionBar />}
                </SortableContext>
              </DropZone>

              {/* ─── Sidebar Zone ─── */}
              {showSidebar && (
                <DropZone id="sidebar-zone" className="w-full lg:w-80 flex-shrink-0">
                  <SortableContext
                    items={(editMode ? sidebarWidgets : sidebarWidgets.filter((w) => w.visible)).map((w) => w.key)}
                    strategy={verticalListSortingStrategy}
                  >
                    {editMode && sidebarWidgets.length === 0 ? (
                      <div
                        className={`rounded-2xl border-2 border-dashed p-8 flex flex-col items-center justify-center text-center min-h-[120px] transition-all ${
                          dropTarget?.zone === "sidebar" ? "border-accent-border-soft bg-accent-soft" : "border-outline-subtle"
                        }`}
                      >
                        <PanelRightOpen size={24} className={dropTarget?.zone === "sidebar" ? "text-accent-emphasis mb-2" : "text-on-surface-muted mb-2"} />
                        <p className="text-xs text-on-surface-muted font-medium">Drag a widget here</p>
                        <p className="text-[10px] text-on-surface-muted mt-0.5">
                          or use the <PanelRight size={10} className="inline align-text-bottom" /> button on a widget
                        </p>
                      </div>
                    ) : (
                      <>
                        {(editMode ? sidebarWidgets : sidebarWidgets.filter((w) => w.visible)).map((widget) => (
                          <Fragment key={widget.key}>
                            {dropTarget?.zone === "sidebar" && dropTarget.beforeKey === widget.key && <InsertionBar />}
                            <SortableItem id={widget.key} disabled={!editMode}>
                              {({ setNodeRef, dragHandle, isDragging }) => (
                                <div ref={setNodeRef} className={`mb-4 ${isDragging ? "opacity-40" : ""}`}>
                                  {getWidgetNode(widget, true, dragHandle, isDragging)}
                                </div>
                              )}
                            </SortableItem>
                          </Fragment>
                        ))}
                        {dropTarget?.zone === "sidebar" && dropTarget.beforeKey === null && <InsertionBar />}
                      </>
                    )}
                  </SortableContext>
                </DropZone>
              )}
            </div>

            <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
              {activeId ? <DragChip label={DASHBOARD_WIDGET_LABELS[activeId as DashboardWidgetKey] || activeId} /> : null}
            </DragOverlay>
          </DndContext>

        </main>
      </div>

      <UpcomingPaymentModal
        payment={selectedPayment}
        open={!!selectedPayment}
        onClose={() => setSelectedPayment(null)}
        lawFirmId={id}
      />

      <TaskDetailModal
        task={selectedTask}
        open={!!selectedTask}
        onClose={() => setSelectedTask(null)}
        lawFirmId={id}
      />

    </div>
    </RequirePermission>
  );
}
