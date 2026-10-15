"use client";

import { useEffect, useState } from "react";
import { useNavigation } from "@/contexts/NavigationContext";
import { apiFetch } from "@/lib/utils/fetchWithTokenRefresh";

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

interface PendingInvite {
  token: string;
  lawFirmId: string;
  lawFirmName: string;
  invitedAt: string;
}

/**
 * Surfaces a member invite to another firm that couldn't be auto-joined.
 * Dismissible per-session only; the invite itself stays pending.
 */
export default function PendingMemberInviteBanner() {
  const { navigate } = useNavigation();
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    apiFetch(`${API_URL}/invitations/my-pending-member-invites`)
      .then((res) => (res.ok ? res.json() : { invites: [] }))
      .then((data) => { if (active) setInvites(data.invites || []); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const visible = invites.filter((i) => !dismissed.has(i.token));
  if (!visible.length) return null;
  const invite = visible[0];

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-accent-border-soft bg-accent-soft px-4 py-2.5 text-sm text-accent-emphasis dark:border-accent-border-soft dark:bg-accent-soft dark:text-accent-emphasis"
    >
      <span className="min-w-0 flex-1">
        You&apos;ve been invited to join <strong>{invite.lawFirmName}</strong>.
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => navigate(`/accept-member-invite?token=${invite.token}`)}
          className="rounded-md bg-accent-solid px-3 py-1 text-xs font-medium text-accent-foreground hover:bg-accent-solid-hover dark:bg-accent-solid dark:hover:bg-accent-solid"
        >
          View Invite
        </button>
        <button
          type="button"
          onClick={() => setDismissed((prev) => new Set(prev).add(invite.token))}
          className="rounded-md px-2 py-1 text-xs font-medium text-accent-emphasis hover:bg-accent-soft dark:text-accent-emphasis dark:hover:bg-accent-soft"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
