'use client';

import AdminAccessRequired from '@/components/adminComp/AdminAccessRequired';
import AdminDirectorySearch from "@/components/adminComp/AdminDirectorySearch";
import AdminFirmPicker from '@/components/adminComp/AdminFirmPicker';
import AdminStatCards from '@/components/adminComp/AdminStatCards';
import ErrorNotification from '@/components/ErrorNotification';
import LoadingSpinner from '@/components/LoadingSpinner';
import SuccessNotification from '@/components/SuccessNotification';
import Button from '@/components/ui/Button';
import Dropdown from '@/components/ui/Dropdown';
import ListPager,{ DEFAULT_ROWS_PER_PAGE_OPTIONS,pagerWillRender } from '@/components/ui/ListPager';
import SortableTh from '@/components/ui/SortableTh';
import StatusBadge from '@/components/ui/StatusBadge';
import Tooltip from "@/components/ui/Tooltip";
import { userTypeMeta } from '@/constants/statusMeta';
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
type AdminUser,
type AdminUserFirm,
type AdminUserListQuery,
type AdminUserStats,
type AdminUserType,
} from '@/services/admin.service';
import userService from '@/services/users.service';
import { Building2,RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback,useEffect,useMemo,useState } from 'react';
import { flushSync } from 'react-dom';

/** Rows per page. Every account on the platform lands in this table. */

const EMPTY_STATS: AdminUserStats = {
  total: 0, clients: 0, firmMembers: 0, pending: 0, admins: 0,
  new24h: 0, new7d: 0, new30d: 0,
};

const USER_TYPE_OPTIONS = [
  { label: 'All types', value: '' },
  { label: 'Firm member', value: 'firm_member' },
  { label: 'Client', value: 'client' },
  { label: 'Pending', value: 'pending' },
];

const ADMIN_OPTIONS = [
  { label: 'Everyone', value: '' },
  { label: 'Platform admins', value: 'true' },
  { label: 'Non-admins', value: 'false' },
];

/**
 * `user_type` is stored snake_case, so it can never be rendered raw - the
 * Tailwind `capitalize` class would produce "Firm_member".
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

/** Firebase provider ids as recorded on the login audit event. */
function providerLabel(provider: string): string {
  switch (provider) {
    case 'google.com': return 'Google';
    case 'microsoft.com': return 'Microsoft';
    case 'password': return 'Email/Password';
    default: return provider;
  }
}

export default function AdminUsersPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const { rows: users, setRows: setUsers, stats, setStats, totalItems, loadingData, error, setError,
    page, setPage, rowsPerPage, setRowsPerPage, search, setSearch, sort, setSort, load: loadDirectory } = useAdminDirectoryData<AdminUser, AdminUserStats>(EMPTY_STATS);
  const [checkingAccess, setCheckingAccess] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [updatingAdminUserId, setUpdatingAdminUserId] = useState<string | null>(null);

  const [successMessage, setSuccessMessage] = useState<string | null>(null);


  const [userType, setUserType] = useState('');
  const [adminFilter, setAdminFilter] = useState('');
  const [firmId, setFirmId] = useState('');
  const [signedUpWithin, setSignedUpWithin] = useState('');

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
  const query = useMemo<AdminUserListQuery>(() => ({
    limit: rowsPerPage,
    search: search.trim() || undefined,
    sortBy: sort.field,
    order: sort.direction,
    userType: (userType || undefined) as AdminUserType | undefined,
    isAdmin: adminFilter === '' ? undefined : adminFilter === 'true',
    lawFirmId: firmId || undefined,
    createdAfter: recencyWindowStart(signedUpWithin),
  }), [search, sort, userType, adminFilter, firmId, signedUpWithin, rowsPerPage]);

  const loadUsers = useCallback(async (targetPage: number, overrides?: AdminUserListQuery) => {
    await loadDirectory(async () => {
      const result = await adminService.getUsersPaged({ ...query, ...overrides, page: targetPage });
      return { rows: result.users, totalItems: result.totalItems, stats: result.stats };
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
      loadUsers(1);
    }, search.trim() ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isAdmin]);

  const goToPage = useCallback((next: number) => {
    setPage(next);
    loadUsers(next);
  }, [loadUsers]);

  useEffect(() => {
    if (!successMessage) return;

    const timeout = setTimeout(() => setSuccessMessage(null), 4000);
    return () => clearTimeout(timeout);
  }, [successMessage]);

  const totalPages = Math.max(1, Math.ceil(totalItems / rowsPerPage));
  const filtersActive = !!(search.trim() || userType || adminFilter || firmId || signedUpWithin);

  const clearFilters = useCallback(() => {
    setSearch('');
    setUserType('');
    setAdminFilter('');
    setFirmId('');
    setSignedUpWithin('');
  }, []);

  const handleSetAdmin = useCallback(async (targetUser: AdminUser, nextIsAdmin: boolean) => {
    if (!targetUser.uid) return;
    if (targetUser.isAdmin === nextIsAdmin) return;

    setUpdatingAdminUserId(targetUser.uid);
    setError(null);

    try {
      const result = await adminService.updateUserAdmin(targetUser.uid, nextIsAdmin);
      setUsers((prev) => prev.map((entry) => (
        // The response carries only the user row, so the firm affiliations this
        // table renders are preserved from the row already on screen rather than
        // being blanked by the merge.
        entry.uid === targetUser.uid
          ? { ...entry, ...result.user, memberFirms: entry.memberFirms, clientFirms: entry.clientFirms }
          : entry
      )));
      setStats((prev) => ({ ...prev, admins: prev.admins + (nextIsAdmin ? 1 : -1) }));
      const label = result.user.name || result.user.email || targetUser.uid;
      setSuccessMessage(nextIsAdmin
        ? `Granted admin access to ${label}.`
        : `Removed admin access for ${label}.`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setUpdatingAdminUserId(null);
    }
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
              <h1 className="text-2xl font-bold text-on-surface mt-1">Users</h1>
              <p className="text-sm text-on-surface-secondary mt-1">
                Every account on the platform, newest signup first, with the firms each one belongs to.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button type="secondary" onClick={() => navigateTo('/admin')}>
                Admin Home
              </Button>
              <Button
                type="primary"
                onClick={() => loadUsers(page)}
                disabled={loadingData}
                icon={<RefreshCw className={`w-4 h-4 ${loadingData ? 'animate-spin' : ''}`} />}
              >
                Refresh
              </Button>
            </div>
          </div>
        </div>

        <ErrorNotification error={error} onClose={() => setError(null)} />

        <SuccessNotification message={successMessage} onClose={() => setSuccessMessage(null)} />

        <AdminStatCards
          columns={4}
          stats={[
            { label: 'Total users', value: stats.total },
            { label: 'New (24h)', value: stats.new24h, accent: stats.new24h > 0 },
            { label: 'New (7 days)', value: stats.new7d, accent: stats.new7d > 0 },
            { label: 'New (30 days)', value: stats.new30d, accent: stats.new30d > 0 },
            {
              label: 'Firm members',
              value: stats.firmMembers,
              hint: shareLabel(stats.firmMembers, stats.total),
            },
            { label: 'Clients', value: stats.clients, hint: shareLabel(stats.clients, stats.total) },
            {
              label: 'Pending',
              value: stats.pending,
              hint: stats.pending ? 'Registration not finished' : undefined,
            },
            { label: 'Platform admins', value: stats.admins },
          ]}
        />

        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-outline-subtle space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <AdminDirectorySearch id="admin-user-search" value={search} onChange={setSearch} placeholder="Name, email, or UID..." />

              <Dropdown
                label="Type"
                value={userType}
                onChange={setUserType}
                options={USER_TYPE_OPTIONS}
                className="w-[170px]"
              />

              <Dropdown
                label="Signed up"
                value={signedUpWithin}
                onChange={setSignedUpWithin}
                options={[...RECENCY_WINDOWS]}
                className="w-[170px]"
              />

              <Dropdown
                label="Admin access"
                value={adminFilter}
                onChange={setAdminFilter}
                options={ADMIN_OPTIONS}
                className="w-[180px]"
              />

              <div className="w-[260px]">
                <AdminFirmPicker
                  label="Law firm"
                  value={firmId}
                  onChange={setFirmId}
                  placeholder="Any firm"
                />
              </div>

              {filtersActive && (
                <Button type="secondary" size="small" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>

            <p className="text-sm text-on-surface-secondary">
              {loadingData ? 'Loading…' : `${totalItems.toLocaleString()} ${totalItems === 1 ? 'user' : 'users'} match`}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-surface-alt text-on-surface-secondary">
                <tr>
                  <SortableTh field="name" label="Name" sort={sort} onSortChange={setSort} />
                  <SortableTh field="email" label="Email" sort={sort} onSortChange={setSort} />
                  <SortableTh field="userType" label="Type" sort={sort} onSortChange={setSort} />
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Law Firms</th>
                  <SortableTh
                    field="createdAt"
                    label="Signed up"
                    sort={sort}
                    onSortChange={setSort}
                    defaultDirection="desc"
                  />
                  <SortableTh
                    field="lastLoginAt"
                    label="Last sign-in"
                    sort={sort}
                    onSortChange={setSort}
                    defaultDirection="desc"
                  />
                  <SortableTh
                    field="isAdmin"
                    label="Admin"
                    sort={sort}
                    onSortChange={setSort}
                    defaultDirection="desc"
                  />
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {users.map((entry) => (
                  <tr key={entry.uid} className="border-t border-outline-subtle align-top">
                    <td className="px-4 py-3 font-medium text-on-surface">{entry.name || '-'}</td>
                    <td className="px-4 py-3 text-on-surface-secondary">{entry.email || '-'}</td>
                    <td className="px-4 py-3">
                      <StatusBadge variant={userTypeMeta(entry.userType).variant}>
                        {userTypeMeta(entry.userType).label}
                      </StatusBadge>
                    </td>
                    <td className="px-4 py-3">
                      <FirmAffiliations
                        memberFirms={entry.memberFirms}
                        clientFirms={entry.clientFirms}
                        onOpenFirm={(id) => navigateTo(`/admin/lawfirms/${id}`)}
                      />
                    </td>
                    <td className="px-4 py-3 text-on-surface-secondary whitespace-nowrap">
                      <Tooltip title={formatDateTime(entry.createdAt)} enterDelay={300}>
                        <span>{formatAge(entry.createdAt)}</span>
                      </Tooltip>
                    </td>
                    <td className="px-4 py-3 text-on-surface-secondary whitespace-nowrap">
                      {entry.lastLoginAt ? (
                        <Tooltip
                          title={`${formatDateTime(entry.lastLoginAt)}${
                            entry.lastLoginProvider ? ` · ${providerLabel(entry.lastLoginProvider)}` : ''
                          }`}
                          enterDelay={300}
                        >
                          <span>{formatAge(entry.lastLoginAt)}</span>
                        </Tooltip>
                      ) : (
                        <Tooltip title="No sign-in has been recorded for this account" enterDelay={300}>
                          <span className="text-on-surface-muted">Never</span>
                        </Tooltip>
                      )}
                    </td>
                    <td className="px-4 py-3 text-on-surface-secondary">
                      {entry.isAdmin ? 'Yes' : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        type={entry.isAdmin ? 'danger' : 'secondary'}
                        size="small"
                        onClick={() => handleSetAdmin(entry, !entry.isAdmin)}
                        loading={updatingAdminUserId === entry.uid}
                        disabled={!!updatingAdminUserId && updatingAdminUserId !== entry.uid}
                      >
                        {entry.isAdmin ? 'Remove Admin' : 'Make Admin'}
                      </Button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && !loadingData && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-on-surface-secondary">
                      {filtersActive ? 'No users match these filters.' : 'No users found.'}
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

/**
 * The firms one account is attached to, split by how it is attached: staff
 * membership (with the role held) and portal-client access are different
 * relationships, and an account can hold both at once.
 */
function FirmAffiliations({
  memberFirms,
  clientFirms,
  onOpenFirm,
}: {
  memberFirms?: AdminUserFirm[];
  clientFirms?: AdminUserFirm[];
  onOpenFirm: (lawFirmId: string) => void;
}) {
  const member = memberFirms ?? [];
  const client = clientFirms ?? [];

  if (!member.length && !client.length) {
    return <span className="text-on-surface-muted">No firm</span>;
  }

  return (
    <div className="flex flex-col gap-1 min-w-[220px]">
      {member.map((firm) => (
        <button
          key={`m-${firm.id}`}
          type="button"
          onClick={() => onOpenFirm(firm.id)}
          className="inline-flex items-center gap-1.5 text-left text-on-surface hover:text-accent-emphasis transition-colors cursor-pointer"
        >
          <Building2 size={13} className="shrink-0 text-on-surface-muted" />
          <span className="truncate">{firm.name}</span>
          <span className="text-xs text-on-surface-muted shrink-0">
            {firm.isOwner ? 'Owner' : (firm.roleName || 'Member')}
          </span>
        </button>
      ))}
      {client.map((firm) => (
        <button
          key={`c-${firm.id}`}
          type="button"
          onClick={() => onOpenFirm(firm.id)}
          className="inline-flex items-center gap-1.5 text-left text-on-surface-secondary hover:text-accent-emphasis transition-colors cursor-pointer"
        >
          <Building2 size={13} className="shrink-0 text-on-surface-muted" />
          <span className="truncate">{firm.name}</span>
          <span className="text-xs text-on-surface-muted shrink-0">Client</span>
        </button>
      ))}
    </div>
  );
}
