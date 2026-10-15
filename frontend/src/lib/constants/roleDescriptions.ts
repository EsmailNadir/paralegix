/**
 * One-line, plain-English summary of what each built-in role grants, shown to
 * whoever is picking a role (inviting a member, changing someone's role) so
 * the choice is informed without having to go check the Roles settings page.
 * Keep in sync with BUILT_IN_ROLES in backend/src/modules/lawfirms/roles/permissions.ts.
 */
export const BUILT_IN_ROLE_DESCRIPTIONS: Record<string, string> = {
  Owner: 'Full control of the firm, including billing, deleting the firm, and transferring ownership.',
  Admin: 'Full access to everything except transferring firm ownership.',
  Attorney: 'Full access to matters, billing, trust accounts, and client management.',
  Paralegal: 'Day-to-day matter and billing work, without deleting matters, managing invoices, or trust funds.',
  Staff: 'Read-only access to matters, tasks, clients, and contacts, plus file uploads and messaging. Cannot edit records or see financial information.',
};

/** Falls back to a permission count for custom roles, which have no fixed description. */
export function describeRole(role: { name: string; permissions?: string[] | null }): string {
  const builtIn = BUILT_IN_ROLE_DESCRIPTIONS[role.name];
  if (builtIn) return builtIn;
  const count = role.permissions?.length ?? 0;
  return `Custom role: ${count} permission${count === 1 ? '' : 's'} selected.`;
}
