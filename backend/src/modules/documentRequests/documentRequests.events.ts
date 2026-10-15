const eventBus = require('../../shared/events/eventBus');
const {
  DOCUMENT_REQUEST_CREATED,
  DOCUMENT_UPLOADED_BY_CLIENT,
  CLIENT_DELETED,
} = require('../../shared/events/eventTypes');
const notificationsRepo = require('../notifications/notifications.repository');
const { createNotifications } = require('../notifications/notifications.service');
const requestsRepo = require('./documentRequests.repository');
const { sendEmail, escapeHtml } = require('../../shared/services/emailService');
const { shouldSendClientEmail, EMAIL_CATEGORIES } = require('../../shared/services/emailPreferences');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');
const { lawFirms } = require('../../shared/database/drizzle/schema');
import { firmQuery } from '../../shared/database/queryContext';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

async function getFirmName(lawFirmId: string) {
  try {
    const rows = await firmQuery(lawFirms, lawFirmId, ({ executor, scope }) => executor
      .select({ name: lawFirms.name }).from(lawFirms).where(scope).limit(1));
    return rows[0]?.name || 'Your law firm';
  } catch (_) {
    return 'Your law firm';
  }
}

/**
 * Remove a deleted client's document requests.
 *
 * Since migration 0225 `document_requests.client_id` is a composite foreign key
 * to `clients` with `on delete cascade`, so the database removes the requests
 * the moment the client row goes. Before that the column had no key and this
 * listener was the only cleanup, leaving checklists addressed to someone the
 * firm no longer had whenever it failed. It stays as the backstop for a client
 * removed by a path that emits the event without deleting the row, and it is
 * idempotent: with the rows already gone it deletes nothing.
 */
eventBus.on(CLIENT_DELETED, async ({ lawFirmId, clientId }: any) => {
  try {
    await requestsRepo.deleteByClientId(lawFirmId, clientId);
  } catch (err: any) {
    console.error('documentRequests.events CLIENT_DELETED failed:', err.message);
  }
});

/**
 * Notify one document-request recipient: an in-app bell (always, since they
 * are a registered portal client) plus a best-effort email. Shared by both
 * the person target and each of a company's eligible roster contacts
 * (organization-clients plan Phase 7), so the two fan out identically.
 */
async function notifyDocumentRequestRecipient({
  lawFirmId, matterId, clientUserId, clientEmail, clientName, clientRecordId, firm, title, itemCount, createdBy,
}: any) {
  const countLabel = itemCount === 1 ? '1 document' : `${itemCount} documents`;
  const notifTitle = `${firm} requested documents from you`;
  const notifBody = itemCount > 0 ? `"${title}" - ${countLabel} needed` : `"${title}"`;
  // Carries the client record into the deep link (organization-clients plan
  // Phase 8), matching the pattern trust.events.ts already established: a
  // company roster contact can hold several client associations, so the
  // portal needs to land them on the right one without guessing.
  const actionUrl = clientRecordId
    ? `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/documents?clientRecordId=${clientRecordId}`
    : `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/documents`;

  try {
    await notificationsRepo.create(lawFirmId, clientUserId, {
      type: 'document_requested',
      title: notifTitle,
      body: notifBody,
      entityType: 'matter',
      entityId: matterId || null,
      matterId: matterId || null,
      actionUrl,
      createdBy: createdBy || null,
    });
  } catch (err: any) {
    console.error('documentRequests.events request-created bell failed:', err.message);
  }

  // Person clients have no per-category toggle for document requests, so this
  // resolves to enabled for them; the call still applies the firm's master
  // switch. A company roster contact's own `documentRequested` preference is
  // checked by the caller before this is invoked (see below).
  const emailAllowed = clientEmail
    ? await shouldSendClientEmail({
      lawFirmId,
      clientUserId,
      category: EMAIL_CATEGORIES.DOCUMENT_REQUESTED,
    })
    : false;

  if (emailAllowed) {
    const safeTitle = escapeHtml(title || 'Documents');
    await sendEmail({
      to: clientEmail,
      subject: `${firm} requested documents from you`,
      html: `<p>Hi ${escapeHtml(clientName || 'there')},</p>
             <p><strong>${escapeHtml(firm)}</strong> has requested documents from you: <strong>${safeTitle}</strong>${itemCount > 0 ? ` (${escapeHtml(countLabel)})` : ''}.</p>
             <p>Please sign in to your client portal to upload the requested documents.</p>
             <p><a href="${escapeHtml(actionUrl)}">Open your documents</a></p>`,
      text: `${firm} has requested documents from you: ${title || 'Documents'}${itemCount > 0 ? ` (${countLabel})` : ''}. Sign in to your client portal to upload them: ${actionUrl}`,
    });
  }
}

/**
 * A firm posted a document request. Notify the target (in-app bell always,
 * email best-effort) and deep-link them into the portal Documents view where
 * they fulfill it. A COMPANY target has no single portal uid of its own
 * (Phase 1 invariant) - it fans out to every eligible portal-enabled roster
 * contact instead, honoring each link's own `documentRequested` preference
 * (organization-clients plan Phase 7). Never throws.
 */
eventBus.on(DOCUMENT_REQUEST_CREATED, async (payload: any) => {
  try {
    const {
      lawFirmId, matterId, clientId, clientType, clientUserId, clientEmail, clientName, contactClientId,
      title, itemCount, createdBy,
    } = payload || {};
    const firm = await getFirmName(lawFirmId);

    if (clientType === 'company') {
      // A creation request naming one contact (documentRequests.service.ts
      // already validated it belongs to this client and has portal access)
      // notifies only that contact; otherwise fan out to the whole eligible
      // roster, same as before contactClientId targeting existed.
      const roster = (contactClientId
        ? [await requestsRepo.getRosterContactById(lawFirmId, clientId, contactClientId)].filter(Boolean)
        : await requestsRepo.getCompanyRosterContacts(lawFirmId, clientId))
        .filter((r: any) => r.portalSettings?.notifications?.documentRequested !== false);
      // Three contacts at a time: each one runs an email-preference check and a
      // notification insert, and a large roster must not take the shared pool.
      // Every item catches its own failure, so one contact never blocks the rest.
      await runWithConcurrency(roster.map((r: any) => () => notifyDocumentRequestRecipient({
        lawFirmId, matterId, clientUserId: r.userId, clientEmail: r.isEmailRecipient ? r.email : null, clientName: r.name, clientRecordId: clientId,
        firm, title, itemCount, createdBy,
      }).catch((err: any) => console.error('documentRequests.events company recipient notify failed:', err.message))), 3);
      return;
    }

    // Only registered portal clients (with a user_id) get a bell item.
    if (!clientUserId) return;
    await notifyDocumentRequestRecipient({
      lawFirmId, matterId, clientUserId, clientEmail, clientName, clientRecordId: clientId, firm, title, itemCount, createdBy,
    });
  } catch (err: any) {
    console.error('documentRequests.events DOCUMENT_REQUEST_CREATED failed:', err.message);
  }
});

/**
 * A portal client uploaded file(s) into a matter (free upload or request
 * fulfillment). Notify the matter's firm-side team so they know new client
 * documents arrived. Batched: one notification per upload call. Never throws.
 */
eventBus.on(DOCUMENT_UPLOADED_BY_CLIENT, async (payload: any) => {
  try {
    const { lawFirmId, matterId, clientName, fileCount, requestTitle, eventId } = payload || {};
    if (!matterId) return;
    const recipients = (await requestsRepo.getMatterMemberIds(lawFirmId, matterId)).filter(Boolean);
    if (!recipients.length) return;

    const who = clientName || 'A client';
    const countLabel = fileCount === 1 ? 'a document' : `${fileCount} documents`;
    const title = `${who} uploaded ${countLabel}`;
    const body = requestTitle
      ? `In response to "${requestTitle}"`
      : 'Uploaded to the matter files';
    const actionUrl = `${FRONTEND_URL}/lawfirm/${lawFirmId}/matters/${matterId}?tab=files`;

    await createNotifications(lawFirmId, recipients, {
      category: 'documentUploaded',
      type: 'document_uploaded',
      eventId: eventId ? `document-upload:${eventId}` : undefined,
      title,
      body,
      entityType: 'matter',
      entityId: matterId,
      matterId,
      actionUrl,
      createdBy: null,
    });
  } catch (err: any) {
    console.error('documentRequests.events DOCUMENT_UPLOADED_BY_CLIENT failed:', err.message);
  }
});

// This module only registers listeners; it exports nothing. The empty
// export marks it as a MODULE so its top-level consts are file-scoped
// rather than colliding in the global scope with every other events file.
export {};
