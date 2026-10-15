"use client";

import { useState, useEffect, Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import userService from "@/services/users.service";
import lawFirmService from "@/services/lawfirm.service";
import AuthService from "@/services/auth.service";
import type { LawFirm } from "@/types";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import PageHeader from "@/components/ui/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Building2, Plus, LogOut, ChevronRight, Briefcase, Shield, Mail } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import Spinner from "@/components/ui/Spinner";
import { apiFetch } from "@/lib/utils/fetchWithTokenRefresh";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";
import SectionLabel from "@/components/ui/SectionLabel";
import Button from "@/components/ui/Button";
import CalendarConnectOutcomeToast from "@/components/calendarComp/CalendarConnectOutcomeToast";
import { connectOutcomeQuery } from "@/lib/utils/calendarConnectOutcome";

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

interface LawFirmsResponse {
  lawFirmIds: string[];
}

interface PendingMemberInvite {
  token: string;
  lawFirmId: string;
  lawFirmName: string;
  invitedAt: string;
}

const FIRM_SIZE_OPTIONS: DropdownOption[] = [
  { value: "1", label: "Just me" },
  { value: "2-5", label: "2-5 people" },
  { value: "6-20", label: "6-20 people" },
  { value: "21-50", label: "21-50 people" },
  { value: "51+", label: "51+ people" },
];

// Mirrors backend/src/shared/referenceData/defaults.ts DEFAULT_PRACTICE_AREAS.
// No shared code between packages, so keep this list in sync by hand.
const PRACTICE_AREA_OPTIONS: DropdownOption[] = [
  "Estate Planning", "Wills", "Probate", "Family Law", "Immigration",
  "Personal Injury", "Real Estate", "Criminal Defense", "Business Law",
  "Dispute Resolution", "Other",
].map((name) => ({ value: name, label: name }));

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning";
  if (h < 17) return "Good Afternoon";
  return "Good Evening";
}

function getFirstName(name: string | null | undefined): string {
  if (!name) return "there";
  return name.split(" ")[0];
}

const Dashboard = () => {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [lawFirms, setLawFirms] = useState<LawFirm[]>([]);
  const [lawFirmsLoading, setLawFirmsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [firmName, setFirmName] = useState("");
  const [firmSize, setFirmSize] = useState("");
  const [practiceArea, setPracticeArea] = useState("");
  const [creating, setCreating] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [logoErrors, setLogoErrors] = useState<Set<string>>(new Set());
  const [navigatingFirmId, setNavigatingFirmId] = useState<string | null>(null);
  const [navigatingAdmin, setNavigatingAdmin] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [pendingInvites, setPendingInvites] = useState<PendingMemberInvite[]>([]);
  const [pendingInvitesLoading, setPendingInvitesLoading] = useState(true);
  const [navigatingInviteToken, setNavigatingInviteToken] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;

    if (!user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async data-fetch effect with timeout that sets loading/error/navigation state
      setLawFirmsLoading(false);
      return;
    }

    let timeoutId: NodeJS.Timeout | null = null;

    const fetchLawFirms = async (retryCount = 0) => {
      if (timeoutId) clearTimeout(timeoutId);

      timeoutId = setTimeout(() => {
        setLawFirmsLoading(false);
        setError("Request timed out. Please try refreshing the page.");
        timeoutId = null;
      }, 30000);

      try {
        const data: LawFirmsResponse = await userService.getMyLawFirms();
        const lawFirmIds: string[] = data.lawFirmIds || [];

        if (lawFirmIds.length === 1 && lawFirmIds[0]) {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          setNavigatingFirmId(lawFirmIds[0]);
          // A calendar connect can land here; the firm shell reports its
          // outcome, so the outcome travels with the forward.
          const outcome = connectOutcomeQuery(new URLSearchParams(window.location.search));
          router.replace(`/lawfirm/${lawFirmIds[0]}${outcome}`);
          return;
        }

        const firmDetails: LawFirm[] = await Promise.all(
          lawFirmIds.map(async (id) => {
            try {
              const firm = await lawFirmService.getLawFirmById(id);
              return firm
                ? { id, name: firm.name || "Unnamed Law Firm", logoUrl: firm.logoUrl }
                : { id, name: "Unknown Law Firm" };
            } catch {
              return { id, name: "Unknown Law Firm" };
            }
          })
        );

        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        setLawFirms(firmDetails);
        setLawFirmsLoading(false);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        if (
          (errorMessage.includes("User not found") ||
            errorMessage.includes("404")) &&
          retryCount < 2
        ) {
          setTimeout(() => fetchLawFirms(retryCount + 1), 1000);
          return;
        } else if (
          errorMessage.includes("User not found") ||
          errorMessage.includes("404")
        ) {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          setLawFirms([]);
          setError(null);
          setLawFirmsLoading(false);
        } else {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          setError(errorMessage || "Failed to load law firms.");
          setLawFirmsLoading(false);
        }
      }
    };

    fetchLawFirms();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [user, authLoading, router]);

  useEffect(() => {
    if (authLoading || !user) return;

    let active = true;

    userService.getProfile()
      .then((profile) => {
        if (active) {
          setIsAdmin(profile?.isAdmin === true);
          setPhotoUrl(profile?.photoUrl ?? null);
        }
      })
      .catch(() => {
        if (active) {
          setIsAdmin(false);
          setPhotoUrl(null);
        }
      });

    return () => {
      active = false;
    };
  }, [user, authLoading]);

  // A member invite that arrived before this person had an account (or that
  // they signed up without going through the emailed accept link) never
  // auto-joins: the backend only auto-processes invites for verified email
  // sign-ups and OAuth, never on plain login. Surface it here so someone who
  // lands on an empty dashboard sees the invite instead of "create a firm".
  // Gated on pendingInvitesLoading below (not just lawFirmsLoading) so the
  // zero-firms view doesn't flash "Create your law firm" for a beat before
  // flipping to the invite card once this resolves.
  useEffect(() => {
    if (authLoading) return;

    if (!user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors the lawFirms effect above: signed-out short-circuit
      setPendingInvitesLoading(false);
      return;
    }

    let active = true;

    apiFetch(`${API_URL}/invitations/my-pending-member-invites`)
      .then((res) => (res.ok ? res.json() : { invites: [] }))
      .then((data) => {
        if (active) setPendingInvites(data.invites || []);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setPendingInvitesLoading(false);
      });

    return () => {
      active = false;
    };
  }, [user, authLoading]);

  const handleGoToLawFirm = (lawFirmId: string) => {
    setNavigatingFirmId(lawFirmId);
    router.push(`/lawfirm/${lawFirmId}`);
  };

  const handleViewInvite = (token: string) => {
    setNavigatingInviteToken(token);
    router.push(`/accept-member-invite?token=${token}`);
  };

  const handleCreateLawFirm = async () => {
    if (!firmName.trim()) return;

    try {
      setCreating(true);
      const response = await lawFirmService.createLawFirm({
        name: firmName.trim(),
        firmSize: firmSize || undefined,
        practiceArea: practiceArea || undefined,
      });

      const newFirmId =
        (response as any)?.lawFirm?.id ||
        (response as any)?.lawFirm?.lawFirmId ||
        (response as any)?.lawFirmId ||
        (response as any)?.id;

      // New firms start on an immediate trial, so the owner goes straight into
      // a short optional setup checklist instead of a forced Stripe checkout.
      if (newFirmId) {
        router.push(`/lawfirm/${newFirmId}/get-started`);
      } else {
        router.push(`/dashboard`);
      }
    } catch {
      setError("Failed to create law firm.");
      setCreating(false);
    }
  };

  const handleLogout = async () => {
    setSigningOut(true);
    try {
      await AuthService.signOutUser();
      router.push("/login");
    } catch {
      setSigningOut(false);
    }
  };

  // Gradient colors for firm cards
  const firmGradients = [
    "from-indigo-500 to-violet-500",
    "from-emerald-500 to-teal-500",
    "from-amber-500 to-orange-500",
    "from-rose-500 to-pink-500",
    "from-blue-500 to-cyan-500",
    "from-fuchsia-500 to-purple-500",
  ];

  if (
    navigatingFirmId ||
    navigatingInviteToken ||
    navigatingAdmin ||
    lawFirmsLoading ||
    // Only the zero-firms view depends on knowing about pending invites up
    // front (which card to show first); a user who already has firms never
    // sees either card, so don't make them wait on this fetch too.
    (lawFirms.length === 0 && pendingInvitesLoading)
  ) {
    return <LoadingSpinner fullPage />;
  }

  if (error) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center">
        <div className="bg-surface rounded-2xl border border-outline-subtle p-8 shadow-[0_1px_3px_rgba(0,0,0,0.04)] max-w-md text-center">
          <div className="w-12 h-12 rounded-xl bg-rose-50 dark:bg-rose-950/30 flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-6 h-6 text-rose-600 dark:text-rose-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <p className="text-sm font-semibold text-on-surface mb-1">
            Something went wrong
          </p>
          <p className="text-xs text-on-surface-muted mb-5">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-accent-solid text-accent-foreground text-sm font-medium rounded-xl hover:bg-accent-solid-hover transition-colors shadow-sm dark:shadow-none cursor-pointer"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-page">
      {/* Mounted only once the person is staying on the dashboard; a single-firm
          forward above hands the outcome to the firm shell instead. */}
      <Suspense fallback={null}>
        <CalendarConnectOutcomeToast />
      </Suspense>
      {/* Header */}
      <header className="bg-surface border-b border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="max-w-5xl mx-auto px-6">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center mt-1">
              <ParalegixLogo
                width={170}
                height={50}
                priority
              />
            </div>
            <div className="flex items-center gap-3">
              {isAdmin && (
                <Tooltip title="Open admin console" enterDelay={300}>
                  <span>
                    <button
                      onClick={() => {
                        setNavigatingAdmin(true);
                        router.push("/admin");
                      }}
                      disabled={navigatingAdmin}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-accent-border-soft dark:border-accent-border-soft text-accent-emphasis dark:text-accent-emphasis hover:bg-accent-soft dark:hover:bg-accent-soft transition-colors text-xs font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Shield size={14} strokeWidth={2} />
                      Admin
                    </button>
                  </span>
                </Tooltip>
              )}
              {/* The only route to account settings for a member who has not
                  created a firm yet - every firm-scoped settings page needs a
                  firm id this user does not have. */}
              <Tooltip title="Account settings" enterDelay={300}>
                <Link
                  href="/account"
                  className="flex items-center gap-3 rounded-xl px-2.5 py-1.5 hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  <div className="text-right hidden sm:block">
                    <p className="text-xs font-semibold text-on-surface">
                      {user?.displayName || "User"}
                    </p>
                  </div>
                  <Avatar
                    size="md"
                    photoUrl={photoUrl}
                    name={user?.displayName}
                    email={user?.email}
                  />
                </Link>
              </Tooltip>
              <Tooltip title="Sign out" enterDelay={300}>
                <button aria-label="Sign out"
                  onClick={handleLogout}
                  disabled={signingOut}
                  className="ml-1 p-2 rounded-xl text-on-surface-muted hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {signingOut
                    ? <Spinner size={16} />
                    : <LogOut size={16} strokeWidth={1.8} />}
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className={`max-w-5xl mx-auto px-6 ${lawFirms.length === 0 ? "py-12" : "py-8"}`}>
        {lawFirms.length > 0 && (
          <PageHeader
            className="mb-8"
            title={<>{getGreeting()}, {getFirstName(user?.displayName)}</>}
            description={`You have ${lawFirms.length} law firm${lawFirms.length !== 1 ? "s" : ""}. Select one to continue.`}
          />
        )}

        {/* Error */}
        <ErrorNotification
          error={error}
          onClose={() => setError(null)}
          className="mb-6"
        />

        {/* No firm yet and a pending invite is waiting: lead with the invite
            so an invited teammate joins the existing firm instead of
            accidentally standing up a second one. */}
        {lawFirms.length === 0 && pendingInvites.length > 0 && !showCreateForm && (
          <div className="flex justify-center">
            <div className="w-full max-w-[420px] bg-surface rounded-2xl border border-outline-subtle p-8 shadow-sm">
              <div className="flex flex-col items-center text-center mb-5">
                <div className="w-12 h-12 rounded-xl bg-accent-soft dark:bg-accent-soft flex items-center justify-center mb-4">
                  <Mail size={22} className="text-accent-emphasis" strokeWidth={1.8} />
                </div>
                <h2 className="text-xl font-bold text-on-surface">You&apos;ve been invited</h2>
                <p className="mt-1 text-xs text-on-surface-muted">
                  <span className="font-semibold text-on-surface-secondary">
                    {pendingInvites[0].lawFirmName}
                  </span>{" "}
                  invited you to join their team on Paralegix.
                </p>
              </div>

              <button
                onClick={() => handleViewInvite(pendingInvites[0].token)}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-accent-solid text-accent-foreground text-sm font-medium rounded-xl hover:bg-accent-solid-hover transition-colors shadow-sm dark:shadow-none cursor-pointer"
              >
                View Invitation
              </button>

              <button
                onClick={() => setShowCreateForm(true)}
                className="mt-3 w-full text-center text-xs text-on-surface-muted hover:text-on-surface transition-colors cursor-pointer"
              >
                Or create your own law firm instead
              </button>
            </div>
          </div>
        )}

        {/* No firm yet: creating one is the only thing to do here, so the form
            is the page rather than something behind a button. */}
        {lawFirms.length === 0 && (pendingInvites.length === 0 || showCreateForm) && (
          <div className="flex justify-center">
            <div className="w-full max-w-[420px] bg-surface rounded-2xl border border-outline-subtle p-8 shadow-sm">
              <div className="flex flex-col items-center text-center mb-5">
                <div className="w-12 h-12 rounded-xl bg-accent-soft dark:bg-accent-soft flex items-center justify-center mb-4">
                  <Building2 size={22} className="text-accent-emphasis" strokeWidth={1.8} />
                </div>
                <h2 className="text-xl font-bold text-on-surface">Create your law firm</h2>
                <p className="mt-1 text-xs text-on-surface-muted">
                  Your workspace for matters, tasks, billing, and your team.
                </p>
              </div>

              {pendingInvites.length > 0 && (
                <button
                  onClick={() => setShowCreateForm(false)}
                  className="mb-4 w-full text-center text-xs text-accent-emphasis hover:text-accent-emphasis-hover transition-colors cursor-pointer"
                >
                  Have an invite? View it instead
                </button>
              )}

              <div className="space-y-3">
                <div>
                  <FieldLabel htmlFor="firmName">
                    Firm name *
                  </FieldLabel>
                  <TextInput
                    id="firmName"
                    type="text"
                    required
                    placeholder="Smith & Associates"
                    value={firmName}
                    onChange={(e) => setFirmName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateLawFirm()}
                    autoFocus
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Dropdown
                    label="Firm size"
                    value={firmSize}
                    onChange={setFirmSize}
                    options={FIRM_SIZE_OPTIONS}
                    placeholder="Select size"
                  />
                  <Dropdown
                    label="Practice area"
                    value={practiceArea}
                    onChange={setPracticeArea}
                    options={PRACTICE_AREA_OPTIONS}
                    placeholder="Select area"
                  />
                </div>

                <button
                  onClick={handleCreateLawFirm}
                  disabled={creating || !firmName.trim()}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-accent-solid text-accent-foreground text-sm font-medium rounded-xl hover:bg-accent-solid-hover transition-colors shadow-sm dark:shadow-none disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {creating && <Spinner size={16} />}
                  {creating ? "Creating..." : "Create Law Firm"}
                </button>
              </div>

              <p className="mt-4 text-center text-xs text-on-surface-muted">
                Includes a 14-day free trial. No credit card required.
              </p>
            </div>
          </div>
        )}

        {/* Multiple firms are only reachable when the per-user cap is raised
            (MAX_LAW_FIRMS_PER_USER), so this list keeps its own add flow. */}
        {lawFirms.length > 0 && (
          <>
            <div className="flex items-center justify-between mb-5">
              <SectionLabel>
                Your Law Firms
              </SectionLabel>
              {!showCreateForm && (
                <Button
                  size="compact"
                  onClick={() => setShowCreateForm(true)}
                  icon={<Plus size={14} strokeWidth={2.2} />}
                >
                  Add Law Firm
                </Button>
              )}
            </div>

            {showCreateForm && (
              <div className="bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm mb-6">
                <p className="text-sm font-semibold text-on-surface mb-4">
                  Create New Law Firm
                </p>
                <div className="space-y-3">
                  <div>
                    <FieldLabel htmlFor="newFirmName">
                      Firm name *
                    </FieldLabel>
                    <TextInput
                      id="newFirmName"
                      type="text"
                      required
                      placeholder="Smith & Associates"
                      value={firmName}
                      onChange={(e) => setFirmName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleCreateLawFirm()}
                      autoFocus
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Dropdown
                      label="Firm size"
                      value={firmSize}
                      onChange={setFirmSize}
                      options={FIRM_SIZE_OPTIONS}
                      placeholder="Select size"
                    />
                    <Dropdown
                      label="Practice area"
                      value={practiceArea}
                      onChange={setPracticeArea}
                      options={PRACTICE_AREA_OPTIONS}
                      placeholder="Select area"
                    />
                  </div>

                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={handleCreateLawFirm}
                      disabled={creating || !firmName.trim()}
                      className="inline-flex items-center gap-2 px-4 py-2.5 bg-accent-solid text-accent-foreground text-sm font-medium rounded-xl hover:bg-accent-solid-hover transition-colors shadow-sm dark:shadow-none disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {creating && <Spinner size={16} />}
                      {creating ? "Creating..." : "Create"}
                    </button>
                    <button
                      onClick={() => {
                        setShowCreateForm(false);
                        setFirmName("");
                        setFirmSize("");
                        setPracticeArea("");
                      }}
                      className="px-4 py-2.5 text-sm font-medium text-on-surface-secondary bg-surface border border-outline rounded-xl hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* Law firm cards */}
        {lawFirms.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {lawFirms.map((firm, idx) => {
              const gradient = firmGradients[idx % firmGradients.length];
              return (
                <button
                  key={firm.id}
                  onClick={() => handleGoToLawFirm(firm.id)}
                  disabled={!!navigatingFirmId}
                  className="group bg-surface rounded-2xl border border-outline-subtle p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] hover:shadow-md hover:border-accent-border-soft dark:hover:border-accent-border-soft transition-all duration-200 text-left cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="flex items-start justify-between mb-4">
                    {firm.logoUrl && !logoErrors.has(firm.id) ? (
                      <div className="w-11 h-11 rounded-xl flex items-center justify-center overflow-hidden bg-surface border border-outline-subtle flex-shrink-0">
                        <Image
                          src={firm.logoUrl}
                          alt={firm.name}
                          width={44}
                          height={44}
                          sizes="44px"
                          className="w-full h-full object-contain"
                          onError={() =>
                            setLogoErrors(
                              (prev) => new Set(prev).add(firm.id)
                            )
                          }
                        />
                      </div>
                    ) : (
                      <div
                        className={`w-11 h-11 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center flex-shrink-0 shadow-sm`}
                      >
                        <Building2
                          size={20}
                          className="text-white"
                          strokeWidth={1.8}
                        />
                      </div>
                    )}
                    <ChevronRight
                      size={16}
                      className="text-on-surface-muted group-hover:text-accent-emphasis transition-colors mt-1"
                    />
                  </div>
                  <h3 className="text-sm font-semibold text-on-surface group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors truncate mb-1">
                    {firm.name}
                  </h3>
                  <div className="flex items-center gap-1.5">
                    <Briefcase size={12} className="text-on-surface-muted" />
                    <span className="text-[11px] text-on-surface-muted">
                      Law Firm
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
