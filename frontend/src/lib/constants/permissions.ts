/**
 * Catalog of every permission, each with a human-friendly display `name` and a
 * `description`. The role-editing UI renders these instead of the raw
 * permission id (e.g. "View Dashboard" rather than "dashboard.view"). Keep this
 * list in sync with the backend's PERMISSIONS map.
 */
export const PERMISSIONS = {
  'dashboard.view': { name: 'View Dashboard', description: 'Access the firm dashboard overview and summary.' },

  'firm.update': { name: 'Edit Firm Info', description: "Edit the firm's name, address, and other details." },
  'firm.delete': { name: 'Delete Firm', description: 'Permanently delete the law firm.' },
  'firm.transferOwnership': { name: 'Transfer Ownership', description: 'Transfer firm ownership to another member.' },
  'firm.manageRoles': { name: 'Manage Roles', description: 'Create, edit, and delete custom roles.' },
  'firm.manageBranding': { name: 'Manage Branding', description: 'Upload or remove the firm logo and customize branding.' },
  'firm.managePreferences': { name: 'Manage Firm Preferences', description: 'Edit firm-wide preferences such as sidebar and defaults.' },
  'firm.viewAuditLog': { name: 'View Audit Log', description: 'View the firm security and data-access audit log.' },

  'members.invite': { name: 'Invite Members', description: 'Invite new members to the firm.' },
  'members.remove': { name: 'Remove Members', description: 'Remove members from the firm.' },
  'members.changeRole': { name: 'Change Member Roles', description: 'Change the role assigned to another member.' },
  'members.view': { name: 'View Members', description: "View the firm's member list." },

  'matters.create': { name: 'Create Matters', description: 'Create new matters.' },
  'matters.update': { name: 'Edit Matters', description: 'Edit matter details.' },
  'matters.delete': { name: 'Delete Matters', description: 'Delete matters.' },
  'matters.view': { name: 'View Matters', description: 'View matters.' },
  'matters.manageMembers': { name: 'Manage Matter Members', description: 'Add or remove members on a matter.' },
  'matters.manageClients': { name: 'Manage Matter Clients', description: 'Add or remove clients on a matter.' },
  'notes.viewFirmWide': { name: 'View Firm-Wide Notes', description: 'Search notes across every matter in the firm.' },

  'tasks.create': { name: 'Create Tasks', description: 'Create new tasks.' },
  'tasks.update': { name: 'Edit Tasks', description: 'Edit existing tasks.' },
  'tasks.delete': { name: 'Delete Tasks', description: 'Delete tasks.' },
  'tasks.view': { name: 'View Tasks', description: 'View tasks.' },

  'billing.viewTimeEntries': { name: 'View Time Entries', description: 'View recorded time entries.' },
  'billing.manageTimeEntries': { name: 'Manage Time Entries', description: 'Create, edit, and delete time entries.' },
  'billing.manageOthersTimeEntries': { name: 'Manage Others\' Time Entries', description: 'Edit and delete other members\' time entries, and log time on their behalf.' },
  'billing.viewInvoices': { name: 'View Invoices', description: 'View invoices.' },
  'billing.manageInvoices': { name: 'Manage Invoices', description: 'Create, edit, and send invoices.' },
  'billing.viewRates': { name: 'View Rates', description: 'View hourly rates and charge codes.' },
  'billing.manageRates': { name: 'Manage Rates', description: 'Edit charge codes and rates.' },
  'billing.recordPayments': { name: 'Record Payments', description: 'Record payments against invoices.' },
  'billing.viewPlans': { name: 'View Billing Plans', description: 'View recurring billing plans.' },
  'billing.managePlans': { name: 'Manage Billing Plans', description: 'Create and edit recurring billing plans.' },
  'billing.viewExpenses': { name: 'View Expenses', description: 'View expenses.' },
  'billing.manageExpenses': { name: 'Manage Expenses', description: 'Create, edit, and delete expenses.' },

  'clients.view': { name: 'View Clients', description: 'View client records.' },
  'clients.manage': { name: 'Manage Clients', description: 'Create, edit, and archive client records.' },
  'clients.invite': { name: 'Invite Clients', description: 'Invite new clients to the portal.' },
  'clients.erase': { name: 'Erase Clients', description: 'Permanently erase a client and their personal data.' },

  'leads.view': { name: 'View Leads', description: 'View leads in the pipeline.' },
  'leads.manage': { name: 'Manage Leads', description: 'Create, edit, and delete leads.' },
  'leads.convert': { name: 'Convert Leads', description: 'Convert a lead into a client and matter.' },
  'leads.manageStages': { name: 'Manage Lead Stages', description: 'Configure lead pipeline stages.' },

  'contacts.view': { name: 'View Contacts', description: 'View the firm contact directory.' },
  'contacts.manage': { name: 'Manage Contacts', description: 'Create, edit, and delete directory contacts.' },

  'files.view': { name: 'View Files', description: 'View and download files.' },
  'files.upload': { name: 'Upload Files', description: 'Upload new files.' },
  'files.delete': { name: 'Delete Files', description: 'Delete files.' },
  'files.manageFolders': { name: 'Manage Folders', description: 'Create, rename, move, and delete folders.' },

  'documents.request': { name: 'Manage Document Requests', description: 'Create, edit, and cancel document requests sent to clients.' },

  'calendar.view': { name: 'View Calendar', description: 'View the calendar.' },
  'calendar.sync': { name: 'Sync Calendar', description: 'Connect and sync external calendars.' },

  'messaging.view': { name: 'View Messages', description: 'View messages.' },
  'messaging.send': { name: 'Send Messages', description: 'Send messages.' },
  'messaging.manageParticipants': { name: 'Add Clients to Conversations', description: 'Add a client to an existing conversation. Adding a colleague only needs Send Messages.' },

  'settings.viewFirm': { name: 'View Firm Settings', description: 'View firm settings.' },
  'settings.manageFirm': { name: 'Manage Firm Settings', description: 'Edit firm-level settings.' },
  'settings.manageLocked': { name: 'Manage Locked Settings', description: 'Edit admin-locked settings.' },

  'signatures.view': { name: 'View Signatures', description: 'View the signatures page and sign documents.' },
  'signatures.send': { name: 'Send Signatures', description: 'Send documents to clients for signing.' },

  'trust.view': { name: 'View Trust Accounts', description: 'View trust accounts, transactions, and balances.' },
  'trust.manage': { name: 'Manage Trust Accounts', description: 'Record trust transactions and manage trust accounts.' },
  'trust.reconcile': { name: 'Reconcile Trust Accounts', description: 'Perform trust account reconciliation.' },

  'templates.view': { name: 'View Templates', description: 'View document templates.' },
  'templates.manage': { name: 'Manage Templates', description: 'Create and delete document templates.' },

  'courts.manage': { name: 'Manage Courts', description: 'Create, edit, and delete courts.' },

  'practiceAreas.view': { name: 'View Practice Areas', description: 'View practice areas.' },
  'practiceAreas.manage': { name: 'Manage Practice Areas', description: 'Create, edit, and delete practice areas.' },

  'noteTypes.view': { name: 'View Note Types', description: 'View custom note types.' },
  'noteTypes.manage': { name: 'Manage Note Types', description: 'Create, edit, and delete custom note types.' },
  'noteTemplates.view': { name: 'View Note Templates', description: 'View custom note templates.' },
  'noteTemplates.manage': { name: 'Manage Note Templates', description: 'Create, edit, and delete custom note templates.' },

} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/**
 * Baseline permissions every firm member holds regardless of their role. Kept
 * in sync with the backend's DEFAULT_PERMISSIONS. These are unioned into a
 * member's resolved permissions so baseline access always works, even for roles
 * that predate the permission.
 *
 * Scope: navigation and core collaboration pages. Invoice, time-entry, rate,
 * expense, billing-plan and trust reads require an explicit role grant. Owners
 * and built-in roles retain the permissions their role definitions grant.
 * The baseline cannot be removed from a role, so financial access is excluded.
 */
export const DEFAULT_PERMISSIONS: Permission[] = [
  'dashboard.view',
  'members.view',
  'settings.viewFirm',
  'messaging.view',
  'messaging.send',
  'calendar.view',
  'templates.view',
  'practiceAreas.view',
  'noteTypes.view',
  'noteTemplates.view',
  'matters.view',
  'tasks.view',
  'files.view',
  'signatures.view',
  'leads.view',
  'contacts.view',
  'clients.view',
];

/**
 * A manage permission is unusable without the reads its screen loads, so a role
 * that holds a manage code always holds the reads listed here. The role editor
 * ticks and locks them, and the backend applies the same map on every role
 * write. Kept equal to the backend's MANAGE_IMPLIES_VIEW; order matters because
 * implied reads are appended in the order listed.
 */
export const MANAGE_IMPLIES_VIEW: Record<string, Permission[]> = {
  'billing.manageTimeEntries': ['billing.viewTimeEntries', 'billing.viewRates'],
  'billing.manageInvoices': ['billing.viewInvoices', 'billing.viewRates'],
  'billing.recordPayments': ['billing.viewInvoices'],
  'billing.manageRates': ['billing.viewRates'],
  'billing.managePlans': ['billing.viewPlans'],
  'billing.manageExpenses': ['billing.viewExpenses'],
  'trust.manage': ['trust.view'],
  'trust.reconcile': ['trust.view'],
};

/**
 * Return `codes` de-duplicated in their given order, followed by every read a
 * held manage code implies that is not already present. Unknown codes are kept,
 * a second call returns the result unchanged, and the input is not mutated.
 */
export function withImpliedViewPermissions(codes: readonly string[]): string[] {
  const result = Array.from(new Set(codes));
  const held = new Set(result);
  for (const [manage, views] of Object.entries(MANAGE_IMPLIES_VIEW)) {
    if (!held.has(manage)) continue;
    for (const view of views) {
      if (held.has(view)) continue;
      held.add(view);
      result.push(view);
    }
  }
  return result;
}

export type BuiltInRoleKey = 'owner' | 'admin' | 'attorney' | 'paralegal' | 'staff';

export const BUILT_IN_ROLES: Record<
  BuiltInRoleKey,
  { key: BuiltInRoleKey; name: string; permissions: Permission[] }
> = {
  owner: {
    key: 'owner',
    name: 'Owner',
    permissions: [...ALL_PERMISSIONS],
  },
  admin: {
    key: 'admin',
    name: 'Admin',
    permissions: ALL_PERMISSIONS.filter((permission) => permission !== 'firm.transferOwnership'),
  },
  attorney: {
    key: 'attorney',
    name: 'Attorney',
    permissions: [
      'dashboard.view',
      'matters.create', 'matters.update', 'matters.delete', 'matters.view',
      'matters.manageMembers', 'matters.manageClients',
      'tasks.create', 'tasks.update', 'tasks.delete', 'tasks.view',
      'billing.viewTimeEntries', 'billing.manageTimeEntries', 'billing.manageOthersTimeEntries',
      'billing.viewInvoices', 'billing.manageInvoices',
      'billing.viewRates', 'billing.recordPayments',
      'billing.viewPlans', 'billing.managePlans',
      'billing.viewExpenses', 'billing.manageExpenses',
      'clients.view', 'clients.manage', 'clients.invite',
      'leads.view', 'leads.manage', 'leads.convert',
      'contacts.view', 'contacts.manage',
      'files.view', 'files.upload', 'files.delete', 'files.manageFolders',
      'documents.request',
      'calendar.view', 'calendar.sync',
      'messaging.view', 'messaging.send', 'messaging.manageParticipants',
      'signatures.view', 'signatures.send',
      'trust.view', 'trust.manage', 'trust.reconcile',
      'templates.view', 'templates.manage',
      'courts.manage',
      'practiceAreas.view',
      'noteTypes.manage', 'noteTemplates.manage',
      'members.view',
      'settings.viewFirm',
    ],
  },
  paralegal: {
    key: 'paralegal',
    name: 'Paralegal',
    permissions: [
      'dashboard.view',
      'matters.create', 'matters.update', 'matters.view',
      'matters.manageMembers', 'matters.manageClients',
      'tasks.create', 'tasks.update', 'tasks.delete', 'tasks.view',
      'billing.viewTimeEntries', 'billing.manageTimeEntries', 'billing.manageOthersTimeEntries',
      'billing.viewInvoices',
      'billing.viewRates',
      'billing.viewExpenses', 'billing.manageExpenses',
      'billing.viewPlans',
      'clients.view',
      'leads.view', 'leads.manage', 'leads.convert',
      'contacts.view', 'contacts.manage',
      'files.view', 'files.upload', 'files.delete', 'files.manageFolders',
      'documents.request',
      'calendar.view', 'calendar.sync',
      'messaging.view', 'messaging.send', 'messaging.manageParticipants',
      'signatures.view', 'signatures.send',
      'trust.view',
      'templates.view', 'templates.manage',
      'courts.manage',
      'practiceAreas.view',
      'noteTypes.manage', 'noteTemplates.manage',
      'members.view',
      'settings.viewFirm',
    ],
  },
  staff: {
    key: 'staff',
    name: 'Staff',
    permissions: [
      'dashboard.view',
      'matters.view',
      'tasks.view',
      'clients.view',
      'contacts.view',
      'files.view', 'files.upload',
      'messaging.view', 'messaging.send',
      'signatures.view',
      'templates.view',
      'practiceAreas.view',
      'members.view',
      'settings.viewFirm',
    ],
  },
};

type MemberPermissionLike = {
  isOwner?: boolean;
  resolvedPermissions?: string[];
  permissions?: string[];
  roleId?: string | null;
  role?: string | null;
};

function normalizedRoleValue(role?: string | null) {
  if (!role) return null;
  const trimmed = role.trim().toLowerCase();
  return trimmed || null;
}

function roleKeyFromValue(value?: string | null): BuiltInRoleKey | null {
  if (!value) return null;
  // Own keys only: `in` also matches inherited names, so a firm role called
  // "Constructor" resolved to Object's constructor and had no `permissions`.
  if (Object.hasOwn(BUILT_IN_ROLES, value)) return value as BuiltInRoleKey;

  const hasToken = (token: string) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`);
    return pattern.test(value);
  };

  if (hasToken('owner')) return 'owner';
  if (hasToken('admin')) return 'admin';
  if (hasToken('attorney')) return 'attorney';
  if (hasToken('paralegal')) return 'paralegal';
  if (hasToken('staff') || hasToken('member')) return 'staff';

  return null;
}

function toKnownPermissions(permissions: string[]) {
  return permissions.filter((permission): permission is Permission => permission in PERMISSIONS);
}

export function resolveMemberPermissions(member?: MemberPermissionLike | null): Permission[] {
  if (!member) return [];
  if (member.isOwner) return [...ALL_PERMISSIONS];

  const explicit = toKnownPermissions([
    ...(Array.isArray(member.resolvedPermissions) ? member.resolvedPermissions : []),
    ...(Array.isArray(member.permissions) ? member.permissions : []),
  ]);

  if (Array.isArray(member.resolvedPermissions) || Array.isArray(member.permissions)) {
    return Array.from(new Set([...DEFAULT_PERMISSIONS, ...explicit]));
  }

  const roleKey =
    roleKeyFromValue(member.roleId?.toLowerCase() || null) ||
    roleKeyFromValue(normalizedRoleValue(member.role));

  if (!roleKey) return [...DEFAULT_PERMISSIONS];
  return Array.from(new Set([...DEFAULT_PERMISSIONS, ...BUILT_IN_ROLES[roleKey].permissions]));
}
