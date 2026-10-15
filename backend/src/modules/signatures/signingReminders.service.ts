const crypto = require('crypto');
const repo = require('./signatures.repository');
const { getActiveParticipant } = require('./signingSessions');
const { sendParticipantInvitation } = require('./signingNotifications');
const { remindersGloballyDisabled, disabledReminderStats } = require('../../shared/utils/reminderControl');
// Shared timestamp coercion (consolidated module-wide helper).
const { toMs } = require('./timeUtils');
const { zonedDayString, dayAnchor } = require('../../shared/utils/time');
const { localDateFor } = require('../../shared/utils/localTime');
const { firmZone } = require('../../shared/utils/personalDay');

// Coerce a stored timestamp into a Date (or null) via the shared epoch helper.
function toDate(value: any) {
  const ms = toMs(value);
  return ms > 0 ? new Date(ms) : null;
}

/**
 * Whole days from the day signing started to today, both on the firm's
 * calendar (`timeZone`). They were counted from the SERVER's midnight, which
 * sent a day-1 reminder on the day signing started for a firm far from it.
 */
function daysSince(startAt: any, timeZone: string) {
  const date = toDate(startAt);
  if (!date) return null;
  const startDay = zonedDayString(date, timeZone);
  const today = localDateFor(timeZone);
  if (!startDay) return null;
  return Math.round((dayAnchor(today).getTime() - dayAnchor(startDay).getTime()) / (1000 * 60 * 60 * 24));
}

function wasSentInLast24Hours(value: any) {
  const sentAt = toDate(value);
  if (!sentAt) return false;
  return (Date.now() - sentAt.getTime()) < 24 * 60 * 60 * 1000;
}

function expiresWithinTwoDays(expiresAt: any) {
  const expiry = toDate(expiresAt);
  if (!expiry) return false;
  return (expiry.getTime() - Date.now()) <= 2 * 24 * 60 * 60 * 1000;
}

export async function sendSigningReminders() {
  if (remindersGloballyDisabled()) return disabledReminderStats();

  const stats = { sent: 0, skipped: 0, errors: 0 };
  // S3: candidates are pre-filtered in SQL (active participant 1/3/5 days in and
  // not reminded in the last 24h), so we only load graphs for sessions that
  // actually qualify instead of every pending/in-progress session.
  const sessions = await repo.listReminderCandidates();

  for (const sessionData of sessions) {
    const activeParticipant = getActiveParticipant(sessionData);
    if (!activeParticipant) {
      stats.skipped += 1;
      continue;
    }

    // Re-assert the SQL predicate in JS as a defensive guard (cheap, keeps the
    // exact day/24h boundary semantics identical to the previous behavior).
    const startBase = activeParticipant.startedAt || sessionData.startedAt || sessionData.createdAt;
    const elapsedDays = daysSince(startBase, await firmZone(sessionData.lawFirmId));
    if (![1, 3, 5].includes(elapsedDays || -1)) {
      stats.skipped += 1;
      continue;
    }

    if (wasSentInLast24Hours(activeParticipant.lastReminderSentAt)) {
      stats.skipped += 1;
      continue;
    }

    // CLAIM BEFORE SENDING. The check above is a read, and "send, then stamp"
    // is a check-then-act: two overlapping reminder sweeps both pass it and
    // the participant gets the same nudge twice. `claimReminderSend` moves
    // the 24h window into the `where` clause, so the database picks exactly
    // one winner. Losing means another worker is sending this one.
    const previousSentAt = activeParticipant.lastReminderSentAt || null;
    if (!(await repo.claimReminderSend(sessionData.token, activeParticipant.participantId))) {
      stats.skipped += 1;
      continue;
    }

    const expiringSoon = expiresWithinTwoDays(sessionData.expiresAt);
    const urgency = expiringSoon ? ' This request is close to expiring.' : '';

    try {
      const result = await sendParticipantInvitation({
        participant: activeParticipant,
        publicToken: activeParticipant.publicToken,
        lawFirmId: sessionData.lawFirmId,
        senderName: sessionData.notifyName || 'Paralegix',
        senderEmail: sessionData.notifyEmail || null,
        fileName: sessionData.fileName,
        message: `Reminder: please sign ${sessionData.fileName}.${urgency}`,
        reminder: true,
        notificationOverride: {
          type: 'signing_reminder',
          title: expiringSoon ? 'Signature request expiring soon' : 'Signature reminder',
          body: expiringSoon
            ? `Your signature on "${sessionData.fileName}" is still needed and this request is expiring soon`
            : `Reminder: your signature is still needed on "${sessionData.fileName}"`,
        },
      });

      if (!result.sent) {
        stats.skipped += 1;
        await repo.releaseReminderClaim(sessionData.token, activeParticipant.participantId, previousSentAt);
        continue;
      }

      // The claim already stamped last_reminder_sent_at / reminder_count, so
      // success needs no further write here.
      stats.sent += 1;
    } catch (err: any) {
      const tokenRef = crypto.createHash('sha256').update(String(sessionData.token)).digest('hex').slice(0, 12);
      console.error('[signingReminders] Failed for session', tokenRef, err.message);
      stats.errors += 1;
      try {
        await repo.releaseReminderClaim(sessionData.token, activeParticipant.participantId, previousSentAt);
      } catch (releaseErr: any) {
        console.error('[signingReminders] Failed to release reminder claim for session', tokenRef, releaseErr.message);
      }
    }
  }

  return stats;
}
