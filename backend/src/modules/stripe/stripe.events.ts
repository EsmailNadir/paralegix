const eventBus = require('../../shared/events/eventBus');
const {
  INVOICE_PAYMENT_RECEIVED,
  INVOICE_PAYMENT_REQUESTED,
  INVOICE_PAYMENT_REVERSED,
  INVOICE_PAYMENT_RECREDITED,
  INVOICE_PAYMENT_DISPUTE_LOST,
} = require('../../shared/events/eventTypes');
const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const usersRepo = require('../users/users.repository');
const invoicesRepo = require('../billing/invoices/invoices.repository');
const clientsRepo = require('../clients/clients.repository');
const { privilegedParameterizedQuery } = require('../../shared/database/queryContext');
const { createNotifications, FRONTEND_URL } = require('../notifications/notifications.service');
const { getFirmBillingSettings } = require('../billing/shared/billingSettings');
const { formatDollarsFromCents } = require('../billing/shared/money');
const { resolveInvoiceRecipients } = require('../billing/shared/billingRecipientSnapshot.service');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');
const {
  sendPaymentReceivedNotificationEmail,
  sendPaymentRefundedEmail,
} = require('../../shared/services/emailService');

const stripeSql = (text: string, params: unknown[] = []) => privilegedParameterizedQuery(
  'Stripe event recipients are scoped to the event law firm', text, params,
);

/**
 * When a payment is applied to an invoice (manual OR Stripe, partial OR full),
 * email the firm's admins/owners. Uses the unified INVOICE_PAYMENT_RECEIVED
 * payload: `amountPaidCents` + `invoiceName` come straight off the event, fixing
 * the earlier bug where manual payments rendered "$0.00" and a raw invoice UUID.
 */
eventBus.on(INVOICE_PAYMENT_RECEIVED, async ({
  lawFirmId, invoiceId, contextType, entityId, amountPaidCents, clientRecordId, clientUserId, invoiceName, source,
}: any) => {
  try {
    // Fetch law firm info
    const firm = await lawfirmsRepo.findById(lawFirmId);
    if (!firm) return;
    const firmName = firm.name || null;

    // Prefer the invoice name off the event; fall back to a lookup, then the id.
    let invoiceNumber = invoiceName || null;
    let clientName = null;
    if ((!invoiceNumber || !clientName) && contextType && entityId) {
      const invoice = await invoicesRepo
        .findById({ type: contextType, lawFirmId, entityId }, invoiceId)
        .catch(() => null);
      if (invoice) {
        invoiceNumber = invoiceNumber || invoice.invoiceName || null;
        clientName = invoice.clientName || null;
      }
    }
    invoiceNumber = invoiceNumber || invoiceId;

    // Resolve the client's name when the invoice did not carry one: from the
    // client RECORD first (a clients.id, which both the manual and the Stripe
    // path send), then from the paying user (a Firebase uid, Stripe path only).
    if (!clientName && clientRecordId) {
      const clientRecord = await clientsRepo.findById(lawFirmId, clientRecordId).catch(() => null);
      if (clientRecord) clientName = clientRecord.name || clientRecord.email || null;
    }
    if (!clientName && clientUserId) {
      const clientUser = await usersRepo.findById(clientUserId).catch(() => null);
      if (clientUser) clientName = clientUser.name || null;
    }

    // Fetch firm admins/owners and notify them
    const adminEmails = await usersRepo.getFirmAdminRecipients(lawFirmId);
    const amountPaid = (Number(amountPaidCents) || 0) / 100;

    // Three admins at a time: each send runs its own recipient-cap check against
    // the shared pool. The first failure still reaches the handler's catch.
    const adminSends = await runWithConcurrency(
      adminEmails.map(({ email, name }: any) => () =>
        sendPaymentReceivedNotificationEmail({
          to: email,
          recipientName: name,
          lawFirmName: firmName,
          invoiceNumber,
          amountPaid,
          clientName,
          method: source,
        })
      ),
      3,
    );
    const adminSendFailure = adminSends.find((r: any) => r.status === 'rejected');
    if (adminSendFailure) throw adminSendFailure.reason;
  } catch (err: any) {
    console.error('[stripe.events] INVOICE_PAYMENT_RECEIVED handler error:', err.message);
  }
});

/**
 * Client-facing refund / returned-payment notice, sent only once the money has
 * really gone back to the client: a Stripe refund (INVOICE_PAYMENT_REVERSED with
 * kind 'refund'), or a dispute that closed as lost (INVOICE_PAYMENT_DISPUTE_LOST).
 * A dispute that has only opened is not one: its outcome is unknown, and if the
 * firm wins it the money stays with the firm. Every billing recipient the invoice
 * was issued to is emailed, gated by the firm's `clientPaymentEmails` setting.
 * Isolated from the firm in-app alert below so a send failure never affects the
 * firm notification.
 *
 * Addresses come from the invoice's frozen bill-to snapshot, so a company's
 * whole accounts-payable list learns the money came back, and the notice goes
 * to whoever was billed rather than to whoever is on the roster today.
 */
async function emailClientPaymentReturned({ lawFirmId, invoiceId, contextType, entityId, amountCents, reason }: any) {
  if (!lawFirmId || !contextType || !entityId) return;

  const settings = await getFirmBillingSettings(lawFirmId);
  if (!settings.clientPaymentEmails) return;

  const invoice = await invoicesRepo
    .findById({ type: contextType, lawFirmId, entityId }, invoiceId)
    .catch(() => null);
  if (!invoice) return;

  const recipients = await resolveInvoiceRecipients({ lawFirmId, invoice }).catch(() => null);
  const to = recipients?.emails?.length
    ? recipients.emails
    : (invoice.billingEmail ? [invoice.billingEmail] : []);
  if (to.length === 0) return;

  const firm = await lawfirmsRepo.findById(lawFirmId);

  await sendPaymentRefundedEmail({
    to,
    recipientName: invoice?.clientName || null,
    lawFirmName: firm?.name || null,
    invoiceNumber: invoice?.invoiceName || invoiceId,
    amountCents,
    reason,
  });
}

eventBus.on(INVOICE_PAYMENT_REVERSED, async ({ lawFirmId, invoiceId, contextType, entityId, reversedCents, kind }: any) => {
  try {
    if (kind !== 'refund') return;
    await emailClientPaymentReturned({ lawFirmId, invoiceId, contextType, entityId, amountCents: reversedCents, reason: 'refund' });
  } catch (err: any) {
    console.error('[stripe.events] INVOICE_PAYMENT_REVERSED client email error:', err.message);
  }
});

eventBus.on(INVOICE_PAYMENT_DISPUTE_LOST, async ({ lawFirmId, invoiceId, contextType, entityId, amountCents }: any) => {
  try {
    await emailClientPaymentReturned({ lawFirmId, invoiceId, contextType, entityId, amountCents, reason: 'dispute' });
  } catch (err: any) {
    console.error('[stripe.events] INVOICE_PAYMENT_DISPUTE_LOST client email error:', err.message);
  }
});

/**
 * When a payment request is sent via Stripe, no additional notification needed
 * (the firm member who triggered it already sees the confirmation in-app).
 * This hook is reserved for future use (e.g., audit log, Slack integration).
 */
eventBus.on(INVOICE_PAYMENT_REQUESTED, async ({ lawFirmId, invoiceId, actingUserId }: any) => {
  // No-op: payment request email to client is sent synchronously in stripe.service.js
  // Add Slack / webhook integrations here in the future if needed.
  void { lawFirmId, invoiceId, actingUserId };
});

/**
 * A recorded card/ACH invoice payment was reversed by Stripe (refund or dispute),
 * so the invoice's balance is open again. Alert the firm's invoice managers (owners
 * + anyone who can manage invoices or record payments) in-app so they can re-collect
 * or write it off. Mirrors the un-muteable trust reversal alert (no category).
 */
eventBus.on(INVOICE_PAYMENT_REVERSED, async ({ lawFirmId, invoiceId, contextType, entityId, reversedCents, kind }: any) => {
  try {
    if (!lawFirmId) return;
    const { rows } = await stripeSql(
      `select distinct m.user_id
         from members m
         left join roles r on r.law_firm_id = m.law_firm_id and r.id = m.role_id
        where m.law_firm_id = $1
          and (m.is_owner = true
               or 'billing.manageInvoices' = any(coalesce(r.permissions, '{}'))
               or 'billing.recordPayments' = any(coalesce(r.permissions, '{}')))`,
      [lawFirmId],
    );
    const recipients = rows.map((x: any) => x.user_id).filter(Boolean);
    if (!recipients.length) return;

    let invoiceNumber = invoiceId;
    if (contextType && entityId) {
      const invoice = await invoicesRepo.findById({ type: contextType, lawFirmId, entityId }, invoiceId).catch(() => null);
      if (invoice?.invoiceName) invoiceNumber = invoice.invoiceName;
    }

    const cause = kind === 'dispute' ? 'disputed' : 'refunded';
    await createNotifications(lawFirmId, recipients, {
      // entityType 'invoice' is allowed by the notifications table CHECK, and the
      // reversed payment's subject is an invoice.
      type: 'invoice_payment_reversed',
      title: 'Invoice payment reversed',
      entityType: 'invoice',
      entityId: invoiceId,
      body: `A ${formatDollarsFromCents(reversedCents)} payment on invoice ${invoiceNumber} was ${cause} in Stripe. `
        + `The invoice balance is open again : review and re-collect or write it off.`,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/billing`,
    });
  } catch (err: any) {
    console.error('[stripe.events] INVOICE_PAYMENT_REVERSED handler error:', err.message);
  }
});

/**
 * A previously-reversed invoice payment was restored because a dispute was WON, so
 * the invoice is paid again. Let the firm's invoice managers know (good news, but
 * they may have already re-collected or written it off, so it needs surfacing).
 */
eventBus.on(INVOICE_PAYMENT_RECREDITED, async ({ lawFirmId, invoiceId, contextType, entityId, restoredCents }: any) => {
  try {
    if (!lawFirmId) return;
    const { rows } = await stripeSql(
      `select distinct m.user_id
         from members m
         left join roles r on r.law_firm_id = m.law_firm_id and r.id = m.role_id
        where m.law_firm_id = $1
          and (m.is_owner = true
               or 'billing.manageInvoices' = any(coalesce(r.permissions, '{}'))
               or 'billing.recordPayments' = any(coalesce(r.permissions, '{}')))`,
      [lawFirmId],
    );
    const recipients = rows.map((x: any) => x.user_id).filter(Boolean);
    if (!recipients.length) return;

    let invoiceNumber = invoiceId;
    if (contextType && entityId) {
      const invoice = await invoicesRepo.findById({ type: contextType, lawFirmId, entityId }, invoiceId).catch(() => null);
      if (invoice?.invoiceName) invoiceNumber = invoice.invoiceName;
    }

    await createNotifications(lawFirmId, recipients, {
      type: 'invoice_payment_recredited',
      title: 'Disputed payment won',
      entityType: 'invoice',
      entityId: invoiceId,
      body: `A dispute was won and ${formatDollarsFromCents(restoredCents)} was restored to invoice ${invoiceNumber}. `
        + `The invoice is paid again. If you already re-collected or wrote it off, reconcile it.`,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/billing`,
    });
  } catch (err: any) {
    console.error('[stripe.events] INVOICE_PAYMENT_RECREDITED handler error:', err.message);
  }
});

// This module only registers listeners; it exports nothing. The empty
// export marks it as a MODULE so its top-level consts are file-scoped
// rather than colliding in the global scope with every other events file.
export {};
