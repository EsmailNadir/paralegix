import { sql } from 'drizzle-orm';
import { lawFirms } from '../../shared/database/drizzle/schema';
import { firmQuery } from '../../shared/database/queryContext';
import { captureServerEvent } from '../../shared/analytics/serverAnalytics';
const stripe = require('../stripe/stripe.config');
const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const mattersRepo = require('../matters/matters.repository');
const invitationsRepo = require('../invitations/invitations.repository');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { ValidationError, NotFoundError } = require('../../shared/errors/AppError');
const { getPriceId, planFromPriceId } = require('../../shared/plans/stripePrices');
const { getPlanById, getEffectiveLimits, getEffectiveFeatures, UNLIMITED } = require('../../shared/plans/planDefinitions');
const { updateStorageConfig } = require('../../shared/utils/storageUsage');
const eventBus = require('../../shared/events/eventBus');
const {
  SUBSCRIPTION_CREATED,
  SUBSCRIPTION_UPDATED,
  SUBSCRIPTION_CANCELLED,
  SUBSCRIPTION_TRIAL_ENDING,
  SUBSCRIPTION_PAYMENT_FAILED,
  SUBSCRIPTION_PLAN_CHANGED,
} = require('../../shared/events/eventTypes');

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

// Stripe unix-seconds → ISO string (plan dates are stored as ISO in the plan jsonb).
function isoFromStripeSeconds(unixSeconds: any) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

// The billing period a subscription is currently in, as ISO strings.
//
// Stripe removed `current_period_start`/`current_period_end` from the subscription
// object and moved them onto its items (API version 2025-03-31.basil). The SDK pins
// a version well past that, so a subscription retrieved through it only carries the
// dates per item, while a webhook payload is rendered at whatever version the
// endpoint is pinned to and may still carry the old top-level fields. Read the item
// first and fall back, so both shapes produce a period instead of a silent null,
// which is what left firms with no renewal date and disarmed the ordering guard
// below. All items on a Paralegix subscription share one price, so the first item's
// period is the subscription's period.
function periodFromSubscription(subscription: any) {
  const item = subscription?.items?.data?.[0];
  return {
    start: isoFromStripeSeconds(item?.current_period_start ?? subscription?.current_period_start),
    end: isoFromStripeSeconds(item?.current_period_end ?? subscription?.current_period_end),
  };
}

// The subscription an invoice belongs to, or null for a one-off invoice.
//
// `Invoice.subscription` was dropped in the same API version that moved the period
// fields; the reference now lives under `parent.subscription_details`. Either shape
// can arrive depending on the webhook endpoint's pinned version, and either can be
// an id string or an expanded object.
export function subscriptionIdFromInvoice(invoice: any) {
  const ref = invoice?.subscription ?? invoice?.parent?.subscription_details?.subscription ?? null;
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id || null;
}

// Retrieve a Stripe subscription, returning null if it no longer exists instead of
// throwing. Stripe raises a 404 / resource_missing for a deleted or bad id; that is
// a terminal condition (nothing to act on), so callers treat null accordingly and a
// webhook won't 500 into an endless retry loop. Any other error (network, auth) is a
// real failure and is rethrown.
async function retrieveSubscriptionOrNull(subscriptionId: any) {
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err: any) {
    if (err && (err.statusCode === 404 || err.code === 'resource_missing')) return null;
    throw err;
  }
}

// Subscription statuses that are over for good. Anything else (trialing, active,
// past_due, unpaid, paused, incomplete) can still bill the customer or turn into
// a paying subscription, so it counts as live.
const FINISHED_SUBSCRIPTION_STATUSES = new Set(['canceled', 'incomplete_expired']);

function isLiveSubscription(subscription: any) {
  return !!subscription && !FINISHED_SUBSCRIPTION_STATUSES.has(subscription.status);
}

// Whether an event about `subscriptionId` must be ignored because the firm is
// billed through a DIFFERENT subscription that is still live. Stripe keeps
// sending events for every subscription a customer has: a second one opened by
// a duplicate checkout, or an old one whose last dunning retry fails after the
// firm resubscribed. Without this the last event to land decides which
// subscription the firm is on, and an old subscription's failure locks out a
// firm paying on its new one. A stored subscription Stripe has ended or no
// longer has is not live, so a genuine replacement still goes through; that
// costs one Stripe read, and only when the ids differ.
async function isEventForAnotherLiveSubscription(firm: any, subscriptionId: string, lawFirmId: string) {
  const storedId = firm?.plan?.stripeSubscriptionId;
  if (!storedId || !subscriptionId || storedId === subscriptionId) return false;
  const stored = await retrieveSubscriptionOrNull(storedId);
  if (!isLiveSubscription(stored)) return false;
  console.warn('Ignoring Stripe event for a subscription that is not the firm\'s live one', {
    lawFirmId, eventSubscriptionId: subscriptionId, storedSubscriptionId: storedId, storedStatus: stored.status,
  });
  return true;
}

// Map a Stripe subscription.status onto the firm's billingStatus. Shared by the
// subscription-change handler and the invoice-paid handler so a paid invoice can
// never force 'active' on a subscription Stripe still reports as (say) past_due.
function mapSubscriptionBillingStatus(status: any) {
  if (status === 'trialing') return 'trialing';
  if (status === 'active') return 'active';
  if (status === 'past_due') return 'past_due';
  return status;
}

// Read a plan date back to ISO. Plan dates are stored as ISO strings in the
// plan jsonb.
function toIsoOrNull(value: any) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return null;
}

// Plan tier and interval for an analytics event. Ids and enums only: the plan
// jsonb also carries payment amounts and Stripe customer ids, none of which may
// leave for analytics.
function analyticsPlanProperties(plan: any) {
  return {
    plan_id: plan?.planId ?? null,
    billing_interval: plan?.billingInterval ?? null,
  };
}

// Report a billing-status transition on a subscription the firm already had.
// `updatedFirm` is the row mergePlan wrote, so the new status is what was
// stored rather than what was asked for, and a firm id that matched no row
// (updatedFirm null) reports nothing.
function reportStatusChange(lawFirmId: string, fromStatus: any, updatedFirm: any) {
  const toStatus = updatedFirm?.plan?.billingStatus;
  if (!updatedFirm || !toStatus || toStatus === fromStatus) return;
  captureServerEvent({
    event: 'subscription_status_changed',
    lawFirmId,
    properties: {
      from_status: fromStatus ?? null,
      to_status: toStatus,
      ...analyticsPlanProperties(updatedFirm.plan),
    },
  });
}

// ── Self-serve endpoints ────────────────────────────────────────────────

export async function createCheckoutSession({ lawFirmId, userId, planId, interval }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const firmData = await lawfirmsRepo.findById(lawFirmId);

  // Block if subscription already exists
  if (firmData?.plan?.stripeSubscriptionId) {
    const sub = await stripe.subscriptions.retrieve(firmData.plan.stripeSubscriptionId).catch(() => null);
    if (sub && ['active', 'trialing', 'past_due'].includes(sub.status)) {
      throw new ValidationError('This firm already has an active subscription. Use change-plan to switch plans.');
    }
  }

  // The stored pointer above only knows about subscriptions whose webhook has
  // landed. Stripe is the authority: a checkout completed a moment ago in
  // another tab already has a subscription there, and a second checkout would
  // bill the firm twice.
  const existingCustomerId = firmData?.plan?.stripeCustomerId;
  if (existingCustomerId) {
    const subscriptions = await stripe.subscriptions.list({ customer: existingCustomerId, status: 'all', limit: 100 });
    if ((subscriptions?.data || []).some(isLiveSubscription)) {
      throw new ValidationError('This firm already has an active subscription. Use change-plan to switch plans.');
    }
  }

  // Get or create Stripe Customer
  let customerId = existingCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { lawFirmId, createdBy: userId },
      name: firmData.name,
      email: firmData.email,
    });
    customerId = customer.id;
    await lawfirmsRepo.mergePlan(lawFirmId, { stripeCustomerId: customerId });
  }

  const priceId = getPriceId(planId, interval);
  if (!priceId) throw new ValidationError('Invalid plan or interval');

  // Determine if trial should be offered
  const isComped = firmData?.plan?.billingStatus === 'comped';
  const isUpgrade = firmData?.plan?.stripeSubscriptionId; // had a subscription before
  // A durable, cancellation-surviving marker: once a firm has consumed a trial it
  // never gets another. Without this, canceling a subscription clears
  // stripeSubscriptionId, so a cancel-then-recheckout would grant a fresh 14-day
  // trial indefinitely. Set when a trialing subscription is observed in the webhook.
  const hasTrialed = firmData?.plan?.trialConsumed === true;

  // A subscription only exists once a checkout is paid, so two checkouts opened
  // side by side (two tabs, two admins) both pass the check above. Expire the
  // customer's other open subscription checkouts so only this newest one can
  // complete. A brand new customer has none.
  if (existingCustomerId) {
    const openSessions = await stripe.checkout.sessions.list({ customer: existingCustomerId, status: 'open', limit: 100 });
    for (const openSession of openSessions?.data || []) {
      if (openSession.mode === 'subscription') await stripe.checkout.sessions.expire(openSession.id);
    }
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${FRONTEND_URL}/lawfirm/${lawFirmId}/settings/billing?session_id={CHECKOUT_SESSION_ID}&status=success`,
    cancel_url: `${FRONTEND_URL}/lawfirm/${lawFirmId}/settings/billing?status=cancelled`,
    subscription_data: {
      metadata: { lawFirmId, userId },
      trial_period_days: (isComped || isUpgrade || hasTrialed) ? undefined : 14,
    },
    metadata: { lawFirmId, userId, planId, interval },
    allow_promotion_codes: true,
  });

  return { checkoutUrl: session.url, sessionId: session.id };
}

const pluralize = (count: number, noun: string) =>
  `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;

// Refuse a plan change the firm's current usage does not fit. The count limits
// are the ones enforceCountLimit applies when a member is invited or a matter
// is created, measured the same way: seats are members plus live pending member
// invitations, and the limits come from getEffectiveLimits on the TARGET plan,
// so the firm's own limitOverrides and unlimitedOverride apply exactly as they
// would after the change. A firm at a limit fits; one over it does not.
async function assertUsageFitsPlan(lawFirmId: string, firmData: any, planId: string) {
  const limits = getEffectiveLimits({ ...firmData, plan: { ...(firmData?.plan || {}), planId } });
  const planName = getPlanById(planId).name;
  const overages: string[] = [];

  if (limits.maxMembers !== UNLIMITED) {
    const [seats, members] = await Promise.all([
      invitationsRepo.countMembersAndPendingMembers(lawFirmId),
      invitationsRepo.countMembers(lawFirmId),
    ]);
    if (seats > limits.maxMembers) {
      const pending = seats - members;
      const pendingNote = pending > 0 ? ` (including ${pluralize(pending, 'pending invitation')})` : '';
      overages.push(`${pluralize(seats, 'member')}${pendingNote}, and ${planName} allows ${limits.maxMembers.toLocaleString('en-US')}`);
    }
  }

  if (limits.maxMatters !== UNLIMITED) {
    const matterCount = await mattersRepo.countMatters(lawFirmId);
    if (matterCount > limits.maxMatters) {
      overages.push(`${pluralize(matterCount, 'matter')}, and ${planName} allows ${limits.maxMatters.toLocaleString('en-US')}`);
    }
  }

  if (overages.length) {
    throw new ValidationError(
      `Your firm is over the ${planName} plan's limits: it has ${overages.join('; it has ')}. `
      + 'Remove members, cancel pending invitations or delete matters to fit, or choose a larger plan.',
    );
  }
}

export async function changePlan({ lawFirmId, userId, planId, interval }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  const subscriptionId = firmData?.plan?.stripeSubscriptionId;
  if (!subscriptionId) throw new ValidationError('No active subscription to change');

  const priceId = getPriceId(planId, interval);
  if (!priceId) throw new ValidationError('Invalid plan or interval');

  await assertUsageFitsPlan(lawFirmId, firmData, planId);

  const subscription = await retrieveSubscriptionOrNull(subscriptionId);
  if (!subscription) throw new NotFoundError('Subscription');
  const itemId = subscription.items?.data?.[0]?.id;
  if (!itemId) throw new ValidationError('Subscription has no billable items to change');

  await stripe.subscriptions.update(subscriptionId, {
    items: [{
      id: itemId,
      price: priceId,
    }],
    proration_behavior: 'create_prorations',
    metadata: { lawFirmId, userId, planId, interval },
  });

  eventBus.emit(SUBSCRIPTION_PLAN_CHANGED, { lawFirmId, userId, planId, interval });

  return { message: 'Plan change initiated : billing adjusted with proration' };
}

export async function cancelSubscription({ lawFirmId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  const subscriptionId = firmData?.plan?.stripeSubscriptionId;
  if (!subscriptionId) throw new ValidationError('No active subscription');

  await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });

  await lawfirmsRepo.mergePlan(lawFirmId, { cancelAtPeriodEnd: true });

  eventBus.emit(SUBSCRIPTION_CANCELLED, { lawFirmId, userId });

  return { message: 'Subscription will cancel at the end of the current billing period' };
}

export async function reactivateSubscription({ lawFirmId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  const subscriptionId = firmData?.plan?.stripeSubscriptionId;
  if (!subscriptionId) throw new ValidationError('No subscription to reactivate');

  const subscription = await retrieveSubscriptionOrNull(subscriptionId);
  if (!subscription) throw new NotFoundError('Subscription');
  // A subscription that already fully ended can't be un-cancelled; only a pending
  // cancel-at-period-end can be reversed.
  if (subscription.status === 'canceled') {
    throw new ValidationError('This subscription has already ended and cannot be reactivated. Start a new subscription instead.');
  }

  await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: false,
  });

  await lawfirmsRepo.mergePlan(lawFirmId, { cancelAtPeriodEnd: false });

  return { message: 'Subscription reactivated' };
}

export async function createPortalSession({ lawFirmId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  const customerId = firmData?.plan?.stripeCustomerId;
  if (!customerId) throw new ValidationError('No billing account found');

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${FRONTEND_URL}/lawfirm/${lawFirmId}/settings/billing`,
  });

  return { portalUrl: session.url };
}

export async function getSubscriptionStatus({ lawFirmId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  const plan = firmData?.plan || {};

  const planDef = getPlanById(plan.planId);
  const limits = getEffectiveLimits(firmData);
  const features = getEffectiveFeatures(firmData);

  // Current usage counts. Seats count members PLUS outstanding member invitations,
  // because that is what `enforceCountLimit` charges against `maxMembers` when an
  // invite is sent — reporting bare members here told a firm it had a free seat and
  // then rejected the invite that tried to use it. `pendingInvites` is broken out
  // so the UI can explain where the difference comes from.
  const [usage] = await firmQuery(
    lawFirms,
    lawFirmId,
    ({ executor, scope }) => executor.select({
      matters: sql<number>`(select count(*)::int from matters where law_firm_id = ${lawFirmId})`,
      members: sql<number>`(select count(*)::int from members where law_firm_id = ${lawFirmId})`,
      // The expiry predicate must match countMembersAndPendingMembers exactly.
      // This figure is what the upgrade screen shows as seats used; if the two
      // drift, the screen tells a firm it is full while the enforcement lets it
      // invite, or the reverse. An expired invite holds no seat in either.
      pendingInvites: sql<number>`(
        select count(*)::int from invitations
        where law_firm_id = ${lawFirmId} and invite_type = 'member' and status = 'pending'
          and (expires_at is null or expires_at > now())
      )`,
      // Who to ask when billing lapses. A member without `settings.manageFirm`
      // cannot pay, and the paywall that tells them so is useless without a name
      // to chase. This endpoint is exempt from the billing gate, so it is the one
      // firm-scoped payload still readable once the workspace is locked.
      owner: sql<{ name: string | null; email: string | null } | null>`(
        select json_build_object('name', u.name, 'email', u.email)
        from members m join users u on u.id = m.user_id
        where m.law_firm_id = ${lawFirmId} and m.is_owner
        limit 1
      )`,
    }).from(lawFirms).where(scope),
  );
  const counts = usage || { matters: 0, members: 0, pendingInvites: 0 };
  const seatsUsed = counts.members + counts.pendingInvites;

  // `law_firms.storage_used_bytes` is the enforcement source of truth; see
  // shared/utils/storageUsage.ts.
  const storageUsed = firmData?.storageUsedBytes ?? 0;

  return {
    planId: plan.planId || 'starter',
    planName: planDef.name,
    // Fail closed when no status is stored (do not report 'comped'/full access).
    billingStatus: plan.billingStatus || 'incomplete',
    billingInterval: plan.billingInterval || null,
    comped: plan.comped || false,
    unlimitedOverride: plan.unlimitedOverride || false,
    cancelAtPeriodEnd: plan.cancelAtPeriodEnd || false,
    currentPeriodEnd: toIsoOrNull(plan.currentPeriodEnd),
    currentPeriodStart: toIsoOrNull(plan.currentPeriodStart),
    trialEndsAt: toIsoOrNull(plan.trialEndsAt),
    owner: usage?.owner || null,
    stripeCustomerId: plan.stripeCustomerId || null,
    stripeSubscriptionId: plan.stripeSubscriptionId || null,
    usage: {
      matters: {
        current: counts.matters,
        limit: limits.maxMatters,
      },
      members: {
        current: seatsUsed,
        activeMembers: counts.members,
        pendingInvites: counts.pendingInvites,
        limit: limits.maxMembers,
      },
      storage: {
        currentBytes: storageUsed,
        limitBytes: limits.storageQuotaBytes,
      },
    },
    features,
    pricing: planDef.pricing,
  };
}

// Point the firm's storage quota at its new plan tier.
//
// This writes the TYPED `storage_quota_bytes` column (what `reserveStorageUsage`
// enforces against) and mirrors the settings jsonb in the same statement, via the
// same helper the admin plan editor uses. Writing only the jsonb — as this did —
// left enforcement on the previous tier's quota, so an upgrade bought storage the
// API still refused and a downgrade kept the old headroom. `hardLimit: true`
// re-asserts enforcement for firms whose column was never seeded.
async function syncStorageQuota(lawFirmId: string, quotaBytes: any) {
  await updateStorageConfig(lawFirmId, { quotaBytes, hardLimit: true });
}

// ── Webhook handlers ────────────────────────────────────────────────────

// Applies a Stripe subscription's state to the firm's stored plan. Returns an
// indicator of whether it actually converged the firm, so callers (notably the
// reconciliation sweep) can tell a real write apart from a guarded no-op:
//   'updated'         — the firm's plan was written.
//   'skipped_no_plan' — no firm on the subscription, or its price id is not in the
//                       plan map (rotated/legacy price); nothing was written.
//   'skipped_stale'   — a terminal or out-of-order event was ignored on purpose.
// The webhook dispatcher ignores this value; only the sweep inspects it.
//
// The event payload only identifies the subscription. What gets applied is the
// subscription as Stripe holds it NOW, the same way the invoice handlers work:
// Stripe retries a failed delivery for days, so a past_due event can land an
// hour after the active one that superseded it, and both carry the same period,
// which the ordering guard below cannot separate. A subscription Stripe no
// longer has is skipped (handleSubscriptionDeleted owns its end). A failed
// retrieve throws rather than falling back to the payload: falling back is the
// stale write this read prevents, the webhook route releases its claim and
// answers 500, and Stripe's retries outlast any outage.
export async function handleSubscriptionChange(eventSubscription: any) {
  if (!eventSubscription?.id || !eventSubscription.metadata?.lawFirmId) return 'skipped_no_plan';
  const subscription = await retrieveSubscriptionOrNull(eventSubscription.id);
  if (!subscription) return 'skipped_stale';

  const lawFirmId = subscription.metadata?.lawFirmId;
  if (!lawFirmId) return 'skipped_no_plan';

  const priceId = subscription.items?.data?.[0]?.price?.id;
  const planInfo = planFromPriceId(priceId);
  if (!planInfo) return 'skipped_no_plan';

  // A terminal 'canceled' status is owned by handleSubscriptionDeleted. Stripe can
  // deliver a stale 'updated' event after the 'deleted' one; ignore it here so it
  // can't resurrect a canceled firm back to an active/paid state.
  if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired') return 'skipped_stale';

  // Ordering guard: Stripe can deliver subscription events out of order. Ignore an
  // event whose billing period starts strictly BEFORE the one already stored, so a
  // delayed/stale event can't roll the firm back to older plan state. Same-period
  // events (e.g. a cancel_at_period_end toggle) still process (equal is not stale).
  const existingFirm = await lawfirmsRepo.findById(lawFirmId);

  // The stale-update case the terminal guard above does NOT catch. Stripe can
  // deliver an `updated` generated BEFORE a cancellation after the `deleted`
  // that ended it, and that event carries the status the subscription had at
  // the time: 'active'. So the guard above, which reads the INCOMING status,
  // lets it through. The ordering guard below cannot catch it either, because
  // handleSubscriptionDeleted nulls currentPeriodStart, which disarms it
  // exactly when it is needed. The firm went back to a paying state with a dead
  // subscription id restored, and kept the product indefinitely.
  //
  // The discriminator is the subscription IDENTITY, not the firm's state.
  // Refusing every update for a canceled firm would lock out a firm that has
  // just handed over a new card; a genuine resubscribe always arrives under a
  // NEW subscription id, because a canceled Stripe subscription is terminal.
  if (existingFirm?.plan?.canceledSubscriptionId
      && existingFirm.plan.canceledSubscriptionId === subscription.id) {
    return 'skipped_stale';
  }

  if (await isEventForAnotherLiveSubscription(existingFirm, subscription.id, lawFirmId)) {
    return 'skipped_stale';
  }

  const storedStartIso = toIsoOrNull(existingFirm?.plan?.currentPeriodStart);
  const period = periodFromSubscription(subscription);
  const incomingStartIso = period.start;
  if (storedStartIso && incomingStartIso && new Date(incomingStartIso) < new Date(storedStartIso)) {
    return 'skipped_stale';
  }

  const billingStatus = mapSubscriptionBillingStatus(subscription.status);

  const updatedFirm = await lawfirmsRepo.mergePlan(lawFirmId, {
    planId: planInfo.planId,
    billingStatus,
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    billingInterval: planInfo.interval,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
    trialEndsAt: isoFromStripeSeconds(subscription.trial_end),
    assignedAt: new Date().toISOString(),
    assignedBy: 'stripe',
    comped: false,
    // A different subscription is now in force, so the previous cancellation is
    // history. Left set, it would silently drop a later legitimate update if
    // Stripe ever reused the id.
    canceledSubscriptionId: null,
    // Durably record that this firm has used a trial so it can never be granted
    // another (the marker is merged into the plan jsonb and is intentionally NOT
    // cleared by handleSubscriptionDeleted). Once true it stays true.
    ...(subscription.status === 'trialing' || subscription.trial_end ? { trialConsumed: true } : {}),
  });

  // Sync storage quota from plan
  const planDef = getPlanById(planInfo.planId);
  await syncStorageQuota(lawFirmId, planDef.limits.storageQuotaBytes);

  eventBus.emit(SUBSCRIPTION_UPDATED, { lawFirmId, planId: planInfo.planId, billingStatus });

  // A subscription id the firm did not already hold is a start (first checkout,
  // or a resubscribe after a cancellation). Stripe sends `created` and then
  // `updated` for it, possibly out of order; whichever lands first writes the
  // id, so the second sees it stored and reports only a real status move.
  const previousStatus = existingFirm?.plan?.billingStatus ?? null;
  if (updatedFirm && existingFirm?.plan?.stripeSubscriptionId !== subscription.id) {
    captureServerEvent({
      event: 'subscription_started',
      lawFirmId,
      properties: {
        ...analyticsPlanProperties(updatedFirm.plan),
        status: updatedFirm.plan?.billingStatus ?? null,
        from_status: previousStatus,
      },
    });
  } else {
    reportStatusChange(lawFirmId, previousStatus, updatedFirm);
  }

  return 'updated';
}

// Lock the firm out of paid access when its Stripe subscription ends (cancellation,
// lapsed trial, or exhausted dunning). There is no free self-serve tier, so a firm
// without an active or comped subscription reverts to the paywall: billingStatus
// 'canceled' with comped left false. The subscription pointers are cleared so the
// reconciliation sweep drops this firm on its next run. planId is left untouched (the
// plan tier is irrelevant while the firm is locked out).
export async function handleSubscriptionDeleted(subscription: any) {
  const lawFirmId = subscription.metadata?.lawFirmId;
  if (!lawFirmId) return;

  // Identity guard, the delete-side twin of handleSubscriptionChange's
  // `canceledSubscriptionId` check. Stripe does not guarantee delivery order: a
  // firm can cancel and immediately resubscribe (a new subscription id, already
  // active) before a delayed `deleted` webhook for the OLD subscription arrives.
  // That event carries its own event id, so the idempotency claim table does not
  // catch it as a duplicate -- without this check it would unconditionally wipe
  // the firm's live, paying subscription back to canceled. Only refuse when the
  // firm has a DIFFERENT subscription on record; a firm with no stored id yet
  // (e.g. the create/update webhook was lost) still gets locked out, which is
  // the safe default.
  const existingFirm = await lawfirmsRepo.findById(lawFirmId);
  const currentSubscriptionId = existingFirm?.plan?.stripeSubscriptionId;
  if (currentSubscriptionId && subscription.id && currentSubscriptionId !== subscription.id) {
    return 'skipped_stale';
  }

  // The twin of handleSubscriptionChange's own `canceledSubscriptionId` check,
  // for the case that guard cannot reach: `currentSubscriptionId` is falsy
  // here whenever something has already deliberately detached the firm from
  // this subscription and cleared the pointer (e.g. adminCompFirm cancelling
  // it and comping the firm), so the check above never fires. Without this,
  // a delayed delete for that same, already-superseded subscription id would
  // still apply unconditionally and undo the deliberate action that caused
  // the cancellation in the first place.
  if (existingFirm?.plan?.canceledSubscriptionId
      && existingFirm.plan.canceledSubscriptionId === subscription.id) {
    return 'skipped_stale';
  }

  const updatedFirm = await lawfirmsRepo.mergePlan(lawFirmId, {
    billingStatus: 'canceled',
    comped: false,
    // Kept so handleSubscriptionChange can recognise a stale `updated` for THIS
    // subscription arriving after this event and drop it. stripeSubscriptionId
    // is still cleared below, because nothing should treat this firm as having
    // a live subscription.
    canceledSubscriptionId: subscription.id || null,
    stripeSubscriptionId: null,
    stripePriceId: null,
    billingInterval: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    assignedAt: new Date().toISOString(),
    assignedBy: 'stripe',
  });

  // Sync storage quota to starter
  const starterPlan = getPlanById('starter');
  await syncStorageQuota(lawFirmId, starterPlan.limits.storageQuotaBytes);

  eventBus.emit(SUBSCRIPTION_CANCELLED, { lawFirmId });

  // The plan fields are read from BEFORE the write, which cleared the interval.
  // A second delete of this subscription never reaches here: the write above
  // recorded it as `canceledSubscriptionId`, which the guard refuses.
  if (updatedFirm) {
    captureServerEvent({
      event: 'subscription_cancelled',
      lawFirmId,
      properties: {
        ...analyticsPlanProperties(existingFirm?.plan),
        from_status: existingFirm?.plan?.billingStatus ?? null,
      },
    });
  }
}

export async function handleTrialEnding(subscription: any) {
  const lawFirmId = subscription.metadata?.lawFirmId;
  if (!lawFirmId) return;

  eventBus.emit(SUBSCRIPTION_TRIAL_ENDING, {
    lawFirmId,
    trialEnd: subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString()
      : null,
  });
}

export async function handleSubscriptionInvoicePaid(invoice: any) {
  // Find the subscription and update last payment info
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;

  const subscription = await retrieveSubscriptionOrNull(subscriptionId);
  if (!subscription) return; // subscription gone; nothing to update (terminal)
  const lawFirmId = subscription.metadata?.lawFirmId;
  if (!lawFirmId) return;

  // Derive billingStatus from the REAL subscription status, not an unconditional
  // 'active': a paid invoice on a still-past_due or canceling subscription must not
  // force the firm to 'active'.
  const firmBefore = await lawfirmsRepo.findById(lawFirmId);
  if (await isEventForAnotherLiveSubscription(firmBefore, subscription.id, lawFirmId)) return;
  const patch: any = { billingStatus: mapSubscriptionBillingStatus(subscription.status) };
  // Only stamp a payment when money actually moved (skip $0 / fully-discounted
  // invoices, which would otherwise record a bogus $0 "last payment").
  if (Number(invoice.amount_paid) > 0) {
    // The moment Stripe collected it, not the moment this handler ran: a delayed
    // or replayed webhook would otherwise record the wrong day.
    patch.lastPaymentAt = invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
      : new Date().toISOString();
    patch.lastPaymentAmount = invoice.amount_paid; // in cents
  }
  const updatedFirm = await lawfirmsRepo.mergePlan(lawFirmId, patch);
  reportStatusChange(lawFirmId, firmBefore?.plan?.billingStatus ?? null, updatedFirm);
}

export async function handlePaymentFailed(invoice: any) {
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;

  const subscription = await retrieveSubscriptionOrNull(subscriptionId);
  if (!subscription) return; // subscription gone; nothing to update (terminal)
  const lawFirmId = subscription.metadata?.lawFirmId;
  if (!lawFirmId) return;

  // Stripe sends a distinct invoice.payment_failed webhook for every dunning
  // retry over its ~2-4 week cycle, each with its own event id, so the
  // notification dedupe window (60s, outbox-retry idempotency only) doesn't
  // collapse them. Alert admins once per dunning episode: only when this
  // failure is what moves the firm INTO past_due, not on every retry while
  // it's already there. A later failure after recovering (billingStatus back
  // to active) is a new episode and alerts again.
  const firm = await lawfirmsRepo.findById(lawFirmId);
  if (await isEventForAnotherLiveSubscription(firm, subscription.id, lawFirmId)) return;
  const alreadyPastDue = firm?.plan?.billingStatus === 'past_due';

  const updatedFirm = await lawfirmsRepo.mergePlan(lawFirmId, {
    billingStatus: 'past_due',
  });

  if (!alreadyPastDue) {
    eventBus.emit(SUBSCRIPTION_PAYMENT_FAILED, { lawFirmId });
    if (updatedFirm) {
      captureServerEvent({
        event: 'subscription_payment_failed',
        lawFirmId,
        properties: {
          ...analyticsPlanProperties(firm?.plan),
          from_status: firm?.plan?.billingStatus ?? null,
        },
      });
    }
  }
  reportStatusChange(lawFirmId, firm?.plan?.billingStatus ?? null, updatedFirm);
}

/**
 * Reconcile firms' stored billing state against Stripe. Webhooks are the primary
 * sync path, but a missed or failed delivery can leave a firm showing an
 * access-granting status (trial/active) after Stripe already moved it to
 * past_due/canceled — i.e. indefinite free access, or the reverse (a firm left
 * locked after a payment recovered). This safety-net sweep pulls the live
 * subscription for every firm that has one and, only when the mapped status
 * diverges from what is stored, re-runs the canonical webhook handler to converge —
 * reusing all its guards and side effects instead of duplicating them. It gates on
 * billingStatus so an in-sync firm is never rewritten (no spurious plan writes or
 * notifications); cosmetic drift in period dates is intentionally left alone.
 * Comped/unlimitedOverride firms are skipped (intentionally free). Best-effort per
 * firm; returns a summary. Intended for a scheduled sweep.
 *
 * `limit` bounds the sweep by firm count; `deadline` (epoch ms, shared across the
 * cron request) bounds it by wall clock, since every firm with a subscription
 * costs a serial Stripe retrieve regardless of whether anything diverged.
 *
 * Both bounds truncate the SAME tail: firms come back ordered by creation date,
 * and an in-sync firm stays in the candidate set forever, so the oldest firms are
 * always scanned first and the newest are the ones dropped. That is the safer end
 * to drop — a firm too new to have been reached has also had less time to drift —
 * but it is a starvation risk if the sweep stops finishing, which `truncated`
 * exists to make visible.
 */
export async function reconcileBillingStatuses({ limit = 1000, deadline = null }: any = {}) {
  if (!stripe) throw new ValidationError('Stripe is not configured');
  const firms = await lawfirmsRepo.listWithStripeSubscription(limit);
  const summary = { scanned: firms.length, processed: 0, reconciled: 0, inSync: 0, skipped: 0, skippedStale: 0, truncated: false, failures: [] as any[] };

  for (const firm of firms) {
    if (deadline && Date.now() >= deadline) { summary.truncated = true; break; }
    summary.processed += 1;
    const lawFirmId = firm.lawFirmId || firm.id;
    try {
      const plan = firm.plan || {};
      // Intentionally-free firms have no billable subscription to reconcile.
      if (plan.comped === true || plan.unlimitedOverride === true) { summary.skipped += 1; continue; }

      const subId = plan.stripeSubscriptionId;
      if (!subId) { summary.skipped += 1; continue; }

      const sub = await retrieveSubscriptionOrNull(subId);

      // Subscription gone or terminal on Stripe → revert to the free tier exactly as
      // the deleted webhook would. handleSubscriptionDeleted nulls the subscription
      // id, so the firm drops out of this sweep on the next run (idempotent).
      if (!sub || sub.status === 'canceled' || sub.status === 'incomplete_expired') {
        await handleSubscriptionDeleted(sub || { id: subId, metadata: { lawFirmId } });
        summary.reconciled += 1;
        continue;
      }

      const expected = mapSubscriptionBillingStatus(sub.status);
      if ((plan.billingStatus || null) === expected) { summary.inSync += 1; continue; }

      // Diverged (e.g. stored 'active'/'trialing' but Stripe says 'past_due'): converge
      // through the canonical handler so the firm is locked/unlocked correctly. The
      // handler can no-op on its own guards, so only count a real write as reconciled.
      const outcome = await handleSubscriptionChange(sub);
      if (outcome === 'updated') {
        summary.reconciled += 1;
      } else if (outcome === 'skipped_no_plan') {
        // The subscription's Stripe price id is not in the plan map (rotated/legacy
        // price), so the handler wrote nothing and this diverged firm keeps its
        // access-granting stored status. Surface it instead of silently counting it
        // as reconciled.
        const reason = 'stripe price id not in plan map';
        summary.failures.push({ lawFirmId, error: reason });
        console.warn(`reconcileBillingStatuses: firm ${lawFirmId} not reconciled (${reason}); stored status '${plan.billingStatus || null}' left unchanged`);
      } else {
        // 'skipped_stale' (terminal/out-of-order event) is benign; the next sweep
        // reconciles once the ordering settles.
        summary.skippedStale += 1;
      }
    } catch (err: any) {
      summary.failures.push({ lawFirmId, error: err.message });
    }
  }
  if (summary.truncated) {
    console.warn(
      `reconcileBillingStatuses: budget exhausted after ${summary.processed}/${summary.scanned} firm(s); ` +
      'the remaining firms were not checked against Stripe this run'
    );
  }
  return summary;
}
