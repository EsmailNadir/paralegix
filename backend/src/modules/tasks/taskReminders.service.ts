/**
 * Task Reminder Service
 *
 * Sends due-date reminders for tasks based on per-firm settings.
 * Called by the daily cron job alongside invoice reminders.
 */

const { sendTaskDueReminderEmail } = require('../../shared/services/emailService');
const { remindersGloballyDisabled, disabledReminderStats } = require('../../shared/utils/reminderControl');
const { forEachFirm, resolveUserInfo, firmAdminRecipients } = require('../../shared/utils/reminderHelpers');
const tasksRepo = require('./tasks.repository');
const { dayAnchor } = require('../../shared/utils/time');
const { localDateFor } = require('../../shared/utils/localTime');
const {
  EMAIL_CATEGORIES,
  getEmailPrefsForUsers,
  resolveUserCategory,
} = require('../../shared/services/emailPreferences');
const { DEFAULTS } = require('../settings/settings.defaults');
const { createHash } = require('crypto');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

/** Shipped digest schedule, overlaid by whatever the user has stored. */
const DEFAULT_DIGEST_CONFIG = DEFAULTS.user.notifications.digest;

/**
 * Whether a recipient receives the daily digest, which already covers every task
 * this pass would email about. Without this check a digest recipient gets the
 * summary and a separate per-task reminder for the same work on the same day.
 *
 * `notifications.digest.enabled` is the single authority: there is deliberately
 * no `digest` key in the email category map, because two booleans gating one
 * email can disagree.
 *
 * Fails CLOSED toward the per-task email: an unreadable preference means the
 * recipient still hears about the task.
 */
function receivesDigest(preferences: any) {
  const stored = preferences?.notifications?.digest;
  const merged = {
    ...DEFAULT_DIGEST_CONFIG,
    ...(stored && typeof stored === 'object' ? stored : {}),
  };
  return merged.enabled !== false;
}

/**
 * Resolve recipients for a task.
 * - Assigned task: assignee
 * - Unassigned task: firm owner + admins
 */
export async function resolveTaskRecipients(task: any, lawFirmId: string, cache: any) {
  const recipients: any[] = [];

  const assignedUserIds = Array.isArray(task.assignedTo)
    ? task.assignedTo.filter(Boolean)
    : (task.assignedTo ? [task.assignedTo] : []);

  if (assignedUserIds.length > 0) {
    for (const uid of assignedUserIds) {
      const assigneeInfo = await resolveUserInfo(uid, lawFirmId, cache);
      if (assigneeInfo && !recipients.some((recipient) => recipient.email === assigneeInfo.email)) {
        recipients.push({ ...assigneeInfo, creatorNotification: false, userId: uid });
      }
    }
  } else {
    // Unassigned: notify firm owner + admins. These recipients get no userId -
    // they are a fallback for a task nobody owns, not a subscription the
    // recipient chose, so there is no per-user preference to consult here.
    const admins = await firmAdminRecipients(lawFirmId, cache);
    for (const info of admins) recipients.push({ ...info, creatorNotification: false });
  }

  return recipients;
}

/**
 * Render a day-only value (Postgres `date` 'YYYY-MM-DD' string, or a Date) at
 * its `dayAnchor` (noon UTC), the anchor the whole task pipeline uses, so day
 * comparisons are timezone-consistent.
 */
function dayOnlyToNoonUtc(value: any) {
  if (!value) return null;
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  return dayAnchor(value);
}

/**
 * Compute days until due. Positive = future, 0 = today, negative = overdue.
 *
 * "Today" is the day in `timeZone`, the zone the due day belongs to. Taking
 * the UTC day instead made a task due today read as overdue every evening in
 * the Americas. Both days are anchored at noon UTC so the difference is a
 * whole number of days.
 */
function daysUntilDue(dueDate: any, timeZone: any) {
  const due = dayOnlyToNoonUtc(dueDate);
  if (!due) return null;
  const nowDay = dayAnchor(localDateFor(timeZone));
  return Math.round((due.getTime() - nowDay.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * The zone a task's due day was set in: its own when it has one, else its
 * creator's (an all-day task imported from a calendar carries none), else UTC.
 */
async function dueDayZone(task: any, lawFirmId: string, userInfoCache: any) {
  if (task.dueDateTimeZone) return task.dueDateTimeZone;
  const creator = task.createdBy ? await resolveUserInfo(task.createdBy, lawFirmId, userInfoCache) : null;
  return creator?.timezone || 'UTC';
}

/**
 * Determine reminder type from days until due.
 * Default behavior is "due today" only.
 * A task can opt into a day-early reminder with `sendReminderEarly`.
 */
function getReminderType(task: any, days: any) {
  if (days === 1 && task?.sendReminderEarly === true) return 'upcoming';
  if (days === 0) return 'due_today';
  return null;
}

/**
 * Send task due-date reminders for a specific law firm (or all firms if lawFirmId is omitted).
 *
 * @param {string|undefined} lawFirmId
 * @returns {{ sent: number, skipped: number, errors: number }}
 */
export async function sendTaskReminders(lawFirmId: string, { deadline = null }: any = {}) {
  if (remindersGloballyDisabled()) return disabledReminderStats();

  const stats = { sent: 0, skipped: 0, errors: 0 };

  const coverage = await forEachFirm('taskReminders', async (firm: any) => {
    const fid = firm.id;
    try {
      const firmName = firm.name || null;
      const userInfoCache = new Map();

      // Preferences are read once per user per firm pass, not once per task:
      // this loop is nested three deep and the same few users recur throughout.
      const emailPrefsCache = new Map();
      const prefsFor = async (uid: string) => {
        if (!uid) return {};
        if (!emailPrefsCache.has(uid)) {
          const loaded = await getEmailPrefsForUsers([uid]);
          emailPrefsCache.set(uid, loaded.get(uid) || {});
        }
        return emailPrefsCache.get(uid);
      };

      // Check firm-level settings (with defaults)
      const taskReminderSettings = firm.settings?.taskReminders || {};
      const enabled = taskReminderSettings.enabled !== false; // default true
      if (!enabled) {
        stats.skipped++;
        return;
      }

      // Query all non-completed tasks with a dueDate
      let tasks;
      try {
        tasks = await tasksRepo.findReminderCandidates(fid);
      } catch (err: any) {
        console.error(`[taskReminders] Failed to query tasks for firm ${fid}:`, err.message);
        stats.errors++;
        return;
      }

      for (const task of tasks) {
        if (!task.dueDate) {
          stats.skipped++;
          continue;
        }

        const days = daysUntilDue(task.dueDate, await dueDayZone(task, fid, userInfoCache));
        const reminderType = getReminderType(task, days);

        if (!reminderType) {
          stats.skipped++;
          continue;
        }

        // If explicit recipients are set on the task, use those; otherwise fall back to defaults
        let recipients;
        if (Array.isArray(task.reminderRecipientIds) && task.reminderRecipientIds.length > 0) {
          recipients = [];
          for (const uid of task.reminderRecipientIds) {
            const info = await resolveUserInfo(uid, fid, userInfoCache);
            if (info) recipients.push({ ...info, creatorNotification: false, userId: uid });
          }
        } else {
          recipients = await resolveTaskRecipients(task, fid, userInfoCache);
        }

        if (recipients.length === 0) {
          stats.skipped++;
          continue;
        }

        // Format due date for display. `task.dueDate` is a 'YYYY-MM-DD' string;
        // anchor at noon UTC and format in UTC so the displayed day never shifts.
        const due = dayOnlyToNoonUtc(task.dueDate);
        const dueDateFormatted = due
          ? due.toLocaleDateString('en-US', {
            month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
          })
          : '';

        const taskUrl = `${FRONTEND_URL}/lawfirm/${fid}/tasks`;

        const seen = new Set();
        for (const recipient of recipients) {
          const recipientKey = createHash('sha256').update(recipient.email.trim().toLowerCase()).digest('hex');
          if (seen.has(recipientKey)) continue;
          seen.add(recipientKey);
          const recipientPrefs = await prefsFor(recipient.userId);
          if (!resolveUserCategory(recipientPrefs, EMAIL_CATEGORIES.TASK_DUE)) {
            stats.skipped++;
            continue;
          }
          // Only recipients identified by a user id are checked: the owner/admin
          // fallback for an unassigned task carries no user id, so there is no
          // preference to read and no basis for assuming a digest covers them.
          if (recipient.userId && receivesDigest(recipientPrefs)) {
            stats.skipped++;
            continue;
          }
          const claim = await tasksRepo.claimReminderSend(fid, task.id, recipientKey);
          if (!claim) {
            stats.skipped++;
            continue;
          }
          let completed = false;
          try {
            const result = await sendTaskDueReminderEmail({
              to: recipient.email,
              recipientName: recipient.name,
              lawFirmName: firmName,
              taskTitle: task.title,
              dueDate: dueDateFormatted,
              taskUrl,
              reminderType,
              daysOverdue: null,
              matterName: task.matterName || null,
              creatorNotification: recipient.creatorNotification,
              assigneeName: task.assignedToName || null,
              idempotencyKey: `task-reminder/${claim.id}/${claim.sentCount}`,
            });

            if (result.sent) {
              completed = await tasksRepo.completeReminderSend(fid, task.id, recipientKey, claim.token);
              if (completed) stats.sent++;
              else stats.errors++;
            } else {
              stats.skipped++;
            }
          } catch (err: any) {
            console.error(`[taskReminders] Failed to send reminder for task ${task.id} to ${recipient.email}:`, err.message);
            stats.errors++;
          } finally {
            if (!completed) {
              try {
                await tasksRepo.releaseReminderClaim(fid, task.id, recipientKey, claim.token);
              } catch (err: any) {
                console.error(`[taskReminders] Failed to release reminder claim for task ${task.id}:`, err.message);
                stats.errors++;
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.error(`[taskReminders] Error processing firm ${fid}:`, err.message);
      stats.errors++;
    }
  }, { lawFirmId, deadline });

  return { ...stats, ...coverage };
}
