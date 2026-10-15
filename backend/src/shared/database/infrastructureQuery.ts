import {
  privilegedParameterizedQuery,
  withDrizzleTransaction,
  type DrizzleExecutor,
} from './queryContext';

const INFRASTRUCTURE_QUERY_REASON =
  'shared infrastructure access is scoped by its authenticated caller or named system capability';

export function infrastructureRootSql(text: string, params: unknown[] = []) {
  return privilegedParameterizedQuery(INFRASTRUCTURE_QUERY_REASON, text, params);
}

export function infrastructureSql(
  executor: DrizzleExecutor,
  text: string,
  params: unknown[] = [],
) {
  return privilegedParameterizedQuery(INFRASTRUCTURE_QUERY_REASON, text, params, executor);
}

export { withDrizzleTransaction };
