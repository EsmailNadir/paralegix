import type { NextFunction, Request, Response } from 'express';

const { enforceFeatureAccess, loadFirmPlanForRequest, assertFirmBillingActive } = require('./planEnforcement');
const { loadResolvedMember } = require('../../modules/lawfirms/roles/requirePermission');

/**
 * Route middleware that gates access to a plan-gated boolean feature.
 *
 * It is the API-side enforcement for the feature flags defined in
 * `planDefinitions.js` (calendarSync, analytics, templates, trustAccounting,
 * documentSigning, fileSharing, messaging, flatFees; `clientPortal` is enforced
 * in the portal router, which is the only place a portal request names a firm).
 * The frontend may hide the UI for a feature the plan lacks,
 * but this is the actual server-side ceiling: a firm on a tier without the
 * feature gets a 403 even if it hits the endpoint directly.
 *
 * Delegates to `enforceFeatureAccess`, which routes through
 * `featureCheck.isFeatureEnabled` and therefore honors BOTH the plan ceiling
 * (incl. unlimitedOverride / featureOverrides) AND the firm-level
 * `settings.features[feature] === false` opt-out. A denied feature throws the
 * shared `ForbiddenError` (403), the same shape every other denial uses.
 *
 * lawFirmId resolution: most firm-scoped routers mount under
 * `/api/lawfirms/:lawFirmId/...`, so `req.params.lawFirmId` is present. A few
 * routers (calendar sync) carry the firm id in the request body instead, so an
 * optional resolver can be supplied. If no firm id can be resolved the gate is
 * skipped (a no-op) and downstream validation/membership middleware handles the
 * missing id. The gate never fabricates access and never blocks a request it
 * cannot scope.
 *
 * Only a MEMBER of the firm may learn its plan state. Both denials this gate
 * produces name something private: the 402 names the firm's subscription state,
 * and the feature 403 names which features its plan includes. Answering either
 * to anyone who can guess a firm id turns the gate into an oracle for whether a
 * firm exists, whether it is paying, and what tier it is on. So a non-member
 * falls through untouched and gets the 403 the route's own `requirePermission`
 * produces, which is the same answer they would get for a firm on any plan.
 * `requireActiveBilling` resolves the workspace-level gate the same way and for
 * the same reason.
 *
 * Resolving the member is effectively free: every call site already runs a
 * permission gate (`requirePermission` on the router, or `requirePermissionFrom`
 * for the body-scoped calendar and signing routes), and that populates the same
 * short-TTL cache this reads. Where the gate is mounted ahead of the router's
 * own permission check, the lookup is the one that would have run a moment later
 * anyway.
 *
 * IMPORTANT: place AFTER `verifyToken` (and, where present, `requirePermission`
 * / `assertLawFirmMembership`) so authorization is decided before plan
 * enforcement. The plan gate is a ceiling on top of authorization, not a
 * substitute for it.
 *
 * @param {string} feature - feature flag name (e.g. 'trustAccounting')
 * @param {(req) => (string|undefined)} [getLawFirmId] - optional resolver
 */
export function requireFeature(feature: string, getLawFirmId?: (req: Request) => string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const lawFirmId = getLawFirmId
      ? getLawFirmId(req)
      : req.params.lawFirmId;
    if (!lawFirmId) return next();

    // Only a member may be told anything about this firm's plan (see header).
    // The gate is mounted behind `verifyToken` at every call site, so an absent
    // user means the request never authenticated; skipping is safe because
    // every route below runs its own `verifyToken` and answers 401.
    const userId = (req as any).user?.uid;
    if (!userId) return next();
    const member = await loadResolvedMember(lawFirmId, userId);
    if (!member) return next();

    // Load the firm once and enforce BOTH gates. The load is shared with
    // requireActiveBilling when both run on one request. The payment-state gate
    // matters here because feature routers such as calendar sync mount outside
    // the /api/lawfirms/:lawFirmId workspace gate (requireActiveBilling), so this
    // is the only place a lapsed (past_due/canceled) firm is denied a paid feature.
    const firmData = await loadFirmPlanForRequest(req, lawFirmId);
    if (!firmData) return next(); // unknown firm: let membership/validation handle it
    assertFirmBillingActive(firmData);
    await enforceFeatureAccess(lawFirmId, feature, { firmData });
    next();
  };
}
