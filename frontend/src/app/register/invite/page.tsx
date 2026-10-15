'use client';

import ErrorNotification from "@/components/ErrorNotification";
import LoadingSpinner from "@/components/LoadingSpinner";
import AuthButton from "@/components/ui/AuthButton";
import FieldLabel from "@/components/ui/FieldLabel";
import InvalidLinkPage from "@/components/ui/InvalidLinkPage";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import PasswordInput from "@/components/ui/PasswordInput";
import SignupConsent from '@/components/ui/SignupConsent';
import Spinner from "@/components/ui/Spinner";
import useInvitationCredentials from "@/hooks/invitationHooks/useInvitationCredentials";
import { useAuth } from "@/hooks/useAuth";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { publicFetch } from "@/lib/utils/fetchWithTokenRefresh";
import Image from "next/image";
import { useRouter,useSearchParams } from "next/navigation";
import { Suspense,useEffect,useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

function InviteRegistrationContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();

  const token = searchParams.get('token');

  const [invitation, setInvitation] = useState<{
    lawFirmId: string;
    lawFirmName: string;
    email: string;
  } | null>(null);
  const [tokenLoading, setTokenLoading] = useState(true);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const { formData, setFormData, errorMessage, setErrorMessage, invalidField, formRef, feedbackRef, feedbackId, loadingMethod, handleChange, handleSubmit, handleGoogleSignup, handleMicrosoftSignup } = useInvitationCredentials({
    userType: "client",
    onWhitelisted: () => router.replace('/client/dashboard'),
    onVerificationRequired: () => router.replace("/verify-email"),
    onOAuthRegistered: () => router.push(token ? `/accept-invite?token=${token}` : "/client/dashboard"),
    onOAuthExisting: () => router.push(token ? `/accept-invite?token=${token}` : "/client/dashboard"),
  });
  const [navigating, setNavigating] = useState(false);

  // Fetch invitation details on mount
  useEffect(() => {
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch effect: sets error/loading state from an async invitation fetch
      setTokenError('Invalid invitation link.');
      setTokenLoading(false);
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
        setFormData(prev => ({ ...prev, email: data.invitation.email }));
      } catch (err) {
        setTokenError(getErrorMessage(err, 'Failed to load invitation'));
      } finally {
        setTokenLoading(false);
      }
    };

    fetchInvitation();
  }, [token, router]);

  // If already logged in, redirect to accept-invite page
  useEffect(() => {
    if (!authLoading && user && token) {
      router.push(`/accept-invite?token=${token}`);
    }
  }, [user, authLoading, token, router]);

  if (authLoading || tokenLoading || navigating || user) {
    return <LoadingSpinner fullPage />;
  }

  // Token error, show fallback
  if (tokenError) {
    return (
      <InvalidLinkPage
        title="This client invitation cannot be used"
        description={tokenError}
        primaryAction={{
          label: "Register anyway",
          onClick: () => {
            setNavigating(true);
            router.push('/register');
          },
        }}
        secondaryAction={{
          label: "Go to login",
          onClick: () => {
            setNavigating(true);
            router.push('/login');
          },
        }}
      />
    );
  }

  const firmName = invitation?.lawFirmName || 'the law firm';

  return (
    <main className="min-h-screen bg-page flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        {/* Card */}
        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8">
          {/* Logo */}
          <div className="flex justify-center mb-8">
            <ParalegixLogo
              width={280}
              height={80}
              priority
            />
          </div>

          <h1 className="text-xl font-bold text-center text-on-surface mb-1">You&apos;ve been invited</h1>
          <p className="text-xs text-on-surface-muted text-center mb-7">
            <span className="font-semibold text-on-surface-secondary">{firmName}</span> has invited you to join their client portal on Paralegix
          </p>

          {/* Error */}
          <div id={feedbackId} ref={feedbackRef} tabIndex={-1}>
            <ErrorNotification
              error={errorMessage}
              onClose={() => setErrorMessage("")}
              className="mb-5"
            />
          </div>

          <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
            <div>
              <FieldLabel htmlFor="name" size="xs" tone="secondary" gap="1.5">
                Full Name *
              </FieldLabel>
              <input
                type="text"
                id="name"
                name="name"
                value={formData.name}
                onChange={handleChange}
                required
                placeholder="John Doe"
                className="w-full px-3.5 py-2.5 bg-input-bg border border-input-border rounded-xl text-sm text-on-surface placeholder-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/20 transition-all"
              />
            </div>

            <div>
              <FieldLabel htmlFor="email" size="xs" tone="secondary" gap="1.5">
                Email
              </FieldLabel>
              <input
                type="email"
                id="email"
                name="email"
                value={formData.email}
                readOnly
                className="w-full px-3.5 py-2.5 bg-surface-alt border border-input-border rounded-xl text-sm text-on-surface-secondary cursor-not-allowed focus:outline-none"
              />
            </div>

            <div className="space-y-3">
              <div>
                <FieldLabel htmlFor="password" size="xs" tone="secondary" gap="1.5">
                  Password *
                </FieldLabel>
                <PasswordInput
                  id="password"
                  name="password"
                  aria-invalid={invalidField === "password"}
                  aria-describedby={invalidField === "password" ? feedbackId : undefined}
                  value={formData.password}
                  onChange={handleChange}
                  required
                  placeholder="Min 6 characters"
                />
              </div>

              <div>
                <FieldLabel htmlFor="confirmPassword" size="xs" tone="secondary" gap="1.5">
                  Confirm Password *
                </FieldLabel>
                <PasswordInput
                  id="confirmPassword"
                  name="confirmPassword"
                  aria-invalid={invalidField === "confirmPassword"}
                  aria-describedby={invalidField === "confirmPassword" ? feedbackId : undefined}
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  required
                  placeholder="Confirm password"
                />
              </div>
            </div>

            <AuthButton
              htmlType="submit"
              disabled={!!loadingMethod}
              loading={loadingMethod === "email"}
              className="mt-2"
            >
              {loadingMethod === "email" ? "Creating Account..." : "Create Client Account"}
            </AuthButton>
          </form>

          {/* Divider */}
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-outline-subtle"></div>
            </div>
            <div className="relative flex justify-center">
              <span className="px-3 bg-surface text-[10px] text-on-surface-muted uppercase tracking-wider font-medium">or continue with</span>
            </div>
          </div>

          {/* OAuth buttons */}
          <div className="grid grid-cols-2 gap-2.5">
            <button
              onClick={handleGoogleSignup}
              disabled={!!loadingMethod}
              className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-medium text-on-surface bg-surface border border-outline hover:bg-surface-hover hover:border-on-surface-muted transition-all duration-100 active:scale-[0.985] motion-reduce:active:scale-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {loadingMethod === "google" ? (
                <Spinner size={16} className="text-on-surface-muted" />
              ) : (
                <Image
                  src="/img/google-logo.png"
                  alt="Google"
                  width={16}
                  height={16}
                  priority
                />
              )}
              Google
            </button>

            <button
              onClick={handleMicrosoftSignup}
              disabled={!!loadingMethod}
              className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-medium text-on-surface bg-surface border border-outline hover:bg-surface-hover hover:border-on-surface-muted transition-all duration-100 active:scale-[0.985] motion-reduce:active:scale-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {loadingMethod === "microsoft" ? (
                <Spinner size={16} className="text-on-surface-muted" />
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24">
                  <path d="M11.4 24H0V12.6h11.4V24z" fill="#00A4EF"/>
                  <path d="M24 24H12.6V12.6H24V24z" fill="#FFB900"/>
                  <path d="M11.4 11.4H0V0h11.4v11.4z" fill="#F25022"/>
                  <path d="M24 11.4H12.6V0H24v11.4z" fill="#7FBA00"/>
                </svg>
              )}
              Microsoft
            </button>
          </div>

          <p className="mt-5 text-center text-[10px] text-on-surface-muted">
            You&apos;ll be registered as a client of <span className="font-medium">{firmName}</span>.
          </p>

          <SignupConsent
            className="mt-4"
            onNavigate={(path) => { setNavigating(true); router.push(path); }}
          />
        </div>

        {/* Footer link */}
        <p className="mt-6 text-center text-xs text-on-surface-muted">
          Already have an account?{" "}
          <button
            onClick={() => { setNavigating(true); router.push(`/login?redirect=${encodeURIComponent(`/accept-invite?token=${token}`)}`); }}
            className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors cursor-pointer"
          >
            Sign in
          </button>
        </p>
      </div>
    </main>
  );
}

export default function InviteRegistrationPage() {
  return (
    <Suspense fallback={<LoadingSpinner fullPage />}>
      <InviteRegistrationContent />
    </Suspense>
  );
}
