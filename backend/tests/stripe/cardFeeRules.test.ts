/**
 * Which card payments may carry a client-paid card fee, and how much. A cent
 * too much on a credit card is a fee above the network cap, and any fee on a
 * debit card breaks federal debit rules, so every amount here is exact.
 */
import {
  creditCardFeeCents, decideCardCharge, cardFeeEligibility, normalizeUsState, stateRule,
  DEFAULT_CARD_FEE_SETTINGS,
} from '../../src/modules/stripe/cardFeeRules';

const STANDARD = { ratePercent: 2.9, fixedCents: 30 };

describe('creditCardFeeCents', () => {
  it('caps a small invoice at exactly 3%, which leaves the firm under 30 cents short', () => {
    expect(creditCardFeeCents(100_00, { ...STANDARD, capPercent: 3, international: false })).toBe(3_00);
  });
  it('charges only the real cost once the cost is under 3%', () => {
    // $10,000: gross-up of 2.9% + 30c is $298.97, below the $300 cap.
    expect(creditCardFeeCents(10_000_00, { ...STANDARD, capPercent: 3, international: false })).toBe(298_97);
  });
  it('makes the firm whole exactly when the cost is under the cap', () => {
    const fee = creditCardFeeCents(2_500_00, { ...STANDARD, capPercent: 3, international: false });
    const total = 2_500_00 + fee;
    const stripeCost = Math.floor(total * 0.029 + 0.5) + 30;
    expect(total - stripeCost).toBe(2_500_00);
  });
  it('charges the smallest fee that covers the cost, not a cent more', () => {
    // One cent less than the fee leaves the firm short of the invoice.
    const fee = creditCardFeeCents(2_500_00, { ...STANDARD, capPercent: 3, international: false });
    const less = 2_500_00 + fee - 1;
    expect(less - (Math.floor(less * 0.029 + 0.5) + 30)).toBeLessThan(2_500_00);
  });
  it('uses the 2% cap for Colorado', () => {
    expect(creditCardFeeCents(1_000_00, { ...STANDARD, capPercent: 2, international: false })).toBe(20_00);
  });
  it('rounds the cap down, so a fee is never above the percentage', () => {
    expect(creditCardFeeCents(1_50, { ...STANDARD, capPercent: 3, international: false })).toBe(4);
  });
  it('adds the 1.5% international cost before capping', () => {
    expect(creditCardFeeCents(10_000_00, { ...STANDARD, capPercent: 3, international: true })).toBe(300_00);
  });
  it('returns 0 for a zero invoice', () => {
    expect(creditCardFeeCents(0, { ...STANDARD, capPercent: 3, international: false })).toBe(0);
  });
});

describe('decideCardCharge', () => {
  const base = { invoiceCents: 1_000_00, passedOn: true, capPercent: 3, settings: DEFAULT_CARD_FEE_SETTINGS };
  it('charges a fee on a US credit card', () => {
    expect(decideCardCharge({ ...base, card: { funding: 'credit', country: 'US' } }))
      .toEqual({ outcome: 'credit_fee', feeCents: 30_00, international: false });
  });
  it('never charges a fee on a debit card', () => {
    expect(decideCardCharge({ ...base, card: { funding: 'debit', country: 'US' } }))
      .toEqual({ outcome: 'no_fee', reason: 'debit' });
  });
  it('never charges a fee on a prepaid card', () => {
    expect(decideCardCharge({ ...base, card: { funding: 'prepaid', country: 'US' } }))
      .toEqual({ outcome: 'no_fee', reason: 'prepaid' });
  });
  it('treats an unknown funding type as no fee', () => {
    expect(decideCardCharge({ ...base, card: { funding: 'unknown', country: 'US' } }))
      .toEqual({ outcome: 'no_fee', reason: 'unknown_funding' });
  });
  it('refuses a debit card when the firm declines them', () => {
    const settings = { ...DEFAULT_CARD_FEE_SETTINGS, debitCards: 'decline' as const };
    expect(decideCardCharge({ ...base, settings, card: { funding: 'debit', country: 'US' } }))
      .toEqual({ outcome: 'refused', reason: 'debit_not_accepted' });
  });
  it('refuses a prepaid card when the firm declines debit and prepaid cards', () => {
    const settings = { ...DEFAULT_CARD_FEE_SETTINGS, debitCards: 'decline' as const };
    expect(decideCardCharge({ ...base, settings, card: { funding: 'prepaid', country: 'US' } }))
      .toEqual({ outcome: 'refused', reason: 'prepaid_not_accepted' });
  });
  it('refuses a non-US card when the firm declines them, before looking at funding', () => {
    const settings = { ...DEFAULT_CARD_FEE_SETTINGS, internationalCards: 'decline' as const };
    expect(decideCardCharge({ ...base, settings, card: { funding: 'credit', country: 'GB' } }))
      .toEqual({ outcome: 'refused', reason: 'non_us_not_accepted' });
  });
  it('charges the international rate on an accepted non-US credit card', () => {
    expect(decideCardCharge({ ...base, card: { funding: 'credit', country: 'GB' } }))
      .toEqual({ outcome: 'credit_fee', feeCents: 30_00, international: true });
  });
  it('accepts every card with no fee when the fee is not passed on', () => {
    const settings = { ...DEFAULT_CARD_FEE_SETTINGS, debitCards: 'decline' as const, internationalCards: 'decline' as const };
    expect(decideCardCharge({ ...base, passedOn: false, settings, card: { funding: 'debit', country: 'GB' } }))
      .toEqual({ outcome: 'no_fee', reason: 'fee_not_passed_on' });
  });
});

describe('normalizeUsState and stateRule', () => {
  it.each([['ca', 'CA'], ['California', 'CA'], [' new york ', 'NY'], ['D.C.', 'DC'], ['Ontario', null], ['', null], [null, null]])(
    'normalizes %p to %p', (raw, code) => expect(normalizeUsState(raw as any)).toBe(code));
  it('blocks the banned states and caps Colorado', () => {
    expect(stateRule('CT')).toEqual({ allowed: false });
    expect(stateRule('MA')).toEqual({ allowed: false });
    expect(stateRule('CA')).toEqual({ allowed: false });
    expect(stateRule('ME')).toEqual({ allowed: false });
    expect(stateRule('CO')).toEqual({ allowed: true, capPercent: 2 });
    expect(stateRule('TX')).toEqual({ allowed: true, capPercent: 3 });
  });
});

describe('cardFeeEligibility', () => {
  const firm = { stripeAccountId: 'acct_1', stripeChargesEnabled: true, state: 'Texas' };
  const confirmed = { ...DEFAULT_CARD_FEE_SETTINGS, confirmation: {
    stripeNotifiedOn: '2026-08-01', engagementLetterConfirmed: true as const, confirmedBy: 'uid', confirmedAt: '2026-08-01T00:00:00.000Z' } };
  it('is eligible for a connected firm in Texas after the notice period', () => {
    expect(cardFeeEligibility(firm, confirmed, '2026-10-10')).toEqual({
      eligible: true, reasons: [], state: 'TX', capPercent: 3, availableFrom: '2026-08-31',
    });
  });
  it('is eligible on exactly the 30th day after the firm told Stripe', () => {
    expect(cardFeeEligibility(firm, confirmed, '2026-08-31').eligible).toBe(true);
    expect(cardFeeEligibility(firm, confirmed, '2026-08-30').reasons).toEqual(['notice_period']);
  });
  it('names every reason it is not eligible', () => {
    const result = cardFeeEligibility({ ...firm, stripeChargesEnabled: false, state: 'CT' }, DEFAULT_CARD_FEE_SETTINGS, '2026-10-10');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['stripe_not_connected', 'state_banned', 'not_confirmed']);
  });
  it('waits 30 days after the firm told Stripe', () => {
    const recent = { ...confirmed, confirmation: { ...confirmed.confirmation, stripeNotifiedOn: '2026-10-01' } };
    const result = cardFeeEligibility(firm, recent, '2026-10-10');
    expect(result.reasons).toEqual(['notice_period']);
    expect(result.availableFrom).toBe('2026-10-31');
  });
  it('separates rules that block settings from the confirmation the firm still has to give', () => {
    expect(cardFeeEligibility(firm, DEFAULT_CARD_FEE_SETTINGS, '2026-10-10').reasons).toEqual(['not_confirmed']);
  });
  it('caps Colorado at 2%', () => {
    expect(cardFeeEligibility({ ...firm, state: 'Colorado' }, confirmed, '2026-10-10').capPercent).toBe(2);
  });
});
