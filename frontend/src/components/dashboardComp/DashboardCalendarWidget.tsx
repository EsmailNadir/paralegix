"use client";

import { useMemo, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";
import Link from "next/link";
import Tooltip from "@/components/ui/Tooltip";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  LayoutGrid,
  List,
  MapPin,
} from "lucide-react";
import useMatterEvents from "@/hooks/calendarHooks/useMatterEvents";
import useStandaloneClientEvents from "@/hooks/calendarHooks/useStandaloneClientEvents";
import { getCalendarWindow } from "@/lib/utils/calendarWindow";
import { type MatterEventType } from "@/types/matterEvent";
import { matterEventTypeMeta, STATUS_VARIANTS } from "@/constants/statusMeta";
import EventDetailModal from "./EventDetailModal";
import useSlidingHighlight from "@/hooks/useSlidingHighlight";
import SectionLabel from "@/components/ui/SectionLabel";
import { eventDayKeys } from "@/components/calendarComp/calendarTiming";

// A single matter/client event flattened to what the mini-calendar needs.
export interface CalendarWidgetEvent {
  key: string;
  id: string;
  title: string;
  iso: string;
  end?: string | null;
  allDay?: boolean;
  /** Start and end as the server formatted them in the viewer's zone, when it sent them. */
  startLocalDisplay?: string | null;
  endLocalDisplay?: string | null;
  dayKey: string; // YYYY-MM-DD, local
  hasTime: boolean;
  type: MatterEventType | null;
  source: "matter" | "client";
  matterId: string | null;
  matterName: string | null;
  clientName: string | null;
  locationName: string | null;
}

// Dot / text color per event type, from the same variant `matterEventTypeMeta`
// already uses for the label text, so a type reads the same color here as it
// does everywhere else (matter events tab, badges, etc.).
const accentFor = (type: string | null) => STATUS_VARIANTS[matterEventTypeMeta(type).variant];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * How many upcoming events the agenda draws. A dashboard widget, not the
 * calendar - whatever falls past this is counted and linked, never dropped
 * silently.
 */
const AGENDA_LIMIT = 40;

function formatEventTime(iso: string, hasTime: boolean): string {
  if (!hasTime) return "All day";
  return dayjs(iso).format("h:mm A");
}

export default function DashboardCalendarWidget({
  lawFirmId,
  compact,
  onNavigate,
}: {
  lawFirmId: string;
  compact: boolean;
  onNavigate: (href: string) => void;
}) {
  const [viewMonth, setViewMonth] = useState<Dayjs>(() => dayjs().startOf("month"));
  const [mode, setMode] = useState<"month" | "agenda">("month");
  const modeHighlight = useSlidingHighlight<HTMLDivElement>(mode);

  // The widget reads the same windowed event feed as the full calendar, bounded
  // to the days it is about to draw rather than the firm's whole history. The two
  // modes need different spans: the grid draws one month, while the agenda lists
  // what is coming up next regardless of which month the grid sits on. Giving the
  // agenda the grid's window would empty it for any firm whose next event falls
  // more than a month out, so it gets a forward year from today instead.
  const eventWindow = useMemo(() => {
    if (mode === "agenda") {
      const today = dayjs().startOf("day");
      return {
        key: `agenda-${today.format("YYYY-MM-DD")}`,
        from: today.format("YYYY-MM-DD"),
        to: today.add(1, "year").format("YYYY-MM-DD"),
      };
    }
    return getCalendarWindow(viewMonth);
  }, [mode, viewMonth]);

  const { matterEvents, loading: matterLoading } = useMatterEvents(lawFirmId, eventWindow);
  const { clientEvents, loading: clientLoading } = useStandaloneClientEvents(lawFirmId, eventWindow);
  const loading = matterLoading || clientLoading;

  const [selectedDay, setSelectedDay] = useState<Dayjs>(() => dayjs().startOf("day"));
  // Event whose detail modal is open (null = closed).
  const [selectedEvent, setSelectedEvent] = useState<CalendarWidgetEvent | null>(null);

  // Flatten matter + client events into a single list, dropping undated ones.
  //
  // The matter and client names are read straight off each event: the events
  // endpoint resolves them server-side (same as the full calendar does), so this
  // widget needs no firm-wide matters list to label its rows.
  const events = useMemo<CalendarWidgetEvent[]>(() => {
    const out: CalendarWidgetEvent[] = [];
    for (const e of matterEvents) {
      if (!e.date) continue;
      const d = dayjs(e.allDay ? e.date.slice(0, 10) : e.date);
      if (!d.isValid()) continue;
      out.push({
        key: `matter-${e.id}`,
        id: e.id,
        title: e.title || "Untitled event",
        iso: e.date,
        end: e.endsAt,
        allDay: e.allDay,
        startLocalDisplay: e.dateLocalDisplay,
        endLocalDisplay: e.endsAtLocalDisplay,
        dayKey: d.format("YYYY-MM-DD"),
        hasTime: e.allDay === undefined ? !!e.dateLocalInput || d.hour() !== 0 || d.minute() !== 0 : !e.allDay,
        type: e.type ?? null,
        source: "matter",
        matterId: e.matterId ?? null,
        matterName: e.matterName ?? null,
        clientName: e.clientNames?.length ? e.clientNames.join(", ") : null,
        locationName: e.locationName || e.location || null,
      });
    }
    for (const e of clientEvents) {
      if (!e.date) continue;
      const d = dayjs(e.allDay ? e.date.slice(0, 10) : e.date);
      if (!d.isValid()) continue;
      out.push({
        key: `client-${e.id}`,
        id: e.id,
        title: e.title || "Untitled event",
        iso: e.date,
        end: e.endsAt,
        allDay: e.allDay,
        startLocalDisplay: e.dateLocalDisplay,
        endLocalDisplay: e.endsAtLocalDisplay,
        dayKey: d.format("YYYY-MM-DD"),
        hasTime: e.allDay === undefined ? !!e.dateLocalInput || d.hour() !== 0 || d.minute() !== 0 : !e.allDay,
        type: e.type ?? null,
        source: e.source === "matter" ? "matter" : "client",
        matterId: e.matterId ?? null,
        // This feed is the firm's STANDALONE client events (`client_events` has
        // no matter column), so these are always the event's own values.
        matterName: e.matterName ?? null,
        clientName: e.clientName ?? null,
        locationName: e.locationName || e.location || null,
      });
    }
    return out;
  }, [matterEvents, clientEvents]);

  // Group events by local day for O(1) cell lookups.
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarWidgetEvent[]>();
    for (const ev of events) {
      for (const key of eventDayKeys({ id: ev.id, title: ev.title, start: ev.iso, end: ev.end || undefined, allDay: ev.allDay }, { from: eventWindow.from, to: eventWindow.to })) {
        const list = map.get(key);
        if (list) list.push(ev);
        else map.set(key, [ev]);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.hasTime !== b.hasTime) return a.hasTime ? 1 : -1;
        return a.iso.localeCompare(b.iso);
      });
    }
    return map;
  }, [events, eventWindow]);

  // Build a padded grid of days covering full weeks for the visible month
  // (weeks start on Sunday).
  const gridDays = useMemo<(Dayjs | null)[]>(() => {
    const startOfMonth = viewMonth.startOf("month");
    const daysInMonth = viewMonth.daysInMonth();
    const leadPad = startOfMonth.day();
    const cells: (Dayjs | null)[] = [];
    for (let i = 0; i < leadPad; i++) cells.push(null);
    for (let d = 0; d < daysInMonth; d++) cells.push(startOfMonth.add(d, "day"));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [viewMonth]);

  const today = dayjs().startOf("day");
  const todayKey = today.format("YYYY-MM-DD");
  const selectedKey = selectedDay.format("YYYY-MM-DD");

  const selectedEvents = eventsByDay.get(selectedKey) ?? [];

  // Agenda mode: the soonest upcoming events from today onward.
  //
  // Capped, because this is a dashboard widget rather than the calendar. The
  // count of what the cap left out travels with it: a silently truncated agenda
  // reads as "this is everything coming up", which is how a deadline further out
  // than the cap gets treated as one that does not exist.
  const { agendaEvents, agendaHiddenCount } = useMemo(() => {
    const upcoming = events
      .filter((e) => e.dayKey >= todayKey)
      .sort((a, b) => a.iso.localeCompare(b.iso));
    return {
      agendaEvents: upcoming.slice(0, AGENDA_LIMIT),
      agendaHiddenCount: Math.max(0, upcoming.length - AGENDA_LIMIT),
    };
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- .sort() runs on the array from .filter(), never mutating the events prop
  }, [events, todayKey]);

  const monthEventCount = useMemo(() => {
    const prefix = viewMonth.format("YYYY-MM");
    return events.reduce((n, e) => (e.dayKey.startsWith(prefix) ? n + 1 : n), 0);
  }, [events, viewMonth]);

  const openEvent = (ev: CalendarWidgetEvent) => setSelectedEvent(ev);

  const gridColsClass = "grid-cols-7";
  const cardClasses =
    "bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden";

  // In the bigger (main-zone) month view, show the day's events in a panel to
  // the RIGHT of the calendar rather than below it, filling the full zone width.
  // Compact (sidebar) and the agenda list keep the single-card stacked layout.
  const sideBySide = !compact && mode === "month";

  const toolbar = (
    <div className="flex items-center gap-2 px-3.5 py-3 border-b border-outline-subtle">
      <div className="flex items-center gap-1 min-w-0">
        <button
          onClick={() => setViewMonth((m) => m.subtract(1, "month"))}
          className="p-1.5 rounded-lg text-on-surface-muted hover:bg-surface-hover hover:text-on-surface-secondary transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          aria-label="Previous month"
        >
          <ChevronLeft size={16} />
        </button>
        <button
          onClick={() => setViewMonth((m) => m.add(1, "month"))}
          className="p-1.5 rounded-lg text-on-surface-muted hover:bg-surface-hover hover:text-on-surface-secondary transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          aria-label="Next month"
        >
          <ChevronRight size={16} />
        </button>
        <div className="min-w-0 ml-1">
          <p className="text-sm font-semibold text-on-surface truncate leading-tight">
            {viewMonth.format("MMMM YYYY")}
          </p>
          <p className="text-[10px] text-on-surface-muted leading-tight">
            {monthEventCount} event{monthEventCount !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={() => {
            const t = dayjs();
            setViewMonth(t.startOf("month"));
            setSelectedDay(t.startOf("day"));
          }}
          className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-on-surface-secondary border border-outline-subtle hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
        >
          Today
        </button>

        {/* View toggle */}
        <div
          ref={modeHighlight.containerRef}
          className="relative flex items-center rounded-lg border border-outline-subtle p-0.5"
        >
          {modeHighlight.rect && (
            <span
              aria-hidden
              className="absolute rounded-md bg-accent-soft transition-[transform,width,height] duration-200 ease-out motion-reduce:transition-none dark:bg-accent-soft"
              style={{
                left: 0,
                top: 0,
                width: modeHighlight.rect.width,
                height: modeHighlight.rect.height,
                transform: `translate(${modeHighlight.rect.left}px, ${modeHighlight.rect.top}px)`,
              }}
            />
          )}
          <Tooltip title="Month grid" enterDelay={300}>
            <button
              ref={modeHighlight.registerItem("month")}
              onClick={() => setMode("month")}
              className={`relative z-10 p-1.5 rounded-md transition-colors cursor-pointer ${
                mode === "month"
                  ? "text-accent-emphasis dark:text-accent-emphasis"
                  : "text-on-surface-muted hover:bg-surface-hover"
              }`}
              aria-label="Month grid view"
            >
              <LayoutGrid size={14} />
            </button>
          </Tooltip>
          <Tooltip title="Agenda list" enterDelay={300}>
            <button
              ref={modeHighlight.registerItem("agenda")}
              onClick={() => setMode("agenda")}
              className={`relative z-10 p-1.5 rounded-md transition-colors cursor-pointer ${
                mode === "agenda"
                  ? "text-accent-emphasis dark:text-accent-emphasis"
                  : "text-on-surface-muted hover:bg-surface-hover"
              }`}
              aria-label="Agenda list view"
            >
              <List size={14} />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );

  const skeletonGridInner = (
    <div className={`grid ${gridColsClass} gap-1.5 animate-pulse`}>
      {Array.from({ length: 35 }).map((_, i) => (
        <div key={i} className="aspect-square rounded-lg bg-surface-alt" />
      ))}
    </div>
  );

  const monthGridInner = (
    <>
      {/* Weekday header */}
      <div className={`grid ${gridColsClass} mb-1.5`}>
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="text-center text-[10px] font-semibold text-on-surface-muted uppercase tracking-wide py-1"
          >
            {w}
          </div>
        ))}
      </div>
      {/* Day grid */}
      <div className={`grid ${gridColsClass} gap-1`}>
        {gridDays.map((day, i) => {
          if (!day) return <div key={`pad-${i}`} />;
          const key = day.format("YYYY-MM-DD");
          const dayEvents = eventsByDay.get(key) ?? [];
          const isToday = key === todayKey;
          const isSelected = key === selectedKey;
          const isWeekend = day.day() === 0 || day.day() === 6;
          const dotTypes = Array.from(new Set(dayEvents.map((e) => e.type))).slice(0, 3);

          return (
            <button
              key={key}
              onClick={() => setSelectedDay(day.startOf("day"))}
              className={`relative aspect-square rounded-lg flex flex-col items-center justify-center transition-colors cursor-pointer ${
                isSelected
                  ? "bg-accent-solid text-accent-foreground shadow-sm"
                  : isToday
                    ? "bg-accent-soft dark:bg-accent-soft text-accent-emphasis dark:text-accent-emphasis font-semibold"
                    : isWeekend
                      ? "bg-surface-alt/40 text-on-surface-secondary hover:bg-surface-hover"
                      : "text-on-surface-secondary hover:bg-surface-hover"
              }`}
            >
              <span className={`text-xs leading-none ${isToday && !isSelected ? "font-bold" : ""}`}>
                {day.date()}
              </span>
              {dotTypes.length > 0 && (
                <span className="absolute bottom-1 flex items-center gap-0.5">
                  {dotTypes.map((t, di) => (
                    <span
                      key={di}
                      className={`w-1 h-1 rounded-full ${isSelected ? "bg-white/90" : accentFor(t).dot}`}
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );

  const dayPanelHeader = (
    <div className="flex items-center justify-between mb-2">
      <p className="text-xs font-semibold text-on-surface">
        {selectedDay.isSame(today, "day") ? "Today" : selectedDay.format("dddd, MMM D")}
      </p>
      <span className="text-[10px] text-on-surface-muted">
        {selectedEvents.length} event{selectedEvents.length !== 1 ? "s" : ""}
      </span>
    </div>
  );

  const dayPanelBody =
    selectedEvents.length === 0 ? (
      <div className="flex items-center gap-2 py-3 text-on-surface-muted">
        <CalendarDays size={15} />
        <span className="text-xs">Nothing scheduled.</span>
      </div>
    ) : (
      <div className="space-y-1">
        {selectedEvents.map((ev) => (
          <EventRow key={ev.key} ev={ev} onClick={() => openEvent(ev)} />
        ))}
      </div>
    );

  const agendaCardBody = (
    <div className="p-3.5">
      {agendaEvents.length === 0 ? (
        <div className="text-center py-8">
          <CalendarDays size={compact ? 24 : 32} className="text-on-surface-secondary mx-auto mb-2" />
          <p className="text-sm text-on-surface-secondary">No upcoming events</p>
        </div>
      ) : (
        <div className="space-y-2.5 max-h-[360px] overflow-y-auto overflow-x-hidden styled-scrollbar -mr-1 pr-1">
          {groupByDay(agendaEvents, today).map((group) => (
            <div key={group.dayKey}>
              <p className="text-[10px] font-semibold text-on-surface-muted uppercase tracking-wide mb-1 px-0.5">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map((ev) => (
                  <EventRow key={ev.key} ev={ev} onClick={() => openEvent(ev)} />
                ))}
              </div>
            </div>
          ))}
          {agendaHiddenCount > 0 && (
            <button
              type="button"
              onClick={() => onNavigate(`/lawfirm/${lawFirmId}/calendar`)}
              className="w-full pt-1 text-center text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover transition-colors cursor-pointer"
            >
              +{agendaHiddenCount} more on the full calendar
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <SectionLabel tone="secondary">
          Calendar
        </SectionLabel>
        <Link
          href={`/lawfirm/${lawFirmId}/calendar`}
          onClick={(e) => {
            e.preventDefault();
            onNavigate(`/lawfirm/${lawFirmId}/calendar`);
          }}
          className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover flex items-center gap-1 transition-colors"
        >
          Full calendar <ChevronRight size={14} />
        </Link>
      </div>

      {sideBySide ? (
        /* Bigger view: calendar on the left, the day's events on the right. */
        <div className="flex flex-col sm:flex-row gap-4 sm:items-stretch">
          <div className={`${cardClasses} w-full sm:w-80 sm:flex-shrink-0`}>
            {toolbar}
            <div className="p-3.5">{loading ? skeletonGridInner : monthGridInner}</div>
          </div>
          <div className={`${cardClasses} flex-1 min-w-0 flex flex-col`}>
            <div className="p-3.5 flex flex-col flex-1 min-h-0">
              {dayPanelHeader}
              <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden styled-scrollbar -mr-1 pr-1">
                {loading ? (
                  <div className="space-y-2 animate-pulse">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-11 rounded-lg bg-surface-alt" />
                    ))}
                  </div>
                ) : (
                  dayPanelBody
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className={cardClasses}>
          {toolbar}
          {loading ? (
            <div className="p-5">{skeletonGridInner}</div>
          ) : mode === "month" ? (
            <div className="p-3.5">
              {monthGridInner}
              <div className="mt-3 pt-3 border-t border-outline-subtle">
                {dayPanelHeader}
                <div className="max-h-52 overflow-y-auto overflow-x-hidden styled-scrollbar -mr-1 pr-1">{dayPanelBody}</div>
              </div>
            </div>
          ) : (
            agendaCardBody
          )}
        </div>
      )}

      <EventDetailModal
        event={selectedEvent}
        open={!!selectedEvent}
        onClose={() => setSelectedEvent(null)}
        lawFirmId={lawFirmId}
      />
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────

function EventRow({ ev, onClick }: { ev: CalendarWidgetEvent; onClick: () => void }) {
  const accent = accentFor(ev.type);
  const typeLabel = ev.type ? matterEventTypeMeta(ev.type).label : ev.source === "matter" ? "Matter event" : "Client event";
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-surface-hover transition-colors group text-left"
    >
      <span className={`w-1.5 self-stretch rounded-full flex-shrink-0 ${accent.dot}`} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-on-surface truncate group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors">
          {ev.title}
        </p>
        {/* Each segment ellipsizes on its own: `truncate` on this row would set
            text-overflow on a flex container, which never reaches the spans
            inside it, so an overlong name would be cut off mid-letter instead. */}
        <p className="text-[10px] text-on-surface-muted overflow-hidden flex items-center gap-1">
          <span className={`shrink-0 ${accent.text}`}>{typeLabel}</span>
          {ev.clientName ? <span className="truncate text-on-surface-muted">· {ev.clientName}</span> : null}
          {ev.matterName ? <span className="truncate text-on-surface-muted">· {ev.matterName}</span> : null}
          {ev.locationName ? (
            <span className="inline-flex min-w-0 items-center gap-0.5 text-on-surface-muted">
              · <MapPin size={9} className="shrink-0" /> <span className="truncate">{ev.locationName}</span>
            </span>
          ) : null}
        </p>
      </div>
      <span className="text-[10px] font-medium text-on-surface-muted flex-shrink-0 whitespace-nowrap">
        {formatEventTime(ev.iso, ev.hasTime)}
      </span>
    </button>
  );
}

// ─── Helpers ────────────────────────────────────────────────

function groupByDay(
  items: CalendarWidgetEvent[],
  today: Dayjs
): { dayKey: string; label: string; items: CalendarWidgetEvent[] }[] {
  const groups: { dayKey: string; label: string; items: CalendarWidgetEvent[] }[] = [];
  const byKey = new Map<string, CalendarWidgetEvent[]>();
  for (const ev of items) {
    const list = byKey.get(ev.dayKey);
    if (list) list.push(ev);
    else byKey.set(ev.dayKey, [ev]);
  }
  for (const dayKey of [...byKey.keys()].sort()) {
    const d = dayjs(dayKey);
    const diff = d.startOf("day").diff(today, "day");
    let label: string;
    if (diff === 0) label = "Today";
    else if (diff === 1) label = "Tomorrow";
    else label = d.format("dddd, MMM D");
    groups.push({ dayKey, label, items: byKey.get(dayKey)! });
  }
  return groups;
}
