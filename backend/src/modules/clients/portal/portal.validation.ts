import { z } from 'zod';
// Bounded paging params, shared so every list agrees on how deep a window may go.
const { pageParam, offsetParam } = require('../../../shared/validation/listQuery');
const { attachmentSchema } = require('../../messaging/messaging.validation');

// POST /lawfirm/:lawFirmId/messages (client sends a message).
// content/attachment presence is further checked in the service.
// `conversationId` is optional (organization-clients plan Phase 7): omitted,
// this sends into the client's own direct thread with the firm (unchanged);
// given a group thread's id (a company's canonical conversation, or an
// ad-hoc group), the service delegates to the group send path instead.
export const sendPortalMessageSchema = z.object({
  body: z.object({
    // The same limits and attachment shape as the firm and group sends, so a
    // client cannot post more, or a looser shape, than the firm can.
    content: z.string().max(4000).optional(),
    matterId: z.string().min(1).nullable().optional(),
    attachments: z.array(attachmentSchema).max(5).optional(),
    conversationId: z.string().uuid().optional(),
  }),
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
});

// PUT /lawfirm/:lawFirmId/messages/mark-read
// `conversationId` optional, same contract as sendPortalMessageSchema.
export const markPortalMessagesReadSchema = z.object({
  body: z.object({
    messageIds: z.array(z.string().min(1)).default([]),
    conversationId: z.string().uuid().optional(),
  }),
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
});

// PUT /lawfirm/:lawFirmId/settings (whitelist the settings keys the service
// actually persists (notifications / communication / portal). Arbitrary jsonb
// is rejected so a client cannot write unexpected keys into clients.settings.
// The service accepts either `{ settings: {...} }` or a bare `{...}`, so allow both.
const portalSettingsObjectSchema = z
  .object({
    notifications: z.record(z.string(), z.any()).optional(),
    communication: z.record(z.string(), z.any()).optional(),
    portal: z.record(z.string(), z.any()).optional(),
  })
  .strict();

export const updatePortalSettingsSchema = z.object({
  body: z.union([
    z.object({ settings: portalSettingsObjectSchema }).strict(),
    portalSettingsObjectSchema,
  ]),
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
});

// GET /lawfirm/:lawFirmId/trust/ledger (paginate the client's trust ledger).
// z.coerce because query params arrive as strings; bounds mirror the firm-side
// clientLedgerQuerySchema so the portal can't request an unbounded page.
export const portalTrustLedgerQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: offsetParam,
  }),
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
});

// POST /lawfirm/:lawFirmId/matters/:matterId/documents/refresh-url (lazily re-sign a
// fresh download URL for a single client-visible matter document the UI is opening.
// The service re-checks that the row belongs to this matter and is shared with
// this client before signing.
export const refreshDocumentUrlSchema = z.object({
  body: z.object({
    fileId: z.string().uuid(),
  }),
  params: z.object({
    lawFirmId: z.string().min(1),
    matterId: z.string().min(1),
  }),
});

// POST /lawfirm/:lawFirmId/documents/refresh-url. Same body, but no matter in the
// path: the document feed spans matters, the client's own files and standalone
// tasks, and the row says which of those it belongs to before the service
// re-checks that this client may read it.
export const refreshAnyDocumentUrlSchema = z.object({
  body: z.object({
    fileId: z.string().uuid(),
  }),
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
});

// GET /lawfirm/:lawFirmId/billing. Omitting `limit` returns every invoice, which
// the statement view needs; the invoice list passes a page.
export const portalBillingQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: offsetParam,
    page: pageParam,
    status: z.string().min(1).max(40).optional(),
  }).passthrough(),
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
});

// GET /lawfirm/:lawFirmId/messages. Cursor-paged history: `lastMessageId` is the
// oldest message the client already holds, and the page returned is the messages
// immediately before it. Bounds mirror the firm-side getConversationSchema so
// both sides of the same thread page identically. `conversationId` is optional
// (organization-clients plan Phase 7): omitted, this is the client's own direct
// thread (unchanged); given a group thread's id, the service delegates to the
// group read path instead.
export const portalMessagesQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    lastMessageId: z.string().uuid().optional(),
    conversationId: z.string().uuid().optional(),
  }),
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
});

// GET /lawfirm/:lawFirmId/messages/conversations. No query params of its own -
// this is participant-membership-based (see listPortalConversations), not
// filterable by active client selection.
export const portalConversationsQuerySchema = z.object({
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
});

// GET /lawfirm/:lawFirmId/notifications. Cursor-paged the same way the firm-side
// feed is: `before` is the createdAt of the oldest notification already held and
// the page returned is the ones immediately before it. `limit` stops at the same
// 100 the service clamps to, so a request asking for more is refused rather than
// silently served a smaller page than it asked for.
export const portalNotificationsQuerySchema = z.object({
  query: z.object({
    unreadOnly: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    before: z.string().datetime({ offset: true }).optional(),
  }),
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
});

// GET /lawfirm/:lawFirmId/events. `matterId` scopes the agenda to one matter;
// the service still checks the client is on it before reading.
export const portalEventsQuerySchema = z.object({
  query: z.object({
    matterId: z.string().min(1).max(100).optional(),
  }),
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
});

// POST /lawfirm/:lawFirmId/messages/attachments/discard. Only paths: the
// service resolves the folder from the client's access and reads the rest
// from storage.
export const discardPortalAttachmentsSchema = z.object({
  body: z.object({
    conversationId: z.string().uuid().optional(),
    objectPaths: z.array(z.string().min(1).max(1024)).min(1).max(5),
  }),
  params: z.object({ lawFirmId: z.string().min(1) }),
});
