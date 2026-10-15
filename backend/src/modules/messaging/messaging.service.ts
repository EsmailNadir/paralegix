const msgRepo = require('./messaging.repository');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { assertFirmPermission } = require('../lawfirms/roles/requirePermission');
const { isUuid } = require('../../shared/utils/isUuid');
const { ForbiddenError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { sendNewMessageNotificationEmail } = require('../../shared/services/emailService');
const { shouldSendClientEmail, EMAIL_CATEGORIES } = require('../../shared/services/emailPreferences');
const { resignAttachments, deleteAttachmentObjects } = require('../../shared/utils/attachmentSigning');
const { adjustStorageUsageByDelta } = require('../../shared/utils/storageUsage');
const { readFinalizedUpload } = require('../../shared/storage/directUpload');
const { resolvePhotoUrls, signUserPhotoUrl } = require('../../shared/utils/userPhoto');
const eventBus = require('../../shared/events/eventBus');
const { MESSAGE_SENT, MESSAGES_READ } = require('../../shared/events/eventTypes');
const { broadcastConversationEvent } = require('./messaging.realtime');

const NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.paralegix.com';
// A sender may edit or delete their own message only within this window of sending it.
const MESSAGE_MODIFY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * "Send as firm" masking (client-facing only). Mutates the given message array
 * in place: any firm-member message flagged `sentAsFirm` is presented under the
 * firm's name + logo instead of the individual. No-op when nothing is flagged.
 * Callers must only invoke this for a client viewer (firm members see the real
 * sender). Shared by the group read and the client-portal direct read so the two
 * paths mask identically.
 */
export async function maskSendAsFirmMessages(messages: any, lawFirmId: string) {
  if (!Array.isArray(messages)) return;
  if (!messages.some((m) => m.sentAsFirm && m.senderType === 'firm_member')) return;
  const branding = await msgRepo.getFirmNameAndLogo(lawFirmId);
  const firmName = branding.name || 'Law Firm';
  const firmLogoUrl = await signUserPhotoUrl(branding.logoObjectPath);
  messages.forEach((m) => {
    if (m.sentAsFirm && m.senderType === 'firm_member') {
      m.senderName = firmName;
      m.senderPhotoUrl = firmLogoUrl || null;
    }
  });
}

/**
 * Admit the attachments a sender names, and replace every claim they make
 * with what storage recorded.
 *
 * Only the object path comes from the request, and it is trusted only once all
 * of these hold, each refusing the whole send:
 *
 *   - it sits directly under `prefix`, the folder of the conversation being
 *     written to. All firms share one bucket and reads sign whatever is stored,
 *     so this is the tenant and participant boundary;
 *   - the object exists and carries the finalize stamp. Finalize is where the
 *     size cap, the executable sniff and the quota charge run, so an object
 *     only PUT to its session has passed none of them;
 *   - storage records THIS sender as its uploader. A direct thread's folder is
 *     written by both sides and every read exposes the path, so without this a
 *     client could name the firm's file (or the reverse) and then delete it;
 *   - no saved message already names it, so one object belongs to one message
 *     and deleting a message can never take bytes another one shows.
 *
 * Name, type and size are then taken from storage. Size is what deleting the
 * message subtracts from the firm's tracked usage, so a claimed size would let
 * a sender zero the firm's meter.
 */
async function admitSendAttachments(
  { lawFirmId, senderId, prefix, attachments }:
  { lawFirmId: string; senderId: string; prefix: string; attachments: any },
) {
  const list = Array.isArray(attachments) ? attachments : [];
  const seen = new Set<string>();
  const admitted = [];
  for (const a of list) {
    const objectPath = a && typeof a.objectPath === 'string' ? a.objectPath : '';
    if (!objectPath.startsWith(prefix) || !objectPath.slice(prefix.length)
      || objectPath.slice(prefix.length).includes('/')) {
      throw new ForbiddenError('Invalid attachment path');
    }
    if (seen.has(objectPath)) throw new ForbiddenError('That attachment has already been sent');
    seen.add(objectPath);

    // eslint-disable-next-line no-await-in-loop -- at most five, and each refusal ends the send
    const stored = await readFinalizedUpload(objectPath);
    if (!stored || !stored.finalized) {
      throw new ValidationError('That attachment did not finish uploading. Please attach it again.');
    }
    if (stored.uploadedBy !== String(senderId)) {
      throw new ForbiddenError('You can only send attachments you uploaded');
    }
    // eslint-disable-next-line no-await-in-loop -- as above
    if (await msgRepo.isAttachmentObjectReferenced(lawFirmId, objectPath)) {
      throw new ForbiddenError('That attachment has already been sent');
    }

    admitted.push({
      ...(a.id !== undefined ? { id: a.id } : {}),
      ...(a.url !== undefined ? { url: a.url } : {}),
      name: stored.originalName || a.name,
      objectPath,
      mimeType: stored.contentType,
      size: stored.size,
    });
  }
  return admitted;
}

/**
 * Delete attachments the caller uploaded and never sent, and give their bytes
 * back to the firm's tracked usage.
 *
 * Finalize charges an attachment the moment it lands, and a message attachment
 * has no file row, so an upload removed from the composer before sending would
 * otherwise sit in storage, counted against the quota, with nothing able to
 * reach it. The object is the only record, so each path is deleted only when
 * storage and the database together prove it is this caller's unsent upload:
 *
 *   - it sits directly under `prefix`, the folder the caller may upload to for
 *     this conversation (resolved by the route from the caller's access);
 *   - it carries the finalize stamp, so its bytes were charged. A session that
 *     never finalized is held by a reservation instead, which cancel releases;
 *   - storage records THIS caller as its uploader. A direct thread's folder is
 *     written by both the firm and the client, and every read exposes the path;
 *   - no message names it. A sent attachment is the record of what was sent.
 *
 * A path that fails any of these is skipped, not refused, so the answer is the
 * same whether the object was never the caller's or was already discarded, and
 * a repeat is harmless. What is subtracted is the size storage reports, and the
 * delete is pinned to the generation that size was read from, so concurrent
 * discards of one object subtract it once.
 */
export async function discardUnsentAttachments(
  { lawFirmId, userId, prefix, objectPaths }:
  { lawFirmId: string; userId: string; prefix: string; objectPaths: unknown },
) {
  const paths = [...new Set((Array.isArray(objectPaths) ? objectPaths : [])
    .filter((p): p is string => typeof p === 'string' && p.length > 0))];

  let discarded = 0;
  let freedBytes = 0;
  for (const objectPath of paths) {
    const name = objectPath.startsWith(prefix) ? objectPath.slice(prefix.length) : '';
    if (!name || name.includes('/')) continue;
    // eslint-disable-next-line no-await-in-loop -- at most five, each a single metadata read
    const stored = await readFinalizedUpload(objectPath);
    if (!stored || !stored.finalized || stored.uploadedBy !== String(userId)) continue;
    // eslint-disable-next-line no-await-in-loop -- as above
    if (await msgRepo.isAttachmentObjectReferenced(lawFirmId, objectPath)) continue;
    // eslint-disable-next-line no-await-in-loop -- as above
    const freed = await deleteAttachmentObjects([{ objectPath }]);
    if (freed > 0) {
      discarded += 1;
      freedBytes += freed;
    }
  }

  if (freedBytes > 0) {
    await adjustStorageUsageByDelta(lawFirmId, -freedBytes)
      .catch((err: any) => console.error('messaging: discard usage decrement failed:', err.message));
  }
  return { discarded };
}

/**
 * Send a message. Lazily creates a conversation if none exists.
 */
export async function sendMessage({ lawFirmId, userId, body }: any) {
  const { clientId, content = '', matterId, attachments = [], mentions = [] } = body;

  const senderData = await msgRepo.getUser(userId);
  const senderType = senderData.userType === 'client' ? 'client' : 'firm_member';
  const senderName = senderData.name || 'Unknown';

  if (senderType === 'client') {
    if (userId !== clientId) throw new ForbiddenError('Client can only send messages as themselves');
    await msgRepo.verifyClientAccess(lawFirmId, clientId);
  } else {
    await assertLawFirmMembership(lawFirmId, userId);
    // A firm member may only open/append a conversation for a client that belongs
    // to this firm. Without this the request-body clientId is trusted, letting a
    // member inject a conversation, message, and notification email into an
    // unrelated firm's client portal.
    await msgRepo.verifyClientAccess(lawFirmId, clientId);
    // Only associate a matter that actually belongs to this firm, mirroring the
    // portal path's matter-access check. A cross-tenant matterId is rejected
    // rather than silently stored against the message.
    if (isUuid(matterId)) await msgRepo.assertMatterInFirm(lawFirmId, matterId);
  }

  // Attachment objectPaths are caller-supplied and the read path signs a fresh
  // download URL for whatever is stored, so an unvalidated path is an arbitrary
  // object read (all firms share one GCS bucket). Scope every attachment to THIS
  // conversation's folder, where the upload endpoint writes
  // (lawfirmids/{firm}/messaging/{firm}_{clientId}/...). A firm-level-only prefix
  // would let a caller attach another of the firm's clients' objects to their own
  // message; the conversation folder is the tenant + participant boundary.
  // `admitSendAttachments` adds the rest: finalized, this sender's, unsent.
  const admittedAttachments = await admitSendAttachments({
    lawFirmId,
    senderId: userId,
    prefix: `lawfirmids/${lawFirmId}/messaging/${lawFirmId}_${clientId}/`,
    attachments,
  });

  // @mentions must resolve to firm members; drop anything else so a caller can't
  // create notification rows for arbitrary uids (or store bogus mention ids).
  const validMentions = (Array.isArray(mentions) && mentions.length)
    ? await msgRepo.filterFirmMemberIds(lawFirmId, mentions)
    : [];

  const clientData = await msgRepo.getUser(clientId);

  // "Send as firm": snapshot the sender's preference so the client sees the firm
  // (name + logo) instead of the individual. Firm members always see the real sender.
  const sentAsFirm = senderType === 'firm_member'
    ? await msgRepo.getMemberPresentAsFirm(lawFirmId, userId)
    : false;

  const result = await msgRepo.sendMessage(lawFirmId, {
    senderId: userId, senderType, senderName, sentAsFirm,
    clientId, clientData, content, attachments: admittedAttachments, matterId, mentions: validMentions,
  });

  const preview = content.trim().substring(0, 100);

  if (senderType === 'firm_member') {
    _maybeNotifyClient({ lawFirmId, clientId, result, senderName, sentAsFirm, preview }).catch((err) =>
      console.error('[messaging] Notification email error:', err)
    );
  }

  // In-app notification fan-out. Firm-side message notifications only fire for
  // inbound (client → firm) messages. The in-app bell is firm-member-facing, so
  // firm → client is covered by the client email above. @mentions are notified
  // separately (any direction) by the MESSAGE_SENT listener.
  let messageRecipients = [];
  if (senderType === 'client') {
    messageRecipients = await msgRepo.getFirmRecipientsForMessage(lawFirmId, result.conversationId, userId);
  }
  eventBus.emit(MESSAGE_SENT, {
    lawFirmId,
    conversationId: result.conversationId,
    // Lets notification listeners build a link that opens the thread; the
    // messages route needs ?type=group for group conversations.
    conversationType: 'direct',
    messageId: result.messageId,
    senderId: userId,
    senderType,
    senderName,
    clientName: result.clientName || clientData.name || '',
    matterId: matterId || null,
    mentions: validMentions,
    messageRecipients,
    preview,
  });

  return {
    message: 'Message sent successfully',
    messageId: result.messageId,
    conversationId: result.conversationId,
  };
}

/**
 * Email the client about a new message, honouring a 1-hour per-conversation cooldown.
 *
 * The cooldown is CLAIMED in one conditional update (`claimNotificationEmailSlot`),
 * the same as the group path, so two messages landing together cannot both see
 * an expired stamp and mail the client twice. A member who presents as the firm
 * is named as the firm, matching what the client sees in the thread.
 */
async function _maybeNotifyClient({ lawFirmId, clientId, result, senderName, sentAsFirm, preview }: any) {
  if (!result.clientEmail) return;

  // The portal's "Email me on new messages" toggle. `clientId` here is the
  // client's portal uid (the same id the conversation and its attachment folder
  // are keyed on), not their `clients` row id.
  const allowed = await shouldSendClientEmail({
    lawFirmId,
    clientUserId: clientId,
    category: EMAIL_CATEGORIES.MESSAGE,
  });
  if (!allowed) return;

  if (!(await msgRepo.claimNotificationEmailSlot(result.conversationId, NOTIFICATION_COOLDOWN_MS))) return;

  await sendNewMessageNotificationEmail({
    recipientEmail: result.clientEmail,
    recipientName: result.clientName,
    lawFirmName: result.lawFirmName,
    senderName: sentAsFirm ? (result.lawFirmName || 'Your legal team') : senderName,
    messagePreview: preview,
    portalUrl: `${FRONTEND_URL}/client/messages`,
  });
}

// Paging, search and the archive split are all optional: a request that supplies
// none of them returns every direct conversation in the firm, which is what the
// callers that pick one thread out of the whole set depend on. `totalItems` counts
// every match, so a windowed caller can label a partial list with a real total.
export async function listFirmConversations({
  lawFirmId, limit, offset, page, search, archived, clientId, clientIds,
}: any) {
  const { conversations, totalItems } = await msgRepo.getConversationsByLawFirm(lawFirmId, {
    limit, offset, page, search, archived, clientId, clientIds,
  });
  const photoMap = await resolvePhotoUrls(conversations.map((c: any) => c.clientId));
  conversations.forEach((c: any) => { c.clientPhotoUrl = photoMap[c.clientId] || null; });
  return { conversations, totalItems };
}

export async function listClientConversations({ userId }: any) {
  const conversations = await msgRepo.getConversationsByClient(userId);
  return { conversations };
}

export async function getConversation({ conversationId, userId, query, lawFirmId }: any) {
  const userData = await msgRepo.getUser(userId);
  const userType = userData.userType || 'firm_member';

  await msgRepo.verifyConversationAccess(conversationId, userId, userType, lawFirmId);
  const conv = await msgRepo.getConversation(conversationId);

  const { messages, hasMore } = await msgRepo.getMessages(conversationId, {
    limit: query.limit,
    lastMessageId: query.lastMessageId,
  });

  // Re-sign attachment URLs on read. Stored signed URLs expire (GCS 7-day max),
  // so persisted links break; regenerate fresh short-lived ones from objectPath.
  await Promise.all(messages.map(async (m: any) => {
    if (m.attachments && m.attachments.length) m.attachments = await resignAttachments(m.attachments);
  }));

  const photoMap = await resolvePhotoUrls(messages.map((m: any) => m.senderId));
  messages.forEach((m: any) => { m.senderPhotoUrl = photoMap[m.senderId] || null; });

  // Synthesize the thread's participant roster (client + the firm members who've
  // messaged + the current viewer) so the firm-side header can offer the same
  // "participants / add people" affordance a group has. Firm members only — a
  // client viewer reaches direct threads through the portal path, and must not be
  // handed a roster of the individual lawyers on the thread.
  let participants = [];
  if (userType !== 'client') {
    participants = await msgRepo.getDirectConversationParticipants(conversationId, conv.clientId, userId);
    await Promise.all(participants.map(async (p: any) => {
      p.photoUrl = await signUserPhotoUrl(p.photoObjectPath);
      delete p.photoObjectPath;
    }));
  }

  return { conversation: conv, participants, messages, hasMore };
}

export async function markRead({ userId, body, lawFirmId }: any) {
  const { conversationId, messageIds } = body;

  const userData = await msgRepo.getUser(userId);
  const userType = userData.userType || 'firm_member';

  await msgRepo.verifyConversationAccess(conversationId, userId, userType, lawFirmId);
  const markedCount = await msgRepo.markRead(conversationId, userType, messageIds);

  // The client sees the firm's read receipts on their own messages. Marking
  // touches only message rows, which a client may not stream, so ping their
  // thread to re-read. A client's own read needs no ping: firm members stream
  // the message rows and see it there.
  if (markedCount > 0 && userType !== 'client') {
    broadcastConversationEvent(conversationId, { conversationId }).catch(() => {});
  }

  // Reading a thread dismisses its unread bell notifications for this viewer.
  // Only firm members receive message/mention notifications (the bell is firm-
  // facing; only firm members can be @mentioned), so clients need no clearing.
  if (userType !== 'client') {
    eventBus.emit(MESSAGES_READ, { lawFirmId, userId, conversationId });
  }

  return { message: 'Messages marked as read', markedCount };
}

export async function getFirmUnreadCount({ lawFirmId, userId }: any) {
  const direct = await msgRepo.getFirmUnreadCount(lawFirmId);
  // Archived threads are hidden from the firm's inbox, so they must not inflate
  // the firm unread badge either.
  const group = userId ? await msgRepo.getGroupUnreadForUser(userId, { excludeArchived: true, lawFirmId }) : 0;
  return { count: direct + group };
}

export async function getClientUnreadCount({ userId }: any) {
  const direct = await msgRepo.getClientUnreadCount(userId);
  // Archiving is firm-side only; a client's badge counts all their threads.
  const group = await msgRepo.getGroupUnreadForUser(userId);
  return { count: direct + group };
}

// Managing an existing conversation (its participants, matter scope, privacy, or
// archive state) requires the same access as reading it: group threads are
// participant-gated for EVERYONE (firm members included), direct threads are
// firm-wide. This is the real boundary — the routes only require messaging.send,
// which is a firm-wide baseline permission every member holds and does NOT gate by
// conversation, so without this a non-participant member could add themselves to (or
// tamper with) any group in the firm.
async function assertConversationManageAccess(conversationId: string, userId: string, lawFirmId: string) {
  await msgRepo.verifyConversationAccess(conversationId, userId, 'firm_member', lawFirmId);
}

// Firm-side archive/unarchive of a conversation (direct or group). Any firm member
// with access to the conversation can archive; the client portal is unaffected.
// Returns the resulting archived state.
export async function setConversationArchived({ lawFirmId, userId, conversationId, archived }: any) {
  await assertConversationManageAccess(conversationId, userId, lawFirmId);
  const id = await msgRepo.setConversationArchived(conversationId, lawFirmId, !!archived, userId);
  if (!id) throw new NotFoundError('Conversation');
  return { message: archived ? 'Conversation archived' : 'Conversation unarchived', archived: !!archived };
}

// ── Message edit + soft delete ──────────────────────────────────────────

/**
 * Edit a message's content. Sender-only (works for firm members and clients).
 * Rejects editing a deleted message and enforces the same non-empty-or-attachment
 * rule as sending. Every thread fires the content-free broadcast ping, so a client
 * (who may not stream the raw row in either kind of thread) re-fetches the masked
 * version. Firm members on a direct thread also get the postgres_changes UPDATE
 * the row update emits.
 *
 * `lawFirmId` is passed on the firm-scoped route so conversation access is checked
 * against the path firm; it's null on the client route (access keyed on ownership).
 */
export async function editMessage({ messageId, userId, content = '', lawFirmId = null, isClient = false }: any) {
  const row = await msgRepo.loadMessageWithConversation(messageId);
  if (!row) throw new NotFoundError('Message');

  const userType = isClient ? 'client' : 'firm_member';
  await msgRepo.verifyConversationAccess(row.conversation_id, userId, userType, lawFirmId);

  if (row.sender_user_id !== userId) {
    throw new ForbiddenError('You can only edit your own messages');
  }
  if (row.deleted_at != null) {
    throw new ValidationError('This message has been deleted and cannot be edited');
  }
  const createdMs = row.created_at ? new Date(row.created_at).getTime() : null;
  if (createdMs != null && Date.now() - createdMs > MESSAGE_MODIFY_WINDOW_MS) {
    throw new ValidationError('Messages can only be edited within 30 minutes of sending');
  }

  const trimmed = (content || '').trim();
  const hasAttachments = Array.isArray(row.attachments) && row.attachments.length > 0;
  if (!trimmed && !hasAttachments) {
    throw new ValidationError('Message content or at least one attachment is required');
  }

  const editedAt = await msgRepo.editMessage(row.conversation_id, messageId, userId, trimmed);
  if (!editedAt) throw new NotFoundError('Message');

  broadcastConversationEvent(row.conversation_id, { conversationId: row.conversation_id, messageId })
    .catch(() => {});

  return { message: 'Message updated successfully', messageId, editedAt };
}

/**
 * Soft-delete a message. Sender-only (firm members and clients). The row is
 * retained (legal record); every read path masks its content and strips
 * attachments. Idempotent: deleting an already-deleted message succeeds without a
 * second broadcast. Realtime mirrors editMessage: the broadcast ping on every
 * thread, plus postgres_changes for firm members on a direct one.
 */
export async function deleteMessage({ messageId, userId, lawFirmId = null, isClient = false }: any) {
  const row = await msgRepo.loadMessageWithConversation(messageId);
  if (!row) throw new NotFoundError('Message');

  const userType = isClient ? 'client' : 'firm_member';
  await msgRepo.verifyConversationAccess(row.conversation_id, userId, userType, lawFirmId);

  if (row.sender_user_id !== userId) {
    throw new ForbiddenError('You can only delete your own messages');
  }
  if (row.deleted_at != null) {
    return { message: 'Message deleted successfully', messageId };
  }
  const createdMs = row.created_at ? new Date(row.created_at).getTime() : null;
  if (createdMs != null && Date.now() - createdMs > MESSAGE_MODIFY_WINDOW_MS) {
    throw new ValidationError('Messages can only be deleted within 30 minutes of sending');
  }

  const deletedAt = await msgRepo.softDeleteMessage(row.conversation_id, messageId, userId);
  if (!deletedAt) throw new NotFoundError('Message');

  // The row survives as the record, but its attachments do not: every read path
  // already strips them, so leaving the objects in storage would keep bytes that
  // nobody can see and nobody can remove, still billed against the firm's quota.
  // Message attachments are not listed in the file browser, so this delete is the
  // only way those bytes are ever reclaimed. An object another live message
  // still names stays, and what is subtracted is the size storage reports.
  const freedBytes = await deleteAttachmentObjects(row.attachments, {
    mayDelete: async (objectPath: string) => !(await msgRepo.isAttachmentObjectReferencedElsewhere(
      row.law_firm_id, objectPath, messageId,
    )),
  });
  if (freedBytes > 0) {
    await adjustStorageUsageByDelta(row.law_firm_id, -freedBytes)
      .catch((err: any) => console.error('messaging: usage decrement failed:', err.message));
  }

  broadcastConversationEvent(row.conversation_id, { conversationId: row.conversation_id, messageId })
    .catch(() => {});

  return { message: 'Message deleted successfully', messageId };
}

// ── Message search ──────────────────────────────────────────────────────

const SEARCH_RESULT_CAP = 50;

// Build a short, single-line snippet centered on the first match of `q` so a
// result row previews the hit in context without dumping the whole message.
function buildSnippet(content: any, q: any, radius = 60) {
  const text = (content || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}...` : text;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + q.length + radius);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = `...${snippet}`;
  if (end < text.length) snippet = `${snippet}...`;
  return snippet;
}

// Shape a repository search row into the API result, applying the SAME sender-
// identity masking used on normal reads so search can't leak a co-client's real
// name to a masked client viewer, nor a "send as firm" member's individual name.
// Masking only applies to client viewers (firm members see real identities).
function shapeSearchResult(r: any, viewerUserId: any, viewerIsClient: any, q: any) {
  let senderName = r.senderName;
  if (viewerIsClient) {
    if (r.sentAsFirm && r.senderType === 'firm_member') {
      senderName = r.lawFirmName || 'Law Firm';
    } else if (
      r.conversationType === 'group' && r.hideClientNames
      && r.senderType === 'client' && r.senderId !== viewerUserId
    ) {
      senderName = 'Client';
    }
  }

  let conversationTitle;
  if (r.conversationType === 'group') {
    conversationTitle = r.title || 'Group conversation';
  } else {
    conversationTitle = viewerIsClient
      ? (r.lawFirmName || 'Law Firm')
      : (r.clientName || 'Client');
  }

  return {
    conversationId: r.conversationId,
    conversationType: r.conversationType,
    conversationTitle,
    lawFirmId: r.lawFirmId,
    messageId: r.messageId,
    snippet: buildSnippet(r.content, q),
    senderName,
    createdAt: r.createdAt,
  };
}

/**
 * Firm-side message search. Requires messaging.view (enforced on the route).
 * Searches content across the firm's direct threads plus the caller's group
 * threads, excluding soft-deleted messages, and returns masked snippet results.
 */
export async function searchFirmMessages({ lawFirmId, userId, q }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const term = (q || '').trim();
  if (term.length < 2) return { results: [], totalItems: 0 };
  const rows = await msgRepo.searchFirmMessages(lawFirmId, userId, term, SEARCH_RESULT_CAP);
  const results = rows.map((r: any) => shapeSearchResult(r, userId, false, term));
  return { results, totalItems: results.length };
}

/**
 * Client-side message search. Scope is strictly the conversations the client
 * participates in. Applies the same masking as their normal reads.
 */
export async function searchClientMessages({ userId, q }: any) {
  const term = (q || '').trim();
  if (term.length < 2) return { results: [], totalItems: 0 };
  const rows = await msgRepo.searchClientMessages(userId, term, SEARCH_RESULT_CAP);
  const results = rows.map((r: any) => shapeSearchResult(r, userId, true, term));
  return { results, totalItems: results.length };
}

// ── Group conversations (Option B) ──────────────────────────────────────

export async function createGroupConversation({
  lawFirmId, userId, title, matterIds, memberIds = [], clientIds = [], clientRecordIds = [], organizationClientIds = [],
}: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  // Same "bringing a CLIENT in is a different act" split addGroupParticipants
  // enforces: creating a brand-new group with a client attached reaches the
  // identical outcome (a client seated on a firm thread) as adding one to an
  // existing group, so it needs the same permission on top of the
  // `messaging.send` baseline the route already requires. Checked here rather
  // than on the route because a group-members-only creation stays on the
  // baseline.
  const createsWithClients = (clientIds || []).filter(Boolean).length > 0
    || (clientRecordIds || []).filter(Boolean).length > 0
    || (organizationClientIds || []).filter(Boolean).length > 0;
  if (createsWithClients) {
    await assertFirmPermission(lawFirmId, userId, 'messaging.manageParticipants');
  }

  const members = [...new Set(memberIds.filter(Boolean))];

  // "Pick an organization" compose-time convenience (organization-clients
  // plan Phase 7, Messaging contract's "Ad-hoc group composition"): every
  // person on each picked company client's roster is added
  // alongside any hand-picked individual clientIds (which may themselves be
  // person clients or individual company roster contacts - see
  // verifyClientAccessMany). A firm member can still drop some of an
  // auto-added roster or mix in additional individuals before creating.
  const orgIds = [...new Set((organizationClientIds || []).filter(Boolean))];
  const orgRosterRecords = orgIds.length
    ? (await Promise.all(orgIds.map((id: any) => msgRepo.getCompanyRosterClientRecords(lawFirmId, id)))).flat()
    : [];
  const selectedRecords = await msgRepo.resolveMessagingClientRecords(lawFirmId, clientRecordIds);
  const rosterRecords = [...selectedRecords, ...orgRosterRecords];
  const clients = [...new Set([
    ...clientIds.filter(Boolean),
    ...rosterRecords.map((record: any) => record.user_id).filter(Boolean),
  ])];
  const pendingClientIds = [...new Set(
    rosterRecords.filter((record: any) => !record.user_id).map((record: any) => record.id),
  )];

  // Every client must belong to this firm (person clients.user_id or company
  // roster contact_clients.user_id).
  await msgRepo.verifyClientAccessMany(lawFirmId, clients);
  // Every named firm member must actually be a member.
  const validMembers = await msgRepo.filterFirmMemberIds(lawFirmId, members);

  // A conversation needs at least one other participant besides the creator. It
  // may be firm-members-only (internal), client-only, or a mix — clients are no
  // longer required, so a firm can message colleagues privately.
  if (validMembers.length + clients.length + pendingClientIds.length < 1) {
    throw new ValidationError('Add at least one other person to the conversation');
  }

  // Matter scope is an organizational tag (zero, one, or many matters), not a
  // confidentiality gate. Only require that each scoped matter belongs to the
  // firm. A multi-client group with no matter is allowed (the client confirms it).
  const scopeMatters = [...new Set((Array.isArray(matterIds) ? matterIds : []).filter(Boolean))];
  await msgRepo.assertMattersInFirm(lawFirmId, scopeMatters);

  const participants = [...new Set([userId, ...validMembers]).values()]
    .map((uid) => ({ userId: uid, type: 'firm_member' }))
    .concat(clients.map((cid) => ({ userId: cid, type: 'client' })));

  const conversationId = await msgRepo.createGroupConversation(lawFirmId, {
    title, matterIds: scopeMatters, createdBy: userId, participants, pendingClientIds,
  });
  return { message: 'Group conversation created', conversationId };
}

/**
 * On a firm-scoped route, the group must belong to the path's :lawFirmId, the
 * same rule `verifyConversationAccess` applies through `expectedLawFirmId`. The
 * route's permission check ran against the PATH firm, so without this a member
 * of two firms could read, post into or mark read a group in a firm where they
 * hold no messaging permission by routing through the other. `lawFirmId` is
 * null on the client routes, which are keyed on participation alone.
 */
async function assertGroupInPathFirm(conversationId: string, lawFirmId: string | null) {
  if (!lawFirmId) return;
  const row = await msgRepo.loadConversationAuthRow(conversationId);
  if (!row) throw new NotFoundError('Group conversation');
  if (row.law_firm_id !== lawFirmId) {
    throw new ForbiddenError('Conversation does not belong to this law firm');
  }
}

export async function sendGroupMessage({ conversationId, userId, body, lawFirmId = null }: any) {
  await assertGroupInPathFirm(conversationId, lawFirmId);
  const conv = await msgRepo.loadGroupConversationRow(conversationId);
  if (!conv) throw new NotFoundError('Group conversation');
  if (!(await msgRepo.isActiveParticipant(conversationId, userId))) {
    throw new ForbiddenError('You are not a participant in this conversation');
  }
  const senderData = await msgRepo.getUser(userId);
  const senderType = senderData.userType === 'client' ? 'client' : 'firm_member';
  const senderName = senderData.name || 'Unknown';

  const { content = '', attachments = [], mentions = [] } = body;
  const admittedAttachments = await admitSendAttachments({
    lawFirmId: conv.law_firm_id,
    senderId: userId,
    prefix: `lawfirmids/${conv.law_firm_id}/messaging/group_${conversationId}/`,
    attachments,
  });
  const validMentions = (Array.isArray(mentions) && mentions.length)
    ? await msgRepo.filterFirmMemberIds(conv.law_firm_id, mentions) : [];

  // "Send as firm": snapshot the sender's preference (see sendMessage).
  const sentAsFirm = senderType === 'firm_member'
    ? await msgRepo.getMemberPresentAsFirm(conv.law_firm_id, userId)
    : false;

  const result = await msgRepo.sendGroupMessage(conversationId, {
    lawFirmId: conv.law_firm_id, senderId: userId, senderType, senderName, sentAsFirm,
    content, attachments: admittedAttachments, mentions: validMentions,
  });

  const preview = content.trim().substring(0, 100);

  // A group thread told nobody anything. Only @mentions carried, so an
  // organization's canonical thread -- which for a company client IS the whole
  // channel -- was silent in both directions: the client got no email when the
  // firm wrote, and no bell reached the firm when the client replied. Both
  // halves now mirror what a direct thread already does, on the same rules
  // (inbound messages raise the firm's bell, outbound ones email the client,
  // each recipient's own preferences and the per-conversation cooldown apply).
  if (senderType === 'firm_member') {
    _notifyGroupClients({ conv, conversationId, userId, senderName, sentAsFirm, preview })
      .catch((err) => console.error('[messaging] Group notification email error:', err));
  }

  const messageRecipients = senderType === 'client'
    ? await msgRepo.getGroupFirmRecipients(conversationId, userId)
    : [];

  eventBus.emit(MESSAGE_SENT, {
    lawFirmId: conv.law_firm_id, conversationId, conversationType: 'group',
    messageId: result.messageId,
    senderId: userId, senderType, senderName, mentions: validMentions,
    matterId: conv.matter_id || null, messageRecipients, preview,
  });

  // Tell client participants to re-fetch (they can't stream the message row --
  // it carries a plaintext sender_name a masked co-client must not see). Fire-
  // and-forget with a content-free payload; never blocks or fails the send.
  broadcastConversationEvent(conversationId, { conversationId, messageId: result.messageId })
    .catch(() => {});

  return { message: 'Message sent successfully', messageId: result.messageId, conversationId };
}

/**
 * Email a group thread's client participants about a firm member's message.
 *
 * The group counterpart of `_maybeNotifyClient`, sharing its 1-hour
 * per-conversation cooldown so a burst of messages is one email. The cooldown is
 * CLAIMED in a single update before anything is sent, so two concurrent sends
 * cannot both pass the check and mail the thread twice.
 *
 * The sender is named as the firm when they marked the message "send as firm",
 * matching what those recipients see in the thread itself -- an email must not
 * be the thing that reveals the individual behind the firm's identity.
 */
async function _notifyGroupClients({ conv, conversationId, userId, senderName, sentAsFirm, preview }: any) {
  const lawFirmId = conv.law_firm_id;
  const recipients = await msgRepo.getGroupClientRecipients(lawFirmId, conversationId, userId);
  if (!recipients.length) return;

  const allowed = [];
  for (const recipient of recipients) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await shouldSendClientEmail({
      lawFirmId,
      clientUserId: recipient.userId,
      category: EMAIL_CATEGORIES.MESSAGE,
    });
    if (ok) allowed.push(recipient);
  }
  if (!allowed.length) return;

  if (!(await msgRepo.claimNotificationEmailSlot(conversationId, NOTIFICATION_COOLDOWN_MS))) return;

  const lawFirmName = await msgRepo.getLawFirmName(lawFirmId);
  const from = sentAsFirm ? (lawFirmName || 'Your legal team') : senderName;

  await Promise.all(allowed.map((recipient: any) => sendNewMessageNotificationEmail({
    recipientEmail: recipient.email,
    recipientName: recipient.name,
    lawFirmName,
    senderName: from,
    messagePreview: preview,
    portalUrl: `${FRONTEND_URL}/client/messages`,
  }).catch((err: any) => console.error('[messaging] Group notification email failed:', err?.message || err))));
}

export async function getGroupConversation({ conversationId, userId, query, lawFirmId = null }: any) {
  await assertGroupInPathFirm(conversationId, lawFirmId);
  if (!(await msgRepo.isActiveParticipant(conversationId, userId))) {
    throw new ForbiddenError('Access denied to conversation');
  }
  const conv = await msgRepo.loadGroupConversationRow(conversationId);
  if (!conv) throw new NotFoundError('Group conversation');
  const matters = await msgRepo.getConversationMatters(conversationId);
  const matterIds = matters.map((m: any) => m.id);
  const participants = await msgRepo.getParticipants(conversationId);
  await Promise.all(participants.map(async (p: any) => {
    p.photoUrl = await signUserPhotoUrl(p.photoObjectPath); delete p.photoObjectPath;
  }));
  const viewer = await msgRepo.getUser(userId);
  const viewerIsClient = viewer.userType === 'client';

  // A client added with "hide previous chats" carries a history cutoff; bound
  // their message page at it so pre-join messages are never returned. Firm
  // members (and full-history clients) have a null cutoff and see everything.
  // `clientVisibleOnly` drops the firm-member participant-change events a client
  // may not see, in the same query, so the page is a full page of things this
  // viewer can actually see and `hasMore` and the cursor stay usable.
  const viewerHistoryFrom = participants.find((p: any) => p.userId === userId)?.historyVisibleFrom || null;
  const { messages, hasMore } = await msgRepo.getMessages(conversationId, {
    limit: query.limit, lastMessageId: query.lastMessageId, visibleFrom: viewerHistoryFrom,
    clientVisibleOnly: viewerIsClient,
  });
  // Group read state lives in the viewer's conversation_participants.last_read_at
  // cursor, not the per-message read columns (those only serve direct threads and
  // stay false on group rows). Derive a per-viewer `read` flag from the cursor so
  // the UI's unread markers (the "New" divider) reflect what THIS viewer has seen,
  // instead of treating every group message as permanently unread.
  const viewerCursor = participants.find((p: any) => p.userId === userId)?.lastReadAt;
  const viewerLastReadMs = viewerCursor ? new Date(viewerCursor).getTime() : 0;
  messages.forEach((m: any) => {
    m.read = m.senderId === userId
      || (m.createdAt != null && new Date(m.createdAt).getTime() <= viewerLastReadMs);
  });

  await Promise.all(messages.map(async (m: any) => {
    if (m.attachments && m.attachments.length) m.attachments = await resignAttachments(m.attachments);
  }));
  const photoMap = await resolvePhotoUrls(messages.map((m: any) => m.senderId));
  messages.forEach((m: any) => { m.senderPhotoUrl = photoMap[m.senderId] || null; });

  // Client-name privacy: when the firm enables it and the viewer is a client,
  // redact OTHER clients' identities (name/email/avatar) from the REST payload,
  // so this API never hands a client a co-client's real name. Firm members and
  // the viewer's own identity are untouched. The co-client's `userId` remains in
  // the payload (needed to map senders to bubbles); `users.getUserById` blocks
  // client-to-client profile lookups so that id can't be resolved back to a name.
  // Caveat: the Supabase Realtime `messages` stream is row-level (not column-
  // level), so a live INSERT payload still carries the raw `sender_name` at the
  // transport layer; the frontend re-derives the displayed name from this masked
  // participant list, but a raw-socket inspection is not redacted. See
  // docs/features/messaging.md.
  const maskClientNames = viewerIsClient && conv.hide_client_names === true;
  if (maskClientNames) {
    participants.forEach((p: any) => {
      if (p.type === 'client' && p.userId !== userId) {
        p.name = 'Client'; p.email = ''; p.photoUrl = null;
      }
    });
    messages.forEach((m: any) => {
      if (m.senderType === 'client' && m.senderId !== userId) {
        m.senderName = 'Client'; m.senderPhotoUrl = null;
      }
      // Mask a co-client's name in a participant-change event too. The UI renders
      // from systemEvent, so also rebuild `content` (the stored fallback carries
      // the real name) to keep it out of the payload entirely.
      if (m.kind === 'system' && m.systemEvent?.subjectType === 'client'
          && m.systemEvent.subjectUserId !== userId) {
        const verb = m.systemEvent.action === 'participant_removed' ? 'was removed from' : 'was added to';
        m.systemEvent = { ...m.systemEvent, subjectName: 'Client' };
        m.content = `Client ${verb} the conversation`;
      }
    });
  }

  // "Send as firm": for client viewers, present firm-member messages the sender
  // marked as sent-as-firm under the firm's name + logo (firm members see the
  // real sender).
  if (viewerIsClient) {
    await maskSendAsFirmMessages(messages, conv.law_firm_id);
  }

  // Firm logo for the client roster: clients see the firm as a single entity, so
  // surface the firm's signed logo URL for the collapsed "Law Firm" entry the
  // client-side roster renders. Only needed (and only signed) for client viewers.
  // The firm name is joined at read rather than copied onto the conversation, so
  // a rename shows everywhere at once.
  const firmBranding = await msgRepo.getFirmNameAndLogo(conv.law_firm_id);
  const convLawFirmName = firmBranding.name || '';
  let lawFirmLogoUrl = null;
  if (viewerIsClient) {
    lawFirmLogoUrl = await signUserPhotoUrl(firmBranding.logoObjectPath);
  }

  // The roster a CLIENT is handed. The firm side collapses to one entry, because
  // which individual lawyers sit on a thread is internal - the same reason their
  // add/remove events are filtered out of the page above. Collapsing it here, and
  // not only in the client UI, is the point: the real roster used to travel in
  // this payload with every member's name and email, behind an interface that
  // merely declined to draw them. Read cursors and history cutoffs go too, for
  // everyone but the viewer: nothing client-side reads them, and they tell a
  // client when each lawyer (and each masked co-client) last opened the thread.
  const clientParticipants = viewerIsClient
    ? [
        ...participants
          .filter((p: any) => p.type === 'client')
          .map((p: any) => (p.userId === userId ? p : { ...p, lastReadAt: null, historyVisibleFrom: null })),
        ...(participants.some((p: any) => p.type !== 'client')
          ? [{
              userId: '__firm__',
              type: 'firm_member',
              name: convLawFirmName || 'Law Firm',
              email: '',
              photoUrl: lawFirmLogoUrl,
              lastReadAt: null,
              historyVisibleFrom: null,
            }]
          : []),
      ]
    : participants;

  return {
    conversation: {
      conversationId: conv.id, conversationType: 'group', title: conv.title || '',
      matterId: conv.matter_id || null, matterIds, matters, clientNamesMasked: !!maskClientNames,
      // Raw per-conversation setting, surfaced so firm managers' toggle reflects
      // the real state (clientNamesMasked is only ever true for client viewers).
      hideClientNames: conv.hide_client_names === true,
      // The clients.id this thread is the canonical company conversation for
      // (organization-clients plan Phase 7); null for an ad-hoc group.
      clientRecordId: conv.client_record_id || null,
      lawFirmId: conv.law_firm_id, lawFirmName: convLawFirmName, lawFirmLogoUrl,
      lastMessageAt: conv.last_message_at instanceof Date ? conv.last_message_at.toISOString() : (conv.last_message_at || null),
    },
    participants: clientParticipants, messages, hasMore,
    // Firm-side only: who used to be on this thread, by portal uid and by client
    // record id (the two keys the add-people pickers select on). The picker marks
    // them, so a re-add is a deliberate choice about their history rather than a
    // surprise.
    removedParticipantIds: viewerIsClient ? [] : await msgRepo.getRemovedParticipantIds(conversationId),
    removedClientRecordIds: viewerIsClient
      ? []
      : await msgRepo.getRemovedParticipantClientIds(conv.law_firm_id, conversationId),
    // Firm-side only: people the firm has already added who have no portal
    // account yet, so they are waiting as pending participant placeholders
    // rather than active members. They were invisible until the day they
    // registered and appeared on the thread unannounced.
    pendingClients: viewerIsClient
      ? []
      : await msgRepo.getPendingClientRecipients(conv.law_firm_id, conversationId),
  };
}

/**
 * Take a pending (not yet registered) recipient off a group thread. Same access
 * as managing any other participant, plus the `messaging.manageParticipants`
 * permission the client half of `addGroupParticipants` requires: who outside
 * the firm is on a thread is one decision, whichever direction it moves in.
 */
export async function removePendingGroupClient({ conversationId, userId, lawFirmId, clientRecordId }: any) {
  const conv = await msgRepo.loadConversationBasic(conversationId);
  if (!conv) throw new NotFoundError('Conversation');
  await assertConversationManageAccess(conversationId, userId, lawFirmId);
  await assertFirmPermission(conv.law_firm_id, userId, 'messaging.manageParticipants');

  const removed = await msgRepo.removePendingClientRecipient(conv.law_firm_id, conversationId, clientRecordId);
  if (!removed) throw new NotFoundError('Pending recipient');
  return { message: 'Pending recipient removed' };
}

/**
 * Resolve a COMPANY client's canonical conversation for firm-side viewing
 * (organization-clients plan Phase 7). Finds or creates it, reusing the same
 * find-or-create discipline `findOrCreateCanonicalCompanyConversation` gives
 * a newly portal-enabled linked person, and the same lazy-creation contract
 * `sendMessage` already gives a person client's first direct message, just
 * reached from a GET on a company's Messages tab instead of a POST /send.
 * Creating here (rather than only finding) is what makes that tab usable at
 * all: without it, a company with no portal-enabled linked person yet has no
 * conversation for the tab to show, and a firm member has no way to start
 * one from the client's own page even though the general Messages page's
 * "pick an organization" quick-add can already reach
 * the same company.
 */
export async function getCompanyConversation({ lawFirmId, userId, clientId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  await msgRepo.assertCompanyClientInFirm(lawFirmId, clientId);
  const { conversationId } = await msgRepo.findOrCreateCanonicalCompanyConversation(
    lawFirmId, clientId, { createdBy: userId },
  );
  return { conversationId };
}

export async function markGroupRead({ conversationId, userId, lawFirmId = null }: any) {
  await assertGroupInPathFirm(conversationId, lawFirmId);
  if (!(await msgRepo.isActiveParticipant(conversationId, userId))) {
    throw new ForbiddenError('Access denied to conversation');
  }
  const marked = await msgRepo.markGroupRead(conversationId, userId);

  // Reading a group thread dismisses its unread @mention bell notifications for
  // this viewer (plain group messages don't create bell notifications).
  const conv = await msgRepo.loadGroupConversationRow(conversationId);
  if (conv?.law_firm_id) {
    eventBus.emit(MESSAGES_READ, { lawFirmId: conv.law_firm_id, userId, conversationId });
  }

  return { message: 'Group conversation marked as read', marked };
}

export async function addGroupParticipants({
  conversationId, userId, lawFirmId, memberIds = [], clientIds = [], clientRecordIds = [], organizationClientIds = [], shareHistory,
}: any) {
  // Works for direct threads too: adding anyone to a 1:1 converts it into a group
  // in place (same id + history) first, then adds the new people. Only firm members
  // manage participants, and on a group the caller must already be a participant.
  const conv = await msgRepo.loadConversationBasic(conversationId);
  if (!conv) throw new NotFoundError('Conversation');
  await assertConversationManageAccess(conversationId, userId, lawFirmId);

  // Bringing a colleague onto a thread is ordinary internal staffing, and stays on
  // the `messaging.send` baseline the route already requires. Bringing a CLIENT in
  // is a different act: it hands someone outside the firm a channel into the
  // firm's correspondence, and it cannot be taken back once they have read it. So
  // that half needs a permission that is not part of the baseline. Checked here
  // rather than on the route because one endpoint serves both cases.
  const addsClients = (clientIds || []).filter(Boolean).length > 0
    || (clientRecordIds || []).filter(Boolean).length > 0
    || (organizationClientIds || []).filter(Boolean).length > 0;
  if (addsClients) {
    await assertFirmPermission(conv.law_firm_id, userId, 'messaging.manageParticipants');
  }

  let converted = false;
  if (conv.conversation_type !== 'group') {
    await msgRepo.convertDirectToGroup(conversationId, userId);
    converted = true;
  }

  const validMembers = await msgRepo.filterFirmMemberIds(conv.law_firm_id, memberIds);
  // Same "pick an organization" quick-add as createGroupConversation: expand
  // each picked company to its full person roster.
  const orgIds = [...new Set((organizationClientIds || []).filter(Boolean))];
  const orgRosterRecords = orgIds.length
    ? (await Promise.all(orgIds.map((id: any) => msgRepo.getCompanyRosterClientRecords(conv.law_firm_id, id)))).flat()
    : [];
  const selectedRecords = await msgRepo.resolveMessagingClientRecords(conv.law_firm_id, clientRecordIds);
  const rosterRecords = [...selectedRecords, ...orgRosterRecords];
  const clients = [...new Set([
    ...(clientIds || []).filter(Boolean),
    ...rosterRecords.map((record: any) => record.user_id).filter(Boolean),
  ])];
  const pendingClientIds = [...new Set(
    rosterRecords.filter((record: any) => !record.user_id).map((record: any) => record.id),
  )];
  // Matter scope is organizational, not a membership gate: any firm client may
  // be added regardless of which matters the group is tagged with.
  await msgRepo.verifyClientAccessMany(conv.law_firm_id, clients);

  // Snapshot who is already active so we announce only genuinely-new additions:
  // re-adding an existing participant, or the roster seeded by a direct->group
  // conversion above, must not emit a spurious "was added" event.
  const before = new Set((await msgRepo.getParticipants(conversationId)).map((p: any) => p.userId));

  const toAdd = [
    ...validMembers.map((uid: string) => ({ userId: uid, type: 'firm_member' })),
    ...clients.map((cid) => ({ userId: cid, type: 'client' })),
  ];
  // What the added client(s) may read of what came before.
  //
  // `shareHistory === false` always hides it. An explicit `true` always shares it.
  // The interesting case is an unset flag, where the answer depends on whose words
  // are in the thread: if it already carries messages from a DIFFERENT client,
  // sharing hands one client another client's correspondence, so the default flips
  // to hiding. A thread that is firm-only, or that only holds this same client's
  // messages, keeps the long-standing full-history default. Firm members are
  // unaffected either way. `addParticipants` layers the re-add rule on top of this.
  const otherClientHistory = shareHistory === undefined
    && await msgRepo.hasOtherClientMessages(conversationId, clients);
  const hideHistoryForClients = shareHistory === false || otherClientHistory;
  await msgRepo.addParticipants(conversationId, conv.law_firm_id, userId, toAdd, {
    hideHistoryForClients,
    // Only an explicit tick on THIS add reopens history a re-added client had
    // already been cut off from; see addParticipants.
    shareHistoryExplicit: shareHistory === true,
  });
  if (pendingClientIds.length) {
    await msgRepo.addPendingClientRecipients(conversationId, conv.law_firm_id, userId, pendingClientIds, {
      hideHistoryForClients,
    });
  }

  // Post an inline system event per newly-added participant. The read paths hide
  // firm-member events from client viewers (clients see only client add/remove)
  // and mask co-client names; the content-free ping tells participants to refetch.
  const added = toAdd.filter((p) => !before.has(p.userId));
  const addedNames = await msgRepo.getUserNames(added.map((p: any) => p.userId));
  for (const p of added) {
    await msgRepo.insertGroupSystemEvent(conversationId, conv.law_firm_id, {
      action: 'participant_added',
      subjectUserId: p.userId,
      subjectType: p.type,
      subjectName: addedNames.get(p.userId) || 'Someone',
      actorUserId: userId,
    });
  }
  if (added.length) {
    broadcastConversationEvent(conversationId, { conversationId }).catch(() => {});
  }

  return { message: 'Participants added', conversationType: 'group', converted };
}

export async function removeGroupParticipant({ conversationId, userId, lawFirmId, targetUserId }: any) {
  // Works for direct threads too. On a 1:1 there is no per-person membership to
  // revoke — every firm member has firm-wide access and the single client IS the
  // thread — so removing anyone first converts the thread into a group in place
  // (same id + history), exactly like adding a participant does. Conversion seeds
  // the current roster as real conversation_participants rows; the target is then
  // soft-removed, which is enforceable (RLS gates group access on those rows). On a
  // group the caller must already be a participant.
  const conv = await msgRepo.loadConversationBasic(conversationId);
  if (!conv) throw new NotFoundError('Conversation');
  await assertConversationManageAccess(conversationId, userId, lawFirmId);

  // Removing yourself is a distinct "leave conversation" action, not offered here.
  if (targetUserId === userId) {
    throw new ValidationError('You cannot remove yourself from a conversation.');
  }

  // Only someone actually on the thread can be taken off it. Checked before the
  // conversion and the system event below, so a stray id can neither turn a 1:1
  // into a group nor post "<their real name> was removed" into the thread.
  const onThread = conv.conversation_type === 'group'
    ? await msgRepo.isActiveParticipant(conversationId, targetUserId)
    : await msgRepo.isDirectThreadParticipant(conversationId, targetUserId);
  if (!onThread) throw new NotFoundError('Participant');

  // A client participant is an external recipient. Removing them changes the
  // same boundary as adding them (or removing a pending client), so it needs
  // messaging.manageParticipants rather than the baseline messaging.send used
  // for internal firm-member staffing. Resolve this before conversion so the
  // direct-thread path cannot bypass the check by becoming a group first.
  const target = await msgRepo.getUser(targetUserId).catch(() => null);
  const subjectType = target?.userType === 'client' ? 'client' : 'firm_member';
  if (subjectType === 'client') {
    await assertFirmPermission(conv.law_firm_id, userId, 'messaging.manageParticipants');
  }

  let converted = false;
  if (conv.conversation_type !== 'group') {
    await msgRepo.convertDirectToGroup(conversationId, userId);
    converted = true;
  }

  await msgRepo.removeParticipant(conversationId, targetUserId);

  // Post an inline system event. As with additions, client viewers only ever see
  // client removals (firm-member removals are hidden on read); co-client names are
  // masked. The content-free ping tells the remaining participants to refetch.
  await msgRepo.insertGroupSystemEvent(conversationId, conv.law_firm_id, {
    action: 'participant_removed',
    subjectUserId: targetUserId,
    subjectType,
    subjectName: target?.name || 'Someone',
    actorUserId: userId,
  });
  broadcastConversationEvent(conversationId, { conversationId }).catch(() => {});

  return { message: 'Participant removed', conversationType: 'group', converted };
}

/**
 * Set a group conversation's matter scope (organizational tag; zero, one, or
 * many matters). Firm members manage scope; clients cannot. Each matter must
 * belong to the conversation's firm.
 */
export async function setGroupMatters({ conversationId, userId, lawFirmId, matterIds = [] }: any) {
  const conv = await msgRepo.loadGroupConversationRow(conversationId);
  if (!conv) throw new NotFoundError('Group conversation');
  await assertConversationManageAccess(conversationId, userId, lawFirmId);
  const ids = [...new Set((matterIds || []).filter(Boolean))];
  await msgRepo.assertMattersInFirm(conv.law_firm_id, ids);
  const saved = await msgRepo.setConversationMatters(conversationId, conv.law_firm_id, ids);
  return { message: 'Matter scope updated', matterIds: saved };
}

/**
 * Toggle a group conversation's client-name masking (per-conversation, replaces
 * the old firm-wide setting). Firm members manage it; when on, client viewers of
 * this group see co-clients as "Client".
 */
export async function setGroupPrivacy({ conversationId, userId, lawFirmId, hideClientNames }: any) {
  const conv = await msgRepo.loadGroupConversationRow(conversationId);
  if (!conv) throw new NotFoundError('Group conversation');
  await assertConversationManageAccess(conversationId, userId, lawFirmId);
  await msgRepo.setConversationHideClientNames(conversationId, !!hideClientNames);
  return { message: 'Messaging privacy updated', hideClientNames: !!hideClientNames };
}

/** Read the caller's "present as firm to clients" preference for this firm. */
export async function getPresentAsFirm({ lawFirmId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  return { presentAsFirm: await msgRepo.getMemberPresentAsFirm(lawFirmId, userId) };
}

/** Set the caller's "present as firm to clients" preference for this firm. */
export async function setPresentAsFirm({ lawFirmId, userId, presentAsFirm }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  await msgRepo.setMemberPresentAsFirm(lawFirmId, userId, !!presentAsFirm);
  return { message: 'Preference updated', presentAsFirm: !!presentAsFirm };
}

// Derive the comma-list label source for a group row: the other participants'
// names (the viewer is dropped so the row reads as "who else is in here"). For a
// client viewer the firm side is collapsed to a single firm-name entry so the row
// never enumerates the individual lawyers on the thread, and co-clients are masked
// to "Client" when the firm enabled that privacy setting (mirrors the roster shown
// in the app). The raw `participants` array is dropped from the payload afterwards.
function attachParticipantNames(conversations: any, userId: string, viewerIsClient: any) {
  return conversations.map((c: any) => {
    const others = (c.participants || []).filter((p: any) => p.userId !== userId);
    const firmName = c.lawFirmName || 'Law Firm';
    const maskClients = viewerIsClient && c.hideClientNames === true;
    const participantNames = [];
    let firmAdded = false;
    for (const p of others) {
      if (viewerIsClient && p.type === 'firm_member') {
        if (!firmAdded) { participantNames.push(firmName); firmAdded = true; }
        continue;
      }
      participantNames.push(maskClients && p.type === 'client' ? 'Client' : p.name);
    }
    const { participants, ...rest } = c;
    return { ...rest, participantNames };
  });
}

export async function listGroupConversations({ userId }: any) {
  const viewer = await msgRepo.getUser(userId);
  const { conversations: all } = await msgRepo.getGroupConversationsForUser(userId);
  return { conversations: attachParticipantNames(all, userId, viewer.userType === 'client') };
}

// Firm-side list: the caller's group threads scoped to the path firm (a member
// only sees groups they actually participate in, not every group in the firm).
// Paging, search and the archive split are optional and mirror the direct list; a
// request supplying none of them returns every group thread the caller is in.
export async function listFirmGroupConversations({
  lawFirmId, userId, limit, offset, page, search, archived, clientId, matterId,
}: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const { conversations: scoped, totalItems } = await msgRepo.getGroupConversationsForUser(userId, {
    lawFirmId, limit, offset, page, search, archived, clientId, matterId,
  });
  // Firm members always see real names (client-name masking only applies to
  // client viewers), so no masking is needed here.
  const named = attachParticipantNames(scoped, userId, false);
  // Also surface the client participant ids (firm-side only) so a client-scoped
  // view — e.g. a client's Messages tab — can pick out which groups a given
  // client is in. attachParticipantNames strips the raw participants, so read
  // them off `scoped` by index before they're gone.
  return {
    conversations: named.map((c: any, i: any) => ({
      ...c,
      clientParticipantIds: (scoped[i].participants || [])
        .filter((p: any) => p.type === 'client')
        .map((p: any) => p.userId),
    })),
    totalItems,
  };
}

/**
 * One page of the firm's whole inbox — direct threads plus the caller's group
 * threads, interleaved by recency and paged in SQL. The two row shapes are shaped
 * exactly as their split-list counterparts (direct rows carry a client photo,
 * group rows carry participant names), so the list renders both from one read.
 */
export async function listFirmInbox({ lawFirmId, userId, limit, offset, page, search, archived }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const { conversations, totalItems } = await msgRepo.getFirmInboxPage(lawFirmId, userId, {
    limit, offset, page, search, archived,
  });

  const direct = conversations.filter((c: any) => c.conversationType !== 'group');
  const photoMap = await resolvePhotoUrls(direct.map((c: any) => c.clientId));
  direct.forEach((c: any) => { c.clientPhotoUrl = photoMap[c.clientId] || null; });

  // Firm members always see real names; client-name masking only applies to
  // client viewers. attachParticipantNames strips the raw roster from the row.
  const named = new Map(
    attachParticipantNames(conversations.filter((c: any) => c.conversationType === 'group'), userId, false)
      .map((c: any) => [c.conversationId, c])
  );

  return {
    conversations: conversations.map((c: any) => named.get(c.conversationId) || c),
    totalItems,
  };
}
