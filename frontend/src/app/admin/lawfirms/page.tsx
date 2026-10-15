'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, Pencil, RefreshCw, Search } from 'lucide-react';
import { flushSync } from 'react-dom';
import { useAuth } from '@/hooks/useAuth';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorNotification from '@/components/ErrorNotification';
import SuccessNotification from '@/components/SuccessNotification';
import ListPager, { DEFAULT_ROWS_PER_PAGE_OPTIONS, pagerWillRender } from '@/components/ui/ListPager';
import Button from '@/components/ui/Button';
import Dropdown from '@/components/ui/Dropdown';
import SortableTh, { type SortState } from '@/components/ui/SortableTh';
import { billingStatusMeta } from '@/constants/statusMeta';
import AdminStatCards from '@/components/adminComp/AdminStatCards';
import { FIELD_CLS, FIELD_LABEL_CLS, INPUT_CLS } from '@/components/ui/inputClasses';
import { SEARCH_DEBOUNCE_MS } from '@/lib/constants/search';
import { formatPlanPrice, intervalLabel, planLabel } from '@/lib/plans/planLabels';
import { toLocalDate } from '@/lib/utils/dateUtils';
import userService from '@/services/users.service';
import adminService, {
  type AdminLawFirm,
  type AdminLawFirmListQuery,
  type AdminLawFirmStats,
  type UpdateLawFirmPayload,
} from '@/services/admin.service';
import Modal from '@/components/ui/Modal';
import AdminAccessRequired from '@/components/adminComp/AdminAccessRequired';
import { useResetAfterClose } from '@/hooks/useMountTransition';

type LawFirmFormState = {
  name: string;
  description: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  email: string;
  quotaMb: number;
};

/** Rows per page. Every firm on the platform lands in this table. */
const PAGE_SIZE = 50;

const EMPTY_STATS: AdminLawFirmStats = {
  total: 0, new7d: 0, new30d: 0, byPlan: {}, byBillingStatus: {},
};

const PLAN_OPTIONS = [
  { label: 'All plans', value: '' },
  { label: 'Starter', value: 'starter' },
  { label: 'Professional', value: 'professional' },
  { label: 'Enterprise', value: 'enterprise' },
];

// The `billing_status` COLUMN carries a narrower set than the plan jsonb; these
// are the values the check constraint allows.
const BILLING_OPTIONS = [
  { label: 'Any billing state', value: '' },
  { label: 'Active', value: 'active' },
  { label: 'Trialing', value: 'trialing' },
  { label: 'Comped', value: 'comped' },
  { label: 'Past due', value: 'past_due' },
  { label: 'Incomplete', value: 'incomplete' },
  { label: 'Canceled', value: 'canceled' },
];

const INITIAL_FORM_STATE: LawFirmFormState = {
  name: '',
  description: '',
  address: '',
  city: '',
  state: '',
  zip: '',
  phone: '',
  email: '',
  quotaMb: 300,
};

function formatDate(value: unknown): string {
  if (!value) return '-';

  try {
    const date = toLocalDate(value as string | number | Date);

    if (!date || Number.isNaN(date.getTime())) return '-';

    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return '-';
  }
}

function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

export default function AdminLawFirmsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [checkingAccess, setCheckingAccess] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  // Id of the most recently issued list request; guards against an older,
  // slower page/filter/sort load overwriting a newer one's rows.
  const loadRequestIdRef = useRef(0);
  const [savingLawFirm, setSavingLawFirm] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  const [lawFirms, setLawFirms] = useState<AdminLawFirm[]>([]);
  const [lawFirmSearch, setLawFirmSearch] = useState('');
  const [page, setPage] = useState(1);
  // Part of `query` below, so changing it goes through the same restart-at-page-1
  // path as any other change to the result set.
  const [rowsPerPage, setRowsPerPage] = useState(PAGE_SIZE);
  const [totalItems, setTotalItems] = useState(0);
  // Firm counts across the platform, unfiltered, so the cards report the platform
  // rather than the current search.
  const [stats, setStats] = useState<AdminLawFirmStats>(EMPTY_STATS);

  const [planFilter, setPlanFilter] = useState('');
  const [billingFilter, setBillingFilter] = useState('');
  // Newest firm first: the list is usually opened to answer "who just signed up".
  const [sort, setSort] = useState<SortState>({ field: 'createdAt', direction: 'desc' });

  const [editingLawFirm, setEditingLawFirm] = useState<AdminLawFirm | null>(null);
  const [formState, setFormState] = useState<LawFirmFormState>(INITIAL_FORM_STATE);

  // Keep the firm rendered through the exit animation, after it is cleared on close.
  const lastEditingLawFirmRef = useRef<AdminLawFirm | null>(null);
  if (editingLawFirm) lastEditingLawFirmRef.current = editingLawFirm;
  const activeEditingLawFirm = editingLawFirm ?? lastEditingLawFirmRef.current;

  const navigateTo = useCallback((path: string) => {
    if (navigating) return;

    flushSync(() => {
      setNavigating(true);
    });

    window.requestAnimationFrame(() => {
      router.push(path);
    });
  }, [navigating, router]);

  const hydrateLawFirmForm = useCallback((lawFirm: AdminLawFirm) => {
    setFormState({
      name: lawFirm.name || '',
      description: lawFirm.description || '',
      address: lawFirm.address || '',
      city: lawFirm.city || '',
      state: lawFirm.state || '',
      zip: lawFirm.zip || '',
      phone: lawFirm.phone || '',
      email: lawFirm.email || '',
      quotaMb: adminService.quotaBytesToMb(lawFirm.storage?.quotaBytes || 0),
    });
  }, []);

  // Search, sort and the plan/billing filters are all applied in SQL, so a
  // narrowed view still reaches every firm on the platform and the footer count
  // keeps matching the rows on screen.
  const query = useMemo<AdminLawFirmListQuery>(() => ({
    limit: rowsPerPage,
    search: lawFirmSearch.trim() || undefined,
    sortBy: sort.field,
    order: sort.direction,
    planId: planFilter || undefined,
    billingStatus: billingFilter || undefined,
  }), [lawFirmSearch, sort, planFilter, billingFilter, rowsPerPage]);

  const loadLawFirms = useCallback(async (targetPage: number) => {
    const requestId = ++loadRequestIdRef.current;
    setLoadingData(true);
    setError(null);

    try {
      const result = await adminService.getLawFirmsPaged({ ...query, page: targetPage });
      // A later filter/page/sort change may have started its own load while
      // this one was in flight; a slower response here would otherwise
      // silently replace rows that no longer match what the controls show.
      if (requestId !== loadRequestIdRef.current) return;
      setLawFirms(result.lawFirms);
      setTotalItems(result.totalItems);
      setStats(result.stats);
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (requestId === loadRequestIdRef.current) setLoadingData(false);
    }
  }, [query]);

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

        // The search effect below owns the first load, so it is not started here
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

  useEffect(() => {
    if (!successMessage) return;

    const timeout = setTimeout(() => setSuccessMessage(null), 4000);
    return () => clearTimeout(timeout);
  }, [successMessage]);

  // The customer list is the one set guaranteed to grow with the business, so it
  // is paged, searched and sorted in SQL. Any change to the query restarts at
  // page 1, since the previous offset belongs to a different result set. Running
  // on `isAdmin` too makes this the single initial load, hence the immediate first
  // pass when nothing is typed.
  useEffect(() => {
    if (!isAdmin) return;
    const timer = window.setTimeout(() => {
      setPage(1);
      loadLawFirms(1);
    }, lawFirmSearch.trim() ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isAdmin]);

  const goToPage = useCallback((next: number) => {
    setPage(next);
    loadLawFirms(next);
  }, [loadLawFirms]);

  const totalPages = Math.max(1, Math.ceil(totalItems / rowsPerPage));

  const openLawFirmEditor = useCallback((lawFirm: AdminLawFirm) => {
    setEditingLawFirm(lawFirm);
    setModalError(null);
    hydrateLawFirmForm(lawFirm);
  }, [hydrateLawFirmForm]);

  const closeLawFirmEditor = useCallback(() => setEditingLawFirm(null), []);

  useResetAfterClose(!!editingLawFirm, () => {
    setModalError(null);
    setFormState(INITIAL_FORM_STATE);
  });

  const requestCloseEditor = useCallback(() => {
    if (savingLawFirm) return;
    closeLawFirmEditor();
  }, [savingLawFirm, closeLawFirmEditor]);

  const handleSaveLawFirm = useCallback(async () => {
    if (!editingLawFirm) return;

    if (!formState.name.trim()) {
      setModalError('Law firm name is required.');
      return;
    }

    if (!Number.isFinite(formState.quotaMb) || formState.quotaMb <= 0) {
      setModalError('Storage quota must be a positive number.');
      return;
    }

    setSavingLawFirm(true);
    setModalError(null);

    const payload: UpdateLawFirmPayload = {
      lawFirm: {
        name: formState.name.trim(),
        description: formState.description.trim(),
        address: formState.address.trim(),
        city: formState.city.trim(),
        state: formState.state.trim(),
        zip: formState.zip.trim(),
        phone: formState.phone.trim(),
        email: formState.email.trim(),
      },
      storage: {
        quotaBytes: adminService.quotaMbToBytes(formState.quotaMb),
      },
    };

    try {
      const result = await adminService.updateLawFirm(editingLawFirm.id, payload);
      setLawFirms((prev) => prev.map((entry) => (
        entry.id === editingLawFirm.id ? result.lawFirm : entry
      )));
      setSuccessMessage(`Saved changes to ${result.lawFirm.name || 'law firm'}.`);
      closeLawFirmEditor();
    } catch (err) {
      setModalError(getErrorMessage(err));
    } finally {
      setSavingLawFirm(false);
    }
  }, [editingLawFirm, formState, closeLawFirmEditor]);

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
              <h1 className="text-2xl font-bold text-on-surface mt-1">Law Firms</h1>
              <p className="text-sm text-on-surface-secondary mt-1">
                Global law firm records with profile and storage quota management.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button type="secondary" onClick={() => navigateTo('/admin')}>
                Admin Home
              </Button>
              <Button type="secondary" onClick={() => navigateTo('/dashboard')}>
                Back to Dashboard
              </Button>
              <Button
                type="primary"
                onClick={() => loadLawFirms(page)}
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
          columns={5}
          stats={[
            { label: 'Law firms', value: stats.total },
            { label: 'New (7 days)', value: stats.new7d, accent: stats.new7d > 0 },
            { label: 'New (30 days)', value: stats.new30d, accent: stats.new30d > 0 },
            {
              label: 'Paying',
              value: stats.byBillingStatus.active || 0,
              hint: `${stats.byBillingStatus.trialing || 0} trialing`,
            },
            {
              label: 'Comped',
              value: stats.byBillingStatus.comped || 0,
              hint: `${stats.byBillingStatus.past_due || 0} past due`,
            },
          ]}
        />

        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-outline-subtle space-y-3">
            <div>
              <h2 className="text-lg font-semibold text-on-surface">Law Firms</h2>
              <p className="text-sm text-on-surface-secondary">Edit firm profile fields and storage quota.</p>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className={`${FIELD_CLS} flex-1 min-w-[220px]`}>
                <label className={FIELD_LABEL_CLS} htmlFor="admin-firm-search">Search</label>
                <div className="relative">
                  <Search className="w-4 h-4 text-on-surface-muted absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    id="admin-firm-search"
                    type="text"
                    value={lawFirmSearch}
                    onChange={(event) => setLawFirmSearch(event.target.value)}
                    placeholder="Name, email, phone, or city..."
                    className={`${INPUT_CLS} w-full pl-9`}
                  />
                </div>
              </div>

              <Dropdown
                label="Plan"
                value={planFilter}
                onChange={setPlanFilter}
                options={PLAN_OPTIONS}
                className="w-[180px]"
              />

              <Dropdown
                label="Billing"
                value={billingFilter}
                onChange={setBillingFilter}
                options={BILLING_OPTIONS}
                className="w-[200px]"
              />

              {(lawFirmSearch.trim() || planFilter || billingFilter) && (
                <Button
                  type="secondary"
                  size="small"
                  onClick={() => { setLawFirmSearch(''); setPlanFilter(''); setBillingFilter(''); }}
                >
                  Clear filters
                </Button>
              )}
            </div>

            <p className="text-sm text-on-surface-secondary">
              {loadingData ? 'Loading…' : `${totalItems.toLocaleString()} ${totalItems === 1 ? 'firm' : 'firms'} match`}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-surface-alt text-on-surface-secondary">
                <tr>
                  <SortableTh field="name" label="Name" sort={sort} onSortChange={setSort} />
                  <SortableTh field="planId" label="Plan" sort={sort} onSortChange={setSort} />
                  <SortableTh
                    field="memberCount"
                    label="Members"
                    sort={sort}
                    onSortChange={setSort}
                    defaultDirection="desc"
                    align="right"
                  />
                  <SortableTh
                    field="matterCount"
                    label="Matters"
                    sort={sort}
                    onSortChange={setSort}
                    defaultDirection="desc"
                    align="right"
                  />
                  <SortableTh
                    field="clientCount"
                    label="Clients"
                    sort={sort}
                    onSortChange={setSort}
                    defaultDirection="desc"
                    align="right"
                  />
                  <SortableTh
                    field="storageUsedBytes"
                    label="Storage"
                    sort={sort}
                    onSortChange={setSort}
                    defaultDirection="desc"
                  />
                  <SortableTh
                    field="createdAt"
                    label="Created"
                    sort={sort}
                    onSortChange={setSort}
                    defaultDirection="desc"
                  />
                  <th scope="col" className="px-4 py-3 text-left font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {lawFirms.map((lawFirm) => {
                  const storage = lawFirm.storage;
                  return (
                    <tr
                      key={lawFirm.id}
                      className="border-t border-outline-subtle hover:bg-surface-hover cursor-pointer transition-colors"
                      onClick={() => navigateTo(`/admin/lawfirms/${lawFirm.id}`)}
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-blue-600 dark:text-blue-400">{lawFirm.name || '-'}</p>
                        {lawFirm.email && (
                          <p className="text-xs text-on-surface-muted">{lawFirm.email}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-on-surface">{planLabel(lawFirm.plan?.planId)}</p>
                        <p className="text-xs text-on-surface-muted">
                          {lawFirm.plan?.billingStatus ? billingStatusMeta(lawFirm.plan.billingStatus).label : '-'}
                          {intervalLabel(lawFirm.plan?.billingInterval)
                            ? ` · ${intervalLabel(lawFirm.plan?.billingInterval)}`
                            : ''}
                        </p>
                        {formatPlanPrice(lawFirm.plan ?? {}) && (
                          <p className="text-xs text-on-surface-muted">{formatPlanPrice(lawFirm.plan ?? {})}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-on-surface-secondary">{lawFirm.memberCount ?? '-'}</td>
                      <td className="px-4 py-3 text-right text-on-surface-secondary">{lawFirm.matterCount ?? '-'}</td>
                      <td className="px-4 py-3 text-right text-on-surface-secondary">{lawFirm.clientCount ?? '-'}</td>
                      <td className="px-4 py-3 text-on-surface-secondary whitespace-nowrap">
                        {formatBytes(storage?.usedBytes)} / {formatBytes(storage?.quotaBytes)}
                      </td>
                      <td className="px-4 py-3 text-on-surface-secondary whitespace-nowrap">{formatDate(lawFirm.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                          <Button
                            type="primary"
                            size="small"
                            onClick={() => navigateTo(`/admin/lawfirms/${lawFirm.id}`)}
                            icon={<Eye className="w-3.5 h-3.5" />}
                          >
                            View
                          </Button>
                          <Button
                            type="secondary"
                            size="small"
                            onClick={() => openLawFirmEditor(lawFirm)}
                            icon={<Pencil className="w-3.5 h-3.5" />}
                          >
                            Edit
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {lawFirms.length === 0 && !loadingData && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-on-surface-secondary">
                      {lawFirmSearch.trim() || planFilter || billingFilter
                        ? 'No law firms match these filters.'
                        : 'No law firms found.'}
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

      <Modal
        isOpen={!!editingLawFirm}
        onClose={requestCloseEditor}
        title="Edit Law Firm"
        subtitle={activeEditingLawFirm?.name || activeEditingLawFirm?.id}
        showClose={false}
        dismissible={!savingLawFirm}
        size="3xl"
        className="rounded-2xl border border-outline-subtle"
        footer={
          <>
            <Button
              type="secondary"
              size="small"
              onClick={closeLawFirmEditor}
              disabled={savingLawFirm}
            >
              Cancel
            </Button>
            <Button
              type="primary"
              size="small"
              onClick={handleSaveLawFirm}
              loading={savingLawFirm}
              disabled={savingLawFirm || !formState.name.trim()}
            >
              Save Changes
            </Button>
          </>
        }
      >
        <ErrorNotification error={modalError} onClose={() => setModalError(null)} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block text-sm text-on-surface-secondary">
            Name*
            <input
              type="text"
              value={formState.name}
              onChange={(event) => setFormState((prev) => ({ ...prev, name: event.target.value }))}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-input-border bg-input-bg text-on-surface"
              maxLength={200}
            />
          </label>

          <label className="block text-sm text-on-surface-secondary">
            Email
            <input
              type="email"
              value={formState.email}
              onChange={(event) => setFormState((prev) => ({ ...prev, email: event.target.value }))}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-input-border bg-input-bg text-on-surface"
              maxLength={254}
            />
          </label>

          <label className="block text-sm text-on-surface-secondary md:col-span-2">
            Description
            <input
              type="text"
              value={formState.description}
              onChange={(event) => setFormState((prev) => ({ ...prev, description: event.target.value }))}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-input-border bg-input-bg text-on-surface"
              maxLength={2000}
            />
          </label>

          <label className="block text-sm text-on-surface-secondary md:col-span-2">
            Address
            <input
              type="text"
              value={formState.address}
              onChange={(event) => setFormState((prev) => ({ ...prev, address: event.target.value }))}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-input-border bg-input-bg text-on-surface"
              maxLength={500}
            />
          </label>

          <label className="block text-sm text-on-surface-secondary">
            City
            <input
              type="text"
              value={formState.city}
              onChange={(event) => setFormState((prev) => ({ ...prev, city: event.target.value }))}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-input-border bg-input-bg text-on-surface"
              maxLength={100}
            />
          </label>

          <label className="block text-sm text-on-surface-secondary">
            State
            <input
              type="text"
              value={formState.state}
              onChange={(event) => setFormState((prev) => ({ ...prev, state: event.target.value }))}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-input-border bg-input-bg text-on-surface"
              maxLength={100}
            />
          </label>

          <label className="block text-sm text-on-surface-secondary">
            ZIP
            <input
              type="text"
              value={formState.zip}
              onChange={(event) => setFormState((prev) => ({ ...prev, zip: event.target.value }))}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-input-border bg-input-bg text-on-surface"
              maxLength={20}
            />
          </label>

          <label className="block text-sm text-on-surface-secondary">
            Phone
            <input
              type="text"
              value={formState.phone}
              onChange={(event) => setFormState((prev) => ({ ...prev, phone: event.target.value }))}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-input-border bg-input-bg text-on-surface"
              maxLength={50}
            />
          </label>

          <label className="block text-sm text-on-surface-secondary">
            Storage Quota (MB)*
            <input
              type="number"
              value={formState.quotaMb}
              onChange={(event) => setFormState((prev) => ({ ...prev, quotaMb: Number(event.target.value) }))}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-input-border bg-input-bg text-on-surface"
              min={1}
              step="0.01"
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}
