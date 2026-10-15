/**
 * Matter Event Reminder Service
 *
 * Sends reminder emails for upcoming matter events based on per-firm settings.
 * Called by the daily cron job alongside invoice and task reminders. The sweep
 * itself (settings, recipients, claim-before-send) is
 * `shared/calendarEvents/eventReminderSweep`, shared with client events; this
 * file says which rows are matter events and how to claim one.
 */

import { sendEventReminders, type EventReminderSource, type ReminderCandidate } from '../../shared/calendarEvents/eventReminderSweep';
const { listMatters } = require('../../shared/utils/reminderHelpers');
const matterEventsRepo = require('./matterEvents.repository');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const PAGE_SIZE = 500;

const matterEventSource: EventReminderSource = {
  passName: 'matterEventReminders',

  async loadCandidates(fid, { deadline }) {
    const matters = await listMatters(fid);
    if (matters.length === 0) return [];

    const matterNames: Record<string, any> = {};
    matters.forEach((c: any) => { matterNames[c.id] = c.name || null; });

    // Pull every event for all of the firm's matters in pages, then group by
    // matter so candidates come out matter by matter, in the order
    // `listMatters` returned them.
    const allEvents = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      if (deadline && Date.now() >= deadline) break;
      const page = await matterEventsRepo.findAllForMatters(fid, matters.map((c: any) => c.id), null, { limit: PAGE_SIZE, offset });
      allEvents.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    const eventsByMatter = new Map<string, any[]>();
    for (const ev of allEvents) {
      if (!eventsByMatter.has(ev.matterId)) eventsByMatter.set(ev.matterId, []);
      eventsByMatter.get(ev.matterId)!.push(ev);
    }

    const candidates: ReminderCandidate[] = [];
    for (const matterRow of matters) {
      for (const event of eventsByMatter.get(matterRow.id) || []) {
        candidates.push({
          event,
          eventUrl: `${FRONTEND_URL}/lawfirm/${fid}/matters/${matterRow.id}`,
          matterName: matterNames[matterRow.id] || null,
        });
      }
    }
    return candidates;
  },

  claim: (fid, event) => matterEventsRepo.claimReminderSend(fid, event.matterId, event.id),
  release: (fid, event, previousSentAt) => matterEventsRepo.releaseReminderClaim(fid, event.matterId, event.id, previousSentAt),
};

/**
 * Send matter event reminders for a specific law firm (or all firms).
 */
export async function sendMatterEventReminders(lawFirmId: string | undefined, { deadline = null }: any = {}) {
  return sendEventReminders(matterEventSource, lawFirmId, { deadline });
}
