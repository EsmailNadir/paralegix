// Which card payments may carry a client-paid card fee, and how much. US card
// rules allow a fee on credit cards only, no more than the merchant's real cost
// of accepting the card and no more than 3%, and some states ban it or cap it
// lower. Everything here is pure so the pay page, the request dialog and the
// charge itself all reach the same answer.
import { percentOfCents } from '../billing/shared/money';
import { addDays } from '../../shared/utils/localTime';

export type CardFunding = 'credit' | 'debit' | 'prepaid' | 'unknown';
export type CardAcceptance = 'absorb' | 'decline';

export interface CardFeeConfirmation {
  /** 'YYYY-MM-DD': the day the firm told Stripe it adds a credit card fee. */
  stripeNotifiedOn: string;
  engagementLetterConfirmed: true;
  confirmedBy: string;
  confirmedAt: string;
}

export interface CardFeeSettings {
  debitCards: CardAcceptance;
  internationalCards: CardAcceptance;
  /** The firm's Stripe card rate, the ceiling on any fee: percent and fixed cents. */
  ratePercent: number;
  fixedCents: number;
  confirmation: CardFeeConfirmation | null;
}

export const DEFAULT_CARD_FEE_SETTINGS: CardFeeSettings = {
  debitCards: 'absorb',
  internationalCards: 'absorb',
  ratePercent: 2.9,
  fixedCents: 30,
  confirmation: null,
};

export const US_CREDIT_FEE_CAP_PERCENT = 3;
/** Stripe's extra charge on a card issued outside the US. */
export const INTERNATIONAL_EXTRA_PERCENT = 1.5;
/** Card networks require this much notice to the acquirer before a merchant starts. */
export const NOTICE_DAYS = 30;

type StateRule = { allowed: false } | { allowed: true; capPercent: number };

/**
 * States that ban a credit card surcharge or cap it below 3%. Sources disagree
 * on California (its 2024 junk-fee law) and Maine, so both are blocked; a
 * firm there passes on the bank fee only.
 */
const STATE_RULES: Record<string, StateRule> = {
  CA: { allowed: false },
  CT: { allowed: false },
  MA: { allowed: false },
  ME: { allowed: false },
  CO: { allowed: true, capPercent: 2 },
};

const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const BY_SQUASHED: Record<string, string> = Object.fromEntries([
  ...Object.keys(STATE_NAMES).map((code) => [squash(code), code]),
  ...Object.entries(STATE_NAMES).map(([code, name]) => [squash(name), code]),
]);

/** A two-letter US state code from the free-text `law_firms.state`, or null. */
export function normalizeUsState(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const key = squash(raw);
  return key ? BY_SQUASHED[key] || null : null;
}

export function stateName(code: string): string {
  return STATE_NAMES[code] || code;
}

export function stateRule(code: string): StateRule {
  return STATE_RULES[code] || { allowed: true, capPercent: US_CREDIT_FEE_CAP_PERCENT };
}

/**
 * The fee on a credit card payment of `invoiceCents`: the smallest amount that
 * covers the firm's Stripe cost on the larger charge (a gross-up, since Stripe
 * charges its percentage on the fee too), never more than `capPercent` of the
 * invoice. The cap rounds down so the fee never exceeds the percentage.
 */
export function creditCardFeeCents(
  invoiceCents: number,
  { ratePercent, fixedCents, capPercent, international }: {
    ratePercent: number; fixedCents: number; capPercent: number; international: boolean;
  },
): number {
  const invoice = Math.round(Number(invoiceCents) || 0);
  if (invoice <= 0) return 0;
  const rate = ratePercent + (international ? INTERNATIONAL_EXTRA_PERCENT : 0);
  const cap = Math.floor((invoice * Math.round(capPercent * 100)) / 10_000);
  const cost = (gross: number) => percentOfCents(gross, rate) + fixedCents;
  // Start just below the closed-form gross-up so the cent-by-cent scan is a
  // handful of steps whatever the invoice amount, then stop at the cap.
  let fee = Math.max(0, Math.floor((invoice * rate / 100 + fixedCents) / (1 - rate / 100)) - 2);
  while (fee < cap && fee < cost(invoice + fee)) fee += 1;
  return Math.min(fee, cap);
}

export type CardChargeDecision =
  | { outcome: 'credit_fee'; feeCents: number; international: boolean }
  | { outcome: 'no_fee'; reason: 'debit' | 'prepaid' | 'unknown_funding' | 'fee_not_passed_on' }
  | { outcome: 'refused'; reason: 'debit_not_accepted' | 'prepaid_not_accepted' | 'non_us_not_accepted' };

export type CardRefusalReason = Extract<CardChargeDecision, { outcome: 'refused' }>['reason'];

/**
 * What one card pays on one invoice. The firm's debit and non-US choices apply
 * only when it passes the card fee on; a firm that pays the fee itself accepts
 * every card.
 */
export function decideCardCharge({ invoiceCents, passedOn, capPercent, settings, card }: {
  invoiceCents: number;
  passedOn: boolean;
  capPercent: number;
  settings: CardFeeSettings;
  card: { funding: CardFunding; country: string | null };
}): CardChargeDecision {
  if (!passedOn) return { outcome: 'no_fee', reason: 'fee_not_passed_on' };
  const international = !!card.country && card.country !== 'US';
  if (international && settings.internationalCards === 'decline') return { outcome: 'refused', reason: 'non_us_not_accepted' };
  if (card.funding === 'debit' || card.funding === 'prepaid') {
    if (settings.debitCards === 'decline') {
      return { outcome: 'refused', reason: card.funding === 'debit' ? 'debit_not_accepted' : 'prepaid_not_accepted' };
    }
    return { outcome: 'no_fee', reason: card.funding };
  }
  if (card.funding !== 'credit') return { outcome: 'no_fee', reason: 'unknown_funding' };
  const feeCents = creditCardFeeCents(invoiceCents, {
    ratePercent: settings.ratePercent, fixedCents: settings.fixedCents, capPercent, international,
  });
  return { outcome: 'credit_fee', feeCents, international };
}

export type IneligibleReason =
  | 'stripe_not_connected' | 'state_missing' | 'state_banned' | 'not_confirmed' | 'notice_period';

export interface CardFeeEligibility {
  eligible: boolean;
  reasons: IneligibleReason[];
  /** Two-letter code of the firm's state, or null when it is missing or not a US state. */
  state: string | null;
  /** The firm's fee cap in percent; 0 when its state bans the fee. */
  capPercent: number;
  /** 'YYYY-MM-DD': the first day the fee may be on, once the firm has confirmed. */
  availableFrom: string | null;
}

/**
 * Whether a firm may pass the card fee on, and every reason it may not. `today`
 * is the firm's own calendar day ('YYYY-MM-DD').
 */
export function cardFeeEligibility(
  firm: { stripeAccountId?: string | null; stripeChargesEnabled?: boolean | null; state?: string | null },
  settings: CardFeeSettings,
  today: string,
): CardFeeEligibility {
  const reasons: IneligibleReason[] = [];
  if (!firm.stripeAccountId || !firm.stripeChargesEnabled) reasons.push('stripe_not_connected');
  const state = normalizeUsState(firm.state);
  const rule = state ? stateRule(state) : null;
  if (!state) reasons.push('state_missing');
  else if (rule && !rule.allowed) reasons.push('state_banned');
  const confirmation = settings.confirmation;
  const availableFrom = confirmation ? addDays(confirmation.stripeNotifiedOn, NOTICE_DAYS) : null;
  if (!confirmation || confirmation.engagementLetterConfirmed !== true) reasons.push('not_confirmed');
  else if (availableFrom && today < availableFrom) reasons.push('notice_period');
  return {
    eligible: reasons.length === 0,
    reasons,
    state,
    capPercent: rule && rule.allowed ? rule.capPercent : 0,
    availableFrom,
  };
}
