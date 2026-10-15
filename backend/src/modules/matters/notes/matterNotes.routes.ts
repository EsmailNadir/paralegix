const { verifyToken } = require('../../../shared/middleware/auth');
const { requireTimezone } = require('../../../shared/middleware/timezone');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const { createNotesRouter } = require('../../../shared/notes/notesRouter');

const schemas = require('./matterNotes.validation');
const {
  createTaskFromNoteSchema,
  linkTaskToNoteSchema,
  linkFileToNoteSchema,
  sendNoteAsClientUpdateSchema,
} = schemas;
const matterNotesService = require('./matterNotes.service');
const matterNoteLinksService = require('./matterNoteLinks.service');
const matterNoteRepliesService = require('./matterNoteReplies.service');
import { handler } from '../../../shared/http/handler';

// /api/lawfirms/:lawFirmId/matters/:matterId/notes/...
//
// Time entries on a matter note are billable work, so they answer to the
// billing permission rather than `matters.update`.
const router = createNotesRouter({
  paramName: 'matterId',
  notesService: matterNotesService,
  repliesService: matterNoteRepliesService,
  schemas,
  permissions: {
    view: 'matters.view',
    write: 'matters.update',
    retract: 'matters.update',
    time: 'billing.manageTimeEntries',
    reply: 'matters.update',
  },
});

// ── Matter-only routes: a matter note can spawn and link work, and can be
// sent to the client as an update. No other entity's notes do either.

// POST /api/lawfirms/:lawFirmId/matters/:matterId/notes/:noteId/tasks
router.post('/:matterId/notes/:noteId/tasks',
  verifyToken,
  requirePermission('tasks.create'),
  requireTimezone,
  validate(createTaskFromNoteSchema),
  handler(async (req) => matterNoteLinksService.createTaskFromNote({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    noteId: req.params.noteId,
    userId: req.user.uid,
    timezone: req.tz,
    task: req.body,
  }), 201),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/notes/:noteId/links/task
router.post('/:matterId/notes/:noteId/links/task',
  verifyToken,
  requirePermission('matters.update'),
  validate(linkTaskToNoteSchema),
  handler(async (req) => matterNoteLinksService.linkTaskToNote({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    noteId: req.params.noteId,
    userId: req.user.uid,
    taskId: req.body.taskId,
  }), 201),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/notes/:noteId/links/file
router.post('/:matterId/notes/:noteId/links/file',
  verifyToken,
  requirePermission('matters.update'),
  validate(linkFileToNoteSchema),
  handler(async (req) => matterNoteLinksService.linkFileToNote({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    noteId: req.params.noteId,
    userId: req.user.uid,
    fileId: req.body.fileId,
  }), 201),
);

// DELETE /api/lawfirms/:lawFirmId/matters/:matterId/notes/:noteId/links/:linkId
router.delete('/:matterId/notes/:noteId/links/:linkId',
  verifyToken,
  requirePermission('matters.update'),
  handler(async (req) => matterNoteLinksService.unlinkFromNote({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    noteId: req.params.noteId,
    userId: req.user.uid,
    linkId: req.params.linkId,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/notes/:noteId/client-update
router.post('/:matterId/notes/:noteId/client-update',
  verifyToken,
  requirePermission('messaging.send'),
  requireTimezone,
  validate(sendNoteAsClientUpdateSchema),
  handler(async (req) => matterNotesService.sendNoteAsClientUpdate({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    noteId: req.params.noteId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

export = router;
