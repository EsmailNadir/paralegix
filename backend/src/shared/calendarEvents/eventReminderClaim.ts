/**
 * The claim-before-send guard for an `events` row's reminder email, shared by
 * matter events and standalone client events.
 *
 * Reading `last_sent_at` in JavaScript and stamping it after the send is a
 * check-then-act: two overlapping reminder sweeps both decide to send and the
 * recipient gets the same nudge twice. The window lives in the statement's
 * `where` instead, so the database picks one winner. Reminder state is the
 * shared `reminders` row keyed by `event_id` (migration 0245), which is why one
 * implementation serves both parents.
 *
 * `parent` names which kind of event the caller means and holds the claim to
 * it: a matter sweep can only claim a matter event, a client sweep only a
 * standalone client event (`matter_id is null`), so neither can claim a row the
 * other owns.
 */

import { events } from '../database/drizzle/schema';
import { tenantParameterizedQuery } from '../database/queryContext';
const { isUuid } = require('../utils/isUuid');

export type EventReminderParent =
  | { kind: 'matter'; matterId: string }
  | { kind: 'client'; clientId: string };

/** The parent predicate on alias `e`, with its id bound as `$2`. */
function parentFilter(parent: EventReminderParent): { clause: string; id: string } {
  return parent.kind === 'matter'
    ? { clause: 'e.matter_id = $2', id: parent.matterId }
    : { clause: 'e.client_id = $2 and e.matter_id is null', id: parent.clientId };
}

const toTimestamp = (v: unknown): Date | null => {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(v as string);
};

/**
 * Claim the right to send this event's reminder, BEFORE the email goes out.
 * An event with no `reminders` row yet is claimed by the INSERT, one with a row
 * by the DO UPDATE whose WHERE holds the window.
 *
 * @returns true if this call won the right to send.
 */
export async function claimEventReminder(
  lawFirmId: string,
  parent: EventReminderParent,
  eventId: string,
  withinHours = 24,
): Promise<boolean> {
  const { clause, id } = parentFilter(parent);
  if (!isUuid(eventId) || !isUuid(id)) return false;
  const hours = Math.max(0, Math.trunc(Number(withinHours)));
  const { rows } = await tenantParameterizedQuery(events, lawFirmId,
    `insert into reminders (law_firm_id, event_id, last_sent_at, sent_count)
     select e.law_firm_id, e.id, now(), 1
       from events e
      where e.law_firm_id = $1 and ${clause} and e.id = $3
     on conflict (law_firm_id, event_id) where event_id is not null
     do update set last_sent_at = now(), sent_count = reminders.sent_count + 1
      where reminders.last_sent_at is null
         or reminders.last_sent_at < now() - make_interval(hours => $4::int)
     returning reminders.id`,
    [lawFirmId, id, eventId, hours],
    'e',
  );
  return rows.length > 0;
}

/** Undo a reminder claim whose sends all failed, so the next sweep retries. */
export async function releaseEventReminder(
  lawFirmId: string,
  parent: EventReminderParent,
  eventId: string,
  previous: unknown = null,
): Promise<void> {
  const { clause, id } = parentFilter(parent);
  if (!isUuid(eventId) || !isUuid(id)) return;
  await tenantParameterizedQuery(events, lawFirmId,
    `update reminders r
        set last_sent_at = $4, sent_count = greatest(r.sent_count - 1, 0)
       from events e
      where r.event_id = e.id
        and e.law_firm_id = $1 and ${clause} and e.id = $3`,
    [lawFirmId, id, eventId, toTimestamp(previous)],
    'e',
  );
}
