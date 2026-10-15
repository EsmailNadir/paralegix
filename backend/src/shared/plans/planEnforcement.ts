const { infrastructureRootSql, infrastructureSql, withDrizzleTransaction } = require('../database/infrastructureQuery');
const { isUuid } = require('../utils/isUuid');
const { getEffectiveLimits, UNLIMITED } = require('./planDefinitions');
const { isFeatureEnabled } = require('./featureCheck');
const { PlanLimitError } = require('../errors/AppError');
const { ForbiddenError } = require('../errors/AppError');
const { AppError } = require('../errors/AppError');

/**
 * Load the firm's plan + settings in the shape the plan helpers expect:
 *   { plan: { planId, unlimitedOverride, limitOverrides, featureOverrides, … },
 *     settings: { features: { … } } }
 * Plan data lives in the `plan` jsonb; planId falls back to the plan_id column.
 * `settings` is needed so feature enforcement can honor firm-level opt-outs
 * (see enforceFeatureAccess / featureCheck.isFeatureEnabled).
 */
export async function loadFirmPlan(lawFirmId: string) {
  // `law_firms.id` is a uuid column, so a malformed id reaches Postgres as a
  // cast error and surfaces as a 500. It can never name a real firm, so answer
  // it the way a well-formed id for a firm that does not exist is answered: the
  // billing gates treat null as "unknown firm" and let the route return its own
  // 404/403.
  if (!isUuid(lawFirmId)) return null;
  const { rows } = await infrastructureRootSql(
    `select plan_id, billing_status, plan, settings from law_firms where id = $1 limit 1`,
    [lawFirmId]
  );
  if (!rows[0]) return null;
  const plan = { ...(rows[0].plan || {}) };
  plan.planId = rows[0].plan_id || 'starter';
  // The columns are the authoritative store and the jsonb no longer carries
  // these two keys (migration 0200), so both are read straight off the row. When
  // a column is somehow absent, fail CLOSED ('incomplete', not 'comped'): a
  // missing status must never grant full access. Genuinely-comped firms carry an
  // explicit comped flag, so they are unaffected.
  plan.billingStatus = rows[0].billing_status || 'incomplete';
  return { plan, settings: rows[0].settings || {} };
}

// Plan loads already started for a request, keyed by firm id. Stored on the
// request object itself under a private symbol, so the loads are released with
// the request and nothing is held at module scope.
const REQUEST_PLAN_LOADS = Symbol('requestPlanLoads');

/**
 * `loadFirmPlan`, memoized for the lifetime of ONE request.
 *
 * The workspace billing gate, a feature gate behind it, and the dashboard each
 * need the same row within a single request. The first caller starts the load
 * and the rest await that same promise. Nothing is shared across requests, so
 * a plan or subscription change written by one request (a Stripe webhook, an
 * admin change) is what the next request reads.
 *
 * Only middleware and the pre-handler reads should use this. A handler that
 * writes the plan and then reads it back must call `loadFirmPlan` directly.
 */
export function loadFirmPlanForRequest(req: object, lawFirmId: string): Promise<any> {
  const holder = req as { [REQUEST_PLAN_LOADS]?: Map<string, Promise<any>> };
  let loads = holder[REQUEST_PLAN_LOADS];
  if (!loads) {
    loads = new Map();
    holder[REQUEST_PLAN_LOADS] = loads;
  }
  let load = loads.get(lawFirmId);
  if (!load) {
    load = loadFirmPlan(lawFirmId);
    loads.set(lawFirmId, load);
  }
  return load;
}

// Billing states that grant access to a firm's workspace and its client portal.
// A live trial and a paid subscription pass; incomplete (never finished
// checkout), past_due (payment failed), and canceled are locked. Shared by the
// firm-workspace gate (requireActiveBilling) and the client-portal per-firm gate
// so both agree on what "active" means.
//
// `comped` and `unlimitedOverride` both pass here, and they are NOT peers.
// Reading them as one idea is what makes their divergence elsewhere look like a
// bug, so state it once: `comped` is a BILLING fact, meaning "do not invoice
// this firm and do not paywall it", and it deliberately leaves the firm's plan
// limits alone. `unlimitedOverride` is an ENTITLEMENT fact, meaning "ignore the
// caps". Only the second appears in getEffectiveLimits (planDefinitions.ts).
//
// That split is intentional and load-bearing: the admin action is a modal
// titled "Give Free Access" carrying a PLAN DROPDOWN, so a comped firm is free
// AT A CHOSEN TIER, and lifting caps would make that dropdown meaningless. The
// grandfathered pre-launch firms are comped on Starter and are meant to stay
// within Starter's limits. See docs/features/lawfirms-rbac-plans.md.
const BILLING_ACTIVE_STATUSES = new Set(['active', 'trialing', 'comped']);
export function isFirmBillingActive(firmData: any) {
  const plan = firmData?.plan || {};
  if (plan.comped === true || plan.unlimitedOverride === true) return true;
  if (!BILLING_ACTIVE_STATUSES.has(plan.billingStatus)) return false;

  // A no-card trial has no Stripe subscription, so nothing else expires it;
  // check it here. A Stripe-tracked trial is left to its own webhook.
  if (plan.billingStatus === 'trialing' && !plan.stripeSubscriptionId && plan.trialEndsAt) {
    return new Date(plan.trialEndsAt).getTime() > Date.now();
  }

  return true;
}

/**
 * Throw the shared 402 BILLING_INACTIVE error when a firm is not in an
 * access-granting billing state; no-op otherwise. This is the single source of
 * truth for the paywall response so every gate agrees. `requireActiveBilling`
 * uses it for the firm-workspace mount, and `requireFeature` uses it for
 * plan-gated routers (e.g. calendar sync) that mount OUTSIDE that workspace gate
 * — without it, a lapsed firm keeps a paid feature just because its route isn't
 * under `/api/lawfirms/:lawFirmId`.
 */
export function assertFirmBillingActive(firmData: any) {
  if (isFirmBillingActive(firmData)) return;
  const plan = firmData?.plan || {};
  const err = new AppError(
    'This firm\'s subscription is inactive. Access is paused until billing is restored. Your data is safe.',
    402,
    'BILLING_INACTIVE',
  );
  err.details = { billingStatus: plan.billingStatus || 'incomplete' };
  throw err;
}

/**
 * Enforce a count-based plan limit (matters, members, etc.)
 * @param {string} lawFirmId
 * @param {string} resource - 'maxMatters' | 'maxMembers'
 * @param {Function} countFn - async function returning current count
 * @param {object} [opts]
 * @param {object|null} [opts.firmData] - a firm plan already loaded via
 *   `loadFirmPlan` (same `{ plan, settings }` shape). When supplied, the
 *   plan-load round-trip is skipped (useful for callers that already hold the
 *   firm so a single request never loads the plan twice. Enforcement semantics
 *   are identical to loading it here.
 */
export async function enforceCountLimit(
  lawFirmId: string,
  resource: string,
  countFn: () => Promise<number> | number,
  opts: { firmData?: any } = {},
) {
  const firmData = opts.firmData !== undefined
    ? opts.firmData
    : await loadFirmPlan(lawFirmId);

  if (!firmData) return; // firm doesn't exist, let other middleware handle

  const limits = getEffectiveLimits(firmData);
  const limit = limits[resource];

  // -1 means unlimited. Short-circuit BEFORE issuing the count so unlimited
  // firms never pay for a COUNT(*) scan on every create. The (cheap, PK)
  // plan load above is the only query in the unlimited path.
  if (limit === UNLIMITED) return;

  const current = await countFn();

  if (current >= limit) {
    throw new PlanLimitError(resource, {
      current,
      limit,
      planId: firmData?.plan?.planId || 'starter',
    });
  }
}

// Human-readable labels for the internal camelCase feature keys enforced via
// enforceFeatureAccess/requireFeature (see app.ts route mounts, calendarSyncGates.ts,
// syncFirmGuard.ts, and signing.routes.ts for the call sites) and gated directly via
// isFeatureEnabled (portal.routes.ts). Covers every feature key defined in
// planDefinitions.ts so a plan-gate error never falls through to the generic label.
const FEATURE_LABELS: Record<string, string> = {
  clientPortal: 'Client portal',
  messaging: 'Messaging',
  calendarSync: 'Calendar sync',
  analytics: 'Billing analytics',
  flatFees: 'Flat fees',
  fileSharing: 'File sharing links',
  templates: 'Templates',
  trustAccounting: 'Trust accounting',
  documentSigning: 'Document signing',
};

/**
 * Enforce feature access for a firm.
 *
 * A feature is available only when BOTH gates pass (see featureCheck.isFeatureEnabled):
 *   1. The plan (incl. unlimitedOverride / featureOverrides) allows it. The plan
 *      is the ceiling, so a feature the plan does not include is ALWAYS denied.
 *   2. The firm has not opted out via `settings.features[featureName] === false`.
 *      A firm opt-out disables a plan-allowed feature.
 *
 * Precedence: plan-deny always wins (no settings value can grant a feature the
 * plan lacks); within a plan-allowed feature, a firm opt-out denies.
 *
 * @param {string} lawFirmId
 * @param {string} featureName - e.g. 'calendarSync', 'analytics'
 * @param {object} [opts]
 * @param {object|null} [opts.firmData] - a firm plan already loaded via
 *   `loadFirmPlan` (same shape). When supplied, the plan-load round-trip is
 *   skipped. Enforcement semantics are identical to loading it here.
 */
export async function enforceFeatureAccess(
  lawFirmId: string,
  featureName: string,
  opts: { firmData?: any } = {},
) {
  const firmData = opts.firmData !== undefined
    ? opts.firmData
    : await loadFirmPlan(lawFirmId);

  if (!firmData) return;

  if (!isFeatureEnabled(firmData, featureName)) {
    throw new ForbiddenError(
      `${FEATURE_LABELS[featureName] || 'This feature'} is not included in your current plan. Upgrade to enable it.`
    );
  }
}
