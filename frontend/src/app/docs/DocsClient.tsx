'use client';

/**
 * Entry point to the documentation site.
 *
 * The docs site is a separate static deployment with no access to the Firebase
 * session, so it is gated on an httpOnly cookie the API issues for the parent
 * domain. Every route into the docs goes through this page: it establishes (or
 * silently re-establishes) that cookie while the user is still on an origin that
 * can prove who they are, then hands off to the docs host.
 *
 * The docs edge middleware bounces anyone without a valid cookie back here with
 * the page they wanted in `?to=`, so an expired cookie renews itself mid-session
 * without the reader seeing a login screen.
 */

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import LoadingSpinner from '@/components/LoadingSpinner';
import authService from '@/services/auth.service';
import { useAuth } from '@/hooks/useAuth';
import { sanitizeNextPath } from '@/lib/utils/safeNext';

const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || 'http://localhost:3005/docs';

const DocsRedirect = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const [error, setError] = useState('');

  // The handoff navigates away from the app, so it must fire exactly once even
  // if auth state settles in more than one render.
  const startedRef = useRef(false);

  // `to` is attacker-controllable (it arrives on a redirect from the docs host),
  // and it is concatenated onto an origin below. Reuse the login page's path
  // validator so a crafted link cannot turn this into an open redirect.
  const to = sanitizeNextPath(searchParams?.get('to')) ?? '';

  useEffect(() => {
    if (authLoading || startedRef.current) return;

    if (!user) {
      const target = `/docs${to ? `?to=${encodeURIComponent(to)}` : ''}`;
      router.replace(`/login?next=${encodeURIComponent(target)}`);
      return;
    }

    startedRef.current = true;

    authService
      .startDocsSession()
      .then(() => {
        // replace(), not assign(): the reader should not land back on this
        // bounce page when they hit Back from the docs site.
        window.location.replace(`${DOCS_URL}${to}`);
      })
      .catch((err) => {
        startedRef.current = false;
        setError(err?.message || 'Could not open the documentation site.');
      });
  }, [user, authLoading, router, to]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-page px-4">
        <div className="max-w-md w-full text-center">
          <h1 className="text-lg font-semibold text-on-surface">Documentation unavailable</h1>
          <p className="mt-2 text-sm text-on-surface-secondary">{error}</p>
          <button
            onClick={() => router.replace('/dashboard')}
            className="mt-6 text-sm font-medium text-accent-emphasis hover:text-accent-emphasis-hover transition-colors cursor-pointer"
          >
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  return <LoadingSpinner fullPage />;
};

const Docs = () => (
  <Suspense fallback={<LoadingSpinner fullPage />}>
    <DocsRedirect />
  </Suspense>
);

export default Docs;
