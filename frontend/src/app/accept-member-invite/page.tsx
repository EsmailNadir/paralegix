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
import { getErrorMessage } from '@/lib/utils/apiErrors';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

/**
 * User-facing copy for a failed accept.
 *
 * The person reading this is the invitee, who has no access to the firm's plan
 * and cannot fix a seat shortage themselves - so a plan-limit rejection has to
 * name the firm as the party who must act. It also cannot go through the generic
 * `details` flattening below: `PLAN_LIMIT_REACHED` details are a `{ resource,
 * current, limit, planId }` record, which flattens to the nonsense string
 * "maxMembers. 3. 3. starter". Only validation-shaped details (field → messages)
 * are safe to flatten.
 */
function acceptFailureMessage(data: any): string {
  if (data?.code === 'PLAN_LIMIT_REACHED') {
    return 'This firm has no seats left on its current plan. Ask whoever invited you to free up a seat or upgrade, then open this link again.';
  }

  const messages = Object.values(data?.details || {})
    .flat()
    .filter((v): v is string => typeof v === 'string');
  if (messages.length > 0) return messages.join('. ');

  return data?.error || 'Failed to accept invitation';
}

interface SwitchRequired {
  currentFirms: { lawFirmId: string; name: string; willBeDeleted: boolean }[];
}

function AcceptMemberInviteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<any>(null);
  const [switchRequired, setSwitchRequired] = useState<SwitchRequired | null>(null);

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
        const response = await publicFetch(`${API_URL}/invitations/member-accept/${token}`);
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Invalid or expired invitation');
        }
        const data = await response.json();
        // If the invite was already auto-processed by the auth service during login,
        // redirect to the firm dashboard directly
        if (data.invitation?.alreadyProcessed) {
          router.replace(`/lawfirm/${data.invitation.lawFirmId}/matters`);
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

  const handleAccept = async (confirmSwitch = false) => {
    if (!user || !token) {
      setAcceptError('Please log in to accept the invitation');
      return;
    }

    setAccepting(true);
    setAcceptError(null);

    try {
      const firebaseToken = await getFirebaseToken();
      const response = await apiFetch(`${API_URL}/invitations/member-accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${firebaseToken}`,
        },
        body: JSON.stringify({ token, confirmSwitch }),
      });

      if (!response.ok) {
        const data = await response.json();
        if (data?.code === 'FIRM_SWITCH_REQUIRED') {
          setSwitchRequired(data.details);
          setAccepting(false);
          return;
        }
        throw new Error(acceptFailureMessage(data));
      }

      const result = await response.json();
      // Success - redirect to the law firm dashboard
      router.push(`/lawfirm/${result.lawFirmId}/matters`);
    } catch (err) {
      setAcceptError(getErrorMessage(err, 'Failed to accept invitation'));
      setAccepting(false);
    }
  };

  if (authLoading || loading) {
    return <LoadingSpinner fullPage />;
  }

  const firmName = invitation?.lawFirmName || 'the law firm';

  if (!token || error) {
    return (
      <InvalidLinkPage
        title="This team invitation is no longer valid"
        description={error || 'The invitation link is missing, expired, or has already been used.'}
      />
    );
  }

  if (!user) {
    return (
      <AuthRequiredPage
        title="Sign in to accept this team invitation"
        description={`You'll need to sign in with the invited account before you can join ${firmName}.`}
        loginHref={`/login?redirect=${encodeURIComponent(`/accept-member-invite?token=${token}`)}`}
        secondaryHref={`/register/member-invite?token=${token}`}
        secondaryLabel="Create account"
      />
    );
  }

  return (
    <div className="min-h-screen bg-page flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8">
          <div className="flex justify-center mb-8">
            <ParalegixLogo width={280} height={80} priority />
          </div>

          <h2 className="text-xl font-bold text-center text-on-surface mb-1">Accept Invitation</h2>
          <p className="text-xs text-on-surface-muted text-center mb-7">
            <span className="font-semibold text-on-surface-secondary">{firmName}</span> has invited you to join their team
          </p>

          <ErrorNotification error={acceptError} onClose={() => setAcceptError(null)} className="mb-5" />

          {switchRequired ? (
            <p className="text-sm text-on-surface-muted text-center mb-6">
              You&apos;re currently part of{' '}
              <span className="font-semibold text-on-surface-secondary">
                {switchRequired.currentFirms.map((f) => f.name).join(', ')}
              </span>
              . You can only be part of one firm at a time, so joining {firmName} means leaving
              {switchRequired.currentFirms.length > 1 ? ' those firms' : ' that firm'} first.
              {switchRequired.currentFirms.some((f) => f.willBeDeleted) && (
                <>
                  {' '}Since you&apos;re the only member there, leaving will schedule it for deletion.
                </>
              )}
            </p>
          ) : invitation && (
            <p className="text-sm text-on-surface-muted text-center mb-6">
              By accepting, you&apos;ll be able to manage matters, tasks, billing, and collaborate with the team.
            </p>
          )}

          <div className="space-y-3">
            <AuthButton onClick={() => handleAccept(!!switchRequired)} loading={accepting}>
              {accepting
                ? (switchRequired ? 'Switching...' : 'Accepting...')
                : (switchRequired ? 'Leave and Join' : 'Accept Invitation')}
            </AuthButton>
            <AuthButton
              variant="secondary"
              onClick={() => (switchRequired ? setSwitchRequired(null) : router.push('/dashboard'))}
            >
              Cancel
            </AuthButton>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AcceptMemberInvitePage() {
  return (
    <Suspense fallback={<LoadingSpinner fullPage />}>
      <AcceptMemberInviteContent />
    </Suspense>
  );
}
