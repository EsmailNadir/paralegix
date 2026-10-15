"use client";

import { useMemo, useState, useEffect, useCallback } from "react";
import Link from "next/link";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import { usePathname, useParams, useRouter } from "next/navigation";
import {
  Home,
  Briefcase,
  CalendarDays,
  ClipboardCheck,
  FolderOpen,
  LogOut,
  Settings,
  MessageSquare,
  Users,
  Contact,
  Menu,
  X,
  PenLine,
  Receipt,
  Landmark,
  FileText,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import authService from "@/services/auth.service";
import { Avatar } from "@/components/ui/Avatar";
import ItemActionMenu, { menuPositionFromEvent } from "@/components/ui/ItemActionMenu";
import { useUnreadCount } from "@/hooks/useUnreadCount";
import NotificationBell from "@/components/notificationComp/NotificationBell";
import { usePreferences } from "@/contexts/PreferencesContext";
import { useFirmSettings } from "@/contexts/FirmSettingsContext";
import { useProfile } from "@/contexts/ProfileContext";
import { SIDEBAR_FEATURE_REQUIREMENTS } from "@/types/preferences";
import type { SidebarItemKey } from "@/types/preferences";
import { useMountTransition } from "@/hooks/useMountTransition";
import { backdropAnim } from "@/components/ui/transitionClasses";
import Spinner from "@/components/ui/Spinner";
import useSlidingHighlight from "@/hooks/useSlidingHighlight";
import TrialBanner from "@/components/billingComp/TrialBanner";
import type { BillingStatus } from "@/types/subscription";
import { SIDEBAR_RESELECT_EVENT } from "@/contexts/NavigationContext";
import SidebarActiveHighlight from "./SidebarActiveHighlight";
import SectionLabel from "@/components/ui/SectionLabel";
import CountPill from "@/components/ui/CountPill";

// Static registry: key → display metadata
const SIDEBAR_ITEM_REGISTRY: Record<
  SidebarItemKey,
  { name: string; icon: LucideIcon; hrefFn: (lawFirmId: string) => string }
> = {
  dashboard: { name: "Dashboard", icon: Home, hrefFn: (id) => `/lawfirm/${id}` },
  matters: { name: "Matters", icon: Briefcase, hrefFn: (id) => `/lawfirm/${id}/matters` },
  tasks: { name: "Tasks", icon: ClipboardCheck, hrefFn: (id) => `/lawfirm/${id}/tasks` },
  messages: { name: "Messages", icon: MessageSquare, hrefFn: (id) => `/lawfirm/${id}/messages` },
  calendar: { name: "Calendar", icon: CalendarDays, hrefFn: (id) => `/lawfirm/${id}/calendar` },
  billing: { name: "Billing", icon: Receipt, hrefFn: (id) => `/lawfirm/${id}/billing` },
  files: { name: "Files", icon: FolderOpen, hrefFn: (id) => `/lawfirm/${id}/files` },
  clients: { name: "Clients", icon: Users, hrefFn: (id) => `/lawfirm/${id}/clients` },
  contacts: { name: "Contacts", icon: Contact, hrefFn: (id) => `/lawfirm/${id}/contacts` },
  signatures: { name: "E-Signatures", icon: PenLine, hrefFn: (id) => `/lawfirm/${id}/signatures` },
  trust: { name: "Trust Accounting", icon: Landmark, hrefFn: (id) => `/lawfirm/${id}/trust` },
  templates: { name: "Templates", icon: FileText, hrefFn: (id) => `/lawfirm/${id}/templates` },
};

interface LawFirmSidebarNavProps {
  pendingHref?: string | null;
  onNavigate?: (href: string) => void;
  billingStatus?: BillingStatus | string | null;
  trialEndsAt?: string | null;
}

const LawFirmSidebarNav = ({
  pendingHref = null,
  onNavigate,
  billingStatus,
  trialEndsAt,
}: LawFirmSidebarNavProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useAuth();
  const { lawFirmId } = useParams<{ lawFirmId: string }>();
  const { unreadCount } = useUnreadCount(lawFirmId);
  const { sidebar } = usePreferences();
  const { features } = useFirmSettings();
  const { profile } = useProfile();
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileBackdropAnim = useMountTransition(mobileOpen, 100);
  const [signingOut, setSigningOut] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountMenuAnchor, setAccountMenuAnchor] = useState({ anchorTop: 0, anchorBottom: 0, right: 0, left: 0 });
  // Read straight from the profile the layout already fetched (shared via
  // ProfileContext), so the footer identity costs no extra /users/profile
  // request. Editing it happens on /account, which is outside this layout - 
  // returning here remounts the layout and refetches, so there is nothing to
  // keep in sync while mounted.
  const photoUrl = profile?.photoUrl ?? null;
  // The stored profile name is what colleagues and clients see on this user, so
  // it wins over the Firebase display name (a mirror that can lag behind it).
  const displayName = profile?.name || user?.displayName || null;

  // Close drawer on route change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- closes the mobile drawer in response to route changes
    setMobileOpen(false);
  }, [pathname]);

  // Build nav items from preferences, then always append Settings
  const navItems = useMemo(() => {
    const items: { name: string; href: string; icon: LucideIcon; key: string }[] = [];
    const seenKeys = new Set<string>();

    for (const item of sidebar.items) {
      if (!item.visible) continue;
      if (seenKeys.has(item.key)) continue;
      const reg = SIDEBAR_ITEM_REGISTRY[item.key];
      if (!reg) continue;

      const requiredFeature = SIDEBAR_FEATURE_REQUIREMENTS[item.key];
      if (requiredFeature && !features[requiredFeature]) {
        continue;
      }

      items.push({
        key: item.key,
        name: reg.name,
        href: reg.hrefFn(lawFirmId),
        icon: reg.icon,
      });
      seenKeys.add(item.key);
    }

    // Settings is always visible
    items.push({
      key: "settings",
      name: "Settings",
      href: `/lawfirm/${lawFirmId}/settings/general`,
      icon: Settings,
    });

    return items;
  }, [sidebar, lawFirmId, features]);

  const isActive = (item: { name: string; href: string }) => {
    if (item.name === "Dashboard") {
      return pathname === `/lawfirm/${lawFirmId}`;
    }
    if (item.name === "Settings") {
      return pathname.startsWith(`/lawfirm/${lawFirmId}/settings`);
    }
    if (item.name === "Messages") {
      return pathname.startsWith(`/lawfirm/${lawFirmId}/messages`);
    }
    if (item.name === "Clients") {
      return pathname.startsWith(`/lawfirm/${lawFirmId}/clients`);
    }
    return pathname === item.href || pathname.startsWith(item.href + "/");
  };

  const wouldBeActiveAt = (item: { name: string; href: string }, path: string) => {
    if (item.name === "Dashboard") return path === item.href;
    if (item.name === "Settings") return path.startsWith(item.href);
    if (item.name === "Messages") return path.startsWith(item.href);
    if (item.name === "Clients") return path.startsWith(item.href);
    return path === item.href || path.startsWith(item.href + "/");
  };

  // Single key driving the sliding highlight, mirroring each item's own
  // `highlighted` check below (pending target wins over the current route so
  // the pill starts moving the instant a click lands, not once the route
  // actually changes).
  const activeItemKey = useMemo(() => {
    const item = navItems.find((candidate) => {
      const active = isActive(candidate);
      const pending = pendingHref === candidate.href;
      const navigatingToChild = !!pendingHref && wouldBeActiveAt(candidate, pendingHref);
      return pending || navigatingToChild || (active && !pendingHref);
    });
    return item?.key ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isActive/wouldBeActiveAt close over pathname, which is already a dep
  }, [navItems, pathname, pendingHref]);

  // Rendered twice (mobile drawer + desktop aside), so each needs its own
  // hook instance -- sharing one would have both DOM subtrees fight over the
  // same item-ref map.
  const mobileHighlight = useSlidingHighlight<HTMLElement>(activeItemKey);
  const desktopHighlight = useSlidingHighlight<HTMLElement>(activeItemKey);

  const handleLogout = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    await authService.signOutUser();
    router.push("/login");
  }, [signingOut, router]);

  const renderNavItem = (
    item: (typeof navItems)[0],
    registerItem: (key: string) => (el: HTMLElement | null) => void
  ) => {
    const Icon = item.icon;
    const active = isActive(item);
    const pending = pendingHref === item.href;
    const navigatingToChild = !!pendingHref && wouldBeActiveAt(item, pendingHref);
    const highlighted = pending || navigatingToChild || (active && !pendingHref);

    return (
        <Link
        key={item.key}
        ref={registerItem(item.key)}
        href={item.href}
        onClick={(e) => {
          // Only swallow the click when already exactly at the item's root --
          // `active` also covers nested/detail routes (via isActive's
          // startsWith checks), and blocking those would make the sidebar a
          // no-op for e.g. clicking "Tasks" from inside a task's detail page.
          if (pathname === item.href) {
            e.preventDefault();
            // Some sections (Files) hold their "current folder/entity" view
            // as in-page state rather than a distinct route, so there is no
            // route change for a remount to reset it. Broadcast a reselect
            // so a mounted page can reset itself back to its own root view.
            window.dispatchEvent(
              new CustomEvent(SIDEBAR_RESELECT_EVENT, { detail: { href: item.href } })
            );
            return;
          }
          // A modified click (⌘/Ctrl/Shift/Alt, or a non-primary button) opens
          // the href in a new tab or window and leaves THIS tab on the page it
          // was already on. Next's Link bails out of client navigation for
          // those, so flagging a pending navigation would park the layout's
          // blocking spinner over a route that is never going to change.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          setMobileOpen(false);
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
  };

  const renderSidebarContent = (highlight: typeof mobileHighlight) => (
    <>
      {/* Logo */}
      <div className="px-5 pt-6 pb-2">
        <Link href={`/lawfirm/${lawFirmId}`} className="block">
          <ParalegixLogo
            width={180}
            height={55}
            priority
          />
        </Link>
      </div>

      {/* Navigation */}
      <nav
        ref={highlight.containerRef}
        className="relative flex-1 px-3 overflow-y-auto overflow-x-hidden styled-scrollbar"
      >
        <SectionLabel gap="2" className="px-3 mt-2">
          Main Menu
        </SectionLabel>
        <SidebarActiveHighlight rect={highlight.rect} />
        {navItems.map((item) => renderNavItem(item, highlight.registerItem))}
      </nav>

      <TrialBanner
        lawFirmId={lawFirmId}
        billingStatus={billingStatus}
        trialEndsAt={trialEndsAt}
      />

      {/* User */}
      <div className="px-4 py-4 border-t border-outline-subtle">
        <div className="flex items-center gap-2.5">
          {/* Account settings are per-user, not per-firm, so they live outside
              this firm's Settings section - a member with no firm still needs
              them. Clicking the identity row opens a popup rather than
              navigating straight there, so logout stays reachable from it too. */}
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
          {lawFirmId && <NotificationBell lawFirmId={lawFirmId} />}
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-14 bg-surface border-b border-outline-subtle flex items-center justify-between px-4 z-50 print:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation menu"
          className="p-2 -ml-2 rounded-lg text-on-surface hover:bg-surface-hover transition-[background-color,border-color,color,transform] duration-75 active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
        >
          <Menu size={22} strokeWidth={1.8} />
        </button>
        <div className="flex items-center gap-1">
          {lawFirmId && <NotificationBell lawFirmId={lawFirmId} />}
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
      <aside className="hidden md:flex fixed top-0 left-0 h-screen w-[220px] bg-surface border-r border-outline flex-col z-40 print:hidden">
        {renderSidebarContent(desktopHighlight)}
      </aside>

      <ItemActionMenu
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

export default LawFirmSidebarNav;
