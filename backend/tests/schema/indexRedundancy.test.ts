/**
 * Structural guard against redundant btree indexes.
 *
 * A redundant index is pure write cost. Postgres maintains it on every insert,
 * update and delete of the table, and the planner never needs it because a
 * wider index on the same table can serve every query it can. Migration 0145
 * removed 24 of them and measured the cost of keeping them: on a
 * clients-shaped table, two redundant btrees made bulk insert 17-20% slower.
 *
 * This test re-derives the redundant set from the live catalog rather than
 * checking a hardcoded list, so it also fails when someone ADDS a redundant
 * index later. That is the point: the list in a migration is a snapshot, and a
 * snapshot cannot catch the next one.
 *
 * WHAT MAKES IT GO RED: adding an index whose columns are a leading prefix of
 * another index on the same table, under either rule below. The fix
 * is to delete the narrower index, not to widen this test.
 *
 * TWO RULES. Both are chosen so that dropping A is COST-NEUTRAL, not merely
 * correct. A and B must cover the SAME ROWS, so the only difference is a
 * slightly wider tuple:
 *
 *   R1  Neither is partial, and A's columns are a leading prefix of B's.
 *       A btree supports leading-prefix scans, so B answers every A query over
 *       the same rows. This is migration 0145's rule verbatim.
 *
 *   R2  A and B have the SAME predicate and A's columns are a leading prefix
 *       of B's. Identical row coverage, so this is R1 restricted to a subset.
 *
 * DELIBERATELY NOT A RULE: A partial, B not partial. B does index every row A
 * does, so B is CORRECT for every A query, but it is not cost-neutral. When A's
 * predicate is selective, B makes the planner read every row of the table and
 * filter, which is exactly the work A existed to avoid. An earlier draft of this
 * test encoded that case and reported five indexes that genuinely earn their
 * keep: `invoices_outstanding_idx` (where balance_due_cents > 0),
 * `matter_notes_client_visible_idx` and `events_client_visible_idx`
 * (where client_visible), and the two firm-wide recipient fan-outs
 * `contact_clients_portal_pending_idx` and
 * `client_company_links_email_recipient_idx`. Selectivity
 * is not derivable from the catalog, so a partial index is argued one at a time
 * with an EXPLAIN against real data, and never by this test.
 *
 * ALSO NOT A RULE: A non-partial, B partial. B covers only some rows, so it
 * cannot stand in for A in general.
 *
 * A UNIQUE index is never reported as redundant. It enforces a constraint, so
 * dropping it changes behaviour rather than just cost. It is still eligible as
 * the WIDER index B.
 *
 * Expression columns show as attribute number 0 in `pg_index.indkey` and cannot
 * be compared positionally, so any index containing one is excluded from both
 * sides.
 */
import { testPool } from '../support/setupInProcess';

/**
 * Every btree in the public schema, with the facts the two rules need.
 * `keys` is the ordered list of indexed attribute numbers; a 0 marks an
 * expression. `pred` is the normalized partial predicate, or null.
 */
const CATALOG_SQL = `
  select t.relname          as tbl,
         i.relname          as idx,
         x.indisunique      as uniq,
         pg_get_expr(x.indpred, x.indrelid) as pred,
         string_to_array(x.indkey::text, ' ')::int[] as keys
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_am   am on am.oid = i.relam
   where t.relnamespace = 'public'::regnamespace
     and t.relkind = 'r'
     and am.amname = 'btree'
`;

type Idx = { tbl: string; idx: string; uniq: boolean; pred: string | null; keys: number[] };

/** True when `a` is a leading prefix of `b` and strictly narrower or equal. */
function isPrefix(a: number[], b: number[]): boolean {
  if (a.length > b.length) return false;
  return a.every((k, i) => k === b[i]);
}

describe('no redundant btree indexes', () => {
  it('reports every index a wider index on the same table already covers', async () => {
    const { rows } = await testPool.query<Idx>(CATALOG_SQL);

    // An expression column cannot be compared positionally, so exclude it from
    // both sides rather than risk a false positive.
    const usable = rows.filter((r) => !r.keys.includes(0));

    const byTable = new Map<string, Idx[]>();
    for (const r of usable) {
      if (!byTable.has(r.tbl)) byTable.set(r.tbl, []);
      byTable.get(r.tbl)!.push(r);
    }

    const findings: string[] = [];
    for (const [tbl, list] of byTable) {
      for (const a of list) {
        // A unique index is a constraint, not just an access path.
        if (a.uniq) continue;
        for (const b of list) {
          if (a.idx === b.idx) continue;
          if (!isPrefix(a.keys, b.keys)) continue;
          // Equal key lists under the same predicate would make each half
          // report the other, so both rules require B to be strictly wider.
          const sameWidth = a.keys.length === b.keys.length;

          let rule: string | null = null;
          if (a.pred === null && b.pred === null && !sameWidth) rule = 'R1';
          else if (a.pred !== null && b.pred !== null && a.pred === b.pred && !sameWidth) rule = 'R2';

          if (rule) {
            findings.push(`${tbl}: ${a.idx} [${rule}] is covered by ${b.idx}`);
            break;
          }
        }
      }
    }

    expect(findings.sort()).toEqual([]);
  });
});
