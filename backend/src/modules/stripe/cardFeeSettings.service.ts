// The firm's credit card fee setting: on or off, what happens to debit and
// non-US cards, its Stripe rate, and its confirmation that it gave Stripe the
// required notice and discloses the fee in its engagement letters. Turning the
// fee on is refused, with every reason, unless the firm may use it.
import { cardFeeEligibility, type CardFeeConfirmation, type CardFeeSettings, type CardAcceptance } from './cardFeeRules';
import { ineligibleMessage } from './cardFeeCopy';
import { getFirmBillingSettings, setFirmBillingSettings } from '../billing/shared/billingSettings';
import { firmZone } from '../../shared/utils/personalDay';
import { localDateFor } from '../../shared/utils/localTime';

const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');

export interface CardFeeSettingsBody {
  clientPays: boolean;
  debitCards: CardAcceptance;
  internationalCards: CardAcceptance;
  ratePercent: number;
  fixedCents: number;
  stripeNotifiedOn?: string;
  engagementLetterConfirmed?: boolean;
}

async function load(lawFirmId: string) {
  const firm = await lawfirmsRepo.findById(lawFirmId);
  if (!firm) throw new NotFoundError('Law firm');
  const billing = await getFirmBillingSettings(lawFirmId);
  // The notice period runs on the firm's own calendar, not the server's.
  const today = localDateFor(await firmZone(lawFirmId, firm.settings));
  return { firm, billing, today };
}

/**
 * The firm, its card fee settings and whether it may pass the card fee on
 * today. Every place that decides a card fee (the request, its quote, the pay
 * page, the charge) reads it here, so they all agree.
 */
export async function firmCardFeeContext(lawFirmId: string) {
  const { firm, billing, today } = await load(lawFirmId);
  const cardFees: CardFeeSettings = billing.cardFees;
  return { firm, billing, cardFees, eligibility: cardFeeEligibility(firm, cardFees, today) };
}

function shape(firm: any, billing: any, today: string) {
  const cardFees: CardFeeSettings = billing.cardFees;
  return {
    clientPays: billing.processingFees.card === 'client',
    ...cardFees,
    eligibility: cardFeeEligibility(firm, cardFees, today),
  };
}

export async function getCardFeeSettings({ lawFirmId, actingUserId }: { lawFirmId: string; actingUserId: string }) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const { firm, billing, today } = await load(lawFirmId);
  return shape(firm, billing, today);
}

export async function updateCardFeeSettings({ lawFirmId, actingUserId, body }: {
  lawFirmId: string; actingUserId: string; body: CardFeeSettingsBody;
}) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const { firm, billing, today } = await load(lawFirmId);
  const previous: CardFeeSettings = billing.cardFees;
  // A new confirmation replaces the old one only when it is complete; turning
  // the fee off keeps the record of the earlier one.
  const confirmation: CardFeeConfirmation | null = body.stripeNotifiedOn && body.engagementLetterConfirmed === true
    ? {
      stripeNotifiedOn: body.stripeNotifiedOn,
      engagementLetterConfirmed: true,
      confirmedBy: actingUserId,
      confirmedAt: new Date().toISOString(),
    }
    : previous.confirmation;
  const next: CardFeeSettings = {
    debitCards: body.debitCards,
    internationalCards: body.internationalCards,
    ratePercent: body.ratePercent,
    fixedCents: body.fixedCents,
    confirmation,
  };
  if (body.clientPays) {
    const eligibility = cardFeeEligibility(firm, next, today);
    if (!eligibility.eligible) {
      throw new ValidationError({ cardFees: eligibility.reasons.map((r) => ineligibleMessage(r, eligibility)) });
    }
  }
  const saved = await setFirmBillingSettings(lawFirmId, {
    cardFees: next,
    processingFees: { ...billing.processingFees, card: body.clientPays ? 'client' : 'firm' },
  });
  return shape(firm, saved, today);
}
