/**
 * Clear every in-process cache the app holds. Call it in `beforeEach`.
 *
 * These caches are correct in production, where a 30-second window between a
 * role change and its effect is invisible. A test changes state and asserts
 * within milliseconds, so each one is a source of FALSE PASSES: the assertion
 * reads a value resolved before the change and agrees with it.
 *
 * Three caches matter, and two of them sit directly under the organization
 * work:
 *
 *   - roles/permissionCache: the resolved permission set, keyed by
 *     (lawFirmId, userId). A spec that narrows a role and re-calls would
 *     otherwise still be authorized.
 *   - portal/clientAssociation.resolver: which client records a portal user is
 *     associated with, including through an organization's roster.
 *   - portal/portal.service: the resolved portal access context.
 *
 * The auth middleware's token cache is deliberately NOT cleared. It is keyed on
 * the full token string and `tokenFor()` mints a unique string per call, so it
 * can never serve one caller's payload to another.
 */
export function resetCaches(): void {
  require('../../src/modules/lawfirms/roles/permissionCache').clear();
  require('../../src/modules/clients/portal/clientAssociation.resolver').__resetAssociationCaches();
  require('../../src/modules/clients/portal/portal.service').__resetAccessContextCache();
}
