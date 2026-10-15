'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import authService from "@/services/auth.service";
import privacyService from "@/services/privacy.service";
import ErrorNotification from "@/components/ErrorNotification";
import { getFirebaseErrorMessage } from "@/lib/utils/firebaseErrors";
import { useAuth } from "@/hooks/useAuth";
import LoadingSpinner from "@/components/LoadingSpinner";
import { getRedirectPath } from "@/lib/utils/redirect";
import { isWhitelistedEmail, isEmailVerified } from "@/lib/utils/emailVerification";
import Spinner from "@/components/ui/Spinner";
import MarketingTransition from "@/components/marketingComp/MarketingTransition";
import AuthButton from "@/components/ui/AuthButton";
import FieldLabel from "@/components/ui/FieldLabel";
import PasswordInput from "@/components/ui/PasswordInput";
import { track } from "@/lib/analytics/analytics";
import SignupConsent from '@/components/ui/SignupConsent';
import useFormFeedback from '@/hooks/useFormFeedback';

type OAuthProvider = "google" | "microsoft";

const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: "Google", microsoft: "Microsoft" };

const Register = () => {
  const router = useRouter();

  const { user, loading: authLoading } = useAuth();
  const [loadingMethod, setLoadingMethod] = useState<"" | "email" | "google" | "microsoft">("");
  // A ref, not state: the effect below must read the CURRENT in-flight status
  // at the moment `user`/`authLoading` change, without itself re-running every
  // time a handler flips the flag (a state dependency would fire this effect
  // an extra, redundant time right after every signup handler finishes).
  const signupInFlightRef = useRef(false);

  useEffect(() => {
    const checkAndRedirect = async () => {
      // Firebase flips `user` to non-null as soon as the account is created
      // client-side, which can race ahead of the backend call (still in
      // flight in the handler below) that creates the matching Postgres user
      // row. Skip this mount-time redirect while a signup is in progress -
      // the handler already redirects once its own backend call resolves.
      if (!authLoading && user && !signupInFlightRef.current) {
        // An unverified user always belongs on /verify-email. Checking this
        // first (a local Firebase flag) avoids a profile fetch that would
        // 403 for them, right after this page just created their account.
        if (!isEmailVerified(user)) {
          router.push('/verify-email');
          return;
        }

        try {
          const status = await authService.checkRegistrationStatus();
          if (status.needsRegistration) {
            router.push('/complete-registration');
            return;
          }
        } catch (error) {
          console.error('Error checking registration status:', error);
        }

        const path = await getRedirectPath();
        router.push(path);
      }
    };

    checkAndRedirect();
  }, [user, authLoading, router]);

  const [formData, setFormData] = useState({
    email: "",
    password: "",
    confirmPassword: "",
    name: "",
  });

  const { errorMessage, invalidField, setErrorMessage, setFieldError, formRef, feedbackRef, feedbackId } = useFormFeedback();
  const [navigating, setNavigating] = useState(false);
  // Announced through the status region: the pop-up being open, and a pop-up the
  // visitor closed, which raises no error banner.
  const [oauthStatus, setOauthStatus] = useState("");
  // The provider whose failure the error banner is showing, so dismissing it
  // returns focus to that provider rather than to the email form.
  const [oauthErrorProvider, setOauthErrorProvider] = useState<OAuthProvider | null>(null);
  const providerButtons = useRef<Record<OAuthProvider, HTMLButtonElement | null>>({ google: null, microsoft: null });
  // The provider button is disabled while its pop-up is open, so focus can only
  // return to it once `loadingMethod` has cleared and the button is enabled again.
  const pendingProviderFocus = useRef<OAuthProvider | null>(null);
  useEffect(() => {
    if (loadingMethod || !pendingProviderFocus.current) return;
    providerButtons.current[pendingProviderFocus.current]?.focus();
    pendingProviderFocus.current = null;
  }, [loadingMethod]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setOauthStatus("");
    setErrorMessage("");
    setOauthErrorProvider(null);

    if (formData.password !== formData.confirmPassword) {
      setFieldError("confirmPassword", "Passwords do not match");
      return;
    }

    if (formData.password.length < 6) {
      setFieldError("password", "Password must be at least 6 characters");
      return;
    }

    setLoadingMethod("email");
    signupInFlightRef.current = true;
    await new Promise(resolve => setTimeout(resolve, 0));

    try {
      await authService.signUp(formData.email, formData.password, {
        name: formData.name,
        userType: 'firm_member'
      });
      track("user_registered", { method: "email_password" });

      // Record terms/privacy acceptance now that the user is authenticated.
      // Best-effort: never block or fail registration if this call errors.
      try {
        await privacyService.acceptTerms();
      } catch (consentError) {
        console.error('Failed to record terms acceptance:', consentError);
      }

      // Whitelisted emails skip verification entirely
      if (isWhitelistedEmail(formData.email)) {
        const path = await getRedirectPath();
        router.replace(path);
        return;
      }

      // Send verification email for email/password registrations
      try {
        await authService.sendVerificationEmail();
      } catch (verifyError) {
        console.error('Failed to send verification email:', verifyError);
      }

      // Persist email so verify-email page can display it even if auth state is stale
      try { sessionStorage.setItem('verify-email-address', formData.email); } catch {}

      // Redirect to email verification screen
      router.replace('/verify-email');
    } catch (error: unknown) {
      const msg = getFirebaseErrorMessage(error, "Something went wrong. Please try again.");
      if (msg) {
        if (msg === getFirebaseErrorMessage({ code: 'auth/weak-password' }, '')) {
          setFieldError('password', msg);
        } else if (msg === getFirebaseErrorMessage({ code: 'auth/email-already-in-use' }, '') || msg === getFirebaseErrorMessage({ code: 'auth/invalid-email' }, '')) {
          setFieldError('email', msg);
        } else {
          setErrorMessage(msg);
        }
      }
    } finally {
      setLoadingMethod("");
      signupInFlightRef.current = false;
    }
  };

  const handleOAuthSignup = async (provider: OAuthProvider) => {
    const label = PROVIDER_LABEL[provider];
    setLoadingMethod(provider);
    signupInFlightRef.current = true;
    setErrorMessage("");
    setOauthStatus(`Signing up with ${label}...`);
    await new Promise(resolve => setTimeout(resolve, 0));

    try {
      const result = provider === "google"
        ? await authService.signUpWithGoogle()
        : await authService.signUpWithMicrosoft();
      track("user_registered", { method: provider });

      if (result.needsRegistration) {
        router.push('/complete-registration');
        return;
      }

      const path = await getRedirectPath();
      router.push(path);
    } catch (error: unknown) {
      const msg = getFirebaseErrorMessage(error, `${label} signup failed. Please try again.`);
      if (msg) {
        setOauthStatus("");
        setOauthErrorProvider(provider);
        setErrorMessage(msg);
      } else {
        // A closed or superseded pop-up is the visitor's own choice: no error
        // banner, but say what happened and put them back where they were.
        setOauthStatus(`${label} sign-up was cancelled.`);
        pendingProviderFocus.current = provider;
      }
    } finally {
      setLoadingMethod("");
      signupInFlightRef.current = false;
    }
  };

  const dismissError = () => {
    setErrorMessage("");
    if (oauthErrorProvider) {
      providerButtons.current[oauthErrorProvider]?.focus();
      setOauthErrorProvider(null);
      return;
    }
    formRef.current?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
  };

  // The waiting screen replaces the form, so whatever had focus is gone and
  // focus has fallen to the document. Land it on the waiting screen's landmark
  // instead, without taking it from anything that still holds it.
  const focusIfStranded = useCallback((main: HTMLElement | null) => {
    if (main && (!document.activeElement || document.activeElement === document.body)) main.focus();
  }, []);

  if (authLoading || navigating || user) {
    return (
      <main
        id="main-content"
        tabIndex={-1}
        ref={focusIfStranded}
        className="min-h-screen bg-page flex items-center justify-center"
      >
        <div className="text-center">
          {/* A signed-in visitor is being redirected, which is announced below
              instead of the spinner's own "Loading" status. */}
          <div aria-hidden={user ? "true" : undefined}><LoadingSpinner /></div>
          <p role="status" className="mt-4 text-on-surface-secondary text-xs font-medium">
            {user ? "Redirecting to your dashboard..." : ""}
          </p>
        </div>
      </main>
    );
  }

  return (
    <MarketingTransition className="min-h-screen bg-mkt-paper dark:bg-page flex items-start justify-center px-4 py-8">
      <div className="w-full max-w-[420px]">
        {/* Card */}
        <div className="bg-mkt-card dark:bg-surface rounded-2xl border border-mkt-line dark:border-outline-subtle shadow-mkt-md dark:shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8 pb-6">
          {/* Logo */}
          <div className="flex justify-center mb-5">
            <ParalegixLogo
              width={280}
              height={80}
              priority
            />
          </div>

          <h1 className="text-xl font-bold text-center text-on-surface mb-1">Create your account</h1>
          <p className="text-xs text-on-surface-muted text-center mb-5">Get started with Paralegix for free</p>

          {/* Error */}
          <div id={feedbackId} ref={feedbackRef} tabIndex={-1}>
            <ErrorNotification
              error={errorMessage}
              onClose={dismissError}
              className="mb-5"
            />
          </div>

          <form ref={formRef} onSubmit={handleSubmit} className="space-y-3">
            <div>
              <FieldLabel htmlFor="name" size="xs" tone="secondary" gap="1.5">
                Full Name *
              </FieldLabel>
              <input
                type="text"
                id="name"
                name="name"
                autoComplete="name"
                value={formData.name}
                onChange={handleChange}
                required
                placeholder="John Doe"
                className="w-full px-3.5 py-2.5 bg-input-bg border border-input-border rounded-xl text-sm text-on-surface placeholder-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/20 transition-all"
              />
            </div>

            <div>
              <FieldLabel htmlFor="email" size="xs" tone="secondary" gap="1.5">
                Email *
              </FieldLabel>
              <input
                type="email"
                id="email"
                name="email"
                autoComplete="email"
                aria-invalid={invalidField === 'email'}
                aria-describedby={invalidField === 'email' ? feedbackId : undefined}
                value={formData.email}
                onChange={handleChange}
                required
                placeholder="you@example.com"
                className="w-full px-3.5 py-2.5 bg-input-bg border border-input-border rounded-xl text-sm text-on-surface placeholder-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/20 transition-all"
              />
            </div>

            <div className="space-y-2.5">
              <div>
                <FieldLabel htmlFor="password" size="xs" tone="secondary" gap="1.5">
                  Password *
                </FieldLabel>
                <PasswordInput
                  id="password"
                  name="password"
                  value={formData.password}
                  onChange={handleChange}
                  required
                  placeholder="Min 6 characters"
                  autoComplete="new-password"
                  aria-invalid={invalidField === 'password'}
                  aria-describedby={invalidField === 'password' ? `${feedbackId} signup-password-hint` : 'signup-password-hint'}
                />
                <p id="signup-password-hint" className="mt-1.5 text-xs text-on-surface-muted">Use at least 6 characters.</p>
              </div>

              <div>
                <FieldLabel htmlFor="confirmPassword" size="xs" tone="secondary" gap="1.5">
                  Confirm Password *
                </FieldLabel>
                <PasswordInput
                  id="confirmPassword"
                  name="confirmPassword"
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  required
                  placeholder="Confirm password"
                  autoComplete="new-password"
                  aria-invalid={invalidField === 'confirmPassword'}
                  aria-describedby={invalidField === 'confirmPassword' ? feedbackId : undefined}
                />
              </div>
            </div>

            <AuthButton
              htmlType="submit"
              disabled={!!loadingMethod}
              loading={loadingMethod === "email"}
              className="mt-2"
            >
              {loadingMethod === "email" ? "Creating Account..." : "Create Account"}
            </AuthButton>
          </form>

          {/* Divider */}
          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-outline-subtle"></div>
            </div>
            <div className="relative flex justify-center">
              <span className="px-3 bg-mkt-card dark:bg-surface text-[10px] text-on-surface-muted uppercase tracking-wider font-medium">or continue with</span>
            </div>
          </div>

          {/* OAuth buttons */}
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              ref={(el) => { providerButtons.current.google = el; }}
              onClick={() => handleOAuthSignup("google")}
              disabled={!!loadingMethod}
              aria-busy={loadingMethod === "google"}
              className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-medium text-on-surface bg-surface border border-outline hover:bg-surface-hover hover:border-on-surface-muted transition-all duration-100 active:scale-[0.985] motion-reduce:active:scale-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {loadingMethod === "google" ? (
                <Spinner size={16} className="text-on-surface-muted" />
              ) : (
                <Image
                  src="/img/google-logo.png"
                  alt=""
                  width={16}
                  height={16}
                  priority
                />
              )}
              Google
            </button>

            <button
              type="button"
              ref={(el) => { providerButtons.current.microsoft = el; }}
              onClick={() => handleOAuthSignup("microsoft")}
              disabled={!!loadingMethod}
              aria-busy={loadingMethod === "microsoft"}
              className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-medium text-on-surface bg-surface border border-outline hover:bg-surface-hover hover:border-on-surface-muted transition-all duration-100 active:scale-[0.985] motion-reduce:active:scale-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {loadingMethod === "microsoft" ? (
                <Spinner size={16} className="text-on-surface-muted" />
              ) : (
                <svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 24 24">
                  <path d="M11.4 24H0V12.6h11.4V24z" fill="#00A4EF"/>
                  <path d="M24 24H12.6V12.6H24V24z" fill="#FFB900"/>
                  <path d="M11.4 11.4H0V0h11.4v11.4z" fill="#F25022"/>
                  <path d="M24 11.4H12.6V0H24v11.4z" fill="#7FBA00"/>
                </svg>
              )}
              Microsoft
            </button>
          </div>
          <div role="status" aria-atomic="true" className="sr-only">{oauthStatus}</div>

          <p className="mt-3 text-center text-[10px] text-on-surface-muted">
            Already work with a firm on Paralegix? You&apos;ll get a client portal invite by
            email, no need to sign up here.
          </p>

          <SignupConsent
            className="mt-2.5"
            onNavigate={(path) => { setNavigating(true); router.push(path); }}
          />
        </div>

        {/* Footer link */}
        <p className="mt-6 text-center text-xs text-on-surface-muted">
          Already have an account?{" "}
          <Link
            href="/login"
            onNavigate={() => setNavigating(true)}
            className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors cursor-pointer"
          >
            Sign in
          </Link>
        </p>
      </div>
    </MarketingTransition>
  );
};

export default Register;
