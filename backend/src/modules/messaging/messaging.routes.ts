const express = require('express');
const router = express.Router({ mergeParams: true });

const { admin } = require('../../shared/database/firebase');
const { verifyToken, requireUserType } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { saveUploadsWithQuota } = require('../../shared/utils/storageUsage');
const filesRepo = require('../files/files.repository');
const { assertFileReadAccess } = require('../files/files.scope');
const { dispositionFor } = require('../../shared/utils/attachmentDisposition');
const { assertUploadsAllowed } = require('../../shared/utils/uploadPolicy');
const { assertObjectPathReadAccess } = require('../../shared/utils/objectPathAccess');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');
const { ValidationError, ForbiddenError, NotFoundError } = require('../../shared/errors/AppError');
const { messageSendLimiter, uploadLimiter } = require('../../shared/middleware/rateLimiters');
const {
  sendMessageSchema,
  attachFromFilesSchema,
  discardAttachmentsSchema,
  markReadSchema,
  listConversationsSchema,
  getConversationSchema,
  createGroupSchema,
  setGroupMattersSchema,
  setGroupPrivacySchema,
  setPresentAsFirmSchema,
  groupSendSchema,
  groupParticipantsSchema,
  setArchivedSchema,
  editMessageSchema,
  deleteMessageSchema,
  searchMessagesSchema,
} = require('./messaging.validation');
const messagingService = require('./messaging.service');
const messagingRepo = require('./messaging.repository');
const { signRealtimeToken } = require('./messaging.realtime');
import {
  beginDirectUploadBatch,
  discardDirectUploadBatch,
  settleDirectUploadBatch,
  stampDirectUploadFinalized,
  FINALIZED_STAMP,
} from '../../shared/storage/directUpload';
import { handler } from '../../shared/http/handler';

const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';
const BASE_FOLDER = 'lawfirmids';
const bucket = admin.storage().bucket(BUCKET_NAME);

/**
 * Source files resolved at once when attaching from the file manager. Each one
 * costs an access check against the pg pool plus a GCS `exists()` and metadata
 * read, and the array comes straight from the request body. The validation
 * schema caps it at five today, but the bound belongs here rather than resting
 * on a number in an unrelated file that a future change may raise.
 */
const ATTACH_SOURCE_CONCURRENCY = Number(process.env.ATTACH_SOURCE_CONCURRENCY) || 4;

// Resolve the storage-folder segment an attachment must live under for a given
// conversation, authorizing the caller along the way. Direct threads target a
// client (the conversation row may not exist yet) and use `{firm}_{clientId}`;
// group threads have no single client and use `group_{conversationId}`. The send
// endpoints only accept attachments whose objectPath is under this folder, so the
// upload/copy handlers and the send-time check must agree on it. Returns the
// folder segment (not the full path).
async function resolveConversationFolder({ lawFirmId, userId, clientId, conversationId }: any) {
  if (!clientId && !conversationId) {
    throw new ValidationError('Unable to upload attachments for this conversation. Please refresh the page and try again.');
  }
  if (clientId) {
    // Verify the target client belongs to this firm before writing bytes under
    // that client's storage prefix, matching the portal upload path. Without it
    // a member could stage attachments in an unrelated firm's client folder.
    await messagingRepo.verifyClientAccess(lawFirmId, clientId);
    return `${lawFirmId}_${clientId}`;
  }
  // Conversation-targeted (group threads, or a direct thread whose client id
  // hasn't resolved client-side). verifyConversationAccess enforces firm scope
  // and (for groups) active participation, so a non-participant member can't
  // stage files under someone else's thread.
  await messagingRepo.verifyConversationAccess(conversationId, userId, 'firm_member', lawFirmId);
  const row = await messagingRepo.loadConversationAuthRow(conversationId);
  return row.conversation_type === 'group'
    ? `group_${conversationId}`
    : `${lawFirmId}_${row.client_id}`;
}

// Read the conversation-list query params off the raw query string. `validate()`
// checks the shape but does not write the parsed values back onto req.query, so the
// numeric params stay strings (the paging helpers coerce them) and the archived
// filter is resolved here. It is deliberately tri-state: absent means "both sides of
// the archive split", which is what the unfiltered full-list callers expect.
function conversationListQuery(req: any) {
  return {
    limit: req.query.limit,
    offset: req.query.offset,
    page: req.query.page,
    search: req.query.search,
    archived: req.query.archived === undefined ? undefined : req.query.archived === 'true',
    clientId: req.query.clientId,
    clientIds: req.query.clientIds
      ? String(req.query.clientIds).split(',').map((id) => id.trim()).filter(Boolean)
      : undefined,
    matterId: req.query.matterId,
  };
}

// ── Firm-scoped routes ──────────────────────────────────────────────────

// POST /api/lawfirms/:lawFirmId/messaging/send
router.post('/lawfirms/:lawFirmId/messaging/send',
  verifyToken,
  requirePermission('messaging.send'),
  messageSendLimiter,
  validate(sendMessageSchema),
  handler(async (req) => messagingService.sendMessage({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

// GET /api/lawfirms/:lawFirmId/messaging/conversations
// Direct threads in the firm. Optional ?limit/&offset/&page/&search/&archived window
// and filter the result; with none of them the whole list comes back.
router.get('/lawfirms/:lawFirmId/messaging/conversations',
  verifyToken,
  requirePermission('messaging.view'),
  validate(listConversationsSchema),
  handler(async (req) => messagingService.listFirmConversations({
    lawFirmId: req.params.lawFirmId,
    ...conversationListQuery(req),
  })),
);

// GET /api/lawfirms/:lawFirmId/messaging/inbox
// The firm's whole conversation list — direct threads plus the caller's group
// threads — interleaved by recency and paged in SQL. Takes the same optional
// ?limit/&offset/&page/&search/&archived params as the two split lists; with none
// of them the whole inbox comes back. This is what the Messages page reads: paging
// the two halves separately and merging them client-side cannot produce an exact
// page N.
router.get('/lawfirms/:lawFirmId/messaging/inbox',
  verifyToken,
  requirePermission('messaging.view'),
  validate(listConversationsSchema),
  handler(async (req) => messagingService.listFirmInbox({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    ...conversationListQuery(req),
  })),
);

// GET /api/lawfirms/:lawFirmId/messaging/conversations/:conversationId
router.get('/lawfirms/:lawFirmId/messaging/conversations/:conversationId',
  verifyToken,
  requirePermission('messaging.view'),
  validate(getConversationSchema),
  handler(async (req) => messagingService.getConversation({
    conversationId: req.params.conversationId,
    userId: req.user.uid,
    query: req.query,
    lawFirmId: req.params.lawFirmId,
  })),
);

// PUT /api/lawfirms/:lawFirmId/messaging/conversations/:conversationId/archive
// Firm-side archive/unarchive of a conversation (direct or group).
router.put('/lawfirms/:lawFirmId/messaging/conversations/:conversationId/archive',
  verifyToken,
  requirePermission('messaging.send'),
  validate(setArchivedSchema),
  handler(async (req) => messagingService.setConversationArchived({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    conversationId: req.params.conversationId,
    archived: req.body.archived,
  })),
);

// GET /api/lawfirms/:lawFirmId/messaging/search?q=...
// Full-text search over message content in this firm's conversations (direct
// threads firm-wide, group threads the caller participates in). Masked snippets.
router.get('/lawfirms/:lawFirmId/messaging/search',
  verifyToken,
  requirePermission('messaging.view'),
  validate(searchMessagesSchema),
  handler(async (req) => messagingService.searchFirmMessages({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    q: req.query.q,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/messaging/messages/:messageId  (edit; sender-only)
router.patch('/lawfirms/:lawFirmId/messaging/messages/:messageId',
  verifyToken,
  requirePermission('messaging.send'),
  validate(editMessageSchema),
  handler(async (req) => messagingService.editMessage({
    messageId: req.params.messageId,
    userId: req.user.uid,
    content: req.body.content,
    lawFirmId: req.params.lawFirmId,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/messaging/messages/:messageId  (soft delete; sender-only)
router.delete('/lawfirms/:lawFirmId/messaging/messages/:messageId',
  verifyToken,
  requirePermission('messaging.send'),
  validate(deleteMessageSchema),
  handler(async (req) => messagingService.deleteMessage({
    messageId: req.params.messageId,
    userId: req.user.uid,
    lawFirmId: req.params.lawFirmId,
  })),
);

// PUT /api/lawfirms/:lawFirmId/messaging/mark-read
router.put('/lawfirms/:lawFirmId/messaging/mark-read',
  verifyToken,
  requirePermission('messaging.view'),
  validate(markReadSchema),
  handler(async (req) => messagingService.markRead({
    userId: req.user.uid,
    body: req.body,
    lawFirmId: req.params.lawFirmId,
  })),
);

// GET /api/lawfirms/:lawFirmId/messaging/unread-count
router.get('/lawfirms/:lawFirmId/messaging/unread-count',
  verifyToken,
  requirePermission('messaging.view'),
  handler(async (req) => messagingService.getFirmUnreadCount({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  })),
);

// GET /api/lawfirms/:lawFirmId/messaging/present-as-firm
// The caller's "appear to clients as the firm" preference for this firm.
router.get('/lawfirms/:lawFirmId/messaging/present-as-firm',
  verifyToken,
  handler(async (req) => messagingService.getPresentAsFirm({
    lawFirmId: req.params.lawFirmId, userId: req.user.uid,
  })),
);

// PUT /api/lawfirms/:lawFirmId/messaging/present-as-firm
router.put('/lawfirms/:lawFirmId/messaging/present-as-firm',
  verifyToken, validate(setPresentAsFirmSchema),
  handler(async (req) => messagingService.setPresentAsFirm({
    lawFirmId: req.params.lawFirmId, userId: req.user.uid,
    presentAsFirm: req.body.presentAsFirm,
  })),
);

// ── Group conversations (firm-scoped) ───────────────────────────────────

// POST /api/lawfirms/:lawFirmId/messaging/groups
router.post('/lawfirms/:lawFirmId/messaging/groups',
  verifyToken, requirePermission('messaging.send'), validate(createGroupSchema),
  handler(async (req) => {
    // Trusted fields last: createGroupSchema declares no lawFirmId/userId in
    // body, so an undeclared key survives validate()'s write-back on the raw
    // req.body and, spread after these, would silently win the object literal
    // and redirect the write into a firm the caller only borrowed
    // messaging.send from via the URL.
    const result = await messagingService.createGroupConversation({
      ...req.body, lawFirmId: req.params.lawFirmId, userId: req.user.uid,
    });
    return result;
  }, 201),
);

// GET /api/lawfirms/:lawFirmId/messaging/groups  (the caller's group threads in this firm)
// Takes the same optional window/filter query params as the direct list above.
router.get('/lawfirms/:lawFirmId/messaging/groups',
  verifyToken, requirePermission('messaging.view'), validate(listConversationsSchema),
  handler(async (req) => messagingService.listFirmGroupConversations({
    lawFirmId: req.params.lawFirmId, userId: req.user.uid,
    ...conversationListQuery(req),
  })),
);

// POST /api/lawfirms/:lawFirmId/messaging/groups/:conversationId/messages
router.post('/lawfirms/:lawFirmId/messaging/groups/:conversationId/messages',
  verifyToken, requirePermission('messaging.send'), messageSendLimiter, validate(groupSendSchema),
  handler(async (req) => messagingService.sendGroupMessage({
    conversationId: req.params.conversationId, userId: req.user.uid, body: req.body,
    lawFirmId: req.params.lawFirmId,
  }), 201),
);

// GET /api/lawfirms/:lawFirmId/messaging/groups/:conversationId
router.get('/lawfirms/:lawFirmId/messaging/groups/:conversationId',
  verifyToken, requirePermission('messaging.view'), validate(getConversationSchema),
  handler(async (req) => messagingService.getGroupConversation({
    conversationId: req.params.conversationId, userId: req.user.uid, query: req.query,
    lawFirmId: req.params.lawFirmId,
  })),
);

// GET /api/lawfirms/:lawFirmId/messaging/company-conversation/:clientId
// Resolve (find or create) a COMPANY client's canonical conversation for
// firm-side viewing (organization-clients plan Phase 7), so a firm member
// opening a company client's Messages tab reaches the one canonical thread
// whether or not any linked person has portal access yet. Distinct path
// segment from `/groups/:conversationId` above, so route order doesn't
// matter here.
router.get('/lawfirms/:lawFirmId/messaging/company-conversation/:clientId',
  verifyToken, requirePermission('messaging.view'),
  handler(async (req) => messagingService.getCompanyConversation({
    lawFirmId: req.params.lawFirmId, userId: req.user.uid, clientId: req.params.clientId,
  })),
);

// PUT /api/lawfirms/:lawFirmId/messaging/groups/:conversationId/mark-read
router.put('/lawfirms/:lawFirmId/messaging/groups/:conversationId/mark-read',
  verifyToken, requirePermission('messaging.view'),
  handler(async (req) => messagingService.markGroupRead({
    conversationId: req.params.conversationId, userId: req.user.uid,
    lawFirmId: req.params.lawFirmId,
  })),
);

// PUT /api/lawfirms/:lawFirmId/messaging/groups/:conversationId/matters
// Set the group's matter scope (organizational tag; zero, one, or many matters).
router.put('/lawfirms/:lawFirmId/messaging/groups/:conversationId/matters',
  verifyToken, requirePermission('messaging.send'), validate(setGroupMattersSchema),
  handler(async (req) => messagingService.setGroupMatters({
    conversationId: req.params.conversationId, userId: req.user.uid,
    lawFirmId: req.params.lawFirmId, matterIds: req.body.matterIds,
  })),
);

// PUT /api/lawfirms/:lawFirmId/messaging/groups/:conversationId/privacy
// Toggle per-conversation client-name masking (replaces the firm-wide setting).
router.put('/lawfirms/:lawFirmId/messaging/groups/:conversationId/privacy',
  verifyToken, requirePermission('messaging.send'), validate(setGroupPrivacySchema),
  handler(async (req) => messagingService.setGroupPrivacy({
    conversationId: req.params.conversationId, userId: req.user.uid,
    lawFirmId: req.params.lawFirmId, hideClientNames: req.body.hideClientNames,
  })),
);

// POST /api/lawfirms/:lawFirmId/messaging/groups/:conversationId/participants
router.post('/lawfirms/:lawFirmId/messaging/groups/:conversationId/participants',
  verifyToken, requirePermission('messaging.send'), validate(groupParticipantsSchema),
  handler(async (req) => {
    // Trusted fields last, same reasoning as the create route above:
    // groupParticipantsSchema declares no conversationId/lawFirmId/userId in
    // body, so those keys survive on the raw req.body and would otherwise win
    // the object literal, redirecting the add into a different conversation
    // and firm the caller has no real permission over.
    const result = await messagingService.addGroupParticipants({
      ...req.body, conversationId: req.params.conversationId, userId: req.user.uid,
      lawFirmId: req.params.lawFirmId,
    });
    return result;
  }),
);

// DELETE /api/lawfirms/:lawFirmId/messaging/groups/:conversationId/participants/:userId
router.delete('/lawfirms/:lawFirmId/messaging/groups/:conversationId/participants/:userId',
  verifyToken, requirePermission('messaging.send'),
  handler(async (req) => messagingService.removeGroupParticipant({
    conversationId: req.params.conversationId, userId: req.user.uid,
    lawFirmId: req.params.lawFirmId, targetUserId: req.params.userId,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/messaging/groups/:conversationId/pending/:clientId
// Remove a recipient who was added before they had a portal account. They are
// keyed by `clients.id`, not a portal uid, so the participant route above
// cannot address them.
router.delete('/lawfirms/:lawFirmId/messaging/groups/:conversationId/pending/:clientId',
  verifyToken, requirePermission('messaging.send'),
  handler(async (req) => messagingService.removePendingGroupClient({
    conversationId: req.params.conversationId, userId: req.user.uid,
    lawFirmId: req.params.lawFirmId, clientRecordId: req.params.clientId,
  })),
);

// Message attachments upload straight to storage. They used to arrive here as
// multipart: up to five files at a hundred megabytes each, all resident in the
// container's heap before the handler ran, on an instance serving 80 concurrent
// requests on 512 MiB that also signs documents. Five people attaching at once
// was the exposure, not one large file.
//
// `messaging.send` and firm membership guard BOTH steps, and the conversation
// folder is resolved from the caller's access on both, never taken from the
// request. A finalize missing either would stage files in a firm's conversation
// folder without the permission that gates messaging.

/** Attachments one message may carry. Matches what the multipart route took. */
const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/** Largest single attachment. Unchanged by the move to direct upload. */
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

// POST /api/lawfirms/:lawFirmId/messaging/attachments/upload-init
router.post('/lawfirms/:lawFirmId/messaging/attachments/upload-init',
  verifyToken,
  requirePermission('messaging.send'),
  uploadLimiter,
  handler(async (req, res) => {
    const { lawFirmId } = req.params;
    const { clientId, conversationId: bodyConversationId, files } = req.body || {};
    const userId = req.user.uid;

    await assertLawFirmMembership(lawFirmId, userId);
    const conversationId = await resolveConversationFolder({
      lawFirmId, userId, clientId, conversationId: bodyConversationId,
    });

    const opened = await beginDirectUploadBatch({
      lawFirmId,
      uploadedBy: userId,
      files: files || [],
      maxBytes: MAX_ATTACHMENT_BYTES,
      maxFiles: MAX_ATTACHMENTS_PER_MESSAGE,
      resolvePath: (file: any) => {
        // The same unique-name shape the multipart route used. A collision here
        // would overwrite another attachment in the same conversation.
        const safeName = String(file.fileName || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
        const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 11)}_${safeName}`;
        return `${BASE_FOLDER}/${lawFirmId}/messaging/${conversationId}/${unique}`;
      },
      origin: req.get('origin') || undefined,
      metadata: { lawFirmId, conversationId, type: 'message-attachment' },
    });

    return res.status(200).json(opened);
  }),
);

// POST /api/lawfirms/:lawFirmId/messaging/attachments/upload-finalize
router.post('/lawfirms/:lawFirmId/messaging/attachments/upload-finalize',
  verifyToken,
  requirePermission('messaging.send'),
  handler(async (req, res) => {
    const { lawFirmId } = req.params;
    const { clientId, conversationId: bodyConversationId, uploads } = req.body || {};
    const userId = req.user.uid;

    await assertLawFirmMembership(lawFirmId, userId);
    // Resolved again rather than trusted from the request, so the prefix the
    // paths below are checked against is one this caller can actually reach.
    const conversationId = await resolveConversationFolder({
      lawFirmId, userId, clientId, conversationId: bodyConversationId,
    });
    const prefix = `${BASE_FOLDER}/${lawFirmId}/messaging/${conversationId}/`;

    const list = Array.isArray(uploads) ? uploads : [];
    // No more than init would open. The array is the caller's, and each entry
    // costs a storage settle and a signed url.
    if (list.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new ValidationError(`Attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files at once.`);
    }
    // The paths are echoed back by the client. Unchecked, an attachment could
    // be recorded against any object in the bucket.
    for (const upload of list) {
      const objectPath = String(upload?.objectPath || '');
      if (!objectPath.startsWith(prefix) || objectPath.slice(prefix.length).includes('/')) {
        throw new ValidationError('That upload does not belong to this conversation.');
      }
    }

    const { results: attachments, failures } = await settleDirectUploadBatch({
      lawFirmId,
      uploadedBy: userId,
      uploads: list,
      maxBytes: MAX_ATTACHMENT_BYTES,
      onSettled: async (settled: any, index: number) => {
        const originalName = String(list[index]?.fileName || 'upload.bin').slice(0, 255);
        // The stamp is what send checks, and charging only the call that wrote
        // it keeps a repeated finalize of the same object from billing twice.
        const firstFinalize = await stampDirectUploadFinalized(settled.objectPath, { originalName });
        const [signedUrl] = await bucket.file(settled.objectPath).getSignedUrl({
          version: 'v4',
          action: 'read',
          // 1 hour. Reads re-sign via resignAttachments(); a week-long signed
          // URL is a bearer token that bypasses every permission check.
          expires: Date.now() + 60 * 60 * 1000,
          responseDisposition: dispositionFor(settled.contentType, originalName),
        });
        return {
          id: `${Date.now()}_${index}`,
          name: originalName,
          url: signedUrl,
          objectPath: settled.objectPath,
          mimeType: settled.contentType,
          size: settled.size,
          chargedBytes: firstFinalize ? settled.size : 0,
        };
      },
    });

    return res.status(201).json({ attachments, failures });
  }),
);

// POST /api/lawfirms/:lawFirmId/messaging/attachments/upload-cancel
//
// The caller abandoned attachment uploads: free the quota they hold at once
// rather than when the reservations lapse. Body `{ clientId | conversationId,
// uploads: [{ objectPath, reservationId }] }`; answers `{ cancelled: n }`, n
// being the reservations released.
//
// A partial object is removed only when it sits directly under the folder this
// request authorizes (resolved from the caller's access, as at finalize) and no
// saved message names it; `discardDirectUploadBatch` adds the rest (this
// caller's stamp, the same reservation, and that reservation still live, which
// a settled upload's never is). An attachment that was sent is the record of
// what the client received, and nothing here reaches it.
router.post('/lawfirms/:lawFirmId/messaging/attachments/upload-cancel',
  verifyToken,
  requirePermission('messaging.send'),
  handler(async (req) => {
    const { lawFirmId } = req.params;
    const { clientId, conversationId: bodyConversationId, uploads } = req.body || {};
    const userId = req.user.uid;

    await assertLawFirmMembership(lawFirmId, userId);
    const conversationId = await resolveConversationFolder({
      lawFirmId, userId, clientId, conversationId: bodyConversationId,
    });
    const prefix = `${BASE_FOLDER}/${lawFirmId}/messaging/${conversationId}/`;

    const list = Array.isArray(uploads) ? uploads : [];
    if (list.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new ValidationError(`Attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files at once.`);
    }

    return discardDirectUploadBatch({
      lawFirmId,
      uploadedBy: userId,
      uploads: list,
      mayDeleteObject: async (objectPath: string) => objectPath.startsWith(prefix)
        && !objectPath.slice(prefix.length).includes('/')
        && !(await messagingRepo.isAttachmentObjectReferenced(lawFirmId, objectPath)),
    });
  }),
);

// POST /api/lawfirms/:lawFirmId/messaging/attachments/discard
//
// The caller removed finalized attachments from the composer without sending
// them: delete the objects and give their bytes back to the firm's usage. Body
// `{ clientId | conversationId, objectPaths }`; answers `{ discarded: n }`.
// The folder is resolved from the caller's access, as at finalize, and
// `discardUnsentAttachments` deletes only this caller's finalized, unsent
// objects in it (device uploads and file-manager copies alike).
router.post('/lawfirms/:lawFirmId/messaging/attachments/discard',
  verifyToken,
  requirePermission('messaging.send'),
  validate(discardAttachmentsSchema),
  handler(async (req) => {
    const { lawFirmId } = req.params;
    const { clientId, conversationId: bodyConversationId, objectPaths } = req.body;
    const userId = req.user.uid;

    await assertLawFirmMembership(lawFirmId, userId);
    const conversationId = await resolveConversationFolder({
      lawFirmId, userId, clientId, conversationId: bodyConversationId,
    });

    return messagingService.discardUnsentAttachments({
      lawFirmId,
      userId,
      prefix: `${BASE_FOLDER}/${lawFirmId}/messaging/${conversationId}/`,
      objectPaths,
    });
  }),
);

// POST /api/lawfirms/:lawFirmId/messaging/attachments/from-files
// Attach files that already live in the firm's file manager. Each referenced
// objectPath is re-authorized for read access (a member can't attach a file from a
// matter/task they lack access to), then COPIED into the conversation's messaging
// folder. Copying (rather than referencing the original path) keeps the existing
// objectPath-prefix security model intact — the send endpoint only trusts paths
// under the conversation folder — and means a portal client on the thread can read
// the attachment without being granted access to the firm-internal source file.
router.post('/lawfirms/:lawFirmId/messaging/attachments/from-files',
  verifyToken,
  requirePermission('messaging.send'),
  validate(attachFromFilesSchema),
  handler(async (req, res) => {
    const { lawFirmId } = req.params;
    const { clientId, conversationId: bodyConversationId, files } = req.body;
    const userId = req.user.uid;

    await assertLawFirmMembership(lawFirmId, userId);
    const conversationId = await resolveConversationFolder({
      lawFirmId, userId, clientId, conversationId: bodyConversationId,
    });

    // Resolve every source first (authorize + load the row) so a bad reference
    // fails the whole request before any bytes are copied or quota is charged.
    //
    // The caller names each document by its file id. It used to send an object
    // path, which had to be checked against the firm's storage prefix by hand
    // and then parsed for a display name; the row is scoped to the firm by the
    // lookup itself and already carries the name.
    const settledSources = await runWithConcurrency(files.map(({ fileId }: any) => async () => {
      const row = await filesRepo.findById(lawFirmId, fileId);
      if (!row || row.kind !== 'file') throw new NotFoundError('File');

      // A member must be able to READ the source (matter membership, task
      // visibility, firm membership) before they can forward it into a chat.
      await assertFileReadAccess(lawFirmId, row.id, userId);

      const srcFile = bucket.file(row.objectPath);
      const [exists] = await srcFile.exists();
      if (!exists) throw new NotFoundError('File');
      const [meta] = await srcFile.getMetadata();
      return {
        srcFile,
        objectPath: row.objectPath,
        mimeType: meta.contentType || row.mimeType || 'application/octet-stream',
        size: Number(meta.size) || row.sizeBytes || 0,
        displayName: row.name.slice(0, 255),
      };
    }), ATTACH_SOURCE_CONCURRENCY);

    // The first bad reference has to fail the request, which is what the
    // comment above promises: nothing is copied and no quota is charged
    // unless every source resolved. `runWithConcurrency` reports failures
    // through its settled array rather than by rejecting, so re-throw here.
    const firstFailure = settledSources.find((r: any) => r.status === 'rejected');
    if (firstFailure) throw firstFailure.reason;
    // In input order, so `sources[i]` still lines up with `quotaFiles[i]`.
    const sources = settledSources.map((r: any) => r.value);

    // Same executable/script deny-list as device uploads: a file-manager file can
    // be forwarded to a portal client, so re-apply the bar by name + mimetype.
    assertUploadsAllowed(sources.map((s: any) => ({ originalname: s.displayName, mimetype: s.mimeType })));

    // Copying duplicates the bytes into the messaging folder, so it consumes real
    // storage and is quota-accounted just like a device upload, through the same
    // atomic reserve.
    const quotaFiles = sources.map((s: any) => ({ size: s.size, originalname: s.displayName }));
    const { results: attachments, failures } = await saveUploadsWithQuota(lawFirmId, quotaFiles, async (_f: any, i: any) => {
      const s = sources[i];
      const safeName = s.displayName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substr(2, 9);
      const uniqueName = `${timestamp}_${randomId}_${safeName}`;
      const destPath = `${BASE_FOLDER}/${lawFirmId}/messaging/${conversationId}/${uniqueName}`;
      const destFile = bucket.file(destPath);

      await s.srcFile.copy(destFile);
      await destFile.setMetadata({
        contentType: s.mimeType,
        metadata: {
          uploadedBy: userId,
          lawFirmId,
          conversationId,
          originalName: s.displayName,
          type: 'message-attachment',
          copiedFrom: s.objectPath,
          // The copy is admitted and charged right here, so it is as finalized
          // as a settled upload, and send accepts it on the same stamp.
          [FINALIZED_STAMP]: new Date().toISOString(),
        },
      });

      const [signedUrl] = await destFile.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 60 * 60 * 1000,
        responseDisposition: dispositionFor(s.mimeType, s.displayName),
      });

      return {
        id: `${timestamp}_${randomId}`,
        name: s.displayName,
        url: signedUrl,
        objectPath: destPath,
        mimeType: s.mimeType,
        size: s.size,
      };
    }, userId);

    if (attachments.length === 0 && failures.length > 0) throw failures[0];

    return res.status(201).json({ attachments });
  }),
);

// ── Client-scoped routes (no lawFirmId) ─────────────────────────────────

// GET /api/messaging/client-conversations
router.get('/messaging/client-conversations',
  verifyToken,
  requireUserType(['client']),
  handler(async (req) => messagingService.listClientConversations({
    userId: req.user.uid,
  })),
);

// GET /api/messaging/search?q=...  (client-facing)
// Search message content across the conversations this client participates in.
router.get('/messaging/search',
  verifyToken,
  requireUserType(['client']),
  validate(searchMessagesSchema),
  handler(async (req) => messagingService.searchClientMessages({
    userId: req.user.uid,
    q: req.query.q,
  })),
);

// PATCH /api/messaging/messages/:messageId  (client edit; sender-only)
router.patch('/messaging/messages/:messageId',
  verifyToken,
  requireUserType(['client']),
  validate(editMessageSchema),
  handler(async (req) => messagingService.editMessage({
    messageId: req.params.messageId,
    userId: req.user.uid,
    content: req.body.content,
    isClient: true,
  })),
);

// DELETE /api/messaging/messages/:messageId  (client soft delete; sender-only)
router.delete('/messaging/messages/:messageId',
  verifyToken,
  requireUserType(['client']),
  validate(deleteMessageSchema),
  handler(async (req) => messagingService.deleteMessage({
    messageId: req.params.messageId,
    userId: req.user.uid,
    isClient: true,
  })),
);

// GET /api/messaging/unread-count  (client-facing)
router.get('/messaging/unread-count',
  verifyToken,
  requireUserType(['client']),
  handler(async (req) => messagingService.getClientUnreadCount({
    userId: req.user.uid,
  })),
);

// ── Group conversations (client-scoped) ─────────────────────────────────

// GET /api/messaging/client-groups
router.get('/messaging/client-groups',
  verifyToken, requireUserType(['client']),
  handler(async (req) => {
    return await messagingService.listGroupConversations({ userId: req.user.uid });
  }),
);

// GET /api/messaging/client-groups/:conversationId
router.get('/messaging/client-groups/:conversationId',
  verifyToken, requireUserType(['client']), validate(getConversationSchema),
  handler(async (req) => {
    return await messagingService.getGroupConversation({
      conversationId: req.params.conversationId, userId: req.user.uid, query: req.query,
    });
  }),
);

// POST /api/messaging/client-groups/:conversationId/messages
router.post('/messaging/client-groups/:conversationId/messages',
  verifyToken, requireUserType(['client']), messageSendLimiter, validate(groupSendSchema),
  handler(async (req) => {
    return await messagingService.sendGroupMessage({
      conversationId: req.params.conversationId, userId: req.user.uid, body: req.body,
    });
  }, 201),
);

// PUT /api/messaging/client-groups/:conversationId/mark-read
router.put('/messaging/client-groups/:conversationId/mark-read',
  verifyToken, requireUserType(['client']),
  handler(async (req) => {
    return await messagingService.markGroupRead({
      conversationId: req.params.conversationId, userId: req.user.uid,
    });
  }),
);

// GET /api/messaging/realtime-token (mint a short-lived Supabase JWT for the
// frontend Realtime subscription (sub = firebase uid; RLS authorizes per-row).
//
// NOTE: This route is intentionally identity-scoped, NOT firm-scoped. It has no
// :lawFirmId in its path and serves BOTH firm members and portal clients (see
// frontend/src/lib/supabase/realtimeClient.ts). We therefore cannot use
// requirePermission() here. It requires a path :lawFirmId and only understands
// `members`, so it would reject every caller (members lacking firm context and
// clients entirely). Security is enforced by Supabase RLS on the messaging tables
// (the JWT only carries the uid; a caller sees only rows their uid is party to),
// plus the short TTL below. verifyToken (which also enforces email verification)
// is the correct gate for this endpoint.
router.get('/messaging/realtime-token',
  verifyToken,
  handler(async (req) => {
    return signRealtimeToken(req.user.uid);
  }),
);

export = router;
