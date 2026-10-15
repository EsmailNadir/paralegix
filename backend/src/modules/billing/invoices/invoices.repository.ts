/**
 * Invoices repository (Postgres, fully relational).
 *
 * The invoice is no longer a jsonb document. Every scalar lives in an `invoices`
 * column; the repeating groups live in child tables:
 *   - line items (timeEntries / flatFees / expenses) -> invoice_line_items
 *   - payments[]                                      -> invoice_payments
 *   - paymentPlan.expectedPayments[]                  -> invoice_expected_payments
 *   - creditNotes[]                                   -> invoice_adjustments (direction = 'credit')
 *   - amountAdjustmentNotes[]                         -> invoice_adjustments (direction = 'charge')
 *
 * The public surface still returns the SAME camelCase invoice object the old
 * Firestore/doc repo returned (invoiceName, timeEntries, payments,
 * paymentPlan.expectedPayments, creditNotes, all scalars, timestamps as ISO
 * strings) so invoices.service / billing / stripe keep working unchanged.
 *
 * create / findById / findByContext / listAll / findByInvoiceName / update /
 * delete plus listStripeCandidateInvoices / findUnpaidByDue (which return
 * {invoice,context}).
 */

const { financialRootSql, financialSql, rootQueryExecutor, withDrizzleTransaction } = require('../../../shared/database/financialQuery');
const crypto = require('crypto');
const { isUuid } = require('../../../shared/utils/isUuid');
// Date columns keep the day a string was written with; a bare day read as an
// instant takes its noon-UTC anchor.
const { toDateOnlyOrNull, toInstant } = require('../../../shared/utils/time');
const { timestamptzArray } = require('../../../shared/database/postgresValues');
const calendarSyncRepo = require('../../calendar/shared/calendarSync.repository');
const { toNum, toCents, fromCents, toCentsOrNull, fromCentsOrNull } = require('../shared/money');
const { deriveInvoiceStatus } = require('../shared/invoiceStatus');
const { ValidationError } = require('../../../shared/errors/AppError');

/* ------------------------------------------------------------------ */
/*  value coercion (canonical helpers from shared/money.js)            */
/* ------------------------------------------------------------------ */

// Aliases kept so the rest of this module reads unchanged. `toCents`/`fromCents`
// (0-for-empty) and `toCentsOrNull`/`fromCentsOrNull` (null-for-empty) live in
// shared/money.js; semantics are identical to the former locals.
const centsOf = toCents;
const centsOrNull = toCentsOrNull;
const dollars = fromCents;
const dollarsOrNull = fromCentsOrNull;

/** Any Date/Timestamp/ISO -> ISO string (or null). Stored timestamps are ISO. */
function toIso(v: any) {
  if (!v) return null;
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v.toDate === 'function') { const d = v.toDate(); return d ? d.toISOString() : null; }
  return null;
}



/** A pg `date` column value (Date or string) -> 'YYYY-MM-DD' ISO string, or null. */
function dateColToIso(v: any) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function tstzToIso(v: any) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return new Date(v).toISOString();
}

const SOURCES_MISSING_MESSAGE = 'One or more selected items do not exist';

// A recurring-plan invoice carries its retainer fee as a flat-fee line whose
// source id names the billing plan period it bills, `plan-<planId>-<periodStart>`
// (a period is addressed by its start date). That id points at a
// billing_plan_periods row, not at an activity.
const PLAN_FEE_SOURCE_RE = /^plan-([0-9a-f-]{36})-(\d{4}-\d{2}-\d{2})$/i;

function contextCol(context: any) {
  return context.type === 'matter'
    ? { col: 'matter_id', other: 'client_context_id' }
    : { col: 'client_context_id', other: 'matter_id' };
}

function rowContext(row: any) {
  return row.matter_id
    ? { lawFirmId: row.law_firm_id, type: 'matter', entityId: row.matter_id }
    : { lawFirmId: row.law_firm_id, type: 'client', entityId: row.client_context_id };
}

/* ------------------------------------------------------------------ */
/*  doc (camelCase) -> relational                                      */
/* ------------------------------------------------------------------ */

function lineToColumns(item: any, kind: any, sortOrder: any, lawFirmId: string, invoiceId: string) {
  return {
    invoice_id: invoiceId,
    law_firm_id: lawFirmId,
    kind,
    sort_order: sortOrder,
    source_id: item.id != null ? String(item.id) : null,
    name: item.name ?? null,
    description: item.description ?? null,
    line_date: toDateOnlyOrNull(item.date),
    quantity: item.hours != null ? toNum(item.hours) : null,
    rate_cents: item.rate != null ? centsOrNull(item.rate) : null,
    amount_cents: centsOf(item.amount),
    user_id: item.userId ?? null,
    user_name: item.userName ?? null,
    charge_code_id: isUuid(item.chargeCodeId) ? item.chargeCodeId : null,
    allocation_percent: item.allocationPercent != null ? toNum(item.allocationPercent) : null,
    allocation_amount_cents: item.allocationAmount != null ? centsOrNull(item.allocationAmount) : null,
    // LEDES 1998B UTBMS codes (read by name in ledesExport.service).
    utbms_task_code: item.utbmsTaskCode ?? null,
    utbms_activity_code: item.utbmsActivityCode ?? null,
  };
}

function lineRowToItem(row: any) {
  const out: Record<string, any> = {};
  if (row.source_id != null) out.id = row.source_id;
  if (row.name != null) out.name = row.name;
  if (row.description != null) out.description = row.description;
  if (row.line_date != null) out.date = row.line_date;
  if (row.quantity != null) out.hours = Number(row.quantity);
  if (row.rate_cents != null) out.rate = dollars(row.rate_cents);
  out.amount = dollars(row.amount_cents);
  if (row.user_id != null) out.userId = row.user_id;
  if (row.user_name != null) out.userName = row.user_name;
  if (row.charge_code_id != null) out.chargeCodeId = row.charge_code_id;
  if (row.allocation_percent != null) out.allocationPercent = Number(row.allocation_percent);
  if (row.allocation_amount_cents != null) out.allocationAmount = dollars(row.allocation_amount_cents);
  if (row.utbms_task_code != null) out.utbmsTaskCode = row.utbms_task_code;
  if (row.utbms_activity_code != null) out.utbmsActivityCode = row.utbms_activity_code;
  return out;
}

function paymentToColumns(p: any, sortOrder: any, lawFirmId: string, invoiceId: string) {
  return {
    // The id a payment was read back with is written back, so a payment keeps the
    // same id across every rewrite of the invoice's payment list and callers can
    // address it by id instead of by position. A new payment gets a fresh one.
    id: isUuid(p.id) ? p.id : crypto.randomUUID(),
    invoice_id: invoiceId,
    law_firm_id: lawFirmId,
    sort_order: sortOrder,
    amount_cents: centsOf(p.amount),
    payment_date: toDateOnlyOrNull(p.date),
    payment_source: p.paymentSource ?? null,
    note: p.note ?? null,
    recorded_by: p.recordedBy ?? null,
    invoice_number: p.invoiceNumber ?? null,
    trust_transaction_id: isUuid(p.trustTransactionId) ? p.trustTransactionId : null,
    trust_account_id: isUuid(p.trustAccountId) ? p.trustAccountId : null,
    stripe_session_id: p.stripeSessionId ?? null,
    stripe_invoice_id: p.stripeInvoiceId ?? null,
    stripe_payment_intent_id: p.stripePaymentIntentId ?? null,
    stripe_refunded_cents: Number.isInteger(p.stripeRefundedCents) ? p.stripeRefundedCents : 0,
    stripe_disputed_cents: Number.isInteger(p.stripeDisputedCents) ? p.stripeDisputedCents : 0,
    surcharge_cents: Number.isInteger(p.surchargeCents) && p.surchargeCents > 0 ? p.surchargeCents : 0,
    surcharge_refunded_cents: Number.isInteger(p.surchargeRefundedCents) ? p.surchargeRefundedCents : 0,
    surcharge_disputed_cents: Number.isInteger(p.surchargeDisputedCents) ? p.surchargeDisputedCents : 0,
    charge_model: p.chargeModel === 'direct' ? 'direct' : 'destination',
  };
}

function paymentRowToObj(row: any) {
  const out: any = { id: row.id, amount: dollars(row.amount_cents) };
  if (row.payment_date != null) out.date = row.payment_date;
  if (row.payment_source != null) out.paymentSource = row.payment_source;
  if (row.note != null) out.note = row.note;
  if (row.recorded_by != null) out.recordedBy = row.recorded_by;
  if (row.invoice_number != null) out.invoiceNumber = row.invoice_number;
  if (row.trust_transaction_id != null) out.trustTransactionId = row.trust_transaction_id;
  if (row.trust_account_id != null) out.trustAccountId = row.trust_account_id;
  if (row.stripe_session_id != null) out.stripeSessionId = row.stripe_session_id;
  if (row.stripe_invoice_id != null) out.stripeInvoiceId = row.stripe_invoice_id;
  if (row.stripe_payment_intent_id != null) out.stripePaymentIntentId = row.stripe_payment_intent_id;
  if (row.stripe_refunded_cents != null && Number(row.stripe_refunded_cents) > 0) {
    out.stripeRefundedCents = Number(row.stripe_refunded_cents);
  }
  if (row.stripe_disputed_cents != null && Number(row.stripe_disputed_cents) > 0) {
    out.stripeDisputedCents = Number(row.stripe_disputed_cents);
  }
  if (row.surcharge_cents != null && Number(row.surcharge_cents) > 0) {
    out.surchargeCents = Number(row.surcharge_cents);
  }
  if (row.surcharge_refunded_cents != null && Number(row.surcharge_refunded_cents) > 0) {
    out.surchargeRefundedCents = Number(row.surcharge_refunded_cents);
  }
  if (row.surcharge_disputed_cents != null && Number(row.surcharge_disputed_cents) > 0) {
    out.surchargeDisputedCents = Number(row.surcharge_disputed_cents);
  }
  // Read back so a rewrite of the invoice's payments keeps it.
  if (row.charge_model === 'direct') out.chargeModel = 'direct';
  return out;
}

function expectedToColumns(e: any, sortOrder: any, lawFirmId: string, invoiceId: string) {
  return {
    invoice_id: invoiceId,
    law_firm_id: lawFirmId,
    sort_order: sortOrder,
    installment_id: e.id != null ? String(e.id) : null,
    due_date: toDateOnlyOrNull(e.dueDate),
    amount_cents: centsOf(e.amount),
    status: e.status || 'pending',
    matched_payment_index: typeof e.matchedPaymentIndex === 'number' ? e.matchedPaymentIndex : null,
    is_down_payment: Boolean(e.isDownPayment),
    pre_due_reminder_sent_at: e.preDueReminderSentAt ? new Date(e.preDueReminderSentAt) : null,
    stripe_invoice_id: e.stripeInvoiceId ?? null,
    stripe_invoice_account_id: e.stripeInvoiceAccountId ?? null,
    stripe_payment_status: e.stripePaymentStatus ?? null,
  };
}

function expectedRowToObj(row: any) {
  const out: any = {
    amount: dollars(row.amount_cents),
    status: row.status,
  };
  if (row.installment_id != null) out.id = row.installment_id;
  if (row.due_date != null) out.dueDate = row.due_date;
  out.matchedPaymentIndex = row.matched_payment_index;
  if (row.is_down_payment) out.isDownPayment = true;
  if (row.pre_due_reminder_sent_at != null) out.preDueReminderSentAt = tstzToIso(row.pre_due_reminder_sent_at);
  if (row.stripe_invoice_id != null) out.stripeInvoiceId = row.stripe_invoice_id;
  if (row.stripe_invoice_account_id != null) out.stripeInvoiceAccountId = row.stripe_invoice_account_id;
  if (row.stripe_payment_status != null) out.stripePaymentStatus = row.stripe_payment_status;
  return out;
}

// Both arrays live in `invoice_adjustments` since migration 0230, told apart by
// `direction`. The API shapes are unchanged: a credit note still reads
// `id` / `type` / `description` / `createdBy` / `createdAt`, an amount
// adjustment still reads `kind` / `note` / `addedBy` / `addedAt`.
function creditToColumns(c: any, sortOrder: any, lawFirmId: string, invoiceId: string) {
  return {
    invoice_id: invoiceId,
    law_firm_id: lawFirmId,
    direction: 'credit',
    sort_order: sortOrder,
    external_id: c.id != null ? String(c.id) : null,
    amount_cents: centsOf(c.amount),
    description: c.description ?? null,
    kind: c.type ?? null,
    created_by: c.createdBy ?? null,
    created_at: c.createdAt ? new Date(c.createdAt) : new Date(),
  };
}

function creditRowToObj(row: any) {
  const out: any = { amount: dollars(row.amount_cents) };
  if (row.external_id != null) out.id = row.external_id;
  if (row.description != null) out.description = row.description;
  if (row.kind != null) out.type = row.kind;
  if (row.created_by != null) out.createdBy = row.created_by;
  out.createdAt = tstzToIso(row.created_at);
  return out;
}

function adjustmentToColumns(a: any, sortOrder: any, lawFirmId: string, invoiceId: string) {
  return {
    invoice_id: invoiceId,
    law_firm_id: lawFirmId,
    direction: 'charge',
    sort_order: sortOrder,
    amount_cents: centsOf(a.amount),
    description: a.note ?? null,
    kind: a.kind ?? null,
    created_by: a.addedBy ?? null,
    created_at: a.addedAt ? new Date(a.addedAt) : new Date(),
  };
}

function adjustmentRowToObj(row: any) {
  return {
    amount: dollars(row.amount_cents),
    note: row.description ?? null,
    kind: row.kind ?? null,
    addedBy: row.created_by ?? null,
    addedAt: tstzToIso(row.created_at),
  };
}

/**
 * Map the merged camelCase doc to the `invoices` scalar columns.
 * `partial` controls whether unspecified keys are skipped (update) or written
 * with their default (create). For create we pass the full doc; for update we
 * only build columns for keys present in `data`.
 */
function scalarColumns(doc: any, context: any, { isCreate }: any) {
  const cols: Record<string, any> = {};
  const set = (key: any, present: any, value: any) => { if (isCreate || present) cols[key] = value; };
  const has = (k: any) => Object.prototype.hasOwnProperty.call(doc, k);

  if (isCreate) {
    const { col, other } = contextCol(context);
    cols.law_firm_id = context.lawFirmId;
    cols[col] = isUuid(context.entityId) ? context.entityId : null;
    cols[other] = null;
  }

  set('context_type', has('contextType'), doc.contextType ?? (isCreate ? context.type : undefined));
  set('invoice_name', has('invoiceName'), doc.invoiceName ?? null);
  // Invoice names and invoice numbers are independent fields. A name edit must
  // never silently re-key an invoice that may already be referenced by a client.
  set('invoice_number', has('invoiceNumber'), doc.invoiceNumber ?? '');
  set('invoice_date', has('invoiceDate'), toDateOnlyOrNull(doc.invoiceDate));
  set('due_date', has('dueDate'), toDateOnlyOrNull(doc.dueDate));
  set('billing_email', has('billingEmail'), doc.billingEmail ?? null);
  set('notes', has('notes'), doc.notes ?? null);
  set('client_id', has('clientId'), isUuid(doc.clientId) ? doc.clientId : null);
  set('client_name', has('clientName'), doc.clientName ?? null);
  set('client_email', has('clientEmail'), doc.clientEmail ?? null);
  set('matter_client_id', has('matterClientId'), isUuid(doc.matterClientId) ? doc.matterClientId : null);

  // remitTo: string OR {name,address,city,state,zip}
  if (isCreate || has('remitTo')) {
    const rt = doc.remitTo;
    if (rt && typeof rt === 'object') {
      cols.remit_to = null;
      cols.remit_to_name = rt.name ?? null;
      cols.remit_to_address = rt.address ?? null;
      cols.remit_to_city = rt.city ?? null;
      cols.remit_to_state = rt.state ?? null;
      cols.remit_to_zip = rt.zip ?? null;
    } else {
      cols.remit_to = rt ?? null;
      cols.remit_to_name = null;
      cols.remit_to_address = null;
      cols.remit_to_city = null;
      cols.remit_to_state = null;
      cols.remit_to_zip = null;
    }
  }

  // Billing recipient / bill-to snapshot, frozen at first external issue
  // (organization-clients plan). Nullable/empty pass-through for now - no
  // caller sets these yet, including on draft creation; the snapshot-taking
  // logic that populates them is a later phase.
  set('billing_emails', has('billingEmails'), Array.isArray(doc.billingEmails) ? doc.billingEmails : []);
  set('billing_contact_name', has('billingContactName'), doc.billingContactName ?? null);
  set('billing_contact_title', has('billingContactTitle'), doc.billingContactTitle ?? null);
  set('billing_contact_email', has('billingContactEmail'), doc.billingContactEmail ?? null);
  set('billing_client_address', has('billingClientAddress'), doc.billingClientAddress ?? null);
  set('billing_client_name', has('billingClientName'), doc.billingClientName ?? null);
  set('billing_snapshot_at', has('billingSnapshotAt'), doc.billingSnapshotAt ? toIso(doc.billingSnapshotAt) : null);

  set('total_hours', has('totalHours'), doc.totalHours != null ? toNum(doc.totalHours) : null);
  set('total_cents', has('totalAmount'), centsOf(doc.totalAmount));
  set('flat_fees_amount_cents', has('flatFeesAmount'), centsOf(doc.flatFeesAmount));
  set('tax_rate', has('taxRate'), doc.taxRate != null ? toNum(doc.taxRate) : null);
  set('tax_cents', has('taxCents'), doc.taxCents != null ? Number(doc.taxCents) : (isCreate ? 0 : undefined));
  set('amount_paid_cents', has('amountPaid'), centsOf(doc.amountPaid));
  set('total_written_off_cents', has('totalWrittenOff'), centsOf(doc.totalWrittenOff));
  set('is_paid', has('isPaid'), Boolean(doc.isPaid));
  set('status', has('status'), doc.status || (isCreate ? 'draft' : undefined));
  // A bare day ('YYYY-MM-DD', as the Stripe path sends) is stored at its noon-UTC
  // anchor, as a manual payment's is; `toIso` made it UTC midnight.
  set('paid_date', has('paidDate'), doc.paidDate ? (toInstant(doc.paidDate)?.toISOString() ?? null) : null);
  set('next_payment_date', has('nextPaymentDate'), toDateOnlyOrNull(doc.nextPaymentDate));

  set('billing_plan_id', has('billingPlanId'), isUuid(doc.billingPlanId) ? doc.billingPlanId : null);
  set('billing_plan_period_id', has('billingPlanPeriodId'), isUuid(doc.billingPlanPeriodId) ? doc.billingPlanPeriodId : null);
  set('billing_plan_name', has('billingPlanName'), doc.billingPlanName ?? null);
  set('billing_plan_type', has('billingPlanType'), doc.billingPlanType ?? null);
  set('is_recurring_retainer', has('isRecurringRetainer'), Boolean(doc.isRecurringRetainer));

  set('split_group_id', has('splitGroupId'), isUuid(doc.splitGroupId) ? doc.splitGroupId : null);
  set('split_mode', has('splitMode'), doc.splitMode ?? null);
  set('split_recipient_count', has('splitRecipientCount'), doc.splitRecipientCount ?? null);
  set('split_share_cents', has('splitShareAmount'), centsOrNull(doc.splitShareAmount));
  set('split_share_percent', has('splitSharePercent'), doc.splitSharePercent != null ? toNum(doc.splitSharePercent) : null);

  set('stripe_invoice_id', has('stripeInvoiceId'), doc.stripeInvoiceId ?? null);
  set('stripe_invoice_account_id', has('stripeInvoiceAccountId'), doc.stripeInvoiceAccountId ?? null);
  set('stripe_checkout_session_id', has('stripeCheckoutSessionId'), doc.stripeCheckoutSessionId ?? null);
  set('stripe_checkout_session_account_id', has('stripeCheckoutSessionAccountId'), doc.stripeCheckoutSessionAccountId ?? null);
  set('stripe_payment_intent_id', has('stripePaymentIntentId'), doc.stripePaymentIntentId ?? null);
  set('stripe_card_payment_intent_id', has('stripeCardPaymentIntentId'), doc.stripeCardPaymentIntentId ?? null);
  set('stripe_card_payment_intent_account_id', has('stripeCardPaymentIntentAccountId'),
    doc.stripeCardPaymentIntentAccountId ?? null);
  set('stripe_payment_status', has('stripePaymentStatus'), doc.stripePaymentStatus ?? null);
  set('stripe_payment_requested', has('stripePaymentRequested'), Boolean(doc.stripePaymentRequested));
  set('is_card_fee_passed_on', has('isCardFeePassedOn'), doc.isCardFeePassedOn === true);
  set('is_bank_fee_passed_on', has('isBankFeePassedOn'), doc.isBankFeePassedOn === true);
  set('pay_link_token', has('payLinkToken'), typeof doc.payLinkToken === 'string' ? doc.payLinkToken : null);
  set('pay_link_installment_id', has('payLinkInstallmentId'),
    typeof doc.payLinkInstallmentId === 'string' && doc.payLinkInstallmentId ? doc.payLinkInstallmentId : null);
  set('stripe_payment_requested_by', has('stripePaymentRequestedBy'),
    typeof doc.stripePaymentRequestedBy === 'string' ? doc.stripePaymentRequestedBy : null);

  set('last_reminder_sent_at', has('lastReminderSentAt'), doc.lastReminderSentAt ? toIso(doc.lastReminderSentAt) : null);
  set('reminder_count', has('reminderCount'), doc.reminderCount != null ? Number(doc.reminderCount) : (isCreate ? 0 : undefined));
  set('reminder_opt_out', has('reminderOptOut'), Boolean(doc.reminderOptOut));
  set('pre_due_reminder_days', has('preDueReminderDays'), doc.preDueReminderDays ?? null);
  set('pre_due_reminder_sent_at', has('preDueReminderSentAt'), doc.preDueReminderSentAt ? toIso(doc.preDueReminderSentAt) : null);
  if (isCreate || has('recentManualReminders')) {
    cols.recent_manual_reminders = (doc.recentManualReminders || []).map((t: any) => new Date(toIso(t) || t));
  }

  set('google_last_modified', has('googleLastModified'), doc.googleLastModified ? toIso(doc.googleLastModified) : null);
  set('outlook_last_modified', has('outlookLastModified'), doc.outlookLastModified ? toIso(doc.outlookLastModified) : null);
  if (has('calendarSync')) cols.calendar_sync = doc.calendarSync == null ? null : JSON.stringify(doc.calendarSync);
  set('last_synced_to_google', has('lastSyncedToGoogle'), doc.lastSyncedToGoogle ? toIso(doc.lastSyncedToGoogle) : null);
  set('last_synced_to_outlook', has('lastSyncedToOutlook'), doc.lastSyncedToOutlook ? toIso(doc.lastSyncedToOutlook) : null);

  // payment plan header (the array part lives in invoice_expected_payments)
  if (isCreate || has('paymentPlan')) {
    const plan = doc.paymentPlan;
    if (plan && typeof plan === 'object') {
      cols.payment_plan_enabled = Boolean(plan.enabled);
      cols.plan_installment_cents = centsOrNull(plan.installmentAmount);
      cols.plan_frequency_days = plan.frequencyDays != null ? Number(plan.frequencyDays) : null;
      cols.plan_start_date = plan.planStartDate ? String(plan.planStartDate).slice(0, 10) : null;
      cols.plan_regular_start_date = plan.regularInstallmentStartDate ? String(plan.regularInstallmentStartDate).slice(0, 10) : null;
      cols.plan_down_payment_cents = centsOrNull(plan.downPaymentAmount);
      cols.plan_pre_reminder_days = plan.preReminderDays != null ? Number(plan.preReminderDays) : null;
    } else {
      cols.payment_plan_enabled = false;
      cols.plan_installment_cents = null;
      cols.plan_frequency_days = null;
      cols.plan_start_date = null;
      cols.plan_regular_start_date = null;
      cols.plan_down_payment_cents = null;
      cols.plan_pre_reminder_days = null;
    }
  }

  if (isCreate || has('createdBy')) set('created_by', true, typeof doc.createdBy === 'string' ? doc.createdBy : null);
  if (isCreate || has('updatedBy')) set('updated_by', true, typeof doc.updatedBy === 'string' ? doc.updatedBy : null);

  return cols;
}

/* ------------------------------------------------------------------ */
/*  relational rows -> doc (camelCase)                                 */
/* ------------------------------------------------------------------ */

function assembleInvoice(row: any, children: any) {
  const {
    lineItems = [], payments = [], expectedPayments = [], creditNotes = [], adjustments = [],
  } = children;

  const timeEntries = lineItems.filter((l: any) => l.kind === 'time_entry').map(lineRowToItem);
  const flatFees = lineItems.filter((l: any) => l.kind === 'flat_fee').map(lineRowToItem);
  const expenses = lineItems.filter((l: any) => l.kind === 'expense').map(lineRowToItem);

  let remitTo = null;
  if (row.remit_to != null) {
    remitTo = row.remit_to;
  } else if (row.remit_to_name || row.remit_to_address || row.remit_to_city || row.remit_to_state || row.remit_to_zip) {
    remitTo = {
      ...(row.remit_to_name ? { name: row.remit_to_name } : {}),
      ...(row.remit_to_address ? { address: row.remit_to_address } : {}),
      ...(row.remit_to_city ? { city: row.remit_to_city } : {}),
      ...(row.remit_to_state ? { state: row.remit_to_state } : {}),
      ...(row.remit_to_zip ? { zip: row.remit_to_zip } : {}),
    };
  }

  let paymentPlan = null;
  if (row.payment_plan_enabled || expectedPayments.length > 0) {
    paymentPlan = {
      enabled: row.payment_plan_enabled,
      installmentAmount: dollarsOrNull(row.plan_installment_cents),
      frequencyDays: row.plan_frequency_days,
      planStartDate: dateColToIso(row.plan_start_date),
      regularInstallmentStartDate: dateColToIso(row.plan_regular_start_date),
      ...(row.plan_down_payment_cents != null ? { downPaymentAmount: dollars(row.plan_down_payment_cents) } : {}),
      ...(row.plan_pre_reminder_days != null ? { preReminderDays: row.plan_pre_reminder_days } : {}),
      expectedPayments: expectedPayments.map(expectedRowToObj),
    };
  }

  const inv: any = {
    id: row.id,
    contextType: row.context_type ?? null,
    entityId: row.matter_id || row.client_context_id || null,
    matterId: row.matter_id || null,
    clientContextId: row.client_context_id || null,
    invoiceName: row.invoice_name ?? null,
    invoiceNumber: row.invoice_number || null,
    invoiceDate: dateColToIso(row.invoice_date),
    dueDate: dateColToIso(row.due_date),
    billingEmail: row.billing_email ?? null,
    notes: row.notes ?? null,
    clientId: row.client_id || null,
    clientName: row.client_name ?? null,
    clientEmail: row.client_email ?? null,
    matterClientId: row.matter_client_id || null,
    // Billing recipient / bill-to snapshot (organization-clients plan). Null/
    // empty pass-through until the snapshot-taking logic (a later phase) ever
    // writes them.
    billingEmails: row.billing_emails || [],
    billingContactName: row.billing_contact_name ?? null,
    billingContactTitle: row.billing_contact_title ?? null,
    billingContactEmail: row.billing_contact_email ?? null,
    billingClientAddress: row.billing_client_address ?? null,
    billingClientName: row.billing_client_name ?? null,
    billingSnapshotAt: tstzToIso(row.billing_snapshot_at),
    remitTo,
    timeEntries,
    flatFees,
    expenses,
    totalHours: row.total_hours != null ? Number(row.total_hours) : 0,
    totalAmount: dollars(row.total_cents),
    flatFeesAmount: dollars(row.flat_fees_amount_cents),
    taxRate: row.tax_rate != null ? Number(row.tax_rate) : null,
    taxCents: Number(row.tax_cents || 0),
    isPaid: row.is_paid,
    status: row.status,
    paidDate: tstzToIso(row.paid_date),
    amountPaid: dollars(row.amount_paid_cents),
    payments: payments.map(paymentRowToObj),
    nextPaymentDate: dateColToIso(row.next_payment_date),
    creditNotes: creditNotes.map(creditRowToObj),
    totalWrittenOff: dollars(row.total_written_off_cents),
    paymentPlan,
    splitGroupId: row.split_group_id || null,
    splitMode: row.split_mode || null,
    splitRecipientCount: row.split_recipient_count ?? null,
    splitShareAmount: dollarsOrNull(row.split_share_cents),
    splitSharePercent: row.split_share_percent != null ? Number(row.split_share_percent) : null,
    billingPlanId: row.billing_plan_id || null,
    billingPlanPeriodId: row.billing_plan_period_id || null,
    billingPlanName: row.billing_plan_name ?? null,
    billingPlanType: row.billing_plan_type ?? null,
    isRecurringRetainer: row.is_recurring_retainer,
    stripeInvoiceId: row.stripe_invoice_id ?? null,
    stripeInvoiceAccountId: row.stripe_invoice_account_id ?? null,
    stripeCheckoutSessionId: row.stripe_checkout_session_id ?? null,
    stripeCheckoutSessionAccountId: row.stripe_checkout_session_account_id ?? null,
    stripePaymentIntentId: row.stripe_payment_intent_id ?? null,
    // A card-form PaymentIntent waiting on the client's bank or on Stripe.
    stripeCardPaymentIntentId: row.stripe_card_payment_intent_id ?? null,
    stripeCardPaymentIntentAccountId: row.stripe_card_payment_intent_account_id ?? null,
    stripePaymentStatus: row.stripe_payment_status ?? null,
    stripePaymentRequested: row.stripe_payment_requested,
    isCardFeePassedOn: row.is_card_fee_passed_on === true,
    isBankFeePassedOn: row.is_bank_fee_passed_on === true,
    // Read by the reminders, which link to the pay page; never sent to a client
    // by the firm API.
    payLinkToken: row.pay_link_token ?? null,
    // The plan row the payment link asks for, by its stable installment_id;
    // null asks for the full balance.
    payLinkInstallmentId: row.pay_link_installment_id ?? null,
    stripePaymentRequestedBy: row.stripe_payment_requested_by ?? null,
    lastReminderSentAt: tstzToIso(row.last_reminder_sent_at),
    reminderCount: row.reminder_count ?? 0,
    reminderOptOut: row.reminder_opt_out,
    preDueReminderDays: row.pre_due_reminder_days ?? null,
    preDueReminderSentAt: tstzToIso(row.pre_due_reminder_sent_at),
    recentManualReminders: timestamptzArray(row.recent_manual_reminders).map((t: any) => tstzToIso(t)),
    googleLastModified: tstzToIso(row.google_last_modified),
    outlookLastModified: tstzToIso(row.outlook_last_modified),
    calendarSync: row.calendar_sync || {},
    lastSyncedToGoogle: tstzToIso(row.last_synced_to_google),
    lastSyncedToOutlook: tstzToIso(row.last_synced_to_outlook),
    createdAt: tstzToIso(row.created_at),
    createdBy: row.created_by ?? null,
    updatedAt: tstzToIso(row.updated_at),
    updatedBy: row.updated_by ?? null,
  };

  if (adjustments.length) inv.amountAdjustmentNotes = adjustments.map(adjustmentRowToObj);

  return inv;
}

/* ------------------------------------------------------------------ */
/*  BL #10: authoritative persisted status                             */
/*                                                                     */
/*  The `status` column is read by SQL that filters it directly:       */
/*  digest.repository.ts and `findUnpaidByDue` below (both test only   */
/*  `'voided'`).                                                       */
/*  (It also used to back the partial index invoices_firm_due_idx,     */
/*  dropped in migration 0195; the two readers above are what keeps    */
/*  this write path justified.) Historically the                       */
/*  app derived status on READ (formatInvoice / mapInvoiceRecord via   */
/*  firmBilling.deriveInvoiceStatus) but only SOME mutation paths wrote */
/*  the column, so it drifted stale and the index covered the wrong    */
/*  rows. We make the column AUTHORITATIVE: after EVERY create/update   */
/*  (all of which funnel through _applyUpdateLocked or create here, all */
/*  inside the row-locked txn), we recompute the derived status from    */
/*  the just-persisted invoice graph and write it back in the same txn. */
/*                                                                      */
/*  The derivation lives in shared/invoiceStatus.js (the SAME module)  */
/*  firmBilling.service uses, so the persisted status and the         */
/*  read-derived status can never drift. That module depends only on    */
/*  shared/money.js, so requiring it here does NOT create the old       */
/*  firmBilling.service <-> invoices.repository cycle.                  */
/* ------------------------------------------------------------------ */

/**
 * Reminder state is a shared `reminders` row (migration 0245) rather than six
 * columns on the invoice, so every read joins it back under the old names and
 * `rowToInvoice` is unchanged. `reminders` is the same table the task, event and
 * signature reminders use.
 */
const INVOICE_JOINED = `select invoices.*,
    invoice_reminder.last_sent_at             as last_reminder_sent_at,
    coalesce(invoice_reminder.sent_count, 0)  as reminder_count,
    coalesce(invoice_reminder.is_opted_out, false) as reminder_opt_out,
    invoice_reminder.pre_due_days             as pre_due_reminder_days,
    invoice_reminder.pre_due_sent_at          as pre_due_reminder_sent_at,
    coalesce(invoice_reminder.recent_manual_sends, '{}') as recent_manual_reminders
  from invoices
  left join reminders invoice_reminder on invoice_reminder.invoice_id = invoices.id`;

/**
 * Wrapped in a subquery named `invoices` so that every caller's predicate still
 * reads `where law_firm_id = $1`. Both tables carry `law_firm_id`, so the join
 * would otherwise make that ambiguous at a dozen call sites.
 *
 * No locking read uses this, and none should: FOR UPDATE re-checks only the
 * relation it locks, so a read that joins `reminders` under a lock on `invoices`
 * hands a waiter the pre-lock copy of the reminder row. Both locking paths take
 * the lock in a statement of their own and then read through this one.
 */
const INVOICE_SELECT = `select * from (${INVOICE_JOINED}) invoices`;

/**
 * The six reminder fields, pulled out of the invoice column map and written to
 * the shared row instead. Every writer reaches this through the same locked
 * transaction on the invoice row, so the lock that used to serialise a manual
 * resend still does.
 */
const REMINDER_COLUMN_TO_FIELD: Record<string, string> = {
  last_reminder_sent_at: 'last_sent_at',
  reminder_count: 'sent_count',
  reminder_opt_out: 'is_opted_out',
  pre_due_reminder_days: 'pre_due_days',
  pre_due_reminder_sent_at: 'pre_due_sent_at',
  recent_manual_reminders: 'recent_manual_sends',
};

function takeReminderColumns(cols: Record<string, unknown>) {
  const taken: Record<string, unknown> = {};
  for (const [column, field] of Object.entries(REMINDER_COLUMN_TO_FIELD)) {
    if (column in cols) {
      taken[field] = cols[column];
      delete cols[column];
    }
  }
  return taken;
}

async function writeInvoiceReminder(
  client: any,
  lawFirmId: string,
  invoiceId: string,
  values: Record<string, unknown>,
) {
  const fields = Object.keys(values);
  if (!fields.length) return;
  const placeholders = fields.map((_, index) => `$${index + 3}`);
  const updates = fields.map((field, index) => `${field} = $${index + 3}`);
  await financialSql(client,
    `insert into reminders (law_firm_id, invoice_id, ${fields.join(', ')})
       values ($1, $2, ${placeholders.join(', ')})
     on conflict (law_firm_id, invoice_id) where invoice_id is not null
     do update set ${updates.join(', ')}`,
    [lawFirmId, invoiceId, ...fields.map((field) => values[field])],
  );
}

async function loadChildren(client: any, invoiceIds: string[]) {
  const byInvoice = new Map();
  for (const id of invoiceIds) {
    byInvoice.set(id, { lineItems: [], payments: [], expectedPayments: [], creditNotes: [], adjustments: [] });
  }
  if (invoiceIds.length === 0) return byInvoice;

  // Sequential (not Promise.all): when `client` is a pooled transaction client
  // it cannot run concurrent queries. `rootQueryExecutor` could, but sequential is safe for both.
  const li = await financialSql(client, 'select * from invoice_line_items where invoice_id = any($1) order by invoice_id, kind, sort_order', [invoiceIds]);
  const pay = await financialSql(client, 'select * from invoice_payments where invoice_id = any($1) order by invoice_id, sort_order', [invoiceIds]);
  const exp = await financialSql(client, 'select * from invoice_expected_payments where invoice_id = any($1) order by invoice_id, sort_order', [invoiceIds]);
  const adj = await financialSql(client, 'select * from invoice_adjustments where invoice_id = any($1) order by invoice_id, direction, sort_order', [invoiceIds]);
  for (const r of li.rows) byInvoice.get(r.invoice_id)?.lineItems.push(r);
  for (const r of pay.rows) byInvoice.get(r.invoice_id)?.payments.push(r);
  for (const r of exp.rows) byInvoice.get(r.invoice_id)?.expectedPayments.push(r);
  for (const r of adj.rows) {
    if (r.direction === 'credit') byInvoice.get(r.invoice_id)?.creditNotes.push(r);
    else byInvoice.get(r.invoice_id)?.adjustments.push(r);
  }
  return byInvoice;
}

async function rowsToInvoices(client: any, rows: any) {
  if (!rows.length) return [];
  const children = await loadChildren(client, rows.map((r: any) => r.id));
  return rows.map((r: any) => assembleInvoice(r, children.get(r.id)));
}

/**
 * Postgres column type per child table, keyed by column name. Read once per
 * table per process; the schema cannot change under a running server.
 */
const childColumnTypes = new Map<string, Record<string, string>>();

async function columnTypesFor(client: any, table: string): Promise<Record<string, string>> {
  const cached = childColumnTypes.get(table);
  if (cached) return cached;
  const { rows } = await financialSql(client,
    `select column_name, udt_name from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  );
  const map: Record<string, string> = {};
  for (const r of rows) map[r.column_name] = r.udt_name;
  childColumnTypes.set(table, map);
  return map;
}

/**
 * Multi-row insert with an EXPLICIT CAST on every placeholder.
 *
 * The casts are not decoration. In a MULTI-ROW `values (...), (...)` list,
 * Postgres resolves each column's type across the rows before matching it to
 * the target column, and a list of untyped parameters resolves to `text`. So
 * `insert into t (d) values ($1), ($2)` against a `date` column fails with
 * "column d is of type date but expression is of type text", while the
 * single-row form of the same insert succeeds, because there Postgres coerces
 * the unknown parameter straight to the target column's type.
 *
 * That is why this worked for years and then broke the moment
 * `invoice_payments.payment_date`, `invoice_expected_payments.due_date` and
 * `invoice_line_items.line_date` stopped being `text` (migration 0196). It also
 * hid until then: the timestamp columns in these same rows are passed as JS
 * `Date` objects, which node-pg sends already typed.
 *
 * Reading the types from the catalog rather than hardcoding a list of date
 * columns is deliberate: the next column retyped here would otherwise
 * reintroduce exactly this failure, and it surfaces as 60 red specs in
 * unrelated billing reports rather than as anything that names the cause.
 */
async function insertChildRows(client: any, table: any, objects: any) {
  if (!objects.length) return;
  const keys = Object.keys(objects[0]);
  const types = await columnTypesFor(client, table);
  const values: any[] = [];
  const placeholders = objects.map((obj: any, ri: any) =>
    `(${keys.map((_, ci) => {
      values.push(obj[keys[ci]]);
      const udt = types[keys[ci]];
      // An unknown column (never expected) falls back to no cast, which is the
      // pre-existing behaviour rather than a syntax error.
      return udt ? `$${ri * keys.length + ci + 1}::${udt}` : `$${ri * keys.length + ci + 1}`;
    }).join(',')})`
  );
  await financialSql(client,
    `insert into ${table} (${keys.join(',')}) values ${placeholders.join(',')}`,
    values,
  );
}

/** Persist all repeating groups present in `doc` for an invoice (replace-all). */
async function writeChildren(client: any, invoiceId: string, lawFirmId: string, doc: any, { replace }: any) {
  const has = (k: any) => Object.prototype.hasOwnProperty.call(doc, k);

  // line items: time entries + flat fees + expenses (replace-all on update if present)
  if (replace ? (has('timeEntries') || has('flatFees') || has('expenses')) : true) {
    if (replace) await financialSql(client, 'delete from invoice_line_items where invoice_id = $1', [invoiceId]);
    const rows: any[] = [];
    (doc.timeEntries || []).forEach((it: any, i: any) => rows.push(lineToColumns(it, 'time_entry', i, lawFirmId, invoiceId)));
    (doc.flatFees || []).forEach((it: any, i: any) => rows.push(lineToColumns(it, 'flat_fee', i, lawFirmId, invoiceId)));
    (doc.expenses || []).forEach((it: any, i: any) => rows.push(lineToColumns(it, 'expense', i, lawFirmId, invoiceId)));
    await insertChildRows(client, 'invoice_line_items', rows);
  }

  // payments (replace-all whenever the patch provides the array)
  if (!replace || has('payments')) {
    if (replace) await financialSql(client, 'delete from invoice_payments where invoice_id = $1', [invoiceId]);
    const rows = (doc.payments || []).map((p: any, i: any) => paymentToColumns(p, i, lawFirmId, invoiceId));
    await insertChildRows(client, 'invoice_payments', rows);
  }

  // expected payments (from paymentPlan.expectedPayments)
  if (!replace || has('paymentPlan')) {
    if (replace) await financialSql(client, 'delete from invoice_expected_payments where invoice_id = $1', [invoiceId]);
    const eps = (doc.paymentPlan && Array.isArray(doc.paymentPlan.expectedPayments))
      ? doc.paymentPlan.expectedPayments : [];
    const rows = eps.map((e: any, i: any) => expectedToColumns(e, i, lawFirmId, invoiceId));
    await insertChildRows(client, 'invoice_expected_payments', rows);
  }

  // credit notes
  if (!replace || has('creditNotes')) {
    if (replace) await financialSql(client, "delete from invoice_adjustments where invoice_id = $1 and direction = 'credit'", [invoiceId]);
    const rows = (doc.creditNotes || []).map((c: any, i: any) => creditToColumns(c, i, lawFirmId, invoiceId));
    await insertChildRows(client, 'invoice_adjustments', rows);
  }

  // amount adjustment notes
  if (!replace || has('amountAdjustmentNotes')) {
    if (replace) await financialSql(client, "delete from invoice_adjustments where invoice_id = $1 and direction = 'charge'", [invoiceId]);
    const rows = (doc.amountAdjustmentNotes || []).map((a: any, i: any) => adjustmentToColumns(a, i, lawFirmId, invoiceId));
    await insertChildRows(client, 'invoice_adjustments', rows);
  }
}

/* ------------------------------------------------------------------ */
/*  repository                                                          */
/* ------------------------------------------------------------------ */

class InvoicesRepository {
  /** Serialize source claims across every invoice writer in a billing context. */
  async lockBillingContext(client: any, context: any) {
    await financialSql(client, 'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`invoice-sources:${context.lawFirmId}:${context.type}:${context.entityId}`]);
  }

  /**
   * A source row an invoice line names must be a billable row of this firm that
   * sits in the invoice's own context: a matter invoice bills that matter's rows,
   * a client-context invoice that client's. An id that names no activity of this
   * firm (unknown, malformed, or another firm's), a row in another context, and a
   * row written off as non-billable are all refused. A line with no id at all is a
   * manual line and never reaches this check.
   */
  async assertSourcesBelongToContext(client: any, context: any, kind: string, ids: string[]) {
    const activityKind = kind === 'time_entry' ? 'time' : kind;
    const activityCol = context.type === 'matter' ? 'matter_id' : 'client_id';
    const uuids = [...new Set(ids.filter(isUuid))];
    if (uuids.length !== new Set(ids).size) throw new ValidationError(SOURCES_MISSING_MESSAGE);
    if (!uuids.length) return;
    const { rows } = await financialSql(client,
      `select id, billable, (${activityCol} = $2) as in_context
         from activities
        where law_firm_id = $1 and kind = $3 and id = any($4::uuid[])`,
      [context.lawFirmId, context.entityId, activityKind, uuids]);
    if (rows.length !== uuids.length) throw new ValidationError(SOURCES_MISSING_MESSAGE);
    if (rows.some((row: any) => !row.in_context)) {
      throw new ValidationError('One or more selected items do not belong to this invoice');
    }
    if (rows.some((row: any) => row.billable === false)) {
      throw new ValidationError('One or more selected items are marked non-billable and cannot be invoiced');
    }
  }

  /**
   * Refuse an id list that names an activity of this firm in no row: an id that is
   * not a uuid, or that matches no row of that kind in the firm. Context and
   * billable checks stay with the writer that places the line.
   */
  async assertActivitiesExist(lawFirmId: string, kind: 'time' | 'flat_fee' | 'expense', ids: string[]) {
    const unique = [...new Set(ids.map(String))];
    if (!unique.length) return;
    const uuids = unique.filter(isUuid);
    if (uuids.length !== unique.length) throw new ValidationError(SOURCES_MISSING_MESSAGE);
    const { rows } = await financialRootSql(
      'select count(*)::int as n from activities where law_firm_id = $1 and kind = $2 and id = any($3::uuid[])',
      [lawFirmId, kind, uuids]);
    if (rows[0].n !== uuids.length) throw new ValidationError(SOURCES_MISSING_MESSAGE);
  }

  /** A plan fee source id must name a billing plan period of this firm under the plan it states. */
  async assertPlanPeriodsExist(client: any, lawFirmId: string, planFeeIds: string[]) {
    const pairs = [...new Set(planFeeIds)].map((id) => PLAN_FEE_SOURCE_RE.exec(id) as RegExpExecArray);
    if (pairs.some((m) => !isUuid(m[1]) || Number.isNaN(Date.parse(m[2])))) {
      throw new ValidationError(SOURCES_MISSING_MESSAGE);
    }
    const { rows } = await financialSql(client,
      `select count(*)::int as n
         from billing_plan_periods p
         join unnest($2::uuid[], $3::date[]) as want(plan_id, period_start)
           on want.plan_id = p.billing_plan_id and want.period_start = p.period_start_date
        where p.law_firm_id = $1`,
      [lawFirmId, pairs.map((m) => m[1]), pairs.map((m) => m[2])]);
    if (rows[0].n !== pairs.length) throw new ValidationError(SOURCES_MISSING_MESSAGE);
  }

  /** Read availability after acquiring the context lock, on the writing transaction. */
  async assertSourcesAvailable(client: any, context: any, data: any, invoiceId: string | null = null) {
    const { col } = contextCol(context);
    const groups = [
      ['time_entry', data.timeEntries], ['flat_fee', data.flatFees], ['expense', data.expenses],
    ];
    for (const [kind, items] of groups) {
      const ids = (items || []).map((item: any) => item.id).filter(Boolean).map(String);
      if (!ids.length) continue;
      const planFeeIds = kind === 'flat_fee' ? ids.filter((id: string) => PLAN_FEE_SOURCE_RE.test(id)) : [];
      if (planFeeIds.length) await this.assertPlanPeriodsExist(client, context.lawFirmId, planFeeIds);
      const activityIds = ids.filter((id: string) => !planFeeIds.includes(id));
      if (activityIds.length) await this.assertSourcesBelongToContext(client, context, kind, activityIds);
      const { rows } = await financialSql(client,
        `select li.source_id from invoice_line_items li
           join invoices i on i.law_firm_id = li.law_firm_id and i.id = li.invoice_id
          where i.law_firm_id = $1 and i.${col} = $2 and li.kind = $3
            and li.source_id = any($4::text[])
            and i.status <> 'voided'
            and ($5::uuid is null or i.id <> $5)
            and ($6::uuid is null or i.split_group_id is distinct from $6)
          limit 1`,
        [context.lawFirmId, context.entityId, kind, ids, invoiceId, data.splitGroupId || null]);
      if (rows.length) throw new ValidationError('One or more selected items are already billed on another invoice');
    }
  }

  async create(context: any, data: any) {
    return withDrizzleTransaction((client: any) => this._createTx(client, context, data));
  }

  /**
   * Transaction-body core of `create`. Assumes `client` is already inside an
   * open transaction; performs the insert + child-row writes + derived-status
   * patch, but does NOT begin/commit/release. Extracted so a caller creating
   * SEVERAL invoices as one unit (createSplitInvoices) can run every insert
   * under ONE outer transaction instead of one committed transaction per
   * invoice - without this, a failure on the Nth share leaves the first N-1
   * shares committed as a permanently incomplete split group.
   */
  async _createTx(client: any, context: any, data: any) {
    await this.lockBillingContext(client, context);
    await this.assertSourcesAvailable(client, context, data);
    const cols = scalarColumns(data, context, { isCreate: true });
    const reminderValues = takeReminderColumns(cols);
    const keys = Object.keys(cols);
    const { rows } = await financialSql(client,
      `insert into invoices (${keys.join(',')})
         values (${keys.map((_, i) => `$${i + 1}`).join(',')})
       returning id`,
      keys.map((k) => cols[k]),
    );
    const invoiceId = rows[0].id;
    await writeInvoiceReminder(client, context.lawFirmId, invoiceId, reminderValues);
    await writeChildren(client, invoiceId, context.lawFirmId, data, { replace: false });

    const full = await financialSql(client, `${INVOICE_SELECT} where invoices.id = $1`, [invoiceId]);
    const [invoice] = await rowsToInvoices(client, full.rows);

    // BL #10: persist the authoritative derived status on create too, so a brand
    // new invoice's `status` column matches what the app derives on read (e.g.
    // 'outstanding'/'overdue'/'paid'), not the table default 'draft'.
    // Perf: derive from the just-assembled `invoice` already in hand and patch
    // only the `status` column. No second full child-table reassemble/SELECT.
    const desiredStatus = deriveInvoiceStatus(invoice);
    if (desiredStatus && desiredStatus !== invoice.status) {
      await financialSql(client, 'update invoices set status = $3 where law_firm_id = $1 and id = $2',
        [context.lawFirmId, invoiceId, desiredStatus]);
      invoice.status = desiredStatus;
    }

    return invoice;
  }

  async findById(context: any, invoiceId: string) {
    if (!isUuid(invoiceId)) return null;
    const { col } = contextCol(context);
    const { rows } = await financialRootSql(
      `${INVOICE_SELECT} where invoices.law_firm_id = $1 and invoices.id = $2 and invoices.${col} = $3 limit 1`,
      [context.lawFirmId, invoiceId, context.entityId],
    );
    const [invoice] = await rowsToInvoices(rootQueryExecutor, rows);
    return invoice || null;
  }

  /**
   * Locate an invoice by id alone, returning just enough to authorize a caller:
   * the billing context it belongs to plus its number for display.
   *
   * Deliberately not a full `rowsToInvoices` load, because callers that address
   * an invoice by id (the preserved-copy reads) need to know WHICH matter or
   * client governs access, not the invoice's line items and payments.
   */
  async findContextById(lawFirmId: string, invoiceId: string) {
    if (!isUuid(invoiceId)) return null;
    const { rows } = await financialRootSql(
      `select id, law_firm_id, matter_id, client_context_id, invoice_number
         from invoices where law_firm_id = $1 and id = $2 limit 1`,
      [lawFirmId, invoiceId],
    );
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      invoiceNumber: rows[0].invoice_number || null,
      context: rowContext(rows[0]),
    };
  }

  async findByContext(context: any) {
    const { col } = contextCol(context);
    const { rows } = await financialRootSql(
      `${INVOICE_SELECT} where law_firm_id = $1 and ${col} = $2 order by created_at desc`,
      [context.lawFirmId, context.entityId],
    );
    return rowsToInvoices(rootQueryExecutor, rows);
  }

  /**
   * Ids of the firm's invoices that could contribute a calendar entry inside
   * `[from, to]` (inclusive day-only 'YYYY-MM-DD' strings).
   *
   * A payment entry's day comes from one of three places: the invoice's own due
   * date, an expected-payment installment's due date, or a recorded payment's
   * date. The two child columns are `text` holding either 'YYYY-MM-DD' or a full
   * ISO string, so they are compared on their first ten characters, which is the
   * calendar day in both shapes (and matches the expression index on each).
   *
   * The recorded-payment bound is stretched by a day either side. That day is the
   * only one of the three the entry builder re-derives through a Date round trip,
   * so a legacy full-ISO value carrying a non-UTC offset can land on the calendar
   * one day off from its own first ten characters. Stretching absorbs that skew
   * while still being a plain range scan on the indexed expression.
   *
   * This is a SUPERSET filter, the same contract `findForFirmByContext`'s
   * `prefilter` documents: `buildPaymentDateEntries` still derives the real
   * entries and the caller drops the ones outside the window, so over-selecting
   * here only costs a little work while under-selecting would silently hide money.
   */
  async findFirmInvoiceIdsInDateWindow(lawFirmId: string, { from, to }: any) {
    // All three columns compared here are `date` (migration 0196 retyped
    // invoice_expected_payments.due_date and invoice_payments.payment_date).
    // The bounds arrive as 'YYYY-MM-DD' strings and are cast at each site;
    // every comparison is a plain range scan on the indexed date columns.
    const { rows } = await financialRootSql(
      `select i.id
         from invoices i
        where i.law_firm_id = $1
          and (
            (i.due_date is not null and i.due_date between $2::date and $3::date)
            or exists (
              select 1 from invoice_expected_payments ep
               where ep.invoice_id = i.id
                 and ep.due_date is not null
                 and ep.due_date between $2::date and $3::date
            )
            or exists (
              select 1 from invoice_payments p
               where p.invoice_id = i.id
                 and p.payment_date is not null
                 and p.payment_date between $2::date and $3::date
            )
          )`,
      [lawFirmId, from, to]
    );
    return rows.map((r: any) => r.id);
  }

  /**
   * All of a firm's invoices in one query (children batched), grouped by context.
   * Replaces per-matter/per-client findByContext N+1 in the firm-billing reads.
   * Returns { byMatter: Map<matterId, invoice[]>, byClient: Map<clientId, invoice[]> }.
   *
   * `prefilter` narrows the read to the rows a caller's column-only filters could
   * possibly keep. It is deliberately a SUPERSET of the caller's real filter: the
   * derived-record filter still runs afterwards, so over-selecting here only costs
   * a little work, while under-selecting would silently drop invoices. That is why
   * `clientId` matches any of the three columns a derived `clientId` can come from
   * rather than trying to reproduce the precedence between them.
   *
   * Only predicates that read a stored column belong here. Anything derived
   * (status, remaining balance, the due buckets) stays in `firmBillingWindow`,
   * where the money model has one definition.
   */
  async findForFirmByContext(lawFirmId: string, prefilter: any = {}) {
    const { matterId, clientId, dateFrom, dateTo, ids } = prefilter;
    const params: unknown[] = [lawFirmId];
    let where = 'law_firm_id = $1';

    if (matterId && isUuid(matterId)) {
      params.push(matterId);
      where += ` and matter_id = $${params.length}`;
    }
    if (clientId) {
      params.push(clientId);
      const p = `$${params.length}`;
      where += ` and (client_context_id = ${p} or client_id = ${p} or matter_client_id = ${p})`;
    }
    // An explicit id set, used by the calendar after it has probed which invoices
    // could contribute an entry to the window it is drawing. An empty array means
    // "nothing matched", which must select nothing rather than everything.
    if (Array.isArray(ids)) {
      const uuids = ids.filter(isUuid);
      if (!uuids.length) return { byMatter: new Map(), byClient: new Map() };
      params.push(uuids);
      where += ` and id = any($${params.length}::uuid[])`;
    }
    if (dateFrom) {
      params.push(dateFrom);
      where += ` and invoice_date >= $${params.length}`;
    }
    if (dateTo) {
      params.push(dateTo);
      where += ` and invoice_date <= $${params.length}`;
    }

    const { rows } = await financialRootSql(
      `${INVOICE_SELECT} where ${where} order by created_at desc`,
      params,
    );
    const invoices = await rowsToInvoices(rootQueryExecutor, rows);
    const byMatter = new Map();
    const byClient = new Map();
    rows.forEach((r: any, i: any) => {
      const ctx = rowContext(r);
      if (!ctx.entityId) return;
      const map = ctx.type === 'matter' ? byMatter : byClient;
      if (!map.has(ctx.entityId)) map.set(ctx.entityId, []);
      map.get(ctx.entityId).push(invoices[i]);
    });
    return { byMatter, byClient };
  }

  /**
   * All matter-context invoices for a firm across a set of matterIds in ONE query
   * (children batched), grouped by matterId. Replaces a per-matter findByContext
   * N+1 in the portal billing read. Returns Map<matterId, invoice[]> with each
   * group ordered by created_at desc (mirrors findByContext ordering).
   */
  async findByMatterIds(lawFirmId: string, matterIds: string[]) {
    const validIds = (matterIds || []).filter((id: any) => isUuid(id));
    const byMatter = new Map();
    if (validIds.length === 0) return byMatter;
    const { rows } = await financialRootSql(
      `${INVOICE_SELECT} where law_firm_id = $1 and matter_id = any($2) order by created_at desc`,
      [lawFirmId, validIds],
    );
    const invoices = await rowsToInvoices(rootQueryExecutor, rows);
    rows.forEach((r: any, i: any) => {
      if (!r.matter_id) return;
      if (!byMatter.has(r.matter_id)) byMatter.set(r.matter_id, []);
      byMatter.get(r.matter_id).push(invoices[i]);
    });
    return byMatter;
  }

  /**
   * Sum the outstanding balance (in cents) of a client's invoices for ONE firm,
   * scoped exactly like the portal billing read (buildPortalBilling +
   * invoiceBelongsToClient + dedup), without assembling full invoices.
   *
   * Two contexts contribute, de-duplicated by invoice id:
   *   - MATTER invoices on the client's accessible `matterIds` that BELONG to the
   *     client, matched by matter_client_id (a client uuid on that matter whose
   *     user_id is this portal user OR whose email is this client's email),
   *     OR by billing_email = the client's email, OR by client_id = clientRecordId
   *     (invoices.client_id is a clients.id uuid - the explicit "bill to" client
   *     on the invoice - never a Firebase UID; this used to compare it against
   *     clientUserId, which could never match a real invoice).
   *   - CLIENT-context invoices on the client's own record (client_context_id).
   *
   * Outstanding per invoice is the persisted generated column
   * `balance_due_cents` (total - amount_paid - written_off), floored at 0 with
   * GREATEST (identical to the summary reducer's max(0, billed - paid - writtenOff)),
   * excluding voided invoices: a cancelled bill is owed by nobody.
   * Returns an integer cents total (0 when nothing qualifies).
   */
  async sumOutstandingForClientPortal({ lawFirmId, matterIds, clientRecordId, clientUserId, clientEmail }: any) {
    const validMatterIds = (matterIds || []).filter((id: any) => isUuid(id));
    const normalizedEmail = typeof clientEmail === 'string' && clientEmail.trim()
      ? clientEmail.trim().toLowerCase()
      : null;
    // invoice.client_id is a clients.id uuid, matched against clientRecordId
    // (also a clients.id uuid) - not clientUserId, which is a Firebase UID and
    // lives in a different id space. Guard the uuid-column compare so a
    // non-uuid value can't raise a cast error.
    const portalUserId = typeof clientUserId === 'string' ? clientUserId : null;
    const clientRecord = isUuid(clientRecordId) ? clientRecordId : null;

    // DISTINCT on invoice id dedups the matter/client UNION (an invoice can't be
    // both contexts here, but DISTINCT keeps the count faithful to the in-memory
    // `seen` dedup). billing_email / client_email are citext, so `= $email`
    // is case-insensitive and index-usable.
    const { rows } = await financialRootSql(
      `with owned as (
         select i.id, i.balance_due_cents
           from invoices i
          where i.law_firm_id = $1
            and i.status <> 'voided'
            and i.matter_id = any($2::uuid[])
            and (
              -- $3 is clientRecordId (a clients.id uuid), not clientUserId
              ($3::uuid is not null and i.client_id = $3::uuid)
              or ($4::citext is not null and i.billing_email = $4::citext)
              or exists (
                select 1
                  from clients cl
                 where cl.id = i.matter_client_id
                   and cl.law_firm_id = i.law_firm_id
                   and (
                     ($5::text is not null and cl.user_id = $5::text)
                     or ($4::citext is not null and cl.email = $4::citext)
                   )
              )
            )
         union
         select i.id, i.balance_due_cents
           from invoices i
          where i.law_firm_id = $1
            and i.status <> 'voided'
            and $6::uuid is not null
            and i.client_context_id = $6::uuid
       )
       select coalesce(sum(greatest(0, balance_due_cents)), 0)::bigint as outstanding_cents
         from owned`,
      [lawFirmId, validMatterIds, clientRecord, normalizedEmail, portalUserId, clientRecord],
    );

    return Number(rows[0]?.outstanding_cents || 0);
  }

  async listAll(context: any) {
    const { col } = contextCol(context);
    const { rows } = await financialRootSql(
      `${INVOICE_SELECT} where law_firm_id = $1 and ${col} = $2`,
      [context.lawFirmId, context.entityId],
    );
    return rowsToInvoices(rootQueryExecutor, rows);
  }

  async findByInvoiceName(context: any, invoiceName: any) {
    const { col } = contextCol(context);
    const { rows } = await financialRootSql(
      `${INVOICE_SELECT} where law_firm_id = $1 and ${col} = $2 and invoice_name = $3`,
      [context.lawFirmId, context.entityId, invoiceName],
    );
    return rowsToInvoices(rootQueryExecutor, rows);
  }

  /**
   * Apply a computed patch to an invoice on a transaction client that is ALREADY
   * holding the row lock (used by both `update` and `runInvoiceTxn`). Assumes the
   * row exists + is locked. Returns the reassembled invoice.
   */
  async _applyUpdateLocked(client: any, context: any, invoiceId: string, data: any) {
    await this.assertSourcesAvailable(client, context, data, invoiceId);
    const cols = scalarColumns(data, context, { isCreate: false });
    const reminderValues = takeReminderColumns(cols);
    // Never re-key the firm / context on update.
    delete cols.law_firm_id;
    delete cols.matter_id;
    delete cols.client_context_id;

    const keys = Object.keys(cols);
    if (keys.length) {
      const setClause = keys.map((k, i) => `${k} = $${i + 3}`).join(',');
      await financialSql(client,
        `update invoices set ${setClause}, updated_at = now() where law_firm_id = $1 and id = $2`,
        [context.lawFirmId, invoiceId, ...keys.map((k) => cols[k])],
      );
    } else {
      await financialSql(client, 'update invoices set updated_at = now() where law_firm_id = $1 and id = $2',
        [context.lawFirmId, invoiceId]);
    }

    await writeInvoiceReminder(client, context.lawFirmId, invoiceId, reminderValues);
    await writeChildren(client, invoiceId, context.lawFirmId, data, { replace: true });

    const full = await financialSql(client, `${INVOICE_SELECT} where invoices.id = $1`, [invoiceId]);
    const [invoice] = await rowsToInvoices(client, full.rows);

    // BL #10: recompute the authoritative status from the just-persisted graph and
    // write it back in the SAME locked txn so the `status` column (and the partial
    // indexes that key on it) always match the derived status the app reads.
    // Perf: the derive only reads scalar money/date fields that are already on the
    // assembled `invoice`, so we patch just the `status` column and mirror it onto
    // the in-hand object. No second full child-table reassemble/SELECT.
    //
    // MIDNIGHT-CROSSING STALENESS (improvement #6): the `status` column is only
    // recomputed on a write (here + in create()). `deriveInvoiceStatus` has a
    // TIME-DEPENDENT rule ('overdue' once (nextPaymentDate||dueDate) < today), so
    // an unpaid invoice whose due date passes WITHOUT any further mutation keeps
    // its prior `status` in the column until the next write. This is intentionally
    // tolerated, NOT a read-path bug: every API response re-derives status live via
    // computeInvoiceDerived (formatInvoice + mapInvoiceRecord), and getBillingSummary
    // filters on that re-derived `inv.status`. Never on this column. The ONLY thing
    // that can read a stale value is raw SQL that filters the `status` column
    // directly: digest.repository.ts and `findUnpaidByDue` below (both test
    // only `'voided'`). That predicate tests only the voided end of the
    // vocabulary, which deriveInvoiceStatus never reaches by the passage of
    // time -- the
    // time-dependent rule moves an invoice between 'sent' and 'overdue' -- so
    // midnight-crossing staleness cannot change either filter's answer.
    // If a SQL-level overdue filter is ever needed, compute it from due_date /
    // balance_due_cents directly rather than from this column.
    const desiredStatus = deriveInvoiceStatus(invoice);
    if (desiredStatus && desiredStatus !== invoice.status) {
      await financialSql(client, 'update invoices set status = $3 where law_firm_id = $1 and id = $2',
        [context.lawFirmId, invoiceId, desiredStatus]);
      invoice.status = desiredStatus;
    }
    return invoice;
  }

  async update(context: any, invoiceId: string, data: any) {
    if (!isUuid(invoiceId)) return null;
    const { col } = contextCol(context);
    return withDrizzleTransaction(async (client: any) => {
      await this.lockBillingContext(client, context);
      const existing = await financialSql(client,
        `select id from invoices where law_firm_id = $1 and id = $2 and ${col} = $3 limit 1 for update`,
        [context.lawFirmId, invoiceId, context.entityId],
      );
      // Returning commits an empty transaction, which releases the row lock just
      // as the previous explicit rollback did.
      if (!existing.rows[0]) return null;

      return this._applyUpdateLocked(client, context, invoiceId, data);
    });
  }

  /**
   * Lock one invoice row on an open transaction, then read its whole graph in a
   * fresh statement. Returns null when the invoice is not in this context.
   *
   * Two statements, deliberately. FOR UPDATE re-checks only the relation it
   * locks: a waiter that blocks here and then proceeds re-reads the invoice
   * row, but any table joined to it is still read at the pre-lock snapshot.
   * Reminder state is such a table, and computing eligibility from a stale copy
   * of it is exactly the double-send this lock exists to stop. So: lock first,
   * then read the graph in a fresh statement, which under READ COMMITTED sees
   * whatever the transaction ahead of us committed.
   */
  async _lockAndRead(client: any, context: any, invoiceId: string) {
    const { col } = contextCol(context);
    const locked = await financialSql(client,
      `select id from invoices where law_firm_id = $1 and id = $2 and ${col} = $3 limit 1 for update`,
      [context.lawFirmId, invoiceId, context.entityId],
    );
    if (!locked.rows[0]) return null;
    const full = await financialSql(client, `${INVOICE_SELECT} where invoices.id = $1`, [invoiceId]);
    const [current] = await rowsToInvoices(client, full.rows);
    return current;
  }

  /**
   * BL1: atomic read→compute→write for payment-mutation paths. Runs in ONE
   * transaction holding `SELECT … FOR UPDATE` on the invoice row, so the read
   * the caller computes against can never be clobbered by a concurrent payment.
   *
   *   compute(currentInvoice, txnClient) -> updateData | null
   *
   * `currentInvoice` is the fully-reassembled invoice read UNDER the lock.
   * Return the same `updateData` patch the service used to pass to `update`;
   * return null to commit without writing (no-op). The returned invoice is the
   * post-write reassembled invoice. Throwing rolls back the whole txn.
   */
  async runInvoiceTxn(context: any, invoiceId: string, compute: any) {
    if (!isUuid(invoiceId)) return null;
    return withDrizzleTransaction(async (client: any) => {
      await this.lockBillingContext(client, context);
      // Returning commits an empty transaction, which releases the row lock.
      const current = await this._lockAndRead(client, context, invoiceId);
      if (!current) return null;
      const updateData = await compute(current, client);
      if (updateData == null) return current;
      return this._applyUpdateLocked(client, context, invoiceId, updateData);
    });
  }

  /**
   * `runInvoiceTxn` without the billing-context lock, for a write that changes
   * only reminder bookkeeping (the `reminders` row, or the per-installment
   * pre-due stamp). The row lock still serializes it against every other writer
   * of this invoice, which is what makes a reminder claim atomic. The context
   * lock exists to stop two invoices claiming the same billable source, and a
   * reminder never names one, so taking it here would only make a reminder wait
   * on, and stall, unrelated invoices in the same matter. Never pass line items
   * through this.
   */
  async runReminderTxn(context: any, invoiceId: string, compute: any) {
    if (!isUuid(invoiceId)) return null;
    return withDrizzleTransaction(async (client: any) => {
      const current = await this._lockAndRead(client, context, invoiceId);
      if (!current) return null;
      const updateData = await compute(current, client);
      if (updateData == null) return current;
      return this._applyUpdateLocked(client, context, invoiceId, updateData);
    });
  }

  /**
   * BL3: allocate the next sequential invoice number for a firm atomically from
   * the per-firm firm_counters row (one UPDATE … RETURNING, no read-then-write
   * race). Returns the formatted `${prefix}${NNN}` string. The unique index on
   * (law_firm_id, invoice_number) is the backstop.
   */
  async allocateInvoiceNumber(lawFirmId: string, prefix: any) {
    const p = prefix || 'INV-';
    const n = await withDrizzleTransaction(async (client: any) => {
      // Upsert-then-increment so the very first allocation also locks atomically.
      await financialSql(client,
        `insert into firm_counters (law_firm_id, counter_type, next_val)
           values ($1, 'invoice_number', 1)
         on conflict (law_firm_id, counter_type) do nothing`,
        [lawFirmId],
      );
      const { rows } = await financialSql(client,
        `update firm_counters set next_val = next_val + 1
          where law_firm_id = $1 and counter_type = 'invoice_number'
        returning next_val - 1 as allocated`,
        [lawFirmId],
      );
      return Number(rows[0].allocated);
    });
    return `${p}${String(n).padStart(3, '0')}`;
  }

  /**
   * Delete one invoice after `guard` approves it, on the same context and row
   * locks every invoice writer takes. `guard(current, client)` reads the invoice
   * as it stands once the lock is held and throws to refuse; a payment that
   * committed while this waited is therefore seen, not deleted along with the
   * invoice. Returns the deleted invoice, or null when it is not in this context.
   */
  async deleteLocked(context: any, invoiceId: string, guard: any) {
    if (!isUuid(invoiceId)) return null;
    return withDrizzleTransaction(async (client: any) => {
      await this.lockBillingContext(client, context);
      const current = await this._lockAndRead(client, context, invoiceId);
      if (!current) return null;
      await guard(current, client);
      await financialSql(client, 'delete from invoices where law_firm_id = $1 and id = $2',
        [context.lawFirmId, invoiceId]);
      return current;
    });
  }

  /**
   * Resolve the invoice payment recorded for a Stripe payment intent, across all
   * firms. Stripe's charge.refunded / charge.dispute.created events carry no
   * law_firm_id, so a card/ACH invoice payment is located by its payment intent id
   * alone. Joins to the owning invoice so the caller can reverse it via
   * runInvoiceTxn without re-deriving the matter-vs-client context.
   *
   * Returns { lawFirmId, invoiceId, amountCents, context } where `context` is the
   * { type, lawFirmId, entityId } runInvoiceTxn expects, or null when no invoice
   * payment matches (the charge was a trust deposit or is unknown to us).
   */
  /**
   * The invoice a secure payment link names, in any firm: the token is the
   * only credential the no-login pay page carries, so it is matched exactly.
   */
  async findByPayLinkTokenAnyFirm(token: string) {
    if (typeof token !== 'string' || !token) return null;
    const { rows } = await financialRootSql(
      `select id, law_firm_id, matter_id, client_context_id
         from invoices
        where pay_link_token = $1
        limit 1`,
      [token],
    );
    const row = rows[0];
    if (!row) return null;
    const context = row.matter_id
      ? { type: 'matter', lawFirmId: row.law_firm_id, entityId: row.matter_id }
      : { type: 'client', lawFirmId: row.law_firm_id, entityId: row.client_context_id };
    return { lawFirmId: row.law_firm_id, invoiceId: row.id, context };
  }

  async findInvoicePaymentByStripePaymentIntentAnyFirm(paymentIntentId: any) {
    if (!paymentIntentId) return null;
    const { rows } = await financialRootSql(
      `select ip.amount_cents, ip.charge_model,
              i.id as invoice_id, i.law_firm_id, i.matter_id, i.client_context_id
         from invoice_payments ip
         join invoices i on i.id = ip.invoice_id
        where ip.stripe_payment_intent_id = $1
        limit 1`,
      [paymentIntentId],
    );
    const row = rows[0];
    if (!row) return null;
    const context = row.matter_id
      ? { type: 'matter', lawFirmId: row.law_firm_id, entityId: row.matter_id }
      : { type: 'client', lawFirmId: row.law_firm_id, entityId: row.client_context_id };
    return {
      lawFirmId: row.law_firm_id,
      invoiceId: row.invoice_id,
      amountCents: Number(row.amount_cents),
      chargeModel: row.charge_model === 'direct' ? 'direct' : 'destination',
      context,
    };
  }

  /**
   * One page of the invoices the Stripe reconciliation job could repair, across
   * every firm. This replaced a scan that loaded the entire billing table with
   * all of its children hydrated so the caller could discard the non-Stripe rows
   * in JavaScript; Postgres answers the same question and the answer is paged.
   *
   * The arms mirror `invoiceHasStripeState` in stripe.service clause for clause,
   * including the ones a foreign key makes unreachable, because the two drifting
   * apart is not symmetric. A row this query lets through that the predicate
   * rejects costs one wasted load. A row this query MISSES is never repaired at
   * all, and nothing reports it. Add an arm here whenever one is added there.
   *
   * Keyset paged on `id`, which reconciliation never rewrites, so a page is not
   * re-read or skipped when the job repairs a row mid-scan.
   */
  async listStripeCandidateInvoices({ after = null, pageSize = 500 }: any = {}) {
    const size = Math.max(1, Math.min(2000, Number(pageSize) || 500));
    const params: any[] = [size];
    let keyset = '';
    if (after) {
      params.push(after);
      keyset = `and invoices.id > $${params.length}`;
    }

    const { rows } = await financialRootSql(
      `${INVOICE_SELECT}
         where (
           invoices.stripe_payment_requested = true
           or invoices.stripe_checkout_session_id is not null
           or exists (
             select 1 from invoice_payments p
              where p.invoice_id = invoices.id
                and (p.payment_source = 'stripe'
                     or p.stripe_session_id is not null
                     or p.stripe_invoice_id is not null
                     or p.stripe_payment_intent_id is not null
                     or lower(coalesce(p.recorded_by, '')) = 'stripe')
           )
         )
         ${keyset}
         order by invoices.id
         limit $1`,
      params,
    );
    const invoices = await rowsToInvoices(rootQueryExecutor, rows);
    return rows.map((r: any, i: any) => ({ invoice: invoices[i], context: rowContext(r) }));
  }

  /**
   * Unpaid, non-voided invoices due before (`overdue`) or after (`upcoming`)
   * `today`, the firm's own day as 'YYYY-MM-DD'. Returns { invoice, context }.
   *
   * An invoice is delivered once it exists and shows in the client portal, so
   * no email or Stripe link is required: every unpaid invoice with a due date
   * is a candidate. Callers are the unattended passes that contact or charge a
   * client (both reminder passes and the auto late-fee sweep). A voided
   * invoice is excluded; `status` is never 'draft' once a row exists, because
   * create writes the derived status over the table default in the same
   * transaction.
   *
   * The caller supplies `today` rather than the database's `current_date`,
   * which is the UTC day: the pass that decides which of these to act on counts
   * days on the firm's calendar, and the two have to agree on what today is.
   */
  async findUnpaidByDue(lawFirmId: string, direction: any, today: string) {
    const cmp = direction === 'overdue' ? '<' : '>';
    const { rows } = await financialRootSql(
      `${INVOICE_SELECT}
         where law_firm_id = $1 and is_paid = false and status <> 'voided'
           and coalesce(next_payment_date, due_date) is not null
           and coalesce(next_payment_date, due_date) ${cmp} $2::date`,
      [lawFirmId, today],
    );
    const invoices = await rowsToInvoices(rootQueryExecutor, rows);
    return rows.map((r: any, i: any) => ({ invoice: invoices[i], context: rowContext(r) }));
  }

  // ── calendar sync writebacks (relational; replaces the InvoiceRef shim) ─────
  // Mutate the invoice's per-user calendar_sync jsonb map + last_synced_to_*
  // stamps for billing calendar items, via real SQL.
  async applyCalendarSync(context: any, invoiceId: string, descriptor: any) {
    if (!isUuid(invoiceId)) return;
    const { col } = contextCol(context);
    await calendarSyncRepo.applyCalendarSyncDescriptor(
      'invoices',
      { sql: `law_firm_id = $1 and id = $2 and ${col} = $3`, params: [context.lawFirmId, invoiceId, context.entityId] },
      descriptor,
      () => null
    );
  }

  /** Minimal calendar-state read the engine needs (calendarSync map + stamps). */
  async getCalendarState(context: any, invoiceId: string) {
    const inv = await this.findById(context, invoiceId);
    if (!inv) return null;
    return inv;
  }
}

export = new InvoicesRepository();
