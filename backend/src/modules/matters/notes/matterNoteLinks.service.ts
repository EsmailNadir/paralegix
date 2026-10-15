const notesRepo = require('./matterNotes.repository');
import type { DrizzleExecutor } from '../../../shared/database/queryContext';
const linksRepo = require('./matterNoteLinks.repository');
const tasksService = require('../../tasks/tasks.service');
const tasksRepo = require('../../tasks/tasks.repository');
const filesRepo = require('../../files/files.repository');
const { assertMatterMembership } = require('../../../shared/utils/membership');
const eventBus = require('../../../shared/events/eventBus');
const { MATTER_NOTE_LINKED } = require('../../../shared/events/eventTypes');
const { NotFoundError, ValidationError } = require('../../../shared/errors/AppError');

async function loadNote(lawFirmId: string, matterId: string, noteId: string, userId: string) {
  await assertMatterMembership(lawFirmId, matterId, userId);
  const note = await notesRepo.getNote(lawFirmId, matterId, noteId);
  if (!note) throw new NotFoundError('Note');
  return note;
}

/**
 * Create a task from a note, keeping the backlink.
 *
 * The task is created through the tasks service rather than inserted here, so
 * it picks up assignee validation, plan limits, calendar sync and the task
 * events exactly as a task made from the tasks page would. The only thing this
 * adds is the link row.
 */
export async function createTaskFromNote({ lawFirmId, matterId, noteId, userId, timezone, task }: any) {
  const note = await loadNote(lawFirmId, matterId, noteId, userId);
  let link;
  const created = await tasksService.createTask({
    lawFirmId,
    userId,
    timezone,
    matterId,
    title: (task.title || note.subject || '').trim() || 'Follow up',
    description: task.description ?? (note.content || '').substring(0, 500),
    dueDate: task.dueDate,
    priority: task.priority,
    assignedTo: task.assigneeIds,
  }, async (taskId: string, transaction: DrizzleExecutor) => {
    link = await linksRepo.createLink(lawFirmId, {
      noteId, matterId, linkType: 'task', taskId,
      replyId: task.replyId || null, createdFromNote: !task.replyId, createdBy: userId,
    }, transaction);
  });

  eventBus.emit(MATTER_NOTE_LINKED, {
    lawFirmId, matterId, noteId, actorUserId: userId,
    linkType: 'task', targetId: created.taskId, createdFromNote: !task.replyId,
  });

  return { message: 'Task created from note', taskId: created.taskId, link };
}

/** Link an existing task to a note. */
export async function linkTaskToNote({ lawFirmId, matterId, noteId, userId, taskId }: any) {
  await loadNote(lawFirmId, matterId, noteId, userId);

  // Resolve the task through a firm-scoped read before trusting the id, and
  // refuse a task on a different matter: a note's links are part of that
  // matter's record, and a cross-matter link would put one matter's work in
  // another's history.
  const task = await tasksRepo.findByIdRaw(lawFirmId, taskId);
  const taskMatterId = task?.matterId ?? task?.matter_id ?? null;
  if (!task) throw new NotFoundError('Task');
  if (taskMatterId && String(taskMatterId) !== String(matterId)) {
    throw new ValidationError('That task belongs to a different matter');
  }

  const link = await linksRepo.createLink(lawFirmId, {
    noteId, matterId, linkType: 'task', taskId, createdFromNote: false, createdBy: userId,
  });
  eventBus.emit(MATTER_NOTE_LINKED, {
    lawFirmId, matterId, noteId, actorUserId: userId,
    linkType: 'task', targetId: taskId, createdFromNote: false,
  });
  return { message: 'Task linked to note', link };
}

/**
 * Link an existing document to a note.
 *
 * References the file record rather than copying the file, so the document keeps
 * its portal visibility and its place in the matter's folder tree, and follows
 * a later rename or move rather than being orphaned by one. Note attachments, which are stored inline on the note, remain a
 * separate thing: this is for documents that already live in the matter.
 */
export async function linkFileToNote({ lawFirmId, matterId, noteId, userId, fileId }: any) {
  await loadNote(lawFirmId, matterId, noteId, userId);

  // The picker names the document by its row id, which is what the file browser
  // already shows it. It used to send the object path, and this resolved that
  // back to the row; the path was the identifier because the tree lived in it.
  const file = await filesRepo.findById(lawFirmId, fileId);
  if (!file) throw new NotFoundError('Document');
  if (file.matterId && String(file.matterId) !== String(matterId)) {
    throw new ValidationError('That document belongs to a different matter');
  }

  const link = await linksRepo.createLink(lawFirmId, {
    noteId, matterId, linkType: 'file', fileId: file.id, createdFromNote: false, createdBy: userId,
  });
  eventBus.emit(MATTER_NOTE_LINKED, {
    lawFirmId, matterId, noteId, actorUserId: userId,
    linkType: 'file', targetId: file.id, createdFromNote: false,
  });
  return { message: 'Document linked to note', link };
}

/** Remove a link. The linked task or document is untouched. */
export async function unlinkFromNote({ lawFirmId, matterId, noteId, userId, linkId }: any) {
  await loadNote(lawFirmId, matterId, noteId, userId);
  // The delete is scoped to this note and this firm, so a link id belonging to
  // another firm (or no link at all) removes nothing. Reporting success anyway
  // told the caller a link had been removed that never existed, and told
  // another firm's caller the same about a link that is still there.
  const removed = await linksRepo.deleteLink(lawFirmId, noteId, linkId);
  if (!removed) throw new NotFoundError('Link');
  return { message: 'Link removed', linkId };
}
