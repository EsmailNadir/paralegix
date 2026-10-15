import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../../../shared/http/handler';
const express = require('express');
const { optionalTimezone } = require('../../../shared/middleware/timezone');
const router = express.Router();

const { verifyToken, requireUserType } = require('../../../shared/middleware/auth');
const {
  heavyReadLimiter,
  uploadLimiter,
  portalMessageSendLimiter,
} = require('../../../shared/middleware/rateLimiters');
const { validate } = require('../../../shared/middleware/validate');
const { AppError, ForbiddenError } = require('../../../shared/errors/AppError');
const { loadFirmPlan, isFirmBillingActive } = require('../../../shared/plans/planEnforcement');
const { isFeatureEnabled } = require('../../../shared/plans/featureCheck');
const {
  portalBillingQuerySchema,
  portalMessagesQuerySchema,
  portalConversationsQuerySchema,
  sendPortalMessageSchema,
  markPortalMessagesReadSchema,
  updatePortalSettingsSchema,
  portalTrustLedgerQuerySchema,
  portalNotificationsQuerySchema,
  portalEventsQuerySchema,
  refreshDocumentUrlSchema,
  refreshAnyDocumentUrlSchema,
  discardPortalAttachmentsSchema,
} = require('./portal.validation');
const portalService = require('./portal.service');
import { cardCompleteSchema, cardConfirmSchema, cardQuoteSchema } from '../../stripe/stripe.validation';
const { CLIENT_SELECTION_REQUIRED_CODE } = require('./clientAssociation.resolver');
import { handler } from '../../../shared/http/handler';

// Read `clientRecordId` the same way `requireActiveClientAssociation`'s default
// reader does: query first (every GET/POST/PUT/DELETE route in this file can
// carry it there), falling back to the body for routes that accept one and
// aren't `.strict()`-validated. The `validate()` middleware merges parsed
// output over the raw `req.query`/`req.body` rather than replacing them (see
// `shared/middleware/validate.ts`), so an undeclared `clientRecordId` survives
// validation untouched on every route below - none of this file's zod schemas
// need to declare it.
function readClientRecordId(req: any): string | undefined {
  return (req.query && req.query.clientRecordId) || (req.body && req.body.clientRecordId) || undefined;
}

// Client-only portal routes.
router.use(verifyToken, requireUserType(['client']));

// Ensure userData always has an email (fallback to Firebase Auth token email)
router.use((req: any, res: any, next: any) => {
  if (req.userData && !req.userData.email && req.user?.email) {
    req.userData.email = req.user.email;
  }
  next();
});

// Per-firm billing gate. A client keeps access to firms that are paid up, but a
// firm whose subscription is inactive (incomplete/past_due/canceled) has its
// portal paused for its clients too — otherwise a non-paying firm keeps getting
// client-collaboration value for free. Only the per-firm `/lawfirm/:lawFirmId/*`
// routes are gated; the aggregate dashboard reads (`/my-lawfirms`,
// `/firm-summaries`, `/unread-count`) stay open and flag locked firms per-firm.
//
// The 402 names the firm's subscription state, so it is only ever answered to a
// client actually associated with that firm, proven via the SAME multi-arm
// resolver every other portal route now uses (person `clients.user_id` OR
// company `contact_clients.user_id`), not just the person arm. A company
// roster-only user (no personal `clients` row of their own) used to fail this
// check and get a flat 403 for every route under a firm they legitimately
// belong to; this is the first thing such a user hits, so it has to prove
// association across both arms, not just one.
//
// Resolving the access context first makes an unassociated client's request
// answer 403 (the same thing they would get for a healthy firm) instead of
// confirming the firm exists and is behind on payment. The context is
// memoized per (firm, uid, clientRecordId) for a few seconds, so a handler's
// own resolve below is a cache hit and this costs no extra queries for a
// caller with exactly one association or an explicit `clientRecordId`.
//
// A uid with MULTIPLE associations in this firm (e.g. Pat, on two companies)
// still passes here without picking one: `CLIENT_SELECTION_REQUIRED` only
// means the ACTIVE-CLIENT selection is ambiguous, not that the uid lacks any
// association with the firm at all - which is all this gate needs to know.
// The real selection is the individual route handler's problem, not this
// gate's.
//
// The same gate carries the `clientPortal` feature check, because this is the
// only place a portal request names a firm — `/api/client-portal` has no
// `:lawFirmId` for a router-level `requireFeature` to resolve. Without it a firm
// that turned the portal off (or lost it with its plan) kept serving its clients
// through the API while the firm's own UI hid it.
router.use('/lawfirm/:lawFirmId', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const firm = await loadFirmPlan(req.params.lawFirmId);
    if (!firm) return next();

    const billingActive = isFirmBillingActive(firm);
    const portalEnabled = isFeatureEnabled(firm, 'clientPortal');
    if (billingActive && portalEnabled) return next();

    // Association is proven before either refusal, so an unassociated client
    // gets the 403 they would get for a healthy firm rather than learning this
    // firm's billing state or plan.
    try {
      await portalService.getActiveClientAccessContext({
        lawFirmId: req.params.lawFirmId,
        clientUserId: req.user.uid,
        userData: req.userData,
      });
    } catch (err: any) {
      // Multiple associations still proves this uid belongs to the firm; only
      // WHICH one is active is ambiguous, which this gate doesn't care about.
      if (!err || err.code !== CLIENT_SELECTION_REQUIRED_CODE) throw err;
    }

    if (!billingActive) {
      const err = new AppError(
        "This law firm's portal is temporarily unavailable. Please contact the firm directly.",
        402,
        'BILLING_INACTIVE',
      );
      err.details = { billingStatus: firm.plan?.billingStatus || 'incomplete' };
      return next(err);
    }

    return next(new ForbiddenError(
      'This law firm has turned off its client portal. Please contact the firm directly.'
    ));
  } catch (e) {
    return next(e);
  }
});

// Identity verification (Credence ID). Mounted after the per-firm gate above so
// it inherits the client-only auth, the billing gate and the portal feature gate.
router.use('/lawfirm/:lawFirmId/identity', require('../../identityVerification/identityVerification.portal.routes'));

// GET /api/client-portal/my-lawfirms
router.get('/my-lawfirms', handler(async (req) => portalService.listMyLawFirms({
  clientUserId: req.user.uid,
  userData: req.userData,
})));

// GET /api/client-portal/firm-summaries
// One aggregate read for the portal dashboard: every firm the client belongs to,
// each with matterCount + outstandingBalanceCents computed server-side (replaces a
// per-firm matters+billing fan-out).
router.get('/firm-summaries', handler(async (req) => portalService.listMyFirmSummaries({
  clientUserId: req.user.uid,
  userData: req.userData,
})));

// GET /api/client-portal/lawfirm/:lawFirmId/associations
// Every client-record association (person and/or company roster links) this
// uid holds in this one firm, shaped for the frontend's active-client
// switcher (organization-clients plan, Phase 5). A person client with no
// company roster memberships gets back exactly one entry; a uid with more
// than one (e.g. Pat, on two companies) sees the full list up front, before
// any route answers `CLIENT_SELECTION_REQUIRED`.
router.get('/lawfirm/:lawFirmId/associations', handler(async (req) => portalService.listPortalAssociations({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
})));

// GET /api/client-portal/lawfirm/:lawFirmId/matters
router.get('/lawfirm/:lawFirmId/matters', handler(async (req) => portalService.listPortalMatters({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  clientRecordId: readClientRecordId(req),
})));

// GET /api/client-portal/lawfirm/:lawFirmId/matters/:matterId
router.get('/lawfirm/:lawFirmId/matters/:matterId', handler(async (req) => portalService.getPortalMatter({
  lawFirmId: req.params.lawFirmId,
  matterId: req.params.matterId,
  clientUserId: req.user.uid,
  userData: req.userData,
  clientRecordId: readClientRecordId(req),
})));

// GET /api/client-portal/lawfirm/:lawFirmId/billing
// Paging is opt-in: the invoice list asks for a page, the statement view asks for
// everything (it builds a running balance over the whole history).
//
// Rate-limited as a heavy read for the same reason the firm-side billing reads
// are: the derived set (each invoice with its payments, credit notes and
// remaining balance) is built in full before it is windowed, so a page costs what
// the unpaged read does, and the statement view genuinely asks for everything.
router.get('/lawfirm/:lawFirmId/billing', heavyReadLimiter, validate(portalBillingQuerySchema), optionalTimezone, handler(async (req) => portalService.listPortalBilling({
  timeZone: req.tz,
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  limit: req.query.limit,
  offset: req.query.offset,
  page: req.query.page,
  status: req.query.status,
  clientRecordId: readClientRecordId(req),
})));

// GET /api/client-portal/lawfirm/:lawFirmId/invoices/:invoiceId
// One invoice, instead of the client's whole billing history — used by the
// invoice-detail page, which otherwise had to fetch every invoice just to
// find() the one it needed.
router.get('/lawfirm/:lawFirmId/invoices/:invoiceId', optionalTimezone, handler(async (req) => portalService.getPortalInvoice({
  timeZone: req.tz,
  lawFirmId: req.params.lawFirmId,
  invoiceId: req.params.invoiceId,
  clientUserId: req.user.uid,
  userData: req.userData,
  clientRecordId: readClientRecordId(req),
})));

// GET /api/client-portal/lawfirm/:lawFirmId/documents
router.get('/lawfirm/:lawFirmId/documents', heavyReadLimiter, handler(async (req) => portalService.listPortalDocuments({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  clientRecordId: readClientRecordId(req),
})));

// GET /api/client-portal/lawfirm/:lawFirmId/matters/:matterId/documents
router.get('/lawfirm/:lawFirmId/matters/:matterId/documents', heavyReadLimiter, handler(async (req) => portalService.listPortalMatterDocuments({
  lawFirmId: req.params.lawFirmId,
  matterId: req.params.matterId,
  clientUserId: req.user.uid,
  userData: req.userData,
  clientRecordId: readClientRecordId(req),
})));

// POST /api/client-portal/lawfirm/:lawFirmId/matters/:matterId/documents/refresh-url
// Lazily (re)sign a fresh download URL for one client-visible matter document the
// UI is opening. The listing doesn't have to rely on URLs baked at list time.
router.post(
  '/lawfirm/:lawFirmId/matters/:matterId/documents/refresh-url',
  validate(refreshDocumentUrlSchema),
  handler(async (req) => portalService.refreshDocumentDownloadUrl({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    clientUserId: req.user.uid,
    userData: req.userData,
    fileId: req.body.fileId,
    clientRecordId: readClientRecordId(req),
  }))
);

// POST /api/client-portal/lawfirm/:lawFirmId/documents/refresh-url
// Sign a fresh download URL for one document the client is opening, whichever
// place it came from: a matter they are on, their own file area, or a standalone
// task they are linked to. The row says which of those it is, and the share is
// re-checked against this client, so the document feed can list documents
// without baking a URL into every row.
router.post(
  '/lawfirm/:lawFirmId/documents/refresh-url',
  validate(refreshAnyDocumentUrlSchema),
  handler(async (req) => portalService.refreshDocumentDownloadUrl({
    lawFirmId: req.params.lawFirmId,
    clientUserId: req.user.uid,
    userData: req.userData,
    fileId: req.body.fileId,
    clientRecordId: readClientRecordId(req),
  }))
);

// Free client upload into one of their matters, straight to storage. It used to
// arrive here as multipart: ten files at a hundred megabytes each, resident in a
// 512 MiB container that serves eighty concurrent requests and signs documents.
//
// The matter access check runs on BOTH steps, because each route stands alone.

// POST /api/client-portal/lawfirm/:lawFirmId/matters/:matterId/documents/upload-init
router.post('/lawfirm/:lawFirmId/matters/:matterId/documents/upload-init',
  uploadLimiter,
  handler(async (req) => portalService.beginMatterDocumentUpload({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    clientUserId: req.user.uid,
    userData: req.userData,
    files: req.body?.files || [],
    clientRecordId: readClientRecordId(req),
    origin: req.get('origin') || undefined,
  })));

// POST /api/client-portal/lawfirm/:lawFirmId/matters/:matterId/documents/upload-finalize
router.post('/lawfirm/:lawFirmId/matters/:matterId/documents/upload-finalize',
  handler(async (req) => portalService.finishMatterDocumentUpload({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    clientUserId: req.user.uid,
    userData: req.userData,
    uploads: req.body?.uploads || [],
    clientRecordId: readClientRecordId(req),
  }), 201));

// POST /api/client-portal/lawfirm/:lawFirmId/matters/:matterId/documents/upload-cancel
// Body `{ uploads: [{ fileId, reservationId }] }`, answers `{ cancelled: n }`.
router.post('/lawfirm/:lawFirmId/matters/:matterId/documents/upload-cancel',
  handler(async (req) => portalService.cancelMatterDocumentUpload({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    clientUserId: req.user.uid,
    userData: req.userData,
    uploads: req.body?.uploads || [],
    clientRecordId: readClientRecordId(req),
  })));

// GET /api/client-portal/lawfirm/:lawFirmId/document-requests[?matterId=...]
// The document requests the firm has posted to this client (optionally one matter).
router.get('/lawfirm/:lawFirmId/document-requests', handler(async (req) => portalService.listPortalDocumentRequests({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  matterId: req.query.matterId || null,
  clientRecordId: readClientRecordId(req),
})));

// POST /api/client-portal/lawfirm/:lawFirmId/document-requests/:requestId/items/:itemId/fulfill
// Upload document(s) that fulfill a specific checklist item.
router.post(
  '/lawfirm/:lawFirmId/document-requests/:requestId/items/:itemId/fulfill/upload-init',
  uploadLimiter,
  handler(async (req) => portalService.beginRequestItemUpload({
    lawFirmId: req.params.lawFirmId,
    requestId: req.params.requestId,
    itemId: req.params.itemId,
    clientUserId: req.user.uid,
    userData: req.userData,
    files: req.body?.files || [],
    actionKey: req.body?.actionKey,
    clientRecordId: readClientRecordId(req),
    origin: req.get('origin') || undefined,
  }))
);

router.post(
  '/lawfirm/:lawFirmId/document-requests/:requestId/items/:itemId/fulfill/upload-finalize',
  handler(async (req) => portalService.finishRequestItemUpload({
    lawFirmId: req.params.lawFirmId,
    requestId: req.params.requestId,
    itemId: req.params.itemId,
    clientUserId: req.user.uid,
    userData: req.userData,
    uploads: req.body?.uploads || [],
    clientRecordId: readClientRecordId(req),
  }), 201)
);

// Body `{ uploads: [{ fileId, reservationId }] }`, answers `{ cancelled: n }`.
router.post(
  '/lawfirm/:lawFirmId/document-requests/:requestId/items/:itemId/fulfill/upload-cancel',
  handler(async (req) => portalService.cancelRequestItemUpload({
    lawFirmId: req.params.lawFirmId,
    requestId: req.params.requestId,
    clientUserId: req.user.uid,
    userData: req.userData,
    uploads: req.body?.uploads || [],
    clientRecordId: readClientRecordId(req),
  }))
);

// GET /api/client-portal/lawfirm/:lawFirmId/document-requests/:requestId/items/:itemId/fulfillments/:fulfillmentId/url
// A short-lived signed URL to preview or download an attached file.
router.get(
  '/lawfirm/:lawFirmId/document-requests/:requestId/items/:itemId/fulfillments/:fulfillmentId/url',
  handler(async (req) => portalService.getPortalRequestFulfillmentUrl({
    lawFirmId: req.params.lawFirmId,
    requestId: req.params.requestId,
    itemId: req.params.itemId,
    fulfillmentId: req.params.fulfillmentId,
    clientUserId: req.user.uid,
    userData: req.userData,
    clientRecordId: readClientRecordId(req),
  }))
);

// DELETE /api/client-portal/lawfirm/:lawFirmId/document-requests/:requestId/items/:itemId/fulfillments/:fulfillmentId
// Remove a file the client uploaded themselves.
router.delete(
  '/lawfirm/:lawFirmId/document-requests/:requestId/items/:itemId/fulfillments/:fulfillmentId',
  handler(async (req) => portalService.deletePortalRequestFulfillment({
    lawFirmId: req.params.lawFirmId,
    requestId: req.params.requestId,
    itemId: req.params.itemId,
    fulfillmentId: req.params.fulfillmentId,
    clientUserId: req.user.uid,
    userData: req.userData,
    clientRecordId: readClientRecordId(req),
  }))
);

// GET /api/client-portal/lawfirm/:lawFirmId/messages/conversations
// Every conversation this portal uid participates in for this firm - the
// client's own direct thread plus every group thread (a company's canonical
// conversation for each company association, and any ad-hoc group) they are
// an active participant of. Placed before the plain /messages route below so
// it never falls through to it. See portalService.listPortalConversations.
router.get('/lawfirm/:lawFirmId/messages/conversations', validate(portalConversationsQuerySchema), handler(async (req) => portalService.listPortalConversations({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
})));

// GET /api/client-portal/lawfirm/:lawFirmId/messages[?conversationId=...]
// Omitted conversationId: the client's own direct thread (unchanged contract).
// A group thread's id (company canonical or ad-hoc): that thread's messages.
router.get('/lawfirm/:lawFirmId/messages', validate(portalMessagesQuerySchema), handler(async (req) => portalService.listPortalMessages({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  limit: req.query.limit,
  lastMessageId: req.query.lastMessageId,
  conversationId: req.query.conversationId,
})));

// POST /api/client-portal/lawfirm/:lawFirmId/messages
// body.conversationId optional, same contract as the GET above.
router.post('/lawfirm/:lawFirmId/messages', portalMessageSendLimiter, validate(sendPortalMessageSchema), handler(async (req) => portalService.sendPortalMessage({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  body: req.body,
})));

// PUT /api/client-portal/lawfirm/:lawFirmId/messages/mark-read
// body.conversationId optional, same contract as the GET above.
router.put('/lawfirm/:lawFirmId/messages/mark-read', validate(markPortalMessagesReadSchema), handler(async (req) => portalService.markPortalMessagesRead({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  body: req.body,
})));

// Message attachments upload straight to storage. They used to arrive here as
// multipart: five files at a hundred megabytes each, resident in a 512 MiB
// container that serves eighty concurrent requests and signs documents.
//
// The firm association and the messaging folder are resolved on BOTH steps
// rather than trusted from the request. Each route is reachable on its own, so
// a finalize that skipped either would let an outsider record attachments
// against a firm they have no relationship with, or a client record them into a
// group thread they are not a participant in.

// POST /api/client-portal/lawfirm/:lawFirmId/messages/attachments/upload-init
router.post('/lawfirm/:lawFirmId/messages/attachments/upload-init',
  uploadLimiter,
  handler(async (req) => portalService.beginMessageAttachmentUpload({
    lawFirmId: req.params.lawFirmId,
    clientUserId: req.user.uid,
    userData: req.userData,
    files: req.body?.files || [],
    conversationId: req.body?.conversationId,
    origin: req.get('origin') || undefined,
  })));

// POST /api/client-portal/lawfirm/:lawFirmId/messages/attachments/upload-finalize
router.post('/lawfirm/:lawFirmId/messages/attachments/upload-finalize',
  handler(async (req) => portalService.finishMessageAttachmentUpload({
    lawFirmId: req.params.lawFirmId,
    clientUserId: req.user.uid,
    userData: req.userData,
    uploads: req.body?.uploads || [],
    conversationId: req.body?.conversationId,
  }), 201));

// POST /api/client-portal/lawfirm/:lawFirmId/messages/attachments/upload-cancel
// Body `{ conversationId?, uploads: [{ objectPath, reservationId }] }`, answers
// `{ cancelled: n }`, n being the reservations released.
router.post('/lawfirm/:lawFirmId/messages/attachments/upload-cancel',
  handler(async (req) => portalService.cancelMessageAttachmentUpload({
    lawFirmId: req.params.lawFirmId,
    clientUserId: req.user.uid,
    userData: req.userData,
    uploads: req.body?.uploads || [],
    conversationId: req.body?.conversationId,
  })));

// POST /api/client-portal/lawfirm/:lawFirmId/messages/attachments/discard
// Body `{ conversationId?, objectPaths }`, answers `{ discarded: n }`: the
// client's own finalized, unsent attachments removed from the composer.
router.post('/lawfirm/:lawFirmId/messages/attachments/discard',
  validate(discardPortalAttachmentsSchema),
  handler(async (req) => portalService.discardMessageAttachmentUploads({
    lawFirmId: req.params.lawFirmId,
    clientUserId: req.user.uid,
    userData: req.userData,
    objectPaths: req.body.objectPaths,
    conversationId: req.body.conversationId,
  })));

// GET /api/client-portal/unread-count
router.get('/unread-count', handler(async (req) => portalService.getPortalUnreadCount({
  clientUserId: req.user.uid,
  userData: req.userData,
})));

// GET /api/client-portal/lawfirm/:lawFirmId/events[?matterId=...]
// `matterId` narrows the agenda to one matter in SQL. A caller that wants one
// matter's events must not read the firm-wide list and filter it: that list is
// capped, so the matter's events could sit entirely past the cap.
router.get('/lawfirm/:lawFirmId/events', validate(portalEventsQuerySchema), optionalTimezone, handler(async (req) => portalService.listPortalEvents({
  timeZone: req.tz,
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  matterId: req.query.matterId || null,
  clientRecordId: readClientRecordId(req),
})));

// GET /api/client-portal/lawfirm/:lawFirmId/billing/pay/:invoiceId/options
router.get('/lawfirm/:lawFirmId/billing/pay/:invoiceId/options', handler(async (req) => portalService.getPaymentOptions({
  lawFirmId: req.params.lawFirmId,
  invoiceId: req.params.invoiceId,
  clientUserId: req.user.uid,
  userData: req.userData,
  clientRecordId: readClientRecordId(req),
})));

// POST /api/client-portal/lawfirm/:lawFirmId/billing/pay/:invoiceId/card/quote
router.post('/lawfirm/:lawFirmId/billing/pay/:invoiceId/card/quote', validate(cardQuoteSchema),
  handler(async (req) => portalService.quotePortalCard({
    lawFirmId: req.params.lawFirmId,
    invoiceId: req.params.invoiceId,
    clientUserId: req.user.uid,
    userData: req.userData,
    clientRecordId: readClientRecordId(req),
    confirmationTokenId: req.body.confirmationTokenId,
  })));

// POST /api/client-portal/lawfirm/:lawFirmId/billing/pay/:invoiceId/card/confirm
router.post('/lawfirm/:lawFirmId/billing/pay/:invoiceId/card/confirm', validate(cardConfirmSchema),
  handler(async (req) => portalService.confirmPortalCard({
    lawFirmId: req.params.lawFirmId,
    invoiceId: req.params.invoiceId,
    clientUserId: req.user.uid,
    userData: req.userData,
    clientRecordId: readClientRecordId(req),
    confirmationTokenId: req.body.confirmationTokenId,
    expectedTotalCents: req.body.expectedTotalCents,
  })));

// POST /api/client-portal/lawfirm/:lawFirmId/billing/pay/:invoiceId/card/complete
router.post('/lawfirm/:lawFirmId/billing/pay/:invoiceId/card/complete', validate(cardCompleteSchema),
  handler(async (req) => portalService.completePortalCard({
    lawFirmId: req.params.lawFirmId,
    invoiceId: req.params.invoiceId,
    clientUserId: req.user.uid,
    userData: req.userData,
    clientRecordId: readClientRecordId(req),
    paymentIntentId: req.body.paymentIntentId,
  })));

// GET /api/client-portal/lawfirm/:lawFirmId/billing/pay/:invoiceId?method=card|bank
router.get('/lawfirm/:lawFirmId/billing/pay/:invoiceId', handler(async (req) => portalService.getPaymentCheckoutUrl({
  lawFirmId: req.params.lawFirmId,
  invoiceId: req.params.invoiceId,
  clientUserId: req.user.uid,
  userData: req.userData,
  clientRecordId: readClientRecordId(req),
  method: typeof req.query.method === 'string' ? req.query.method : null,
})));

// GET /api/client-portal/lawfirm/:lawFirmId/trust/balance
router.get('/lawfirm/:lawFirmId/trust/balance', handler(async (req) => portalService.getPortalTrustBalance({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  clientRecordId: readClientRecordId(req),
})));

// GET /api/client-portal/lawfirm/:lawFirmId/trust/ledger
router.get('/lawfirm/:lawFirmId/trust/ledger', validate(portalTrustLedgerQuerySchema), handler(async (req) => portalService.getPortalTrustLedger({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  limit: req.query.limit,
  offset: req.query.offset,
  clientRecordId: readClientRecordId(req),
})));

// GET /api/client-portal/lawfirm/:lawFirmId/settings (the client's own portal prefs)
router.get('/lawfirm/:lawFirmId/settings', handler(async (req) => portalService.getPortalSettings({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  clientRecordId: readClientRecordId(req),
})));

// PUT /api/client-portal/lawfirm/:lawFirmId/settings
// `clientRecordId` must travel as a QUERY param on this route, never in the
// body: `updatePortalSettingsSchema`'s body is `.strict()` (only the settings
// keys the service persists are allowed), so an extra body field would fail
// validation instead of silently passing through.
router.put('/lawfirm/:lawFirmId/settings', validate(updatePortalSettingsSchema), handler(async (req) => portalService.updatePortalSettings({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  body: req.body,
  clientRecordId: (req.query && req.query.clientRecordId) || undefined,
})));

// GET /api/client-portal/lawfirm/:lawFirmId/notifications (client's own bell feed)
router.get('/lawfirm/:lawFirmId/notifications', validate(portalNotificationsQuerySchema), handler(async (req) => portalService.listClientNotifications({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  unreadOnly: req.query.unreadOnly,
  limit: req.query.limit,
  before: req.query.before,
  beforeId: req.query.beforeId,
})));

// POST /api/client-portal/lawfirm/:lawFirmId/notifications/mark-all-read
router.post('/lawfirm/:lawFirmId/notifications/mark-all-read', handler(async (req) => portalService.markAllClientNotificationsRead({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
})));

// POST /api/client-portal/lawfirm/:lawFirmId/notifications/:notificationId/read
router.post('/lawfirm/:lawFirmId/notifications/:notificationId/read', handler(async (req) => portalService.markClientNotificationRead({
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  notificationId: req.params.notificationId,
})));

// GET /api/client-portal/lawfirm/:lawFirmId/dashboard
// Heavy for the same reason `/billing` is: it builds the client's ENTIRE derived
// invoice set (every invoice with its payments and credit notes) unwindowed to
// produce the summary, so one dashboard read costs what an unpaged billing read
// costs.
router.get('/lawfirm/:lawFirmId/dashboard', heavyReadLimiter, optionalTimezone, handler(async (req) => portalService.getClientDashboard({
  timeZone: req.tz,
  lawFirmId: req.params.lawFirmId,
  clientUserId: req.user.uid,
  userData: req.userData,
  clientRecordId: readClientRecordId(req),
})));

export = router;
