// Card payments taken on our own page through Stripe's Payment Element, for
// invoices whose card fee the client pays. The card is checked before any
// charge: Stripe.js turns it into a ConfirmationToken, its preview gives the
// funding type and issuing country, and cardFeeRules decides the fee. The
// charge is a direct charge on the firm's own Stripe account with no
// application fee when the client pays a card fee, so the firm keeps the
// invoice amount and Paralegix is never charged.
import {
  decideCardCharge,
  creditCardFeeCents,
  type CardChargeDecision,
  type CardFeeEligibility,
  type CardFeeSettings,
  type CardFunding,
} from './cardFeeRules';
import { FEE_CHANGED_MESSAGE, refusalMessage } from './cardFeeCopy';
import { applicationFeeCents } from './processingFees';
import { firmCardFeeContext } from './cardFeeSettings.service';
import { payLinkRequest } from '../billing/shared/payLinkRequest';
import { firmZone } from '../../shared/utils/personalDay';

const stripe = require('./stripe.config');
const stripeService = require('./stripe.service');
const invoicesRepo = require('../billing/invoices/invoices.repository');
const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const { withLock } = require('../../shared/database/advisoryLock');
const { isUuid } = require('../../shared/utils/isUuid');
const { AppError, ConflictError, NotFoundError } = require('../../shared/errors/AppError');

/** Marks a PaymentIntent this module created, in its metadata. */
export const CARD_FORM_PAY_CHANNEL = 'card_form';

const CONFIRMATION_TOKEN_RE = /^ctoken_[A-Za-z0-9_]+$/;
const PAYMENT_INTENT_RE = /^pi_[A-Za-z0-9_]+$/;
const STRIPE_CARD_FORM_LOCK_MAX_HOLD_MS = Number(process.env.STRIPE_PAYMENT_INTENT_LOCK_MAX_HOLD_MS) || 120_000;

export interface CardSummary { brand: string | null; last4: string | null; funding: CardFunding; country: string | null }

export type CardSetup =
  | { flow: 'checkout' }
  | {
    flow: 'card_form';
    stripeAccountId: string;
    creditFeeCents: number;
    debitCards: CardFeeSettings['debitCards'];
    internationalCards: CardFeeSettings['internationalCards'];
  };

/** Whether this invoice's card payments go through the card form: the client pays its card fee and the firm still may pass it on. */
function usesCardForm(invoice: any, eligibility: CardFeeEligibility) {
  return invoice?.isCardFeePassedOn === true && eligibility.eligible;
}

/** Whether this invoice's card payments go through the card form, and what the page needs for it. */
export async function cardSetupFor(lawFirmId: string, invoice: any, owedCents: number): Promise<CardSetup> {
  const { firm, cardFees, eligibility } = await firmCardFeeContext(lawFirmId);
  if (!usesCardForm(invoice, eligibility)) return { flow: 'checkout' };
  return {
    flow: 'card_form',
    stripeAccountId: firm.stripeAccountId as string,
    creditFeeCents: creditCardFeeCents(owedCents, {
      ratePercent: cardFees.ratePercent, fixedCents: cardFees.fixedCents, capPercent: eligibility.capPercent, international: false,
    }),
    debitCards: cardFees.debitCards,
    internationalCards: cardFees.internationalCards,
  };
}

/** The card behind a ConfirmationToken the client's browser made on the firm's account. */
async function readCard(confirmationTokenId: string, stripeAccount: string): Promise<CardSummary> {
  if (typeof confirmationTokenId !== 'string' || !CONFIRMATION_TOKEN_RE.test(confirmationTokenId)) {
    throw new AppError('Enter your card again.', 400, 'CARD_TOKEN_INVALID');
  }
  if (!stripe) throw new AppError('Payment processing is not available', 503, 'STRIPE_NOT_CONFIGURED');
  const ct = await stripe.confirmationTokens.retrieve(confirmationTokenId, {}, { stripeAccount });
  const card = ct?.payment_method_preview?.card;
  if (ct?.payment_method_preview?.type !== 'card' || !card) {
    throw new AppError('Enter a card to pay by card.', 400, 'CARD_TOKEN_INVALID');
  }
  const funding: CardFunding = ['credit', 'debit', 'prepaid'].includes(card.funding) ? card.funding : 'unknown';
  return {
    brand: card.brand || null,
    last4: card.last4 || null,
    funding,
    country: typeof card.country === 'string' && card.country ? card.country : null,
  };
}

/** What the payment link asks for now, refusing an invoice with nothing left to pay. */
function owedOn(invoice: any) {
  const requested = payLinkRequest(invoice);
  if (invoice.isPaid || requested.requestedCents <= 0 || (requested.installmentId && !requested.isPayable)) {
    throw new ConflictError('This invoice has already been paid. Please refresh the page.');
  }
  return requested;
}

/** The firm's card fee rules for this invoice, refusing one that no longer uses the card form. */
async function cardFormContext(lawFirmId: string, invoice: any) {
  const ctx = await firmCardFeeContext(lawFirmId);
  if (!usesCardForm(invoice, ctx.eligibility)) throw new ConflictError('Please reload the page.');
  return ctx;
}

function decide(owedCents: number, cardFees: CardFeeSettings, capPercent: number, card: CardSummary): CardChargeDecision {
  return decideCardCharge({ invoiceCents: owedCents, passedOn: true, capPercent, settings: cardFees, card });
}

/** Quote: what this card pays on this invoice. Creates nothing in Stripe. */
export async function quoteCardPayment({ lawFirmId, invoice, confirmationTokenId }: {
  lawFirmId: string; invoice: any; confirmationTokenId: string;
}) {
  const owed = owedOn(invoice).requestedCents;
  const { firm, cardFees, eligibility } = await cardFormContext(lawFirmId, invoice);
  const card = await readCard(confirmationTokenId, firm.stripeAccountId);
  const decision = decide(owed, cardFees, eligibility.capPercent, card);
  if (decision.outcome === 'refused') {
    return { outcome: 'refused', reason: decision.reason, message: refusalMessage(decision.reason), invoiceCents: owed, card };
  }
  const feeCents = decision.outcome === 'credit_fee' ? decision.feeCents : 0;
  return {
    outcome: decision.outcome,
    ...(decision.outcome === 'no_fee' ? { reason: decision.reason } : {}),
    feeCents,
    invoiceCents: owed,
    totalCents: owed + feeCents,
    card,
  };
}

interface ConfirmArgs {
  lawFirmId: string;
  invoiceId: string;
  context: { type: string; lawFirmId: string; entityId: string };
  confirmationTokenId: string;
  expectedTotalCents: number;
  clientId: string | null;
  clientUserId: string | null;
  /** The pay link the client is on; null from the portal. */
  payLinkToken: string | null;
  returnUrl: string;
}

/**
 * Charge the card, after checking it again: the fee the client saw must still
 * be the fee, and a card the firm declines is refused even if the client never
 * asked for a quote. Runs under the same lock as hosted checkout, so a card
 * payment and a bank checkout for one invoice never start together.
 */
export async function confirmCardPayment(args: ConfirmArgs) {
  try {
    return await withLock('STRIPE_INVOICE_CHECKOUT', `${args.lawFirmId}:${args.invoiceId}`,
      () => confirmLocked(args), { maxHoldMs: STRIPE_CARD_FORM_LOCK_MAX_HOLD_MS });
  } catch (err: any) {
    if (err?.code === 'ADVISORY_LOCK_TIMEOUT') {
      throw new ConflictError('Another payment is being prepared. Please try again in a moment.');
    }
    throw err;
  }
}

async function confirmLocked({
  lawFirmId, invoiceId, context, confirmationTokenId, expectedTotalCents, clientId, clientUserId, payLinkToken, returnUrl,
}: ConfirmArgs) {
  const invoice = await invoicesRepo.findById(context, invoiceId);
  if (!invoice || invoice.status === 'voided' || invoice.stripePaymentRequested !== true) throw new NotFoundError('Invoice');
  if (payLinkToken && invoice.payLinkToken !== payLinkToken) throw new NotFoundError('Payment link');
  const requested = owedOn(invoice);
  const { firm, cardFees, eligibility } = await cardFormContext(lawFirmId, invoice);

  // Nothing else may be collecting: a bank checkout still processing, or an
  // earlier card payment still waiting on the client's bank.
  const { collected } = await stripeService.closeInvoicePaymentSurfaces(lawFirmId, invoice, { strict: true });
  if (collected) {
    throw new AppError('A payment is already processing for this invoice. Please wait for it to complete.', 409, 'PAYMENT_PROCESSING');
  }
  // An earlier card payment the client abandoned at verification was just
  // cancelled; it no longer holds the invoice.
  if (invoice.stripeCardPaymentIntentId) {
    await invoicesRepo.runInvoiceTxn(context, invoice.id, (existing: any) => (
      existing && existing.stripeCardPaymentIntentId === invoice.stripeCardPaymentIntentId
        ? { stripeCardPaymentIntentId: null, stripeCardPaymentIntentAccountId: null }
        : null));
  }

  const card = await readCard(confirmationTokenId, firm.stripeAccountId);
  const decision = decide(requested.requestedCents, cardFees, eligibility.capPercent, card);
  if (decision.outcome === 'refused') throw new AppError(refusalMessage(decision.reason), 422, 'CARD_NOT_ACCEPTED');
  const feeCents = decision.outcome === 'credit_fee' ? decision.feeCents : 0;
  const total = requested.requestedCents + feeCents;
  if (total !== expectedTotalCents) throw new AppError(FEE_CHANGED_MESSAGE, 409, 'FEE_CHANGED');

  const params: any = {
    amount: total,
    currency: 'usd',
    confirm: true,
    confirmation_token: confirmationTokenId,
    payment_method_types: ['card'],
    return_url: returnUrl,
    description: requested.installmentNumber
      ? `Invoice #${invoice.invoiceName || invoice.invoiceNumber}, Installment ${requested.installmentNumber}`
      : `Invoice #${invoice.invoiceName || invoice.invoiceNumber}`,
    metadata: {
      chargeModel: 'direct',
      payChannel: CARD_FORM_PAY_CHANNEL,
      lawFirmId,
      invoiceId,
      contextType: context.type,
      entityId: context.entityId,
      clientId: clientId || '',
      clientUserId: clientUserId || '',
      ...(requested.installmentId ? { installmentId: requested.installmentId } : {}),
      // How the recorder separates invoice money from the client-paid fee.
      paymentMethod: 'card',
      invoiceAmountCents: String(requested.requestedCents),
      surchargeCents: String(feeCents),
      cardFunding: card.funding,
      cardCountry: card.country || '',
    },
  };
  // Paralegix takes nothing on a payment whose fee the client paid. On a card
  // the firm absorbs (debit, prepaid, unknown) it takes its usual margin.
  if (feeCents === 0) params.application_fee_amount = applicationFeeCents('card', total, true);

  let pi: any;
  try {
    pi = await stripe.paymentIntents.create(params, {
      stripeAccount: firm.stripeAccountId,
      idempotencyKey: `card-form-${invoiceId}-${confirmationTokenId}`,
    });
  } catch (err: any) {
    // Stripe writes card_error messages for the cardholder, so they are shown
    // as is. 422, not 402: the app reads a 402 as the firm's plan lapsing.
    if (err?.type === 'StripeCardError') throw new AppError(err.message, 422, 'CARD_DECLINED');
    throw err;
  }
  return settle(context, invoice, pi, firm.stripeAccountId);
}

/**
 * Act on a PaymentIntent's state: record a success, hold the invoice while it
 * waits on the client's bank. The firm's account id is passed in because a
 * PaymentIntent object does not carry the connected account it lives on.
 */
async function settle(context: any, invoice: any, pi: any, stripeAccountId: string) {
  if (pi.status === 'succeeded') {
    await recordCardPaymentIntent(pi, stripeAccountId);
    return { status: 'succeeded' };
  }
  if (pi.status === 'requires_action' || pi.status === 'processing') {
    let held = false;
    await invoicesRepo.runInvoiceTxn(context, invoice.id, (existing: any) => {
      // The request was withdrawn or replaced while Stripe answered.
      if (!existing || existing.status === 'voided' || existing.stripePaymentRequested !== true
        || existing.payLinkToken !== invoice.payLinkToken) return null;
      held = true;
      return { stripeCardPaymentIntentId: pi.id, stripeCardPaymentIntentAccountId: stripeAccountId };
    });
    if (!held) {
      await cancelQuietly(pi.id, stripeAccountId);
      throw new ConflictError('This payment request has changed. Please refresh the page.');
    }
    return pi.status === 'requires_action' ? { status: 'requires_action', clientSecret: pi.client_secret } : { status: 'processing' };
  }
  throw new AppError('Your card was not charged. Please try again or use a different card.', 422, 'CARD_NOT_CHARGED');
}

async function cancelQuietly(paymentIntentId: string, stripeAccount: string) {
  try {
    await stripe.paymentIntents.cancel(paymentIntentId, {}, { stripeAccount });
  } catch (err: any) {
    console.error(`cardPayment: could not cancel card payment ${paymentIntentId}:`, err?.message || err);
  }
}

/**
 * After the client finishes a bank verification step: record the payment if
 * it succeeded. A PaymentIntent that is not this invoice's answers 404.
 */
export async function completeCardPayment({ lawFirmId, invoice, paymentIntentId }: {
  lawFirmId: string; invoice: any; paymentIntentId: string;
}) {
  const firm = await lawfirmsRepo.findById(lawFirmId);
  if (typeof paymentIntentId !== 'string' || !PAYMENT_INTENT_RE.test(paymentIntentId) || !firm?.stripeAccountId) {
    throw new NotFoundError('Payment');
  }
  if (!stripe) throw new AppError('Payment processing is not available', 503, 'STRIPE_NOT_CONFIGURED');
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {}, { stripeAccount: firm.stripeAccountId });
  const md = pi?.metadata || {};
  if (md.payChannel !== CARD_FORM_PAY_CHANNEL || md.invoiceId !== invoice.id || md.lawFirmId !== lawFirmId) {
    throw new NotFoundError('Payment');
  }
  if (pi.status === 'succeeded') {
    await recordCardPaymentIntent(pi, firm.stripeAccountId);
    return { status: 'succeeded' };
  }
  if (pi.status === 'processing') return { status: 'processing' };
  // Verification failed or was abandoned. The PaymentIntent is cancelled so the
  // client secret can never confirm it with a different card at this amount.
  await releaseCardPaymentIntent(pi, firm.stripeAccountId);
  return { status: 'failed' };
}

/** Whether a card-form payment with this PaymentIntent is already on an invoice. */
export async function isCardPaymentRecorded(paymentIntentId: string) {
  if (typeof paymentIntentId !== 'string' || !PAYMENT_INTENT_RE.test(paymentIntentId)) return false;
  return Boolean(await invoicesRepo.findInvoicePaymentByStripePaymentIntentAnyFirm(paymentIntentId));
}

function candidateFromPaymentIntent(pi: any, timeZone: string) {
  const md = pi.metadata || {};
  // The fee the client paid rides on the same charge; only the rest is invoice
  // money. Clamped to the charge so a malformed value can never credit more
  // than was paid.
  const total = Math.max(0, Math.round(pi.amount_received || 0));
  const surchargeCents = Math.min(Math.max(0, parseInt(md.surchargeCents, 10) || 0), total);
  return {
    chargeModel: 'direct',
    lawFirmId: md.lawFirmId,
    invoiceId: md.invoiceId,
    contextType: md.contextType,
    entityId: md.entityId,
    clientRecordId: md.clientId || null,
    clientUserId: md.clientUserId || null,
    installmentId: typeof md.installmentId === 'string' && md.installmentId ? md.installmentId : null,
    surchargeCents,
    paymentMethod: 'card',
    paymentFlow: CARD_FORM_PAY_CHANNEL,
    amountPaid: (total - surchargeCents) / 100,
    paymentDate: stripeService.stripeDay(pi.created, timeZone),
    stripeSessionId: null,
    stripePaymentIntentId: pi.id,
    endsRequest: true,
    clearCheckoutSession: false,
    clearCardPaymentIntent: true,
    note: 'Online card payment via Stripe',
  };
}

/**
 * Record a succeeded card-form PaymentIntent on its invoice. Idempotent on the
 * PaymentIntent id, so the immediate record and the webhook can both run.
 * Only a PaymentIntent on the account of the firm its metadata names counts:
 * anyone with a Stripe account writes their own metadata.
 */
export async function recordCardPaymentIntent(pi: any, stripeAccountId: string | null) {
  const md = pi?.metadata || {};
  if (md.payChannel !== CARD_FORM_PAY_CHANNEL || md.chargeModel !== 'direct' || pi?.status !== 'succeeded') return { applied: false };
  if (!isUuid(md.lawFirmId) || !isUuid(md.invoiceId) || !md.contextType || !md.entityId) return { applied: false };
  const firm = await lawfirmsRepo.findById(md.lawFirmId);
  if (!firm || !stripeAccountId || firm.stripeAccountId !== stripeAccountId) return { applied: false };
  const candidate = candidateFromPaymentIntent(pi, await firmZone(md.lawFirmId, firm.settings));
  let result: any;
  try {
    result = await stripeService.applyStripeCandidateTransaction(candidate);
  } catch (err: any) {
    // The invoice was deleted after the card was charged: money moved, so say
    // so loudly, but acknowledge rather than make Stripe retry for days.
    if (err?.code === 'STRIPE_INVOICE_NOT_FOUND') {
      console.error('cardPayment: card payment for a deleted invoice:', {
        lawFirmId: candidate.lawFirmId, invoiceId: candidate.invoiceId, paymentIntentId: pi.id,
      });
      return { applied: false };
    }
    throw err;
  }
  if (result.applied) await stripeService.finishAppliedStripePayment(candidate, result);
  return result;
}

/**
 * A card-form PaymentIntent failed or was cancelled: cancel it if it still can
 * be (so its client secret cannot later confirm it with another card) and
 * release the invoice it was holding.
 */
export async function releaseCardPaymentIntent(pi: any, stripeAccountId: string | null) {
  const md = pi?.metadata || {};
  if (md.payChannel !== CARD_FORM_PAY_CHANNEL || !isUuid(md.lawFirmId) || !isUuid(md.invoiceId)) return;
  const firm = await lawfirmsRepo.findById(md.lawFirmId);
  if (!firm || !stripeAccountId || firm.stripeAccountId !== stripeAccountId) return;
  if (pi.status === 'requires_payment_method' || pi.status === 'requires_action' || pi.status === 'requires_confirmation') {
    await cancelQuietly(pi.id, stripeAccountId);
  }
  const context = { type: md.contextType, lawFirmId: md.lawFirmId, entityId: md.entityId };
  await invoicesRepo.runInvoiceTxn(context, md.invoiceId, (existing: any) => (
    existing && existing.stripeCardPaymentIntentId === pi.id
      ? { stripeCardPaymentIntentId: null, stripeCardPaymentIntentAccountId: null }
      : null));
}
