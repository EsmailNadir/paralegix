const eventBus = require('../../shared/events/eventBus');
const { firmZone } = require('../../shared/utils/personalDay');
const { localDateFor } = require('../../shared/utils/localTime');
const {
  CLIENT_DELETED,
  INVOICE_PAYMENT_RECEIVED,
  INVOICE_CREDIT_NOTE_ADDED,
} = require('../../shared/events/eventTypes');
const { financialRootSql, financialSql, withDrizzleTransaction } = require('../../shared/database/financialQuery');
const { resolveContext } = require('./context');
const invoicesService = require('./invoices/invoices.service');
const invoicesRepo = require('./invoices/invoices.repository');
const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const { getFirmBillingSettings } = require('./shared/billingSettings');
const { toCents, formatDollarsFromCents } = require('./shared/money');
const { createNotifications, FRONTEND_URL } = require('../notifications/notifications.service');
const { sendPaymentReceiptEmail, sendPaymentOnVoidedInvoiceEmail } = require('../../shared/services/emailService');
const { resolveInvoiceRecipients } = require('./shared/billingRecipientSnapshot.service');
const { RECEIPT_FEE_LABEL } = require('../stripe/cardFeeCopy');

/**
 * TIME_ENTRY_CHANGED no longer updates a member's totalHours: that value is now
 * derived (matter_members JOIN activities SUM) at read time.
 *
 * MATTER_DELETED billing cleanup is handled by the database: activities /
 * flat_fees / invoices all CASCADE on the matter's composite (law_firm_id, matter_id)
 * FK, so no application-level subcollection deletion is needed.
 *
 * On CLIENT_DELETED, client-context billing rows likewise CASCADE via the
 * clients FK; we still emit external-calendar deletes for the client's invoices
 * (best-effort; effective once the calendar module is ported to Postgres).
 */
eventBus.on(CLIENT_DELETED, async ({ lawFirmId, clientId, userId }: any) => {
  try {
    const context = resolveContext({ lawFirmId, matterId: undefined, clientId });
    await invoicesService.emitCalendarDeletesForInvoicesInContext({
      lawFirmId,
      context,
      actingUserId: userId || null,
    });
  } catch (err: any) {
    console.error('billing.events: client invoice calendar purge failed:', err?.message || err);
  }
});

/**
 * Client-facing payment receipt. On every applied payment (partial or full),
 * email every billing recipient the invoice was issued to, gated by the firm's
 * `clientPaymentEmails` setting (default ON). Firm-side notifications are handled
 * separately (notifications.events / stripe.events) and are NOT gated by this
 * setting. Isolated + best-effort: a missing address or send failure is swallowed.
 *
 * The address list comes from the invoice's frozen bill-to snapshot, so a
 * company's whole accounts-payable list is receipted rather than one address,
 * and a roster change after billing does not redirect the receipt for a payment
 * on an older invoice. `billingEmail` on the event payload is the pre-snapshot
 * fallback for the case where the invoice can no longer be read.
 *
 * A payment that lands on a voided invoice gets a neutral notice instead of the
 * receipt: the bill is no longer payable, so "paid in full" or a balance would
 * mislead, and the firm follows up about the funds.
 */
eventBus.on(INVOICE_PAYMENT_RECEIVED, async ({
  lawFirmId, invoiceId, contextType, entityId, amountPaidCents, surchargeCents, isFullyPaid, billingEmail, paymentDate, invoiceVoided,
  paymentMethod,
}: any) => {
  try {
    if (!lawFirmId) return;

    const settings = await getFirmBillingSettings(lawFirmId);
    if (!settings.clientPaymentEmails) return;

    // Best-effort read for the remaining balance, invoice number, and client name.
    let invoice = null;
    if (contextType && entityId) {
      invoice = await invoicesRepo
        .findById({ type: contextType, lawFirmId, entityId }, invoiceId)
        .catch(() => null);
    }

    const recipients = invoice
      ? (await resolveInvoiceRecipients({ lawFirmId, invoice }).catch(() => null))?.emails || []
      : [];
    const to = recipients.length ? recipients : (billingEmail ? [billingEmail] : []);
    if (to.length === 0) return;

    // Work in integer cents (consistent with the rest of the billing module) and
    // floor at 0 so an overpaid invoice never shows a negative remaining balance.
    const remainingBalanceCents = invoice
      ? Math.max(0, toCents(invoice.totalAmount || 0) - toCents(invoice.amountPaid || 0) - toCents(invoice.totalWrittenOff || 0))
      : (isFullyPaid ? 0 : null);

    const firm = await lawfirmsRepo.findById(lawFirmId);

    if (invoiceVoided === true || invoice?.status === 'voided') {
      await sendPaymentOnVoidedInvoiceEmail({
        to,
        recipientName: invoice?.clientName || null,
        lawFirmName: firm?.name || null,
        invoiceNumber: invoice?.invoiceName || invoiceId,
        amountPaidCents,
      });
      return;
    }

    await sendPaymentReceiptEmail({
      to,
      recipientName: invoice?.clientName || null,
      lawFirmName: firm?.name || null,
      invoiceNumber: invoice?.invoiceName || invoiceId,
      amountPaidCents,
      processingFeeCents: surchargeCents || 0,
      processingFeeLabel: RECEIPT_FEE_LABEL[paymentMethod === 'bank' ? 'bank' : 'card'],
      remainingBalanceCents,
      // The payment's own recorded day. Only an event without one (none are
      // emitted that way now) falls back to the firm's today.
      paymentDate: paymentDate || localDateFor(await firmZone(lawFirmId)),
    });
  } catch (err: any) {
    console.error('billing.events: client payment receipt email failed:', err?.message || err);
  }
});

/**
 * A credit note / write-off was recorded against an invoice. Notify the firm's
 * invoice managers (owners + `billing.manageInvoices` / `billing.recordPayments`)
 * in-app so a reduced collectible balance is not missed. Best-effort + isolated.
 */
eventBus.on(INVOICE_CREDIT_NOTE_ADDED, async ({
  lawFirmId, invoiceId, matterId, amountCents, invoiceName, actorUserId,
}: any) => {
  try {
    if (!lawFirmId || !invoiceId) return;
    const { rows } = await financialRootSql(
      `select distinct m.user_id
         from members m
         left join roles r on r.law_firm_id = m.law_firm_id and r.id = m.role_id
        where m.law_firm_id = $1
          and (m.is_owner = true
               or 'billing.manageInvoices' = any(coalesce(r.permissions, '{}'))
               or 'billing.recordPayments' = any(coalesce(r.permissions, '{}')))`,
      [lawFirmId],
    );
    const recipients = Array.from(new Set(rows.map((x: any) => x.user_id).filter(Boolean)))
      .filter((id) => id !== actorUserId);
    if (!recipients.length) return;

    const label = invoiceName ? `Invoice ${invoiceName}` : 'an invoice';
    await createNotifications(lawFirmId, recipients, {
      type: 'invoice_credit_note_added',
      title: 'Credit note added',
      entityType: 'invoice',
      entityId: invoiceId,
      matterId: matterId || null,
      body: `A ${formatDollarsFromCents(amountCents)} credit note was recorded on ${label}, reducing its collectible balance.`,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/billing`,
      createdBy: actorUserId || null,
    });
  } catch (err: any) {
    console.error('billing.events: credit-note notification failed:', err?.message || err);
  }
});

/**
 * A Stripe payment left money on an invoice the firm owes back: it landed after
 * the invoice was voided, or it pushed the amount paid past the total. The
 * payment stays on the invoice (a Stripe refund matches back through that
 * record), so this tells the firm's invoice managers (owner plus
 * `billing.manageInvoices`) to refund it. Keyed on the Stripe payment so a
 * redelivered event never raises a second notice for the same money.
 */
eventBus.on(INVOICE_PAYMENT_RECEIVED, async ({
  lawFirmId, invoiceId, contextType, entityId, matterId, source, refundDue, invoiceName, stripePaymentRef,
}: any) => {
  try {
    if (!lawFirmId || !invoiceId || source !== 'stripe' || !refundDue?.amountCents) return;
    const { rows } = await financialRootSql(
      `select distinct m.user_id
         from members m
         left join roles r on r.law_firm_id = m.law_firm_id and r.id = m.role_id
        where m.law_firm_id = $1
          and (m.is_owner = true
               or 'billing.manageInvoices' = any(coalesce(r.permissions, '{}')))`,
      [lawFirmId],
    );
    const recipients = Array.from(new Set(rows.map((x: any) => x.user_id).filter(Boolean))) as string[];
    if (!recipients.length) return;

    const label = invoiceName ? `Invoice ${invoiceName}` : 'an invoice';
    const reasonText = refundDue.reason === 'voided'
      ? 'received after the invoice was voided'
      : 'exceeds the invoice total';
    await createNotifications(lawFirmId, recipients, {
      type: 'payment_refund_due',
      title: 'Refund due',
      body: `${formatDollarsFromCents(refundDue.amountCents)} on ${label} is due back to the client: the payment was ${reasonText}.`,
      entityType: 'invoice',
      entityId: invoiceId,
      matterId: matterId || null,
      actionUrl: contextType && entityId
        ? `${FRONTEND_URL}/lawfirm/${lawFirmId}/${contextType === 'matter' ? 'matters' : 'clients'}/${entityId}/invoices/${invoiceId}`
        : `${FRONTEND_URL}/lawfirm/${lawFirmId}/billing`,
      dedupeKey: `payment_refund_due:${invoiceId}:${stripePaymentRef || 'unknown'}`,
    });
  } catch (err: any) {
    console.error('billing.events: refund-due notification failed:', err?.message || err);
  }
});

// This module only registers listeners; it exports nothing. The empty
// export marks it as a MODULE so its top-level consts are file-scoped
// rather than colliding in the global scope with every other events file.
export {};
