/**
 * Give a component test a real permission set.
 *
 * `tests/setup.ts` forces `hasPermission: () => true` for every spec, so the
 * read-only degradation rule (a narrow role sees read-only pages, never a denial
 * screen) has never had a test: every component renders as though the viewer can
 * do everything.
 *
 * These helpers mutate the SAME object `usePermissions()` returns, which is what
 * makes them work: `setup.ts` closes over `mockPermissionsValue` and returns it
 * by reference, so replacing its fields changes what a component sees without
 * re-mocking the module.
 *
 * Always call `resetPermissions()` in `afterEach`. The object is module-level and
 * shared, so a spec that narrows permissions and does not restore them hands the
 * next spec in the file a viewer who cannot do anything, and the failure appears
 * somewhere unrelated.
 *
 * WHICH PRESET MODELS A REAL PERSON
 * `grantBaselineMember` and `grantOutsider` are the two that correspond to
 * someone who can actually exist. Every firm member carries the baseline, and
 * only a non-member resolves to nothing. `grantPermissions` builds an arbitrary
 * set on purpose, for a case about what a component is TOLD rather than about a
 * person; prefer a baseline-aware preset when the scenario is "a real member".
 */
import { DEFAULT_PERMISSIONS } from '@/lib/constants/permissions';

import { mockPermissionsValue } from '../setup';

const FULL_ACCESS = {
  isOwner: true,
  permissions: ['*'] as string[],
  hasPermission: () => true,
  hasAnyPermission: () => true,
  hasAllPermissions: () => true,
};

/**
 * Restrict the viewer to exactly these permission codes.
 *
 * The always-on baseline is NOT applied here on purpose. This models "what the
 * component is told", and a component asks `hasPermission('clients.manage')`
 * without knowing where the answer came from. Use `grantBaselineMember` when the
 * scenario is a person rather than a value.
 */
export function grantPermissions(codes: string[]): void {
  const granted = new Set(codes);
  Object.assign(mockPermissionsValue, {
    isOwner: false,
    permissions: codes,
    hasPermission: (code: string) => granted.has(code),
    hasAnyPermission: (list: string[]) => list.some((c) => granted.has(c)),
    hasAllPermissions: (list: string[]) => list.every((c) => granted.has(c)),
  });
}

/**
 * A real firm member: the always-on baseline, plus whatever a role adds.
 *
 * The baseline is unioned into every member's permissions in two independent
 * places, so no member can hold less than it. The backend does it in
 * `roles.service.ts` (`withBaseline`, applied to a role's codes, and returned
 * whole for a member with no role). The frontend does it again in
 * `resolveMemberPermissions`, so even a server response carrying an empty list
 * renders as the baseline.
 *
 * A preset that grants LESS than this therefore describes nobody, and a test
 * built on one proves nothing about a person the product can produce.
 */
export function grantBaselineMember(extra: string[] = []): void {
  grantPermissions([...DEFAULT_PERMISSIONS, ...extra]);
}

/**
 * The narrowest real member: the baseline and nothing else.
 *
 * This is the read-only degradation case, with one honest caveat. The baseline
 * is not literally read-only: it carries `messaging.send`, because a member who
 * cannot reply to a message is not a state the product ships. Everything else in
 * it is a `.view`.
 */
export function grantReadOnly(): void {
  grantBaselineMember();
}

/**
 * Nobody: a caller who is not a member of this firm.
 *
 * This is the ONLY way an empty permission list occurs. `roles.service.ts:93`
 * returns `[]` when there is no member row, and every other branch returns the
 * baseline or more. Use it for an outsider or a revoked member, never as a
 * stand-in for an ordinary member with a narrow role.
 */
export function grantOutsider(): void {
  grantPermissions([]);
}

/** Put the shared object back to the permissive default `setup.ts` installs. */
export function resetPermissions(): void {
  Object.assign(mockPermissionsValue, FULL_ACCESS);
}
