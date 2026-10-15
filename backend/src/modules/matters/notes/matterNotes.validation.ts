import { z } from 'zod';
const { paging } = require('../../../shared/validation/listQuery');
const {
  dayString, listNotesSchema, addNoteSchema, updateNoteSchema, retractNoteSchema, pinNoteSchema,
  addTimeToNoteSchema, updateNoteTimeEntrySchema, addReplySchema, updateReplySchema, retractReplySchema,
} = require('../../../shared/notes/notesValidation');

export {
  listNotesSchema, addNoteSchema, updateNoteSchema, retractNoteSchema, pinNoteSchema,
  addTimeToNoteSchema, updateNoteTimeEntrySchema, addReplySchema, updateReplySchema, retractReplySchema,
};

export const createTaskFromNoteSchema = z.object({
  body: z.object({
    title: z.string().max(500).optional(),
    description: z.string().max(5000).optional(),
    dueDate: dayString.optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    assigneeIds: z.array(z.string().min(1)).max(20).optional(),
    // Set when the task is created from a reply rather than the note body, so
    // the resulting link records which message prompted it.
    replyId: z.string().uuid().optional(),
  }),
});

export const linkTaskToNoteSchema = z.object({
  body: z.object({ taskId: z.string().uuid() }),
});

export const linkFileToNoteSchema = z.object({
  body: z.object({ fileId: z.string().uuid() }),
});

export const sendNoteAsClientUpdateSchema = z.object({
  body: z.object({
    message: z.string().min(1, 'An update message is required').max(10000),
    recipientClientIds: z.array(z.string().uuid()).max(50).optional(),
  }),
});

export const listFirmNotesSchema = z.object({
  query: z.object({
    ...paging({ max: 200 }),
    search: z.string().max(500).optional(),
    noteType: z.string().max(50).optional(),
    timeFilter: z.enum(['all', 'with-time', 'without-time']).optional(),
    tag: z.string().max(100).optional(),
    authorId: z.string().max(128).optional(),
    matterId: z.string().uuid().optional(),
    dateFrom: dayString.optional(),
    dateTo: dayString.optional(),
  }).passthrough(),
});
