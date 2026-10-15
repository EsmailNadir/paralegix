/**
 * Shared pieces of the entity-id sweeps (`tests/crosscutting/entityIdHandling.*`).
 *
 * Each sweep walks a table of routes that carry an entity id in the path and
 * asks three things of every one: a MALFORMED id is refused rather than
 * answered with a 500, a well-formed id that names NOTHING is refused the same
 * way, and ANOTHER FIRM's id is never served or written. A cross-firm refusal
 * only counts when the same request with the caller's OWN id succeeds, so each
 * sweep pairs it with that control.
 *
 * The route tables, the world each sweep seeds and what "unchanged" means for
 * each entity differ per slice and stay in the spec. What lives here is what
 * the two sweeps had each written for themselves.
 */
import { randomUUID } from 'crypto';
import { testPool } from './db';

/** Not a uuid, so an unguarded lookup reaches Postgres as a 22P02 cast error. */
export const MALFORMED_ID = 'not-a-uuid';

/** A well-formed uuid that names nothing. The control for the malformed case. */
export const absentId = (): string => randomUUID();

/**
 * A count and a content hash of every `tables` row belonging to `lawFirmId`.
 * Taken either side of a cross-firm request, it catches a write that touched
 * ANYTHING in the other firm, not only the row the URL named.
 */
export async function firmFingerprint(tables: readonly string[], lawFirmId: string) {
  const sql = [...new Set(tables)].map((t) => (
    `select '${t}' as t, count(*)::int as n,`
    + ` md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h`
    + ` from ${t} x where x.law_firm_id = $1`
  )).join(' union all ');
  const { rows } = await testPool.query(sql, [lawFirmId]);
  return rows;
}

/** One row as json, or null, keyed by `column` (text-keyed tables use `token`). */
export async function rowJson(table: string, id: string, column = 'id') {
  const { rows } = await testPool.query(
    `select to_jsonb(x) as j from ${table} x where x.${column} = $1`, [id],
  );
  return rows[0]?.j ?? null;
}

/**
 * `'refused'` when the status is one the case accepts, and the status plus the
 * body otherwise. Asserting `toBe('refused')` on this rather than on the bare
 * status is what puts the actual error envelope into the failure output; a bare
 * `expect([404]).toContain(500)` says only "500".
 *
 * `emptyIsRefusal` is for a route that takes the id as a FILTER on a
 * firm-scoped aggregate: it refuses by reporting nothing, so a 200 whose body
 * the predicate calls empty is the refusal too.
 */
export function refusalVerdict(
  response: { status: number; body?: any; text?: string },
  accepted: readonly number[],
  emptyIsRefusal?: (body: any) => boolean,
): string {
  if (accepted.includes(response.status)) return 'refused';
  if (emptyIsRefusal && response.status === 200) {
    return emptyIsRefusal(response.body) ? 'refused' : `200 leaked ${JSON.stringify(response.body)}`;
  }
  const payload = response.body && Object.keys(response.body).length
    ? JSON.stringify(response.body)
    : String(response.text || '').slice(0, 200);
  return `${response.status} ${payload}`;
}
