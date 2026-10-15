"use client";

import { useState, useEffect, useId } from "react";
import Link from "next/link";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import { usePathname, useRouter } from "next/navigation";
import {
  Home,
  MessageSquare,
  FileText,
  FolderOpen,
  DollarSign,
  Landmark,
  CalendarDays,
  PenLine,
  ShieldCheck,
  Settings,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import authService from "@/services/auth.service";
import { useUnreadCount } from "@/hooks/useUnreadCount";
import { useProfile } from "@/contexts/ProfileContext";
import ClientNotificationBell from "@/components/notificationComp/ClientNotificationBell";
import { DEFAULT_FIRM_FEATURES, type FirmFeatures } from "@/types/preferences";
import Dropdown from "@/components/ui/Dropdown";
import { Avatar } from "@/components/ui/Avatar";
import ItemActionMenu, { menuPositionFromEvent } from "@/components/ui/ItemActionMenu";
import { useMountTransition } from "@/hooks/useMountTransition";
import { backdropAnim } from "@/components/ui/transitionClasses";
import Spinner from "@/components/ui/Spinner";
import useSlidingHighlight from "@/hooks/useSlidingHighlight";
import SidebarActiveHighlight from "./SidebarActiveHighlight";
import type { ClientPortalAssociation } from "@/contexts/ClientPortalContext";
import SectionLabel from "@/components/ui/SectionLabel";
import CountPill from "@/components/ui/CountPill";
import { useDialog } from "@/hooks/useDialog";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";

interface ClientSidebarProps {
  lawFirmId?: string;
  lawFirms?: { id: string; name: string }[];
  onSwitchFirm?: (firmId: string) => void;
  features?: FirmFeatures;
  pendingHref?: string | null;
  onNavigate?: (href: string) => void;
  // Every client-record association the portal user holds in `lawFirmId`
  // (organization-clients plan, Phase 5). A switcher only renders once there's
  // more than one to choose between (e.g. Pat, on two companies) - matching
  // the "Law Firm" switcher above it, which follows the same rule.
  associations?: ClientPortalAssociation[];
  activeClientRecordId?: string | null;
  onSwitchClientRecord?: (clientRecordId: string) => void;
}

const ClientSidebar = ({
  lawFirmId,
  lawFirms = [],
  onSwitchFirm,
  features = DEFAULT_FIRM_FEATURES,
  pendingHref = null,
  onNavigate,
  associations = [],
  activeClientRecordId = null,
  onSwitchClientRecord,
}: ClientSidebarProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useAuth();
  const { unreadCount } = useUnreadCount();
  const { profile } = useProfile();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountMenuAnchor, setAccountMenuAnchor] = useState({ anchorTop: 0, anchorBottom: 0, right: 0, left: 0 });
  const mobileBackdropAnim = useMountTransition(mobileOpen, 100);
  const mobileDrawerId = useId();
  const { dialogRef } = useDialog<HTMLElement>({ isOpen: mobileOpen, onClose: () => setMobileOpen(false) });
  useBodyScrollLock(mobileOpen);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)');
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileOpen(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const main = document.getElementById('main-content');
    if (!main) return;
    const wasInert = main.hasAttribute('inert');
    main.setAttribute('inert', '');
    return () => {
      if (!wasInert) main.removeAttribute('inert');
    };
  }, [mobileOpen]);
  // Read straight from the profile the client layout already fetched (shared via
  // ProfileContext), so the footer identity costs no extra request. Editing it
  // happens on /account, which is outside this layout - returning here remounts
  // the layout and refetches, so there is nothing to keep in sync while mounted.
  const photoUrl = profile?.photoUrl ?? null;
  // The stored profile name is what the firm sees on this client, so it wins
  // over the Firebase display name (a mirror that can lag behind it).
  const displayName = profile?.name || user?.displayName || null;

  // Close drawer on route change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- closes the mobile drawer in response to route changes
    setMobileOpen(false);
  }, [pathname]);

  const basePath = lawFirmId ? `/client/lawfirm/${lawFirmId}` : '/client';

  // Billing and Trust are the two nav items the backend refuses outright for an
  // organization link whose `canViewBilling` is off (`assertCanViewBilling`), so
  // offering them would just route the client to a 403. Defaults to true while
  // the active association is still unresolved, so the ordinary single-account
  // client never sees the items pop in after load.
  const activeAssociation = associations.find((a) => a.clientRecordId === activeClientRecordId) || null;
  const canViewBilling = !activeAssociation || activeAssociation.canViewBilling;

  const items = [
    { name: "Dashboard", href: "/client/dashboard", icon: Home },
  ];

  if (features.messaging) {
    items.push({ name: "Messages", href: "/client/messages", icon: MessageSquare });
  }

  if (lawFirmId && features.clientPortal) {
    items.push({ name: "My Matters", href: `${basePath}/matters`, icon: FileText });
    items.push({ name: "Calendar", href: `${basePath}/calendar`, icon: CalendarDays });
    // Document sharing rides on the same firm feature flag the firm-side file
    // manager uses (RequireFeature feature="fileSharing").
    if (features.fileSharing) {
      items.push({ name: "Documents", href: `${basePath}/documents`, icon: FolderOpen });
    }
    // Signing requests ride on the firm's documentSigning feature flag, mirroring
    // the firm-side signatures nav item.
    if (features.documentSigning) {
      items.push({ name: "Documents to Sign", href: `${basePath}/signatures`, icon: PenLine });
    }
    // Identity verification checks a person's own ID, so an organization link
    // has nothing to verify. Shown while the association is unresolved, like
    // Billing above, so the ordinary single-account client never sees it pop in.
    if (activeAssociation?.clientType !== "company") {
      items.push({ name: "Identity", href: `${basePath}/identity`, icon: ShieldCheck });
    }
    if (canViewBilling) {
      items.push({ name: "Billing", href: `${basePath}/billing`, icon: DollarSign });
      if (features.trustAccounting) {
        items.push({ name: "Trust Account", href: `${basePath}/trust`, icon: Landmark });
      }
    }
  }

  // Settings holds this firm's notification and communication preferences, so it
  // is shown whenever a firm is selected. Anything belonging to the person rather
  // than the firm lives on /account, linked from the footer below.
  if (lawFirmId) {
    items.push({ name: "Settings", href: `${basePath}/settings`, icon: Settings });
  }

  const isActive = (item: (typeof items)[number]) => {
    if (item.name === "Dashboard") {
      return pathname === "/client/dashboard";
    }
    if (item.name === "Messages") {
      return pathname.startsWith("/client/messages");
    }
    if (item.name === "My Matters") {
      return pathname.startsWith(`${basePath}/matters`);
    }
    if (item.name === "Calendar") {
      return pathname.startsWith(`${basePath}/calendar`);
    }
    if (item.name === "Documents to Sign") {
      return pathname.startsWith(`${basePath}/signatures`);
    }
    if (item.name === "Documents") {
      return pathname.startsWith(`${basePath}/documents`);
    }
    if (item.name === "Billing") {
      return pathname.startsWith(`${basePath}/billing`);
    }
    if (item.name === "Trust Account") {
      return pathname.startsWith(`${basePath}/trust`);
    }
    if (item.name === "Settings") {
      return pathname.startsWith(`${basePath}/settings`);
    }
    return pathname === item.href || pathname.startsWith(item.href + "/");
  };

  // Single key driving the sliding highlight, mirroring each item's own
  // `highlighted` check below (pending target wins over the current route so
  // the pill starts moving the instant a click lands, not once the route
  // actually changes).
  const activeItemKey = items.find((item) => {
    const active = isActive(item);
    const pending = !!pendingHref && pendingHref.startsWith(item.href);
    return pending || (active && !pendingHref);
  })?.name ?? null;

  // Rendered twice (mobile drawer + desktop aside), so each needs its own
  // hook instance -- sharing one would have both DOM subtrees fight over the
  // same item-ref map.
  const mobileHighlight = useSlidingHighlight<HTMLElement>(activeItemKey);
  const desktopHighlight = useSlidingHighlight<HTMLElement>(activeItemKey);

  const handleLogout = async () => {
    setSigningOut(true);
    try {
      await authService.signOutUser();
      router.push("/login");
    } catch {
      setSigningOut(false);
    }
  };

  const renderSidebarContent = (highlight: typeof mobileHighlight) => (
    <>
      {/* Logo */}
      <div className="px-5 pt-6 pb-2">
        <Link href="/client/dashboard" className="block">
          <ParalegixLogo
            width={180}
            height={55}
            priority
          />
        </Link>
      </div>

      {/* Firm switcher: only for clients who belong to more than one firm. */}
      {lawFirms.length > 1 && lawFirmId && (
        <div className="px-4 pb-1 pt-2">
          <SectionLabel gap="1.5" className="px-0">
            Law Firm
          </SectionLabel>
          <Dropdown
            value={lawFirmId}
            onChange={(id) => onSwitchFirm?.(id)}
            options={lawFirms.map((f) => ({ label: f.name, value: f.id }))}
            ariaLabel="Switch law firm"
            buttonClassName="!rounded-xl !py-2 text-[13px] bg-surface-alt"
          />
        </div>
      )}

      {/* Client-record switcher: only for a portal uid with more than one
          association in this firm (a personal client record and/or one or more
          company roster links). Always visible rather than only-on-ambiguity,
          matching the firm switcher just above it, so a multi-association user
          like Pat can jump between their companies from anywhere in the portal. */}
      {associations.length > 1 && lawFirmId && (
        <div className="px-4 pb-1 pt-2">
          <SectionLabel gap="1.5" className="px-0">
            Client Account
          </SectionLabel>
          <Dropdown
            value={activeClientRecordId || ''}
            onChange={(id) => onSwitchClientRecord?.(id)}
            options={associations.map((a) => ({ label: a.clientName, value: a.clientRecordId }))}
            placeholder="Choose an account"
            ariaLabel="Switch client account"
            buttonClassName="!rounded-xl !py-2 text-[13px] bg-surface-alt"
          />
        </div>
      )}

      {/* Navigation */}
      <nav
        aria-label="Client portal"
        ref={highlight.containerRef}
        className="relative flex-1 px-3 overflow-y-auto overflow-x-hidden styled-scrollbar"
      >
        <SectionLabel gap="2" className="px-3 mt-2">
          Portal
        </SectionLabel>
        <SidebarActiveHighlight rect={highlight.rect} />
        {items.map((item) => {
          const Icon = item.icon;
          const active = isActive(item);
          const pending = !!pendingHref && pendingHref.startsWith(item.href);
          const highlighted = pending || (active && !pendingHref);
          return (
            <Link
              key={item.name}
              ref={highlight.registerItem(item.name)}
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={(e) => {
                // A modified click (⌘/Ctrl/Shift/Alt, or a non-primary button)
                // opens the href in a new tab or window and leaves THIS tab on
                // the page it was already on. Next's Link bails out of client
                // navigation for those, so flagging a pending navigation would
                // park the layout's blocking spinner over a route that is never
                // going to change.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                setMobileOpen(false);
                if (active) return;
                onNavigate?.(item.href);
              }}
              className={`relative z-10 flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-[color,transform] duration-150 active:scale-[0.96] mb-0.5 cursor-pointer ${
                highlighted
                  ? "text-accent-emphasis"
                  : "text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface"
              }`}
            >
              <div className="flex items-center gap-3">
                <Icon size={17} strokeWidth={highlighted ? 2.2 : 1.8} />
                {item.name}
              </div>
              {/* The pill is taller than the label line; the negative margin keeps it
                 from stretching the row when an unread count appears. */}
              {item.name === "Messages" && unreadCount > 0 && (
                <CountPill count={unreadCount} tone="accent" max={99} className="-my-1" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* User */}
      <div className="px-4 py-4 border-t border-outline-subtle">
        <div className="flex items-center gap-2.5">
          {/* Account settings are per-user, so this is deliberately outside the
              firm-scoped nav above: a client whose firm removed them still needs
              to reach their profile, data export, and account deletion. Clicking
              the identity row opens a popup rather than navigating straight
              there, so logout stays reachable from it too. */}
          <button
            type="button"
            data-item-menu-trigger
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
            onClick={(e) => {
              setAccountMenuAnchor(menuPositionFromEvent(e));
              setAccountMenuOpen((open) => !open);
            }}
            className="flex items-center gap-2.5 min-w-0 flex-1 rounded-lg -m-1 p-1 hover:bg-surface-hover transition-colors cursor-pointer"
          >
            <Avatar size="sm" photoUrl={photoUrl} name={displayName} email={user?.email} />
            <p className="text-xs font-semibold text-on-surface truncate">{displayName || "User"}</p>
          </button>
          {lawFirmId && <ClientNotificationBell lawFirmId={lawFirmId} />}
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-14 bg-surface flex items-center justify-between px-4 z-50 print:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={mobileOpen}
          aria-controls={mobileDrawerId}
          className="p-2 -ml-2 rounded-lg text-on-surface hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
        >
          <Menu size={22} strokeWidth={1.8} />
        </button>
        <ParalegixLogo width={120} height={36} priority />
        <div className="flex items-center gap-1">
          {lawFirmId && <ClientNotificationBell lawFirmId={lawFirmId} compact />}
          <Avatar size="sm" photoUrl={photoUrl} name={displayName} email={user?.email} />
        </div>
      </div>

      {/* Mobile drawer backdrop */}
      {mobileBackdropAnim.mounted && (
        <div
          className={`md:hidden fixed inset-0 bg-black/40 z-50 print:hidden ${backdropAnim(mobileBackdropAnim.exiting)}`}
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        ref={dialogRef}
        id={mobileDrawerId}
        role="dialog"
        aria-label="Client navigation"
        aria-modal={mobileOpen ? true : undefined}
        aria-hidden={!mobileOpen}
        inert={!mobileOpen}
        tabIndex={-1}
        className={`md:hidden fixed top-0 left-0 h-screen w-[270px] bg-surface border-r border-outline flex flex-col z-50 print:hidden transition-transform duration-200 ease-out ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <button
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation menu"
          className="absolute top-4 right-3 p-1.5 rounded-lg text-on-surface-muted hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
        >
          <X size={18} strokeWidth={2} />
        </button>
        {renderSidebarContent(mobileHighlight)}
      </aside>

      {/* Desktop sidebar */}
      <aside inert={mobileOpen} aria-hidden={mobileOpen || undefined} className="hidden md:flex fixed top-0 left-0 h-screen w-[220px] bg-surface border-r border-outline flex-col z-40 print:hidden">
        {renderSidebarContent(desktopHighlight)}
      </aside>

      <ItemActionMenu
        portalContainer={mobileOpen ? dialogRef.current : undefined}
        open={accountMenuOpen}
        anchorTop={accountMenuAnchor.anchorTop}
        anchorBottom={accountMenuAnchor.anchorBottom}
        left={accountMenuAnchor.left}
        align="left"
        onClose={() => setAccountMenuOpen(false)}
        header={
          <Link
            href="/account"
            onClick={(e) => {
              setAccountMenuOpen(false);
              setMobileOpen(false);
              if (pathname === "/account") {
                e.preventDefault();
                return;
              }
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              onNavigate?.("/account");
            }}
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-surface-hover transition-colors"
          >
            <Avatar size="sm" photoUrl={photoUrl} name={displayName} email={user?.email} />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-on-surface truncate">{displayName || "User"}</p>
              {user?.email && (
                <p className="text-xs text-on-surface-muted truncate">{user.email}</p>
              )}
            </div>
          </Link>
        }
        actions={[
          {
            key: "logout",
            label: signingOut ? "Logging out…" : "Log out",
            icon: signingOut ? <Spinner size={15} /> : <LogOut size={15} strokeWidth={1.8} />,
            danger: true,
            disabled: signingOut,
            onClick: handleLogout,
          },
        ]}
      />
    </>
  );
};

export default ClientSidebar;
