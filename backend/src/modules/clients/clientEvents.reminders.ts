/**
 * Reminder emails for standalone client events: an `events` row with a
 * `client_id` and no `matter_id`.
 *
 * The sweep is the one matter events use (`shared/calendarEvents/eventReminderSweep`):
 * the same firm settings, recipients (assignees, else the creator, else the
 * firm's owner and admins) and claim on the shared `reminders` row. This file
 * says which rows are client events and how to claim one.
 *
 * A matter event that names a client is NOT read here. It shows on that
 * client's Events tab, but the matter sweep owns its reminder, and
 * `findForReminders` excludes it so the assignee is told once.
 */

import { sendEventReminders, type EventReminderSource } from '../../shared/calendarEvents/eventReminderSweep';
const clientEventsRepo = require('./clientEvents.repository');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 500;

/**
 * The UTC instants an event can sit between and still be due a reminder today.
 * The sweep decides the exact day in the event's own zone, so the window is
 * padded by a day either side of today and of the furthest `daysBefore`; the
 * sweep's own check drops anything the padding lets through.
 */
function reminderWindow(daysBefore: number[]) {
  const offsets = daysBefore.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  const furthest = offsets.length ? Math.max(...offsets) : 0;
  const now = Date.now();
  return {
    fromUtc: new Date(now - 2 * DAY_MS),
    toUtc: new Date(now + (furthest + 2) * DAY_MS),
  };
}

const clientEventSource: EventReminderSource = {
  passName: 'clientEventReminders',

  async loadCandidates(fid, { deadline, daysBefore }) {
    const { fromUtc, toUtc } = reminderWindow(daysBefore);
    const events = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      if (deadline && Date.now() >= deadline) break;
      const page = await clientEventsRepo.findForReminders(fid, { fromUtc, toUtc, limit: PAGE_SIZE, offset });
      events.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return events.map((event: any) => ({
      event,
      eventUrl: `${FRONTEND_URL}/lawfirm/${fid}/clients/${event.clientId}`,
      // The email labels this line "Matter", and a client event has none.
      matterName: null,
    }));
  },

  claim: (fid, event) => clientEventsRepo.claimReminderSend(fid, event.clientId, event.id),
  release: (fid, event, previousSentAt) => clientEventsRepo.releaseReminderClaim(fid, event.clientId, event.id, previousSentAt),
};

/** Send standalone client event reminders for a specific law firm (or all firms). */
export async function sendClientEventReminders(lawFirmId: string | undefined, { deadline = null }: any = {}) {
  return sendEventReminders(clientEventSource, lawFirmId, { deadline });
}
