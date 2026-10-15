const crypto = require('crypto');
const dayjs = require('dayjs');
const billingReads = require('../shared/billingReads');
const { allocateWorkToPayers } = require('../shared/splitAllocation');
const { toTimestampOrNull, toDateOnlyOrNull, zonedDayString } = require('../../../shared/utils/time');
const { assertLawFirmMembership, getAccessibleMatterIds, isFirmOwnerOrAdmin } = require('../../../shared/utils/membership');
const { personalToday } = require('../../../shared/utils/personalDay');
const { AppError, ValidationError, NotFoundError, ConflictError } = require('../../../shared/errors/AppError');
const eventBus = require('../../../shared/events/eventBus');
const {
  INVOICE_CREATED,
  INVOICE_UPDATED,
  INVOICE_DELETED,
  INVOICE_PAYMENT_RECEIVED,
  INVOICE_CREDIT_NOTE_ADDED,
} = require('../../../shared/events/eventTypes');
const { resolveContext, authorizeContext, CONTEXT_TYPES, MODE_READ } = require('../context');
const { runWithConcurrency } = require('../../../shared/utils/runWithConcurrency');
const invoicesRepo = require('./invoices.repository');
const { withDrizzleTransaction } = require('../../../shared/database/financialQuery');
const invoiceArchive = require('./invoiceArchive');
const firmBillingService = require('../shared/firmBilling.service');
const { recordAudit } = require('../../audit/audit.service');
const { getFirmBillingSettings } = require('../shared/billingSettings');
const { computeInvoiceDerived } = require('../shared/invoiceDerive');
// The canonical billable total. Every money path in this file goes through it so
// the balance a payment/write-off/late fee is checked against is the SAME number
// deriveInvoiceStatus and the invoice list display. It is the stored total and
// nothing else: a zero total stays zero even beside a positive flatFeesAmount,
// so no reader can bill money the invoice itself does not ask for.
const { invoiceTotalCents, deriveExpectedPayments, assertInvoiceNotVoided } = require('../shared/invoiceStatus');
const { payLinkUrl } = require('../shared/payLinkUrl');
const { payLinkRequest } = require('../shared/payLinkRequest');
const { paymentsWithSurcharge } = require('../shared/paymentOutput');
const { toNum, roundCurrency, toCents, fromCents, formatDollarsFromCents, MAX_PLAN_INSTALLMENTS, percentOfCents, hourlyAmountCents } = require('../shared/money');
const { resolveRateValue } = require('../shared/rateResolution');
const {
  refreshInvoiceRecipients,
  replaceInvoiceRecipientEmails,
  assertHasRecipients,
  resolveCurrentBillingRecipients,
  resolveInvoiceRecipients,
} = require('../shared/billingRecipientSnapshot.service');
const {
  ensureExpectedPaymentsHaveIds,
  ensureInvoicePaymentPlanIds,
  buildPaymentDateEntries,
  getNextPendingExpectedPayment,
} = require('../shared/billingCalendar');
const {
  scheduleDay,
  isOpenInstallment,
  sortScheduleByDate,
  earliestOpenIndex,
  allocatePaymentAcrossOpenRows,
} = require('../shared/paymentPlanSchedule');

/**
 * Split invoices whose calendar events are emitted at once. Kept small because
 * each emit is itself a fan-out over the invoice's billing recipients, so this
 * number multiplies rather than adds: the resources on the far side are the pg
 * pool and the Google/Outlook APIs.
 */
const SPLIT_INVOICE_EMIT_CONCURRENCY = Number(process.env.SPLIT_INVOICE_EMIT_CONCURRENCY) || 3;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function ts(val: any) {
  if (!val) return null;
  // Postgres returns a timestamptz as an ISO string; in-memory values are Dates.
  if (typeof val === 'string') {
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val.toISOString();
  return null;
}
// invoice_date, due_date and next_payment_date are day-only `date` columns. Serialize
// them as 'YYYY-MM-DD' (the UTC calendar day) rather than a full ...T00:00:00.000Z
// timestamp; dayjs on the frontend renders a UTC-midnight timestamp as the previous
// day for viewers behind UTC. paid_date is a real timestamptz and stays on ts().
function dateOnly(val: any) {
  const iso = ts(val);
  return iso ? iso.slice(0, 10) : null;
}
function approxEqual(a: any, b: any) { return Math.abs(roundCurrency(a) - roundCurrency(b)) < 0.01; }

function formatInvoice(inv: any) {
  // Shared derivations (recurringPlanFlatFee, totalAmount, remainingBalance,
  // status, billingPlanName, isRecurringRetainer) come from the canonical
  // computeInvoiceDerived helper so this serializer and firmBilling's
  // mapInvoiceRecord can't drift. Caller-specific fields (amountPaid /
  // totalWrittenOff coercion, the unrounded split shares) stay inline below.
  const { recurringPlanFlatFee, totalAmount, remainingBalance, status, refundDue, billingPlanName, isRecurringRetainer } =
    computeInvoiceDerived(inv);
  const amountPaid = inv.amountPaid || 0;
  const totalWrittenOff: any = inv.totalWrittenOff || 0;
  return {
    id: inv.id,
    contextType: inv.contextType || null,
    entityId: inv.entityId || inv.matterId || inv.clientContextId || null,
    matterId: inv.matterId || null,
    clientContextId: inv.clientContextId || null,
    invoiceName: inv.invoiceName,
    invoiceNumber: inv.invoiceNumber || null,
    invoiceDate: dateOnly(inv.invoiceDate),
    dueDate: dateOnly(inv.dueDate),
    billingEmail: inv.billingEmail || null,
    notes: inv.notes || null,
    clientId: inv.clientId || null,
    clientName: inv.clientName || null,
    clientEmail: inv.clientEmail || null,
    matterClientId: inv.matterClientId || null,
    // Bill-to snapshot, frozen at first external issue. Empty/null until the
    // invoice actually leaves the firm; once set, this - not clientEmail /
    // billingEmail - is what delivery and the PDF bill-to block read.
    billingEmails: inv.billingEmails || [],
    billingContactName: inv.billingContactName || null,
    billingContactTitle: inv.billingContactTitle || null,
    billingContactEmail: inv.billingContactEmail || null,
    billingClientAddress: inv.billingClientAddress || null,
    billingClientName: inv.billingClientName || null,
    billingSnapshotAt: ts(inv.billingSnapshotAt) || null,
    remitTo: inv.remitTo || null,
    timeEntries: inv.timeEntries || [],
    flatFees: inv.flatFees || [],
    expenses: inv.expenses || [],
    totalHours: inv.totalHours || 0,
    totalAmount,
    flatFeesAmount: inv.flatFeesAmount || 0,
    taxRate: inv.taxRate ?? null,
    taxAmount: fromCents(Number(inv.taxCents) || 0),
    subtotalAmount: fromCents(toCents(totalAmount) - (Number(inv.taxCents) || 0)),
    isPaid: inv.isPaid || false,
    status,
    paidDate: ts(inv.paidDate),
    amountPaid,
    // Each payment with the processing fee the client paid on top (0 when none).
    payments: paymentsWithSurcharge(inv.payments),
    nextPaymentDate: dateOnly(inv.nextPaymentDate),
    creditNotes: inv.creditNotes || [],
    // The charge-side adjustments (a late fee, an added amount). The detail view
    // renders them as the "Adjustments" section and reads them to decide whether a
    // late fee has already been applied; without them the total grows with no row
    // explaining why and "Apply late fee" stays enabled, then fails.
    amountAdjustmentNotes: inv.amountAdjustmentNotes || [],
    totalWrittenOff,
    remainingBalance,
    // Money the invoice holds that the firm owes back (a payment after a void, or
    // one past the total); null when there is none.
    refundDue,
    paymentPlan: deriveExpectedPayments(inv.paymentPlan) || null,
    createdAt: ts(inv.createdAt),
    createdBy: inv.createdBy || null,
    updatedAt: ts(inv.updatedAt),
    updatedBy: inv.updatedBy || null,
    splitGroupId: inv.splitGroupId || null,
    splitMode: inv.splitMode || null,
    splitRecipientCount: inv.splitRecipientCount || null,
    // Reconciled with firmBilling.mapInvoiceRecord: both serializers now round the
    // split-share fields to display precision so the firm-list shape and the detail
    // shape report identical precision for the same invoice. (split_share_cents reads
    // back as an exact whole-cent dollar value, so the amount round is a no-op; the
    // percent, numeric in the DB, is the field that could actually differ.
    splitShareAmount: inv.splitShareAmount != null ? roundCurrency(inv.splitShareAmount) : null,
    splitSharePercent: inv.splitSharePercent != null ? roundCurrency(inv.splitSharePercent) : null,
    billingPlanId: inv.billingPlanId || null,
    billingPlanPeriodId: inv.billingPlanPeriodId || null,
    billingPlanName,
    billingPlanType: inv.billingPlanType || null,
    isRecurringRetainer,
    stripePaymentRequested: inv.stripePaymentRequested || false,
    stripePaymentStatus: inv.stripePaymentStatus || null,
    stripePaymentRequestedBy: inv.stripePaymentRequestedBy || null,
    // Whether the client pays each processing fee on the open payment request.
    isCardFeePassedOn: inv.isCardFeePassedOn === true,
    isBankFeePassedOn: inv.isBankFeePassedOn === true,
    // The open payment request's link, for the firm to copy and send itself.
    paymentLinkUrl: inv.stripePaymentRequested && inv.payLinkToken ? payLinkUrl(inv.payLinkToken) : null,
    // The installment that link asks for, by its stable id; null for the full balance.
    payLinkInstallmentId: inv.payLinkInstallmentId || null,
    lastReminderSentAt: ts(inv.lastReminderSentAt) || null,
    reminderCount: inv.reminderCount || 0,
    reminderOptOut: inv.reminderOptOut || false,
  };
}

/**
 * Refuse a plan that would need more than MAX_PLAN_INSTALLMENTS schedule rows.
 * The count is arithmetic on integer cents, so a typo like 0.01 against a large
 * balance is turned away before a single row is built.
 */
function assertPlanWithinInstallmentCap(regularCents: number, installmentCents: number, extraRows: number) {
  const regularRows = regularCents > 0 ? Math.ceil(regularCents / Math.max(1, installmentCents)) : 0;
  if (regularRows + extraRows > MAX_PLAN_INSTALLMENTS) {
    throw new ValidationError(
      `This plan would need ${regularRows + extraRows} instalments, but a payment plan can have at most `
      + `${MAX_PLAN_INSTALLMENTS}. Use a larger installment amount.`,
    );
  }
}

/**
 * The first regular instalment sits one period after the start date when a down
 * payment occupies the start date itself, and on it otherwise. Row `i` is then
 * `scheduleDay(planStartDate, firstRegularIndex + i)`.
 */
function firstRegularIndexOf(plan: any) {
  const start = String(plan.planStartDate || '').slice(0, 10);
  const regularStart = String(plan.regularInstallmentStartDate || '').slice(0, 10);
  return start && regularStart && regularStart !== start ? 1 : 0;
}

/** The day a plan's dates are measured from: its start day, or failing that its first regular day. */
function planAnchorDay(plan: any) {
  return String(plan.planStartDate || plan.regularInstallmentStartDate || '').slice(0, 10);
}

/**
 * The days a plan's schedule continues on after `afterDay`, one per call.
 *
 * When `afterDay` is itself a day of the plan's series (its start day plus whole
 * periods) the series carries on, so a plan that began on the 31st returns to
 * the 31st after a short month. When it is not, because the dates were edited or
 * the schedule was replaced, the schedule steps on from `afterDay` itself. A
 * plan with no start day on record steps from `afterDay` the same way.
 */
function onCadenceDaysAfter(plan: any, afterDay: string | null) {
  const frequencyDays = Number(plan.frequencyDays) || 30;
  const anchor = planAnchorDay(plan);
  const steppingFrom = (from: string) => {
    let step = 0;
    return () => { step += 1; return scheduleDay(from, step, frequencyDays); };
  };
  if (!anchor) return steppingFrom(afterDay || dayjs().format('YYYY-MM-DD'));

  if (!afterDay) {
    let index = firstRegularIndexOf(plan);
    return () => { const day = scheduleDay(anchor, index, frequencyDays); index += 1; return day; };
  }

  // Land just before `afterDay`, then walk forward to it. The estimate never
  // overshoots, so the walk is a handful of steps whatever the cadence.
  const gapDays = Math.max(0, dayjs(afterDay).diff(dayjs(anchor), 'day'));
  let index = Math.max(0, Math.floor(gapDays / (frequencyDays === 30 ? 31 : frequencyDays)) - 1);
  while (scheduleDay(anchor, index, frequencyDays) < afterDay) index += 1;
  if (scheduleDay(anchor, index, frequencyDays) !== afterDay) return steppingFrom(afterDay);
  index += 1;
  return () => { const day = scheduleDay(anchor, index, frequencyDays); index += 1; return day; };
}

/** The latest due date on the schedule, or null when it has none. */
function lastScheduledDay(expectedPayments: any[] = []) {
  return (expectedPayments || []).reduce(
    (latest: string | null, ep: any) => (ep?.dueDate && (!latest || String(ep.dueDate) > latest) ? String(ep.dueDate) : latest),
    null,
  );
}

/**
 * Refuse a schedule that has no room for one more row. Every path that can add
 * a row (a carried shortfall, a lowered last instalment, a late fee) checks here,
 * so the plan limit holds whatever way the schedule grew.
 */
function assertRoomForAnotherInstallment(expectedPayments: any[] = []) {
  if (expectedPayments.length >= MAX_PLAN_INSTALLMENTS) {
    throw new ValidationError(
      `A payment plan can have at most ${MAX_PLAN_INSTALLMENTS} instalments, and this one is full. `
      + 'Change the amounts of the instalments that are still open instead.',
    );
  }
}

/**
 * A new open row for `cents`, dated on the plan's cadence after the schedule's
 * last date. The caller has already checked there is room for it.
 */
function newInstallmentAfterLast(plan: any, expectedPayments: any[], cents: number) {
  const nextDay = onCadenceDaysAfter(plan, lastScheduledDay(expectedPayments))();
  return { dueDate: nextDay, amount: fromCents(cents), status: 'pending', matchedPaymentIndex: null };
}

/**
 * Build a payment plan's schedule from nothing.
 * Returns the new expectedPayments array, or null if plan should be removed.
 *
 * Row `i` falls on the plan's start day plus `i` periods (see `scheduleDay`),
 * which is the same schedule the plan form previews.
 */
function rebuildSchedule(plan: any, remaining: any) {
  if (remaining <= 0) return null;

  const { installmentAmount, frequencyDays } = plan;
  const expectedPayments = [];
  const anchor = planAnchorDay(plan);
  const firstIndex = firstRegularIndexOf(plan);

  // BL #3: do the schedule fill in integer cents so the installments sum EXACTLY
  // to `remaining` (no float drift, no lost/gained cent on the final installment).
  const remainingCents = toCents(remaining);
  const installmentCents = Math.max(1, toCents(installmentAmount));
  let runningCents = 0;

  while (runningCents < remainingCents) {
    const amtCents = Math.min(installmentCents, remainingCents - runningCents);
    expectedPayments.push({
      dueDate: scheduleDay(anchor, firstIndex + expectedPayments.length, frequencyDays),
      amount: fromCents(amtCents),
      status: 'pending',
      matchedPaymentIndex: null,
    });
    runningCents += amtCents;
  }
  return normalizeExpectedPayments(expectedPayments);
}

/**
 * Re-fit a payment plan's schedule to a new remaining balance WITHOUT disturbing
 * installments that have already been paid.
 *
 * Settled rows carry over verbatim and only the open tail is refilled, in
 * instalments of the plan's own `installmentAmount`. The tail reuses its existing
 * due dates, in date order, so an edit does not move dates the client has already
 * been told about; past the last known date the plan's own cadence continues. An
 * open row keeps its identity (id, pre-due reminder stamp, Stripe link) at its
 * position in the tail, so a refit that leaves a row's date alone leaves its
 * reminder history alone too. An open down payment keeps its own amount.
 *
 * The open amounts sum EXACTLY to `remainingCents` (integer cents, no drift).
 * Returns the new expectedPayments array, or null when there is nothing left to
 * schedule and the caller should drop the plan entirely.
 */
function rebalancePendingInstallments(plan: any, expectedPayments: any, remainingCents: any) {
  const all = sortScheduleByDate(normalizeExpectedPayments(expectedPayments || []));
  const settled = all.filter((ep: any) => ep.status === 'paid');
  if (remainingCents <= 0) return settled.length ? settled : null;

  const open = all.filter((ep: any) => ep.status !== 'paid');
  const openDownPayment = open.find((ep: any) => ep.isDownPayment) || null;
  const templates = open.filter((ep: any) => ep !== openDownPayment);
  const installmentCents = Math.max(1, toCents(plan.installmentAmount));

  // A tiny installment against a large balance would otherwise spin out tens of
  // thousands of rows. Paid rows count toward the plan limit, so the open
  // rows get what is left of it (at least one, to carry the balance), and past
  // that the whole remainder lands on the last one.
  const maxOpen = Math.max(1, MAX_PLAN_INSTALLMENTS - settled.length - (openDownPayment ? 1 : 0));

  const out = [...settled];
  let filledCents = 0;
  if (openDownPayment) {
    const downCents = Math.min(toCents(openDownPayment.amount || 0), remainingCents);
    if (downCents > 0) {
      out.push({ ...openDownPayment, amount: fromCents(downCents), status: 'pending', matchedPaymentIndex: null });
      filledCents = downCents;
    }
  }

  const nextGeneratedDay = onCadenceDaysAfter(plan, lastScheduledDay(all));
  let i = 0;
  while (filledCents < remainingCents) {
    const atCap = i >= maxOpen - 1;
    const amtCents = atCap
      ? remainingCents - filledCents
      : Math.min(installmentCents, remainingCents - filledCents);
    const template = templates[i];
    out.push({
      ...(template || {}),
      dueDate: template ? template.dueDate : nextGeneratedDay(),
      amount: fromCents(amtCents),
      status: 'pending',
      matchedPaymentIndex: null,
    });
    filledCents += amtCents;
    i += 1;
  }
  return normalizeExpectedPayments(sortScheduleByDate(out));
}

/**
 * Reopen the rows a payment had settled: back to pending, unlinked. The rows keep
 * the amount they were settled at, so the caller refits the open tail afterwards
 * (a row the payment settled short, or a neighbour that carried its shortfall,
 * goes back to the plan's own instalment amount that way).
 */
function reopenInstallmentsSettledBy(expectedPayments: any[] = [], paymentIndex: number) {
  return (expectedPayments || []).map((ep: any) => (
    ep.status === 'paid' && ep.matchedPaymentIndex === paymentIndex
      ? { ...ep, status: 'pending', matchedPaymentIndex: null }
      : ep
  ));
}

/**
 * The plan fields to write after Stripe fully reversed (refunded or disputed)
 * the payment at `paymentIndex`. One payment can have settled several rows and
 * shrunk the next, so every row it settled is reopened and the open rows are
 * refit to `remainingCents`, the balance now owed. The Stripe payment keeps its
 * place in `payments[]` (the reversal handlers find it by its payment intent),
 * so no other row's index shifts.
 */
export function reopenPlanAfterStripeReversal(plan: any, paymentIndex: number, remainingCents: number) {
  const reopened = reopenInstallmentsSettledBy(normalizeExpectedPayments(plan.expectedPayments || []), paymentIndex);
  const refit = (remainingCents > 0 ? rebalancePendingInstallments(plan, reopened, remainingCents) : reopened) || [];
  return syncDueDateToLastInstallment({
    paymentPlan: { ...plan, expectedPayments: refit },
    nextPaymentDate: getNextPaymentTimestamp(refit),
  });
}

/**
 * An instalment whose amount must not be rewritten by a reconciliation: a paid
 * one carries payment linkage. A payment link prices the current open row;
 * a checkout already priced for a changed row must expire before the edit.
 */
function isFixedInstallment(ep: any) {
  return ep.status === 'paid';
}

/** What the unpaid instalments together have to collect. */
function unscheduledCents(expectedPayments: any[] = []) {
  return (expectedPayments || []).reduce(
    (sum: number, ep: any) => (ep.status === 'paid' ? sum : sum + toCents(ep.amount || 0)),
    0,
  );
}

/**
 * Keep the schedule adding up to the balance after ONE instalment is edited.
 * Editing an instalment moves the schedule total off the invoice total, and
 * nothing else recomputes it, so the plan goes on collecting the wrong amount:
 * a raised instalment over-collects, and a lowered one leaves a balance no
 * instalment is scheduled to pay, so the invoice never settles.
 *
 * `rebalancePendingInstallments` cannot do this job. It rebuilds the whole tail
 * from the plan's own `installmentAmount`, which would erase the very edit that
 * was asked for. So the edited instalment keeps exactly what the firm typed and
 * the difference is absorbed by the instalments AFTER it, back to front. A
 * shortfall with nothing after it extends the schedule by one instalment (and is
 * refused when the plan already holds the most instalments it may); an
 * overage with nothing after it is refused, because the alternative is asking
 * the client for more than the invoice.
 */
function absorbInstallmentDelta(expectedPayments: any[], editedIndex: number, targetCents: number, plan: any) {
  const out = expectedPayments.map((ep: any) => ({ ...ep }));
  const adjustable = (idx: number) => idx > editedIndex && !isFixedInstallment(out[idx]);
  const diff = targetCents - unscheduledCents(out);
  if (diff === 0) return normalizeExpectedPayments(out);

  if (diff > 0) {
    for (let i = out.length - 1; i > editedIndex; i -= 1) {
      if (!adjustable(i)) continue;
      out[i].amount = fromCents(toCents(out[i].amount || 0) + diff);
      return normalizeExpectedPayments(out);
    }
    assertRoomForAnotherInstallment(out);
    out.push(newInstallmentAfterLast(plan, out, diff));
    return normalizeExpectedPayments(out);
  }

  let over = -diff;
  for (let i = out.length - 1; i > editedIndex && over > 0; i -= 1) {
    if (!adjustable(i)) continue;
    const cents = toCents(out[i].amount || 0);
    const take = Math.min(cents, over);
    out[i].amount = fromCents(cents - take);
    over -= take;
  }
  if (over > 0) {
    throw new ValidationError(
      `That instalment is more than this payment plan still has to collect (${formatDollarsFromCents(targetCents)}).`,
    );
  }
  // An instalment shaved to nothing is a schedule row asking for a payment of
  // zero, so it leaves the plan rather than staying on it at $0.
  return normalizeExpectedPayments(
    out.filter((ep: any, idx: number) => idx <= editedIndex || isFixedInstallment(ep) || toCents(ep.amount || 0) > 0),
  );
}

/**
 * BL8: after a payment is removed from `payments[]` at `removedIndex`, every
 * installment whose `matchedPaymentIndex` pointed PAST the removed payment is
 * now off by one, and any pointing AT it is dangling. Re-point survivors and
 * null-out the dangling reference so installment→payment matching stays correct.
 * Returns a new expectedPayments array (does not mutate the input).
 */
function reindexMatchedPaymentIndices(expectedPayments: any[] = [], removedIndex: any) {
  return (expectedPayments || []).map((ep) => {
    const idx = ep.matchedPaymentIndex;
    if (typeof idx !== 'number') return ep;
    if (idx === removedIndex) return { ...ep, matchedPaymentIndex: null };
    if (idx > removedIndex) return { ...ep, matchedPaymentIndex: idx - 1 };
    return ep;
  });
}

async function getClientRecordById(lawFirmId: string, clientId: string) {
  return billingReads.getClient(lawFirmId, clientId);
}

/**
 * Resolve the billing client for a matter invoice. The matterClientId passed from
 * the client is now the `clients` uuid (matter_clients junction → clients), so the
 * snapshot is just the client record. `clientId` (used for trust linkage) is the
 * clients uuid.
 */
async function resolveMatterClientSnapshot(lawFirmId: string, matterId: string, matterClientId: any) {
  if (!matterClientId) return null;
  const client = await billingReads.getClient(lawFirmId, matterClientId);
  if (!client) return null;
  return {
    matterClientId: client.id,
    clientId: client.id,
    clientName: client.name || client.email || null,
    clientEmail: client.email || null,
    clientRecord: client,
  };
}

async function resolveInvoiceClientSnapshot({ lawFirmId, context, invoiceClientId, billingEmail }: any) {
  if (context.type === CONTEXT_TYPES.matter) {
    const matterClient = await resolveMatterClientSnapshot(lawFirmId, context.entityId, invoiceClientId);
    return {
      clientId: matterClient?.clientId || null,
      matterClientId: invoiceClientId || null,
      clientName: matterClient?.clientName || null,
      clientEmail: matterClient?.clientEmail || null,
      billingEmail: billingEmail || matterClient?.clientEmail || null,
      clientRecord: matterClient?.clientRecord || null,
    };
  }

  const clientRecord = await getClientRecordById(lawFirmId, context.entityId);
  return {
    clientId: context.entityId,
    matterClientId: null,
    clientName: clientRecord?.name || clientRecord?.email || null,
    clientEmail: clientRecord?.email || null,
    billingEmail: billingEmail || clientRecord?.email || null,
    clientRecord: clientRecord || null,
  };
}

/**
 * Who this DRAFT would be billed to if it went out now.
 *
 * Creation deliberately resolves CURRENT recipients and does not snapshot: the
 * bill-to record freezes on first external issue, not on drafting (the plan's
 * "Invoice history" contract). The composer needs the list to show the firm who
 * will receive the invoice, especially for a company client whose recipients
 * live on the contact roster and never appear in `clients.email`.
 *
 * Reuses the client row `resolveInvoiceClientSnapshot` already read, so a
 * person client costs no extra query and a company costs one roster read.
 */
async function currentRecipientsForDraft(lawFirmId: string, clientSnapshot: any) {
  return resolveCurrentBillingRecipients({
    lawFirmId,
    clientId: clientSnapshot.clientId,
    overrideEmail: clientSnapshot.billingEmail,
    client: clientSnapshot.clientRecord,
  });
}

function resolveInvoiceContext({ lawFirmId, matterId, clientId, bodyContext, bodyMatterId, bodyClientId }: any) {
  return resolveContext({
    lawFirmId,
    context: bodyContext,
    matterId: matterId || bodyMatterId,
    clientId: clientId || bodyClientId,
  });
}

function contextScopedIds(context: any) {
  return {
    matterId: context.type === CONTEXT_TYPES.matter ? context.entityId : null,
    clientId: context.type === CONTEXT_TYPES.client ? context.entityId : null,
  };
}

function sumLineAmounts(items: any[] = []) {
  // BL #3: sum each line amount in whole cents, then convert once. Summing floats
  // and rounding only at the end lets dust accumulate across many lines.
  return fromCents(items.reduce((sum, item) => sum + toCents(item.amount), 0));
}

function sumLineHours(items: any[] = []) {
  return roundCurrency(items.reduce((sum, item) => sum + toNum(item.hours), 0));
}

function buildValidationError(message: any, details = undefined) {
  if (details) {
    const err: any = new ValidationError(details);
    err.message = message;
    return err;
  }
  return new ValidationError({ splitInvoices: [message] });
}

function normalizeExpectedPayments(expectedPayments: any[] = []) {
  return ensureExpectedPaymentsHaveIds(expectedPayments).expectedPayments;
}

/**
 * Give every row of a plan's schedule an id, on the plan object itself. A row is
 * matched across a schedule change by its id, and a row stored without one only
 * has an id from the first normalisation, so the plan has to carry it before
 * the rows before and after the change are compared.
 */
function ensurePlanRowIds(plan: any) {
  if (plan && Array.isArray(plan.expectedPayments)) {
    plan.expectedPayments = normalizeExpectedPayments(plan.expectedPayments);
  }
  return plan;
}

// `nextPaymentDate` feeds `invoices.next_payment_date`, a day-only `date`
// column - `toDateOnlyOrNull` keeps the schedule's literal 'YYYY-MM-DD',
// where `toTimestampOrNull` would read a UTC instant's calendar day instead
// and could shift by one if the value ever carried a time/offset.
function getNextPaymentTimestamp(expectedPayments: any[] = []) {
  const nextPending = getNextPendingExpectedPayment(expectedPayments);
  return nextPending ? toDateOnlyOrNull(nextPending.dueDate) : null;
}

/**
 * Keep `dueDate` in sync with the payment plan: dueDate represents when the
 * invoice is fully due, which for a plan is the LAST installment's due date
 * (not the first, and not a value independently tracked elsewhere). Called
 * from every place that builds, rebuilds, rebalances, or edits
 * `expectedPayments` so dueDate never drifts from the schedule without a
 * separate edit at each call site. It also stores the schedule in due-date
 * order, so every write leaves the rows in the order they fall due.
 *
 * A no-op when the update does not touch paymentPlan.expectedPayments (or
 * clears it to an empty/null schedule) - dueDate is left as whatever the
 * caller already set. Plan removal is handled separately: see the comment
 * in removePaymentPlan for why dueDate is deliberately left alone there.
 */
function syncDueDateToLastInstallment(updateFields: any) {
  const expectedPayments = updateFields?.paymentPlan?.expectedPayments;
  if (!Array.isArray(expectedPayments) || expectedPayments.length === 0) return updateFields;
  updateFields.paymentPlan = {
    ...updateFields.paymentPlan,
    expectedPayments: sortScheduleByDate(expectedPayments),
  };
  // dueDate values are 'YYYY-MM-DD' strings, which sort correctly with a
  // plain string comparison - no need to parse them into Date objects.
  const lastDueDate = expectedPayments.reduce(
    (latest: any, ep: any) => (!latest || ep.dueDate > latest ? ep.dueDate : latest),
    null,
  );
  if (lastDueDate) updateFields.dueDate = toDateOnlyOrNull(lastDueDate);
  return updateFields;
}

async function ensureInvoiceCalendarSyncState(context: any, invoice: any) {
  if (!invoice?.id) return invoice;

  const { invoice: normalizedInvoice, changed } = ensureInvoicePaymentPlanIds(invoice);
  if (!changed) return invoice;

  return invoicesRepo.update(context, invoice.id, {
    paymentPlan: normalizedInvoice.paymentPlan,
  });
}

async function emitInvoiceCalendarEvent(eventName: any, { lawFirmId, context, actingUserId, invoice }: any) {
  const normalizedInvoice = await ensureInvoiceCalendarSyncState(context, invoice);
  if (!normalizedInvoice?.id) return normalizedInvoice;

  const payload = {
    lawFirmId,
    invoiceId: normalizedInvoice.id,
    userId: actingUserId,
    invoiceData: {
      ...normalizedInvoice,
      lawFirmId,
    },
  };

  if (
    eventName === INVOICE_CREATED
    || eventName === INVOICE_UPDATED
    || eventName === INVOICE_DELETED
  ) {
    await eventBus.emitAsync(eventName, payload);
  } else {
    eventBus.emit(eventName, payload);
  }

  return normalizedInvoice;
}

/**
 * Re-sync external calendars after an invoice was updated outside invoices.service
 * (e.g. Stripe webhooks). Loads latest invoice state then emits INVOICE_UPDATED.
 */
export async function refreshInvoiceCalendarSyncAfterPersistence({ lawFirmId, context, invoiceId, actingUserId }: any) {
  const invoice = await invoicesRepo.findById(context, invoiceId);
  if (!invoice) return null;
  return emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice,
  });
}

/**
 * Emit INVOICE_DELETED for every invoice in a billing context so Google/Outlook billing
 * events are removed before invoice rows are bulk-deleted (e.g. matter/client removal).
 * Uses emitAsync so calendar listeners finish before callers delete invoice records.
 */
export async function emitCalendarDeletesForInvoicesInContext({ lawFirmId, context, actingUserId }: any) {
  if (!lawFirmId || !context?.entityId) return;

  const invoices = await invoicesRepo.listAll(context);
  for (const inv of invoices) {
    const normalizedInvoice = await ensureInvoiceCalendarSyncState(context, inv);
    if (!normalizedInvoice?.id) continue;
    const uid = actingUserId ?? normalizedInvoice.updatedBy ?? normalizedInvoice.createdBy ?? null;
    await eventBus.emitAsync(INVOICE_DELETED, {
      lawFirmId,
      invoiceId: normalizedInvoice.id,
      userId: uid,
      invoiceData: {
        ...normalizedInvoice,
        lawFirmId,
      },
    });
  }
}

function toIsoDateString(val: any) {
  if (!val) return null;
  if (typeof val === 'string') return val.length >= 10 ? val.slice(0, 10) : val;
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val.toISOString().slice(0, 10);
  }
  return null;
}

export async function applyBillingCalendarSyncUpdate({
  lawFirmId,
  invoice,
  billingItemKey,
  scheduledDate,
  actingUserId,
  provider,
  modifiedAt,
}: any) {
  if (!invoice?.id || !billingItemKey || !scheduledDate) return invoice;

  const context = {
    type: invoice.contextType,
    lawFirmId,
    entityId: invoice.entityId || invoice.matterId || invoice.clientContextId || invoice.clientId,
  };

  let workingInvoice = await ensureInvoiceCalendarSyncState(context, invoice);

  // Date-equality short-circuit: if the calendar-derived scheduledDate
  // matches what's already stored, skip the write and the INVOICE_UPDATED
  // emit. This kills the bouncing loop where a Google/Outlook webhook
  // re-asserts the same date and triggers another cross-sync push.
  const incomingDate = toIsoDateString(scheduledDate);
  if (incomingDate) {
    if (billingItemKey === 'dueDate') {
      if (toIsoDateString(workingInvoice.dueDate) === incomingDate) return workingInvoice;
    } else if (billingItemKey.startsWith('installment_')) {
      const installmentId = billingItemKey.replace(/^installment_/, '');
      const existing = (workingInvoice.paymentPlan?.expectedPayments || [])
        .find((p: any) => p.id === installmentId);
      if (existing && toIsoDateString(existing.dueDate) === incomingDate) return workingInvoice;
    }
  }

  const updateData: any = {
    updatedAt: new Date().toISOString(),
    updatedBy: actingUserId,
  };

  if (provider === 'google' && modifiedAt) {
    updateData.googleLastModified = new Date(modifiedAt);
  }
  if (provider === 'outlook' && modifiedAt) {
    updateData.outlookLastModified = new Date(modifiedAt);
  }

  if (billingItemKey === 'dueDate') {
    // `dueDate` is a day-only `date` column; `toDateOnlyOrNull` keeps the
    // literal calendar date a synced calendar event carries instead of
    // reading it back off a UTC instant, which can shift by a day near a
    // negative-offset midnight (see `toDateOnlyOrNull`'s doc comment).
    updateData.dueDate = toDateOnlyOrNull(scheduledDate);
  } else if (billingItemKey.startsWith('installment_')) {
    const installmentId = billingItemKey.replace(/^installment_/, '');
    const expectedPayments = normalizeExpectedPayments([...(workingInvoice.paymentPlan?.expectedPayments || [])]);
    const installmentIndex = expectedPayments.findIndex((payment: any) => payment.id === installmentId);
    if (installmentIndex < 0) {
      return workingInvoice;
    }

    expectedPayments[installmentIndex] = {
      ...expectedPayments[installmentIndex],
      dueDate: scheduledDate,
    };

    updateData.paymentPlan = {
      ...workingInvoice.paymentPlan,
      expectedPayments,
    };
    updateData.nextPaymentDate = getNextPaymentTimestamp(expectedPayments);
    syncDueDateToLastInstallment(updateData);
  } else {
    return workingInvoice;
  }

  let updatedInvoice = await invoicesRepo.update(context, workingInvoice.id, updateData);
  updatedInvoice = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updatedInvoice,
  });

  return updatedInvoice;
}

/* ------------------------------------------------------------------ */
/*  Service functions                                                   */
/* ------------------------------------------------------------------ */

/**
 * Create (save) an invoice on a matter.
 */
export async function createInvoice({ lawFirmId, matterId, clientId, actingUserId, body }: any) {
  const inferredClientContextId = (!matterId && !body.matterId) ? body.clientId : undefined;
  const context = resolveInvoiceContext({
    lawFirmId,
    matterId,
    clientId,
    bodyContext: body.context,
    bodyMatterId: body.matterId,
    bodyClientId: body.contextClientId || inferredClientContextId,
  });
  await authorizeContext(context, actingUserId);

  const {
    invoiceName, invoiceNumber, invoiceDate, dueDate, billingEmail, notes,
    clientId: invoiceClientId, remitTo, timeEntries, flatFees, expenses,
    totalAmount,
    billingPlanId, billingPlanPeriodId, billingPlanName, billingPlanType,
  } = body;
  const resolvedInvoiceName = String(
    invoiceName ||
    billingPlanName ||
    invoiceNumber ||
    `Invoice ${dayjs().format('YYYYMMDD-HHmmss')}`
  ).trim();

  // A matter invoice bills one of the matter's own clients, the same rule a
  // split invoice and a plan-created draft hold.
  if (context.type === CONTEXT_TYPES.matter && invoiceClientId
      && !(await billingReads.isClientOnMatter(lawFirmId, context.entityId, invoiceClientId))) {
    throw new ValidationError({ clientId: ['The client must be a client on this matter.'] });
  }

  // BL11: pre-read uniqueness check (fast path); the unique index
  // (law_firm_id, context, lower(invoice_name)) is the real backstop against a
  // concurrent duplicate, handled below on create.
  const existing = await invoicesRepo.findByInvoiceName(context, resolvedInvoiceName);
  if (existing.length > 0) {
    throw new ValidationError('Invoice name already exists for this matter');
  }

  const clientSnapshot = await resolveInvoiceClientSnapshot({
    lawFirmId,
    context,
    invoiceClientId,
    billingEmail,
  });
  const scoped = contextScopedIds(context);

  // Never trust client-supplied monetary totals. Recompute them from the line
  // items server-side (same approach as createSplitInvoices and
  // bulkCreateInvoices) and persist the server-recomputed values regardless of
  // what was sent. Only assert a supplied total when the caller explicitly sent
  // a non-zero one. That preserves the anti-underbilling check (a client
  // sending totalAmount: 1 against $1500 of line items still throws) without
  // breaking legitimate callers who send line items but omit totalAmount (the
  // Zod default of 0).
  const lineTimeEntries = timeEntries || [];
  const lineFlatFees = flatFees || [];
  const lineExpenses = expenses || [];

  // Early feedback for stale selections. The repository repeats this check
  // under a transaction-scoped context lock for create, split and edit writes.
  const existingContextInvoices = await invoicesRepo.findByContext(context);
  const { timeEntryIds: billedTimeEntryIds, flatFeeIds: billedFlatFeeIds, expenseIds: billedExpenseIds } =
    billingReads.collectBilledIds(existingContextInvoices);
  const alreadyBilled = lineTimeEntries.filter((te: any) => billingReads.isBilled(billedTimeEntryIds, te)).length
    + lineFlatFees.filter((ff: any) => billingReads.isBilled(billedFlatFeeIds, ff)).length
    + lineExpenses.filter((ex: any) => billingReads.isBilled(billedExpenseIds, ex)).length;
  if (alreadyBilled > 0) {
    throw new ValidationError('One or more selected items are already billed on another invoice');
  }

  // Time written off as non-billable must never reach a client invoice, whatever
  // the caller sent. Same reasoning as the double-billing guard above: the
  // composer filters these out, but a direct call or a stale tab would not.
  const nonBillableIds = await billingReads.listNonBillableSourceIds(
    lawFirmId,
    [...lineTimeEntries, ...lineFlatFees, ...lineExpenses].map((line: any) => line.id),
  );
  if (nonBillableIds.size > 0) {
    throw new ValidationError('One or more selected items are marked non-billable and cannot be invoiced');
  }

  const computedTimeAmount = sumLineAmounts(lineTimeEntries);
  const computedFlatFeesAmount = sumLineAmounts(lineFlatFees);
  const computedExpensesAmount = sumLineAmounts(lineExpenses);
  const computedTotalAmount = fromCents(
    toCents(computedTimeAmount) + toCents(computedFlatFeesAmount) + toCents(computedExpensesAmount),
  );
  const computedTotalHours = sumLineHours(lineTimeEntries);

  const suppliedTotal = toNum(totalAmount);
  if (suppliedTotal !== 0 && !approxEqual(computedTotalAmount, suppliedTotal)) {
    throw new ValidationError('Invoice total does not match line items');
  }

  // Optional tax: applied on top of the line-item subtotal. The rate comes from
  // the invoice (if the caller sent one) otherwise the firm default when tax is
  // enabled. tax_cents is folded into total_cents so balance/payment/status logic
  // is unchanged; the rate + tax amount are stored for display and the PDF.
  const billingSettings = await getFirmBillingSettings(lawFirmId);
  const taxConfig = billingSettings.tax || {};
  const effectiveTaxRate = body.taxRate != null
    ? Number(body.taxRate)
    : (taxConfig.enabled ? Number(taxConfig.defaultRate) || 0 : 0);
  const subtotalCents = toCents(computedTotalAmount);
  const taxCents = effectiveTaxRate > 0 ? percentOfCents(subtotalCents, effectiveTaxRate) : 0;
  const totalWithTaxAmount = fromCents(subtotalCents + taxCents);

  const docData = {
    invoiceName: resolvedInvoiceName,
    invoiceNumber: invoiceNumber || null,
    invoiceDate: toDateOnlyOrNull(invoiceDate),
    dueDate: toDateOnlyOrNull(dueDate),
    billingEmail: clientSnapshot.billingEmail,
    notes: notes || null,
    clientId: clientSnapshot.clientId,
    clientName: clientSnapshot.clientName,
    clientEmail: clientSnapshot.clientEmail,
    matterClientId: clientSnapshot.matterClientId,
    contextType: context.type,
    entityId: context.entityId,
    matterId: scoped.matterId,
    clientContextId: scoped.clientId,
    remitTo: remitTo || null,
    timeEntries: lineTimeEntries,
    flatFees: lineFlatFees,
    expenses: lineExpenses,
    totalHours: computedTotalHours,
    totalAmount: totalWithTaxAmount,
    flatFeesAmount: computedFlatFeesAmount,
    taxRate: effectiveTaxRate > 0 ? effectiveTaxRate : null,
    taxCents,
    billingPlanId: billingPlanId || null,
    billingPlanPeriodId: billingPlanPeriodId || null,
    billingPlanName: billingPlanName || null,
    billingPlanType: billingPlanType || null,
    isRecurringRetainer: billingPlanType === 'retainer' || Boolean(billingPlanId),
    isPaid: false,
    paidDate: null,
    amountPaid: 0,
    payments: [],
    nextPaymentDate: null,
    createdAt: new Date().toISOString(),
    createdBy: actingUserId,
    updatedAt: new Date().toISOString(),
    updatedBy: actingUserId,
  };

  let invoice;
  try {
    invoice = await invoicesRepo.create(context, docData);
  } catch (createErr: any) {
    // BL11: unique-index violation on invoice_name (or invoice_number) → 400.
    if (createErr?.code === '23505') {
      throw new ValidationError('Invoice name or number already exists for this matter');
    }
    throw createErr;
  }
  invoice = await emitInvoiceCalendarEvent(INVOICE_CREATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice,
  });
  const billingRecipients = await currentRecipientsForDraft(lawFirmId, clientSnapshot);
  return {
    message: 'Invoice saved successfully',
    invoice: formatInvoice(invoice),
    billingRecipients,
  };
}

export async function createSplitInvoices({ lawFirmId, matterId, actingUserId, body }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId });
  await authorizeContext(context, actingUserId);

  if (context.type !== CONTEXT_TYPES.matter) {
    throw buildValidationError('Split invoices are only supported for matter billing.');
  }

  const {
    invoiceDate,
    dueDate,
    notes,
    remitTo,
    splitMode,
    sourceSelection,
    invoices,
  } = body;

  const selectedTimeEntryIds = Array.from(new Set(sourceSelection?.timeEntries || []));
  const selectedFlatFeeIds = Array.from(new Set(sourceSelection?.flatFees || []));
  const hasManualItems = invoices.some((inv: any) =>
    (inv.timeEntries || []).some((e: any) => !e.id) ||
    (inv.flatFees || []).some((f: any) => !f.id)
  );
  if (selectedTimeEntryIds.length === 0 && selectedFlatFeeIds.length === 0 && !hasManualItems) {
    throw buildValidationError('Select at least one time entry or flat fee to split.');
  }

  const [summary, existingInvoices, matterClientsList] = await Promise.all([
    getUnbilledSummary({ lawFirmId, matterId, actingUserId }),
    invoicesRepo.findByContext(context),
    billingReads.listMatterClients(lawFirmId, matterId),
  ]);

  const existingNames = new Set(existingInvoices.map((invoice: any) => String(invoice.invoiceName || '').trim().toLowerCase()).filter(Boolean));
  const matterClients = new Map(matterClientsList.map((c: any) => [c.id, c]));
  const selectedTimeEntryMap = new Map<string, any>(
    summary.unbilledTimeEntries
      .filter((entry: any) => selectedTimeEntryIds.includes(entry.id))
      .map((entry: any) => [entry.id, entry]),
  );
  const selectedFlatFeeMap = new Map<string, any>(
    summary.unbilledFlatFees
      .filter((fee: any) => selectedFlatFeeIds.includes(fee.id))
      .map((fee: any) => [fee.id, fee]),
  );

  if (selectedTimeEntryMap.size !== selectedTimeEntryIds.length || selectedFlatFeeMap.size !== selectedFlatFeeIds.length) {
    throw buildValidationError('One or more selected billing items are no longer available to bill.');
  }

  const requestNames = new Set();
  const recipients = new Set();
  const timeEntryAllocations = new Map();
  const flatFeeAllocations = new Map();
  // BL #3: accumulate split cross-check totals in integer cents (and hours as
  // numbers) so they reconcile exactly to the source totals.
  let splitTotalAmountCents = 0;
  let splitTotalHours = 0;
  let manualEntriesAmountCents = 0;
  let manualEntriesHours = 0;
  let inlineFlatFeesAmountCents = 0;

  for (const invoice of invoices) {
    const invoiceName = String(invoice.invoiceName || '').trim();
    if (!invoiceName) {
      throw buildValidationError('Each split invoice must have an invoice name.');
    }
    const normalizedName = invoiceName.toLowerCase();
    if (requestNames.has(normalizedName) || existingNames.has(normalizedName)) {
      throw buildValidationError(`Invoice name "${invoiceName}" already exists for this matter.`);
    }
    requestNames.add(normalizedName);

    if (!invoice.matterClientId || !matterClients.has(invoice.matterClientId)) {
      throw buildValidationError('Each split invoice must target a client on this matter.');
    }
    if (recipients.has(invoice.matterClientId)) {
      throw buildValidationError('Each split invoice recipient may only appear once.');
    }
    recipients.add(invoice.matterClientId);

    const lineTimeEntries = invoice.timeEntries || [];
    const lineFlatFees = invoice.flatFees || [];
    const computedTimeAmount = sumLineAmounts(lineTimeEntries);
    const computedFlatFeeAmount = sumLineAmounts(lineFlatFees);
    const computedHours = sumLineHours(lineTimeEntries);
    const computedTotalCents = toCents(computedTimeAmount) + toCents(computedFlatFeeAmount);
    const computedTotal = fromCents(computedTotalCents);

    if (!approxEqual(computedFlatFeeAmount, toNum(invoice.flatFeesAmount))) {
      throw buildValidationError(`Flat fee totals do not match for "${invoiceName}".`);
    }
    if (!approxEqual(computedHours, toNum(invoice.totalHours))) {
      throw buildValidationError(`Time entry hours do not match for "${invoiceName}".`);
    }
    if (!approxEqual(computedTotal, toNum(invoice.totalAmount))) {
      throw buildValidationError(`Invoice totals do not match for "${invoiceName}".`);
    }
    if (computedTotalCents <= 0) {
      throw buildValidationError(`Split invoice "${invoiceName}" must have a positive total.`);
    }

    splitTotalAmountCents += computedTotalCents;
    splitTotalHours += computedHours;

    for (const entry of lineTimeEntries) {
      // A line with no id is a manual line: typed by the caller, with no unbilled
      // source behind it to allocate against.
      if (!entry.id) {
        manualEntriesAmountCents += toCents(entry.amount);
        manualEntriesHours += toNum(entry.hours);
        continue;
      }
      const actualEntry = selectedTimeEntryMap.get(entry.id);
      if (!actualEntry) {
        throw buildValidationError(`Time entry "${entry.id}" is not part of the selected split source.`);
      }
      const bucket = timeEntryAllocations.get(entry.id) || { amountCents: 0, hours: 0, percent: 0 };
      bucket.amountCents += toCents(entry.amount);
      bucket.hours += toNum(entry.hours);
      if (entry.allocationPercent !== undefined) bucket.percent += toNum(entry.allocationPercent);
      timeEntryAllocations.set(entry.id, bucket);
    }

    for (const fee of lineFlatFees) {
      // A fee with no id is a manual line, billed as typed.
      if (!fee.id) {
        inlineFlatFeesAmountCents += toCents(fee.amount);
        continue;
      }
      const actualFee = selectedFlatFeeMap.get(fee.id);
      if (!actualFee) {
        throw buildValidationError(`Flat fee "${fee.id}" is not part of the selected split source.`);
      }
      const bucket = flatFeeAllocations.get(fee.id) || { amountCents: 0, percent: 0 };
      bucket.amountCents += toCents(fee.amount);
      if (fee.allocationPercent !== undefined) bucket.percent += toNum(fee.allocationPercent);
      flatFeeAllocations.set(fee.id, bucket);
    }
  }

  for (const [id, entry] of selectedTimeEntryMap.entries()) {
    const allocation = timeEntryAllocations.get(id);
    if (!allocation) {
      throw buildValidationError(`Selected time entry "${id}" was not allocated to a client.`);
    }
    if (allocation.amountCents !== toCents(entry.amount)) {
      throw buildValidationError(`Allocated amount does not match source time entry "${id}".`);
    }
    if (!approxEqual(allocation.hours, entry.hours)) {
      throw buildValidationError(`Allocated hours do not match source time entry "${id}".`);
    }
    if (allocation.percent > 0 && !approxEqual(allocation.percent, 100)) {
      throw buildValidationError(`Allocated percentages for time entry "${id}" must total 100%.`);
    }
  }

  for (const [id, fee] of selectedFlatFeeMap.entries()) {
    const allocation = flatFeeAllocations.get(id);
    if (!allocation) {
      throw buildValidationError(`Selected flat fee "${id}" was not allocated to a client.`);
    }
    if (allocation.amountCents !== toCents(fee.amount)) {
      throw buildValidationError(`Allocated amount does not match source flat fee "${id}".`);
    }
    if (allocation.percent > 0 && !approxEqual(allocation.percent, 100)) {
      throw buildValidationError(`Allocated percentages for flat fee "${id}" must total 100%.`);
    }
  }

  // BL #3: source totals summed in integer cents.
  const sourceTimeTotalCents = Array.from(selectedTimeEntryMap.values()).reduce((sum: number, entry: any) => sum + toCents(entry.amount), 0);
  const sourceFlatTotalCents = Array.from(selectedFlatFeeMap.values()).reduce((sum: number, fee: any) => sum + toCents(fee.amount), 0);
  const sourceHoursTotal = roundCurrency(Array.from(selectedTimeEntryMap.values()).reduce((sum: number, entry: any) => sum + toNum(entry.hours), 0));
  const sourceGrandTotalCents = sourceTimeTotalCents + sourceFlatTotalCents;
  const sourceGrandTotal = fromCents(sourceGrandTotalCents);

  const adjustedSourceTotalCents = sourceGrandTotalCents + manualEntriesAmountCents + inlineFlatFeesAmountCents;
  const adjustedSourceHours = roundCurrency(sourceHoursTotal + manualEntriesHours);
  // Exact cent equality (the parts were summed in cents): no epsilon needed.
  if (splitTotalAmountCents !== adjustedSourceTotalCents) {
    throw buildValidationError('Split invoice totals do not equal the selected source total.');
  }
  if (!approxEqual(splitTotalHours, adjustedSourceHours)) {
    throw buildValidationError('Split invoice hours do not equal the selected source hours.');
  }

  const splitGroupId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  // Current (not snapshotted) recipients per created draft, keyed by invoice id,
  // so the composer can show each split share's billing recipients. A split
  // targets one client per share, so a company share resolves its own roster.
  const billingRecipients: Record<string, any> = {};

  // Tax follows the same rule as createInvoice: the firm default rate when tax is
  // enabled. Each share levies it on its own lines, so a share's tax is computed
  // from what that payer is billed and never apportioned from a combined figure.
  const splitTaxConfig = (await getFirmBillingSettings(lawFirmId)).tax || {};
  const splitTaxRate = splitTaxConfig.enabled ? Number(splitTaxConfig.defaultRate) || 0 : 0;

  // Build every share's row data first (this does reads only - client-snapshot
  // resolution - so it can run outside the write transaction below).
  const shareRows: any[] = [];
  for (const invoice of invoices) {
    const clientSnapshot = await resolveInvoiceClientSnapshot({
      lawFirmId,
      context,
      invoiceClientId: invoice.matterClientId,
      billingEmail: invoice.billingEmail || null,
    });
    const invoiceTotal = roundCurrency(invoice.totalAmount);
    const splitSharePercent = invoice.allocationPercent !== undefined
      ? roundCurrency(invoice.allocationPercent)
      : (sourceGrandTotal > 0 ? roundCurrency((invoiceTotal / sourceGrandTotal) * 100) : 0);
    const shareSubtotalCents = toCents(invoiceTotal);
    const shareTaxCents = splitTaxRate > 0 ? percentOfCents(shareSubtotalCents, splitTaxRate) : 0;
    const shareTotal = fromCents(shareSubtotalCents + shareTaxCents);

    const docData = {
      invoiceName: String(invoice.invoiceName).trim(),
      invoiceNumber: invoice.invoiceNumber || null,
      invoiceDate: toDateOnlyOrNull(invoiceDate),
      dueDate: toDateOnlyOrNull(dueDate),
      billingEmail: clientSnapshot.billingEmail,
      notes: notes || null,
      clientId: clientSnapshot.clientId,
      clientName: clientSnapshot.clientName,
      clientEmail: clientSnapshot.clientEmail,
      matterClientId: clientSnapshot.matterClientId,
      contextType: CONTEXT_TYPES.matter,
      entityId: matterId,
      matterId,
      clientContextId: null,
      remitTo: remitTo || null,
      timeEntries: (invoice.timeEntries || []).map((entry: any) => ({
        ...entry,
        rate: entry.rate !== undefined ? toNum(entry.rate) : undefined,
        hours: toNum(entry.hours),
        amount: roundCurrency(entry.amount),
        allocationPercent: entry.allocationPercent !== undefined ? roundCurrency(entry.allocationPercent) : undefined,
        allocationAmount: entry.allocationAmount !== undefined ? roundCurrency(entry.allocationAmount) : undefined,
      })),
      flatFees: (invoice.flatFees || []).map((fee: any) => ({
        ...fee,
        amount: roundCurrency(fee.amount),
        allocationPercent: fee.allocationPercent !== undefined ? roundCurrency(fee.allocationPercent) : undefined,
        allocationAmount: fee.allocationAmount !== undefined ? roundCurrency(fee.allocationAmount) : undefined,
      })),
      totalHours: roundCurrency(invoice.totalHours),
      totalAmount: shareTotal,
      flatFeesAmount: roundCurrency(invoice.flatFeesAmount),
      taxRate: splitTaxRate > 0 ? splitTaxRate : null,
      taxCents: shareTaxCents,
      isPaid: false,
      paidDate: null,
      amountPaid: 0,
      payments: [],
      nextPaymentDate: null,
      splitGroupId,
      splitMode,
      splitRecipientCount: invoices.length,
      splitShareAmount: shareTotal,
      splitSharePercent,
      createdAt,
      createdBy: actingUserId,
      updatedAt: createdAt,
      updatedBy: actingUserId,
    };

    shareRows.push({ docData, clientSnapshot });
  }

  // One outer transaction for every share in the split. A failure creating the
  // Nth share must not leave the first N-1 already committed: those invoices
  // would carry a real, spendable split_group_id while the group itself is
  // permanently short a share, and nothing on any single invoice's own screen
  // would show that it is missing a sibling.
  const createdInvoices: any[] = await withDrizzleTransaction(async (client: any) => {
    const saved: any[] = [];
    for (const { docData } of shareRows) {
      // eslint-disable-next-line no-await-in-loop
      saved.push(await invoicesRepo._createTx(client, context, docData));
    }
    return saved;
  });

  for (let i = 0; i < createdInvoices.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    billingRecipients[createdInvoices[i].id] =
      await currentRecipientsForDraft(lawFirmId, shareRows[i].clientSnapshot);
  }

  // Each emit is awaited through to its calendar listener, which then fans out
  // again over every billing recipient of that invoice, so the cost of this line
  // is split-count x recipients of provider calls and pg reads. Neither factor
  // is capped: a split carries one invoice per matter client, and the request
  // chooses how many. Capping the outer factor keeps the product off the pool
  // and off Google/Outlook's rate limits.
  const settledEmits = await runWithConcurrency(
    createdInvoices.map((invoice) => () =>
      emitInvoiceCalendarEvent(INVOICE_CREATED, {
        lawFirmId,
        context,
        actingUserId,
        invoice,
      }),
    ),
    SPLIT_INVOICE_EMIT_CONCURRENCY,
  );
  // The invoices are already written by this point, and an emit failure still
  // fails the whole call: silently returning success on a half-synced split
  // would leave calendars disagreeing with the ledger with nothing to say so.
  const emitFailure = settledEmits.find((r: any) => r.status === 'rejected');
  if (emitFailure) throw emitFailure.reason;

  return {
    message: 'Split invoices created successfully',
    splitGroupId,
    createdCount: createdInvoices.length,
    invoices: createdInvoices.map(formatInvoice),
    billingRecipients,
  };
}

/**
 * Locate an invoice from its id alone and authorize the caller against whatever
 * context it turns out to belong to.
 *
 * The sent-copy routes are addressed by invoice id, because a preserved copy is
 * looked up from the invoice itself rather than from a matter or client the
 * caller already navigated through. Access still runs through the invoice's own
 * context, so a matter invoice keeps requiring the right to read that matter.
 */
async function resolveInvoiceForRead(lawFirmId: string, invoiceId: string, actingUserId: string) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const row = await invoicesRepo.findContextById(lawFirmId, invoiceId);
  if (!row) throw new NotFoundError('Invoice');

  await authorizeContext(row.context, actingUserId, MODE_READ);
  return row;
}

/**
 * The preserved copies of an invoice, one per successful send.
 */
export async function listInvoiceSentCopies({ lawFirmId, invoiceId, actingUserId }: any) {
  await resolveInvoiceForRead(lawFirmId, invoiceId, actingUserId);
  const copies = await invoiceArchive.listSentCopies(lawFirmId, invoiceId);
  return { sentCopies: copies, totalItems: copies.length };
}

/**
 * One preserved copy's bytes, named for the invoice and the day it went out so a
 * downloaded file is identifiable away from the app.
 */
/**
 * How long a sent-copy url lives. An hour, matching every other place a stored
 * document is handed out, and short because the url outlives nothing else: the
 * old response was authorized per request.
 */
const SENT_COPY_URL_TTL_MS = 60 * 60 * 1000;

/**
 * A short-lived url for one preserved copy of a sent invoice.
 *
 * The route used to read the whole PDF and send it as the response body, so
 * every download put a document in a 512 MiB container that serves eighty
 * concurrent requests. Reads outnumber uploads, so this is the direction that
 * carries the most traffic.
 *
 * The url is minted only AFTER `resolveInvoiceForRead` has authorized this
 * caller, because a signed url is a bearer credential: handed out first and
 * checked afterwards it is a way to read an invoice the caller cannot see. It
 * is short-lived for the same reason, since the old response was authorized per
 * request and a long url outlives the permission that produced it.
 *
 * The filename the user sees moves onto the url's content disposition, because
 * there is no longer a response for the browser to read one from.
 */
export async function getInvoiceSentCopy({ lawFirmId, invoiceId, name, actingUserId }: any) {
  const { invoiceNumber } = await resolveInvoiceForRead(lawFirmId, invoiceId, actingUserId);

  const objectPath = invoiceArchive.sentCopyPath(lawFirmId, invoiceId, name);
  if (!objectPath) throw new NotFoundError('Sent copy');

  const stored = await invoiceArchive.statSentCopy(objectPath);
  if (!stored) throw new NotFoundError('Sent copy');

  const day = String(name).replace(/^sent-/, '').slice(0, 10);
  const label = invoiceNumber ? `Invoice ${invoiceNumber}` : 'Invoice';
  const fileName = `${label} - sent ${day}.pdf`;

  const signedUrl = await invoiceArchive.signSentCopy(objectPath, fileName, SENT_COPY_URL_TTL_MS);
  return {
    signedUrl,
    fileName,
    size: stored.size,
    expiresAt: new Date(Date.now() + SENT_COPY_URL_TTL_MS).toISOString(),
  };
}

/**
 * Who this invoice is (or would be) billed to.
 *
 * Returns the frozen snapshot once the invoice has issued, otherwise a live
 * resolve of the client's current billing recipients. `source` on the result
 * tells the caller which it got, so the UI can label a still-editable draft
 * differently from a frozen record.
 */
export async function getInvoiceBillingRecipients({ lawFirmId, matterId, clientId, invoiceId, actingUserId }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId, MODE_READ);

  const invoice = await invoicesRepo.findById(context, invoiceId);
  if (!invoice) throw new NotFoundError('Invoice');

  const billingRecipients = await resolveInvoiceRecipients({ lawFirmId, invoice });
  return { billingRecipients };
}

/**
 * Deliberately replace an issued invoice's frozen bill-to record with the
 * client's current billing details.
 *
 * The snapshot exists so roster changes cannot rewrite billing history, which
 * means the only way to correct a bill issued against wrong recipient data is
 * an explicit, permissioned action that says so. Audited in the snapshot
 * service (`invoice.billing_recipients.refreshed`) with the previous and new
 * address lists, so the rewrite is inspectable afterwards.
 */
export async function refreshInvoiceBillingRecipients({ lawFirmId, matterId, clientId, invoiceId, actingUserId }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  const invoice = await invoicesRepo.findById(context, invoiceId);
  if (!invoice) throw new NotFoundError('Invoice');

  const billingRecipients = await refreshInvoiceRecipients({
    lawFirmId,
    invoice,
    invoiceId,
    actingUserId,
  });
  return { message: 'Billing recipients updated successfully', billingRecipients };
}

/**
 * Correct the billing email on an invoice: replace who it is billed to with
 * the addresses the firm enters. Reminders, payment links and receipts read
 * this from now on. A voided invoice is not changed.
 */
export async function updateInvoiceBillingEmails({ lawFirmId, matterId, clientId, invoiceId, actingUserId, emails }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  const invoice = await invoicesRepo.findById(context, invoiceId);
  if (!invoice) throw new NotFoundError('Invoice');
  assertInvoiceNotVoided(invoice, 'change its billing email');

  const billingRecipients = await replaceInvoiceRecipientEmails({
    lawFirmId,
    invoice,
    invoiceId,
    emails,
    actingUserId,
  });
  return { message: 'Billing email updated successfully', billingRecipients };
}

const STRIPE_PAID_VOID_REFUSAL = 'The client has already paid this invoice through Stripe, or a payment is in progress. '
  + 'The payment will appear on the invoice shortly; refund it in Stripe, which reverses it here, '
  + 'then void the invoice.';

const STRIPE_PAID_DELETE_REFUSAL = 'The client has already paid this invoice through Stripe, or a payment is in progress. '
  + 'Refund the client in Stripe and remove the payment from the invoice first, then delete it.';

/**
 * Cancel an invoice without destroying it.
 *
 * `deleteInvoice` refuses an invoice the trust ledger points at, because those
 * entries are permanent, and told the firm to void it instead. Nothing
 * implemented that, so a firm that billed from trust and then had to cancel had
 * no path at all: the bill stayed in reminders, in the late-fee sweep and in
 * accounts receivable forever.
 *
 * Void keeps the record and every link into it, and takes the invoice out of
 * everything that chases money: `findUnpaidByDue` (both reminder passes and the
 * late-fee sweep) excludes the status, `deriveInvoiceStatus` / `isPastDue` treat
 * it as terminal, and every money total reads past it.
 *
 * It also closes every way to pay it. The hosted Stripe invoices (top-level and
 * per installment) are voided and the open checkout session is expired, and the
 * local pointers are cleared. If Stripe reports any of them already collected,
 * or a checkout payment still settling, the void is refused and nothing changes,
 * because the money is on its way to the invoice.
 *
 * It refuses an invoice that still carries payments, deliberately. Money that
 * was collected against a bill is a second record: a trust withdrawal, or a
 * charge at Stripe. Removing the payment reverses that half properly (a trust
 * withdrawal is voided with it), so the order is remove, then void. Voiding on
 * top of a live payment would leave the firm holding client money against a bill
 * that no longer exists.
 */
export async function voidInvoice({ lawFirmId, matterId, clientId, invoiceId, actingUserId }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  const refuseIfNotVoidable = (invoice: any) => {
    if (invoice.status === 'voided') {
      throw new ConflictError('This invoice has already been voided.');
    }
    if (toCents(invoice.amountPaid) > 0 || (invoice.payments || []).length > 0) {
      throw new ConflictError(
        'This invoice has payments recorded against it. Remove them first, which reverses any '
        + 'trust withdrawal with them, then void the invoice.',
      );
    }
  };

  // Refuse on an unlocked read first, so a void that is going to be refused has
  // no side effect at Stripe. The locked check below is the authoritative one.
  const current = await invoicesRepo.findById(context, invoiceId);
  if (!current) throw new NotFoundError('Invoice');
  refuseIfNotVoidable(current);

  // Lazy-required: stripe.service requires this module.
  const { closeInvoicePaymentSurfaces } = require('../../stripe/stripe.service');
  const { collected } = await closeInvoicePaymentSurfaces(lawFirmId, current);
  if (collected) throw new ConflictError(STRIPE_PAID_VOID_REFUSAL);

  const updated = await invoicesRepo.runInvoiceTxn(context, invoiceId, async (existing: any) => {
    refuseIfNotVoidable(existing);
    // A link can be minted between the first close and this lock. Creation
    // takes this same lock, so anything it committed is on the row now: close
    // what was not there at the first pass before the void commits.
    const late = await closeInvoicePaymentSurfaces(lawFirmId, existing, { skip: current });
    if (late.collected) throw new ConflictError(STRIPE_PAID_VOID_REFUSAL);
    const hadStripeLink = Boolean(existing.stripePaymentRequested || existing.stripeCheckoutSessionId);
    const patch: any = {
      status: 'voided',
      // The payment link stops working with the invoice.
      payLinkToken: null,
      payLinkInstallmentId: null,
      stripeCheckoutSessionId: null,
      stripeCheckoutSessionAccountId: null,
      stripeCardPaymentIntentId: null,
      stripeCardPaymentIntentAccountId: null,
      stripePaymentRequested: false,
      updatedAt: new Date().toISOString(),
      updatedBy: actingUserId,
    };
    if (hadStripeLink) patch.stripePaymentStatus = 'voided';
    return patch;
  });
  if (!updated) throw new NotFoundError('Invoice');

  // A retainer period drafted into this invoice is open for billing again. Lazy
  // required: the plans module requires this one.
  await require('../plans/plans.repository').releasePeriodsOfInvoice(lawFirmId, invoiceId);

  // The voided invoice yields no billing items, so this update deletes the
  // entries already synced to members' Google and Outlook calendars.
  const emitted = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });

  return { message: 'Invoice voided successfully', invoice: formatInvoice(emitted) };
}

/**
 * The remit-to block as the columns store it: a free-text string, or the five
 * structured fields. An empty string and an absent field both store as nothing,
 * so both normalise to null.
 */
function remitToColumns(remitTo: any) {
  const blank = (v: any) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  if (remitTo && typeof remitTo === 'object') {
    return [null, blank(remitTo.name), blank(remitTo.address), blank(remitTo.city), blank(remitTo.state), blank(remitTo.zip)];
  }
  return [blank(remitTo), null, null, null, null, null];
}

/** Whether a frozen-at-issue details field sent on an edit equals what the invoice holds. */
function frozenValueUnchanged(key: 'invoiceNumber' | 'invoiceDate' | 'remitTo', sent: any, stored: any) {
  if (key === 'invoiceNumber') return (sent || '') === (stored || '');
  if (key === 'invoiceDate') return toDateOnlyOrNull(sent) === toDateOnlyOrNull(stored);
  const a = remitToColumns(sent);
  const b = remitToColumns(stored);
  return a.every((v, i) => v === b[i]);
}

export async function updateInvoiceDetails({ lawFirmId, matterId, clientId, invoiceId, actingUserId, body }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  const { invoiceName, invoiceNumber, invoiceDate, dueDate, remitTo } = body;
  const updates: Record<string, any> = {};
  if (invoiceName !== undefined) updates.invoiceName = invoiceName;
  if (invoiceNumber !== undefined) updates.invoiceNumber = invoiceNumber || null;
  if (invoiceDate !== undefined) updates.invoiceDate = toDateOnlyOrNull(invoiceDate);
  if (dueDate !== undefined) updates.dueDate = toDateOnlyOrNull(dueDate);
  if (remitTo !== undefined) updates.remitTo = remitTo;

  // The number, the invoice date and the remit-to block are the record frozen
  // at issue, alongside the bill-to snapshot (`billing_*`): once the client
  // holds a document carrying them, the firm's copy of that document does not
  // change. Before issue the invoice is the firm's own draft and all of it is
  // editable. Issue is the moment `billing_snapshot_at` is stamped. The name is
  // the firm's own label and the due date is a payment term the firm may extend,
  // so both stay editable after issue.
  //
  // The freeze refuses a different value, not the presence of a key: the edit
  // form resends every field, so an unchanged number, date or remit-to must not
  // block a rename or a new due date. An unchanged frozen value is dropped from
  // the write so an issued invoice's frozen columns are never rewritten.
  const frozenAtIssue = (['invoiceNumber', 'invoiceDate', 'remitTo'] as const).filter((key) => key in updates);

  let updated;
  try {
    updated = await invoicesRepo.runInvoiceTxn(context, invoiceId, (existing: any) => {
      // Judged on the row as it stands once locked: a first send that stamped
      // the snapshot while this edit waited must be seen here. A conflict with
      // the invoice's state, not a permission failure, so 409 rather than 403
      // (which the error handler logs as a denied-access security event).
      if (!existing.billingSnapshotAt) return updates;
      const changed = frozenAtIssue.filter((key) => !frozenValueUnchanged(key, updates[key], existing[key]));
      if (changed.length) {
        throw new ConflictError(
          'The invoice number, invoice date and remit-to details are frozen once an invoice has been issued.',
        );
      }
      const allowed = { ...updates };
      for (const key of frozenAtIssue) delete allowed[key];
      return allowed;
    });
  } catch (updateErr: any) {
    // The firm-scoped unique index is the final race-safe duplicate guard. Turn
    // its violation into a client error instead of exposing a generic 500.
    if (updateErr?.code === '23505' || updateErr?.cause?.code === '23505') {
      throw new ValidationError('Invoice number already exists for this billing context');
    }
    throw updateErr;
  }
  if (!updated) throw new NotFoundError('Invoice');
  updated = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });
  return { message: 'Invoice updated successfully', invoice: formatInvoice(updated) };
}

/**
 * Replace an invoice's line items and re-derive everything hanging off the total:
 * tax, billed hours, the flat-fee subtotal, settled/unsettled state, the
 * payment-plan schedule, the next payment date, and any live Stripe payment
 * surface.
 *
 * The invoice's line items are the client-facing billing record; the source time
 * entries are the work log and are deliberately NOT touched (they stay frozen once
 * billed — see FROZEN_ONCE_BILLED in timeEntries.service). Billing 3.5h against a
 * logged 4h is therefore a write-down, not a correction to the log.
 *
 * Removing a line returns its source row to unbilled with no extra write, because
 * "billed" is derived from the existence of an invoice_line_items row pointing at
 * it, on an invoice that is not voided (billingReads.isSourceBilled), never from
 * the source table's own column.
 *
 * Lowering the total below what has already been paid or written off is permitted
 * — a firm may be renaming lines or reworking a bill it has over-collected on —
 * but the caller must opt in: the first attempt throws 409
 * INVOICE_TOTAL_BELOW_SETTLED carrying the resulting credit so the UI can confirm.
 */
export async function updateInvoiceLineItems({ lawFirmId, matterId, clientId, invoiceId, actingUserId, body }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  const before = await invoicesRepo.findById(context, invoiceId);
  if (!before) throw new NotFoundError('Invoice');
  // Refused here as well as under the lock, so the double-billing pre-check
  // below never answers for an invoice that is already cancelled.
  assertInvoiceNotVoided(before, 'change its line items');

  // A split invoice carries one recipient's share of the matter's work and its
  // siblings carry the rest. Editing one share breaks the group's arithmetic, and
  // re-allocating the siblings would mutate invoices the caller is not looking at
  // (possibly ones already sent).
  if (before.splitGroupId) {
    throw new ConflictError(
      'This invoice is part of a split group. Delete and regenerate the split to change what is billed.',
    );
  }

  // Never trust a client-supplied amount on hourly work: recompute it from
  // hours x rate so what is persisted cannot disagree with what the invoice
  // renders. Flat fees and expenses have no quantity, so their amount IS the
  // figure and is taken as sent (the Zod schema floors it at 0).
  const lineTimeEntries = (body.timeEntries || []).map((te: any) => ({
    ...te,
    hours: toNum(te.hours),
    rate: toNum(te.rate),
    amount: fromCents(hourlyAmountCents(te.hours, te.rate)),
  }));
  const lineFlatFees = body.flatFees || [];
  const lineExpenses = body.expenses || [];

  // Same double-billing guard as createInvoice, minus this invoice's own lines: a
  // source row may legitimately still sit on THIS invoice, but must not also be on
  // a sibling invoice in the same billing context.
  const otherInvoices = (await invoicesRepo.findByContext(context))
    .filter((inv: any) => inv.id !== invoiceId);
  const { timeEntryIds, flatFeeIds, expenseIds } = billingReads.collectBilledIds(otherInvoices);
  const alreadyBilled = lineTimeEntries.filter((te: any) => billingReads.isBilled(timeEntryIds, te)).length
    + lineFlatFees.filter((ff: any) => billingReads.isBilled(flatFeeIds, ff)).length
    + lineExpenses.filter((ex: any) => billingReads.isBilled(expenseIds, ex)).length;
  if (alreadyBilled > 0) {
    throw new ValidationError('One or more line items are already billed on another invoice');
  }

  // Time written off as non-billable must never reach a client invoice, whatever
  // the caller sent — same reasoning as the createInvoice guard.
  const nonBillableIds = await billingReads.listNonBillableSourceIds(
    lawFirmId,
    [...lineTimeEntries, ...lineFlatFees, ...lineExpenses].map((line: any) => line.id),
  );
  if (nonBillableIds.size > 0) {
    throw new ValidationError('One or more line items are marked non-billable and cannot be invoiced');
  }

  const beforeTotalCents = invoiceTotalCents(before);

  // BL1: read→compute→write under a row lock.
  const updated = await invoicesRepo.runInvoiceTxn(context, invoiceId, async (existing: any) => {
    assertInvoiceNotVoided(existing, 'change its line items');
    // Every sum in integer cents, converted once at the end.
    const subtotalCents = toCents(sumLineAmounts(lineTimeEntries))
      + toCents(sumLineAmounts(lineFlatFees))
      + toCents(sumLineAmounts(lineExpenses));
    // Amounts added after creation (add-amount, late fee) are charges on top of
    // the lines. Editing the lines leaves them in the total, and tax is levied on
    // the lines only.
    const adjustmentsCents = (existing.amountAdjustmentNotes || [])
      .reduce((sum: number, a: any) => sum + toCents(a.amount), 0);

    // Tax rides on the invoice's own stored rate, so an edit re-levies it on the
    // new subtotal instead of carrying forward an old tax amount that the new
    // total never produced. A rate in the body replaces the stored one.
    const taxRate = body.taxRate != null && body.taxRate !== ''
      ? Number(body.taxRate)
      : (Number(existing.taxRate) || 0);
    const taxCents = taxRate > 0 ? percentOfCents(subtotalCents, taxRate) : 0;
    const newTotalCents = subtotalCents + taxCents + adjustmentsCents;

    const amountPaidCents = toCents(existing.amountPaid || 0);
    const writtenOffCents = toCents(existing.totalWrittenOff || 0);
    const newRemainingCents = newTotalCents - amountPaidCents - writtenOffCents;

    if (newRemainingCents < 0 && body.acknowledgeOverpayment !== true) {
      const err: any = new ConflictError(
        'The new total is below what has already been paid or written off on this invoice.',
      );
      err.code = 'INVOICE_TOTAL_BELOW_SETTLED';
      err.details = {
        newTotal: fromCents(newTotalCents),
        amountPaid: fromCents(amountPaidCents),
        totalWrittenOff: fromCents(writtenOffCents),
        creditAmount: fromCents(-newRemainingCents),
      };
      throw err;
    }

    const updateFields: any = {
      // The presence of these three keys is what makes writeChildren replace the
      // invoice_line_items rows; sending them IS the persistence step.
      timeEntries: lineTimeEntries,
      flatFees: lineFlatFees,
      expenses: lineExpenses,
      totalHours: sumLineHours(lineTimeEntries),
      totalAmount: fromCents(newTotalCents),
      flatFeesAmount: sumLineAmounts(lineFlatFees),
      taxCents,
      // Persist a rate the caller supplied, so the next edit re-levies at it.
      ...(body.taxRate != null && body.taxRate !== '' ? { taxRate: taxRate > 0 ? taxRate : null } : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: actingUserId,
    };

    // Settlement can flip in EITHER direction here, unlike addAmountToInvoice
    // (only ever reopens) or addCreditNote (only ever settles), so both are
    // handled. A reopened invoice also loses its paidDate: keeping it would date a
    // settlement that no longer holds.
    if (newRemainingCents <= 0 && newTotalCents > 0) {
      updateFields.isPaid = true;
      updateFields.nextPaymentDate = null;
    } else if (existing.isPaid) {
      updateFields.isPaid = false;
      updateFields.paidDate = null;
    }

    const plan = ensurePlanRowIds(existing.paymentPlan);
    if (plan?.enabled) {
      const rebalanced = rebalancePendingInstallments(plan, plan.expectedPayments, newRemainingCents);
      if (!rebalanced) {
        updateFields.paymentPlan = null;
        updateFields.nextPaymentDate = null;
      } else {
        updateFields.paymentPlan = { ...plan, expectedPayments: rebalanced };
        updateFields.nextPaymentDate = getNextPaymentTimestamp(rebalanced);
      }
    }

    return syncDueDateToLastInstallment(updateFields);
  });

  if (!updated) throw new NotFoundError('Invoice');

  const emitted = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });

  // An open checkout session was priced at the OLD total, so leaving it live
  // would let the client pay a superseded amount.
  const afterTotalCents = invoiceTotalCents(emitted);
  if (afterTotalCents !== beforeTotalCents) {
    await expireStaleCheckoutSession(context, before);
  }

  // The global audit middleware records that this route was called; only the
  // service knows what the money actually did. Best-effort by design.
  await recordAudit({
    lawFirmId,
    actorUid: actingUserId,
    action: 'invoice.line_items.updated',
    resourceType: 'invoice',
    resourceId: invoiceId,
    metadata: {
      beforeTotalCents,
      afterTotalCents,
      lineCounts: {
        timeEntries: lineTimeEntries.length,
        flatFees: lineFlatFees.length,
        expenses: lineExpenses.length,
      },
      acknowledgedOverpayment: body.acknowledgeOverpayment === true,
    },
  });

  return { message: 'Line items updated successfully', invoice: formatInvoice(emitted) };
}

/**
 * List invoices for a matter.
 */
export async function listInvoices({ lawFirmId, matterId, clientId, actingUserId }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId, MODE_READ);

  const invoices = await invoicesRepo.findByContext(context);
  return { invoices: invoices.map(formatInvoice) };
}

/**
 * List invoices across accessible matters plus client-context invoices.
 *
 * Every filter/sort/page option is forwarded untouched; omitting `limit` returns
 * the firm's complete list.
 */
export async function listFirmInvoices(options: any) {
  return firmBillingService.listFirmInvoices(options);
}

/**
 * Unbilled summary: time entries & flat fees not yet on an invoice.
 */
export async function getUnbilledSummary({ lawFirmId, matterId, clientId, actingUserId }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId, MODE_READ);

  // Staged in groups of at most three so one summary never holds more than three
  // pool connections at once: the instance pool is small and shared by every
  // concurrent request. Reads within a group are independent and stay parallel.
  const [timeEntries, flatFees, expenses] = await Promise.all([
    billingReads.listTimeEntries(context),
    billingReads.listFlatFees(context),
    billingReads.listExpenses(context),
  ]);
  const [invoices, chargeCodes, memberDefaultRates] = await Promise.all([
    invoicesRepo.findByContext(context),
    billingReads.chargeCodeMap(lawFirmId),
    billingReads.memberDefaultRates(lawFirmId),
  ]);
  const firmDefaultRate = await billingReads.firmDefaultRate(lawFirmId);

  // Resolve matter members + billing client rates for rate resolution.
  let matterMembers = [];
  let clientBillingRates = null;
  let rateClients: any[] = [];
  if (context.type === CONTEXT_TYPES.matter) {
    const matterData = await billingReads.getMatter(lawFirmId, context.entityId);
    matterMembers = (matterData?.members || []).map((m: any) => ({ userId: m.userId, hourlyRate: m.hourlyRate }));
    // Rate tiers 3-4 read the matter's billing client. A matter can have several
    // clients, so the entry's own named payer decides whose negotiated rate
    // applies, falling back to the first client by name when it names nobody.
    // Resolved per entry, in `billingRatesForEntry`.
    rateClients = await billingReads.listMatterClients(lawFirmId, context.entityId);
  } else {
    const client = await billingReads.getClient(lawFirmId, context.entityId);
    clientBillingRates = client?.billingRates || null;
  }
  const ratesFor = (entry: any) => (context.type === CONTEXT_TYPES.matter
    ? billingReads.billingRatesForEntry(rateClients, entry?.matterClientIds)
    : clientBillingRates);

  const { timeEntryIds, flatFeeIds, expenseIds } = billingReads.collectBilledIds(invoices);

  const unbilledTimeEntries = timeEntries
    .filter((e: any) => !billingReads.isBilled(timeEntryIds, e) && e.billable !== false && e.retainerCoverage !== 'covered')
    .map((d: any) => {
      const chargeCode = d.chargeCodeId ? chargeCodes.get(d.chargeCodeId) : null;
      // The stored rate when the entry has one (migration 0233); live resolution
      // only for a row nothing has rated yet. A stored 'none' bills at 0, as the
      // live fallback tier always did.
      const rate = billingReads.storedOrLiveRate(d, () => (typeof d.hourlyRate === 'number'
        ? d.hourlyRate
        : resolveRateValue({ entry: d, matterMembers, clientBillingRates: ratesFor(d), chargeCode, memberDefaultRates, firmDefaultRate }))) ?? 0;
      const hours = d.hours || 0;
      return {
        id: d.id,
        userId: d.userId,
        userName: d.userName,
        hours,
        rate,
        // Priced like the stored time entry amount: hundredths of an hour x rate, half up.
        amount: fromCents(hourlyAmountCents(hours, rate || 0)),
        date: d.date,
        name: d.name,
        description: d.description,
        utbmsTaskCode: d.utbmsTaskCode || null,
        utbmsActivityCode: d.utbmsActivityCode || null,
      };
    });

  const unbilledFlatFees = flatFees
    .filter((f: any) => !billingReads.isBilled(flatFeeIds, f))
    .map((d: any) => ({ id: d.id, description: d.description, amount: d.amount || 0, date: d.date }));

  const unbilledExpenses = expenses
    .filter((e: any) => !billingReads.isBilled(expenseIds, e) && e.billable !== false)
    .map((d: any) => ({
      id: d.id,
      description: d.description,
      amount: d.amount || 0,
      date: d.date,
      category: d.category,
      expenseCategoryId: d.expenseCategoryId,
      vendor: d.vendor,
    }));

  return {
    unbilledTimeEntries,
    unbilledFlatFees,
    unbilledExpenses,
    // BL #3: sum monetary totals in integer cents, convert once at the boundary.
    totalUnbilledHours: roundCurrency(unbilledTimeEntries.reduce((s: any, e: any) => s + e.hours, 0)),
    totalUnbilledFlatFees: fromCents(unbilledFlatFees.reduce((s: any, f: any) => s + toCents(f.amount), 0)),
    totalUnbilledTimeAmount: fromCents(unbilledTimeEntries.reduce((s: any, e: any) => s + toCents(e.amount), 0)),
    totalUnbilledExpenses: fromCents(unbilledExpenses.reduce((s: any, e: any) => s + toCents(e.amount), 0)),
  };
}

/**
 * Batched unbilled summary for many contexts at once (used by bulkCreateInvoices).
 *
 * The per-context getUnbilledSummary issues ~7 reads PER context (time entries,
 * flat fees, expenses, invoices, charge codes, member rates, firm rate, plus a
 * getMatter + listMatterClients for matter contexts). A 50-context bulk run therefore
 * fanned out ~50× that. This loads every one of those inputs ONCE firm-wide
 * (the same batched reads firmBilling already uses) and computes each context's
 * summary in memory, collapsing the fan-out to a constant number of queries.
 *
 * Only the fields bulkCreateInvoices consumes are produced (unbilledTimeEntries,
 * unbilledFlatFees, totalUnbilledHours). Expenses are intentionally omitted
 * because bulk never bills them. The per-line / per-context math (rate
 * resolution, integer-cent line amounts, billed-id filtering) is IDENTICAL to
 * getUnbilledSummary so a context billed via bulk reconciles to the same cents.
 *
 * `seeAll` widens matter authorization from "is a member of this matter" to "this
 * matter belongs to this firm", for callers that have already established the user
 * is a firm owner or admin. It defaults to false, so membership stays the rule for
 * every caller that does not opt in. See listFirmUnbilledSummaries for why the
 * reporting read opts in and bulkCreateInvoices does not.
 *
 * @returns {Promise<Map<string, {unbilledTimeEntries, unbilledFlatFees, totalUnbilledHours}>>}
 *          keyed by `${type}:${entityId}`. Contexts the user can't access are omitted.
 */
async function getUnbilledSummaryBatch({ lawFirmId, contexts, actingUserId, seeAll = false }: any) {
  // Normalize each context to carry lawFirmId (callers pass { type, entityId }),
  // matching the shape resolveInvoiceContext produces. authorizeContext reads
  // context.lawFirmId.
  const normalized = contexts.map((c: any) => ({ type: c.type, lawFirmId, entityId: c.entityId }));
  const matterContexts = normalized.filter((c: any) => c.type === CONTEXT_TYPES.matter);
  const matterIds = matterContexts.map((c: any) => c.entityId);
  const hasClientContext = normalized.some((c: any) => c.type === CONTEXT_TYPES.client);

  // Authorization resolved ONCE rather than per context. The old loop called
  // authorizeContext per entry, which is a membership query per matter, so a
  // caller passing every context in the firm paid one query per matter.
  // getAccessibleMatterIds answers the same question (firm member AND matter
  // member) for the whole set in one query. Skipped entirely under `seeAll`, where
  // matter membership is not the rule and the answer would go unused; the
  // firm-scoped matterById below is the authorization set in that mode.
  const accessibleMatterIds = (!seeAll && matterIds.length)
    ? await getAccessibleMatterIds(lawFirmId, matterIds, actingUserId)
    : new Set();
  let firmMember = false;
  if (hasClientContext) {
    // Client contexts need firm membership only. Not being a member omits them
    // rather than throwing, matching the per-context behaviour it replaces.
    try {
      await assertLawFirmMembership(lawFirmId, actingUserId);
      firmMember = true;
    } catch (_) {
      firmMember = false;
    }
  }

  // One firm-wide read per input instead of per-context.
  const [
    timeEntriesByContext,
    flatFeesByContext,
    invoicesByContext,
    chargeCodes,
    memberDefaultRates,
    firmDefaultRate,
    matterClientsByMatter,
    matterRecords,
    firmClients,
  ] = await Promise.all([
    billingReads.listTimeEntriesForFirm(lawFirmId),
    billingReads.listFlatFeesForFirm(lawFirmId),
    invoicesRepo.findForFirmByContext(lawFirmId),
    billingReads.chargeCodeMap(lawFirmId),
    billingReads.memberDefaultRates(lawFirmId),
    billingReads.firmDefaultRate(lawFirmId),
    billingReads.listMatterClientsForMatters(lawFirmId, matterIds),
    matterIds.length ? require('../../matters/matters.repository').findByIdsRaw(lawFirmId, matterIds) : [],
    // The firm's clients in one read, so a client context's billing rates come
    // from memory instead of a SELECT each.
    hasClientContext ? billingReads.listFirmClients(lawFirmId) : [],
  ]);
  const matterById = new Map<string, any>(matterRecords.map((c: any) => [c.id, c]));
  const clientById = new Map<string, any>(firmClients.map((c: any) => [c.id, c]));

  const out = new Map();
  for (const context of normalized) {
    // Under `seeAll` the test is still "does this matter belong to this firm",
    // never an unconditional yes: matterById comes from a law_firm_id-scoped read,
    // so a matter id from another tenant is rejected exactly as before.
    const matterAuthorized = seeAll
      ? matterById.has(context.entityId)
      : accessibleMatterIds.has(context.entityId);
    const authorized = context.type === CONTEXT_TYPES.matter ? matterAuthorized : firmMember;
    if (!authorized) continue;

    const isMatter = context.type === CONTEXT_TYPES.matter;
    const ctxMap = isMatter ? timeEntriesByContext.byMatter : timeEntriesByContext.byClient;
    const ffMap = isMatter ? flatFeesByContext.byMatter : flatFeesByContext.byClient;
    const invMap = isMatter ? invoicesByContext.byMatter : invoicesByContext.byClient;
    const timeEntries = ctxMap.get(context.entityId) || [];
    const flatFees = ffMap.get(context.entityId) || [];
    const invoices = invMap.get(context.entityId) || [];

    let matterMembers = [];
    let clientBillingRates = null;
    let rateClients: any[] = [];
    if (isMatter) {
      const matterData = matterById.get(context.entityId);
      matterMembers = (matterData?.members || []).map((m: any) => ({ userId: m.userId, hourlyRate: m.hourlyRate }));
      // Rate tiers 3-4 read the matter's billing client. A matter can have
      // several clients, so the entry's own named payer decides whose negotiated
      // rate applies, falling back to the first client by name when it names
      // nobody. Resolved per entry, in `billingRatesForEntry`.
      rateClients = matterClientsByMatter.get(context.entityId) || [];
    } else {
      clientBillingRates = clientById.get(context.entityId)?.billingRates || null;
    }
    const ratesFor = (entry: any) => (isMatter
      ? billingReads.billingRatesForEntry(rateClients, entry?.matterClientIds)
      : clientBillingRates);

    const { timeEntryIds, flatFeeIds } = billingReads.collectBilledIds(invoices);

    const unbilledTimeEntries = timeEntries
      .filter((e: any) => !billingReads.isBilled(timeEntryIds, e) && e.billable !== false && e.retainerCoverage !== 'covered')
      .map((d: any) => {
        const chargeCode = d.chargeCodeId ? chargeCodes.get(d.chargeCodeId) : null;
        const rate = billingReads.storedOrLiveRate(d, () => (typeof d.hourlyRate === 'number'
          ? d.hourlyRate
          : resolveRateValue({ entry: d, matterMembers, clientBillingRates: ratesFor(d), chargeCode, memberDefaultRates, firmDefaultRate }))) ?? 0;
        const hours = d.hours || 0;
        return {
          id: d.id,
          userId: d.userId,
          userName: d.userName,
          hours,
          rate,
          amount: fromCents(hourlyAmountCents(hours, rate || 0)),
          date: d.date,
          name: d.name,
          description: d.description,
          utbmsTaskCode: d.utbmsTaskCode || null,
          utbmsActivityCode: d.utbmsActivityCode || null,
        };
      });

    const unbilledFlatFees = flatFees
      .filter((f: any) => !billingReads.isBilled(flatFeeIds, f))
      .map((d: any) => ({ id: d.id, description: d.description, amount: d.amount || 0, date: d.date }));

    // Key by `${type}:${entityId}` (not entityId alone): matter ids and client ids
    // are independent UUID spaces, so keying by id alone could collide if two
    // contexts ever share an id (a duplicate, or a future non-globally-unique id
    // scheme). The later would silently overwrite the earlier and one invoice
    // would be skipped/mis-summarized. The composite key is collision-proof.
    out.set(`${context.type}:${context.entityId}`, {
      unbilledTimeEntries,
      unbilledFlatFees,
      totalUnbilledHours: roundCurrency(unbilledTimeEntries.reduce((s: any, e: any) => s + e.hours, 0)),
    });
  }
  return out;
}

/**
 * Every matter and client with unbilled work, for the bulk-invoice picker.
 *
 * The picker used to enumerate the firm's matters and clients on the client side
 * and then request one unbilled summary PER context: a firm with 200 matters and
 * 300 clients opened 500 concurrent requests to render one page, and discarded
 * most of the answers, since only contexts that have work are ever shown. This
 * answers the whole page in one request off the batched firm-wide reads, and
 * returns only the contexts with something to bill.
 *
 * Names are included so the caller does not have to load the firm's full matter
 * and client lists just to label the rows.
 *
 * Visibility follows the same owner/admin rule as every other firm-wide billing
 * read: owners and admins see the firm's whole billable picture, regular members
 * stay scoped to the matters they belong to. Without it the context list (built
 * from the owner-aware listAccessibleMatters) and the per-context authorization
 * disagreed, so a firm owner's bulk-invoicing screen silently under-reported what
 * the firm could bill by exactly the matters the owner is not a member of.
 */
export async function listFirmUnbilledSummaries({ lawFirmId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const [seeAll, matters, clients] = await Promise.all([
    isFirmOwnerOrAdmin(lawFirmId, actingUserId),
    billingReads.listAccessibleMatters(lawFirmId, actingUserId),
    billingReads.listFirmClients(lawFirmId),
  ]);

  const nameByKey = new Map();
  const contexts = [];
  for (const matter of matters) {
    contexts.push({ type: CONTEXT_TYPES.matter, entityId: matter.id });
    nameByKey.set(`${CONTEXT_TYPES.matter}:${matter.id}`, matter.name || matter.id);
  }
  for (const client of clients) {
    contexts.push({ type: CONTEXT_TYPES.client, entityId: client.id });
    nameByKey.set(`${CONTEXT_TYPES.client}:${client.id}`, client.name || client.email || client.id);
  }

  const summaryByKey = await getUnbilledSummaryBatch({ lawFirmId, contexts, actingUserId, seeAll });

  const summaries = [];
  for (const [key, summary] of summaryByKey) {
    // Sum in whole cents and convert once, matching getUnbilledSummary so a
    // context's estimate here reconciles with what billing it actually produces.
    const flatFeesCents = summary.unbilledFlatFees.reduce((sum: any, fee: any) => sum + toCents(fee.amount), 0);
    const timeCents = summary.unbilledTimeEntries.reduce((sum: any, entry: any) => sum + toCents(entry.amount), 0);
    const hours = summary.totalUnbilledHours || 0;
    if (!flatFeesCents && !timeCents && !hours) continue;

    const [type, entityId] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    summaries.push({
      type,
      entityId,
      name: nameByKey.get(key) || entityId,
      unbilledHours: hours,
      unbilledFlatFees: fromCents(flatFeesCents),
      unbilledTimeAmount: fromCents(timeCents),
      unbilledAmount: fromCents(flatFeesCents + timeCents),
    });
  }

  summaries.sort((a, b) => b.unbilledAmount - a.unbilledAmount || a.name.localeCompare(b.name));

  return { summaries, totalItems: summaries.length };
}

/**
 * Reverse the trust withdrawals linked to invoice payments that are about to be
 * removed (a deleted payment, a reset-to-unpaid, or an un-paid installment).
 *
 * Called from inside the invoice's own row-locked transaction, with that
 * transaction as `executor`, BEFORE the invoice write is returned. The reversal and
 * the removal therefore commit or roll back together: when the ledger refuses the
 * reversal (the entry was reconciled, or its period is closed) the refusal aborts
 * the removal, so the payment stays on the invoice and the withdrawal stays on the
 * ledger, and the client's trust balance never ends up short of money the invoice
 * no longer records as paid.
 */
async function voidTrustWithdrawalsForRemovedPayments(
  lawFirmId: string,
  removedPayments: any,
  actingUserId: string,
  executor: any,
) {
  const { voidTransactionInternal } = require('../../trust/trust.service');
  for (const p of removedPayments || []) {
    if (!p || p.paymentSource !== 'trust' || !p.trustTransactionId) continue;
    try {
      await voidTransactionInternal({
        lawFirmId,
        transactionId: p.trustTransactionId,
        reason: 'Invoice payment deleted',
        actingUserId,
        executor,
      });
    } catch (err: any) {
      // A withdrawal that no longer exists has nothing left to reverse.
      if (err instanceof NotFoundError) continue;
      // Any other refusal from the ledger is explained to the person, and the
      // removal is not made.
      if (err instanceof AppError && err.statusCode < 500) {
        throw new ConflictError(
          `The trust withdrawal behind this payment could not be reversed, so the payment was not removed. ${err.message}`,
        );
      }
      throw err;
    }
  }
}

/**
 * Record a payment, mark paid/unpaid, or update nextPaymentDate.
 */
export async function recordPayment({ lawFirmId, matterId, clientId, invoiceId, actingUserId, timeZone, body }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  const {
    isPaid, paidDate, paymentAmount, nextPaymentDate, installmentIndex, paymentNote,
    invoiceNumber,
    paymentSource, trustAccountId,
  } = body;
  // The day a payment is dated when none is given: today for the person
  // recording it, not the UTC day (which is tomorrow every evening in the US).
  const paymentDay = paidDate || await personalToday({ timeZone, userId: actingUserId });
  const hasIsPaid = typeof isPaid === 'boolean';
  const hasPaymentAmount = typeof paymentAmount === 'number' && paymentAmount > 0;
  // The one dollar-to-cents conversion in this flow. The schema admits whole
  // cents only, so this is exact, and everything below works in cents.
  const paymentAmountCents = hasPaymentAmount ? toCents(paymentAmount) : 0;
  const hasNextPaymentDate = nextPaymentDate !== undefined;

  if (!hasIsPaid && !hasPaymentAmount && !hasNextPaymentDate) {
    throw new ValidationError('isPaid (boolean), paymentAmount (positive number), or nextPaymentDate is required');
  }

  // Paying from trust writes a real withdrawal against the client's ledger, so it
  // is a trust-accounting action reached through a billing route. The invoices
  // router is NOT behind `requireFeature('trustAccounting')` (external payments
  // must keep working whatever the firm switched off), so the gate is applied
  // here, to the one branch that touches the ledger. Without it a firm on a plan
  // without trust accounting, or one that opted out, could still move client
  // funds through the payment form.
  if (paymentSource === 'trust') {
    const { enforceFeatureAccess } = require('../../../shared/plans/planEnforcement');
    await enforceFeatureAccess(lawFirmId, 'trustAccounting');
  }

  // BL1: the entire read→compute→write runs inside one transaction holding a
  // SELECT … FOR UPDATE lock on the invoice row. A trust withdrawal is issued
  // from inside the compute callback, ON THAT SAME TRANSACTION, so it (and its
  // BL4 over-payment guard) are evaluated against the locked invoice state and
  // commit or roll back with it. It used to open its own transaction on a second
  // connection, which deadlocked against this lock through the ledger row's
  // `invoice_id` foreign key; see the `executor` argument below.
  let trustTransactionId: any = null;
  let updated;
  // Cents of money actually applied by THIS update (a real payment or a
  // mark-fully-paid top-up). Drives the single INVOICE_PAYMENT_RECEIVED emitted
  // after commit: we fire on every applied payment (partial and full), and skip
  // no-money updates (a next-payment-date change, or a reset-to-unpaid).
  let appliedPaymentCents = 0;
  updated = await invoicesRepo.runInvoiceTxn(context, invoiceId, async (existing: any, txn: any) => {
    assertInvoiceNotVoided(existing, 'record a payment on it');
    const totalWrittenOff: any = existing.totalWrittenOff || 0;
    // BL #3: effectiveTotal in cents so comparisons/subtractions are exact.
    const effectiveTotalCents = invoiceTotalCents(existing) - toCents(totalWrittenOff);

    let updateData: any;

    if (!hasIsPaid && !hasPaymentAmount && hasNextPaymentDate) {
      // Next payment date only. A plan owns the date: it is the earliest open
      // instalment, so moving it on its own would hide a past-due instalment
      // from the invoice status until the next plan change recomputed it.
      if (existing.paymentPlan?.enabled) {
        throw new ValidationError(
          'This invoice is on a payment plan, which sets its next payment date from the schedule. '
          + 'Change an instalment date instead.',
        );
      }
      updateData = {
        nextPaymentDate: nextPaymentDate ? toDateOnlyOrNull(nextPaymentDate) : null,
        updatedAt: new Date().toISOString(),
        updatedBy: actingUserId,
      };
    } else if (hasPaymentAmount) {
      // BL4: reject over-payment before any trust withdrawal. Integer cents,
      // no tolerance: a whole-cent payment fits the balance exactly or it does not.
      const remainingCents = effectiveTotalCents - toCents(existing.amountPaid || 0);
      if (paymentAmountCents > remainingCents) {
        throw new ValidationError(
          `Payment amount ($${fromCents(paymentAmountCents).toFixed(2)}) exceeds the remaining balance ($${fromCents(remainingCents).toFixed(2)})`
        );
      }
      appliedPaymentCents = paymentAmountCents;

      // If paying from trust, create a trust withdrawal linked to this invoice first
      if (paymentSource === 'trust' && trustAccountId) {
        // Resolve client ID from the invoice record (not from the frontend) for security & consistency.
        const resolvedTrustClientId = existing.clientId;
        if (!resolvedTrustClientId) {
          throw new ValidationError('Cannot pay from trust: invoice has no linked client');
        }

        // Look up the client name from the firm's client record
        let resolvedTrustClientName = existing.clientName || '';
        if (!resolvedTrustClientName) {
          try {
            const cd = await billingReads.getClient(lawFirmId, resolvedTrustClientId);
            if (cd) resolvedTrustClientName = cd.name || cd.email || 'Unknown Client';
          } catch { /* use empty string fallback */ }
        }

        const { createTrustWithdrawalForInvoice } = require('../../trust/trust.service');
        const trustResult = await createTrustWithdrawalForInvoice({
          lawFirmId,
          trustAccountId,
          amountCents: paymentAmountCents,
          clientId: resolvedTrustClientId,
          clientName: resolvedTrustClientName,
          matterId: matterId || existing.matterId || null,
          invoiceId,
          date: paymentDay,
          actingUserId,
          // THIS transaction, not a new one. The ledger row carries
          // `invoice_id`, so its foreign key needs a key-share lock on the
          // invoice row we already hold `for update`. On a second connection
          // the two wait on each other until the statement timeout. Sharing
          // the transaction also makes the withdrawal roll back with the
          // invoice update, which is why no compensating void follows.
          executor: txn,
        });
        trustTransactionId = trustResult.transactionId;
      }

      // Partial payment
      const newAmountPaid = fromCents(toCents(existing.amountPaid || 0) + paymentAmountCents);
      const nowFullyPaid = toCents(newAmountPaid) >= effectiveTotalCents;

      const paymentEntry = {
        amount: fromCents(paymentAmountCents),
        date: paymentDay,
        recordedBy: actingUserId,
        ...(invoiceNumber ? { invoiceNumber: invoiceNumber.trim() } : {}),
        ...(paymentSource === 'trust' ? { paymentSource: 'trust', trustTransactionId, trustAccountId } : {}),
        ...(paymentNote ? { note: paymentNote.trim() } : {}),
      };

      updateData = {
        amountPaid: newAmountPaid,
        payments: [...(existing.payments || []), paymentEntry],
        isPaid: nowFullyPaid,
        paidDate: nowFullyPaid
          ? (toTimestampOrNull(paidDate) || new Date().toISOString())
          : (existing.paidDate || null),
        nextPaymentDate: nowFullyPaid
          ? null
          : (toDateOnlyOrNull(nextPaymentDate) || existing.nextPaymentDate || null),
        updatedAt: new Date().toISOString(),
        updatedBy: actingUserId,
      };
    } else if (isPaid === false) {
      // Mark as unpaid: reset all payment data. A payment Stripe collected is not
      // the firm's to erase (a refund or dispute still has to find it), so the
      // reset is refused outright. Trust-funded payments have their withdrawals
      // reversed in this same transaction, and a refused reversal refuses the reset.
      if ((existing.payments || []).some(isStripePayment)) {
        throw new ConflictError(STRIPE_PAYMENT_NOT_REMOVABLE);
      }
      await voidTrustWithdrawalsForRemovedPayments(lawFirmId, existing.payments, actingUserId, txn);
      updateData = {
        isPaid: false,
        paidDate: null,
        amountPaid: 0,
        payments: [],
        nextPaymentDate: null,
        updatedAt: new Date().toISOString(),
        updatedBy: actingUserId,
      };
    } else {
      // Mark as fully paid. The top-up payment is the shortfall to the
      // effective total; clamp at 0 so an already-overpaid invoice never
      // appends a NEGATIVE payment entry (which would corrupt the payment history).
      const topUpCents = Math.max(0, effectiveTotalCents - toCents(existing.amountPaid || 0));
      appliedPaymentCents = topUpCents;
      updateData = {
        isPaid: true,
        paidDate: toTimestampOrNull(paidDate) || new Date().toISOString(),
        // Never below what the payment rows already hold: an invoice paid past its
        // total keeps the overpayment on amount_paid so the credit due back stays visible.
        amountPaid: fromCents(Math.max(
          effectiveTotalCents,
          toCents(existing.amountPaid || 0),
          (existing.payments || []).reduce((sum: number, p: any) => sum + toCents(p.amount), 0),
        )),
        payments: [
          ...(existing.payments || []),
          ...(topUpCents > 0 ? [{
            amount: fromCents(topUpCents),
            date: paymentDay,
            recordedBy: actingUserId,
          }] : []),
        ],
        nextPaymentDate: null,
        updatedAt: new Date().toISOString(),
        updatedBy: actingUserId,
      };
    }

    // Payment plan installment tracking
    const existingPlan = ensurePlanRowIds(existing.paymentPlan);
    if (existingPlan?.enabled) {
      if (updateData.isPaid === true && !hasPaymentAmount) {
        // Fully paid: mark all installments as paid. The rows this settles are
        // linked to the top-up payment, so removing that payment reopens them.
        const topUpIndex = (updateData.payments || []).length > (existing.payments || []).length
          ? (existing.payments || []).length
          : null;
        const expectedPayments = normalizeExpectedPayments((existingPlan.expectedPayments || []).map((ep: any) => ({
          ...ep,
          status: 'paid',
          matchedPaymentIndex: topUpIndex !== null && isOpenInstallment(ep) ? topUpIndex : ep.matchedPaymentIndex,
        })));
        updateData.paymentPlan = { ...existingPlan, expectedPayments };
        updateData.nextPaymentDate = null;
      } else if (isPaid === false && !hasPaymentAmount) {
        // Reset to unpaid: every payment is gone, so every instalment is owed
        // again and the schedule is refit to the whole balance.
        const reopened = (existingPlan.expectedPayments || []).map((ep: any) => (
          ep.status === 'paid' ? { ...ep, status: 'pending', matchedPaymentIndex: null } : ep
        ));
        const refit = rebalancePendingInstallments(existingPlan, reopened, Math.max(0, effectiveTotalCents));
        if (refit) {
          updateData.paymentPlan = { ...existingPlan, expectedPayments: refit };
          updateData.nextPaymentDate = getNextPaymentTimestamp(refit);
        }
      } else if (hasPaymentAmount) {
        let expectedPayments = normalizeExpectedPayments([...(existingPlan.expectedPayments || [])]);
        const paymentIdx = (existing.payments || []).length;
        const named = typeof installmentIndex === 'number';

        if (named && (installmentIndex < 0 || installmentIndex >= expectedPayments.length)) {
          throw new ValidationError('That installment no longer exists on this payment plan. Refresh and try again.');
        }

        if (named) {
          const installment = expectedPayments[installmentIndex];
          if (!isOpenInstallment(installment)) {
            throw new ValidationError(
              `Installment #${installmentIndex + 1} is already paid. Choose an open installment, `
              + 'or leave the installment unselected to apply the payment from the earliest one.',
            );
          }
          // BL #3: all installment shortfall/excess math in integer cents.
          const shortfallCents = toCents(installment.amount) - paymentAmountCents;
          const shortfall = fromCents(shortfallCents);
          const { shortfallAction } = body;

          if (shortfallCents > 0 && (!shortfallAction || shortfallAction === 'add_to_current')) {
            // Partial payment: the installment stays open for the remaining
            // amount, so the open rows always sum to the invoice balance. This
            // is also the outcome when no shortfall action was chosen.
            expectedPayments[installmentIndex] = {
              ...installment,
              amount: shortfall,
              // status stays as-is (pending/overdue)
            };
          } else if (shortfallCents > 0) {
            // Settle the installment at what was actually paid, then deal with the shortfall.
            expectedPayments[installmentIndex] = {
              ...installment,
              amount: fromCents(paymentAmountCents),
              status: 'paid',
              matchedPaymentIndex: paymentIdx,
            };

            if (shortfallAction === 'write_off') {
              // Create a credit note for the shortfall
              const creditNote = {
                id: `cn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                amount: shortfall,
                description: `Shortfall write-off for installment #${installmentIndex + 1}`,
                type: 'write_off',
                createdAt: new Date().toISOString(),
                createdBy: actingUserId,
              };
              updateData.creditNotes = [...(existing.creditNotes || []), creditNote];
              updateData.totalWrittenOff = fromCents(toCents(existing.totalWrittenOff || 0) + shortfallCents);
            } else if (shortfallAction === 'add_to_next') {
              // Find the next open installment after this one
              let foundNext = false;
              for (let i = installmentIndex + 1; i < expectedPayments.length; i++) {
                if (isOpenInstallment(expectedPayments[i])) {
                  expectedPayments[i] = {
                    ...expectedPayments[i],
                    amount: fromCents(toCents(expectedPayments[i].amount) + shortfallCents),
                  };
                  foundNext = true;
                  break;
                }
              }
              if (!foundNext) {
                // No next installment exists: create a new one
                assertRoomForAnotherInstallment(expectedPayments);
                expectedPayments.push(newInstallmentAfterLast(existingPlan, expectedPayments, shortfallCents));
              }
            }
          } else {
            // The payment covers the installment; whatever is left over goes to
            // the open rows after it, then to the open rows before it.
            expectedPayments = allocatePaymentAcrossOpenRows(
              expectedPayments, installmentIndex, paymentAmountCents, paymentIdx,
            ).rows;
          }
        } else {
          // BL #3: allocate the payment across the open installments, earliest first, in integer cents.
          expectedPayments = allocatePaymentAcrossOpenRows(
            expectedPayments, Math.max(0, earliestOpenIndex(expectedPayments)), paymentAmountCents, paymentIdx,
          ).rows;
        }

        expectedPayments = normalizeExpectedPayments(expectedPayments);

        expectedPayments = normalizeExpectedPayments(expectedPayments);
        const allPaid = expectedPayments.every((ep: any) => ep.status === 'paid');
        updateData.paymentPlan = { ...existingPlan, expectedPayments };

        // Optional: set next installment due date (e.g. from Record Payment modal)
        if (!allPaid && body.nextPaymentDate && typeof installmentIndex === 'number') {
          const np = String(body.nextPaymentDate).trim();
          if (np) {
            const nextPending = getNextPendingExpectedPayment(expectedPayments);
            const nextIdx = nextPending
              ? expectedPayments.findIndex((payment: any) => payment.id === nextPending.id)
              : -1;
            if (nextIdx >= 0) {
              expectedPayments[nextIdx] = { ...expectedPayments[nextIdx], dueDate: np };
              updateData.paymentPlan = { ...existingPlan, expectedPayments };
            }
          }
        }

        if (allPaid) {
          updateData.nextPaymentDate = null;
        } else {
          const nextPending = getNextPendingExpectedPayment(expectedPayments);
          if (nextPending) {
            updateData.nextPaymentDate = toDateOnlyOrNull(nextPending.dueDate);
          }
        }
      }
    }

    return syncDueDateToLastInstallment(updateData);
  });

  if (!updated) {
    throw new NotFoundError('Invoice');
  }

  updated = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });

  // Fire on every applied payment (partial or full) so firm notifications, the
  // firm email, and the client receipt email can react. No-money updates (a
  // next-payment-date change or a reset-to-unpaid) leave appliedPaymentCents at
  // 0 and emit nothing. Non-fatal: never blocks the response.
  if (appliedPaymentCents > 0) {
    try {
      eventBus.emit(INVOICE_PAYMENT_RECEIVED, {
        lawFirmId,
        invoiceId,
        contextType: context.type,
        entityId: context.entityId,
        amountPaidCents: appliedPaymentCents,
        // The day the payment is recorded on, which the receipt shows.
        paymentDate: paymentDay,
        source: 'manual',
        isFullyPaid: updated.isPaid === true,
        // `clientId` on an invoice is a clients.id, never a Firebase uid. The
        // Stripe path emits both spaces under their own names; this path has only
        // the record, so the uid stays null rather than carrying the wrong id.
        clientRecordId: updated.clientId || null,
        clientUserId: null,
        actorUserId: actingUserId,
        invoiceName: updated.invoiceName || updated.invoiceNumber || null,
        invoiceCreatedBy: updated.createdBy || null,
        billingEmail: updated.billingEmail || null,
      });
    } catch (err: any) {
      console.error('[invoices] INVOICE_PAYMENT_RECEIVED emit failed:', err.message);
    }
  }

  // A manual payment just changed the balance. An open checkout session was
  // priced at the OLD remaining balance and, left live, lets the client pay that
  // stale amount on top of what was just recorded. Expire it; the payment link
  // stays open and prices from the new balance. Non-fatal.
  if (appliedPaymentCents > 0) {
    await expireStaleCheckoutSession(context, updated);
  }

  return { message: 'Invoice payment status updated successfully', invoice: formatInvoice(updated) };
}

/**
 * Expire an invoice's open Stripe Checkout session after its balance changed,
 * and clear the reference. A session is priced when it is created, so left open
 * it would let the client pay the superseded amount. The payment request itself
 * stays open: the pay link prices from the current balance, so the client's
 * link keeps working. Best effort: Stripe being unreachable must not fail a
 * write that has already committed.
 *
 * The reference is cleared only once the session can no longer collect money:
 * it was open and has just been expired, it had already expired, or Stripe has
 * no such session. A `complete` session with a bank debit still settling keeps
 * it, because the next checkout reads that pointer to refuse a second payment
 * (409 PAYMENT_PROCESSING) and void and delete read it to find the payment.
 * When Stripe cannot be read, or the expire fails, nothing is known and the
 * reference stays; the next checkout re-reads the session and replaces it.
 */
async function expireStaleCheckoutSession(context: any, invoice: any) {
  await cancelStaleCardPaymentIntent(context, invoice);
  try {
    if (!invoice || !invoice.stripeCheckoutSessionId) return;
    if (invoice.stripePaymentStatus === 'completed') return;

    const stripe = require('../../stripe/stripe.config');
    if (!stripe) return;
    let sessionGone = false;
    try {
      // Lazy-required: stripe.service requires this module at load.
      const { invoiceObjectArgsFor } = require('../../stripe/stripe.service');
      const onFirmAccount = await invoiceObjectArgsFor(context.lawFirmId, invoice.stripeCheckoutSessionAccountId);
      const sess = await stripe.checkout.sessions.retrieve(invoice.stripeCheckoutSessionId, ...onFirmAccount);
      if (sess && sess.status === 'open') {
        await stripe.checkout.sessions.expire(sess.id, ...onFirmAccount);
        sessionGone = true;
      } else if (sess && sess.status === 'expired') {
        sessionGone = true;
      }
    } catch (stripeErr: any) {
      if (stripeErr?.code === 'resource_missing' || stripeErr?.statusCode === 404 || stripeErr?.raw?.code === 'resource_missing') {
        sessionGone = true;
      } else {
        console.error(
          `stripe: could not expire stale checkout session ${invoice.stripeCheckoutSessionId} after a balance change:`,
          stripeErr?.message || stripeErr,
        );
      }
    }
    if (!sessionGone) return;

    await invoicesRepo.runInvoiceTxn(context, invoice.id, (existing: any) => {
      if (!existing || existing.stripePaymentStatus === 'completed') return null;
      if (existing.stripeCheckoutSessionId !== invoice.stripeCheckoutSessionId) return null;
      return {
        stripeCheckoutSessionId: null,
        stripeCheckoutSessionAccountId: null,
      };
    });
  } catch (err: any) {
    console.error('invoices: expireStaleCheckoutSession failed:', err?.message || err);
  }
}

/**
 * The card-form half of expireStaleCheckoutSession: a card payment the client
 * left waiting on bank verification was priced for the old balance, so it is
 * cancelled. The reference is cleared only once Stripe confirms it can no
 * longer collect; one that is processing or succeeded keeps it, and so does
 * one Stripe could not be reached about.
 */
async function cancelStaleCardPaymentIntent(context: any, invoice: any) {
  try {
    if (!invoice?.stripeCardPaymentIntentId || invoice.stripePaymentStatus === 'completed') return;
    // Lazy-required: stripe.service requires this module at load.
    const { closeCardPaymentIntent } = require('../../stripe/stripe.service');
    if (await closeCardPaymentIntent(invoice) !== 'closed') return;
    await invoicesRepo.runInvoiceTxn(context, invoice.id, (existing: any) => (
      existing && existing.stripeCardPaymentIntentId === invoice.stripeCardPaymentIntentId
        ? { stripeCardPaymentIntentId: null, stripeCardPaymentIntentAccountId: null }
        : null));
  } catch (err: any) {
    console.error('invoices: cancelStaleCardPaymentIntent failed:', err?.message || err);
  }
}

/**
 * A payment Stripe collected. Stripe holds the other half of the record, and the
 * refund and dispute handlers find it by its payment intent id, so removing it
 * here would leave a later refund with nothing to reverse.
 */
function isStripePayment(payment: any) {
  return payment?.paymentSource === 'stripe';
}

/** The refusal for removing a payment Stripe collected, from any path that removes one. */
const STRIPE_PAYMENT_NOT_REMOVABLE =
  'This payment was collected through Stripe and cannot be removed here. Refund it in Stripe, '
  + 'which reverses it on this invoice.';

/**
 * Where a payment sits in the invoice's list right now.
 *
 * A payment named by `paymentId` is found wherever it has moved to, and refused as
 * a conflict when it is gone (another tab or a double click already removed it), so
 * a stale request can never land on whichever payment now holds its old position.
 * Without an id the position is used, which is what callers that predate payment
 * ids send.
 */
function resolvePaymentIndex(payments: any[], { paymentId, paymentIndex }: { paymentId?: string; paymentIndex?: number }) {
  const gone = 'That payment no longer exists on this invoice. Refresh and try again.';
  if (paymentId) {
    const found = payments.findIndex((p: any) => p?.id === paymentId);
    if (found < 0) throw new ConflictError(gone);
    return found;
  }
  if (typeof paymentIndex !== 'number' || paymentIndex < 0 || paymentIndex >= payments.length) {
    throw new ValidationError(gone);
  }
  return paymentIndex;
}

/**
 * Delete a single payment from an invoice.
 */
export async function deletePayment({
  lawFirmId, matterId, clientId, invoiceId, paymentIndex: requestedIndex, paymentId, actingUserId,
}: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  // BL1: read→compute→write under a row lock.
  const updated = await invoicesRepo.runInvoiceTxn(context, invoiceId, async (existing: any, txn: any) => {
    const payments = [...(existing.payments || [])];
    const paymentIndex = resolvePaymentIndex(payments, { paymentId, paymentIndex: requestedIndex });
    if (isStripePayment(payments[paymentIndex])) {
      throw new ConflictError(STRIPE_PAYMENT_NOT_REMOVABLE);
    }

    const removed = payments.splice(paymentIndex, 1)[0];
    // A trust-funded payment's withdrawal is reversed first and in this same
    // transaction: a refused reversal aborts the delete before the invoice changes.
    await voidTrustWithdrawalsForRemovedPayments(lawFirmId, [removed], actingUserId, txn);
    // BL #3: integer-cent subtraction for amountPaid / effectiveTotal.
    const newAmountPaidCents = Math.max(0, toCents(existing.amountPaid || 0) - toCents(removed.amount));
    const newAmountPaid = fromCents(newAmountPaidCents);
    const totalWrittenOff: any = existing.totalWrittenOff || 0;
    const effectiveTotalCents = invoiceTotalCents(existing) - toCents(totalWrittenOff);
    const effectiveTotal = fromCents(effectiveTotalCents);
    const isPaid = newAmountPaidCents >= effectiveTotalCents && effectiveTotalCents > 0;

    const updateData: any = {
      payments,
      amountPaid: newAmountPaid,
      isPaid,
      paidDate: isPaid ? existing.paidDate : null,
      updatedAt: new Date().toISOString(),
      updatedBy: actingUserId,
    };

    // Rebuild payment plan schedule if one exists
    const existingPlan = ensurePlanRowIds(existing.paymentPlan);
    if (existingPlan?.enabled) {
      const newRemaining = fromCents(effectiveTotalCents - newAmountPaidCents);
      if (newRemaining <= 0) {
        // BL8: re-point matchedPaymentIndex for the removed payment before persisting.
        const ep = normalizeExpectedPayments(
          reindexMatchedPaymentIndices(
            (existingPlan.expectedPayments || []).map((e: any) => ({ ...e, status: 'paid' })),
            paymentIndex,
          )
        );
        updateData.paymentPlan = { ...existingPlan, expectedPayments: ep };
        updateData.nextPaymentDate = null;
      } else {
        // The instalments the payment settled are owed again, so reopen them
        // first. Reindex BEFORE rebalancing: deleting a payment shifts every later
        // index in `payments[]`, and the settled installments carried over by
        // rebalancePendingInstallments keep their matchedPaymentIndex verbatim.
        const ep = rebalancePendingInstallments(
          existingPlan,
          reindexMatchedPaymentIndices(
            reopenInstallmentsSettledBy(existingPlan.expectedPayments || [], paymentIndex),
            paymentIndex,
          ),
          toCents(newRemaining),
        );
        updateData.paymentPlan = { ...existingPlan, expectedPayments: ep };
        if (ep && ep.length > 0) {
          updateData.nextPaymentDate = getNextPaymentTimestamp(ep);
        }
      }
    }

    return syncDueDateToLastInstallment(updateData);
  });

  if (!updated) {
    throw new NotFoundError('Invoice');
  }

  const emitted = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });
  return { message: 'Payment deleted successfully', invoice: formatInvoice(emitted) };
}

/**
 * Edit a single payment on an invoice (amount, date, note).
 */
export async function editPayment({ lawFirmId, matterId, clientId, invoiceId, actingUserId, body }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  const { paymentIndex: requestedIndex, paymentId, amount, date, note, invoiceNumber } = body;

  // Set when the edit raises a payment, which lowers what the client still owes.
  let balanceLowered = false;

  // BL1: read→compute→write under a row lock.
  const updated = await invoicesRepo.runInvoiceTxn(context, invoiceId, async (existing: any) => {
    assertInvoiceNotVoided(existing, 'edit its payments');
    const payments = [...(existing.payments || [])];
    const paymentIndex = resolvePaymentIndex(payments, { paymentId, paymentIndex: requestedIndex });

    const old = payments[paymentIndex];

    // A trust- or Stripe-funded payment is backed by an external ledger entry (a
    // trust withdrawal, or a Stripe charge whose refunds are reconstructed from the
    // recorded amount). Silently re-amounting it here would desync that ledger: the
    // trust balance would stay wrong and could be drawn again, and the Stripe
    // refunded-cents reconstruction would be corrupted. Amount changes on these must
    // go through delete + re-record (which properly voids/re-issues the trust
    // withdrawal); date/note edits are still allowed.
    const isExternallyFunded = old.paymentSource === 'trust' || old.paymentSource === 'stripe';
    const wantsAmountChange = typeof amount === 'number' && amount > 0 && toCents(amount) !== toCents(old.amount);
    if (isExternallyFunded && wantsAmountChange) {
      throw new ValidationError(
        'Cannot change the amount of a trust- or Stripe-funded payment. Delete it and record a new payment instead.'
      );
    }

    const newAmount = (typeof amount === 'number' && amount > 0) ? amount : old.amount;
    const newDate = date || old.date;
    const newNote = note !== undefined ? (note.trim() || null) : (old.note || null);
    const newInvoiceNumber = invoiceNumber !== undefined ? (invoiceNumber?.trim() || null) : (old.invoiceNumber || null);

    payments[paymentIndex] = {
      ...old,
      amount: fromCents(toCents(newAmount)),
      date: newDate,
      ...(newNote ? { note: newNote } : {}),
      ...(newInvoiceNumber ? { invoiceNumber: newInvoiceNumber } : {}),
    };
    if (!newNote) delete payments[paymentIndex].note;
    if (!newInvoiceNumber) delete payments[paymentIndex].invoiceNumber;

    // BL #3: integer-cent diff so repeated edits never drift the paid total.
    const amountDiffCents = toCents(newAmount) - toCents(old.amount);
    const newAmountPaidCents = Math.max(0, toCents(existing.amountPaid || 0) + amountDiffCents);
    const newAmountPaid = fromCents(newAmountPaidCents);
    const totalWrittenOff: any = existing.totalWrittenOff || 0;
    const effectiveTotalCents = invoiceTotalCents(existing) - toCents(totalWrittenOff);

    // BL4 parity: editing an amount up must not overpay the invoice (record-small,
    // then-edit-up would otherwise bypass recordPayment's cap). Exact integer
    // cents, the same rule recordPayment applies. Only a raised amount can push the
    // paid total further past the invoice, so a note, a date or a lowered amount is
    // never refused for a total the payment did not move.
    if (amountDiffCents > 0 && newAmountPaidCents > effectiveTotalCents) {
      throw new ValidationError('Edited payment amount would exceed the invoice total');
    }
    balanceLowered = amountDiffCents > 0;

    const isPaid = newAmountPaidCents >= effectiveTotalCents && effectiveTotalCents > 0;

    const result: any = {
      payments,
      amountPaid: newAmountPaid,
      isPaid,
      paidDate: isPaid ? (existing.paidDate || new Date().toISOString()) : null,
      updatedAt: new Date().toISOString(),
      updatedBy: actingUserId,
    };

    // Correcting an amount moves the balance, so the schedule has to move with
    // it, exactly as it does for recordPayment and deletePayment. The instalments
    // this payment had settled are owed again; the schedule is refit to what the
    // balance was without the payment, and the payment is then applied at its
    // new amount starting where it started. A settled instalment therefore never
    // goes on reading as paid in full for an amount that no longer exists, and an
    // edit that settles the invoice keeps the paid rows, as recording that
    // payment would have.
    const existingPlan = ensurePlanRowIds(existing.paymentPlan);
    if (existingPlan?.enabled && amountDiffCents !== 0) {
      const planRows = normalizeExpectedPayments(existingPlan.expectedPayments || []);
      const settledByThisPayment = planRows
        .filter((ep: any) => ep.status === 'paid' && ep.matchedPaymentIndex === paymentIndex)
        .map((ep: any) => String(ep.dueDate || ''))
        .sort();
      const withoutThisPayment = rebalancePendingInstallments(
        existingPlan,
        reopenInstallmentsSettledBy(planRows, paymentIndex),
        effectiveTotalCents - (newAmountPaidCents - toCents(newAmount)),
      ) || [];
      const firstSettledDay = settledByThisPayment[0];
      const startIndex = firstSettledDay
        ? withoutThisPayment.findIndex((ep: any) => isOpenInstallment(ep) && String(ep.dueDate || '') >= firstSettledDay)
        : -1;
      const refit = allocatePaymentAcrossOpenRows(
        withoutThisPayment,
        startIndex >= 0 ? startIndex : Math.max(0, earliestOpenIndex(withoutThisPayment)),
        toCents(newAmount),
        paymentIndex,
      ).rows;
      result.paymentPlan = { ...existingPlan, expectedPayments: refit };
      result.nextPaymentDate = refit.every((ep: any) => ep.status === 'paid')
        ? null
        : getNextPaymentTimestamp(refit);
    }

    return syncDueDateToLastInstallment(result);
  });

  if (!updated) {
    throw new NotFoundError('Invoice');
  }

  // A raised payment lowers the balance, so any Stripe surface priced at the old
  // balance has to close, as it does for a newly recorded payment.
  if (balanceLowered) {
    await expireStaleCheckoutSession(context, updated);
  }

  const emitted = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });
  return { message: 'Payment updated successfully', invoice: formatInvoice(emitted) };
}

/**
 * Refuse to delete an invoice whose money lives in a second system as well.
 * Called twice by `deleteInvoice`: once early, so the common refusal costs no
 * Stripe call, and once under the row lock, which is the one that decides.
 */
async function assertInvoiceDeletable(lawFirmId: string, invoiceId: string, invoice: any) {
  // A payment Stripe collected is a record in a system this delete cannot reach.
  // The reversal handlers find the payment by `invoice_payments.stripe_payment_intent_id`;
  // delete the row and a later `charge.refunded` or `charge.dispute.created`
  // silently finds nothing, so the money is returned at Stripe while the firm's
  // accounts receivable still shows it as collected. A manually recorded payment
  // is the firm's own bookkeeping and stays deletable, which is the behaviour
  // the delete path has always had.
  if ((invoice.payments || []).some(isStripePayment)) {
    throw new ConflictError(
      'This invoice was paid through Stripe and cannot be deleted. Refund the payment in Stripe, '
      + 'which reverses it here, or void the invoice to cancel it while keeping the record.',
    );
  }

  // The trust ledger references this invoice by an ON DELETE SET NULL FK, and
  // that SET NULL is an UPDATE the append-only trigger refuses on a completed or
  // void entry, so deleting the invoice would abort with a raw trigger error.
  // Voiding the linked withdrawals does not help: a void row still carries
  // invoice_id, and void rows are the most immutable of all. Refuse with an
  // explanation instead, and keep the ledger's attribution intact.
  // Lazy-required, like every other trust access in this file (trust.service
  // reads invoices, so a top-level require would close a cycle).
  const { trustTxnRepo } = require('../../trust/trust.repository');
  if (await trustTxnRepo.countPermanentByInvoiceId(lawFirmId, invoiceId) > 0) {
    throw new ConflictError(
      'This invoice is referenced by trust account entries and cannot be deleted. Trust ledger entries are permanent records; remove the trust payment and then void the invoice instead.'
    );
  }
}

/**
 * INVOICE_DELETED for an invoice whose row is already gone. Not routed through
 * `emitInvoiceCalendarEvent`: that first persists missing plan ids onto the
 * row, which no longer exists, and then emits nothing. The ids are only needed
 * on the payload here.
 */
async function emitInvoiceDeleted({ lawFirmId, actingUserId, invoice }: any) {
  const { invoice: normalized } = ensureInvoicePaymentPlanIds(invoice);
  await eventBus.emitAsync(INVOICE_DELETED, {
    lawFirmId,
    invoiceId: normalized.id,
    userId: actingUserId,
    invoiceData: { ...normalized, lawFirmId },
  });
}

/**
 * Delete an invoice.
 */
export async function deleteInvoice({ lawFirmId, matterId, clientId, invoiceId, actingUserId }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  const existing = await invoicesRepo.findById(context, invoiceId);
  if (!existing) {
    throw new NotFoundError('Invoice');
  }
  await assertInvoiceDeletable(lawFirmId, invoiceId, existing);

  // Close every live Stripe payment surface BEFORE the row goes, the same set a
  // void closes: a charge that lands after deletion has no invoice to apply to
  // and would wedge the webhook in an endless retry. Strict, so a Stripe that
  // cannot be reached aborts the delete here rather than leaving a deleted
  // invoice with a payable link; a link that has already collected refuses it.
  // Lazy-required: stripe.service requires this module at load.
  const { closeInvoicePaymentSurfaces } = require('../../stripe/stripe.service');
  const { collected } = await closeInvoicePaymentSurfaces(lawFirmId, existing, { strict: true });
  if (collected) throw new ConflictError(STRIPE_PAID_DELETE_REFUSAL);

  // No trust compensation here, deliberately. A trust-funded payment always
  // creates its withdrawal with `invoice_id` set, so the permanent-entry guard
  // refuses the delete before this point is ever reached; the same helper
  // is still live for the two paths that remove a payment WITHOUT deleting the
  // invoice (a deleted payment, and an un-paid installment).

  // The decision that counts: re-checked on the invoice as it stands once the
  // row is locked, in the transaction that deletes it. The trust count reads
  // on its own connection; a trust payment needs this row lock to write its
  // withdrawal, so one cannot be in flight while this holds it, and a
  // committed one is visible.
  //
  // A link minted since the close above is on the row now (creation takes this
  // same lock), so it is closed here, still before the row goes.
  const deleted = await invoicesRepo.deleteLocked(context, invoiceId, async (current: any) => {
    await assertInvoiceDeletable(lawFirmId, invoiceId, current);
    const late = await closeInvoicePaymentSurfaces(lawFirmId, current, { strict: true, skip: existing });
    if (late.collected) throw new ConflictError(STRIPE_PAID_DELETE_REFUSAL);
  });
  if (!deleted) throw new NotFoundError('Invoice');

  // After commit: calendar listeners make network calls and must not run under the lock.
  await emitInvoiceDeleted({ lawFirmId, actingUserId, invoice: deleted });
  return { message: 'Invoice deleted successfully' };
}

/**
 * True when a derived payment entry lands on a day inside `[from, to]`.
 *
 * An entry carries up to three days (paid, invoice due, next installment) and is
 * drawn on each of them, so it belongs to the window if ANY of them is inside it.
 * The dates arrive as day strings or ISO strings, so each is cut to its calendar
 * day before comparison.
 */
function paymentEntryInWindow(entry: any, { from, to }: any) {
  return [entry.paidDate, entry.dueDate, entry.nextPaymentDate]
    .filter(Boolean)
    .map((value) => String(value).slice(0, 10))
    .some((day) => day >= from && day <= to);
}

/**
 * Calendar payment dates: upcoming payments across all user-visible matters.
 *
 * `window` ({ from, to } day-only strings) bounds the read to the days the
 * calendar is drawing. These are day-only money dates, so no timezone conversion
 * applies: the bounds are compared as calendar days. Without a window every
 * invoice in the firm is expanded, which is the contract the unwindowed callers
 * still hold.
 */
export async function getCalendarPaymentDates({ lawFirmId, actingUserId, window = null }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  // Probe which invoices could contribute an entry to the window before reading
  // any of them, so a firm with years of billing history pays for the days on
  // screen rather than its whole invoice book.
  const windowedIds = window ? await invoicesRepo.findFirmInvoiceIdsInDateWindow(lawFirmId, window) : null;
  if (windowedIds && windowedIds.length === 0) return { paymentDates: [] };

  const [matters, clients] = await Promise.all([
    billingReads.listAccessibleMatters(lawFirmId, actingUserId),
    billingReads.listFirmClients(lawFirmId),
  ]);

  // BL7: batch the firm-wide invoice + matter-client reads (was a per-matter /
  // per-client findByContext + listMatterClients N+1).
  const [{ byMatter: invByMatter, byClient: invByClient }, matterClientsByMatter] = await Promise.all([
    invoicesRepo.findForFirmByContext(lawFirmId, windowedIds ? { ids: windowedIds } : {}),
    billingReads.listMatterClientsForMatters(lawFirmId, matters.map((c: any) => c.id)),
  ]);

  const matterResults = await Promise.all(
    matters.map((matterRecord: any) => {
      const matterId = matterRecord.id;
      const matterName = matterRecord.name || 'Unnamed Matter';

      const invoices = invByMatter.get(matterId) || [];
      const matterClients = matterClientsByMatter.get(matterId) || [];

      // BL #5: read path must NOT write. Compute the payment-plan installment
      // ids in-memory only (ensureInvoicePaymentPlanIds) instead of persisting
      // them via ensureInvoiceCalendarSyncState → invoicesRepo.update, which
      // fired a burst of UPDATEs on a GET. buildPaymentDateEntries re-normalizes
      // the ids itself, and clientId/matterClientId/clientName are untouched by id
      // backfill, so the returned payload is identical.
      // No isPaid filter: buildPaymentDateEntries self-gates scheduled (owed)
      // items via getBillingCalendarItems, while still surfacing recorded
      // payments. A fully-paid invoice keeps showing its payment history.
      const paymentEntries = invoices
        .map((data: any) => {
          const { invoice: normalizedInvoice } = ensureInvoicePaymentPlanIds(data);

          let billingClient = null;
          if (normalizedInvoice.clientId) billingClient = matterClients.find((c: any) => c.id === normalizedInvoice.clientId || c.userId === normalizedInvoice.clientId);
          if (!billingClient && normalizedInvoice.matterClientId) billingClient = matterClients.find((c: any) => c.id === normalizedInvoice.matterClientId);

          return buildPaymentDateEntries(normalizedInvoice, {
            contextType: CONTEXT_TYPES.matter,
            matterId,
            matterName,
            clientName: normalizedInvoice.clientName || billingClient?.name || null,
          });
        });

      return paymentEntries.flat();
    })
  );

  const clientResults = await Promise.all(
    clients.map((clientRecord: any) => {
      const clientId = clientRecord.id;
      const clientName = clientRecord.name || null;
      const invoices = invByClient.get(clientId) || [];

      // BL #5: in-memory id normalization only. No DB write on this read path.
      // No isPaid filter (see the matter branch above).
      const paymentEntries = invoices
        .map((data: any) => {
          const { invoice: normalizedInvoice } = ensureInvoicePaymentPlanIds(data);
          return buildPaymentDateEntries(normalizedInvoice, {
            contextType: CONTEXT_TYPES.client,
            clientId,
            clientName: normalizedInvoice.clientName || clientName,
          });
        });

      return paymentEntries.flat();
    })
  );

  // The id probe is a superset (it matches an invoice if ANY of its dates is in
  // the window, while an invoice can produce entries on other days too), so the
  // derived entries are filtered exactly here.
  const entries = [...matterResults.flat(), ...clientResults.flat()];
  return { paymentDates: window ? entries.filter((e) => paymentEntryInWindow(e, window)) : entries };
}

/**
 * Add a credit note (write-off, discount, or adjustment) to an invoice.
 */
export async function addCreditNote({ lawFirmId, matterId, clientId, invoiceId, actingUserId, body }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  const { amount, description, type } = body;

  // BL1: read→compute→write under a row lock.
  const updated = await invoicesRepo.runInvoiceTxn(context, invoiceId, async (existing: any) => {
    assertInvoiceNotVoided(existing, 'add a credit note to it');
    const creditNote = {
      id: crypto.randomUUID(),
      amount,
      description: description || type.replace('_', ' '),
      type,
      createdBy: actingUserId,
      createdAt: new Date().toISOString(),
    };

    // BL #3: write-off totals and remaining computed in integer cents.
    const newTotalWrittenOffCents = toCents(existing.totalWrittenOff || 0) + toCents(amount);
    const newTotalWrittenOff = fromCents(newTotalWrittenOffCents);

    // A write-off cannot exceed the remaining balance: amountPaid + totalWrittenOff
    // must never exceed the invoice total, or the balance goes negative. Reject
    // (integer-cent exact comparison, no epsilon needed).
    const totalCents = invoiceTotalCents(existing);
    const amountPaidCents = toCents(existing.amountPaid || 0);
    if (amountPaidCents + newTotalWrittenOffCents > totalCents) {
      throw new ValidationError('Write-off exceeds the invoice remaining balance');
    }

    const updateFields: any = {
      creditNotes: [...(existing.creditNotes || []), creditNote],
      totalWrittenOff: newTotalWrittenOff,
      updatedAt: new Date().toISOString(),
      updatedBy: actingUserId,
    };

    // A write-off that clears the balance settles the invoice without marking it
    // paid: `isPaid` records that the firm collected the money, and forgiven money
    // was not collected, so the invoice reads 'credited' (or 'paid' when cash
    // covered the rest). No next payment is expected either way.
    const newRemainingCents = invoiceTotalCents(existing) - toCents(existing.amountPaid || 0) - newTotalWrittenOffCents;
    const newRemaining = fromCents(newRemainingCents);
    if (newRemainingCents <= 0 && invoiceTotalCents(existing) > 0) {
      updateFields.nextPaymentDate = null;
    }

    // Recalculate payment plan if active. A write-off that settles the invoice
    // keeps the instalments already paid, as a line-item edit does, and drops
    // the open ones.
    const existingPlan = ensurePlanRowIds(existing.paymentPlan);
    if (existingPlan?.enabled) {
      const ep = rebalancePendingInstallments(
        existingPlan, existingPlan.expectedPayments, newRemainingCents,
      );
      if (!ep) {
        updateFields.paymentPlan = null;
        updateFields.nextPaymentDate = null;
      } else {
        updateFields.paymentPlan = { ...existingPlan, expectedPayments: ep };
        updateFields.nextPaymentDate = newRemaining <= 0 ? null : getNextPaymentTimestamp(ep);
      }
    }

    return syncDueDateToLastInstallment(updateFields);
  });

  if (!updated) {
    throw new NotFoundError('Invoice');
  }

  // The write-off lowered what the client owes, so any Stripe surface priced at
  // the old balance has to close.
  await expireStaleCheckoutSession(context, updated);

  const emitted = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });

  // A write-off reduces the invoice's collectible balance; let firm invoice
  // managers know in-app. Non-fatal: never blocks the response.
  try {
    eventBus.emit(INVOICE_CREDIT_NOTE_ADDED, {
      lawFirmId,
      invoiceId,
      contextType: context.type,
      entityId: context.entityId,
      matterId: emitted.matterId || null,
      amountCents: toCents(amount),
      creditType: type,
      invoiceName: emitted.invoiceName || emitted.invoiceNumber || null,
      actorUserId: actingUserId,
    });
  } catch (err: any) {
    console.error('[invoices] INVOICE_CREDIT_NOTE_ADDED emit failed:', err.message);
  }

  return { message: 'Credit note added successfully', invoice: formatInvoice(emitted) };
}

/**
 * Delete a credit note from an invoice.
 */
export async function deleteCreditNote({ lawFirmId, matterId, clientId, invoiceId, creditNoteId, actingUserId }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  // BL1: read→compute→write under a row lock (was a plain findById + update,
  // which a concurrent payment could clobber).
  const updated = await invoicesRepo.runInvoiceTxn(context, invoiceId, async (existing: any) => {
    assertInvoiceNotVoided(existing, 'remove its credit notes');
    const existingCreditNotes = existing.creditNotes || [];
    const noteToDelete = existingCreditNotes.find((cn: any) => cn.id === creditNoteId);
    if (!noteToDelete) {
      throw new NotFoundError('Credit note');
    }

    const updatedCreditNotes = existingCreditNotes.filter((cn: any) => cn.id !== creditNoteId);
    // BL #3: sum credit-note amounts in integer cents, then convert once.
    const newTotalWrittenOffCents = updatedCreditNotes.reduce((sum: any, cn: any) => sum + toCents(cn.amount), 0);
    const newTotalWrittenOff = fromCents(newTotalWrittenOffCents);

    const updateFields: any = {
      creditNotes: updatedCreditNotes,
      totalWrittenOff: newTotalWrittenOff,
      updatedAt: new Date().toISOString(),
      updatedBy: actingUserId,
    };

    // Re-evaluate settled status after removing credit note
    const newRemainingCents = invoiceTotalCents(existing) - toCents(existing.amountPaid || 0) - newTotalWrittenOffCents;
    const newRemaining = fromCents(newRemainingCents);
    if (newRemainingCents > 0 && existing.isPaid) {
      // Removing this credit note leaves a real outstanding balance, so an invoice
      // that was marked paid must be reopened, and with it loses the date it was
      // settled on. Gated on the live isPaid flag, not status. The persisted status
      // is recomputed by deriveInvoiceStatus in the repo.
      updateFields.isPaid = false;
      updateFields.paidDate = null;
    }

    // Recalculate payment plan if active. A write-off that settles the invoice
    // keeps the instalments already paid, as a line-item edit does, and drops
    // the open ones.
    const existingPlan = ensurePlanRowIds(existing.paymentPlan);
    if (existingPlan?.enabled) {
      const ep = rebalancePendingInstallments(
        existingPlan, existingPlan.expectedPayments, newRemainingCents,
      );
      if (!ep) {
        updateFields.paymentPlan = null;
        updateFields.nextPaymentDate = null;
      } else {
        updateFields.paymentPlan = { ...existingPlan, expectedPayments: ep };
        updateFields.nextPaymentDate = newRemaining <= 0 ? null : getNextPaymentTimestamp(ep);
      }
    }

    return syncDueDateToLastInstallment(updateFields);
  });

  if (!updated) {
    throw new NotFoundError('Invoice');
  }

  const emitted = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });
  return { message: 'Credit note deleted successfully', invoice: formatInvoice(emitted) };
}

/**
 * Add an amount to an existing invoice's total.
 * If a payment plan is active, appends a new installment after the last pending one.
 */
export async function addAmountToInvoice({ lawFirmId, matterId, clientId, invoiceId, actingUserId, body }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  const { amount, note } = body;

  // BL1: read→compute→write under a row lock.
  const updated = await invoicesRepo.runInvoiceTxn(context, invoiceId, async (existing: any) => {
    assertInvoiceNotVoided(existing, 'add an amount to it');
    // BL #3: total + remaining in integer cents. totalAmount already includes flat
    // fees (set from time + flat fees at creation), so the remaining balance is the
    // canonical total - paid - writtenOff; do not add flatFeesAmount again.
    const newTotalAmount = fromCents(invoiceTotalCents(existing) + toCents(amount));
    const newRemainingCents = toCents(newTotalAmount)
      - toCents(existing.amountPaid || 0) - toCents(existing.totalWrittenOff || 0);
    const newRemaining = fromCents(newRemainingCents);

    const updateFields: any = {
      totalAmount: newTotalAmount,
      updatedAt: new Date().toISOString(),
      updatedBy: actingUserId,
    };

    // Every added amount is recorded, with or without a note: the rows are what
    // keeps the charge in the total when the invoice's lines are edited later.
    updateFields.amountAdjustmentNotes = [
      ...(existing.amountAdjustmentNotes || []),
      { amount, note: note?.trim() || null, addedBy: actingUserId, addedAt: new Date().toISOString() },
    ];

    // If previously paid but new amount pushes remaining > 0, reopen invoice and
    // drop the date it was settled on.
    if (existing.isPaid && newRemaining > 0) {
      updateFields.isPaid = false;
      updateFields.paidDate = null;
    }

    // If payment plan is active, append a new installment after the last open one.
    // A plan already at its instalment limit folds the amount into the last open
    // instalment instead of growing past it.
    const existingPlan = ensurePlanRowIds(existing.paymentPlan);
    if (existingPlan?.enabled) {
      let expectedPayments = sortScheduleByDate(normalizeExpectedPayments([...(existingPlan.expectedPayments || [])]));

      if (expectedPayments.length >= MAX_PLAN_INSTALLMENTS) {
        const lastOpen = expectedPayments.map(isOpenInstallment).lastIndexOf(true);
        // Full, with no open instalment to carry the amount: nothing can take it.
        if (lastOpen < 0) assertRoomForAnotherInstallment(expectedPayments);
        expectedPayments = expectedPayments.map((ep: any, idx: number) => (
          idx === lastOpen
            ? { ...ep, amount: fromCents(toCents(ep.amount || 0) + toCents(amount)) }
            : ep
        ));
      } else {
        // Anchor the new date on the last open instalment, or the last one of all.
        const lastOpen = expectedPayments.map(isOpenInstallment).lastIndexOf(true);
        const lastDate = lastOpen >= 0 ? expectedPayments[lastOpen].dueDate : lastScheduledDay(expectedPayments);

        const nextDate = lastDate
          ? onCadenceDaysAfter(existingPlan, lastDate)()
          : dayjs().add(existingPlan.frequencyDays, 'day').format('YYYY-MM-DD');

        expectedPayments = [...expectedPayments, {
          dueDate: nextDate,
          amount,
          status: 'pending',
          matchedPaymentIndex: null,
        }];
      }

      const schedule = normalizeExpectedPayments(expectedPayments);
      updateFields.paymentPlan = { ...existingPlan, expectedPayments: schedule };
    }

    return syncDueDateToLastInstallment(updateFields);
  });

  if (!updated) {
    throw new NotFoundError('Invoice');
  }

  const emitted = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });
  return { message: 'Amount added to invoice successfully', invoice: formatInvoice(emitted) };
}

/* ------------------------------------------------------------------ */
/*  Late fees (one-time overdue charge, NOT interest)                  */
/* ------------------------------------------------------------------ */

// Fee in integer cents for a remaining balance under a firm's late-fee settings.
// flatAmount and percent stack. Returns 0 when disabled or nothing is owed.
export function computeLateFeeCents(remainingCents: any, lateFee: any) {
  if (!lateFee || lateFee.enabled !== true) return 0;
  if (!(remainingCents > 0)) return 0;
  const flatCents = toCents(Number(lateFee.flatAmount) || 0);
  const percent = Number(lateFee.percent) || 0;
  const percentCents = percent > 0 ? percentOfCents(remainingCents, percent) : 0;
  const fee = flatCents + percentCents;
  return fee > 0 ? fee : 0;
}

function invoiceRemainingCents(inv: any) {
  return invoiceTotalCents(inv) - toCents(inv.amountPaid || 0) - toCents(inv.totalWrittenOff || 0);
}

// Whether a late fee may be applied to `existing` right now. A late fee is a
// one-time charge, so an invoice that already carries one is never eligible again.
function lateFeeEligibility(existing: any, lateFee: any, now: any, timeZone: any) {
  // Void before every other rule: a cancelled bill is never charged a penalty,
  // and the cron sweep reads this as a skip rather than an error.
  if (existing.status === 'voided') return { eligible: false, reason: 'voided' };
  if (invoiceRemainingCents(existing) <= 0 || existing.isPaid) {
    return { eligible: false, reason: 'no_balance' };
  }
  const alreadyApplied = (existing.amountAdjustmentNotes || []).some((a: any) => a && a.kind === 'late_fee');
  if (alreadyApplied) return { eligible: false, reason: 'already_applied' };

  const dueRaw = existing.nextPaymentDate || existing.dueDate;
  if (!dueRaw) return { eligible: false, reason: 'no_due_date' };
  // Both days come from the same zone. `today` used to be the SERVER's local day
  // while the due day was read straight off the column, so a firm whose zone had
  // not yet rolled over could be charged a late fee a day early (or, west of the
  // server, a day late). zonedDayString returns a day-only value unchanged and
  // projects a real instant into the zone, so the comparison is apples to apples.
  const dueDay = zonedDayString(dueRaw, timeZone);
  const today = zonedDayString(now, timeZone);
  if (!dueDay || !today) return { eligible: false, reason: 'no_due_date' };
  const graceDays = Number(lateFee.graceDays) || 0;
  // Eligible once the current calendar day is strictly past the due day plus grace.
  const graceCutoff = dayjs(dueDay).add(graceDays, 'day');
  if (!dayjs(today).isAfter(graceCutoff, 'day')) return { eligible: false, reason: 'within_grace' };
  return { eligible: true };
}

function buildLateFeeUpdate(existing: any, feeCents: any, actingUserId: string) {
  const feeDollars = fromCents(feeCents);
  const newTotalAmount = fromCents(invoiceTotalCents(existing) + feeCents);
  const newRemaining = toCents(newTotalAmount) - toCents(existing.amountPaid || 0) - toCents(existing.totalWrittenOff || 0);
  const updateFields: any = {
    totalAmount: newTotalAmount,
    updatedAt: new Date().toISOString(),
    updatedBy: actingUserId,
    // A late fee is recorded as a tagged amount adjustment.
    amountAdjustmentNotes: [
      ...(existing.amountAdjustmentNotes || []),
      { amount: feeDollars, note: 'Late fee', kind: 'late_fee', addedBy: actingUserId, addedAt: new Date().toISOString() },
    ],
  };
  if (existing.isPaid && newRemaining > 0) {
    updateFields.isPaid = false;
    updateFields.paidDate = null;
  }

  // On a payment plan the fee is carried by the next open instalment, so the
  // open rows go on covering the balance. A plan with no open instalment gets a
  // new one for the fee.
  const plan = ensurePlanRowIds(existing.paymentPlan);
  if (plan?.enabled) {
    const rows = sortScheduleByDate(normalizeExpectedPayments(plan.expectedPayments || []));
    const nextOpen = rows.findIndex((ep: any) => isOpenInstallment(ep));
    let withFee;
    if (nextOpen >= 0) {
      withFee = rows.map((ep: any, idx: number) => (
        idx === nextOpen ? { ...ep, amount: fromCents(toCents(ep.amount || 0) + feeCents) } : ep
      ));
    } else {
      assertRoomForAnotherInstallment(rows);
      withFee = [...rows, newInstallmentAfterLast(plan, rows, feeCents)];
    }
    const schedule = normalizeExpectedPayments(withFee);
    updateFields.paymentPlan = { ...plan, expectedPayments: schedule };
    updateFields.nextPaymentDate = getNextPaymentTimestamp(schedule);
  }
  return syncDueDateToLastInstallment(updateFields);
}

// Shared apply used by both the manual route and the auto cron. Runs under the
// invoice row lock and is idempotent (re-running never stacks a second fee).
// Returns { applied, feeCents, invoice, skipReason }.
export async function applyLateFeeCore({ context, invoiceId, actingUserId, lateFee, timeZone = 'UTC' }: any) {
  let feeCents = 0;
  let skipReason = null;
  const invoice = await invoicesRepo.runInvoiceTxn(context, invoiceId, async (existing: any) => {
    const elig = lateFeeEligibility(existing, lateFee, new Date(), timeZone);
    if (!elig.eligible) { skipReason = elig.reason; return null; }
    feeCents = computeLateFeeCents(invoiceRemainingCents(existing), lateFee);
    if (feeCents <= 0) { skipReason = 'zero_fee'; return null; }
    return buildLateFeeUpdate(existing, feeCents, actingUserId);
  });
  return { applied: !skipReason && !!invoice, feeCents, invoice, skipReason };
}

const LATE_FEE_SKIP_MESSAGES = {
  no_balance: 'Invoice has no outstanding balance',
  already_applied: 'A late fee has already been applied to this invoice',
  no_due_date: 'Invoice has no due date',
  within_grace: 'Invoice is not yet past due beyond the grace period',
  zero_fee: 'The configured late fee comes to zero for this invoice',
  voided: 'This invoice has been voided, so a late fee cannot be applied.',
};

/**
 * Apply a late fee to a single invoice (manual, firm-triggered).
 */
export async function applyLateFee({ lawFirmId, matterId, clientId, invoiceId, actingUserId, timeZone }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  const billingSettings = await getFirmBillingSettings(lawFirmId);
  const lateFee = billingSettings.lateFee;
  if (!lateFee || lateFee.enabled !== true) {
    throw new ValidationError('Late fees are not enabled for this firm');
  }

  const { applied, feeCents, invoice, skipReason } = await applyLateFeeCore({
    context, invoiceId, actingUserId, lateFee, timeZone: timeZone || 'UTC',
  });

  if (!invoice) {
    throw new NotFoundError('Invoice');
  }
  if (!applied) {
    throw new ValidationError((LATE_FEE_SKIP_MESSAGES as Record<string, string>)[String(skipReason)] || 'Late fee could not be applied');
  }

  const emitted = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId, context, actingUserId, invoice,
  });
  return {
    message: 'Late fee applied successfully',
    lateFeeAmount: fromCents(feeCents),
    invoice: formatInvoice(emitted),
  };
}

/** Close a checkout whose installment or amount a plan edit changes, before committing the new schedule. */
async function runPaymentPlanTxn(context: any, invoiceId: string, update: (invoice: any) => Promise<any>) {
  return invoicesRepo.runInvoiceTxn(context, invoiceId, async (existing: any) => {
    const patch = await update(existing);
    if (!patch || (!existing.stripeCheckoutSessionId && !existing.stripeCardPaymentIntentId)) return patch;
    const before = payLinkRequest(existing);
    const after = payLinkRequest({ ...existing, ...patch });
    if (before.requestedCents === after.requestedCents && before.isPayable === after.isPayable
      && before.installmentId === after.installmentId) return patch;

    const { closeInvoicePaymentSurfaces } = require('../../stripe/stripe.service');
    const { collected } = await closeInvoicePaymentSurfaces(context.lawFirmId, existing, {
      strict: true, allowRecordedPayments: true,
    });
    if (collected) {
      throw new ConflictError('A payment for this plan has already been collected or is processing. Wait for it to appear on the invoice before changing the plan.');
    }
    return {
      ...patch,
      stripeCheckoutSessionId: null,
      stripeCheckoutSessionAccountId: null,
      stripeCardPaymentIntentId: null,
      stripeCardPaymentIntentAccountId: null,
    };
  });
}

/** Set a payment plan on an invoice. */
export async function setPaymentPlan({ lawFirmId, matterId, clientId, invoiceId, actingUserId, body }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  const { installmentAmount, frequencyDays, downPaymentAmount, downPaymentAlreadyPaid } = body;
  // Normalize to the literal 'YYYY-MM-DD' up front, once, rather than letting
  // the raw request string (which may carry a time and offset) reach dayjs/
  // `new Date()` below - those read the UTC INSTANT's calendar day, which
  // shifts by one whenever an offset pushes the wall time across UTC
  // midnight. `dateInput`'s Zod refine already proved the leading date is
  // real, so this can only fail defensively.
  const planStartDate = toDateOnlyOrNull(body.planStartDate) || body.planStartDate;
  const downPaymentDueDate = body.downPaymentDueDate
    ? (toDateOnlyOrNull(body.downPaymentDueDate) || body.downPaymentDueDate)
    : body.downPaymentDueDate;

  // BL1: read→compute→write under a row lock.
  const updated = await runPaymentPlanTxn(context, invoiceId, async (existing: any) => {
    assertInvoiceNotVoided(existing, 'put it on a payment plan');
    // BL #3: remaining balance in integer cents.
    const remainingCents = invoiceTotalCents(existing) - toCents(existing.amountPaid || 0) - toCents(existing.totalWrittenOff || 0);
    const remaining = fromCents(remainingCents);
    if (remainingCents <= 0) {
      throw new ValidationError('Invoice has no remaining balance');
    }

    const hasDownPayment = typeof downPaymentAmount === 'number' && downPaymentAmount > 0;
    if (hasDownPayment && toCents(downPaymentAmount) >= remainingCents) {
      throw new ValidationError('Down payment must be less than the remaining balance');
    }

    // Regular installments start on planStartDate; if there's a down payment they start one period later
    const regularInstallmentStartDate = hasDownPayment
      ? scheduleDay(planStartDate, 1, frequencyDays)
      : planStartDate;

    const regularRemainingCents = hasDownPayment ? remainingCents - toCents(downPaymentAmount) : remainingCents;
    assertPlanWithinInstallmentCap(regularRemainingCents, toCents(installmentAmount), hasDownPayment ? 1 : 0);
    const regularRemaining = fromCents(regularRemainingCents);
    const regularInstallments = rebuildSchedule(
      { installmentAmount, frequencyDays, planStartDate, regularInstallmentStartDate },
      regularRemaining,
    );

    const markDownPaymentPaid = hasDownPayment && downPaymentAlreadyPaid === true;

    // Build the down payment entry. Mark as paid immediately if already received
    const existingPayments = existing.payments || [];
    const downPaymentMatchIndex = markDownPaymentPaid ? existingPayments.length : null;

    const downPaymentEntry = hasDownPayment
      ? {
          dueDate: markDownPaymentPaid ? planStartDate : (downPaymentDueDate || planStartDate),
          amount: downPaymentAmount,
          status: markDownPaymentPaid ? 'paid' : 'pending',
          isDownPayment: true,
          matchedPaymentIndex: downPaymentMatchIndex,
        }
      : null;

    const expectedPayments = normalizeExpectedPayments(hasDownPayment
      ? [downPaymentEntry, ...(regularInstallments || [])]
      : (regularInstallments || []));

    const paymentPlan: any = {
      enabled: true,
      installmentAmount,
      frequencyDays,
      planStartDate,
      regularInstallmentStartDate,
      ...(hasDownPayment ? { downPaymentAmount } : {}),
      expectedPayments,
    };

    // If down payment is already collected, record a payment entry and update amountPaid
    const newPayments = markDownPaymentPaid
      ? [...existingPayments, {
          amount: downPaymentAmount,
          date: planStartDate,
          recordedBy: actingUserId,
          note: 'Down payment',
        }]
      : existingPayments;
    const newAmountPaid = markDownPaymentPaid
      ? fromCents(toCents(existing.amountPaid || 0) + toCents(downPaymentAmount))
      : (existing.amountPaid || 0);

    // Next payment is the first pending installment (skip down payment if already paid)
    const nextPaymentDate = getNextPaymentTimestamp(expectedPayments) || toDateOnlyOrNull(planStartDate);

    return syncDueDateToLastInstallment({
      paymentPlan,
      nextPaymentDate,
      ...(markDownPaymentPaid ? { payments: newPayments, amountPaid: newAmountPaid } : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: actingUserId,
    });
  });

  if (!updated) {
    throw new NotFoundError('Invoice');
  }

  const emitted = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });

  return { message: 'Payment plan set successfully', invoice: formatInvoice(emitted) };
}

/**
 * Remove a payment plan from an invoice.
 * Any payments already recorded against installments are preserved in the payments array.
 */
export async function removePaymentPlan({ lawFirmId, matterId, clientId, invoiceId, actingUserId }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  // BL1: read→compute→write under a row lock (was a plain findById + update,
  // which a concurrent payment could clobber).
  const updated = await runPaymentPlanTxn(context, invoiceId, async (existing: any) => {
    assertInvoiceNotVoided(existing, 'change its payment plan');
    // Preserve all recorded payments and recalculate paid status from them
    const preservedPayments = existing.payments || [];
    const preservedAmountPaid = existing.amountPaid || 0;
    const totalWrittenOff: any = existing.totalWrittenOff || 0;
    // BL #3: integer-cent comparison for the preserved-payments paid check.
    const effectiveTotalCents = invoiceTotalCents(existing) - toCents(totalWrittenOff);
    const isPaid = effectiveTotalCents > 0 && toCents(preservedAmountPaid) >= effectiveTotalCents;
    // The persisted status is recomputed by deriveInvoiceStatus in the repo
    // (which also accounts for 'overdue'), so only the real isPaid flag is set here.

    // dueDate is intentionally left untouched here. While the plan was active,
    // dueDate was kept in sync with the LAST installment's due date (see
    // syncDueDateToLastInstallment), which permanently overwrote whatever
    // pre-plan value the invoice used to carry - there is no column that
    // preserves the original, and inventing one is a schema change beyond the
    // scope of this fix. On removal we could either (a) leave dueDate at that
    // last-installment value, as done here, or (b) recompute some fresh
    // default (e.g. a net-30-style invoiceDate + N days), but no such default
    // is actually computed anywhere in this codebase today - createInvoice
    // just persists whatever dueDate the caller sent. Leaving it as-is is the
    // least surprising option without guessing at a policy nobody has
    // defined; if a recoverable pre-plan due date is wanted, that needs a
    // product decision plus a real column to store it.
    return {
      paymentPlan: null,
      nextPaymentDate: null,
      payments: preservedPayments,
      amountPaid: preservedAmountPaid,
      isPaid,
      updatedAt: new Date().toISOString(),
      updatedBy: actingUserId,
    };
  });

  if (!updated) {
    throw new NotFoundError('Invoice');
  }

  const emitted = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });

  return { message: 'Payment plan removed successfully', invoice: formatInvoice(emitted) };
}

/**
 * Update a single installment in a payment plan (date or amount).
 */
export async function updateInstallment({ lawFirmId, matterId, clientId, invoiceId, actingUserId, installmentIndex, body }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  // BL1: read→compute→write under a row lock (was a plain findById + update,
  // which a concurrent payment could clobber).
  const updated = await runPaymentPlanTxn(context, invoiceId, async (existing: any) => {
    assertInvoiceNotVoided(existing, 'change its payment plan');
    const plan = ensurePlanRowIds(existing.paymentPlan);
    if (!plan?.enabled) {
      throw new ValidationError('No active payment plan');
    }

    const expectedPayments = normalizeExpectedPayments([...(plan.expectedPayments || [])]);
    if (installmentIndex < 0 || installmentIndex >= expectedPayments.length) {
      throw new ValidationError('That installment no longer exists on this payment plan. Refresh and try again.');
    }

    const installment = expectedPayments[installmentIndex];
    if (installment.status === 'paid') {
      throw new ValidationError('Cannot edit a paid installment');
    }

    if (body.dueDate) {
      expectedPayments[installmentIndex] = { ...installment, dueDate: body.dueDate };
    }
    if (typeof body.amount === 'number') {
      expectedPayments[installmentIndex] = { ...expectedPayments[installmentIndex], amount: body.amount };
    }

    // If rescheduled to a date that already has another unpaid installment,
    // combine them into a single installment instead of showing duplicates.
    // Where the edit ends up. A merge removes the row that was edited, so the
    // amount the firm typed lives on the row it merged into from then on, and
    // the reconciliation below has to protect THAT row.
    let editedIndex = installmentIndex;

    if (body.dueDate) {
      const moved = expectedPayments[installmentIndex];
      const mergeIdx = expectedPayments.findIndex((ep: any, idx: any) =>
        idx !== installmentIndex
        && ep.dueDate === moved.dueDate
        && (ep.status === 'pending' || ep.status === 'overdue')
      );

      if (mergeIdx >= 0) {
        // BL #3: merge installment amounts in integer cents.
        const mergedAmount = fromCents(toCents(expectedPayments[mergeIdx].amount || 0) + toCents(moved.amount || 0));
        expectedPayments[mergeIdx] = {
          ...expectedPayments[mergeIdx],
          amount: mergedAmount,
        };
        expectedPayments.splice(installmentIndex, 1);
        // Removing the earlier row shifts everything after it down by one.
        editedIndex = mergeIdx > installmentIndex ? mergeIdx - 1 : mergeIdx;
      }
    }

    // The edit changes what the schedule adds up to, so reconcile it against
    // the balance before it is stored. Without this the plan collects an amount
    // the invoice never agreed to.
    const balanceCents = invoiceTotalCents(existing)
      - toCents(existing.totalWrittenOff || 0)
      - toCents(existing.amountPaid || 0);
    // "After the edited instalment" means falling due after it, so the rows are
    // put in date order first and the edited row is found again by its id.
    const editedId = expectedPayments[editedIndex].id;
    const dated = sortScheduleByDate(expectedPayments);
    const reconciled = absorbInstallmentDelta(
      dated,
      dated.findIndex((ep: any) => ep.id === editedId),
      Math.max(0, balanceCents),
      plan,
    );

    // Recalculate nextPaymentDate
    const nextPaymentDate = getNextPaymentTimestamp(reconciled);

    return syncDueDateToLastInstallment({
      paymentPlan: { ...plan, expectedPayments: reconciled },
      nextPaymentDate,
      updatedAt: new Date().toISOString(),
      updatedBy: actingUserId,
    });
  });

  if (!updated) {
    throw new NotFoundError('Invoice');
  }

  const emitted = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });

  return { message: 'Installment updated successfully', invoice: formatInvoice(emitted) };
}

/**
 * Replace the unpaid portion of a payment plan's schedule in one atomic write.
 *
 * Paid installments are "locked": they are preserved exactly. Every other (free, unpaid) installment is
 * discarded and replaced by `body.installments`. This backs the bulk schedule editor:
 * editing amounts/dates, adding, removing, redistributing, and changing the cadence all
 * collapse into a single call. The unpaid instalments must together add up to the
 * balance the invoice still has to collect, and a schedule that does not is refused.
 */
export async function replacePaymentPlanSchedule({ lawFirmId, matterId, clientId, invoiceId, actingUserId, body }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  const incoming = Array.isArray(body.installments) ? body.installments : [];

  const updated = await runPaymentPlanTxn(context, invoiceId, async (existing: any) => {
    assertInvoiceNotVoided(existing, 'change its payment plan');
    const plan = ensurePlanRowIds(existing.paymentPlan);
    if (!plan?.enabled) {
      throw new ValidationError('No active payment plan');
    }

    const current = normalizeExpectedPayments([...(plan.expectedPayments || [])]);

    // Paid installments survive untouched: they carry payment linkage. A payment
    // link aimed at a replaced row simply stops being payable.
    const isLocked = (ep: any) => ep.status === 'paid';
    const lockedInstallments = current.filter(isLocked);

    const replacements = incoming.map((inst: any) => ({
      dueDate: inst.dueDate,
      amount: roundCurrency(inst.amount),
      status: 'pending',
      matchedPaymentIndex: null,
    }));

    if (lockedInstallments.length + replacements.length > MAX_PLAN_INSTALLMENTS) {
      throw new ValidationError(
        `A payment plan can have at most ${MAX_PLAN_INSTALLMENTS} instalments, and ${lockedInstallments.length} `
        + `paid instalment(s) stay on this one.`,
      );
    }

    const merged = [...lockedInstallments, ...replacements]
      .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

    // A wholesale replacement states the entire schedule, so there is nothing
    // to absorb a mismatch into and no edit to preserve. Refusing is the only
    // honest answer: a schedule adding to more asks the client for money the
    // invoice never billed, and one adding to less never settles it.
    const balanceCents = invoiceTotalCents(existing)
      - toCents(existing.totalWrittenOff || 0)
      - toCents(existing.amountPaid || 0);
    const scheduledCents = unscheduledCents(merged);
    if (merged.length > 0 && scheduledCents !== Math.max(0, balanceCents)) {
      throw new ValidationError(
        `These instalments add up to ${formatDollarsFromCents(scheduledCents)}, but this invoice still has `
        + `${formatDollarsFromCents(Math.max(0, balanceCents))} to collect.`,
      );
    }

    const expectedPayments = normalizeExpectedPayments(merged);
    const nextPaymentDate = getNextPaymentTimestamp(expectedPayments);

    const nextPlan = { ...plan, expectedPayments };
    if (typeof body.frequencyDays === 'number' && body.frequencyDays > 0) {
      nextPlan.frequencyDays = body.frequencyDays;
    }

    return syncDueDateToLastInstallment({
      paymentPlan: nextPlan,
      nextPaymentDate,
      updatedAt: new Date().toISOString(),
      updatedBy: actingUserId,
    });
  });

  if (!updated) {
    throw new NotFoundError('Invoice');
  }

  const emitted = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });

  return { message: 'Payment plan schedule updated successfully', invoice: formatInvoice(emitted) };
}

/**
 * Mark a paid installment as unpaid: reverses the matched payment.
 */
export async function unpayInstallment({ lawFirmId, matterId, clientId, invoiceId, actingUserId, installmentIndex, paymentId }: any) {
  const context = resolveInvoiceContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);

  // BL1: read→compute→write under a row lock.
  const updated = await invoicesRepo.runInvoiceTxn(context, invoiceId, async (existing: any, txn: any) => {
    assertInvoiceNotVoided(existing, 'change its payment plan');
    const plan = ensurePlanRowIds(existing.paymentPlan);
    if (!plan?.enabled) {
      throw new ValidationError('No active payment plan');
    }

    const expectedPayments = normalizeExpectedPayments([...(plan.expectedPayments || [])]);
    if (installmentIndex < 0 || installmentIndex >= expectedPayments.length) {
      throw new ValidationError('That installment no longer exists on this payment plan. Refresh and try again.');
    }

    const installment = expectedPayments[installmentIndex];
    if (installment.status !== 'paid') {
      throw new ValidationError('Installment is not paid');
    }

    const paymentIdx = installment.matchedPaymentIndex;
    const payments = [...(existing.payments || [])];
    let removedAmount = 0;
    // Every row the payment settled is owed again, not only the one named.
    let reopened: any[];

    if (typeof paymentIdx === 'number' && paymentIdx >= 0 && paymentIdx < payments.length) {
      // A Stripe payment keeps its row: the refund and dispute handlers find it
      // by its payment intent id, and un-paying would leave a refund at Stripe
      // with nothing to reverse here.
      if (isStripePayment(payments[paymentIdx])) {
        throw new ConflictError(STRIPE_PAYMENT_NOT_REMOVABLE);
      }
      // A caller that names the payment it saw settle this installment is refused
      // when the installment now points at a different one.
      if (paymentId && payments[paymentIdx].id !== paymentId) {
        throw new ConflictError('That payment no longer settles this installment. Refresh and try again.');
      }
      const removed = payments.splice(paymentIdx, 1)[0];
      removedAmount = removed.amount || 0;
      // The payment's trust withdrawal is reversed first and in this same
      // transaction: a refused reversal aborts the un-pay before the invoice changes.
      await voidTrustWithdrawalsForRemovedPayments(lawFirmId, [removed], actingUserId, txn);

      // Fix matchedPaymentIndex on other installments (indices shifted after splice)
      reopened = reindexMatchedPaymentIndices(reopenInstallmentsSettledBy(expectedPayments, paymentIdx), paymentIdx);
    } else {
      if (paymentId) {
        throw new ConflictError('That payment no longer settles this installment. Refresh and try again.');
      }
      // Settled with no payment behind it: only this row is reopened.
      reopened = expectedPayments.map((ep: any, idx: number) => (
        idx === installmentIndex ? { ...ep, status: 'pending', matchedPaymentIndex: null } : ep
      ));
    }

    // BL #3: integer-cent subtraction for the reversed installment payment.
    const newAmountPaidCents = Math.max(0, toCents(existing.amountPaid || 0) - toCents(removedAmount));
    const newAmountPaid = fromCents(newAmountPaidCents);
    const totalWrittenOff: any = existing.totalWrittenOff || 0;
    const effectiveTotalCents = invoiceTotalCents(existing) - toCents(totalWrittenOff);
    const isPaid = newAmountPaidCents >= effectiveTotalCents && effectiveTotalCents > 0;

    // The reopened rows and the balance now owed are brought back into step, so
    // a row settled short, or one that carried the shortfall, returns to the
    // plan's own instalment amount.
    const remainingCents = effectiveTotalCents - newAmountPaidCents;
    const refit = (remainingCents > 0 ? rebalancePendingInstallments(plan, reopened, remainingCents) : reopened) || [];

    return syncDueDateToLastInstallment({
      payments,
      amountPaid: newAmountPaid,
      isPaid,
      paidDate: isPaid ? existing.paidDate : null,
      paymentPlan: { ...plan, expectedPayments: refit },
      nextPaymentDate: getNextPaymentTimestamp(refit),
      updatedAt: new Date().toISOString(),
      updatedBy: actingUserId,
    });
  });

  if (!updated) {
    throw new NotFoundError('Invoice');
  }

  const emitted = await emitInvoiceCalendarEvent(INVOICE_UPDATED, {
    lawFirmId,
    context,
    actingUserId,
    invoice: updated,
  });

  return { message: 'Installment marked as unpaid', invoice: formatInvoice(emitted) };
}

export async function setReminderOptOut({ lawFirmId, matterId, clientId, invoiceId, actingUserId, optOut }: any) {
  const context = resolveContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);
  const { NotFoundError } = require('../../../shared/errors/AppError');
  // BL1: read→write under a row lock (was a plain findById + update, which a
  // concurrent payment could clobber via the child-table replace-all).
  const updated = await invoicesRepo.runInvoiceTxn(context, invoiceId, () => ({
    reminderOptOut: Boolean(optOut),
    updatedAt: new Date().toISOString(),
  }));
  if (!updated) throw new NotFoundError('Invoice');
  return { message: optOut ? 'Reminders disabled for this invoice' : 'Reminders enabled for this invoice', invoice: formatInvoice(updated) };
}

export async function setPreDueReminder({ lawFirmId, matterId, clientId, invoiceId, actingUserId, invoiceDays, planDays }: any) {
  const context = resolveContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);
  const { NotFoundError } = require('../../../shared/errors/AppError');

  // BL1: read→compute→write under a row lock (was a plain findById + update,
  // which a concurrent payment could clobber via the child-table replace-all).
  const updated = await invoicesRepo.runInvoiceTxn(context, invoiceId, (invoice: any) => {
    const patch: any = { updatedAt: new Date().toISOString() };

    // Invoice-level pre-due reminder (null clears it)
    if (invoiceDays !== undefined) {
      patch.preDueReminderDays = invoiceDays === null ? null : Number(invoiceDays);
      patch.preDueReminderSentAt = null; // reset so next cron re-evaluates
    }

    // Payment-plan-level pre-due reminder. Rewrite the whole paymentPlan object
    // (the relational repo persists the plan header + expectedPayments together).
    if (planDays !== undefined && invoice.paymentPlan?.enabled) {
      const expectedPayments = Array.isArray(invoice.paymentPlan.expectedPayments)
        ? invoice.paymentPlan.expectedPayments.map((p: any) => ({ ...p, preDueReminderSentAt: null }))
        : invoice.paymentPlan.expectedPayments;
      patch.paymentPlan = {
        ...invoice.paymentPlan,
        preReminderDays: planDays === null ? null : Number(planDays),
        expectedPayments,
      };
    }

    return patch;
  });

  if (!updated) throw new NotFoundError('Invoice');
  return { message: 'Pre-due reminder settings saved', invoice: formatInvoice(updated) };
}

/**
 * Bulk-create invoices for multiple contexts in a single call.
 * Each context with unbilled work gets its own invoice with auto-assigned sequential number.
 */
export async function bulkCreateInvoices({
  lawFirmId, actingUserId, contexts, invoiceDate, dueDate, invoiceNamePrefix,
}: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  // BL3: derive the allocator prefix from the requested base (strip any numeric
  // suffix) so every bulk-created invoice number comes from the same atomic
  // per-firm counter as single creates, never a racy local counter.
  const baseNumber = invoiceNamePrefix || 'INV-001';
  const allocatorPrefix = baseNumber.replace(/\d+$/, '') || 'INV-';
  const created: any[] = [];
  const skipped: any[] = [];
  const errors: Record<string, string> = {};
  // Current (not snapshotted) billing recipients per created draft, keyed by
  // invoice id - same contract the single and split create paths return.
  const billingRecipients: Record<string, any> = {};

  // Perf: compute every context's unbilled summary from ONE set of firm-wide
  // batched reads instead of fanning out ~7 reads per context (getUnbilledSummary).
  // getUnbilledSummaryBatch authorizes each context internally and omits any the
  // user can't access; an omitted entityId here means either no-access or no-work,
  // both of which are reported as "skipped" exactly as the prior per-context path
  // surfaced an empty/unauthorized context.
  //
  // No `seeAll` here, deliberately. This is a write path, and createInvoice below
  // authorizes every context through authorizeContext -> assertMatterMembership,
  // which has no owner/admin escape. Widening the summary alone would only move a
  // refusal from "skipped" to "errors"; widening the write is a privilege change to
  // invoice creation that the single-invoice path does not make either.
  const summaryByEntity = await getUnbilledSummaryBatch({ lawFirmId, contexts, actingUserId });

  // A picked id that names no activity at all is a malformed request, not work to
  // skip: refuse the whole run before any invoice is written.
  await invoicesRepo.assertActivitiesExist(lawFirmId, 'time', contexts.flatMap((c: any) => c.timeEntryIds || []));
  await invoicesRepo.assertActivitiesExist(lawFirmId, 'flat_fee', contexts.flatMap((c: any) => c.flatFeeIds || []));

  for (const ctx of contexts) {
    const { type, entityId } = ctx;
    try {
      const summary = summaryByEntity.get(`${type}:${entityId}`);
      if (!summary) {
        skipped.push(entityId);
        continue;
      }

      // A run may bill only part of a context's unbilled work. Filtering here
      // rather than in the caller keeps the server the one place that decides
      // what is billable: an id the context does not own simply does not match,
      // so a selection can never pull in another matter's time.
      const pickedTimeEntryIds = ctx.timeEntryIds ? new Set(ctx.timeEntryIds) : null;
      const pickedFlatFeeIds = ctx.flatFeeIds ? new Set(ctx.flatFeeIds) : null;
      const selectedTimeEntries = pickedTimeEntryIds
        ? summary.unbilledTimeEntries.filter((te: any) => pickedTimeEntryIds.has(te.id))
        : summary.unbilledTimeEntries;
      const selectedFlatFees = pickedFlatFeeIds
        ? summary.unbilledFlatFees.filter((ff: any) => pickedFlatFeeIds.has(ff.id))
        : summary.unbilledFlatFees;

      const hasWork = selectedTimeEntries.length > 0 || selectedFlatFees.length > 0;
      if (!hasWork) {
        skipped.push(entityId);
        continue;
      }

      const invoiceName = await invoicesRepo.allocateInvoiceNumber(lawFirmId, allocatorPrefix);

      const timeEntries = selectedTimeEntries.map((te: any) => ({
        id: te.id,
        name: te.name,
        description: te.description,
        hours: te.hours,
        rate: te.rate || 0,
        amount: te.amount || 0,
      }));
      const flatFees = selectedFlatFees.map((ff: any) => ({
        id: ff.id,
        description: ff.description,
        amount: ff.amount,
      }));
      // BL #3: aggregate invoice totals in integer cents so they reconcile to the
      // cent against the per-line amounts createInvoice will re-sum and assert.
      const timeAmountCents = timeEntries.reduce((s: any, te: any) => s + toCents(te.amount), 0);
      const flatFeesAmountCents = flatFees.reduce((s: any, f: any) => s + toCents(f.amount), 0);
      const timeAmount = fromCents(timeAmountCents);
      const flatFeesAmount = fromCents(flatFeesAmountCents);
      const totalAmount = fromCents(timeAmountCents + flatFeesAmountCents);
      const totalHours = pickedTimeEntryIds
        ? roundCurrency(selectedTimeEntries.reduce((sum: number, te: any) => sum + (Number(te.hours) || 0), 0))
        : summary.totalUnbilledHours;

      const body = {
        invoiceName,
        invoiceNumber: invoiceName,
        invoiceDate,
        dueDate: dueDate || null,
        timeEntries,
        flatFees,
        totalHours,
        totalAmount,
        flatFeesAmount,
      };

      // A matter with a configured split bills to several payers at once, so it
      // produces one invoice per payer rather than one for the matter. The split
      // is read from the matter, not asked for: it is a property of the
      // engagement, so a bulk run must honour it without a person restating it.
      const matterPayers =
        type === 'matter' ? await billingReads.listMatterClients(lawFirmId, entityId) : [];

      if (type === 'matter' && billingReads.isSplitConfigured(matterPayers)) {
        const allocations = allocateWorkToPayers({
          payers: matterPayers.map((client: any) => ({
            clientId: client.id,
            portionBp: client.billingPortionBp,
          })),
          timeEntries,
          flatFees,
        });

        const splitBodies: any[] = [];
        for (const allocation of allocations) {
          // Each share takes its own number from the same atomic per-firm
          // counter, so the split's invoices are not distinguished only by a
          // suffix the counter never issued.
          const shareName: string = splitBodies.length === 0
            ? invoiceName
            : await invoicesRepo.allocateInvoiceNumber(lawFirmId, allocatorPrefix);

          splitBodies.push({
            invoiceName: shareName,
            invoiceNumber: shareName,
            matterClientId: allocation.clientId,
            allocationPercent: allocation.allocationPercent,
            timeEntries: allocation.timeEntries.map((line: any) => ({
              ...line.source,
              hours: line.allocationHours,
              amount: line.allocationAmount,
              allocationPercent: line.allocationPercent,
              allocationAmount: line.allocationAmount,
            })),
            flatFees: allocation.flatFees.map((line: any) => ({
              ...line.source,
              amount: line.allocationAmount,
              allocationPercent: line.allocationPercent,
              allocationAmount: line.allocationAmount,
            })),
            totalHours: allocation.totalHours,
            totalAmount: allocation.totalAmount,
            flatFeesAmount: allocation.flatFeesAmount,
          });
        }

        const splitResult = await createSplitInvoices({
          lawFirmId,
          matterId: entityId,
          actingUserId,
          body: {
            invoiceDate,
            dueDate: dueDate || null,
            splitMode: 'percentage',
            sourceSelection: {
              timeEntries: timeEntries.map((entry: any) => entry.id),
              flatFees: flatFees.map((fee: any) => fee.id),
            },
            invoices: splitBodies,
          },
        });

        created.push(...splitResult.invoices);
        Object.assign(billingRecipients, splitResult.billingRecipients || {});
        continue;
      }

      const result = await createInvoice({
        lawFirmId,
        matterId: type === 'matter' ? entityId : undefined,
        clientId: type === 'client' ? entityId : undefined,
        actingUserId,
        body,
      });
      created.push(result.invoice);
      if (result.billingRecipients) billingRecipients[result.invoice.id] = result.billingRecipients;
    } catch (err: any) {
      errors[entityId] = err.message;
    }
  }

  return {
    message: 'Bulk invoice creation completed',
    requested: contexts.length,
    created,
    skipped,
    failed: Object.keys(errors),
    errors,
    billingRecipients,
  };
}

export const _rebuildSchedule = rebuildSchedule;
export const _rebalancePendingInstallments = rebalancePendingInstallments;

