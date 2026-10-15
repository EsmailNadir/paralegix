"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import SidebarNav from "@/components/sidebar/LawfirmSidebar";
import NotificationToaster from "@/components/notificationComp/NotificationToaster";
import lawfirmService from "@/services/lawfirm.service";
import userService from "@/services/users.service";
import LoadingSpinner from "@/components/LoadingSpinner";
import { isEmailVerified } from "@/lib/utils/emailVerification";
import { NavigationContext } from "@/contexts/NavigationContext";
import { PreferencesProvider } from "@/contexts/PreferencesContext";
import { PermissionsProvider } from "@/contexts/PermissionsContext";
import { FirmSettingsProvider } from "@/contexts/FirmSettingsContext";
import { BillingTimerProvider } from "@/contexts/BillingTimerContext";
import { FileExportProvider } from "@/contexts/FileExportContext";
import { FileUploadProvider } from "@/contexts/FileUploadContext";
import { LawFirmContext } from "@/contexts/LawFirmContext";
import { ProfileContext } from "@/contexts/ProfileContext";
import { AppShellContext } from "@/contexts/AppShellContext";
import ThemeApplier from "@/components/providers/ThemeApplier";
import ConnectionUnavailable from "@/components/ui/ConnectionUnavailable";
import MaintenancePage from "@/components/ui/MaintenancePage";
import ResourceNotFoundPage from "@/components/ui/ResourceNotFoundPage";
import AccessDeniedPage from "@/components/ui/AccessDeniedPage";
import UnexpectedErrorPage from "@/components/ui/UnexpectedErrorPage";
import GoogleCalendarReconnectBanner from "@/components/GoogleCalendarReconnectBanner";
import OutlookCalendarReconnectBanner from "@/components/OutlookCalendarReconnectBanner";
import PendingMemberInviteBanner from "@/components/PendingMemberInviteBanner";
import CalendarConnectOutcomeToast from "@/components/calendarComp/CalendarConnectOutcomeToast";
import { useCalendarBackgroundSync } from "@/hooks/useCalendarBackgroundSync";
import { CalendarSyncContext } from "@/contexts/CalendarSyncContext";
import { resolveFirmFeatures } from "@/lib/plans/featureAccess";
import { API_UNREACHABLE_MESSAGE } from "@/lib/utils/fetchWithTokenRefresh";
import { isApiError } from "@/lib/utils/apiErrors";
import { isColdStartError } from "@/lib/utils/coldStartRetry";
import { createLawFirmQueryClient, markQueriesStaleOnApiWrite } from "@/lib/query/lawFirmQueryClient";
import subscriptionService from "@/services/subscription.service";
import { isBillingActive, isBillingLocked } from "@/lib/plans/billingAccess";
import { onBillingLock } from "@/lib/plans/billingLockSignal";
import BillingLockScreen from "@/components/billingComp/BillingLockScreen";

import type { LawFirm, User } from "@/types";
import useAnalyticsContext from "@/hooks/useAnalyticsContext";
import type { BillingStatus, SubscriptionStatus } from "@/types/subscription";

/**
 * How long the blocking navigation overlay may stay up before it gives up and
 * hands the page back. Well past a normal client-side route change, so it never
 * cuts a slow-but-working navigation short.
 */
const NAVIGATION_OVERLAY_TIMEOUT_MS = 8000;

// Mounted inside FirmSettingsProvider so it can read calendarSync feature flag.
// Single mount per law-firm session, the SOLE calendar sync engine. It exposes
// live sync status to the calendar UI (deep in `children`) via CalendarSyncContext,
// so the calendar no longer runs its own duplicate sync.
function CalendarBackgroundSyncMount({
  lawFirmId,
  children,
}: {
  lawFirmId: string | undefined;
  children: React.ReactNode;
}) {
  const status = useCalendarBackgroundSync(lawFirmId);
  return <CalendarSyncContext value={status}>{children}</CalendarSyncContext>;
}

const LawFirmLayout = ({ children }: { children: React.ReactNode }) => {
  const params = useParams();
  const router = useRouter();
  const { user, loading } = useAuth();
  const id = Array.isArray(params.lawFirmId) ? params.lawFirmId[0] : params.lawFirmId;
  const pathname = usePathname();

  // Created per component instance rather than at module scope. A module-level
  // client is instantiated once per server process and shared by every render
  // that process handles, so anything cached into it during a server render
  // would be served to the next user. The lazy initializer keeps exactly one
  // client for the life of this layout. See `createLawFirmQueryClient` for why
  // results stay fresh for two minutes and focus does not refetch.
  const [queryClient] = useState(createLawFirmQueryClient);

  // Any successful write marks the cache stale, so a page remounted after the
  // user's own edit re-reads instead of serving the pre-edit result.
  useEffect(() => markQueriesStaleOnApiWrite(queryClient), [queryClient]);

  const [lawFirm, setLawFirm] = useState<LawFirm | null>(null);
  const [lawFirmLoading, setLawFirmLoading] = useState(true);
  const [lawFirmError, setLawFirmError] = useState<unknown>(null);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [retryingConnection, setRetryingConnection] = useState(false);
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null);
  const [trialEndsAt, setTrialEndsAt] = useState<string | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);
  const [subscriptionStatusLoaded, setSubscriptionStatusLoaded] = useState(false);
  // Set when a firm request comes back 402 (see `billingLockSignal`). It is how a
  // status that went stale mid-session reaches the paywall: without it the client
  // keeps rendering a workspace the backend has already closed, and every page
  // inside it reports the same 402 as its own error banner.
  const [apiBillingLock, setApiBillingLock] = useState<{ billingStatus: string | null } | null>(null);
  const [checkingType, setCheckingType] = useState(true);
  const [profile, setProfile] = useState<User | null>(null);
  // Only ever true for a firm-scoped page loaded inside another page's iframe
  // (e.g. NotePrintPreviewModal) - the sidebar, banners, and toaster belong to
  // the top-level app shell, not to a document preview nested inside it.
  const [isEmbedded, setIsEmbedded] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window.top is only knowable client-side, after mount
    if (typeof window !== 'undefined' && window.self !== window.top) setIsEmbedded(true);
  }, []);

  const navigate = useCallback((href: string) => {
    // The overlay below is cleared by a pathname change, so only raise it when
    // the pathname is actually going to change. A push that alters only the
    // query string (a `?tab=` jump onto the page you are already on) leaves
    // `pathname` untouched and would strand the overlay.
    if (href.split(/[?#]/)[0] !== pathname) setPendingHref(href);
    router.push(href);
  }, [router, pathname]);

  const navContextValue = useMemo(() => ({ navigate }), [navigate]);

  // A confirmed calendar connect changes what the background sync and the
  // get-started checklist read, and neither refetches on focus.
  const refreshCalendarConnection = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["userSyncSettings", id] });
    void queryClient.invalidateQueries({ queryKey: ["getStartedProgress", id, "calendar"] });
  }, [queryClient, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the pending navigation target once the route (pathname) changes
    setPendingHref(null);
  }, [pathname]);

  // Backstop for a navigation that never commits - an aborted route transition,
  // a failed chunk fetch. The overlay blocks the whole page, so leaving it up
  // indefinitely is worse than dropping it and letting the user click again.
  useEffect(() => {
    if (!pendingHref) return;
    const timer = setTimeout(() => setPendingHref(null), NAVIGATION_OVERLAY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingHref]);

  useEffect(() => {
    if (!loading && !user) {
      // Deep links from notification email are opened without a live session far
      // more often than in-app navigation. Dropping the destination lands every
      // one of them on the dashboard instead of the thing the email was about.
      const search = typeof window !== 'undefined' ? window.location.search : '';
      const next = `${pathname || ''}${search}`;
      router.push(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
    } else if (!loading && user && !isEmailVerified(user)) {
      router.push("/verify-email");
    }
  }, [user, loading, router, pathname]);

  // Verify this user is actually a firm member before mounting the firm shell.
  // The backend fails closed (clients hold no membership, so every firm-scoped
  // request 403s and PermissionsProvider resolves an empty permission set), but
  // without this a logged-in client visiting a /lawfirm/[id] URL would still see
  // the firm chrome. Mirror the client layout's symmetric userType guard.
  useEffect(() => {
    if (loading || !user || !isEmailVerified(user)) return;

    let active = true;
    const verifyMemberType = async () => {
      try {
        const profile = await userService.getProfile();
        const userType = profile?.userType;
        if (!active) return;

        // Share the already-fetched profile with the sidebar avatar and settings
        // pages via ProfileContext so they don't each re-request /users/profile.
        setProfile(profile);

        if (!userType || userType === 'pending') {
          router.replace('/complete-registration');
          return;
        }
        if (userType === 'client') {
          router.replace('/client/dashboard');
          return;
        }
        setCheckingType(false);
      } catch (error) {
        console.error('LawFirmLayout - failed to verify user type:', error);
        // Don't hard-block the firm member on a transient profile-fetch failure;
        // the backend still enforces membership on every request.
        if (active) setCheckingType(false);
      }
    };

    verifyMemberType();
    return () => {
      active = false;
    };
  }, [user, loading, router]);

  useEffect(() => {
    if (!id || loading || !user) return;

    const fetchLawFirm = async () => {
      // Only show spinner if we have no existing firm data.
      // Avoids unmounting children (QueryClientProvider etc.) on background re-fetches.
      setLawFirmLoading(true);
      try {
        setLawFirmError(null);
        // The workspace variant: waits out a container boot and retries once if
        // it still fails that way. Without it, a cold start becomes the full-page
        // connection error below, which the user clears by pressing a button that
        // repeats this exact request.
        const firm = await lawfirmService.getLawFirmForWorkspace(id as string);
        setLawFirm(firm);
      } catch (error) {
        console.error("Error fetching law firm:", error);
        setLawFirmError(error);
        setLawFirm(null);
      } finally {
        setLawFirmLoading(false);
      }
    };

    fetchLawFirm();
  }, [id, loading, user]);

  // Resolve billing status for the paywall. The subscription status endpoint is
  // exempt from the billing gate, so it always answers; it's the authoritative
  // source for both billingStatus and trialEndsAt.
  //
  // The firm's plan jsonb is the fallback when this fails, and that fallback is
  // applied in `effectiveBillingStatus` below rather than here. Applying it here
  // meant reading `lawFirm.plan`, which meant listing it as a dependency, which
  // ran this whole effect a second time the moment the firm record arrived: two
  // identical status requests on the critical path of every workspace open. The
  // render-level `??` chain reaches the same answer from state this effect
  // never has to see.
  useEffect(() => {
    if (!id || loading || !user) return;
    let active = true;

    const resolveBilling = async () => {
      try {
        const status = await subscriptionService.getStatus(id as string);
        if (!active) return;
        setSubscriptionStatus(status);
        setBillingStatus(status.billingStatus ?? null);
        setTrialEndsAt(status.trialEndsAt ?? null);
        // A fresh status that grants access clears a lock a stale 402 raised, so
        // paying in another tab does not leave this one behind the paywall.
        if (isBillingActive(status)) setApiBillingLock(null);
      } catch {
        // Leave both values null so the plan jsonb below supplies them.
      } finally {
        if (active) setSubscriptionStatusLoaded(true);
      }
    };

    resolveBilling();
    return () => {
      active = false;
    };
  }, [id, loading, user]);

  // Any 402 for THIS firm locks the workspace. A signal with no firm id in its
  // URL is accepted too: 402 is only ever BILLING_INACTIVE, and the only firm a
  // request from inside this layout can be refused for is this one.
  useEffect(() => {
    return onBillingLock((signal) => {
      if (signal.lawFirmId && signal.lawFirmId !== id) return;
      setApiBillingLock({ billingStatus: signal.billingStatus });
    });
  }, [id]);

  const lawFirmErrorMessage =
    lawFirmError instanceof Error
      ? lawFirmError.message
      : lawFirmError
        ? String(lawFirmError)
        : null;
  // A timeout and an unreachable server are the same thing to the user: the app
  // could not get an answer from the backend, and the useful response is a retry
  // button. Left out of this branch, a timeout falls through to the "we couldn't
  // find this law firm" screen, which is both wrong and alarming.
  // One definition of the shape, shared with the retry above: a screen that
  // retries a failure and a screen that reports it must agree on which failures
  // those are, or the retry runs on errors the page then renders differently.
  const isConnectionError = isApiError(lawFirmError)
    ? isColdStartError(lawFirmError)
    : lawFirmErrorMessage?.includes(API_UNREACHABLE_MESSAGE) ?? false;
  const isMaintenanceError = isApiError(lawFirmError)
    ? lawFirmError.isMaintenanceMode
    : lawFirmErrorMessage?.toLowerCase().includes("maintenance mode") ?? false;
  const isNotFoundError = isApiError(lawFirmError)
    ? lawFirmError.status === 404
    : lawFirmErrorMessage?.toLowerCase().includes("not found") ?? false;
  // The membership middleware answers 403 for a firm the user can see the id of
  // but does not belong to - a permission answer, not a failure to load.
  const isForbiddenError = isApiError(lawFirmError) && lawFirmError.status === 403;

  const refetchLawFirm = useCallback(async () => {
    if (!id) return;
    try {
      const firm = await lawfirmService.getLawFirmById(id as string);
      setLawFirm(firm);
    } catch (error) {
      console.error("Error fetching law firm:", error);
    }
  }, [id]);

  const handleRetryConnection = useCallback(async () => {
    if (!id) return;
    setRetryingConnection(true);
    setLawFirmError(null);
    try {
      const firm = await lawfirmService.getLawFirmForWorkspace(id as string);
      setLawFirm(firm);
    } catch (error) {
      console.error("Error fetching law firm:", error);
      setLawFirmError(error);
    } finally {
      setLawFirmLoading(false);
      setRetryingConnection(false);
    }
  }, [id]);

  // Effective status prefers the exempt subscription endpoint, then the firm
  // plan jsonb. comped/unlimitedOverride on the plan always grant access.
  const effectiveBillingStatus = billingStatus ?? lawFirm?.plan?.billingStatus ?? null;
  const lockedByStatus = isBillingLocked({
    billingStatus: effectiveBillingStatus,
    comped: lawFirm?.plan?.comped,
    unlimitedOverride: lawFirm?.plan?.unlimitedOverride,
    trialEndsAt: trialEndsAt ?? lawFirm?.plan?.trialEndsAt ?? null,
    stripeSubscriptionId:
      subscriptionStatus?.stripeSubscriptionId ?? lawFirm?.plan?.stripeSubscriptionId ?? null,
  });
  const billingLocked = lockedByStatus || apiBillingLock !== null;
  // When only the API knows we are locked, the status it reported is the accurate
  // one; the local copy is the stale value that let the workspace render.
  const lockScreenStatus = lockedByStatus
    ? effectiveBillingStatus
    : apiBillingLock?.billingStatus ?? effectiveBillingStatus;
  // Owners must still reach the billing settings page while locked so they can pay.
  const onBillingSettings = pathname?.endsWith("/settings/billing") ?? false;
  const showLockScreen = billingLocked && !onBillingSettings;

  const lawFirmContextValue = useMemo(
    () => ({ lawFirm, refetchLawFirm, subscriptionStatus, subscriptionStatusLoaded }),
    [lawFirm, refetchLawFirm, subscriptionStatus, subscriptionStatusLoaded],
  );
  const profileContextValue = useMemo(() => ({ profile }), [profile]);
  useAnalyticsContext("firm_member", id ?? null);
  // Seeds FirmSettingsContext, which treats this as the source of truth and
  // skips its own GET. So `features` here must be the RESOLVED answer, not the
  // plan's: the firm's own opt-out lives in `lawFirm.settings.features` and is
  // what `resolveFirmFeatures` layers on top. Seeding raw plan features instead
  // left the sidebar, the matter billing tab and the invoice payment form
  // offering a feature the firm had switched off, while every route 403'd.
  const initialFirmSettings = useMemo(() => {
    if (!lawFirm) return undefined;
    return {
      ...(lawFirm.settings || {}),
      features: resolveFirmFeatures(lawFirm.plan, lawFirm.settings),
    };
  }, [lawFirm]);

  if (lawFirmLoading || loading || !user || checkingType) {
    return (
      <LoadingSpinner fullPage />
    );
  }

  if (!lawFirm) {
    if (isMaintenanceError) {
      return (
        <MaintenancePage
          onRetry={handleRetryConnection}
          isRetrying={retryingConnection}
        />
      );
    }
    if (isConnectionError) {
      return (
        <ConnectionUnavailable
          onRetry={handleRetryConnection}
          isRetrying={retryingConnection}
        />
      );
    }
    if (isForbiddenError) {
      return (
        <AccessDeniedPage
          title="You do not have access to this firm"
          description="Your account is not a member of this workspace. Ask a firm admin to invite you."
        />
      );
    }
    if (!lawFirmError || isNotFoundError) {
      return (
        <ResourceNotFoundPage
          resourceLabel="law firm"
          title="We couldn't find this law firm"
          description="The workspace may have been removed, or your access to it may have changed."
        />
      );
    }
    return (
      <UnexpectedErrorPage
        title="We couldn't open this law firm"
        description="The workspace shell loaded, but the firm record itself did not come back cleanly."
        onRetry={handleRetryConnection}
        retrying={retryingConnection}
        details={lawFirmErrorMessage || undefined}
      />
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <NavigationContext value={navContextValue}>
        <ProfileContext value={profileContextValue}>
        <LawFirmContext value={lawFirmContextValue}>
          <PermissionsProvider lawFirmId={id as string} userId={user?.uid}>
            <FirmSettingsProvider lawFirmId={id as string} initialSettings={initialFirmSettings}>
              <PreferencesProvider lawFirmId={id as string}>
                <BillingTimerProvider lawFirmId={id as string}>
                 <FileExportProvider>
                 <FileUploadProvider>
                  <CalendarBackgroundSyncMount lawFirmId={id as string}>
                    <ThemeApplier />
                    {isEmbedded ? (
                      <main id="main-content" className="w-full min-w-0 relative">
                        <AppShellContext value={true}>{children}</AppShellContext>
                      </main>
                    ) : (
                      <>
                        <NotificationToaster lawFirmId={id as string} />
                        <GoogleCalendarReconnectBanner />
                        <OutlookCalendarReconnectBanner />
                        <PendingMemberInviteBanner />
                        <CalendarConnectOutcomeToast lawFirmId={id as string} onConnected={refreshCalendarConnection} />
                        <div className="flex min-w-0">
                          <a href="#main-content" className="skip-link">Skip to main content</a>
                          <SidebarNav
                            pendingHref={pendingHref}
                            onNavigate={setPendingHref}
                            billingStatus={effectiveBillingStatus}
                            trialEndsAt={trialEndsAt}
                          />
                          <main id="main-content" className="w-full min-w-0 md:pl-[220px] print:pl-0 relative pt-14 md:pt-0">
                            <AppShellContext value={true}>
                              {showLockScreen ? (
                                <BillingLockScreen
                                  lawFirmId={id as string}
                                  billingStatus={lockScreenStatus}
                                  firmName={lawFirm.name}
                                  planName={subscriptionStatus?.planName}
                                  trialEndsAt={trialEndsAt}
                                  currentPeriodEnd={subscriptionStatus?.currentPeriodEnd}
                                  owner={subscriptionStatus?.owner}
                                />
                              ) : children}
                            </AppShellContext>
                            {pendingHref && (
                              <div className="fixed inset-0 bg-page/80 flex items-center justify-center z-30 md:pl-[220px] pt-14 md:pt-0">
                                <LoadingSpinner />
                              </div>
                            )}
                          </main>
                        </div>
                      </>
                    )}
                  </CalendarBackgroundSyncMount>
                 </FileUploadProvider>
                 </FileExportProvider>
                </BillingTimerProvider>
              </PreferencesProvider>
            </FirmSettingsProvider>
          </PermissionsProvider>
        </LawFirmContext>
        </ProfileContext>
      </NavigationContext>
    </QueryClientProvider>
  );
};

export default LawFirmLayout;
