import { z } from 'zod';
const { paging } = require('../../shared/validation/listQuery');

// A message attachment as the browser echoes it from finalize. Only the path is
// trusted, and only after send verifies it against storage: name, type and
// size are replaced there with what storage recorded. Shared with the portal
// send so both sides of a thread take the same shape.
export const attachmentSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  url: z.string().url(),
  objectPath: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
});

export const sendMessageSchema = z.object({
  body: z.object({
    clientId: z.string().min(1, 'clientId is required'),
    content: z.string().max(4000).optional().default(''),
    matterId: z.string().optional().nullable(),
    attachments: z.array(attachmentSchema).max(5).optional(),
    // User ids @mentioned in the message (captured from the compose-time
    // autocomplete; never name-matched). Drives @mention notifications.
    mentions: z.array(z.string().min(1)).max(50).optional(),
  }).superRefine((data, ctx) => {
    if (!data.content?.trim() && (!data.attachments || data.attachments.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Message content or at least one attachment is required',
      });
    }
  }),
});

// Attach existing file-manager files to a message. The caller references files by
// their GCS objectPath (read-access re-verified server-side); `name` is an optional
// display hint. Exactly one of clientId / conversationId targets the thread.
export const attachFromFilesSchema = z.object({
  body: z.object({
    clientId: z.string().min(1).optional(),
    conversationId: z.string().uuid().optional(),
    // The row carries the name, so the caller sends only the id. A name from
    // the request used to override it, which let one document be forwarded into
    // a chat under another document's name.
    files: z.array(z.object({
      fileId: z.string().uuid(),
    })).min(1, 'Select at least one file').max(5, 'You can attach up to 5 files'),
  }).refine((d) => d.clientId || d.conversationId, {
    message: 'A conversation target is required',
    path: ['conversationId'],
  }),
  params: z.object({ lawFirmId: z.string() }),
});

// The attachments a composer is dropping before send. Only paths: the route
// resolves the folder from the caller's access and storage supplies the rest.
export const discardAttachmentsSchema = z.object({
  body: z.object({
    clientId: z.string().min(1).optional(),
    conversationId: z.string().uuid().optional(),
    objectPaths: z.array(z.string().min(1).max(1024)).min(1).max(5),
  }).refine((d) => d.clientId || d.conversationId, {
    message: 'A conversation target is required',
    path: ['conversationId'],
  }),
  params: z.object({ lawFirmId: z.string() }),
});

export const markReadSchema = z.object({
  body: z.object({
    conversationId: z.string().min(1, 'conversationId is required'),
    messageIds: z.array(z.string().min(1)).min(1, 'At least one messageId is required'),
  }),
});

// Conversation-list query, shared by the direct and the group list endpoints.
// Every part is optional: omitting `limit` preserves the unlimited full-list
// response the firm-wide callers depend on, and omitting `archived` returns both
// active and archived threads. `archived` is validated as the literal query-string
// values rather than coerced, because 'false' would coerce to true.
export const listConversationsSchema = z.object({
  query: z.object({
    ...paging({ max: 200 }),
    search: z.string().max(200).optional(),
    archived: z.enum(['true', 'false']).optional(),
    clientId: z.string().min(1).max(200).optional(),
    clientIds: z.string().max(5000).optional(),
    matterId: z.string().uuid().optional(),
  }),
  params: z.object({ lawFirmId: z.string() }),
});

export const getConversationSchema = z.object({
  query: z.object({
    // Coerce the query-string limit to a bounded int so a bad value is a clean
    // 400 here (the repo otherwise falls back to its default of 25).
    limit: z.coerce.number().int().min(1).max(100).optional(),
    // lastMessageId is a cursor resolved against a uuid messages.id; validate it
    // as a uuid so malformed input is a 400 instead of a confusing 404 deep in
    // the repo's cursor lookup.
    lastMessageId: z.string().uuid().optional(),
  }),
});

// ── Group conversations (Option B) ──────────────────────────────────────

export const createGroupSchema = z.object({
  body: z.object({
    title: z.string().max(200).optional(),
    // Matter scope is an organizational tag: zero, one, or many matters.
    matterIds: z.array(z.string().uuid()).max(50).optional(),
    memberIds: z.array(z.string().min(1)).max(50).optional(),
    // Client record ids may be selected before the client has a portal account.
    // The service stores those records as pending recipients and promotes them
    // to participants when the client later creates an account.
    clientRecordIds: z.array(z.string().uuid()).max(50).optional(),
    // Clients are optional: a conversation may be firm-members-only (internal) or
    // include one or more clients. The service requires at least one participant
    // besides the creator.
    clientIds: z.array(z.string().min(1)).max(50).optional(),
    // "Pick an organization" quick-add (organization-clients plan Phase 7):
    // company clients.id values whose whole person roster should be
    // added alongside any hand-picked clientIds.
    organizationClientIds: z.array(z.string().uuid()).max(20).optional(),
  }),
  params: z.object({ lawFirmId: z.string() }),
});

export const setGroupMattersSchema = z.object({
  body: z.object({
    matterIds: z.array(z.string().uuid()).max(50),
  }),
  params: z.object({ conversationId: z.string().uuid() }),
});

export const groupSendSchema = z.object({
  body: z.object({
    content: z.string().max(4000).optional().default(''),
    attachments: z.array(attachmentSchema).max(5).optional(),
    mentions: z.array(z.string().min(1)).max(50).optional(),
  }).superRefine((data, ctx) => {
    if (!data.content?.trim() && (!data.attachments || data.attachments.length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['content'], message: 'Message content or at least one attachment is required' });
    }
  }),
  params: z.object({ conversationId: z.string().uuid() }),
});

export const setGroupPrivacySchema = z.object({
  body: z.object({
    hideClientNames: z.boolean(),
  }),
  params: z.object({ conversationId: z.string().uuid() }),
});

export const setPresentAsFirmSchema = z.object({
  body: z.object({
    presentAsFirm: z.boolean(),
  }),
  params: z.object({ lawFirmId: z.string() }),
});

export const groupParticipantsSchema = z.object({
  body: z.object({
    memberIds: z.array(z.string().min(1)).max(50).optional(),
    clientIds: z.array(z.string().min(1)).max(50).optional(),
    clientRecordIds: z.array(z.string().uuid()).max(50).optional(),
    // Same "pick an organization" quick-add as createGroupSchema, for adding
    // a company's whole person roster to an EXISTING group.
    organizationClientIds: z.array(z.string().uuid()).max(20).optional(),
    // Whether the added client(s) may read messages sent before they joined.
    // Omitted/true keeps the long-standing full-history behavior; false hides
    // prior messages from the added clients (firm members are never affected).
    shareHistory: z.boolean().optional(),
  }),
  params: z.object({ conversationId: z.string().uuid() }),
});

export const setArchivedSchema = z.object({
  body: z.object({
    archived: z.boolean(),
  }),
  params: z.object({ lawFirmId: z.string(), conversationId: z.string().uuid() }),
});

// Edit a message. Content follows the same non-empty-or-attachment rule as
// sending, enforced in the service (an edit may keep an attachment-only message
// with empty content). messageId is the message uuid; extra path params (e.g. a
// firm route's lawFirmId) are ignored by zod's default object parsing.
export const editMessageSchema = z.object({
  body: z.object({
    content: z.string().max(4000).optional().default(''),
  }),
  params: z.object({ messageId: z.string().uuid() }),
});

export const deleteMessageSchema = z.object({
  params: z.object({ messageId: z.string().uuid() }),
});

// In-message search. `q` must be at least 2 chars (the service also guards this
// after trimming); coerced from the query string.
export const searchMessagesSchema = z.object({
  query: z.object({
    q: z.string().min(2, 'Enter at least 2 characters').max(200),
  }),
});
