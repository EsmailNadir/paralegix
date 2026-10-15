'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import authService from "@/services/auth.service";
import ErrorNotification from "@/components/ErrorNotification";
import { useAuth } from "@/hooks/useAuth";
import LoadingSpinner from "@/components/LoadingSpinner";
import { resolveLoginDestination } from "@/lib/utils/redirect";
import { clearTokenCache, refreshToken } from "@/lib/utils/auth";
import { reloadAndCheckVerified } from "@/lib/utils/emailVerification";
import { getFirebaseErrorMessage } from "@/lib/utils/firebaseErrors";
import { sanitizeNextPath } from "@/lib/utils/safeNext";
import Spinner from "@/components/ui/Spinner";
import MarketingTransition from "@/components/marketingComp/MarketingTransition";
import AuthButton from "@/components/ui/AuthButton";
import FieldLabel from "@/components/ui/FieldLabel";
import PasswordInput from "@/components/ui/PasswordInput";
import useFormFeedback from "@/hooks/useFormFeedback";
import { track } from "@/lib/analytics/analytics";

type OAuthProvider = "google" | "microsoft";

const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: "Google", microsoft: "Microsoft" };

/**
 * Which control raised the current error, so the credential fields are only
 * marked invalid for a credential failure and dismissal can return focus to the
 * control the visitor was using.
 */
type ErrorSource = "credentials" | "forgot" | OAuthProvider;

const LoginForm = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = sanitizeNextPath(searchParams?.get('next'));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { errorMessage, setErrorMessage, setFieldError, invalidField, formRef, feedbackRef, feedbackId } = useFormFeedback();
  const [loadingMethod, setLoadingMethod] = useState<"" | "email" | "google" | "microsoft" | "forgot">("");
  const [forgotPasswordMode, setForgotPasswordMode] = useState(false);
  const previousMode = useRef(forgotPasswordMode);
  useEffect(() => {
    if (previousMode.current === forgotPasswordMode) return;
    previousMode.current = forgotPasswordMode;
    const emailField = formRef.current?.elements.namedItem("email");
    if (emailField instanceof HTMLElement) emailField.focus();
  }, [forgotPasswordMode, formRef]);
  const [successMessage, setSuccessMessage] = useState("");
  const [errorSource, setErrorSource] = useState<ErrorSource>("credentials");
  // Announced through the status region: the pop-up being open, and a pop-up the
  // visitor closed, which raises no error banner.
  const [oauthStatus, setOauthStatus] = useState("");
  const providerButtons = useRef<Record<OAuthProvider, HTMLButtonElement | null>>({ google: null, microsoft: null });
  // The provider button is disabled while its pop-up is open, so focus can only
  // return to it once `loadingMethod` has cleared and the button is enabled again.
  const pendingProviderFocus = useRef<OAuthProvider | null>(null);
  useEffect(() => {
    if (loadingMethod || !pendingProviderFocus.current) return;
    providerButtons.current[pendingProviderFocus.current]?.focus();
    pendingProviderFocus.current = null;
  }, [loadingMethod]);
  const credentialError = !!errorMessage && errorSource === "credentials";
  const [authenticating, setAuthenticating] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  // The guard that stops this redirect running twice must NOT be the same state
  // that renders the spinner. `redirecting` is a dependency of the effect below,
  // so setting it re-runs the effect, and the re-run's cleanup cancels the first
  // run at its next await. The redirect then never completed and an already
  // signed-in visitor sat on the login page forever. A ref changes
  // synchronously and triggers no re-run, so it can guard while the state
  // renders.
  const redirectStartedRef = useRef(false);
  const [navigating, setNavigating] = useState(false);

  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    // Abort guard: if user/authLoading change mid-flight (or the component
    // unmounts), don't resolve a stale redirect. `cancelled` short-circuits
    // every await boundary before it can call router.replace.
    let cancelled = false;

    const checkAndRedirect = async () => {
      // Reset on sign-out so a later sign-in on this same mounted page can
      // redirect again.
      if (authLoading || !user) {
        redirectStartedRef.current = false;
        return;
      }
      if (!authenticating && !redirectStartedRef.current) {
        redirectStartedRef.current = true;
        setRedirecting(true);

        // One awaited helper that always reloads and reports current verification
        // state (replaces the inline reload + stale-state check).
        const verified = await reloadAndCheckVerified();
        if (cancelled) return;

        if (verified === 'not-verified') {
          router.replace('/verify-email');
          return;
        }

        try {
          const status = await authService.checkRegistrationStatus();
          if (cancelled) return;
          if (status.needsRegistration) {
            router.replace('/complete-registration');
            return;
          }
        } catch (error) {
          console.error('Error checking registration status:', error);
        }

        // A validated `next` wins over the default destination so an email deep
        // link survives the login round-trip, but only for a firm this account
        // can actually open (see resolveLoginDestination).
        const path = await resolveLoginDestination(nextPath);
        if (cancelled) return;
        router.replace(path);
      }
    };

    checkAndRedirect();

    return () => { cancelled = true; };
  }, [user, authLoading, router, authenticating, nextPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setOauthStatus("");
    setErrorMessage("");
    setLoadingMethod("email");
    setAuthenticating(true);
    await new Promise(resolve => setTimeout(resolve, 0));

    try {
      clearTokenCache();

      await authService.signIn(email, password);

      await refreshToken();
      track("user_logged_in", { method: "email_password" });

      // Check email verification for email/password users via the single
      // always-reload helper (no fixed setTimeout delay).
      const verified = await reloadAndCheckVerified();
      if (verified === 'not-verified') {
        setRedirecting(true);
        router.replace('/verify-email');
        return;
      }

      setRedirecting(true);
      const path = await resolveLoginDestination(nextPath);
      router.replace(path);
    } catch (error: unknown) {
      const msg = getFirebaseErrorMessage(error, "Invalid email or password.");
      setErrorSource("credentials");
      if (msg) setErrorMessage(msg);
      setAuthenticating(false);
    } finally {
      setLoadingMethod("");
    }
  };

  const handleOAuthLogin = async (provider: OAuthProvider) => {
    const label = PROVIDER_LABEL[provider];
    setLoadingMethod(provider);
    setErrorMessage("");
    setOauthStatus(`Signing in with ${label}...`);
    setAuthenticating(true);
    await new Promise(resolve => setTimeout(resolve, 0));

    try {
      clearTokenCache();

      const result = provider === "google"
        ? await authService.signInWithGoogle()
        : await authService.signInWithMicrosoft();

      await refreshToken();
      track("user_logged_in", { method: provider });

      setRedirecting(true);

      if (result.needsRegistration) {
        router.replace('/complete-registration');
        return;
      }

      const path = await resolveLoginDestination(nextPath);
      router.replace(path);
    }
    catch (error: unknown) {
      const msg = getFirebaseErrorMessage(error, `${label} login failed. Please try again.`);
      setErrorSource(provider);
      if (msg) {
        setOauthStatus("");
        setErrorMessage(msg);
      } else {
        // A closed or superseded pop-up is the visitor's own choice: no error
        // banner, but say what happened and put them back where they were.
        setOauthStatus(`${label} sign-in was cancelled.`);
        pendingProviderFocus.current = provider;
      }
      setAuthenticating(false);
    }
    finally {
      setLoadingMethod("");
    }
  };

  // The waiting screen replaces the form, so whatever had focus (the provider
  // button, the submit button) is gone and focus has fallen to the document.
  // Land it on the waiting screen's landmark instead, without taking it from
  // anything that still holds it.
  const focusIfStranded = useCallback((main: HTMLElement | null) => {
    if (main && (!document.activeElement || document.activeElement === document.body)) main.focus();
  }, []);

  const dismissError = () => {
    setErrorMessage("");
    if (errorSource === "google" || errorSource === "microsoft") {
      providerButtons.current[errorSource]?.focus();
      return;
    }
    const emailField = formRef.current?.elements.namedItem("email");
    if (emailField instanceof HTMLElement) emailField.focus();
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setOauthStatus("");
    setErrorMessage("");
    setSuccessMessage("");
    setLoadingMethod("forgot");
    await new Promise(resolve => setTimeout(resolve, 0));

    try {
      await authService.forgotPassword(email);
      setSuccessMessage("Password reset email sent! Check your inbox or spam folder.");
      setForgotPasswordMode(false);
    } catch (error: unknown) {
      const msg = getFirebaseErrorMessage(error, "Failed to send reset email. Please try again.");
      setErrorSource("forgot");
      if (msg) {
        if ((error as { code?: string } | null)?.code === "auth/invalid-email") setFieldError("email", msg);
        else setErrorMessage(msg);
      }
    } finally {
      setLoadingMethod("");
    }
  };

  if (authLoading || navigating || redirecting || (user && !authenticating)) {
    return (
      <main
        id="main-content"
        tabIndex={-1}
        ref={focusIfStranded}
        className="min-h-screen bg-mkt-paper dark:bg-page flex items-center justify-center"
      >
        <div className="text-center">
          {/* Once the redirect is announced below, the spinner's own "Loading"
              status would be a second, competing announcement. */}
          <div aria-hidden={redirecting ? "true" : undefined}><LoadingSpinner /></div>
          <p role="status" className="mt-4 text-on-surface-secondary text-xs font-medium">
            {redirecting ? "Redirecting to your dashboard..." : ""}
          </p>
        </div>
      </main>
    );
  }

  return (
    <MarketingTransition className="min-h-screen bg-mkt-paper dark:bg-page flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        {/* Card */}
        <div className="bg-mkt-card dark:bg-surface rounded-2xl border border-mkt-line dark:border-outline-subtle shadow-mkt-md dark:shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8">
          {/* Logo */}
          <div className="flex justify-center mb-8">
            <ParalegixLogo
              width={280}
              height={90}
              priority
            />
          </div>

          <h1 className="text-xl font-bold text-center text-on-surface mb-1">{forgotPasswordMode ? "Reset your password" : "Welcome back"}</h1>
          <p className="text-xs text-on-surface-muted text-center mb-7">{forgotPasswordMode ? "Enter your email to receive a reset link" : "Sign in to your account to continue"}</p>

          {/* Error / Success */}
          <div id={feedbackId} ref={feedbackRef} tabIndex={-1}>
            <ErrorNotification
              error={errorMessage}
              onClose={dismissError}
              className="mb-5"
            />
          </div>

          <div role="status" aria-atomic="true">
            {successMessage && (
              <div className="mb-5 p-3.5 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-800/50 rounded-xl">
                <div className="flex items-start gap-2.5">
                  <svg className="h-4 w-4 text-emerald-500 mt-0.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <p className="text-xs text-emerald-700 dark:text-emerald-300">{successMessage}</p>
                </div>
              </div>
            )}
            <p className="sr-only">{oauthStatus}</p>
          </div>

          {!forgotPasswordMode ? (
            <>
              <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <FieldLabel htmlFor="email" size="xs" tone="secondary" gap="1.5">
                    Email *
                  </FieldLabel>
                  <input
                    type="email"
                    id="email"
                    name="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="you@example.com"
                    aria-invalid={credentialError}
                    aria-describedby={credentialError ? feedbackId : undefined}
                    className="w-full px-3.5 py-2.5 bg-input-bg border border-input-border rounded-xl text-sm text-on-surface placeholder-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/20 transition-all"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="password" className="block text-xs font-medium text-on-surface-secondary">
                      Password *
                    </label>
                    <button
                      type="button"
                      onClick={() => { setErrorMessage(""); setSuccessMessage(""); setOauthStatus(""); setForgotPasswordMode(true); }}
                      className="text-xs text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors cursor-pointer"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <PasswordInput
                    id="password"
                    name="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="Enter your password"
                    aria-invalid={credentialError}
                    aria-describedby={credentialError ? feedbackId : undefined}
                  />
                </div>

                <AuthButton
                  htmlType="submit"
                  disabled={!!loadingMethod}
                  loading={loadingMethod === "email"}
                  className="mt-2"
                >
                  {loadingMethod === "email" ? "Signing in..." : "Sign In"}
                </AuthButton>
              </form>

              {/* Divider */}
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-outline-subtle"></div>
                </div>
                <div className="relative flex justify-center">
                  <span className="px-3 bg-mkt-card dark:bg-surface text-[10px] text-on-surface-muted uppercase tracking-wider font-medium">or continue with</span>
                </div>
              </div>

              {/* OAuth buttons */}
              <div className="space-y-2.5">
                <button
                  type="button"
                  ref={(el) => { providerButtons.current.google = el; }}
                  onClick={() => handleOAuthLogin("google")}
                  disabled={!!loadingMethod}
                  aria-busy={loadingMethod === "google"}
                  className="w-full flex items-center justify-center gap-2.5 py-2.5 px-4 rounded-xl text-sm font-medium text-on-surface bg-surface border border-outline hover:bg-surface-hover hover:border-on-surface-muted transition-all active:scale-[0.985] motion-reduce:active:scale-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {loadingMethod === "google" ? (
                    <Spinner size={16} className="text-on-surface-muted" />
                  ) : (
                    <Image
                      src="/img/google-logo.png"
                      alt=""
                      width={18}
                      height={18}
                      priority
                    />
                  )}
                  {loadingMethod === "google" ? "Signing in..." : "Google"}
                </button>

                <button
                  type="button"
                  ref={(el) => { providerButtons.current.microsoft = el; }}
                  onClick={() => handleOAuthLogin("microsoft")}
                  disabled={!!loadingMethod}
                  aria-busy={loadingMethod === "microsoft"}
                  className="w-full flex items-center justify-center gap-2.5 py-2.5 px-4 rounded-xl text-sm font-medium text-on-surface bg-surface border border-outline hover:bg-surface-hover hover:border-on-surface-muted transition-all active:scale-[0.985] motion-reduce:active:scale-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
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
                  {loadingMethod === "microsoft" ? "Signing in..." : "Microsoft"}
                </button>
              </div>
            </>
          ) : (
            <>
              <form ref={formRef} onSubmit={handleForgotPassword} className="space-y-4">
                <div>
                  <FieldLabel htmlFor="email" size="xs" tone="secondary" gap="1.5">
                    Email *
                  </FieldLabel>
                  <input
                    type="email"
                    id="email"
                    name="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="you@example.com"
                    aria-invalid={invalidField === "email"}
                    aria-describedby={errorMessage ? feedbackId : undefined}
                    className="w-full px-3.5 py-2.5 bg-input-bg border border-input-border rounded-xl text-sm text-on-surface placeholder-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/20 transition-all"
                  />
                </div>

                <AuthButton
                  htmlType="submit"
                  disabled={!!loadingMethod}
                  loading={loadingMethod === "forgot"}
                >
                  {loadingMethod === "forgot" ? "Sending..." : "Send Reset Email"}
                </AuthButton>
              </form>

              <div className="mt-5 text-center">
                <button
                  onClick={() => { setErrorMessage(""); setOauthStatus(""); setForgotPasswordMode(false); }}
                  className="text-xs text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors cursor-pointer"
                >
                  Back to sign in
                </button>
              </div>
            </>
          )}
        </div>

        {/* Footer link */}
        <p className="mt-6 text-center text-xs text-on-surface-muted">
          Don&apos;t have an account?{" "}
          <button
            onClick={() => { setNavigating(true); router.push('/register'); }}
            className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors cursor-pointer"
          >
            Sign up
          </button>
        </p>
      </div>
    </MarketingTransition>
  );
};

const Login = () => (
  <Suspense fallback={<LoadingSpinner fullPage />}>
    <LoginForm />
  </Suspense>
);

export default Login;
