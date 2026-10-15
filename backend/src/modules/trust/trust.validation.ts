import { z } from 'zod';
// Bounded paging params, shared so every list agrees on how deep a window may go.
const { offsetParam } = require('../../shared/validation/listQuery');
const { isValidCalendarDateString } = require('../../shared/validation/calendarDate');
const { MAX_MONEY_AMOUNT } = require('../billing/shared/money');

// Trust id fields reference uuid columns. Validate the shape here so a malformed
// id returns a clean 400 instead of flowing into a `... for update` query and
// blowing up as a raw 500 on the uuid cast.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (msg = 'Must be a valid id') => z.string().regex(UUID_RE, msg);

const accountType = z.enum(['iolta', 'trust', 'separate_interest']);
const interestBeneficiary = z.enum(['bar_foundation', 'client', 'firm']);

// The regex only proves the string is shaped like a date; it happily matches
// "2026-02-30" or "2026-04-31". Those reach `txn_date`/`book_close_date`
// (native Postgres `date` columns) unchanged, and Postgres's own parser
// rejects an out-of-range day with "date/time field value out of range" - a
// raw error with no .statusCode, so it falls through the central error
// handler's generic branch as a scrubbed, unhelpful 500 instead of a 400
// naming the bad field. `isValidCalendarDateString` round-trips through
// Date.UTC and compares the parts back out to catch this before it ever
// reaches a query.
const dateStr = (msg = 'Date must be YYYY-MM-DD') => z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, msg)
  .refine(isValidCalendarDateString, { message: 'Must be a real calendar date' });

export const createAccountSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Account name is required'),
    bankName: z.string().min(1, 'Bank name is required'),
    accountNumberLast4: z.string().length(4).regex(/^\d{4}$/, 'Must be exactly 4 digits'),
    routingNumberLast4: z.string().length(4).regex(/^\d{4}$/, 'Must be exactly 4 digits').optional(),
    accountType: accountType.optional(),
    ioltaTin: z.string().trim().max(32).optional(),
    interestBeneficiary: interestBeneficiary.optional(),
  }),
});

export const updateAccountSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    bankName: z.string().min(1).optional(),
    accountNumberLast4: z.string().length(4).regex(/^\d{4}$/).optional(),
    routingNumberLast4: z.string().length(4).regex(/^\d{4}$/).optional(),
    accountType: accountType.optional(),
    ioltaTin: z.string().trim().max(32).optional(),
    interestBeneficiary: interestBeneficiary.optional(),
  }),
});

// Period lock. A null date clears the lock.
export const bookCloseSchema = z.object({
  body: z.object({
    bookCloseDate: dateStr().nullable(),
  }),
});

// Per-firm trust settings (jurisdiction defaults). All optional (partial update).
export const trustSettingsSchema = z.object({
  body: z.object({
    reconcileCadence: z.enum(['monthly', 'quarterly']).optional(),
    retentionYears: z.number().int().min(1).max(20).optional(),
    flatFeeToOperatingAllowed: z.boolean().optional(),
    electronicTrustDepositsAllowed: z.boolean().optional(),
    // Integer cents, or null for the built-in $100. Capped at the same ceiling
    // as every other money field so a mistyped figure cannot silence the alert
    // for every client at once.
    defaultMinimumCents: z.number().int().min(0)
      .max(MAX_MONEY_AMOUNT * 100, 'defaultMinimumCents is above the maximum amount')
      .nullable().optional(),
    enforceMatterTrustBalance: z.boolean().optional(),
  }),
});

// Evergreen retainer minimum upsert (per client + account).
export const minimumBalanceSchema = z.object({
  body: z.object({
    clientId: uuid('A valid client is required'),
    trustAccountId: uuid('A valid trust account is required'),
    minimumCents: z.number().int().min(0, 'Minimum must be zero or more (cents)'),
  }),
});

export const updateAccountStatusSchema = z.object({
  body: z.object({
    status: z.enum(['active', 'inactive']),
  }),
});

export const createTransactionSchema = z.object({
  body: z.object({
    trustAccountId: uuid('A valid trust account is required'),
    type: z.enum(['deposit', 'withdrawal', 'transfer', 'refund']),
    amountCents: z.number().int().positive('Amount must be a positive integer (cents)'),
    clientId: uuid('A valid client is required'),
    clientName: z.string().min(1),
    matterId: uuid('A valid matter is required').optional(),
    matterName: z.string().optional(),
    date: dateStr(),
    description: z.string().optional(),
    referenceNumber: z.string().optional(),
    payee: z.string().optional(),
    transferTo: z.enum(['operating', 'other']).optional(),
    // Destination trust account for a double-entry trust→trust transfer. Only
    // meaningful when type === 'transfer'; must differ from the source account.
    transferToAccountId: uuid('A valid destination trust account is required').optional(),
    // No 'stripe': that source marks a row the Stripe webhook posted, which the
    // void route refuses ("refund it in Stripe instead"). A hand-entered row has
    // no Stripe charge behind it, so tagging it that way would make it unvoidable.
    source: z.enum(['check', 'wire', 'ach', 'cash', 'credit_card', 'interest', 'other']).optional(),
    invoiceId: uuid('A valid invoice is required').optional(),
  }).refine(
    (b) => !b.transferToAccountId || (b.type === 'transfer' && b.transferToAccountId !== b.trustAccountId),
    { message: 'transferToAccountId is only valid on a transfer to a different trust account', path: ['transferToAccountId'] },
  ).refine(
    // A transfer moves money somewhere. Without a destination the ledger would
    // hold a withdrawal-shaped row labelled transfer, and the operating-account
    // fee rule below it could not tell which kind it was.
    (b) => b.type !== 'transfer' || Boolean(b.transferTo) || Boolean(b.transferToAccountId),
    { message: 'A transfer needs a destination: transferTo or transferToAccountId', path: ['transferTo'] },
  ).refine(
    // Only a transfer has a destination. `transferTo: 'operating'` on a deposit
    // would satisfy the fee rule's "names an invoice" check for money that never
    // left trust.
    (b) => b.type === 'transfer' || (!b.transferTo && !b.transferToAccountId),
    { message: 'transferTo is only valid on a transfer', path: ['transferTo'] },
  ),
});

// IOLTA interest remittance tracking.
export const createRemittanceSchema = z.object({
  body: z.object({
    trustAccountId: uuid('A valid trust account is required'),
    periodStart: dateStr().optional(),
    periodEnd: dateStr().optional(),
    interestEarnedCents: z.number().int().min(0).optional(),
    amountRemittedCents: z.number().int().min(0).optional(),
    remittedTo: z.string().optional(),
    remittanceDate: dateStr().optional(),
    referenceNumber: z.string().optional(),
    notes: z.string().optional(),
    status: z.enum(['pending', 'remitted']).optional(),
  }),
});

export const updateRemittanceSchema = z.object({
  body: z.object({
    periodStart: dateStr().nullable().optional(),
    periodEnd: dateStr().nullable().optional(),
    interestEarnedCents: z.number().int().min(0).optional(),
    amountRemittedCents: z.number().int().min(0).optional(),
    remittedTo: z.string().nullable().optional(),
    remittanceDate: dateStr().nullable().optional(),
    referenceNumber: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    status: z.enum(['pending', 'remitted']).optional(),
  }),
});

// Paging is opt-in, matching the reconciliation list: omitting `limit` returns
// the whole set (bounded by the repository's ceiling), which is what the current
// consumer does.
export const remittanceListQuerySchema = z.object({
  query: z.object({
    trustAccountId: uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: offsetParam,
  }),
});

export const voidTransactionSchema = z.object({
  body: z.object({
    voidReason: z.string().min(1, 'Void reason is required'),
  }),
});

export const transactionFiltersSchema = z.object({
  query: z.object({
    trustAccountId: uuid().optional(),
    clientId: uuid().optional(),
    type: z.enum(['deposit', 'withdrawal', 'transfer', 'refund']).optional(),
    status: z.enum(['completed', 'void']).optional(),
    // Same `dateStr` as every other date in this module, for the same reason:
    // both values flow straight into `txn_date >= $n` on a native `date` column,
    // so an unvalidated string reaches Postgres's own parser and comes back as a
    // scrubbed 500 rather than a 400 naming the bad field.
    startDate: dateStr('startDate must be YYYY-MM-DD').optional(),
    endDate: dateStr('endDate must be YYYY-MM-DD').optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: offsetParam,
  }),
});

export const clientLedgerQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: offsetParam,
    // Chronological by default. A paged ledger asks for 'desc' so the first page
    // holds the most recent activity rather than the oldest.
    order: z.enum(['asc', 'desc']).optional(),
  }),
});

export const listReconciliationsQuerySchema = z.object({
  query: z.object({
    trustAccountId: uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: offsetParam,
  }),
});

export const createReconciliationSchema = z.object({
  body: z.object({
    trustAccountId: uuid('A valid trust account is required'),
    reconciliationDate: dateStr(),
    bankStatementBalanceCents: z.number().int(),
    adjustments: z.array(z.object({
      description: z.string(),
      amountCents: z.number().int(),
      category: z.string().optional(),
    })).optional(),
    outstandingTransactionIds: z.array(uuid()).optional(),
    notes: z.string().optional(),
  }),
});
