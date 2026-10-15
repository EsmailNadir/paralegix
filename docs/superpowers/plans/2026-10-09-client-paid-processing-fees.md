# Client-Paid Processing Fees Implementation Plan

> **For agentic workers:** Implement this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Plan tasks usually build on each other, so execute inline by default; split a task out to a subagent only when it is genuinely independent; see the `delegating-to-subagents` skill.

**Goal:** Let a firm choose, separately for card payments and for bank (ACH) payments, whether the firm absorbs the online processing fee or the client pays it on top of the invoice, with the client choosing card or bank before checkout.

**Architecture:** One pure module (`processingFees.ts`) owns every fee number: the cost estimate per method, the Stripe application fee per method and charge model, and the gross-up that makes a client-paid fee leave the firm with exactly the invoice amount. The portal Checkout Session becomes method-specific (`payment_method_types` is one method) and carries the fee as its own line plus `surchargeCents` in metadata. Every place that turns a Stripe charge into invoice money subtracts that surcharge, and the payment row stores it in a new `surcharge_cents` column.

**Tech Stack:** Express 5 + TypeScript backend, Stripe Checkout, Postgres (`invoice_payments`), Jest in-process specs with a mocked `stripe.config`, Next.js 16 frontend.

---

## Decisions this plan encodes

These were settled with the user. Do not reopen them while implementing.

1. **Two independent firm settings**, `billing.processingFees.card` and `billing.processingFees.bank`, each `'firm' | 'client'`, both defaulting to `'firm'`.
8. **No backward-compatibility paths.** There are no existing clients. The pay link requires a method, except when an open hosted Stripe invoice is the payable link; a reused session must carry the fee metadata; the fee helpers are imported from `processingFees.ts` directly, with no re-export. Where a code block below shows a no-method fallback or a re-export, the implementation does not have it.
2. **The firm nets the full invoice amount** when the client pays: the charge is grossed up so `gross - estimatedCost(gross) >= invoice`. A $1,000.00 invoice charges $1,039.81 by card and $1,014.13 by bank.
3. **Fee schedule** (env-overridable, defaults shown):
   - Card estimated cost: `3.8% + 30c` (`STRIPE_APPLICATION_FEE_RATE`, `STRIPE_APPLICATION_FEE_FIXED_CENTS`). It is Stripe's ~2.9% + 30c plus the 0.9% Paralegix margin.
   - Bank estimated cost: `min(0.8%, $5.00) + 0.9%` (`STRIPE_ACH_FEE_RATE`, `STRIPE_ACH_FEE_CAP_CENTS`, and the margin `STRIPE_DIRECT_APPLICATION_FEE_RATE`).
   - Application fee on a destination charge (Express firm) = the estimated cost for the method. **This lowers the Express bank-transfer fee from 3.8% + 30c to about 1.7%.** That is intended.
   - Application fee on a direct charge (Standard firm) = 0.9% of the gross charge for either method, unchanged.
4. **The client picks the method before checkout.** The portal's Pay Now opens a chooser showing each method's fee and total. Each choice mints a Checkout Session restricted to that method.
5. **Emailed payment requests go through the portal** when either fee is client-paid and the client can sign in to the portal. No hosted Stripe invoice is created; the email links to the portal invoice page. A client with no portal access keeps today's hosted Stripe invoice, and the firm pays the fee.
6. **Out of scope for this plan (a follow-up plan):** per-installment requests (`requestInstallmentPayment`) stay hosted Stripe invoices with the firm paying the card-rate fee. The settings copy says so.
7. **Debit cards are surcharged too**, because hosted Checkout cannot tell debit from credit before the amount is fixed. The settings copy tells the firm it is responsible for surcharge rules in its state.

## How a surcharge must flow through the money code

| Place | File:line (today) | Change |
|---|---|---|
| Fee constants and helpers | `backend/src/modules/stripe/stripe.service.ts:64-136` | Move into `processingFees.ts`; `stripe.service.ts` re-exports the two old names |
| Portal checkout | `stripe.service.ts:1634` `getClientCheckoutUrl` | Takes `method`; adds fee line, `payment_method_types`, metadata, method-aware reuse |
| Firm request | `stripe.service.ts:1433` `requestPayment` | Portal-only branch when fees are client-paid |
| Void request | `stripe.service.ts:3626` `voidPaymentRequest` | Accepts a portal-only request (no `stripeInvoiceId`) |
| Checkout webhook candidate | `stripe.service.ts:595` `buildStripeCandidateFromCheckoutSession` | `amountPaid` excludes the surcharge; candidate carries `surchargeCents` |
| Payment row | `stripe.service.ts:407` `buildStripePaymentEntry`; `invoices.repository.ts:140-187` | Stores `surchargeCents` / `surcharge_cents` |
| Payment event | `stripe.service.ts:3036` `emitStripePaymentReceived` | Adds `surchargeCents` to the payload |
| Receipt email | `billing/billing.events.ts:62`; `emailService.ts:744` | Shows the processing fee as its own line |
| Refund / dispute | `stripe.service.ts:2179` `handleInvoicePaymentReversal` | Unchanged invoice math (entry amount already excludes the surcharge); transfer recovery adds the surcharge share |

The hosted-invoice candidate (`buildStripeCandidateFromInvoice`, `:655`) needs no change: hosted invoices never carry a surcharge in this plan.

---

### Task 1: The fee module

**Files:**
- Create: `backend/src/modules/stripe/processingFees.ts`
- Modify: `backend/src/modules/stripe/stripe.service.ts:64-136` (remove the moved constants and functions, re-export)
- Test: `backend/tests/stripe/processingFees.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// backend/tests/stripe/processingFees.test.ts
/**
 * Every processing-fee number, pinned to the cent. Nothing here is visible on
 * screen: a wrong gross-up silently shorts the firm or overcharges its client.
 * The pricing env vars are deleted first so the defaults are what runs.
 */
const FEE_ENV = [
  'STRIPE_APPLICATION_FEE_RATE', 'STRIPE_APPLICATION_FEE_FIXED_CENTS',
  'STRIPE_ACH_FEE_RATE', 'STRIPE_ACH_FEE_CAP_CENTS',
  'STRIPE_DIRECT_APPLICATION_FEE_RATE', 'STRIPE_DIRECT_APPLICATION_FEE_FIXED_CENTS',
];
let fees: typeof import('../../src/modules/stripe/processingFees');

beforeAll(() => {
  for (const key of FEE_ENV) delete process.env[key];
  jest.isolateModules(() => {
    fees = require('../../src/modules/stripe/processingFees');
  });
});

describe('estimatedCostCents', () => {
  it('charges a card 3.8% plus 30 cents', () => {
    // round(100000 * 0.038) = 3800, plus 30.
    expect(fees.estimatedCostCents('card', 100_000)).toBe(3_830);
  });

  it('charges a bank transfer 0.8% capped at $5, plus 0.9% uncapped', () => {
    // 0.8% of $100 is 80c (under the cap), 0.9% is 90c.
    expect(fees.estimatedCostCents('bank', 10_000)).toBe(170);
    // 0.8% of $1,000 is $8, capped to $5; 0.9% is $9.
    expect(fees.estimatedCostCents('bank', 100_000)).toBe(1_400);
  });

  it('never exceeds the charge itself', () => {
    expect(fees.estimatedCostCents('card', 10)).toBe(10);
  });
});

describe('applicationFeeCents', () => {
  it('takes the full card cost on a destination charge, as before', () => {
    expect(fees.applicationFeeCents('card', 38_000, false)).toBe(1_474);
    expect(fees.computeApplicationFeeCents(38_000)).toBe(1_474);
  });

  it('takes the lower bank cost on a destination charge', () => {
    // min(round(38000 * 0.008) = 304, 500) + round(38000 * 0.009) = 342.
    expect(fees.applicationFeeCents('bank', 38_000, false)).toBe(646);
  });

  it('takes only the 0.9% margin on a direct charge, whatever the method', () => {
    expect(fees.applicationFeeCents('card', 100_000, true)).toBe(900);
    expect(fees.applicationFeeCents('bank', 100_000, true)).toBe(900);
    expect(fees.computeDirectApplicationFeeCents(100_000)).toBe(900);
  });
});

describe('clientSurchargeCents (gross-up)', () => {
  it.each([
    // [method, invoice cents, surcharge cents]
    ['card', 100_000, 3_981],
    ['card', 38_000, 1_532],
    ['card', 250_000, 9_906],
    ['bank', 100_000, 1_413],
    ['bank', 38_000, 657],
    ['bank', 250_000, 2_775],
  ] as const)('%s on %i cents adds %i cents', (method, invoiceCents, expected) => {
    expect(fees.clientSurchargeCents(method, invoiceCents)).toBe(expected);
  });

  it('leaves the firm exactly the invoice amount after the destination fee', () => {
    for (const method of ['card', 'bank'] as const) {
      for (const invoiceCents of [1, 99, 12_345, 100_000, 987_654]) {
        const gross = invoiceCents + fees.clientSurchargeCents(method, invoiceCents);
        expect(gross - fees.applicationFeeCents(method, gross, false)).toBeGreaterThanOrEqual(invoiceCents);
        // One cent less would short the firm, so the surcharge is the smallest that works.
        const oneLess = gross - 1;
        if (oneLess >= invoiceCents) {
          expect(oneLess - fees.applicationFeeCents(method, oneLess, false)).toBeLessThan(invoiceCents);
        }
      }
    }
  });

  it('is zero on a non-positive invoice', () => {
    expect(fees.clientSurchargeCents('card', 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest tests/stripe/processingFees.test.ts`
Expected: FAIL with `Cannot find module '../../src/modules/stripe/processingFees'`

- [ ] **Step 3: Write the module**

```typescript
// backend/src/modules/stripe/processingFees.ts
// Every online-payment fee number in one place. A client invoice payment costs
// the firm (or, when the firm passes it on, the client) an estimated processing
// cost; Paralegix collects its share as the Stripe application fee. Rates are
// env-overridable so pricing can change without a redeploy.
import { percentOfCents } from '../billing/shared/money';

export type PaymentMethodKind = 'card' | 'bank';
export const PAYMENT_METHOD_KINDS: readonly PaymentMethodKind[] = ['card', 'bank'];

// Card: Stripe's ~2.9% + 30c plus the 0.9% Paralegix margin. On a destination
// charge (a firm on an Express account) this is the whole application fee, and
// Paralegix pays Stripe out of it.
const CARD_RATE = Number(process.env.STRIPE_APPLICATION_FEE_RATE ?? 0.038);
const CARD_FIXED_CENTS = Number(process.env.STRIPE_APPLICATION_FEE_FIXED_CENTS ?? 30);

// Bank (ACH): Stripe's 0.8% capped at $5, plus the same 0.9% margin.
const BANK_STRIPE_RATE = Number(process.env.STRIPE_ACH_FEE_RATE ?? 0.008);
const BANK_STRIPE_CAP_CENTS = Number(process.env.STRIPE_ACH_FEE_CAP_CENTS ?? 500);

// The Paralegix margin. On a direct charge (a firm on its own Standard account)
// the firm pays Stripe itself, so this is the whole application fee.
const MARGIN_RATE = Number(process.env.STRIPE_DIRECT_APPLICATION_FEE_RATE ?? 0.009);
const MARGIN_FIXED_CENTS = Number(process.env.STRIPE_DIRECT_APPLICATION_FEE_FIXED_CENTS ?? 0);

function wholeCents(amountCents: unknown): number {
  return Math.round(Number(amountCents) || 0);
}

/** The estimated processing cost of a charge of `grossCents`, never more than the charge. */
export function estimatedCostCents(method: PaymentMethodKind, grossCents: number): number {
  const gross = wholeCents(grossCents);
  if (gross <= 0) return 0;
  const cost = method === 'card'
    ? percentOfCents(gross, CARD_RATE * 100) + CARD_FIXED_CENTS
    : Math.min(percentOfCents(gross, BANK_STRIPE_RATE * 100), BANK_STRIPE_CAP_CENTS)
      + percentOfCents(gross, MARGIN_RATE * 100);
  return Math.min(cost, gross);
}

/** The Paralegix margin alone: the application fee on a direct charge. */
function marginCents(grossCents: number): number {
  const gross = wholeCents(grossCents);
  if (gross <= 0) return 0;
  return Math.min(percentOfCents(gross, MARGIN_RATE * 100) + MARGIN_FIXED_CENTS, gross);
}

/**
 * The `application_fee_amount` for a charge of `grossCents`. A destination
 * charge keeps the whole estimated cost (Paralegix pays Stripe from it); a
 * direct charge keeps only the margin.
 */
export function applicationFeeCents(method: PaymentMethodKind, grossCents: number, direct: boolean): number {
  return direct ? marginCents(grossCents) : estimatedCostCents(method, grossCents);
}

/** The card-rate destination fee, the fee every hosted invoice still uses. */
export function computeApplicationFeeCents(amountCents: unknown): number {
  return estimatedCostCents('card', wholeCents(amountCents));
}

/** The direct-charge fee, the fee every hosted invoice on a Standard account still uses. */
export function computeDirectApplicationFeeCents(amountCents: unknown): number {
  return marginCents(wholeCents(amountCents));
}

/**
 * The fee to add on top of an invoice payment of `invoiceCents` when the client
 * pays it: the smallest surcharge that leaves the firm the full invoice amount
 * after the estimated cost of the larger charge. Grossing up, not adding a flat
 * percentage, because the cost is charged on the surcharge too.
 */
export function clientSurchargeCents(method: PaymentMethodKind, invoiceCents: number): number {
  const invoice = wholeCents(invoiceCents);
  if (invoice <= 0) return 0;
  const netOf = (gross: number) => gross - estimatedCostCents(method, gross);
  // Start from the closed-form estimate, then walk to the smallest gross that
  // still nets the invoice. Rounding makes the closed form off by a cent or two.
  const rate = method === 'card' ? CARD_RATE : BANK_STRIPE_RATE + MARGIN_RATE;
  const fixed = method === 'card' ? CARD_FIXED_CENTS : 0;
  let gross = Math.max(invoice, Math.ceil((invoice + fixed) / Math.max(1 - rate, 0.01)));
  while (netOf(gross) < invoice) gross += 1;
  while (gross - 1 >= invoice && netOf(gross - 1) >= invoice) gross -= 1;
  return gross - invoice;
}
```

- [ ] **Step 4: Point `stripe.service.ts` at the module**

In `backend/src/modules/stripe/stripe.service.ts`, delete the `APPLICATION_FEE_RATE`, `APPLICATION_FEE_FIXED_CENTS` constants (`:71-72`), the `computeApplicationFeeCents` function (`:117-122`), the `DIRECT_APPLICATION_FEE_*` constants and `computeDirectApplicationFeeCents` (`:124-136`), keeping their comments' substance in `processingFees.ts`. Leave the `TRUST_ACH_*` constants and `computeTrustAchFeeCents` where they are: trust deposits are a different charge. Add beside the other imports:

```typescript
import {
  applicationFeeCents,
  clientSurchargeCents,
  computeApplicationFeeCents,
  computeDirectApplicationFeeCents,
  PAYMENT_METHOD_KINDS,
  type PaymentMethodKind,
} from './processingFees';
```

and, beside the existing `export` statements, keep the two names reachable for existing callers and tests:

```typescript
export { computeApplicationFeeCents, computeDirectApplicationFeeCents };
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx jest tests/stripe/processingFees.test.ts tests/stripe/stripeApplicationFee.test.ts tests/stripe/applicationFeeHalfCent.test.ts tests/stripe/stripePaymentGuards.test.ts`
Expected: all PASS. The last three prove the card fee did not move.

- [ ] **Step 6: Typecheck and lint**

Run: `cd backend && npm run typecheck && npm run lint && npm run db:dead-exports`
Expected: exit 0.

---

### Task 2: The firm setting

**Files:**
- Modify: `backend/src/modules/billing/shared/billingSettings.ts:16-39`
- Modify: `backend/src/modules/settings/settings.defaults.ts:75-76`
- Modify: `backend/src/modules/settings/settings.validation.ts:179-198`
- Test: `backend/tests/billing/processingFeeSettings.test.ts`

- [ ] **Step 1: Write the failing test**

Find the route test that already saves `lateFee` through `PUT /api/lawfirms/:id/settings/firm` (`grep -rln "lateFee" backend/tests --include=*.test.ts`) and copy its imports and request shape. The cases:

```typescript
// backend/tests/billing/processingFeeSettings.test.ts
import { createFirm, ownerOf, type Firm } from '../support/setupInProcess';
import { getFirmBillingSettings } from '../../src/modules/billing/shared/billingSettings';

let firm: Firm;
beforeEach(async () => { firm = await createFirm(); });

const path = (id: string) => `/api/lawfirms/${id}/settings/firm`;

it('refuses a caller from another firm and stores nothing', async () => {
  const other = await createFirm();
  const res = await (await ownerOf(other)).api.put(path(firm.id))
    .send({ billing: { processingFees: { card: 'client' } } });
  expect(res.status).toBe(403);
  expect((await getFirmBillingSettings(firm.id)).processingFees).toEqual({ card: 'firm', bank: 'firm' });
});

it('defaults both methods to the firm paying', async () => {
  expect((await getFirmBillingSettings(firm.id)).processingFees).toEqual({ card: 'firm', bank: 'firm' });
});

it('saves one method without resetting the other', async () => {
  const owner = await ownerOf(firm);
  await owner.api.put(path(firm.id)).send({ billing: { processingFees: { bank: 'client' } } }).expect(200);
  // Breaks if the nested group is not merged field by field.
  expect((await getFirmBillingSettings(firm.id)).processingFees).toEqual({ card: 'firm', bank: 'client' });
});

it('rejects a value other than firm or client', async () => {
  const owner = await ownerOf(firm);
  const res = await owner.api.put(path(firm.id)).send({ billing: { processingFees: { card: 'nobody' } } });
  expect(res.status).toBe(400);
});
```

Adjust the actor calls (`ownerOf(...).api`) to match what the copied lateFee test does; `actors.ts` is the reference.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest tests/billing/processingFeeSettings.test.ts`
Expected: FAIL; `processingFees` is `undefined`.

- [ ] **Step 3: Implement**

In `billingSettings.ts`, add to `BILLING_SETTINGS_DEFAULTS` after `tax`:

```typescript
  // processingFees: who pays the online processing fee, per payment method.
  // 'firm' absorbs it (the default, today's behaviour); 'client' adds it on top
  // of the invoice at checkout, grossed up so the firm nets the full amount.
  processingFees: {
    card: 'firm' as 'firm' | 'client',
    bank: 'firm' as 'firm' | 'client',
  },
```

and change `NESTED_GROUPS` to `['timeRounding', 'lateFee', 'tax', 'processingFees'] as const;`.

In `settings.defaults.ts`, add after the `tax` line: `processingFees: { card: 'firm', bank: 'firm' },`.

In `settings.validation.ts`, add after the `tax` object inside the billing schema:

```typescript
          processingFees: z
            .object({
              card: z.enum(['firm', 'client']).optional(),
              bank: z.enum(['firm', 'client']).optional(),
            })
            .strict()
            .optional(),
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx jest tests/billing/processingFeeSettings.test.ts tests/billing/workbenchRoutes.test.ts tests/billing/lateFees.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `cd backend && npm run typecheck && npm run lint`
Expected: exit 0.

---

### Task 3: The `surcharge_cents` column

**Files:**
- Create: `backend/db/migrations/0041_invoice_payment_surcharge.sql`
- Modify: `backend/db/schema/70_billing.sql:229-265` (the `invoice_payments` table)
- Modify: `backend/db/schema.sql` (regenerated, never hand-edited)
- Modify: the Drizzle table definition for `invoice_payments` under `backend/src/shared/database/drizzle/`
- Modify: `backend/src/modules/billing/invoices/invoices.repository.ts:140-187`

- [ ] **Step 1: Invoke the `new-migration` skill** and follow it for numbering, the domain-file edit, regeneration and the parity check. Confirm `0041` is still the next free number (`ls backend/db/migrations | tail -3`).

- [ ] **Step 2: Write the migration**

```sql
-- 0041_invoice_payment_surcharge.sql
-- The processing fee a client paid on top of an online invoice payment, kept
-- apart from amount_cents so it never counts toward the invoice balance.
alter table invoice_payments
  add column if not exists surcharge_cents bigint not null default 0;

alter table invoice_payments
  drop constraint if exists invoice_payments_surcharge_cents_check;
alter table invoice_payments
  add constraint invoice_payments_surcharge_cents_check check (surcharge_cents >= 0);
```

Add the same column and check to the `invoice_payments` table in `backend/db/schema/70_billing.sql`, after `stripe_disputed_cents`, with the same comment.

- [ ] **Step 3: Regenerate and prove parity**

Run: `cd backend && npm run db:catalog-parity && npm run db:drift`
Expected: both pass. Then rebuild the test databases: `npm run test:db`.

- [ ] **Step 4: Map the column in the repository**

In `paymentToColumns`, after `stripe_disputed_cents`:

```typescript
    surcharge_cents: Number.isInteger(p.surchargeCents) && p.surchargeCents > 0 ? p.surchargeCents : 0,
```

In `paymentRowToObj`, after the `stripe_disputed_cents` block:

```typescript
  if (row.surcharge_cents != null && Number(row.surcharge_cents) > 0) {
    out.surchargeCents = Number(row.surcharge_cents);
  }
```

Add `surchargeCents` to the Drizzle `invoicePayments` table definition following the shape of `stripeDisputedCents`.

- [ ] **Step 5: Run the schema and payment tests**

Run: `cd backend && npx jest tests/schema/conventions.test.ts tests/billing/stripePaymentDelete.test.ts`
Expected: PASS.

---

### Task 4: Record a surcharged checkout payment correctly

**Files:**
- Modify: `backend/src/modules/stripe/stripe.service.ts:407-419` (`buildStripePaymentEntry`), `:595-627` (`buildStripeCandidateFromCheckoutSession`), `:3036` (`emitStripePaymentReceived`)
- Test: `backend/tests/stripe/clientPaidFeeWebhooks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/stripe/clientPaidFeeWebhooks.test.ts`. Copy the harness from `backend/tests/stripe/clientInvoicePaidAnalytics.test.ts` lines 1-129: the `stripe.config` mock, the imports, the `WEBHOOK_SECRET`, and the `send` / `deliver` / `eventPayload` / `checkoutSession` / `invoiceMoney` helpers. Drop the `serverAnalytics` mock and `mockCapture`. Give `checkoutSession` one more option, `metadata?: Record<string, string>`, spread last into the session's `metadata`. Then:

```typescript
const INVOICE_CENTS = 250_00;
// clientSurchargeCents('card', 25000) with the default schedule.
const CARD_SURCHARGE = 1_019;

it('credits the invoice with the invoice amount only, and stores the fee apart', async () => {
  await send('checkout.session.completed', checkoutSession({
    amountCents: INVOICE_CENTS + CARD_SURCHARGE,
    metadata: { paymentMethod: 'card', invoiceAmountCents: String(INVOICE_CENTS), surchargeCents: String(CARD_SURCHARGE) },
  }));

  // Breaks if the surcharge is counted as invoice money: paid would be 26019
  // and the invoice would show a refund due.
  expect(await invoiceMoney(invoiceId)).toEqual({ paidCents: INVOICE_CENTS, isPaid: true });
  const { rows } = await testPool.query(
    'select amount_cents, surcharge_cents from invoice_payments where invoice_id = $1', [invoiceId],
  );
  expect(rows).toEqual([{ amount_cents: String(INVOICE_CENTS), surcharge_cents: String(CARD_SURCHARGE) }]);
});

it('treats a session with no surcharge metadata exactly as before', async () => {
  await send('checkout.session.completed', checkoutSession());
  const { rows } = await testPool.query(
    'select amount_cents, surcharge_cents from invoice_payments where invoice_id = $1', [invoiceId],
  );
  expect(rows).toEqual([{ amount_cents: String(INVOICE_CENTS), surcharge_cents: '0' }]);
});

it('never lets a malformed surcharge exceed what was charged', async () => {
  await send('checkout.session.completed', checkoutSession({
    amountCents: INVOICE_CENTS,
    metadata: { surchargeCents: String(INVOICE_CENTS * 2) },
  }));
  // The whole charge became the surcharge, so nothing is credited to the invoice.
  expect((await invoiceMoney(invoiceId)).paidCents).toBe(0);
});
```

Verify `CARD_SURCHARGE` before relying on it: `cd backend && npx tsx -e "console.log(require('./src/modules/stripe/processingFees').clientSurchargeCents('card', 25000))"`. If it prints another number, use that number; the test pins whatever the Task 1 module computes.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest tests/stripe/clientPaidFeeWebhooks.test.ts`
Expected: the first case FAILS with `paidCents: 26019` and no `surcharge_cents` match.

- [ ] **Step 3: Implement**

In `buildStripeCandidateFromCheckoutSession`, above the `return`:

```typescript
  // A client-paid processing fee rides on the same charge. Only the rest is
  // invoice money; the fee is stored apart on the payment row. Clamped so a
  // malformed value can never credit more than was charged.
  const totalCents = Math.max(0, Math.round(session.amount_total || 0));
  const surchargeCents = Math.min(Math.max(0, parseInt(metadata.surchargeCents, 10) || 0), totalCents);
```

and in the returned object replace the `amountPaid` line with:

```typescript
    surchargeCents,
    amountPaid: (totalCents - surchargeCents) / 100,
```

In `buildStripePaymentEntry`, add after the `chargeModel` spread:

```typescript
    ...(candidate.surchargeCents > 0 ? { surchargeCents: candidate.surchargeCents } : {}),
```

In `emitStripePaymentReceived`, add after `amountPaidCents`:

```typescript
    // The client-paid processing fee on top, if any. Not invoice money.
    surchargeCents: candidate.surchargeCents || 0,
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx jest tests/stripe/clientPaidFeeWebhooks.test.ts tests/stripe/clientInvoicePaidAnalytics.test.ts tests/stripe/stripeWebhookState.test.ts tests/stripe/reconcileCandidateScan.test.ts`
Expected: PASS. The reconciler re-uses the same builder, so it is covered by the same change.

- [ ] **Step 5: Typecheck and lint**

Run: `cd backend && npm run typecheck && npm run lint`
Expected: exit 0.

---

### Task 5: Refunds and disputes on a surcharged payment

**Files:**
- Modify: `backend/src/modules/stripe/stripe.service.ts:2179-2290` (`handleInvoicePaymentReversal`)
- Test: `backend/tests/stripe/clientPaidFeeWebhooks.test.ts`, `backend/tests/stripe/stripeAutoRecovery.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a `charge.refunded` sender using the same `send` helper and a charge object shaped as `stripeReversalWebhooks.test.ts` builds it (`{ id, payment_intent, amount_refunded }`). Seed a paid surcharged payment by sending the Task 4 completed session first with a known `payment_intent`.

```typescript
describe('reversing a surcharged payment', () => {
  const PI = 'pi_surcharged_fixture';
  beforeEach(async () => {
    await send('checkout.session.completed', checkoutSession({
      amountCents: INVOICE_CENTS + CARD_SURCHARGE,
      paymentIntent: PI,
      metadata: { paymentMethod: 'card', invoiceAmountCents: String(INVOICE_CENTS), surchargeCents: String(CARD_SURCHARGE) },
    }));
  });

  it('a full refund reverses exactly the invoice amount', async () => {
    await send('charge.refunded', { id: 'ch_1', payment_intent: PI, amount_refunded: INVOICE_CENTS + CARD_SURCHARGE });
    expect(await invoiceMoney(invoiceId)).toEqual({ paidCents: 0, isPaid: false });
    const { rows } = await testPool.query(
      'select stripe_refunded_cents from invoice_payments where invoice_id = $1', [invoiceId],
    );
    // The refunded total is the invoice money, never the gross charge.
    expect(rows[0].stripe_refunded_cents).toBe(String(INVOICE_CENTS));
  });

  it('a partial refund reduces invoice money first', async () => {
    await send('charge.refunded', { id: 'ch_1', payment_intent: PI, amount_refunded: 50_00 });
    expect((await invoiceMoney(invoiceId)).paidCents).toBe(INVOICE_CENTS - 50_00);
  });
});
```

If `checkoutSession` in the copied harness has no `paymentIntent` option, add one that sets `payment_intent`.

- [ ] **Step 2: Run them and prove they bite**

Run: `cd backend && npx jest tests/stripe/clientPaidFeeWebhooks.test.ts -t "reversing"`
Expected: both PASS already, because `entry.amount` excludes the surcharge and the target is capped at it. Break the code to prove the tests bite: temporarily change Task 4's `amountPaid` back to `totalCents / 100`, rerun, and confirm the full-refund case fails. Revert.

- [ ] **Step 3: Write the failing transfer-recovery test**

In `backend/tests/stripe/stripeAutoRecovery.test.ts`, copy its existing full-refund destination case and change the seed to a surcharged payment (`amount_cents = INVOICE_CENTS`, `surcharge_cents = CARD_SURCHARGE`, gross charge `INVOICE_CENTS + CARD_SURCHARGE`). Assert the transfer reversal amount is `INVOICE_CENTS + CARD_SURCHARGE`. Run it: it FAILS with `INVOICE_CENTS`, because the platform is debited the gross refund but recovers only the invoice part.

- [ ] **Step 4: Recover the surcharge share on a destination charge**

In `handleInvoicePaymentReversal`, declare `let surchargeRecoveredThisEvent = 0;` beside `let reversedThisEvent = 0;`. Inside the transaction callback, after `reversedThisEvent` is set:

```typescript
    // A partial refund reduces invoice money first, so the client-paid fee is
    // only refunded once the cumulative refund passes the invoice amount. Its
    // share is that excess, up to the fee itself.
    const surcharge = entry.surchargeCents || 0;
    const surchargeRefundedBefore = Math.min(surcharge, Math.max(0, alreadyRefunded - originalCents));
    const surchargeRefundedNow = Math.min(surcharge, Math.max(0, disputedCents - originalCents));
    surchargeRecoveredThisEvent = Math.max(0, surchargeRefundedNow - surchargeRefundedBefore);
```

Change the recovery call to:

```typescript
  await recoverConnectedTransfer({
    paymentIntentId,
    recoverCents: reversedThisEvent + surchargeRecoveredThisEvent,
    reason: `invoice ${kind}`,
  });
```

- [ ] **Step 5: Run the reversal suites**

Run: `cd backend && npx jest tests/stripe/clientPaidFeeWebhooks.test.ts tests/stripe/stripeReversalWebhooks.test.ts tests/stripe/stripeAutoRecovery.test.ts`
Expected: PASS.

---

### Task 6: Method-specific portal checkout

**Files:**
- Modify: `backend/src/modules/stripe/stripe.service.ts:1634-1820` (`getClientCheckoutUrl`)
- Modify: `backend/src/modules/clients/portal/portal.service.ts:2520-2570` (`getPaymentCheckoutUrl`)
- Modify: `backend/src/modules/clients/portal/portal.routes.ts:508-515`
- Test: `backend/tests/stripe/stripePaymentRequests.test.ts` (extend the `the client portal pay link` describe at `:615`), `backend/tests/stripe/stripeDirectCharges.test.ts`

- [ ] **Step 1: Write the failing tests**

Inside `describe('the client portal pay link (getClientCheckoutUrl)')`, add a helper and cases. `requestedPortalInvoice()` leaves $380.00 collectable.

```typescript
  async function setFees(fees: { card?: 'firm' | 'client'; bank?: 'firm' | 'client' }) {
    await testPool.query(
      `update law_firms
          set settings = jsonb_set(
            jsonb_set(coalesce(settings, '{}'::jsonb), '{billing}', coalesce(settings->'billing', '{}'::jsonb), true),
            '{billing,processingFees}', $2::jsonb, true)
        where id = $1`,
      [firm.id, JSON.stringify({ card: 'firm', bank: 'firm', ...fees })],
    );
  }

  it('a card payment the client pays for adds the fee line and restricts to card', async () => {
    stubNewSession();
    await setFees({ card: 'client' });
    const invoiceId = await requestedPortalInvoice();

    const res = await payer.api.get(`${payUrl(invoiceId)}?method=card`);

    expect(res.status).toBe(200);
    const params = fakeStripe().checkout.sessions.create.mock.calls[0][0];
    expect(params.payment_method_types).toEqual(['card']);
    expect(params.line_items).toEqual([
      expect.objectContaining({ price_data: expect.objectContaining({ unit_amount: 38_000 }) }),
      { price_data: { currency: 'usd', product_data: { name: 'Card processing fee' }, unit_amount: 1_532 }, quantity: 1 },
    ]);
    // The fee on the 39532 gross, so the firm nets 38000.
    expect(params.payment_intent_data.application_fee_amount).toBe(1_532);
    expect(params.metadata).toEqual(expect.objectContaining({
      paymentMethod: 'card', invoiceAmountCents: '38000', surchargeCents: '1532',
    }));
  });

  it('a bank payment the firm pays for has no fee line and the lower bank fee', async () => {
    stubNewSession();
    await setFees({ card: 'client', bank: 'firm' });
    const invoiceId = await requestedPortalInvoice();

    await payer.api.get(`${payUrl(invoiceId)}?method=bank`).expect(200);

    const params = fakeStripe().checkout.sessions.create.mock.calls[0][0];
    expect(params.payment_method_types).toEqual(['us_bank_account']);
    expect(params.line_items).toHaveLength(1);
    // min(304, 500) + 342. Breaks if bank still takes the 3.8% + 30c card fee (1474).
    expect(params.payment_intent_data.application_fee_amount).toBe(646);
    expect(params.metadata.surchargeCents).toBe('0');
  });

  it('with no method chosen behaves exactly as before', async () => {
    stubNewSession();
    await setFees({ card: 'client', bank: 'client' });
    const invoiceId = await requestedPortalInvoice();

    await payer.api.get(payUrl(invoiceId)).expect(200);

    const params = fakeStripe().checkout.sessions.create.mock.calls[0][0];
    expect(params.payment_method_types).toBeUndefined();
    expect(params.line_items).toHaveLength(1);
    expect(params.payment_intent_data.application_fee_amount).toBe(1_474);
  });

  it('rejects an unknown method', async () => {
    const invoiceId = await requestedPortalInvoice();
    const res = await payer.api.get(`${payUrl(invoiceId)}?method=crypto`);
    expect(res.status).toBe(400);
    expect(stripeCallCount()).toBe(0);
  });

  it('does not reuse an open session minted for the other method', async () => {
    stubNewSession();
    await setFees({ card: 'client' });
    const invoiceId = await requestedPortalInvoice({ sessionId: 'cs_bank_open' });
    const stripe = fakeStripe();
    stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_bank_open', status: 'open', url: 'https://checkout.stripe.test/cs_bank_open',
      amount_total: 38_000, metadata: { paymentMethod: 'bank', invoiceAmountCents: '38000', surchargeCents: '0' },
    });
    stripe.checkout.sessions.expire.mockResolvedValue({});

    const res = await payer.api.get(`${payUrl(invoiceId)}?method=card`);

    expect(res.body.checkoutUrl).toBe('https://checkout.stripe.test/cs_minted');
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_bank_open');
  });
```

Keep the existing `mints a Checkout Session for the remaining balance` case untouched: it is the proof that a call without `method` is unchanged.

In `stripeDirectCharges.test.ts`, beside its existing checkout case, add: a direct-charge firm with `card: 'client'` paying by card gets `application_fee_amount` 356 (`applicationFeeCents('card', 39532, true)`), not 1532.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx jest tests/stripe/stripePaymentRequests.test.ts -t "client portal pay link"`
Expected: the new cases FAIL (`payment_method_types` undefined, one line item).

- [ ] **Step 3: Thread `method` through the route and portal service**

In `portal.routes.ts`:

```typescript
router.get('/lawfirm/:lawFirmId/billing/pay/:invoiceId', handler(async (req) => portalService.getPaymentCheckoutUrl({
  lawFirmId: req.params.lawFirmId,
  invoiceId: req.params.invoiceId,
  clientUserId: req.user.uid,
  userData: req.userData,
  clientRecordId: readClientRecordId(req),
  method: typeof req.query.method === 'string' ? req.query.method : null,
})));
```

In `portal.service.ts` `getPaymentCheckoutUrl`, accept `method` and validate it right after the voided-invoice assertion, before any Stripe work:

```typescript
  if (method != null && !PAYMENT_METHOD_KINDS.includes(method)) {
    throw new ValidationError({ method: ['Choose card or bank transfer'] });
  }
```

Import `PAYMENT_METHOD_KINDS` from `../../stripe/processingFees` and `ValidationError` if not already imported. Pass `method` into `stripeService.getClientCheckoutUrl`.

- [ ] **Step 4: Make the checkout method-aware**

In `getClientCheckoutUrl`, accept `method` (`PaymentMethodKind | null`). Import `getFirmBillingSettings` from `../billing/shared/billingSettings`. After `remainingCents` is computed, add:

```typescript
  // Who pays the processing fee for the chosen method. No method (an older
  // client) keeps today's session: every method, firm pays, card-rate fee.
  const feeSettings = method ? (await getFirmBillingSettings(lawFirmId)).processingFees : null;
  const surchargeCents = method && feeSettings?.[method] === 'client'
    ? clientSurchargeCents(method, remainingCents)
    : 0;
  const grossCents = remainingCents + surchargeCents;
  const appFeeCents = method
    ? applicationFeeCents(method, grossCents, scope.direct)
    : (scope.direct ? computeDirectApplicationFeeCents(remainingCents) : computeApplicationFeeCents(remainingCents));
```

Replace the session-reuse condition `Number(existingSession.amount_total) === remainingCents` with:

```typescript
        const meta = existingSession.metadata || {};
        const sameMethod = (meta.paymentMethod || null) === (method || null);
        const sameInvoiceAmount = meta.invoiceAmountCents
          ? meta.invoiceAmountCents === String(remainingCents)
          : true;
        if (sameMethod && sameInvoiceAmount && Number(existingSession.amount_total) === grossCents) {
```

Build the line items:

```typescript
  const lineItems: any[] = [{
    price_data: {
      currency: 'usd',
      product_data: {
        name: `Invoice #${invoice.invoiceName}`,
        description: `Payment for Invoice #${invoice.invoiceName}`,
      },
      unit_amount: remainingCents,
    },
    quantity: 1,
  }];
  if (surchargeCents > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: method === 'card' ? 'Card processing fee' : 'Bank transfer processing fee' },
        unit_amount: surchargeCents,
      },
      quantity: 1,
    });
  }
```

In `sessionParams`: set `line_items: lineItems`; use `appFeeCents` for both `application_fee_amount` values; add `...(method ? { payment_method_types: [method === 'card' ? 'card' : 'us_bank_account'] } : {}),`; and add to `metadata`:

```typescript
      ...(method ? {
        paymentMethod: method,
        invoiceAmountCents: String(remainingCents),
        surchargeCents: String(surchargeCents),
      } : {}),
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx jest tests/stripe/stripePaymentRequests.test.ts tests/stripe/stripeDirectCharges.test.ts tests/stripe/stripeApplicationFee.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

Run: `cd backend && npm run typecheck && npm run lint`
Expected: exit 0.

---

### Task 7: The payment options endpoint the chooser reads

**Files:**
- Modify: `backend/src/modules/clients/portal/portal.routes.ts` (new route above the `pay/:invoiceId` route)
- Modify: `backend/src/modules/clients/portal/portal.service.ts` (extract the invoice lookup, add `getPaymentOptions`)
- Modify: `backend/tests/contracts/routeCatalog.ts` (register the route the way the neighbouring portal routes are)
- Test: `backend/tests/stripe/stripePaymentRequests.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('the client portal payment options', () => {
  let payer: PortalPerson;
  beforeEach(async () => { payer = await portalPerson(firm.id, 'Olive Options'); });
  const optionsUrl = (invoiceId: string) => portalPath(firm.id, `billing/pay/${invoiceId}/options`);

  it('refuses a portal client of another firm', async () => {
    const invoice = await seedClientInvoice(firm.id, payer.clientId, { totalCents: 380_00, stripePaymentRequested: true });
    const otherFirm = await createFirm();
    const outsider = await portalPerson(otherFirm.id, 'Oscar Outsider');
    expect((await outsider.api.get(optionsUrl(invoice.id))).status).toBe(403);
  });

  it('quotes each method with the firm settings applied', async () => {
    await testPool.query(
      `update law_firms
          set settings = jsonb_set(
            jsonb_set(coalesce(settings, '{}'::jsonb), '{billing}', coalesce(settings->'billing', '{}'::jsonb), true),
            '{billing,processingFees}', $2::jsonb, true)
        where id = $1`,
      [firm.id, JSON.stringify({ card: 'client', bank: 'firm' })],
    );
    const invoice = await seedClientInvoice(firm.id, payer.clientId, { totalCents: 380_00, stripePaymentRequested: true });

    const res = await payer.api.get(optionsUrl(invoice.id));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      invoiceCents: 38_000,
      hostedInvoice: false,
      methods: [
        { method: 'card', feeCents: 1_532, totalCents: 39_532 },
        { method: 'bank', feeCents: 0, totalCents: 38_000 },
      ],
    });
    // A quote touches no Stripe object.
    expect(stripeCallCount()).toBe(0);
  });

  it('says so when an open hosted Stripe invoice is the payable surface', async () => {
    const invoice = await seedClientInvoice(firm.id, payer.clientId, { totalCents: 380_00, stripePaymentRequested: true });
    await testPool.query(`update invoices set stripe_invoice_id = 'in_hosted' where id = $1`, [invoice.id]);
    const res = await payer.api.get(optionsUrl(invoice.id));
    expect(res.body.hostedInvoice).toBe(true);
  });
});
```

Check `seedClientInvoice`'s real signature at the top of the file and adjust the arguments to it.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx jest tests/stripe/stripePaymentRequests.test.ts -t "payment options"`
Expected: FAIL with 404.

- [ ] **Step 3: Implement**

In `portal.service.ts`, move the part of `getPaymentCheckoutUrl` that resolves `foundInvoice`, `foundContextType` and `foundEntityId` (through the voided assertion) into a helper, unchanged, and call it from `getPaymentCheckoutUrl`:

```typescript
async function resolvePortalPayableInvoice({ lawFirmId, invoiceId, clientUserId, userData, clientRecordId }: any) {
  // ...the existing lookup, moved here as-is...
  return { context, invoice: foundInvoice, contextType: foundContextType, entityId: foundEntityId };
}
```

Add:

```typescript
export async function getPaymentOptions(args: any) {
  const { invoice } = await resolvePortalPayableInvoice(args);
  const invoiceCents = Math.max(0, toCents(invoice.totalAmount || 0)
    - toCents(invoice.amountPaid || 0) - toCents(invoice.totalWrittenOff || 0));
  const { processingFees } = await getFirmBillingSettings(args.lawFirmId);
  return {
    invoiceCents,
    // An open hosted invoice is paid on Stripe's page, which offers its own
    // methods; the chooser is skipped.
    hostedInvoice: !!invoice.stripeInvoiceId,
    methods: PAYMENT_METHOD_KINDS.map((method) => {
      const feeCents = processingFees[method] === 'client' ? clientSurchargeCents(method, invoiceCents) : 0;
      return { method, feeCents, totalCents: invoiceCents + feeCents };
    }),
  };
}
```

Import `toCents` from `../../billing/shared/money`, `getFirmBillingSettings` from `../../billing/shared/billingSettings`, and `clientSurchargeCents` from `../../stripe/processingFees`.

Register the route in `portal.routes.ts` **above** `/lawfirm/:lawFirmId/billing/pay/:invoiceId`:

```typescript
// GET /api/client-portal/lawfirm/:lawFirmId/billing/pay/:invoiceId/options
router.get('/lawfirm/:lawFirmId/billing/pay/:invoiceId/options', handler(async (req) => portalService.getPaymentOptions({
  lawFirmId: req.params.lawFirmId,
  invoiceId: req.params.invoiceId,
  clientUserId: req.user.uid,
  userData: req.userData,
  clientRecordId: readClientRecordId(req),
})));
```

Add the route to `backend/tests/contracts/routeCatalog.ts` following the existing `billing/pay/:invoiceId` entry.

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx jest tests/stripe/stripePaymentRequests.test.ts tests/contracts`
Expected: PASS.

---

### Task 8: Firm payment requests go through the portal when the client pays the fee

**Files:**
- Modify: `backend/src/modules/clients/clients.repository.ts` (new `hasPortalAccess`)
- Modify: `backend/src/modules/stripe/stripe.service.ts:1433-1620` (`requestPayment`), `:3626-3670` (`voidPaymentRequest`)
- Test: `backend/tests/stripe/stripePaymentRequests.test.ts`, a `backend/tests/clients/` spec for `hasPortalAccess`

- [ ] **Step 1: Write the failing tests**

Find the existing `requestPayment` describe in `stripePaymentRequests.test.ts` and reuse its seeding and URL helpers. Cases:

1. **Portal client, `card: 'client'`:** the request returns 200, `stripe.invoices.create` is never called, the invoice row has `stripe_payment_requested = true`, `stripe_invoice_id is null`, `stripe_payment_status = 'pending'`, and the response is `{ message: 'Payment request created', hostedInvoiceUrl: null, paymentUrl: '<FRONTEND_URL>/client/lawfirm/<firm>/billing/<invoice>', stripeInvoiceId: null }`. Assert the email went out with that portal URL, the way the existing request test checks its email.
2. **Client with no portal login, `card: 'client'`:** a hosted Stripe invoice is created exactly as today (stub the same Stripe calls the existing request test stubs) and the response carries `paymentUrl` equal to the hosted URL.
3. **Both fees `'firm'`:** unchanged from today, and `paymentUrl` equals `hostedInvoiceUrl`.
4. **Void a portal-only request:** after case 1, call the void route; expect 200, `stripe_payment_requested = false`, `stripe_payment_status = 'voided'`, and no `stripe.invoices.retrieve` call.
5. **Void a portal-only request with an open session:** seed `stripe_checkout_session_id`; the void expires that session.
6. **Void with nothing requested** still answers 400 `No active Stripe payment request found`. The existing case at `:600` covers it and must stay green untouched.

For `hasPortalAccess`, add a spec under `backend/tests/clients/` covering: a person client with a login (true), a person without (false), a company with a linked person who has a login (true), a company without (false), and the right client id under another firm's id (false).

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx jest tests/stripe/stripePaymentRequests.test.ts -t "request"`
Expected: cases 1, 4 and 5 FAIL.

- [ ] **Step 3: Add the portal-access check**

In `clients.repository.ts`, beside `countBillingRecords`:

```typescript
  /**
   * Whether anyone can sign in to the portal to pay for this client: a person
   * client with a login, or a company with at least one linked person who has one.
   */
  async hasPortalAccess(lawFirmId: string, clientId: string) {
    const { rows } = await tenantParameterizedQuery(clients, lawFirmId,
      `select exists (
         select 1 from clients c
          where c.law_firm_id = $1 and c.id = $2 and c.user_id is not null
       ) or exists (
         select 1 from client_company_links l
           join clients p on p.id = l.person_client_id and p.law_firm_id = l.law_firm_id
          where l.law_firm_id = $1 and l.company_client_id = $2 and p.user_id is not null
       ) as ok`,
      [lawFirmId, clientId],
      'c',
    );
    return rows[0]?.ok === true;
  }
```

- [ ] **Step 4: Branch `requestPayment`**

After step 7b (the stale checkout session is expired) and before step 8 (the hosted invoice is created), add the branch below. `billing`, `customerName` and `formatDueDateForEmail` must be in scope there; if `customerName` is only defined later, move the branch below its definition but still above `stripe.invoices.create`.

```typescript
  // When the client pays a processing fee, the fee depends on the method they
  // choose, which a hosted Stripe invoice cannot ask. Send them to the portal's
  // pay page instead, where they choose. A client nobody can sign in for keeps
  // the hosted invoice, and the firm pays the fee.
  const { processingFees } = await getFirmBillingSettings(lawFirmId);
  const clientPaysAFee = processingFees.card === 'client' || processingFees.bank === 'client';
  const recordId = invoiceClientRecordId(invoice);
  if (clientPaysAFee && recordId && await clientsRepo.hasPortalAccess(lawFirmId, recordId)) {
    const paymentUrl = `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/billing/${invoiceId}`;
    await invoicesRepo.update(context, invoiceId, {
      stripePaymentRequested: true,
      stripeInvoiceId: null,
      stripeInvoiceAccountId: null,
      stripePaymentStatus: 'pending',
      stripePaymentRequestedBy: actingUserId,
      stripeCheckoutSessionId: null,
      stripeCheckoutSessionAccountId: null,
      updatedAt: new Date(),
    });
    eventBus.emit(INVOICE_PAYMENT_REQUESTED, { lawFirmId, invoiceId, contextType, entityId, actingUserId });
    if (billing.recipients.emails.length > 0) {
      sendPaymentRequestEmail({
        to: billing.recipients.emails,
        recipientName: customerName,
        lawFirmName: firmData.name || null,
        invoiceNumber: invoice.invoiceName,
        amountDue: remaining,
        checkoutUrl: paymentUrl,
        portalUrl: `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/billing`,
        dueDate: formatDueDateForEmail(invoice.dueDate),
      }).catch((err: any) => {
        console.error('stripe.service: error sending payment request email:', err.message);
      });
    }
    return { message: 'Payment request created', hostedInvoiceUrl: null, paymentUrl, stripeInvoiceId: null };
  }
```

Add `paymentUrl: finalized.hosted_invoice_url` to the existing final `return` of `requestPayment`.

- [ ] **Step 5: Let `voidPaymentRequest` void a portal-only request**

Confirm the helper's signature first: `grep -n "function withdrawCheckoutSession" backend/src/modules/stripe/stripe.service.ts`. Then replace the `if (!invoice.stripeInvoiceId)` guard and wrap the retrieve block:

```typescript
  if (!invoice.stripeInvoiceId && !invoice.stripePaymentRequested) {
    throw new ValidationError({ stripe: ['No active Stripe payment request found'] });
  }
  if (invoice.stripePaymentStatus === 'completed') {
    throw new ValidationError({ stripe: ['Cannot void a completed payment'] });
  }

  if (invoice.stripeInvoiceId) {
    // ...the existing scope, retrieve, voidInvoice and paid-check block, unchanged...
  } else if (invoice.stripeCheckoutSessionId) {
    // A portal-only request has no hosted invoice; close the open session so
    // the client cannot finish paying a request the firm withdrew.
    const sessionScope = scopeForRecordedAccount(
      invoice.stripeCheckoutSessionAccountId, await invoiceChargeScopeFor(lawFirmId),
    );
    await withdrawCheckoutSession(invoice.stripeCheckoutSessionId, sessionScope);
  }
```

- [ ] **Step 6: Run the tests**

Run: `cd backend && npx jest tests/stripe/stripePaymentRequests.test.ts tests/stripe/stripeDirectCharges.test.ts tests/clients`
Expected: PASS.

- [ ] **Step 7: Typecheck and lint**

Run: `cd backend && npm run typecheck && npm run lint`
Expected: exit 0.

---

### Task 9: The receipt shows the fee

**Files:**
- Modify: `backend/src/modules/billing/billing.events.ts:62-110`
- Modify: `backend/src/shared/services/emailService.ts:744` (`sendPaymentReceiptEmail`)
- Test: the existing receipt email test (`grep -rln "sendPaymentReceiptEmail\|Payment received" backend/tests`)

- [ ] **Step 1: Write the failing test**

In the receipt test file, add a case that emits `INVOICE_PAYMENT_RECEIVED` with `amountPaidCents: 25000, surchargeCents: 1019`, drains events, and asserts the sent email contains `$250.00` as the payment and `Processing fee: $10.19`, and that the remaining balance is computed from 25000, not 26019. Add a second case with `surchargeCents: 0` asserting the email contains no `Processing fee` text.

- [ ] **Step 2: Run to verify failure**

Expected: FAIL; no `Processing fee` text.

- [ ] **Step 3: Implement**

Destructure `surchargeCents` in the `INVOICE_PAYMENT_RECEIVED` listener and pass `processingFeeCents: surchargeCents || 0` to `sendPaymentReceiptEmail`. In `sendPaymentReceiptEmail`, accept `processingFeeCents = 0` and, when it is above 0, render one more row after the payment amount using the same row markup and money formatter the function already uses for `amountPaidCents`: label `Processing fee`, value the formatted fee. The plain-text body gets `Processing fee: $X.XX` on its own line.

- [ ] **Step 4: Run the test, typecheck and lint**

Run: `cd backend && npx jest <receipt test file> && npm run typecheck && npm run lint`
Expected: PASS and exit 0.

---

### Task 10: Settings screen and fee notes (frontend)

**Files:**
- Modify: `frontend/src/types/preferences.ts:230-241`
- Modify: `frontend/src/components/billingComp/BillingSettingsView.tsx` (new card after Late Fees + Tax)
- Modify: `frontend/src/components/ui/StripeFeeNote.tsx` and its three full-balance call sites
- Test: `frontend/tests/components/billing/BillingSettingsViewProcessingFees.test.tsx`

- [ ] **Step 1: Invoke the `paralegix-frontend` skill** before writing any JSX, and use the Late Fees card in `BillingSettingsView.tsx` (`:350-430`) as the exemplar: the same card wrapper, a header row with a lucide icon, a description paragraph, and `Checkbox` controls with `label` and `description`.

- [ ] **Step 2: Write the failing test**

Copy the harness from `frontend/tests/components/billing/BillingSettingsViewLateFees.test.tsx`. Cases:
1. With no stored `processingFees`, both checkboxes "Clients pay the card processing fee" and "Clients pay the bank transfer fee" render unchecked.
2. Checking the card box calls `updateFirmSettings` with `{ billing: expect.objectContaining({ processingFees: { card: 'client', bank: 'firm' } }) }`.
3. A user without `canManageFirmSettings` sees both disabled.

- [ ] **Step 3: Run to verify failure**

Run the late-fee test's runner on the new file (check `frontend/package.json` `test:unit` for the command).
Expected: FAIL; labels not found.

- [ ] **Step 4: Implement**

In `preferences.ts`, add to the billing type after `tax`:

```typescript
    processingFees?: {
      card: "firm" | "client";
      bank: "firm" | "client";
    };
```

In `BillingSettingsView.tsx`, beside `saveTax`:

```typescript
  const processingFees = settings.billing.processingFees ?? { card: "firm", bank: "firm" };

  const saveProcessingFees = async (patch: Partial<typeof processingFees>) => {
    if (!canManageFirmSettings) return;
    await withSaving("processingFees", () =>
      updateFirmSettings({
        billing: { ...settings.billing, processingFees: { ...processingFees, ...patch } },
      }),
    );
  };
```

and the card, after the Late Fees + Tax card:

```tsx
      {/* ── Online Payment Fees ─────────────────────────────────────────────── */}
      <div className="bg-surface border border-outline rounded-lg overflow-hidden">
        <div className="p-6">
          <div className="flex items-center gap-2 mb-1">
            <CreditCard className="w-4 h-4 text-on-surface-muted" />
            <h3 className="text-sm font-semibold text-on-surface">Online Payment Fees</h3>
          </div>
          <p className="text-sm text-on-surface-secondary mb-4">
            Each online payment carries a processing fee: 3.8% + $0.30 by card, or 0.8% (up to $5) + 0.9% by bank transfer. By default your firm pays it. You can add it to what the client pays instead, so you receive the full invoice amount. Clients choose card or bank transfer before they pay and see the fee first.
          </p>
          <div className="space-y-3">
            <Checkbox
              checked={processingFees.card === "client"}
              onChange={(checked) => saveProcessingFees({ card: checked ? "client" : "firm" })}
              disabled={!canManageFirmSettings}
              label="Clients pay the card processing fee"
              description="Applies to debit cards too. Card surcharges are limited or banned in some states; check the rules that apply to your firm before turning this on."
            />
            <Checkbox
              checked={processingFees.bank === "client"}
              onChange={(checked) => saveProcessingFees({ bank: checked ? "client" : "firm" })}
              disabled={!canManageFirmSettings}
              label="Clients pay the bank transfer fee"
            />
          </div>
          <p className="mt-3 text-xs text-on-surface-muted">
            Installment payment links still charge your firm the card fee.
          </p>
          {!canManageFirmSettings && (
            <p className="mt-3 text-xs text-on-surface-muted">
              Only firm admins can change this setting.
            </p>
          )}
        </div>
      </div>
```

Import `CreditCard` from `lucide-react` if the file does not already.

In `StripeFeeNote.tsx`, add optional `clientPaysCard?: boolean` and `clientPaysBank?: boolean` props. When either is true, replace the platform-fee sentence with one naming who pays what, for example `The client pays the card fee (3.8% + $0.30). Your firm pays the bank transfer fee.` Build the sentence from the two flags so all four combinations read correctly, and keep the "You will receive" tooltip line, which becomes the full amount for a client-paid method. Pass both flags from the three full-balance call sites (`client-invoice/[invoiceId]/page.tsx:1536`, `InvoiceDetailDialogs.tsx:811`, `ClientBillingTab.tsx:1849`) using `settings.billing.processingFees` from `useFirmSettings()`. Leave the installment call (`InvoiceDetailDialogs.tsx:873`) unchanged; installments are firm-paid. Add a test case for `StripeFeeNote` covering the four flag combinations.

- [ ] **Step 5: Run the tests and the gate**

Run: `cd frontend && npm run test:unit && npm run ci:checks`
Expected: PASS and exit 0.

---

### Task 11: The portal method chooser (frontend)

**Files:**
- Modify: `frontend/src/services/client-portal.service.ts:1195-1200`
- Create: `frontend/src/components/portalComp/PaymentMethodDialog.tsx`
- Modify: `frontend/src/app/client/lawfirm/[lawFirmId]/billing/page.tsx:531-551`
- Modify: `frontend/src/app/client/lawfirm/[lawFirmId]/billing/[invoiceId]/page.tsx:165,559`
- Modify: `frontend/src/hooks/billingHooks/useInvoiceDetailController.tsx:1443-1451` and `frontend/src/services/billing.service.ts:2233-2248, 2276-2291`
- Test: `frontend/tests/components/portal/clientPortalService.test.ts`, `frontend/tests/components/portal/PaymentMethodDialog.test.tsx`

- [ ] **Step 1: Write the failing service tests**

In `clientPortalService.test.ts`, following its existing `getPaymentCheckoutUrl` case: `getPaymentCheckoutUrl(firm, inv, undefined, 'bank')` requests `.../billing/pay/inv?method=bank`; with a `clientRecordId` too, both parameters are present; and `getPaymentOptions(firm, inv)` requests `.../billing/pay/inv/options` and returns the parsed body.

- [ ] **Step 2: Implement the service**

Add `method?: "card" | "bank"` as the fourth parameter of `getPaymentCheckoutUrl`, appending `method=<value>` to the query string. Check how `withClientRecordId` appends its parameter: if it assumes the URL has no `?` yet, make it use `&` when one exists. Add `getPaymentOptions(lawFirmId, invoiceId, clientRecordId?)` with the same fetch and error shape, against `.../billing/pay/<invoice>/options`, and export:

```typescript
export interface PaymentOptions {
  invoiceCents: number;
  hostedInvoice: boolean;
  methods: { method: "card" | "bank"; feeCents: number; totalCents: number }[];
}
```

- [ ] **Step 3: Build the dialog test-first**

Write `PaymentMethodDialog.test.tsx`: with `card` fee 1532 (total 39532) and `bank` fee 0 (total 38000), it shows "You pay $395.32" and "No fee", and clicking Bank transfer calls `onChoose('bank')`. Then build the dialog with the `paralegix-frontend` skill's modal exemplar and `src/components/ui/` primitives (the shared modal, `Button`, `formatCents`). Props: `{ open, options, onChoose(method), onClose, choosing }`. One option per method: the method name ("Card" / "Bank transfer"), the fee line ("+ $15.32 processing fee" or "No fee"), and the total ("You pay $395.32").

- [ ] **Step 4: Wire Pay Now**

On both portal pages, Pay Now calls `getPaymentOptions`. If `hostedInvoice` is true, call `getPaymentCheckoutUrl` with no method and redirect, as today. Otherwise open `PaymentMethodDialog`; `onChoose` calls `getPaymentCheckoutUrl(lawFirmId, id, clientRecordId, method)` and redirects. Keep the existing loading and error handling.

- [ ] **Step 5: Firm-side request result**

In `billing.service.ts`, widen both request return types to `{ hostedInvoiceUrl: string | null; paymentUrl: string; stripeInvoiceId: string | null }`. In `useInvoiceDetailController.tsx:1443-1451`, use `result.paymentUrl` instead of `result.hostedInvoiceUrl` for the portal message link. The installment request still returns a hosted URL, so give its return the same shape on the backend (`paymentUrl: finalized.hosted_invoice_url` in `requestInstallmentPayment`'s return) and add that assertion to the existing installment request test.

- [ ] **Step 6: Run the tests and the gate**

Run: `cd frontend && npm run test:unit && npm run ci:checks`
Expected: PASS and exit 0.

---

### Task 12: Docs and environment

**Files:**
- Modify: `docs/features/stripe-payments.md` (fee economics table near `:274`, plus a new "Client-paid processing fees" section)
- Modify: `docs/features/billing.md` (billing settings list)
- Modify: `backend/.env.example` (commented `STRIPE_ACH_FEE_RATE`, `STRIPE_ACH_FEE_CAP_CENTS`, `STRIPE_DIRECT_APPLICATION_FEE_RATE`)

- [ ] **Step 1: Update the fee table** to the per-method schedule in "Decisions" above, including the lower Express bank-transfer fee.
- [ ] **Step 2: Add the section** covering: the two settings, the gross-up with the $1,000 examples, the method chooser, the portal-only request and its no-portal-access fallback, how the surcharge is stored (`invoice_payments.surcharge_cents`) and kept out of invoice money, refund ordering (invoice money first), and the two known limits (debit cards are surcharged; installments are firm-paid).
- [ ] **Step 3: Check the diff for em-dashes** as `.claude/rules/no-em-dashes.md` describes, and reword any found.

---

## Final verification (run before saying it is done)

```bash
cd backend && npm run typecheck && npm run lint && npx jest tests/stripe/processingFees.test.ts tests/stripe/clientPaidFeeWebhooks.test.ts tests/stripe/stripePaymentRequests.test.ts tests/stripe/stripeDirectCharges.test.ts tests/stripe/stripeApplicationFee.test.ts tests/stripe/stripeReversalWebhooks.test.ts tests/stripe/stripeAutoRecovery.test.ts tests/billing/processingFeeSettings.test.ts
cd ../frontend && npm run ci:checks && npm run test:unit
```

Do not run the full backend `npm test` unless the user asks. Leave everything uncommitted.
