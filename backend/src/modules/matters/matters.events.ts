import { and, eq, inArray } from 'drizzle-orm';
import { matterMembers } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
import { scopedDelete } from '../../shared/database/scopedWrite';
import { clearEventAssignees, clearReminderRecipients, clearTaskAssignees } from './members/memberAssignments';

const eventBus = require('../../shared/events/eventBus');
const { MEMBER_REMOVED, MATTER_MEMBERS_UPDATED } = require('../../shared/events/eventTypes');

/**
 * USER_NAME_UPDATED no longer needs a handler here: member, lead, and note
 * author names are resolved via JOINs at read time (no denormalized copies to
 * keep in sync). The legacy cascade has been removed.
 *
 * When a member is removed from a law firm, drop their matter_members rows in that
 * firm and notify (so the tasks module can re-derive visibility).
 */
eventBus.on(MEMBER_REMOVED, async ({ lawFirmId, userId }: any) => {
  try {
    // Drop the user's task assignments, explicit task reminder recipients and
    // event assignees across the firm. Each is an independent path onto reminder
    // emails (assignedTo is derived from task_assignees at read time;
    // `tasks.reminder_recipient_ids` and the event assignee rows are resolved
    // through a membership-blind user lookup), so leaving any one keeps a
    // removed member receiving a task's or event's title, date and matter name
    // after their access ends. The same steps run when a member leaves a single
    // matter; here no matter narrows them, so client events are covered too.
    // Each step is isolated so one failing does not stop the others or the
    // membership delete below.
    const firmScope = { lawFirmId, userId };
    try {
      await clearTaskAssignees(firmScope);
    } catch (err: any) {
      console.error('matters.events: clearing task_assignees on member removal failed:', err.message);
    }
    try {
      await clearReminderRecipients(firmScope);
    } catch (err: any) {
      console.error('matters.events: clearing reminder_recipient_ids on member removal failed:', err.message);
    }
    try {
      await clearEventAssignees(firmScope);
    } catch (err: any) {
      console.error('matters.events: clearing events.assigned_to on member removal failed:', err.message);
    }

    const removed = await scopedDelete(matterMembers, lawFirmId, eq(matterMembers.userId, userId));
    if (!removed.length) return;

    const matterIds = removed.map((row) => row.matterId);
    const remaining = await tenantQuery(matterMembers, lawFirmId, ({ executor, scope }) => executor
      .select({ matterId: matterMembers.matterId, userId: matterMembers.userId })
      .from(matterMembers).where(and(scope, inArray(matterMembers.matterId, matterIds))));
    const memberIdsByMatter = new Map<string, string[]>();
    for (const row of remaining) {
      const memberIds = memberIdsByMatter.get(row.matterId) || [];
      memberIds.push(row.userId);
      memberIdsByMatter.set(row.matterId, memberIds);
    }

    for (const matterId of matterIds) {
      try {
        eventBus.emit(MATTER_MEMBERS_UPDATED, {
          lawFirmId,
          matterId,
          memberUserIds: memberIdsByMatter.get(matterId) || [],
          // The person being removed from the FIRM is removed from each of
          // these matters too, so the calendar listener has to be told which
          // user to unwind. Without it that listener returns early and the
          // ex-member keeps every hearing and deadline for every matter they
          // were on, on their own Google or Outlook calendar, after their
          // access to this firm has ended. Same gap `removeMembers` carried at
          // the per-matter level.
          removedUserIds: [userId],
        });
      } catch (err: any) {
        console.error(`matters.events: notify after member removal for matter ${matterId} failed:`, err.message);
      }
    }
  } catch (err: any) {
    console.error('matters.events: MEMBER_REMOVED handler failed:', err);
  }
});

// This module only registers listeners; it exports nothing. The empty
// export marks it as a MODULE so its top-level consts are file-scoped
// rather than colliding in the global scope with every other events file.
export {};
