"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { useProfile } from "@/contexts/ProfileContext";
import clientPortalService from "@/services/client-portal.service";
import signaturesService from "@/services/signatures.service";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import { AutoPager } from "@/components/ui/ListPager";
import usePagedRows from "@/hooks/usePagedRows";
import { Briefcase, MessageSquare, DollarSign, FileText, Building2, PenLine, Lock, ChevronRight } from "lucide-react";
import { useNavigation } from "@/contexts/NavigationContext";
import { useClientSigningRealtime } from "@/hooks/useSigningRealtime";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { formatCurrency } from '@/lib/utils/currency';
import Card from "@/components/ui/Card";
import NavigationLink from "@/components/ui/NavigationLink";
import SectionLabel from "@/components/ui/SectionLabel";

/**
 * Waiting documents shown as buttons in the action banner. The banner has room
 * for a handful; the rest are reached through the firm's own signing list, so
 * this is also the page size the dashboard requests.
 */
const PENDING_PREVIEW = 3;

interface LawFirm {
  id: string;
  name: string;
}

interface FirmSummary {
  matterCount: number;
  // Outstanding balance in dollars (cents-from-the-API divided by 100), matching
  // the currency formatter used by the cards.
  outstandingBalance: number;
  // The firm's subscription is inactive, so its portal is paused. The card shows
  // an "unavailable" state and the per-firm portal routes 402.
  billingLocked: boolean;
}

function SummaryCard({ href, className, children }: { href?: string; className: string; children: React.ReactNode }) {
  return href
    ? <NavigationLink href={href} className={`block ${className}`}>{children}</NavigationLink>
    : <div className={className}>{children}</div>;
}

export default function ClientDashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const { navigate } = useNavigation();
  const { user, loading: authLoading } = useAuth();
  // The client layout already fetched the profile (shared via ProfileContext);
  // read userType from it instead of issuing another /users/profile request.
  const { profile: clientProfile } = useProfile();
  const [lawFirms, setLawFirms] = useState<LawFirm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userType, setUserType] = useState<string | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<{ [key: string]: number }>({});
  const [firmSummaries, setFirmSummaries] = useState<{ [key: string]: FirmSummary }>({});
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [pendingDocuments, setPendingDocuments] = useState<Array<{
    sessionToken: string;
    lawFirmId: string;
    fileName: string;
    routingMode: string;
    createdAt: string | null;
    participantId: string;
    participantRole: string;
    participantName: string | null;
    publicToken: string | null;
    totalParticipants: number;
    completedParticipants: number;
  }>>([]);
  // How many documents are waiting in total, and the one firm holding them all
  // (null when they span firms). Both describe the whole waiting set, not the
  // few documents fetched for the banner buttons.
  const [pendingTotal, setPendingTotal] = useState(0);
  const [pendingFirmId, setPendingFirmId] = useState<string | null>(null);

  // The banner shows the first few as buttons and sends the client to a firm's
  // signing list for the rest, so it asks for exactly those few. The count and
  // the firm come back resolved over every waiting document.
  const refreshPendingDocuments = useCallback(async () => {
    try {
      const response = await signaturesService.getPendingForClient({ limit: PENDING_PREVIEW });
      setPendingDocuments(response.pendingDocuments || []);
      setPendingTotal(response.totalItems || 0);
      setPendingFirmId(response.singleLawFirmId || null);
    } catch (err) {
      console.error('ClientDashboard - Pending signatures fetch failed:', err);
      setPendingDocuments([]);
      setPendingTotal(0);
      setPendingFirmId(null);
    }
  }, []);

  // --- Logic Section (Unchanged) ---

  useEffect(() => {
    if (isRedirecting) return;

    if (!authLoading && !user) {
      router.push("/login");
      return;
    }

    if (!user || authLoading) return;

    const initializeDashboard = async () => {
      try {
        const { auth: firebaseAuth } = await import('@/lib/firebase/config');
        if (!firebaseAuth) {
          router.replace('/login');
          return;
        }

        const currentUser = firebaseAuth.currentUser;

        if (!currentUser) {
          router.replace('/login');
          return;
        }

        const type = clientProfile?.userType;
        // The layout gates rendering until the shared profile resolves, so this
        // is populated by the time the dashboard mounts; bail until it is rather
        // than misreading a null profile as "pending".
        if (!clientProfile) return;

        if (!type || type === 'pending') {
          if (pathname !== '/complete-registration' && !isRedirecting) {
            setIsRedirecting(true);
            router.replace('/complete-registration');
          }
          return;
        }

        if (type !== 'client') {
          if (!isRedirecting) {
            setIsRedirecting(true);
            router.replace('/dashboard');
          }
          return;
        }

        setUserType(type);

        try {
          // One aggregate request returns every firm the client belongs to plus
          // each firm's matterCount + outstandingBalanceCents, computed server-side
          // replacing a per-firm matters+billing fan-out.
          const response = await clientPortalService.getFirmSummaries();
          const firms = response.lawFirms || [];
          setLawFirms(firms.map((firm) => ({ id: firm.id, name: firm.name })));

          const summaries: { [key: string]: FirmSummary } = {};
          for (const firm of firms) {
            summaries[firm.id] = {
              matterCount: firm.matterCount || 0,
              // API returns integer cents; the cards format dollars.
              outstandingBalance: (firm.outstandingBalanceCents || 0) / 100,
              billingLocked: firm.billingLocked || false,
            };
          }
          setFirmSummaries(summaries);
        } catch {
          setLawFirms([]);
          setFirmSummaries({});
        }

        // Initial pending-documents and unread-count loads are owned by the
        // dedicated effects below (which also handle their fallback polls), so
        // we don't fetch them here, that avoided two back-to-back identical
        // GETs on mount.
        setLoading(false);
      } catch (err) {
        console.error('ClientDashboard - Error:', err);
        setError(getErrorMessage(err, "Failed to load dashboard"));
        setLoading(false);
      }
    };

    initializeDashboard();
  }, [user, authLoading, router, isRedirecting, pathname, clientProfile]);

  useEffect(() => {
    if (!user || !lawFirms.length) return;

    const fetchUnreadCounts = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const unreadResponse = await clientPortalService.getUnreadCount();
        const sanitizedCounts: { [key: string]: number } = {};
        for (const [firmId, count] of Object.entries(unreadResponse.unreadByFirm || {})) {
          sanitizedCounts[firmId] = Math.max(0, count);
        }
        setUnreadCounts(sanitizedCounts);
      } catch {
        // Non-critical
      }
    };

    fetchUnreadCounts();
    const interval = setInterval(fetchUnreadCounts, 60000);
    return () => clearInterval(interval);
  }, [user, lawFirms]);

  useEffect(() => {
    if (!user || userType !== 'client') return;

    let cancelled = false;

    const fetchPendingDocuments = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const response = await signaturesService.getPendingForClient({ limit: PENDING_PREVIEW });
        if (!cancelled) {
          setPendingDocuments(response.pendingDocuments || []);
          setPendingTotal(response.totalItems || 0);
          setPendingFirmId(response.singleLawFirmId || null);
        }
      } catch (err) {
        console.error('ClientDashboard - Pending signatures refresh failed:', err);
        if (!cancelled) {
          setPendingDocuments([]);
          setPendingTotal(0);
          setPendingFirmId(null);
        }
      }
    };

    fetchPendingDocuments();
    // Realtime drives updates (see useClientSigningRealtime below); this is a
    // slow fallback poll in matter the websocket drops.
    const interval = setInterval(fetchPendingDocuments, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user, userType]);

  // Realtime: refresh pending documents when this client's signing participant
  // rows change, instead of an always-firing poll.
  useClientSigningRealtime(
    userType === 'client' ? user?.uid : undefined,
    refreshPendingDocuments
  );

  // Firm cards are windowed. Declared above the early returns below so the hook
  // runs on every render.
  const firmsPager = usePagedRows(lawFirms, 6);

  // --- UI Helpers ---

  const getUnreadCount = (firmId: string): number => {
    return Math.max(0, unreadCounts[firmId] || 0);
  };

  // --- Render Sections ---

  if (authLoading || loading || !userType) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center">
        <div className="text-center">
          <LoadingSpinner />
          <p className="mt-4 text-on-surface-muted text-xs font-medium">Initializing Portal...</p>
        </div>
      </div>
    );
  }

  if (userType !== 'client') {
    return <LoadingSpinner fullPage />;
  }

  // --- Empty State ---
  if (lawFirms.length === 0) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto min-w-0">
        <div className="max-w-lg mx-auto mt-16">
          <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8 text-center">
            <div className="mx-auto w-16 h-16 bg-accent-soft dark:bg-accent-soft rounded-2xl flex items-center justify-center mb-5">
              <Building2 className="w-7 h-7 text-accent-emphasis" />
            </div>

            <h2 className="text-xl font-bold text-on-surface mb-2">Welcome to Paralegix</h2>
            <p className="text-sm text-on-surface-secondary mb-8 leading-relaxed">
              We&apos;re waiting for your law firm to connect with your account. Once they send an invitation, your dashboard will automatically activate.
            </p>

            <div className="bg-surface-alt rounded-xl p-5 text-left">
              <SectionLabel gap="3">What to expect</SectionLabel>
              <ul className="space-y-2.5">
                {[
                  "Secure access to your matter updates",
                  "Direct messaging with your attorney",
                  "View and pay invoices online"
                ].map((item, idx) => (
                  <li key={idx} className="flex items-center text-sm text-on-surface">
                    <div className="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center mr-2.5 flex-shrink-0">
                      <svg className="w-3 h-3 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Main Dashboard ---
  const totalMatters = Object.values(firmSummaries).reduce((sum, s) => sum + s.matterCount, 0);
  const totalBalance = Object.values(firmSummaries).reduce((sum, s) => sum + s.outstandingBalance, 0);
  const totalUnread = Object.values(unreadCounts).reduce((sum, count) => sum + Math.max(0, count), 0);

  // The Active Matters / Outstanding stat cards aggregate across every firm, so
  // deep-linking them to a single firm is only meaningful when the client
  // belongs to exactly one. With multiple firms they stay plain totals and the
  // per-firm cards below own navigation.
  const singleFirm = lawFirms.length === 1 ? lawFirms[0] : null;
  const summaryFirm = singleFirm && !firmSummaries[singleFirm.id]?.billingLocked ? singleFirm : null;
  const statCardBase = "bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-5";

  return (
    <div className="p-8 max-w-[1600px] mx-auto min-w-0">
      <ErrorNotification error={error} onClose={() => setError(null)} />

      {/* Greeting */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-on-surface">
          Welcome back, {user?.displayName?.split(' ')[0] || "Client"}
        </h1>
        <p className="text-sm text-on-surface-muted mt-1">
          Here&apos;s what&apos;s happening with your matters.
        </p>
      </div>

      {pendingTotal > 0 && (
        <div className="mb-8 rounded-2xl border border-accent-border-soft dark:border-accent-border-soft bg-accent-soft dark:bg-accent-soft px-5 py-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <div className="relative mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis">
                <PenLine className="h-5 w-5" />
                <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-accent-selection animate-pulse" />
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-accent-emphasis dark:text-accent-emphasis">
                  Action Required
                </p>
                <p className="text-sm font-semibold text-accent-emphasis dark:text-accent-emphasis">
                  {pendingTotal} document{pendingTotal !== 1 ? 's' : ''} waiting for your signature
                </p>
                <p className="text-sm text-accent-emphasis dark:text-accent-emphasis mt-1">
                  Review and sign the documents below to keep your matter moving.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {pendingDocuments.map((document) => (
                <button
                  key={document.sessionToken}
                  onClick={() => navigate(`/signature?token=${encodeURIComponent(document.publicToken || document.sessionToken)}`)}
                  className="inline-flex items-center gap-2 rounded-xl bg-accent-solid px-4 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-solid-hover transition-[background-color,border-color,color,transform] cursor-pointer active:scale-[0.96] motion-reduce:active:scale-100"
                >
                  <PenLine className="h-4 w-4" />
                  Sign {document.fileName}
                </button>
              ))}
              {/* Only the first few fit here, so the rest are reached through the
                  firm's own paged signing list. Shown only when every waiting
                  document belongs to one firm; otherwise there is no single list
                  to send the client to. */}
              {pendingTotal > PENDING_PREVIEW && pendingFirmId && (
                <button
                  onClick={() => navigate(`/client/lawfirm/${pendingFirmId}/signatures`)}
                  className="inline-flex items-center gap-2 rounded-xl border border-accent-border-soft dark:border-accent-border-soft px-4 py-2 text-sm font-medium text-accent-emphasis dark:text-accent-emphasis hover:bg-accent-soft/60 dark:hover:bg-accent-soft transition-[background-color,border-color,color,transform] cursor-pointer active:scale-[0.96] motion-reduce:active:scale-100"
                >
                  View all {pendingTotal} documents
                  <ChevronRight className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
        {/* Active Matters */}
        <SummaryCard
          href={summaryFirm ? `/client/lawfirm/${summaryFirm.id}/matters` : undefined}
          className={`${statCardBase} ${summaryFirm ? "cursor-pointer hover:border-accent-border-soft dark:hover:border-accent-border-soft hover:shadow-md transition-all" : ""}`}
        >
          <div className="flex items-center justify-between">
            <div>
              <SectionLabel>Active Matters</SectionLabel>
              <p className="text-2xl font-bold text-on-surface mt-1">{totalMatters}</p>
            </div>
            <div className="w-10 h-10 bg-accent-soft dark:bg-accent-soft rounded-xl flex items-center justify-center">
              <Briefcase className="w-5 h-5 text-accent-emphasis" />
            </div>
          </div>
        </SummaryCard>

        {/* Unread Messages */}
        <NavigationLink
          href="/client/messages"
          className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-5 cursor-pointer hover:border-accent-border-soft dark:hover:border-accent-border-soft hover:shadow-md transition-all"
        >
          <div className="flex items-center justify-between">
            <div>
              <SectionLabel>New Messages</SectionLabel>
              <p className="text-2xl font-bold text-on-surface mt-1">{totalUnread}</p>
            </div>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${totalUnread > 0 ? 'bg-accent-soft dark:bg-accent-soft' : 'bg-surface-alt'}`}>
              <MessageSquare className={`w-5 h-5 ${totalUnread > 0 ? 'text-accent-emphasis dark:text-accent-emphasis' : 'text-on-surface-muted'}`} />
            </div>
          </div>
        </NavigationLink>

        {/* Outstanding Balance */}
        <SummaryCard
          href={summaryFirm ? `/client/lawfirm/${summaryFirm.id}/billing` : undefined}
          className={`${statCardBase} ${summaryFirm ? "cursor-pointer hover:border-emerald-200 dark:hover:border-emerald-500/30 hover:shadow-md transition-all" : ""}`}
        >
          <div className="flex items-center justify-between">
            <div>
              <SectionLabel>Outstanding</SectionLabel>
              <p className={`text-2xl font-bold mt-1 ${totalBalance > 0 ? 'text-rose-600' : 'text-on-surface'}`}>
                {formatCurrency(totalBalance)}
              </p>
            </div>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${totalBalance > 0 ? 'bg-rose-50 dark:bg-rose-500/10' : 'bg-emerald-50 dark:bg-emerald-500/10'}`}>
              <DollarSign className={`w-5 h-5 ${totalBalance > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`} />
            </div>
          </div>
        </SummaryCard>
      </div>

      {/* Law Firms Section */}
      <SectionLabel gap="4">Your Legal Teams</SectionLabel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {firmsPager.pagedRows.map((firm) => {
          const firmUnread = getUnreadCount(firm.id);
          const firmBalance = firmSummaries[firm.id]?.outstandingBalance || 0;
          const firmMatters = firmSummaries[firm.id]?.matterCount || 0;
          const locked = firmSummaries[firm.id]?.billingLocked ?? false;

          return (
            <Card key={firm.id}>
              {/* Firm Header */}
              <div className="px-5 py-4 border-b border-outline-subtle flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-accent-solid rounded-xl flex items-center justify-center">
                    <Building2 className="w-4 h-4 text-accent-foreground" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-on-surface">{firm.name}</h3>
                    <p className="text-[10px] text-on-surface-muted">Connected Firm</p>
                  </div>
                </div>
                {firmUnread > 0 && (
                  <span className="flex items-center bg-accent-soft dark:bg-accent-soft text-accent-emphasis dark:text-accent-emphasis text-[10px] font-bold px-2.5 py-1 rounded-full">
                    <span className="w-1.5 h-1.5 bg-accent-selection rounded-full mr-1.5 animate-pulse"></span>
                    New
                  </span>
                )}
              </div>

              {/* Action Grid (or an unavailable notice when the firm's billing is inactive) */}
              {locked ? (
                <div className="p-5 flex items-start gap-3">
                  <div className="w-9 h-9 rounded-xl bg-surface-alt flex items-center justify-center flex-shrink-0">
                    <Lock className="w-4 h-4 text-on-surface-muted" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-on-surface">Portal unavailable</p>
                    <p className="text-xs text-on-surface-muted mt-1">
                      This firm&apos;s portal is temporarily unavailable. Please contact the firm directly.
                    </p>
                  </div>
                </div>
              ) : (
              <div className="p-3 grid grid-cols-2 gap-2.5">
                {/* Matters */}
                <NavigationLink
                  href={`/client/lawfirm/${firm.id}/matters`}
                  aria-label={`My Matters at ${firm.name}`}
                  className="flex flex-col p-3.5 rounded-xl border border-outline-subtle hover:bg-accent-soft dark:hover:bg-accent-soft hover:border-accent-border-soft dark:hover:border-accent-border-soft transition-all text-left group cursor-pointer active:scale-[0.96] motion-reduce:active:scale-100"
                >
                  <div className="mb-2.5 w-7 h-7 rounded-lg bg-accent-soft dark:bg-accent-soft text-accent-emphasis flex items-center justify-center group-hover:scale-110 transition-transform">
                    <FileText className="w-3.5 h-3.5" />
                  </div>
                  <span className="text-xs font-semibold text-on-surface group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis">My Matters</span>
                  <span className="text-[10px] text-on-surface-muted mt-0.5">{firmMatters} active</span>
                </NavigationLink>

                {/* Billing */}
                <NavigationLink
                  href={`/client/lawfirm/${firm.id}/billing`}
                  aria-label={`Billing at ${firm.name}`}
                  className={`flex flex-col p-3.5 rounded-xl border border-outline-subtle hover:bg-emerald-50/50 dark:hover:bg-emerald-500/10 hover:border-emerald-200 dark:hover:border-emerald-500/30 transition-all text-left group cursor-pointer active:scale-[0.96] motion-reduce:active:scale-100 ${firmBalance > 0 ? 'ring-1 ring-rose-100 dark:ring-rose-500/20' : ''}`}
                >
                  <div className={`mb-2.5 w-7 h-7 rounded-lg flex items-center justify-center group-hover:scale-110 transition-transform ${firmBalance > 0 ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400' : 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}`}>
                    <DollarSign className="w-3.5 h-3.5" />
                  </div>
                  <span className="text-xs font-semibold text-on-surface group-hover:text-emerald-700 dark:group-hover:text-emerald-400">Billing</span>
                  <span className={`text-[10px] mt-0.5 ${firmBalance > 0 ? 'text-rose-600 font-medium' : 'text-on-surface-muted'}`}>
                    {firmBalance > 0 ? `${formatCurrency(firmBalance)} due` : 'Paid up'}
                  </span>
                </NavigationLink>

                {/* Messages */}
                <NavigationLink
                  href={`/client/messages/${firm.id}`}
                  aria-label={`Messages at ${firm.name}`}
                  className="flex flex-col p-3.5 rounded-xl border border-outline-subtle hover:bg-accent-soft dark:hover:bg-accent-soft hover:border-accent-border-soft dark:hover:border-accent-border-soft transition-all text-left group cursor-pointer active:scale-[0.96] motion-reduce:active:scale-100"
                >
                  <div className="flex justify-between items-start w-full">
                    <div className="mb-2.5 w-7 h-7 rounded-lg bg-accent-soft dark:bg-accent-soft text-accent-emphasis dark:text-accent-emphasis flex items-center justify-center group-hover:scale-110 transition-transform">
                      <MessageSquare className="w-3.5 h-3.5" />
                    </div>
                    {firmUnread > 0 && (
                      <span className="bg-accent-selection text-accent-foreground dark:bg-accent-solid text-[9px] font-bold px-1.5 py-0.5 rounded-md">
                        {firmUnread}
                      </span>
                    )}
                  </div>
                  <span className="text-xs font-semibold text-on-surface group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis">Messages</span>
                  <span className="text-[10px] text-on-surface-muted mt-0.5">Contact Team</span>
                </NavigationLink>

              </div>
              )}
            </Card>
          );
        })}
      </div>
      {firmsPager.total > firmsPager.rowsPerPage && (
        <div className="mt-5 bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] px-5 py-3">
          <AutoPager pager={firmsPager} />
        </div>
      )}
    </div>
  );
}
