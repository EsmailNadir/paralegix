const { createNotesRouter } = require('../../../shared/notes/notesRouter');

const schemas = require('./clientNotes.validation');
const clientNotesService = require('./clientNotes.service');
const clientNoteRepliesService = require('./clientNoteReplies.service');

// /api/lawfirms/:lawFirmId/clients/:clientId/notes/...
//
// Time on a client note is billable work, so it answers to the billing
// permission exactly as it does on matter notes.
const router = createNotesRouter({
  paramName: 'clientId',
  notesService: clientNotesService,
  repliesService: clientNoteRepliesService,
  schemas,
  permissions: {
    view: 'clients.view',
    write: 'clients.manage',
    retract: 'clients.manage',
    time: 'billing.manageTimeEntries',
    reply: 'clients.manage',
  },
});

export = router;
