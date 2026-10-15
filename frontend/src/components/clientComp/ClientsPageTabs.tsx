"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import TabBar, { type TabBarTab } from "@/components/ui/TabBar";
import RequirePermission from "@/components/ui/RequirePermission";
import { usePermissions } from "@/contexts/PermissionsContext";
import ClientViewGrid from "@/components/clientComp/ClientViewGrid";
import LeadsGrid from "@/components/leadComp/LeadsGrid";

type Tab = "clients" | "leads";

type Props = {
  lawFirmId: string;
};

export default function ClientsPageTabs({ lawFirmId }: Props) {
  const { hasPermission } = usePermissions();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Allow deep-linking to the Leads tab via ?tab=leads (e.g. the back link
  // on a lead's detail page).
  const initialTab: Tab = searchParams.get("tab") === "leads" ? "leads" : "clients";
  const [tab, setTab] = useState<Tab>(initialTab);

  // Keep ?tab= in sync with the selected tab so a refresh lands back on the
  // tab the user is actually looking at, not a stale deep-link value.
  const handleTabChange = useCallback(
    (next: Tab) => {
      setTab(next);
      const params = new URLSearchParams(searchParams.toString());
      if (next === "leads") {
        params.set("tab", "leads");
      } else {
        params.delete("tab");
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  const tabs = useMemo(() => {
    const list: TabBarTab<Tab>[] = [{ value: "clients", label: "Clients" }];
    if (hasPermission("leads.view")) {
      list.push({ value: "leads", label: "Leads" });
    }
    return list;
  }, [hasPermission]);

  // If the user loses leads.view while on that tab, fall back to clients.
  const activeTab: Tab =
    tab === "leads" && !hasPermission("leads.view") ? "clients" : tab;

  return (
    <div>
      {tabs.length > 1 && (
        <div className="bg-page p-4 pl-5 pb-0 md:p-6 md:pb-0 max-w-[1600px] mx-auto min-w-0">
          <TabBar
            tabs={tabs}
            value={activeTab}
            onChange={handleTabChange}
            align="start"
            density="comfortable"
          />
        </div>
      )}
      {activeTab === "clients" ? (
        <ClientViewGrid lawFirmId={lawFirmId} />
      ) : (
        <RequirePermission permission="leads.view">
          <LeadsGrid lawFirmId={lawFirmId} />
        </RequirePermission>
      )}
    </div>
  );
}
