/**
 * The frontend's permission tables are a hand-kept copy of the backend's. The
 * backend is the authority, so every list below must equal it exactly: a code
 * missing here hides a control a role holds, and an extra one offers a control
 * the backend refuses.
 */
import {
  ALL_PERMISSIONS,
  BUILT_IN_ROLES,
  DEFAULT_PERMISSIONS,
  MANAGE_IMPLIES_VIEW,
  withImpliedViewPermissions,
} from '@/lib/constants/permissions';
const backend = require('../../../backend/src/modules/lawfirms/roles/permissions') as {
  ALL_PERMISSIONS: string[];
  DEFAULT_PERMISSIONS: string[];
  BUILT_IN_ROLES: Record<string, { name: string; permissions: string[] }>;
  MANAGE_IMPLIES_VIEW: Record<string, string[]>;
  withImpliedViewPermissions: (codes: string[]) => string[];
};

const sorted = (list: readonly string[]) => [...list].sort();

describe('frontend permissions mirror the backend', () => {
  it('defines the same permission codes', () => {
    expect(sorted(ALL_PERMISSIONS)).toEqual(sorted(backend.ALL_PERMISSIONS));
  });

  it('holds the same member baseline', () => {
    expect(sorted(DEFAULT_PERMISSIONS)).toEqual(sorted(backend.DEFAULT_PERMISSIONS));
  });

  it('defines the same built-in roles', () => {
    expect(Object.keys(BUILT_IN_ROLES).sort()).toEqual(Object.keys(backend.BUILT_IN_ROLES).sort());
  });

  it.each(['owner', 'admin', 'attorney', 'paralegal', 'staff'])('gives the %s role the same permissions', (key) => {
    expect(sorted(BUILT_IN_ROLES[key as keyof typeof BUILT_IN_ROLES].permissions))
      .toEqual(sorted(backend.BUILT_IN_ROLES[key].permissions));
  });
});

describe('the manage-implies-view rule mirrors the backend', () => {
  it('holds the same map, with the same keys, values and order', () => {
    expect(Object.entries(MANAGE_IMPLIES_VIEW)).toEqual(Object.entries(backend.MANAGE_IMPLIES_VIEW));
  });

  it.each([
    [[]],
    [['billing.manageTimeEntries']],
    [['billing.manageRates', 'billing.manageInvoices', 'billing.viewRates']],
    [['trust.reconcile', 'trust.manage', 'unknown.code', 'trust.reconcile']],
    [['billing.manageExpenses', 'billing.managePlans', 'billing.recordPayments', 'matters.view']],
    [Object.keys(backend.MANAGE_IMPLIES_VIEW)],
  ])('returns the backend result for %j', (input) => {
    expect(withImpliedViewPermissions(input)).toEqual(backend.withImpliedViewPermissions(input));
  });
});
