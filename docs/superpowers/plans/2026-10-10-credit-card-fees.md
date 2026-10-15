# Credit Card Fees Implementation Plan

> **For agentic workers:** Implement this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Plan tasks usually build on each other, so execute inline by default; split a task out to a subagent only when it is genuinely independent; see the `delegating-to-subagents` skill.

**Goal:** Let a firm pass the card processing fee to its client in a way card-network rules and US law allow: a fee on US-permitted credit cards only, never more than the firm's real Stripe cost or 3%, shown to the client with the exact amount before they pay, with no Paralegix fee on those payments, so the firm receives the full invoice amount.

**Architecture:** Card payments on an invoice whose card fee is passed on move from Stripe's hosted Checkout page to Stripe's embedded Payment Element on our own pay page and portal. The client enters a card, Stripe.js turns it into a ConfirmationToken, and our server reads the card's funding type (credit, debit, prepaid) and issuing country from that token, decides the fee with one pure rules module, shows it, and only then creates and confirms a PaymentIntent on the firm's own Stripe account. The payment is recorded from `payment_intent.succeeded` (and immediately after a synchronous success) through the same `applyStripeCandidateTransaction` path Checkout uses. Bank transfers and card payments without a passed-on fee keep using hosted Checkout unchanged.

**Tech Stack:** Express 5 + TypeScript + Drizzle/Postgres (backend), Stripe Node SDK 22 on API `2026-08-26.dahlia`, Next.js 16 + React 19 (frontend), `@stripe/stripe-js` + `@stripe/react-stripe-js` (new), Jest on both sides.

---

## 0. Read this first

### What the rules require, and how this plan meets each one

| Requirement | Source | How the plan meets it |
|---|---|---|
| No fee on debit or prepaid cards | Federal debit rules (Regulation II) and card-network rules | Fee only when the card's `funding` is `credit`. Debit, prepaid and unknown get no fee. |
| Fee no more than 3% and no more than the merchant's cost | Visa (lower of 3% or cost), Stripe's US surcharge cap of 3% | `creditCardFeeCents` grosses up the firm's Stripe rate and caps the result at 3% (2% in Colorado), rounding the cap down. |
| Not allowed in some states | State law | Blocked for firms in CT, MA, ME, CA. Capped at 2% in CO. See Decisions to confirm. |
| Merchant notifies its acquirer 30 days before | Visa, Mastercard | The firm confirms the date it told Stripe. The setting can't be turned on until 30 days after that date. |
| Exact fee and total shown before payment, with a way out | Card networks, Stripe's surcharge guidance | The client sees the fee after entering the card and before paying, with "Pay by bank transfer instead". |
| Fee shown separately on the receipt | Card networks | The receipt email already shows a fee line; the label becomes "Credit card fee". |
| Fee refunded proportionally with a refund | Card networks | Refunds are done in the Stripe dashboard. The firm's payment detail shows exactly how much fee to refund. |
| Lawyer disclosure | Bar rules (ABA Formal Opinion 00-419 and state equivalents) | The firm confirms its engagement letters disclose the fee. |
| Merchant of record carries the compliance | Stripe Connect | Every card payment is a direct charge on the firm's own Stripe account, so the firm is the merchant and Paralegix is never charged. |

### Money, per payment, after this ships

| Who pays the card fee | Card | Client pays | Stripe charges the firm | Paralegix application fee | Firm receives |
|---|---|---|---|---|---|
| Client | US credit | invoice + fee | 2.9% + 30c of the total | 0 | invoice, or up to 29c less on invoices under about $2,300 |
| Client | Non-US credit, firm accepts them | invoice + fee | 4.4% + 30c of the total | 0 | invoice less about 1.5% |
| Client | Debit or prepaid, firm accepts them | invoice | 2.9% + 30c | 0.9% | invoice less about 3.8% + 30c |
| Client | Debit, prepaid or non-US, firm declines them | not charged | nothing | nothing | client is sent to bank transfer |
| Firm | any card | invoice | 2.9% + 30c | 0.9% | invoice less about 3.8% + 30c |

Bank transfers do not change.

### Decisions to confirm with the user before starting

1. **California and Maine are blocked by default.** Sources disagree on both. Blocking is the safe default; unblocking is a one-line change in `STATE_RULES`.
2. **Declining debit cards.** Card-network rules generally let a merchant accept credit and decline debit. Confirm with Stripe that a firm's account may refuse debit cards this way before Task 9 ships.
3. **Stripe's surcharge API is not used.** It is a public preview on a preview API version. This plan reads the funding type from a ConfirmationToken on the stable API instead. Revisit when the surcharge API is generally available.

### Out of scope

- An in-app refund button (refunds stay in the Stripe dashboard, with guidance).
- Apple Pay, Google Pay and Link on the card form. They are switched off in the Payment Element.
- Changing the bank-transfer fee.

## 1. Wording guide (single source for every message)

Every string below lives in one of two files and nowhere else, so the client, the firm and the emails always say the same thing:

- Backend: `backend/src/modules/stripe/cardFeeCopy.ts` (error messages and email labels).
- Frontend: `frontend/src/lib/payments/cardFeeCopy.ts` (screens).

Placeholders in braces are filled at runtime. Money is always formatted with `formatCents` on the frontend and `formatDollarsFromCents` on the backend.

### Client, before entering a card (pay page and portal)

| Situation | Card option subtitle |
|---|---|
| Fee on, debit accepted | `US credit cards add a {creditFee} card fee. Debit cards have no fee.` |
| Fee on, debit declined | `Credit cards only. US credit cards add a {creditFee} card fee.` |
| Fee on, non-US declined (append) | ` Cards must be issued in the US.` |
| Fee off | `No fee` (unchanged) |

Under the card form, before the card is checked: `Enter your card to see the exact total before you pay.`

### Client, after the card is checked

| Outcome | Heading | Body | Primary button | Secondary button |
|---|---|---|---|---|
| Credit card fee | `Credit card fee: {fee}` | `{firm} adds a fee of up to 3% to credit card payments to cover processing costs. Your total is {total}. You can avoid the fee by paying by bank transfer{debitAccepted ? " or with a debit card" : ""}.` | `Pay {total}` | `Pay by bank transfer instead` |
| Debit or prepaid, accepted | `No card fee` | `Debit and prepaid cards can't carry a card fee, so you pay {invoice}.` | `Pay {invoice}` | none |
| Funding unknown | `No card fee` | `You pay {invoice}.` | `Pay {invoice}` | none |
| Debit or prepaid, declined | `Debit and prepaid cards aren't accepted` | `{firm} accepts credit cards and bank transfers for this invoice. Use a credit card, or pay by bank transfer.` | `Pay by bank transfer instead` | `Use a different card` |
| Non-US card, declined | `Cards from outside the US aren't accepted` | `{firm} accepts cards issued in the US. Use a US card, or pay by bank transfer.` | `Pay by bank transfer instead` | `Use a different card` |

Footer under the result: `The card fee is listed separately on your receipt.` (only when there is a fee).

Errors:
- Fee changed between check and pay: `The amount changed since you checked your card. Please review the new total.`
- Card declined: Stripe's own decline message, which Stripe writes for cardholders.

### Receipt email

Fee line label: `Credit card fee` for a card payment, `Bank transfer fee` for a bank payment.

### Firm, settings (Billing settings, "Online payment fees")

Card section:
- Toggle label: `Clients pay a fee on credit cards`
- Toggle description: `Your client pays the card fee on credit cards, so your firm receives the full invoice amount. On invoices under about $2,300 the 3% limit can leave you up to 30 cents short.`
- "How card fees work" list:
  - `Credit cards only. The law doesn't allow a fee on debit or prepaid cards.`
  - `The fee covers your Stripe cost and is never more than 3% of the payment (2% for firms in Colorado).`
  - `Clients see the exact fee after entering their card and before they pay, and can switch to bank transfer.`
  - `Not available for firms in California, Connecticut, Maine or Massachusetts.`
  - `Paralegix takes no fee on credit card payments where your client pays the card fee.`
  - `If you refund a payment, refund the card fee too: all of it for a full refund, or the same share for a partial one.`
- Debit choice, label `Debit and prepaid cards`, options:
  - `Accept them. My firm pays their processing fee.`
  - `Don't accept them. Clients pay by credit card or bank transfer.`
- Non-US choice, label `Cards issued outside the US`, options:
  - `Accept them. My firm pays Stripe's extra 1.5%.`
  - `Only accept cards issued in the US.`
- Rate fields, label `Your Stripe card rate`, help: `The card fee can't be more than what Stripe charges your firm. Stripe's standard rate is 2.9% + 30 cents. Change this only if Stripe gave your firm a different rate.`
- Confirmations, required to turn the toggle on:
  - Date field label `Date your firm told Stripe it adds a credit card fee`, help `Card networks require 30 days' notice. Contact Stripe support to give it.`
  - Checkbox `Our engagement letters tell clients about the credit card fee.`
- Not available reasons (shown instead of the toggle, one line each):
  - `stripe_not_connected`: `Connect Stripe in Payments settings to use card fees.`
  - `state_missing`: `Add your firm's state in Firm settings to use card fees.`
  - `state_banned`: `Card fees aren't allowed for firms in {stateName}.`
  - `notice_period`: `You can turn this on from {date}, 30 days after you told Stripe.`

Bank section:
- Toggle label: `Clients pay the bank transfer fee`
- Description: `Bank transfers cost 0.8% (up to $5) plus a 0.9% Paralegix fee. Your client pays it on top, so your firm receives the full invoice amount.`

### Firm, request payment dialog

Two checkboxes replace the single one:
- `Client pays the credit card fee` (disabled with the not-available reason when the firm can't use card fees)
- `Client pays the bank transfer fee`

Breakdown lines (one per row the quote returns):
- `US credit card: client pays a {fee} card fee, {total} in total. You receive {firmReceives}.`
- `Debit or prepaid card: no card fee allowed. You pay about {firmCost} and receive {firmReceives}.`
- `Debit or prepaid card: not accepted. The client pays by credit card or bank transfer.`
- `Card from outside the US: client pays a {fee} card fee. You pay Stripe's extra 1.5% and receive about {firmReceives}.`
- `Card from outside the US: not accepted.`
- `Card: your firm pays the {fee} fee. You receive {firmReceives}.` (fee not passed on)
- `Bank transfer: ...` (unchanged)

### Firm, invoice payment detail (a payment that carried a credit card fee)

`Includes a {fee} credit card fee paid by the client. If you refund this payment in Stripe, refund the fee too: {fee} for a full refund, or the same share of it for a partial refund.`

### Firm, Payments settings "How it works" step 3

`The client gets a secure link and pays by card or bank transfer. If you pass on card fees, credit card payments include the fee and debit cards never do.`

## 2. File map

Backend, new:
- `backend/src/modules/stripe/cardFeeRules.ts`: pure rules. State table, state-name normalisation, fee math, the per-card decision, firm eligibility.
- `backend/src/modules/stripe/cardFeeCopy.ts`: backend strings from the wording guide.
- `backend/src/modules/stripe/cardFeeSettings.service.ts`: read and write the firm's card fee settings and confirmations.
- `backend/src/modules/stripe/cardPayment.service.ts`: card setup for the pay page, quote, confirm, complete, and PaymentIntent webhook recording.
- `backend/db/migrations/0047_invoice_card_payment_intent.sql`: the in-flight PaymentIntent pointer on `invoices`.

Backend, modified:
- `backend/src/modules/billing/shared/billingSettings.ts`: `cardFees` defaults and merge.
- `backend/src/modules/settings/settings.validation.ts`, `settings.defaults.ts`: generic firm-settings PUT can no longer switch the card fee on.
- `backend/src/modules/billing/shared/workbench.routes.ts`: `GET/PUT /billing/card-fees`.
- `backend/src/modules/stripe/stripe.service.ts`: export helpers, clear the new pointer, request/quote eligibility, Checkout never adds a card fee, `closeInvoicePaymentSurfaces` handles the card PaymentIntent.
- `backend/src/modules/stripe/payLink.service.ts`, `payLink.routes.ts`: card setup on the page, three card routes.
- `backend/src/modules/clients/portal/portal.service.ts`, `portal.routes.ts`: the same for the portal.
- `backend/src/modules/stripe/stripe.webhook.routes.ts`: Connect `payment_intent.*` for invoice card payments.
- `backend/src/modules/billing/invoices/invoices.service.ts`: `expireStaleCheckoutSession` also cancels an abandoned card PaymentIntent.
- `backend/src/modules/billing/billing.events.ts`, `backend/src/shared/services/emailService.ts`: receipt fee label.
- `backend/db/schema/70_billing.sql`, `backend/db/schema.sql`, `backend/src/shared/database/drizzle/schema.ts`, `invoices.repository.ts`: new columns.

Frontend, new:
- `frontend/src/lib/payments/cardFeeCopy.ts`
- `frontend/src/lib/payments/stripeClient.ts`: one cached `loadStripe` per connected account.
- `frontend/src/components/payments/CardPaymentPanel.tsx`: the card form, check, result and pay.
- `frontend/src/components/billingComp/CardFeeSettings.tsx`: the settings card.
- `frontend/src/services/cardFees.service.ts`: firm settings calls.

Frontend, modified:
- `frontend/package.json`, `.env.example`
- `frontend/src/services/payLink.service.ts`, `client-portal.service.ts`, `billing.service.ts`
- `frontend/src/app/pay/[token]/page.tsx`, `frontend/src/components/portalComp/PaymentMethodOptions.tsx`, `PaymentMethodDialog.tsx`, `frontend/src/hooks/billingHooks/usePortalPayment.ts`
- `frontend/src/components/billingComp/BillingSettingsView.tsx`, `PaymentRequestFees.tsx`, `PaymentFeeBreakdown.tsx`, `InvoiceDetailPayments.tsx`
- `frontend/src/app/lawfirm/[lawFirmId]/settings/payments/page.tsx`

Docs: `docs/features/stripe-payments.md`, `docs/dev/ops/webhooks.md`, the billing user guide pages under `docs/billing/`.

## 3. Conventions for every task

- Backend tests: `cd backend && TEST_DB_SLOT=5 npx jest <file> --runInBand`. Never the full `npm test`.
- Frontend tests: `cd frontend && npm run test:unit -- <file>`.
- Each task ends with typecheck and lint for the package it touched: `cd backend && npm run typecheck && npm run lint`, or `cd frontend && npm run ci:checks`.
- No em-dashes anywhere. Comments say what and why, never "added for card fees plan".
- Leave everything uncommitted.

---

## Phase A: rules (pure, no I/O)

### Task 1: Card fee rules module

**Files:**
- Create: `backend/src/modules/stripe/cardFeeRules.ts`
- Test: `backend/tests/stripe/cardFeeRules.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
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
  it('refuses a non-US card when the firm declines them, before looking at funding', () => {
    const settings = { ...DEFAULT_CARD_FEE_SETTINGS, internationalCards: 'decline' as const };
    expect(decideCardCharge({ ...base, settings, card: { funding: 'credit', country: 'GB' } }))
      .toEqual({ outcome: 'refused', reason: 'non_us_not_accepted' });
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
    expect(stateRule('CO')).toEqual({ allowed: true, capPercent: 2 });
    expect(stateRule('TX')).toEqual({ allowed: true, capPercent: 3 });
  });
});

describe('cardFeeEligibility', () => {
  const firm = { stripeAccountId: 'acct_1', stripeChargesEnabled: true, state: 'Texas' };
  const confirmed = { ...DEFAULT_CARD_FEE_SETTINGS, confirmation: {
    stripeNotifiedOn: '2026-08-01', engagementLetterConfirmed: true, confirmedBy: 'uid', confirmedAt: '2026-08-01T00:00:00.000Z' } };
  it('is eligible for a connected firm in Texas after the notice period', () => {
    expect(cardFeeEligibility(firm, confirmed, '2026-10-10')).toEqual({
      eligible: true, reasons: [], state: 'TX', capPercent: 3, availableFrom: '2026-08-31',
    });
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
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `cd backend && TEST_DB_SLOT=5 npx jest tests/stripe/cardFeeRules.test.ts --runInBand`
Expected: FAIL, "Cannot find module '../../src/modules/stripe/cardFeeRules'".

- [ ] **Step 3: Implement**

```ts
// Which card payments may carry a client-paid card fee, and how much. US card
// rules allow a fee on credit cards only, no more than the merchant's real cost
// of accepting the card and no more than 3%, and some states ban it or cap it
// lower. Everything here is pure so the pay page, the request dialog and the
// charge itself all reach the same answer.
import { percentOfCents } from '../billing/shared/money';

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
  { ratePercent, fixedCents, capPercent, international }: { ratePercent: number; fixedCents: number; capPercent: number; international: boolean },
): number {
  const invoice = Math.round(Number(invoiceCents) || 0);
  if (invoice <= 0) return 0;
  const rate = ratePercent + (international ? INTERNATIONAL_EXTRA_PERCENT : 0);
  const cap = Math.floor((invoice * Math.round(capPercent * 100)) / 10_000);
  const cost = (gross: number) => percentOfCents(gross, rate) + fixedCents;
  let fee = Math.max(0, Math.floor((invoice * rate / 100 + fixedCents) / (1 - rate / 100)) - 2);
  while (fee < cap && invoice + fee - cost(invoice + fee) < invoice) fee += 1;
  return Math.min(fee, cap);
}

export type CardChargeDecision =
  | { outcome: 'credit_fee'; feeCents: number; international: boolean }
  | { outcome: 'no_fee'; reason: 'debit' | 'prepaid' | 'unknown_funding' | 'fee_not_passed_on' }
  | { outcome: 'refused'; reason: 'debit_not_accepted' | 'prepaid_not_accepted' | 'non_us_not_accepted' };

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

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Whether a firm may pass the card fee on, and every reason it may not. `today`
 * is the firm's own calendar day ('YYYY-MM-DD').
 */
export function cardFeeEligibility(
  firm: { stripeAccountId?: string | null; stripeChargesEnabled?: boolean; state?: string | null },
  settings: CardFeeSettings,
  today: string,
) {
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
```

- [ ] **Step 4: Run to confirm they pass**

Run: `cd backend && TEST_DB_SLOT=5 npx jest tests/stripe/cardFeeRules.test.ts --runInBand`
Expected: PASS. If a gross-up assertion is off by a cent, recompute it by hand with the formula in the test; do not loosen it to `toBeCloseTo`.

- [ ] **Step 5: Prove the debit test guards something**

Temporarily change `if (card.funding === 'debit' || card.funding === 'prepaid')` to `if (card.funding === 'prepaid')`, rerun, confirm "never charges a fee on a debit card" fails, then restore.

- [ ] **Step 6: Typecheck and lint**

Run: `cd backend && npm run typecheck && npm run lint`. Expected: exit 0.

### Task 2: Backend wording file

**Files:**
- Create: `backend/src/modules/stripe/cardFeeCopy.ts`

- [ ] **Step 1: Write it**

```ts
// User-facing text about card fees that the backend sends: refusals and the
// receipt label. The frontend keeps the screen text in its own copy file with
// the same wording.
import type { CardChargeDecision, IneligibleReason } from './cardFeeRules';
import { stateName } from './cardFeeRules';

export const RECEIPT_FEE_LABEL = { card: 'Credit card fee', bank: 'Bank transfer fee' } as const;

export const FEE_CHANGED_MESSAGE = 'The amount changed since you checked your card. Please review the new total.';

export function refusalMessage(reason: Extract<CardChargeDecision, { outcome: 'refused' }>['reason'], firmName: string) {
  if (reason === 'non_us_not_accepted') {
    return `${firmName} accepts cards issued in the US. Use a US card, or pay by bank transfer.`;
  }
  return `${firmName} accepts credit cards and bank transfers for this invoice. Use a credit card, or pay by bank transfer.`;
}

export function ineligibleMessage(reason: IneligibleReason, ctx: { state: string | null; availableFrom: string | null }) {
  switch (reason) {
    case 'stripe_not_connected': return 'Connect Stripe in Payments settings to use card fees.';
    case 'state_missing': return "Add your firm's state in Firm settings to use card fees.";
    case 'state_banned': return `Card fees aren't allowed for firms in ${ctx.state ? stateName(ctx.state) : 'your state'}.`;
    case 'not_confirmed': return 'Confirm the date your firm told Stripe and that your engagement letters disclose the fee.';
    case 'notice_period': return `You can turn this on from ${ctx.availableFrom}, 30 days after you told Stripe.`;
  }
}
```

- [ ] **Step 2: Typecheck**: `cd backend && npm run typecheck`. Expected: exit 0.

---

## Phase B: firm settings and eligibility

### Task 3: Store card fee settings

**Files:**
- Modify: `backend/src/modules/billing/shared/billingSettings.ts:30-60`
- Modify: `backend/src/modules/settings/settings.defaults.ts:77`
- Modify: `backend/src/modules/settings/settings.validation.ts:198-205`
- Test: `backend/tests/billing/processingFeeSettings.test.ts` (existing, extend)

- [ ] **Step 1: Write the failing tests** (append to `processingFeeSettings.test.ts`, reusing its existing firm and owner setup)

```ts
it('reads default card fee settings for a firm that never saved any', async () => {
  const res = await owner.api.get(`/api/lawfirms/${firm.id}/billing/settings`);
  expect(res.status).toBe(200);
  expect(res.body.settings.cardFees).toEqual({
    debitCards: 'absorb', internationalCards: 'absorb', ratePercent: 2.9, fixedCents: 30, confirmation: null,
  });
});

it('refuses to switch the card fee on through the generic firm settings route', async () => {
  const res = await owner.api.put(`/api/lawfirms/${firm.id}/settings/firm`)
    .send({ settings: { billing: { processingFees: { card: 'client' } } } });
  expect(res.status).toBe(400);
  const stored = await testPool.query(`select settings->'billing'->'processingFees' as p from law_firms where id = $1`, [firm.id]);
  expect(stored.rows[0].p?.card ?? 'firm').toBe('firm');
});

it('still lets the generic route turn the bank fee on and the card fee off', async () => {
  const res = await owner.api.put(`/api/lawfirms/${firm.id}/settings/firm`)
    .send({ settings: { billing: { processingFees: { card: 'firm', bank: 'client' } } } });
  expect(res.status).toBe(200);
});
```

Check the GET response's actual envelope in the existing test file first (`res.body.settings` vs `res.body`), and match it.

- [ ] **Step 2: Run to confirm they fail**: `cd backend && TEST_DB_SLOT=5 npx jest tests/billing/processingFeeSettings.test.ts --runInBand`. Expected: the three new cases FAIL.

- [ ] **Step 3: Implement**

In `billingSettings.ts`, add the group and merge it:

```ts
import { DEFAULT_CARD_FEE_SETTINGS } from '../../stripe/cardFeeRules';
// inside BILLING_SETTINGS_DEFAULTS, after processingFees:
  // cardFees: what the firm decided about debit and non-US cards, its Stripe
  // rate (the ceiling on any card fee), and its confirmation that it told
  // Stripe and its clients. Written only by PUT /billing/card-fees.
  cardFees: { ...DEFAULT_CARD_FEE_SETTINGS },
```

and change `NESTED_GROUPS` to `['timeRounding', 'lateFee', 'tax', 'processingFees', 'cardFees'] as const`.

In `settings.defaults.ts:77` add `cardFees: { debitCards: 'absorb', internationalCards: 'absorb', ratePercent: 2.9, fixedCents: 30, confirmation: null },` beside `processingFees`.

In `settings.validation.ts`, replace the `processingFees` block:

```ts
          // Strict: these values decide what a client is charged. The card fee
          // can only be switched ON through PUT /billing/card-fees, which checks
          // the firm may use it and records its confirmation.
          processingFees: z
            .object({
              card: z.literal('firm', { message: 'Turn on credit card fees in Billing settings.' }).optional(),
              bank: z.enum(['firm', 'client']).optional(),
            })
            .strict()
            .optional(),
```

and reject `cardFees` on this route by adding `cardFees: z.never().optional(),` inside the billing object.

- [ ] **Step 4: Run the tests**: same command. Expected: PASS.
- [ ] **Step 5: Typecheck and lint**: `cd backend && npm run typecheck && npm run lint`.

### Task 4: Card fee settings routes

**Files:**
- Create: `backend/src/modules/stripe/cardFeeSettings.service.ts`
- Modify: `backend/src/modules/billing/shared/workbench.routes.ts` (after the `/settings` routes, line ~94)
- Test: `backend/tests/billing/cardFeeSettings.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { createFirm, ownerOf, memberWith, testPool, type Firm, type Actor } from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
const url = () => `/api/lawfirms/${firm.id}/billing/card-fees`;
const turnOn = {
  clientPays: true, debitCards: 'decline', internationalCards: 'absorb', ratePercent: 2.9, fixedCents: 30,
  stripeNotifiedOn: '2026-08-01', engagementLetterConfirmed: true,
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await testPool.query(
    `update law_firms set stripe_account_id = 'acct_cardfees', stripe_charges_enabled = true,
            direct_charges_enabled = true, state = 'Texas' where id = $1`, [firm.id]);
});

it('turns card fees on for an eligible firm and records who confirmed', async () => {
  const res = await owner.api.put(url()).send(turnOn);
  expect(res.status).toBe(200);
  expect(res.body.clientPays).toBe(true);
  expect(res.body.debitCards).toBe('decline');
  expect(res.body.confirmation).toMatchObject({ stripeNotifiedOn: '2026-08-01', engagementLetterConfirmed: true, confirmedBy: owner.uid });
  const stored = await testPool.query(`select settings->'billing' as b from law_firms where id = $1`, [firm.id]);
  expect(stored.rows[0].b.processingFees.card).toBe('client');
});

it('refuses a firm whose Stripe account is not connected and leaves the fee off', async () => {
  await testPool.query(`update law_firms set stripe_charges_enabled = false where id = $1`, [firm.id]);
  const res = await owner.api.put(url()).send(turnOn);
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/Connect Stripe/);
  const stored = await testPool.query(`select settings->'billing'->'processingFees' as p from law_firms where id = $1`, [firm.id]);
  expect(stored.rows[0].p?.card ?? 'firm').toBe('firm');
});

it('refuses a firm in Connecticut', async () => {
  await testPool.query(`update law_firms set state = 'CT' where id = $1`, [firm.id]);
  const res = await owner.api.put(url()).send(turnOn);
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/Connecticut/);
});

it('refuses until 30 days after the firm told Stripe', async () => {
  const res = await owner.api.put(url()).send({ ...turnOn, stripeNotifiedOn: '2026-10-05' });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/2026-11-04/);
});

it('lets the firm turn card fees off without any confirmation', async () => {
  await owner.api.put(url()).send(turnOn);
  const res = await owner.api.put(url()).send({ clientPays: false, debitCards: 'absorb', internationalCards: 'absorb', ratePercent: 2.9, fixedCents: 30 });
  expect(res.status).toBe(200);
  expect(res.body.clientPays).toBe(false);
});

it('reports eligibility and reasons on GET', async () => {
  await testPool.query(`update law_firms set state = null where id = $1`, [firm.id]);
  const res = await owner.api.get(url());
  expect(res.status).toBe(200);
  expect(res.body.eligibility.reasons).toEqual(['state_missing', 'not_confirmed']);
});

it('refuses a member without settings.manageFirm', async () => {
  const member = await memberWith(firm.id, ['billing.viewInvoices']);
  expect((await member.api.put(url()).send(turnOn)).status).toBe(403);
});

it("refuses another firm's owner", async () => {
  const other = await ownerOf((await createFirm()).id);
  expect((await other.api.put(url()).send(turnOn)).status).toBe(403);
});

it('rejects a rate above Stripe standard pricing plus margin of error', async () => {
  const res = await owner.api.put(url()).send({ ...turnOn, ratePercent: 9 });
  expect(res.status).toBe(400);
});
```

The "today" used by the 30-day check is the firm's calendar day. Freeze the clock at `2026-10-10` the way other billing tests do (search `jest.useFakeTimers` or a `now` helper in `tests/billing/`), so the dates above stay valid.

- [ ] **Step 2: Run to confirm they fail**: `cd backend && TEST_DB_SLOT=5 npx jest tests/billing/cardFeeSettings.test.ts --runInBand`. Expected: FAIL with 404 on the route.

- [ ] **Step 3: Implement the service**

```ts
// The firm's credit card fee setting: on or off, what happens to debit and
// non-US cards, its Stripe rate, and its confirmation that it gave Stripe the
// required notice and discloses the fee in its engagement letters. Turning the
// fee on is refused, with every reason, unless the firm may use it.
import { cardFeeEligibility, type CardFeeSettings } from './cardFeeRules';
import { ineligibleMessage } from './cardFeeCopy';
import { getFirmBillingSettings, setFirmBillingSettings } from '../billing/shared/billingSettings';

const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { firmToday } = require('../../shared/utils/personalDay');

async function load(lawFirmId: string) {
  const firm = await lawfirmsRepo.findById(lawFirmId);
  if (!firm) throw new NotFoundError('Law firm');
  const billing = await getFirmBillingSettings(lawFirmId);
  const today = await firmToday(lawFirmId);
  return { firm, billing, today };
}

function shape(firm: any, billing: any, today: string) {
  const cardFees: CardFeeSettings = billing.cardFees;
  return {
    clientPays: billing.processingFees.card === 'client',
    ...cardFees,
    eligibility: cardFeeEligibility(firm, cardFees, today),
  };
}

export async function getCardFeeSettings({ lawFirmId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const { firm, billing, today } = await load(lawFirmId);
  return shape(firm, billing, today);
}

export async function updateCardFeeSettings({ lawFirmId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const { firm, billing, today } = await load(lawFirmId);
  const previous: CardFeeSettings = billing.cardFees;
  const confirmation = body.stripeNotifiedOn && body.engagementLetterConfirmed === true
    ? {
      stripeNotifiedOn: body.stripeNotifiedOn,
      engagementLetterConfirmed: true as const,
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
```

Before writing, check `backend/src/shared/utils/personalDay.ts` for the helper that returns a firm's calendar day as `'YYYY-MM-DD'` and use its real name; the `handling-dates-and-times` skill names it. If none returns a firm day, add `firmToday(lawFirmId)` there with a test, using the firm's stored time zone.

- [ ] **Step 4: Add the routes** in `workbench.routes.ts`, after `PUT /settings`:

```ts
const cardFeeSettings = require('../../stripe/cardFeeSettings.service');

const cardFeesSchema = z.object({
  body: z.object({
    clientPays: z.boolean(),
    debitCards: z.enum(['absorb', 'decline']),
    internationalCards: z.enum(['absorb', 'decline']),
    // A firm's negotiated rate is lower than standard, never meaningfully higher.
    ratePercent: z.number().min(0).max(3.5),
    fixedCents: z.number().int().min(0).max(50),
    stripeNotifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    engagementLetterConfirmed: z.boolean().optional(),
  }).strict(),
});

// GET /api/lawfirms/:lawFirmId/billing/card-fees
router.get('/card-fees',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  handler(async (req) => cardFeeSettings.getCardFeeSettings({ lawFirmId: req.params.lawFirmId, actingUserId: req.user.uid })),
);

// PUT /api/lawfirms/:lawFirmId/billing/card-fees
router.put('/card-fees',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(cardFeesSchema),
  handler(async (req) => cardFeeSettings.updateCardFeeSettings({
    lawFirmId: req.params.lawFirmId, actingUserId: req.user.uid, body: req.body,
  })),
);
```

Use the file's existing `z` import (add one if it has none).

- [ ] **Step 5: Run the tests**: same command. Expected: PASS.
- [ ] **Step 6: Typecheck and lint.**

### Task 5: Requests and the firm's fee quote respect eligibility

**Files:**
- Modify: `backend/src/modules/stripe/stripe.service.ts` (`resolveFeeChoice` ~1492, `getPaymentFeeQuote` ~1527, `requestPayment` ~1568)
- Test: `backend/tests/stripe/clientPaidFeeRequests.test.ts` (existing, extend)

- [ ] **Step 1: Write the failing tests** (in the existing file, reusing its firm, invoice and request helpers)

```ts
it('refuses a request that passes the card fee on for a firm that may not', async () => {
  await testPool.query(`update law_firms set state = 'CT' where id = $1`, [firm.id]);
  const res = await requestWith({ isCardFeePassedOn: true });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/Connecticut/);
});

it('drops the card fee default for a firm that may not use it, instead of failing the request', async () => {
  await testPool.query(`update law_firms set state = 'CT' where id = $1`, [firm.id]);
  await testPool.query(
    `update law_firms set settings = jsonb_set(coalesce(settings,'{}'), '{billing,processingFees}', '{"card":"client","bank":"firm"}') where id = $1`, [firm.id]);
  const res = await requestWith({});
  expect(res.status).toBe(200);
  const inv = await testPool.query('select is_card_fee_passed_on from invoices where id = $1', [invoiceId]);
  expect(inv.rows[0].is_card_fee_passed_on).toBe(false);
});

it('quotes credit, debit and non-US card rows for an eligible firm', async () => {
  await makeEligible(firm.id, { debitCards: 'decline', internationalCards: 'absorb' });
  const res = await quoteWith({ card: 'true' });
  const card = res.body.methods.find((m: any) => m.method === 'card');
  expect(card.cardRows).toEqual([
    { kind: 'us_credit', paidBy: 'client', feeCents: 7_50, clientPaysCents: 257_50, firmReceivesCents: 249_73 },
    { kind: 'debit', accepted: false },
    { kind: 'non_us_credit', paidBy: 'client', feeCents: 7_50, clientPaysCents: 257_50, firmReceivesCents: 245_87 },
  ]);
});
```

`requestWith`, `quoteWith` and `makeEligible` are small helpers you add at the top of the test file: the first two wrap the existing request and fee-quote calls with a body or query, and `makeEligible` sets `direct_charges_enabled`, `state = 'TX'`, and writes `settings.billing.cardFees` with a confirmation dated `2026-08-01` plus `processingFees.card = 'client'`. Compute `firmReceivesCents` by hand from the table in section 0 (Stripe 2.9% + 30c, or 4.4% + 30c, on the client total) and put the result in the assertion; the numbers above are for a $250.00 invoice and must be re-derived if the fixture amount differs.

- [ ] **Step 2: Run to confirm they fail.**

- [ ] **Step 3: Implement**

Change `resolveFeeChoice` to take the firm's eligibility:

```ts
async function resolveFeeChoice(lawFirmId: string, choice: FeeChoice = {}) {
  const billing = await getFirmBillingSettings(lawFirmId);
  const firm = await lawfirmsRepo.findById(lawFirmId);
  const eligibility = cardFeeEligibility(firm || {}, billing.cardFees, await firmToday(lawFirmId));
  const firmDefault = {
    card: billing.processingFees.card === 'client' && eligibility.eligible,
    bank: billing.processingFees.bank === 'client',
  };
  if (choice.card === true && !eligibility.eligible) {
    throw new ValidationError({ isCardFeePassedOn: eligibility.reasons.map((r) => ineligibleMessage(r, eligibility)) });
  }
  const passedOn = {
    card: typeof choice.card === 'boolean' ? choice.card : firmDefault.card,
    bank: typeof choice.bank === 'boolean' ? choice.bank : firmDefault.bank,
  };
  return { passedOn, firmDefault, eligibility, cardFees: billing.cardFees as CardFeeSettings };
}
```

In `getPaymentFeeQuote`, build the card entry with rows when `passedOn.card`:

```ts
function cardRowsFor(invoiceCents: number, cardFees: CardFeeSettings, capPercent: number) {
  const stripeCost = (gross: number, intl: boolean) =>
    percentOfCents(gross, cardFees.ratePercent + (intl ? INTERNATIONAL_EXTRA_PERCENT : 0)) + cardFees.fixedCents;
  const credit = (kind: 'us_credit' | 'non_us_credit', intl: boolean) => {
    const feeCents = creditCardFeeCents(invoiceCents, { ...cardFees, capPercent, international: intl });
    const total = invoiceCents + feeCents;
    return { kind, paidBy: 'client', feeCents, clientPaysCents: total, firmReceivesCents: total - stripeCost(total, intl) };
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
```

and in the `methods` map: for `method === 'card' && passedOn.card`, return `{ method, paidBy: 'client', cardRows: cardRowsFor(invoiceCents, cardFees, eligibility.capPercent) }`; every other branch stays as it is. Add `cardFeeEligibility: { eligible, reasons }` to the quote response so the dialog can disable the checkbox with the reason.

Imports at the top of `stripe.service.ts`:

```ts
import { cardFeeEligibility, creditCardFeeCents, INTERNATIONAL_EXTRA_PERCENT, type CardFeeSettings } from './cardFeeRules';
import { ineligibleMessage } from './cardFeeCopy';
import { percentOfCents } from '../billing/shared/money';
```

- [ ] **Step 4: Checkout never adds a card fee.** In `createClientCheckoutUrl` (~1742), change the surcharge line to:

```ts
  // A card fee is only ever charged through the card form, which knows the
  // card type first. Checkout cannot tell credit from debit, so a card
  // checkout carries no fee whatever the invoice says.
  const surchargeCents = method === 'bank' && invoice.isBankFeePassedOn ? clientSurchargeCents('bank', requestedCents) : 0;
```

Find the test in `clientPaidFeeRequests.test.ts` or `payLink.test.ts` that asserts a card Checkout carries a "Card processing fee" line item; change only that assertion to expect no fee line, and say so in the task notes.

- [ ] **Step 5: Run** `clientPaidFeeRequests`, `payLink`, `stripePaymentRequests`, `processingFees` tests. Expected: PASS.
- [ ] **Step 6: Typecheck and lint.**

---

## Phase C: schema

### Task 6: Migration for the in-flight card PaymentIntent

**Files:**
- Create: `backend/db/migrations/0047_invoice_card_payment_intent.sql`
- Modify: `backend/db/schema/70_billing.sql` (next to `stripe_checkout_session_account_id`, line ~110), regenerate `backend/db/schema.sql`
- Modify: `backend/src/shared/database/drizzle/schema.ts` (invoices table), `backend/src/modules/billing/invoices/invoices.repository.ts` (field mapping)

- [ ] **Step 1: Follow the `new-migration` skill end to end.** The migration is expand-only:

```sql
-- mode: expand
-- A card payment taken through the card form waiting on the client (a bank
-- verification step) or on Stripe. Nothing else may charge the invoice while
-- it is set, and closing the invoice's payment surfaces cancels it.
alter table invoices add column if not exists stripe_card_payment_intent_id text;
alter table invoices add column if not exists stripe_card_payment_intent_account_id text;

comment on column invoices.stripe_card_payment_intent_id is 'PaymentIntent of a card-form payment not yet settled; cleared when it succeeds, fails or is cancelled.';
comment on column invoices.stripe_card_payment_intent_account_id is 'Stripe account stripe_card_payment_intent_id was created on (an acct_ id).';
```

Match the first-line mode marker and comment style of `0044_invoice_pay_link_installment.sql`.

- [ ] **Step 2:** Map the fields as `stripeCardPaymentIntentId` / `stripeCardPaymentIntentAccountId` in Drizzle and the repository, the same way `stripeCheckoutSessionAccountId` is mapped.
- [ ] **Step 3:** `cd backend && npm run db:schema:build && npm run db:catalog-parity && DB_TARGET=local npm run db:drift`. Expected: all OK.
- [ ] **Step 4:** Rebuild your test slot from the new schema as the skill describes, then run `tests/schema/` on it. Expected: PASS.

---

## Phase D: the card payment backend

### Task 7: Export the shared Stripe helpers

**Files:**
- Modify: `backend/src/modules/stripe/stripe.service.ts`

- [ ] **Step 1:** Export, without changing behaviour: `applyStripeCandidateTransaction`, `emitStripePaymentReceived`, `stripeDay`, the firm time-zone helper used in `handleCheckoutCompleted` (`firmZone`), `invoiceChargeScopeFor`, `getOrCreateConnectedCustomer`, `resolveInvoiceStripeBilling` and `refreshCalendarAfterStripePayment` if such a helper exists (otherwise the inline `invoicesService.refreshInvoiceCalendarSyncAfterPersistence` call is copied in Task 8).
- [ ] **Step 2:** In `applyStripeCandidate` (~451), clear the card pointer next to the session pointer:

```ts
    stripeCheckoutSessionId: candidate.clearCheckoutSession ? null : (invoice.stripeCheckoutSessionId || null),
    ...(candidate.clearCheckoutSession ? { stripeCheckoutSessionAccountId: null } : {}),
    ...(candidate.clearCardPaymentIntent && invoice.stripeCardPaymentIntentId === candidate.stripePaymentIntentId
      ? { stripeCardPaymentIntentId: null, stripeCardPaymentIntentAccountId: null }
      : {}),
```

and make sure `buildInvoiceUpdateData` writes both new fields (search it for `stripeCheckoutSessionAccountId` and add the pair beside it).

- [ ] **Step 3:** `npm run db:dead-exports` must still pass (Task 8 is the reader); run it after Task 8 if it flags these.
- [ ] **Step 4:** Run `tests/stripe/stripeWebhookState.test.ts` and `tests/stripe/payLink.test.ts`. Expected: PASS, unchanged.

### Task 8: Card payment service

**Files:**
- Create: `backend/src/modules/stripe/cardPayment.service.ts`
- Test: `backend/tests/stripe/cardPayment.test.ts`

The service has four entry points. Pay link and portal callers in Task 9 resolve the invoice and identity, then call these.

- [ ] **Step 1: Write the failing tests.** Mock Stripe as `payLink.test.ts` does, adding `confirmationTokens: { retrieve: fn() }` and `paymentIntents: { create, retrieve, cancel }`. Seed an eligible firm (connected account `acct_card` with direct charges, state TX, confirmation dated `2026-08-01`, `processingFees.card = 'client'`) and a $250.00 invoice with `stripe_payment_requested = true`, a pay link token and `is_card_fee_passed_on = true`. Helper:

```ts
const token = (funding: string, country = 'US') => ({
  id: 'ctoken_1', object: 'confirmation_token',
  payment_method_preview: { type: 'card', card: { brand: 'visa', last4: '4242', funding, country } },
});
```

Cases (write each as its own `it`):

```ts
it('quotes a US credit card with the capped fee and touches no PaymentIntent', async () => {
  fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));
  const res = await request.post(`/api/pay/${TOKEN}/card/quote`).send({ confirmationTokenId: 'ctoken_1' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    outcome: 'credit_fee', feeCents: 7_50, invoiceCents: 250_00, totalCents: 257_50,
    card: { brand: 'visa', last4: '4242', funding: 'credit', country: 'US' },
  });
  expect(fake().confirmationTokens.retrieve).toHaveBeenCalledWith('ctoken_1', { stripeAccount: 'acct_card' });
  expect(fake().paymentIntents.create).not.toHaveBeenCalled();
});

it('quotes a debit card with no fee', async () => { /* funding 'debit' -> outcome 'no_fee', reason 'debit', feeCents 0, totalCents 250_00 */ });

it('refuses a debit card when the firm declines them, with the wording-guide message', async () => {
  /* set cardFees.debitCards = 'decline'; quote -> 200 with outcome 'refused', reason 'debit_not_accepted',
     message equal to refusalMessage('debit_not_accepted', 'Pay Link LLP') */
});

it('charges the quoted total with no application fee on a credit card', async () => {
  fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));
  fake().paymentIntents.create.mockResolvedValue({ id: 'pi_card_1', status: 'succeeded', amount_received: 257_50, created: 1_790_000_000,
    metadata: { /* echo what create was called with */ } });
  const res = await request.post(`/api/pay/${TOKEN}/card/confirm`).send({ confirmationTokenId: 'ctoken_1', expectedTotalCents: 257_50 });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'succeeded' });
  const [params, opts] = fake().paymentIntents.create.mock.calls[0];
  expect(params).toMatchObject({ amount: 257_50, currency: 'usd', confirm: true, confirmation_token: 'ctoken_1', payment_method_types: ['card'] });
  expect(params.application_fee_amount).toBeUndefined();
  expect(params.metadata).toMatchObject({ chargeModel: 'direct', payChannel: 'card_form', surchargeCents: '750', invoiceAmountCents: '25000', cardFunding: 'credit' });
  expect(opts).toMatchObject({ stripeAccount: 'acct_card' });
  // Recorded immediately: $250.00 paid, the $7.50 fee kept out of it.
  const pay = await testPool.query('select amount_cents, surcharge_cents, stripe_payment_intent_id, charge_model from invoice_payments where invoice_id = $1', [invoiceId]);
  expect(pay.rows).toEqual([{ amount_cents: '25000', surcharge_cents: '750', stripe_payment_intent_id: 'pi_card_1', charge_model: 'direct' }]);
});

it('takes the Paralegix margin on an absorbed debit card', async () => {
  /* funding 'debit', debitCards 'absorb': create called with amount 250_00 and application_fee_amount 2_25 (0.9%) */
});

it('refuses to charge when the total the client saw is not the total now', async () => {
  /* expectedTotalCents 250_00 for a credit card -> 409, error FEE_CHANGED_MESSAGE, create not called */
});

it('refuses a declined card type at confirm even if the client skipped the quote', async () => {
  /* debitCards 'decline', funding 'debit' -> 422 with the refusal message, create not called */
});

it('returns the client secret when the bank asks for verification, and holds the invoice', async () => {
  /* create -> { id: 'pi_card_2', status: 'requires_action', client_secret: 'pi_card_2_secret' }
     res.body -> { status: 'requires_action', clientSecret: 'pi_card_2_secret' }
     invoices.stripe_card_payment_intent_id = 'pi_card_2', account 'acct_card'; no invoice_payments row */
});

it('records on complete once verification succeeds', async () => {
  /* seed pointer pi_card_2; retrieve -> succeeded; POST /card/complete {paymentIntentId:'pi_card_2'} -> 200 { status: 'succeeded' },
     payment row recorded, pointer cleared */
});

it("refuses complete for a PaymentIntent that is not this invoice's", async () => {
  /* retrieve returns metadata.invoiceId of another invoice -> 404, nothing recorded */
});

it('refuses a second card payment while a bank checkout is processing', async () => {
  /* invoice has a checkout session that is complete/unpaid -> confirm 409 PAYMENT_PROCESSING */
});

it('uses hosted checkout for card when the client does not pay the card fee', async () => {
  /* is_card_fee_passed_on false: GET /api/pay/:token -> card.flow === 'checkout', card method feeCents 0 */
});
```

Fill every comment-bodied case with real code in the same shape as the first and fourth cases; each comment states exactly what to set up and assert.

- [ ] **Step 2: Run to confirm they fail.**

- [ ] **Step 3: Implement the service**

```ts
// Card payments taken on our own page through Stripe's Payment Element, for
// invoices whose card fee the client pays. The card is checked before any
// charge: Stripe.js turns it into a ConfirmationToken, its preview gives the
// funding type and issuing country, and cardFeeRules decides the fee. The
// charge is a direct charge on the firm's own Stripe account with no
// application fee when the client pays a card fee, so the firm keeps the
// invoice amount and Paralegix is never charged.
import { decideCardCharge, cardFeeEligibility, creditCardFeeCents, type CardFunding, type CardFeeSettings } from './cardFeeRules';
import { FEE_CHANGED_MESSAGE, refusalMessage } from './cardFeeCopy';
import { applicationFeeCents } from './processingFees';
import { payLinkRequest } from '../billing/shared/payLinkRequest';
import { getFirmBillingSettings } from '../billing/shared/billingSettings';

const stripe = require('./stripe.config');
const stripeService = require('./stripe.service');
const invoicesRepo = require('../billing/invoices/invoices.repository');
const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const { withLock } = require('../../shared/database/advisoryLock');
const { AppError, ConflictError, NotFoundError } = require('../../shared/errors/AppError');
const { firmToday } = require('../../shared/utils/personalDay');

const PAY_CHANNEL = 'card_form';

async function firmCardContext(lawFirmId: string) {
  const [firm, billing] = await Promise.all([lawfirmsRepo.findById(lawFirmId), getFirmBillingSettings(lawFirmId)]);
  if (!firm) throw new NotFoundError('Law firm');
  const cardFees: CardFeeSettings = billing.cardFees;
  const eligibility = cardFeeEligibility(firm, cardFees, await firmToday(lawFirmId));
  return { firm, cardFees, eligibility };
}

/** Whether this invoice's card payments go through the card form, and what the page needs for it. */
export async function cardSetupFor(lawFirmId: string, invoice: any, owedCents: number) {
  const { firm, cardFees, eligibility } = await firmCardContext(lawFirmId);
  const useForm = invoice.isCardFeePassedOn === true && eligibility.eligible;
  if (!useForm) return { flow: 'checkout' as const };
  return {
    flow: 'card_form' as const,
    stripeAccountId: firm.stripeAccountId as string,
    creditFeeCents: creditCardFeeCents(owedCents, { ...cardFees, capPercent: eligibility.capPercent, international: false }),
    debitCards: cardFees.debitCards,
    internationalCards: cardFees.internationalCards,
  };
}

async function readCard(confirmationTokenId: string, stripeAccount: string) {
  if (!/^ctoken_[A-Za-z0-9]+$/.test(confirmationTokenId)) throw new AppError('Enter your card again.', 400, 'CARD_TOKEN_INVALID');
  const ct = await stripe.confirmationTokens.retrieve(confirmationTokenId, { stripeAccount });
  const card = ct?.payment_method_preview?.card;
  if (ct?.payment_method_preview?.type !== 'card' || !card) throw new AppError('Enter a card to pay by card.', 400, 'CARD_TOKEN_INVALID');
  const funding: CardFunding = ['credit', 'debit', 'prepaid'].includes(card.funding) ? card.funding : 'unknown';
  return { brand: card.brand || null, last4: card.last4 || null, funding, country: card.country || null };
}

function decide(invoice: any, owedCents: number, cardFees: CardFeeSettings, capPercent: number, card: any) {
  return decideCardCharge({ invoiceCents: owedCents, passedOn: true, capPercent, settings: cardFees, card });
}

/** Quote: what this card pays on this invoice. Creates nothing in Stripe. */
export async function quoteCardPayment({ lawFirmId, invoice, confirmationTokenId }: any) {
  const owed = payLinkRequest(invoice).requestedCents;
  const { firm, cardFees, eligibility } = await firmCardContext(lawFirmId);
  if (!(invoice.isCardFeePassedOn === true && eligibility.eligible)) throw new ConflictError('Please reload the page.');
  const card = await readCard(confirmationTokenId, firm.stripeAccountId);
  const decision = decide(invoice, owed, cardFees, eligibility.capPercent, card);
  if (decision.outcome === 'refused') {
    return { outcome: 'refused', reason: decision.reason, message: refusalMessage(decision.reason, firm.name), invoiceCents: owed, card };
  }
  const feeCents = decision.outcome === 'credit_fee' ? decision.feeCents : 0;
  return {
    outcome: decision.outcome,
    ...(decision.outcome === 'no_fee' ? { reason: decision.reason } : {}),
    feeCents, invoiceCents: owed, totalCents: owed + feeCents, card,
  };
}
```

`confirmCardPayment` runs under the same advisory lock as Checkout so a card payment and a bank checkout for one invoice can never start together:

```ts
export async function confirmCardPayment(args: {
  lawFirmId: string; invoiceId: string; context: any; confirmationTokenId: string; expectedTotalCents: number;
  clientId: string | null; clientUserId: string | null; payLinkToken: string | null; returnUrl: string;
}) {
  return withLock('STRIPE_INVOICE_CHECKOUT', `${args.lawFirmId}:${args.invoiceId}`, () => confirmLocked(args));
}

async function confirmLocked({ lawFirmId, invoiceId, context, confirmationTokenId, expectedTotalCents, clientId, clientUserId, payLinkToken, returnUrl }: any) {
  const invoice = await invoicesRepo.findById(context, invoiceId);
  if (!invoice || invoice.status === 'voided' || invoice.stripePaymentRequested !== true) throw new NotFoundError('Invoice');
  if (payLinkToken && invoice.payLinkToken !== payLinkToken) throw new NotFoundError('Payment link');
  const requested = payLinkRequest(invoice);
  if (invoice.isPaid || requested.requestedCents <= 0 || (requested.installmentId && !requested.isPayable)) {
    throw new ConflictError('This invoice has already been paid. Please refresh the page.');
  }

  // Nothing else may be collecting: a bank checkout still processing, or an
  // earlier card payment still waiting on the client's bank.
  const { collected } = await stripeService.closeInvoicePaymentSurfaces(lawFirmId, invoice, { strict: true });
  if (collected) throw new AppError('A payment is already processing for this invoice. Please wait for it to complete.', 409, 'PAYMENT_PROCESSING');

  const { firm, cardFees, eligibility } = await firmCardContext(lawFirmId);
  if (!(invoice.isCardFeePassedOn === true && eligibility.eligible)) throw new ConflictError('Please reload the page.');
  const card = await readCard(confirmationTokenId, firm.stripeAccountId);
  const decision = decide(invoice, requested.requestedCents, cardFees, eligibility.capPercent, card);
  if (decision.outcome === 'refused') throw new AppError(refusalMessage(decision.reason, firm.name), 422, 'CARD_NOT_ACCEPTED');
  const feeCents = decision.outcome === 'credit_fee' ? decision.feeCents : 0;
  const total = requested.requestedCents + feeCents;
  if (total !== expectedTotalCents) throw new AppError(FEE_CHANGED_MESSAGE, 409, 'FEE_CHANGED');

  const opts = { stripeAccount: firm.stripeAccountId };
  const params: any = {
    amount: total,
    currency: 'usd',
    confirm: true,
    confirmation_token: confirmationTokenId,
    payment_method_types: ['card'],
    return_url: returnUrl,
    description: `Invoice ${invoice.invoiceName || invoice.invoiceNumber || invoiceId}`,
    metadata: {
      chargeModel: 'direct', payChannel: PAY_CHANNEL, lawFirmId, invoiceId,
      contextType: context.type, entityId: context.entityId,
      ...(clientId ? { clientId } : {}), ...(clientUserId ? { clientUserId } : {}),
      ...(requested.installmentId ? { installmentId: requested.installmentId } : {}),
      paymentMethod: 'card', invoiceAmountCents: String(requested.requestedCents), surchargeCents: String(feeCents),
      cardFunding: card.funding, cardCountry: card.country || '',
    },
  };
  // Paralegix takes nothing on a payment whose fee the client paid. On a card
  // the firm absorbs (debit, prepaid, unknown) it takes its usual margin.
  if (feeCents === 0) params.application_fee_amount = applicationFeeCents('card', total, true);

  let pi: any;
  try {
    pi = await stripe.paymentIntents.create(params, { ...opts, idempotencyKey: `card-form-${invoiceId}-${confirmationTokenId}` });
  } catch (err: any) {
    // Stripe writes card_error messages for the cardholder, so they are shown as is.
    if (err?.type === 'StripeCardError') throw new AppError(err.message, 402, 'CARD_DECLINED');
    throw err;
  }
  return settle(context, invoice, pi, firm.stripeAccountId);
}

/** Act on a PaymentIntent's state: record a success, hold the invoice while it waits on the client. */
async function settle(context: any, invoice: any, pi: any, stripeAccountId: string) {
  if (pi.status === 'succeeded') {
    await recordCardPaymentIntent(pi, stripeAccountId);
    return { status: 'succeeded' };
  }
  if (pi.status === 'requires_action' || pi.status === 'processing') {
    await invoicesRepo.runInvoiceTxn(context, invoice.id, (existing: any) => {
      if (!existing || existing.status === 'voided') return null;
      return { stripeCardPaymentIntentId: pi.id, stripeCardPaymentIntentAccountId: stripeAccountId };
    });
    return pi.status === 'requires_action' ? { status: 'requires_action', clientSecret: pi.client_secret } : { status: 'processing' };
  }
  throw new AppError('Your card was not charged. Please try again or use a different card.', 402, 'CARD_NOT_CHARGED');
}
```

The firm's account id is passed to `settle` because a PaymentIntent object does not carry the connected account it lives on.

`completeCardPayment` and the webhook recorder:

```ts
/** After the client finishes a bank verification step: record the payment if it succeeded. */
export async function completeCardPayment({ lawFirmId, context, invoice, paymentIntentId }: any) {
  const firm = await lawfirmsRepo.findById(lawFirmId);
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId) || !firm?.stripeAccountId) throw new NotFoundError('Payment');
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { stripeAccount: firm.stripeAccountId });
  if (pi?.metadata?.invoiceId !== invoice.id || pi?.metadata?.lawFirmId !== lawFirmId) throw new NotFoundError('Payment');
  if (pi.status === 'succeeded') {
    await recordCardPaymentIntent(pi, firm.stripeAccountId);
    return { status: 'succeeded' };
  }
  return { status: pi.status === 'processing' ? 'processing' : 'failed' };
}

function candidateFromPaymentIntent(pi: any, timeZone: string) {
  const md = pi.metadata || {};
  const total = Math.max(0, Math.round(pi.amount_received || 0));
  const surchargeCents = Math.min(Math.max(0, parseInt(md.surchargeCents, 10) || 0), total);
  return {
    chargeModel: 'direct',
    lawFirmId: md.lawFirmId, invoiceId: md.invoiceId, contextType: md.contextType, entityId: md.entityId,
    clientRecordId: md.clientId || null, clientUserId: md.clientUserId || null,
    installmentId: md.installmentId || null,
    surchargeCents,
    paymentMethod: 'card',
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

/** Record a succeeded card-form PaymentIntent. Idempotent on the PaymentIntent id. */
export async function recordCardPaymentIntent(pi: any, stripeAccountId: string) {
  const md = pi?.metadata || {};
  if (md.payChannel !== PAY_CHANNEL || md.chargeModel !== 'direct' || pi.status !== 'succeeded') return { applied: false };
  const firm = await lawfirmsRepo.findById(md.lawFirmId);
  if (!firm || firm.stripeAccountId !== stripeAccountId) return { applied: false };
  const candidate = candidateFromPaymentIntent(pi, await stripeService.firmZone(md.lawFirmId));
  const result = await stripeService.applyStripeCandidateTransaction(candidate);
  if (result.applied) {
    try { stripeService.emitStripePaymentReceived(candidate, result.invoice); } catch (err: any) {
      console.error('cardPayment: could not announce a committed card payment:', err?.message || err);
    }
  }
  return result;
}

/** A card-form PaymentIntent failed or was cancelled: release the invoice. */
export async function releaseCardPaymentIntent(pi: any) {
  const md = pi?.metadata || {};
  if (md.payChannel !== PAY_CHANNEL) return;
  const context = { type: md.contextType, lawFirmId: md.lawFirmId, entityId: md.entityId };
  await invoicesRepo.runInvoiceTxn(context, md.invoiceId, (existing: any) =>
    existing && existing.stripeCardPaymentIntentId === pi.id
      ? { stripeCardPaymentIntentId: null, stripeCardPaymentIntentAccountId: null }
      : null);
}
```

Give `buildStripePaymentEntry` the method so the receipt can label the fee (Task 13): add `...(candidate.paymentMethod ? { paymentMethod: candidate.paymentMethod } : {})` and, in `buildStripeCandidateFromCheckoutSession`, set `paymentMethod: metadata.paymentMethod === 'bank' ? 'bank' : 'card'`. It rides only in the event payload; nothing new is stored.

- [ ] **Step 4: Run the tests**: `cd backend && TEST_DB_SLOT=5 npx jest tests/stripe/cardPayment.test.ts --runInBand`. Expected: PASS.
- [ ] **Step 5: Break it on purpose.** Remove `if (feeCents === 0)` so the application fee is always set; confirm "charges the quoted total with no application fee" fails; restore.
- [ ] **Step 6: Typecheck and lint.**

### Task 9: Routes for the pay link and the portal

**Files:**
- Modify: `backend/src/modules/stripe/payLink.service.ts`, `payLink.routes.ts`
- Modify: `backend/src/modules/clients/portal/portal.service.ts` (~2564), `portal.routes.ts` (~509-530)
- Test: extend `backend/tests/stripe/cardPayment.test.ts` (pay link, already used above) and add portal cases to `backend/tests/clients/portalCrossFirmIsolation.test.ts`

- [ ] **Step 1: Write the failing portal tests**

```ts
it("refuses a card quote for another firm's invoice from the portal", async () => {
  /* client of firm A calls POST /api/client-portal/lawfirm/<firmB>/billing/pay/<invoiceB>/card/quote -> 403 or 404,
     confirmationTokens.retrieve not called */
});
it("refuses card complete for an invoice the client can't see", async () => { /* -> 403/404, nothing recorded */ });
```

Use the client-actor helpers that file already uses.

- [ ] **Step 2: Pay link service.** In `getPayPage`, add the card setup and make the card method's preview honest:

```ts
  const card = isPaid ? { flow: 'checkout' as const } : await cardSetupFor(lawFirmId, invoice, owed);
  return {
    ...,
    card,
    methods: isPaid ? [] : PAYMENT_METHOD_KINDS.map((method) => {
      if (method === 'card') {
        // A card fee depends on the card, so the option shows no fee and the
        // card form shows the exact amount once the card is entered.
        return { method, feeCents: 0, totalCents: owed };
      }
      const feeCents = invoice.isBankFeePassedOn ? clientSurchargeCents('bank', owed) : 0;
      return { method, feeCents, totalCents: owed + feeCents };
    }),
  };
```

Add three functions that resolve the token with `loadPayableInvoice` and call the card service:

```ts
export async function quotePayLinkCard(token: string, confirmationTokenId: string) {
  const { lawFirmId, invoice } = await loadPayableInvoice(token);
  return quoteCardPayment({ lawFirmId, invoice, confirmationTokenId });
}

export async function confirmPayLinkCard(token: string, confirmationTokenId: string, expectedTotalCents: number) {
  const { lawFirmId, invoiceId, context, invoice } = await loadPayableInvoice(token);
  return confirmCardPayment({
    lawFirmId, invoiceId, context, confirmationTokenId, expectedTotalCents,
    clientId: invoiceClientRecordId(invoice), clientUserId: null, payLinkToken: token,
    returnUrl: `${payLinkUrl(token)}?payment=card_return`,
  });
}

export async function completePayLinkCard(token: string, paymentIntentId: string) {
  const { lawFirmId, context, invoice } = await loadPayableInvoice(token);
  return completeCardPayment({ lawFirmId, context, invoice, paymentIntentId });
}
```

`completePayLinkCard` must still work after the payment ends the request, because recording clears the token. Load by token first; if that 404s, look the PaymentIntent up by id through `completeCardPayment` only when it already recorded (return `{ status: 'succeeded' }` when an `invoice_payments` row has that `stripe_payment_intent_id`). Add a test: complete after the payment was recorded by the webhook returns `{ status: 'succeeded' }`.

- [ ] **Step 3: Pay link routes**

```ts
const cardQuoteSchema = z.object({ body: z.object({ confirmationTokenId: z.string().min(1).max(255) }).strict() });
const cardConfirmSchema = z.object({ body: z.object({
  confirmationTokenId: z.string().min(1).max(255),
  expectedTotalCents: z.number().int().positive().max(MAX_MONEY_AMOUNT * 100),
}).strict() });
const cardCompleteSchema = z.object({ body: z.object({ paymentIntentId: z.string().min(1).max(255) }).strict() });

router.post('/:token/card/quote', publicPayLimiter, validate(cardQuoteSchema),
  handler(async (req) => service.quotePayLinkCard(req.params.token, req.body.confirmationTokenId)));
router.post('/:token/card/confirm', publicPayLimiter, validate(cardConfirmSchema),
  handler(async (req) => service.confirmPayLinkCard(req.params.token, req.body.confirmationTokenId, req.body.expectedTotalCents)));
router.post('/:token/card/complete', publicPayLimiter, validate(cardCompleteSchema),
  handler(async (req) => service.completePayLinkCard(req.params.token, req.body.paymentIntentId)));
```

Import `MAX_MONEY_AMOUNT` from `../billing/shared/money`.

- [ ] **Step 4: Portal.** Add `card: await cardSetupFor(...)` to `getPaymentOptions` with the same card-method change, and three routes under `/lawfirm/:lawFirmId/billing/pay/:invoiceId/card/{quote,confirm,complete}` that call `resolvePortalPayableInvoice` first (it enforces the client's access) and then the card service with `clientUserId: req.user.uid` and `returnUrl: ${FRONTEND_URL}/client/lawfirm/${lawFirmId}/billing/${invoiceId}?payment=card_return`. Use the same three schemas.
- [ ] **Step 5: Run** `cardPayment`, `payLink`, `portalCrossFirmIsolation`, `portalClientSeparation`. Expected: PASS.
- [ ] **Step 6: Typecheck and lint.**

### Task 10: Webhooks and closing payment surfaces

**Files:**
- Modify: `backend/src/modules/stripe/stripe.webhook.routes.ts` (the `payment_intent.*` case, ~169)
- Modify: `backend/src/modules/stripe/stripe.service.ts` (`closeInvoicePaymentSurfaces`, ~3617)
- Modify: `backend/src/modules/billing/invoices/invoices.service.ts` (`expireStaleCheckoutSession`)
- Test: `backend/tests/stripe/cardPaymentWebhooks.test.ts`

- [ ] **Step 1: Write the failing tests** (deliver with `stripeWebhookSender(CONNECT_SECRET, { account: 'acct_card' })` from `tests/support/stripeWebhook.ts`)

```ts
it('records a card-form payment from a Connect payment_intent.succeeded', async () => { /* one payment row, fee separate */ });
it('records it once when the event arrives twice', async () => { /* deliver twice -> one row */ });
it('ignores a card-form PaymentIntent from an account that is not the firm', async () => { /* account acct_other -> no row */ });
it('releases the invoice on payment_intent.payment_failed', async () => { /* pointer cleared */ });
it('still ignores a Connect event that claims to be a trust deposit', async () => { /* unchanged behaviour */ });
it('cancels a card payment waiting on verification when the invoice is voided', async () => {
  /* pointer set, PI retrieve -> requires_action; void -> paymentIntents.cancel called with { stripeAccount: 'acct_card' } */
});
it('keeps the invoice from being voided while a card payment is processing', async () => {
  /* PI retrieve -> processing; void returns the same 409 a processing bank checkout gets */
});
it('cancels an abandoned card payment when a manual payment changes the balance', async () => { /* expireStaleCheckoutSession path */ });
```

- [ ] **Step 2: Run to confirm they fail.**

- [ ] **Step 3: Webhook.** Replace the Connect early-exit in the `payment_intent.*` case:

```ts
        if (connectedAccountId) {
          const md = event.data.object?.metadata || {};
          if (md.depositType === 'trust') {
            logIgnoredEvent(event, 'a trust deposit is never a connected-account event');
          } else if (md.payChannel === 'card_form') {
            if (event.type === 'payment_intent.succeeded') {
              await cardPayment.recordCardPaymentIntent(event.data.object, connectedAccountId);
            } else {
              await cardPayment.releaseCardPaymentIntent(event.data.object);
            }
          }
          break;
        }
```

`recordCardPaymentIntent` already checks the account owns the firm. Add `payment_intent.canceled` to the same case so an expired verification also releases the invoice, and add it to both `/api/webhooks/stripe` rows in `docs/dev/ops/webhooks.md`.

- [ ] **Step 4: `closeInvoicePaymentSurfaces`.** After the checkout-session block, before `return { collected: false }`, add:

```ts
  const cardIntentId = invoice?.stripeCardPaymentIntentId && invoice.stripeCardPaymentIntentId !== skip?.stripeCardPaymentIntentId
    ? invoice.stripeCardPaymentIntentId
    : null;
  if (cardIntentId) {
    const firm = await lawfirmsRepo.findById(lawFirmId);
    const account = invoice.stripeCardPaymentIntentAccountId || firm?.stripeAccountId;
    try {
      const pi = await stripe.paymentIntents.retrieve(cardIntentId, { stripeAccount: account });
      if (pi.status === 'succeeded' || pi.status === 'processing') return { collected: true };
      if (pi.status !== 'canceled') await stripe.paymentIntents.cancel(cardIntentId, { stripeAccount: account });
    } catch (err: any) {
      console.error(`stripe.service: could not cancel card payment ${cardIntentId} for a closed invoice:`, err?.message || err);
      failed("the client's card payment", err);
    }
  }
```

The early `return` at the top (`if (!stripe || !sessionId) return`) must become `if (!stripe) return` with the session block guarded by `if (sessionId)`, so an invoice with only a card intent still reaches this code. Every caller that clears `stripeCheckoutSessionId` after a successful close must clear the card pair too; search for `stripeCheckoutSessionId: null` in `invoices.service.ts` and `stripe.service.ts` and add `stripeCardPaymentIntentId: null, stripeCardPaymentIntentAccountId: null` beside each one that follows a close.

- [ ] **Step 5: `expireStaleCheckoutSession`.** After the session handling, cancel a card intent the same way, but only when it is in `requires_action` or `requires_payment_method`; clear the pointer only after a confirmed cancel or a `resource_missing`, mirroring the session rule.
- [ ] **Step 6: Run** `cardPaymentWebhooks`, `webhookEventScope`, `invoiceVoidStripe`, `manualPaymentInFlightBankPayment`, `stripeLinkVoidRace`, `invoiceDeleteClosesStripeLinks`. Expected: PASS.
- [ ] **Step 7: Typecheck and lint.**

### Task 11: Receipt and firm email labels

**Files:**
- Modify: `backend/src/modules/billing/billing.events.ts:62`, `backend/src/shared/services/emailService.ts:830` (`sendPaymentReceiptEmail`)
- Test: the receipt email test (search `sendPaymentReceiptEmail` under `backend/tests/`)

- [ ] **Step 1: Failing test:** a card-form payment with a $7.50 fee renders `Credit card fee` and `$7.50`; a bank payment with a fee renders `Bank transfer fee`.
- [ ] **Step 2:** Pass `feeLabel: RECEIPT_FEE_LABEL[payload.paymentMethod === 'bank' ? 'bank' : 'card']` from the listener and render it instead of the fixed "Processing fee" text.
- [ ] **Step 3:** Run, typecheck, lint.

---

## Phase E: frontend

Invoke the `paralegix-frontend` skill before each task in this phase. The pay page's existing card (`rounded-xl bg-surface border border-outline shadow-sm p-8`) and `PaymentMethodOptions` are the precedent for the client screens; `ToggleSwitch` is the precedent for boolean settings; `InlineWarning` for the debit and non-US notes. Run `bash .claude/skills/paralegix-frontend/scripts/check-ui.sh` at the end of each task.

### Task 12: Stripe.js and the wording file

**Files:**
- Modify: `frontend/package.json`, `frontend/.env.example`
- Create: `frontend/src/lib/payments/stripeClient.ts`, `frontend/src/lib/payments/cardFeeCopy.ts`
- Test: `frontend/tests/lib/payments/cardFeeCopy.test.ts`

- [ ] **Step 1:** `cd frontend && npm install @stripe/stripe-js@<latest> @stripe/react-stripe-js@<latest>` with exact versions pinned (check npm for the current releases and pin them, no caret). Root `AGENTS.md` notes npm 11 blocks install scripts; neither package has one.
- [ ] **Step 2:** Add `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=` to `.env.example` with a comment: the platform's publishable key; the card form passes the firm's connected account id.
- [ ] **Step 3:** `stripeClient.ts`:

```ts
import { loadStripe, type Stripe } from "@stripe/stripe-js";

const cache = new Map<string, Promise<Stripe | null>>();

/** Stripe.js for one firm's connected account, loaded once per account. */
export function stripeForAccount(stripeAccountId: string): Promise<Stripe | null> {
  const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!key) return Promise.resolve(null);
  let entry = cache.get(stripeAccountId);
  if (!entry) {
    entry = loadStripe(key, { stripeAccount: stripeAccountId });
    cache.set(stripeAccountId, entry);
  }
  return entry;
}
```

- [ ] **Step 4: Failing test** for the copy functions (exact strings from section 1):

```ts
import { cardOptionSubtitle, cardResultCopy } from "@/lib/payments/cardFeeCopy";

it("tells the client debit cards have no fee", () => {
  expect(cardOptionSubtitle({ creditFeeCents: 750, debitCards: "absorb", internationalCards: "absorb" }))
    .toBe("US credit cards add a $7.50 card fee. Debit cards have no fee.");
});
it("says credit only when debit is declined, and US only when non-US is declined", () => {
  expect(cardOptionSubtitle({ creditFeeCents: 750, debitCards: "decline", internationalCards: "decline" }))
    .toBe("Credit cards only. US credit cards add a $7.50 card fee. Cards must be issued in the US.");
});
it("explains a credit card fee with the total and the way out", () => {
  expect(cardResultCopy({ outcome: "credit_fee", feeCents: 750, invoiceCents: 25000, totalCents: 25750 }, { firm: "Pay Link LLP", debitCards: "absorb" }))
    .toEqual({
      heading: "Credit card fee: $7.50",
      body: "Pay Link LLP adds a fee of up to 3% to credit card payments to cover processing costs. Your total is $257.50. You can avoid the fee by paying by bank transfer or with a debit card.",
      payLabel: "Pay $257.50",
      showBankInstead: true,
      footer: "The card fee is listed separately on your receipt.",
    });
});
it("explains why a debit card has no fee", () => {
  expect(cardResultCopy({ outcome: "no_fee", reason: "debit", feeCents: 0, invoiceCents: 25000, totalCents: 25000 }, { firm: "X", debitCards: "absorb" }))
    .toMatchObject({ heading: "No card fee", body: "Debit and prepaid cards can't carry a card fee, so you pay $250.00.", payLabel: "Pay $250.00" });
});
it("turns a declined debit card away with both ways forward", () => {
  expect(cardResultCopy({ outcome: "refused", reason: "debit_not_accepted", invoiceCents: 25000 }, { firm: "Pay Link LLP", debitCards: "decline" }))
    .toMatchObject({ heading: "Debit and prepaid cards aren't accepted", payLabel: null, showBankInstead: true, showDifferentCard: true });
});
```

- [ ] **Step 5:** Implement `cardFeeCopy.ts` with `cardOptionSubtitle`, `cardResultCopy`, `CARD_FORM_INTRO`, `FEE_CHANGED`, and the firm-side strings (settings, request dialog, payment detail, "How it works") as exported constants and small functions, word for word from section 1. Use `formatCents` for every amount.
- [ ] **Step 6:** `cd frontend && npm run test:unit -- tests/lib/payments/cardFeeCopy.test.ts`, then `npm run ci:checks`. Expected: PASS.

### Task 13: Card payment panel

**Files:**
- Create: `frontend/src/components/payments/CardPaymentPanel.tsx`
- Modify: `frontend/src/services/payLink.service.ts`, `frontend/src/services/client-portal.service.ts` (types and three calls each)
- Test: `frontend/tests/components/payments/CardPaymentPanel.test.tsx`

- [ ] **Step 1: Service types and calls**

```ts
export interface CardSetup {
  flow: "card_form" | "checkout";
  stripeAccountId?: string;
  creditFeeCents?: number;
  debitCards?: "absorb" | "decline";
  internationalCards?: "absorb" | "decline";
}
export type CardQuote =
  | { outcome: "credit_fee"; feeCents: number; invoiceCents: number; totalCents: number; card: CardSummary }
  | { outcome: "no_fee"; reason: "debit" | "prepaid" | "unknown_funding"; feeCents: 0; invoiceCents: number; totalCents: number; card: CardSummary }
  | { outcome: "refused"; reason: "debit_not_accepted" | "prepaid_not_accepted" | "non_us_not_accepted"; message: string; invoiceCents: number; card: CardSummary };
export interface CardSummary { brand: string | null; last4: string | null; funding: string; country: string | null }
export type CardConfirmResult = { status: "succeeded" | "processing" | "failed" } | { status: "requires_action"; clientSecret: string };
```

Add `card: CardSetup` to `PayPage` and `PaymentOptions`. Add `quoteCard`, `confirmCard`, `completeCard` to both services, posting to the routes from Task 9 (`publicFetch` for the pay link, the authenticated fetch the portal service already uses).

- [ ] **Step 2: Write the failing test.** Mock `@stripe/react-stripe-js` (`Elements` renders children, `PaymentElement` renders a placeholder, `useStripe`/`useElements` return objects with `createConfirmationToken`, `handleNextAction`, `submit`) and pass the three API calls as props:

```tsx
it("checks the card, shows the credit card fee, and pays the quoted total", async () => {
  const quote = jest.fn().mockResolvedValue({ outcome: "credit_fee", feeCents: 750, invoiceCents: 25000, totalCents: 25750, card: { brand: "visa", last4: "4242", funding: "credit", country: "US" } });
  const confirm = jest.fn().mockResolvedValue({ status: "succeeded" });
  render(<CardPaymentPanel setup={SETUP} firmName="Pay Link LLP" invoiceCents={25000} api={{ quote, confirm, complete: jest.fn() }} onPaid={onPaid} onPayByBank={onBank} />);
  await user.click(screen.getByRole("button", { name: "Check card" }));
  expect(await screen.findByRole("heading", { name: "Credit card fee: $7.50" })).toBeInTheDocument();
  expect(screen.getByText(/Your total is \$257\.50/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Pay $257.50" }));
  expect(confirm).toHaveBeenCalledWith("ctoken_test", 25750);
  expect(onPaid).toHaveBeenCalled();
});
it("never shows a pay button for a declined debit card, and offers bank transfer", async () => { /* refused -> no "Pay" button; "Pay by bank transfer instead" calls onPayByBank */ });
it("runs the bank verification step and then completes", async () => { /* confirm -> requires_action; handleNextAction resolves with paymentIntent.id; complete called with it */ });
it("asks the client to review again when the fee changed", async () => { /* confirm rejects with ApiError code FEE_CHANGED -> shows FEE_CHANGED text and returns to the check step */ });
it("has no accessibility violations in the result state", async () => { /* scanAccessibility(container).violations === [] as in PaymentMethodDialog.test.tsx */ });
```

- [ ] **Step 3: Implement**

```tsx
"use client";

import { useEffect, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import type { Stripe } from "@stripe/stripe-js";
import Button from "@/components/ui/Button";
import InlineWarning from "@/components/ui/InlineWarning";
import ErrorNotification from "@/components/ErrorNotification";
import { stripeForAccount } from "@/lib/payments/stripeClient";
import { CARD_FORM_INTRO, FEE_CHANGED, cardResultCopy } from "@/lib/payments/cardFeeCopy";
import { ApiError, getErrorMessage } from "@/lib/utils/apiErrors";
import type { CardConfirmResult, CardQuote, CardSetup } from "@/services/payLink.service";

export interface CardPaymentApi {
  quote: (confirmationTokenId: string) => Promise<CardQuote>;
  confirm: (confirmationTokenId: string, expectedTotalCents: number) => Promise<CardConfirmResult>;
  complete: (paymentIntentId: string) => Promise<CardConfirmResult>;
}

interface Props {
  setup: CardSetup;
  firmName: string;
  invoiceCents: number;
  api: CardPaymentApi;
  onPaid: () => void;
  onPayByBank: () => void;
}

/**
 * Card payment on our own page, for an invoice whose card fee the client pays.
 * The card is checked before anything is charged, so the client always sees the
 * exact fee (or why there is none, or why the card is not accepted) first.
 */
export default function CardPaymentPanel(props: Props) {
  const [stripe, setStripe] = useState<Stripe | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    if (props.setup.stripeAccountId) stripeForAccount(props.setup.stripeAccountId).then((s) => live && setStripe(s));
    return () => { live = false; };
  }, [props.setup.stripeAccountId]);
  if (stripe === undefined) return null;
  if (stripe === null) return <InlineWarning>Card payments are unavailable right now. Please pay by bank transfer.</InlineWarning>;
  return (
    <Elements
      stripe={stripe}
      options={{ mode: "payment", amount: props.invoiceCents, currency: "usd", paymentMethodCreation: "manual", paymentMethodTypes: ["card"] }}
    >
      <CardForm {...props} />
    </Elements>
  );
}

function CardForm({ setup, firmName, api, onPaid, onPayByBank }: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const [tokenId, setTokenId] = useState<string | null>(null);
  const [quote, setQuote] = useState<CardQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setQuote(null); setTokenId(null); };

  const check = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    try {
      const submitted = await elements.submit();
      if (submitted.error) { setError(submitted.error.message || "Check your card details."); return; }
      const { error: tokenError, confirmationToken } = await stripe.createConfirmationToken({ elements });
      if (tokenError || !confirmationToken) { setError(tokenError?.message || "Check your card details."); return; }
      setTokenId(confirmationToken.id);
      setQuote(await api.quote(confirmationToken.id));
    } catch (err) {
      setError(getErrorMessage(err, "We couldn't check this card."));
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    if (!stripe || !tokenId || !quote || quote.outcome === "refused") return;
    setBusy(true);
    setError(null);
    try {
      let result = await api.confirm(tokenId, quote.totalCents);
      if (result.status === "requires_action") {
        const next = await stripe.handleNextAction({ clientSecret: result.clientSecret });
        if (next.error || !next.paymentIntent) { setError(next.error?.message || "Your bank didn't confirm the payment."); reset(); return; }
        result = await api.complete(next.paymentIntent.id);
      }
      if (result.status === "succeeded" || result.status === "processing") onPaid();
      else { setError("Your card was not charged. Please try again or use a different card."); reset(); }
    } catch (err) {
      if (err instanceof ApiError && err.code === "FEE_CHANGED") { setError(FEE_CHANGED); reset(); }
      else setError(getErrorMessage(err, "The payment didn't go through."));
    } finally {
      setBusy(false);
    }
  };

  const copy = quote ? cardResultCopy(quote, { firm: firmName, debitCards: setup.debitCards || "absorb" }) : null;

  return (
    <div className="space-y-4">
      <PaymentElement options={{ wallets: { applePay: "never", googlePay: "never", link: "never" } }} onChange={() => quote && reset()} />
      <ErrorNotification error={error} onClose={() => setError(null)} compact />
      {!copy && (
        <>
          <p className="text-sm text-on-surface-secondary">{CARD_FORM_INTRO}</p>
          <Button type="primary" onClick={check} loading={busy} className="w-full">Check card</Button>
        </>
      )}
      {copy && (
        <section aria-live="polite" className="rounded-xl border border-outline bg-surface-alt p-4 space-y-2">
          <h2 className="text-sm font-semibold text-on-surface">{copy.heading}</h2>
          <p className="text-sm text-on-surface-secondary">{copy.body}</p>
          {copy.payLabel && <Button type="primary" onClick={pay} loading={busy} className="w-full">{copy.payLabel}</Button>}
          {copy.showBankInstead && <Button type="secondary" onClick={onPayByBank} disabled={busy} className="w-full">Pay by bank transfer instead</Button>}
          {copy.showDifferentCard && <Button type="secondary" onClick={reset} disabled={busy} className="w-full">Use a different card</Button>}
          {copy.footer && <p className="text-xs text-on-surface-muted">{copy.footer}</p>}
        </section>
      )}
    </div>
  );
}
```

Check the real prop names of `ui/Button` (`type` vs `variant`, `className` support) and `ui/InlineWarning` before writing, and match them. Confirm in Stripe's docs for the installed `@stripe/stripe-js` version that `createConfirmationToken` and `handleNextAction` exist with these shapes, and that `wallets.link` is the right option name; adjust if not.

- [ ] **Step 4: Run** the component test. Expected: PASS. Then `npm run ci:checks`.

### Task 14: Use the panel on the pay page and in the portal

**Files:**
- Modify: `frontend/src/app/pay/[token]/page.tsx`, `frontend/src/components/portalComp/PaymentMethodOptions.tsx`, `PaymentMethodDialog.tsx`, `frontend/src/hooks/billingHooks/usePortalPayment.ts`, `frontend/src/app/client/lawfirm/[lawFirmId]/billing/[invoiceId]/page.tsx`, `billing/page.tsx`
- Test: `frontend/tests/app/pay/PayPage.test.tsx`, `frontend/tests/components/portal/PaymentMethodDialog.test.tsx`

- [ ] **Step 1: Failing tests**
  - Pay page with `card.flow === "card_form"`: the card option's subtitle is the wording-guide subtitle; choosing card shows `CardPaymentPanel` instead of redirecting; "Pay by bank transfer instead" starts the bank checkout redirect; `onPaid` shows "Thank you for your payment".
  - Pay page with `card.flow === "checkout"`: redirects to Stripe Checkout (the existing tests stay green).
  - Returning with `?payment=card_return`: shows the thank-you card (the client came back from a bank verification redirect).
  - Portal dialog: same two flows.
- [ ] **Step 2: Implement.** `PaymentMethodOptions` takes an optional `subtitles?: Partial<Record<PaymentMethodKind, string>>` that replaces the fee line for that method; pass `cardOptionSubtitle(card)` when `card.flow === "card_form"`. On the pay page, keep `choose` for bank and for `checkout`-flow card; for `card_form` set local state `cardOpen = true` and render `<CardPaymentPanel setup={page.card} firmName={firm} invoiceCents={page.invoiceCents} api={{ quote: (t) => payLinkService.quoteCard(token, t), confirm: (t, total) => payLinkService.confirmCard(token, t, total), complete: (id) => payLinkService.completeCard(token, id) }} onPaid={() => setPaid(true)} onPayByBank={() => choose("bank")} />` with a "Back" text button that closes it. In the portal, `usePortalPayment` gains `cardOpen` and passes an `api` bound to the client-portal service; the dialog renders the panel in its body when open and becomes `size="lg"`.
- [ ] **Step 3:** Run both test files and `npm run ci:checks`. Expected: PASS.

### Task 15: Firm settings card

**Files:**
- Create: `frontend/src/services/cardFees.service.ts`, `frontend/src/components/billingComp/CardFeeSettings.tsx`
- Modify: `frontend/src/components/billingComp/BillingSettingsView.tsx:741-765`
- Test: `frontend/tests/components/billing/CardFeeSettings.test.tsx`; update `BillingSettingsViewProcessingFees.test.tsx`

- [ ] **Step 1: Service**: `getCardFees(lawFirmId)` and `updateCardFees(lawFirmId, body)` against `GET/PUT /lawfirms/:id/billing/card-fees`, typed to the Task 4 response.
- [ ] **Step 2: Failing tests**
  - An ineligible firm sees each not-available reason from the wording guide and no toggle.
  - An eligible firm without a confirmation: turning the toggle on reveals the date field and engagement checkbox; Save is disabled until both are filled; saving sends `{ clientPays: true, ..., stripeNotifiedOn, engagementLetterConfirmed: true }`.
  - A date less than 30 days ago shows `You can turn this on from {date}, 30 days after you told Stripe.` from the server's 400 response.
  - The "How card fees work" list renders all six lines.
  - The debit and non-US choices render their two options each with the exact labels.
  - Bank fee toggle is separate and still saves through `updateFirmSettings({ billing: { processingFees: { bank } } })`.
  - Accessibility scan has no violations.
- [ ] **Step 3: Implement** with `ToggleSwitch` for both booleans, a radio group for each two-way choice (follow the skill's guidance for a two-option choice; `SegmentedToggle` if the skill allows it for settings), `TextInput` with `type="date"` for the notice date, `Checkbox` for the engagement letter, and two number inputs for the rate. Copy only from `cardFeeCopy.ts`. Replace the single "Clients pay the processing fee" checkbox in `BillingSettingsView` with `<CardFeeSettings lawFirmId={...} canEdit={...} />` and a separate bank `ToggleSwitch`.
- [ ] **Step 4:** Run tests, `npm run ci:checks`, `check-ui.sh`.

### Task 16: Request dialog, payment detail, Payments page copy

**Files:**
- Modify: `frontend/src/services/billing.service.ts` (`PaymentFeeQuote` gains `cardRows` and `cardFeeEligibility`), `PaymentRequestFees.tsx`, `PaymentFeeBreakdown.tsx`, `frontend/src/hooks/billingHooks/usePaymentRequestFees.ts`, `InvoiceDetailPayments.tsx`, `frontend/src/app/lawfirm/[lawFirmId]/settings/payments/page.tsx`
- Test: `PaymentRequestFees.test.tsx`, `RequestPaymentDialog.test.tsx`, and a new case in the invoice payments test (search for `InvoiceDetailPayments` under `frontend/tests/`)

- [ ] **Step 1: Failing tests**
  - The dialog shows two checkboxes with the wording-guide labels; the card one is disabled with the reason when `cardFeeEligibility.eligible` is false.
  - `usePaymentRequestFees().setPassedOn` becomes `setCardPassedOn` and `setBankPassedOn`; the request sends both flags independently.
  - With card rows, the breakdown renders one line per row with the exact wording, including "not accepted" rows.
  - A payment with `surchargeCents > 0` and a card method shows the refund guidance line with the fee amount.
  - The Payments page "How it works" step 3 shows the new sentence.
- [ ] **Step 2: Implement**, all strings from `cardFeeCopy.ts`.
- [ ] **Step 3:** Run the tests and `npm run ci:checks`.

---

## Phase F: docs and rollout

### Task 17: Documentation

**Files:**
- Modify: `docs/features/stripe-payments.md` (new section "Credit card fees": rules, flow diagram in words, the money table from section 0, the webhook events, the in-flight pointer, what Paralegix earns)
- Modify: `docs/dev/ops/webhooks.md` (`payment_intent.canceled` on both payments rows; note that Connect `payment_intent.*` now records card-form payments)
- Modify: the billing user guide pages under `docs/billing/` that describe online payments and fees: firm-facing explanation using the settings wording, plus a short "What your client sees" section using the client wording
- Modify: `docs/STAGING_SETUP.md` (the new `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` on Vercel)

- [ ] **Step 1:** Write the pages. No em-dashes (the hook blocks them under `docs/`).
- [ ] **Step 2:** `cd docs && npm run build`. Expected: exit 0.

### Task 18: Staging check with Stripe test cards

Not code; a checklist to run on staging after `/push-to-staging`, with a test firm in Texas, Stripe connected, whose confirmation date is more than 30 days back.

- [ ] Add `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (test mode) to the staging Vercel project.
- [ ] In the Stripe dashboard, make sure the Connect endpoint is subscribed to `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`.
- [ ] Pay a $250.00 invoice from its pay link with each Stripe test card and record what happens:

| Card | Test number | Expected |
|---|---|---|
| Visa credit, US | 4242 4242 4242 4242 | Fee $7.50, total $257.50, firm nets $250.00 less at most 29c, no application fee on the charge |
| Visa debit, US, firm accepts debit | 4000 0566 5566 5556 | No fee, $250.00, application fee $2.25 |
| Visa debit, firm declines debit | 4000 0566 5566 5556 | "Debit and prepaid cards aren't accepted", no charge created |
| Mastercard prepaid | 5105 1051 0510 5100 | Same as debit |
| Visa credit, Brazil | 4000 0007 6000 0002 | Fee, or refused if the firm declines non-US cards |
| 3D Secure | 4000 0027 6000 3184 | Verification popup, then recorded |
| Declined | 4000 0000 0000 0002 | Stripe's decline message, invoice unchanged |

- [ ] Confirm each test number's funding and country in Stripe's testing docs before relying on the table.
- [ ] Check the receipt email shows "Credit card fee $7.50".
- [ ] Void an invoice while a 3D Secure payment is waiting and confirm the PaymentIntent is cancelled.

---

## Self-review against the request

- **Credit only, never debit or prepaid:** Task 1 rules, Task 8 server re-check at confirm, Task 13 UI.
- **Exact fee shown before paying, with a way out:** Task 8 quote, Task 13 panel, wording guide.
- **Firm receives the full amount, Paralegix charged nothing:** no application fee on surcharged charges (Task 8), direct charges on the firm account.
- **Caps and states:** Task 1 (`creditCardFeeCents`, `STATE_RULES`), Task 4 refusal messages.
- **Notice and disclosure:** Task 4 confirmation with the 30-day wait, Task 15 UI.
- **Receipts and refunds:** Task 11 label, Task 16 refund guidance.
- **Information made clear:** section 1 is the single wording source; Tasks 2, 12, 13, 15, 16 and 17 use it.
