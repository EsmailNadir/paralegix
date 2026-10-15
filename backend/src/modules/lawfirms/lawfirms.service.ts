const { admin } = require('../../shared/database/firebase');
const lawfirmsRepo = require('./lawfirms.repository');
const membersRepo = require('./members/members.repository');
const usersRepo = require('../users/users.repository');
const practiceAreasRepo = require('../practiceAreas/practiceAreas.repository');
const chargeCodesRepo = require('../billing/chargeCodes/chargeCodes.repository');
const leadStagesRepo = require('../leads/stages/leadStages.repository');
const intakeFormsRepo = require('../leads/intakeForms.repository');
const rolesService = require('./roles/roles.service');
const { trustTxnRepo } = require('../trust/trust.repository');
const { NotFoundError, ForbiddenError, ValidationError, ConflictError } = require('../../shared/errors/AppError');
const { canUserJoinMoreFirms } = require('../../shared/plans/userLimits');
const eventBus = require('../../shared/events/eventBus');
const { LAWFIRM_DELETED, LAWFIRM_DELETION_REQUESTED, MEMBER_ADDED } = require('../../shared/events/eventTypes');
const { normalizeStorageSettings } = require('../../shared/plans/storageQuota');
const { getEffectiveLimits } = require('../../shared/plans/planDefinitions');
const { signUserPhotoUrl } = require('../../shared/utils/userPhoto');
const { DEFAULT_PRACTICE_AREAS, DEFAULT_CHARGE_CODES } = require('../../shared/referenceData/defaults');
import { withDrizzleTransaction } from '../../shared/database/queryContext';
import { withTransactionEffects, type TransactionEffects } from '../../shared/database/transactionEffects';
import { captureServerEvent } from '../../shared/analytics/serverAnalytics';

const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';
const BASE_FOLDER = 'lawfirmids';

// How long a soft-deleted firm's data is retained before the housekeeping cron
// is allowed to hard-purge it. State bar client-file retention rules commonly
// run 5-10 years after a matter closes (varies by state and practice area —
// there is no single universal number); this is one flat, conservative default
// applied to the whole firm rather than tracking per-matter/per-jurisdiction
// windows, which would need retention metadata this app doesn't collect today.
// Override via env for a firm/region that needs a different number.
const DELETION_RETENTION_YEARS = Number(process.env.FIRM_DELETION_RETENTION_YEARS) || 10;

// The create form's firm-size options. `firmSize` is free text on the wire, so
// only these exact values are reported to analytics; anything else is 'other'.
const ANALYTICS_FIRM_SIZES = new Set(['1', '2-5', '6-20', '21-50', '51+']);

function analyticsFirmSize(firmSize: any): string {
  const size = typeof firmSize === 'string' ? firmSize.trim() : '';
  if (!size) return 'not_specified';
  return ANALYTICS_FIRM_SIZES.has(size) ? size : 'other';
}

/**
 * Create a new law firm with defaults. `plan` lets a caller override the default
 * (e.g. admin test-firm tooling). Otherwise the firm starts on an immediate
 * 14-day Professional trial: full access now, no card required.
 */
export async function createLawFirm({ name, userId, plan, firmSize, practiceArea }: any) {
  const user = await usersRepo.findById(userId);
  if (!user) throw new NotFoundError('User');

  // New firms start on a 14-day trial with full access, no Stripe checkout
  // required. `trialConsumed: true` stops a later real checkout from stacking
  // a second Stripe-side trial on top of this one.
  const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const effectivePlan = plan || {
    planId: 'professional',
    billingStatus: 'trialing',
    trialEndsAt,
    trialConsumed: true,
    comped: false,
    assignedAt: new Date().toISOString(),
    assignedBy: 'system',
  };

  // Storage quota must be seeded into the TYPED columns, not just the settings
  // jsonb: `reserveStorageUsage` enforces against `storage_quota_bytes` /
  // `storage_hard_limit` inline in SQL, and a null quota or a false hard limit
  // makes its WHERE clause always match — i.e. no quota enforcement at all. The
  // quota comes from the firm's own plan (honoring any seeded overrides) so it
  // agrees with what `getSubscriptionStatus` reports back to the firm.
  const planQuotaBytes = getEffectiveLimits({ plan: effectivePlan }).storageQuotaBytes;

  const lawFirmId = await withDrizzleTransaction(async (transaction) => {
    await usersRepo.lockForMembershipChange(userId, transaction);
    const lawFirmIds = await usersRepo.getLawFirmIdsForUser(userId, transaction);
    if (!canUserJoinMoreFirms({ ...user, lawFirmIds })) {
      throw new ValidationError({ lawFirm: ['You have reached the maximum number of law firm memberships'] });
    }
    const firm = await lawfirmsRepo.create({
      name: name?.trim() || 'New Law Firm',
      plan: effectivePlan,
      settings: {
        storage: normalizeStorageSettings({ quotaBytes: planQuotaBytes }),
        ...(firmSize?.trim() || practiceArea?.trim()
          ? { firmInfo: { size: firmSize?.trim() || undefined, practiceArea: practiceArea?.trim() || undefined } }
          : {}),
      },
      storageQuotaBytes: planQuotaBytes,
      storageUsedBytes: 0,
      storageHardLimit: true,
    }, transaction);
    const firmId = firm.id;
    const roleMap = await rolesService.seedBuiltInRoles(firmId, transaction);
    await membersRepo.addMember(firmId, userId, { roleId: roleMap.owner, isOwner: true, joinedAt: new Date() }, transaction);

    // Keep all defaults on the same connection so a failed seed rolls back the firm.
    for (const [index, paName] of DEFAULT_PRACTICE_AREAS.entries()) {
      await practiceAreasRepo.create(firmId, { name: paName, order: index + 1, createdBy: userId }, transaction);
    }
    for (const [index, cc] of DEFAULT_CHARGE_CODES.entries()) {
      await chargeCodesRepo.create(firmId, { code: cc.code, name: cc.name, isActive: true, order: index + 1, createdBy: userId }, transaction);
    }
    await leadStagesRepo.seedDefaultPipeline(firmId, transaction);
    await intakeFormsRepo.createDefaultTemplate(firmId, { createdBy: userId }, transaction);
    return firmId;
  });
  eventBus.emit(MEMBER_ADDED, { lawFirmId, userId });

  // Only the admin test-account tooling passes an explicit plan; the create
  // route never does, so its presence is what separates the two.
  captureServerEvent({
    event: 'law_firm_created',
    lawFirmId,
    distinctId: userId,
    properties: {
      firm_size: analyticsFirmSize(firmSize),
      has_practice_area: Boolean(typeof practiceArea === 'string' && practiceArea.trim()),
      created_via: plan ? 'admin' : 'self_serve',
    },
  });

  return { lawFirmId };
}

/**
 * Get law firm details.
 */
export async function getLawFirm(lawFirmId: string) {
  const firm = await lawfirmsRepo.findById(lawFirmId);
  if (!firm) throw new NotFoundError('Law firm');

  // Sign the stored logo path for the client. The shared signer confirms the
  // object exists (signing alone doesn't, so a stale path would hand back a URL
  // that 404s), caches the result — this record is read on every page load — and
  // yields null when the object is gone or signing fails.
  if (firm.logoObjectPath) {
    firm.logoUrl = await signUserPhotoUrl(firm.logoObjectPath, firm.updatedAt);
  }

  return firm;
}

/**
 * Update law firm info.
 */
export async function updateLawFirm(lawFirmId: string, data: any) {
  const firm = await lawfirmsRepo.findById(lawFirmId);
  if (!firm) throw new NotFoundError('Law firm');

  const allowedFields = ['name', 'description', 'address', 'city', 'state', 'zip', 'phone', 'email'];
  const updateData: Record<string, any> = {};
  for (const field of allowedFields) {
    if (data[field] !== undefined) {
      updateData[field] = data[field];
    }
  }

  return lawfirmsRepo.update(lawFirmId, updateData);
}

/**
 * Refuse to delete a firm that holds a matter or client under legal hold, or
 * whose trust ledger holds permanent entries. Checked in that order to match
 * the per-entity guards (matters.service#assertMatterIsDeletable,
 * clients.service#removeClient): legal hold first, then trust activity.
 *
 * `PATCH .../matters/:id/legal-hold` and the per-entity delete routes already
 * refuse to touch a held matter or client one at a time, but `purgeLawFirm`
 * does not go through either of those routes: it is a direct `delete from
 * law_firms` cascade. Without this check a litigation hold placed on one
 * matter would not stop the automated retention purge from destroying it (and
 * every other record in the firm) once the firm's own retention window
 * elapsed, which is exactly the outcome the hold exists to prevent.
 *
 * The trust ledger is append-only: a DB trigger blocks deleting a completed or
 * void `trust_transactions` row, and that trigger fires for cascaded deletes
 * too. So `delete from law_firms` aborts partway with a raw trigger error for
 * any firm that ever recorded trust activity. Checking up front turns an
 * unexplained 500 into an explanation, and keeps the ledger intact: client
 * trust records are retained on purpose, not incidentally.
 */
async function assertLawFirmIsDeletable(lawFirmId: string) {
  if (await lawfirmsRepo.countLegalHoldByLawFirmId(lawFirmId) > 0) {
    throw new ConflictError(
      'This firm has a matter or client under legal hold and cannot be deleted. Lift the hold before the firm can be purged.'
    );
  }
  if (await trustTxnRepo.countPermanentByLawFirmId(lawFirmId) > 0) {
    throw new ConflictError(
      'This firm has trust account activity and cannot be deleted. Trust ledger entries are permanent records and must be retained.'
    );
  }
}

/**
 * Tear down the state a firm holds outside this database, before its row goes.
 *
 * Everything here is unreachable once the firm row is deleted: the Stripe
 * subscription id lives on the firm's `plan` blob, and stopping a calendar watch
 * needs the channel/subscription rows that cascade away with the firm. Left
 * behind, the subscription keeps charging a customer with no firm to bill for and
 * the providers keep pushing notifications nothing can act on.
 *
 * Best-effort per resource: a firm must still be deletable when Stripe or Google
 * is unreachable, so each failure is logged and the teardown continues.
 */
async function releaseExternalResources(lawFirmId: string) {
  const firm = await lawfirmsRepo.findById(lawFirmId);

  const subscriptionId = firm?.plan?.stripeSubscriptionId;
  if (subscriptionId) {
    // Cancel outright rather than at period end: there will be no firm left to
    // serve for the remainder of the period, so the unused time is prorated back
    // (matching the admin cancel path) instead of being charged for.
    const stripe = require('../stripe/stripe.config');
    if (stripe) {
      try {
        await stripe.subscriptions.cancel(subscriptionId, { prorate: true });
      } catch (err: any) {
        console.error(`lawfirms.service: failed to cancel subscription ${subscriptionId} for deleted firm ${lawFirmId}:`, err.message);
      }
    }
  }

  // Lazy-required: the calendar services pull in the firm/matter read paths, and
  // a top-level require here would close a cycle.
  const googleService = require('../calendar/google/google.service');
  const outlookService = require('../calendar/outlook/outlook.service');
  const calendarSyncRepo = require('../calendar/shared/calendarSync.repository');
  await Promise.allSettled([
    googleService.stopWatchChannelsForLawFirm(lawFirmId),
    outlookService.stopSubscriptionsForLawFirm(lawFirmId),
    // These rows carry no FK to law_firms, so the cascade never reaches them and
    // the retry sweep would keep working a deleted firm's queue forever.
    calendarSyncRepo.deleteWebhookFailuresForLawFirm(lawFirmId),
  ]);
}

/**
 * Soft-delete a law firm: stop billing/external sync immediately, but only
 * stamp a retention window instead of destroying data. See
 * DELETION_RETENTION_YEARS above — signed documents, invoices, and matter
 * records are commonly subject to a 5-10 year legal retention requirement that
 * an instant delete made impossible to honor. The firm becomes inaccessible to
 * every member the moment this returns (see assertLawFirmMembership /
 * loadResolvedMember), same as before, but nothing is actually gone until
 * purgeLawFirm runs, and only once deletion_purge_after has passed.
 */
export async function requestLawFirmDeletion(lawFirmId: string, requestedBy: any, context?: TransactionEffects) {
  return withTransactionEffects(async ({ executor, defer }) => {
    const firm = await lawfirmsRepo.requestDeletion(lawFirmId, {
      requestedBy,
      retentionYears: DELETION_RETENTION_YEARS,
    }, executor);
    defer(() => {
      eventBus.emit(LAWFIRM_DELETION_REQUESTED, { lawFirmId, requestedBy, purgeEligibleAt: firm.deletionPurgeAfter });
    });
    defer(() => releaseExternalResources(lawFirmId));
    return firm;
  }, context);
}

/**
 * Undo a pending soft-delete. Only meaningful before purgeLawFirm has actually
 * run (the row still has to exist to restore). No membership/permission check
 * here deliberately — callers are expected to gate this themselves, since the
 * normal membership path (assertLawFirmMembership) treats a pending-deletion
 * firm as inaccessible and would make this endpoint unreachable by its own
 * owner if it went through that helper.
 */
export async function restoreLawFirm(lawFirmId: string) {
  const firm = await lawfirmsRepo.findById(lawFirmId);
  if (!firm) throw new NotFoundError('Law firm');
  return lawfirmsRepo.cancelDeletionRequest(lawFirmId);
}

/**
 * Hard-delete a law firm and all associated data. Every child table (members,
 * clients, matters, tasks, invoices, roles, practice areas, charge codes,
 * conversations, messages, signature sessions, …) declares ON DELETE CASCADE
 * against law_firms, so a single row delete tears down the whole firm. Then we
 * purge the firm's GCS files and emit LAWFIRM_DELETED for any further cleanup.
 *
 * Only ever called by purgeEligibleFirms once deletion_purge_after has passed,
 * never synchronously from a route. assertLawFirmIsDeletable still runs here:
 * a firm with an active legal hold or permanent trust-ledger activity can
 * never actually be purged (a held record must be preserved, and the DB
 * trigger would abort a trust-ledger cascade anyway), so this keeps failing
 * cleanly with a ConflictError instead of leaving the row soft-deleted forever
 * with no explanation.
 */
async function purgeLawFirm(lawFirmId: string) {
  await assertLawFirmIsDeletable(lawFirmId);

  await lawfirmsRepo.delete(lawFirmId);

  // Delete all GCS files for the firm. A failure here is not recoverable by
  // retrying (the firm row is already gone), so it is logged loudly with the
  // prefix an operator needs to finish the purge by hand.
  const prefix = `${BASE_FOLDER}/${lawFirmId}/`;
  try {
    const bucket = admin.storage().bucket(BUCKET_NAME);
    await bucket.deleteFiles({ prefix, force: true });
  } catch (error) {
    console.error(
      `lawfirms.service: GCS purge INCOMPLETE for deleted firm ${lawFirmId}. Objects may remain under ${prefix} and require manual deletion:`,
      error
    );
  }

  eventBus.emit(LAWFIRM_DELETED, { lawFirmId });
}

/**
 * Cron entry point (housekeeping, daily): purge every firm whose retention
 * window has cleared. A firm blocked by an active legal hold or by permanent
 * trust-ledger activity is left pending indefinitely, which mirrors today's
 * behavior (such a firm was previously entirely undeletable), just scoped to
 * firms that actually have a hold or trust history instead of blocking every
 * deletion up front.
 */
export async function purgeEligibleFirms() {
  const eligible = await lawfirmsRepo.findPurgeEligible();
  const results = { purged: 0, blockedByLegalHold: 0, blockedByTrustLedger: 0, failed: 0 };
  for (const firm of eligible) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose: each
      // purge does a full-cascade delete + bucket wipe, not something to fan out.
      await purgeLawFirm(firm.id);
      results.purged += 1;
    } catch (err: any) {
      if (err instanceof ConflictError) {
        // assertLawFirmIsDeletable is the only source of a ConflictError here,
        // and it always throws one of these two exact messages. Matched
        // rather than tracked with a bespoke error subclass because this is
        // the sole caller of either.
        if (err.message.includes('legal hold')) {
          results.blockedByLegalHold += 1;
        } else {
          results.blockedByTrustLedger += 1;
        }
      } else {
        console.error(`lawfirms.service: purge failed for firm ${firm.id}:`, err);
        results.failed += 1;
      }
    }
  }
  return results;
}
