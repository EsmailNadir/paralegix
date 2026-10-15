/**
 * Notification event listeners.
 * Listens for task/matter/messaging/billing events and creates in-app
 * notifications for the affected users.
 */

const eventBus = require('../../shared/events/eventBus');
import { and, eq, sql } from 'drizzle-orm';
import { matterMembers, matters, members, roles } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
const {
  TASK_CREATED,
  TASK_UPDATED,
  TASK_DELETED,
  TASK_NOTE_CREATED,
  TASK_NOTE_REPLY_ADDED,
  MATTER_CREATED,
  MATTER_DELETED,
  MATTER_MEMBERS_UPDATED,
  MATTER_NOTE_CREATED,
  MATTER_NOTE_REPLY_ADDED,
  CLIENT_NOTE_CREATED,
  CLIENT_NOTE_REPLY_ADDED,
  MESSAGE_SENT,
  MESSAGES_READ,
  INVOICE_PAYMENT_RECEIVED,
  SIGNING_COMPLETED,
  SIGNING_DECLINED,
  SIGNING_PARTICIPANT_REMOVED,
  MEMBER_ROLE_CHANGED,
} = require('../../shared/events/eventTypes');
const { createNotifications, FRONTEND_URL } = require('./notifications.service');
const notificationsRepo = require('./notifications.repository');
const invoicesRepo = require('../billing/invoices/invoices.repository');
const { formatDollarsFromCents } = require('../billing/shared/money');

/** Normalize an assignee value (scalar or array) into a clean array. */
function toAssigneeArray(value: any) {
  return Array.isArray(value) ? value : (value ? [value] : []);
}

/** Dedupe an id list and drop falsy ids plus the acting user (no self-notify). */
function uniqueRecipients(ids: any, excludeId: any) {
  return Array.from(new Set((ids || []).filter(Boolean))).filter((id) => id !== excludeId);
}

/**
 * Deep link to a single task, falling back to the task list when the event
 * carried no id. Landing on the list and making the reader hunt for the task
 * they were just assigned defeats the notification.
 */
function taskUrl(lawFirmId: string, taskId: string) {
  const base = `${FRONTEND_URL}/lawfirm/${lawFirmId}/tasks`;
  return taskId ? `${base}/${taskId}` : base;
}

/**
 * Deep link to one note on a parent's Notes tab. Every parent page opens the tab
 * from `?tab=notes` and scrolls to the note named by `?note=`.
 */
function noteUrl(lawFirmId: string, parentBase: 'matters' | 'tasks' | 'clients', parentId: string, noteId: string) {
  return `${FRONTEND_URL}/lawfirm/${lawFirmId}/${parentBase}/${parentId}?tab=notes&note=${noteId}`;
}

/**
 * Deep link to a single client's Notes tab, falling back to the client list
 * when the event carried no id.
 */
function clientUrl(lawFirmId: string, clientId: string) {
  const base = `${FRONTEND_URL}/lawfirm/${lawFirmId}/clients`;
  return clientId ? `${base}/${clientId}?tab=notes` : base;
}

/**
 * Deep link to a single conversation, falling back to the message list when the
 * event carried no id. Group threads need `?type=group` to load, matching how the
 * messages page routes its own rows.
 */
function conversationUrl(lawFirmId: string, conversationId: string, conversationType: any) {
  const base = `${FRONTEND_URL}/lawfirm/${lawFirmId}/messages`;
  if (!conversationId) return base;
  return `${base}/${conversationId}${conversationType === 'group' ? '?type=group' : ''}`;
}

/** Best-effort matter display name for notification bodies; '' on any failure. */
async function getMatterName(lawFirmId: string, matterId: string) {
  try {
    const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
      .select({ name: matters.name }).from(matters)
      .where(and(scope, eq(matters.id, matterId))).limit(1));
    return (rows[0] && rows[0].name) || '';
  } catch {
    return '';
  }
}

/** Best-effort user ids of a matter's team; [] on any failure or missing matter. */
async function getMatterMemberIds(lawFirmId: string, matterId: string) {
  if (!matterId) return [];
  try {
    const rows = await tenantQuery(matterMembers, lawFirmId, ({ executor, scope }) => executor
      .select({ userId: matterMembers.userId }).from(matterMembers)
      .where(and(scope, eq(matterMembers.matterId, matterId))));
    return rows.map((r: any) => r.userId).filter(Boolean);
  } catch {
    return [];
  }
}
/**
 * Shared assignment-notification fan-out. Normalizes the new/previous assignee
 * lists, skips the acting user (no self-notify) and anyone already assigned
 * (dedupe against the previous set), then creates one notification per newly
 * assigned user via `buildPayload()`.
 *
 * This consolidates the identical normalize / skip-self / dedupe / create loop
 * shared by the TASK listeners. Each caller only supplies the per-notification
 * payload, preserving their distinct title/body/entity shape.
 *
 * `buildPayload` takes no arguments: the payload is identical for every
 * recipient today (no per-assignee deep links). It's called once per new
 * assignee inside the loop so a future per-recipient variant can be added by
 * giving it the assignee id then. The current API does not promise that.
 */
async function notifyNewAssignees({ lawFirmId, assignees, previousAssignees, actorUserId, buildPayload }: any) {
  const newAssigned = toAssigneeArray(assignees);
  const prevSet = new Set(toAssigneeArray(previousAssignees));

  // Skip the actor (no self-notify) and anyone already assigned before, then
  // create one notification per newly assigned user in a single batched insert.
  const recipients = newAssigned.filter(
    (assigneeId) => !prevSet.has(assigneeId) && assigneeId !== actorUserId
  );
  if (!recipients.length) return;

  await createNotifications(lawFirmId, recipients, buildPayload());
}

/**
 * Notify users when they are assigned to a task.
 */
eventBus.on(TASK_CREATED, async ({ lawFirmId, entityData, userId }: any) => {
  try {
    if (!entityData || !lawFirmId) return;

    await notifyNewAssignees({
      lawFirmId,
      assignees: entityData.assignedTo,
      previousAssignees: [],
      actorUserId: userId,
      buildPayload: () => ({
        category: 'taskAssigned',
        type: 'task_assigned',
        title: 'New task assigned',
        body: `You were assigned to "${entityData.title || 'a task'}"`,
        entityType: 'task',
        entityId: entityData.id || entityData.taskId,
        matterId: entityData.matterId || null,
        actionUrl: taskUrl(lawFirmId, entityData.id || entityData.taskId),
        createdBy: userId,
      }),
    });
  } catch (err: any) {
    console.error('[notifications.events] TASK_CREATED handler error:', err.message);
  }
});

/**
 * Notify users when they are newly assigned to a task (on update).
 */
eventBus.on(TASK_UPDATED, async ({ lawFirmId, entityData, userId, previousData }: any) => {
  try {
    if (!entityData || !lawFirmId) return;

    await notifyNewAssignees({
      lawFirmId,
      assignees: entityData.assignedTo,
      previousAssignees: previousData ? previousData.assignedTo : [],
      actorUserId: userId,
      buildPayload: () => ({
        category: 'taskAssigned',
        type: 'task_assigned',
        title: 'Task assigned to you',
        body: `You were assigned to "${entityData.title || 'a task'}"`,
        entityType: 'task',
        entityId: entityData.id || entityData.taskId,
        matterId: entityData.matterId || null,
        actionUrl: taskUrl(lawFirmId, entityData.id || entityData.taskId),
        createdBy: userId,
      }),
    });
  } catch (err: any) {
    console.error('[notifications.events] TASK_UPDATED handler error:', err.message);
  }
});

/**
 * New message in a conversation. Fans out two distinct notifications:
 *  - @mention (any direction): every firm user @mentioned in the message;
 *  - new message (client → firm only): the firm-side conversation participants,
 *    excluding anyone already notified via a mention. The in-app bell is
 *    firm-member-facing, so firm → client messages are covered by email, not here.
 * Plain new-message notifications collapse per conversation: they pass an
 * explicit `dedupeKey` of the conversation, so a burst of messages stays one
 * bell item within the window even though each carries a different preview.
 * Mentions deliberately do NOT share that key: every mention is worth its own
 * notification.
 */
eventBus.on(MESSAGE_SENT, async ({ lawFirmId, conversationId, conversationType, messageId, senderId, senderName, matterId, mentions, messageRecipients, preview }: any) => {
  try {
    if (!lawFirmId) return;
    const convUrl = conversationUrl(lawFirmId, conversationId, conversationType);

    const mentioned = uniqueRecipients(mentions, senderId);
    if (mentioned.length) {
      await createNotifications(lawFirmId, mentioned, {
        category: 'mention',
        type: 'mention',
        title: `${senderName || 'Someone'} mentioned you`,
        body: preview ? `"${preview}"` : 'You were mentioned in a message',
        entityType: 'message',
        entityId: messageId,
        matterId: matterId || null,
        actionUrl: convUrl,
        createdBy: senderId || null,
      });
    }

    const recipients = uniqueRecipients(messageRecipients, senderId)
      .filter((id) => !mentioned.includes(id));
    if (recipients.length) {
      await createNotifications(lawFirmId, recipients, {
        category: 'message',
        type: 'message',
        title: `New message from ${senderName || 'a client'}`,
        body: preview || 'You have a new message',
        entityType: 'message',
        entityId: conversationId,
        matterId: matterId || null,
        actionUrl: convUrl,
        createdBy: senderId || null,
        dedupeKey: `message:${conversationId}`,
      });
    }
  } catch (err: any) {
    console.error('[notifications.events] MESSAGE_SENT handler error:', err.message);
  }
});

/**
 * A viewer opened a conversation and marked its messages read. Clear that
 * conversation's unread message + @mention notifications for the viewer, so
 * reading the thread dismisses the matching bell notifications (they shouldn't
 * linger once the message has been seen in the message view).
 */
eventBus.on(MESSAGES_READ, async ({ lawFirmId, userId, conversationId }: any) => {
  try {
    if (!lawFirmId || !userId || !conversationId) return;
    await notificationsRepo.markReadForConversation(lawFirmId, userId, conversationId);
  } catch (err: any) {
    console.error('[notifications.events] MESSAGES_READ handler error:', err.message);
  }
});
/**
 * Notify a matter's initial team when the matter itself is created. Members
 * added afterward go through MATTER_MEMBERS_UPDATED below, which never fires
 * for the roster the matter is created with.
 */
eventBus.on(MATTER_CREATED, async ({ lawFirmId, matterId, memberUserIds, matterData, userId }: any) => {
  try {
    if (!lawFirmId || !matterId) return;
    const recipients = uniqueRecipients(memberUserIds, userId);
    if (!recipients.length) return;

    const matterName = matterData?.name || await getMatterName(lawFirmId, matterId);
    await createNotifications(lawFirmId, recipients, {
      category: 'matterAdded',
      type: 'matter_added',
      title: 'Added to a matter',
      body: `You were added to "${matterName || 'a matter'}"`,
      entityType: 'matter',
      entityId: matterId,
      matterId,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/matters/${matterId}`,
      createdBy: userId || null,
    });
  } catch (err: any) {
    console.error('[notifications.events] MATTER_CREATED handler error:', err.message);
  }
});

/**
 * Notify users when they are newly added as members of a matter.
 */
eventBus.on(MATTER_MEMBERS_UPDATED, async ({ lawFirmId, matterId, addedUserIds, actorUserId }: any) => {
  try {
    if (!lawFirmId || !matterId) return;
    const recipients = uniqueRecipients(addedUserIds, actorUserId);
    if (!recipients.length) return;

    const matterName = await getMatterName(lawFirmId, matterId);
    await createNotifications(lawFirmId, recipients, {
      category: 'matterAdded',
      type: 'matter_added',
      title: 'Added to a matter',
      body: `You were added to "${matterName || 'a matter'}"`,
      entityType: 'matter',
      entityId: matterId,
      matterId,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/matters/${matterId}`,
      createdBy: actorUserId || null,
    });
  } catch (err: any) {
    console.error('[notifications.events] MATTER_MEMBERS_UPDATED handler error:', err.message);
  }
});

/**
 * Notify the firm when a payment is applied to an invoice (partial or full).
 * Recipients are the invoice owner plus every firm owner and holder of
 * `billing.manageInvoices` / `billing.recordPayments`, minus the actor (a firm
 * member who recorded it manually; for Stripe the actor is the client, so the
 * exclusion is a no-op). Fires on both the manual and Stripe payment paths via
 * the unified INVOICE_PAYMENT_RECEIVED contract. The remaining balance for the
 * partial-payment body is read from the invoice (best-effort).
 */
eventBus.on(INVOICE_PAYMENT_RECEIVED, async ({
  lawFirmId, invoiceId, contextType, entityId,
  amountPaidCents, isFullyPaid, actorUserId, invoiceName, invoiceCreatedBy,
}: any) => {
  try {
    if (!lawFirmId || !invoiceId) return;

    const rows = await tenantQuery(members, lawFirmId, ({ executor, scope }) => executor
      .selectDistinct({ userId: members.userId }).from(members)
      .leftJoin(roles, and(eq(roles.lawFirmId, members.lawFirmId), eq(roles.id, members.roleId)))
      .where(and(scope, sql`(
        ${members.isOwner} = true
        or 'billing.manageInvoices' = any(coalesce(${roles.permissions}, '{}'))
        or 'billing.recordPayments' = any(coalesce(${roles.permissions}, '{}'))
      )`)));
    const permHolders = rows.map((x: any) => x.userId).filter(Boolean);
    const recipients = uniqueRecipients([invoiceCreatedBy, ...permHolders], actorUserId);
    if (!recipients.length) return;

    // Best-effort invoice read for the remaining balance and matter link.
    let matterId = null;
    let remainingCents = null;
    if (contextType && entityId) {
      const invoice = await invoicesRepo
        .findById({ type: contextType, lawFirmId, entityId }, invoiceId)
        .catch(() => null);
      if (invoice) {
        matterId = invoice.matterId || null;
        remainingCents = Math.round(
          ((invoice.totalAmount || 0) - (invoice.amountPaid || 0) - (invoice.totalWrittenOff || 0)) * 100
        );
      }
    }

    const label = invoiceName ? `Invoice ${invoiceName}` : 'an invoice';
    const amount = formatDollarsFromCents(amountPaidCents);
    const title = isFullyPaid ? 'Invoice paid in full' : 'Payment received';
    const body = isFullyPaid
      ? `${label} has been paid in full.`
      : `${amount} was received on ${label}.`
        + (remainingCents != null ? ` Remaining balance ${formatDollarsFromCents(remainingCents)}.` : '');

    await createNotifications(lawFirmId, recipients, {
      category: 'invoicePaid',
      type: 'invoice_paid',
      title,
      body,
      entityType: 'invoice',
      entityId: invoiceId,
      matterId,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/billing`,
      createdBy: actorUserId || null,
    });
  } catch (err: any) {
    console.error('[notifications.events] INVOICE_PAYMENT_RECEIVED handler error:', err.message);
  }
});

/**
 * Notify the firm when a signing session is fully signed. Recipients are the
 * session initiator plus, when the document is filed to a matter, that matter's
 * team. The signer who triggered completion (usually an external/portal signer,
 * occasionally a firm member facilitating) is excluded from self-notify.
 */
eventBus.on(SIGNING_COMPLETED, async ({ lawFirmId, matterId, fileName, initiatorUserId, actorUserId }: any) => {
  try {
    if (!lawFirmId) return;
    const memberIds = await getMatterMemberIds(lawFirmId, matterId);
    const recipients = uniqueRecipients([initiatorUserId, ...memberIds], actorUserId);
    if (!recipients.length) return;

    await createNotifications(lawFirmId, recipients, {
      category: 'signingCompleted',
      type: 'signing_completed',
      title: 'Document signed',
      body: `"${fileName || 'A document'}" has been fully signed`,
      entityType: matterId ? 'matter' : null,
      entityId: matterId || null,
      matterId: matterId || null,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/signatures/history`,
      createdBy: actorUserId || null,
    });
  } catch (err: any) {
    console.error('[notifications.events] SIGNING_COMPLETED handler error:', err.message);
  }
});

/**
 * Notify the firm when a signer declines a signing session (which cancels it).
 * Same recipient set as completion: the initiator plus the matter team.
 */
eventBus.on(SIGNING_DECLINED, async ({ lawFirmId, matterId, fileName, initiatorUserId, signerName, actorUserId }: any) => {
  try {
    if (!lawFirmId) return;
    const memberIds = await getMatterMemberIds(lawFirmId, matterId);
    const recipients = uniqueRecipients([initiatorUserId, ...memberIds], actorUserId);
    if (!recipients.length) return;

    await createNotifications(lawFirmId, recipients, {
      category: 'signingDeclined',
      type: 'signing_declined',
      title: 'Signature declined',
      body: `${signerName || 'A signer'} declined to sign "${fileName || 'a document'}"`,
      entityType: matterId ? 'matter' : null,
      entityId: matterId || null,
      matterId: matterId || null,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/signatures/history`,
      createdBy: actorUserId || null,
    });
  } catch (err: any) {
    console.error('[notifications.events] SIGNING_DECLINED handler error:', err.message);
  }
});

/**
 * Notify the firm when a signing session is cancelled because one of its
 * signers was removed (their client record was deleted) and nobody actionable
 * was left to finish it. Same recipient set and terminal-only bar as
 * SIGNING_DECLINED: this only ever fires once the whole session resolves, not
 * for a signer being removed from a session that still has other people who
 * can complete it (signatures.events.ts's CLIENT_DELETED handler only emits
 * this event in that terminal case).
 */
eventBus.on(SIGNING_PARTICIPANT_REMOVED, async ({ lawFirmId, matterId, fileName, initiatorUserId, participantName }: any) => {
  try {
    if (!lawFirmId) return;
    const memberIds = await getMatterMemberIds(lawFirmId, matterId);
    const recipients = uniqueRecipients([initiatorUserId, ...memberIds], null);
    if (!recipients.length) return;

    await createNotifications(lawFirmId, recipients, {
      category: 'signingDeclined',
      type: 'signing_participant_removed',
      title: 'Signing session cancelled',
      body: `"${fileName || 'A document'}" was cancelled: ${participantName || 'a signer'}'s account was removed and no other signers were still pending`,
      entityType: matterId ? 'matter' : null,
      entityId: matterId || null,
      matterId: matterId || null,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/signatures/history`,
      createdBy: null,
    });
  } catch (err: any) {
    console.error('[notifications.events] SIGNING_PARTICIPANT_REMOVED handler error:', err.message);
  }
});

/**
 * Notify a firm member when their role is updated by an administrator.
 */
eventBus.on(MEMBER_ROLE_CHANGED, async ({ lawFirmId, userId, roleName, actorUserId }: any) => {
  try {
    if (!lawFirmId || !userId || userId === actorUserId) return;
    const roleTitle = roleName || 'a new role';
    await createNotifications(lawFirmId, [userId], {
      category: 'roleChanged',
      type: 'member_role_changed',
      title: 'Role updated',
      body: `Your role was updated to "${roleTitle}"`,
      entityType: null,
      entityId: null,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/settings`,
      createdBy: actorUserId || null,
    });
  } catch (err: any) {
    console.error('[notifications.events] MEMBER_ROLE_CHANGED handler error:', err.message);
  }
});

/**
 * A matter was deleted. Drop every notification attached to it — the matter row
 * itself, and anything carrying its `matter_id` (its tasks, notes and invoices
 * go with it). Left behind, they sit in the bell advertising a link that
 * dead-ends on a matter that no longer exists.
 */
eventBus.on(MATTER_DELETED, async ({ lawFirmId, matterId }: any) => {
  try {
    if (!lawFirmId || !matterId) return;
    await notificationsRepo.removeForMatter(lawFirmId, matterId);
  } catch (err: any) {
    console.error('[notifications.events] MATTER_DELETED handler error:', err.message);
  }
});
/**
 * A task was deleted. Drop its notifications for the same reason.
 */
eventBus.on(TASK_DELETED, async ({ lawFirmId, taskId, entityData }: any) => {
  try {
    const id = taskId || (entityData && entityData.id);
    if (!lawFirmId || !id) return;
    await notificationsRepo.removeForEntity(lawFirmId, 'task', id);
  } catch (err: any) {
    console.error('[notifications.events] TASK_DELETED handler error:', err.message);
  }
});
/**
 * Notify users @mentioned in a matter note.
 */
eventBus.on(MATTER_NOTE_CREATED, async ({ lawFirmId, matterId, noteId, authorId, mentions, preview }: any) => {
  try {
    if (!lawFirmId) return;
    const recipients = uniqueRecipients(mentions, authorId);
    if (!recipients.length) return;

    const matterName = await getMatterName(lawFirmId, matterId);
    await createNotifications(lawFirmId, recipients, {
      category: 'mention',
      type: 'mention',
      title: 'You were mentioned in a note',
      body: preview ? `"${preview}"` : `You were mentioned in a note on "${matterName || 'a matter'}"`,
      entityType: 'note',
      entityId: noteId,
      matterId: matterId || null,
      actionUrl: noteUrl(lawFirmId, 'matters', matterId, noteId),
      createdBy: authorId || null,
    });
  } catch (err: any) {
    console.error('[notifications.events] MATTER_NOTE_CREATED handler error:', err.message);
  }
});

/**
 * Notify the note's author and anyone @mentioned in a reply to it.
 */
eventBus.on(MATTER_NOTE_REPLY_ADDED, async ({ lawFirmId, matterId, noteId, authorId, mentions, noteAuthorId, parentReplyAuthorId, preview }: any) => {
  try {
    if (!lawFirmId) return;
    const recipients = uniqueRecipients([...(mentions || []), noteAuthorId, parentReplyAuthorId], authorId);
    if (!recipients.length) return;

    const matterName = await getMatterName(lawFirmId, matterId);
    await createNotifications(lawFirmId, recipients, {
      category: 'mention',
      type: 'mention',
      title: 'New reply to a note',
      body: preview ? `"${preview}"` : `Someone replied to a note on "${matterName || 'a matter'}"`,
      entityType: 'note',
      entityId: noteId,
      matterId: matterId || null,
      actionUrl: noteUrl(lawFirmId, 'matters', matterId, noteId),
      createdBy: authorId || null,
    });
  } catch (err: any) {
    console.error('[notifications.events] MATTER_NOTE_REPLY_ADDED handler error:', err.message);
  }
});

/**
 * Notify users @mentioned in a task note.
 */
eventBus.on(TASK_NOTE_CREATED, async ({ lawFirmId, taskId, matterId, noteId, authorId, mentions, preview }: any) => {
  try {
    if (!lawFirmId) return;
    const recipients = uniqueRecipients(mentions, authorId);
    if (!recipients.length) return;

    await createNotifications(lawFirmId, recipients, {
      category: 'mention',
      type: 'mention',
      title: 'You were mentioned in a task note',
      body: preview ? `"${preview}"` : 'You were mentioned in a task note',
      entityType: 'note',
      entityId: noteId,
      matterId: matterId || null,
      actionUrl: noteUrl(lawFirmId, 'tasks', taskId, noteId),
      createdBy: authorId || null,
    });
  } catch (err: any) {
    console.error('[notifications.events] TASK_NOTE_CREATED handler error:', err.message);
  }
});

/**
 * Notify the task note's author and anyone @mentioned in a reply to it.
 */
eventBus.on(TASK_NOTE_REPLY_ADDED, async ({ lawFirmId, taskId, matterId, noteId, authorId, mentions, noteAuthorId, parentReplyAuthorId, preview }: any) => {
  try {
    if (!lawFirmId) return;
    const recipients = uniqueRecipients([...(mentions || []), noteAuthorId, parentReplyAuthorId], authorId);
    if (!recipients.length) return;

    await createNotifications(lawFirmId, recipients, {
      category: 'mention',
      type: 'mention',
      title: 'New reply to a task note',
      body: preview ? `"${preview}"` : 'Someone replied to a note on a task',
      entityType: 'note',
      entityId: noteId,
      matterId: matterId || null,
      actionUrl: noteUrl(lawFirmId, 'tasks', taskId, noteId),
      createdBy: authorId || null,
    });
  } catch (err: any) {
    console.error('[notifications.events] TASK_NOTE_REPLY_ADDED handler error:', err.message);
  }
});

/**
 * Notify users @mentioned in a client note.
 */
eventBus.on(CLIENT_NOTE_CREATED, async ({ lawFirmId, clientId, noteId, authorId, mentions, preview }: any) => {
  try {
    if (!lawFirmId) return;
    const recipients = uniqueRecipients(mentions, authorId);
    if (!recipients.length) return;

    await createNotifications(lawFirmId, recipients, {
      category: 'mention',
      type: 'mention',
      title: 'You were mentioned in a client note',
      body: preview ? `"${preview}"` : 'You were mentioned in a client note',
      entityType: 'note',
      entityId: noteId,
      actionUrl: noteUrl(lawFirmId, 'clients', clientId, noteId),
      createdBy: authorId || null,
    });
  } catch (err: any) {
    console.error('[notifications.events] CLIENT_NOTE_CREATED handler error:', err.message);
  }
});

/**
 * Notify the client note's author and anyone @mentioned in a reply to it.
 */
eventBus.on(CLIENT_NOTE_REPLY_ADDED, async ({ lawFirmId, clientId, noteId, authorId, mentions, noteAuthorId, parentReplyAuthorId, preview }: any) => {
  try {
    if (!lawFirmId) return;
    const recipients = uniqueRecipients([...(mentions || []), noteAuthorId, parentReplyAuthorId], authorId);
    if (!recipients.length) return;

    await createNotifications(lawFirmId, recipients, {
      category: 'mention',
      type: 'mention',
      title: 'New reply to a client note',
      body: preview ? `"${preview}"` : 'Someone replied to a note on a client',
      entityType: 'note',
      entityId: noteId,
      actionUrl: noteUrl(lawFirmId, 'clients', clientId, noteId),
      createdBy: authorId || null,
    });
  } catch (err: any) {
    console.error('[notifications.events] CLIENT_NOTE_REPLY_ADDED handler error:', err.message);
  }
});

// This module only registers listeners; it exports nothing. The empty
// export marks it as a MODULE so its top-level consts are file-scoped
// rather than colliding in the global scope with every other events file.
export {};
