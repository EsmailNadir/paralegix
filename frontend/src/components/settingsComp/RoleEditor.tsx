"use client";

import { useMemo } from "react";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import {
  PERMISSIONS,
  DEFAULT_PERMISSIONS,
  MANAGE_IMPLIES_VIEW,
  withImpliedViewPermissions,
} from "@/lib/constants/permissions";

type PermissionKey = keyof typeof PERMISSIONS;

// Permissions every role always has (the server unions these into every member's
// resolved set), so they render as locked-on here - a role can never drop below
// this floor, which is what stops any role from being completely useless.
const BASELINE_PERMISSIONS = new Set<string>(DEFAULT_PERMISSIONS);

const DOMAIN_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  firm: "Firm",
  members: "Members",
  matters: "Matters",
  tasks: "Tasks",
  billing: "Billing",
  clients: "Clients",
  leads: "Leads",
  contacts: "Contacts",
  files: "Files",
  documents: "Document Requests",
  calendar: "Calendar",
  messaging: "Messaging",
  settings: "Settings",
  signatures: "Signatures",
  trust: "Trust Accounting",
  templates: "Templates",
  courts: "Courts",
  practiceAreas: "Practice Areas",
  noteTypes: "Note Types",
  noteTemplates: "Note Templates",
  chargeCodes: "Charge Codes",
};

function permissionDomain(permission: string) {
  return permission.split(".")[0];
}

export default function RoleEditor({
  permissions,
  onChange,
  disabled = false,
}: {
  permissions: string[];
  onChange: (permissions: string[]) => void;
  disabled?: boolean;
}) {
  const groupedPermissions = useMemo(() => {
    const entries = Object.entries(PERMISSIONS) as Array<
      [PermissionKey, { name: string; description: string }]
    >;
    const groups = new Map<string, Array<{ key: string; name: string; description: string }>>();

    entries.forEach(([key, meta]) => {
      const domain = permissionDomain(key);
      if (!groups.has(domain)) {
        groups.set(domain, []);
      }
      groups.get(domain)!.push({ key, name: meta.name, description: meta.description });
    });

    return Array.from(groups.entries()).map(([domain, items]) => ({
      domain,
      label: DOMAIN_LABELS[domain] || domain,
      items,
    }));
  }, []);

  const permissionSet = useMemo(() => new Set(permissions), [permissions]);

  // Maps each read a held manage permission implies to the names of the manage
  // permissions that imply it, so a shared read stays locked until the last one
  // is cleared.
  const impliedBy = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [manage, views] of Object.entries(MANAGE_IMPLIES_VIEW)) {
      if (!permissionSet.has(manage)) continue;
      for (const view of views) {
        map.set(view, [...(map.get(view) ?? []), PERMISSIONS[manage as PermissionKey].name]);
      }
    }
    return map;
  }, [permissionSet]);

  const togglePermission = (permission: string) => {
    if (disabled) return;
    // Baseline permissions are always granted and cannot be toggled off.
    if (BASELINE_PERMISSIONS.has(permission)) return;
    // Reads implied by a held manage permission are locked on.
    if (impliedBy.has(permission)) return;
    const next = new Set(permissionSet);
    if (next.has(permission)) {
      next.delete(permission);
    } else {
      next.add(permission);
    }
    onChange(withImpliedViewPermissions(Array.from(next)));
  };

  const selectAll = () => {
    if (disabled) return;
    onChange(Object.keys(PERMISSIONS));
  };

  const clearAll = () => {
    if (disabled) return;
    onChange([]);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-muted">
            Permissions
          </p>
          <p className="mt-1 text-[11px] text-on-surface-secondary">
            Every role always keeps a baseline (dashboard, messaging, calendar, and other basics),
            so no member is ever locked out entirely. Those are marked{" "}
            <span className="font-medium text-on-surface">Always on</span> below.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="secondary" size="small" onClick={selectAll} disabled={disabled}>
            Select All
          </Button>
          <Button type="secondary" size="small" onClick={clearAll} disabled={disabled}>
            Clear
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {groupedPermissions.map((group) => (
          <div key={group.domain} className="rounded-xl border border-outline-subtle bg-surface p-3">
            <p className="text-xs font-semibold text-on-surface mb-2">{group.label}</p>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {group.items.map((item) => {
                const isBaseline = BASELINE_PERMISSIONS.has(item.key);
                const includedWith = impliedBy.get(item.key);
                const isImplied = !isBaseline && includedWith !== undefined;
                const checked = permissionSet.has(item.key) || isBaseline || isImplied;
                const locked = disabled || isBaseline || isImplied;
                return (
                  <label
                    key={item.key}
                    className={[
                      "flex items-start gap-2 rounded-lg border px-2 py-2 transition-colors",
                      checked
                        ? "border-accent-border-soft bg-accent-soft dark:border-accent-border-soft/40 dark:bg-accent-soft"
                        : "border-outline-subtle bg-surface",
                      disabled ? "opacity-60" : isBaseline || isImplied ? "" : "cursor-pointer",
                    ].join(" ")}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={locked}
                      onChange={() => togglePermission(item.key)}
                    />
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs font-medium text-on-surface">{item.name}</p>
                        {isBaseline && (
                          <span className="rounded-full bg-surface-alt px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-on-surface-muted">
                            Always on
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-on-surface-secondary">{item.description}</p>
                      {isImplied && (
                        <p className="text-[11px] text-on-surface-muted">
                          Included with {includedWith.join(", ")}
                        </p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

