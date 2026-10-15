'use client';

import { useState, useEffect, useId, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { confirmPasswordReset } from "firebase/auth";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import ErrorNotification from "@/components/ErrorNotification";
import LoadingSpinner from "@/components/LoadingSpinner";
import InvalidLinkPage from "@/components/ui/InvalidLinkPage";
import Link from "next/link";
import AuthButton from "@/components/ui/AuthButton";
import useFormFeedback from "@/hooks/useFormFeedback";
import FieldLabel from "@/components/ui/FieldLabel";

const ResetPasswordContent = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const { errorMessage, setErrorMessage, setFieldError, invalidField, formRef, feedbackRef, feedbackId } = useFormFeedback();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  // The success heading takes focus, so describing it with the redirect notice
  // announces the timed navigation before it happens.
  const successDescriptionId = useId();
  useEffect(() => {
    if (success) successHeadingRef.current?.focus();
  }, [success]);

  // Get the oobCode from URL parameters
  const oobCode = searchParams.get('oobCode');

  useEffect(() => {
    if (!oobCode) {
      setErrorMessage("Invalid reset link. Please request a new password reset from the login page.");
    }
  }, [oobCode, setErrorMessage]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage("");

    if (password !== confirmPassword) {
      setFieldError("confirmPassword", "Passwords do not match");
      return;
    }

    if (password.length < 6) {
      setFieldError("password", "Password must be at least 6 characters long");
      return;
    }

    setLoading(true);

    try {
      const { auth: firebaseAuth } = await import('@/lib/firebase/config');
      if (!firebaseAuth) {
        setErrorMessage("Unable to initialize. Please refresh the page and try again.");
        setLoading(false);
        return;
      }

      await confirmPasswordReset(firebaseAuth, oobCode!, password);
      setSuccess(true);
      setTimeout(() => {
        router.push("/login");
      }, 3000);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to reset password";

      if (msg.includes('auth/expired-action-code')) {
        setErrorMessage("This reset link has expired. Please request a new password reset from the login page.");
      } else if (msg.includes('auth/invalid-action-code')) {
        setErrorMessage("This reset link is invalid or has already been used. Please request a new password reset.");
      } else if (msg.includes('auth/weak-password')) {
        setFieldError("password", "Password is too weak. Please use at least 6 characters.");
      } else if (msg.includes('auth/network-request-failed')) {
        setErrorMessage("Network error. Please check your internet connection and try again.");
      } else {
        setErrorMessage("Failed to reset password. The link may be expired or invalid.");
      }
    } finally {
      setLoading(false);
    }
  };

  if (success) {
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

            <h1 ref={successHeadingRef} tabIndex={-1} aria-describedby={successDescriptionId} className="text-xl font-bold text-center text-on-surface mb-1">Password Reset Successful</h1>
            <div id={successDescriptionId}>
              <p className="text-xs text-on-surface-muted text-center mb-5">
                Your password has been successfully reset. You can now sign in with your new password.
              </p>
              <p className="text-xs text-on-surface-muted text-center mb-6">Redirecting to login...</p>
            </div>

            <AuthButton href="/login">Sign In Now</AuthButton>
          </div>
        </div>
      </main>
    );
  }

  const hasLinkIssue =
    !oobCode ||
    /reset link|expired|already been used|link may be expired or invalid/i.test(errorMessage);

  if (hasLinkIssue) {
    return (
      <InvalidLinkPage
        title="This password reset link is no longer valid"
        description={
          errorMessage ||
          "Request a new password reset email, then open the newest link that arrives."
        }
        primaryAction={{
          label: "Back to login",
          href: "/login",
        }}
        secondaryAction={{
          label: "Request a new reset",
          href: "/login",
        }}
      />
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

          <h1 className="text-xl font-bold text-center text-on-surface mb-1">Reset Your Password</h1>
          <p className="text-xs text-on-surface-muted text-center mb-7">Enter your new password below</p>

          <div id={feedbackId} ref={feedbackRef} tabIndex={-1}>
            <ErrorNotification
              error={errorMessage}
              onClose={() => setErrorMessage("")}
              className="mb-5"
            />
          </div>

          <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
            <div>
              <FieldLabel htmlFor="password" size="xs" tone="secondary" gap="1.5">
                New Password *
              </FieldLabel>
              <input
                type="password"
                id="password"
                name="password"
                aria-invalid={invalidField === "password"}
                aria-describedby={invalidField === "password" ? feedbackId : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                placeholder="Min 6 characters"
                className="w-full px-3.5 py-2.5 bg-input-bg border border-input-border rounded-xl text-sm text-on-surface placeholder-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/20 transition-all"
              />
            </div>

            <div>
              <FieldLabel htmlFor="confirmPassword" size="xs" tone="secondary" gap="1.5">
                Confirm New Password *
              </FieldLabel>
              <input
                type="password"
                id="confirmPassword"
                name="confirmPassword"
                aria-invalid={invalidField === "confirmPassword"}
                aria-describedby={invalidField === "confirmPassword" ? feedbackId : undefined}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={6}
                placeholder="Confirm your new password"
                className="w-full px-3.5 py-2.5 bg-input-bg border border-input-border rounded-xl text-sm text-on-surface placeholder-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/20 transition-all"
              />
            </div>

            <AuthButton htmlType="submit" disabled={loading || !oobCode} className="mt-2">
              {loading ? "Resetting..." : "Reset Password"}
            </AuthButton>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-on-surface-muted">
          <Link href="/login" className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors">
            Back to login
          </Link>
        </p>
      </div>
    </main>
  );
};

const ResetPassword = () => {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-page flex items-center justify-center">
        <LoadingSpinner />
      </div>
    }>
      <ResetPasswordContent />
    </Suspense>
  );
};

export default ResetPassword;
