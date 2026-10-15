import { z } from 'zod';
const { MAX_MONEY_AMOUNT } = require('../billing/shared/money');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = (msg = 'Must be a valid id') => z.string().regex(UUID_RE, msg);

/**
 * A payment-plan installment's stable id (the row's `id`, stored as
 * `installment_id`). Positions are not accepted: a plan edit reorders rows.
 */
const installmentId = z.string().trim().min(1, 'Choose an installment').max(128);

/**
 * A firm requesting online payment for an invoice. The two fee flags are the
 * choice made in the request dialog: whether the client pays the card fee and
 * the bank transfer fee on this invoice; left out, the firm's billing setting
 * decides. `sendEmail: false` creates the payment link without emailing it, for
 * the firm to copy and send another way. `installmentId` makes the link ask for
 * that one installment instead of the full balance.
 */
export const requestPaymentSchema = z.object({
  body: z.object({
    isCardFeePassedOn: z.boolean().optional(),
    isBankFeePassedOn: z.boolean().optional(),
    sendEmail: z.boolean().optional(),
    installmentId: installmentId.optional(),
  }).strict().optional(),
});

/**
 * The request dialog previewing a fee choice before it is sent. Query strings
 * carry the two flags as 'true' / 'false'; `installmentId` quotes the link for
 * that one installment.
 */
export const paymentFeeQuoteSchema = z.object({
  query: z.object({
    card: z.enum(['true', 'false']).optional(),
    bank: z.enum(['true', 'false']).optional(),
    installmentId: installmentId.optional(),
  }).strict(),
});

/**
 * A firm asking a client for an electronic trust deposit. Money is integer
 * cents and capped at the same ceiling every other money field carries, so an
 * absurd figure is refused here with a message rather than reaching Stripe and
 * coming back as a scrubbed 500. Every id is uuid-checked at the boundary; the
 * service still proves each one belongs to this firm and this client.
 */
export const requestTrustDepositSchema = z.object({
  body: z.object({
    trustAccountId: uuid('A valid trust account is required'),
    clientId: uuid('A valid client is required'),
    amountCents: z.number().int('A positive amount in whole cents is required').positive('A positive amount in whole cents is required')
      .max(MAX_MONEY_AMOUNT * 100, `Amount cannot exceed $${MAX_MONEY_AMOUNT.toLocaleString('en-US')}`),
    matterId: uuid('A valid matter is required').nullable().optional(),
    // Email the link to the client, or create it for the firm to copy.
    sendEmail: z.boolean().optional(),
  }),
  params: z.object({ lawFirmId: z.string() }),
});

/**
 * The card form, on the pay link and in the portal. The client's browser turns
 * the card into a ConfirmationToken; the quote reads it, the confirm charges
 * the total the client was shown, and the complete records a payment the
 * client's bank verified.
 */
export const cardQuoteSchema = z.object({
  body: z.object({ confirmationTokenId: z.string().min(1).max(255) }).strict(),
});

export const cardConfirmSchema = z.object({
  body: z.object({
    confirmationTokenId: z.string().min(1).max(255),
    expectedTotalCents: z.number().int().positive().max(MAX_MONEY_AMOUNT * 100),
  }).strict(),
});

export const cardCompleteSchema = z.object({
  body: z.object({ paymentIntentId: z.string().min(1).max(255) }).strict(),
});
