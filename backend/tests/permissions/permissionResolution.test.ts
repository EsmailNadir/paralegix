/**
 * The permission decision layer, which decides who may act.
 *
 * The coverage baseline for this suite put `roles/permissions.ts` at 36.8%
 * statements and ZERO percent branch coverage. Every branch of the role-to-
 * permission mapping was unexecuted, in the one file whose entire job is
 * answering "may this person do this". The route-level specs exercise the
 * decision only through whatever role they happen to seed, so a wrong answer
 * for a role no spec uses is invisible.
 *
 * Pure functions and table structure, deliberately with no database. The
 * behaviour under test is a mapping, and putting a route in front of it would
 * let a pass be explained by the route's own guards instead.
 *
 * `roleEscalation.test.ts` covers the separate question of who may GRANT a
 * permission, through real routes. This file covers what a granted permission
 * resolves to.
 */
import '../support/setupInProcess';

import {
  ALL_PERMISSIONS,
  BUILT_IN_ROLES,
  DEFAULT_PERMISSIONS,
  PERMISSIONS,
  hasPermission,
  isAdmin,
} from '../../src/modules/lawfirms/roles/permissions';
import { resolveFromRolePermissions } from '../../src/modules/lawfirms/roles/roles.service';

describe('resolveFromRolePermissions covers each documented branch', () => {
  it('gives a non-member nothing', () => {
    // The ONLY input that resolves to an empty list. Every branch below returns
    // the baseline or more, which is why a test fixture representing "a member
    // with no permissions" describes nobody.
    expect(resolveFromRolePermissions(null, [])).toEqual([]);
    expect(resolveFromRolePermissions(undefined, ['matters.view'])).toEqual([]);
  });

  it('gives an owner everything, whatever their role says', () => {
    // Checked before the role is consulted, so an owner assigned a narrow role
    // is still an owner. A resolver that read the role first would lock a firm
    // owner out of their own firm.
    expect(resolveFromRolePermissions({ isOwner: true, roleId: 'narrow-role' }, ['matters.view']))
      .toEqual(ALL_PERMISSIONS);
  });

  it('gives a member with no role exactly the baseline', () => {
    const resolved = resolveFromRolePermissions({ isOwner: false, roleId: null }, null);

    expect(resolved).toEqual([...DEFAULT_PERMISSIONS]);
    expect(resolved).not.toContain('matters.manage');
  });

  it('unions a role with the baseline rather than replacing it', () => {
    // The baseline can never be removed from a role. A resolver that returned
    // only the role's own array would take `messaging.send` away from every
    // narrow role, and nothing in the UI would explain why.
    const resolved = resolveFromRolePermissions(
      { isOwner: false, roleId: 'role-1' },
      ['matters.manage'],
    );

    expect(resolved).toContain('matters.manage');
    for (const code of DEFAULT_PERMISSIONS) expect(resolved).toContain(code);
  });

  it('falls back to the baseline when the assigned role has gone', () => {
    // A deleted role must degrade to the baseline, not to nothing. Resolving to
    // an empty list here would present a member as a non-member, and the
    // read-only degradation rule this product follows would have nothing to
    // degrade to.
    const resolved = resolveFromRolePermissions({ isOwner: false, roleId: 'deleted-role' }, undefined);

    expect(resolved).toEqual([...DEFAULT_PERMISSIONS]);
  });

  it('de-duplicates a role that restates a baseline code', () => {
    const resolved = resolveFromRolePermissions(
      { isOwner: false, roleId: 'role-1' },
      ['matters.view', 'matters.view', 'clients.view'],
    );

    expect(resolved.filter((p: string) => p === 'matters.view')).toHaveLength(1);
  });

  it('ignores a role whose permissions are not an array', () => {
    // Defensive, and reachable: the column is JSON, so a bad write or an older
    // row can hold a string or null. Spreading a string would resolve to a set
    // of single CHARACTERS, none of which is a real permission, silently
    // stripping the member back to nothing recognisable.
    const resolved = resolveFromRolePermissions({ isOwner: false, roleId: 'r' }, 'matters.view');

    expect(resolved).toEqual([...DEFAULT_PERMISSIONS]);
  });
});

describe('the enforcement switch', () => {
  it('gives EVERY member everything when RBAC_ENFORCED is not "true"', () => {
    // The most consequential branch in the file, and the one the suite can
    // never reach normally: `tests/support/db.ts` pins RBAC_ENFORCED to 'true'
    // precisely so the RBAC half of the suite means something. A deployment
    // without that variable set resolves every firm member to ALL_PERMISSIONS.
    //
    // Reached with an isolated module registry, because the flag is captured
    // into a module-level const at import time.
    jest.isolateModules(() => {
      const previous = process.env.RBAC_ENFORCED;
      process.env.RBAC_ENFORCED = 'false';
      try {
        const svc = require('../../src/modules/lawfirms/roles/roles.service');
        const perms = require('../../src/modules/lawfirms/roles/permissions');

        const resolved = svc.resolveFromRolePermissions(
          { isOwner: false, roleId: 'the-narrowest-role' },
          [],
        );

        expect(resolved).toEqual(perms.ALL_PERMISSIONS);
        expect(resolved).toContain('firm.delete');
      } finally {
        process.env.RBAC_ENFORCED = previous;
      }
    });
  });

  it('is enforced in this suite, so every other case here means something', () => {
    // The control. Without it the case above could pass in a process where
    // enforcement was off for everyone, and every narrow-role assertion in this
    // file would be vacuous.
    expect(process.env.RBAC_ENFORCED).toBe('true');
    expect(resolveFromRolePermissions({ isOwner: false, roleId: 'r' }, []))
      .not.toEqual(ALL_PERMISSIONS);
  });
});

describe('hasPermission', () => {
  it('refuses a missing member', () => {
    expect(hasPermission(null, 'matters.view')).toBe(false);
    expect(hasPermission(undefined, 'matters.view')).toBe(false);
  });

  it('accepts anything for an owner', () => {
    expect(hasPermission({ isOwner: true, resolvedPermissions: [] }, 'firm.delete')).toBe(true);
  });

  it('reads the resolved list for a non-owner', () => {
    const member = { isOwner: false, resolvedPermissions: ['matters.view'] };

    expect(hasPermission(member, 'matters.view')).toBe(true);
    expect(hasPermission(member, 'matters.manage')).toBe(false);
  });

  it('refuses when the member has no resolved list at all', () => {
    // Not the same as an empty list, and both must refuse. A member row read
    // through a path that forgot to resolve permissions must not be treated as
    // permitted by default.
    expect(hasPermission({ isOwner: false }, 'matters.view')).toBe(false);
  });

});

describe('isAdmin', () => {
  it('treats the owner as admin', () => {
    expect(isAdmin({ isOwner: true, resolvedPermissions: [] })).toBe(true);
  });

  it('treats firm.update as the admin indicator', () => {
    expect(isAdmin({ isOwner: false, resolvedPermissions: ['firm.update'] })).toBe(true);
  });

  it('refuses a member holding everything EXCEPT firm.update', () => {
    // The negative that makes the rule mean something. Without it, a function
    // returning true for any non-empty permission list would pass.
    const nearlyEverything = ALL_PERMISSIONS.filter((p: string) => p !== 'firm.update');

    expect(isAdmin({ isOwner: false, resolvedPermissions: nearlyEverything })).toBe(false);
  });

  it('refuses a member with no resolved list', () => {
    expect(isAdmin({ isOwner: false })).toBe(false);
  });
});

describe('the permission tables are internally consistent', () => {
  it('lists every built-in role permission in PERMISSIONS', () => {
    // A typo in a built-in role grants NOTHING, because the code is compared by
    // string equality against what the middleware asks for. It fails silently:
    // the role looks populated in the UI and the member is refused everywhere
    // the misspelt code was meant to allow.
    const known = new Set(Object.keys(PERMISSIONS));
    const unknown: string[] = [];

    for (const [key, role] of Object.entries(BUILT_IN_ROLES as Record<string, any>)) {
      for (const code of role.permissions) {
        if (!known.has(code)) unknown.push(`${key}: ${code}`);
      }
    }

    expect(unknown).toEqual([]);
  });

  it('lists every baseline permission in PERMISSIONS', () => {
    const known = new Set(Object.keys(PERMISSIONS));

    expect(DEFAULT_PERMISSIONS.filter((code: string) => !known.has(code))).toEqual([]);
  });

  it('derives ALL_PERMISSIONS from PERMISSIONS, with nothing missing', () => {
    expect(ALL_PERMISSIONS).toEqual(Object.keys(PERMISSIONS));
    expect(ALL_PERMISSIONS.length).toBeGreaterThan(0);
  });

  it('gives the owner role everything and the admin role everything but ownership transfer', () => {
    // The one deliberate difference between the two strongest built-in roles.
    // An admin who could transfer ownership could take the firm.
    expect(BUILT_IN_ROLES.owner.permissions).toEqual(ALL_PERMISSIONS);
    expect(BUILT_IN_ROLES.admin.permissions).not.toContain('firm.transferOwnership');
    expect(BUILT_IN_ROLES.admin.permissions).toHaveLength(ALL_PERMISSIONS.length - 1);
  });

  it('keeps every built-in role at or above the baseline once resolved', () => {
    // Resolution unions the baseline in, so this holds for any role. Pinned
    // because a role defined as a strict subset would otherwise look narrower
    // in the table than it behaves at runtime, and a reader would trust the
    // table.
    for (const [key, role] of Object.entries(BUILT_IN_ROLES as Record<string, any>)) {
      const resolved = resolveFromRolePermissions({ isOwner: false, roleId: key }, role.permissions);
      for (const code of DEFAULT_PERMISSIONS) {
        expect(resolved).toContain(code);
      }
    }
  });
});
