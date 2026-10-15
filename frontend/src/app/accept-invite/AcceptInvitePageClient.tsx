"use client";

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorNotification from '@/components/ErrorNotification';
import ParalegixLogo from '@/components/ui/ParalegixLogo';
import AuthRequiredPage from '@/components/ui/AuthRequiredPage';
import InvalidLinkPage from '@/components/ui/InvalidLinkPage';
import { getFirebaseToken } from '@/lib/utils/auth';
import { apiFetch, publicFetch } from '@/lib/utils/fetchWithTokenRefresh';
import AuthButton from '@/components/ui/AuthButton';
import useFormFeedback from '@/hooks/useFormFeedback';
import { getErrorMessage } from '@/lib/utils/apiErrors';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

function AcceptInviteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { errorMessage: acceptError, setErrorMessage: setAcceptError, feedbackRef, feedbackId } = useFormFeedback();
  const [invitation, setInvitation] = useState<any>(null);

  const token = searchParams.get('token');

  useEffect(() => {
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch effect: sets error/loading state from an async invitation fetch
      setError('Invalid invitation link');
      setLoading(false);
      return;
    }

    const fetchInvitation = async () => {
      try {
        const response = await publicFetch(`${API_URL}/invitations/accept/${token}`);
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Invalid or expired invitation');
        }
        const data = await response.json();
        // If the invite was already auto-processed, redirect to client dashboard
        if (data.invitation?.alreadyProcessed) {
          router.replace('/client/dashboard');
          return;
        }
        setInvitation(data.invitation);
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to load invitation'));
      } finally {
        setLoading(false);
      }
    };

    fetchInvitation();
  }, [token, router]);

  const handleAccept = async () => {
    if (!user || !token) {
      setAcceptError('Please log in to accept the invitation');
      return;
    }

    setAccepting(true);
    setAcceptError('');

    try {
      const firebaseToken = await getFirebaseToken();
      const response = await apiFetch(`${API_URL}/invitations/accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${firebaseToken}`,
        },
        body: JSON.stringify({ token }),
      });

      if (!response.ok) {
        const data = await response.json();
        // Extract detailed message from validation errors
        const detailMsg = data.details
          ? Object.values(data.details).flat().join('. ')
          : null;
        throw new Error(detailMsg || data.error || 'Failed to accept invitation');
      }

      // Success - redirect to client dashboard
      router.push('/client/dashboard');
    } catch (err) {
      setAcceptError(getErrorMessage(err, 'Failed to accept invitation'));
      setAccepting(false);
    }
  };

  if (authLoading || loading) {
    return (
      <LoadingSpinner fullPage />
    );
  }

  const firmName = invitation?.lawFirmName || 'the law firm';

  if (!token || error) {
    return (
      <InvalidLinkPage
        title="This client invitation is no longer valid"
        description={error || 'The invitation link is missing, expired, or has already been used.'}
      />
    );
  }

  if (!user) {
    return (
      <AuthRequiredPage
        title="Sign in to accept this invitation"
        description={`You'll need to sign in with the invited account before you can join ${firmName}'s client portal.`}
        loginHref={`/login?redirect=${encodeURIComponent(`/accept-invite?token=${token}`)}`}
        secondaryHref={`/register/invite?token=${token}`}
        secondaryLabel="Create account"
      />
    );
  }

  return (
    <main className="min-h-screen bg-page flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8">
          <div className="flex justify-center mb-8">
            <ParalegixLogo width={280} height={80} priority />
          </div>

          <h1 className="text-xl font-bold text-center text-on-surface mb-1">Accept Invitation</h1>
          <p className="text-xs text-on-surface-muted text-center mb-7">
            <span className="font-semibold text-on-surface-secondary">{firmName}</span> has invited you to join their client portal
          </p>

          <div id={feedbackId} ref={feedbackRef} tabIndex={-1}>
            <ErrorNotification error={acceptError} onClose={() => setAcceptError('')} className="mb-5" />
          </div>

          {invitation && (
            <p className="text-sm text-on-surface-muted text-center mb-6">
              By accepting, you&apos;ll be able to view your matters, communicate with your legal team, and access important documents.
            </p>
          )}

          <div className="space-y-3">
            <AuthButton onClick={handleAccept} loading={accepting}>
              {accepting ? "Accepting..." : "Accept Invitation"}
            </AuthButton>
            <AuthButton variant="secondary" onClick={() => router.push('/client/dashboard')}>
              Cancel
            </AuthButton>
          </div>
        </div>
      </div>
    </main>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<LoadingSpinner fullPage />}>
      <AcceptInviteContent />
    </Suspense>
  );
}
