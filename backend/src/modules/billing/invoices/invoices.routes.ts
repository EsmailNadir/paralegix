const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { heavyReadLimiter } = require('../../../shared/middleware/rateLimiters');
const { validate } = require('../../../shared/middleware/validate');
const { requireTimezone, optionalTimezone } = require('../../../shared/middleware/timezone');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const {
  listFirmInvoicesSchema,
  calendarPaymentDatesSchema,
  createInvoiceSchema,
  createClientInvoiceSchema,
  createSplitInvoicesSchema,
  updateInvoiceDetailsSchema,
  updateLineItemsSchema,
  recordPaymentSchema,
  editPaymentSchema,
  deletePaymentSchema,
  unpayInstallmentSchema,
  addAmountSchema,
  addCreditNoteSchema,
  setPaymentPlanSchema,
  updateInstallmentSchema,
  replaceScheduleSchema,
  bulkCreateInvoicesSchema,
  setPreDueReminderSchema,
  setReminderOptOutSchema,
  updateBillingEmailsSchema,
} = require('./invoices.validation');
const invoicesService = require('./invoices.service');
const { sendOverdueReminders, sendReminderForInvoice, sendInvoiceToEmail, assertInvoiceSendable } = require('./invoiceReminders.service');
const { authorizeContext, MODE_READ } = require('../context');
const { generateLedesExport } = require('./ledesExport.service');
const { logSecurityEvent } = require('../../../shared/utils/securityLog');
const { ValidationError, NotFoundError } = require('../../../shared/errors/AppError');
import { handler } from '../../../shared/http/handler';
import { beginDirectUpload, settleDirectUpload } from '../../../shared/storage/directUpload';
import { getArtifact } from '../../../shared/storage/recordArchive';

const crypto = require('crypto');

/**
 * What the browser may upload as an invoice attachment.
 *
 * The PDF is rendered in the browser and used twice: attached to the email and
 * archived as the copy the client received. It used to arrive as base64 inside
 * the JSON body, which is the worst possible shape for it. The container held
 * the raw bytes, the string they were decoded from and the resulting buffer at
 * once, under a 50 MiB body ceiling any caller could claim, on an instance
 * serving 80 concurrent requests. It now lands in storage directly and the
 * request carries only its path.
 *
 * The cap is enforced against what STORAGE recorded, so an oversized upload is
 * refused without being read.
 */
const INVOICE_PDF_MAX_BYTES = Number(process.env.INVOICE_PDF_MAX_BYTES) || 20 * 1024 * 1024;
const INVOICE_PDF_TYPES = ['application/pdf'];

/**
 * Where an outgoing attachment waits between being uploaded and being sent.
 *
 * A WORKING segment, so it sits outside the firm's browsable tree, outside
 * their quota, and is refused as a signing source. It is deleted once the mail
 * has left, and the copy that is kept is the archived one.
 */
function outgoingPrefix(lawFirmId: string, invoiceId: string) {
  return `lawfirmids/${lawFirmId}/invoice-outgoing/${invoiceId}/`;
}

/**
 * The uploaded attachment, verified and read, or null when none was sent.
 *
 * The path arrives from the client. Unchecked, it names any object in the
 * bucket, another firm's documents included, and this route would then mail it
 * out and archive it as this invoice.
 */
async function attachmentFrom(req: any, lawFirmId: string, invoiceId: string) {
  const objectPath = String(req.body?.objectPath || '');
  if (!objectPath) return null;

  const prefix = outgoingPrefix(lawFirmId, invoiceId);
  if (!objectPath.startsWith(prefix) || objectPath.slice(prefix.length).includes('/')) {
    throw new ValidationError('That upload does not belong to this invoice.');
  }

  await settleDirectUpload({
    objectPath,
    uploadedBy: req.user.uid,
    maxBytes: INVOICE_PDF_MAX_BYTES,
    allowedContentTypes: INVOICE_PDF_TYPES,
    fileName: 'invoice.pdf',
  });

  return { objectPath, buffer: await getArtifact(objectPath) };
}

/**
 * Drop the working copy once the send is over.
 *
 * The copy that is KEPT is the archived one, written by the send itself. This
 * object exists only to carry the bytes from the browser to this request, so
 * leaving it would keep a second copy of every invoice ever emailed. Failure to
 * delete is logged and never raised: the mail has already gone out.
 */
async function discardAttachment(attachment: { objectPath: string } | null) {
  if (!attachment) return;
  const { admin } = require('../../../shared/database/firebase');
  await admin.storage().bucket(process.env.GCS_BUCKET).file(attachment.objectPath).delete()
    .catch((err: any) => console.error(
      '[invoices] Could not delete the outgoing attachment', attachment.objectPath, err?.message,
    ));
}

/** Open an upload for an invoice attachment. Shared by both parent scopes. */
async function openAttachmentUpload(req: any, res: any) {
  const { lawFirmId, invoiceId, matterId, clientId } = req.params;
  // The working prefix is keyed by invoice id alone, so access to the invoice
  // is settled here with the same gate as the send this upload prepares.
  await assertInvoiceSendable({ lawFirmId, matterId, clientId, invoiceId, actingUserId: req.user.uid });
  const opened = await beginDirectUpload({
    objectPath: `${outgoingPrefix(lawFirmId, invoiceId)}${crypto.randomUUID()}.pdf`,
    contentType: 'application/pdf',
    uploadedBy: req.user.uid,
    maxBytes: INVOICE_PDF_MAX_BYTES,
    allowedContentTypes: INVOICE_PDF_TYPES,
    fileName: String(req.body?.fileName || 'invoice.pdf'),
    declaredSize: Number(req.body?.size) || undefined,
    origin: req.get('origin') || undefined,
    metadata: { cacheControl: 'private, max-age=0, no-transform' },
  });
  res.json(opened);
}

// ── Calendar (firm-wide, no matterId) ────────────────────────────────

// GET /api/lawfirms/:lawFirmId/billing/invoices/firm
// Server-side paging/filtering/sorting. Every query param is optional; with no
// `limit` the complete firm list comes back, which is the contract the billing
// workbench and summary reads depend on. The timezone is required because the
// status, `due_soon` and due-bucket filters are calendar-day comparisons that must
// roll over at the viewer's midnight.
router.get('/firm',
  verifyToken,
  heavyReadLimiter,
  requirePermission('billing.viewInvoices'),
  validate(listFirmInvoicesSchema),
  requireTimezone,
  handler(async (req) => invoicesService.listFirmInvoices({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    timezone: req.tz,
    page: req.query.page,
    limit: req.query.limit,
    offset: req.query.offset,
    sort: req.query.sort,
    search: req.query.search,
    matterId: req.query.matterId,
    clientId: req.query.clientId,
    clientScope: req.query.clientScope,
    billingRelation: req.query.billingRelation,
    relatedClientId: req.query.relatedClientId,
    includeDetails: req.query.includeDetails === 'true',
    status: req.query.status,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    dueDateFrom: req.query.dueDateFrom,
    dueDateTo: req.query.dueDateTo,
    dueGroup: req.query.dueGroup,
    awaitingOnly: req.query.awaitingOnly === 'true',
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/invoices/firm/unbilled-summaries
router.get('/firm/unbilled-summaries',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  handler(async (req) => invoicesService.listFirmUnbilledSummaries({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/invoices/calendar-payment-dates
router.get('/calendar-payment-dates',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  validate(calendarPaymentDatesSchema),
  handler(async (req) => {
    const { from, to } = req.query;
    const result = await invoicesService.getCalendarPaymentDates({
      lawFirmId: req.params.lawFirmId,
      actingUserId: req.user.uid,
      // Money dates are day-only, so the window needs no timezone resolution:
      // it is only valid when both bounds are present and correctly ordered.
      window: from && to && from <= to ? { from, to } : null,
    });
    return result;
  }),
);

// ── Matter-level CRUD ────────────────────────────────────────────────

// POST /api/lawfirms/:lawFirmId/billing/invoices
router.post('/',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(createInvoiceSchema),
  handler(async (req) => invoicesService.createInvoice({
    lawFirmId: req.params.lawFirmId,
    matterId: req.body.matterId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/split
router.post('/matter/:matterId/split',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(createSplitInvoicesSchema),
  handler(async (req) => invoicesService.createSplitInvoices({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId
router.post('/client/:clientId',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(createClientInvoiceSchema),
  handler(async (req) => invoicesService.createInvoice({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201),
);

// GET /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId
router.get('/matter/:matterId',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  handler(async (req) => invoicesService.listInvoices({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    actingUserId: req.user.uid,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId
router.get('/client/:clientId',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  handler(async (req) => invoicesService.listInvoices({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    actingUserId: req.user.uid,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/unbilled-summary
router.get('/matter/:matterId/unbilled-summary',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  handler(async (req) => invoicesService.getUnbilledSummary({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    actingUserId: req.user.uid,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/unbilled-summary
router.get('/client/:clientId/unbilled-summary',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  handler(async (req) => invoicesService.getUnbilledSummary({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    actingUserId: req.user.uid,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId
router.delete('/matter/:matterId/:invoiceId',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => invoicesService.deleteInvoice({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId
router.delete('/client/:clientId/:invoiceId',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => invoicesService.deleteInvoice({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })),
);

// ── Invoice Details (name / number / date) ──────────────────────────

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/details
router.patch('/matter/:matterId/:invoiceId/details',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(updateInvoiceDetailsSchema),
  handler(async (req) => invoicesService.updateInvoiceDetails({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/details
router.patch('/client/:clientId/:invoiceId/details',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(updateInvoiceDetailsSchema),
  handler(async (req) => invoicesService.updateInvoiceDetails({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// ── Line items ─────────────────────────────────────────────────────

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/line-items
router.patch('/matter/:matterId/:invoiceId/line-items',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(updateLineItemsSchema),
  handler(async (req) => invoicesService.updateInvoiceLineItems({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/line-items
router.patch('/client/:clientId/:invoiceId/line-items',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(updateLineItemsSchema),
  handler(async (req) => invoicesService.updateInvoiceLineItems({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// ── Payments ───────────────────────────────────────────────────────

// PUT /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/payment
router.put('/matter/:matterId/:invoiceId/payment',
  verifyToken,
  requirePermission('billing.recordPayments'),
  validate(recordPaymentSchema),
  optionalTimezone,
  handler(async (req) => invoicesService.recordPayment({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    timeZone: req.tz,
    body: req.body,
  })),
);

// PUT /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/payment
router.put('/client/:clientId/:invoiceId/payment',
  verifyToken,
  requirePermission('billing.recordPayments'),
  validate(recordPaymentSchema),
  optionalTimezone,
  handler(async (req) => invoicesService.recordPayment({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    timeZone: req.tz,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/payment
router.delete('/matter/:matterId/:invoiceId/payment',
  verifyToken,
  requirePermission('billing.recordPayments'),
  validate(deletePaymentSchema),
  handler(async (req) => invoicesService.deletePayment({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    paymentIndex: req.query.paymentIndex,
    paymentId: req.query.paymentId,
    actingUserId: req.user.uid,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/payment
router.delete('/client/:clientId/:invoiceId/payment',
  verifyToken,
  requirePermission('billing.recordPayments'),
  validate(deletePaymentSchema),
  handler(async (req) => invoicesService.deletePayment({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    paymentIndex: req.query.paymentIndex,
    paymentId: req.query.paymentId,
    actingUserId: req.user.uid,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/payment
router.patch('/matter/:matterId/:invoiceId/payment',
  verifyToken,
  requirePermission('billing.recordPayments'),
  validate(editPaymentSchema),
  handler(async (req) => invoicesService.editPayment({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/payment
router.patch('/client/:clientId/:invoiceId/payment',
  verifyToken,
  requirePermission('billing.recordPayments'),
  validate(editPaymentSchema),
  handler(async (req) => invoicesService.editPayment({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// ── Add Amount ─────────────────────────────────────────────────────

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/add-amount
router.patch('/matter/:matterId/:invoiceId/add-amount',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(addAmountSchema),
  handler(async (req) => invoicesService.addAmountToInvoice({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/add-amount
router.patch('/client/:clientId/:invoiceId/add-amount',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(addAmountSchema),
  handler(async (req) => invoicesService.addAmountToInvoice({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// ── Late Fee ───────────────────────────────────────────────────────

// POST /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/void
router.post('/matter/:matterId/:invoiceId/void',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => invoicesService.voidInvoice({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/void
router.post('/client/:clientId/:invoiceId/void',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => invoicesService.voidInvoice({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/late-fee
router.post('/matter/:matterId/:invoiceId/late-fee',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  requireTimezone,
  handler(async (req) => invoicesService.applyLateFee({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    timeZone: req.tz,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/late-fee
router.post('/client/:clientId/:invoiceId/late-fee',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  requireTimezone,
  handler(async (req) => invoicesService.applyLateFee({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    timeZone: req.tz,
  })),
);

// ── Credit Notes ───────────────────────────────────────────────────

// POST /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/credit-note
router.post('/matter/:matterId/:invoiceId/credit-note',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(addCreditNoteSchema),
  handler(async (req) => invoicesService.addCreditNote({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/credit-note
router.post('/client/:clientId/:invoiceId/credit-note',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(addCreditNoteSchema),
  handler(async (req) => invoicesService.addCreditNote({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/credit-note
router.delete('/matter/:matterId/:invoiceId/credit-note',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => {
    if (!req.query.creditNoteId) {
      throw new ValidationError('Select a credit note.');
    }
    const result = await invoicesService.deleteCreditNote({
      lawFirmId: req.params.lawFirmId,
      matterId: req.params.matterId,
      invoiceId: req.params.invoiceId,
      creditNoteId: req.query.creditNoteId,
      actingUserId: req.user.uid,
    });
    return result;
  }),
);

// DELETE /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/credit-note
router.delete('/client/:clientId/:invoiceId/credit-note',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => {
    if (!req.query.creditNoteId) {
      throw new ValidationError('Select a credit note.');
    }
    const result = await invoicesService.deleteCreditNote({
      lawFirmId: req.params.lawFirmId,
      clientId: req.params.clientId,
      invoiceId: req.params.invoiceId,
      creditNoteId: req.query.creditNoteId,
      actingUserId: req.user.uid,
    });
    return result;
  }),
);

// ── Payment Plans ──────────────────────────────────────────────────

// POST /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/payment-plan
router.post('/matter/:matterId/:invoiceId/payment-plan',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(setPaymentPlanSchema),
  handler(async (req) => invoicesService.setPaymentPlan({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/payment-plan
router.post('/client/:clientId/:invoiceId/payment-plan',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(setPaymentPlanSchema),
  handler(async (req) => invoicesService.setPaymentPlan({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/payment-plan
router.delete('/matter/:matterId/:invoiceId/payment-plan',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => invoicesService.removePaymentPlan({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/payment-plan
router.delete('/client/:clientId/:invoiceId/payment-plan',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => invoicesService.removePaymentPlan({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })),
);

// ── Installment Management ────────────────────────────────────────

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/payment-plan/installment/:installmentIndex
router.patch('/matter/:matterId/:invoiceId/payment-plan/installment/:installmentIndex',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(updateInstallmentSchema),
  handler(async (req) => invoicesService.updateInstallment({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    installmentIndex: parseInt(String(req.params.installmentIndex)),
    body: req.body,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/payment-plan/installment/:installmentIndex
router.patch('/client/:clientId/:invoiceId/payment-plan/installment/:installmentIndex',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(updateInstallmentSchema),
  handler(async (req) => invoicesService.updateInstallment({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    installmentIndex: parseInt(String(req.params.installmentIndex)),
    body: req.body,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/payment-plan/schedule
router.patch('/matter/:matterId/:invoiceId/payment-plan/schedule',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(replaceScheduleSchema),
  handler(async (req) => invoicesService.replacePaymentPlanSchedule({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/payment-plan/schedule
router.patch('/client/:clientId/:invoiceId/payment-plan/schedule',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(replaceScheduleSchema),
  handler(async (req) => invoicesService.replacePaymentPlanSchedule({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/payment-plan/installment/:installmentIndex/payment
router.delete('/matter/:matterId/:invoiceId/payment-plan/installment/:installmentIndex/payment',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(unpayInstallmentSchema),
  handler(async (req) => invoicesService.unpayInstallment({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    installmentIndex: parseInt(String(req.params.installmentIndex)),
    paymentId: req.query.paymentId,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/payment-plan/installment/:installmentIndex/payment
router.delete('/client/:clientId/:invoiceId/payment-plan/installment/:installmentIndex/payment',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(unpayInstallmentSchema),
  handler(async (req) => invoicesService.unpayInstallment({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    installmentIndex: parseInt(String(req.params.installmentIndex)),
    paymentId: req.query.paymentId,
  })),
);

// ── LEDES Export ─────────────────────────────────────────────────────

// GET /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/export/ledes
router.get('/matter/:matterId/:invoiceId/export/ledes',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req, res) => {
    const { lawFirmId, matterId, invoiceId } = req.params;
    const context = { type: 'matter', lawFirmId, entityId: matterId };
    // A read: an owner or firm admin may export any matter's bill, everyone
    // else must be on the matter. Same rule as the invoice reads.
    await authorizeContext(context, req.user.uid, MODE_READ);

    const invoicesRepo = require('./invoices.repository');
    const lawfirmsRepo = require('../../lawfirms/lawfirms.repository');
    const clientsRepo = require('../../clients/clients.repository');

    const [invoice, lawFirm] = await Promise.all([
      invoicesRepo.findById(context, invoiceId),
      lawfirmsRepo.findById(lawFirmId),
    ]);

    if (!invoice) throw new NotFoundError('Invoice');

    // Fetch client if known
    let client = null;
    if (invoice.clientId) {
      client = await clientsRepo.findByIdRaw(lawFirmId, invoice.clientId);
    }

    const ledesContent = generateLedesExport({ invoice, lawFirm, client });
    const filename = `${(invoice.invoiceName || invoiceId).replace(/[^a-zA-Z0-9-_]/g, '_')}.ledes`;

    logSecurityEvent(req, 'data.export', { scope: 'invoice-ledes', lawFirmId, matterId, invoiceId });
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(ledesContent);
  }),
);

// GET /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/export/ledes
router.get('/client/:clientId/:invoiceId/export/ledes',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req, res) => {
    const { lawFirmId, clientId, invoiceId } = req.params;
    const context = { type: 'client', lawFirmId, entityId: clientId };
    // A read: same gate as the invoice reads.
    await authorizeContext(context, req.user.uid, MODE_READ);

    const invoicesRepo = require('./invoices.repository');
    const lawfirmsRepo = require('../../lawfirms/lawfirms.repository');
    const clientsRepo = require('../../clients/clients.repository');

    const [invoice, lawFirm, client] = await Promise.all([
      invoicesRepo.findById(context, invoiceId),
      lawfirmsRepo.findById(lawFirmId),
      clientsRepo.findByIdRaw(lawFirmId, clientId),
    ]);

    if (!invoice) throw new NotFoundError('Invoice');

    const ledesContent = generateLedesExport({ invoice, lawFirm, client });
    const filename = `${(invoice.invoiceName || invoiceId).replace(/[^a-zA-Z0-9-_]/g, '_')}.ledes`;

    logSecurityEvent(req, 'data.export', { scope: 'invoice-ledes', lawFirmId, clientId, invoiceId });
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(ledesContent);
  }),
);

// ── Invoice Reminders ────────────────────────────────────────────────

// POST /api/lawfirms/:lawFirmId/billing/invoices/send-reminders
// Manual trigger for the whole firm, limited to the invoices the caller could
// remind one at a time (matter invoices on matters they are on, plus client-context invoices).
router.post('/send-reminders',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => {
    const stats = await sendOverdueReminders(req.params.lawFirmId, { actingUserId: req.user.uid });
    return { message: 'Reminders processed', ...stats };
  }),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/send-reminder
router.post('/matter/:matterId/:invoiceId/send-reminder',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => sendReminderForInvoice({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/send-reminder
router.post('/client/:clientId/:invoiceId/send-reminder',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => sendReminderForInvoice({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/reminder-optout
router.patch('/matter/:matterId/:invoiceId/reminder-optout',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(setReminderOptOutSchema),
  handler(async (req) => invoicesService.setReminderOptOut({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    optOut: req.body.optOut !== false,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/reminder-optout
router.patch('/client/:clientId/:invoiceId/reminder-optout',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(setReminderOptOutSchema),
  handler(async (req) => invoicesService.setReminderOptOut({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    optOut: req.body.optOut !== false,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/pre-due-reminder
router.patch('/matter/:matterId/:invoiceId/pre-due-reminder',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(setPreDueReminderSchema),
  handler(async (req) => invoicesService.setPreDueReminder({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    invoiceDays: req.body.invoiceDays,
    planDays: req.body.planDays,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/pre-due-reminder
router.patch('/client/:clientId/:invoiceId/pre-due-reminder',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(setPreDueReminderSchema),
  handler(async (req) => invoicesService.setPreDueReminder({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    invoiceDays: req.body.invoiceDays,
    planDays: req.body.planDays,
  })),
);

// ── Billing recipients (bill-to snapshot) ────────────────────────────
//
// GET reports who the invoice is (or would be) billed to: the frozen snapshot
// once it has issued, otherwise a live resolve of the client's current billing
// recipients. POST .../refresh deliberately REPLACES an existing snapshot with
// today's recipients - the one sanctioned way to correct a bill issued against
// wrong recipient data. Permissioned on `billing.manageInvoices` (viewing is
// enough to read, but rewriting billing history is a management action) and
// audited by the snapshot service.

// GET /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/billing-recipients
router.get('/matter/:matterId/:invoiceId/billing-recipients',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  handler(async (req) => invoicesService.getInvoiceBillingRecipients({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/billing-recipients
router.get('/client/:clientId/:invoiceId/billing-recipients',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  handler(async (req) => invoicesService.getInvoiceBillingRecipients({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/billing-recipients/refresh
router.post('/matter/:matterId/:invoiceId/billing-recipients/refresh',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => invoicesService.refreshInvoiceBillingRecipients({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/billing-recipients/refresh
router.post('/client/:clientId/:invoiceId/billing-recipients/refresh',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => invoicesService.refreshInvoiceBillingRecipients({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })),
);

// PUT /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/billing-email
router.put('/matter/:matterId/:invoiceId/billing-email',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(updateBillingEmailsSchema),
  handler(async (req) => invoicesService.updateInvoiceBillingEmails({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    emails: req.body.emails,
  })),
);

// PUT /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/billing-email
router.put('/client/:clientId/:invoiceId/billing-email',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(updateBillingEmailsSchema),
  handler(async (req) => invoicesService.updateInvoiceBillingEmails({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    emails: req.body.emails,
  })),
);

// ── Sent Copies (preserved as-sent invoice PDFs) ──────────────────────
//
// One entry per successful send, so an invoice emailed three times has three.
// Read-only on purpose: these exist to answer what a client was actually sent,
// which a copy anyone could edit or delete would not.

// GET /api/lawfirms/:lawFirmId/billing/invoices/:invoiceId/sent-copies
router.get('/:invoiceId/sent-copies',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  handler(async (req) => invoicesService.listInvoiceSentCopies({
    lawFirmId: req.params.lawFirmId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/invoices/:invoiceId/sent-copies/:name
router.get('/:invoiceId/sent-copies/:name',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  // Answers with a short-lived signed url, not the document. Sending the PDF
  // itself put the whole file in a 512 MiB container that serves eighty
  // concurrent requests, on every download, and downloads outnumber uploads.
  //
  // The url is minted only after the service has authorized this caller, and
  // carries the filename on its own content disposition, because there is no
  // longer a response for the browser to read one from.
  handler(async (req) => {
    return invoicesService.getInvoiceSentCopy({
      lawFirmId: req.params.lawFirmId,
      invoiceId: req.params.invoiceId,
      name: req.params.name,
      actingUserId: req.user.uid,
    });
  }),
);

// ── Send Invoice via Email ────────────────────────────────────────────

// POST /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/send-email-init
router.post('/matter/:matterId/:invoiceId/send-email-init',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(openAttachmentUpload),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/matter/:matterId/:invoiceId/send-email
router.post('/matter/:matterId/:invoiceId/send-email',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => {
    const { recipientEmail, recipientName, pdfFileName } = req.body;
    const attachment = await attachmentFrom(req, req.params.lawFirmId, req.params.invoiceId);
    try {
      return await sendInvoiceToEmail({
        lawFirmId: req.params.lawFirmId,
        matterId: req.params.matterId,
        invoiceId: req.params.invoiceId,
        actingUserId: req.user.uid,
        recipientEmail,
        recipientName,
        pdfBuffer: attachment?.buffer || null,
        pdfFileName,
      });
    } finally {
      // Discarded even when the send is refused: a 403 after the attachment was
      // read would otherwise leave the working copy in storage.
      await discardAttachment(attachment);
    }
  }),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/send-email-init
router.post('/client/:clientId/:invoiceId/send-email-init',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(openAttachmentUpload),
);

// POST /api/lawfirms/:lawFirmId/billing/invoices/client/:clientId/:invoiceId/send-email
router.post('/client/:clientId/:invoiceId/send-email',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  handler(async (req) => {
    const { recipientEmail, recipientName, pdfFileName } = req.body;
    const attachment = await attachmentFrom(req, req.params.lawFirmId, req.params.invoiceId);
    try {
      return await sendInvoiceToEmail({
        lawFirmId: req.params.lawFirmId,
        clientId: req.params.clientId,
        invoiceId: req.params.invoiceId,
        actingUserId: req.user.uid,
        recipientEmail,
        recipientName,
        pdfBuffer: attachment?.buffer || null,
        pdfFileName,
      });
    } finally {
      // Discarded even when the send is refused: a 403 after the attachment was
      // read would otherwise leave the working copy in storage.
      await discardAttachment(attachment);
    }
  }),
);

// ── Bulk Invoice Generation ───────────────────────────────────────────

// POST /api/lawfirms/:lawFirmId/billing/invoices/bulk
router.post('/bulk',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(bulkCreateInvoicesSchema),
  handler(async (req) => invoicesService.bulkCreateInvoices({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    contexts: req.body.contexts,
    invoiceDate: req.body.invoiceDate,
    dueDate: req.body.dueDate,
    invoiceNamePrefix: req.body.invoiceNamePrefix,
  }), 201),
);

export = router;
