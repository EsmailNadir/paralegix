/**
 * The permission presets, pinned to what the product can actually produce.
 *
 * A preset is a claim about a person. `grantNothing()` used to claim there is a
 * firm member holding no permissions, and there is not: the baseline is unioned
 * into every member's set in two independent places, so the empty list belongs
 * to a non-member alone. A spec built on that preset asserts something about a
 * viewer the product cannot create, and it passes whatever the component does.
 *
 * These tests exist so the presets cannot drift back. They compare against
 * `resolveMemberPermissions`, the function the running app uses, rather than
 * against a copied list.
 */
import {
  DEFAULT_PERMISSIONS,
  resolveMemberPermissions,
} from '@/lib/constants/permissions';

import { mockPermissionsValue } from '../setup';
import {
  grantBaselineMember,
  grantOutsider,
  grantPermissions,
  grantReadOnly,
  resetPermissions,
} from './permissions';

/** A code no baseline holds, so a preset that grants it has widened too far. */
const MANAGE_CODE = 'clients.manage';

afterEach(() => {
  resetPermissions();
});

describe('the baseline preset matches what the app resolves for a real member', () => {
  it('grants every code a roleless member resolves to', () => {
    // Compared against the app's own resolver, not a copy of the list. A code
    // added to the baseline in src reaches this test without anyone editing it.
    const resolved = resolveMemberPermissions({ isOwner: false, resolvedPermissions: [] });

    grantBaselineMember();

    expect(resolved).toEqual([...DEFAULT_PERMISSIONS]);
    for (const code of resolved) {
      expect(mockPermissionsValue.hasPermission(code)).toBe(true);
    }
  });

  it('grants nothing beyond the baseline', () => {
    // The half that makes the preset useful. A baseline member who could manage
    // clients would satisfy every "hides the control" assertion by accident.
    grantBaselineMember();

    expect(mockPermissionsValue.hasPermission(MANAGE_CODE)).toBe(false);
    expect(DEFAULT_PERMISSIONS).not.toContain(MANAGE_CODE);
  });

  it('adds a role permission on top rather than replacing the baseline', () => {
    grantBaselineMember([MANAGE_CODE]);

    expect(mockPermissionsValue.hasPermission(MANAGE_CODE)).toBe(true);
    expect(mockPermissionsValue.hasPermission('messaging.send')).toBe(true);
    expect(mockPermissionsValue.hasAllPermissions([...DEFAULT_PERMISSIONS, MANAGE_CODE])).toBe(true);
  });

  it('is not owner, so an isOwner shortcut cannot satisfy a permission case', () => {
    grantBaselineMember();

    expect(mockPermissionsValue.isOwner).toBe(false);
  });
});

describe('the read-only preset is the narrowest REAL member', () => {
  it('holds exactly the baseline, no more and no less', () => {
    // The drift guard. This preset was previously a hand-written 9-code subset,
    // missing 13 codes every real member holds. Narrowing it again fails here.
    grantReadOnly();

    for (const code of DEFAULT_PERMISSIONS) {
      expect(mockPermissionsValue.hasPermission(code)).toBe(true);
    }
    expect(mockPermissionsValue.permissions).toEqual([...DEFAULT_PERMISSIONS]);
  });

  it('carries messaging.send, which is why it is not literally read-only', () => {
    // Recorded rather than hidden. A member who cannot reply to a message is not
    // a state the product ships, so the name is a simplification.
    grantReadOnly();

    expect(mockPermissionsValue.hasPermission('messaging.send')).toBe(true);
  });

  it('cannot manage anything', () => {
    grantReadOnly();

    expect(mockPermissionsValue.hasPermission(MANAGE_CODE)).toBe(false);
    expect(mockPermissionsValue.hasAnyPermission([MANAGE_CODE, 'settings.manageFirm'])).toBe(false);
  });
});

describe('the empty permission list belongs to a non-member only', () => {
  it('is what the app resolves for no member at all', () => {
    expect(resolveMemberPermissions(null)).toEqual([]);
    expect(resolveMemberPermissions(undefined)).toEqual([]);
  });

  it('is NOT what the app resolves for a member sent an empty list', () => {
    // The reason `grantNothing()` was wrong. Even a server response carrying
    // `resolvedPermissions: []` renders as the baseline, because the frontend
    // unions it back in independently of the backend.
    const resolved = resolveMemberPermissions({ isOwner: false, resolvedPermissions: [] });

    expect(resolved).not.toEqual([]);
    expect(resolved).toEqual([...DEFAULT_PERMISSIONS]);
  });

  it('grants an outsider nothing, including baseline reads', () => {
    grantOutsider();

    expect(mockPermissionsValue.permissions).toEqual([]);
    expect(mockPermissionsValue.hasPermission('clients.view')).toBe(false);
    expect(mockPermissionsValue.hasAnyPermission([...DEFAULT_PERMISSIONS])).toBe(false);
  });
});

describe('the shared object is restored', () => {
  it('resetPermissions puts full access back after a narrowing', () => {
    // Not decoration. The object is module-level, so a spec that narrows it and
    // does not restore hands the next spec in the file a viewer who can do
    // nothing, and that failure surfaces somewhere unrelated.
    grantOutsider();
    expect(mockPermissionsValue.hasPermission('clients.view')).toBe(false);

    resetPermissions();

    expect(mockPermissionsValue.isOwner).toBe(true);
    expect(mockPermissionsValue.hasPermission(MANAGE_CODE)).toBe(true);
    expect(mockPermissionsValue.hasAllPermissions([MANAGE_CODE, 'clients.view'])).toBe(true);
  });
});

describe('grantPermissions stays an exact set on purpose', () => {
  it('does not add the baseline, because it models a value not a person', () => {
    // Kept deliberately. A case about what a component is TOLD needs the exact
    // set. The preset above is the one to reach for when the case is a person.
    grantPermissions(['clients.view']);

    expect(mockPermissionsValue.hasPermission('clients.view')).toBe(true);
    expect(mockPermissionsValue.hasPermission('messaging.send')).toBe(false);
  });
});
