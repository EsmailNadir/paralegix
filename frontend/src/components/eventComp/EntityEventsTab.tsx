"use client";

import { useState, type ReactNode } from "react";
import { Calendar, ChevronRight, Plus } from "lucide-react";
import type { MatterEvent, MatterEventStatus } from "@/types/matterEvent";
import { matterEventTypeMeta } from "@/constants/statusMeta";
import { isPastInstant } from "@/lib/utils/dateUtils";
import ErrorNotification from "@/components/ErrorNotification";
import Button from "@/components/ui/Button";
import ListBusyIndicator from "@/components/ui/ListBusyIndicator";
import ListEmptyState from "@/components/ui/ListEmptyState";
import { DEFAULT_ROWS_PER_PAGE_OPTIONS } from "@/components/ui/ListPager";
import ListSkeleton from "@/components/ui/ListSkeleton";
import ListView, { type ListRow } from "@/components/ui/ListView";
import RowActionMenu, { type RowAction } from "@/components/ui/RowActionMenu";
import SegmentedToggle from "@/components/ui/SegmentedToggle";
import StatusBadge from "@/components/ui/StatusBadge";
import { eventSectionState } from "@/components/eventComp/eventSectionState";

export type EventStatusFilter = "all" | MatterEventStatus;

/**
 * The status chips' state, and which sections it leaves on screen.
 *
 * Lives outside the tab because the parent owns the section pagers (they are
 * each parent's own query hooks), and every pager needs to know whether its
 * section is visible before it can decide whether to fetch.
 */
export function useEventStatusFilter() {
  const [filterStatus, setFilterStatus] = useState<EventStatusFilter>("all");
  return {
    filterStatus,
    setFilterStatus,
    showUpcoming: filterStatus === "all" || filterStatus === "upcoming",
    showCompleted: filterStatus === "all" || filterStatus === "completed",
    showCancelled: filterStatus === "all" || filterStatus === "cancelled",
  };
}

export type EventStatusFilterState = ReturnType<typeof useEventStatusFilter>;

/** One server-paged status section, as `useMatterEventsPage` and `useClientEventsPage` return it. */
export interface EventSectionPage<E> {
  rows: E[];
  total: number;
  page: number;
  setPage: (page: number) => void;
  rowsPerPage: number;
  setRowsPerPage: (rowsPerPage: number) => void;
  loading: boolean;
  fetching: boolean;
}

/** The fields the shared row reads. Both `MatterEvent` and `ClientEvent` carry them. */
type EventRowBase = Pick<MatterEvent, "id" | "type" | "title" | "status" | "date" | "dateLocalDisplay">;

/** A row's controls: an optional always-visible button, then the kebab menu. */
export interface EventRowActions {
  primary?: ReactNode;
  menu: RowAction[];
}

/**
 * What a parent supplies for the parts of its events tab that are its own.
 * Everything else (the status chips, the three paged sections, the skeleton,
 * the empty state, the expandable row shell) is the same on every parent.
 */
export interface EntityEventsAdapter<E> {
  /** Prefix for each row's details panel id; the event id is appended. */
  detailsIdPrefix: string;
  /** Whether the row has a details panel, and so whether clicking it expands. */
  hasDetails: (event: E) => boolean;
  /** Badges drawn after the event type badge. */
  renderBadges: (event: E, row: { isOverdue: boolean }) => ReactNode;
  /** The line under the title. */
  renderMeta: (event: E) => ReactNode;
  /** Contents of the expanded details panel. Only called when `hasDetails` is true. */
  renderDetails: (event: E) => ReactNode;
  /** The row's controls, or null for a row the viewer cannot act on. */
  rowActions: (event: E) => EventRowActions | null;
  /**
   * Drop the kebab when `rowActions` returns an empty menu. A parent whose menu
   * is built from permission checks can end up with nothing in it; a parent
   * whose menu always has entries leaves this off.
   */
  hideEmptyRowMenu: boolean;
  /** Empty-state copy for a viewer who can add events, and for one who cannot. */
  emptyMessage: { canManage: string; readOnly: string };
}

export interface EntityEventsTabProps<E> {
  canManage: boolean;
  filter: EventStatusFilterState;
  sections: Record<MatterEventStatus, EventSectionPage<E>>;
  /** The error to show, already combined with any load failure by the parent. */
  error: string | null;
  onDismissError: () => void;
  onAdd: () => void;
  /** Further header buttons, drawn before "Add Event" in a shared group. */
  headerActions?: ReactNode;
  adapter: EntityEventsAdapter<E>;
  /** The parent's dialogs, rendered after the list. */
  children?: ReactNode;
}

/**
 * An events tab for any parent: matters and clients today. Each status is its
 * own server-paged section behind one status control that HIDES sections rather
 * than filtering rows, since filtering a server page in the browser would only
 * narrow what happens to be loaded.
 */
export default function EntityEventsTab<E extends EventRowBase>({
  canManage,
  filter,
  sections,
  error,
  onDismissError,
  onAdd,
  headerActions,
  adapter,
  children,
}: EntityEventsTabProps<E>) {
  const { filterStatus, setFilterStatus, showUpcoming, showCompleted, showCancelled } = filter;
  const { upcoming: upcomingPager, completed: completedPager, cancelled: cancelledPager } = sections;
  // Which event's disclosure panel is expanded. Only one at a time.
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  const { showSkeleton: sectionsLoading, busy: sectionsFetching } = eventSectionState([
    { visible: showUpcoming, ...upcomingPager, rowCount: upcomingPager.rows.length },
    { visible: showCompleted, ...completedPager, rowCount: completedPager.rows.length },
    { visible: showCancelled, ...cancelledPager, rowCount: cancelledPager.rows.length },
  ]);
  // Server totals, not loaded rows, so the empty state describes the parent
  // rather than whichever page happens to be in hand.
  const visibleEventCount =
    (showUpcoming ? upcomingPager.total : 0)
    + (showCompleted ? completedPager.total : 0)
    + (showCancelled ? cancelledPager.total : 0);

  const renderEvent = (event: E): ListRow => {
    const isOverdue = event.status === "upcoming" && isPastInstant(event.date);
    const hasDetails = adapter.hasDetails(event);
    const expanded = expandedEventId === event.id;
    const detailsId = `${adapter.detailsIdPrefix}${event.id}`;

    return {
      title: (
        <span className="flex min-w-0 items-center gap-1.5">
          {hasDetails ? (
            <ChevronRight
              size={15}
              className={`shrink-0 text-on-surface-muted transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
            />
          ) : (
            <Calendar size={15} className="shrink-0 text-on-surface-muted" />
          )}
          <span className={`truncate ${event.status === "cancelled" ? "line-through text-on-surface-muted" : ""}`}>
            {event.title}
          </span>
        </span>
      ),
      badges: (
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge variant={matterEventTypeMeta(event.type).variant}>
            {matterEventTypeMeta(event.type).label}
          </StatusBadge>
          {adapter.renderBadges(event, { isOverdue })}
        </div>
      ),
      meta: adapter.renderMeta(event),
      detailsOpen: expanded,
      detailsId: hasDetails ? detailsId : undefined,
      details: hasDetails ? (
        <div className="space-y-2.5 border-t border-outline-subtle bg-surface-alt/40 px-4 py-3">
          {adapter.renderDetails(event)}
        </div>
      ) : undefined,
    };
  };

  const renderEventActions = (event: E) => {
    const actions = adapter.rowActions(event);
    if (!actions) return null;
    const hideMenu = adapter.hideEmptyRowMenu && actions.menu.length === 0;
    return (
      <>
        {actions.primary}
        {!hideMenu && <RowActionMenu actions={actions.menu} />}
      </>
    );
  };

  const handleRowClick = (event: E) => {
    if (!adapter.hasDetails(event)) return;
    setExpandedEventId((current) => (current === event.id ? null : event.id));
  };

  const addButton = (
    <Button
      size="compact"
      onClick={onAdd}
      icon={<Plus size={14} strokeWidth={2.2} />}
    >
      Add Event
    </Button>
  );

  const renderSection = (pager: EventSectionPage<E>) => (
    <ListView
      variant="separated"
      rows={pager.rows}
      getRowId={(event) => event.id}
      renderRow={renderEvent}
      rowActions={renderEventActions}
      onRowClick={handleRowClick}
      paginationMode="server"
      page={pager.page - 1}
      pageSize={pager.rowsPerPage}
      rowCount={pager.total}
      onPageChange={(p) => pager.setPage(p + 1)}
      onPageSizeChange={pager.setRowsPerPage}
      pageSizeOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
      fetching={pager.fetching}
      showFetchIndicator={false}
    />
  );

  return (
    <div>
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <SegmentedToggle
            ariaLabel="Filter events by status"
            value={filterStatus}
            onChange={setFilterStatus}
            options={[
              { value: "all", label: "All" },
              { value: "upcoming", label: "Upcoming" },
              { value: "completed", label: "Completed" },
              { value: "cancelled", label: "Cancelled" },
            ]}
          />
          {/* Each chip enables a different server read while the events already
              on screen stay put, so the switch needs an acknowledgement of its
              own. The section pagers carry their own page-click waits. */}
          <ListBusyIndicator busy={sectionsFetching} />
        </div>
        {canManage && (headerActions ? (
          <div className="flex items-center gap-2">
            {headerActions}
            {addButton}
          </div>
        ) : addButton)}
      </div>

      <div className="space-y-5">
      <ErrorNotification error={error} onClose={onDismissError} />

      {sectionsLoading ? (
        <ListSkeleton rows={4} label="Loading events" />
      ) : visibleEventCount === 0 ? (
        <ListEmptyState
          compact
          icon={<Calendar size={32} />}
          title="No events yet"
          message={canManage ? adapter.emptyMessage.canManage : adapter.emptyMessage.readOnly}
          action={
            canManage && (
              <Button
                size="compact"
                onClick={onAdd}
                icon={<Plus size={14} />}
              >
                Add First Event
              </Button>
            )
          }
        />
      ) : (
        <div className="space-y-5">
          {showUpcoming && upcomingPager.total > 0 && (
            <div>
              {(completedPager.total > 0 || cancelledPager.total > 0) && (
                <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-secondary mb-2">Upcoming</h3>
              )}
              {renderSection(upcomingPager)}
            </div>
          )}
          {showCompleted && completedPager.total > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-secondary mb-2">Completed</h3>
              {renderSection(completedPager)}
            </div>
          )}
          {showCancelled && cancelledPager.total > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-secondary mb-2">Cancelled</h3>
              {renderSection(cancelledPager)}
            </div>
          )}
        </div>
      )}
      </div>

      {children}
    </div>
  );
}
