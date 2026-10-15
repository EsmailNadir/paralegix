/**
 * Postgres access for `client_identity_verifications`, through the audited
 * tenant contexts. Every read and write is scoped by `law_firm_id`.
 *
 * Expiry is judged by the database clock (`expires_at` against `now()`), the
 * same clock that set the default, so an app server with a skewed clock can
 * neither extend nor cut short the ten-minute window.
 */
import { and, desc, eq, gt, lte, sql } from 'drizzle-orm';
import { clientIdentityVerifications as table } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
import { scopedInsert, scopedUpdate } from '../../shared/database/scopedWrite';
import { isUuid } from '../../shared/utils/isUuid';
import type { VerificationMethod, VerificationStatus } from './identityVerification.validation';

export type VerificationRow = typeof table.$inferSelect;

/** The outcome written when an attempt finishes. Every field the row may keep. */
export type VerificationOutcome = {
  status: Exclude<VerificationStatus, 'pending' | 'expired'>;
  verifiedGivenName?: string | null;
  verifiedFamilyName?: string | null;
  issuer?: string | null;
  docType?: string | null;
  credentialExpiresOn?: string | null;
  isNameMatch?: boolean | null;
  checks?: Record<string, boolean | string>;
  failureReason?: string | null;
};

export async function insertVerification(
  lawFirmId: string,
  values: { clientId: string; userId: string; method: VerificationMethod; providerSessionId: string },
): Promise<VerificationRow> {
  const [row] = await scopedInsert(table, lawFirmId, {
    clientId: values.clientId,
    userId: values.userId,
    method: values.method,
    providerSessionId: values.providerSessionId,
  });
  return row;
}

/**
 * One verification, only when it belongs to this user. Another user's row reads
 * as absent, so a caller can never learn that it exists.
 */
export async function findForUser(lawFirmId: string, verificationId: string, userId: string): Promise<VerificationRow | null> {
  if (!isUuid(verificationId)) return null;
  const rows = await tenantQuery(table, lawFirmId, ({ executor, scope }) => executor
    .select().from(table)
    .where(and(scope, eq(table.id, verificationId), eq(table.userId, userId)))
    .limit(1));
  return rows[0] ?? null;
}

/**
 * Mark a pending row whose window has closed as expired. Answers whether this
 * call expired it; false for a row still open or already finished.
 */
export async function expireIfDue(lawFirmId: string, verificationId: string): Promise<boolean> {
  const rows = await scopedUpdate(
    table,
    lawFirmId,
    and(eq(table.id, verificationId), eq(table.status, 'pending'), lte(table.expiresAt, sql`now()`))!,
    { status: 'expired', completedAt: sql`now()` as unknown as Date },
  );
  return rows.length > 0;
}

/**
 * Write the outcome onto a row that is still pending and inside its window.
 * Answers null when another request finished it first or the window closed, so
 * the outcome lands at most once.
 */
export async function finishPending(
  lawFirmId: string,
  verificationId: string,
  outcome: VerificationOutcome,
): Promise<VerificationRow | null> {
  const rows = await scopedUpdate(
    table,
    lawFirmId,
    and(eq(table.id, verificationId), eq(table.status, 'pending'), gt(table.expiresAt, sql`now()`))!,
    {
      status: outcome.status,
      verifiedGivenName: outcome.verifiedGivenName ?? null,
      verifiedFamilyName: outcome.verifiedFamilyName ?? null,
      issuer: outcome.issuer ?? null,
      docType: outcome.docType ?? null,
      credentialExpiresOn: outcome.credentialExpiresOn ?? null,
      isNameMatch: outcome.isNameMatch ?? null,
      checks: outcome.checks ?? {},
      failureReason: outcome.failureReason ?? null,
      completedAt: sql`now()` as unknown as Date,
    },
  );
  return rows[0] ?? null;
}

/**
 * The newest attempt for a client, optionally narrowed to one status and one
 * portal user.
 */
export async function latestForClient(
  lawFirmId: string,
  clientId: string,
  filters: { status?: VerificationStatus; userId?: string } = {},
): Promise<VerificationRow | null> {
  const rows = await tenantQuery(table, lawFirmId, ({ executor, scope }) => executor
    .select().from(table)
    .where(and(
      scope,
      eq(table.clientId, clientId),
      filters.status ? eq(table.status, filters.status) : undefined,
      filters.userId ? eq(table.userId, filters.userId) : undefined,
    ))
    .orderBy(desc(table.createdAt), desc(table.id))
    .limit(1));
  return rows[0] ?? null;
}
