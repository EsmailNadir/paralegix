import type { Matter } from '@/types/matter';

type LeadUser = { uid: string; name?: string | null; email?: string | null };

/** Resolve the current lead set using live user labels when the caller has them. */
export function getMatterLeadNames(
  matter: (Pick<Matter, 'members' | 'leadUserIds'> & { leadUserId?: string | null; leadUserName?: string | null }) | null | undefined,
  users: readonly LeadUser[] = [],
): string[] {
  if (!matter) return [];

  // When `leadUserIds` is explicitly provided, it is the authoritative set of leads.
  // An empty array means the matter intentionally has no leads (do not fall back to stale leadUserName).
  if (matter.leadUserIds != null) {
    const members = matter.members ?? [];
    return [...new Set(matter.leadUserIds)].map((id) => {
      const user = users.find((candidate) => candidate.uid === id);
      const member = members.find((candidate) => candidate.userId === id);
      return (user?.name || user?.email || member?.name || '').trim();
    }).filter(Boolean);
  }

  // Otherwise, fall back to embedded lead members, leadUserId, or legacy leadUserName.
  const members = matter.members ?? [];
  const ids = matter.leadUserId
    ? [matter.leadUserId]
    : members.filter((member) => member.role === 'lead').map((member) => member.userId);

  const resolved = [...new Set(ids)].map((id) => {
    const user = users.find((candidate) => candidate.uid === id);
    const member = members.find((candidate) => candidate.userId === id);
    return (user?.name || user?.email || member?.name || '').trim();
  }).filter(Boolean);

  if (resolved.length) return resolved;

  const memberNames = members
    .filter((member) => member.role === 'lead')
    .map((member) => member.name?.trim())
    .filter((name): name is string => !!name);
  if (memberNames.length) return memberNames;

  if (matter.leadUserName?.trim()) {
    return [matter.leadUserName.trim()];
  }

  return [];
}
