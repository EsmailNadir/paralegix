'use client';

/**
 * Reconnect a Google or Microsoft calendar from a link: `?provider=google|microsoft`
 * and an optional same-site `return` path.
 *
 * Starts the API's authorization-code flow, the only path that yields a
 * refresh token the API validates. The callback sends the person back to the
 * return page (or the dashboard) with the connect outcome on the URL, where the
 * firm and dashboard shells report it.
 *
 * The connect reads Firebase's `currentUser`, which stays null until the
 * persisted session is restored, so the page waits for auth to settle first. A
 * visitor who is signed out goes to sign in with this page as the return path.
 */

import { useEffect, useRef, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ParalegixLogo from '@/components/ui/ParalegixLogo';
import LoadingSpinner from '@/components/LoadingSpinner';
import AuthButton from '@/components/ui/AuthButton';
import AuthService from '@/services/auth.service';
import { useAuth } from '@/hooks/useAuth';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import { sanitizeNextPath } from '@/lib/utils/safeNext';
import { connectOutcomeQuery } from '@/lib/utils/calendarConnectOutcome';

/**
 * Where the callback should land, as an absolute same-origin URL. Never this
 * page: landing back here would start the connect again.
 */
function returnUrlFor(raw: string | null): string {
  const path = sanitizeNextPath(raw);
  const safe = path && !path.startsWith('/auth/reconnect') ? path : '/dashboard';
  return `${window.location.origin}${safe}`;
}

function ReconnectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  // The connect navigates away from the app, so it must start exactly once even
  // if auth state settles in more than one render.
  const startedRef = useRef(false);
  const [status, setStatus] = useState<'redirecting' | 'error'>('redirecting');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const run = async () => {
      if (startedRef.current) return;

      // An outcome on this URL means a connect already finished; hand it to the
      // dashboard to report instead of starting another one.
      const outcome = connectOutcomeQuery(searchParams);
      if (outcome) {
        startedRef.current = true;
        router.replace(`/dashboard${outcome}`);
        return;
      }

      if (authLoading) return;
      if (!user) {
        startedRef.current = true;
        const query = searchParams.toString();
        const next = `/auth/reconnect${query ? `?${query}` : ''}`;
        router.replace(`/login?next=${encodeURIComponent(next)}`);
        return;
      }

      startedRef.current = true;
      const provider = searchParams.get('provider');
      const returnUrl = returnUrlFor(searchParams.get('return'));

      try {
        if (provider === 'google') {
          await AuthService.connectGoogleCalendar(returnUrl);
          return;
        }
        if (provider === 'microsoft') {
          await AuthService.connectMicrosoftCalendar(returnUrl);
          return;
        }
        setStatus('error');
        setErrorMessage('Missing or invalid provider. Use ?provider=google or ?provider=microsoft');
      } catch (err) {
        // No cancelled-effect guard here: the start-once ref means a re-run never
        // retries, so dropping this error would leave the spinner up for good.
        setStatus('error');
        setErrorMessage(getErrorMessage(err, 'Reconnect failed.'));
      }
    };

    run();
  }, [router, searchParams, user, authLoading]);

  if (status === 'redirecting') {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-[420px]">
          <div className="bg-surface rounded-2xl border border-outline-subtle shadow-sm p-8">
            <div className="flex justify-center mb-8">
              <ParalegixLogo width={160} height={40} priority />
            </div>
            <div className="flex flex-col items-center">
              <LoadingSpinner />
              <p className="mt-4 text-xs text-on-surface-muted font-medium">
                Redirecting to sign in...
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-page flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-sm p-8">
          <div className="flex justify-center mb-8">
            <ParalegixLogo width={160} height={40} priority />
          </div>
          <div className="text-center mb-5">
            <div className="w-12 h-12 rounded-full bg-red-50 dark:bg-red-950/30 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-on-surface mb-1">Reconnect failed</h2>
            <p className="text-sm text-on-surface-secondary">{errorMessage}</p>
          </div>
          <AuthButton onClick={() => router.push('/dashboard')}>
            Back to Dashboard
          </AuthButton>
        </div>
      </div>
    </div>
  );
}

export default function ReconnectPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-page flex items-center justify-center">
          <LoadingSpinner />
        </div>
      }
    >
      <ReconnectContent />
    </Suspense>
  );
}
