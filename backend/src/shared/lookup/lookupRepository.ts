import { asc } from 'drizzle-orm';
import { DrizzleRepository } from '../database/DrizzleRepository';
import { tenantQuery } from '../database/queryContext';

/**
 * A firm-scoped reference table: a name, an optional sort order, and a handful of
 * descriptive columns. Courts, practice areas, note types, matter categories and
 * the rest of the settings lists are all this shape.
 *
 * The repository each of them had was the same twenty-six lines with a different
 * table name. Extracting it is not only about the duplication: `listOrdered` has
 * one detail worth having in a single place, which is that it orders by
 * `sort_order` and then `name`, so a firm that has never dragged the list into an
 * order still sees it alphabetically rather than in insertion order.
 */
class LookupRepository extends DrizzleRepository {
  private readonly lookupTable: any;

  constructor(table: any) {
    // `order` is the entity-side name; the column is `sort_order`, because
    // `order` is a reserved word in SQL.
    super(table, { aliases: { order: 'sortOrder' } });
    this.lookupTable = table;
  }

  /** Rows ordered by (sort_order nulls last, name). */
  async listOrdered(lawFirmId: string) {
    const table = this.lookupTable;
    // No `: any` on the callback context. `tenantQuery` is generic over what the
    // builder returns, so annotating the destructured context erases the row type
    // and forces every downstream `.map` callback to be annotated too.
    const rows: Record<string, unknown>[] = await tenantQuery(
      table,
      lawFirmId,
      ({ executor, scope }) => executor
        .select()
        .from(table)
        .where(scope)
        .orderBy(asc(table.sortOrder), asc(table.name)),
    );
    return rows.map((row) => this.toEntity(row));
  }
}

/**
 * Build the repository for one reference table.
 *
 * Each module keeps its own `*.repository` file exporting the result, because
 * other modules require those by path (`lawfirms.service` reaches for the
 * practice-area repository, `catalog.service` for the courts one).
 */
export function createLookupRepository(table: any) {
  return new LookupRepository(table);
}
