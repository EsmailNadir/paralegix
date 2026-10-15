import { eq, getTableName, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable, TableConfig } from 'drizzle-orm/pg-core';
import { db, type DrizzleExecutor } from './drizzleClient';
import { restorePgTypes } from './pgTypeRestore';

export type { DrizzleExecutor } from './drizzleClient';
export type Scopable = PgTable<TableConfig> & { lawFirmId: PgColumn };
export type FirmRootTable = PgTable<TableConfig> & { id: PgColumn };
export const rootQueryExecutor: DrizzleExecutor = db;

/** Transaction callbacks receive the same executor type every scoped helper accepts. */
export function withDrizzleTransaction<TResult>(
  work: (transaction: DrizzleExecutor) => Promise<TResult>,
  executor: DrizzleExecutor = db,
): Promise<TResult> {
  return executor.transaction((transaction) => work(transaction));
}

type CompiledQuery = { sql: string; params: unknown[] };
type AuditedQuery<TResult> = {
  toSQL?: () => CompiledQuery;
  getQuery?: () => CompiledQuery;
  execute(): Promise<TResult>;
};

function compileAuditedQuery<TResult>(query: AuditedQuery<TResult>): CompiledQuery {
  if (query.toSQL) return query.toSQL();
  if (query.getQuery) return query.getQuery();
  throw new Error('Audited Drizzle query does not expose compiled SQL.');
}

/**
 * Preserve an existing, planner-sensitive SQL statement while moving its
 * parameter binding and execution onto Drizzle. Positional placeholders are
 * converted to Drizzle parameters (including repeated and array parameters),
 * so values never pass through sql.raw().
 *
 * Placeholder scanning skips `--` line comments, `/* *\/` block comments, and
 * `'...'` string literals, matching Postgres's own lexer. Without this, a
 * comment or literal that merely contains `$`-then-digits (e.g. a code
 * comment mentioning "$13/$14", or "$0 rows") is misread as a real bind
 * parameter, desyncing the driver's parameter count from what Postgres
 * itself parses.
 */
export function parameterizedSql(text: string, params: unknown[] = []): SQL {
  const query = sql.empty();
  let cursor = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '-' && text[i + 1] === '-') {
      const newline = text.indexOf('\n', i);
      i = newline === -1 ? text.length : newline + 1;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (text[i] === "'") {
      i += 1;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (text[i] === '$' && /[0-9]/.test(text[i + 1] ?? '')) {
      const start = i;
      let end = i + 1;
      while (end < text.length && /[0-9]/.test(text[end])) end += 1;
      query.append(sql.raw(text.slice(cursor, start)));
      const placeholderText = text.slice(start, end);
      const index = Number(text.slice(start + 1, end)) - 1;
      if (index < 0 || index >= params.length) {
        throw new Error(`SQL placeholder ${placeholderText} has no bound parameter.`);
      }
      query.append(sql`${sql.param(params[index])}`);
      cursor = end;
      i = end;
      continue;
    }
    i += 1;
  }
  query.append(sql.raw(text.slice(cursor)));
  return query;
}

/** Tenant-audited execution for a complex positional SQL statement. */
export async function tenantParameterizedQuery(
  table: Scopable,
  lawFirmId: string,
  text: string,
  params: unknown[],
  alias = getTableName(table),
  executor: DrizzleExecutor = db,
) {
  requireNonEmpty(lawFirmId, 'tenantParameterizedQuery lawFirmId');
  const query = executor.execute(parameterizedSql(text, params));
  const compiled = compileAuditedQuery(query);
  const parameterIndex = namedScopeParameterIndex(compiled, alias, table.lawFirmId.name);
  if (parameterIndex === null || compiled.params[parameterIndex] !== lawFirmId) {
    throw new Error(`Tenant SQL for ${getTableName(table)} alias ${alias} lost its tenant predicate.`);
  }
  return restorePgTypes(await query.execute());
}

interface ScopedBuildContext {
  executor: DrizzleExecutor;
  /** The mandatory tenant predicate. The wrapper verifies it survived into SQL. */
  scope: SQL;
}

export type SystemQueryCapability =
  | 'audit_log'
  | 'auth_identity'
  | 'catalog'
  | 'event_outbox'
  | 'oauth_state'
  | 'platform_admin'
  | 'privacy_erasure'
  | 'rate_limit'
  | 'scheduler'
  | 'stripe_idempotency'
  | 'tenant_provisioning';

function requireNonEmpty(value: string, label: string) {
  if (!value) throw new Error(`${label} is required`);
}

function scopeParameterIndex(
  compiled: CompiledQuery,
  table: PgTable<TableConfig>,
  column: PgColumn,
): number | null {
  return namedScopeParameterIndex(compiled, getTableName(table), column.name);
}

function namedScopeParameterIndex(
  compiled: CompiledQuery,
  relation: string,
  column: string,
): number | null {
  const tableName = relation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const columnName = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const predicate = new RegExp(
    `\\bwhere\\b[\\s\\S]*?"?${tableName}"?\\."?${columnName}"?\\s*=\\s*\\$(\\d+)`,
    'i',
  );
  const match = compiled.sql.match(predicate);
  return match ? Number(match[1]) - 1 : null;
}

function assertTenantPredicate(compiled: CompiledQuery, table: Scopable, lawFirmId: string) {
  const parameterIndex = scopeParameterIndex(compiled, table, table.lawFirmId);
  if (parameterIndex === null || compiled.params[parameterIndex] !== lawFirmId) {
    throw new Error(
      `Tenant query for ${getTableName(table)} lost its law_firm_id predicate. `
      + 'Build the query with the supplied scope expression.',
    );
  }
}

/** The law_firms row is tenant-scoped by its own primary key. */
export async function firmQuery<TResult>(
  table: FirmRootTable,
  lawFirmId: string,
  build: (context: ScopedBuildContext) => AuditedQuery<TResult>,
  executor: DrizzleExecutor = db,
): Promise<TResult> {
  requireNonEmpty(lawFirmId, 'firmQuery lawFirmId');
  const query = build({ executor, scope: eq(table.id, lawFirmId) });
  const compiled = compileAuditedQuery(query);
  const parameterIndex = scopeParameterIndex(compiled, table, table.id);
  if (parameterIndex === null || compiled.params[parameterIndex] !== lawFirmId) {
    throw new Error('Firm-root query lost its law_firms.id tenant predicate.');
  }
  return query.execute();
}

/**
 * Build and execute an arbitrary Drizzle read whose base/parent table carries
 * law_firm_id. The callback can add joins, CTEs, aggregates, ordering and
 * pagination; execution is refused if the supplied tenant predicate did not
 * survive into the emitted SQL with the expected bound value.
 */
export async function tenantQuery<TResult>(
  table: Scopable,
  lawFirmId: string,
  build: (context: ScopedBuildContext) => AuditedQuery<TResult>,
  executor: DrizzleExecutor = db,
): Promise<TResult> {
  requireNonEmpty(lawFirmId, 'tenantQuery lawFirmId');
  const query = build({ executor, scope: eq(table.lawFirmId, lawFirmId) });
  const compiled = compileAuditedQuery(query);
  assertTenantPredicate(compiled, table, lawFirmId);
  return query.execute();
}

/**
 * Tenant-audited escape hatch for a complex Drizzle SQL template whose base
 * table uses a fixed SQL alias. This retains bound parameters and the same
 * tenant-predicate verification while allowing physical query shapes (lateral
 * joins, planner-sensitive UNIONs) that the fluent builder cannot express
 * without obscuring their intent.
 */
export async function tenantAliasedQuery<TResult>(
  table: Scopable,
  lawFirmId: string,
  alias: string,
  build: (context: ScopedBuildContext) => AuditedQuery<TResult>,
): Promise<TResult> {
  requireNonEmpty(lawFirmId, 'tenantAliasedQuery lawFirmId');
  requireNonEmpty(alias, 'tenantAliasedQuery alias');
  const scope = sql`${sql.identifier(alias)}.${sql.identifier(table.lawFirmId.name)} = ${lawFirmId}`;
  const query = build({ executor: db, scope });
  const compiled = compileAuditedQuery(query);
  const parameterIndex = namedScopeParameterIndex(compiled, alias, table.lawFirmId.name);
  if (parameterIndex === null || compiled.params[parameterIndex] !== lawFirmId) {
    throw new Error(`Tenant query for ${getTableName(table)} alias ${alias} lost its tenant predicate.`);
  }
  return query.execute();
}


/**
 * Explicit path for genuinely global infrastructure/identity data. The named
 * capability makes an unscoped query searchable and reviewable; there is no
 * generic `unscopedQuery()` helper.
 */
export async function systemQuery<TResult>(
  capability: SystemQueryCapability,
  build: (executor: DrizzleExecutor) => AuditedQuery<TResult>,
  executor: DrizzleExecutor = db,
): Promise<TResult> {
  requireNonEmpty(capability, 'systemQuery capability');
  return build(executor).execute();
}

/** Explicit privileged cross-tenant path. Permission checks stay at the caller. */
export async function adminQuery<TResult>(
  reason: string,
  build: (executor: DrizzleExecutor) => AuditedQuery<TResult>,
  executor: DrizzleExecutor = db,
): Promise<TResult> {
  requireNonEmpty(reason, 'adminQuery reason');
  return build(executor).execute();
}

/** Parameterized SQL for a reviewed privileged path that cannot use tenantQuery yet. */
export function privilegedParameterizedQuery(
  reason: string,
  text: string,
  params: unknown[] = [],
  executor: DrizzleExecutor = db,
) {
  return adminQuery(
    reason,
    (queryExecutor) => queryExecutor.execute(parameterizedSql(text, params)),
    executor,
  ).then(restorePgTypes);
}

/**
 * Public reads/writes scoped by an unguessable token. Verify the token is a
 * bound parameter in the emitted query so a caller cannot accidentally build a
 * table-wide operation through this capability.
 */
export async function tokenQuery<TResult>(
  token: string,
  build: (executor: DrizzleExecutor) => AuditedQuery<TResult>,
  executor: DrizzleExecutor = db,
): Promise<TResult> {
  requireNonEmpty(token, 'tokenQuery token');
  const query = build(executor);
  const compiled = compileAuditedQuery(query);
  if (!compiled.params.includes(token)) {
    throw new Error('tokenQuery refused a query that does not bind the supplied token.');
  }
  return query.execute();
}
