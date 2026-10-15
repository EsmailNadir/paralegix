const { randomUUID } = require('crypto');
import { DrizzleRepository } from '../../shared/database/DrizzleRepository';
import {
  trustAccounts,
  trustInterestRemittances,
  trustMinimumBalances,
  trustReconciliations,
} from '../../shared/database/drizzle/schema';

import { sqlRowToEntity } from '../../shared/database/rowShape';

// The custom reads below assemble their own SQL with `financialSql`, so their
// rows arrive keyed by column name and are shaped explicitly. Only the CRUD the
// base class provides moved onto Drizzle, which shapes its own.
const { isUuid } = require('../../shared/utils/isUuid');
const { financialRootSql, financialSql, withDrizzleTransaction } = require('../../shared/database/financialQuery');
const {
  clampLimit, buildPageClause, buildCeilingClause, applyCeiling, LIST_CEILING,
} = require('../../shared/database/pagination');
const { NotFoundError, AppError, ForbiddenError } = require('../../shared/errors/AppError');

/** Hold a shared firm lock so disabling waits for this ledger write to commit. */
async function assertTrustWriteEnabled(executor: any, lawFirmId: string) {
  const { rows } = await financialSql(executor,
    `select settings from law_firms where id = $1 for share`, [lawFirmId]);
  if (rows[0]?.settings?.features?.trustAccounting === false) {
    throw new ForbiddenError('Trust accounting is disabled for this firm.');
  }
}

const dateOnly = (v: any) => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (typeof v.toDate === 'function') return v.toDate().toISOString().slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
};

// Format an integer-cents amount as USD ("$250.00") for user-facing error copy.
// Balances are stored in cents internally; clients should never see raw cents.
const usd = (cents: any) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents) / 100);

// Period lock: a transaction dated on/before an account's book-close date falls
// in a closed accounting period and may not be posted or voided. `bookCloseDate`
// and `txnDate` are both raw 'YYYY-MM-DD' strings (ISO-comparable). Called inside
// the write transactions, after the account row is locked.
function assertPeriodOpen(bookCloseDate: any, txnDate: any) {
  if (bookCloseDate && txnDate && txnDate <= bookCloseDate) {
    throw new AppError(
      `This date falls in a closed period (book closed through ${bookCloseDate}).`,
      400, 'TRUST_PERIOD_LOCKED'
    );
  }
}

/**
 * A recorded reconciliation closes the period it certifies, whether or not the
 * firm also set an explicit `book_close_date`. A backdated entry posted after
 * the fact changes the book balance a signed reconciliation reports, and nothing
 * on the reconciliation record shows that it moved. Reopening the reconciliation
 * (which deletes it) is the sanctioned way to get the period back, exactly as it
 * already is for voiding an entry the reconciliation cleared.
 *
 * Scoped to one account: reconciling one bank account says nothing about another.
 * Called inside the write transactions, after the account row is locked.
 */
async function assertPeriodNotReconciled(client: any, lawFirmId: string, trustAccountId: string, txnDate: any) {
  if (!txnDate) return;
  const { rows } = await financialSql(client,
    `select max(reconciliation_date) d from trust_reconciliations
      where law_firm_id = $1 and trust_account_id = $2`,
    [lawFirmId, trustAccountId]
  );
  const latest = dateOnly(rows[0] && rows[0].d);
  if (latest && txnDate <= latest) {
    throw new AppError(
      `This date falls inside a period already reconciled through ${latest}. `
      + 'Reopen that reconciliation before posting into it.',
      400, 'TRUST_PERIOD_RECONCILED'
    );
  }
}

/**
 * Check numbers run per chequebook, so one number may appear at most once per
 * trust account. A duplicate is the classic trust bookkeeping error and
 * `reference_number` is otherwise free text with nothing watching it. Voided
 * entries release their number: a spoiled cheque should not force the firm to
 * skip one. Only `source = 'check'` is policed; bank wire references are
 * legitimately repeated. Called under the account row lock, so it is race-free.
 */
async function assertCheckNumberFree(client: any, lawFirmId: string, trustAccountId: string, source: any, referenceNumber: any) {
  if (source !== 'check' || !referenceNumber) return;
  const { rows } = await financialSql(client,
    `select 1 from trust_transactions
      where law_firm_id = $1 and trust_account_id = $2 and source = 'check'
        and reference_number = $3 and status = 'completed'
      limit 1`,
    [lawFirmId, trustAccountId, referenceNumber]
  );
  if (rows[0]) {
    throw new AppError(
      `Check number ${referenceNumber} is already recorded in this trust account.`,
      400, 'TRUST_DUPLICATE_CHECK_NUMBER'
    );
  }
}

// ── Trust Accounts ─────────────────────────────────────────────────
class TrustAccountRepository extends DrizzleRepository {
  constructor() {
    // The alias maps the entity name onto the Drizzle KEY now, not the column.
    super(trustAccounts as any, { aliases: { bookBalance: 'bookBalanceCents' } });
  }
  async findActive(lawFirmId: string) {
    return this.findWhere(lawFirmId, 'status', '==', 'active');
  }

  /**
   * Whether any ledger entry has ever been posted into this account, void rows
   * included. Used to freeze the columns that define what the account IS
   * (`account_type`, the bank digits, the interest beneficiary) once entries
   * exist that were posted on the strength of those values.
   *
   * Void rows count. A voided entry is still a permanent record of a posting
   * made into an account of a particular type, and it is exactly what an
   * examiner reads when asking why an entry was reversed.
   */
  async hasLedgerActivity(lawFirmId: string, accountId: any) {
    if (!isUuid(accountId)) return false;
    const { rows } = await financialRootSql(
      `select 1 from trust_transactions
        where law_firm_id = $1 and trust_account_id = $2 limit 1`,
      [lawFirmId, accountId]
    );
    return !!rows[0];
  }
}

// ── Trust Reconciliations ──────────────────────────────────────────
class TrustReconciliationRepository extends DrizzleRepository {
  constructor() {
    // `adjustments` is jsonb in the schema, so the `{ jsonb: [...] }` option the
    // old base class needed has nothing left to declare.
    super(trustReconciliations as any);
  }
  /**
   * findById override that resolves the reconciler's display name via a join on
   * `users` (PK is the Firebase UID stored in reconciled_by). `reconciled_by`
   * stays the raw UID; `reconciled_by_name` is the human-readable name used by
   * the reconciliation report. findByIdOrFail inherits this automatically.
   */
  async findById(lawFirmId: string, id: any) {
    if (!isUuid(id)) return null;
    const { rows } = await financialRootSql(
      `select r.*, u.name as reconciled_by_name
         from trust_reconciliations r left join users u on u.id = r.reconciled_by
        where r.law_firm_id = $1 and r.id = $2 limit 1`,
      [lawFirmId, id]
    );
    return rows[0] ? sqlRowToEntity(rows[0]) : null;
  }

  /**
   * Paginated reconciliation list. Optionally scoped to one account. Newest
   * first (reconciliation_date desc). Joins `users` to resolve the reconciler's
   * display name (reconciled_by is a raw Firebase UID).
   */
  async findPaged(lawFirmId: string, { trustAccountId, limit = 100, offset = 0 }: any = {}) {
    const params: unknown[] = [lawFirmId];
    let acc = '';
    if (trustAccountId) { params.push(trustAccountId); acc = ` and r.trust_account_id = $${params.length}`; }
    const { pageClause } = buildPageClause({ limit, offset, params, fallbackLimit: 100, max: 200 });
    const { rows } = await financialRootSql(
      `select r.*, u.name as reconciled_by_name
         from trust_reconciliations r left join users u on u.id = r.reconciled_by
        where r.law_firm_id = $1${acc}
        order by r.reconciliation_date desc, r.created_at desc, r.id desc${pageClause}`,
      params
    );
    return rows.map((r: any) => sqlRowToEntity(r));
  }

  /**
   * The latest statement date reconciled for one account, as a raw 'YYYY-MM-DD'
   * string, or null when the account has never been reconciled. Reconciliation
   * history is a forward sequence of bank statements, so this is the floor a new
   * reconciliation date has to clear.
   */
  async findLatestDateForAccount(lawFirmId: string, trustAccountId: string) {
    const { rows } = await financialRootSql(
      `select max(reconciliation_date) d from trust_reconciliations
        where law_firm_id = $1 and trust_account_id = $2`,
      [lawFirmId, trustAccountId]
    );
    return dateOnly(rows[0] && rows[0].d);
  }

  /** Total reconciliation count matching the same scope as findPaged. */
  async countAll(lawFirmId: string, { trustAccountId }: any = {}) {
    const params: unknown[] = [lawFirmId];
    let acc = '';
    if (trustAccountId) { params.push(trustAccountId); acc = ` and trust_account_id = $${params.length}`; }
    const { rows } = await financialRootSql(
      `select count(*)::bigint c from trust_reconciliations where law_firm_id = $1${acc}`,
      params
    );
    return Number(rows[0].c);
  }

  async findLatestByAccountId(lawFirmId: string, trustAccountId: string) {
    const { rows } = await financialRootSql(
      // Deterministic tiebreaker on same-date ties: match findPaged's
      // `reconciliation_date desc, created_at desc` and add `id desc` as a final
      // tiebreaker so the snapshot pre-fill / getLatestReconciliation is stable.
      `select r.*, u.name as reconciled_by_name
         from trust_reconciliations r left join users u on u.id = r.reconciled_by
        where r.law_firm_id = $1 and r.trust_account_id = $2
        order by r.reconciliation_date desc, r.created_at desc, r.id desc limit 1`,
      [lawFirmId, trustAccountId]
    );
    return rows[0] ? sqlRowToEntity(rows[0]) : null;
  }

  /**
   * Atomically insert a reconciliation AND mark this account's cleared
   * transactions, in one transaction. A completed entry dated on/before the
   * statement date that is NOT flagged outstanding (and not already cleared)
   * becomes cleared, stamped with this reconciliation's id. Returns the inserted
   * reconciliation entity.
   */
  async createWithClearing(lawFirmId: string, recData: any, { trustAccountId, reconciliationDate, outstandingIds, clearedAt }: any) {
    return withDrizzleTransaction(async (client: any) => {
      // Lock the account row for the whole insert-and-clear. Every ledger write
      // (createWithBalance/voidWithBalance) also takes this lock, so holding it here
      // serializes reconciliation against concurrent postings. Then re-read the book
      // balance under the lock and compare it to the snapshot the caller computed: a
      // posting that committed between the caller's read and this lock changes the
      // book balance, and clearing against a stale snapshot would stamp a
      // not-in-snapshot transaction as cleared (it could then never be flagged
      // outstanding or voided). On a mismatch, abort so the caller recomputes.
      const acc = await financialSql(client,
        `select book_balance_cents from trust_accounts where law_firm_id = $1 and id = $2 for update`,
        [lawFirmId, trustAccountId]
      );
      if (!acc.rows[0]) throw new NotFoundError('TrustAccount');
      if (Number(acc.rows[0].book_balance_cents) !== Number(recData.bookBalanceCents)) {
        throw new AppError(
          'The trust account changed while this reconciliation was being prepared. Please reload and try again.',
          409, 'RECONCILIATION_STALE'
        );
      }
      const ins = await financialSql(client,
        `insert into trust_reconciliations
           (law_firm_id, trust_account_id, reconciliation_date, bank_statement_balance_cents,
            book_balance_cents, client_ledger_total_cents, is_reconciled, discrepancy_cents,
            adjustments, outstanding_transaction_ids, notes, reconciled_by, reconciled_at, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::uuid[],$11,$12,$13,$14)
         returning *`,
        [
          lawFirmId, trustAccountId, reconciliationDate, recData.bankStatementBalanceCents,
          recData.bookBalanceCents, recData.clientLedgerTotalCents, recData.isReconciled, recData.discrepancyCents,
          JSON.stringify(recData.adjustments || []), outstandingIds || [], recData.notes || '',
          recData.reconciledBy, recData.reconciledAt, recData.createdBy,
        ]
      );
      const recId = ins.rows[0].id;
      // Clear completed, this-account, on/before-date, not-outstanding,
      // not-already-cleared rows. An empty outstanding array clears everything
      // eligible (`id = any('{}')` is false → `not(...)` is true).
      await financialSql(client,
        `update trust_transactions
            set cleared_at = $4, cleared_in_reconciliation_id = $5
          where law_firm_id = $1 and trust_account_id = $2
            and status = 'completed' and cleared_at is null
            and txn_date <= $3
            and not (id = any($6::uuid[]))`,
        [lawFirmId, trustAccountId, reconciliationDate, clearedAt, recId, outstandingIds || []]
      );
      return sqlRowToEntity(ins.rows[0]);
    });
  }

  /**
   * Reopen a reconciliation: un-clear every transaction it stamped and remove the
   * reconciliation record, in one transaction. This is the counterpart the void
   * path already points users to ("Reopen the reconciliation that cleared it
   * first") — without it, one erroneous reconciliation (e.g. a mistyped future
   * statement date that clears every entry) would permanently block voiding. Returns
   * the number of transactions un-cleared, or null if the reconciliation is absent.
   */
  async reopen(lawFirmId: string, reconciliationId: any) {
    if (!isUuid(reconciliationId)) return null;
    return withDrizzleTransaction(async (client: any) => {
      const rec = await financialSql(client,
        `select id from trust_reconciliations where law_firm_id = $1 and id = $2 for update`,
        [lawFirmId, reconciliationId]
      );
      // Returning commits an empty transaction, which releases the row lock just
      // as the previous explicit rollback did.
      if (!rec.rows[0]) return null;

      const cleared = await financialSql(client,
        `update trust_transactions set cleared_at = null, cleared_in_reconciliation_id = null
          where law_firm_id = $1 and cleared_in_reconciliation_id = $2`,
        [lawFirmId, reconciliationId]
      );
      await financialSql(client,
        `delete from trust_reconciliations where law_firm_id = $1 and id = $2`,
        [lawFirmId, reconciliationId]
      );
      return cleared.rowCount;
    });
  }
}

// ── Trust Transactions (append-only ledger) ────────────────────────
const TXN_SELECT = `select t.*, cl.name as client_name, ca.name as matter_name, ta.name as trust_account_name
  from trust_transactions t
  left join clients cl on cl.id = t.client_id
  left join matters   ca on ca.id = t.matter_id
  left join trust_accounts ta on ta.id = t.trust_account_id`;

function txnToEntity(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    trustAccountId: r.trust_account_id,
    trustAccountName: r.trust_account_name || null,
    type: r.type,
    amountCents: Number(r.amount_cents),
    clientId: r.client_id,
    clientName: r.client_name || null,
    matterId: r.matter_id,
    matterName: r.matter_name || null,
    date: r.txn_date || null,
    description: r.description || null,
    referenceNumber: r.reference_number || null,
    payee: r.payee || null,
    transferTo: r.transfer_to || null,
    transferToAccountId: r.transfer_to_account_id || null,
    transferGroupId: r.transfer_group_id || null,
    source: r.source || null,
    invoiceId: r.invoice_id || null,
    stripeSessionId: r.stripe_session_id || null,
    stripePaymentIntentId: r.stripe_payment_intent_id || null,
    reversesTransactionId: r.reverses_transaction_id || null,
    status: r.status,
    clientBalanceAfter: r.client_balance_after_cents == null ? null : Number(r.client_balance_after_cents),
    accountBalanceAfter: r.account_balance_after_cents == null ? null : Number(r.account_balance_after_cents),
    clearedAt: r.cleared_at ? r.cleared_at.toISOString() : null,
    clearedInReconciliationId: r.cleared_in_reconciliation_id || null,
    voidedBy: r.voided_by || null,
    voidedAt: r.voided_at ? r.voided_at.toISOString() : null,
    voidReason: r.void_reason || null,
    createdBy: r.created_by || null,
    createdAt: r.created_at ? r.created_at.toISOString() : null,
    updatedAt: r.updated_at ? r.updated_at.toISOString() : null,
  };
}

// Money direction: a `deposit` is the only inflow (credit). `withdrawal`,
// `transfer`, and `refund` are all outflows (debits). A trust refund pays
// money OUT of the trust back to the client, so it reduces the balance and is
// subject to the overdraft guard like any other withdrawal.
//
// Balances are authoritative SUMs over the non-void ledger: direction is encoded
// in `type`, not sign. A SUM is self-correcting. It cannot drift from history the
// way a stored running balance can, which is the right tradeoff for a
// correctness-critical, low-volume trust ledger. Pass a table alias to qualify the
// columns in a joined query (e.g. when joining `clients`).
const balanceExprFor = (alias = '') => {
  const p = alias ? `${alias}.` : '';
  // Only 'completed' rows contribute to a balance. A 'void' (reversed) row or any
  // future 'pending' (unsettled) row sums to 0 here, so an unsettled or reversed
  // entry can never inflate a withdrawable balance — even if a caller's WHERE clause
  // filters only `status <> 'void'`. This is the single authoritative definition of
  // "balance" for the whole ledger.
  return `coalesce(sum(case when ${p}status = 'completed' then (case when ${p}type = 'deposit' then ${p}amount_cents else -${p}amount_cents end) else 0 end), 0)::bigint`;
};
const balanceExpr = balanceExprFor();

class TrustTransactionRepository {
  /**
   * One ledger row, with its joined client / matter / account names.
   *
   * `executor` reads inside a caller's OPEN transaction instead of on a pooled
   * connection. A row written by that transaction is not visible anywhere else
   * until it commits, so a caller that just inserted one and wants it back has
   * to pass its own transaction or read nothing.
   */
  async findById(lawFirmId: string, id: any, executor?: any) {
    if (!isUuid(id)) return null;
    const text = `${TXN_SELECT} where t.law_firm_id = $1 and t.id = $2`;
    const { rows } = executor
      ? await financialSql(executor, text, [lawFirmId, id])
      : await financialRootSql(text, [lawFirmId, id]);
    return txnToEntity(rows[0]);
  }

  async findWithFilters(lawFirmId: string, filters: any = {}) {
    const where = ['t.law_firm_id = $1'];
    const params: unknown[] = [lawFirmId];
    const eq = (col: any, val: any) => { params.push(val); where.push(`t.${col} = $${params.length}`); };
    if (filters.trustAccountId) eq('trust_account_id', filters.trustAccountId);
    if (filters.clientId) eq('client_id', filters.clientId);
    if (filters.type) eq('type', filters.type);
    if (filters.status) eq('status', filters.status);
    if (filters.startDate) { params.push(filters.startDate); where.push(`t.txn_date >= $${params.length}`); }
    if (filters.endDate) { params.push(filters.endDate); where.push(`t.txn_date <= $${params.length}`); }
    const { pageClause } = buildPageClause({
      limit: filters.limit, offset: filters.offset, params, fallbackLimit: 100, max: 200,
    });
    const { rows } = await financialRootSql(
      `${TXN_SELECT} where ${where.join(' and ')} order by t.txn_date desc, t.created_at desc${pageClause}`,
      params
    );
    return rows.map(txnToEntity);
  }

  /** One client's trust ledger (all statuses), chronological unless `order` says otherwise. */
  async findByClientId(lawFirmId: string, clientId: string, { limit = 100, offset = 0, order = 'asc' }: any = {}) {
    const params: unknown[] = [lawFirmId, clientId];
    const { pageClause } = buildPageClause({ limit, offset, params, fallbackLimit: 100, max: 200 });
    const dir = order === 'desc' ? 'desc' : 'asc';
    const { rows } = await financialRootSql(
      `${TXN_SELECT} where t.law_firm_id = $1 and t.client_id = $2
        order by t.txn_date ${dir}, t.created_at ${dir}${pageClause}`,
      params
    );
    return rows.map(txnToEntity);
  }

  /** Total transaction count for one client (all statuses), for ledger paging. */
  async countByClientId(lawFirmId: string, clientId: string) {
    const { rows } = await financialRootSql(
      `select count(*)::bigint c from trust_transactions where law_firm_id = $1 and client_id = $2`,
      [lawFirmId, clientId]
    );
    return Number(rows[0].c);
  }

  /**
   * The firm's evergreen-retainer replenishment threshold for this client.
   * Separate from the ledger count above because it is not a ledger entry and
   * does not deserve that error message: a threshold is a setting the firm can
   * remove, where a transaction is permanent. Its foreign key to `clients` is
   * `restrict` as of migration 0225; before that it was `cascade`, so deleting
   * a client silently took the threshold with it.
   */
  async countMinimumBalancesByClientId(lawFirmId: string, clientId: string) {
    const { rows } = await financialRootSql(
      `select count(*)::bigint c from trust_minimum_balances where law_firm_id = $1 and client_id = $2`,
      [lawFirmId, clientId]
    );
    return Number(rows[0].c);
  }

  async findByInvoiceId(lawFirmId: string, invoiceId: string) {
    const { rows } = await financialRootSql(`${TXN_SELECT} where t.law_firm_id = $1 and t.invoice_id = $2`, [lawFirmId, invoiceId]);
    return rows.map(txnToEntity);
  }

  /**
   * How many permanent (completed or void) ledger entries reference one invoice.
   *
   * The invoice_id FK is ON DELETE SET NULL, and that SET NULL is an UPDATE the
   * append-only trigger refuses on a completed or void row. So deleting such an
   * invoice aborts the statement with a raw trigger error; callers use this to
   * refuse the delete with an explanation instead. Non-terminal rows are excluded
   * because the trigger permits editing them.
   */
  async countPermanentByInvoiceId(lawFirmId: string, invoiceId: string) {
    if (!isUuid(invoiceId)) return 0;
    const { rows } = await financialRootSql(
      `select count(*)::bigint c from trust_transactions
        where law_firm_id = $1 and invoice_id = $2 and status in ('completed', 'void')`,
      [lawFirmId, invoiceId]
    );
    return Number(rows[0].c);
  }

  /** Lookup by Stripe checkout session (idempotency for electronic deposits). */
  async findByStripeSession(lawFirmId: string, stripeSessionId: any) {
    if (!stripeSessionId) return null;
    const { rows } = await financialRootSql(
      `${TXN_SELECT} where t.law_firm_id = $1 and t.stripe_session_id = $2 limit 1`,
      [lawFirmId, stripeSessionId]
    );
    return txnToEntity(rows[0]);
  }

  /**
   * Lookup by Stripe payment intent, across all firms. ACH deposits are posted on
   * `payment_intent.succeeded` and reversed on `charge.refunded` /
   * `charge.dispute.created` — none of those Stripe events carry a law_firm_id, so
   * the trust transaction is resolved from the payment intent id alone. Returns the
   * non-void deposit for that intent (the reversing void entry shares no PI id).
   */
  async findByStripePaymentIntentAnyFirm(paymentIntentId: any) {
    if (!paymentIntentId) return null;
    const { rows } = await financialRootSql(
      `${TXN_SELECT} where t.stripe_payment_intent_id = $1 and t.status <> 'void'
        order by t.created_at asc limit 1`,
      [paymentIntentId]
    );
    if (!rows[0]) return null;
    // Attach law_firm_id (txnToEntity omits it) so a webhook caller with no firm
    // context can act on the row (e.g. post a reversing entry).
    return { ...txnToEntity(rows[0]), lawFirmId: rows[0].law_firm_id };
  }

  /**
   * The original deposit for a payment intent, INCLUDING voided ones, across all
   * firms. Used when a dispute is WON to re-post funds that were clawed back: the
   * caller needs the voided deposit's account/client/amount to re-credit. Returns
   * the earliest matching deposit (the original, not its reversing entry).
   */
  async findDepositByStripePaymentIntentIncludingVoid(paymentIntentId: any) {
    if (!paymentIntentId) return null;
    const { rows } = await financialRootSql(
      `${TXN_SELECT} where t.stripe_payment_intent_id = $1 and t.type = 'deposit'
        order by t.created_at asc limit 1`,
      [paymentIntentId]
    );
    if (!rows[0]) return null;
    return { ...txnToEntity(rows[0]), lawFirmId: rows[0].law_firm_id };
  }

  /** One matter's trust ledger (all statuses), chronological unless `order` says otherwise. */
  async findByMatterId(lawFirmId: string, matterId: string, { limit = 100, offset = 0, order = 'asc' }: any = {}) {
    const params: unknown[] = [lawFirmId, matterId];
    const { pageClause } = buildPageClause({ limit, offset, params, fallbackLimit: 100, max: 200 });
    const dir = order === 'desc' ? 'desc' : 'asc';
    const { rows } = await financialRootSql(
      `${TXN_SELECT} where t.law_firm_id = $1 and t.matter_id = $2
        order by t.txn_date ${dir}, t.created_at ${dir}${pageClause}`,
      params
    );
    return rows.map(txnToEntity);
  }

  /** Total transaction count for one matter (all statuses), for ledger paging. */
  async countByMatterId(lawFirmId: string, matterId: string) {
    const { rows } = await financialRootSql(
      `select count(*)::bigint c from trust_transactions where law_firm_id = $1 and matter_id = $2`,
      [lawFirmId, matterId]
    );
    return Number(rows[0].c);
  }

  /**
   * How many permanent (completed or void) ledger entries the firm holds.
   *
   * Deleting the firm cascades into trust_transactions, and the append-only
   * trigger refuses to delete a completed or void row — so the cascade aborts and
   * the whole firm delete fails with a raw trigger error. Callers check this first
   * to refuse the delete with an explanation instead.
   */
  async countPermanentByLawFirmId(lawFirmId: string) {
    if (!isUuid(lawFirmId)) return 0;
    const { rows } = await financialRootSql(
      `select count(*)::bigint c from trust_transactions
        where law_firm_id = $1 and status in ('completed', 'void')`,
      [lawFirmId]
    );
    return Number(rows[0].c);
  }

  /** Per-account trust balances for ONE matter (non-voided): Map account -> cents. */
  async computeMatterBalancesByAccount(lawFirmId: string, matterId: string) {
    const { rows } = await financialRootSql(
      `select trust_account_id, ${balanceExpr} balance
         from trust_transactions
        where law_firm_id = $1 and matter_id = $2 and status <> 'void'
        group by trust_account_id`,
      [lawFirmId, matterId]
    );
    const map = new Map();
    for (const r of rows) map.set(r.trust_account_id, Number(r.balance));
    return map;
  }

  /**
   * Current (account, client) balance: a SUM over that client's non-void ledger.
   * With no trustAccountId, sums across all accounts the client has touched.
   */
  async computeClientBalance(lawFirmId: string, clientId: string, trustAccountId: string) {
    if (trustAccountId) {
      const { rows } = await financialRootSql(
        `select ${balanceExpr} b from trust_transactions
          where law_firm_id = $1 and client_id = $2 and trust_account_id = $3 and status <> 'void'`,
        [lawFirmId, clientId, trustAccountId]
      );
      return Number(rows[0].b);
    }
    const map = await this.computeClientBalancesByAccount(lawFirmId, clientId);
    let total = 0;
    for (const v of map.values()) total += v;
    return total;
  }

  /**
   * Per-account balances for ONE client (non-voided): a single GROUP BY SUM over
   * the client's ledger. Returns a Map of trustAccountId -> balanceCents; accounts
   * with no transactions for this client are simply absent (treated as 0).
   */
  async computeClientBalancesByAccount(lawFirmId: string, clientId: string) {
    const { rows } = await financialRootSql(
      `select trust_account_id, ${balanceExpr} balance
         from trust_transactions
        where law_firm_id = $1 and client_id = $2 and status <> 'void'
        group by trust_account_id`,
      [lawFirmId, clientId]
    );
    const map = new Map();
    for (const r of rows) map.set(r.trust_account_id, Number(r.balance));
    return map;
  }

  /**
   * Validate AND sum the flagged outstanding ids in ONE round-trip. Returns
   * `{ validIds: Set, netCents }` where `validIds` is the subset of `ids` that
   * exist, belong to this account+firm, aren't voided, and have not ALREADY
   * cleared the bank; `netCents` is the net delta (deposit = inflow, everything
   * else = outflow, same convention as balanceExpr) over exactly those valid
   * rows. Folds the former findValidOutstandingIds + sumOutstandingNet pair so
   * the service does a single query that both validates membership and sums.
   *
   * `cleared_at is null` is load-bearing, not tidiness. An entry a previous
   * reconciliation already cleared is money the bank has confirmed. Accepting it
   * as outstanding again subtracts its delta from the expected bank balance a
   * second time, and `createWithClearing` then skips it (it only stamps rows with
   * a null `cleared_at`), so the wrong `discrepancy_cents` is recorded with
   * nothing in the record to show where it came from.
   */
  async validateAndSumOutstanding(lawFirmId: string, trustAccountId: string, ids: any) {
    if (!ids || ids.length === 0) return { validIds: new Set(), netCents: 0 };
    const { rows } = await financialRootSql(
      `select coalesce(array_agg(id), '{}') ids, ${balanceExpr} net
         from trust_transactions
        where law_firm_id = $1 and trust_account_id = $2 and status <> 'void'
          and cleared_at is null and id = any($3::uuid[])`,
      [lawFirmId, trustAccountId, ids]
    );
    return { validIds: new Set(rows[0].ids), netCents: Number(rows[0].net) };
  }

  /** Count of non-voided-aware transactions matching the same filters as findWithFilters. */
  async countWithFilters(lawFirmId: string, filters: any = {}) {
    const where = ['t.law_firm_id = $1'];
    const params: unknown[] = [lawFirmId];
    const eq = (col: any, val: any) => { params.push(val); where.push(`t.${col} = $${params.length}`); };
    if (filters.trustAccountId) eq('trust_account_id', filters.trustAccountId);
    if (filters.clientId) eq('client_id', filters.clientId);
    if (filters.type) eq('type', filters.type);
    if (filters.status) eq('status', filters.status);
    if (filters.startDate) { params.push(filters.startDate); where.push(`t.txn_date >= $${params.length}`); }
    if (filters.endDate) { params.push(filters.endDate); where.push(`t.txn_date <= $${params.length}`); }
    const { rows } = await financialRootSql(
      `select count(*)::bigint c from trust_transactions t where ${where.join(' and ')}`,
      params
    );
    return Number(rows[0].c);
  }

  /**
   * Account book balance derived from the ledger: a SUM over the account's
   * non-void rows. Returns 0 when the account has no non-void transactions.
   * NOTE: this is the LEDGER-derived total, deliberately distinct from the
   * stored `trust_accounts.book_balance_cents`, which reconciliation compares
   * against this to catch drift.
   */
  async computeAccountBalance(lawFirmId: string, trustAccountId: string) {
    const { rows } = await financialRootSql(
      `select ${balanceExpr} b from trust_transactions
        where law_firm_id = $1 and trust_account_id = $2 and status <> 'void'`,
      [lawFirmId, trustAccountId]
    );
    return Number(rows[0].b);
  }

  /**
   * Per (client, account) balances across the firm (non-voided): one GROUP BY
   * SUM over the whole ledger.
   */
  async computeAllBalances(lawFirmId: string) {
    const { rows } = await financialRootSql(
      `select t.client_id, t.trust_account_id, cl.name as client_name,
              ${balanceExprFor('t')} balance
         from trust_transactions t left join clients cl on cl.id = t.client_id
        where t.law_firm_id = $1 and t.status <> 'void'
        group by t.client_id, t.trust_account_id, cl.name`,
      [lawFirmId]
    );
    return rows.map((r: any) => ({
      clientId: r.client_id, clientName: r.client_name || r.client_id,
      trustAccountId: r.trust_account_id, balanceCents: Number(r.balance),
    }));
  }

  /**
   * Whether this firm still holds client money, across every trust account.
   *
   * Grouped per (client, account) the same way `computeAllBalances` groups, then
   * filtered to the ledgers that are not flat. A firm can hold money for one
   * client and carry a negative ledger for another, so a plain `sum` over the
   * whole firm can read zero while client funds are still on deposit. Counting
   * the non-flat ledgers separately from the positive total is what makes
   * "this firm holds nothing" a safe answer to act on.
   *
   * `heldCents` is the sum of the POSITIVE ledgers only, which is the money
   * actually on deposit and the figure a bar-rules reader expects.
   */
  async summarizeFirmHoldings(lawFirmId: string, executor?: any) {
    const query = `select
         count(*) filter (where b.balance <> 0)::bigint as nonzero_ledgers,
         coalesce(sum(b.balance) filter (where b.balance > 0), 0)::bigint as held_cents
       from (
         select ${balanceExprFor('t')} balance
           from trust_transactions t
          where t.law_firm_id = $1 and t.status <> 'void'
          group by t.client_id, t.trust_account_id
       ) b`;
    const { rows } = executor
      ? await financialSql(executor, query, [lawFirmId])
      : await financialRootSql(query, [lawFirmId]);
    return {
      nonzeroLedgers: Number(rows[0]?.nonzero_ledgers || 0),
      heldCents: Number(rows[0]?.held_cents || 0),
    };
  }

  /**
   * The entries in one account that have not yet cleared the bank: how many, and
   * their net effect on the balance (deposit = inflow, everything else = outflow,
   * the same convention as balanceExpr).
   *
   * "Outstanding" is completed and never stamped by a reconciliation, which is
   * the reconciling difference between the book balance and a bank statement.
   * This is the figure an examiner asks the firm to explain.
   */
  async summariseOutstanding(lawFirmId: string, trustAccountId: string) {
    const { rows } = await financialRootSql(
      `select count(*)::bigint c, ${balanceExpr} net from trust_transactions
        where law_firm_id = $1 and trust_account_id = $2
          and status = 'completed' and cleared_at is null`,
      [lawFirmId, trustAccountId]
    );
    return { count: Number(rows[0].c), netCents: Number(rows[0].net) };
  }

  /** Count of non-voided transactions in one account. */
  async countNonVoidByAccount(lawFirmId: string, trustAccountId: string) {
    const { rows } = await financialRootSql(
      `select count(*)::bigint c from trust_transactions
        where law_firm_id = $1 and trust_account_id = $2 and status <> 'void'`,
      [lawFirmId, trustAccountId]
    );
    return Number(rows[0].c);
  }

  /**
   * Per-client balance breakdown within one account (non-voided): a GROUP BY SUM
   * over the account's ledger, one row per client.
   */
  async computeAccountClientBreakdown(lawFirmId: string, trustAccountId: string) {
    const { rows } = await financialRootSql(
      `select t.client_id, cl.name as client_name, ${balanceExprFor('t')} balance
         from trust_transactions t left join clients cl on cl.id = t.client_id
        where t.law_firm_id = $1 and t.trust_account_id = $2 and t.status <> 'void'
        group by t.client_id, cl.name`,
      [lawFirmId, trustAccountId]
    );
    return rows.map((r: any) => ({
      clientId: r.client_id, clientName: r.client_name || r.client_id, balanceCents: Number(r.balance),
    }));
  }

  /** Atomically create a transaction + update the account book balance (overdraft-safe). */
  /**
   * Atomic create + book-balance update + overdraft guard.
   *
   * `executor` makes this JOIN a transaction the caller already has open, as a
   * savepoint, rather than opening its own on a second connection. The billing
   * bridge needs that: `recordPayment` holds `select ... for update` on the
   * invoice row, and the ledger row this writes carries `invoice_id`, whose
   * foreign key needs a key-share lock on that same row. On a separate
   * connection the two wait on each other until the statement timeout. Sharing
   * one transaction also makes the pair all-or-nothing, so a failed invoice
   * write can no longer leave a withdrawal behind.
   */
  async createWithBalance({ lawFirmId, actingUserId, body, settledStripeFunds = false }: any, executor?: any) {
    const core = await withDrizzleTransaction(
      (client: any) => this._createWithBalanceTx(client, { lawFirmId, actingUserId, body, settledStripeFunds }),
      executor,
    );
    // The re-read joins client/matter/account names the write path does not
    // have. It must run on the SAME transaction when there is one: the row is
    // not committed yet, so a pooled connection would not see it and this would
    // answer null. Without an executor the row is durable by now, and a pooled
    // read is the cheaper choice.
    const transaction = await this.findById(lawFirmId, core.transactionId, executor);
    return {
      transaction,
      clientBalanceBefore: core.clientBalanceBefore,
      clientBalanceAfter: core.clientBalanceAfter,
      isCredit: core.isCredit,
    };
  }

  /**
   * Transaction-body core of createWithBalance. Assumes `client` is already inside
   * an open transaction; performs the account lock, overdraft guards, and inserts,
   * but does NOT begin/commit/release. Extracted so multi-step flows (e.g. the
   * atomic Stripe-reversal restore) can run several ledger writes under ONE
   * transaction. Returns the new row id and the computed client balances.
   */
  async _createWithBalanceTx(client: any, { lawFirmId, actingUserId, body, settledStripeFunds = false }: any) {
    const { trustAccountId, type, amountCents, clientId, matterId, date,
      description, referenceNumber, payee, transferTo, source, invoiceId,
      stripeSessionId, stripePaymentIntentId, reversesTransactionId,
      enforceMatterBalance } = body;
    // Only a deposit is an inflow. withdrawal/transfer/refund are all outflows
    // (debits) and must pass the overdraft guard below.
    const isCredit = type === 'deposit';
    const delta = isCredit ? amountCents : -amountCents;

    const txnDateStr = dateOnly(date);
    const accRows = await financialSql(client,
      `select book_balance_cents, book_close_date, status from trust_accounts where law_firm_id = $1 and id = $2 for update`,
      [lawFirmId, trustAccountId]
    );
    if (!accRows.rows[0]) throw new NotFoundError('TrustAccount');
    // A Stripe deposit that has SETTLED is a record of money already sitting in
    // the IOLTA, not a request to move any. The firm can deactivate the account
    // or switch trust accounting off while the ACH is still in flight (days), and
    // refusing then would leave client money in trust with no ledger entry. Both
    // closures therefore stop new activity everywhere except this one path, which
    // only `createTrustDepositFromStripe` takes. It is an argument rather than a
    // body field so no request body can reach it. The period and overdraft guards
    // below still apply to it.
    const settledFunds = settledStripeFunds === true && isCredit && Boolean(stripePaymentIntentId);
    if (!settledFunds) await assertTrustWriteEnabled(client, lawFirmId);
    // A deactivated trust account is closed to new activity. Blocking here (under
    // the account lock, on every write path) closes the gap where the Stripe path
    // checked account status but the direct create paths did not.
    if (!settledFunds && accRows.rows[0].status && accRows.rows[0].status !== 'active') {
      throw new AppError('This trust account is not active and cannot accept new transactions.', 400, 'TRUST_ACCOUNT_INACTIVE');
    }
    assertPeriodOpen(accRows.rows[0].book_close_date, txnDateStr);
    await assertPeriodNotReconciled(client, lawFirmId, trustAccountId, txnDateStr);
    await assertCheckNumberFree(client, lawFirmId, trustAccountId, source, referenceNumber);

    // Client balance BEFORE this row = a SUM over the (account, client) non-void
    // ledger. Safe under the account `for update` lock: that lock serializes
    // every write to this account, so no concurrent writer can append a new
    // (account, client) row between this read and our insert below.
    const beforeRows = await financialSql(client,
      `select ${balanceExpr} b from trust_transactions
        where law_firm_id = $1 and trust_account_id = $2 and client_id = $3 and status <> 'void'`,
      [lawFirmId, trustAccountId, clientId]
    );
    const clientBalanceBefore = Number(beforeRows.rows[0].b);
    const clientBalanceAfter = clientBalanceBefore + delta;
    if (!isCredit && clientBalanceAfter < 0) {
      throw new AppError(
        `Insufficient trust balance. Available: ${usd(clientBalanceBefore)}, required: ${usd(amountCents)}.`,
        400, 'INSUFFICIENT_TRUST_BALANCE'
      );
    }
    // Matter-level guard, only when the firm has asked for it
    // (`enforceMatterTrustBalance`). The per-client check above cannot see this:
    // a client with two matters can hold plenty of money overall while the matter
    // being spent against holds none, which for a firm that takes retainers per
    // matter is the same error as spending another client's funds. Same account
    // `for update` lock, so it is race-free on the same terms.
    if (!isCredit && enforceMatterBalance && matterId) {
      const matterRows = await financialSql(client,
        `select ${balanceExpr} b from trust_transactions
          where law_firm_id = $1 and trust_account_id = $2 and matter_id = $3 and status <> 'void'`,
        [lawFirmId, trustAccountId, matterId]
      );
      const matterBalanceBefore = Number(matterRows.rows[0].b);
      if (matterBalanceBefore + delta < 0) {
        throw new AppError(
          `Insufficient trust balance on this matter. Available: ${usd(matterBalanceBefore)}, `
          + `required: ${usd(amountCents)}.`,
          400, 'INSUFFICIENT_MATTER_TRUST_BALANCE'
        );
      }
    }

    const newBookBalance = Number(accRows.rows[0].book_balance_cents) + delta;
    // Account-level overdraft guard (mirrors the per-client check above). The
    // account book balance must never go negative on a debit. This is enforced
    // under the same `for update` row lock on the account, so it is race-free
    // against concurrent withdrawals, and is backstopped by the
    // trust_accounts_book_balance_nonneg DB CHECK (migration 0080).
    if (!isCredit && newBookBalance < 0) {
      throw new AppError(
        `Insufficient trust account balance. Available: ${usd(accRows.rows[0].book_balance_cents)}, required: ${usd(amountCents)}.`,
        400, 'INSUFFICIENT_TRUST_BALANCE'
      );
    }

    const ins = await financialSql(client,
      `insert into trust_transactions
         (law_firm_id, trust_account_id, type, amount_cents, client_id, matter_id, txn_date, description,
          reference_number, payee, transfer_to, source, invoice_id, stripe_session_id, stripe_payment_intent_id, status,
          client_balance_after_cents, account_balance_after_cents, created_by, reverses_transaction_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'completed',$16,$17,$18,$19) returning id`,
      [lawFirmId, trustAccountId, type, amountCents, clientId, matterId || null, txnDateStr,
       description || null, referenceNumber || null, payee || null, transferTo || null, source || null,
       invoiceId || null, stripeSessionId || null, stripePaymentIntentId || null, clientBalanceAfter, newBookBalance,
       actingUserId, reversesTransactionId || null]
    );
    await financialSql(client,
      `update trust_accounts set book_balance_cents = $3 where law_firm_id = $1 and id = $2`,
      [lawFirmId, trustAccountId, newBookBalance]
    );

    return { transactionId: ins.rows[0].id, clientBalanceBefore, clientBalanceAfter, isCredit };
  }

  /**
   * Total cents already reversed against a deposit via balance-affecting partial
   * reversing entries (completed rows whose reverses_transaction_id points at it).
   * A full void is represented by a `void` lineage row, which is excluded here — so
   * this returns only the partial-reversal withdrawals used to converge a Stripe
   * refund. Used to compute the remaining delta so multiple partial refunds (and
   * webhook replays) never over-reverse.
   */
  async sumStripeReversalsForDeposit(lawFirmId: string, depositId: any) {
    if (!isUuid(depositId)) return 0;
    const { rows } = await financialRootSql(
      `select coalesce(sum(amount_cents), 0)::bigint s
         from trust_transactions
        where law_firm_id = $1 and reverses_transaction_id = $2 and status = 'completed'`,
      [lawFirmId, depositId]
    );
    return Number(rows[0].s);
  }

  /**
   * The still-outstanding (completed) reversing withdrawals posted against a deposit
   * for partial Stripe clawbacks, newest first. Voiding these is how a returned
   * partial refund / won dispute is un-reversed: a void drops the row out of
   * sumStripeReversalsForDeposit and posts a balance-restoring compensating entry.
   */
  async findStripeReversalWithdrawals(lawFirmId: string, depositId: any) {
    if (!isUuid(depositId)) return [];
    const { rows } = await financialRootSql(
      `select id, amount_cents from trust_transactions
        where law_firm_id = $1 and reverses_transaction_id = $2
          and type = 'withdrawal' and status = 'completed'
        order by created_at desc`,
      [lawFirmId, depositId]
    );
    return rows.map((r: any) => ({ id: r.id, amountCents: Number(r.amount_cents) }));
  }

  /**
   * Atomically post a double-entry trust→trust transfer: a `transfer` (outflow)
   * leg on the source account and a `deposit` (inflow) leg on the destination,
   * for the same client, linked by a shared transfer_group_id. Both account rows
   * are locked in deterministic id order to avoid deadlocks; the source side runs
   * the same per-client + account overdraft guards as a withdrawal. Returns the
   * SOURCE leg as the primary transaction.
   */
  async createTransferWithBalance({ lawFirmId, actingUserId, body }: any) {
    const { trustAccountId, transferToAccountId, amountCents, clientId, matterId, date,
      description, referenceNumber, payee, source, enforceMatterBalance } = body;
    if (trustAccountId === transferToAccountId) {
      throw new AppError('Cannot transfer to the same trust account.', 400, 'INVALID_TRANSFER');
    }
    const transferGroupId = randomUUID();
    const { srcTxnId, clientBalanceBefore, clientBalanceAfterSource } = await withDrizzleTransaction(async (client: any) => {
      // Lock BOTH accounts, ordered by id, so a concurrent reverse-direction
      // transfer can't deadlock against this one.
      const orderedIds = [trustAccountId, transferToAccountId].sort();
      const accRes = await financialSql(client,
        `select id, book_balance_cents, book_close_date, status from trust_accounts
          where law_firm_id = $1 and id = any($2::uuid[]) order by id for update`,
        [lawFirmId, orderedIds]
      );
      if (accRes.rows.length !== 2) throw new NotFoundError('TrustAccount');
      // Both legs must be active. A deactivated account is closed to new activity;
      // without this the destination (deposit) leg could post funds into a closed
      // account, violating the closed-account invariant (the direct create path
      // already guards this).
      for (const r of accRes.rows) {
        if (r.status && r.status !== 'active') {
          throw new AppError('This trust account is not active and cannot accept new transactions.', 400, 'TRUST_ACCOUNT_INACTIVE');
        }
      }
      const bookById = new Map(accRes.rows.map((r: any) => [r.id, Number(r.book_balance_cents)]));
      // Both legs post on `date`; neither account's period may be closed for it.
      const transferDateStr = dateOnly(date);
      for (const r of accRes.rows) assertPeriodOpen(r.book_close_date, transferDateStr);
      // Both legs post on `date`, so neither account may already be reconciled
      // through it. The source leg also consumes a cheque number if it names one;
      // the destination leg is a bookkeeping mirror and never does.
      for (const r of accRes.rows) {
        await assertPeriodNotReconciled(client, lawFirmId, r.id, transferDateStr);
      }
      await assertCheckNumberFree(client, lawFirmId, trustAccountId, source, referenceNumber);

      // Source overdraft guards (per-client + account), identical to a withdrawal.
      const srcBeforeRows = await financialSql(client,
        `select ${balanceExpr} b from trust_transactions
          where law_firm_id = $1 and trust_account_id = $2 and client_id = $3 and status <> 'void'`,
        [lawFirmId, trustAccountId, clientId]
      );
      const clientBalanceBefore = Number(srcBeforeRows.rows[0].b);
      const clientBalanceAfterSource = clientBalanceBefore - amountCents;
      if (clientBalanceAfterSource < 0) {
        throw new AppError(
          `Insufficient trust balance. Available: ${usd(clientBalanceBefore)}, required: ${usd(amountCents)}.`,
          400, 'INSUFFICIENT_TRUST_BALANCE'
        );
      }
      const srcBookAfter = Number(bookById.get(trustAccountId)) - amountCents;
      if (srcBookAfter < 0) {
        throw new AppError(
          `Insufficient trust account balance. Available: ${usd(bookById.get(trustAccountId))}, required: ${usd(amountCents)}.`,
          400, 'INSUFFICIENT_TRUST_BALANCE'
        );
      }
      // Matter-level guard on the source leg, on the same terms as a withdrawal.
      // The destination leg credits the same matter, so the client's matter
      // balance across accounts is unchanged; it is the SOURCE account's matter
      // balance that this transfer can overdraw.
      if (enforceMatterBalance && matterId) {
        const matterRows = await financialSql(client,
          `select ${balanceExpr} b from trust_transactions
            where law_firm_id = $1 and trust_account_id = $2 and matter_id = $3 and status <> 'void'`,
          [lawFirmId, trustAccountId, matterId]
        );
        const matterBalanceBefore = Number(matterRows.rows[0].b);
        if (matterBalanceBefore - amountCents < 0) {
          throw new AppError(
            `Insufficient trust balance on this matter. Available: ${usd(matterBalanceBefore)}, `
            + `required: ${usd(amountCents)}.`,
            400, 'INSUFFICIENT_MATTER_TRUST_BALANCE'
          );
        }
      }

      const dstBookAfter = bookById.get(transferToAccountId) + amountCents;

      // Destination per-client running balance, for the deposit leg's snapshot.
      const dstBeforeRows = await financialSql(client,
        `select ${balanceExpr} b from trust_transactions
          where law_firm_id = $1 and trust_account_id = $2 and client_id = $3 and status <> 'void'`,
        [lawFirmId, transferToAccountId, clientId]
      );
      const dstClientAfter = Number(dstBeforeRows.rows[0].b) + amountCents;

      // Source (outflow) leg.
      const srcIns = await financialSql(client,
        `insert into trust_transactions
           (law_firm_id, trust_account_id, type, amount_cents, client_id, matter_id, txn_date, description,
            reference_number, payee, transfer_to, transfer_to_account_id, transfer_group_id, source, status,
            client_balance_after_cents, account_balance_after_cents, created_by)
         values ($1,$2,'transfer',$3,$4,$5,$6,$7,$8,$9,null,$10,$11,$12,'completed',$13,$14,$15) returning id`,
        [lawFirmId, trustAccountId, amountCents, clientId, matterId || null, dateOnly(date),
         description || null, referenceNumber || null, payee || null, transferToAccountId, transferGroupId,
         source || null, clientBalanceAfterSource, srcBookAfter, actingUserId]
      );
      // Destination (inflow) leg.
      await financialSql(client,
        `insert into trust_transactions
           (law_firm_id, trust_account_id, type, amount_cents, client_id, matter_id, txn_date, description,
            reference_number, payee, transfer_group_id, source, status,
            client_balance_after_cents, account_balance_after_cents, created_by)
         values ($1,$2,'deposit',$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed',$12,$13,$14)`,
        [lawFirmId, transferToAccountId, amountCents, clientId, matterId || null, dateOnly(date),
         `Transfer from trust account${description ? `: ${description}` : ''}`,
         referenceNumber || null, payee || null, transferGroupId, source || null,
         dstClientAfter, dstBookAfter, actingUserId]
      );

      await financialSql(client,
        `update trust_accounts set book_balance_cents = $3 where law_firm_id = $1 and id = $2`,
        [lawFirmId, trustAccountId, srcBookAfter]
      );
      await financialSql(client,
        `update trust_accounts set book_balance_cents = $3 where law_firm_id = $1 and id = $2`,
        [lawFirmId, transferToAccountId, dstBookAfter]
      );
      return { srcTxnId: srcIns.rows[0].id, clientBalanceBefore, clientBalanceAfterSource };
    });

    // Read back after the commit, on a pooled connection, so the transfer's two
    // account locks are released before this join runs.
    const transaction = await this.findById(lawFirmId, srcTxnId);
    return { transaction, clientBalanceBefore, clientBalanceAfter: clientBalanceAfterSource, isCredit: false };
  }

  /**
   * Atomically void a transaction, reversing the account book balance. A
   * double-entry transfer is voided as a unit: voiding either leg voids every
   * non-void leg sharing its transfer_group_id, reversing each leg's account.
   */
  async voidWithBalance({ lawFirmId, actingUserId, transactionId, voidReason }: any, executor?: any) {
    await withDrizzleTransaction((client: any) =>
      this._voidWithBalanceTx(client, { lawFirmId, actingUserId, transactionId, voidReason }), executor);
    // Read back after the commit, as before, so the reversal is durable and the
    // account lock is released before the name-joining select runs. With an
    // `executor` there is no commit yet: the read joins the caller's transaction,
    // which is the only place the reversal is visible.
    return this.findById(lawFirmId, transactionId, executor);
  }

  /**
   * Transaction-body core of voidWithBalance. Assumes `client` is already inside an
   * open transaction; does NOT begin/commit/release. Extracted so a multi-step flow
   * (the atomic Stripe-reversal restore) can void several entries and re-post a
   * residual under ONE transaction, making the whole restore all-or-nothing.
   */
  async _voidWithBalanceTx(client: any, { lawFirmId, actingUserId, transactionId, voidReason }: any) {
    {
      // Peek (unlocked) to discover whether the target belongs to a transfer
      // group, so the actual row locks below are taken in a deterministic order.
      // Locking the target row first and then its siblings could deadlock two
      // concurrent voids of sibling legs (each holding the other's target).
      const peek = await financialSql(client,
        `select transfer_group_id, status from trust_transactions where law_firm_id = $1 and id = $2`,
        [lawFirmId, transactionId]
      );
      const peekRow = peek.rows[0];
      if (!peekRow) throw new NotFoundError('TrustTransaction');
      if (peekRow.status === 'void') throw new AppError('Transaction is already voided.', 400, 'ALREADY_VOIDED');

      // A double-entry transfer is voided as a unit: lock every non-void leg
      // sharing the transfer_group_id in id order. A plain entry is its own group.
      let legs;
      if (peekRow.transfer_group_id) {
        const grp = await financialSql(client,
          `select * from trust_transactions
            where law_firm_id = $1 and transfer_group_id = $2 and status <> 'void'
            order by id for update`,
          [lawFirmId, peekRow.transfer_group_id]
        );
        legs = grp.rows;
      } else {
        // Filter on status <> 'void' inside the FOR UPDATE (mirrors the transfer
        // group above). Under READ COMMITTED, if a concurrent void of this same row
        // committed while we blocked on the lock, Postgres re-checks the predicate
        // against the updated row: it now fails, so `legs` is empty and the
        // re-validation below throws ALREADY_VOIDED. Without the filter, two
        // concurrent reversals (e.g. charge.refunded + charge.dispute.created for
        // one payment intent) would each void the row and double-decrement the
        // account book balance.
        const one = await financialSql(client,
          `select * from trust_transactions where law_firm_id = $1 and id = $2 and status <> 'void' for update`,
          [lawFirmId, transactionId]
        );
        legs = one.rows;
      }
      // Re-validate after locking: the target must still be present and non-void
      // (a concurrent void of a sibling leg may have already voided the group).
      if (!legs.some((l: any) => l.id === transactionId)) {
        throw new AppError('Transaction is already voided.', 400, 'ALREADY_VOIDED');
      }

      // Lock all affected account rows in deterministic id order (deadlock-safe).
      const acctIds = [...new Set(legs.map((l: any) => l.trust_account_id))].sort();
      const accRes = await financialSql(client,
        `select id, book_balance_cents, book_close_date from trust_accounts
          where law_firm_id = $1 and id = any($2::uuid[]) order by id for update`,
        [lawFirmId, acctIds]
      );
      if (accRes.rows.length !== acctIds.length) throw new NotFoundError('TrustAccount');
      await assertTrustWriteEnabled(client, lawFirmId);
      const bookById = new Map(accRes.rows.map((r: any) => [r.id, Number(r.book_balance_cents)]));
      const closeById = new Map(accRes.rows.map((r: any) => [r.id, r.book_close_date]));

      // Reconciliation guard: a leg that has cleared the bank (cleared_at set, i.e.
      // included in a completed three-way reconciliation) must not be voided, or it
      // would silently corrupt a signed-off reconciliation. Reject the whole
      // transfer group atomically here, before any balance is mutated below.
      for (const leg of legs) {
        if (leg.cleared_at != null) {
          throw new AppError(
            'This transaction has been reconciled and cleared the bank, so it cannot be voided. Reopen the reconciliation that cleared it first.',
            409, 'TRANSACTION_RECONCILED'
          );
        }
      }

      // Outstanding-reversal guard: a deposit that has completed partial-reversal
      // withdrawals pointing at it (a Stripe partial clawback) must not be plainly
      // voided. Voiding the deposit reverses the FULL amount while the partial
      // reversal withdrawals still stand, double-counting the clawed-back portion
      // (and a later won-dispute restore would re-post the full deposit on top).
      // Refuse it: the reversals have to be resolved first (they converge via the
      // Stripe reversal/restore path, not a manual void of the parent deposit).
      for (const leg of legs) {
        if (leg.type !== 'deposit') continue;
        const revRows = await financialSql(client,
          `select coalesce(sum(amount_cents), 0)::bigint s from trust_transactions
            where law_firm_id = $1 and reverses_transaction_id = $2 and status = 'completed'`,
          [lawFirmId, leg.id]
        );
        if (Number(revRows.rows[0].s) > 0) {
          throw new AppError(
            'This deposit has outstanding partial reversals and cannot be voided directly. Resolve the reversals first.',
            409, 'DEPOSIT_HAS_OUTSTANDING_REVERSALS'
          );
        }
      }

      for (const leg of legs) {
        // Voiding alters balances as of the original entry's date, so it is
        // blocked once that period is closed.
        assertPeriodOpen(closeById.get(leg.trust_account_id), dateOnly(leg.txn_date));
        const isCredit = leg.type === 'deposit';
        const reverseDelta = isCredit ? -Number(leg.amount_cents) : Number(leg.amount_cents);
        const newBookBalance = Number(bookById.get(leg.trust_account_id)) + reverseDelta;
        bookById.set(leg.trust_account_id, newBookBalance);

        // Post-reversal (account, client) balance is a fresh ledger SUM.
        //
        // Computed BEFORE any write, excluding this leg explicitly by id rather
        // than relying on it having already been marked 'void'. Earlier legs of a
        // transfer group are excluded by the `status <> 'void'` predicate exactly
        // as before, so the figure is identical to the post-update version.
        //
        // The ORDER is load-bearing. Updating `trust_accounts` first meant that
        // reversing a spent deposit drove `book_balance_cents` negative and
        // tripped the `trust_accounts_book_balance_nonneg` CHECK, so Postgres
        // aborted the transaction before the guard below could run. The money was
        // safe (the whole transaction rolled back), but the caller got an opaque
        // 500 instead of the specific, actionable refusal this guard is written
        // to give them.
        const clientAfterRows = await financialSql(client,
          `select ${balanceExpr} b from trust_transactions
            where law_firm_id = $1 and trust_account_id = $2 and client_id = $3
              and status <> 'void' and id <> $4`,
          [lawFirmId, leg.trust_account_id, leg.client_id, leg.id]
        );
        const clientBalanceAfter = Number(clientAfterRows.rows[0].b);

        // Per-client overdraft guard, symmetric to createWithBalance and to the
        // account-level DB CHECK. Reversing a deposit whose funds were already
        // disbursed would drive THIS client's balance negative: covering the
        // clawed-back client's shortfall with other clients' pooled trust money,
        // a commingling violation the account-level book-balance CHECK cannot
        // catch when the account still holds other clients' funds. Refuse it and
        // let the caller surface it for manual correction (e.g. an ACH return on
        // spent funds raises TRUST_DEPOSIT_REVERSAL_FAILED). Only deposit
        // reversals can go negative; voiding a withdrawal only credits the client
        // back.
        if (isCredit && leg.client_id && clientBalanceAfter < 0) {
          throw new AppError(
            'Reversing this deposit would drive the client\'s trust balance negative because the funds were already disbursed. This needs a manual correction (the firm must restore the shortfall) rather than an automatic reversal.',
            400, 'INSUFFICIENT_TRUST_BALANCE'
          );
        }

        await financialSql(client,
          `update trust_transactions set status = 'void', voided_by = $3, voided_at = now(), void_reason = $4
            where law_firm_id = $1 and id = $2`,
          [lawFirmId, leg.id, actingUserId, voidReason || null]
        );
        await financialSql(client,
          `update trust_accounts set book_balance_cents = $3 where law_firm_id = $1 and id = $2`,
          [lawFirmId, leg.trust_account_id, newBookBalance]
        );

        // Reversal lineage: a NEW balance-neutral 'void' entry pointing at the
        // original via reverses_transaction_id. It is an INSERT (never an edit),
        // so the append-only immutability trigger is preserved, and being 'void'
        // it is excluded from every `status <> 'void'` aggregation.
        await financialSql(client,
          `insert into trust_transactions
             (law_firm_id, trust_account_id, type, amount_cents, client_id, matter_id, txn_date, description,
              reference_number, payee, transfer_to, transfer_to_account_id, transfer_group_id, source, invoice_id,
              reverses_transaction_id, status, client_balance_after_cents, account_balance_after_cents, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'void',$17,$18,$19)`,
          [
            lawFirmId, leg.trust_account_id, leg.type, leg.amount_cents, leg.client_id, leg.matter_id,
            leg.txn_date, `Reversal of ${leg.id}${voidReason ? `: ${voidReason}` : ''}`,
            leg.reference_number, leg.payee, leg.transfer_to, leg.transfer_to_account_id, leg.transfer_group_id,
            leg.source, leg.invoice_id, leg.id, clientBalanceAfter, newBookBalance, actingUserId,
          ]
        );
      }
    }
  }

  /**
   * Atomically restore up to `restoreCents` of the outstanding partial Stripe
   * reversals against a deposit — the money-safe, all-or-nothing version of the
   * former void-each-then-repost loop that ran each step in its own committed
   * transaction (so a mid-sequence failure permanently skewed the ledger). Voids
   * every outstanding reversing withdrawal and, when only part is restored, re-posts
   * one reversing withdrawal for the remainder, all under ONE transaction: any
   * failure rolls the whole thing back so a Stripe retry recomputes cleanly.
   * Returns the cents restored.
   */
  async restoreStripeReversalsAtomic({ lawFirmId, deposit, restoreCents, date, reason, actingUserId }: any) {
    if (!deposit || !isUuid(deposit.id)) return { restoredCents: 0 };
    return withDrizzleTransaction(async (client: any) => {
      // Lock the outstanding reversal withdrawals for this deposit so a concurrent
      // reversal/restore can't race us.
      const rev = await financialSql(client,
        `select id, amount_cents from trust_transactions
          where law_firm_id = $1 and reverses_transaction_id = $2
            and type = 'withdrawal' and status = 'completed'
          order by created_at desc
          for update`,
        [lawFirmId, deposit.id]
      );
      const outstanding = rev.rows.reduce((s: any, r: any) => s + Number(r.amount_cents), 0);
      if (outstanding <= 0) return { restoredCents: 0 };

      const restore = Math.min(outstanding, Math.round(restoreCents) || 0);
      if (restore <= 0) return { restoredCents: 0 };

      // Void every outstanding reversing withdrawal (each posts a balance-restoring
      // compensating entry and drops out of the reversed-total sum).
      for (const r of rev.rows) {
        await this._voidWithBalanceTx(client, {
          lawFirmId, actingUserId, transactionId: r.id, voidReason: `Restore: ${reason || ''}`.trim(),
        });
      }

      // When only part is restored, re-post one reversing withdrawal for the
      // remainder so the reversed total converges to (outstanding - restore).
      const remainder = outstanding - restore;
      if (remainder > 0) {
        await this._createWithBalanceTx(client, {
          lawFirmId, actingUserId, body: {
            trustAccountId: deposit.trustAccountId, type: 'withdrawal', amountCents: remainder,
            clientId: deposit.clientId || null, matterId: deposit.matterId || null, date,
            description: `Trust deposit reversal (${reason || 'residual'} residual)`, source: 'stripe',
            reversesTransactionId: deposit.id,
          },
        });
      }

      return { restoredCents: restore };
    });
  }
}

// ── Trust Minimum Balances (evergreen retainer thresholds) ─────────
class TrustMinimumBalanceRepository extends DrizzleRepository {
  constructor() { super(trustMinimumBalances as any); }

  /** The configured minimum (cents) for one (client, account), or null. */
  async getMinimum(lawFirmId: string, clientId: string, trustAccountId: string) {
    if (!isUuid(clientId) || !isUuid(trustAccountId)) return null;
    const { rows } = await financialRootSql(
      `select minimum_cents from trust_minimum_balances
        where law_firm_id = $1 and client_id = $2 and trust_account_id = $3`,
      [lawFirmId, clientId, trustAccountId]
    );
    return rows[0] ? Number(rows[0].minimum_cents) : null;
  }

  /** Upsert the (client, account) minimum. Returns the row with joined names. */
  async upsert(lawFirmId: string, { clientId, trustAccountId, minimumCents, actingUserId }: any) {
    await financialRootSql(
      `insert into trust_minimum_balances
         (law_firm_id, client_id, trust_account_id, minimum_cents, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$5)
       on conflict (law_firm_id, client_id, trust_account_id)
       do update set minimum_cents = excluded.minimum_cents, updated_by = excluded.updated_by`,
      [lawFirmId, clientId, trustAccountId, minimumCents, actingUserId]
    );
    const { rows } = await financialRootSql(
      `select m.*, cl.name as client_name, ta.name as trust_account_name
         from trust_minimum_balances m
         left join clients cl on cl.id = m.client_id
         left join trust_accounts ta on ta.id = m.trust_account_id
        where m.law_firm_id = $1 and m.client_id = $2 and m.trust_account_id = $3`,
      [lawFirmId, clientId, trustAccountId]
    );
    return sqlRowToEntity(rows[0]);
  }

  /** All configured minimums for the firm, with client + account names. */
  async listAll(lawFirmId: string) {
    const { rows } = await financialRootSql(
      `select m.*, cl.name as client_name, ta.name as trust_account_name
         from trust_minimum_balances m
         left join clients cl on cl.id = m.client_id
         left join trust_accounts ta on ta.id = m.trust_account_id
        where m.law_firm_id = $1
        order by cl.name nulls last, ta.name nulls last`,
      [lawFirmId]
    );
    return rows.map((r: any) => sqlRowToEntity(r));
  }
}

// ── Trust Interest Remittances (IOLTA interest tracking) ───────────
class TrustInterestRemittanceRepository extends DrizzleRepository {
  constructor() { super(trustInterestRemittances as any); }

  /**
   * Remittance records, newest period first, optionally scoped to an account.
   *
   * `trust_interest_remittances` is append-only accounting history: a firm adds a
   * row every interest period per IOLTA account and never removes one, so the set
   * only grows. The ordering and the WHERE are unchanged — this bounds how many
   * rows come back at once, never which rows a given query matches.
   *
   * Paging is optional. With a `limit` the caller gets that window; without one
   * the whole list comes back as before, stopping at `LIST_CEILING` with
   * `truncated` set so a capped list is not read as the firm's complete history.
   */
  async listAll(lawFirmId: string, { trustAccountId, limit, offset }: any = {}) {
    const params: unknown[] = [lawFirmId];
    let acc = '';
    if (trustAccountId) { params.push(trustAccountId); acc = ` and r.trust_account_id = $${params.length}`; }

    const paged = limit != null;
    const limitSql = paged
      ? buildPageClause({ limit, offset, params, fallbackLimit: 100, max: 200 }).pageClause
      : buildCeilingClause({ params });

    const { rows } = await financialRootSql(
      `select r.*, ta.name as trust_account_name
         from trust_interest_remittances r
         left join trust_accounts ta on ta.id = r.trust_account_id
        where r.law_firm_id = $1${acc}
        order by r.period_end desc nulls last, r.created_at desc, r.id desc${limitSql}`,
      params
    );

    // A paged read is already bounded by its own limit, so only the unpaged path
    // can be truncated by the ceiling.
    const capped = paged
      ? { rows, truncated: false, ceiling: LIST_CEILING }
      : applyCeiling(rows);
    return {
      remittances: capped.rows.map((r: any) => sqlRowToEntity(r)),
      truncated: capped.truncated,
      ceiling: capped.ceiling,
    };
  }

  /** Total remittance count matching the same scope as `listAll`. */
  async countAll(lawFirmId: string, { trustAccountId }: any = {}) {
    const params: unknown[] = [lawFirmId];
    let acc = '';
    if (trustAccountId) { params.push(trustAccountId); acc = ` and trust_account_id = $${params.length}`; }
    const { rows } = await financialRootSql(
      `select count(*)::bigint c from trust_interest_remittances where law_firm_id = $1${acc}`,
      params
    );
    return Number(rows[0].c);
  }
}

/**
 * Whether `matterId` is a matter of this firm that `clientId` is a client on.
 *
 * A matter can carry several co-clients, so the junction table is the authority
 * rather than any single column on `matters`. The trust ledger's own
 * `(law_firm_id, matter_id)` FK only proves the matter is in the same firm,
 * which is not the question: attributing one client's money to another client's
 * engagement is wrong even inside one firm, and `trust_transactions` is
 * append-only so the row can never be corrected in place.
 */
export async function matterBelongsToClient(lawFirmId: string, matterId: string, clientId: string) {
  if (!isUuid(matterId) || !isUuid(clientId)) return false;
  const { rows } = await financialRootSql(
    `select 1 from matter_clients
      where law_firm_id = $1 and matter_id = $2 and client_id = $3 limit 1`,
    [lawFirmId, matterId, clientId]
  );
  return !!rows[0];
}

// ── Per-firm trust settings (jurisdiction defaults) ────────────────
// Stored under `law_firms.settings -> 'trust'` (a jsonb sub-object) so no
// dedicated table is needed for a small, firm-wide config blob.
export async function getFirmTrustSettings(lawFirmId: string) {
  const { rows } = await financialRootSql('select settings from law_firms where id = $1', [lawFirmId]);
  const settings = (rows[0] && rows[0].settings) || {};
  return settings.trust || {};
}

export async function setFirmTrustSettings(lawFirmId: string, trust: any) {
  // Read-modify-write the settings blob, merging the trust sub-object so other
  // settings keys are preserved.
  const { rows } = await financialRootSql('select settings from law_firms where id = $1', [lawFirmId]);
  if (!rows[0]) throw new NotFoundError('LawFirm');
  const settings = rows[0].settings || {};
  const merged = { ...settings, trust: { ...(settings.trust || {}), ...trust } };
  await financialRootSql('update law_firms set settings = $2::jsonb where id = $1', [lawFirmId, JSON.stringify(merged)]);
  return merged.trust;
}

// ── Trust-account Stripe connected account (cross-firm webhook lookup) ──
// `account.updated` for a trust connected account carries only the Stripe account
// id, so the owning firm + trust account are resolved from it here.
export async function findTrustAccountByStripeConnectedAccountId(connectedAccountId: any) {
  if (!connectedAccountId) return null;
  const { rows } = await financialRootSql(
    `select law_firm_id, id from trust_accounts where stripe_connected_account_id = $1 limit 1`,
    [connectedAccountId]
  );
  return rows[0] ? { lawFirmId: rows[0].law_firm_id, id: rows[0].id } : null;
}

// ── Trust deposit processing-fee ledger ────────────────────────────
// The ACH fee Paralegix fronts on a trust deposit, accrued so it is billed to the
// firm's operating side exactly once. Idempotent on the deposit transaction.
export async function recordTrustDepositFee({ lawFirmId, trustTransactionId, feeCents }: any) {
  const { rows } = await financialRootSql(
    `insert into trust_deposit_fees (law_firm_id, trust_transaction_id, fee_cents)
       values ($1, $2, $3)
     on conflict (law_firm_id, trust_transaction_id) do nothing
     returning id, status`,
    [lawFirmId, trustTransactionId, feeCents]
  );
  // No row returned => the fee was already accrued (replayed webhook). Signal that
  // so the caller does not create a second Stripe invoice item.
  if (!rows[0]) return { feeId: null, alreadyExisted: true };
  return { feeId: rows[0].id, alreadyExisted: false };
}

export async function markTrustDepositFeeBilled(lawFirmId: string, feeId: any, stripeInvoiceItemId: any) {
  await financialRootSql(
    `update trust_deposit_fees set status = 'billed', stripe_invoice_item_id = $3
      where law_firm_id = $1 and id = $2`,
    [lawFirmId, feeId, stripeInvoiceItemId]
  );
}

/** The current fee row for a deposit (id/status/fee/invoice), or null. */
export async function findTrustDepositFee(lawFirmId: string, trustTransactionId: any) {
  const { rows } = await financialRootSql(
    `select id, status, fee_cents, stripe_invoice_id
       from trust_deposit_fees
      where law_firm_id = $1 and trust_transaction_id = $2 limit 1`,
    [lawFirmId, trustTransactionId]
  );
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    status: rows[0].status,
    feeCents: Number(rows[0].fee_cents),
    stripeInvoiceId: rows[0].stripe_invoice_id || null,
  };
}

/**
 * Persist the one-off fee invoice id on an accrued fee row (status unchanged) the
 * moment it is finalized, before it is paid. A later retry reuses this invoice
 * instead of creating a second charge.
 */
export async function attachTrustDepositFeeInvoice(lawFirmId: string, feeId: any, stripeInvoiceId: any) {
  await financialRootSql(
    `update trust_deposit_fees set stripe_invoice_id = $3
      where law_firm_id = $1 and id = $2`,
    [lawFirmId, feeId, stripeInvoiceId]
  );
}

/**
 * Accrued (not-yet-billed) trust deposit fees across all firms, oldest first. Used
 * by the sweep that bills fees which could not be billed at deposit time (e.g. the
 * firm had no subscription customer yet).
 */
export async function listAccruedTrustDepositFees(limit = 500) {
  const { rows } = await financialRootSql(
    `select id, law_firm_id, trust_transaction_id, fee_cents, stripe_invoice_id
       from trust_deposit_fees
      where status = 'accrued'
      order by created_at asc
      limit $1`,
    [clampLimit(limit, { fallback: 500, max: 1000 })]
  );
  return rows.map((r: any) => ({
    id: r.id,
    lawFirmId: r.law_firm_id,
    trustTransactionId: r.trust_transaction_id,
    feeCents: Number(r.fee_cents),
    stripeInvoiceId: r.stripe_invoice_id || null,
  }));
}

export const trustAccountRepo = new TrustAccountRepository();
export const trustTxnRepo = new TrustTransactionRepository();
export const trustRecRepo = new TrustReconciliationRepository();
export const trustMinRepo = new TrustMinimumBalanceRepository();
export const trustInterestRepo = new TrustInterestRemittanceRepository();
