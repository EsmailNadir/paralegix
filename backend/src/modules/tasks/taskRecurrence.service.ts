import { withDrizzleTransaction } from '../../shared/database/queryContext';
/**
 * Task Recurrence Service
 *
 * Processes recurring tasks: when a recurring task is completed,
 * generates the next occurrence with a new due date.
 * Called by the daily cron job.
 */

const { forEachFirm } = require('../../shared/utils/reminderHelpers');
const tasksRepo = require('./tasks.repository');
const { taskDueInstant } = require('./taskDue');
const { shiftedEnd } = require('../../shared/validation/eventRange');
const { dayAnchor, zonedWallClock, wallClockToUtc } = require('../../shared/utils/time');
const eventBus = require('../../shared/events/eventBus');
const { TASK_CREATED } = require('../../shared/events/eventTypes');

/** Extract the date-only ('YYYY-MM-DD') portion of a date string or Date. */
function dateOnly(v: any) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') return v.slice(0, 10);
  return null;
}

/**
 * Parse a date-only value as its `dayAnchor` (noon UTC), so date math (done in
 * UTC below) never rolls back a day in negative-offset timezones the way
 * `new Date('YYYY-MM-DD')` (UTC-midnight) does.
 */
function noonUtc(v: any) {
  const d = dateOnly(v);
  return d ? dayAnchor(d) : null;
}

/** The local clock time of `instant` in `timeZone`, on the local day `day`, as an instant. */
function sameLocalTimeOn(day: string | null, instant: any, timeZone: any) {
  if (!day) return null;
  const clock = zonedWallClock(new Date(instant), timeZone).slice(11, 19);
  return wallClockToUtc(`${day}T${clock}`, timeZone);
}

/**
 * Calculate the next due date based on the recurrence pattern.
 * Returns a Date at noon UTC; all arithmetic uses UTC mutators.
 */
function calculateNextDueDate(currentDueDate: any, recurrence: any) {
  const next = noonUtc(currentDueDate);
  if (!next) return null;
  const interval = recurrence.interval || 1;

  switch (recurrence.pattern) {
    case 'daily':
      next.setUTCDate(next.getUTCDate() + interval);
      break;

    case 'weekly':
      if (Array.isArray(recurrence.daysOfWeek) && recurrence.daysOfWeek.length > 0) {
        // Find next matching day of week
        const days = [...recurrence.daysOfWeek].sort();
        const currentDay = next.getUTCDay();
        let found = false;
        for (const day of days) {
          if (day > currentDay) {
            next.setUTCDate(next.getUTCDate() + (day - currentDay));
            found = true;
            break;
          }
        }
        if (!found) {
          // Wrap to next week's first matching day
          const daysUntilNextWeek = 7 - currentDay + days[0];
          next.setUTCDate(next.getUTCDate() + daysUntilNextWeek + (interval - 1) * 7);
        }
      } else {
        next.setUTCDate(next.getUTCDate() + 7 * interval);
      }
      break;

    case 'monthly': {
      // Roll the month WITHOUT letting a 29/30/31 source day overflow into the
      // following month: setUTCMonth while the date still holds day 31 overflows
      // (Jan 31 + 1mo -> Mar 3), silently skipping the short month. Snap to day 1,
      // roll the month, then clamp to that month's last day.
      const targetDay = recurrence.dayOfMonth || next.getUTCDate();
      next.setUTCDate(1);
      next.setUTCMonth(next.getUTCMonth() + interval);
      const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
      next.setUTCDate(Math.min(targetDay, lastDay));
      break;
    }

    case 'custom':
      // Custom uses interval as days
      next.setUTCDate(next.getUTCDate() + interval);
      break;

    default:
      next.setUTCDate(next.getUTCDate() + 1);
  }

  return next;
}

/**
 * Process recurring tasks for all firms (or a specific firm).
 * Finds completed recurring tasks and creates the next occurrence.
 *
 * @param {string|undefined} lawFirmId
 * @returns {{ created: number, skipped: number, errors: number }}
 */
export async function processRecurringTasks(lawFirmId: string, { deadline = null }: any = {}) {
  const stats = { created: 0, skipped: 0, errors: 0 };

  const coverage = await forEachFirm('taskRecurrence', async (firm: any) => {
    const fid = firm.id;
    try {
      // Find completed tasks with active recurrence
      const completed = await tasksRepo.findRecurringCompleted(fid);

      for (const task of completed) {
        const rec = task.recurrence;

        if (!rec || !rec.enabled || !task.dueDate) {
          stats.skipped++;
          continue;
        }

        // Check maxOccurrences limit
        if (rec.maxOccurrences && rec.occurrenceCount >= rec.maxOccurrences) {
          // Disable recurrence: limit reached
          try {
            await tasksRepo.disableRecurrence(fid, task.id, undefined, task.recurrenceVersion);
          } catch { /* ignore */ }
          stats.skipped++;
          continue;
        }

        // Check endDate limit
        const nextDue = calculateNextDueDate(task.dueDate, rec);
        if (rec.endDate) {
          const end = noonUtc(rec.endDate);
          if (end && nextDue && nextDue > end) {
            try {
              await tasksRepo.disableRecurrence(fid, task.id, undefined, task.recurrenceVersion);
            } catch { /* ignore */ }
            stats.skipped++;
            continue;
          }
        }

        // Clone the task with a new due date and reset status
        try {
          // An all-day task stays all-day with no dueAt, mirroring `resolveDue`
          // in tasks.service.ts. A timed task keeps its LOCAL clock time: the
          // day is the task's local day, so the time has to be read and put
          // back in the task's own zone too. Doing it in UTC gave an evening
          // task the old instant again, and shifted it an hour across DST.
          const nextDueOnly = dateOnly(nextDue);
          const nextDueAt = (!task.allDay && task.dueAt)
            ? sameLocalTimeOn(nextDueOnly, task.dueAt, task.dueDateTimeZone)
            : null;

          const newTaskDoc = {
            matterId: task.matterId || null,
            lawFirmId: fid,
            assignedTo: task.assignedTo || [],
            assignedToName: task.assignedToName || [],
            createdBy: task.createdBy,
            createdByName: task.createdByName,
            practiceAreaId: task.practiceAreaId || null,
            practiceAreaName: task.practiceAreaName || null,
            courtId: task.courtId || null,
            courtName: task.courtName || null,
            title: task.title,
            description: task.description || '',
            location: task.location || null,
            status: 'open',
            priority: task.priority || 'medium',
            dueDate: nextDue,
            dueAt: nextDueAt,
            // The end moves with the start, so each occurrence keeps the length.
            endsAt: shiftedEnd(taskDueInstant(task), task.endsAt ? new Date(task.endsAt) : null,
              taskDueInstant({ dueDate: nextDueOnly, dueAt: nextDueAt })),
            allDay: task.allDay === true,
            dueDateTimeZone: task.dueDateTimeZone || null,
            visibleToUserIds: task.visibleToUserIds || [],
            clientIds: task.clientIds || [],
            clientNames: task.clientNames || [],
            // Carry the reminder configuration onto each generated occurrence;
            // otherwise it silently reverts to the assignee/admin default.
            reminderRecipientIds: task.reminderRecipientIds || [],
            sendReminderEarly: task.sendReminderEarly === true,
            source: 'recurrence',
            attachments: [],
            recurrence: {
              ...rec,
              occurrenceCount: (rec.occurrenceCount || 0) + 1,
              sourceTaskId: rec.sourceTaskId || task.id,
            },
          };

          const created = await withDrizzleTransaction(async (transaction) => {
            // The conditional claim serializes workers; a failed insert restores it for retry.
            const claimed = await tasksRepo.disableRecurrence(fid, task.id, transaction, task.recurrenceVersion);
            if (!claimed) return null;
            return tasksRepo.createTask(fid, newTaskDoc, undefined, transaction);
          });
          if (!created) {
            stats.skipped++;
            continue;
          }

          // Emit event
          eventBus.emit(TASK_CREATED, {
            lawFirmId: fid,
            taskId: created.id,
            entityData: created,
            userId: task.createdBy,
          });

          stats.created++;
        } catch (err: any) {
          console.error(`[taskRecurrence] Failed to create next occurrence for task ${task.id}:`, err.message);
          stats.errors++;
        }
      }
    } catch (err: any) {
      console.error(`[taskRecurrence] Error processing firm ${fid}:`, err.message);
      stats.errors++;
    }
  }, { lawFirmId, deadline });

  return { ...stats, ...coverage };
}
