'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useParams } from 'next/navigation';
import { Settings as SettingsIcon, Users, Briefcase, Palette, Shield, CreditCard, Crown, Bell, Rocket } from 'lucide-react';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useFirmSettings } from '@/contexts/FirmSettingsContext';
import { useGetStartedProgress } from '@/hooks/useGetStartedProgress';
import LoadingSpinner from '@/components/LoadingSpinner';
import AccessDeniedPage from '@/components/ui/AccessDeniedPage';
import PageHeader from '@/components/ui/PageHeader';
import PanelLoadingSpinner from '@/components/ui/PanelLoadingSpinner';
import Card from '@/components/ui/Card';


export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const pathname = usePathname();
  const [pendingTab, setPendingTab] = useState<string | null>(null);
  const { hasPermission, loading } = usePermissions();
  const { features } = useFirmSettings();
  const { complete: getStartedComplete } = useGetStartedProgress(lawFirmId);
  const canViewFirmSettings = hasPermission('settings.viewFirm');
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const activeTabRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the pending tab indicator once the route (pathname) changes
    setPendingTab(null);
  }, [pathname]);

  // `permission` hides a tab whose page reads need more than the settings
  // baseline, so a member never lands on reads the backend refuses.
  const allTabs: { label: string; href: string; icon: typeof SettingsIcon; feature?: keyof typeof features; hideWhenComplete?: boolean; permission?: string }[] = [
    { label: 'Getting Started', href: `/lawfirm/${lawFirmId}/settings/getting-started`, icon: Rocket, hideWhenComplete: true },
    { label: 'General', href: `/lawfirm/${lawFirmId}/settings/general`, icon: SettingsIcon },
    { label: 'Members', href: `/lawfirm/${lawFirmId}/settings/members`, icon: Users },
    { label: 'Subscriptions', href: `/lawfirm/${lawFirmId}/settings/billing`, icon: Crown },
    { label: 'Payments', href: `/lawfirm/${lawFirmId}/settings/payments`, icon: CreditCard, permission: 'billing.viewInvoices' },
    { label: 'Roles', href: `/lawfirm/${lawFirmId}/settings/roles`, icon: Shield },
    { label: 'Notifications', href: `/lawfirm/${lawFirmId}/settings/notifications`, icon: Bell },
    { label: 'Matter Config', href: `/lawfirm/${lawFirmId}/settings/matter-config`, icon: Briefcase },
    { label: 'Customization', href: `/lawfirm/${lawFirmId}/settings/customization`, icon: Palette },
  ];

  const tabs = allTabs
    .filter((tab) => !tab.feature || features[tab.feature])
    .filter((tab) => !tab.permission || hasPermission(tab.permission))
    .filter((tab) => !tab.hideWhenComplete || !getStartedComplete);

  const isCurrentPath = (href: string) =>
    pathname === href || pathname.startsWith(href + '/');

  const isActive = (href: string) =>
    pendingTab ? href === pendingTab : isCurrentPath(href);

  const handleTabClick = (href: string) => {
    if (isCurrentPath(href)) return;
    setPendingTab(href);
  };

  useEffect(() => {
    const container = scrollContainerRef.current;
    const activeEl = activeTabRef.current;
    if (!container || !activeEl) return;
    try {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    } catch {
      // ignore scroll errors
    }
  }, [pathname, pendingTab]);

  if (loading) {
    return <LoadingSpinner fullPage />;
  }

  if (!canViewFirmSettings) {
    return (
      <AccessDeniedPage
        title="You do not have permission to view firm settings"
        description="This settings area is limited to roles with firm configuration access."
      />
    );
  }

  return (
    <div className="min-h-screen bg-page overflow-x-hidden">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <div className="p-4 pl-5 md:p-6 max-w-[1600px] mx-auto space-y-6 min-w-0">
        <PageHeader
          eyebrow="Settings"
          title="Firm Configuration"
          description="Manage your account, team members, practice areas, and billing codes."
        />

        {/* Tab Navigation */}
        <nav
          aria-label="Settings sections"
          ref={scrollContainerRef}
          className="min-w-0"
        >
          <div className="flex flex-wrap gap-2">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = isActive(tab.href);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  onClick={() => handleTabClick(tab.href)}
                  ref={active ? activeTabRef : undefined}
                  className={[
                    'flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all whitespace-nowrap',
                    active
                      ? 'bg-accent-solid text-accent-foreground border border-accent-solid shadow-sm shadow-black/10'
                      : 'bg-surface text-on-surface-secondary border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] hover:shadow-md hover:border-accent-border-soft',
                  ].join(' ')}
                >
                  <Icon size={16} strokeWidth={active ? 2.2 : 1.8} />
                  {tab.label}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Page Content */}
        {pendingTab ? (
          <Card>
            <PanelLoadingSpinner label="Loading settings" />
          </Card>
        ) : (
          <Card className="min-w-0">
            {children}
          </Card>
        )}
      </div>
    </div>
  );
}
