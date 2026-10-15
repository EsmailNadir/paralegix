/**
 * Assembly for the daily digest: one email per recipient per firm per local day,
 * replacing the per-item reminder blast.
 *
 * The cron fires HOURLY, not once a day. Recipients pick a delivery hour in their
 * own IANA zone, and a single daily fire can only ever be the right hour for one
 * zone, so every hourly run walks every firm and serves only the recipients whose
 * local clock currently reads their configured hour.
 *
 * Because the same recipient is therefore evaluated ~24 times a day, "have we
 * already sent?" cannot be inferred from timing. It is answered by
 * `claimDigestSend`, whose `(law_firm_id, user_id, sent_on)` primary key makes the
 * claim atomic. The claim is taken BEFORE the send and released on every path that
 * does not result in a delivered email, so a failure retries on the next hour
 * instead of burning the recipient's whole day.
 */

const { addDays, isWeekend, localDateFor, localHourFor } = require('../../../shared/utils/localTime');
const { forEachFirm, resolveUserInfo } = require('../../../shared/utils/reminderHelpers');
const { remindersGloballyDisabled, disabledReminderStats } = require('../../../shared/utils/reminderControl');
const { getEmailPrefsForUsers } = require('../../../shared/services/emailPreferences');
const { DEFAULTS } = require('../../settings/settings.defaults');
import { and, eq, sql } from 'drizzle-orm';
import { members, roles } from '../../../shared/database/drizzle/schema';
import { tenantQuery } from '../../../shared/database/queryContext';
const { isUuid } = require('../../../shared/utils/isUuid');
const digestRepo = require('./digest.repository');

const {
  DIGEST_CAPS,
  DIGEST_WINDOW_DAYS,
  bucketItems,
  applyCaps,
  itemUrl,
  bucketUrl,
} = require('./digestBuckets');

/** Shipped digest schedule, overlaid by whatever the user has stored. */
const DEFAULT_DIGEST_CONFIG = DEFAULTS.user.notifications.digest;

/**
 * Permissions that let a member see the firm's receivables. Invoices are read
 * firm-wide (they belong to the books, not to a matter team), so this is the gate
 * that keeps them out of the digest of someone who cannot open them in the app.
 */
const BILLING_READ_PERMISSIONS = ['billing.viewInvoices', 'billing.manageInvoices'];

/**
 * Whether a member may see invoice lines in their digest.
 *
 * Owners always may; otherwise the member's role must carry a billing read
 * permission. Any failure returns false — a lookup error must not leak firm
 * receivables to a member whose permissions could not be confirmed.
 */
async function canSeeInvoices(lawFirmId: string, userId: string) {
  if (!isUuid(lawFirmId) || !userId) return false;
  try {
    const rows = await tenantQuery(members, lawFirmId, ({ executor, scope }) => executor
      .select({ userId: members.userId }).from(members)
      .leftJoin(roles, and(eq(roles.lawFirmId, members.lawFirmId), eq(roles.id, members.roleId)))
      .where(and(
        scope,
        eq(members.userId, userId),
        // `sql.param` binds the whole list as ONE array parameter. Interpolating
        // the array directly expands it into a placeholder LIST, so the overlap
        // reached Postgres as `&& ($3, $4)::text[]` - a row cast, which errors.
        // The catch below then answered false for everyone, owners included, and
        // no digest ever carried an invoice line.
        sql`(${members.isOwner} = true or ${roles.permissions} && ${sql.param(BILLING_READ_PERMISSIONS)}::text[])`,
      )).limit(1));
    return rows.length > 0;
  } catch (err: any) {
    console.error(`[digest] Billing permission lookup failed for ${lawFirmId}/${userId}:`, err.message);
    return false;
  }
}

/**
 * Merge a user's stored digest settings over the shipped defaults, discarding
 * values a settings write could have left in an unusable state (a non-integer or
 * out-of-range hour would silently mean "never", since no local clock matches it).
 */
function resolveDigestConfig(preferences: any) {
  const stored = preferences?.notifications?.digest;
  const merged = { ...DEFAULT_DIGEST_CONFIG, ...(stored && typeof stored === 'object' ? stored : {}) };
  const hour = Number(merged.hour);
  return {
    enabled: merged.enabled !== false,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_DIGEST_CONFIG.hour,
    days: merged.days === 'daily' ? 'daily' : 'weekdays',
  };
}

/**
 * Attach the deep links the email renders, so the template never has to know how
 * a URL is built for a given item kind.
 *
 * `userId` is threaded into the bucket links so a "+N more" opens the task list
 * scoped to the recipient rather than to the whole firm.
 */
function decorateBuckets(capped: any, lawFirmId: string, userId: string) {
  const out: Record<string, any> = {};
  for (const name of ['critical', 'overdue', 'today', 'tomorrow', 'week']) {
    const bucket = capped[name];
    out[name] = {
      shown: bucket.shown.map((item: any) => ({ ...item, url: itemUrl(lawFirmId, item) })),
      more: bucket.more,
      total: bucket.total,
      moreUrl: bucket.more > 0 ? bucketUrl(lawFirmId, name, bucket.overflowKinds, userId) : null,
    };
  }
  return out;
}

/**
 * Assemble and deliver one recipient's digest.
 *
 * Returns 'sent' only when an email actually went out; 'skipped' covers every
 * reason not to send (schedule, preferences, nothing due, a claim another run
 * already holds); 'error' means the send threw.
 *
 * @returns {Promise<'sent'|'skipped'|'error'>}
 */
export async function sendDigestForUser({ firm, userId, userInfoCache, now = new Date() }: any) {
  const lawFirmId = firm.id;

  const info = await resolveUserInfo(userId, lawFirmId, userInfoCache);
  if (!info?.email) return 'skipped';

  let preferences = {};
  try {
    const prefs = await getEmailPrefsForUsers([userId]);
    preferences = prefs.get(userId) || {};
  } catch (err: any) {
    // Absent preferences mean "shipped defaults", which is the same posture the
    // rest of the email layer takes when a preference read fails.
    console.error(`[digest] Preference lookup failed for ${userId}; using defaults:`, err.message);
  }

  const config = resolveDigestConfig(preferences);
  if (!config.enabled) return 'skipped';

  const timezone = info.timezone || 'UTC';
  if (localHourFor(timezone, now) !== config.hour) return 'skipped';

  const today = localDateFor(timezone, now);
  if (config.days === 'weekdays' && isWeekend(today)) return 'skipped';

  const windowEnd = addDays(today, DIGEST_WINDOW_DAYS);

  const [tasks, events, statutes] = await Promise.all([
    digestRepo.findDigestTasks(lawFirmId, userId, today, windowEnd),
    digestRepo.findDigestEvents(lawFirmId, userId, today, windowEnd, timezone),
    digestRepo.findDigestStatuteDates(lawFirmId, userId, today, windowEnd),
  ]);

  let invoices = [];
  if (await canSeeInvoices(lawFirmId, userId)) {
    invoices = await digestRepo.findDigestInvoices(lawFirmId, today, windowEnd);
  }

  const capped = applyCaps(bucketItems([...tasks, ...events, ...invoices, ...statutes], today));

  // A recurring "nothing due" email teaches recipients to filter the digest, so
  // an empty one is never sent.
  if (capped.totalItems === 0 && capped.critical.total === 0) return 'skipped';

  const claimed = await digestRepo.claimDigestSend(lawFirmId, userId, today, capped.totalItems);
  if (!claimed) return 'skipped';

  try {
    // Required lazily so this module loads (and its assembly is testable) before
    // the digest template exists in the email service.
    const { sendDailyDigestEmail } = require('../../../shared/services/emailService');
    if (typeof sendDailyDigestEmail !== 'function') {
      console.warn('[digest] sendDailyDigestEmail is not available; skipping send');
      await digestRepo.releaseDigestSend(lawFirmId, userId, today);
      return 'skipped';
    }

    const result = await sendDailyDigestEmail({
      to: info.email,
      recipientName: info.name || null,
      lawFirmId,
      lawFirmName: firm.name || null,
      localDate: today,
      timezone,
      buckets: decorateBuckets(capped, lawFirmId, userId),
      totalItems: capped.totalItems,
    });

    if (!result?.sent) {
      await digestRepo.releaseDigestSend(lawFirmId, userId, today);
      return 'skipped';
    }
    return 'sent';
  } catch (err: any) {
    console.error(`[digest] Send failed for ${lawFirmId}/${userId} on ${today}:`, err.message);
    await digestRepo.releaseDigestSend(lawFirmId, userId, today);
    return 'error';
  }
}

/**
 * Run the digest pass across every firm (or one firm, for a manual invocation).
 *
 * `now` is threaded through rather than read per recipient so a single pass makes
 * one consistent decision about what hour it is everywhere.
 *
 * @param {string|undefined} lawFirmId  run exactly one firm
 * @param {{deadline?: number, now?: Date}} options
 * @returns {Promise<{sent:number, skipped:number, errors:number}>} merged with the
 *   firm-coverage counters `forEachFirm` reports
 */
export async function sendDailyDigests(lawFirmId: string, { deadline = null, now = new Date() }: any = {}) {
  if (remindersGloballyDisabled()) return disabledReminderStats();

  const stats = { sent: 0, skipped: 0, errors: 0 };

  const coverage = await forEachFirm('dailyDigest', async (firm: any) => {
    if (firm.settings?.dailyDigest?.enabled === false || firm.settings?.emailNotificationsEnabled === false) {
      stats.skipped++;
      return;
    }

    let memberIds = [];
    try {
      memberIds = await digestRepo.listFirmMemberIds(firm.id);
    } catch (err: any) {
      console.error(`[digest] Failed to list members for firm ${firm.id}:`, err.message);
      stats.errors++;
      return;
    }

    const userInfoCache = new Map();
    for (const userId of memberIds) {
      // Checked per recipient rather than per firm: a large firm can exhaust the
      // request budget on its own, and the pass cursor only advances between firms.
      if (deadline && Date.now() >= deadline) break;
      try {
        const outcome = await sendDigestForUser({ firm, userId, userInfoCache, now });
        if (outcome === 'sent') stats.sent++;
        else if (outcome === 'error') stats.errors++;
        else stats.skipped++;
      } catch (err: any) {
        console.error(`[digest] Digest failed for ${firm.id}/${userId}:`, err.message);
        stats.errors++;
      }
    }
  }, { lawFirmId, deadline });

  return { ...stats, ...coverage };
}

// Re-exported so callers keep importing these from here.
export { bucketItems, applyCaps, itemUrl, bucketUrl, DIGEST_CAPS, DIGEST_WINDOW_DAYS };
