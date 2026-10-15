import {
  privilegedParameterizedQuery,
  rootQueryExecutor,
  withDrizzleTransaction,
  type DrizzleExecutor,
} from './queryContext';

const FINANCIAL_QUERY_REASON =
  'financial access is scoped by the authorized billing or trust repository entry point';

export function financialRootSql(text: string, params: unknown[] = []) {
  return privilegedParameterizedQuery(FINANCIAL_QUERY_REASON, text, params);
}

export function financialSql(
  executor: DrizzleExecutor,
  text: string,
  params: unknown[] = [],
) {
  return privilegedParameterizedQuery(FINANCIAL_QUERY_REASON, text, params, executor);
}

export { rootQueryExecutor, withDrizzleTransaction };
