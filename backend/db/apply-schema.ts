/**
 * Apply backend/db/schema.sql to the database in DATABASE_URL.
 *
 *   npx tsx backend/db/apply-schema.ts            # create everything (idempotent)
 *   npx tsx backend/db/apply-schema.ts --reset --confirm-local-reset
 *                                                  # DROP local only (DANGER)
 *   DB_TARGET=staging npx tsx backend/db/apply-schema.ts --allow-nonlocal-create
 *                                                  # fresh nonlocal DB only
 *
 * Loads env from backend/.env.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');
const { resolveDbUrl, needsSsl } = require('../src/shared/database/resolveDbUrl');

const RESET = process.argv.includes('--reset');
const CONFIRM_LOCAL_RESET = process.argv.includes('--confirm-local-reset');
const ALLOW_NONLOCAL_CREATE = process.argv.includes('--allow-nonlocal-create');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);

function assertTargetIsAllowed(connectionString: string) {
  const target = String(process.env.DB_TARGET || '').toLowerCase();
  let hostname = '';
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    throw new Error('Schema apply refused: the resolved database URL could not be validated.');
  }

  if (!target) {
    throw new Error('Schema apply requires an explicit DB_TARGET; fallback DATABASE_URL is not accepted.');
  }
  if (RESET && (target !== 'local' || !LOCAL_HOSTS.has(hostname) || !CONFIRM_LOCAL_RESET)) {
    throw new Error(
      '--reset refused. It requires DB_TARGET=local, a local database host, and '
      + '--confirm-local-reset. Staging and production resets are forbidden.',
    );
  }
  if (!RESET && target !== 'local' && !ALLOW_NONLOCAL_CREATE) {
    throw new Error(
      `Schema apply to DB_TARGET=${target} requires --allow-nonlocal-create and is only for creating a fresh database. `
      + 'Upgrade an existing database with numbered migrations.',
    );
  }
  if (!RESET && target === 'local' && !LOCAL_HOSTS.has(hostname)) {
    throw new Error('DB_TARGET=local resolved to a nonlocal host; schema apply refused.');
  }
}

async function main() {
  const connectionString = resolveDbUrl();
  if (!connectionString) {
    console.error('No database URL resolved (DB_TARGET / DATABASE_URL in backend/.env).');
    process.exit(1);
  }
  assertTargetIsAllowed(connectionString);

  const client = new Client({
    connectionString,
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined, // hosted Supabase requires TLS; local does not
  });
  await client.connect();
  console.log(`Connected (DB_TARGET=${process.env.DB_TARGET || 'default'}).`);

  try {
    if (RESET) {
      console.log('--reset: dropping and recreating the public schema …');
      await client.query('drop schema if exists public cascade; create schema public;');
    }

    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    console.log('Applying schema.sql …');
    await client.query(sql);

    const { rows } = await client.query(
      `select count(*)::int as n from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`
    );
    console.log(`Done. ${rows[0].n} tables now exist in public.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nSCHEMA APPLY FAILED:', err.message);
  if (err.position) console.error('  at SQL position', err.position);
  process.exit(1);
});

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
