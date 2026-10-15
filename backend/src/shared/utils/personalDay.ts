/**
 * "Today" for a person, for anything that defaults a day to today on their
 * behalf: a payment's date, a time entry's date.
 *
 * A day-only value belongs to the zone of whoever it is for. The UTC day is the
 * wrong one for everyone west of UTC every evening (after 5pm Pacific it is
 * already tomorrow), so the day is read in, in order: the zone the person's
 * request carries, the zone saved on their user row (every request keeps it
 * current), and only then UTC.
 */

const usersRepo = require('../../modules/users/users.repository');
const { localDateFor } = require('./localTime');
const { normalizeTimeZone } = require('./time');
const membersRepo = require('../../modules/lawfirms/members/members.repository');
const lawfirmsRepo = require('../../modules/lawfirms/lawfirms.repository');

/** The zone a person's day is read in. */
export async function personalZone({ timeZone, userId }: { timeZone?: unknown; userId?: string | null }): Promise<string> {
  if (typeof timeZone === 'string' && timeZone.trim()) return normalizeTimeZone(timeZone);
  if (userId) {
    const saved = await usersRepo.getSettings(userId).catch(() => null);
    if (saved?.timezone) return normalizeTimeZone(saved.timezone);
  }
  return 'UTC';
}

/** Today, 'YYYY-MM-DD', for that person. */
export async function personalToday(who: { timeZone?: unknown; userId?: string | null }): Promise<string> {
  return localDateFor(await personalZone(who));
}

/**
 * The zone a firm's day is read in, for work no person does (a Stripe webhook's
 * payment or trust entry, a nightly reminder or late-fee pass): the firm's own
 * `settings.timezone` when it is set, else the zone saved on the firm's owner,
 * else UTC. Pass `settings` when the caller already holds the firm row.
 */
export async function firmZone(lawFirmId: string | null | undefined, settings?: any): Promise<string> {
  if (!lawFirmId) return 'UTC';
  const firmSettings = settings !== undefined
    ? settings
    : (await lawfirmsRepo.findById(lawFirmId).catch(() => null))?.settings;
  if (typeof firmSettings?.timezone === 'string' && firmSettings.timezone.trim()) {
    return normalizeTimeZone(firmSettings.timezone);
  }
  const ownerId = await membersRepo.findOwnerUserId(lawFirmId).catch(() => null);
  const owner = ownerId ? await usersRepo.getSettings(ownerId).catch(() => null) : null;
  return normalizeTimeZone(owner?.timezone);
}
