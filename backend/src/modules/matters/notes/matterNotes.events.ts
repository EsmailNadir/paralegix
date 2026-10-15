/**
 * Projects note activity into the matter timeline.
 *
 * Subscribed rather than called inline: the timeline is a reading surface, and
 * a failure to write one of its rows must never be able to fail the note,
 * reply, time entry or link that produced it.
 */

// Forces module scope (this file has no other top-level import/export), so
// its top-level `const`s don't collide with same-named ones in other
// require-only script files.
export {};

const eventBus = require('../../../shared/events/eventBus');
const matterActivityService = require('../activity/matterActivity.service');
const {
  MATTER_NOTE_CREATED,
  MATTER_NOTE_UPDATED,
  MATTER_NOTE_RETRACTED,
  MATTER_NOTE_REPLY_ADDED,
  MATTER_NOTE_TIME_RECORDED,
  MATTER_NOTE_LINKED,
  MATTER_NOTE_SHARED,
} = require('../../../shared/events/eventTypes');

/** A note's subject, or a short stand-in when it has none. */
function noteLabel(subject: any) {
  const s = (subject || '').trim();
  return s ? `"${s}"` : 'a note';
}

eventBus.on(MATTER_NOTE_CREATED, async ({ lawFirmId, matterId, noteId, authorId, authorName, subject }: any) => {
  try {
    await matterActivityService.recordActivity({
      lawFirmId,
      matterId,
      activityType: 'note.created',
      actorUserId: authorId,
      actorName: authorName || null,
      summary: `Added ${noteLabel(subject)}`,
      metadata: { noteId },
    });
  } catch (err: any) {
    console.error('notes.events MATTER_NOTE_CREATED failed:', err?.message || err);
  }
});

eventBus.on(MATTER_NOTE_UPDATED, async ({ lawFirmId, matterId, noteId, authorId, authorName, subject }: any) => {
  try {
    await matterActivityService.recordActivity({
      lawFirmId,
      matterId,
      activityType: 'note.updated',
      actorUserId: authorId,
      actorName: authorName || null,
      summary: `Edited ${noteLabel(subject)}`,
      metadata: { noteId },
    });
  } catch (err: any) {
    console.error('notes.events MATTER_NOTE_UPDATED failed:', err?.message || err);
  }
});

eventBus.on(MATTER_NOTE_RETRACTED, async ({ lawFirmId, matterId, noteId, actorUserId, subject }: any) => {
  try {
    await matterActivityService.recordActivity({
      lawFirmId,
      matterId,
      activityType: 'note.retracted',
      actorUserId,
      summary: `Retracted ${noteLabel(subject)}`,
      metadata: { noteId },
    });
  } catch (err: any) {
    console.error('notes.events MATTER_NOTE_RETRACTED failed:', err?.message || err);
  }
});

eventBus.on(MATTER_NOTE_REPLY_ADDED, async ({ lawFirmId, matterId, noteId, replyId, authorId, authorName }: any) => {
  try {
    await matterActivityService.recordActivity({
      lawFirmId,
      matterId,
      activityType: 'note.reply.added',
      actorUserId: authorId,
      actorName: authorName || null,
      summary: 'Replied to a note',
      metadata: { noteId, replyId },
    });
  } catch (err: any) {
    console.error('notes.events MATTER_NOTE_REPLY_ADDED failed:', err?.message || err);
  }
});

eventBus.on(MATTER_NOTE_TIME_RECORDED, async ({ lawFirmId, matterId, noteId, actorUserId, hours }: any) => {
  try {
    const h = Number(hours);
    await matterActivityService.recordActivity({
      lawFirmId,
      matterId,
      activityType: 'note.time.recorded',
      actorUserId,
      summary: Number.isFinite(h) ? `Recorded ${h}h against a note` : 'Recorded time against a note',
      metadata: { noteId },
    });
  } catch (err: any) {
    console.error('notes.events MATTER_NOTE_TIME_RECORDED failed:', err?.message || err);
  }
});

eventBus.on(MATTER_NOTE_LINKED, async ({ lawFirmId, matterId, noteId, actorUserId, linkType, targetId, createdFromNote }: any) => {
  try {
    const summary = linkType === 'task'
      ? (createdFromNote ? 'Created a task from a note' : 'Linked a task to a note')
      : 'Linked a document to a note';
    await matterActivityService.recordActivity({
      lawFirmId,
      matterId,
      activityType: linkType === 'task' ? 'note.task.linked' : 'note.document.linked',
      actorUserId,
      summary,
      metadata: { noteId, linkType, targetId, createdFromNote: createdFromNote === true },
    });
  } catch (err: any) {
    console.error('notes.events MATTER_NOTE_LINKED failed:', err?.message || err);
  }
});

eventBus.on(MATTER_NOTE_SHARED, async ({ lawFirmId, matterId, noteId, actorUserId, recipientCount }: any) => {
  try {
    await matterActivityService.recordActivity({
      lawFirmId,
      matterId,
      activityType: 'note.shared',
      actorUserId,
      summary: recipientCount === 1
        ? 'Sent a client update from a note'
        : `Sent a client update from a note to ${recipientCount} recipients`,
      metadata: { noteId },
    });
  } catch (err: any) {
    console.error('notes.events MATTER_NOTE_SHARED failed:', err?.message || err);
  }
});
