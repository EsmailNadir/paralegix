/**
 * The cash automatic Stripe recovery took back for a clawed-back payment, and how
 * much of it has since been given back (`stripe_fund_recoveries`).
 *
 * One row per Stripe object that moved the money: a transfer reversal on a
 * connected account, or the payment intent that charged the firm's card. The
 * row says where the cash came from, which is where a won dispute or a failed
 * refund must send it back. The trust ledger and the invoice cannot answer
 * that: the ledger can refuse a reversal while cash was still taken, and a
 * transfer reversal is capped below the charge by the application fee.
 *
 * Every read and write is scoped by `law_firm_id`. Webhook callers resolve the
 * firm from the deposit or the invoice payment before reaching this file.
 */
import { and, asc, eq, lt, sql } from 'drizzle-orm';

import { stripeFundRecoveries } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
import { scopedInsertOnConflictDoNothing, scopedUpdate } from '../../shared/database/scopedWrite';

export type FundRecoverySource = 'trust_transfer' | 'firm_transfer' | 'firm_card';

export interface FundRecovery {
  id: string;
  source: FundRecoverySource;
  stripeObjectId: string;
  recoveredCents: number;
  restoredCents: number;
}

/**
 * Record cash taken back by one Stripe object. A replay of the same Stripe
 * object (an idempotent retry hands back the same reversal or payment intent)
 * records nothing. Returns true when a row was written.
 */
export async function recordFundRecovery({
  lawFirmId, paymentIntentId, source, stripeObjectId, recoveredCents,
}: {
  lawFirmId: string;
  paymentIntentId: string;
  source: FundRecoverySource;
  stripeObjectId: string;
  recoveredCents: number;
}): Promise<boolean> {
  const rows = await scopedInsertOnConflictDoNothing(stripeFundRecoveries, lawFirmId, {
    stripePaymentIntentId: paymentIntentId,
    source,
    stripeObjectId,
    recoveredCents: Math.round(recoveredCents),
  }, [stripeFundRecoveries.stripeObjectId]);
  return rows.length > 0;
}

/** Cash still held back for a payment across every source: recovered less restored. */
export async function netRecoveredCents(lawFirmId: string, paymentIntentId: string): Promise<number> {
  const rows: any[] = await tenantQuery(stripeFundRecoveries, lawFirmId, ({ executor, scope }: any) => executor
    .select({
      held: sql<string>`coalesce(sum(${stripeFundRecoveries.recoveredCents} - ${stripeFundRecoveries.restoredCents}), 0)::bigint`,
    })
    .from(stripeFundRecoveries)
    .where(and(scope, eq(stripeFundRecoveries.stripePaymentIntentId, paymentIntentId))));
  return Number(rows[0]?.held || 0);
}

/** The rows from one source that still have cash to give back, oldest first. */
export async function listOutstandingRecoveries(
  lawFirmId: string,
  paymentIntentId: string,
  source: FundRecoverySource,
): Promise<FundRecovery[]> {
  const rows: any[] = await tenantQuery(stripeFundRecoveries, lawFirmId, ({ executor, scope }: any) => executor
    .select()
    .from(stripeFundRecoveries)
    .where(and(
      scope,
      eq(stripeFundRecoveries.stripePaymentIntentId, paymentIntentId),
      eq(stripeFundRecoveries.source, source),
      lt(stripeFundRecoveries.restoredCents, stripeFundRecoveries.recoveredCents),
    ))
    .orderBy(asc(stripeFundRecoveries.createdAt), asc(stripeFundRecoveries.id)));
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    stripeObjectId: r.stripeObjectId,
    recoveredCents: Number(r.recoveredCents),
    restoredCents: Number(r.restoredCents),
  }));
}

/**
 * Count `cents` more of a row as given back. Conditional on the figure the
 * caller read, so a concurrent restore cannot both count the same cents; the
 * CHECK keeps the total at or under what was recovered. Returns true when the
 * row moved.
 */
export async function markRecoveryRestored(
  lawFirmId: string,
  recovery: FundRecovery,
  cents: number,
): Promise<boolean> {
  const rows = await scopedUpdate(
    stripeFundRecoveries,
    lawFirmId,
    and(
      eq(stripeFundRecoveries.id, recovery.id),
      eq(stripeFundRecoveries.restoredCents, recovery.restoredCents),
    )!,
    { restoredCents: recovery.restoredCents + Math.round(cents) },
  );
  return rows.length > 0;
}
