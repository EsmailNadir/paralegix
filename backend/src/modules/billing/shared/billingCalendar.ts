const crypto = require('crypto');
const { toDate, toIso, toDayKey } = require('../../../shared/utils/dateConversion');
const { toCents, fromCents } = require('./money');
const { invoiceTotalCents } = require('./invoiceStatus');

export function toNumber(value: any) {
  if (typeof value === 'number') return value;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function roundCurrency(value: any) {
  return Math.round(toNumber(value) * 100) / 100;
}

function generateInstallmentId() {
  if (typeof crypto.randomUUID === 'function') {
    return `inst_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `inst_${crypto.randomBytes(16).toString('hex')}`;
}

export function ensureExpectedPaymentsHaveIds(expectedPayments: any[] = []) {
  let changed = false;
  const normalized = (expectedPayments || []).map((payment) => {
    if (payment?.id) return payment;
    changed = true;
    return {
      ...payment,
      id: generateInstallmentId(),
    };
  });

  return { expectedPayments: normalized, changed };
}

export function ensureInvoicePaymentPlanIds(invoice: any) {
  const plan = invoice?.paymentPlan;
  if (!plan?.enabled || !Array.isArray(plan.expectedPayments)) {
    return { invoice, changed: false };
  }

  const { expectedPayments, changed } = ensureExpectedPaymentsHaveIds(plan.expectedPayments);
  if (!changed) return { invoice, changed: false };

  return {
    invoice: {
      ...invoice,
      paymentPlan: {
        ...plan,
        expectedPayments,
      },
    },
    changed: true,
  };
}

/**
 * The invoice's effective billable total, in dollars.
 *
 * This file used to carry its own copy of the fallback chain in float dollars.
 * `invoiceTotalCents` is the same rule in integer cents and is what the invoice
 * composer bills from, so this delegates rather than restating it: two copies
 * of a money rule drift, and the one a calendar entry shows is the one nobody
 * checks against the bill.
 */
export function getInvoiceTotal(invoice: any) {
  return fromCents(invoiceTotalCents(invoice));
}

export function getInvoiceRemainingBalance(invoice: any) {
  // Subtracted in whole cents, converted once. Dollar subtraction here needed a
  // rounding patch to come out right, which is the shape this codebase treats
  // as a defect wherever money is involved.
  const remainingCents = invoiceTotalCents(invoice)
    - toCents(invoice?.amountPaid)
    - toCents(invoice?.totalWrittenOff);
  return fromCents(Math.max(0, remainingCents));
}

function isPendingInstallment(installment: any) {
  return installment?.status === 'pending' || installment?.status === 'overdue';
}

export function getBillingCalendarItems(invoice: any) {
  const { invoice: normalizedInvoice } = ensureInvoicePaymentPlanIds(invoice);
  const remainingBalance = getInvoiceRemainingBalance(normalizedInvoice);
  // A voided invoice is owed nothing and keeps no calendar entry. Returning no
  // items is also what makes the sync engine delete entries already pushed.
  if (
    remainingBalance <= 0
    || normalizedInvoice?.isPaid === true
    || normalizedInvoice?.status === 'credited'
    || normalizedInvoice?.status === 'voided'
  ) {
    return [];
  }

  const plan = normalizedInvoice?.paymentPlan;
  if (plan?.enabled && Array.isArray(plan.expectedPayments)) {
    return plan.expectedPayments
      .map((installment: any, idx: any) => ({ installment, idx }))
      .filter(({ installment }: any) => isPendingInstallment(installment))
      .map(({ installment, idx }: any) => ({
        key: `installment_${installment.id}`,
        billingItemType: 'installment',
        installmentId: installment.id,
        installmentIndex: idx,
        scheduledDate: installment.dueDate || null,
        scheduledAmount: roundCurrency(installment.amount),
      }))
      .filter((item: any) => Boolean(item.scheduledDate));
  }

  const dueDate = toDayKey(normalizedInvoice?.dueDate);
  if (!dueDate) return [];

  return [{
    key: 'dueDate',
    billingItemType: 'invoice_due_date',
    installmentId: null,
    scheduledDate: dueDate,
    scheduledAmount: remainingBalance,
  }];
}

export function buildPaymentDateEntries(invoice: any, meta: any = {}) {
  const { invoice: normalizedInvoice } = ensureInvoicePaymentPlanIds(invoice);

  // Fields shared by every calendar entry derived from this invoice.
  const base = (extra: any) => ({
    invoiceId: normalizedInvoice.id,
    contextType: normalizedInvoice.contextType || meta.contextType || null,
    matterId: normalizedInvoice.matterId || meta.matterId || null,
    matterName: meta.matterName || normalizedInvoice.matterName || null,
    clientId: normalizedInvoice.clientId || meta.clientId || null,
    clientName: normalizedInvoice.clientName || meta.clientName || null,
    invoiceName: normalizedInvoice.invoiceName || null,
    invoiceNumber: normalizedInvoice.invoiceNumber || null,
    totalAmount: getInvoiceTotal(normalizedInvoice),
    amountPaid: roundCurrency(normalizedInvoice.amountPaid),
    totalWrittenOff: roundCurrency(normalizedInvoice.totalWrittenOff || 0),
    ...extra,
  });

  // Upcoming money owed: installment due dates / the invoice due date.
  const scheduled = getBillingCalendarItems(normalizedInvoice).map((item: any) => base({
    id: `${normalizedInvoice.id}:${item.key}`,
    billingItemType: item.billingItemType,
    installmentId: item.installmentId,
    installmentIndex: item.billingItemType === 'installment' ? item.installmentIndex : undefined,
    scheduledAmount: item.scheduledAmount,
    dueDate: item.billingItemType === 'invoice_due_date' ? item.scheduledDate : null,
    nextPaymentDate: item.billingItemType === 'installment' ? item.scheduledDate : null,
  }));

  // Money already received: one entry per recorded payment, on the day it was paid.
  const received = (normalizedInvoice.payments || [])
    .map((payment: any, index: any) => ({ payment, index }))
    .filter(({ payment }: any) => toNumber(payment?.amount) > 0 && toDayKey(payment?.date))
    .map(({ payment, index }: any) => base({
      id: `${normalizedInvoice.id}:payment_${index}`,
      billingItemType: 'payment_received',
      installmentId: null,
      paidAmount: roundCurrency(payment.amount),
      paidDate: toDayKey(payment.date),
      scheduledAmount: null,
      dueDate: null,
      nextPaymentDate: null,
    }));

  return [...scheduled, ...received];
}

export function findBillingSyncItemKey(invoice: any, provider: any, userId: string, externalEventId: any) {
  if (!externalEventId) return null;

  const nestedProviderSync = invoice?.calendarSync?.[provider]?.[userId];
  if (nestedProviderSync && typeof nestedProviderSync === 'object') {
    for (const [key, value] of Object.entries(nestedProviderSync) as Array<[string, any]>) {
      if (value?.eventId === externalEventId) return key;
    }
  }

  return null;
}

/**
 * External calendar event id for a billing item key, from the per-user map.
 * Must stay consistent with findBillingSyncItemKey lookup paths.
 */
export function getBillingProviderEventId(invoice: any, provider: any, userId: string, key: any) {
  if (!key) return null;
  return invoice?.calendarSync?.[provider]?.[userId]?.[key]?.eventId || null;
}

export function getBillingOutlookChangeKey(invoice: any, userId: string, key: any) {
  if (!key) return null;
  const nested = invoice?.calendarSync?.outlook?.[userId]?.[key];
  if (nested && Object.prototype.hasOwnProperty.call(nested, 'changeKey')) {
    return nested.changeKey ?? null;
  }
  return null;
}

/** All billing sync keys stored for a user. */
export function listBillingProviderSyncKeys(invoice: any, provider: any, userId: string) {
  const keys = new Set();

  const perUser = invoice?.calendarSync?.[provider]?.[userId];
  if (perUser && typeof perUser === 'object') {
    Object.keys(perUser).forEach((k) => keys.add(k));
  }

  return [...keys];
}

export function getNextPendingExpectedPayment(expectedPayments: any[] = []) {
  return (expectedPayments || [])
    .filter((payment) => isPendingInstallment(payment) && Boolean(payment?.dueDate))
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0] || null;
}

// Re-exported so callers keep importing these from here.
export { toIso, toDayKey };
