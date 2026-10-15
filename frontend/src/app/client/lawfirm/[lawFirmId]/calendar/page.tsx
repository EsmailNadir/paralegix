"use client";

import { eventZoneSuffix, formatEventWhen } from "@/components/calendarComp/calendarTiming";
import ZonedEventTime from "@/components/calendarComp/ZonedEventTime";

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import clientPortalService from '@/services/client-portal.service';
import ErrorNotification from '@/components/ErrorNotification';
import { AutoPager } from '@/components/ui/ListPager';
import ListSkeleton from '@/components/ui/ListSkeleton';
import ListEmptyState from '@/components/ui/ListEmptyState';
import TruncatedListNotice from '@/components/ui/TruncatedListNotice';
import usePagedRows from '@/hooks/usePagedRows';
import { CalendarDays, MapPin, ChevronRight, Scale } from 'lucide-react';
import NavigationLink from '@/components/ui/NavigationLink';
import StatusBadge from '@/components/ui/StatusBadge';
import { matterEventTypeMeta } from '@/constants/statusMeta';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import { useClientPortal } from '@/contexts/ClientPortalContext';
import ClientRecordPicker from '@/components/portalComp/ClientRecordPicker';
import LinkifiedText from '@/components/ui/LinkifiedText';

interface PortalEvent {
  id: string;
  matterId: string;
  title?: string | null;
  type?: string | null;
  date?: string | null;
  description?: string | null;
  location?: string | null;
  allDay?: boolean;
  endsAt?: string | null;
  timeZone?: string | null;
}

interface PortalMatter {
  id: string;
  title?: string;
  name?: string;
}

// snake_case / multi-word enum values (e.g. "court_date") never render raw.
const titleCase = (value?: string | null) =>
  (value || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const toDateOrNull = (value: unknown): Date | null => {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === 'number') {
    const parsed = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

export default function ClientCalendarPage() {
  const params = useParams();
  const { user } = useAuth();
  const lawFirmId = params.lawFirmId as string;
  const { associations, associationsLoading, activeAssociation, selectionRequired, setActiveClientRecordId } = useClientPortal();
  const clientRecordId = activeAssociation?.clientRecordId;

  const [events, setEvents] = useState<PortalEvent[]>([]);
  // The agenda is capped server-side, so a client with a very full schedule can
  // be looking at part of it. Saying so beats presenting it as everything.
  const [eventsTruncated, setEventsTruncated] = useState(false);
  const [matterNames, setMatterNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadGeneration = useRef(0);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    if (!lawFirmId || !user || associationsLoading || selectionRequired) return;

    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        setEvents([]);
        setEventsTruncated(false);
        setMatterNames({});
        // Events are the page; matter names only label them, so a matters failure
        // must not blank the calendar.
        const [eventsRes, mattersRes] = await Promise.allSettled([
          clientPortalService.getEvents(lawFirmId, { clientRecordId }),
          clientPortalService.getMatters(lawFirmId, clientRecordId),
        ]);

        if (generation !== loadGeneration.current) return;

        if (eventsRes.status === 'fulfilled') {
          setEvents(Array.isArray(eventsRes.value?.events) ? eventsRes.value.events : []);
          setEventsTruncated(!!eventsRes.value?.truncated);
        } else {
          throw eventsRes.reason;
        }

        if (mattersRes.status === 'fulfilled') {
          const map: Record<string, string> = {};
          for (const m of (mattersRes.value?.matters || []) as PortalMatter[]) {
            map[m.id] = m.title || m.name || 'Matter';
          }
          setMatterNames(map);
        }
      } catch (err) {
        if (generation === loadGeneration.current) {
          setError(getErrorMessage(err, 'Failed to load your calendar'));
        }
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
      }
    };

    void fetchData();
    return () => { loadGeneration.current += 1; };
  }, [lawFirmId, user, associationsLoading, selectionRequired, clientRecordId]);

  const formatTime = (date: Date) =>
    date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  // Group upcoming events by calendar day, each group sorted chronologically, so
  // the page reads like an agenda.
  const groups = useMemo(() => {
    const withDates = events
      .map((ev) => ({ ev, date: toDateOrNull(ev.allDay && ev.date ? `${ev.date.slice(0, 10)}T12:00:00` : ev.date) }))
      .filter((x): x is { ev: PortalEvent; date: Date } => x.date !== null)
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    const byDay = new Map<string, { date: Date; items: PortalEvent[] }>();
    for (const { ev, date } of withDates) {
      const key = date.toDateString();
      if (!byDay.has(key)) byDay.set(key, { date, items: [] });
      byDay.get(key)!.items.push(ev);
    }
    return Array.from(byDay.values());
  }, [events]);

  // Paged by day rather than by event, so a page break never splits a single
  // day's agenda across two pages.
  const daysPager = usePagedRows(groups, 7);

  if (selectionRequired) {
    return <ClientRecordPicker associations={associations} onSelect={setActiveClientRecordId} />;
  }

  if (loading) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto min-w-0">
        <ListSkeleton rows={6} label="Loading your calendar" />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1600px] mx-auto min-w-0">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-accent-solid rounded-xl flex items-center justify-center">
            <CalendarDays className="w-5 h-5 text-accent-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-on-surface">Calendar</h1>
            <p className="text-sm text-on-surface-muted">Your upcoming appointments, court dates, and deadlines.</p>
          </div>
        </div>
      </div>

      <ErrorNotification error={error} onClose={() => setError(null)} />

      <TruncatedListNotice truncated={eventsTruncated} unitLabel="events" mode="list" className="mb-6" />

      {groups.length === 0 ? (
        <ListEmptyState
          icon={<CalendarDays className="w-8 h-8" />}
          title="No upcoming events"
          message="When your legal team schedules a court date, appointment, or deadline, it will appear here."
        />
      ) : (
        <div className="space-y-6">
          {daysPager.pagedRows.map((group) => (
            <div key={group.date.toDateString()}>
              <div className="flex items-baseline gap-2 mb-2.5">
                <h2 className="text-sm font-semibold text-on-surface">
                  {group.date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </h2>
                <p className="text-[11px] text-on-surface-muted">
                  {group.date.toLocaleDateString('en-US', { year: 'numeric' })}
                </p>
              </div>

              <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] divide-y divide-outline-subtle overflow-hidden">
                {group.items.map((ev) => {
                  const date = toDateOrNull(ev.date);
                  const matterName = matterNames[ev.matterId];
                  return (
                    <div key={ev.id} className="p-4 flex items-start gap-3">
                      <div className="p-2 rounded-xl bg-accent-soft dark:bg-accent-soft text-accent-emphasis shrink-0">
                        <CalendarDays className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="text-sm font-semibold text-on-surface">
                            {ev.title || titleCase(ev.type) || 'Event'}
                          </h3>
                          {ev.type && ev.title && (
                            <StatusBadge variant={matterEventTypeMeta(ev.type).variant}>
                              {matterEventTypeMeta(ev.type).label}
                            </StatusBadge>
                          )}
                        </div>
                        <p className="text-[11px] text-on-surface-secondary mt-1">
                          <ZonedEventTime
                            when={ev.endsAt ? formatEventWhen({ id: ev.id, title: ev.title || '', start: ev.date || undefined, end: ev.endsAt, allDay: ev.allDay }) : ev.allDay ? 'All day' : date ? formatTime(date) : ''}
                            zone={eventZoneSuffix({ start: ev.date, end: ev.endsAt, timeZone: ev.timeZone, allDay: ev.allDay })}
                          />
                        </p>
                        {ev.location && (
                          <p className="flex items-center gap-1 text-[11px] text-on-surface-muted mt-1">
                            <MapPin className="w-3 h-3" /> <LinkifiedText text={ev.location} />
                          </p>
                        )}
                        {ev.description && (
                          <p className="text-[11px] text-on-surface-secondary mt-1 whitespace-pre-wrap"><LinkifiedText text={ev.description} /></p>
                        )}
                        {matterName && (
                          <NavigationLink
                            href={`/client/lawfirm/${lawFirmId}/matters/${ev.matterId}`}
                            className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-accent-emphasis hover:text-accent-emphasis-hover dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover"
                          >
                            <Scale className="w-3 h-3" />
                            {matterName}
                            <ChevronRight className="w-3 h-3" />
                          </NavigationLink>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {daysPager.total > daysPager.rowsPerPage && (
            <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] px-5 py-3">
              <AutoPager pager={daysPager} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
