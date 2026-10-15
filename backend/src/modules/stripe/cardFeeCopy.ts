// User-facing text about card fees that the backend sends: refusals and the
// receipt label. The frontend keeps the screen text in its own copy file with
// the same wording.
import type { CardRefusalReason, IneligibleReason } from './cardFeeRules';
import { stateName } from './cardFeeRules';

export const RECEIPT_FEE_LABEL = { card: 'Credit card fee', bank: 'Bank transfer fee' } as const;

export const FEE_CHANGED_MESSAGE = 'Your total changed. Please review it.';

export function refusalMessage(reason: CardRefusalReason): string {
  if (reason === 'non_us_not_accepted') return 'Only US cards are accepted. Use a US card or pay by bank transfer.';
  return "Debit cards aren't accepted. Use a credit card or pay by bank transfer.";
}

export function ineligibleMessage(
  reason: IneligibleReason,
  ctx: { state: string | null; availableFrom: string | null },
): string {
  switch (reason) {
    case 'stripe_not_connected': return 'Connect Stripe under Settings > Payments first.';
    case 'state_missing': return "Choose your firm's state first.";
    case 'state_banned': return `Card fees aren't allowed in ${ctx.state ? stateName(ctx.state) : 'your state'}.`;
    case 'not_confirmed': return 'Enter the date you told Stripe and confirm your engagement letters mention this fee.';
    case 'notice_period': return `Available from ${ctx.availableFrom}.`;
  }
}
