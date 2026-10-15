/**
 * The reminder-email sweep for `events` rows, shared by matter events and
 * standalone client events.
 *
 * Everything that decides WHETHER and WHOM to remind is here once: the per-firm
 * settings (`law_firms.settings.matterEventReminders`, which governs every
 * event reminder whatever its parent), the day arithmetic in the event's zone,
 * recipient resolution (assignees, else the creator, else the firm's owner and
 * admins, each checked for current membership), the per-recipient email
 * preference, and the claim-before-send guard. What differs per parent is only
 * which rows to read, how to claim one, and where its link points, which is the
 * `EventReminderSource` adapter each caller supplies.
 */

const { sendMatterEventReminderEmail } = require('../services/emailService');
const { remindersGloballyDisabled, disabledReminderStats } = require('../utils/reminderControl');
const { resolveUserInfo, wasSentRecently, daysUntil } = require('../utils/reminderUtils');
const { forEachFirm, firmAdminRecipients, isFirmMember } = require('../utils/reminderHelpers');
const { EMAIL_CATEGORIES, isUserEmailCategoryEnabled } = require('../services/emailPreferences');

/** One event the sweep may remind about, with what the email shows beside it. */
export interface ReminderCandidate {
  event: any;
  /** Where "View in Paralegix" goes. */
  eventUrl: string;
  /** The matter the event belongs to, shown under the event. Null for none. */
  matterName: string | null;
}

/** What a parent supplies to the sweep. */
export interface EventReminderSource {
  /** The `forEachFirm` pass name and the log prefix. */
  passName: string;
  /**
   * This firm's events that might be due a reminder. Returning extra rows is
   * safe (the sweep re-checks status, date and window); omitting one is not.
   */
  loadCandidates(
    lawFirmId: string,
    context: { deadline: number | null; daysBefore: number[] },
  ): Promise<ReminderCandidate[]>;
  /** Claim the right to send this event's reminder. True if this call won it. */
  claim(lawFirmId: string, event: any): Promise<boolean>;
  /** Undo a claim whose sends all failed, so the next sweep retries. */
  release(lawFirmId: string, event: any, previousSentAt: string | null): Promise<void>;
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  court_date: 'Court Date',
  hearing: 'Hearing',
  deposition: 'Deposition',
  filing_deadline: 'Filing Deadline',
  discovery_cutoff: 'Discovery Cutoff',
  mediation: 'Mediation',
  arbitration: 'Arbitration',
  trial: 'Trial',
  appeal_deadline: 'Appeal Deadline',
  statute_of_limitations: 'Statute of Limitations',
  meeting: 'Meeting',
  other: 'Other',
};

/**
 * The zone an event's day is read in: its own when it stored one, else its
 * creator's, checked for current membership first for the reason
 * `resolveEventRecipients` gives; UTC when there is none.
 */
async function eventDayZone(event: any, lawFirmId: string, { userInfoCache, membershipCache }: any) {
  if (event.timeZone) return event.timeZone;
  if (!event.createdBy || !(await isFirmMember(lawFirmId, event.createdBy, membershipCache))) return 'UTC';
  const creator = await resolveUserInfo(event.createdBy, lawFirmId, userInfoCache);
  return creator?.timezone || 'UTC';
}

/**
 * Resolve recipients for an event.
 * Priority: assignees, then the creator, then firm owner + admins (fallback, pre-computed).
 */
async function resolveEventRecipients(event: any, lawFirmId: string, { userInfoCache, membershipCache, fallbackRecipients }: any = {}) {
  const recipients = [];

  if (Array.isArray(event.assignedTo) && event.assignedTo.length > 0) {
    for (const uid of event.assignedTo) {
      if (!(await isFirmMember(lawFirmId, uid, membershipCache))) continue;
      const info = await resolveUserInfo(uid, lawFirmId, userInfoCache);
      if (info) recipients.push(info);
    }
  }

  // `created_by` is an audit field, not a live membership list - it is never
  // scrubbed when its author leaves the firm (other features read it purely
  // for display, e.g. "created by Jane Doe", and must keep working after Jane
  // is gone). So this fallback can't rely on the row being cleaned up the way
  // assignees are; it has to check current membership itself before treating
  // a former member as someone to email.
  if (recipients.length === 0 && event.createdBy && (await isFirmMember(lawFirmId, event.createdBy, membershipCache))) {
    const info = await resolveUserInfo(event.createdBy, lawFirmId, userInfoCache);
    if (info) recipients.push(info);
  }

  if (recipients.length === 0 && Array.isArray(fallbackRecipients)) {
    recipients.push(...fallbackRecipients);
  }

  return recipients;
}

/** Send the reminders one parent's events are due, for one firm or all of them. */
export async function sendEventReminders(
  source: EventReminderSource,
  lawFirmId: string | undefined,
  { deadline = null }: { deadline?: number | null } = {},
) {
  if (remindersGloballyDisabled()) return disabledReminderStats();

  const stats = { sent: 0, skipped: 0, errors: 0 };
  const tag = `[${source.passName}]`;

  const coverage = await forEachFirm(source.passName, async (firm: any) => {
    const fid = firm.id;
    try {
      const firmName = firm.name || null;

      // Per-firm settings with defaults
      const settings = firm.settings?.matterEventReminders || {};
      const enabled = settings.enabled !== false; // default true
      const daysBefore: number[] = settings.daysBefore || [1, 7];

      if (!enabled) {
        stats.skipped++;
        return;
      }

      // Cache user info lookups for the duration of this firm's run
      const userInfoCache = new Map();
      // Cache created-by membership checks for the duration of this firm's run
      const membershipCache = new Map();
      // Lazy-resolve admin fallback recipients only if we actually need them
      let fallbackRecipients: any = null;
      const getFallbackRecipients = async () => {
        if (fallbackRecipients !== null) return fallbackRecipients;
        fallbackRecipients = await firmAdminRecipients(fid, userInfoCache);
        return fallbackRecipients;
      };

      let candidates: ReminderCandidate[];
      try {
        candidates = await source.loadCandidates(fid, { deadline, daysBefore });
      } catch (err: any) {
        console.error(`${tag} Failed to query events for firm ${fid}:`, err.message);
        stats.errors++;
        return;
      }

      for (const { event, eventUrl, matterName } of candidates) {
        // Skip cancelled or completed events, or those without dates
        if (!event.date || event.status === 'cancelled' || event.status === 'completed') {
          stats.skipped++;
          continue;
        }

        const days = daysUntil(event.date, await eventDayZone(event, fid, { userInfoCache, membershipCache }), event.allDay === true);

        // Check if days matches any configured daysBefore trigger, or is today
        const isUpcoming = daysBefore.includes(days);
        const isDueToday = days === 0;

        if (days < 0 || (!isUpcoming && !isDueToday)) {
          stats.skipped++;
          continue;
        }

        // Don't re-send within 24h. Cheap in-memory reject first; the claim
        // below is the authoritative test.
        if (wasSentRecently(event.lastReminderSentAt)) {
          stats.skipped++;
          continue;
        }

        // CLAIM BEFORE SENDING, for the same reason as task reminders: the
        // check above is a read, and "send then stamp" lets two overlapping
        // sweeps both pass it and mail the same recipient twice.
        const previousSentAt = event.lastReminderSentAt || null;
        if (!(await source.claim(fid, event))) {
          stats.skipped++;
          continue;
        }

        let recipients = await resolveEventRecipients(event, fid, { userInfoCache, membershipCache });
        if (recipients.length === 0) {
          recipients = await resolveEventRecipients(event, fid, {
            userInfoCache,
            membershipCache,
            fallbackRecipients: await getFallbackRecipients(),
          });
        }
        if (recipients.length === 0) {
          stats.skipped++;
          continue;
        }

        const eventDate = new Date(event.date);

        let anySent = false;
        for (const recipient of recipients) {
          try {
            if (!(await isUserEmailCategoryEnabled(recipient.userId, EMAIL_CATEGORIES.EVENT_REMINDER))) {
              stats.skipped++;
              continue;
            }
            // A timed event is a real instant: render it in the recipient's
            // saved zone so the emailed time matches their clock (UTC when
            // they have none). An all-day event is only its day, stored at
            // the noon-UTC anchor, so it is its date alone, read in UTC.
            const dateFormatted = event.allDay === true
              ? eventDate.toLocaleDateString('en-US', {
                month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
              })
              : eventDate.toLocaleDateString('en-US', {
                month: 'long', day: 'numeric', year: 'numeric',
                hour: 'numeric', minute: '2-digit',
                timeZone: recipient.timezone || 'UTC',
              });
            const result = await sendMatterEventReminderEmail({
              to: recipient.email,
              lawFirmId: fid,
              recipientName: recipient.name,
              lawFirmName: firmName,
              eventTitle: event.title,
              eventType: EVENT_TYPE_LABELS[event.type] || event.type,
              eventDate: dateFormatted,
              eventUrl,
              reminderType: isDueToday ? 'due_today' : 'upcoming',
              daysUntil: Math.abs(days),
              matterName,
            });

            if (result.sent !== false) {
              anySent = true;
              stats.sent++;
            } else {
              stats.skipped++;
            }
          } catch (err: any) {
            console.error(`${tag} Failed to send for event ${event.id} to ${recipient.email}:`, err.message);
            stats.errors++;
          }
        }

        // The claim already stamped it; only a total failure needs undoing, so
        // the next sweep retries rather than treating this as reminded.
        if (!anySent) {
          try {
            await source.release(fid, event, previousSentAt);
          } catch (err: any) {
            console.error(`${tag} Failed to release claim for event ${event.id}:`, err.message);
          }
        }
      }
    } catch (err: any) {
      console.error(`${tag} Error processing firm ${fid}:`, err.message);
      stats.errors++;
    }
  }, { lawFirmId, deadline });

  return { ...stats, ...coverage };
}
