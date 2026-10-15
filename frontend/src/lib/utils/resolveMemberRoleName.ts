import type { Member } from '@/types/member';
import type { Role } from '@/types/role';

export function roleDisplayLabel(value?: string | null) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  const compact = normalized.replace(/[\s_-]+/g, '');
  if (compact === 'owner') return 'Owner';
  if (compact === 'admin') return 'Admin';
  if (compact === 'attorney') return 'Attorney';
  if (compact === 'paralegal') return 'Paralegal';
  if (compact === 'staff' || compact === 'member') return 'Staff';

  return normalized[0].toUpperCase() + normalized.slice(1);
}

/**
 * Display name for a member's role. The custom role assigned by `roleId` wins;
 * `role` is the name the members endpoint derives from that same row (or the
 * bare 'owner'/'member' fallback it uses when no custom role is assigned).
 */
export function resolveMemberRoleName(member: Member, roleMap: Map<string, Role>) {
  if (member.isOwner) return 'Owner';
  if (member.roleId && roleMap.has(member.roleId)) {
    return roleMap.get(member.roleId)!.name;
  }

  const label = roleDisplayLabel(member.role);
  if (label) return label;

  return 'Staff';
}
