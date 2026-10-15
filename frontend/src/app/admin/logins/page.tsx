'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin, RefreshCw, Search } from 'lucide-react';
import { flushSync } from 'react-dom';
import { SEARCH_DEBOUNCE_MS } from '@/lib/constants/search';
import { useAuth } from '@/hooks/useAuth';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorNotification from '@/components/ErrorNotification';
import Button from '@/components/ui/Button';
import Dropdown from '@/components/ui/Dropdown';
import ListPager, { DEFAULT_ROWS_PER_PAGE_OPTIONS, pagerWillRender } from '@/components/ui/ListPager';
import userService from '@/services/users.service';
import adminService, { type AdminAuditEvent } from '@/services/admin.service';
import FieldLabel from '@/components/ui/FieldLabel';
import AdminAccessRequired from '@/components/adminComp/AdminAccessRequired';

const PAGE_SIZE = 50;

// action=auth.login is the login stream; empty action returns every audited event.
const ACTION_OPTIONS = [
  { label: 'Logins', value: 'auth.login' },
  { label: 'All activity', value: '' },
];

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

function providerLabel(provider?: string | null): string {
  switch (provider) {
    case 'google.com': return 'Google';
    case 'microsoft.com': return 'Microsoft';
    case 'password': return 'Email/Password';
    default: return provider || '-';
  }
}

function locationLabel(event: AdminAuditEvent): string {
  const loc = event.metadata?.location;
  if (!loc) return '-';
  const parts = [loc.city, loc.region, loc.country].filter(Boolean);
  return parts.length ? parts.join(', ') : '-';
}

function formatTime(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

export default function AdminLoginsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [checkingAccess, setCheckingAccess] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  // Id of the most recently issued list request; guards against an older,
  // slower page/filter/search load overwriting a newer one's rows.
  const loadRequestIdRef = useRef(0);

  const [error, setError] = useState<string | null>(null);

  const [events, setEvents] = useState<AdminAuditEvent[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [action, setAction] = useState('auth.login');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(PAGE_SIZE);
  const [search, setSearch] = useState('');

  const navigateTo = useCallback((path: string) => {
    if (navigating) return;
    flushSync(() => setNavigating(true));
    window.requestAnimationFrame(() => router.push(path));
  }, [navigating, router]);

  const loadEvents = useCallback(async (opts?: { action?: string; page?: number; search?: string; limit?: number }) => {
    const effectiveAction = opts?.action ?? action;
    const effectivePage = opts?.page ?? page;
    const effectiveSearch = opts?.search ?? search;
    // Passed explicitly by the page-size control, whose new value has not
    // reached this callback's closure yet when it fires.
    const effectiveLimit = opts?.limit ?? rowsPerPage;
    const requestId = ++loadRequestIdRef.current;
    setLoadingData(true);
    setError(null);
    try {
      const result = await adminService.getAuditEvents({
        action: effectiveAction || undefined,
        search: effectiveSearch.trim() || undefined,
        limit: effectiveLimit,
        offset: effectivePage * effectiveLimit,
      });
      // A later filter/page/search change may have started its own load while
      // this one was in flight; a slower response here would otherwise
      // silently replace rows that no longer match what the controls show.
      if (requestId !== loadRequestIdRef.current) return;
      setEvents(result.items);
      setTotalItems(result.totalItems);
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (requestId === loadRequestIdRef.current) setLoadingData(false);
    }
  }, [action, page, search, rowsPerPage]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace('/login');
      return;
    }

    let active = true;
    const checkAccess = async () => {
      setCheckingAccess(true);
      setError(null);
      try {
        const profile = await userService.getProfile();
        const hasAdminAccess = (profile as { isAdmin?: boolean })?.isAdmin === true;
        if (!active) return;
        // The search effect below owns the first load, so it is not kicked off
        // here as well.
        setIsAdmin(hasAdminAccess);
      } catch (err) {
        if (!active) return;
        setError(getErrorMessage(err));
      } finally {
        if (active) setCheckingAccess(false);
      }
    };
    checkAccess();
    return () => { active = false; };
     
  }, [authLoading, user, router]);

  const handleActionChange = useCallback((next: string) => {
    setAction(next);
    setPage(0);
    loadEvents({ action: next, page: 0 });
  }, [loadEvents]);

  const goToPage = useCallback((next: number) => {
    setPage(next);
    loadEvents({ page: next });
  }, [loadEvents]);

  // A different page size re-cuts the log, so the current offset no longer
  // points at the same events. Rewind to the most recent page.
  const changeRowsPerPage = useCallback((next: number) => {
    setRowsPerPage(next);
    setPage(0);
    loadEvents({ page: 0, limit: next });
  }, [loadEvents]);

  // The term is applied in SQL, so it covers the whole log and the row count in
  // the footer keeps matching what is on screen. Filtering the loaded page here
  // instead would search only the 50 rows the admin happens to be looking at.
  // Any search resets to page 1, since the previous offset belongs to a
  // different result set. Running on `isAdmin` as well makes this the single
  // initial load, hence the immediate first pass when there is nothing typed.
  useEffect(() => {
    if (!isAdmin) return;
    const timer = window.setTimeout(() => {
      setPage(0);
      loadEvents({ page: 0, search });
    }, search.trim() ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, isAdmin]);

  const showingLogins = action === 'auth.login';
  const rangeStart = totalItems === 0 ? 0 : page * rowsPerPage + 1;
  const rangeEnd = Math.min(totalItems, (page + 1) * rowsPerPage);

  if (authLoading || checkingAccess || navigating) {
    return <LoadingSpinner fullPage />;
  }

  if (!user) return null;

  if (!isAdmin) {
    return <AdminAccessRequired onBack={() => navigateTo('/dashboard')} />;
  }

  return (
    <div className="min-h-screen bg-page p-4 md:p-8">
      <div className="max-w-[1600px] mx-auto space-y-6">
        <div className="bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.12em] text-on-surface-muted font-semibold">Global Admin</p>
              <h1 className="text-2xl font-bold text-on-surface mt-1">Login Activity</h1>
              <p className="text-sm text-on-surface-secondary mt-1">
                Sign-in events across all firms, with approximate location, device, and IP.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button type="secondary" onClick={() => navigateTo('/admin')}>
                Admin Home
              </Button>
              <Button
                type="primary"
                onClick={() => loadEvents()}
                disabled={loadingData}
                icon={<RefreshCw className={`w-4 h-4 ${loadingData ? 'animate-spin' : ''}`} />}
              >
                Refresh
              </Button>
            </div>
          </div>
        </div>

        <ErrorNotification error={error} onClose={() => setError(null)} />

        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-outline-subtle flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="flex items-end gap-3">
              <div className="w-[180px]">
                <FieldLabel>Show</FieldLabel>
                <Dropdown
                  value={action}
                  onChange={handleActionChange}
                  options={ACTION_OPTIONS}
                  portal
                />
              </div>
              <p className="text-sm text-on-surface-secondary pb-2">
                {totalItems === 0
                  ? 'No events'
                  : `Showing ${rangeStart}–${rangeEnd} of ${totalItems}`}
              </p>
            </div>
            <div className="relative w-full md:w-[320px]">
              <Search className="w-4 h-4 text-on-surface-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter by user, firm, IP, location..."
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-input-border bg-input-bg text-sm text-on-surface placeholder-on-surface-muted"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-surface-alt text-on-surface-secondary">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold whitespace-nowrap">Time</th>
                  <th className="px-4 py-3 text-left font-semibold">User</th>
                  <th className="px-4 py-3 text-left font-semibold">Firm</th>
                  {showingLogins
                    ? <th className="px-4 py-3 text-left font-semibold">Method</th>
                    : <th className="px-4 py-3 text-left font-semibold">Action</th>}
                  <th className="px-4 py-3 text-left font-semibold">Location</th>
                  <th className="px-4 py-3 text-left font-semibold">IP</th>
                  <th className="px-4 py-3 text-left font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-t border-outline-subtle align-top">
                    <td className="px-4 py-3 text-on-surface-secondary whitespace-nowrap">{formatTime(e.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-on-surface">{e.actorName || e.actorEmail || '-'}</div>
                      {e.actorName && e.actorEmail && (
                        <div className="text-xs text-on-surface-muted">{e.actorEmail}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-on-surface-secondary">{e.lawFirmName || (e.lawFirmId ? e.lawFirmId : 'Global')}</td>
                    <td className="px-4 py-3 text-on-surface-secondary">
                      {showingLogins ? providerLabel(e.metadata?.provider) : e.action}
                    </td>
                    <td className="px-4 py-3 text-on-surface-secondary">
                      {locationLabel(e) !== '-' ? (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="w-3.5 h-3.5 text-on-surface-muted" />
                          {locationLabel(e)}
                        </span>
                      ) : '-'}
                    </td>
                    <td className="px-4 py-3 text-on-surface-secondary font-mono text-xs">{e.ip || '-'}</td>
                    <td className="px-4 py-3 text-on-surface-secondary">{e.statusCode ?? '-'}</td>
                  </tr>
                ))}
                {events.length === 0 && !loadingData && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-on-surface-secondary">
                      {search.trim() ? 'No events match your search.' : 'No login events recorded yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* The shared pager is 1-based; this list pages from 0. */}
          {pagerWillRender(totalItems) && (
          <div className="px-5 py-4 border-t border-outline-subtle">
            <ListPager
              page={page + 1}
              totalPages={Math.max(1, Math.ceil(totalItems / rowsPerPage))}
              total={totalItems}
              rowsPerPage={rowsPerPage}
              onPageChange={(next) => goToPage(next - 1)}
              onRowsPerPageChange={changeRowsPerPage}
              rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
              busy={loadingData}
              serverPaged
            />
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
