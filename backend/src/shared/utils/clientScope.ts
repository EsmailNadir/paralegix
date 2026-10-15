import { and, eq, inArray } from 'drizzle-orm';
import { clients } from '../database/drizzle/schema';
import { tenantQuery } from '../database/queryContext';

const { NotFoundError } = require('../errors/AppError');
const { isUuid } = require('./isUuid');

/**
 * The client a write names must belong to the firm the write is charged to.
 *
 * `assertLawFirmMembership` proves the CALLER belongs to the firm. It says
 * nothing about the SUBJECT, and a create path that checks only the caller will
 * happily write a row carrying its own `law_firm_id` and another firm's
 * `client_id`.
 *
 * That is not a data leak: reads stay scoped by `law_firm_id`, so neither firm
 * sees the other's records. It is worse in a quieter way. The row is invisible
 * to BOTH firms, so the work is simply lost, and `clients.id` cascades on
 * delete, so the owning firm removing that client silently deletes the other
 * firm's rows.
 *
 * Answers 404 rather than 403 on purpose: another firm's client must be
 * indistinguishable from one that never existed, or the response confirms which
 * ids are real elsewhere in the system.
 *
 * Call this in any service that accepts a client id from the request and writes
 * it. `tests/tenancy/foreignClientWrites.test.ts` is the standing guard for the
 * whole class.
 */
export async function assertClientInFirm(lawFirmId: string, clientId: string): Promise<void> {
  // A non-uuid would reach Postgres as a failed cast, which surfaces as a 500
  // carrying the query shape rather than as a clean not-found.
  if (!isUuid(clientId)) throw new NotFoundError('Client');

  const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
    .select({ id: clients.id })
    .from(clients)
    .where(and(scope, eq(clients.id, clientId)))
    .limit(1));

  if (!rows.length) throw new NotFoundError('Client');
}

/**
 * Which of these client ids belong to the firm, resolved in a SINGLE query.
 *
 * The set-returning half of `assertClientInFirm`, split out the same way
 * `resolveMatterMembers` was split out of `assertMatterMemberships`: a caller
 * holding many records that each name a client (a bulk delete over a firm-wide
 * selection) can settle every id at once and then decide per record in memory,
 * instead of one round trip per record on a pool the whole instance shares.
 *
 * `assertClientInFirm` is still what turns a miss into the user-facing 404, so
 * the "indistinguishable from an id that never existed" wording lives in one
 * place.
 */
export async function resolveClientsInFirm(
  lawFirmId: string,
  clientIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set((Array.isArray(clientIds) ? clientIds : [clientIds]).filter(Boolean))]
    .filter((id) => isUuid(id));
  if (!ids.length) return new Set<string>();

  const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
    .select({ id: clients.id })
    .from(clients)
    .where(and(scope, inArray(clients.id, ids))));

  return new Set<string>(rows.map((row: any) => row.id));
}
