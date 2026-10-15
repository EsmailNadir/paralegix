"use client";

import { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { usePermissions } from "@/contexts/PermissionsContext";
import AccessDeniedPage from "@/components/ui/AccessDeniedPage";
import StatusPage from "@/components/ui/StatusPage";
import LoadingSpinner from "@/components/LoadingSpinner";

type PermissionProp = string | string[];

export default function RequirePermission({
  permission,
  mode = "any",
  fallback = null,
  page = false,
  deniedTitle,
  deniedDescription,
  children,
}: {
  permission: PermissionProp;
  mode?: "any" | "all";
  fallback?: ReactNode;
  /**
   * When true, this gate owns the whole page: it renders a full-page spinner
   * while permissions resolve, a "couldn't load" retry screen if the permission
   * load failed, and a full-page AccessDeniedPage when the permission is genuinely
   * missing (instead of the bare `fallback`/null, which shows a blank screen). Use
   * it on the top-level page wrapper; leave it off for inline gates around
   * buttons/sections, which should stay silent when denied.
   */
  page?: boolean;
  /** Optional heading/subtext for the denied screen (page mode only). */
  deniedTitle?: string;
  deniedDescription?: string;
  children: ReactNode;
}) {
  const { loading, loadError, refresh, hasPermission, hasAnyPermission, hasAllPermissions } =
    usePermissions();

  // Don't decide access until permissions have loaded, otherwise the denied
  // screen flashes before the real permission set arrives.
  if (loading) return page ? <LoadingSpinner fullPage /> : null;

  // A failed load is not a denial. In page mode, offer a retry instead of
  // wrongly telling the user they don't have access.
  if (loadError) {
    if (!page) return <>{fallback}</>;
    return (
      <StatusPage
        badge="Something went wrong"
        Icon={RefreshCw}
        title="We couldn't load your access"
        description="This is usually a connection issue. Try again in a moment."
        primaryAction={{ label: "Try again", icon: RefreshCw, onClick: () => refresh() }}
        secondaryAction={{ label: "Back to dashboard", href: "/dashboard" }}
      />
    );
  }

  const requested = Array.isArray(permission) ? permission : [permission];
  const allowed =
    mode === "all"
      ? hasAllPermissions(requested)
      : requested.length === 1
        ? hasPermission(requested[0])
        : hasAnyPermission(requested);

  if (allowed) return <>{children}</>;
  if (page) return <AccessDeniedPage title={deniedTitle} description={deniedDescription} />;
  return <>{fallback}</>;
}
