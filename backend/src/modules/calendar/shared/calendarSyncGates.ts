const { requireFeature } = require('../../../shared/plans/requireFeature');
const { requirePermissionFrom } = require('../../lawfirms/roles/requirePermission');

// Google and Outlook sync routes are structurally identical: the firm id lives
// in the request body (not the URL), so they can't use the URL-param
// `requirePermission`/`requireFeature` wiring. These gates are shared by both
// provider route files so the resolution rules stay in one place.

// Coerce a body/query field to a clean firm-id string; anything that isn't a
// non-empty string resolves to undefined so a gate becomes a safe no-op (it only
// ever DENIES a known firm, never grants) and downstream validation decides.
export function cleanFirmId(value: any) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// Firm-id resolvers for the two route shapes.
export const firmIdFromBody = (req: any) => cleanFirmId(req.body?.lawFirmId);
// Batch push routes carry the firm id per-item in a tasks/events array. Resolve
// from the top-level body field first, then the first array item.
export const firmIdFromItems = (req: any) => {
  const body = req.body || {};
  const direct = cleanFirmId(body.lawFirmId);
  if (direct) return direct;
  const firstItem = (Array.isArray(body.tasks) && body.tasks[0])
    || (Array.isArray(body.events) && body.events[0])
    || null;
  return firstItem ? cleanFirmId(firstItem.lawFirmId) : undefined;
};

// Permission gates (calendar.sync). Placed BEFORE the plan gate per the
// requireFeature contract: authorization is decided before plan enforcement.
export const requireSyncPerm = requirePermissionFrom(firmIdFromBody, 'calendar.sync');
export const requireSyncPermFromItems = requirePermissionFrom(firmIdFromItems, 'calendar.sync');

// Plan gates (calendarSync feature + active billing).
export const requireCalendarSync = requireFeature('calendarSync', firmIdFromBody);
export const requireCalendarSyncFromItems = requireFeature('calendarSync', firmIdFromItems);
