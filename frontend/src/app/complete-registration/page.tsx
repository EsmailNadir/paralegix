'use client';

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import authService from "@/services/auth.service";
import privacyService from "@/services/privacy.service";
import ErrorNotification from "@/components/ErrorNotification";
import { useAuth } from "@/hooks/useAuth";
import LoadingSpinner from "@/components/LoadingSpinner";
import AuthButton from "@/components/ui/AuthButton";
import { getUserTypeFromProfile } from "@/lib/utils/redirect";
import useFormFeedback from "@/hooks/useFormFeedback";

const CompleteRegistration = () => {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const { errorMessage, setErrorMessage, formRef, feedbackRef, feedbackId } = useFormFeedback();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [loading, setLoading] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [statusCheckFailed, setStatusCheckFailed] = useState(false);
  const [retryingStatus, setRetryingStatus] = useState(false);
  const [statusCheckAttempt, setStatusCheckAttempt] = useState(0);

  // The uid of the signed-in identity right now. An async step started for one
  // identity compares against it after every await, so a response that lands
  // after a sign-out or account switch cannot redirect or write for the new one.
  const uid = user?.uid ?? null;
  const identityRef = useRef(uid);
  useEffect(() => { identityRef.current = uid; }, [uid]);

  useEffect(() => {
    if (!checkingStatus && !statusCheckFailed) headingRef.current?.focus();
  }, [checkingStatus, statusCheckFailed]);

  useEffect(() => {
    let stale = false;
    const checkStatus = async () => {
      if (authLoading) return;

      if (!user) {
        router.replace('/login');
        return;
      }

      try {
        const { userType } = await getUserTypeFromProfile();
        if (stale) return;
        if (userType && userType !== 'pending') {
          const path = userType === 'client' ? '/client/dashboard' : '/dashboard';
          router.replace(path);
          return;
        }
        // getUserTypeFromProfile reports a failed profile read as a null type.
        const failed = userType === null;
        setStatusCheckFailed(failed);
        setErrorMessage(failed ? "We couldn't check your registration status. Please try again." : "");
      } catch (error) {
        if (stale) return;
        console.error('Error checking registration status:', error);
      }

      setRetryingStatus(false);
      setCheckingStatus(false);
    };

    checkStatus();
    return () => { stale = true; };
  }, [user, authLoading, router, statusCheckAttempt, setErrorMessage]);

  const retryStatusCheck = () => {
    setRetryingStatus(true);
    setStatusCheckAttempt(attempt => attempt + 1);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage("");
    setStatusCheckFailed(false);
    setLoading(true);
    const startedFor = identityRef.current;
    const identityChanged = () => identityRef.current !== startedFor;

    try {
      await authService.completeOAuthRegistration('firm_member');
      if (identityChanged()) return;

      // Record terms/privacy acceptance now that registration is complete.
      // Best-effort: never block or fail registration if this call errors.
      try {
        await privacyService.acceptTerms();
      } catch (consentError) {
        console.error('Failed to record terms acceptance:', consentError);
      }
      if (identityChanged()) return;

      // completeOAuthRegistration is the authoritative write, and we already know
      // the chosen userType, so the destination is known without re-deriving it.
      // We poll the profile only to confirm the write has propagated before we
      // navigate, and we use the single source of truth (getUserTypeFromProfile)
      // rather than a separate raw getProfile() loop so this flow fetches the
      // profile from exactly one place.
      let verified = false;
      let attempts = 0;
      const maxAttempts = 10;

      while (!verified && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (identityChanged()) return;
        attempts++;

        try {
          const { userType: type } = await getUserTypeFromProfile();
          if (identityChanged()) return;
          if (type === 'firm_member') {
            verified = true;
            break;
          }
        } catch {
          // User might not exist yet, keep trying
        }
      }

      if (!verified) {
        console.warn('Could not verify userType after registration, redirecting anyway');
      }

      router.replace('/dashboard');
    } catch (error: unknown) {
      if (identityChanged()) return;
      const errorMessage = error instanceof Error ? error.message : "Registration failed. Please try again.";
      setErrorMessage(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  if (authLoading || checkingStatus) {
    return (
      <main className="min-h-screen bg-page flex items-center justify-center">
        <div className="text-center">
          <div aria-hidden="true"><LoadingSpinner /></div>
          <p role="status" className="mt-4 text-on-surface-muted text-xs font-medium">Checking registration status...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-page flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8">
          <div className="flex justify-center mb-8">
            <ParalegixLogo
              width={160}
              height={40}
              priority
            />
          </div>

          <h1 ref={headingRef} tabIndex={-1} className="text-xl font-bold text-center text-on-surface mb-1">
            Complete Your Registration
          </h1>
          <p className="text-xs text-on-surface-muted text-center mb-7">
            Welcome! Please tell us how you&apos;ll be using Paralegix.
          </p>

          <div id={feedbackId} ref={feedbackRef} tabIndex={-1}>
            <ErrorNotification
              error={errorMessage}
              onRetry={statusCheckFailed ? retryStatusCheck : undefined}
              retrying={retryingStatus}
              onClose={() => { setErrorMessage(""); setStatusCheckFailed(false); formRef.current?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus(); }}
              className="mb-5"
            />
          </div>
          <p role="status" className="sr-only">{loading ? 'Completing registration...' : ''}</p>

          <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
            <div className="flex items-center gap-3 p-3.5 rounded-xl border-2 border-accent-solid bg-accent-soft">
              <svg aria-hidden="true" className="w-6 h-6 text-accent-emphasis flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 14.15v4.25c0 1.094-.787 2.036-1.872 2.18-2.087.277-4.216.42-6.378.42s-4.291-.143-6.378-.42c-1.085-.144-1.872-1.086-1.872-2.18v-4.25m16.5 0a2.18 2.18 0 00.75-1.661V8.706c0-1.081-.768-2.015-1.837-2.175a48.114 48.114 0 00-3.413-.387m4.5 8.006c-.194.165-.42.295-.673.38A23.978 23.978 0 0112 15.75c-2.648 0-5.195-.429-7.577-1.22a2.016 2.016 0 01-.673-.38m0 0A2.18 2.18 0 013 12.489V8.706c0-1.081.768-2.015 1.837-2.175a48.111 48.111 0 013.413-.387m7.5 0V5.25A2.25 2.25 0 0013.5 3h-3a2.25 2.25 0 00-2.25 2.25v.894m7.5 0a48.667 48.667 0 00-7.5 0M12 12.75h.008v.008H12v-.008z" />
              </svg>
              <div>
                <p className="text-xs font-semibold text-accent-emphasis">Law Firm workspace</p>
                <p className="text-[10px] text-on-surface-muted">Manage matters, tasks, and your team</p>
              </div>
            </div>

            <AuthButton htmlType="submit" disabled={loading} className="mt-2">
              {loading ? "Completing Registration..." : "Continue"}
            </AuthButton>
          </form>

          <p className="mt-5 text-center text-[10px] text-on-surface-muted">
            Have a client portal invite? Check the email from your law firm for a sign-in link
            instead.
          </p>
        </div>
      </div>
    </main>
  );
};

export default CompleteRegistration;
