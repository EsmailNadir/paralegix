/**
 * Client notes use the shared schemas verbatim — no client-only extras
 * (links, client-update sharing, and the firm-wide list stay matter-only).
 */
const {
  listNotesSchema, addNoteSchema, updateNoteSchema, retractNoteSchema, pinNoteSchema,
  addTimeToNoteSchema, updateNoteTimeEntrySchema, addReplySchema, updateReplySchema, retractReplySchema,
} = require('../../../shared/notes/notesValidation');

export {
  listNotesSchema, addNoteSchema, updateNoteSchema, retractNoteSchema, pinNoteSchema,
  addTimeToNoteSchema, updateNoteTimeEntrySchema, addReplySchema, updateReplySchema, retractReplySchema,
};
