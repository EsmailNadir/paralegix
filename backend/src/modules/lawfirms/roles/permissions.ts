/**
 * All permission strings organized by domain.
 * Each role has a set of granted permissions from this list.
 */
export const PERMISSIONS = {
  // Dashboard
  'dashboard.view':          'View the firm dashboard overview/summary',

  // Firm management
  'firm.update':             'Edit law firm info (name, address, etc.)',
  'firm.delete':             'Delete the law firm',
  'firm.transferOwnership':  'Transfer ownership to another member',
  'firm.manageRoles':        'Create/edit/delete custom roles',
  'firm.manageBranding':     'Upload/delete logo, customize branding',
  'firm.managePreferences':  'Edit firm-wide preferences (sidebar, defaults)',
  'firm.viewAuditLog':       'View the firm security and data-access audit log',

  // Members
  'members.invite':          'Invite new members to the firm',
  'members.remove':          'Remove members from the firm',
  'members.changeRole':      'Change another member\'s role',
  'members.view':            'View member list',

  // Matters
  'matters.create':            'Create new matters',
  'matters.update':            'Edit matter details',
  'matters.delete':            'Delete matters',
  'matters.view':              'View matters',
  'matters.manageMembers':     'Add/remove matter members',
  'matters.manageClients':     'Add/remove clients on matters',
  'notes.viewFirmWide':        'Search notes across every matter in the firm',

  // Tasks
  'tasks.create':            'Create tasks',
  'tasks.update':            'Edit tasks',
  'tasks.delete':            'Delete tasks',
  'tasks.view':              'View tasks',

  // Billing
  'billing.viewTimeEntries': 'View time entries',
  'billing.manageTimeEntries': 'Create/edit/delete time entries',
  'billing.manageOthersTimeEntries': 'Edit and delete other members\' time entries',
  'billing.viewInvoices':    'View invoices',
  'billing.manageInvoices':  'Create/edit/send invoices',
  'billing.viewRates':       'View hourly rates and charge codes',
  'billing.manageRates':     'Edit charge codes and rates',
  'billing.recordPayments':  'Record payments on invoices',
  'billing.viewPlans':       'View recurring billing plans',
  'billing.managePlans':     'Create/edit recurring billing plans',
  'billing.viewExpenses':    'View expenses',
  'billing.manageExpenses':  'Create/edit/delete expenses',

  // Clients
  'clients.view':            'View client records',
  'clients.manage':          'Create/edit/archive client records',
  'clients.invite':          'Invite new clients',
  'clients.erase':           'Permanently erase a client and their personal data',

  // Leads
  'leads.view':              'View leads',
  'leads.manage':            'Create, edit, and delete leads',
  'leads.convert':           'Convert a lead into a client and matter',
  'leads.manageStages':      'Configure lead pipeline stages',

  // Contacts (firm-wide directory of opposing counsel, judges, experts, …)
  'contacts.view':           'View the firm contact directory',
  'contacts.manage':         'Create/edit/delete directory contacts',

  // Files
  'files.view':              'View and download files',
  'files.upload':            'Upload files',
  'files.delete':            'Delete files',
  'files.manageFolders':     'Create/rename/move/delete folders',

  // Document requests
  'documents.request':       'Create and manage document requests to clients',

  // Calendar
  'calendar.view':           'View calendar',
  'calendar.sync':           'Connect and sync external calendars',

  // Messaging
  'messaging.view':          'View messages',
  'messaging.send':          'Send messages',
  'messaging.manageParticipants': 'Add a client to an existing conversation',

  // Settings
  'settings.viewFirm':       'View firm settings',
  'settings.manageFirm':     'Edit firm-level settings',
  'settings.manageLocked':   'Edit admin-locked settings',

  // Signatures
  'signatures.view':         'View signatures page and sign documents',
  'signatures.send':         'Send documents to clients for signing',

  // Trust accounting
  'trust.view':              'View trust accounts, transactions, and balances',
  'trust.manage':            'Record trust transactions and manage trust accounts',
  'trust.reconcile':         'Perform trust account reconciliation',

  // Templates
  'templates.view':          'View document templates',
  'templates.manage':        'Create/delete document templates',

  // Courts
  'courts.manage':           'Create/edit/delete courts',

  // Practice areas & charge codes
  'practiceAreas.view':      'View practice areas',
  'practiceAreas.manage':    'Create/edit/delete practice areas',

  // Note types & templates (firm-configurable additions to the note composer)
  'noteTypes.view':          'View custom note types',
  'noteTypes.manage':        'Create custom note types',
  'noteTemplates.view':      'View custom note templates',
  'noteTemplates.manage':    'Create custom note templates',
};

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

/**
 * Baseline permissions every firm member holds regardless of their assigned
 * role. These are unioned into the resolved permission set at read time, so
 * they apply even to roles that were seeded before the permission existed (no
 * role-table backfill is required). Add a permission here to grant it to every
 * member by default. Kept in sync with the frontend's DEFAULT_PERMISSIONS.
 *
 * Scope: navigation and core collaboration pages. Invoice, time-entry, rate,
 * expense, billing-plan and trust reads require an explicit role grant. Owners
 * and built-in roles retain the permissions their role definitions grant.
 * The baseline cannot be removed from a role, so financial access is excluded.
 */
export const DEFAULT_PERMISSIONS = [
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
 * Each manage code with the read codes a role holding it must also hold. The
 * roles repository applies the map on every write (`withImpliedViewPermissions`)
 * and migration 0027 applied it to the roles that already existed, so a stored
 * role never has a manage code without its reads.
 *
 * None of these reads are in DEFAULT_PERMISSIONS, so without a grant the manage
 * screen loads and its read calls 403. Reads in the baseline (matters, tasks,
 * clients, files and the other pages every member sees) need no entry. Order
 * matters: the migration and the helper both append reads in the order listed.
 *
 *  - manageTimeEntries: the entry list is a time-entry read, and the form's
 *    charge-code picker reads charge codes and their rates.
 *  - manageInvoices: the invoice list and detail are invoice reads, and the
 *    invoice generator's manual time lines use the charge-code picker.
 *  - recordPayments: a payment is recorded on an invoice the member must open.
 *  - manageRates: the charge-code and rate editor lists what it edits.
 *  - managePlans: the plan editor lists the plans it edits.
 *  - manageExpenses: the expense list is the page that holds the edit controls.
 *  - trust.manage and trust.reconcile: accounts, ledgers and balances are trust
 *    reads, and a transaction or reconciliation form is blank without them.
 *
 * billing.manageOthersTimeEntries is not listed: it only widens
 * manageTimeEntries, which already carries the reads.
 *
 * Keep the frontend mirror in `frontend/src/lib/constants/permissions.ts` equal.
 */
export const MANAGE_IMPLIES_VIEW: Record<string, string[]> = {
  'billing.manageTimeEntries': ['billing.viewTimeEntries', 'billing.viewRates'],
  'billing.manageInvoices':    ['billing.viewInvoices', 'billing.viewRates'],
  'billing.recordPayments':    ['billing.viewInvoices'],
  'billing.manageRates':       ['billing.viewRates'],
  'billing.managePlans':       ['billing.viewPlans'],
  'billing.manageExpenses':    ['billing.viewExpenses'],
  'trust.manage':              ['trust.view'],
  'trust.reconcile':           ['trust.view'],
};

/**
 * Return `codes` de-duplicated, in their given order, followed by every read a
 * held manage code implies that is not already present. Reads are appended
 * following MANAGE_IMPLIES_VIEW's key order, then each entry's own order, so the
 * result is deterministic and a second call returns it unchanged. Codes the
 * catalog does not know are kept. The input is not mutated.
 */
export function withImpliedViewPermissions(codes: string[]): string[] {
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

/**
 * Built-in role definitions. These are seeded when a firm is created
 * and cannot be deleted (but their permissions can be customized).
 */
export const BUILT_IN_ROLES = {
  owner: {
    name: 'Owner',
    isBuiltIn: true,
    permissions: ALL_PERMISSIONS,
  },
  admin: {
    name: 'Admin',
    isBuiltIn: true,
    permissions: ALL_PERMISSIONS.filter(p => p !== 'firm.transferOwnership'),
  },
  attorney: {
    name: 'Attorney',
    isBuiltIn: true,
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
    name: 'Paralegal',
    isBuiltIn: true,
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
    name: 'Staff',
    isBuiltIn: true,
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

/**
 * Check if a member has a specific permission.
 * Owner always has all permissions.
 */
export function hasPermission(memberDoc: any, permission: any) {
  if (!memberDoc) return false;

  const data = memberDoc;

  // Owner always has all permissions
  if (data.isOwner) return true;

  // Check the role's resolved permissions
  const rolePermissions = data.resolvedPermissions || [];
  return rolePermissions.includes(permission);
}

/**
 * Check if a member has admin-equivalent access: firm owner, or a role that
 * grants firm.update (the admin-level indicator).
 */
export function isAdmin(memberDoc: any) {
  const data = memberDoc;
  if (data.isOwner) return true;

  const rolePermissions = data.resolvedPermissions || [];
  return rolePermissions.includes('firm.update');
}
