/**
 * Cache-invalidation listeners for the RBAC permission cache
 * (`permissionCache.js`).
 *
 * The cache memoizes a member's resolved permission set keyed by
 * (lawFirmId, userId) for a short TTL. These listeners make permission changes
 * take effect immediately instead of waiting out the TTL backstop. Each
 * listener is async and wrapped in try/catch per the event-listener
 * convention. A failed invalidation must never crash the emitter, and the TTL
 * still bounds staleness if one slips through.
 */

const eventBus = require('../../../shared/events/eventBus');
const {
  MEMBER_ROLE_CHANGED,
  MEMBER_REMOVED,
  ROLE_PERMISSIONS_CHANGED,
  LAWFIRM_DELETION_REQUESTED,
} = require('../../../shared/events/eventTypes');
const permissionCache = require('./permissionCache');

// A member's role changed -> their effective permission set changed.
eventBus.on(MEMBER_ROLE_CHANGED, async ({ lawFirmId, userId }: any) => {
  try {
    permissionCache.invalidate(lawFirmId, userId);
  } catch (err) {
    console.error('permissionCache.events MEMBER_ROLE_CHANGED failed:', err);
  }
});

// A member was removed -> drop their cached entry so a stale "still a member"
// resolution can't linger.
eventBus.on(MEMBER_REMOVED, async ({ lawFirmId, userId }: any) => {
  try {
    permissionCache.invalidate(lawFirmId, userId);
  } catch (err) {
    console.error('permissionCache.events MEMBER_REMOVED failed:', err);
  }
});

// A role's permission array was edited -> every member holding that role has a
// changed effective set. The cache key is per-member (not per-role), so the
// correct action is to drop all of the firm's entries.
eventBus.on(ROLE_PERMISSIONS_CHANGED, async ({ lawFirmId }: any) => {
  try {
    permissionCache.invalidateFirm(lawFirmId);
  } catch (err) {
    console.error('permissionCache.events ROLE_PERMISSIONS_CHANGED failed:', err);
  }
});

// A firm was just soft-deleted -> every member's cached "allowed" resolution
// is stale. Drop the whole firm's entries so access is revoked immediately
// instead of waiting out the 30s TTL backstop.
eventBus.on(LAWFIRM_DELETION_REQUESTED, async ({ lawFirmId }: any) => {
  try {
    permissionCache.invalidateFirm(lawFirmId);
  } catch (err) {
    console.error('permissionCache.events LAWFIRM_DELETION_REQUESTED failed:', err);
  }
});

// This module only registers listeners; it exports nothing. The empty
// export marks it as a MODULE so its top-level consts are file-scoped
// rather than colliding in the global scope with every other events file.
export {};
