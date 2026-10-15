/**
 * Resolve which Postgres connection string to use based on the DB_TARGET env var.
 *
 *   DB_TARGET=local   -> DATABASE_URL_LOCAL
 *   DB_TARGET=staging -> DATABASE_URL_STAGING
 *   DB_TARGET=prod    -> DATABASE_URL_PROD
 *
 * When DB_TARGET is unset (or the target-specific var is empty), falls back to
 * plain DATABASE_URL so existing setups and the db/*.js scripts keep working.
 */
export function resolveDbUrl() {
  const target = (process.env.DB_TARGET || '').trim().toUpperCase();
  if (target) {
    const key = `DATABASE_URL_${target}`;
    if (process.env[key]) return process.env[key];
    console.warn(`[db] DB_TARGET=${target.toLowerCase()} but ${key} is empty; falling back to DATABASE_URL.`);
  }
  return process.env.DATABASE_URL;
}

/** True when the connection string points at a hosted Supabase instance (needs TLS). */
export function needsSsl(connectionString: string | undefined): boolean {
  return !!connectionString && connectionString.includes('supabase');
}
