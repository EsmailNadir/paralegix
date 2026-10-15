const crypto = require('crypto');
const stripe = require('./stripe.config');
const { privilegedParameterizedQuery } = require('../../shared/database/queryContext');
const { withLock } = require('../../shared/database/advisoryLock');
const { toTimestampOrNull, zonedDayString } = require('../../shared/utils/time');
const { firmZone } = require('../../shared/utils/personalDay');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { NoBillingRecipientError, NotFoundError, ValidationError, ConflictError, AppError } = require('../../shared/errors/AppError');
const {
  assertHasRecipients,
  invoiceClientRecordId,
  normalizeEmailList,
  resolveCurrentBillingRecipients,
  resolveInvoiceRecipients,
  snapshotInvoiceRecipients,
} = require('../billing/shared/billingRecipientSnapshot.service');
const { authorizeContext } = require('../billing/context');
const { assertInvoiceNotVoided } = require('../billing/shared/invoiceStatus');
const { deriveRefundDue } = require('../billing/shared/invoiceDerive');
const invoicesRepo = require('../billing/invoices/invoices.repository');
const invoicesService = require('../billing/invoices/invoices.service');
const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const clientsRepo = require('../clients/clients.repository');
const billingReads = require('../billing/shared/billingReads');
const { financialRootSql } = require('../../shared/database/financialQuery');
const { formatDollarsFromCents } = require('../billing/shared/money');
const eventBus = require('../../shared/events/eventBus');
const { INVOICE_PAYMENT_REQUESTED, INVOICE_PAYMENT_RECEIVED, INVOICE_PAYMENT_REVERSED,
  INVOICE_PAYMENT_RECREDITED, INVOICE_PAYMENT_DISPUTE_LOST, TRUST_DEPOSIT_RECEIVED,
  TRUST_DEPOSIT_REVERSAL_FAILED, TRUST_DEPOSIT_FAILED,
  TRUST_DEPOSIT_POSTING_FAILED } = require('../../shared/events/eventTypes');
const { isUuid } = require('../../shared/utils/isUuid');
const { toCents, fromCents, percentOfCents } = require('../billing/shared/money');
const trustService = require('../trust/trust.service');
const {
  trustAccountRepo,
  trustTxnRepo,
  getFirmTrustSettings,
  recordTrustDepositFee,
  markTrustDepositFeeBilled,
  findTrustDepositFee,
  attachTrustDepositFeeInvoice,
  listAccruedTrustDepositFees,
  findTrustAccountByStripeConnectedAccountId,
  matterBelongsToClient,
} = require('../trust/trust.repository');
const { sendPaymentRequestEmail, sendTrustDepositRequestEmail } = require('../../shared/services/emailService');
const { getNextPendingExpectedPayment } = require('../billing/shared/billingCalendar');
const { earliestOpenIndex, allocatePaymentAcrossOpenRows } = require('../billing/shared/paymentPlanSchedule');
// An ES import, unlike its neighbours, so the event name and property types are checked.
import { captureServerEvent } from '../../shared/analytics/serverAnalytics';
import {
  applicationFeeCents,
  clientSurchargeCents,
  estimatedCostCents,
  PAYMENT_METHOD_KINDS,
  type PaymentMethodKind,
} from './processingFees';
import { hasRecordedStripeSurface } from '../billing/shared/stripePaymentSurfaces';
import {
  creditCardFeeCents,
  INTERNATIONAL_EXTRA_PERCENT,
  type CardFeeEligibility,
  type CardFeeSettings,
} from './cardFeeRules';
import { ineligibleMessage } from './cardFeeCopy';
import { firmCardFeeContext } from './cardFeeSettings.service';
import { payLinkUrl } from '../billing/shared/payLinkUrl';
import { payLinkRequest } from '../billing/shared/payLinkRequest';
import {
  listOutstandingRecoveries,
  markRecoveryRestored,
  netRecoveredCents,
  recordFundRecovery,
  type FundRecovery,
  type FundRecoverySource,
} from './stripeFundRecoveries.repository';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Generous: the locked work is a ledger write plus up to two sequential Stripe
// API calls (recoverConnectedTransfer, chargeFirmForTrustClawback).
const STRIPE_PAYMENT_INTENT_LOCK_MAX_HOLD_MS = Number(process.env.STRIPE_PAYMENT_INTENT_LOCK_MAX_HOLD_MS) || 120_000;

const stripeSql = (text: string, params: unknown[] = [], executor?: any) => privilegedParameterizedQuery(
  'Stripe webhook idempotency and payment locks are privileged infrastructure paths',
  text,
  params,
  executor,
);

// The application fee on invoice payments (destination and direct charges, card
// and bank) lives in processingFees.ts, beside the client-paid surcharge it must
// agree with.

// ACH processing fee for an electronic trust deposit. The deposit itself carries NO
// application fee (client trust funds settle in full); Paralegix fronts the ACH cost
// and bills it back to the firm's operating side. Defaults track Stripe ACH pricing
// (0.8%, capped at $5). Rate/cap are env-overridable so pricing can change without a
// redeploy. Pass-through by default (no margin).
const TRUST_ACH_FEE_RATE = Number(process.env.STRIPE_TRUST_ACH_FEE_RATE ?? 0.008);
const TRUST_ACH_FEE_CAP_CENTS = Number(process.env.STRIPE_TRUST_ACH_FEE_CAP_CENTS ?? 500);

// Payout-schedule delay (business days) applied to connected accounts so client
// funds stay in the account's recoverable Stripe balance during the dispute /
// ACH-return window instead of paying out to the firm's bank immediately. On a
// clawback within the window the funds can then be reversed from the Stripe
// balance rather than lost. Env-overridable.
const CONNECT_PAYOUT_DELAY_DAYS = Number(process.env.STRIPE_CONNECT_PAYOUT_DELAY_DAYS ?? 7);

// Master switch for the AUTOMATIC fund-recovery actions that move real money on a
// dispute/refund/ACH-return (transfer reversals, re-transfers, and charging a
// firm's card for a trust clawback). OFF by default: these run on live webhooks
// and must be validated end-to-end with the Stripe CLI (simulated disputes / ACH
// returns) before being enabled per environment. When off, the handlers log what
// they WOULD do so the exposure is still visible. Payout hardening below is NOT
// gated by this — it only keeps funds recoverable, it never moves money.
const AUTO_RECOVERY_ENABLED = String(process.env.STRIPE_AUTO_RECOVERY_ENABLED ?? '').toLowerCase() === 'true';

/**
 * The processing fee (integer cents) billed to the firm for an ACH trust deposit of
 * `amountCents`: `min(round half up(rate * amount), cap)`, never exceeding the deposit.
 */
export function computeTrustAchFeeCents(amountCents: any) {
  const amount = Math.round(Number(amountCents) || 0);
  if (amount <= 0) return 0;
  const fee = Math.min(percentOfCents(amount, TRUST_ACH_FEE_RATE * 100), TRUST_ACH_FEE_CAP_CENTS);
  return Math.max(0, Math.min(fee, amount));
}

/**
 * How a firm's invoice payments are charged. A firm onboarded onto a Standard
 * account (`direct_charges_enabled`) is charged directly ON its own account: every
 * Stripe call about those payments carries `{ stripeAccount }`, there is no
 * transfer, and refunds and disputes debit the firm, not Paralegix. Every other
 * firm keeps destination charges on the platform account (`opts` undefined).
 * Trust deposits never use this; they stay destination charges into the trust
 * connected account, because a Standard account would take Stripe's fee out of
 * client money.
 */
function invoiceChargeScope(firmData: any): { direct: boolean; opts: { stripeAccount: string } | undefined } {
  const direct = firmData?.directChargesEnabled === true && !!firmData?.stripeAccountId;
  return { direct, opts: direct ? { stripeAccount: firmData.stripeAccountId } : undefined };
}

/**
 * Trailing request arguments that put a call on the firm's account, and nothing at
 * all for a destination-charge firm, so its calls keep their exact shape:
 * `create(params, ...onAccount(scope))`, `voidInvoice(id, ...idOnAccount(scope))`.
 */
function onAccount(scope: { opts: { stripeAccount: string } | undefined }) {
  return scope.opts ? [scope.opts] : [];
}
function idOnAccount(scope: { opts: { stripeAccount: string } | undefined }) {
  return scope.opts ? [{}, scope.opts] : [];
}

async function invoiceChargeScopeFor(lawFirmId: string) {
  return invoiceChargeScope(await lawfirmsRepo.findById(lawFirmId));
}

/**
 * What is stored beside a checkout session id to say which
 * account it was created on: the connected account id for a direct charge, the
 * word below for the platform account. Null is reserved for rows written before
 * the column existed, which carry no answer.
 */
export const PLATFORM_ACCOUNT = 'platform';

/** The value to record for an object created under `scope`. */
function recordedAccountFor(scope: { opts: { stripeAccount: string } | undefined }): string {
  return scope.opts ? scope.opts.stripeAccount : PLATFORM_ACCOUNT;
}

/**
 * The scope an existing object must be addressed with. The account recorded when
 * it was created wins over the firm's current setup: a firm can switch between
 * platform and direct charges after a link exists, and Stripe only finds an
 * object on the account it lives on. A row with nothing recorded predates the
 * column, so the firm's current setup is the best guess available.
 */
function scopeForRecordedAccount(
  recorded: string | null | undefined,
  fallback: { opts: { stripeAccount: string } | undefined },
): { opts: { stripeAccount: string } | undefined } {
  if (!recorded) return fallback;
  return { opts: recorded === PLATFORM_ACCOUNT ? undefined : { stripeAccount: recorded } };
}

/**
 * Trailing arguments for a Stripe call that names one of a firm's invoice
 * payment objects by id (retrieve, voidInvoice, expire): the firm's own
 * account for a direct-charge firm, nothing for a destination-charge one.
 * Exported for callers outside this module that hold a Stripe id but not the
 * firm's charge scope; without it a direct firm's object is "not found" on the
 * platform and the link it names stays payable. Pass the account recorded
 * beside the id when the row has one; it outranks the firm's current setup.
 */
export async function invoiceObjectArgsFor(lawFirmId: string, recordedAccountId?: string | null) {
  return idOnAccount(scopeForRecordedAccount(recordedAccountId, await invoiceChargeScopeFor(lawFirmId)));
}

/**
 * The client's Customer on the firm's own Stripe account, for a direct charge (a
 * platform Customer cannot pay a charge made on a connected account). Found by
 * email, which Stripe answers consistently, and matched on the client id stored in
 * its metadata; created when there is none. Nothing is cached locally.
 */
async function getOrCreateConnectedCustomer({ stripeAccount, clientId, clientEmail, clientName }: any) {
  if (!clientEmail) return null;
  const opts = { stripeAccount };
  const existing = await stripe.customers.list({ email: clientEmail, limit: 100 }, opts);
  const match = (existing?.data || []).find((c: any) => c?.metadata?.paralegixClientId === (clientId || ''));
  if (match) return match.id;
  const created = await stripe.customers.create({
    email: clientEmail,
    ...(clientName ? { name: clientName } : {}),
    metadata: { paralegixClientId: clientId || '' },
  }, opts);
  return created.id;
}

function roundCurrency(value: any) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * The day a Stripe timestamp (Unix seconds; now when absent) falls on in
 * `timeZone`, the firm's zone. A webhook has no person recording it, so its
 * rows are dated in the firm's day; the UTC day was tomorrow every evening in
 * the Americas.
 */
export function stripeDay(unixSeconds: any, timeZone: string) {
  const at = unixSeconds ? new Date(unixSeconds * 1000) : new Date();
  return zonedDayString(at, timeZone);
}

/**
 * Format a day-only due-date value ('YYYY-MM-DD', or a full ISO string/Date)
 * for the payment-request email. `timeZone: 'UTC'` is deliberate: the value
 * came from a `date`-only column with no timezone concept, so reading it back
 * without an explicit zone would use the SERVER PROCESS's ambient local zone
 * instead - on a server whose local offset is negative, that silently shows
 * the day BEFORE the one on the invoice. Every other day-only display in this
 * codebase (`emailService.ts`'s `digestLongDay`/`digestShortDay`, `taskReminders.service.ts`'s
 * due-date text, `certificatePage.ts`'s `formatTimestamp`) already pins this
 * explicitly; these two call sites did not.
 */
export function formatDueDateForEmail(value: any): string | null {
  if (!value) return null;
  const date = value?.toDate ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * BL9: normalize a paidDate value to a date-only ISO string ('YYYY-MM-DD') so
 * Stripe-recorded paidDates match the date-only convention used everywhere else
 * (manual payments store date-only). Accepts Date / ISO string / null.
 */
function paidDateOnly(value: any) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// A Stripe payment is recorded by nobody: `recorded_by` is a real foreign key
// to `users` (migration 0226), and the webhook is not a user. `payment_source`
// is what says it came from Stripe. The `recordedBy === 'Stripe'` reading below
// is kept only to recognise rows written before that key existed.
function isStripePaymentEntry(payment: any = {}) {
  if (!payment || typeof payment !== 'object') return false;
  if (payment.paymentSource === 'stripe') return true;
  if (payment.stripeSessionId || payment.stripeInvoiceId || payment.stripePaymentIntentId) return true;
  return String(payment.recordedBy || '').toLowerCase() === 'stripe';
}

function getStripePaymentIdentity(payment: any = {}) {
  return {
    stripeSessionId: payment.stripeSessionId || null,
    stripeInvoiceId: payment.stripeInvoiceId || null,
    stripePaymentIntentId: payment.stripePaymentIntentId || null,
  };
}

function stripeIdentityKey(identity: any = {}) {
  return [
    identity.stripeSessionId || '',
    identity.stripeInvoiceId || '',
    identity.stripePaymentIntentId || '',
  ].join('|');
}

function stripeIdentitiesMatch(payment: any, identity: any = {}) {
  const existing = getStripePaymentIdentity(payment);
  return (
    (identity.stripeSessionId && existing.stripeSessionId === identity.stripeSessionId)
    || (identity.stripeInvoiceId && existing.stripeInvoiceId === identity.stripeInvoiceId)
    || (identity.stripePaymentIntentId && existing.stripePaymentIntentId === identity.stripePaymentIntentId)
  );
}

function normalizeStripePayment(payment: any = {}) {
  if (!isStripePaymentEntry(payment)) return payment;
  return {
    ...payment,
    paymentSource: 'stripe',
    recordedBy: null,
    note: payment.note || 'Online payment via Stripe',
  };
}

function dedupeStripePayments(payments: any[] = []) {
  const seen = new Map();
  const normalized = [];

  for (const payment of payments) {
    const next = normalizeStripePayment(payment);
    if (!isStripePaymentEntry(next)) {
      normalized.push(next);
      continue;
    }

    const key = stripeIdentityKey(getStripePaymentIdentity(next));
    if (key === '||') {
      normalized.push(next);
      continue;
    }

    const existingIndex = seen.get(key);
    if (existingIndex === undefined) {
      seen.set(key, normalized.length);
      normalized.push(next);
      continue;
    }

    const existing: any = normalized[existingIndex];
    normalized[existingIndex] = {
      ...existing,
      ...next,
      paymentSource: 'stripe',
      recordedBy: null,
      note: existing.note || next.note || 'Online payment via Stripe',
    };
  }

  return normalized;
}

function computeStripeInvoiceStatus(invoice: any) {
  const amountPaid = roundCurrency(invoice.amountPaid || 0);
  const effectiveTotal = roundCurrency((invoice.totalAmount || 0) - (invoice.totalWrittenOff || 0));
  if (effectiveTotal > 0 && amountPaid >= effectiveTotal) return 'paid';
  if (amountPaid > 0) return 'partially_paid';
  return 'outstanding';
}

/** The plan as stored, with the next payment date read off its first open row. */
function normalizePaymentPlan(invoice: any) {
  const plan = invoice.paymentPlan;
  if (!plan || !Array.isArray(plan.expectedPayments)) {
    return {
      paymentPlan: plan || null,
      nextPaymentDate: invoice.nextPaymentDate || null,
    };
  }

  const nextPending = getNextPendingExpectedPayment(plan.expectedPayments);
  return {
    paymentPlan: plan,
    nextPaymentDate: nextPending ? toTimestampOrNull(nextPending.dueDate) : null,
  };
}

function buildStripePaymentEntry(candidate: any) {
  return {
    amount: roundCurrency(candidate.amountPaid),
    date: candidate.paymentDate,
    recordedBy: null,
    paymentSource: 'stripe',
    note: candidate.note || 'Online payment via Stripe',
    ...(candidate.stripeSessionId ? { stripeSessionId: candidate.stripeSessionId } : {}),
    ...(candidate.stripePaymentIntentId ? { stripePaymentIntentId: candidate.stripePaymentIntentId } : {}),
    ...(candidate.chargeModel === 'direct' ? { chargeModel: 'direct' } : {}),
    // The processing fee the client paid on top, kept out of `amount`.
    ...(candidate.surchargeCents > 0 ? { surchargeCents: candidate.surchargeCents } : {}),
  };
}

function applyStripeCandidate(invoice: any, candidate: any) {
  const currentPayments = dedupeStripePayments(invoice.payments || []);

  if (currentPayments.some((payment) => stripeIdentitiesMatch(payment, candidate))) {
    return {
      invoice: {
        ...invoice,
        payments: currentPayments,
      },
      applied: false,
      duplicate: true,
    };
  }

  const paymentEntry = buildStripePaymentEntry(candidate);
  const payments = [...currentPayments, paymentEntry];

  let paymentPlan = invoice.paymentPlan ? {
    ...invoice.paymentPlan,
    expectedPayments: Array.isArray(invoice.paymentPlan.expectedPayments)
      ? invoice.paymentPlan.expectedPayments.map((item: any) => ({ ...item }))
      : invoice.paymentPlan.expectedPayments,
  } : null;

  if (paymentPlan && Array.isArray(paymentPlan.expectedPayments) && candidate.installmentId) {
    const rows = paymentPlan.expectedPayments;
    const paymentIndex = payments.length - 1;
    // The link named its installment by the row's stable id, which survives the
    // delete-and-reinsert of a plan edit where a position would not.
    // Apply the money actually collected: a delayed payment can arrive after
    // the row changed, and a short payment must leave its remainder open.
    const target = rows.findIndex((row: any) => row?.id === candidate.installmentId && row.status !== 'paid');
    if (target >= 0) {
      paymentPlan.expectedPayments = allocatePaymentAcrossOpenRows(
        rows, target, toCents(candidate.amountPaid), paymentIndex,
      ).rows;
    } else {
      // The installment was paid another way, or left the plan, after the link
      // went out. The money is real: it settles the open installments from the
      // earliest one.
      paymentPlan.expectedPayments = allocatePaymentAcrossOpenRows(
        rows, Math.max(0, earliestOpenIndex(rows)), toCents(candidate.amountPaid), paymentIndex,
      ).rows;
    }
  }

  // Integer cents, like the rest of the billing layer. Summing dollars as floats
  // and comparing the result against the total decides `isPaid`, which is the
  // difference between an invoice that settles and one that stays open.
  const amountPaidCents = stripePaymentsTotalCents(payments);
  const effectiveTotalCents = toCents(invoice.totalAmount || 0) - toCents(invoice.totalWrittenOff || 0);
  const amountPaid = fromCents(amountPaidCents);
  const isPaid = effectiveTotalCents > 0 && amountPaidCents >= effectiveTotalCents;

  const nextInvoice = {
    ...invoice,
    payments,
    amountPaid,
    isPaid,
    status: isPaid ? 'paid' : amountPaid > 0 ? 'partially_paid' : 'outstanding',
    // BL9: store paidDate as a date-only ISO string to match manual payments.
    paidDate: isPaid
      ? (paidDateOnly(invoice.paidDate) || paidDateOnly(candidate.paymentDate) || paidDateOnly(new Date()))
      : null,
    stripePaymentIntentId: candidate.stripePaymentIntentId || invoice.stripePaymentIntentId || null,
    stripeCheckoutSessionId: candidate.clearCheckoutSession ? null : (invoice.stripeCheckoutSessionId || null),
    ...(candidate.clearCheckoutSession ? { stripeCheckoutSessionAccountId: null } : {}),
    // A card-form payment that waited on the client's bank releases the
    // invoice it was holding, but only if it is still the one holding it.
    ...(candidate.clearCardPaymentIntent && invoice.stripeCardPaymentIntentId === candidate.stripePaymentIntentId
      ? { stripeCardPaymentIntentId: null, stripeCardPaymentIntentAccountId: null }
      : {}),
    paymentPlan,
  };

  // A recorded link payment ends the request, so the link stops working and
  // the firm can send the next one (for a plan, the next installment's).
  if (candidate.endsRequest) {
    nextInvoice.stripePaymentStatus = 'completed';
    nextInvoice.stripePaymentRequested = false;
    nextInvoice.payLinkToken = null;
    nextInvoice.payLinkInstallmentId = null;
  }

  const normalizedPlan = normalizePaymentPlan(nextInvoice);
  nextInvoice.paymentPlan = normalizedPlan.paymentPlan;
  nextInvoice.nextPaymentDate = normalizedPlan.nextPaymentDate;

  return { invoice: nextInvoice, applied: true, duplicate: false };
}

/** What a payment list adds up to, in integer cents. */
function stripePaymentsTotalCents(payments: any[] = []) {
  return payments.reduce((sum: number, payment: any) => sum + toCents(payment?.amount || 0), 0);
}

function normalizeStripeInvoiceLocally(invoice: any) {
  const payments = dedupeStripePayments(invoice.payments || []);
  const amountPaidCents = stripePaymentsTotalCents(payments);
  const effectiveTotalCents = toCents(invoice.totalAmount || 0) - toCents(invoice.totalWrittenOff || 0);
  const amountPaid = fromCents(amountPaidCents);
  const isPaid = effectiveTotalCents > 0 && amountPaidCents >= effectiveTotalCents;
  const normalizedPlan = normalizePaymentPlan(invoice);

  return {
    ...invoice,
    payments,
    amountPaid,
    isPaid,
    status: isPaid ? 'paid' : amountPaid > 0 ? 'partially_paid' : 'outstanding',
    // BL9: date-only paidDate.
    paidDate: isPaid
      ? (
        paidDateOnly(invoice.paidDate)
        || paidDateOnly(payments[payments.length - 1]?.date || null)
        || paidDateOnly(new Date())
      )
      : null,
    paymentPlan: normalizedPlan.paymentPlan,
    nextPaymentDate: normalizedPlan.nextPaymentDate,
  };
}

function buildInvoiceUpdateData(invoice: any) {
  return {
    amountPaid: roundCurrency(invoice.amountPaid || 0),
    payments: invoice.payments || [],
    isPaid: invoice.isPaid === true,
    status: invoice.status || computeStripeInvoiceStatus(invoice),
    paidDate: invoice.paidDate || null,
    stripePaymentStatus: invoice.stripePaymentStatus || null,
    stripePaymentIntentId: invoice.stripePaymentIntentId || null,
    stripeCheckoutSessionId: invoice.stripeCheckoutSessionId || null,
    stripeCardPaymentIntentId: invoice.stripeCardPaymentIntentId || null,
    stripeCardPaymentIntentAccountId: invoice.stripeCardPaymentIntentAccountId || null,
    stripePaymentRequested: invoice.stripePaymentRequested === true,
    payLinkToken: invoice.payLinkToken || null,
    payLinkInstallmentId: invoice.payLinkInstallmentId || null,
    paymentPlan: invoice.paymentPlan || null,
    nextPaymentDate: invoice.nextPaymentDate || null,
    updatedAt: new Date(),
  };
}

function extractComparableStripeState(invoice: any) {
  return JSON.stringify({
    amountPaid: roundCurrency(invoice.amountPaid || 0),
    payments: invoice.payments || [],
    isPaid: invoice.isPaid === true,
    status: invoice.status || null,
    paidDate: invoice.paidDate || null,
    stripePaymentStatus: invoice.stripePaymentStatus || null,
    stripePaymentIntentId: invoice.stripePaymentIntentId || null,
    stripeCheckoutSessionId: invoice.stripeCheckoutSessionId || null,
    stripeCardPaymentIntentId: invoice.stripeCardPaymentIntentId || null,
    stripePaymentRequested: invoice.stripePaymentRequested === true,
    payLinkToken: invoice.payLinkToken || null,
    payLinkInstallmentId: invoice.payLinkInstallmentId || null,
    paymentPlan: invoice.paymentPlan || null,
    nextPaymentDate: invoice.nextPaymentDate || null,
  });
}

function invoiceHasStripeState(invoice: any = {}) {
  return Boolean(
    invoice.stripePaymentRequested
    || invoice.stripeCheckoutSessionId
    || (invoice.payments || []).some(isStripePaymentEntry)
  );
}

/**
 * Whether a checkout session is an invoice payment this module created. A
 * subscription or setup checkout, or a firm's own checkout on its account, also
 * reaches the payments webhook; none carries the invoice metadata, and failing
 * on one would only make Stripe retry it for three days. A session with no
 * `mode` is treated as a payment, the only mode the invoice checkout uses.
 */
function isInvoiceCheckoutSession(session: any) {
  if (session?.mode && session.mode !== 'payment') return false;
  const md = session?.metadata || {};
  return Boolean(md.lawFirmId && md.invoiceId && md.contextType && md.entityId);
}

/** Log a checkout session that reached an invoice handler but is not an invoice payment. */
function logNonInvoiceCheckout(session: any, handlerName: string) {
  console.info(`stripe.service: ${handlerName} acknowledged a checkout session that is not an invoice payment`, {
    checkoutSessionId: session?.id || null,
    mode: session?.mode || null,
    lawFirmId: session?.metadata?.lawFirmId || null,
  });
}

/**
 * Why a checkout event must not be acted on, or null when it may be. A
 * signature proves Stripe sent the event, not that the firm its metadata names
 * collected the money:
 *
 * - A Connect event (`connectedAccountId` set) is about that account's own
 *   objects, and anyone with a Standard account writes its own metadata. It is
 *   honoured only for a direct charge whose named firm owns that account.
 * - A platform event never describes a direct charge, which lives on the
 *   firm's account, so one that claims to be is refused.
 */
export async function checkoutEventScopeRefusal(session: any, connectedAccountId: string | null): Promise<string | null> {
  const md = session?.metadata || {};
  const direct = md.chargeModel === 'direct';
  if (!connectedAccountId) {
    return direct ? 'a platform event cannot describe a direct-charge checkout' : null;
  }
  if (!direct) return 'a connected-account checkout that is not a direct charge';
  if (!isUuid(md.lawFirmId)) return 'a connected-account checkout that names no firm';
  const firm = await lawfirmsRepo.findById(md.lawFirmId);
  if (!firm || firm.stripeAccountId !== connectedAccountId) {
    return 'the connected account does not belong to the firm the checkout names';
  }
  return null;
}

/**
 * Why a Connect refund or dispute event must not touch the invoice payment it
 * names, or null when it may. Only a direct charge lives on a connected account.
 *
 * The firm's CURRENT account is deliberately not compared. A refund or dispute
 * event describes a charge on the account that sent it, and payment intent ids
 * are unique across Stripe, so a matched payment was necessarily charged on
 * that account. A firm that disconnects and reconnects gets a new account, and
 * refunds on charges made under the old one must still reverse.
 */
async function invoicePaymentAccountRefusal(match: any): Promise<string | null> {
  if (match.chargeModel !== 'direct') return 'a connected-account event for a payment that is not a direct charge';
  return null;
}

function logRefusedInvoicePaymentEvent(match: any, paymentIntentId: string, connectedAccountId: string, reason: string) {
  console.warn('stripe.service: connected-account event ignored for an invoice payment', {
    reason,
    connectedAccountId,
    paymentIntentId,
    lawFirmId: match.lawFirmId,
    invoiceId: match.invoiceId,
    chargeModel: match.chargeModel,
  });
}

function buildStripeCandidateFromCheckoutSession(session: any, timeZone = 'UTC') {
  const metadata = session.metadata || {};
  if (!metadata.lawFirmId || !metadata.invoiceId || !metadata.contextType || !metadata.entityId) {
    const err: any = new Error('Stripe checkout.session.completed missing required metadata');
    err.code = 'STRIPE_METADATA_MISSING';
    throw err;
  }

  // A processing fee the client paid rides on the same charge. Only the rest
  // is invoice money; the fee is reported apart. Clamped to the charge so a
  // malformed value can never credit more than was paid.
  const totalCents = Math.max(0, Math.round(session.amount_total || 0));
  const surchargeCents = Math.min(Math.max(0, parseInt(metadata.surchargeCents, 10) || 0), totalCents);

  return {
    chargeModel: metadata.chargeModel === 'direct' ? 'direct' : 'destination',
    lawFirmId: metadata.lawFirmId,
    invoiceId: metadata.invoiceId,
    contextType: metadata.contextType,
    entityId: metadata.entityId,
    // Two distinct id spaces kept distinct on the way back in, exactly as they
    // were written out: clientRecordId is the legal client (clients.id),
    // clientUserId is the Firebase uid of whoever paid. Older sessions created
    // before clientId was written carry no clientRecordId, hence the null.
    clientRecordId: metadata.clientId || null,
    clientUserId: metadata.clientUserId || null,
    // The plan row an installment link asked for, by its stable id.
    installmentId: typeof metadata.installmentId === 'string' && metadata.installmentId ? metadata.installmentId : null,
    surchargeCents,
    // Names the fee on the receipt. Only rides in the event payload.
    paymentMethod: metadata.paymentMethod === 'bank' ? 'bank' : 'card',
    amountPaid: (totalCents - surchargeCents) / 100,
    paymentDate: stripeDay(session.created, timeZone),
    stripeSessionId: session.id,
    stripePaymentIntentId: session.payment_intent || null,
    endsRequest: true,
    clearCheckoutSession: true,
    note: 'Online payment via Stripe',
  };
}

/**
 * Read-compute-write a Stripe payment onto an invoice: a read
 * (invoicesRepo.findById) followed by an explicit computed write
 * (invoicesRepo.update). The write payload is fully computed in JS (no
 * in-database increment), so re-applying a duplicate is idempotent.
 */
/** The two webhook endpoints, each with its own idempotency ledger in `stripe_events`. */
export type StripeWebhookEndpoint = 'payments' | 'subscriptions';

/**
 * The outcome of claiming a webhook event.
 *   claimed:   this delivery owns the event and must run its handler, then call
 *              finishStripeEvent on success or releaseStripeEvent on failure with
 *              `claimToken`.
 *   duplicate: an earlier delivery finished it. Acknowledge with a 200.
 *   in_flight: another delivery holds it right now. Answer non-2xx so Stripe
 *              retries later; the holder may still fail and release it.
 */
export type StripeEventClaim =
  | { status: 'claimed'; claimToken: string | null }
  | { status: 'duplicate' | 'in_flight'; claimToken: null };

const DEFAULT_STRIPE_EVENT_CLAIM_STALE_SECONDS = 600;

// How long a 'processing' claim is honoured before another delivery may take it
// over. A holder that is still alive after this long is treated as dead: a
// deploy SIGTERM or an OOM kill leaves the row behind with nothing to release
// it, and without a timeout that event would be refused forever. Ten minutes is
// far beyond any handler's runtime and far inside Stripe's three-day retry window.
function stripeEventClaimStaleSeconds() {
  const configured = Number(process.env.STRIPE_EVENT_CLAIM_STALE_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STRIPE_EVENT_CLAIM_STALE_SECONDS;
}

/**
 * Claim a Stripe event for one endpoint before running its handler.
 *
 * One statement, so the decision is atomic: insert a 'processing' row, or take
 * over an existing 'processing' row whose claim is older than the stale
 * threshold. When neither happens the existing row says why. A conflicting row
 * the statement cannot see in its snapshot was inserted by a delivery running
 * concurrently with this one, so that case is in flight too.
 *
 * The claim token is the row's `claimed_at`, rendered as text so it round-trips
 * at full microsecond precision. finish and release match on it, so a holder
 * whose claim was taken over after it went stale cannot mark done or delete the
 * claim that replaced it.
 */
export async function claimStripeEvent(eventId: string, endpoint: StripeWebhookEndpoint): Promise<StripeEventClaim> {
  // No id to dedupe on: process it (the signature is already verified).
  if (!eventId) return { status: 'claimed', claimToken: null };
  const { rows } = await stripeSql(
    `with claim as (
       insert into stripe_events as e (endpoint, event_id, status, claimed_at)
       values ($1, $2, 'processing', now())
       on conflict (endpoint, event_id) do update
         set claimed_at = now()
         where e.status = 'processing'
           and e.claimed_at < now() - make_interval(secs => $3)
       returning e.claimed_at::text as claim_token
     )
     select claim.claim_token, null::text as existing_status from claim
     union all
     select null::text, e.status from stripe_events e
      where e.endpoint = $1 and e.event_id = $2
        and not exists (select 1 from claim)`,
    [endpoint, eventId, stripeEventClaimStaleSeconds()],
  );
  const row = rows[0];
  if (row?.claim_token) return { status: 'claimed', claimToken: row.claim_token };
  if (row?.existing_status === 'done') return { status: 'duplicate', claimToken: null };
  return { status: 'in_flight', claimToken: null };
}

/**
 * Record that a claimed event's handler succeeded, so later deliveries of it
 * are acknowledged as duplicates.
 *
 * Never throws. The handler's work is already committed, so the webhook still
 * answers 200; a 500 would only make Stripe re-run it. If this write is lost
 * the row stays 'processing': a redelivery inside the stale threshold gets a
 * 409, and one after it re-runs the handler, which is the same exposure as a
 * process dying after the handler. Logged loudly because both are worth seeing.
 */
export async function finishStripeEvent(eventId: string, endpoint: StripeWebhookEndpoint, claimToken: string | null) {
  if (!eventId || !claimToken) return;
  try {
    const { rowCount } = await stripeSql(
      `update stripe_events set status = 'done', processed_at = now()
        where endpoint = $1 and event_id = $2 and status = 'processing'
          and claimed_at = $3::timestamptz`,
      [endpoint, eventId, claimToken],
    );
    if (!rowCount) {
      console.warn('Stripe webhook claim was taken over before it finished; another delivery now owns it', {
        eventId, endpoint,
      });
    }
  } catch (err: any) {
    console.error('Stripe webhook could not mark a processed event done; it stays claimed until the stale threshold', {
      eventId, endpoint, error: err?.message,
    });
  }
}

/**
 * Give back a claim whose handler failed, so Stripe's next retry processes the
 * event at once instead of waiting out the stale threshold.
 *
 * Never throws, because the caller is already answering 500. A release that
 * fails is not a lost event: the row stays 'processing' and a retry after the
 * stale threshold reclaims it. It is logged as an error because until then
 * every retry is refused with a 409.
 */
export async function releaseStripeEvent(eventId: string, endpoint: StripeWebhookEndpoint, claimToken: string | null) {
  if (!eventId || !claimToken) return;
  try {
    await stripeSql(
      `delete from stripe_events
        where endpoint = $1 and event_id = $2 and status = 'processing'
          and claimed_at = $3::timestamptz`,
      [endpoint, eventId, claimToken],
    );
  } catch (err: any) {
    console.error('Stripe webhook claim release FAILED; retries are refused until the claim goes stale', {
      eventId, endpoint, error: err?.message,
    });
  }
}

export async function applyStripeCandidateTransaction(candidate: any) {
  const context = {
    type: candidate.contextType,
    lawFirmId: candidate.lawFirmId,
    entityId: candidate.entityId,
  };

  // BL2: read→compute→write under a SELECT … FOR UPDATE row lock so concurrent
  // Stripe events (retries, or a completed session racing its async settlement) can't read the
  // same pre-state and double-apply a payment. The write payload is fully
  // computed in JS (no in-db increment), so re-applying a duplicate is a no-op.
  // Set inside the transaction callback; the guard below proves it is non-null
  // by the time it is returned, which inference cannot see through the closure.
  let outcome: any = null;
  const result = await invoicesRepo.runInvoiceTxn(context, candidate.invoiceId, (existing: any) => {
    const invoice = { id: candidate.invoiceId, ...existing };
    const next = applyStripeCandidate(invoice, candidate);
    const normalized = normalizeStripeInvoiceLocally(next.invoice);
    const changed = extractComparableStripeState(invoice) !== extractComparableStripeState(normalized);

    outcome = {
      applied: next.applied,
      duplicate: !next.applied,
      context,
    };

    // Persist when there's an actual payment OR a normalization delta; otherwise
    // commit without writing (return null is a no-op under the lock).
    if (!next.applied && !changed) return null;
    const update = buildInvoiceUpdateData(normalized);
    // A voided invoice stays voided. The firm cancelled the bill, so a payment
    // that still arrives (a link opened before the void, a delayed method
    // settling) is recorded, because money moved and a refund finds the payment
    // by its intent id, but it does not turn the bill back into one that is owed.
    if (existing.status === 'voided') {
      update.status = 'voided';
      outcome.landedOnVoided = next.applied;
    }
    return update;
  });

  // runInvoiceTxn returns null ONLY when the row didn't exist (compute never
  // ran, so `outcome` is still null). A committed no-op returns the current
  // invoice object and `outcome` is populated.
  if (result === null && outcome === null) {
    const err: any = new Error(`Invoice ${candidate.invoiceId} not found for Stripe processing`);
    err.code = 'STRIPE_INVOICE_NOT_FOUND';
    throw err;
  }

  // The invoice as the transaction left it, so the callers announce the payment
  // from data already in hand instead of reading it back after the commit.
  outcome.invoice = result;

  if (outcome.landedOnVoided) {
    console.error('stripe.service: Stripe payment collected against a voided invoice; refund it in Stripe', {
      lawFirmId: candidate.lawFirmId,
      invoiceId: candidate.invoiceId,
      paymentIntentId: candidate.stripePaymentIntentId,
      amountPaid: candidate.amountPaid,
    });
  }

  return outcome;
}

/**
 * Resolve a billing email/name for a context when the invoice itself lacks a
 * billingEmail/clientId. Mirrors the legacy Firestore fallback: for a matter, try
 * the specific matterClient (by id) then the first matter client with an email; for
 * a client context, read the client row. matterClient ids are the client uuids in
 * the relational model.
 */
async function resolveContextBillingContact(lawFirmId: string, contextType: any, entityId: any, matterClientId: any) {
  let email: any = null;
  let name: any = null;

  if (contextType === 'matter') {
    const matterClients = await billingReads.listMatterClients(lawFirmId, entityId).catch(() => []);
    const specific = matterClientId ? matterClients.find((c: any) => c.id === matterClientId) : null;
    if (specific?.email) {
      email = specific.email;
      name = specific.name || null;
    }
    if (!email) {
      const withEmail = matterClients.find((c: any) => c.email);
      if (withEmail) {
        email = withEmail.email || null;
        name = name || withEmail.name || null;
      }
    }
  } else if (contextType === 'client') {
    const client = await clientsRepo.findByIdRaw(lawFirmId, entityId).catch(() => null);
    if (client) {
      email = client.email || null;
      name = name || client.name || null;
    }
  }

  return { email, name };
}

/**
 * The Stripe customer identity for one legal client record.
 *
 * The customer is the CLIENT, never a person who happens to be logged in on its
 * behalf. For a company that means the company's own name and its billing
 * recipient's address, not the roster contact who clicked pay. `clients.user_id`
 * is null for a company by database constraint, so `clientUserId` here is only
 * ever a person client's own portal uid and can never be a roster contact's.
 *
 * `fallbackEmail`/`fallbackName` are used only when the client record cannot be
 * read at all (a deleted client on a historical invoice).
 *
 * `preferredEmail` short-circuits the company roster read for a caller that has
 * already resolved the billing address it wants on the customer (an invoice
 * path, which uses that invoice's own primary billing recipient).
 */
async function resolveClientStripeIdentity({
  lawFirmId, clientId, fallbackEmail = null, fallbackName = null, preferredEmail = null,
}: any) {
  const empty = {
    clientId: null,
    clientUserId: null,
    clientType: null,
    customerEmail: fallbackEmail,
    customerName: fallbackName,
  };
  if (!clientId) return empty;

  const client = await clientsRepo.findById(lawFirmId, clientId).catch(() => null);
  if (!client) return empty;

  const clientType = client.clientType === 'company' ? 'company' : 'person';
  let customerEmail = preferredEmail || client.email || null;
  if (clientType === 'company' && !preferredEmail) {
    // A company's own `email` column is often blank: its addresses live on the
    // contact roster. Use the primary billing recipient for the customer's
    // single email field.
    const recipients = await resolveCurrentBillingRecipients({ lawFirmId, clientId: client.id, client });
    customerEmail = recipients.primaryEmail || customerEmail;
  }

  return {
    clientId: client.id,
    clientUserId: client.userId || null,
    clientType,
    customerEmail: customerEmail || fallbackEmail,
    customerName: client.name || fallbackName,
  };
}

/**
 * Everything a Stripe payment path needs to know about who is being billed for
 * one invoice: the full recipient list to email, and the single customer
 * identity Stripe stores.
 *
 * `freeze` marks this call as the invoice's first external issue (creating a
 * hosted payment link is exactly that), so the bill-to record is snapshotted
 * here and never re-derived afterwards. Pass false for a read that must not
 * change history.
 *
 * The context fallback (any matter client with an email) is preserved from the
 * pre-snapshot code, but it now only runs when the invoice's own client record
 * yields nothing - and when it does supply an address, that address is frozen
 * with the rest, because it is genuinely who the invoice went to.
 */
async function resolveInvoiceStripeBilling({ lawFirmId, contextType, entityId, invoice, action, freeze = true }: any) {
  const clientRecordId = invoiceClientRecordId(invoice);

  let recipients = freeze
    ? await snapshotInvoiceRecipients({ lawFirmId, invoice, invoiceId: invoice.id, action, requireRecipients: false })
    : await resolveInvoiceRecipients({ lawFirmId, invoice });

  let contextName = null;
  if (recipients.emails.length === 0) {
    const fallback = await resolveContextBillingContact(lawFirmId, contextType, entityId, invoice.matterClientId);
    if (fallback.email) {
      contextName = fallback.name || null;
      recipients = freeze
        ? await snapshotInvoiceRecipients({
          lawFirmId, invoice, invoiceId: invoice.id, action, extraEmails: [fallback.email], requireRecipients: false,
        })
        : {
          ...recipients,
          emails: normalizeEmailList([fallback.email]),
          primaryEmail: fallback.email,
        };
    }
  }

  const identity = await resolveClientStripeIdentity({
    lawFirmId,
    clientId: clientRecordId,
    // The invoice's own primary billing address is the right one for this
    // customer, so the roster does not need resolving a second time.
    preferredEmail: recipients.primaryEmail,
    fallbackEmail: recipients.primaryEmail,
    fallbackName: recipients.clientName || invoice.clientName || contextName,
  });

  return {
    // Always a clients.id uuid. Kept separate from clientUserId throughout.
    clientRecordId: identity.clientId || clientRecordId || null,
    clientUserId: identity.clientUserId,
    clientType: identity.clientType,
    // Stripe's customer carries ONE email; the invoice's primary billing address
    // is the right one. The full list below is what Paralegix's own mail uses.
    customerEmail: recipients.primaryEmail || identity.customerEmail || null,
    customerName: identity.customerName || recipients.clientName || invoice.clientName || contextName || null,
    recipients,
  };
}

/* ------------------------------------------------------------------ */
/*  Stripe Connect: Account management                               */
/* ------------------------------------------------------------------ */

/**
 * Create a Stripe connected account for a law firm and return an Account Link URL
 * for onboarding. New accounts are Standard (full Stripe Dashboard): the firm pays
 * Stripe's fees and Stripe, not Paralegix, carries negative-balance liability. Stripe
 * refuses that combination on an Express account, where the platform must pay fees
 * and carry losses whatever the charge type. A firm already on an Express account
 * keeps it (and destination charges) until it disconnects and reconnects.
 */
export async function createConnectAccount(lawFirmId: string, actingUserId: string) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');

  // Check if already has a Stripe account
  if (firmData.stripeAccountId) {
    // Account already exists, just create a new onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: firmData.stripeAccountId,
      refresh_url: `${FRONTEND_URL}/lawfirm/${lawFirmId}/settings/payments?stripe=refresh`,
      return_url: `${FRONTEND_URL}/lawfirm/${lawFirmId}/settings/payments?stripe=return`,
      type: 'account_onboarding',
    });

    return { url: accountLink.url, accountId: firmData.stripeAccountId };
  }

  const account = await stripe.accounts.create({
    controller: {
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
      stripe_dashboard: { type: 'full' },
      requirement_collection: 'stripe',
    },
    metadata: { lawFirmId },
    business_type: 'company',
    company: {
      name: firmData.name || undefined,
    },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });

  // Store the account and switch the firm to direct charges. No payout hardening:
  // a Standard account's payout settings belong to the firm, and a refund or
  // dispute on a direct charge debits the firm's balance, not Paralegix's.
  await lawfirmsRepo.update(lawFirmId, {
    stripeAccountId: account.id,
    stripeOnboardingComplete: false,
    stripeChargesEnabled: false,
    directChargesEnabled: true,
  });

  // Create an Account Link for onboarding
  const accountLink = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: `${FRONTEND_URL}/lawfirm/${lawFirmId}/settings/payments?stripe=refresh`,
    return_url: `${FRONTEND_URL}/lawfirm/${lawFirmId}/settings/payments?stripe=return`,
    type: 'account_onboarding',
  });

  return { url: accountLink.url, accountId: account.id };
}

/**
 * Get the current Stripe Connect status for a law firm.
 */
export async function getConnectStatus(lawFirmId: string, actingUserId: string) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');

  if (!firmData.stripeAccountId) {
    return {
      connected: false,
      directCharges: false,
      stripeAccountId: null,
      chargesEnabled: false,
      payoutsEnabled: false,
      onboardingComplete: false,
    };
  }

  if (!stripe) {
    return {
      connected: true,
      directCharges: invoiceChargeScope(firmData).direct,
      stripeAccountId: firmData.stripeAccountId,
      chargesEnabled: firmData.stripeChargesEnabled || false,
      payoutsEnabled: false,
      onboardingComplete: firmData.stripeOnboardingComplete || false,
    };
  }

  // Fetch latest status from Stripe
  try {
    const account = await stripe.accounts.retrieve(firmData.stripeAccountId);

    // Update local cache of status
    const statusUpdate = {
      stripeChargesEnabled: account.charges_enabled || false,
      stripeOnboardingComplete: account.details_submitted || false,
    };

    // Only update if changed
    if (
      firmData.stripeChargesEnabled !== statusUpdate.stripeChargesEnabled ||
      firmData.stripeOnboardingComplete !== statusUpdate.stripeOnboardingComplete
    ) {
      await lawfirmsRepo.update(lawFirmId, statusUpdate);
    }

    return {
      connected: true,
      directCharges: invoiceChargeScope(firmData).direct,
      stripeAccountId: account.id,
      chargesEnabled: account.charges_enabled || false,
      payoutsEnabled: account.payouts_enabled || false,
      onboardingComplete: account.details_submitted || false,
    };
  } catch (err: any) {
    console.error('stripe.service: failed to retrieve Stripe account:', err.message);
    return {
      connected: true,
      directCharges: invoiceChargeScope(firmData).direct,
      stripeAccountId: firmData.stripeAccountId,
      chargesEnabled: firmData.stripeChargesEnabled || false,
      payoutsEnabled: false,
      onboardingComplete: firmData.stripeOnboardingComplete || false,
    };
  }
}

/**
 * Get a login link for the law firm's Stripe Express dashboard.
 */
export async function getDashboardLink(lawFirmId: string, actingUserId: string) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');
  if (!firmData.stripeAccountId) {
    throw new ValidationError({ stripe: ['No Stripe account connected'] });
  }

  // A Standard account signs in to the full Stripe Dashboard itself; login links
  // exist only for Express accounts.
  if (invoiceChargeScope(firmData).direct) return { url: 'https://dashboard.stripe.com/' };

  const loginLink = await stripe.accounts.createLoginLink(firmData.stripeAccountId);
  return { url: loginLink.url };
}

/**
 * Disconnect the Stripe Connect account from a law firm (local only, does not delete the Stripe account).
 */
export async function disconnectAccount(lawFirmId: string, actingUserId: string) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');
  if (!firmData.stripeAccountId) {
    throw new ValidationError({ stripe: ['No Stripe account connected'] });
  }

  await lawfirmsRepo.update(lawFirmId, {
    stripeAccountId: null,
    stripeChargesEnabled: false,
    stripeOnboardingComplete: false,
    directChargesEnabled: false,
  });

  return { disconnected: true };
}

/* ------------------------------------------------------------------ */
/*  Stripe Connect: trust-account (IOLTA bank) accounts               */
/* ------------------------------------------------------------------ */
//
// A trust account settles electronic (ACH) deposits into its OWN connected
// account, whose payout bank is the trust/IOLTA bank account — kept entirely
// separate from the firm's operating connected account (law_firms.stripe_account_id)
// so client funds never commingle with operating revenue.

/**
 * Onboard (or resume onboarding of) the Stripe connected account for a trust
 * account. Returns an Account Link URL for the firm to complete Stripe onboarding.
 */
export async function createTrustConnectAccount(lawFirmId: string, trustAccountId: string, actingUserId: string) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const account = await trustAccountRepo.findByIdOrFail(lawFirmId, trustAccountId, 'TrustAccount');

  const returnUrls = {
    refresh_url: `${FRONTEND_URL}/lawfirm/${lawFirmId}/trust?stripe=refresh`,
    return_url: `${FRONTEND_URL}/lawfirm/${lawFirmId}/trust?stripe=return`,
    type: 'account_onboarding',
  };

  if (account.stripeConnectedAccountId) {
    const accountLink = await stripe.accountLinks.create({
      account: account.stripeConnectedAccountId,
      ...returnUrls,
    });
    return { url: accountLink.url, accountId: account.stripeConnectedAccountId };
  }

  // Request `card_payments` + `transfers` (Stripe requires transfers to be paired
  // with a payment capability unless the platform has special approval). We still
  // only ever charge this account via ACH — requestTrustDeposit forces
  // `us_bank_account` — so no card is ever charged to a trust account; the
  // card_payments capability is simply present and unused.
  const connected = await stripe.accounts.create({
    type: 'express',
    metadata: { lawFirmId, trustAccountId, purpose: 'trust' },
    business_type: 'company',
    company: { name: account.name || undefined },
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
  });

  await trustAccountRepo.update(lawFirmId, trustAccountId, {
    stripeConnectedAccountId: connected.id,
    stripeChargesEnabled: false,
    stripeOnboardingComplete: false,
    updatedBy: actingUserId,
  });

  // Delay payouts so a returned/disputed ACH deposit can be reversed from the
  // account's Stripe balance during the return window. Crucially, do NOT enable
  // debit_negative_balances here: this account's bank is an IOLTA holding client
  // money and must never be auto-debited. Any shortfall that outlives the payout
  // delay is recovered from the firm's operating card instead (never trust).
  await applyConnectPayoutHardening(connected.id, { trust: true });

  const accountLink = await stripe.accountLinks.create({
    account: connected.id,
    ...returnUrls,
  });
  return { url: accountLink.url, accountId: connected.id };
}

/**
 * Current Stripe onboarding/charges status for a trust account's connected account.
 * Refreshes the cached status columns from Stripe when it differs.
 */
export async function getTrustConnectStatus(lawFirmId: string, trustAccountId: string, actingUserId: string) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const account = await trustAccountRepo.findByIdOrFail(lawFirmId, trustAccountId, 'TrustAccount');

  if (!account.stripeConnectedAccountId) {
    return { connected: false, chargesEnabled: false, payoutsEnabled: false, onboardingComplete: false };
  }
  if (!stripe) {
    return {
      connected: true,
      chargesEnabled: !!account.stripeChargesEnabled,
      payoutsEnabled: false,
      onboardingComplete: !!account.stripeOnboardingComplete,
    };
  }

  try {
    const connected = await stripe.accounts.retrieve(account.stripeConnectedAccountId);
    const chargesEnabled = connected.charges_enabled || false;
    const onboardingComplete = connected.details_submitted || false;
    if (account.stripeChargesEnabled !== chargesEnabled
        || account.stripeOnboardingComplete !== onboardingComplete) {
      await trustAccountRepo.update(lawFirmId, trustAccountId, {
        stripeChargesEnabled: chargesEnabled,
        stripeOnboardingComplete: onboardingComplete,
      });
    }
    return {
      connected: true,
      chargesEnabled,
      payoutsEnabled: connected.payouts_enabled || false,
      onboardingComplete,
    };
  } catch (err: any) {
    console.error('stripe.service: failed to retrieve trust connected account:', err.message);
    return {
      connected: true,
      chargesEnabled: !!account.stripeChargesEnabled,
      payoutsEnabled: false,
      onboardingComplete: !!account.stripeOnboardingComplete,
    };
  }
}

/** Login link to the trust account's Stripe Express dashboard. */
export async function getTrustConnectDashboardLink(lawFirmId: string, trustAccountId: string, actingUserId: string) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const account = await trustAccountRepo.findByIdOrFail(lawFirmId, trustAccountId, 'TrustAccount');
  if (!account.stripeConnectedAccountId) {
    throw new ValidationError({ stripe: ['No trust bank account connected'] });
  }
  const loginLink = await stripe.accounts.createLoginLink(account.stripeConnectedAccountId);
  return { url: loginLink.url };
}

/**
 * Disconnect a trust account's connected account (local only; does not delete the
 * Stripe account). Blocked while the connected account still holds funds, so an
 * available/pending trust balance can't be stranded off-ledger.
 */
export async function disconnectTrustConnectAccount(lawFirmId: string, trustAccountId: string, actingUserId: string) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const account = await trustAccountRepo.findByIdOrFail(lawFirmId, trustAccountId, 'TrustAccount');
  if (!account.stripeConnectedAccountId) {
    throw new ValidationError({ stripe: ['No trust bank account connected'] });
  }

  if (stripe) {
    try {
      const balance = await stripe.balance.retrieve({ stripeAccount: account.stripeConnectedAccountId });
      const sumCents = (entries: any) => (entries || []).reduce((s: any, e: any) => s + Math.abs(e.amount || 0), 0);
      const outstanding = sumCents(balance.available) + sumCents(balance.pending);
      if (outstanding > 0) {
        throw new AppError(
          'Cannot disconnect: the trust bank account still holds funds in Stripe. Wait for payouts to settle first.',
          400, 'STRIPE_TRUST_HAS_BALANCE',
        );
      }
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      // Fail closed: an unreadable balance may be client trust money still held in
      // Stripe, and disconnecting would strand it. The firm can retry shortly.
      console.warn('stripe.service: could not verify trust connected-account balance before disconnect:', err.message);
      throw new AppError(
        'Could not confirm the trust bank account is empty in Stripe. Try disconnecting again in a few minutes.',
        503, 'STRIPE_TRUST_BALANCE_UNKNOWN',
      );
    }
  }

  await trustAccountRepo.update(lawFirmId, trustAccountId, {
    stripeConnectedAccountId: null,
    stripeChargesEnabled: false,
    stripeOnboardingComplete: false,
    updatedBy: actingUserId,
  });
  return { disconnected: true };
}

/* ------------------------------------------------------------------ */
/*  Stripe Customer management                                        */
/* ------------------------------------------------------------------ */

/**
 * Get or create a Stripe Customer for a client at a specific law firm.
 *
 * Accepts two independent, explicitly-named identifiers rather than one
 * overloaded id: `clientId` (a `clients.id` uuid) and `clientUserId` (a
 * Firebase uid, present only when the client has a linked portal account).
 * Either, both, or neither may be supplied. `clientId` is preferred for
 * lookup/storage when present since it identifies the client record itself
 * and is always available (unlike `clientUserId`, which is null for clients
 * who haven't joined the portal).
 */
/**
 * Push the client's current email and name onto an existing Stripe customer when
 * either has changed. One retrieve and, only when something differs, one update:
 * a no-op costs a single read and never writes. Every failure is swallowed, since
 * the caller is on a payment path and a stale display name at Stripe is not worth
 * refusing a payment over.
 */
async function syncStripeCustomerIdentity(customerId: string, clientEmail: any, clientName: any) {
  if (!stripe || !customerId) return;
  if (!clientEmail && !clientName) return;
  try {
    const existing: any = await stripe.customers.retrieve(customerId);
    if (!existing || existing.deleted) return;
    const patch: any = {};
    if (clientEmail && existing.email !== clientEmail) patch.email = clientEmail;
    if (clientName && existing.name !== clientName) patch.name = clientName;
    if (!Object.keys(patch).length) return;
    await stripe.customers.update(customerId, patch);
  } catch (err: any) {
    console.warn('stripe.service: could not sync customer identity:', { customerId, message: err.message });
  }
}

export async function getOrCreateStripeCustomer({ lawFirmId, clientId, clientUserId, clientEmail, clientName }: any) {
  if (!clientEmail && !clientId && !clientUserId) return null;

  // Check if a customer ID is already stored on the client record.
  //
  // A customer is created once and reused forever, so the identity Stripe holds
  // is whatever it was on the first payment. A company whose billing recipient
  // changes keeps the old address at Stripe, and Stripe's own hosted-invoice and
  // receipt mail keeps going there while Paralegix mails the new list. Push the
  // current identity when it differs, best-effort: a failed sync must never stop
  // a payment, and the id we already hold is still the right customer.
  if (clientId) {
    const client = await clientsRepo.findById(lawFirmId, clientId);
    if (client?.stripeCustomerId) {
      await syncStripeCustomerIdentity(client.stripeCustomerId, clientEmail, clientName);
      return client.stripeCustomerId;
    }
  } else if (clientUserId) {
    const client = await clientsRepo.findByUserId(lawFirmId, clientUserId);
    if (client?.stripeCustomerId) {
      await syncStripeCustomerIdentity(client.stripeCustomerId, clientEmail, clientName);
      return client.stripeCustomerId;
    }
  }

  if (!stripe) return null;

  // Create a new Stripe Customer
  const customerData: any = {
    metadata: { lawFirmId, clientId: clientId || '', clientUserId: clientUserId || '' },
  };
  if (clientEmail) customerData.email = clientEmail;
  if (clientName) customerData.name = clientName;

  const customer = await stripe.customers.create(customerData);

  // Store on the client record, always keyed by `clients.id`. When the caller
  // only holds the portal Firebase uid, resolve the record first: one uid can
  // own several client rows in a firm, so the uuid is the unambiguous key.
  const targetClientId = clientId
    || (clientUserId
      ? await clientsRepo.findByUserId(lawFirmId, clientUserId).then((c: any) => c?.id).catch(() => null)
      : null);
  if (targetClientId) {
    await clientsRepo.setStripeCustomerIdById(lawFirmId, targetClientId, customer.id)
      .catch(() => {
        // Client record may not exist by this id; ignore
      });
  }

  return customer.id;
}

/* ------------------------------------------------------------------ */
/*  Invoice payment request (law firm side)                           */
/* ------------------------------------------------------------------ */

/** Expire a checkout session this request just created and could not record. */
async function withdrawCheckoutSession(sessionId: string, scope: { opts: { stripeAccount: string } | undefined }) {
  try {
    await stripe.checkout.sessions.expire(sessionId, ...idOnAccount(scope));
  } catch (err: any) {
    console.error(`stripe.service: could not withdraw unrecorded checkout session ${sessionId}:`, err?.message || err);
  }
}

/**
 * Store the pointers of a Stripe link this request just created, under the
 * invoice row lock. Void and delete close an invoice's links under that same
 * lock, so whichever of the two commits first, the other sees it: a link made
 * for an invoice that was voided or deleted in the meantime is refused here and
 * its Stripe object is withdrawn through `withdraw`, instead of surviving as a
 * payable link on a cancelled or missing invoice.
 */
async function recordNewLink(
  { context, invoiceId, action, patch, withdraw }:
  { context: any; invoiceId: string; action: string; patch: (existing: any) => any; withdraw: () => Promise<void> },
) {
  try {
    const recorded = await invoicesRepo.runInvoiceTxn(context, invoiceId, (existing: any) => {
      assertInvoiceNotVoided(existing, action);
      return patch(existing);
    });
    if (!recorded) throw new NotFoundError('Invoice');
  } catch (err) {
    await withdraw();
    throw err;
  }
}

type FeeChoice = { card?: boolean; bank?: boolean };

/**
 * Whether the client pays each method's processing fee on a request: what the
 * firm ticked in the request dialog, with a method left out taking the firm's
 * billing setting. The request and the dialog's quote both read this, so what
 * the firm is shown is what the request does.
 */
async function resolveFeeChoice(lawFirmId: string, choice: FeeChoice = {}, { strict = false } = {}) {
  const { billing, cardFees, eligibility } = await firmCardFeeContext(lawFirmId);
  const { processingFees } = billing;
  // A card fee default the firm may no longer use (its state, its Stripe
  // account) is dropped rather than failing every request that relies on it.
  const firmDefault = {
    card: processingFees.card === 'client' && eligibility.eligible,
    bank: processingFees.bank === 'client',
  };
  if (strict && choice.card === true && !eligibility.eligible) {
    throw new ValidationError({ isCardFeePassedOn: eligibility.reasons.map((r) => ineligibleMessage(r, eligibility)) });
  }
  const passedOn = {
    card: typeof choice.card === 'boolean' ? choice.card && eligibility.eligible : firmDefault.card,
    bank: typeof choice.bank === 'boolean' ? choice.bank : firmDefault.bank,
  };
  return { passedOn, firmDefault, eligibility, cardFees };
}

/**
 * What a client-paid card fee comes to for each kind of card on a payment of
 * `invoiceCents`, and what the firm receives from each: a US credit card, a
 * debit or prepaid card, and a credit card issued outside the US. A card the
 * firm declines shows as not accepted. The card form charges on the firm's own
 * Stripe account, so a card the firm absorbs costs it Stripe's fee plus the
 * Paralegix margin, and a card that carries a fee costs it Stripe's fee only.
 */
function cardRowsFor(invoiceCents: number, cardFees: CardFeeSettings, capPercent: number) {
  const stripeCost = (gross: number, international: boolean) =>
    percentOfCents(gross, cardFees.ratePercent + (international ? INTERNATIONAL_EXTRA_PERCENT : 0)) + cardFees.fixedCents;
  const credit = (kind: 'us_credit' | 'non_us_credit', international: boolean) => {
    const feeCents = creditCardFeeCents(invoiceCents, {
      ratePercent: cardFees.ratePercent, fixedCents: cardFees.fixedCents, capPercent, international,
    });
    const total = invoiceCents + feeCents;
    return { kind, paidBy: 'client', feeCents, clientPaysCents: total, firmReceivesCents: total - stripeCost(total, international) };
  };
  const debitCost = stripeCost(invoiceCents, false) + applicationFeeCents('card', invoiceCents, true);
  return [
    credit('us_credit', false),
    cardFees.debitCards === 'decline'
      ? { kind: 'debit', accepted: false }
      : { kind: 'debit', paidBy: 'firm', feeCents: debitCost, clientPaysCents: invoiceCents, firmReceivesCents: invoiceCents - debitCost },
    cardFees.internationalCards === 'decline'
      ? { kind: 'non_us_credit', accepted: false }
      : credit('non_us_credit', true),
  ];
}

/**
 * What a payment link would ask for: the full balance, or the one installment
 * the firm names by its stable id. A named installment must be on an active
 * plan and still unpaid; anything else is refused with 400 before a link exists.
 */
function requestFor(invoice: any, installmentId: string | null) {
  if (!installmentId) return payLinkRequest({ ...invoice, payLinkInstallmentId: null });
  const plan = invoice.paymentPlan;
  if (!plan?.enabled || !Array.isArray(plan.expectedPayments)) {
    throw new ValidationError({ installmentId: ['Invoice does not have a payment plan'] });
  }
  const row = plan.expectedPayments.find((ep: any) => ep?.id === installmentId);
  if (!row) throw new ValidationError({ installmentId: ['Installment not found'] });
  if (row.status === 'paid') throw new ValidationError({ installmentId: ['Installment is already paid'] });
  return payLinkRequest({ ...invoice, payLinkInstallmentId: installmentId });
}


/**
 * What the request dialog shows before a payment link is sent: what each
 * method costs (the processing fee, who pays it, what the client pays and what
 * the firm receives) and who an emailed link would go to, for a link asking for
 * the full balance or for one installment. Touches no Stripe object. A firm-paid fee is the estimated cost, which on a direct charge
 * splits into Stripe's fee on the firm's account and the Paralegix margin.
 */
export async function getPaymentFeeQuote({
  lawFirmId, contextType, entityId, invoiceId, actingUserId, feeChoice, installmentId = null,
}: any) {
  const context = { type: contextType, lawFirmId, entityId };
  await authorizeContext(context, actingUserId);
  const invoice = await invoicesRepo.findById(context, invoiceId);
  if (!invoice) throw new NotFoundError('Invoice');

  // What the link would charge: the balance, or the named installment capped at it.
  const invoiceCents = requestFor(invoice, installmentId).requestedCents;
  const { passedOn, firmDefault, eligibility, cardFees } = await resolveFeeChoice(lawFirmId, feeChoice);
  // Who an emailed link would go to, resolved as the request resolves it but
  // without freezing the bill-to record.
  const billing = await resolveInvoiceStripeBilling({
    lawFirmId, contextType, entityId, invoice, action: 'quote payment for', freeze: false,
  });

  return {
    invoiceCents,
    firmDefault,
    // Whether the firm may pass the card fee on, and why not, so the dialog
    // can disable that choice with the reason.
    cardFeeEligibility: eligibility as CardFeeEligibility,
    emailTo: billing.recipients.emails,
    methods: PAYMENT_METHOD_KINDS.map((method) => {
      // A card fee depends on the card, so a passed-on card fee is quoted per
      // kind of card rather than as one amount.
      if (method === 'card' && passedOn.card) {
        return { method, paidBy: 'client', cardRows: cardRowsFor(invoiceCents, cardFees, eligibility.capPercent) };
      }
      if (passedOn[method]) {
        const feeCents = clientSurchargeCents(method, invoiceCents);
        return { method, paidBy: 'client', feeCents, clientPaysCents: invoiceCents + feeCents, firmReceivesCents: invoiceCents };
      }
      const feeCents = estimatedCostCents(method, invoiceCents);
      return { method, paidBy: 'firm', feeCents, clientPaysCents: invoiceCents, firmReceivesCents: invoiceCents - feeCents };
    }),
  };
}

/**
 * Request online payment for an invoice. Every request makes one secure
 * payment link to the no-login pay page, where the client chooses card or bank
 * transfer and sees any processing fee the firm passed on. The link asks for
 * the full balance, or for one payment-plan installment when `installmentId`
 * names it. The firm either has Paralegix email it to the invoice's billing
 * recipients (`sendEmail`) or copies it to send another way, such as a text. A
 * new request replaces the previous link, so an old one stops working.
 */
export async function requestPayment({
  lawFirmId, contextType, entityId, invoiceId, actingUserId, feeChoice, sendEmail = true, installmentId = null,
}: any) {
  const context = { type: contextType, lawFirmId, entityId };
  await authorizeContext(context, actingUserId);

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');
  if (!firmData.stripeAccountId || !firmData.stripeChargesEnabled) {
    throw new ValidationError({
      stripe: ['Law firm must connect and complete Stripe onboarding before requesting payments'],
    });
  }

  const invoice = await invoicesRepo.findById(context, invoiceId);
  if (!invoice) throw new NotFoundError('Invoice');
  assertInvoiceNotVoided(invoice, 'request payment for it');
  if (invoice.isPaid) throw new ValidationError({ invoice: ['Invoice is already paid'] });

  const remaining = Math.round(
    ((invoice.totalAmount || 0) - (invoice.amountPaid || 0) - (invoice.totalWrittenOff || 0)) * 100
  ) / 100;
  if (remaining <= 0) throw new ValidationError({ invoice: ['No remaining balance'] });
  const target = requestFor(invoice, installmentId);
  const targetRow = target.installmentNumber ? invoice.paymentPlan.expectedPayments[target.installmentNumber - 1] : null;
  // Refuses a card fee the firm may not pass on before anything is frozen.
  const { passedOn } = await resolveFeeChoice(lawFirmId, feeChoice, { strict: true });

  // Who is billed. The first request freezes the bill-to record. Emailing the
  // link needs someone to email; copying it does not.
  const billing = await resolveInvoiceStripeBilling({
    lawFirmId, contextType, entityId, invoice, action: 'request payment for',
  });
  if (sendEmail) assertHasRecipients(billing.recipients, 'email a payment link for this invoice to');

  // Close the previous request's checkout before replacing its link. A
  // completed checkout may be an ACH debit still awaiting settlement.
  const { collected } = await closeInvoicePaymentSurfaces(lawFirmId, invoice, { strict: true, allowRecordedPayments: true });
  if (collected) {
    throw new ValidationError({ stripe: ['The client has already paid this request, or a payment is processing. Please wait for it to complete.'] });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const paymentUrl = payLinkUrl(token);
  // Under the invoice row lock like every other link, so a void that lands
  // meanwhile refuses the request. There is no Stripe object to withdraw:
  // nothing payable exists until the client picks a method on the pay page.
  await recordNewLink({
    context,
    invoiceId,
    action: 'request payment for it',
    withdraw: async () => {},
    patch: async (existing: any) => {
      if (existing.isPaid || existing.payLinkToken !== invoice.payLinkToken) {
        throw new ConflictError('This payment request has changed. Please refresh the page.');
      }
      if (target.installmentId && !payLinkRequest({ ...existing, payLinkInstallmentId: target.installmentId }).isPayable) {
        throw new ConflictError('This installment has changed. Please refresh the page.');
      }
      const late = await closeInvoicePaymentSurfaces(lawFirmId, existing, { strict: true, skip: invoice, allowRecordedPayments: true });
      if (late.collected) {
        throw new ValidationError({ stripe: ['A payment is already processing for this invoice. Please wait for it to complete.'] });
      }
      return {
        stripePaymentRequested: true,
        stripePaymentStatus: 'pending',
        stripePaymentRequestedBy: actingUserId,
        stripeCheckoutSessionId: null,
        stripeCheckoutSessionAccountId: null,
        stripeCardPaymentIntentId: null,
        stripeCardPaymentIntentAccountId: null,
        // Read by the checkout when the client pays.
        isCardFeePassedOn: passedOn.card,
        isBankFeePassedOn: passedOn.bank,
        payLinkToken: token,
        // The installment the link asks for; null asks for the full balance.
        payLinkInstallmentId: target.installmentId,
        updatedAt: new Date(),
      };
    },
  });

  eventBus.emit(INVOICE_PAYMENT_REQUESTED, {
    lawFirmId, invoiceId, contextType, entityId, actingUserId,
  });

  if (sendEmail) {
    sendPaymentRequestEmail({
      to: billing.recipients.emails,
      recipientName: billing.customerName,
      lawFirmName: firmData.name || null,
      invoiceNumber: target.installmentNumber
        ? `${invoice.invoiceName} (Installment ${target.installmentNumber})`
        : invoice.invoiceName,
      // What the link charges, which for an installment is capped at the balance.
      amountDue: fromCents(target.requestedCents),
      checkoutUrl: paymentUrl,
      dueDate: formatDueDateForEmail(targetRow ? targetRow.dueDate : invoice.dueDate),
      payLink: true,
    }).then((result: any) => {
      if (!result.sent) {
        console.warn(`stripe.service: payment request email not sent for invoice ${invoiceId}`);
      }
    }).catch((err: any) => {
      console.error('stripe.service: error sending payment request email:', err.message);
    });
  }

  return { message: sendEmail ? 'Payment link emailed' : 'Payment link created', paymentUrl };
}

/* ------------------------------------------------------------------ */
/*  Client checkout: verify invoice status, then create checkout URL */
/* ------------------------------------------------------------------ */

/**
 * For the client portal and the pay page: checks the payment request is still
 * open and payable, then creates a Checkout Session for what it asks for (the
 * full balance or one installment), returning to the portal or the pay link.
 */
export async function getClientCheckoutUrl(args: any) {
  try {
    return await withLock('STRIPE_INVOICE_CHECKOUT', `${args.lawFirmId}:${args.invoiceId}`,
      () => createClientCheckoutUrl(args), { maxHoldMs: STRIPE_PAYMENT_INTENT_LOCK_MAX_HOLD_MS });
  } catch (err: any) {
    if (err?.code === 'ADVISORY_LOCK_TIMEOUT') {
      throw new ConflictError('Another payment checkout is being prepared. Please try again in a moment.');
    }
    throw err;
  }
}

async function createClientCheckoutUrl({
  lawFirmId, invoiceId, contextType, entityId, clientId, clientUserId, clientEmail, clientName, method, payLinkToken,
  successUrl = `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/billing?payment=success`,
  cancelUrl = `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/billing?payment=cancelled`,
}: any) {
  if (!stripe) throw new AppError('Payment processing is not available', 503, 'STRIPE_NOT_CONFIGURED');

  const context = { type: contextType, lawFirmId, entityId };
  const invoice = await invoicesRepo.findById(context, invoiceId);
  if (!invoice) throw new NotFoundError('Invoice');
  assertInvoiceNotVoided(invoice, 'pay it online');
  if (payLinkToken !== undefined && invoice.payLinkToken !== payLinkToken) throw new NotFoundError('Payment link');
  if (!invoice.stripePaymentRequested) {
    throw new ValidationError({ invoice: ['Payment has not been requested for this invoice'] });
  }
  if (invoice.isPaid) throw new ValidationError({ invoice: ['Invoice is already paid'] });
  const requested = payLinkRequest(invoice);
  // An installment link whose row was paid another way or left the plan has
  // nothing to collect. The pay page treats it as a dead link.
  if (requested.installmentId && !requested.isPayable) {
    if (payLinkToken !== undefined) throw new NotFoundError('Payment link');
    throw new ValidationError({ invoice: ['This installment is no longer due. Please refresh the page.'] });
  }

  // Every Stripe object for a direct-charge firm lives on its own account. An
  // existing link is read on the account recorded when it was created; only a
  // new session below takes the firm's current setup.
  const scope = await invoiceChargeScopeFor(lawFirmId);
  const existingSessionScope = scopeForRecordedAccount(invoice.stripeCheckoutSessionAccountId, scope);

  // A checkout session is for one method, chosen on the pay page or in the
  // portal before it is minted.
  if (method !== 'card' && method !== 'bank') {
    throw new ValidationError({ method: ['Choose card or bank transfer'] });
  }

  // What this request charges, in cents for an exact comparison against a cached
  // session's amount, before deciding whether a cached checkout session is reusable.
  const requestedCents = requested.requestedCents;
  if (requestedCents <= 0) throw new ValidationError({ invoice: ['No remaining balance'] });

  // The session is restricted to the chosen method. A bank fee the firm passed
  // on when it requested payment is added as its own line, grossed up so the
  // firm still nets the balance. A card fee is only ever charged through the
  // card form, which knows the card type first: Checkout cannot tell credit
  // from debit, so a card checkout carries no fee whatever the invoice says.
  const surchargeCents = method === 'bank' && invoice.isBankFeePassedOn ? clientSurchargeCents('bank', requestedCents) : 0;
  const grossCents = requestedCents + surchargeCents;
  const appFeeCents = applicationFeeCents(method, grossCents, scope.direct);

  // Check for existing valid checkout session. Only reuse it when it was minted
  // for the same method, installment, amount and return URLs; if the amount
  // changed (e.g. a manual partial payment landed), the request now names another
  // installment, or the client picked the other method, expire the stale session
  // and create a fresh one so the client can never pay an out-of-date total or
  // the wrong fee.
  if (invoice.stripeCheckoutSessionId) {
    try {
      const existingSession = await stripe.checkout.sessions.retrieve(invoice.stripeCheckoutSessionId, ...idOnAccount(existingSessionScope));
      if (existingSession.status === 'complete'
        && !(existingSession.payment_status === 'paid' && hasRecordedStripeSurface(invoice, existingSession.id))) {
        if (existingSession.payment_status === 'paid') {
          await handleCheckoutCompleted(existingSession);
          throw new ConflictError('This invoice has just been paid. Please refresh the page.');
        }
        throw new AppError('A bank payment is already processing for this invoice. Please wait for it to complete.', 409, 'PAYMENT_PROCESSING');
      }
      if (existingSession.status === 'open' && existingSession.url) {
        const sessionMeta = existingSession.metadata || {};
        if (sessionMeta.paymentMethod === method
          && sessionMeta.invoiceAmountCents === String(requestedCents)
          && (sessionMeta.installmentId || null) === requested.installmentId
          && existingSession.success_url === successUrl
          && existingSession.cancel_url === cancelUrl
          && Number(existingSession.amount_total) === grossCents) {
          return { checkoutUrl: existingSession.url };
        }
        await stripe.checkout.sessions.expire(existingSession.id, ...idOnAccount(existingSessionScope));
      }
    } catch (err: any) {
      // A missing session cannot collect money. Every other failure preserves
      // the current payable surface instead of creating a second charge.
      if (err?.code !== 'resource_missing' && err?.statusCode !== 404 && err?.raw?.code !== 'resource_missing') throw err;
    }
  }

  // A card-form payment waiting on the client's bank holds the invoice: refuse
  // while it is collecting, and cancel it when the client has abandoned it for
  // this checkout.
  if (invoice.stripeCardPaymentIntentId) {
    const outcome = await closeCardPaymentIntent(invoice);
    if (outcome === 'collected') {
      throw new AppError('A payment is already processing for this invoice. Please wait for it to complete.', 409, 'PAYMENT_PROCESSING');
    }
    if (outcome === 'unreachable') {
      throw new AppError('Could not reach Stripe to start the payment. Try again in a moment.', 502, 'STRIPE_UNAVAILABLE');
    }
  }

  // Get the law firm's connected account
  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');
  if (!firmData.stripeAccountId || !firmData.stripeChargesEnabled) {
    throw new AppError('Law firm payment processing is not set up', 400, 'STRIPE_NOT_READY');
  }

  // Get or create the customer for the CLIENT RECORD.
  //
  // `clientEmail`/`clientName` arrive from the portal as the signed-in user's
  // own identity. For a person client that is the client. For a company it is
  // one roster contact, and using it would have created the company's Stripe
  // customer under whichever employee happened to pay first, permanently. The
  // client record itself is the authority: a company customer carries the
  // company's name and its primary billing recipient's address, whoever is
  // holding the browser.
  const recipients = await resolveInvoiceRecipients({ lawFirmId, invoice });
  const identity = await resolveClientStripeIdentity({
    lawFirmId,
    clientId,
    preferredEmail: recipients.primaryEmail,
    fallbackEmail: clientEmail,
    fallbackName: clientName,
  });

  // Minting a payable hosted URL is an external issue, so freeze the bill-to
  // record if this is the first one. `requireRecipients: false`: the client is
  // already looking at the invoice in their portal, so a firm that has not
  // named a billing recipient must not block them from paying - that call
  // simply leaves the invoice unsnapshotted rather than freezing "nobody".
  await snapshotInvoiceRecipients({
    lawFirmId, invoice, invoiceId, action: 'issue a payment link for', requireRecipients: false,
  }).catch((err: any) => {
    console.error('stripe.service: billing snapshot before checkout failed:', err?.message || err);
  });

  const stripeCustomerId = scope.direct
    ? await getOrCreateConnectedCustomer({
      stripeAccount: firmData.stripeAccountId,
      clientId: identity.clientId || clientId,
      clientEmail: identity.customerEmail,
      clientName: identity.customerName,
    })
    : await getOrCreateStripeCustomer({
      lawFirmId,
      clientId: identity.clientId || clientId,
      clientUserId: identity.clientUserId,
      clientEmail: identity.customerEmail,
      clientName: identity.customerName,
    });

  // Create new Checkout Session (provides redirect back to portal after payment)
  const itemName = requested.installmentNumber
    ? `Invoice #${invoice.invoiceName}, Installment ${requested.installmentNumber}`
    : `Invoice #${invoice.invoiceName}`;
  const lineItems: any[] = [{
    price_data: {
      currency: 'usd',
      product_data: {
        name: itemName,
        description: `Payment for ${itemName}`,
      },
      unit_amount: requestedCents,
    },
    quantity: 1,
  }];
  if (surchargeCents > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: 'Bank transfer processing fee' },
        unit_amount: surchargeCents,
      },
      quantity: 1,
    });
  }
  const sessionParams: any = {
    mode: 'payment',
    line_items: lineItems,
    payment_method_types: [method === 'card' ? 'card' : 'us_bank_account'],
    payment_intent_data: scope.direct
      ? {
        application_fee_amount: appFeeCents,
        // On the payment intent too, so a refund or dispute event names its model.
        metadata: { chargeModel: 'direct' },
      }
      : {
        application_fee_amount: appFeeCents,
        transfer_data: {
          destination: firmData.stripeAccountId,
        },
      },
    metadata: {
      ...(scope.direct ? { chargeModel: 'direct' } : {}),
      lawFirmId,
      invoiceId,
      contextType,
      entityId,
      // clientId is the legal client being billed (clients.id). clientUserId is
      // the Firebase uid of whoever opened checkout - for a company that is a
      // roster contact, which is exactly why it is a separate key and never
      // stands in for the client.
      clientId: identity.clientId || clientId || '',
      clientUserId: clientUserId || '',
      // How the webhook separates invoice money from a client-paid fee, and how
      // a later visit decides whether this session can be reused.
      paymentMethod: method,
      invoiceAmountCents: String(requestedCents),
      surchargeCents: String(surchargeCents),
      // The installment's stable id, so the webhook credits that row. Absent on
      // a full-balance link.
      ...(requested.installmentId ? { installmentId: requested.installmentId } : {}),
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  };

  if (stripeCustomerId) {
    sessionParams.customer = stripeCustomerId;
  } else if (identity.customerEmail || clientEmail) {
    // Receipt address only, when no customer could be created. Prefer the
    // client record's billing address over the signed-in user's own.
    sessionParams.customer_email = identity.customerEmail || clientEmail;
  }

  const session = await stripe.checkout.sessions.create(sessionParams, ...onAccount(scope));

  // Update invoice with new session ID
  await recordNewLink({
    context,
    invoiceId,
    action: 'pay it online',
    withdraw: () => withdrawCheckoutSession(session.id, scope),
    patch: (existing: any) => {
      if (payLinkToken !== undefined && existing.payLinkToken !== payLinkToken) throw new NotFoundError('Payment link');
      if (!existing.stripePaymentRequested) throw new NotFoundError('Payment link');
      if (existing.payLinkToken !== invoice.payLinkToken
        || existing.stripeCheckoutSessionId !== invoice.stripeCheckoutSessionId
        || existing.stripeCardPaymentIntentId !== invoice.stripeCardPaymentIntentId) {
        throw new ConflictError('This payment request has changed. Please refresh the page.');
      }
      if (existing.isPaid || (existing.payLinkInstallmentId || null) !== requested.installmentId
        || payLinkRequest(existing).requestedCents !== requestedCents
        || existing.isCardFeePassedOn !== invoice.isCardFeePassedOn
        || existing.isBankFeePassedOn !== invoice.isBankFeePassedOn) {
        throw new ConflictError('This payment request has changed. Please refresh the page.');
      }
      return {
        stripeCheckoutSessionId: session.id,
        stripeCheckoutSessionAccountId: recordedAccountFor(scope),
        // Any card payment the invoice held was cancelled above.
        stripeCardPaymentIntentId: null,
        stripeCardPaymentIntentAccountId: null,
        stripePaymentStatus: 'pending',
      };
    },
  });

  return { checkoutUrl: session.url };
}

/* ------------------------------------------------------------------ */
/*  Trust deposits (electronic, optional)                             */
/* ------------------------------------------------------------------ */

/**
 * Firm-initiated request for an electronic (ACH) trust deposit. Creates a Stripe
 * Checkout Session the client pays to fund a trust account, and returns the URL to
 * share with the client.
 *
 * Compliance-critical:
 *  - The charge is a destination charge to the TRUST account's own connected account
 *    (its trust/IOLTA bank account), NOT the firm's operating account — client trust
 *    funds must never settle into operating funds.
 *  - NO application fee is taken from the charge, so the deposit lands in full. The
 *    ACH processing cost Paralegix fronts is billed to the firm's operating side
 *    later (see handleTrustDepositPaymentSucceeded).
 *  - ACH only. Funds are posted to the ledger on payment_intent.succeeded, not on
 *    session completion, because ACH can still fail after checkout.
 *
 * Gated: the firm must have opted into electronic trust deposits, and the trust
 * account must have a fully-onboarded connected account with charges enabled.
 */
export async function requestTrustDeposit({ lawFirmId, trustAccountId, clientId, amountCents, matterId, actingUserId, sendEmail = false }: any) {
  if (!stripe) throw new AppError('Payment processing is not available', 503, 'STRIPE_NOT_CONFIGURED');
  await assertLawFirmMembership(lawFirmId, actingUserId);

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ValidationError({ amountCents: ['A positive amount (cents) is required'] });
  }

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  if (!firmData) throw new NotFoundError('Law firm');

  // Firm-level opt-in (jurisdiction acknowledgement).
  const trustSettings = await getFirmTrustSettings(lawFirmId);
  if (!trustSettings.electronicTrustDepositsAllowed) {
    throw new AppError(
      'Electronic trust deposits are not enabled for this firm.',
      400, 'TRUST_DEPOSITS_DISABLED',
    );
  }

  // The ACH processing fee is billed to the firm's operating side (a subscription
  // invoice item). Require a billable subscription customer up front so the platform
  // never fronts a fee it cannot collect — no electronic deposit without one.
  if (!firmData.plan?.stripeCustomerId) {
    throw new AppError(
      'Electronic trust deposits require an active Paralegix subscription so the processing fee can be billed.',
      400, 'TRUST_DEPOSIT_NO_BILLING',
    );
  }

  const trustAccount = await trustAccountRepo.findByIdOrFail(lawFirmId, trustAccountId, 'TrustAccount');
  if (trustAccount.status !== 'active') {
    throw new ValidationError({ trustAccountId: ['Trust account is not active'] });
  }
  // The deposit must settle into the trust account's own connected (trust bank)
  // account, so it must be fully onboarded and able to accept transfers.
  if (!trustAccount.stripeConnectedAccountId || !trustAccount.stripeChargesEnabled) {
    throw new AppError(
      'This trust account is not set up to accept electronic deposits yet. Connect its trust bank account in settings first.',
      400, 'STRIPE_TRUST_NOT_READY',
    );
  }

  const client = await clientsRepo.findById(lawFirmId, clientId);
  if (!client) throw new NotFoundError('Client');

  // The same rule the manual deposit path enforces. This path posts through
  // `createTrustDepositFromStripe` once the money lands, which skips the
  // service-level check, so it has to happen here or a firm can attach one
  // client's deposit to another client's matter on an append-only ledger.
  if (matterId && !await matterBelongsToClient(lawFirmId, matterId, clientId)) {
    throw new AppError(
      'That matter does not belong to this client, so trust money cannot be posted against it.',
      400, 'TRUST_MATTER_CLIENT_MISMATCH',
    );
  }

  // The customer is the client RECORD. For a company that means the company's
  // own name plus its primary billing recipient's address (a company's own
  // `email` column is usually blank), never an individual roster contact's
  // identity, and the SAME customer the company's invoices already use.
  const identity = await resolveClientStripeIdentity({ lawFirmId, clientId });

  const stripeCustomerId = await getOrCreateStripeCustomer({
    lawFirmId,
    clientId,
    clientUserId: identity.clientUserId,
    clientEmail: identity.customerEmail,
    clientName: identity.customerName,
  });
  // ACH via Checkout requires a Customer (the debit mandate is attached to it).
  if (!stripeCustomerId) {
    throw new NoBillingRecipientError(
      identity.clientType === 'company'
        ? 'This company needs a billing recipient with an email address before it can fund trust by ACH.'
        : 'This client needs an email address before they can fund trust by ACH.',
    );
  }

  // Shared by the session and the payment intent so payment_intent.succeeded (where
  // the deposit is actually posted) carries the same trust context. `clientId` is
  // the legal client; `actingUserId` is the firm member who requested the deposit.
  // Separate keys, separate id spaces.
  const depositMetadata = {
    lawFirmId,
    trustAccountId,
    clientId: clientId || '',
    matterId: matterId || '',
    actingUserId: actingUserId || '',
    depositType: 'trust',
  };

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['us_bank_account'],
    customer: stripeCustomerId,
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Trust deposit: ${trustAccount.name}`,
          description: client.name ? `Trust funds for ${client.name}` : 'Trust account funding',
        },
        unit_amount: amountCents,
      },
      quantity: 1,
    }],
    payment_intent_data: {
      // Deliberately NO application_fee_amount: a trust deposit must land in full.
      // The processing cost is billed to the firm's operating side, never trust.
      transfer_data: { destination: trustAccount.stripeConnectedAccountId },
      metadata: depositMetadata,
    },
    metadata: depositMetadata,
    success_url: `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/trust?deposit=success`,
    cancel_url: `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/trust?deposit=cancelled`,
  });

  // Like an invoice payment request: emailed to the client, or left for the
  // firm to copy and send another way.
  const emailedTo = sendEmail ? identity.customerEmail : null;
  if (emailedTo) {
    sendTrustDepositRequestEmail({
      to: [emailedTo],
      recipientName: identity.customerName,
      lawFirmName: firmData.name || null,
      amountCents,
      checkoutUrl: session.url,
    }).catch((err: any) => {
      console.error('stripe.service: error sending trust deposit request email:', err?.message || err);
    });
  }

  return { checkoutUrl: session.url, sessionId: session.id, emailedTo };
}

/**
 * payment_intent.succeeded handler for an ACH trust deposit (depositType=trust).
 * This is where the deposit is posted to the ledger — NOT on session completion,
 * because ACH funds can still fail after checkout. Idempotent on the payment intent.
 * Once posted, the ACH processing fee is billed to the firm's operating side.
 *
 * Returns `{ posted }`: true only when THIS call actually created a new ledger
 * row. `reconcileStripeTrustDeposits` relies on this to count real recoveries;
 * a graceful dedupe (this payment intent turned out to already be posted, by a
 * concurrent webhook or an earlier sweep) is not a posting.
 */
export async function handleTrustDepositPaymentSucceeded(paymentIntent: any, eventCreated: any) {
  const md = paymentIntent.metadata || {};
  if (md.depositType !== 'trust') return { posted: false };
  if (!md.lawFirmId || !md.trustAccountId) return { posted: false };

  const amountCents = paymentIntent.amount_received || paymentIntent.amount;
  if (!amountCents || amountCents <= 0) return { posted: false };

  let posted: { duplicate: boolean; transactionId: string };
  try {
    posted = await trustService.createTrustDepositFromStripe({
      lawFirmId: md.lawFirmId,
      trustAccountId: md.trustAccountId,
      clientId: md.clientId || null,
      matterId: md.matterId || null,
      amountCents,
      // Date the deposit at the succeeded-event time (ACH settlement), not the
      // payment-intent creation time (checkout, days earlier). Dating it in the past
      // can land it behind a closed book period and block posting entirely.
      date: stripeDay(eventCreated || paymentIntent.created, await firmZone(md.lawFirmId)),
      stripePaymentIntentId: paymentIntent.id,
      description: 'Trust deposit via ACH',
    });
  } catch (err: any) {
    // The money is already in the trust account, so a refusal here leaves the
    // IOLTA holding client funds the ledger does not show. Tell a person, then
    // rethrow so the webhook fails and Stripe retries once the cause is fixed.
    // Only an AppError's message is user-facing copy; anything else is generic.
    console.error('stripe.service: CRITICAL: settled trust deposit could not be posted to the ledger:', {
      lawFirmId: md.lawFirmId, trustAccountId: md.trustAccountId, paymentIntentId: paymentIntent.id,
      amountCents, error: err?.message || err,
    });
    eventBus.emit(TRUST_DEPOSIT_POSTING_FAILED, {
      lawFirmId: md.lawFirmId,
      trustAccountId: md.trustAccountId,
      clientId: md.clientId || null,
      amountCents,
      paymentIntentId: paymentIntent.id,
      error: err instanceof AppError ? err.message : null,
    });
    throw err;
  }
  const { duplicate, transactionId } = posted;

  if (!duplicate) {
    eventBus.emit(TRUST_DEPOSIT_RECEIVED, {
      lawFirmId: md.lawFirmId,
      trustAccountId: md.trustAccountId,
      clientId: md.clientId || null,
      amountCents,
      transactionId,
      stripePaymentIntentId: paymentIntent.id,
    });
  }

  // Bill the ACH processing fee to the firm's operating side (never trust). Runs on
  // BOTH the first delivery and a retry/replay: billing is idempotent (dedup on the
  // accrued-fee row plus a Stripe idempotency key), so a duplicate delivery never
  // double-charges, but a first attempt whose fee accrual failed still gets billed
  // when Stripe redelivers. A genuine accrual/DB failure is deliberately allowed to
  // propagate so the webhook 500s and Stripe retries the whole (idempotent) event,
  // rather than silently dropping a fee the firm owes. A declined/absent-card charge
  // does NOT throw here (billFirmForTrustAchFee leaves it accrued for the sweep).
  await billFirmForTrustAchFee({ lawFirmId: md.lawFirmId, trustTransactionId: transactionId, amountCents });
  return { posted: !duplicate };
}

/**
 * payment_intent.payment_failed handler for a trust deposit. Nothing is posted to
 * the ledger until funds succeed, so a failed/returned ACH payment needs no reversal
 * here — just an audit log so the firm can see the attempt failed.
 */
/**
 * payment_intent.payment_failed for an ACH trust deposit. Nothing was posted (an
 * ACH deposit posts only on payment_intent.succeeded), so there is no ledger work.
 * The failure can land days after the client checked out, when nobody is watching,
 * so the firm's trust managers are told: otherwise the client believes the
 * retainer is paid and the firm believes it is on its way.
 */
export async function handleTrustDepositPaymentFailed(paymentIntent: any) {
  const md = paymentIntent.metadata || {};
  if (md.depositType !== 'trust') return;
  const reason = paymentIntent.last_payment_error?.message || null;
  console.warn('stripe.service: ACH trust deposit failed before posting:', {
    lawFirmId: md.lawFirmId || null,
    trustAccountId: md.trustAccountId || null,
    paymentIntentId: paymentIntent.id,
    reason,
  });
  if (!isUuid(md.lawFirmId)) return;
  eventBus.emit(TRUST_DEPOSIT_FAILED, {
    lawFirmId: md.lawFirmId,
    trustAccountId: isUuid(md.trustAccountId) ? md.trustAccountId : null,
    clientId: isUuid(md.clientId) ? md.clientId : null,
    amountCents: Math.round(Number(paymentIntent.amount) || 0),
    paymentIntentId: paymentIntent.id,
    reason,
  });
}

/**
 * charge.refunded / charge.dispute.created handler for a trust deposit. A posted
 * ACH trust deposit can be clawed back later — an ACH return, a dispute, or a
 * firm-initiated refund (full OR partial). Converges the ledger to the total
 * clawed-back amount: a dispute (no amount_refunded) pulls the whole deposit; a
 * refund converges to its CUMULATIVE amount_refunded (Stripe reports it
 * cumulatively), so multiple partials and webhook replays never over-reverse. The
 * first full clawback voids the original deposit (balance-neutral void lineage). A
 * partial clawback — or a full one arriving after earlier partials — posts a
 * balance-affecting reversing withdrawal for just the new delta. The platform's
 * cash for that delta is then recovered from the trust connected account (or the
 * firm's operating card for any residual already paid out to the IOLTA). The whole
 * decide-then-post sequence runs under a per-payment-intent advisory lock so a
 * simultaneous refund + dispute for the same deposit cannot double-reverse.
 */
export async function handleTrustDepositReversal(charge: any, reason: any, eventCreated: any) {
  const paymentIntentId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : (charge.payment_intent && charge.payment_intent.id) || null;
  if (!paymentIntentId) return;
  return withLock(
    'STRIPE_PAYMENT_INTENT',
    paymentIntentId,
    () => handleTrustDepositReversalLocked(charge, reason, paymentIntentId, eventCreated),
    { maxHoldMs: STRIPE_PAYMENT_INTENT_LOCK_MAX_HOLD_MS },
  );
}

async function handleTrustDepositReversalLocked(charge: any, reason: any, paymentIntentId: any, eventCreated: any) {
  const txn = await trustTxnRepo.findByStripePaymentIntentAnyFirm(paymentIntentId);
  if (!txn || txn.type !== 'deposit') return; // a fully-voided deposit is not found → no-op

  const depositCents = txn.amountCents;
  const refundedCents = typeof charge.amount_refunded === 'number' ? charge.amount_refunded : null;
  // Total to have reversed after this event: a dispute pulls the whole deposit; a
  // refund converges to its cumulative refunded amount, capped at the deposit.
  const target = refundedCents != null ? Math.min(refundedCents, depositCents) : depositCents;
  if (target <= 0) return;

  const alreadyReversed = await trustService.sumStripeReversals({ lawFirmId: txn.lawFirmId, depositId: txn.id });
  const delta = target - alreadyReversed;
  // Cash still to take back, tracked apart from the ledger. Stripe debits the
  // platform for the clawback whatever the ledger does, and when the ledger
  // refuses `alreadyReversed` stays 0, so a replay would otherwise recover the
  // same cents a second time.
  const cashDelta = AUTO_RECOVERY_ENABLED
    ? target - await netRecoveredCents(txn.lawFirmId, paymentIntentId)
    : Math.max(0, delta);
  if (delta <= 0 && cashDelta <= 0) return; // nothing new (replay / non-increasing cumulative refund)

  // Date the reversal at the event time (the refund/dispute), not the original
  // charge date (weeks earlier), which could fall behind a closed book period.
  const date = stripeDay(eventCreated || charge.created, await firmZone(txn.lawFirmId));

  // Whether the client's OWN ledger balance carries this clawback: true once the
  // reversal below posts, or when an earlier event already reversed to `target`.
  let ledgerCarriesClawback = delta <= 0;
  if (delta > 0) {
    try {
      if (alreadyReversed === 0 && target >= depositCents) {
        // First clawback, and for the whole deposit → void the original, preserving
        // the balance-neutral void-lineage representation.
        try {
          await trustService.voidTransactionInternal({
            lawFirmId: txn.lawFirmId, transactionId: txn.id, reason, actingUserId: null,
          });
        } catch (voidErr: any) {
          // A void rewrites the deposit's own date, so it is refused once a signed
          // reconciliation cleared the deposit or its period was closed. The money
          // still left today: post a reversing withdrawal dated at the event, the
          // same entry a partial clawback uses. Only those two refusals fall back.
          // Any other refusal (above all, a balance that would go negative because
          // the client already spent the funds) stands and is alerted below.
          if (voidErr?.code !== 'TRANSACTION_RECONCILED' && voidErr?.code !== 'TRUST_PERIOD_LOCKED') throw voidErr;
          await trustService.createStripeReversalWithdrawal({
            lawFirmId: txn.lawFirmId, deposit: txn, amountCents: delta, date,
            reason: `Trust deposit reversal (${reason})`,
          });
        }
      } else {
        // Partial clawback, or completing a deposit already partially reversed → post a
        // reversing withdrawal for the delta so the balance converges to `target`
        // without double-counting earlier partials or voiding a partly-refunded deposit.
        await trustService.createStripeReversalWithdrawal({
          lawFirmId: txn.lawFirmId, deposit: txn, amountCents: delta, date,
          reason: `Trust deposit reversal (${reason})`,
        });
      }
      ledgerCarriesClawback = true;
    } catch (err: any) {
      // The ledger refused the reversal (funds already disbursed, so it would go
      // negative). SAFE outcome, but the client's trust balance is now overstated
      // until a human corrects it, so raise a durable alert.
      console.error('stripe.service: CRITICAL: could not reverse clawed-back trust deposit, manual correction required:', {
        lawFirmId: txn.lawFirmId, trustTransactionId: txn.id, paymentIntentId, delta, error: err?.message || err,
      });
      eventBus.emit(TRUST_DEPOSIT_REVERSAL_FAILED, {
        lawFirmId: txn.lawFirmId,
        trustTransactionId: txn.id,
        trustAccountId: txn.trustAccountId,
        clientId: txn.clientId,
        amountCents: delta,
        paymentIntentId,
        reason,
        error: err?.message || String(err),
      });
    }
  }

  if (cashDelta <= 0) return;

  // Cash recovery. The trust connected account's Stripe balance pools EVERY
  // client's pending deposits, so reversing the trust transfer takes money from
  // that pool, not from this client. It is the right source only when this
  // client's own ledger balance went down by the same cents. When the ledger
  // refused (the client already spent the money), a transfer reversal would make
  // other clients' trust funds cover this client's shortfall, so the whole delta
  // is billed to the firm's OPERATING card instead and the trust account is not
  // touched. Either way the residual goes to the operating card, never the trust
  // bank. Idempotent per (payment intent, cumulative target), and each Stripe
  // object that moves cash is recorded so a restore can return exactly it.
  const recovered = ledgerCarriesClawback
    ? await recoverConnectedTransfer({
      paymentIntentId, recoverCents: cashDelta, reason: `trust ${reason}`,
      idempotencyKey: `trust-recover-${paymentIntentId}-${target}`,
      lawFirmId: txn.lawFirmId, source: 'trust_transfer',
    })
    : 0;
  const shortfall = cashDelta - recovered;
  if (shortfall > 0) {
    await chargeFirmForTrustClawback({
      lawFirmId: txn.lawFirmId, paymentIntentId, amountCents: shortfall, idempotencySuffix: String(target),
    }).catch((err) => console.error('stripe.service: CRITICAL: failed to recover trust clawback from firm operating card:', {
      lawFirmId: txn.lawFirmId, trustTransactionId: txn.id, paymentIntentId, shortfall, error: err?.message || err,
    }));
  }
}

/**
 * charge.refunded / charge.dispute.created handler for an INVOICE (card/ACH)
 * payment. Trust deposits are handled by handleTrustDepositReversal; this reverses
 * the invoice-side payment so a refunded/disputed invoice no longer shows paid.
 * No-ops when the charge isn't an invoice payment we recorded (trust deposit or
 * unknown). `kind` is 'refund' (reverse only the refunded portion) or 'dispute'
 * (reverse the full matched payment, since the funds are pulled in full).
 */
export async function handleInvoicePaymentReversal(charge: any, kind: any, connectedAccountId: string | null = null) {
  const paymentIntentId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : (charge.payment_intent && charge.payment_intent.id) || null;
  if (!paymentIntentId) return;

  const match = await invoicesRepo.findInvoicePaymentByStripePaymentIntentAnyFirm(paymentIntentId);
  if (!match) return; // not an invoice payment (trust deposit or unknown charge)
  if (connectedAccountId) {
    const refusal = await invoicePaymentAccountRefusal(match);
    if (refusal) {
      logRefusedInvoicePaymentEvent(match, paymentIntentId, connectedAccountId, refusal);
      return;
    }
  }

  const { lawFirmId, invoiceId, context } = match;

  let reversedThisEvent = 0;
  let surchargeReversedThisEvent = 0;
  await invoicesRepo.runInvoiceTxn(context, invoiceId, (existing: any) => {
    const payments = [...(existing.payments || [])];
    const idx = payments.findIndex((p) => p.stripePaymentIntentId === paymentIntentId);
    if (idx < 0) return null; // payment already removed/reconciled: nothing to reverse

    const entry = payments[idx];
    // Stripe's charge.amount_refunded is CUMULATIVE. Reconstruct the original charged
    // amount (current net + what we've already reversed) and converge the entry to
    // (original - amount_refunded), rather than subtracting a delta each time. This is
    // idempotent and order-safe across multiple partial refunds and webhook re-delivery.
    const alreadyRefunded = entry.stripeRefundedCents || 0;
    const originalCents = toCents(entry.amount) + alreadyRefunded;
    // A dispute names the amount in question, and a partial dispute pulls only
    // that portion. The route passes it as `amount_refunded`, the same field the
    // trust reversal reads, so both paths treat it as the cumulative target and a
    // re-delivered event converges on the same number. A dispute with no amount
    // is the whole charge, which is what every dispute used to mean here.
    const surchargeCents = entry.surchargeCents || 0;
    const chargedCents = originalCents + surchargeCents;
    const reversedTarget = Math.max(0, Math.round(charge.amount_refunded) || 0);
    const target = kind === 'dispute' && reversedTarget === 0 ? chargedCents : Math.min(chargedCents, reversedTarget);
    const newRefunded = Math.max(alreadyRefunded, Math.min(originalCents, target));
    const alreadySurchargeRefunded = entry.surchargeRefundedCents || 0;
    const newSurchargeRefunded = Math.max(alreadySurchargeRefunded, Math.min(surchargeCents, Math.max(0, target - originalCents)));
    reversedThisEvent = newRefunded - alreadyRefunded;
    surchargeReversedThisEvent = newSurchargeRefunded - alreadySurchargeRefunded;
    if (reversedThisEvent === 0 && surchargeReversedThisEvent === 0) return null;

    // Track each part of the gross charge independently. A fee-only refund
    // changes cash recovery even after the invoice principal is fully reversed.
    payments[idx] = {
      ...entry,
      amount: fromCents(originalCents - newRefunded),
      stripeRefundedCents: newRefunded,
      stripeDisputedCents: (entry.stripeDisputedCents || 0) + (kind === 'dispute' ? reversedThisEvent : 0),
      surchargeRefundedCents: newSurchargeRefunded,
      surchargeDisputedCents: (entry.surchargeDisputedCents || 0) + (kind === 'dispute' ? surchargeReversedThisEvent : 0),
    };

    // Recompute amountPaid from the (net) payments so the paid flag / open balance
    // reflect the reversal.
    const amountPaidCents = payments.reduce((sum, p) => sum + toCents(p.amount), 0);
    const effectiveTotalCents = toCents(existing.totalAmount || 0) - toCents(existing.totalWrittenOff || 0);
    const isPaid = amountPaidCents >= effectiveTotalCents && effectiveTotalCents > 0;

    const patch: any = {
      payments,
      amountPaid: fromCents(amountPaidCents),
      isPaid,
      paidDate: isPaid ? existing.paidDate : null,
      updatedAt: new Date().toISOString(),
    };

    // If this payment settled payment-plan installments and it is now FULLY
    // reversed, reopen every row it settled (one payment can settle several and
    // shrink the next) and refit the open rows to the balance now owed, so the
    // firm can re-collect it: a payment link refuses an installment still marked
    // 'paid'. A partially-reversed payment keeps its rows settled.
    const fullyReversed = (originalCents - newRefunded) <= 0;
    const plan = existing.paymentPlan;
    if (fullyReversed && plan && Array.isArray(plan.expectedPayments)
      && plan.expectedPayments.some((item: any) => item?.status === 'paid' && item.matchedPaymentIndex === idx)) {
      Object.assign(patch, invoicesService.reopenPlanAfterStripeReversal(
        plan, idx, Math.max(0, effectiveTotalCents - amountPaidCents),
      ));
    }

    return patch;
  });

  if (reversedThisEvent + surchargeReversedThisEvent <= 0) return;

  if (reversedThisEvent > 0) eventBus.emit(INVOICE_PAYMENT_REVERSED, {
    lawFirmId,
    invoiceId,
    contextType: context.type,
    entityId: context.entityId,
    reversedCents: reversedThisEvent,
    kind,
    paymentIntentId,
  });

  // A direct charge was refunded or disputed on the firm's own account: Stripe
  // debited the firm, there is no transfer, and nothing is owed to Paralegix.
  if (match.chargeModel === 'direct') return;

  // Make the platform whole: Stripe debited us for this dispute/refund on a
  // destination charge, so claw the money back out of the firm's connected
  // balance by reversing the transfer for the amount just reversed on the invoice.
  await recoverConnectedTransfer({
    paymentIntentId,
    recoverCents: reversedThisEvent + surchargeReversedThisEvent,
    reason: `invoice ${kind}`,
  });
}

/** The payment intent id a Stripe charge, dispute or refund names, expanded or not. */
function paymentIntentIdOf(object: any): string | null {
  return typeof object?.payment_intent === 'string'
    ? object.payment_intent
    : (object?.payment_intent && object.payment_intent.id) || null;
}

/**
 * Whether a Connect event may act on the funds behind `paymentIntentId`. A
 * trust deposit is a platform destination charge and never reaches here on a
 * connected account, so the only thing such an event can restore is an invoice
 * payment held by the firm that owns the account. A platform event passes.
 */
async function connectedEventMayTouchPayment(paymentIntentId: string | null, connectedAccountId: string | null) {
  if (!connectedAccountId) return true;
  if (!paymentIntentId) return false;
  const match = await invoicesRepo.findInvoicePaymentByStripePaymentIntentAnyFirm(paymentIntentId);
  if (!match) return false;
  const refusal = await invoicePaymentAccountRefusal(match);
  if (refusal) {
    logRefusedInvoicePaymentEvent(match, paymentIntentId, connectedAccountId, refusal);
    return false;
  }
  return true;
}

/**
 * The cumulative amount a dispute leaves reversed on its charge: what was
 * already refunded plus what the dispute takes, capped at the charge. Stripe's
 * dispute amount does not include earlier refunds, and the reversal handlers
 * treat their target as the total reversed so far, so passing the disputed
 * amount alone after a partial refund would reverse too little.
 *
 * The refunded figure is read from the charge itself, on the connected account
 * for a Connect event (a direct charge lives there) and on the platform
 * otherwise. A failed read throws, so the webhook answers 500 and Stripe
 * retries rather than reversing the wrong amount. A dispute with no amount
 * returns undefined, which both handlers read as the whole charge; one with no
 * charge reference falls back to the disputed amount alone.
 */
export async function disputeReversalTargetCents(dispute: any, connectedAccountId: string | null): Promise<number | undefined> {
  if (typeof dispute?.amount !== 'number') return undefined;
  const disputedCents = Math.max(0, Math.round(dispute.amount));
  let charge: any = dispute.charge && typeof dispute.charge === 'object' ? dispute.charge : null;
  if (typeof dispute.charge === 'string' && dispute.charge) {
    const scope = { opts: connectedAccountId ? { stripeAccount: connectedAccountId } : undefined };
    charge = await stripe.charges.retrieve(dispute.charge, ...idOnAccount(scope));
  }
  if (!charge) return disputedCents;
  const totalCents = Math.max(0, Math.round(Number(charge.amount_refunded) || 0)) + disputedCents;
  return typeof charge.amount === 'number' ? Math.min(Math.round(charge.amount), totalCents) : totalCents;
}

/**
 * charge.dispute.closed handler.
 *
 * WON: the funds come back, so a payment reversed when the dispute took them is
 * restored. LOST: the cardholder keeps the money, so the reversal stands and
 * the client is told the payment was returned. Any other close (an inquiry's
 * `warning_closed`) reversed nothing and changes nothing.
 *
 * `closedAt` is the webhook event's own timestamp. The dispute object carries
 * only `created`, the day it was OPENED, and a re-credit dated there can land
 * inside a trust period that has since been reconciled and closed. The reversal
 * on `charge.dispute.created` dates at event time for the same reason.
 */
export async function handleDisputeClosed(dispute: any, closedAt?: number, connectedAccountId: string | null = null) {
  if (!dispute || (dispute.status !== 'won' && dispute.status !== 'lost')) return;
  const paymentIntentId = paymentIntentIdOf(dispute);
  if (!(await connectedEventMayTouchPayment(paymentIntentId, connectedAccountId))) return;
  if (dispute.status === 'lost') {
    await announceDisputeLost(paymentIntentId, dispute.amount);
    return;
  }
  await restoreReversedFunds(paymentIntentId, dispute.amount, closedAt || dispute.created, 'dispute won', 'dispute');
}

/**
 * A lost dispute on an invoice payment: the money went back to the cardholder
 * for good. Announced so the client can be told; the firm was already alerted
 * when the dispute reversed the payment. A no-op for anything that is not an
 * invoice payment we recorded.
 */
async function announceDisputeLost(paymentIntentId: string | null, amountCents: any) {
  if (!paymentIntentId) return;
  const match = await invoicesRepo.findInvoicePaymentByStripePaymentIntentAnyFirm(paymentIntentId);
  if (!match) return;
  eventBus.emit(INVOICE_PAYMENT_DISPUTE_LOST, {
    lawFirmId: match.lawFirmId,
    invoiceId: match.invoiceId,
    contextType: match.context.type,
    entityId: match.context.entityId,
    amountCents: Math.max(0, Math.round(Number(amountCents) || 0)),
    paymentIntentId,
  });
}

/**
 * charge.refund.updated handler. A refund we already reversed on charge.refunded can
 * itself FAIL later (e.g. an ACH refund bounces), meaning the money never actually left
 * the firm's account, so the reversal must be undone. Only acts on status 'failed'.
 */
export async function handleRefundUpdated(refund: any, connectedAccountId: string | null = null) {
  if (!refund || refund.status !== 'failed') return;
  const paymentIntentId = paymentIntentIdOf(refund);
  if (!(await connectedEventMayTouchPayment(paymentIntentId, connectedAccountId))) return;
  await restoreReversedFunds(paymentIntentId, refund.amount, refund.created, 'refund failed', 'refund');
}

/**
 * Restore funds that we previously reversed but which came back (a won dispute or a
 * failed refund). Two independent halves, each a no-op for a payment that is not
 * theirs:
 *
 * - the books: re-credit the invoice payment, or re-post / un-reverse the trust deposit;
 * - the cash: give back exactly what automatic recovery took for this payment
 *   intent, to the place it took it from (`stripe_fund_recoveries`).
 *
 * The cash does not follow the books. The ledger can refuse a clawback while the
 * firm's card still paid for it, and a transfer reversal is capped below the charge
 * by the application fee, so neither the ledger nor the invoice says what to return.
 * Runs under the same per-payment-intent lock as the clawback. Idempotent: the trust
 * re-post dedupes on the (non-void) payment intent, and the cash record counts what
 * has already gone back.
 */
async function restoreReversedFunds(
  paymentIntentId: any,
  amountCents: any,
  createdTs: any,
  reason: any,
  kind: 'refund' | 'dispute',
) {
  if (!paymentIntentId) return;
  return withLock(
    'STRIPE_PAYMENT_INTENT',
    paymentIntentId,
    () => restoreReversedFundsLocked(paymentIntentId, amountCents, createdTs, reason, kind),
    { maxHoldMs: STRIPE_PAYMENT_INTENT_LOCK_MAX_HOLD_MS },
  );
}

async function restoreReversedFundsLocked(
  paymentIntentId: any,
  amountCents: any,
  createdTs: any,
  reason: any,
  kind: 'refund' | 'dispute',
) {
  await recreditInvoicePayment(paymentIntentId, amountCents, kind);

  const dep = await trustTxnRepo.findDepositByStripePaymentIntentIncludingVoid(paymentIntentId);
  if (!dep) return;

  await restoreTrustLedger(dep, paymentIntentId, amountCents, createdTs, reason);
  // What came back is the event's amount; with none, everything still held.
  const returnedCents = Math.round(Number(amountCents)) || null;
  await restoreTrustCash({
    lawFirmId: dep.lawFirmId, trustAccountId: dep.trustAccountId, paymentIntentId, amountCents: returnedCents, reason,
  });
}

/**
 * The trust ledger half of a restore. A failure is alerted, not thrown: the cash
 * half still runs, and the money it returns (or never took) is in the trust
 * account whether or not the books show it, so a person has to hear about it.
 */
async function restoreTrustLedger(dep: any, paymentIntentId: any, amountCents: any, createdTs: any, reason: any) {
  const alertUnrecorded = (err: any, cents: number) => {
    console.error('stripe.service: CRITICAL: returned trust funds could not be re-credited to the ledger:', {
      lawFirmId: dep.lawFirmId, paymentIntentId, reason, error: err?.message || err,
    });
    eventBus.emit(TRUST_DEPOSIT_POSTING_FAILED, {
      lawFirmId: dep.lawFirmId,
      trustAccountId: dep.trustAccountId,
      clientId: dep.clientId,
      amountCents: cents,
      paymentIntentId,
      alertKey: `${paymentIntentId}:restore`,
      error: err instanceof AppError ? err.message : null,
    });
  };

  if (dep.status === 'void') {
    // The clawback fully voided the deposit → re-post the whole thing. Idempotent: the
    // re-post dedupes on the (non-void) payment intent, so an already-restored deposit
    // is never double-credited.
    try {
      const { duplicate } = await trustService.createTrustDepositFromStripe({
        lawFirmId: dep.lawFirmId,
        trustAccountId: dep.trustAccountId,
        clientId: dep.clientId,
        // The re-credit must land where the deposit did. Without the matter a
        // matter-tagged retainer would come back at client level only.
        matterId: dep.matterId || null,
        amountCents: dep.amountCents,
        date: stripeDay(createdTs, await firmZone(dep.lawFirmId)),
        stripePaymentIntentId: paymentIntentId,
        description: `Trust deposit re-credited (${reason})`,
      });
      if (!duplicate) {
        eventBus.emit(TRUST_DEPOSIT_RECEIVED, {
          lawFirmId: dep.lawFirmId,
          trustAccountId: dep.trustAccountId,
          clientId: dep.clientId,
          amountCents: dep.amountCents,
          transactionId: null,
          stripePaymentIntentId: paymentIntentId,
        });
      }
    } catch (err: any) {
      alertUnrecorded(err, dep.amountCents);
    }
    return;
  }

  // The deposit is still `completed` but may carry partial reversing withdrawals (a
  // partial refund / partial clawback that did NOT void it). Returned funds must
  // un-reverse up to the amount that came back, or the client's trust balance stays
  // understated versus the actual IOLTA funds. None outstanding (the ledger had
  // refused the clawback) restores nothing here.
  try {
    const { restoredCents } = await trustService.restoreStripeReversal({
      lawFirmId: dep.lawFirmId,
      deposit: dep,
      amountCents: Math.round(amountCents) || 0,
      date: stripeDay(createdTs, await firmZone(dep.lawFirmId)),
      reason,
    });
    if (restoredCents > 0) {
      eventBus.emit(TRUST_DEPOSIT_RECEIVED, {
        lawFirmId: dep.lawFirmId,
        trustAccountId: dep.trustAccountId,
        clientId: dep.clientId,
        amountCents: restoredCents,
        transactionId: null,
        stripePaymentIntentId: paymentIntentId,
      });
    }
  } catch (err: any) {
    alertUnrecorded(err, Math.round(amountCents) || 0);
  }
}

/**
 * Restore a previously-reversed invoice payment. Symmetric to
 * handleInvoicePaymentReversal: adds back up to `recreditCents` of the amount we had
 * reversed for this payment intent, and lowers the stored refunded total accordingly.
 *
 * Only the share that belongs to `kind` comes back. A won dispute returns what that
 * dispute took (`stripeDisputedCents`); a failed refund returns the rest of the
 * reversal, which is what refunds took. Money a refund really sent to the customer
 * therefore stays reversed when a dispute is won. No-op when that share is empty.
 * Idempotent.
 */
async function recreditInvoicePayment(paymentIntentId: any, recreditCents: any, kind: 'refund' | 'dispute') {
  const match = await invoicesRepo.findInvoicePaymentByStripePaymentIntentAnyFirm(paymentIntentId);
  if (!match) return;
  const { lawFirmId, invoiceId, context } = match;

  let restoredThisEvent = 0;
  let surchargeRestoredThisEvent = 0;
  await invoicesRepo.runInvoiceTxn(context, invoiceId, (existing: any) => {
    const payments = [...(existing.payments || [])];
    const idx = payments.findIndex((p) => p.stripePaymentIntentId === paymentIntentId);
    if (idx < 0) return null;
    const entry = payments[idx];
    const alreadyRefunded = entry.stripeRefundedCents || 0;
    const disputed = Math.min(alreadyRefunded, entry.stripeDisputedCents || 0);
    const restorable = kind === 'dispute' ? disputed : alreadyRefunded - disputed;
    const surchargeRefunded = entry.surchargeRefundedCents || 0;
    const surchargeDisputed = Math.min(surchargeRefunded, entry.surchargeDisputedCents || 0);
    const surchargeRestorable = kind === 'dispute' ? surchargeDisputed : surchargeRefunded - surchargeDisputed;
    if (restorable + surchargeRestorable <= 0) return null;
    const returnedCents = Math.max(0, Math.round(recreditCents) || restorable + surchargeRestorable);
    // Undo the cumulative principal-first allocation from the fee end first.
    // This also restores fee-only refunds without crediting invoice money.
    surchargeRestoredThisEvent = Math.min(surchargeRestorable, returnedCents);
    const restore = Math.min(restorable, returnedCents - surchargeRestoredThisEvent);
    restoredThisEvent = restore;
    payments[idx] = {
      ...entry,
      amount: fromCents(toCents(entry.amount) + restore),
      stripeRefundedCents: alreadyRefunded - restore,
      stripeDisputedCents: kind === 'dispute' ? disputed - restore : disputed,
      surchargeRefundedCents: surchargeRefunded - surchargeRestoredThisEvent,
      surchargeDisputedCents: kind === 'dispute' ? surchargeDisputed - surchargeRestoredThisEvent : surchargeDisputed,
    };

    const amountPaidCents = payments.reduce((sum, p) => sum + toCents(p.amount), 0);
    const effectiveTotalCents = toCents(existing.totalAmount || 0) - toCents(existing.totalWrittenOff || 0);
    const isPaid = amountPaidCents >= effectiveTotalCents && effectiveTotalCents > 0;
    return {
      payments,
      amountPaid: fromCents(amountPaidCents),
      isPaid,
      paidDate: isPaid ? (existing.paidDate || new Date().toISOString()) : null,
      updatedAt: new Date().toISOString(),
    };
  });

  if (restoredThisEvent + surchargeRestoredThisEvent <= 0) return;
  if (restoredThisEvent > 0) eventBus.emit(INVOICE_PAYMENT_RECREDITED, {
    lawFirmId, invoiceId, contextType: context.type, entityId: context.entityId,
    restoredCents: restoredThisEvent, paymentIntentId,
  });

  // The funds came back to the platform (won dispute / failed refund) but we had
  // clawed them out of the firm's connected balance on reversal, so push them back
  // to the firm to match the re-credited invoice.
  // A direct charge's funds came back to the firm's own account; nothing to push.
  if (match.chargeModel === 'direct') return;
  await restoreConnectedTransfer({ lawFirmId, paymentIntentId, amountCents: restoredThisEvent + surchargeRestoredThisEvent, reason: 'invoice restore' });
}

/**
 * Charge a firm's card on file immediately for a fee, off their Paralegix
 * subscription customer's default payment method. Creates a standalone invoice with
 * only this fee item and pays it now, so the platform never fronts the fee (versus
 * adding an invoice item that would only settle on the next monthly invoice).
 * `pending_invoice_items_behavior: 'exclude'` keeps unrelated pending items off this
 * one-off invoice. Throws if the charge cannot complete (no payment method on file,
 * declined, or authentication required); returns the paid invoice id.
 *
 * `idempotencyKey` (required for fee charges) makes the whole create→pay sequence
 * safe to retry: the dedupe between "recorded the fee" and "charged the card" is not
 * atomic, so a crash after the charge but before the row is marked billed, or a sweep
 * running concurrently with the settlement webhook, would otherwise charge the firm
 * twice. Stripe replays the same key (within its 24h window) so the firm is charged at
 * most once per key; distinct suffixes keep the four calls independently idempotent.
 */
/**
 * Charge (or finish charging) one accrued trust ACH fee to the firm's operating card
 * and mark it billed. Fully idempotent across retries and beyond Stripe's 24h
 * idempotency-key TTL: the finalized fee invoice id is persisted on the fee row
 * BEFORE the pay call, so a later retry reuses that invoice — paying it if still open,
 * or just marking it billed if already paid — instead of ever creating a second
 * charge. Throws on a hard charge failure (declined / no card / SCA) so the caller
 * can leave the fee accrued for the sweep to retry.
 */
async function chargeAccruedTrustFee({ feeId, lawFirmId, trustTransactionId, feeCents, customerId, existingInvoiceId }: any) {
  const idemBase = `trust_fee_${trustTransactionId}`;
  const description = 'Trust deposit ACH processing fee';
  const metadata = { lawFirmId, trustTransactionId };

  let invoiceId = existingInvoiceId || null;
  if (invoiceId) {
    // Reuse the invoice a prior attempt already created rather than charging again.
    const existing = await stripe.invoices.retrieve(invoiceId).catch(() => null);
    if (!existing || existing.status === 'void' || existing.status === 'uncollectible') {
      invoiceId = null; // gone/unusable → create a fresh one
    } else if (existing.status === 'paid') {
      await markTrustDepositFeeBilled(lawFirmId, feeId, invoiceId);
      return invoiceId; // already charged on a prior attempt; just record it
    }
    // 'open' / 'draft' fall through to (re)pay below.
  }

  if (!invoiceId) {
    const opts = (suffix: any) => ({ idempotencyKey: `${idemBase}_${suffix}` });
    const draft = await stripe.invoices.create({
      customer: customerId,
      collection_method: 'charge_automatically',
      auto_advance: false,
      pending_invoice_items_behavior: 'exclude',
      description,
      metadata,
    }, opts('inv'));
    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: draft.id,
      amount: feeCents,
      currency: 'usd',
      description,
      metadata,
    }, opts('item'));
    const finalized = await stripe.invoices.finalizeInvoice(draft.id, opts('final'));
    invoiceId = finalized.id;
    // Persist BEFORE paying so a retry reuses this invoice instead of charging twice.
    await attachTrustDepositFeeInvoice(lawFirmId, feeId, invoiceId);
  }

  try {
    await stripe.invoices.pay(invoiceId, { idempotencyKey: `${idemBase}_pay` });
  } catch (err: any) {
    // Paying an already-paid invoice throws; treat that as success, rethrow otherwise.
    const fresh = await stripe.invoices.retrieve(invoiceId).catch(() => null);
    if (!fresh || fresh.status !== 'paid') throw err;
  }
  await markTrustDepositFeeBilled(lawFirmId, feeId, invoiceId);
  return invoiceId;
}

/**
 * Charge the firm UP FRONT for the ACH processing fee on a trust deposit — a
 * standalone charge to their card on file at settlement, so Paralegix never fronts
 * it. Idempotent: the fee is recorded once per deposit and charged via
 * chargeAccruedTrustFee (reuses the persisted fee invoice, never double-charges). Runs
 * on a first delivery AND a webhook retry — if a prior delivery accrued the fee but
 * did not bill it, this finishes the charge. If the up-front charge fails (no card,
 * declined), the fee is left accrued for the sweep to retry; the deposit is untouched.
 */
async function billFirmForTrustAchFee({ lawFirmId, trustTransactionId, amountCents }: any) {
  const feeCents = computeTrustAchFeeCents(amountCents);
  if (feeCents <= 0) return;

  const { feeId, alreadyExisted } = await recordTrustDepositFee({ lawFirmId, trustTransactionId, feeCents });

  // Resolve the current fee row so a retry can finish an accrued-but-unbilled fee.
  let fee = { id: feeId, status: 'accrued', feeCents, stripeInvoiceId: null };
  if (alreadyExisted || !feeId) {
    fee = await findTrustDepositFee(lawFirmId, trustTransactionId);
    if (!fee || fee.status !== 'accrued') return; // billed/waived/missing → nothing to do
  }

  const firmData = await lawfirmsRepo.findById(lawFirmId);
  const customerId = firmData?.plan?.stripeCustomerId || null;
  if (!stripe || !customerId) {
    // No subscription customer to charge yet; leave accrued for the sweep to retry.
    console.warn('stripe.service: trust ACH fee accrued but firm has no subscription customer to charge:', { lawFirmId, trustTransactionId, feeCents: fee.feeCents });
    return;
  }

  try {
    await chargeAccruedTrustFee({
      feeId: fee.id, lawFirmId, trustTransactionId, feeCents: fee.feeCents,
      customerId, existingInvoiceId: fee.stripeInvoiceId,
    });
  } catch (err: any) {
    // Up-front charge failed (no card on file, declined, or SCA). Leave the fee
    // accrued so the sweep retries; never fail the trust deposit (funds already
    // landed in trust).
    console.warn('stripe.service: up-front trust ACH fee charge failed, left accrued for retry:', { lawFirmId, trustTransactionId, feeCents: fee.feeCents, error: err?.message || err });
  }
}

/**
 * Retry trust deposit fees that were recorded but not charged up front — because the
 * firm had no subscription customer at settlement, or the up-front card charge failed.
 * Charges each firm's card on file now and marks the fee billed. Safe to run
 * repeatedly (only touches `status='accrued'` rows) and never double-charges (reuses
 * the persisted fee invoice). Intended for a scheduled sweep. Returns a summary.
 *
 * `limit` bounds the sweep by row count; `deadline` (epoch ms, shared across the
 * cron request) bounds it by wall clock, since each fee is a serial card charge
 * against Stripe and 500 of them have no bounded duration. A fee not reached
 * stays `accrued` and is picked up by the next run.
 */
export async function sweepAccruedTrustFees({ limit = 500, deadline = null }: any = {}) {
  if (!stripe) throw new AppError('Payment processing is not available', 503, 'STRIPE_NOT_CONFIGURED');
  const fees = await listAccruedTrustDepositFees(limit);
  const summary = { scanned: fees.length, processed: 0, billed: 0, skippedNoCustomer: 0, truncated: false, failures: [] as any[] };
  const customerCache = new Map(); // lawFirmId -> customerId | null

  for (const fee of fees) {
    if (deadline && Date.now() >= deadline) { summary.truncated = true; break; }
    summary.processed += 1;
    try {
      if (!customerCache.has(fee.lawFirmId)) {
        const firm = await lawfirmsRepo.findById(fee.lawFirmId);
        customerCache.set(fee.lawFirmId, firm?.plan?.stripeCustomerId || null);
      }
      const customerId = customerCache.get(fee.lawFirmId);
      if (!customerId) { summary.skippedNoCustomer += 1; continue; }

      await chargeAccruedTrustFee({
        feeId: fee.id, lawFirmId: fee.lawFirmId, trustTransactionId: fee.trustTransactionId,
        feeCents: fee.feeCents, customerId, existingInvoiceId: fee.stripeInvoiceId,
      });
      summary.billed += 1;
    } catch (err: any) {
      summary.failures.push({ feeId: fee.id, lawFirmId: fee.lawFirmId, error: err.message });
    }
  }
  if (summary.truncated) {
    console.warn(
      `stripe.service: trust fee sweep budget exhausted after ${summary.processed}/${summary.scanned} accrued fee(s); ` +
      'the rest stay accrued for the next run'
    );
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/*  Connect fund recovery (dispute / refund / ACH return)            */
/* ------------------------------------------------------------------ */

/**
 * Best-effort payout hardening for a connected account. Sets a payout-schedule
 * delay so client funds stay in the account's recoverable Stripe balance during
 * the dispute / ACH-return window. For operating accounts we also allow Stripe to
 * debit the account's external bank to cover a negative balance; for TRUST
 * accounts we never do (that bank is an IOLTA holding client money). Not gated by
 * AUTO_RECOVERY_ENABLED — it only positions funds, it never moves money. Failure
 * is swallowed: it must never block onboarding.
 */
async function applyConnectPayoutHardening(accountId: any, { trust = false }: any = {}) {
  if (!stripe || !accountId) return;
  try {
    await updateConnectPayoutSettings(accountId, { trust });
  } catch (err: any) {
    console.warn('stripe.service: could not apply payout hardening to connected account:', {
      accountId, trust, error: err?.message || err,
    });
  }
}

/**
 * Apply the payout hardening settings to a single connected account and THROW on
 * failure. Single source of the settings shape, shared by onboarding (via the
 * swallow-and-warn wrapper above) and the harden-connect-payouts backfill script
 * (which needs to collect per-account failures). Payout-schedule delay keeps
 * client funds in the recoverable Stripe balance through the dispute / ACH-return
 * window; debit_negative_balances lets Stripe recover a clawback from the account's
 * own bank for OPERATING accounts, and is left OFF for TRUST accounts whose bank is
 * an IOLTA holding client money.
 */
export async function updateConnectPayoutSettings(accountId: any, { trust = false }: any = {}) {
  if (!stripe) throw new AppError('Payment processing is not available', 503, 'STRIPE_NOT_CONFIGURED');
  // Internal function parameter, never sourced from user input directly: a
  // missing value here is a programming bug, not user-actionable input. A
  // generic Error becomes a scrubbed 500.
  if (!accountId) throw new Error('accountId is required');
  await stripe.accounts.update(accountId, {
    settings: {
      payouts: {
        schedule: { interval: 'daily', delay_days: CONNECT_PAYOUT_DELAY_DAYS },
        debit_negative_balances: !trust,
      },
    },
  });
}

/**
 * Resolve the Transfer created for a destination charge from its payment intent.
 * Returns { transferId, amount, amountReversed } or null when there is no transfer
 * (e.g. not a destination charge).
 */
async function getDestinationTransferForPaymentIntent(paymentIntentId: any) {
  if (!stripe || !paymentIntentId) return null;
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
  const charge = pi && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const transferId = charge
    ? (typeof charge.transfer === 'string' ? charge.transfer : (charge.transfer && charge.transfer.id) || null)
    : null;
  if (!transferId) return null;
  const transfer = await stripe.transfers.retrieve(transferId);
  return {
    transferId,
    amount: transfer.amount,
    amountReversed: transfer.amount_reversed || 0,
  };
}

/**
 * Claw disputed/refunded/returned funds back OUT of a connected account by
 * reversing the destination transfer, so the platform (which Stripe debits for a
 * dispute/refund/ACH return on a destination charge) is made whole from that
 * account's balance. Reverses up to `recoverCents`, capped at the transfer's
 * un-reversed balance (so it never over-reverses across multiple partial events),
 * and records what it took so a won dispute or a failed refund gives back exactly
 * that. `source` names the account the transfer paid: the firm's operating
 * account for an invoice payment, the trust account for a deposit. Best-effort:
 * a failure (empty balance / already paid out) is logged, never thrown. Returns
 * the cents actually reversed. Gated by AUTO_RECOVERY_ENABLED.
 */
async function recoverConnectedTransfer({
  paymentIntentId, recoverCents, reason, idempotencyKey, lawFirmId = null, source = 'firm_transfer',
}: {
  paymentIntentId: any;
  recoverCents: number;
  reason: string;
  idempotencyKey?: string;
  lawFirmId?: string | null;
  source?: FundRecoverySource;
}) {
  if (!paymentIntentId || !recoverCents || recoverCents <= 0) return 0;
  if (!AUTO_RECOVERY_ENABLED) {
    console.warn('stripe.service: [recovery disabled] would reverse transfer to recover funds:', {
      paymentIntentId, recoverCents, reason,
    });
    return 0;
  }
  let reversal: any;
  let toReverse = 0;
  try {
    const t = await getDestinationTransferForPaymentIntent(paymentIntentId);
    if (!t) return 0;
    const available = Math.max(0, t.amount - t.amountReversed);
    toReverse = Math.min(Math.round(recoverCents), available);
    if (toReverse <= 0) return 0;
    // Idempotency key keyed on (payment intent, cumulative target): a webhook retry
    // for the same clawback re-sends the same key so Stripe dedupes the reversal
    // rather than pulling the delta from the connected account twice.
    reversal = await stripe.transfers.createReversal(t.transferId, {
      amount: toReverse,
      metadata: { paymentIntentId, reason: (reason || 'recovery').slice(0, 200) },
    }, idempotencyKey ? { idempotencyKey } : undefined);
  } catch (err: any) {
    console.error('stripe.service: transfer reversal recovery failed (platform may be out of pocket):', {
      paymentIntentId, recoverCents, reason, error: err?.message || err,
    });
    return 0;
  }
  const firmId = lawFirmId
    || (await invoicesRepo.findInvoicePaymentByStripePaymentIntentAnyFirm(paymentIntentId).catch(() => null))?.lawFirmId
    || null;
  await recordRecoveredCash({ lawFirmId: firmId, paymentIntentId, source, stripeObjectId: reversal?.id, cents: toReverse });
  return toReverse;
}

/**
 * Write down cash recovery took back. Never throws: the money has already moved,
 * and failing the webhook would only make Stripe retry a recovery that is done.
 * A lost record means a later restore cannot return these cents, so it is
 * logged as critical for a person to return them by hand.
 */
async function recordRecoveredCash({ lawFirmId, paymentIntentId, source, stripeObjectId, cents }: {
  lawFirmId: string | null;
  paymentIntentId: string;
  source: FundRecoverySource;
  stripeObjectId: string | null | undefined;
  cents: number;
}) {
  try {
    if (!lawFirmId || !stripeObjectId) throw new Error('no firm or Stripe object to record the recovery against');
    await recordFundRecovery({ lawFirmId, paymentIntentId, source, stripeObjectId, recoveredCents: cents });
  } catch (err: any) {
    console.error('stripe.service: CRITICAL: recovered cash was not recorded, so a won dispute or failed refund will not return it automatically:', {
      lawFirmId, paymentIntentId, source, stripeObjectId, cents, error: err?.message || err,
    });
  }
}

/**
 * Give back up to `maxCents` (null: all) of the recorded recoveries in `rows`,
 * oldest first, through `send`. Each call's idempotency key names the recovery
 * and how much of it had already gone back, so a retry after a crash between the
 * Stripe call and the write that counts it repeats the same call, and Stripe
 * hands back the same object instead of moving the money twice. Throws when a
 * Stripe call fails; the caller logs it. Returns the cents given back.
 */
async function returnRecoveredCash(
  lawFirmId: string,
  rows: FundRecovery[],
  maxCents: number | null,
  keyPrefix: string,
  send: (row: FundRecovery, cents: number, idempotencyKey: string) => Promise<unknown>,
) {
  let remaining = maxCents == null ? Number.POSITIVE_INFINITY : Math.max(0, Math.round(maxCents));
  let returned = 0;
  for (const row of rows) {
    const cents = Math.min(remaining, row.recoveredCents - row.restoredCents);
    if (cents <= 0) break;
    await send(row, cents, `${keyPrefix}_${row.stripeObjectId}_${row.restoredCents}_${cents}`);
    if (!(await markRecoveryRestored(lawFirmId, row, cents))) {
      console.warn('stripe.service: a recovery was counted as returned by another restore at the same time:', {
        lawFirmId, recoveryId: row.id, cents,
      });
    }
    remaining -= cents;
    returned += cents;
  }
  return returned;
}

const heldCents = (rows: FundRecovery[]) => rows.reduce((sum, r) => sum + (r.recoveredCents - r.restoredCents), 0);

/**
 * Push funds BACK to a firm's operating connected account after we clawed them
 * back but the dispute was later WON / the refund FAILED (the money is the firm's
 * after all). Sends at most what recovery recorded taking from that account for
 * this payment intent: on a destination charge the transfer, and so the
 * recovery, was capped below the charge by the application fee, which went to
 * Paralegix and never to the firm. Best-effort, gated by AUTO_RECOVERY_ENABLED.
 * Invoice payments only; trust restoration is `restoreTrustCash`.
 */
async function restoreConnectedTransfer({ lawFirmId, paymentIntentId, amountCents, reason }: any) {
  if (!lawFirmId || !paymentIntentId || !amountCents || amountCents <= 0) return;
  if (!AUTO_RECOVERY_ENABLED) {
    console.warn('stripe.service: [recovery disabled] would restore funds to connected account:', {
      lawFirmId, paymentIntentId, amountCents, reason,
    });
    return;
  }
  try {
    const rows = await listOutstandingRecoveries(lawFirmId, paymentIntentId, 'firm_transfer');
    if (!rows.length) return;
    const firm = await lawfirmsRepo.findById(lawFirmId);
    const destination = firm?.stripeAccountId || null;
    if (!destination) {
      console.error('stripe.service: CRITICAL: recovered invoice funds cannot be returned, the firm has no connected account:', {
        lawFirmId, paymentIntentId, heldCents: heldCents(rows),
      });
      return;
    }
    await returnRecoveredCash(lawFirmId, rows, amountCents, 'restore', (_row, cents, idempotencyKey) => stripe.transfers.create({
      amount: cents,
      currency: 'usd',
      destination,
      metadata: { paymentIntentId: paymentIntentId || '', reason: (reason || 'restore').slice(0, 200) },
    }, { idempotencyKey }));
  } catch (err: any) {
    console.error('stripe.service: failed to restore funds to connected account after won dispute/failed refund:', {
      lawFirmId, paymentIntentId, amountCents, reason, error: err?.message || err,
    });
  }
}

/**
 * After a clawed-back trust deposit's funds come back (won dispute / failed refund),
 * return the cash recovery took, to where it took it from, up to `amountCents`
 * (null: all of it). First refund the charges made to the firm's operating card;
 * then push the rest back INTO the trust connected account, but only what was
 * reversed out of it. This follows the recovery record, not the ledger: when the
 * ledger refused the clawback, the firm's card paid and the trust account gave up
 * nothing, so the firm is refunded and trust receives nothing. A card refund that
 * fails is never redirected into trust, which would over-fund the IOLTA with the
 * firm's money. Best-effort, gated by AUTO_RECOVERY_ENABLED (the clawback that
 * created the imbalance only runs when recovery is enabled).
 */
async function restoreTrustCash({ lawFirmId, trustAccountId, paymentIntentId, amountCents, reason }: {
  lawFirmId: string;
  trustAccountId: string;
  paymentIntentId: string;
  amountCents: number | null;
  reason: string;
}) {
  if (amountCents != null && amountCents <= 0) return;
  if (!AUTO_RECOVERY_ENABLED) {
    console.warn('stripe.service: [recovery disabled] would restore recovered trust deposit cash:', {
      lawFirmId, paymentIntentId, amountCents, reason,
    });
    return;
  }

  let cardRows: FundRecovery[] = [];
  let trustRows: FundRecovery[] = [];
  try {
    cardRows = await listOutstandingRecoveries(lawFirmId, paymentIntentId, 'firm_card');
    trustRows = await listOutstandingRecoveries(lawFirmId, paymentIntentId, 'trust_transfer');
  } catch (err: any) {
    console.error('stripe.service: CRITICAL: could not read what was recovered for a returned trust deposit; return it manually:', {
      lawFirmId, paymentIntentId, amountCents, error: err?.message || err,
    });
    return;
  }

  // The firm's card is refunded first, so trust gets only what is left of the
  // returned amount after the card's share, whether or not that refund succeeds.
  const cardHeld = heldCents(cardRows);
  const trustBudget = amountCents == null ? null : amountCents - Math.min(amountCents, cardHeld);

  if (cardRows.length) {
    try {
      await returnRecoveredCash(lawFirmId, cardRows, amountCents, 'trust_clawback_refund', (row, cents, idempotencyKey) => stripe.refunds.create(
        { payment_intent: row.stripeObjectId, amount: cents, metadata: { trustClawbackPaymentIntentId: paymentIntentId } },
        { idempotencyKey },
      ));
    } catch (err: any) {
      console.error('stripe.service: CRITICAL: trust clawback funds returned but the firm operating-card charge could not be refunded; refund it manually:', {
        lawFirmId, paymentIntentId, cardHeld, error: err?.message || err,
      });
    }
  }

  if (!trustRows.length || trustBudget === 0) return;
  try {
    const account = await trustAccountRepo.findById(lawFirmId, trustAccountId);
    const destination = account?.stripeConnectedAccountId || null;
    if (!destination) {
      console.error('stripe.service: CRITICAL: recovered trust funds cannot be returned, the trust account has no connected account:', {
        lawFirmId, trustAccountId, paymentIntentId, heldCents: heldCents(trustRows),
      });
      return;
    }
    await returnRecoveredCash(lawFirmId, trustRows, trustBudget, 'restore', (_row, cents, idempotencyKey) => stripe.transfers.create({
      amount: cents,
      currency: 'usd',
      destination,
      metadata: { paymentIntentId: paymentIntentId || '', reason: `trust restore ${reason || ''}`.slice(0, 200) },
    }, { idempotencyKey }));
  } catch (err: any) {
    console.error('stripe.service: failed to restore cash to trust connected account after returned funds:', {
      lawFirmId, paymentIntentId, trustBudget, reason, error: err?.message || err,
    });
  }
}

/**
 * Recover a clawed-back trust deposit's principal from the firm's OPERATING card
 * (its Paralegix subscription customer's default payment method). Used for what the
 * trust transfer could not cover, and for the whole clawback when the ledger
 * refused it, because then the client's funds are already spent and the trust
 * account's pooled balance belongs to other clients. Never touches the client
 * trust bank. Idempotent per payment intent and cumulative target via a Stripe
 * idempotency key, so multiple clawback events (refund + dispute, or a webhook
 * replay) charge the firm at most once each; a completed charge is recorded so a
 * won dispute refunds exactly it. Best-effort, gated by AUTO_RECOVERY_ENABLED.
 */
async function chargeFirmForTrustClawback({ lawFirmId, paymentIntentId, amountCents, idempotencySuffix }: any) {
  if (!amountCents || amountCents <= 0) return;
  if (!AUTO_RECOVERY_ENABLED) {
    console.warn('stripe.service: [recovery disabled] would charge firm operating card for trust clawback shortfall:', {
      lawFirmId, paymentIntentId, amountCents,
    });
    return;
  }
  if (!stripe) return;
  const firm = await lawfirmsRepo.findById(lawFirmId);
  const customerId = firm?.plan?.stripeCustomerId || null;
  if (!customerId) {
    console.error('stripe.service: CRITICAL: cannot recover trust clawback, firm has no subscription customer:', { lawFirmId, paymentIntentId, amountCents });
    return;
  }
  const customer = await stripe.customers.retrieve(customerId);
  const pm = customer && !customer.deleted ? (customer.invoice_settings?.default_payment_method || null) : null;
  if (!pm) {
    console.error('stripe.service: CRITICAL: cannot recover trust clawback, firm has no default payment method:', { lawFirmId, paymentIntentId, amountCents });
    return;
  }
  const recovery = await stripe.paymentIntents.create(
    {
      amount: Math.round(amountCents),
      currency: 'usd',
      customer: customerId,
      payment_method: typeof pm === 'string' ? pm : pm.id,
      off_session: true,
      confirm: true,
      description: 'Recovery of returned trust deposit (ACH return/dispute)',
      metadata: { lawFirmId, trustClawbackPaymentIntentId: paymentIntentId || '' },
    },
    // Suffix with the cumulative target so each partial clawback charges once while
    // a replay of the same event still dedupes.
    { idempotencyKey: `trust_clawback_${paymentIntentId}${idempotencySuffix ? `_${idempotencySuffix}` : ''}` },
  );

  if (recovery?.status === 'succeeded' || recovery?.status === 'processing') {
    await recordRecoveredCash({
      lawFirmId, paymentIntentId, source: 'firm_card', stripeObjectId: recovery.id, cents: Math.round(amountCents),
    });
  } else {
    console.error('stripe.service: CRITICAL: trust clawback charge to the firm card did not complete:', {
      lawFirmId, paymentIntentId, amountCents, recoveryPaymentIntentId: recovery?.id, status: recovery?.status,
    });
  }

  await notifyFirmOfClawbackCharge(lawFirmId, Math.round(amountCents), recovery.id);
}

/**
 * Tell the firm their card was charged to make a trust account whole.
 *
 * Two reasons this must reach a person rather than a log line: the firm is
 * entitled to know their card was charged off-session and why, and the charge's
 * reference is what a person needs if the automatic refund on a won dispute
 * (`restoreTrustCash`, from the `stripe_fund_recoveries` record) cannot run.
 *
 * Best-effort and isolated: the money has already moved, and a failure to notify
 * must not turn a completed recovery into an error the caller retries.
 */
export async function notifyFirmOfClawbackCharge(lawFirmId: string, amountCents: number, recoveryPaymentIntentId: string) {
  try {
    const { createNotifications, FRONTEND_URL: NOTIFY_URL } = require('../notifications/notifications.service');
    const { rows } = await financialRootSql(
      `select distinct m.user_id
         from members m
         left join roles r on r.law_firm_id = m.law_firm_id and r.id = m.role_id
        where m.law_firm_id = $1
          and (m.is_owner = true or 'trust.manage' = any(coalesce(r.permissions, '{}')))`,
      [lawFirmId],
    );
    const recipients = rows.map((x: any) => x.user_id).filter(Boolean);
    if (!recipients.length) return;

    // No entityType: the notifications table restricts it to
    // task/matter/invoice/message/note/file, and a recovery charge is none of
    // them. The reference travels in the body, where a human can copy it.
    await createNotifications(lawFirmId, recipients, {
      type: 'trust_clawback_charged',
      title: 'Your card was charged to cover a returned trust deposit',
      body: `A trust deposit was returned or disputed and the funds had already left the trust `
        + `account, so ${formatDollarsFromCents(amountCents)} was charged to your firm's card to make `
        + `the trust account whole. If the dispute is later resolved in your favour, this charge is `
        + `refunded manually: reference ${recoveryPaymentIntentId}.`,
      actionUrl: `${NOTIFY_URL}/lawfirm/${lawFirmId}/trust`,
    });
  } catch (err: any) {
    console.error('stripe.service: failed to notify the firm of a trust clawback charge:', {
      lawFirmId, recoveryPaymentIntentId, amountCents, message: err.message,
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Webhook handlers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Handle checkout.session.completed (and async_payment_succeeded): record the
 * payment on the invoice and end the payment request it answered.
 */
export async function handleCheckoutCompleted(session: any) {
  // Only record a payment once the money is actually collected. A synchronous method
  // (card) carries payment_status 'paid' on checkout.session.completed; a delayed
  // method (e.g. a bank debit) fires 'unpaid'/'processing' here and settles later on
  // checkout.session.async_payment_succeeded. Recording on an unpaid session would
  // mark the invoice paid and end the payment request before the funds
  // arrive, leaving the invoice "paid" if the payment then fails. The offline
  // reconciler applies the same payment_status gate.
  if (!isInvoiceCheckoutSession(session)) {
    logNonInvoiceCheckout(session, 'handleCheckoutCompleted');
    return;
  }
  if (session.payment_status && session.payment_status !== 'paid') {
    return;
  }
  const candidate = buildStripeCandidateFromCheckoutSession(session, await firmZone(session.metadata?.lawFirmId));
  let result;
  try {
    result = await applyStripeCandidateTransaction(candidate);
  } catch (err: any) {
    // The Paralegix invoice was deleted after the payment link was created. ACK the
    // webhook (return, don't throw) so Stripe stops retrying forever; log enough to
    // investigate a payment collected against a now-missing invoice.
    if (err.code === 'STRIPE_INVOICE_NOT_FOUND') {
      console.error('stripe.service: checkout payment for a deleted invoice, acking webhook:', {
        lawFirmId: candidate.lawFirmId,
        invoiceId: candidate.invoiceId,
        paymentIntentId: candidate.stripePaymentIntentId,
        amountPaid: candidate.amountPaid,
      });
      return;
    }
    throw err;
  }
  if (!result.applied) return;
  await finishAppliedStripePayment(candidate, result);
}

/**
 * The work after a Stripe payment is newly recorded on an invoice: refresh the
 * invoice's calendar entry and announce the payment. The payment is committed,
 * so nothing here may fail the caller: a webhook 500 makes Stripe retry, the
 * retry finds the payment already recorded and returns early, and the
 * announcement is then lost for good. A failure is logged instead.
 */
export async function finishAppliedStripePayment(candidate: any, result: any) {
  try {
    await invoicesService.refreshInvoiceCalendarSyncAfterPersistence({
      lawFirmId: candidate.lawFirmId,
      context: result.context,
      invoiceId: candidate.invoiceId,
      actingUserId: candidate.clientUserId || null,
    });
  } catch (calErr: any) {
    console.error('stripe.service: calendar sync after a Stripe payment failed:', calErr?.message || calErr);
  }

  // The invoice is the one the transaction just wrote, not a second read of it.
  const updatedInvoice = result.invoice;

  try {
    emitStripePaymentReceived(candidate, updatedInvoice);
  } catch (err: any) {
    console.error('stripe.service: could not announce a committed Stripe payment:', {
      lawFirmId: candidate.lawFirmId,
      invoiceId: candidate.invoiceId,
      paymentIntentId: candidate.stripePaymentIntentId,
      message: err?.message || err,
    });
  }
}

/**
 * Emit the unified INVOICE_PAYMENT_RECEIVED payload for a Stripe-applied payment,
 * the same contract the manual recordPayment path emits (so the firm email
 * renders the amount and invoice name, and partial Stripe payments notify too).
 * It is reached only when the payment was newly applied, so it is also where
 * the `client_invoice_paid` analytics event is reported, once per payment.
 */
function emitStripePaymentReceived(candidate: any, updatedInvoice: any) {
  eventBus.emit(INVOICE_PAYMENT_RECEIVED, {
    lawFirmId: candidate.lawFirmId,
    invoiceId: candidate.invoiceId,
    contextType: candidate.contextType,
    entityId: candidate.entityId,
    amountPaidCents: Math.round((candidate.amountPaid || 0) * 100),
    // A processing fee the client paid on top, if any. Not invoice money.
    surchargeCents: candidate.surchargeCents || 0,
    // How the client paid ('card' or 'bank'), so the receipt names the fee.
    paymentMethod: candidate.paymentMethod || null,
    paymentDate: candidate.paymentDate || null,
    source: 'stripe',
    isFullyPaid: updatedInvoice ? updatedInvoice.isPaid === true : false,
    // The legal client the money is for, kept separate from the uid that paid.
    clientRecordId: candidate.clientRecordId || null,
    clientUserId: candidate.clientUserId || null,
    // The client (not a firm member) triggered this payment; pass their id as the
    // actor so firm self-notify exclusion is a harmless no-op.
    actorUserId: candidate.clientUserId || null,
    invoiceName: updatedInvoice?.invoiceName || updatedInvoice?.invoiceNumber || candidate.invoiceId,
    invoiceCreatedBy: updatedInvoice?.createdBy || null,
    billingEmail: updatedInvoice?.billingEmail || null,
    // What the firm owes back after this payment (a payment on a voided invoice, or
    // one past the total), in cents; null when the payment is simply owed. The same
    // payment never reaches this emit twice, and the payment's own Stripe id keys
    // the notification besides.
    refundDue: updatedInvoice ? deriveRefundDue(updatedInvoice) : null,
    invoiceVoided: updatedInvoice?.status === 'voided',
    stripePaymentRef: candidate.stripePaymentIntentId || candidate.stripeSessionId || null,
  });

  // Product analytics for the same first-time application. Ids, enums and
  // booleans only: no amount, and nothing about the client who paid.
  captureServerEvent({
    event: 'client_invoice_paid',
    lawFirmId: candidate.lawFirmId,
    properties: {
      invoice_id: candidate.invoiceId,
      payment_flow: candidate.paymentFlow || 'checkout',
      context_type: candidate.contextType || null,
      charge_model: candidate.chargeModel || null,
      is_installment: Boolean(candidate.installmentId),
      is_fully_paid: updatedInvoice ? updatedInvoice.isPaid === true : false,
    },
  });
}

/**
 * Handle checkout.session.expired: clear the session ID. The payment request
 * stays open: the client can open the pay link again and start a new session.
 */
export async function handleCheckoutExpired(session: any) {
  const { lawFirmId, invoiceId, contextType, entityId } = session.metadata || {};

  if (!lawFirmId || !invoiceId || !contextType || !entityId) return;

  const context = { type: contextType, lawFirmId, entityId };

  // Read and written under the invoice row lock like every other pointer write,
  // so a concurrent request cannot mint a fresh session between the check and
  // the clear. No voided-invoice refusal: a voided invoice still gets its
  // pointer cleared.
  await invoicesRepo.runInvoiceTxn(context, invoiceId, (invoice: any) => {
    if (invoice.stripePaymentStatus === 'completed') return null;
    // `getClientCheckoutUrl` expires an amount-mismatched session and mints a
    // fresh one; the old session's expiry then arrives naming the OLD id. Clearing
    // on it would drop the fresh pointer and every portal visit would mint again.
    if (invoice.stripeCheckoutSessionId && invoice.stripeCheckoutSessionId !== session.id) return null;
    return {
      stripeCheckoutSessionId: null,
      stripeCheckoutSessionAccountId: null,
      updatedAt: new Date(),
    };
  });
}

/**
 * Handle checkout.session.async_payment_failed: a delayed payment method (e.g. a bank
 * debit) started at checkout later failed, so no funds arrived. handleCheckoutCompleted
 * only records a 'paid' session, so there is nothing to reverse here; just clear the
 * pending checkout session marker so the invoice can be requested again.
 */
export async function handleCheckoutAsyncPaymentFailed(session: any) {
  if (!isInvoiceCheckoutSession(session)) {
    logNonInvoiceCheckout(session, 'handleCheckoutAsyncPaymentFailed');
    return;
  }
  const { lawFirmId, invoiceId, contextType, entityId } = session.metadata || {};

  const context = { type: contextType, lawFirmId, entityId };
  // Locked read-then-write; see handleCheckoutExpired.
  await invoicesRepo.runInvoiceTxn(context, invoiceId, (invoice: any) => {
    if (invoice.stripePaymentStatus === 'completed') return null;
    // Only the session we still point at may fail us.
    if (invoice.stripeCheckoutSessionId && invoice.stripeCheckoutSessionId !== session.id) return null;
    return {
      stripeCheckoutSessionId: null,
      stripeCheckoutSessionAccountId: null,
      stripePaymentStatus: 'failed',
      updatedAt: new Date(),
    };
  });
}

/**
 * Handle account.updated: refresh cached Connect status. The same event type covers
 * both a firm's operating account and a trust account's connected (trust bank)
 * account, distinguished by which record owns the Stripe account id (also flagged by
 * metadata.purpose === 'trust' on trust accounts).
 */
export async function handleAccountUpdated(account: any) {
  // Trust connected accounts first: resolve the owning firm + trust account from the
  // Stripe account id and update the trust_accounts row.
  const trustRef = await findTrustAccountByStripeConnectedAccountId(account.id);
  if (trustRef) {
    await trustAccountRepo.update(trustRef.lawFirmId, trustRef.id, {
      stripeChargesEnabled: account.charges_enabled || false,
      stripeOnboardingComplete: account.details_submitted || false,
    });
    return;
  }

  // Otherwise it's a firm's operating account.
  const firm = await lawfirmsRepo.findByStripeAccountId(account.id);
  if (!firm) return;

  await lawfirmsRepo.update(firm.id, {
    stripeChargesEnabled: account.charges_enabled || false,
    stripeOnboardingComplete: account.details_submitted || false,
  });
}

/** Stripe rejected the request itself (the object is in a state it cannot be changed from), not the connection. */
function isInvalidRequest(err: any): boolean {
  return err?.type === 'StripeInvalidRequestError' || err?.rawType === 'invalid_request_error';
}

/** An object's status as Stripe reports it now, or null when it cannot be read. */
async function statusNow(read: () => Promise<{ status?: string }>): Promise<string | null> {
  try {
    return (await read()).status ?? null;
  } catch {
    return null;
  }
}


/**
 * Close the Stripe surfaces that can still take money for an invoice the firm
 * is cancelling, deleting or re-requesting: the checkout session opened from
 * its payment link or the portal, and a card-form payment waiting on the
 * client's bank verification.
 *
 * Reads it first and changes nothing if it has already collected, or is
 * collecting (a completed checkout session whose delayed payment has not
 * settled). The caller refuses in that case: the payment is on its way to the
 * invoice, and cancelling the bill under it would strand the money.
 * Otherwise expires it if it is open.
 *
 * Best effort by default: a Stripe error is logged, and a payment that still
 * lands is kept voided by applyStripeCandidateTransaction. With `strict` (a
 * delete or plan edit, which must not leave an obsolete checkout payable) a Stripe error
 * other than "no such object" throws, so the caller stops before removing the
 * row and no link outlives it.
 *
 * `skip` is an earlier snapshot of the same invoice whose session was already
 * closed: a caller that closes outside the row lock and again inside it passes
 * its first read so the second pass touches only a session minted in between.
 *
 * `allowRecordedPayments` lets a replacement request ignore a historical paid
 * session whose payment is already on the invoice. A refund can reopen the
 * invoice while Stripe still reports that original charge as paid.
 *
 * Returns { collected: boolean }.
 */
export async function closeInvoicePaymentSurfaces(
  lawFirmId: string,
  invoice: any,
  { strict = false, skip = null, allowRecordedPayments = false }: { strict?: boolean; skip?: any; allowRecordedPayments?: boolean } = {},
) {
  const sessionId = invoice?.stripeCheckoutSessionId && invoice.stripeCheckoutSessionId !== skip?.stripeCheckoutSessionId
    ? invoice.stripeCheckoutSessionId
    : null;
  const cardIntentId = invoice?.stripeCardPaymentIntentId && invoice.stripeCardPaymentIntentId !== skip?.stripeCardPaymentIntentId
    ? invoice.stripeCardPaymentIntentId
    : null;
  if (!stripe || (!sessionId && !cardIntentId)) return { collected: false };

  const failed = (what: string, err: any) => {
    if (!strict || err?.code === 'resource_missing') return false;
    throw new AppError(
      `Could not reach Stripe to cancel ${what}, so the payment request was kept. Try again in a moment.`,
      502,
      'STRIPE_UNAVAILABLE',
    );
  };

  if (sessionId) {
    const { collected } = await closeCheckoutSession(lawFirmId, invoice, sessionId, failed, allowRecordedPayments);
    if (collected) return { collected: true };
  }
  if (cardIntentId) {
    const outcome = await closeCardPaymentIntent(invoice);
    if (outcome === 'collected') return { collected: true };
    if (outcome === 'unreachable') failed("the client's card payment", null);
  }
  return { collected: false };
}

/**
 * Cancel the card-form PaymentIntent an invoice is holding (one waiting on the
 * client's bank verification), unless it has collected or is collecting.
 * Answers 'collected' for a succeeded or processing payment, 'closed' once it
 * can no longer take money (cancelled now, already cancelled, or unknown to
 * Stripe), and 'unreachable' when Stripe could not be read or the cancel failed.
 */
export async function closeCardPaymentIntent(invoice: any): Promise<'collected' | 'closed' | 'unreachable'> {
  const id = invoice?.stripeCardPaymentIntentId;
  const stripeAccount = invoice?.stripeCardPaymentIntentAccountId;
  if (!id) return 'closed';
  if (!stripe || !stripeAccount) return 'unreachable';
  const onFirm = [{}, { stripeAccount }];
  const judge = (status: string | null | undefined) => {
    if (status === 'succeeded' || status === 'processing') return 'collected' as const;
    if (status === 'canceled') return 'closed' as const;
    return null;
  };
  let status: string | null;
  try {
    status = (await stripe.paymentIntents.retrieve(id, ...onFirm)).status ?? null;
  } catch (err: any) {
    if (err?.code === 'resource_missing' || err?.raw?.code === 'resource_missing') return 'closed';
    console.warn(`stripe.service: could not read card payment ${id} while closing:`, err?.message || err);
    return 'unreachable';
  }
  const known = judge(status);
  if (known) return known;
  try {
    await stripe.paymentIntents.cancel(id, ...onFirm);
    return 'closed';
  } catch (err: any) {
    // A rejected cancel usually means the payment changed since it was read:
    // judge it by what it is now.
    if (isInvalidRequest(err)) {
      const now = judge(await statusNow(() => stripe.paymentIntents.retrieve(id, ...onFirm)));
      if (now) return now;
    }
    console.error(`stripe.service: could not cancel card payment ${id} for a closed invoice:`, err?.message || err);
    return 'unreachable';
  }
}

/** The checkout-session half of closeInvoicePaymentSurfaces. */
async function closeCheckoutSession(
  lawFirmId: string,
  invoice: any,
  sessionId: string,
  failed: (what: string, err: any) => boolean,
  allowRecordedPayments: boolean,
) {
  // The session is addressed to the account it was created on, which may no
  // longer be the account the firm's charges use.
  const sessionScope = scopeForRecordedAccount(invoice?.stripeCheckoutSessionAccountId, await invoiceChargeScopeFor(lawFirmId));

  let openSessionId: string | null = null;
  try {
    const sess = await stripe.checkout.sessions.retrieve(sessionId, ...idOnAccount(sessionScope));
    if (sess.status === 'complete' && !(allowRecordedPayments && sess.payment_status === 'paid' && hasRecordedStripeSurface(invoice, sess.id))) return { collected: true };
    if (sess.status === 'open') openSessionId = sess.id;
  } catch (err: any) {
    console.warn(`stripe.service: could not read checkout session ${sessionId} while closing:`, err?.message || err);
    failed("the client's checkout link", err);
  }

  if (openSessionId) {
    try {
      await stripe.checkout.sessions.expire(openSessionId, ...idOnAccount(sessionScope));
    } catch (err: any) {
      // A rejected request usually means the session changed since it was read:
      // judge it by what it is now, and treat only a real failure as one.
      if (isInvalidRequest(err)) {
        const now = await statusNow(() => stripe.checkout.sessions.retrieve(openSessionId, ...idOnAccount(sessionScope)));
        if (now === 'complete') return { collected: true };
        if (now === 'expired') return { collected: false };
      }
      console.error(`stripe.service: could not expire checkout session ${openSessionId} for a closed invoice:`, err?.message || err);
      failed("the client's checkout link", err);
    }
  }
  return { collected: false };
}

/**
 * Cancel a pending payment request: expire any checkout session the client
 * opened and clear the pay link token, so the link stops working.
 */
export async function voidPaymentRequest({ lawFirmId, contextType, entityId, invoiceId, actingUserId }: any) {
  const context = { type: contextType, lawFirmId, entityId };
  await authorizeContext(context, actingUserId);

  const invoice = await invoicesRepo.findById(context, invoiceId);
  if (!invoice) throw new NotFoundError('Invoice');
  if (!invoice.stripePaymentRequested) {
    throw new ValidationError({ stripe: ['No active Stripe payment request found'] });
  }
  if (invoice.stripePaymentStatus === 'completed') {
    throw new ValidationError({ stripe: ['Cannot void a completed payment'] });
  }

  await invoicesRepo.runInvoiceTxn(context, invoiceId, async (existing: any) => {
    if (existing.stripePaymentStatus === 'completed' || existing.isPaid) {
      throw new ValidationError({ stripe: ['Cannot void a completed payment'] });
    }
    // Close the request's checkout session under its row lock.
    const { collected } = await closeInvoicePaymentSurfaces(lawFirmId, existing, { strict: true });
    if (collected) {
      throw new ValidationError({ stripe: ['The client has already paid this request, or a payment is processing. The payment will appear on the invoice shortly.'] });
    }
    return {
      stripePaymentRequested: false,
      stripePaymentStatus: 'voided',
      stripeCheckoutSessionId: null,
      stripeCheckoutSessionAccountId: null,
      stripeCardPaymentIntentId: null,
      stripeCardPaymentIntentAccountId: null,
      // The payment link stops working with the request.
      payLinkToken: null,
      payLinkInstallmentId: null,
    };
  });

  return { message: 'Payment request voided' };
}

async function collectStripeReconciliationCandidates(invoice: any, lawFirmId: string) {
  const zone = await firmZone(lawFirmId);
  const candidates = [];
  const scope = await invoiceChargeScopeFor(lawFirmId);

  if (invoice.stripeCheckoutSessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(invoice.stripeCheckoutSessionId, ...idOnAccount(scopeForRecordedAccount(invoice.stripeCheckoutSessionAccountId, scope)));
      if (session.status === 'complete' && session.payment_status === 'paid') {
        candidates.push(buildStripeCandidateFromCheckoutSession(session, zone));
      }
    } catch (err: any) {
      console.warn(`stripe.service: unable to retrieve Checkout Session ${invoice.stripeCheckoutSessionId} during reconciliation:`, err.message);
    }
  }

  return candidates;
}

export async function reconcileStripeInvoices({ dryRun = true, limit = null }: any = {}) {
  if (!stripe) {
    throw new AppError('Payment processing is not available', 503, 'STRIPE_NOT_CONFIGURED');
  }

  const summary = {
    dryRun,
    scanned: 0,
    eligible: 0,
    changed: 0,
    repaired: 0,
    skipped: 0,
    failures: [] as any[],
  };

  // Only the invoices that carry Stripe state, a page at a time. The predicate
  // below stays the authority on what is eligible: the query narrows the set the
  // job has to load, and never decides what it repairs.
  const PAGE_SIZE = 500;
  let after: string | null = null;

  for (;;) {
    const page: any[] = await invoicesRepo.listStripeCandidateInvoices({ after, pageSize: PAGE_SIZE });
    if (!page.length) break;
    after = page[page.length - 1].invoice.id;

    for (const { invoice: original, context } of page) {
      if (limit && summary.eligible >= limit) break;

      if (!context || !context.entityId) {
        summary.scanned += 1;
        summary.skipped += 1;
        continue;
      }

      summary.scanned += 1;

      if (!invoiceHasStripeState(original)) continue;

      summary.eligible += 1;

      try {
        let reconciled = normalizeStripeInvoiceLocally(original);
        const candidates = await collectStripeReconciliationCandidates(original, context.lawFirmId);

        for (const candidate of candidates) {
          reconciled = applyStripeCandidate(reconciled, candidate).invoice;
        }

        reconciled = normalizeStripeInvoiceLocally(reconciled);
        const changed = extractComparableStripeState(original) !== extractComparableStripeState(reconciled);
        if (!changed) continue;

        summary.changed += 1;

        if (!dryRun) {
          // The Stripe reads above are slow, and the invoice can change while
          // they run (a manual payment, a webhook). Recompute the repair from
          // the row as it stands under its lock, as the webhook path does, so
          // the write never overwrites what landed in between.
          let repairedNow = false;
          await invoicesRepo.runInvoiceTxn(context, original.id, (existing: any) => {
            const current = { id: original.id, ...existing };
            let next = normalizeStripeInvoiceLocally(current);
            for (const candidate of candidates) {
              next = applyStripeCandidate(next, candidate).invoice;
            }
            next = normalizeStripeInvoiceLocally(next);
            if (extractComparableStripeState(current) === extractComparableStripeState(next)) return null;
            repairedNow = true;
            const update = buildInvoiceUpdateData(next);
            // A voided invoice stays voided; see applyStripeCandidateTransaction.
            if (existing.status === 'voided') update.status = 'voided';
            return update;
          });
          if (!repairedNow) continue;
          summary.repaired += 1;

          try {
            await invoicesService.refreshInvoiceCalendarSyncAfterPersistence({
              lawFirmId: context.lawFirmId,
              context,
              invoiceId: original.id,
              actingUserId: null,
            });
          } catch (calErr: any) {
            console.error('stripe.service: calendar sync after reconciliation failed:', calErr?.message || calErr);
          }
        }
      } catch (err: any) {
        summary.failures.push({
          invoiceId: original.id,
          lawFirmId: context.lawFirmId,
          error: err.message,
        });
      }
    }

    if (page.length < PAGE_SIZE) break;
    if (limit && summary.eligible >= limit) break;
  }

  return summary;
}

/**
 * Reconciliation sweep for ACH trust deposits — the durable backstop invoices and
 * subscriptions already have but trust lacked. Scans recently-succeeded Stripe
 * payment intents tagged depositType=trust and posts any that never reached the
 * ledger. This recovers a deposit whose webhook handler died AFTER the idempotency
 * claim committed (so Stripe's retry saw a duplicate and never reprocessed), which
 * would otherwise leave real client money sitting in the IOLTA with no ledger entry.
 *
 * Safety: a deposit that was posted and later fully voided (a clawback) is looked up
 * INCLUDING void rows, so the sweep never resurrects clawed-back funds. Posting is
 * idempotent on the payment intent, so re-running is safe. dryRun by default.
 *
 * This is the least bounded of the sweeps: it auto-paginates every payment
 * intent the platform took in the last `sinceDays`, most of which are not trust
 * deposits at all, and `limit` only counts the trust ones. `deadline` (epoch ms,
 * shared across the cron request) is what actually stops it, reporting
 * `truncated` so a scan that no longer completes is visible in the cron response
 * rather than inferred. Stripe pages newest-first, so a truncated run always
 * covers the most recent deposits — the ones most likely to still be missing.
 */
export async function reconcileStripeTrustDeposits({ dryRun = true, sinceDays = 14, limit = null, deadline = null }: any = {}) {
  if (!stripe) {
    throw new AppError('Payment processing is not available', 503, 'STRIPE_NOT_CONFIGURED');
  }
  const createdGte = Math.floor((Date.now() - sinceDays * 24 * 60 * 60 * 1000) / 1000);
  const summary = { dryRun, scanned: 0, trust: 0, missing: 0, posted: 0, truncated: false, failures: [] as any[] };

  for await (const pi of stripe.paymentIntents.list({ limit: 100, created: { gte: createdGte } })) {
    if (limit && summary.trust >= limit) break;
    if (deadline && Date.now() >= deadline) { summary.truncated = true; break; }
    summary.scanned += 1;

    const md = pi.metadata || {};
    if (md.depositType !== 'trust' || pi.status !== 'succeeded') continue;
    summary.trust += 1;

    try {
      // Include-void lookup: if this deposit was ever posted (even if later clawed
      // back and voided), it must NOT be re-posted.
      const existing = await trustTxnRepo.findDepositByStripePaymentIntentIncludingVoid(pi.id);
      if (existing) continue;

      summary.missing += 1;
      if (!dryRun) {
        // Date the recovered deposit at discovery time (settlement time is not
        // recoverable here), which also keeps it out of any closed prior period.
        // The precheck above and this call are two separate reads; a concurrent
        // webhook can commit the deposit in between, so this handler can find it
        // already posted and gracefully dedupe. Only count a REAL posting, not
        // every call that returned without throwing.
        const { posted } = await handleTrustDepositPaymentSucceeded(pi, Math.floor(Date.now() / 1000));
        if (posted) summary.posted += 1;
      }
    } catch (err: any) {
      summary.failures.push({ paymentIntentId: pi.id, error: err.message });
    }
  }

  if (summary.truncated) {
    console.warn(
      `stripe.service: trust deposit reconciliation budget exhausted after ${summary.scanned} payment intent(s); ` +
      'older intents in the window were not scanned this run'
    );
  }
  return summary;
}


