'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Building2, Contact, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { flushSync } from 'react-dom';
import { useAuth } from '@/hooks/useAuth';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorNotification from '@/components/ErrorNotification';
import Button from '@/components/ui/Button';
import AdminAccessRequired from '@/components/adminComp/AdminAccessRequired';
import userService from '@/services/users.service';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

export default function AdminPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [checkingAccess, setCheckingAccess] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigateTo = useCallback((path: string) => {
    if (navigating) return;

    flushSync(() => {
      setNavigating(true);
    });

    window.requestAnimationFrame(() => {
      router.push(path);
    });
  }, [navigating, router]);

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
              <h1 className="text-2xl font-bold text-on-surface mt-1">Admin Console</h1>
              <p className="text-sm text-on-surface-secondary mt-1">
                Choose a section to manage global law firm and client data.
              </p>
            </div>

            <Button type="secondary" onClick={() => navigateTo('/dashboard')}>
              Back to Dashboard
            </Button>
          </div>
        </div>

        <ErrorNotification error={error} onClose={() => setError(null)} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => navigateTo('/admin/lawfirms')}
            disabled={navigating}
            className="w-full text-left bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm hover:bg-surface-hover transition-colors cursor-pointer"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-surface-alt border border-outline-subtle flex items-center justify-center">
                <Building2 className="w-6 h-6 text-on-surface" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-on-surface">Law Firms</h2>
                <p className="text-sm text-on-surface-secondary mt-1">
                  View all law firms, search records, and edit profile details and storage quotas.
                </p>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => navigateTo('/admin/users')}
            disabled={navigating}
            className="w-full text-left bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm hover:bg-surface-hover transition-colors cursor-pointer"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-surface-alt border border-outline-subtle flex items-center justify-center">
                <Users className="w-6 h-6 text-on-surface" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-on-surface">Users</h2>
                <p className="text-sm text-on-surface-secondary mt-1">
                  Every account by signup date, the firms they belong to, and last sign-in. Grant or remove admin access.
                </p>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => navigateTo('/admin/clients')}
            disabled={navigating}
            className="w-full text-left bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm hover:bg-surface-hover transition-colors cursor-pointer"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-surface-alt border border-outline-subtle flex items-center justify-center">
                <Contact className="w-6 h-6 text-on-surface" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-on-surface">Clients</h2>
                <p className="text-sm text-on-surface-secondary mt-1">
                  Client records across every firm, with portal status and matter involvement.
                </p>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => navigateTo('/admin/logins')}
            disabled={navigating}
            className="w-full text-left bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm hover:bg-surface-hover transition-colors cursor-pointer"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-surface-alt border border-outline-subtle flex items-center justify-center">
                <Activity className="w-6 h-6 text-on-surface" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-on-surface">Login Activity</h2>
                <p className="text-sm text-on-surface-secondary mt-1">
                  Review sign-in events across all firms, including approximate location, device, and IP.
                </p>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => navigateTo('/admin/test-accounts')}
            disabled={navigating}
            className="w-full text-left bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm hover:bg-surface-hover transition-colors cursor-pointer"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-surface-alt border border-outline-subtle flex items-center justify-center">
                <UserPlus className="w-6 h-6 text-on-surface" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-on-surface">Test Accounts</h2>
                <p className="text-sm text-on-surface-secondary mt-1">
                  Create pre-verified firm owner, client, or member accounts for testing.
                </p>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => navigateTo('/admin/whitelist')}
            disabled={navigating}
            className="w-full text-left bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm hover:bg-surface-hover transition-colors cursor-pointer"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-surface-alt border border-outline-subtle flex items-center justify-center">
                <ShieldCheck className="w-6 h-6 text-on-surface" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-on-surface">Verification Whitelist</h2>
                <p className="text-sm text-on-surface-secondary mt-1">
                  Allow specific emails to sign in without verifying their email address.
                </p>
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
