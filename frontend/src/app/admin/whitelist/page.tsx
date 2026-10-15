'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { flushSync } from 'react-dom';
import { useAuth } from '@/hooks/useAuth';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorNotification from '@/components/ErrorNotification';
import SuccessNotification from '@/components/SuccessNotification';
import { AutoPager } from '@/components/ui/ListPager';
import usePagedRows from '@/hooks/usePagedRows';
import Button from '@/components/ui/Button';
import ConfirmModal from '@/components/ui/ConfirmModal';
import userService from '@/services/users.service';
import adminService, { type AdminWhitelistEntry } from '@/services/admin.service';
import FieldLabel from '@/components/ui/FieldLabel';
import { FULL_INPUT_CLS } from '@/components/ui/inputClasses';
import AdminAccessRequired from '@/components/adminComp/AdminAccessRequired';

function formatDate(value: string | null): string {
  if (!value) return '-';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}


export default function AdminWhitelistPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [checkingAccess, setCheckingAccess] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [loadingData, setLoadingData] = useState(false);

  const [error, setError] = useState<string | Error | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | Error | null>(null);

  const [entries, setEntries] = useState<AdminWhitelistEntry[]>([]);

  // The whitelist grows with every address added, so the rendered rows are
  // windowed.
  const entriesPager = usePagedRows(entries, 50);

  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);

  const [pendingRemoval, setPendingRemoval] = useState<AdminWhitelistEntry | null>(null);
  const [removing, setRemoving] = useState(false);

  const navigateTo = useCallback((path: string) => {
    if (navigating) return;

    flushSync(() => {
      setNavigating(true);
    });

    window.requestAnimationFrame(() => {
      router.push(path);
    });
  }, [navigating, router]);

  const loadWhitelist = useCallback(async () => {
    setLoadingData(true);
    setError(null);

    try {
      const rows = await adminService.getWhitelist();
      setEntries(rows);
    } catch (err) {
      setError(err instanceof Error ? err : getErrorMessage(err));
    } finally {
      setLoadingData(false);
    }
  }, []);

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

        setIsAdmin(hasAdminAccess);

        if (hasAdminAccess) {
          await loadWhitelist();
        }
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err : getErrorMessage(err));
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
  }, [authLoading, user, router, loadWhitelist]);

  useEffect(() => {
    if (!successMessage) return;

    const timeout = setTimeout(() => setSuccessMessage(null), 4000);
    return () => clearTimeout(timeout);
  }, [successMessage]);

  const handleAdd = useCallback(async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setFormError('Email is required.');
      return;
    }

    setAdding(true);
    setFormError(null);

    try {
      const trimmedNote = note.trim();
      const result = await adminService.addWhitelistEntry({
        email: trimmedEmail,
        note: trimmedNote || undefined,
      });
      setEmail('');
      setNote('');
      setSuccessMessage(`Added ${result.email} to the whitelist.`);
      await loadWhitelist();
    } catch (err) {
      setFormError(err instanceof Error ? err : getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  }, [email, note, loadWhitelist]);

  const handleConfirmRemove = useCallback(async () => {
    if (!pendingRemoval) return;

    setRemoving(true);
    setError(null);

    try {
      const result = await adminService.removeWhitelistEntry(pendingRemoval.email);
      setSuccessMessage(`Removed ${result.email} from the whitelist.`);
      setPendingRemoval(null);
      await loadWhitelist();
    } catch (err) {
      setError(err instanceof Error ? err : getErrorMessage(err));
    } finally {
      setRemoving(false);
    }
  }, [pendingRemoval, loadWhitelist]);

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
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.12em] text-on-surface-muted font-semibold">Global Admin</p>
              <h1 className="text-2xl font-bold text-on-surface mt-1">Verification Whitelist</h1>
              <p className="text-sm text-on-surface-secondary mt-1">
                Emails here can sign in without verifying their email address (for test accounts).
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button type="secondary" onClick={() => navigateTo('/admin')}>
                Back to Admin Console
              </Button>
              <Button
                type="primary"
                onClick={loadWhitelist}
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

        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-sm p-5 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-on-surface">Add email</h2>
            <p className="text-sm text-on-surface-secondary">
              Add an email address that may sign in without email verification.
            </p>
          </div>

          <ErrorNotification error={formError} onClose={() => setFormError(null)} />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
            <div>
              <FieldLabel>Email *</FieldLabel>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !adding) handleAdd();
                }}
                placeholder="test@example.com"
                className={FULL_INPUT_CLS}
                maxLength={254}
              />
            </div>

            <div>
              <FieldLabel>Note</FieldLabel>
              <input
                type="text"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !adding) handleAdd();
                }}
                placeholder="Optional note"
                className={FULL_INPUT_CLS}
                maxLength={500}
              />
            </div>

            <Button
              type="primary"
              onClick={handleAdd}
              loading={adding}
              icon={<Plus className="w-4 h-4" />}
            >
              Add
            </Button>
          </div>
        </div>

        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-outline-subtle">
            <h2 className="text-lg font-semibold text-on-surface">Whitelisted Emails</h2>
            <p className="text-sm text-on-surface-secondary">{entries.length} email(s) whitelisted.</p>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-surface-alt text-on-surface-secondary">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Email</th>
                  <th className="px-4 py-3 text-left font-semibold">Note</th>
                  <th className="px-4 py-3 text-left font-semibold">Added By</th>
                  <th className="px-4 py-3 text-left font-semibold">Added</th>
                  <th className="px-4 py-3 text-left font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {entriesPager.pagedRows.map((entry) => (
                  <tr key={entry.email} className="border-t border-outline-subtle">
                    <td className="px-4 py-3 font-medium text-on-surface">{entry.email}</td>
                    <td className="px-4 py-3 text-on-surface-secondary">{entry.note || '-'}</td>
                    <td className="px-4 py-3 text-on-surface-secondary">{entry.createdByEmail || '-'}</td>
                    <td className="px-4 py-3 text-on-surface-secondary">{formatDate(entry.createdAt)}</td>
                    <td className="px-4 py-3">
                      <Button
                        type="danger"
                        size="small"
                        onClick={() => setPendingRemoval(entry)}
                        icon={<Trash2 className="w-3.5 h-3.5" />}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
                {entries.length === 0 && !loadingData && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-on-surface-secondary">
                      No whitelisted emails yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {entriesPager.total > entriesPager.rowsPerPage && (
            <div className="mt-4">
              <AutoPager pager={entriesPager} />
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={!!pendingRemoval}
        onClose={() => {
          if (!removing) setPendingRemoval(null);
        }}
        onConfirm={handleConfirmRemove}
        title="Remove from whitelist"
        message={
          pendingRemoval
            ? `Remove ${pendingRemoval.email} from the verification whitelist? They will need to verify their email to sign in.`
            : ''
        }
        confirmText="Remove"
        confirmType="danger"
        loading={removing}
      />
    </div>
  );
}
