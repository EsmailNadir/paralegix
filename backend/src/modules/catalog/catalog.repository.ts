/** Global reference-catalog reads and tenant-scoped adoption lookups. */
import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  inArray,
  max,
  sql,
  type SQL,
} from 'drizzle-orm';
import { drizzleRowToEntity } from '../../shared/database/DrizzleRepository';
import {
  billingCodes,
  courtCatalog,
  courts,
  utbmsCodes,
} from '../../shared/database/drizzle/schema';
import { systemQuery, tenantQuery } from '../../shared/database/queryContext';
import { resolvePage } from '../../shared/database/pagination';
const { isUuid } = require('../../shared/utils/isUuid');

const onlyUuids = (ids: unknown) => (Array.isArray(ids) ? ids.filter(isUuid) : []);
/**
 * Charge codes and expense categories are both rows of `billing_codes` since
 * migration 0231, told apart by `kind`. The adoption routines still take the
 * historical table name from `catalog.service` and turn it into the kind
 * predicate, so a charge-code adoption can never see or collide with an
 * expense category.
 */
function adoptionKind(table: string): 'charge' | 'expense' {
  if (table === 'charge_codes') return 'charge';
  if (table === 'expense_categories') return 'expense';
  throw new Error(`Unsupported UTBMS adoption table: ${table}`);
}

/** Paginated court catalog search with per-firm adoption status. */
export async function searchCourts(
  lawFirmId: string,
  { search, state, courtType, jurisdiction, limit = 50, offset = 0 }: any = {},
) {
  const filters: SQL[] = [];
  if (search?.trim()) {
    const trimmedSearch = search.trim();
    const prefixQuery = (trimmedSearch.match(/[a-zA-Z0-9]+/g) || [])
      .map((term: string) => `${term}:*`)
      .join(' & ');
    filters.push(prefixQuery
      ? sql`(
          ${courtCatalog.search} @@ websearch_to_tsquery('english', ${trimmedSearch})
          or ${courtCatalog.search} @@ to_tsquery('english', ${prefixQuery})
        )`
      : sql`${courtCatalog.search} @@ websearch_to_tsquery('english', ${trimmedSearch})`);
  }
  if (state) filters.push(eq(courtCatalog.state, state));
  if (courtType) filters.push(eq(courtCatalog.courtType, courtType));
  if (jurisdiction) filters.push(eq(courtCatalog.jurisdiction, jurisdiction));
  const predicate = filters.length ? and(...filters) : undefined;
  const page = resolvePage({ limit, offset, fallbackLimit: 50, max: 200 });

  const [rows, totals] = await Promise.all([
    systemQuery('catalog', (executor) => executor
      .select({
        ...getTableColumns(courtCatalog),
        // Every column here is written TABLE-QUALIFIED, and it has to stay that
        // way. Drizzle renders a bare `${courts.catalogCourtId}` as
        // `"catalog_court_id"` with no table prefix whenever the outer query has
        // a single FROM table, and `courts` carries an `id` column of its own, so
        // the unqualified `${courtCatalog.id}` resolved to `courts.id` inside the
        // subquery's scope. Postgres read the filter as
        // `courts.catalog_court_id = courts.id`, the EXISTS stopped being
        // correlated at all, and the flag came back false for every catalog row
        // at every firm. The picker then never showed a court as already added.
        alreadyAdded: sql<boolean>`exists (
          select 1 from ${courts}
          where ${courts}."law_firm_id" = ${lawFirmId}
            and ${courts}."catalog_court_id" = ${courtCatalog}."id"
        )`,
      })
      .from(courtCatalog)
      .where(predicate)
      .orderBy(asc(courtCatalog.fullName))
      .limit(page.limit)
      .offset(page.offset)),
    systemQuery('catalog', (executor) => executor
      .select({ n: count() })
      .from(courtCatalog)
      .where(predicate)),
  ]);

  return {
    items: rows.map((row) => drizzleRowToEntity(row)!),
    totalItems: totals[0]?.n || 0,
  };
}

export async function getCourtsByIds(ids: unknown) {
  const clean = onlyUuids(ids);
  if (!clean.length) return [];
  const rows = await systemQuery('catalog', (executor) => executor
    .select()
    .from(courtCatalog)
    .where(inArray(courtCatalog.id, clean)));
  return rows.map((row) => drizzleRowToEntity(row)!);
}

/** List active UTBMS codes by type and optional practice set. */
export async function listUtbmsCodes({ codeType, practiceSet }: any = {}) {
  const filters: SQL[] = [eq(utbmsCodes.isActive, true)];
  if (codeType) filters.push(eq(utbmsCodes.codeType, codeType));
  if (practiceSet) filters.push(eq(utbmsCodes.practiceSet, practiceSet));
  const rows = await systemQuery('catalog', (executor) => executor
    .select()
    .from(utbmsCodes)
    .where(and(...filters))
    .orderBy(asc(utbmsCodes.code)));
  return rows.map((row) => drizzleRowToEntity(row)!);
}

export async function getUtbmsCodesByIds(ids: unknown) {
  const clean = onlyUuids(ids);
  if (!clean.length) return [];
  const rows = await systemQuery('catalog', (executor) => executor
    .select()
    .from(utbmsCodes)
    .where(inArray(utbmsCodes.id, clean)));
  return rows.map((row) => drizzleRowToEntity(row)!);
}

export async function findAdoptedCatalogCourtIds(lawFirmId: string, catalogCourtIds: unknown) {
  const clean = onlyUuids(catalogCourtIds);
  if (!clean.length) return new Set<string>();
  const rows = await tenantQuery(
    courts,
    lawFirmId,
    ({ executor, scope }) => executor
      .selectDistinct({ catalogCourtId: courts.catalogCourtId })
      .from(courts)
      .where(and(scope, inArray(courts.catalogCourtId, clean))),
  );
  return new Set(rows.flatMap((row) => row.catalogCourtId ? [row.catalogCourtId] : []));
}

export async function findAdoptedUtbmsCodeIds(
  lawFirmId: string,
  tableName: string,
  utbmsCodeIds: unknown,
) {
  const clean = onlyUuids(utbmsCodeIds);
  if (!clean.length) return new Set<string>();
  const kind = adoptionKind(tableName);
  const rows = await tenantQuery(
    billingCodes,
    lawFirmId,
    ({ executor, scope }) => executor
      .selectDistinct({ utbmsCodeId: billingCodes.utbmsCodeId })
      .from(billingCodes)
      .where(and(scope, eq(billingCodes.kind, kind), inArray(billingCodes.utbmsCodeId, clean))),
  );
  return new Set(rows.flatMap((row) => row.utbmsCodeId ? [row.utbmsCodeId] : []));
}

export async function findExistingCodes(lawFirmId: string, tableName: string, codes: unknown[]) {
  if (!codes.length) return new Set<string>();
  const kind = adoptionKind(tableName);
  const upper = codes.map((code) => String(code).toUpperCase());
  const rows = await tenantQuery(
    billingCodes,
    lawFirmId,
    ({ executor, scope }) => executor
      .select({ code: billingCodes.code })
      .from(billingCodes)
      .where(and(scope, eq(billingCodes.kind, kind), inArray(sql`upper(${billingCodes.code})`, upper))),
  );
  return new Set(rows.map((row) => row.code.toUpperCase()));
}

export async function getMaxSortOrder(lawFirmId: string, tableName: string) {
  if (tableName === 'courts') {
    const rows = await tenantQuery(
      courts,
      lawFirmId,
      ({ executor, scope }) => executor
        .select({ maximum: max(courts.sortOrder) })
        .from(courts)
        .where(scope),
    );
    return rows[0]?.maximum || 0;
  }
  const kind = adoptionKind(tableName);
  const rows = await tenantQuery(
    billingCodes,
    lawFirmId,
    ({ executor, scope }) => executor
      .select({ maximum: max(billingCodes.sortOrder) })
      .from(billingCodes)
      .where(and(scope, eq(billingCodes.kind, kind))),
  );
  return rows[0]?.maximum || 0;
}
