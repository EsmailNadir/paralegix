const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { firmZone } = require('../../shared/utils/personalDay');
const { localDateFor } = require('../../shared/utils/localTime');
const { assertClientInFirm } = require('../../shared/utils/clientScope');
const { NotFoundError, ValidationError, AppError } = require('../../shared/errors/AppError');
const { trustAccountRepo, trustTxnRepo, trustRecRepo, trustMinRepo, trustInterestRepo,
  getFirmTrustSettings, setFirmTrustSettings, matterBelongsToClient } = require('./trust.repository');
const { isUuid } = require('../../shared/utils/isUuid');
const { assertInvoiceNotVoided } = require('../billing/shared/invoiceStatus');
const eventBus = require('../../shared/events/eventBus');
const { TRUST_LOW_BALANCE } = require('../../shared/events/eventTypes');

// The fallback when a firm has set no default of its own. A firm that wants a
// different figure sets `defaultMinimumCents` in its trust settings; a per-client
// minimum on the evergreen-retainer table still wins over both.
const LOW_BALANCE_THRESHOLD_CENTS = 10000; // $100

// Jurisdiction defaults (ABA model). Per-firm overrides are merged on top.
const TRUST_SETTINGS_DEFAULTS = {
  reconcileCadence: 'monthly',        // 'monthly' | 'quarterly'
  retentionYears: 5,                  // client trust record retention
  flatFeeToOperatingAllowed: false,   // may a flat fee be deposited straight to operating
  // Electronic (ACH) trust deposits are OFF until a firm explicitly opts in,
  // acknowledging its jurisdiction permits electronically funding a trust account.
  // A trust account must also have a connected Stripe (trust bank) account before
  // the deposit flow is available.
  electronicTrustDepositsAllowed: false,
  // The balance below which a client's trust account raises a low-balance alert,
  // in integer cents, when no per-client minimum is set. Null means the built-in
  // $100. Every firm shared that one figure and none could change it.
  defaultMinimumCents: null,
  // Make the matter ledger authoritative for withdrawals, not just a reporting
  // view. Off by default: balances are scoped per (client, account), so a firm
  // that deposits at the client level and spends against matters would have
  // every withdrawal refused if this were on.
  enforceMatterTrustBalance: false,
};

const SETTINGS_KEYS = [
  'reconcileCadence', 'retentionYears', 'flatFeeToOperatingAllowed',
  'electronicTrustDepositsAllowed', 'enforceMatterTrustBalance',
  'defaultMinimumCents',
];

const CADENCE_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3 };

/**
 * Add `months` to a raw 'YYYY-MM-DD' date, clamping to the last real day of the
 * target month.
 *
 * The clamp is the point. Plain month arithmetic rolls 30 January into 2 March,
 * so a firm that reconciles on the 30th would be told its next reconciliation is
 * due in the month AFTER the one it is actually due in, and the overdue flag
 * would fire late every quarter that starts on a short month.
 */
function addMonthsClamped(isoDate: string, months: number) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const targetMonthIndex = (m - 1) + months;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  // Day 0 of the FOLLOWING month is the last day of the target month.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return new Date(Date.UTC(targetYear, targetMonth, day)).toISOString().slice(0, 10);
}

/**
 * When the next reconciliation is due for an account, and whether it is late.
 *
 * An account that has NEVER been reconciled is overdue with no due date rather
 * than "not overdue": there is no previous statement to add a cadence to, and an
 * unreconciled account is the case a firm most needs chasing. Reporting it clean
 * because the arithmetic has no input would hide the worst case behind the one
 * that looks tidiest.
 */
function reconciliationDueStatus(lastReconciliationDate: any, cadence: any, firmToday: string) {
  const months = CADENCE_MONTHS[cadence] ?? CADENCE_MONTHS.monthly;
  if (!lastReconciliationDate) {
    return { nextReconciliationDueDate: null, reconciliationOverdue: true };
  }
  const due = addMonthsClamped(lastReconciliationDate, months);
  return {
    nextReconciliationDueDate: due,
    // Late once the due day is over on the FIRM's calendar; the UTC day turned
    // over hours early every evening in the Americas.
    reconciliationOverdue: due < firmToday,
  };
}

/**
 * The date before which trust records fall outside the firm's retention policy,
 * as a raw 'YYYY-MM-DD' string.
 *
 * `retentionYears` on its own is a number nothing can act on. The date it
 * resolves to is what a report, an archive decision or an examiner's request can
 * actually be measured against. Nothing is deleted on the strength of it:
 * `trust_transactions` is append-only and stays that way.
 */
function retentionCutoffDate(retentionYears: any) {
  const years = Number(retentionYears) || TRUST_SETTINGS_DEFAULTS.retentionYears;
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/** Stored overrides merged onto the jurisdiction defaults, plus derived values. */
async function resolveTrustSettings(lawFirmId: string) {
  const stored = await getFirmTrustSettings(lawFirmId);
  const settings = { ...TRUST_SETTINGS_DEFAULTS, ...stored };
  return { ...settings, retentionCutoffDate: retentionCutoffDate(settings.retentionYears) };
}

// Guard untrusted path/query ids before they reach a uuid-cast query. A
// malformed id is "not found", not a 500.
function assertUuid(id: any, label: any) {
  if (!isUuid(id)) throw new NotFoundError(label);
}

/**
 * The latest calendar date a bank statement may plausibly carry, as a raw
 * 'YYYY-MM-DD' string comparable with a `date` column.
 *
 * Deliberately UTC tomorrow rather than today. There is no per-firm time zone on
 * `law_firms`, so a strict UTC "today" would refuse a same-day reconciliation
 * from any firm east of UTC while a firm west of it was never affected. One day
 * of slack removes that asymmetry and still catches what this guard exists for:
 * a mistyped year, which clears every entry in the account.
 */
function latestPlausibleStatementDate() {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

// ── Formatting helpers ─────────────────────────────────────────────

function formatAccount(doc: any) {
  return {
    id: doc.id,
    name: doc.name,
    bankName: doc.bankName,
    accountNumberLast4: doc.accountNumberLast4,
    routingNumberLast4: doc.routingNumberLast4 || null,
    accountType: doc.accountType || 'iolta',
    ioltaTin: doc.ioltaTin || null,
    interestBeneficiary: doc.interestBeneficiary || null,
    bookCloseDate: doc.bookCloseDate || null,
    status: doc.status,
    bookBalance: Number(doc.bookBalance || 0),
    // Electronic-deposit (trust bank) Stripe status. The raw connected account id
    // is intentionally NOT exposed; the UI only needs the onboarding/charges state.
    stripeConnected: !!doc.stripeConnectedAccountId,
    stripeChargesEnabled: !!doc.stripeChargesEnabled,
    stripeOnboardingComplete: !!doc.stripeOnboardingComplete,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function formatRemittance(doc: any) {
  return {
    id: doc.id,
    trustAccountId: doc.trustAccountId,
    trustAccountName: doc.trustAccountName || null,
    periodStart: doc.periodStart || null,
    periodEnd: doc.periodEnd || null,
    interestEarnedCents: Number(doc.interestEarnedCents || 0),
    amountRemittedCents: Number(doc.amountRemittedCents || 0),
    remittedTo: doc.remittedTo || null,
    remittanceDate: doc.remittanceDate || null,
    referenceNumber: doc.referenceNumber || null,
    notes: doc.notes || null,
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function formatMinimumBalance(doc: any) {
  return {
    id: doc.id,
    clientId: doc.clientId,
    clientName: doc.clientName || null,
    trustAccountId: doc.trustAccountId,
    trustAccountName: doc.trustAccountName || null,
    minimumCents: Number(doc.minimumCents || 0),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function formatTransaction(doc: any) {
  return {
    id: doc.id,
    trustAccountId: doc.trustAccountId,
    trustAccountName: doc.trustAccountName || null,
    type: doc.type,
    amountCents: doc.amountCents,
    clientId: doc.clientId,
    clientName: doc.clientName,
    matterId: doc.matterId || null,
    matterName: doc.matterName || null,
    date: doc.date,
    description: doc.description || null,
    referenceNumber: doc.referenceNumber || null,
    payee: doc.payee || null,
    transferTo: doc.transferTo || null,
    transferToAccountId: doc.transferToAccountId || null,
    transferGroupId: doc.transferGroupId || null,
    source: doc.source || null,
    invoiceId: doc.invoiceId || null,
    status: doc.status,
    clientBalanceAfter: doc.clientBalanceAfter,
    accountBalanceAfter: doc.accountBalanceAfter,
    clearedAt: doc.clearedAt || null,
    clearedInReconciliationId: doc.clearedInReconciliationId || null,
    voidedBy: doc.voidedBy || null,
    voidedAt: doc.voidedAt || null,
    voidReason: doc.voidReason || null,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function formatReconciliation(doc: any) {
  return {
    id: doc.id,
    trustAccountId: doc.trustAccountId,
    reconciliationDate: doc.reconciliationDate,
    bankStatementBalanceCents: doc.bankStatementBalanceCents,
    bookBalanceCents: doc.bookBalanceCents,
    clientLedgerTotalCents: doc.clientLedgerTotalCents,
    isReconciled: doc.isReconciled,
    discrepancyCents: doc.discrepancyCents,
    adjustments: doc.adjustments || [],
    outstandingTransactionIds: doc.outstandingTransactionIds || [],
    notes: doc.notes || '',
    reconciledBy: doc.reconciledBy,
    reconciledByName: doc.reconciledByName || null,
    reconciledAt: doc.reconciledAt,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ── Trust Accounts ─────────────────────────────────────────────────

export async function createAccount({ lawFirmId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const { name, bankName, accountNumberLast4, routingNumberLast4,
    accountType, ioltaTin, interestBeneficiary } = body;

  const doc = await trustAccountRepo.create(lawFirmId, {
    name,
    bankName,
    accountNumberLast4,
    routingNumberLast4: routingNumberLast4 || null,
    accountType: accountType || 'iolta',
    ioltaTin: ioltaTin || null,
    interestBeneficiary: interestBeneficiary || null,
    status: 'active',
    bookBalance: 0,
    createdBy: actingUserId,
  });

  return { account: formatAccount(doc) };
}

export async function listAccounts({ lawFirmId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const docs = await trustAccountRepo.findAll(lawFirmId);
  return { accounts: docs.map(formatAccount) };
}

export async function getAccount({ lawFirmId, accountId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const doc = await trustAccountRepo.findByIdOrFail(lawFirmId, accountId, 'TrustAccount');
  return { account: formatAccount(doc) };
}

// The columns that define what a trust account IS, rather than what it is
// called. Every posted entry was made into an account of this type, at this bank
// account, with interest going to this beneficiary. Changing one after the fact
// silently rewrites what the existing history means, and `trust_transactions` is
// append-only so none of it can be restated. A firm that genuinely opened a
// different bank account should record a new trust account and move the balance
// across with a transfer, which leaves a ledger trail.
const ACCOUNT_IDENTITY_FIELDS = [
  'accountType', 'accountNumberLast4', 'routingNumberLast4', 'interestBeneficiary',
];

export async function updateAccount({ lawFirmId, accountId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const existing = await trustAccountRepo.findByIdOrFail(lawFirmId, accountId, 'TrustAccount');

  const { name, bankName, accountNumberLast4, routingNumberLast4,
    accountType, ioltaTin, interestBeneficiary } = body;

  // Only a field that actually CHANGES is a restatement. Re-sending the current
  // value (which a PUT-shaped form does on every save) must not be refused, or
  // renaming an account with history becomes impossible.
  const changedIdentityFields = ACCOUNT_IDENTITY_FIELDS.filter((field) => {
    if (body[field] === undefined) return false;
    return (body[field] || null) !== (existing[field] || null);
  });
  if (changedIdentityFields.length > 0
      && await trustAccountRepo.hasLedgerActivity(lawFirmId, accountId)) {
    throw new AppError(
      'This trust account already has ledger history, so its type, bank account digits and '
      + `interest beneficiary are fixed (${changedIdentityFields.join(', ')}). `
      + 'Record a new trust account and transfer the balance across instead.',
      400, 'TRUST_ACCOUNT_HAS_HISTORY',
    );
  }

  const updateData: Record<string, any> = {};
  if (name !== undefined) updateData.name = name;
  if (bankName !== undefined) updateData.bankName = bankName;
  if (accountNumberLast4 !== undefined) updateData.accountNumberLast4 = accountNumberLast4;
  if (routingNumberLast4 !== undefined) updateData.routingNumberLast4 = routingNumberLast4;
  if (accountType !== undefined) updateData.accountType = accountType;
  if (ioltaTin !== undefined) updateData.ioltaTin = ioltaTin || null;
  if (interestBeneficiary !== undefined) updateData.interestBeneficiary = interestBeneficiary || null;
  updateData.updatedBy = actingUserId;

  const updated = await trustAccountRepo.update(lawFirmId, accountId, updateData);
  const fresh = await trustAccountRepo.findById(lawFirmId, accountId);
  return { account: formatAccount(fresh) };
}

export async function updateAccountStatus({ lawFirmId, accountId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const account = await trustAccountRepo.findByIdOrFail(lawFirmId, accountId, 'TrustAccount');

  // Block ANY non-zero balance, not just positive: a negative book balance
  // (an overdraft/outstanding liability tolerated on legacy rows) must not be
  // hidden by deactivating the account.
  if (body.status === 'inactive' && Number(account.bookBalance || 0) !== 0) {
    throw new AppError(
      'Cannot deactivate a trust account with a non-zero balance.',
      400,
      'TRUST_ACCOUNT_HAS_BALANCE',
    );
  }

  await trustAccountRepo.update(lawFirmId, accountId, {
    status: body.status,
    updatedBy: actingUserId,
  });
  const fresh = await trustAccountRepo.findById(lawFirmId, accountId);
  return { account: formatAccount(fresh) };
}

/**
 * Set (or clear, with null) an account's book-close date. Transactions dated
 * on/before this date are locked: they can no longer be posted or voided. We
 * only allow advancing the close date (or clearing it) so a previously closed
 * period cannot be silently reopened past an earlier lock.
 */
export async function setBookCloseDate({ lawFirmId, accountId, actingUserId, bookCloseDate }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const account = await trustAccountRepo.findByIdOrFail(lawFirmId, accountId, 'TrustAccount');

  // The ratchet. Both dates are raw 'YYYY-MM-DD' strings, so they compare
  // lexicographically. Clearing the lock (null) stays allowed: that is a
  // deliberate, total removal a reader can see, whereas moving the date back
  // reopens one period and leaves no trace but the column that just changed.
  const current = account.bookCloseDate || null;
  if (current && bookCloseDate && bookCloseDate < current) {
    throw new AppError(
      `The books are already closed through ${current}. A close date can be advanced or `
      + 'cleared, but not moved backwards.',
      400, 'TRUST_PERIOD_LOCK_REGRESSION',
    );
  }

  await trustAccountRepo.update(lawFirmId, accountId, {
    bookCloseDate: bookCloseDate || null,
    updatedBy: actingUserId,
  });
  const fresh = await trustAccountRepo.findById(lawFirmId, accountId);
  return { account: formatAccount(fresh) };
}

export async function getAccountSummary({ lawFirmId, accountId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const account = await trustAccountRepo.findByIdOrFail(lawFirmId, accountId, 'TrustAccount');

  // Per-client balances + non-void transaction count, both computed server-side.
  // (Previously this fetched up to 1000 rows and aggregated in JS, which both
  // under-counted past the 1000-row cap and re-filtered voids client-side.)
  const breakdown = await trustTxnRepo.computeAccountClientBreakdown(lawFirmId, accountId);
  const transactionCount = await trustTxnRepo.countNonVoidByAccount(lawFirmId, accountId);

  const clientBalances = breakdown
    .filter((c: any) => c.balanceCents !== 0)
    .map((c: any) => ({
      clientId: c.clientId,
      clientName: c.clientName,
      trustAccountId: accountId,
      balanceCents: c.balanceCents,
    }));

  return {
    account: formatAccount(account),
    clientBalances,
    transactionCount,
    clientCount: clientBalances.length,
  };
}

// ── Trust Transactions ─────────────────────────────────────────────

/**
 * Create a trust transaction atomically.
 * Runs inside a single Postgres transaction (createWithBalance) that updates the
 * account book balance and inserts the ledger row together, under a row lock.
 */
export async function createTransaction({ lawFirmId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  // The caller belonging to the firm does not make the CLIENT belong to it.
  // Checked HERE rather than in `_createTransactionInternal`, which the billing
  // integration also calls and which documents its caller as responsible for
  // authorization; this is the HTTP entry point, so it is the one taking a
  // client id straight from a request body.
  //
  // Trust is the worst place in the app to get this wrong. The entry records
  // client money in a fiduciary account, `trust_transactions` is append-only so
  // a bad row cannot be edited or deleted, and its `client_id` references
  // `clients(id)` with no cascade, so the owning firm is permanently blocked
  // from deleting that client by a row it cannot see.
  await assertClientInFirm(lawFirmId, body.clientId);

  // The matter FK is `(law_firm_id, matter_id)`, which only proves the matter is
  // in this firm. Attributing this client's money to a co-client-free matter of
  // ANOTHER client is wrong inside one firm too, and the row is append-only.
  if (body.matterId && !await matterBelongsToClient(lawFirmId, body.matterId, body.clientId)) {
    throw new AppError(
      'That matter does not belong to this client, so trust money cannot be posted against it.',
      400, 'TRUST_MATTER_CLIENT_MISMATCH',
    );
  }

  // The invoice an entry names must be this firm's and this client's. The
  // composite key catches another firm's id, but as a raw 23503 the handler
  // scrubs into a 500; and it cannot catch an in-firm invoice that belongs to a
  // DIFFERENT client, which would link a fee withdrawal to the wrong client's
  // bill on an append-only ledger.
  if (body.invoiceId) {
    const invoicesRepo = require('../billing/invoices/invoices.repository');
    const located = await invoicesRepo.findContextById(lawFirmId, body.invoiceId);
    const invoice = located ? await invoicesRepo.findById(located.context, body.invoiceId) : null;
    if (!invoice) {
      throw new AppError('That invoice does not exist in this firm.', 400, 'TRUST_INVOICE_NOT_FOUND');
    }
    const payerId = invoice.clientId || invoice.clientContextId || null;
    if (payerId && payerId !== body.clientId) {
      throw new AppError(
        'That invoice belongs to a different client, so this entry cannot be linked to it.',
        400, 'TRUST_INVOICE_CLIENT_MISMATCH',
      );
    }
    // Void is terminal and the ledger is append-only: a link to a cancelled
    // bill could never be removed. Same refusal the invoice side gives.
    assertInvoiceNotVoided(invoice, 'link a trust entry to it');
  }

  // Moving trust money to the operating account is the firm taking a fee. Bar
  // rules want a bill behind that, so the entry has to name the invoice it pays.
  // `flatFeeToOperatingAllowed` is the firm asserting its jurisdiction permits an
  // earned flat fee to move without one. Trust-to-trust transfers are not fees:
  // the money is still the client's, so `transferToAccountId` is exempt.
  if (body.transferTo === 'operating' && !body.invoiceId && !body.transferToAccountId) {
    const settings = { ...TRUST_SETTINGS_DEFAULTS, ...(await getFirmTrustSettings(lawFirmId)) };
    if (!settings.flatFeeToOperatingAllowed) {
      throw new AppError(
        'A transfer to the operating account must name the invoice it pays. Enable '
        + '"flat fee to operating" in trust settings if your jurisdiction allows an earned '
        + 'flat fee to move without a separate invoice.',
        400, 'TRUST_FEE_REQUIRES_INVOICE',
      );
    }
  }

  return _createTransactionInternal({ lawFirmId, actingUserId, body });
}

/**
 * Internal transaction creation, shared by the HTTP endpoint and the billing integration.
 * Does NOT re-check membership (caller is responsible).
 *
 * Balance computation happens INSIDE the Postgres transaction (under a
 * `SELECT ... FOR UPDATE` lock on the account row) to prevent concurrent
 * withdrawals from overdrawing a client's account.
 */
async function _createTransactionInternal(
  { lawFirmId, actingUserId, body: rawBody, executor, settledStripeFunds = false }: any,
) {
  // Resolved once, here, so EVERY write path inherits it: the HTTP route, the
  // billing bridge and the Stripe webhook all funnel through this function. The
  // repository takes it as a plain flag rather than reading settings itself,
  // which keeps the locked transaction body free of an extra round-trip.
  const settings = await resolveTrustSettings(lawFirmId);
  const body = { ...rawBody, enforceMatterBalance: !!settings.enforceMatterTrustBalance };
  const { type, transferToAccountId, clientId, clientName } = body;

  // Double-entry trust→trust transfer: a linked withdrawal + deposit pair across
  // two accounts. The client's TOTAL trust balance is unchanged (funds just move
  // between accounts), so this path does NOT emit the low-balance warning.
  if (type === 'transfer' && transferToAccountId) {
    const result = await trustTxnRepo.createTransferWithBalance({ lawFirmId, actingUserId, body });
    return { transaction: formatTransaction(result.transaction) };
  }

  // Atomic create + book-balance update + overdraft guard (Postgres transaction).
  // `executor`, when a caller supplies one, makes that a savepoint inside the
  // caller's transaction instead of a second connection. See createWithBalance.
  const result = await trustTxnRepo.createWithBalance(
    { lawFirmId, actingUserId, body, settledStripeFunds },
    executor,
  );
  const { transaction, clientBalanceBefore, clientBalanceAfter, isCredit } = result;

  // Emit low balance warning if a debit dropped below the threshold. The
  // threshold is the per-(client, account) configured minimum (evergreen
  // retainer) when set, otherwise the firm-wide default.
  // Most specific wins: this client's own minimum on this account, then the
  // firm's default, then the built-in one.
  const firmTrustSettings = { ...TRUST_SETTINGS_DEFAULTS, ...(await getFirmTrustSettings(lawFirmId)) };
  // `?? null` on the value FIRST: `Number(null)` is 0, which is finite, so a
  // null setting would otherwise read as a zero threshold and silence the alert
  // for every client at once.
  const configuredDefault = firmTrustSettings.defaultMinimumCents;
  const firmDefaultMinimum = configuredDefault == null || !Number.isFinite(Number(configuredDefault))
    ? null
    : Number(configuredDefault);
  const threshold = (await trustMinRepo.getMinimum(lawFirmId, clientId, body.trustAccountId))
    ?? firmDefaultMinimum
    ?? LOW_BALANCE_THRESHOLD_CENTS;
  if (!isCredit && threshold > 0
      && clientBalanceAfter < threshold && clientBalanceBefore >= threshold) {
    eventBus.emit(TRUST_LOW_BALANCE, {
      eventId: transaction.id,
      lawFirmId,
      clientId,
      clientName,
      balanceCents: clientBalanceAfter,
      thresholdCents: threshold,
    });
  }

  return { transaction: formatTransaction(transaction) };
}

export async function listTransactions({ lawFirmId, actingUserId, filters }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const f = filters || {};
  const [txns, totalItems] = await Promise.all([
    trustTxnRepo.findWithFilters(lawFirmId, f),
    trustTxnRepo.countWithFilters(lawFirmId, f),
  ]);
  // `transactions` is preserved for the existing consumer (frontend reads
  // body.transactions); `totalItems` is the total matching the same filters,
  // independent of the limit/offset window.
  return { transactions: txns.map(formatTransaction), totalItems };
}

export async function getTransaction({ lawFirmId, transactionId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const doc = await trustTxnRepo.findById(lawFirmId, transactionId);
  if (!doc) throw new NotFoundError('TrustTransaction');
  return { transaction: formatTransaction(doc) };
}

export async function voidTransaction({ lawFirmId, transactionId, actingUserId, body }: any) {
  assertUuid(transactionId, 'TrustTransaction');
  await assertLawFirmMembership(lawFirmId, actingUserId);

  // An entry that paid an invoice is half of a two-system record, and only the
  // billing side knows how to unwind both halves. `invoices.service` already
  // reverses the trust entry when the payment behind it is removed
  // (`voidTrustWithdrawalsForRemovedPayments`, which calls
  // `voidTransactionInternal` and so does not reach this guard). Nothing did the
  // reverse: voiding here returns the money to the client's trust balance while
  // the invoice still records a trust payment, leaving the invoice payable from
  // trust a second time. Send the user to the payment, which reverses both.
  const existing = await trustTxnRepo.findById(lawFirmId, transactionId);
  if (existing && existing.invoiceId) {
    throw new AppError(
      'This entry paid an invoice, so it cannot be voided on its own. Remove the trust payment '
      + 'on that invoice instead, which reverses this entry with it.',
      409, 'TRUST_ENTRY_LINKED_TO_INVOICE',
    );
  }

  // A Stripe-funded deposit is half of a two-system record too. Voiding it here
  // posts a reversing entry and moves no money at Stripe, so the IOLTA still
  // holds the funds while the ledger says they left: a shortfall the firm cannot
  // see. Refunding through Stripe returns the money AND comes back as
  // `charge.refunded`, which reverses the ledger through the same path that
  // recorded it. The Stripe-driven reversal itself goes through
  // `voidTransactionInternal`, which does not pass this guard.
  if (existing && existing.source === 'stripe') {
    throw new AppError(
      'This deposit was paid electronically, so it cannot be voided by hand. Refund it in Stripe '
      + 'instead; the refund returns the money and reverses this entry with it.',
      409, 'TRUST_ENTRY_STRIPE_FUNDED',
    );
  }

  // Atomic void + reversing book-balance update (Postgres transaction).
  const updated = await trustTxnRepo.voidWithBalance({
    lawFirmId, actingUserId, transactionId, voidReason: body.voidReason,
  });
  return { transaction: formatTransaction(updated) };
}

// ── Client Ledger & Balances ───────────────────────────────────────

export async function getClientLedger({ lawFirmId, clientId, actingUserId, limit, offset, order }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  assertUuid(clientId, 'Client');
  const page = { limit: limit ?? 100, offset: offset ?? 0, order: order ?? 'asc' };
  const [txns, totalItems] = await Promise.all([
    trustTxnRepo.findByClientId(lawFirmId, clientId, page),
    trustTxnRepo.countByClientId(lawFirmId, clientId),
  ]);
  // `transactions` preserved as an array for the existing consumer; `totalItems`
  // is the full count independent of the limit/offset window.
  return { transactions: txns.map(formatTransaction), totalItems };
}

export async function getClientBalance({ lawFirmId, clientId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  assertUuid(clientId, 'Client');

  const accounts = await trustAccountRepo.findAll(lawFirmId);
  const balanceByAccount = await trustTxnRepo.computeClientBalancesByAccount(lawFirmId, clientId);
  const accountBalances = accounts.map((acct: any) => ({
    clientId,
    trustAccountId: acct.id,
    balanceCents: balanceByAccount.get(acct.id) || 0,
  }));

  const totalBalanceCents = accountBalances.reduce((sum: any, b: any) => sum + b.balanceCents, 0);
  return { clientId, totalBalanceCents, accountBalances };
}

export async function listAllBalances({ lawFirmId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const balances = await trustTxnRepo.computeAllBalances(lawFirmId);
  return { balances };
}

// ── Matter Ledger & Balances ───────────────────────────────────────

export async function getMatterLedger({ lawFirmId, matterId, actingUserId, limit, offset, order }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  assertUuid(matterId, 'Matter');
  const page = { limit: limit ?? 100, offset: offset ?? 0, order: order ?? 'asc' };
  const [txns, totalItems] = await Promise.all([
    trustTxnRepo.findByMatterId(lawFirmId, matterId, page),
    trustTxnRepo.countByMatterId(lawFirmId, matterId),
  ]);
  return { transactions: txns.map(formatTransaction), totalItems };
}

export async function getMatterBalance({ lawFirmId, matterId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  assertUuid(matterId, 'Matter');

  const accounts = await trustAccountRepo.findAll(lawFirmId);
  const balanceByAccount = await trustTxnRepo.computeMatterBalancesByAccount(lawFirmId, matterId);
  const accountBalances = accounts.map((acct: any) => ({
    matterId,
    trustAccountId: acct.id,
    trustAccountName: acct.name,
    balanceCents: balanceByAccount.get(acct.id) || 0,
  }));

  const totalBalanceCents = accountBalances.reduce((sum: any, b: any) => sum + b.balanceCents, 0);
  return { matterId, totalBalanceCents, accountBalances: accountBalances.filter((b: any) => b.balanceCents !== 0) };
}

// ── Minimum Balances (evergreen retainer thresholds) ───────────────

export async function listMinimumBalances({ lawFirmId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const docs = await trustMinRepo.listAll(lawFirmId);
  return { minimumBalances: docs.map(formatMinimumBalance) };
}

export async function upsertMinimumBalance({ lawFirmId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const { clientId, trustAccountId, minimumCents } = body;
  await trustAccountRepo.findByIdOrFail(lawFirmId, trustAccountId, 'TrustAccount');
  const doc = await trustMinRepo.upsert(lawFirmId, { clientId, trustAccountId, minimumCents, actingUserId });
  return { minimumBalance: formatMinimumBalance(doc) };
}

export async function deleteMinimumBalance({ lawFirmId, actingUserId, id }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  assertUuid(id, 'TrustMinimumBalance');
  // The delete below is firm-scoped, so another firm's row is never removed, but
  // without this read it removes nothing and still answers 200 "removed". That
  // tells the caller a threshold in ANOTHER firm was deleted, and tells a caller
  // in this firm that a row which never existed is gone. Resolve the row first so
  // the route answers 404, matching updateRemittance below.
  await trustMinRepo.findByIdOrFail(lawFirmId, id, 'TrustMinimumBalance');
  await trustMinRepo.delete(lawFirmId, id);
  return { message: 'Minimum balance removed', id };
}

// ── Per-firm Trust Settings (jurisdiction defaults) ────────────────

export async function getTrustSettings({ lawFirmId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  return { settings: await resolveTrustSettings(lawFirmId) };
}

export async function updateTrustSettings({ lawFirmId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const patch: Record<string, any> = {};
  for (const k of SETTINGS_KEYS) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  await setFirmTrustSettings(lawFirmId, patch);
  return { settings: await resolveTrustSettings(lawFirmId) };
}

// ── IOLTA Interest Remittances ─────────────────────────────────────

/**
 * IOLTA interest remittances, newest period first.
 *
 * `remittances` stays an array for the existing consumer. `totalItems` is the
 * full count for the same scope, independent of any limit/offset window, and
 * `truncated` says the unpaged read stopped at `ceiling` — this is accounting
 * history, so a list that quietly ends looks like records that were never filed.
 */
export async function listRemittances({ lawFirmId, actingUserId, trustAccountId, limit, offset }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  if (trustAccountId) assertUuid(trustAccountId, 'TrustAccount');
  const scope = { trustAccountId: trustAccountId || null };
  const [{ remittances, truncated, ceiling }, totalItems] = await Promise.all([
    trustInterestRepo.listAll(lawFirmId, { ...scope, limit, offset }),
    trustInterestRepo.countAll(lawFirmId, scope),
  ]);
  return { remittances: remittances.map(formatRemittance), totalItems, truncated, ceiling };
}

export async function createRemittance({ lawFirmId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const { trustAccountId } = body;
  await trustAccountRepo.findByIdOrFail(lawFirmId, trustAccountId, 'TrustAccount');
  const doc = await trustInterestRepo.create(lawFirmId, {
    trustAccountId,
    periodStart: body.periodStart || null,
    periodEnd: body.periodEnd || null,
    interestEarnedCents: body.interestEarnedCents ?? 0,
    amountRemittedCents: body.amountRemittedCents ?? 0,
    remittedTo: body.remittedTo || null,
    remittanceDate: body.remittanceDate || null,
    referenceNumber: body.referenceNumber || null,
    notes: body.notes || null,
    status: body.status || 'pending',
    createdBy: actingUserId,
  });
  return { remittance: formatRemittance(doc) };
}

export async function updateRemittance({ lawFirmId, actingUserId, remittanceId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  assertUuid(remittanceId, 'TrustInterestRemittance');
  await trustInterestRepo.findByIdOrFail(lawFirmId, remittanceId, 'TrustInterestRemittance');
  const updateData: any = { updatedBy: actingUserId };
  for (const k of ['periodStart', 'periodEnd', 'interestEarnedCents', 'amountRemittedCents',
    'remittedTo', 'remittanceDate', 'referenceNumber', 'notes', 'status']) {
    if (body[k] !== undefined) updateData[k] = body[k];
  }
  await trustInterestRepo.update(lawFirmId, remittanceId, updateData);
  const fresh = await trustInterestRepo.findById(lawFirmId, remittanceId);
  return { remittance: formatRemittance(fresh) };
}

export async function deleteRemittance({ lawFirmId, actingUserId, remittanceId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  assertUuid(remittanceId, 'TrustInterestRemittance');
  // Same reason as deleteMinimumBalance: the delete is firm-scoped, so a
  // remittance belonging to another firm survives, but without this read the
  // route still answers 200 "removed" over IOLTA interest history that was never
  // touched. updateRemittance already resolves the row first; so does this.
  await trustInterestRepo.findByIdOrFail(lawFirmId, remittanceId, 'TrustInterestRemittance');
  await trustInterestRepo.delete(lawFirmId, remittanceId);
  return { message: 'Remittance removed', remittanceId };
}

// ── Reconciliation ─────────────────────────────────────────────────

export async function createReconciliation({ lawFirmId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const {
    trustAccountId, reconciliationDate, bankStatementBalanceCents,
    adjustments, outstandingTransactionIds, notes,
  } = body;

  const account = await trustAccountRepo.findByIdOrFail(lawFirmId, trustAccountId, 'TrustAccount');

  // Reconciliation history is a forward sequence of bank statements, and the
  // statement date is what `createWithClearing` clears against. Both failures
  // below are silent without a guard:
  //   - A future date (a mistyped year) clears every entry in the account, and a
  //     cleared entry can no longer be voided.
  //   - A date at or before the previous reconciliation is a duplicate or a typo,
  //     and the `is_reconciled` it records is measured against a book balance
  //     from the wrong month.
  const latestPlausible = latestPlausibleStatementDate();
  if (reconciliationDate > latestPlausible) {
    throw new ValidationError({
      reconciliationDate: 'A bank statement cannot be dated in the future.',
    });
  }
  const latestReconciled = await trustRecRepo.findLatestDateForAccount(lawFirmId, trustAccountId);
  if (latestReconciled && reconciliationDate <= latestReconciled) {
    throw new AppError(
      `This account is already reconciled through ${latestReconciled}. A new reconciliation must `
      + 'be dated after that. Reopen the existing one if it needs correcting.',
      400, 'RECONCILIATION_OUT_OF_ORDER',
    );
  }

  const bookBalanceCents = account.bookBalance || 0;

  // Three-way reconciliation. The client-ledger total is the SUM of the
  // per-client balances derived directly from the ledger, NOT
  // computeAccountBalance(), which is tautologically equal to the book balance
  // and would prove nothing. If a transaction has a client_id that doesn't roll
  // up, or the book balance drifts from the ledger, these two will diverge.
  const clientBreakdown = await trustTxnRepo.computeAccountClientBreakdown(lawFirmId, trustAccountId);
  const clientLedgerTotalCents = clientBreakdown.reduce(
    (sum: any, c: any) => sum + (c.balanceCents || 0), 0,
  );

  // The bank statement balance is expected to differ from the book balance only
  // by outstanding (uncleared) transactions and any reconciling adjustments:
  //   expectedBank = book - Σ(outstanding txn deltas) + Σ(adjustment amounts)
  const outstandingIds = outstandingTransactionIds || [];
  // Validate AND sum the flagged outstanding ids in ONE query. A foreign/voided
  // id contributes 0 to the sum, which would understate the outstanding total and
  // corrupt the reconciliation. We reject the request when any flagged id
  // doesn't resolve to a valid (this-account, non-void) row, rather than silently
  // dropping it. `netCents` is the deposit-inflow/else-outflow sum (same direction
  // convention as balanceExpr) over exactly the validated rows.
  const { validIds, netCents: outstandingNetCents } =
    await trustTxnRepo.validateAndSumOutstanding(lawFirmId, trustAccountId, outstandingIds);
  if (outstandingIds.length > 0) {
    const invalidIds = outstandingIds.filter((id: any) => !validIds.has(id));
    if (invalidIds.length > 0) {
      throw new ValidationError({
        outstandingTransactionIds:
          `These ids do not belong to this account or are voided: ${invalidIds.join(', ')}`,
        invalidIds,
      });
    }
  }

  const adjustmentsTotalCents = (adjustments || []).reduce(
    (sum: any, a: any) => sum + (a.amountCents || 0), 0,
  );

  const expectedBankBalanceCents = bookBalanceCents - outstandingNetCents + adjustmentsTotalCents;

  // discrepancyCents is the bank-vs-expected gap (drives the "off by $X" UI).
  const discrepancyCents = bankStatementBalanceCents - expectedBankBalanceCents;

  // Fully reconciled only when all three agree: bank (adjusted for outstanding
  // and adjustments) == book == Σ client-ledger balances.
  const isReconciled =
    discrepancyCents === 0 && (bookBalanceCents - clientLedgerTotalCents) === 0;

  // Insert the reconciliation AND mark cleared transactions in one transaction:
  // every completed entry dated on/before the statement date that was not flagged
  // outstanding becomes cleared, stamped with this reconciliation's id. "Currently
  // outstanding" is then a simple query (completed + cleared_at is null).
  const reconciledAt = new Date().toISOString();
  const rec = await trustRecRepo.createWithClearing(
    lawFirmId,
    {
      bankStatementBalanceCents,
      bookBalanceCents,
      clientLedgerTotalCents,
      isReconciled,
      discrepancyCents,
      adjustments: adjustments || [],
      notes: notes || '',
      reconciledBy: actingUserId,
      reconciledAt,
      createdBy: actingUserId,
    },
    {
      trustAccountId,
      reconciliationDate,
      outstandingIds: outstandingTransactionIds || [],
      clearedAt: reconciledAt,
    },
  );

  return { reconciliation: formatReconciliation(rec) };
}

export async function listReconciliations({ lawFirmId, actingUserId, trustAccountId, limit, offset }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  if (trustAccountId) assertUuid(trustAccountId, 'TrustAccount');
  const scope = { trustAccountId: trustAccountId || null, limit: limit ?? 100, offset: offset ?? 0 };
  const [docs, totalItems] = await Promise.all([
    trustRecRepo.findPaged(lawFirmId, scope),
    trustRecRepo.countAll(lawFirmId, scope),
  ]);

  // `reconciliations` preserved as an array for the existing consumer;
  // `totalItems` is the full count independent of the limit/offset window.
  return { reconciliations: docs.map(formatReconciliation), totalItems };
}

export async function getLatestReconciliation({ lawFirmId, actingUserId, trustAccountId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  // A missing trustAccountId is a bad request, not a missing resource. Without this
  // guard assertUuid(undefined) throws a misleading 404 "TrustAccount not found".
  if (!trustAccountId) {
    throw new ValidationError({ trustAccountId: 'trustAccountId is required' });
  }
  assertUuid(trustAccountId, 'TrustAccount');
  const rec = await trustRecRepo.findLatestByAccountId(lawFirmId, trustAccountId);
  return { reconciliation: rec ? formatReconciliation(rec) : null };
}

export async function getReconciliation({ lawFirmId, reconciliationId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const doc = await trustRecRepo.findByIdOrFail(lawFirmId, reconciliationId, 'TrustReconciliation');
  return { reconciliation: formatReconciliation(doc) };
}

/**
 * Reopen (undo) a reconciliation: un-clear the transactions it cleared and remove
 * the reconciliation. Needed so a mistaken reconciliation no longer permanently
 * blocks voiding a transaction it cleared.
 */
export async function reopenReconciliation({ lawFirmId, reconciliationId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  assertUuid(reconciliationId, 'TrustReconciliation');
  const unclearedCount = await trustRecRepo.reopen(lawFirmId, reconciliationId);
  if (unclearedCount === null) throw new NotFoundError('TrustReconciliation');
  return { message: 'Reconciliation reopened', reconciliationId, unclearedCount };
}

/**
 * Get the current snapshot of a trust account for pre-populating the reconciliation wizard.
 * Returns: bookBalance, clientLedgerTotal, per-client breakdown, lastReconciliationDate
 */
export async function getReconciliationSnapshot({ lawFirmId, trustAccountId, actingUserId }: any) {
  const firmToday = localDateFor(await firmZone(lawFirmId));
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const account = await trustAccountRepo.findByIdOrFail(lawFirmId, trustAccountId, 'TrustAccount');
  const bookBalanceCents = account.bookBalance || 0;

  // Per-client breakdown from the ledger.
  const clientBreakdown = await trustTxnRepo.computeAccountClientBreakdown(lawFirmId, trustAccountId);

  // Derive the client-ledger total from the SAME per-client breakdown that
  // createReconciliation uses (NOT computeAccountBalance, the raw account SUM).
  // This guarantees the pre-fill and the stored reconciliation agree even if a
  // transaction has a null/unrollable client_id that the breakdown groups apart.
  const clientLedgerTotalCents = clientBreakdown.reduce(
    (sum: any, c: any) => sum + (c.balanceCents || 0), 0,
  );

  const latestRec = await trustRecRepo.findLatestByAccountId(lawFirmId, trustAccountId);
  const settings = await resolveTrustSettings(lawFirmId);
  // The STATEMENT date, not `reconciled_at`. The cadence runs on the periods the
  // firm has certified, not on when someone happened to sit down and do the
  // paperwork, so a firm catching up on three months at once is not credited with
  // being three months ahead.
  const lastReconciliationDate = latestRec?.reconciliationDate || null;

  return {
    bookBalanceCents,
    clientLedgerTotalCents,
    clientBreakdown,
    lastReconciliationDate,
    lastReconciledAt: latestRec?.reconciledAt || null,
    accountName: account.name || null,
    reconcileCadence: settings.reconcileCadence,
    ...reconciliationDueStatus(lastReconciliationDate, settings.reconcileCadence, firmToday),
  };
}

/**
 * The firm-wide trust audit report: every account's three-way figures, its
 * per-client breakdown, its negative balances and its reconciliation standing,
 * in one read.
 *
 * A bar examination asks the firm to prove all of this at once. The data already
 * existed but only one account and one client at a time, so producing the proof
 * meant clicking through every account and every client by hand and assembling
 * the answer off-screen, which is where mistakes live.
 *
 * Deliberately as-of-now rather than as-of-a-date. `book_balance_cents` is a live
 * running total with no history, so an as-of-date ledger figure sitting beside a
 * present-day book figure would make the comparison between them meaningless,
 * which is the one comparison this report exists to make.
 */
export async function getAuditReport({ lawFirmId, actingUserId }: any) {
  const firmToday = localDateFor(await firmZone(lawFirmId));
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const settings = await resolveTrustSettings(lawFirmId);
  const accounts = await trustAccountRepo.findAll(lawFirmId);

  // One account at a time, and within an account two reads at a time rather than
  // four. Every request shares one small pool (12 connections against a Supabase
  // session pooler that allows 15), so it is the WIDTH per account, not the
  // account count, that decides how much of the pool one report can hold: the
  // loop already bounds the count, and four in flight let a single report take a
  // third of the pool for its whole duration.
  //
  // The pairing keeps the critical path short. The client breakdown is the
  // heaviest read (a GROUP BY over the account's ledger joined to `clients`), so
  // it leads, paired with the latest reconciliation, which is a `limit 1` on the
  // much smaller `trust_reconciliations` and finishes inside the breakdown's
  // shadow. The two remaining ledger aggregates then run together over the rows
  // the first pair just warmed, so the pair costs about one of them. Splitting
  // the other way would put the breakdown beside a read that cannot hide inside
  // it and leave the cheap reconciliation lookup paying for a step of its own.
  const rows: any[] = [];
  for (const account of accounts) {
    // eslint-disable-next-line no-await-in-loop
    const [clientBreakdown, latestRec] = await Promise.all([
      trustTxnRepo.computeAccountClientBreakdown(lawFirmId, account.id),
      trustRecRepo.findLatestByAccountId(lawFirmId, account.id),
    ]);
    // eslint-disable-next-line no-await-in-loop
    const [ledgerBalanceCents, outstanding] = await Promise.all([
      trustTxnRepo.computeAccountBalance(lawFirmId, account.id),
      trustTxnRepo.summariseOutstanding(lawFirmId, account.id),
    ]);

    const bookBalanceCents = Number(account.bookBalance || 0);
    const clientLedgerTotalCents = clientBreakdown.reduce(
      (sum: any, c: any) => sum + (c.balanceCents || 0), 0,
    );
    // A pooled account's total says nothing about whether one client inside it is
    // negative, and a negative client balance is a commingling finding: that
    // client's shortfall is being covered by other clients' money.
    const negativeClientBalances = clientBreakdown.filter((c: any) => c.balanceCents < 0);
    const lastReconciliationDate = latestRec?.reconciliationDate || null;

    rows.push({
      trustAccountId: account.id,
      name: account.name,
      accountType: account.accountType || 'iolta',
      bankName: account.bankName || null,
      accountNumberLast4: account.accountNumberLast4 || null,
      status: account.status,
      bookBalanceCents,
      ledgerBalanceCents,
      clientLedgerTotalCents,
      // Stored book balance minus the ledger it is supposed to mirror. Non-zero
      // means the running total has drifted from history and needs repairing.
      driftCents: bookBalanceCents - ledgerBalanceCents,
      balanced: bookBalanceCents === ledgerBalanceCents
        && bookBalanceCents === clientLedgerTotalCents
        && negativeClientBalances.length === 0,
      clientBalances: clientBreakdown,
      negativeClientBalances,
      outstandingCount: outstanding.count,
      outstandingNetCents: outstanding.netCents,
      lastReconciliationDate,
      lastReconciliationIsReconciled: latestRec ? !!latestRec.isReconciled : null,
      bookCloseDate: account.bookCloseDate || null,
      ...reconciliationDueStatus(lastReconciliationDate, settings.reconcileCadence, firmToday),
    });
  }

  const totals = rows.reduce((acc: any, r: any) => ({
    bookBalanceCents: acc.bookBalanceCents + r.bookBalanceCents,
    clientLedgerTotalCents: acc.clientLedgerTotalCents + r.clientLedgerTotalCents,
    balanced: acc.balanced && r.balanced,
  }), { bookBalanceCents: 0, clientLedgerTotalCents: 0, balanced: true });

  return {
    generatedAt: new Date().toISOString(),
    reconcileCadence: settings.reconcileCadence,
    retentionYears: settings.retentionYears,
    retentionCutoffDate: settings.retentionCutoffDate,
    accounts: rows,
    totals,
  };
}

// ── Billing integration: create a withdrawal linked to an invoice ──

/**
 * Called by invoices.service.ts when a payment is recorded with
 * paymentSource === 'trust'. Creates a withdrawal linked to the invoice.
 *
 * `executor` is REQUIRED in practice, and is the whole reason this function
 * takes one. The caller (`recordPayment`) is inside a transaction holding
 * `select ... for update` on the invoice row, and the ledger row written here
 * carries `invoice_id`, whose foreign key needs a key-share lock on that same
 * row. Passing the caller's transaction down keeps both writes on one
 * connection; omitting it puts them on two, where they wait on each other until
 * the statement timeout cancels one. It also makes the invoice update and the
 * withdrawal commit or roll back together.
 *
 * @returns {{ transactionId: string }}
 */
export async function createTrustWithdrawalForInvoice({
  lawFirmId,
  trustAccountId,
  amountCents,
  clientId,
  clientName,
  matterId,
  invoiceId,
  date,
  actingUserId,
  executor,
}: any) {
  // No pre-check here: the overdraft guard lives inside createWithBalance under
  // a `for update` row lock on the account, which is the authoritative,
  // race-free check. A pre-check outside the lock could pass and then be
  // overdrawn by a concurrent withdrawal before this one commits. The locked
  // guard throws the identical AppError (400, INSUFFICIENT_TRUST_BALANCE).
  const result = await _createTransactionInternal({
    lawFirmId,
    actingUserId,
    executor,
    body: {
      trustAccountId,
      type: 'withdrawal',
      amountCents,
      clientId,
      clientName,
      matterId: matterId || null,
      date,
      description: 'Invoice payment',
      invoiceId,
    },
  });

  return { transactionId: result.transaction.id };
}

/**
 * Create a trust DEPOSIT funded by a Stripe payment. Called from the Stripe
 * webhook (no acting user, no membership assertion — the caller authenticates the
 * webhook signature). Idempotent on the Stripe checkout session id, so a replayed
 * webhook does not double-post (also backstopped by a unique DB index).
 *
 * @returns {{ transactionId: string, duplicate: boolean }}
 */
export async function createTrustDepositFromStripe({
  lawFirmId,
  trustAccountId,
  amountCents,
  clientId,
  clientName,
  matterId,
  date,
  stripeSessionId,
  stripePaymentIntentId,
  description,
}: any) {
  if (stripeSessionId) {
    const existing = await trustTxnRepo.findByStripeSession(lawFirmId, stripeSessionId);
    if (existing) return { transactionId: existing.id, duplicate: true };
  }
  // ACH deposits are posted from payment_intent.succeeded, which does not carry the
  // checkout session id, so dedupe on the payment intent as well (unique-indexed).
  if (stripePaymentIntentId) {
    const existing = await trustTxnRepo.findByStripePaymentIntentAnyFirm(stripePaymentIntentId);
    if (existing) return { transactionId: existing.id, duplicate: true };
  }
  const result = await _createTransactionInternal({
    lawFirmId,
    actingUserId: null,
    body: {
      trustAccountId,
      type: 'deposit',
      amountCents,
      clientId: clientId || null,
      clientName: clientName || null,
      matterId: matterId || null,
      date,
      description: description || 'Trust deposit via Stripe',
      source: 'stripe',
      stripeSessionId: stripeSessionId || null,
      stripePaymentIntentId: stripePaymentIntentId || null,
    },
    // Settled money is recorded even into an account deactivated, or a firm
    // whose trust accounting was switched off, after the deposit was requested.
    settledStripeFunds: true,
  });
  return { transactionId: result.transaction.id, duplicate: false };
}

/**
 * Void a transaction without membership assertion.
 * Used internally for compensating transactions (e.g., invoice update failure after trust withdrawal).
 */
export async function voidTransactionInternal({ lawFirmId, transactionId, reason, actingUserId, executor }: any) {
  const txn = await trustTxnRepo.findById(lawFirmId, transactionId, executor);
  if (!txn) throw new NotFoundError('TrustTransaction');
  if (txn.status === 'void') return; // already voided, no-op
  // `executor`, when a caller supplies one, makes the reversal part of that
  // caller's open transaction, so it commits or rolls back with the caller's own
  // writes (an invoice payment removal, which must not outlive a failed reversal).
  await trustTxnRepo.voidWithBalance({ lawFirmId, actingUserId, transactionId, voidReason: reason }, executor);
}

/**
 * Total cents already reversed against a Stripe deposit via partial reversing
 * withdrawals. Lets the webhook converge a multi-part refund to the cumulative
 * refunded amount without over-reversing. See createStripeReversalWithdrawal.
 */
export async function sumStripeReversals({ lawFirmId, depositId }: any) {
  return trustTxnRepo.sumStripeReversalsForDeposit(lawFirmId, depositId);
}

/**
 * Post a balance-affecting reversing WITHDRAWAL against a Stripe trust deposit for a
 * PARTIAL clawback (a partial refund, or the remainder after earlier partials),
 * linked to the original via reverses_transaction_id. Used instead of a full void
 * when only part of the deposit is clawed back, so the client's balance is reduced
 * by exactly the refunded amount. Reuses the overdraft-guarded create path, so a
 * clawback of already-disbursed funds is refused (400 INSUFFICIENT_TRUST_BALANCE)
 * and surfaced by the caller rather than silently driving the balance negative.
 */
export async function createStripeReversalWithdrawal({ lawFirmId, deposit, amountCents, date, reason }: any) {
  const result = await _createTransactionInternal({
    lawFirmId,
    actingUserId: null,
    body: {
      trustAccountId: deposit.trustAccountId,
      type: 'withdrawal',
      amountCents,
      clientId: deposit.clientId || null,
      matterId: deposit.matterId || null,
      date,
      description: reason || 'Partial trust deposit reversal (Stripe)',
      source: 'stripe',
      reversesTransactionId: deposit.id,
    },
  });
  return { transactionId: result.transaction.id };
}

/**
 * Un-reverse a PARTIAL Stripe clawback whose funds came back — a failed ACH refund
 * or a won dispute on a deposit that was only partially reversed (so the original
 * deposit is still `completed`, not voided). Restores up to `amountCents` of the
 * outstanding reversing withdrawals: voids them all (each void posts a
 * balance-restoring compensating entry and drops out of sumStripeReversalsForDeposit)
 * and, when only part is being restored, re-posts one reversing withdrawal for the
 * remainder — so the reversed total converges to (outstanding - restored) and the
 * client balance rises by exactly the restored amount. Returns the cents restored.
 */
export async function restoreStripeReversal({ lawFirmId, deposit, amountCents, date, reason }: any) {
  // The void-all + re-post-residual sequence runs inside ONE Postgres transaction
  // (restoreStripeReversalsAtomic), so a mid-sequence failure rolls back entirely
  // and a Stripe retry recomputes the outstanding total cleanly. The former
  // step-by-step version committed each void separately, so a failure after some
  // voids left the reversed total permanently skewed.
  return trustTxnRepo.restoreStripeReversalsAtomic({
    lawFirmId, deposit, restoreCents: Math.round(amountCents) || 0, date, reason, actingUserId: null,
  });
}

// ── Portal-safe versions (no membership assertion) ────────────────

/**
 * Returns the client's trust ledger (transaction history).
 * No membership assertion. The caller (portal routes) is responsible
 * for verifying the client owns this data.
 */
export async function getClientLedgerForPortal({ lawFirmId, clientId, limit, offset, order }: any) {
  assertUuid(clientId, 'Client');
  const page = { limit: limit ?? 100, offset: offset ?? 0, order: order ?? 'asc' };
  const [txns, totalItems] = await Promise.all([
    trustTxnRepo.findByClientId(lawFirmId, clientId, page),
    trustTxnRepo.countByClientId(lawFirmId, clientId),
  ]);
  return { transactions: txns.map(formatTransaction), totalItems };
}

/**
 * Returns the client's total trust balance across all accounts.
 * No membership assertion. The caller (portal routes) is responsible
 * for verifying the client owns this data.
 */
export async function getClientBalanceForPortal({ lawFirmId, clientId }: any) {
  assertUuid(clientId, 'Client');
  const accounts = await trustAccountRepo.findAll(lawFirmId);
  const balanceByAccount = await trustTxnRepo.computeClientBalancesByAccount(lawFirmId, clientId);
  const accountBalances = accounts.map((acct: any) => ({
    clientId,
    trustAccountId: acct.id,
    accountName: acct.name,
    balanceCents: balanceByAccount.get(acct.id) || 0,
  }));

  const totalBalanceCents = accountBalances.reduce((sum: any, b: any) => sum + b.balanceCents, 0);
  return { clientId, totalBalanceCents, accountBalances: accountBalances.filter((b: any) => b.balanceCents !== 0) };
}
