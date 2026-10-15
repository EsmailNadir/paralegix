/**
 * Zod schemas for the notes feature, shared by matters, tasks, and clients.
 * Matter notes layer a few matter-only extras (links, client-update sharing,
 * firm-wide search) on top of these in `notes.validation.ts`.
 */

import { z } from 'zod';
const { paging } = require('../validation/listQuery');

/** One time entry as the note compose form and the Add time modal both send it. */
export const timeEntryInput = z.object({
  timeSpent: z.number().positive('Time spent must be positive').max(24, 'Time spent cannot exceed 24 hours for a single entry'),
  timeEntryDate: z.string().optional(),
  activityName: z.string().max(500).optional(),
  activityDescription: z.string().max(2000).optional(),
  isBillable: z.boolean().optional(),
});

/** 'YYYY-MM-DD', the shape every day-only column in this codebase uses. */
export const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/**
 * The notes list query. Every filter mirrors a control in the notes panel, so
 * the same set of notes is selected whether the panel is showing page 1 or
 * page 9. A filter that only ran over the loaded page would silently change
 * meaning as the reader paged.
 */
export const listNotesSchema = z.object({
  query: z.object({
    ...paging({ max: 200 }),
    search: z.string().max(500).optional(),
    // 'all' is the panel's unset value and is accepted rather than requiring the
    // caller to drop the param.
    noteType: z.string().max(50).optional(),
    timeFilter: z.enum(['all', 'with-time', 'without-time']).optional(),
    // A bare `#tag` word, without the '#'.
    tag: z.string().max(100).optional(),
    authorId: z.string().max(128).optional(),
    dateFrom: dayString.optional(),
    dateTo: dayString.optional(),
    // A deep-linked note that may not be on the requested page. When present,
    // the server resolves which page it actually falls on under these same
    // filters and returns it as `resolvedPage`, ignoring the requested `page`.
    jumpToNoteId: z.string().uuid().optional(),
  }).passthrough(),
});

/**
 * What a note or reply sends for its attachments: the entries the editor holds,
 * each naming a file by `id` or `objectPath`. The display fields beside them are
 * read from the file row, so they pass through untouched. The ceiling bounds the
 * lookup and the replace-set one request can drive.
 */
const attachmentEntry = z.object({
  id: z.string().nullish(),
  fileId: z.string().nullish(),
  objectPath: z.string().nullish(),
}).passthrough();
const attachmentList = z.array(attachmentEntry).max(50).optional();

export const addNoteSchema = z.object({
  body: z.object({
    content: z.string().min(1, 'Content is required'),
    contentHtml: z.string().optional(),
    // User ids @mentioned in the note (from compose-time autocomplete).
    mentions: z.array(z.string().min(1)).max(50).optional(),
    subject: z.string().max(500).optional().nullable(),
    noteType: z.string().max(50).optional().default('general'),
    attachments: attachmentList,
    noteDate: dayString.optional(),
    // Save sends none; Save & Add Time sends one; the panel can send several.
    timeEntries: z.array(timeEntryInput).max(20).optional(),
  }),
});

export const updateNoteSchema = z.object({
  body: z.object({
    content: z.string().min(1, 'Content is required'),
    contentHtml: z.string().optional(),
    subject: z.string().max(500).optional().nullable(),
    noteType: z.string().max(50).optional(),
    attachments: attachmentList,
    noteDate: dayString.optional(),
  }),
});

export const retractNoteSchema = z.object({
  body: z.object({
    reason: z.string().max(1000).optional(),
  }),
});

export const pinNoteSchema = z.object({
  body: z.object({ pinned: z.boolean() }),
});

export const addTimeToNoteSchema = z.object({ body: timeEntryInput });
export const updateNoteTimeEntrySchema = z.object({ body: timeEntryInput });

export const addReplySchema = z.object({
  body: z.object({
    content: z.string().min(1, 'Reply cannot be empty').max(20000),
    contentHtml: z.string().optional(),
    mentions: z.array(z.string().min(1)).max(50).optional(),
    attachments: attachmentList,
    // When set, this reply nests under another reply rather than the note
    // itself. Unlimited depth is intentional, so there is no cap here.
    parentReplyId: z.string().uuid().optional(),
  }),
});

export const updateReplySchema = z.object({
  body: z.object({
    content: z.string().min(1, 'Reply cannot be empty').max(20000),
    contentHtml: z.string().optional(),
    attachments: attachmentList,
  }),
});

export const retractReplySchema = z.object({
  body: z.object({
    reason: z.string().max(1000).optional(),
  }),
});
