'use client';

import AdminAccessRequired from '@/components/adminComp/AdminAccessRequired';
import AdminDirectorySearch from "@/components/adminComp/AdminDirectorySearch";
import AdminFirmPicker from '@/components/adminComp/AdminFirmPicker';
import AdminStatCards from '@/components/adminComp/AdminStatCards';
import ErrorNotification from '@/components/ErrorNotification';
import LoadingSpinner from '@/components/LoadingSpinner';
import Button from '@/components/ui/Button';
import Dropdown from '@/components/ui/Dropdown';
import ListPager,{ DEFAULT_ROWS_PER_PAGE_OPTIONS,pagerWillRender } from '@/components/ui/ListPager';
import SortableTh from '@/components/ui/SortableTh';
import StatusBadge from '@/components/ui/StatusBadge';
import Tooltip from "@/components/ui/Tooltip";
import { clientPortalStatusMeta } from '@/constants/statusMeta';
import useAdminDirectoryData from "@/hooks/adminHooks/useAdminDirectoryData";
import { useAuth } from '@/hooks/useAuth';
import { SEARCH_DEBOUNCE_MS } from '@/lib/constants/search';
import {
RECENCY_WINDOWS,
formatAge,
formatDateTime,
recencyWindowStart,
shareLabel,
} from '@/lib/utils/adminConsole';
import adminService,{
type AdminClientListQuery,
type AdminClientRecord,
type AdminClientStats,
type ClientPortalStatus,
} from '@/services/admin.service';
import userService from '@/services/users.service';
import { AlertTriangle,Building2,RefreshCw,Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback,useEffect,useMemo,useState } from 'react';
import { flushSync } from 'react-dom';

/** Rows per page. Every client record on the platform lands in this table. */

const EMPTY_STATS: AdminClientStats = {
  total: 0, withPortal: 0, invitesPending: 0, new7d: 0, new30d: 0,
  personCount: 0, companyCount: 0, rosterContactTotal: 0, rosterPortalTotal: 0, peopleTotal: 0,
};

const PORTAL_OPTIONS = [
  { label: 'Any portal state', value: '' },
  { label: 'Portal account linked', value: 'linked' },
  { label: 'Invite pending', value: 'pending' },
  { label: 'Never invited', value: 'none' },
];

const STATUS_OPTIONS = [
  { label: 'All statuses', value: '' },
  { label: 'Active', value: 'active' },
  { label: 'Inactive', value: 'inactive' },
  { label: 'Archived', value: 'archived' },
];

const CLIENT_TYPE_OPTIONS = [
  { label: 'Any type', value: '' },
  { label: 'Person', value: 'person' },
  { label: 'Organization', value: 'company' },
];

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

export default function AdminClientsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const { rows: clients, setRows: setClients, stats, setStats, totalItems, loadingData, error, setError,
    page, setPage, rowsPerPage, setRowsPerPage, search, setSearch, sort, setSort, load: loadDirectory } = useAdminDirectoryData<AdminClientRecord, AdminClientStats>(EMPTY_STATS);
  const [checkingAccess, setCheckingAccess] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [navigating, setNavigating] = useState(false);



  const [firmId, setFirmId] = useState('');
  const [portal, setPortal] = useState('');
  const [status, setStatus] = useState('');
  const [clientType, setClientType] = useState('');
  const [createdWithin, setCreatedWithin] = useState('');

  const navigateTo = useCallback((path: string) => {
    if (navigating) return;

    flushSync(() => {
      setNavigating(true);
    });

    window.requestAnimationFrame(() => {
      router.push(path);
    });
  }, [navigating, router]);

  // Every filter is applied in SQL, so a narrowed view still reaches the whole
  // platform and the footer count keeps matching the rows.
  const query = useMemo<AdminClientListQuery>(() => ({
    limit: rowsPerPage,
    search: search.trim() || undefined,
    sortBy: sort.field,
    order: sort.direction,
    lawFirmId: firmId || undefined,
    portal: (portal || undefined) as ClientPortalStatus | undefined,
    status: status || undefined,
    clientType: (clientType || undefined) as AdminClientListQuery['clientType'],
    createdAfter: recencyWindowStart(createdWithin),
  }), [search, sort, firmId, portal, status, clientType, createdWithin, rowsPerPage]);

  const loadClients = useCallback(async (targetPage: number) => {
    await loadDirectory(async () => {
      const result = await adminService.getClientsPaged({ ...query, page: targetPage });
      return { rows: result.clients, totalItems: result.totalItems, stats: result.stats };
    });
  }, [query, loadDirectory]);

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

        // The query effect below owns the first load, so it is not started here
        // as well.
        setIsAdmin(hasAdminAccess);
      } catch (err) {
        if (!active) return;
        setError(getErrorMessage(err));
      } finally {
        if (active) {
          setCheckingAccess(false);
        }
      }
    };

    checkAccess();

    return () => {
      active = false;
    };
  }, [authLoading, user, router]);

  // Any change to the query restarts at page 1, since the previous offset belongs
  // to a different result set. Running on `isAdmin` too makes this the single
  // initial load, hence the immediate first pass when nothing is typed.
  useEffect(() => {
    if (!isAdmin) return;
    const timer = window.setTimeout(() => {
      setPage(1);
      loadClients(1);
    }, search.trim() ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isAdmin]);

  const goToPage = useCallback((next: number) => {
    setPage(next);
    loadClients(next);
  }, [loadClients]);

  const totalPages = Math.max(1, Math.ceil(totalItems / rowsPerPage));
  const filtersActive = !!(search.trim() || firmId || portal || status || clientType || createdWithin);

  const clearFilters = useCallback(() => {
    setSearch('');
    setFirmId('');
    setPortal('');
    setStatus('');
    setClientType('');
    setCreatedWithin('');
  }, []);

  if (authLoading || checkingAccess || navigating) {
    return <LoadingSpinner fullPage />;
  }

  if (!user) {
    return null;
  }

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
              <h1 className="text-2xl font-bold text-on-surface mt-1">Clients</h1>
              <p className="text-sm text-on-surface-secondary mt-1">
                Every client record across all firms, with the firm that owns it and whether they reached the portal.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button type="secondary" onClick={() => navigateTo('/admin')}>
                Admin Home
              </Button>
              <Button type="secondary" onClick={() => navigateTo('/admin/users')}>
                User Accounts
              </Button>
              <Button
                type="primary"
                onClick={() => loadClients(page)}
                disabled={loadingData}
                icon={<RefreshCw className={`w-4 h-4 ${loadingData ? 'animate-spin' : ''}`} />}
              >
                Refresh
              </Button>
            </div>
          </div>
        </div>

        <ErrorNotification error={error} onClose={() => setError(null)} />

        <AdminStatCards
          columns={6}
          stats={[
            {
              label: 'Client records',
              value: stats.total,
              hint: `${stats.personCount.toLocaleString()} people, ${stats.companyCount.toLocaleString()} companies`,
            },
            {
              // Records undercount people once a company is in the mix: a
              // company is one record no matter how many roster contacts it
              // carries, so this adds those contacts back in.
              label: 'People total',
              value: stats.peopleTotal,
              hint: stats.rosterContactTotal
                ? `${stats.rosterContactTotal.toLocaleString()} via company rosters (${stats.rosterPortalTotal.toLocaleString()} with portal access)`
                : undefined,
            },
            {
              label: 'Portal accounts',
              value: stats.withPortal,
              hint: shareLabel(stats.withPortal, stats.total, 'of clients'),
            },
            {
              label: 'Invites pending',
              value: stats.invitesPending,
              hint: stats.invitesPending ? 'Sent, not yet accepted' : undefined,
            },
            { label: 'New (7 days)', value: stats.new7d, accent: stats.new7d > 0 },
            { label: 'New (30 days)', value: stats.new30d, accent: stats.new30d > 0 },
          ]}
        />

        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-outline-subtle space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <AdminDirectorySearch id="admin-client-search" value={search} onChange={setSearch} placeholder="Name, email, organization, or firm..." />

              <div className="w-[260px]">
                <AdminFirmPicker
                  label="Law firm"
                  value={firmId}
                  onChange={setFirmId}
                  placeholder="Any firm"
                />
              </div>

              <Dropdown
                label="Portal"
                value={portal}
                onChange={setPortal}
                options={PORTAL_OPTIONS}
                className="w-[200px]"
              />

              <Dropdown
                label="Status"
                value={status}
                onChange={setStatus}
                options={STATUS_OPTIONS}
                className="w-[160px]"
              />

              <Dropdown
                label="Type"
                value={clientType}
                onChange={setClientType}
                options={CLIENT_TYPE_OPTIONS}
                className="w-[160px]"
              />

              <Dropdown
                label="Added"
                value={createdWithin}
                onChange={setCreatedWithin}
                options={[...RECENCY_WINDOWS]}
                className="w-[170px]"
              />

              {filtersActive && (
                <Button type="secondary" size="small" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>

            <p className="text-sm text-on-surface-secondary">
              {loadingData
                ? 'Loading…'
                : `${totalItems.toLocaleString()} ${totalItems === 1 ? 'client' : 'clients'} match`}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-surface-alt text-on-surface-secondary">
                <tr>
                  <SortableTh field="name" label="Client" sort={sort} onSortChange={setSort} />
                  <SortableTh field="email" label="Email" sort={sort} onSortChange={setSort} />
                  <SortableTh field="lawFirmName" label="Law Firm" sort={sort} onSortChange={setSort} />
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Portal</th>
                  <SortableTh
                    field="matterCount"
                    label="Matters"
                    sort={sort}
                    onSortChange={setSort}
                    defaultDirection="desc"
                    align="right"
                  />
                  <SortableTh field="status" label="Status" sort={sort} onSortChange={setSort} />
                  <SortableTh
                    field="createdAt"
                    label="Added"
                    sort={sort}
                    onSortChange={setSort}
                    defaultDirection="desc"
                  />
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.id} className="border-t border-outline-subtle">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {client.clientType === 'company' && (
                          <Tooltip title="Organization client" enterDelay={300}>
                            <Building2 size={14} className="text-accent-emphasis shrink-0" />
                          </Tooltip>
                        )}
                        <p className="font-medium text-on-surface">{client.name || '-'}</p>
                      </div>
                      {client.organization && (
                        <p className="text-xs text-on-surface-muted">{client.organization}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-on-surface-secondary">{client.email || '-'}</td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => navigateTo(`/admin/lawfirms/${client.lawFirmId}`)}
                        className="text-left text-on-surface hover:text-accent-emphasis transition-colors cursor-pointer"
                      >
                        {client.lawFirmName}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      {client.clientType === 'company' ? (
                        // A company never carries `portalStatus` of its own (it has
                        // no direct login), so the linked/pending/none badge below
                        // would always read "Never invited" here regardless of how
                        // many roster contacts actually have portal access.
                        <div className="flex items-center gap-1.5 text-on-surface-secondary">
                          <Users size={14} className="text-on-surface-muted shrink-0" />
                          <span>
                            {client.rosterPortalCount.toLocaleString()} roster {client.rosterPortalCount === 1 ? 'user' : 'users'}
                          </span>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-1.5">
                            <StatusBadge variant={clientPortalStatusMeta(client.portalStatus).variant}>
                              {clientPortalStatusMeta(client.portalStatus).label}
                            </StatusBadge>
                            {client.invitationFailed && (
                              <Tooltip title="The last portal invitation email failed to send" enterDelay={300}>
                                <AlertTriangle size={14} className="text-red-500 shrink-0" />
                              </Tooltip>
                            )}
                          </div>
                          {client.portalStatus === 'linked' && client.joinedAt && (
                            <p className="text-xs text-on-surface-muted mt-0.5">
                              Joined {formatAge(client.joinedAt)}
                            </p>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-on-surface-secondary">{client.matterCount}</td>
                    <td className="px-4 py-3 text-on-surface-secondary capitalize">{client.status}</td>
                    <td className="px-4 py-3 text-on-surface-secondary whitespace-nowrap">
                      <Tooltip title={formatDateTime(client.createdAt)} enterDelay={300}>
                        <span>{formatAge(client.createdAt)}</span>
                      </Tooltip>
                    </td>
                  </tr>
                ))}
                {clients.length === 0 && !loadingData && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-on-surface-secondary">
                      {filtersActive ? 'No clients match these filters.' : 'No clients found.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {pagerWillRender(totalItems) && (
            <div className="mt-4 px-5 pb-4">
              <ListPager
                page={page}
                totalPages={totalPages}
                total={totalItems}
                rowsPerPage={rowsPerPage}
                onPageChange={goToPage}
                onRowsPerPageChange={setRowsPerPage}
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
