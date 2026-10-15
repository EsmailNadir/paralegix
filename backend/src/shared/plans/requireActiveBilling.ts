import type { NextFunction, Request, Response } from 'express';

const { loadFirmPlanForRequest, assertFirmBillingActive } = require('./planEnforcement');
const { loadResolvedMember } = require('../../modules/lawfirms/roles/requirePermission');

/**
 * Firm-workspace billing gate.
 *
 * Mounted at `/api/lawfirms/:lawFirmId`, this blocks access to a firm whose
 * subscription is not in an access-granting state and lets the frontend render a
 * lock screen. It is the real enforcement boundary — even if the UI is bypassed,
 * the API refuses data access for an unpaid firm.
 *
 * Access-granting states (read from the law_firms.billing_status column, which
 * migration 0200 made authoritative; lawfirms.repository.mergePlan routes it there):
 *   - active    paid subscription
 *   - trialing  inside the 14-day trial
 *   - comped    internal / admin-granted free access
 * Plus any firm flagged `comped: true` or `unlimitedOverride: true`.
 *
 * Blocked states: incomplete (never finished checkout), past_due (payment
 * failed), canceled (subscription ended). These return 402 BILLING_INACTIVE with
 * the status in `details` so the client can route to onboarding vs. billing.
 *
 * The 402 is only ever shown to a MEMBER of the firm. It names the firm's
 * subscription state, so answering it to anyone who can guess a firm id would
 * turn this gate into an oracle for whether a firm exists and whether it is
 * paying. A non-member falls through untouched and gets the 403 the route's own
 * `requirePermission` produces, which is the same answer they would get for an
 * active firm. Resolving the member here is effectively free: it goes through
 * the same short-TTL permission cache `requirePermission` populates downstream
 * on the very same request.
 */

// Sub-paths (relative to the :lawFirmId mount) that MUST stay reachable while a
// firm is locked: an owner has to be able to pay, and an invited member/client
// has to be able to accept their invite into the firm.
const EXEMPT_PREFIXES = ['/subscriptions', '/invitations'];

function isExempt(path: string) {
  return EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export async function requireActiveBilling(req: Request, res: Response, next: NextFunction) {
  try {
    // req.path is relative to the mount point, e.g. '/matters' or '/subscriptions/checkout'.
    if (isExempt(req.path)) return next();

    const lawFirmId = req.params.lawFirmId;
    if (!lawFirmId) return next();

    const firm = await loadFirmPlanForRequest(req, lawFirmId);
    if (!firm) return next(); // unknown (or malformed) firm id: let the domain route answer

    // Only a member of this firm may learn its billing state (see header). The
    // gate is mounted behind `verifyToken`, so an absent user means the request
    // never authenticated; skipping the gate is safe because every route below
    // this mount runs its own `verifyToken` and answers 401.
    const userId = req.user?.uid;
    if (!userId) return next();
    const member = await loadResolvedMember(lawFirmId, userId);
    if (!member) return next();

    // Throws 402 BILLING_INACTIVE (shared with requireFeature) unless active.
    assertFirmBillingActive(firm);
    return next();
  } catch (e) {
    return next(e);
  }
}
