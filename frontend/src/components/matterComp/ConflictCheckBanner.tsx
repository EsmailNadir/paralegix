"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import mattersService from "@/services/matters.service";
import type { ConflictCheckResult } from "@/types";
import { contactCategoryMeta } from "@/constants/statusMeta";

interface ConflictCheckBannerProps {
  lawFirmId: string;
  clients: Array<{ name?: string; email?: string; organization?: string; clientType?: 'person' | 'company' | null }>;
  excludeClientIds?: string[];
}

/**
 * Names the party a match landed on, and what kind they are.
 *
 * A conflict can be a client the firm acts for or someone from the contact
 * directory - an opposing party matching at intake is at least as serious as a
 * client matching, so the line has to say which it found. The `partyType`
 * fallback covers matches produced before contacts were searched.
 */
function conflictDescription(c: ConflictCheckResult): string {
  const field = c.matchType === "organization"
    ? "Organization"
    : c.matchType === "email"
      ? "Email"
      : "Name";
  const name = c.partyName || c.clientName;
  const kind = c.partyType === "contact"
    ? contactCategoryMeta(c.contactCategory).label
    : "client";
  const match = c.matchValue ? ` “${c.matchValue}”` : "";

  if (c.matterName) {
    return name
      ? `${field}${match} matches ${kind} “${name}” on matter “${c.matterName}”.`
      : `${field}${match} matches a party on matter “${c.matterName}”.`;
  }
  return name
    ? `${field}${match} matches ${kind} “${name}” in the firm’s records.`
    : `${field}${match} matches an existing firm record.`;
}

export default function ConflictCheckBanner({ lawFirmId, clients, excludeClientIds = [] }: ConflictCheckBannerProps) {
  const [loading, setLoading] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictCheckResult[]>([]);
  const [checked, setChecked] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `clearTimeout` only cancels a pending, not-yet-fired debounce; once the
  // check itself is in flight, a later edit can't stop it. This guards
  // against an earlier edit's slower response landing after a later edit's
  // and silently showing a conflict for names the user has since changed.
  const requestIdRef = useRef(0);

  const names = clients.map((c) => c.name?.trim()).filter(Boolean) as string[];
  const emails = clients.map((c) => c.email?.trim()).filter(Boolean) as string[];
  // An ORGANIZATION client keeps its legal name in `name` and leaves
  // `organization` empty, so reading `organization` alone never asked the
  // organization question about the very party the matter is being opened for.
  // The server-side check matches an organization name against company clients
  // AND against the people linked to them, which is how "we already act for
  // someone at this organization" surfaces at all.
  const organizations = clients
    .map((c) => (c.clientType === "company" ? c.name?.trim() : c.organization?.trim()))
    .filter(Boolean) as string[];
  const hasInput = names.length + emails.length + organizations.length > 0;

  useEffect(() => {
    if (!hasInput || !lawFirmId) {
      requestIdRef.current += 1;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets results for a debounced async conflict check
      setConflicts([]);
      setChecked(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const requestId = ++requestIdRef.current;
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const result = await mattersService.checkConflicts(lawFirmId, {
          names,
          emails,
          organizations,
          excludeClientIds,
        });
        // A later edit may have started its own check while this one was in
        // flight; a slower response here would otherwise silently show a
        // conflict (or clear one) for names the user has since changed.
        if (requestId !== requestIdRef.current) return;
        setConflicts(result.conflicts || []);
        setChecked(true);
      } catch {
        if (requestId !== requestIdRef.current) return;
        setConflicts([]);
        setChecked(false);
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lawFirmId, JSON.stringify(names), JSON.stringify(emails), JSON.stringify(organizations), JSON.stringify(excludeClientIds)]);

  if (!hasInput) return null;

  if (loading || !checked || conflicts.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-500/10 px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            Review possible conflict
          </p>
          <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
            A selected client&apos;s details match someone already known to the firm. This is not a confirmed conflict; review the relationship before creating the matter.
          </p>
          <ul className="mt-2 space-y-1">
            {conflicts.map((conflict, index) => (
              <li key={index} className="text-xs font-medium text-amber-800 dark:text-amber-300">
                {conflictDescription(conflict)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
