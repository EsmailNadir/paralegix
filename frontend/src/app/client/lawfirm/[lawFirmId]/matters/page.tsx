"use client";

import { useEffect, useState, useMemo, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import clientPortalService from '@/services/client-portal.service';
import ErrorNotification from '@/components/ErrorNotification';
import { Search, ChevronRight, Briefcase, CalendarDays } from 'lucide-react';
import NavigationLink from '@/components/ui/NavigationLink';
import { AutoPager } from '@/components/ui/ListPager';
import ListSkeleton from '@/components/ui/ListSkeleton';
import ListEmptyState from '@/components/ui/ListEmptyState';
import usePagedRows from '@/hooks/usePagedRows';
import MatterStatusBadge from '@/components/ui/MatterStatusBadge';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import { useClientPortal } from '@/contexts/ClientPortalContext';
import ClientRecordPicker from '@/components/portalComp/ClientRecordPicker';
import { formatCurrency } from '@/lib/utils/currency';
import SectionLabel from '@/components/ui/SectionLabel';

interface Matter {
  id: string;
  title: string;
  matterNumber?: string;
  status: string;
  matterType?: string;
  opposingParty?: string | null;
  practiceAreaName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface MatterEvent {
  id: string;
  matterId: string;
  title?: string | null;
  type?: string | null;
  date?: string | null;
}


// Short calendar date (no year unless it differs from the current one).
const formatShortDate = (value: any): string => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
};

// "Updated 3 days ago" style relative label for the most recent activity.
const formatRelative = (value: any): string => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const day = 1000 * 60 * 60 * 24;
  const days = Math.floor(diffMs / day);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return 'a month ago';
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'a year ago' : `${years} years ago`;
};

export default function ClientMattersPage() {
  const params = useParams();
  const { user } = useAuth();
  const lawFirmId = params.lawFirmId as string;
  const { associations, associationsLoading, activeAssociation, selectionRequired, setActiveClientRecordId } = useClientPortal();
  const clientRecordId = activeAssociation?.clientRecordId;

  const [matters, setMatters] = useState<Matter[]>([]);
  const [events, setEvents] = useState<MatterEvent[]>([]);
  // Outstanding balance per matter id, summed from matter-context invoices.
  const [outstandingByMatter, setOutstandingByMatter] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Held until the active client-record association resolves: an ambiguous
    // uid (selectionRequired) has nothing to fetch yet, and any request without
    // a resolved clientRecordId would just 400.
    if (!lawFirmId || !user || associationsLoading || selectionRequired) return;

    const fetchMatters = async () => {
      try {
        setLoading(true);
        setError(null);
        // Matters are required; events + billing only enrich the cards, so a
        // failure in either must not block the list from rendering.
        const [mattersRes, eventsRes, billingRes] = await Promise.allSettled([
          clientPortalService.getMatters(lawFirmId, clientRecordId),
          clientPortalService.getEvents(lawFirmId, { clientRecordId }),
          clientPortalService.getBilling(lawFirmId, { clientRecordId }),
        ]);

        if (mattersRes.status === 'fulfilled') {
          setMatters(mattersRes.value.matters || []);
        } else {
          throw mattersRes.reason;
        }

        if (eventsRes.status === 'fulfilled') {
          setEvents(eventsRes.value.events || []);
        }

        if (billingRes.status === 'fulfilled') {
          const totals: Record<string, number> = {};
          for (const inv of billingRes.value.invoices || []) {
            if (!inv.matterId) continue;
            const remaining =
              typeof inv.remainingBalance === 'number'
                ? inv.remainingBalance
                : Math.max(0, (inv.totalAmount || 0) - (inv.amountPaid || 0) - (inv.totalWrittenOff || 0));
            if (remaining > 0) {
              totals[inv.matterId] = (totals[inv.matterId] || 0) + remaining;
            }
          }
          setOutstandingByMatter(totals);
        }
      } catch (err) {
        console.error('Error fetching matters:', err);
        const msg = getErrorMessage(err, 'Failed to load matters');
        // Don't show "access denied" as an error. The empty state handles it
        if (!msg.toLowerCase().includes('not associated')) {
          setError(msg);
        }
      } finally {
        setLoading(false);
      }
    };

    fetchMatters();
  }, [lawFirmId, user, associationsLoading, selectionRequired, clientRecordId]);

  // Soonest upcoming event per matter. getEvents returns only upcoming,
  // client-visible events already ordered by date ascending, so the first match
  // for a matter is its next event.
  const nextEventByMatter = useMemo(() => {
    const map: Record<string, MatterEvent> = {};
    for (const ev of events) {
      if (ev.matterId && !map[ev.matterId]) {
        map[ev.matterId] = ev;
      }
    }
    return map;
  }, [events]);

  const filteredMatters = useMemo(() => {
    return matters.filter(c =>
      c.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.matterNumber?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.matterType?.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [matters, searchTerm]);
  // An institutional client can be on many matters, so the rendered cards are
  // windowed.
  const mattersPager = usePagedRows(filteredMatters, 15, searchTerm);


  if (selectionRequired) {
    return <ClientRecordPicker associations={associations} onSelect={setActiveClientRecordId} />;
  }

  if (loading) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto min-w-0">
        <ListSkeleton rows={6} label="Loading your matters" />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1600px] mx-auto min-w-0">
      {/* Header */}
      <div className="mb-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-on-surface">My Matters</h1>
            <p className="text-sm text-on-surface-muted mt-1">Track the progress and details of your legal matters.</p>
          </div>

          {matters.length > 0 && (
            <div className="relative max-w-xs w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-muted" />
              <input
                type="text"
                ref={searchRef}
                aria-label="Search matters"
                className="w-full pl-9 pr-3 py-2 bg-input-bg border border-input-border rounded-xl text-sm text-on-surface placeholder-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring dark: transition-all"
                placeholder="Search matters..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          )}
        </div>
      </div>

      <ErrorNotification error={error} onClose={() => setError(null)} />

      <p role="status" aria-atomic="true" className="sr-only">
        {matters.length > 0 ? `${filteredMatters.length} matter${filteredMatters.length === 1 ? "" : "s"} found` : ""}
      </p>

      {/* Empty State */}
      {matters.length === 0 ? (
        <ListEmptyState
          icon={<Briefcase className="w-8 h-8" />}
          title="No active matters"
          message="You don't have any matters associated with this law firm yet. Once your attorney creates a matter, it will appear here."
        />
      ) : (
        <>
          {filteredMatters.length === 0 ? (
            <ListEmptyState
              compact
              title={`No matters match your search "${searchTerm}"`}
              action={(
                <button
                  onClick={() => { setSearchTerm(''); searchRef.current?.focus(); }}
                  className="text-accent-emphasis hover:text-accent-emphasis-hover text-xs font-semibold cursor-pointer"
                >
                  Clear search
                </button>
              )}
            />
          ) : (
            <div className="space-y-3">
              {mattersPager.pagedRows.map((matterItem) => {
                const nextEvent = nextEventByMatter[matterItem.id];
                const outstanding = outstandingByMatter[matterItem.id] || 0;
                const updatedLabel = formatRelative(matterItem.updatedAt || matterItem.createdAt);

                return (
                  <NavigationLink
                    key={matterItem.id}
                    href={`/client/lawfirm/${lawFirmId}/matters/${matterItem.id}`}
                    aria-labelledby={`matter-${matterItem.id}-title`}
                    className="block group bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] hover:shadow-md hover:border-accent-border-soft dark:hover:border-accent-border-soft transition-all cursor-pointer"
                  >
                    <div className="p-5">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2">
                            <MatterStatusBadge status={matterItem.status} />
                            {updatedLabel && (
                              <span className="text-[10px] text-on-surface-muted">Updated {updatedLabel}</span>
                            )}
                          </div>
                          <h2 id={`matter-${matterItem.id}-title`} className="text-base font-bold text-on-surface truncate group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors">
                            {matterItem.title}
                          </h2>
                        </div>

                        <div className="ml-4 flex-shrink-0 self-center">
                          <div className="w-7 h-7 rounded-lg bg-surface-alt flex items-center justify-center text-on-surface-muted group-hover:bg-accent-soft dark:group-hover:bg-accent-soft group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors">
                            <ChevronRight className="w-4 h-4" />
                          </div>
                        </div>
                      </div>

                      <div className="h-px bg-outline-subtle my-3" />

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div>
                          <SectionLabel>Matter Number</SectionLabel>
                          <p className="text-xs font-medium text-on-surface mt-0.5 truncate">{matterItem.matterNumber || '--'}</p>
                        </div>
                        <div>
                          <SectionLabel>Matter Type</SectionLabel>
                          <p className="text-xs font-medium text-on-surface mt-0.5 truncate">{matterItem.matterType || matterItem.practiceAreaName || 'General Practice'}</p>
                        </div>
                        {matterItem.practiceAreaName && (
                          <div>
                            <SectionLabel>Practice Area</SectionLabel>
                            <p className="text-xs font-medium text-on-surface mt-0.5 truncate">{matterItem.practiceAreaName}</p>
                          </div>
                        )}
                        {matterItem.opposingParty && (
                          <div>
                            <SectionLabel>Opposing Party</SectionLabel>
                            <p className="text-xs font-medium text-on-surface mt-0.5 truncate">{matterItem.opposingParty}</p>
                          </div>
                        )}
                      </div>

                      {/* Activity footer: next event + outstanding balance. Only
                          rendered when there's something to surface. */}
                      {(nextEvent || outstanding > 0) && (
                        <div className="flex flex-wrap items-center gap-2 mt-3">
                          {nextEvent && (
                            <span className="inline-flex items-center gap-1.5 rounded-lg bg-accent-soft dark:bg-accent-soft text-accent-emphasis dark:text-accent-emphasis px-2 py-1 text-[11px] font-medium">
                              <CalendarDays className="w-3.5 h-3.5" />
                              {nextEvent.title || nextEvent.type || 'Event'}
                              {formatShortDate(nextEvent.date) && (
                                <span className="opacity-70">· {formatShortDate(nextEvent.date)}</span>
                              )}
                            </span>
                          )}
                          {outstanding > 0 && (
                            <span className="inline-flex items-center gap-1.5 rounded-lg bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 px-2 py-1 text-[11px] font-semibold">
                              {formatCurrency(outstanding)} due
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </NavigationLink>
                );
              })}
              {mattersPager.total > mattersPager.rowsPerPage && (
                <div className="px-4 py-3">
                  <AutoPager pager={mattersPager} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
