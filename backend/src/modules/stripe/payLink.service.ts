// The secure payment link: a no-login pay page whose token is its only
// credential. The firm's request emails it or the firm copies it; the client
// chooses card or bank transfer there, which sets any processing fee. A link
// asks for the full balance or for one payment-plan installment. A withdrawn
// request, a voided invoice, a replaced link and an installment link whose row
// is paid or gone all answer 404.
import { PAYMENT_METHOD_KINDS, clientSurchargeCents, type PaymentMethodKind } from './processingFees';
import { payLinkRequest } from '../billing/shared/payLinkRequest';
import {
  cardSetupFor,
  completeCardPayment,
  confirmCardPayment,
  isCardPaymentRecorded,
  quoteCardPayment,
} from './cardPayment.service';

const invoicesRepo = require('../billing/invoices/invoices.repository');
const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const { invoiceClientRecordId } = require('../billing/shared/billingRecipientSnapshot.service');
const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const stripeService = require('./stripe.service');
const { payLinkUrl } = require('../billing/shared/payLinkUrl');

const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

/** The live invoice behind a token, or a 404 that says nothing about why. */
async function loadPayableInvoice(token: string) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new NotFoundError('Payment link');
  const match = await invoicesRepo.findByPayLinkTokenAnyFirm(token);
  if (!match) throw new NotFoundError('Payment link');
  const invoice = await invoicesRepo.findById(match.context, match.invoiceId);
  if (!invoice || invoice.payLinkToken !== token || invoice.status === 'voided' || invoice.stripePaymentRequested !== true) {
    throw new NotFoundError('Payment link');
  }
  return { ...match, invoice };
}

/**
 * What the pay page shows: who is asking, for which invoice (and which
 * installment, by its 1-based position, when the link asks for one), what the
 * link charges, and what card and bank transfer each cost with any fee the firm
 * passed on. Nothing else about the client or the invoice reaches a token holder.
 */
export async function getPayPage(token: string) {
  const { lawFirmId, invoice } = await loadPayableInvoice(token);
  const requested = payLinkRequest(invoice);
  // An installment that was paid another way or left the plan leaves the link
  // with nothing to collect, so it answers like a dead link.
  if (requested.installmentId && !requested.isPayable) throw new NotFoundError('Payment link');
  const firm = await lawfirmsRepo.findById(lawFirmId);
  const owed = requested.requestedCents;
  const isPaid = invoice.isPaid === true || owed === 0;
  return {
    firmName: firm?.name || null,
    invoiceName: invoice.invoiceName || invoice.invoiceNumber || null,
    dueDate: invoice.dueDate || null,
    installmentNumber: requested.installmentNumber,
    isPaid,
    invoiceCents: isPaid ? 0 : owed,
    // How a card payment is taken: hosted checkout, or the card form when the
    // client pays a card fee that depends on the card.
    card: isPaid ? { flow: 'checkout' as const } : await cardSetupFor(lawFirmId, invoice, owed),
    methods: isPaid ? [] : PAYMENT_METHOD_KINDS.map((method) => {
      // A card fee depends on the card, so the card option shows no fee and
      // the card form shows the exact amount once the card is entered.
      if (method === 'card') return { method, feeCents: 0, totalCents: owed };
      const feeCents = invoice.isBankFeePassedOn ? clientSurchargeCents('bank', owed) : 0;
      return { method, feeCents, totalCents: owed + feeCents };
    }),
  };
}

/** What the card the client entered pays on this link. Creates nothing in Stripe. */
export async function quotePayLinkCard(token: string, confirmationTokenId: string) {
  const { lawFirmId, invoice } = await loadPayableInvoice(token);
  return quoteCardPayment({ lawFirmId, invoice, confirmationTokenId });
}

/** Charge the card for the total the client was shown. */
export async function confirmPayLinkCard(token: string, confirmationTokenId: string, expectedTotalCents: number) {
  const { lawFirmId, invoiceId, context, invoice } = await loadPayableInvoice(token);
  return confirmCardPayment({
    lawFirmId,
    invoiceId,
    context,
    confirmationTokenId,
    expectedTotalCents,
    clientId: invoiceClientRecordId(invoice),
    clientUserId: null,
    payLinkToken: token,
    returnUrl: `${payLinkUrl(token)}?payment=card_return`,
  });
}

/**
 * Finish a card payment after the client's bank verified it. Recording the
 * payment ends the link, so a link that no longer resolves still answers
 * succeeded for a PaymentIntent already recorded on an invoice.
 */
export async function completePayLinkCard(token: string, paymentIntentId: string) {
  let payable;
  try {
    payable = await loadPayableInvoice(token);
  } catch (err: any) {
    if (err instanceof NotFoundError && await isCardPaymentRecorded(paymentIntentId)) return { status: 'succeeded' };
    throw err;
  }
  return completeCardPayment({ lawFirmId: payable.lawFirmId, invoice: payable.invoice, paymentIntentId });
}

/**
 * Start checkout for the method the client chose on the pay page. The session
 * returns to the pay link, not to a portal the client may not be able to open.
 */
export async function startPayLinkCheckout(token: string, method: PaymentMethodKind) {
  if (!PAYMENT_METHOD_KINDS.includes(method)) {
    throw new ValidationError({ method: ['Choose card or bank transfer'] });
  }
  const { lawFirmId, invoiceId, context, invoice } = await loadPayableInvoice(token);
  const payPage = payLinkUrl(token);
  return stripeService.getClientCheckoutUrl({
    lawFirmId,
    invoiceId,
    contextType: context.type,
    entityId: context.entityId,
    clientId: invoiceClientRecordId(invoice),
    clientUserId: null,
    clientEmail: null,
    clientName: null,
    method,
    payLinkToken: token,
    successUrl: `${payPage}?payment=success`,
    cancelUrl: `${payPage}?payment=cancelled`,
  });
}
