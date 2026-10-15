'use client';

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import { useAuth } from "@/hooks/useAuth";
import authService from "@/services/auth.service";
import ErrorNotification from "@/components/ErrorNotification";
import LoadingSpinner from "@/components/LoadingSpinner";
import AuthButton from "@/components/ui/AuthButton";
import { getRedirectPath } from "@/lib/utils/redirect";
import useFormFeedback from "@/hooks/useFormFeedback";
import { isOAuthUser, isEmailVerified } from "@/lib/utils/emailVerification";

const RESEND_COOLDOWN_SECONDS = 60;
const POLL_INTERVAL_MS = 5000;

type VerifyCheckResult =
  | 'verified'
  | 'not-verified'
  | 'no-user'
  | 'network-error'
  | 'session-expired'
  | 'error';

const VerifyEmail = () => {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const { errorMessage, setErrorMessage, feedbackRef, feedbackId } = useFormFeedback();
  const [successMessage, setSuccessMessage] = useState("");
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [checking, setChecking] = useState(false);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const cooldownRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

  // Fallback email from sessionStorage (set during registration)
  const displayEmail = user?.email || (typeof window !== 'undefined' ? sessionStorage.getItem('verify-email-address') : null) || '';

  // Track mounted state for safe async updates
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (cooldownRef.current) clearInterval(cooldownRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Start cooldown timer
  const startCooldown = useCallback(() => {
    setCooldown(RESEND_COOLDOWN_SECONDS);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setCooldown(prev => {
        if (prev <= 1) {
          if (cooldownRef.current) clearInterval(cooldownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  // Check verification status by reloading user from Firebase
  const checkVerificationStatus = useCallback(async (): Promise<VerifyCheckResult> => {
    try {
      const { auth: firebaseAuth } = await import('@/lib/firebase/config');
      if (!firebaseAuth?.currentUser) {
        return 'no-user';
      }

      // Reload user data from Firebase servers
      await firebaseAuth.currentUser.reload();

      // Re-read from auth.currentUser after reload. This is the live reference
      // that reload() mutates in place
      const refreshedUser = firebaseAuth.currentUser;
      if (!refreshedUser) {
        return 'no-user';
      }

      if (refreshedUser.emailVerified) {
        // Force token refresh so the new emailVerified claim propagates
        await refreshedUser.getIdToken(true);
        return 'verified';
      }

      return 'not-verified';
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '';

      if (msg.includes('auth/network-request-failed')) {
        return 'network-error';
      }
      if (
        msg.includes('auth/user-token-expired') ||
        msg.includes('auth/user-disabled') ||
        msg.includes('auth/invalid-user-token') ||
        msg.includes('auth/requires-recent-login')
      ) {
        return 'session-expired';
      }

      return 'error';
    }
  }, []);

  // Redirect already-verified users
  useEffect(() => {
    if (authLoading) return;

    if (!user) {
      router.replace('/login');
      return;
    }

    // OAuth users should never be on this page, redirect to dashboard
    if (isOAuthUser(user)) {
      const redirect = async () => {
        try {
          const status = await authService.checkRegistrationStatus();
          if (status.needsRegistration) {
            router.replace('/complete-registration');
            return;
          }
        } catch {}
        const path = await getRedirectPath();
        router.replace(path);
      };
      redirect();
      return;
    }

    // Quick check: if already verified or whitelisted, redirect immediately
    if (isEmailVerified(user)) {
      const redirect = async () => {
        const path = await getRedirectPath();
        router.replace(path);
      };
      redirect();
      return;
    }

    // Also do a live check in matter the React state is stale (e.g. user
    // verified in another tab then navigated here)
    const liveCheck = async () => {
      const result = await checkVerificationStatus();
      if (!mountedRef.current) return;
      if (result === 'verified') {
        const path = await getRedirectPath();
        router.replace(path);
      } else if (result === 'no-user') {
        router.replace('/login');
      }
    };
    liveCheck();
  }, [user, authLoading, router, checkVerificationStatus]);

  // Auto-poll for verification status
  useEffect(() => {
    if (authLoading || !user || isEmailVerified(user)) return;

    pollRef.current = setInterval(async () => {
      const result = await checkVerificationStatus();
      if (!mountedRef.current) return;

      if (result === 'verified') {
        if (pollRef.current) clearInterval(pollRef.current);
        const path = await getRedirectPath();
        router.replace(path);
      } else if (result === 'no-user' || result === 'session-expired') {
        if (pollRef.current) clearInterval(pollRef.current);
        router.replace('/login');
      }
      // 'not-verified', 'network-error', 'error': silently retry on next poll
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [authLoading, user, checkVerificationStatus, router]);

  const handleResend = async () => {
    if (resending) return;
    setResending(true);
    setErrorMessage("");
    setSuccessMessage("");

    try {
      await authService.sendVerificationEmail();
      if (!mountedRef.current) return;
      setSuccessMessage("Verification email sent! Check your inbox or spam folder.");
      startCooldown();
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      const msg = error instanceof Error ? error.message : "Failed to send verification email";
      if (msg.includes('auth/too-many-requests')) {
        setErrorMessage("Too many requests. Please wait a few minutes before trying again.");
        startCooldown();
      } else if (msg.includes('auth/missing-email') || msg.includes('auth/user-not-found') || msg.includes('No authenticated user')) {
        setErrorMessage("Your session has expired. Please log in again to resend the verification email.");
      } else {
        setErrorMessage(msg);
      }
    } finally {
      if (mountedRef.current) setResending(false);
    }
  };

  const handleCheckStatus = async () => {
    if (checking) return;
    setChecking(true);
    setErrorMessage("");
    setSuccessMessage("");

    const result = await checkVerificationStatus();
    if (!mountedRef.current) return;

    switch (result) {
      case 'verified': {
        const path = await getRedirectPath();
        router.replace(path);
        return; // Don't reset checking, we're navigating away
      }
      case 'not-verified':
        setErrorMessage("Email not yet verified. Please check your inbox and click the verification link.");
        break;
      case 'no-user':
      case 'session-expired':
        setErrorMessage("Your session has expired. Redirecting to login...");
        setTimeout(() => router.replace('/login'), 1500);
        break;
      case 'network-error':
        setErrorMessage("Couldn't check verification status. Please check your internet connection and try again.");
        break;
      case 'error':
        setErrorMessage("Something went wrong checking your verification status. Please try again.");
        break;
    }

    setChecking(false);
  };

  const handleBackToLogin = async () => {
    try { sessionStorage.removeItem('verify-email-address'); } catch {}
    await authService.signOutUser();
    router.replace('/login');
  };

  if (authLoading || (user && isEmailVerified(user))) {
    return <LoadingSpinner fullPage />;
  }

  if (!user) return null;

  return (
    <main className="min-h-screen bg-page flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8">
          {/* Logo */}
          <div className="flex justify-center mb-8">
            <ParalegixLogo
              width={160}
              height={40}
              priority
            />
          </div>

          {/* Mail icon */}
          <div className="flex justify-center mb-5">
            <div className="w-14 h-14 rounded-full bg-accent-soft flex items-center justify-center">
              <svg className="w-7 h-7 text-accent-emphasis" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
              </svg>
            </div>
          </div>

          <h1 className="text-xl font-bold text-center text-on-surface mb-1">Check your email</h1>
          <p className="text-xs text-on-surface-muted text-center mb-2">
            We sent a verification link to
          </p>
          <p className="text-sm font-medium text-on-surface-secondary text-center mb-6">
            {displayEmail}
          </p>

          <p className="text-xs text-on-surface-muted text-center mb-6">
            Click the link in the email to verify your account. If you don&apos;t see it, check your spam folder.
          </p>

          {/* Messages */}
          <div id={feedbackId} ref={feedbackRef} tabIndex={-1}>
            <ErrorNotification
              error={errorMessage}
              onClose={() => setErrorMessage("")}
              className="mb-4"
            />
          </div>

          <div role="status" aria-atomic="true">
            {successMessage && (
              <div className="mb-4 p-3.5 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-800/50 rounded-xl">
                <div className="flex items-start gap-2.5">
                  <svg className="h-4 w-4 text-emerald-500 mt-0.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <p className="text-xs text-emerald-700 dark:text-emerald-300">{successMessage}</p>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2.5">
            {/* Check verification status */}
            <AuthButton onClick={handleCheckStatus} disabled={checking}>
              {checking ? "Checking..." : "I've Verified My Email"}
            </AuthButton>

            {/* Resend */}
            <AuthButton
              variant="secondary"
              onClick={handleResend}
              disabled={resending || cooldown > 0}
              className="hover:border-on-surface-muted"
            >
              {resending
                ? "Sending..."
                : cooldown > 0
                  ? `Resend in ${cooldown}s`
                  : "Resend Verification Email"
              }
            </AuthButton>
          </div>

          <p className="mt-5 text-[10px] text-on-surface-muted text-center">
            Verification is checked automatically. You can also click the button above after verifying.
          </p>
        </div>

        {/* Footer link */}
        <p className="mt-6 text-center text-xs text-on-surface-muted">
          Wrong email?{" "}
          <button onClick={handleBackToLogin} className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors cursor-pointer">
            Back to login
          </button>
        </p>
      </div>
    </main>
  );
};

export default VerifyEmail;
