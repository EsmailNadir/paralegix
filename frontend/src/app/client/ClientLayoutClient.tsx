"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import userService from "@/services/users.service";
import LoadingSpinner from "@/components/LoadingSpinner";
import { isEmailVerified } from "@/lib/utils/emailVerification";
import ClientSidebar from "@/components/sidebar/ClientSidebar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NavigationContext } from "@/contexts/NavigationContext";
import clientPortalService from "@/services/client-portal.service";
import { DEFAULT_FIRM_FEATURES, type FirmFeatures } from "@/types/preferences";
import { ProfileContext } from "@/contexts/ProfileContext";
import { ClientPortalContext, type ClientPortalFirm, type ClientPortalAssociation } from "@/contexts/ClientPortalContext";
import { AppShellContext } from "@/contexts/AppShellContext";
import { shouldRetryQuery } from "@/lib/query/retryPolicy";
import type { User } from "@/types";
import useAnalyticsContext from "@/hooks/useAnalyticsContext";
import SkipLink from "@/components/ui/SkipLink";

// The client's chosen active client-record association is remembered per firm
// (a uid's associations - and which one they last picked - are meaningless
// outside the firm they belong to), the same way the active firm itself is
// remembered under 'paralegix-client-lawfirm'.
const activeClientRecordStorageKey = (lawFirmId: string) => `paralegix-client-active-record:${lawFirmId}`;

/**
 * How long the blocking navigation overlay may stay up before it gives up and
 * hands the page back. Well past a normal client-side route change, so it never
 * cuts a slow-but-working navigation short.
 */
const NAVIGATION_OVERLAY_TIMEOUT_MS = 8000;

export default function ClientLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const previousPathname = useRef(pathname);

  // Created per component instance rather than at module scope. A module-level
  // client is instantiated once per server process and shared by every render
  // that process handles, so anything cached into it during a server render
  // would be served to the next user. The lazy initializer keeps exactly one
  // client for the life of this layout.
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetryQuery,
      },
    },
  }));

  const [checkingType, setCheckingType] = useState(true);
  const [isVerifiedClient, setIsVerifiedClient] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [firmFeatures, setFirmFeatures] = useState<FirmFeatures>(DEFAULT_FIRM_FEATURES);
  const [featuresLoaded, setFeaturesLoaded] = useState(false);
  const [lawFirms, setLawFirms] = useState<ClientPortalFirm[]>([]);
  const [profile, setProfile] = useState<User | null>(null);

  // Every client-record association the portal uid holds in the CURRENTLY
  // VIEWED firm (organization-clients plan, Phase 5), resolved once here so
  // pages under /client/lawfirm/[lawFirmId] don't each re-request
  // /associations. The chosen active one drives every clientRecordId-aware
  // portal call.
  const [associations, setAssociations] = useState<ClientPortalAssociation[]>([]);
  const [associationsLoading, setAssociationsLoading] = useState(true);
  const [activeClientRecordId, setActiveClientRecordIdState] = useState<string | null>(null);

  // Extract lawFirmId from URL or messages path, persist in localStorage
  const lawFirmIdFromUrl = (() => {
    const lawFirmMatch = pathname.match(/^\/client\/lawfirm\/([^/]+)/);
    if (lawFirmMatch) return lawFirmMatch[1];
    const messagesMatch = pathname.match(/^\/client\/messages\/([^/]+)/);
    if (messagesMatch) return messagesMatch[1];
    return undefined;
  })();

  // Read the persisted firm synchronously on first render so the sidebar can
  // render every nav item at once instead of popping the firm-scoped links in
  // after a post-mount effect runs.
  const [storedLawFirmId, setStoredLawFirmId] = useState<string | undefined>(() => {
    if (typeof window === 'undefined') return undefined;
    return localStorage.getItem('paralegix-client-lawfirm') || undefined;
  });

  useEffect(() => {
    if (lawFirmIdFromUrl) {
      localStorage.setItem('paralegix-client-lawfirm', lawFirmIdFromUrl);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs state from localStorage / URL (browser-only external source)
      setStoredLawFirmId(lawFirmIdFromUrl);
    }
  }, [lawFirmIdFromUrl]);

  const lawFirmId = lawFirmIdFromUrl || storedLawFirmId;

  // Analytics is filed under a firm only once the server has confirmed this
  // client belongs to it. The stored id can be a previous client's on a shared
  // browser, and a URL can name a firm the client was removed from.
  const [analyticsFirmId, setAnalyticsFirmId] = useState<string | null>(null);
  useAnalyticsContext("client", analyticsFirmId);

  useEffect(() => {
    let mounted = true;
    const loadFirmFeatures = async () => {
      setAnalyticsFirmId(null);
      if (!user) {
        if (mounted) setFirmFeatures(DEFAULT_FIRM_FEATURES);
        return;
      }

      try {
        const response = await clientPortalService.getMyLawFirms();
        if (!mounted) return;
        const firms = response.lawFirms || [];
        setLawFirms(
          firms.map((f) => ({
            id: f.id,
            name: f.name,
            logoUrl: f.logoUrl ?? null,
            address: f.address ?? null,
            city: f.city ?? null,
            state: f.state ?? null,
            zip: f.zip ?? null,
          })),
        );

        // A client with no firm association (their firm was deleted, the firm
        // removed them, or they registered before being invited) has nothing to
        // scope the portal to. Forget any firm remembered from before, so the
        // sidebar stops offering firm-scoped links the backend now rejects.
        // Resolved here rather than by returning early, because a firm id still
        // present in the URL would leave `lawFirmId` unchanged and this effect
        // would never re-run to finish loading.
        if (firms.length === 0) {
          localStorage.removeItem('paralegix-client-lawfirm');
          setStoredLawFirmId(undefined);
          setFirmFeatures(DEFAULT_FIRM_FEATURES);
          setFeaturesLoaded(true);
          return;
        }

        // Honour the requested firm only when the client belongs to it; a firm
        // they've been removed from (or never had) falls back to their first.
        // Resolved in one pass rather than by correcting storage and waiting for
        // a re-run: when the stale id comes from the URL, `lawFirmId` doesn't
        // change, so the re-run never happens and the portal would sit on the
        // "Verifying access..." spinner forever.
        const effectiveId = lawFirmId && firms.some((f) => f.id === lawFirmId)
          ? lawFirmId
          : firms[0].id;
        localStorage.setItem('paralegix-client-lawfirm', effectiveId);
        setStoredLawFirmId(effectiveId);
        setAnalyticsFirmId(effectiveId);

        const firm = firms.find((f) => f.id === effectiveId);
        setFirmFeatures({
          ...DEFAULT_FIRM_FEATURES,
          ...(firm?.features || {}),
        });
        setFeaturesLoaded(true);
      } catch {
        if (!mounted) return;
        setFirmFeatures(DEFAULT_FIRM_FEATURES);
        setFeaturesLoaded(true);
      }
    };

    loadFirmFeatures();
    return () => {
      mounted = false;
    };
  }, [lawFirmId, user]);

  // Resolve every client-record association this uid holds in the current
  // firm, then apply the portal selection contract client-side: a persisted
  // choice wins if it's still valid, otherwise auto-select when exactly one
  // association exists, otherwise leave it unresolved (selectionRequired below
  // picks that up so a page can render the picker instead of fetching).
  useEffect(() => {
    if (!lawFirmId || !user) {
      /* eslint-disable react-hooks/set-state-in-effect -- resets association state when the firm/user scope disappears (external source: route + auth) */
      setAssociations([]);
      setActiveClientRecordIdState(null);
      setAssociationsLoading(false);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }

    let mounted = true;
    setAssociationsLoading(true);

    clientPortalService.getAssociations(lawFirmId)
      .then((response) => {
        if (!mounted) return;
        const list = response.associations || [];
        setAssociations(list);

        // A ?clientRecordId= deep link (e.g. from a notification, once Phase 7
        // starts carrying one) wins over anything persisted, but only when it
        // actually names one of this uid's associations. Read straight off
        // `window.location` (a plain browser API) rather than
        // `useSearchParams()`: this layout wraps every /client/* route,
        // including ones that are otherwise statically generated, and that
        // hook forces the whole subtree into a Suspense-gated client-only
        // render just to serve a value only ever needed inside this effect.
        const fromDeepLink = typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('clientRecordId')
          : null;
        const persisted = typeof window !== 'undefined'
          ? window.localStorage.getItem(activeClientRecordStorageKey(lawFirmId))
          : null;

        let resolved: string | null = null;
        if (fromDeepLink && list.some((a) => a.clientRecordId === fromDeepLink)) {
          resolved = fromDeepLink;
        } else if (persisted && list.some((a) => a.clientRecordId === persisted)) {
          resolved = persisted;
        } else if (list.length === 1) {
          resolved = list[0].clientRecordId;
        }

        setActiveClientRecordIdState(resolved);
        if (typeof window !== 'undefined') {
          if (resolved) window.localStorage.setItem(activeClientRecordStorageKey(lawFirmId), resolved);
          else window.localStorage.removeItem(activeClientRecordStorageKey(lawFirmId));
        }
      })
      .catch(() => {
        if (!mounted) return;
        setAssociations([]);
        setActiveClientRecordIdState(null);
      })
      .finally(() => {
        if (mounted) setAssociationsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [lawFirmId, user]);

  // Switch the active client record for the current firm: persists the choice
  // and updates every consumer immediately. Pages depending on the resolved
  // clientRecordId re-fetch because it flows through their effect deps.
  const setActiveClientRecordId = useCallback((clientRecordId: string) => {
    if (!lawFirmId) return;
    setActiveClientRecordIdState(clientRecordId);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(activeClientRecordStorageKey(lawFirmId), clientRecordId);
    }
  }, [lawFirmId]);

  const activeAssociation = useMemo(
    () => associations.find((a) => a.clientRecordId === activeClientRecordId) || null,
    [associations, activeClientRecordId],
  );

  // The portal's CLIENT_SELECTION_REQUIRED state: resolution finished, more
  // than one association exists, and none is active yet.
  const selectionRequired = !associationsLoading && associations.length > 1 && !activeAssociation;

  const navigate = useCallback((href: string) => {
    // The overlay below is cleared by a pathname change, so only raise it when
    // the pathname is actually going to change. A push that alters only the
    // query string (a `?tab=` jump onto the page you are already on) leaves
    // `pathname` untouched and would strand the overlay.
    if (href.split(/[?#]/)[0] !== pathname) setPendingHref(href);
    router.push(href);
  }, [router, pathname]);

  // Switch the portal to a different firm the client belongs to: persist the
  // choice and jump to that firm's matters (the rest of the portal re-scopes off
  // the new lawFirmId).
  const switchFirm = useCallback((firmId: string) => {
    if (!firmId || firmId === lawFirmId) return;
    localStorage.setItem('paralegix-client-lawfirm', firmId);
    setStoredLawFirmId(firmId);
    navigate(`/client/lawfirm/${firmId}/matters`);
  }, [lawFirmId, navigate]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears pending navigation state on route change (driven by external pathname)
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
    // Don't do anything while auth is loading
    if (loading) return;

    // Not logged in - redirect to login
    if (!user) {
      // Deep links from client-portal notification email are opened without a
      // live session far more often than in-app navigation. Dropping the
      // destination lands every one of them on the dashboard instead of the
      // thing the email was about.
      const search = typeof window !== 'undefined' ? window.location.search : '';
      const next = `${pathname || ''}${search}`;
      router.push(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
      return;
    }

    // Email not verified - redirect to verification screen
    if (!isEmailVerified(user)) {
      router.push("/verify-email");
      return;
    }

    // Verify user is actually a client via the backend profile API.
    const verifyClientType = async () => {
      try {
        // Dynamic import to avoid SSR issues
        const { auth: firebaseAuth } = await import('@/lib/firebase/config');
        if (!firebaseAuth) {
          router.push('/login');
          return;
        }

        const currentFirebaseUser = firebaseAuth.currentUser;

        // Double-check we have a user
        if (!currentFirebaseUser) {
          router.push('/login');
          return;
        }

        const profile = await userService.getProfile();
        const userType = profile?.userType;

        // Share with ClientSidebar via ProfileContext so the footer avatar
        // doesn't issue a second /users/profile request.
        setProfile(profile);

        if (!userType || userType === 'pending') {
          router.replace('/complete-registration');
          return;
        }

        // If not a client, redirect to firm member dashboard
        if (userType !== 'client') {
          router.replace('/dashboard');
          return;
        }

        setIsVerifiedClient(true);

      } catch (error) {
        console.error('❌ ClientLayout - Failed to verify user type:', error);
        // On error, redirect to dashboard to be safe
        router.replace('/dashboard');
      } finally {
        setCheckingType(false);
      }
    };

    verifyClientType();
  }, [user, loading, router, pathname]);

  useEffect(() => {
    if (previousPathname.current === pathname || loading || checkingType || !featuresLoaded || !isVerifiedClient) return;
    const main = document.getElementById('main-content');
    if (main) {
      previousPathname.current = pathname;
      main.focus();
    }
  }, [pathname, loading, checkingType, featuresLoaded, isVerifiedClient]);

  // Show loading while auth is loading, while checking type, or until the
  // firm's features have resolved, so the sidebar mounts once with every nav
  // item present instead of popping the firm-scoped links in afterward.
  if (loading || checkingType || (user && !featuresLoaded)) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center">
        <div className="text-center">
          <LoadingSpinner />
          <p className="mt-4 text-on-surface-secondary text-sm">Verifying access...</p>
        </div>
      </div>
    );
  }

  // Not logged in
  if (!user) return null;

  // Not verified as client (shouldn't reach here, but safety check)
  if (!isVerifiedClient) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center">
        <div className="text-center">
          <LoadingSpinner />
          <p className="mt-4 text-on-surface-secondary text-sm">Redirecting...</p>
        </div>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ProfileContext value={{ profile }}>
      <ClientPortalContext
        value={{
          lawFirms,
          associations,
          associationsLoading,
          activeAssociation,
          selectionRequired,
          setActiveClientRecordId,
        }}
      >
      {/* Wraps the sidebar too, not only the page: its notification bell
          navigates through this context and gets a no-op outside it. */}
      <NavigationContext value={{ navigate }}>
      <div className="flex min-h-screen bg-page">
        <SkipLink />
        <ClientSidebar
          // Withheld when the client belongs to no firm, so a firm id still sitting
          // in the URL can't render firm-scoped nav the client can no longer open.
          lawFirmId={lawFirms.length > 0 ? lawFirmId : undefined}
          lawFirms={lawFirms}
          onSwitchFirm={switchFirm}
          features={firmFeatures}
          pendingHref={pendingHref}
          onNavigate={setPendingHref}
          associations={associations}
          activeClientRecordId={activeClientRecordId}
          onSwitchClientRecord={setActiveClientRecordId}
        />
        <main id="main-content" tabIndex={-1} className={`md:ml-[220px] flex-1 min-w-0 relative pt-14 md:pt-0 ${pendingHref ? 'h-screen overflow-hidden' : ''}`}>
          <AppShellContext value={true}>
            {children}
          </AppShellContext>
          {pendingHref && (
            <div className="absolute inset-0 bg-page flex items-center justify-center z-10">
              <LoadingSpinner />
            </div>
          )}
        </main>
      </div>
      </NavigationContext>
      </ClientPortalContext>
      </ProfileContext>
    </QueryClientProvider>
  );
}
