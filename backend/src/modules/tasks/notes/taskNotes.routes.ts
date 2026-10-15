const { createNotesRouter } = require('../../../shared/notes/notesRouter');

const schemas = require('./taskNotes.validation');
const taskNotesService = require('./taskNotes.service');
const taskNoteRepliesService = require('./taskNoteReplies.service');

// /api/lawfirms/:lawFirmId/tasks/:taskId/notes/...
//
// Time on a task note is billable work, so it answers to the billing permission
// exactly as it does on matter notes. Retracting needs the task's own write
// permission, the same rule matter and client notes follow.
const router = createNotesRouter({
  paramName: 'taskId',
  notesService: taskNotesService,
  repliesService: taskNoteRepliesService,
  schemas,
  permissions: {
    view: 'tasks.view',
    write: 'tasks.update',
    retract: 'tasks.update',
    time: 'billing.manageTimeEntries',
    reply: 'tasks.update',
  },
});

export = router;
