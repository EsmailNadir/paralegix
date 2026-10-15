'use client';

import { useState, useEffect, useId, useRef, Suspense, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { applyActionCode } from "firebase/auth";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import LoadingSpinner from "@/components/LoadingSpinner";
import AuthButton from "@/components/ui/AuthButton";
import InvalidLinkPage from "@/components/ui/InvalidLinkPage";
import authService from "@/services/auth.service";

const AuthActionContent = () => {
  const router = useRouter();
  const searchParams = useSearchParams();

  const mode = searchParams.get('mode');
  const oobCode = searchParams.get('oobCode');

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState("");
  const [errorType, setErrorType] = useState<'expired' | 'invalid' | 'already-used' | 'generic' | null>(null);
  const [resending, setResending] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [resendError, setResendError] = useState("");
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  // The success heading takes focus, so describing it with the redirect notice
  // announces the timed navigation before it happens.
  const successDescriptionId = useId();
  useEffect(() => {
    if (status === "success") successHeadingRef.current?.focus();
  }, [status]);

  const handleResendVerification = useCallback(async () => {
    if (resending) return;
    setResending(true);
    setResendSuccess(false);
    setResendError("");
    try {
      await authService.sendVerificationEmail();
      setResendSuccess(true);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to resend email";
      if (msg.includes('auth/too-many-requests')) {
        setResendError("Too many requests. Please wait a few minutes before trying again.");
      } else if (msg.includes('No authenticated user')) {
        setResendError("You're not signed in. Please log in first, then resend from the verification screen.");
      } else {
        setResendError(msg);
      }
    } finally {
      setResending(false);
    }
  }, [resending]);

  useEffect(() => {
    if (!mode && !oobCode) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- effect processes an async firebase action code and performs navigation/redirects based on URL params
      setStatus('error');
      setErrorType('generic');
      setErrorMessage("This page handles email verification and password reset links. It looks like you navigated here directly. If you need to verify your email, check your inbox for the verification link.");
      return;
    }

    if (mode === 'resetPassword') {
      const params = new URLSearchParams();
      if (oobCode) params.set('oobCode', oobCode);
      router.replace(`/reset-password?${params.toString()}`);
      return;
    }

    if (mode !== 'verifyEmail') {
      setStatus('error');
      setErrorType('generic');
      setErrorMessage("This action is not supported. Please check the link and try again.");
      return;
    }

    if (!oobCode) {
      setStatus('error');
      setErrorType('invalid');
      setErrorMessage("Invalid verification link. The verification code is missing from the URL.");
      return;
    }

    const verifyEmail = async () => {
      try {
        const { auth: firebaseAuth } = await import('@/lib/firebase/config');
        if (!firebaseAuth) {
          setStatus('error');
          setErrorType('generic');
          setErrorMessage("Unable to initialize. Please refresh the page and try again.");
          return;
        }

        await applyActionCode(firebaseAuth, oobCode);
        setStatus('success');

        setTimeout(() => {
          router.push("/login");
        }, 3000);
      } catch (error: unknown) {
        setStatus('error');
        const msg = error instanceof Error ? error.message : "Verification failed";

        if (msg.includes('auth/expired-action-code')) {
          setErrorType('expired');
          setErrorMessage("This verification link has expired. Please request a new verification email.");
        } else if (msg.includes('auth/invalid-action-code')) {
          setErrorType('already-used');
          setErrorMessage("This verification link is invalid or has already been used. If you've already verified your email, you can sign in below.");
        } else if (msg.includes('auth/network-request-failed')) {
          setErrorType('generic');
          setErrorMessage("Network error. Please check your internet connection and try again.");
        } else {
          setErrorType('generic');
          setErrorMessage("Email verification failed. The link may be expired or invalid.");
        }
      }
    };

    verifyEmail();
  }, [mode, oobCode, router]);

  if (status === 'loading') {
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
            <div className="flex flex-col items-center">
              <div aria-hidden="true"><LoadingSpinner /></div>
              <p role="status" className="mt-4 text-xs text-on-surface-muted font-medium">Verifying your email...</p>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (status === 'success') {
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

            <div className="flex justify-center mb-5">
              <div className="w-12 h-12 rounded-full bg-emerald-50 dark:bg-emerald-950/30 flex items-center justify-center">
                <svg className="w-6 h-6 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>

            <h1 ref={successHeadingRef} tabIndex={-1} aria-describedby={successDescriptionId} className="text-xl font-bold text-center text-on-surface mb-1">Email Verified</h1>
            <div id={successDescriptionId}>
              <p className="text-xs text-on-surface-muted text-center mb-5">
                Your email has been successfully verified. You can now sign in to your account.
              </p>
              <p className="text-xs text-on-surface-muted text-center">Redirecting to login...</p>
            </div>

            <div className="mt-6">
              <AuthButton href="/login">Sign In Now</AuthButton>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // Error state
  const showResendButton = errorType === 'expired' || errorType === 'already-used' || errorType === 'invalid';

  return (
    <InvalidLinkPage
      title={
        errorType === 'generic'
          ? 'We could not complete this email action'
          : 'This verification link is no longer valid'
      }
      description={errorMessage}
      primaryAction={
        showResendButton
          ? {
              label: resending ? 'Sending verification email' : 'Resend verification email',
              onClick: handleResendVerification,
              loading: resending,
            }
          : {
              label: 'Back to login',
              href: '/login',
            }
      }
      secondaryAction={{
        label: 'Back to login',
        href: '/login',
      }}
    >
      <div role="status" aria-atomic="true">
        {resendSuccess ? (
          <div className="rounded-2xl border border-emerald-200/70 bg-emerald-50 px-4 py-4 text-sm text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300">
            A new verification email has been sent. Check your inbox for the newest message.
          </div>
        ) : null}
      </div>
      {resendError ? (
        <div role="alert" className="mt-3 rounded-2xl border border-rose-200/70 bg-rose-50 px-4 py-4 text-sm text-rose-700 dark:border-rose-800/60 dark:bg-rose-950/30 dark:text-rose-300">
          {resendError}
        </div>
      ) : null}
    </InvalidLinkPage>
  );
};

const AuthAction = () => {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-page flex items-center justify-center">
        <LoadingSpinner />
      </div>
    }>
      <AuthActionContent />
    </Suspense>
  );
};

export default AuthAction;
