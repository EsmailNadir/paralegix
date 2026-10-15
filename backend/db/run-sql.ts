/**
 * Apply one SQL file to the database selected by DB_TARGET.
 *
 * Numbered migrations participate in the schema_migrations ledger. New normal
 * migrations execute in the same transaction as their ledger entry. Concurrent
 * index operations are necessarily non-transactional and require an explicit
 * flag plus a single idempotent statement.
 *
 * Usage:
 *   DB_TARGET=local npx tsx backend/db/run-sql.ts backend/db/migrations/0146_example.sql
 *   DB_TARGET=local npx tsx backend/db/run-sql.ts <migration> --non-transactional
 *   DB_TARGET=local npx tsx backend/db/run-sql.ts <migration> --record-only
 *
 * Production requires --allow-prod in addition to DB_TARGET=prod. Phase E does
 * not authorize using that path; it exists so the operator tool fails closed
 * without making future production work impossible.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');
const { resolveDbUrl, needsSsl } = require('../src/shared/database/resolveDbUrl');

const args = process.argv.slice(2);
const RECORD_ONLY = args.includes('--record-only');
const NON_TRANSACTIONAL = args.includes('--non-transactional');
const ALLOW_PROD = args.includes('--allow-prod');
const ALLOW_CONTRACT = args.includes('--allow-contract');
const FORCE = args.includes('--force');
const file = args.find((arg: string) => !arg.startsWith('--'));

if (FORCE) {
  console.error('--force is no longer supported. Correct an applied migration with a new numbered migration.');
  process.exit(1);
}
if (!file) {
  console.error(
    'Usage: npx tsx backend/db/run-sql.ts <file.sql> '
    + '[--record-only | --non-transactional] [--allow-contract] [--allow-prod]',
  );
  process.exit(1);
}
if (RECORD_ONLY && NON_TRANSACTIONAL) {
  console.error('--record-only and --non-transactional are mutually exclusive.');
  process.exit(1);
}

const resolved = path.resolve(file);
if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
  console.error(`SQL file not found: ${file}`);
  process.exit(1);
}

const migrationsDir = path.resolve(__dirname, 'migrations');
const isMigration = path.dirname(resolved) === migrationsDir;
const name = path.basename(resolved);
const target = String(process.env.DB_TARGET || '').toLowerCase();

if (isMigration && !['local', 'staging', 'prod'].includes(target)) {
  console.error('Numbered migrations require an explicit DB_TARGET=local, staging, or prod.');
  process.exit(1);
}
if (target === 'prod' && !ALLOW_PROD) {
  console.error('Production SQL is disabled by default. Re-run only with separately authorized --allow-prod.');
  process.exit(1);
}

const sql = fs.readFileSync(resolved, 'utf8');
const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
const withoutComments = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

// Dollar-quoted bodies removed before any statement-level check below.
//
// A plpgsql function is one statement to Postgres, but its body is full of the
// tokens these regexes look for. `begin` after a `declare` block's trailing
// semicolon reads exactly like a transaction the migration opened for itself,
// and the semicolons between its statements split a single CREATE FUNCTION into
// a dozen apparent ones. Migration 0168 slipped through only because its
// functions happen to have no `declare` section; 0183 has one, and was refused
// with "remove BEGIN/COMMIT from the file" for a file that contains neither.
//
// The tag form (`$tag$ ... $tag$`) is matched as well as the bare `$$`, since
// nested bodies use it.
const withoutBodies = withoutComments.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1?\$/g, ' ');

const hasExplicitTransaction = /(^|;)\s*(begin|start\s+transaction|commit|rollback)\b/i.test(withoutBodies);
const concurrentIndex = /\b(create|drop)\s+index\s+concurrently\b/i.test(withoutBodies);
const statements = withoutBodies.split(';').map((part: string) => part.trim()).filter(Boolean);
const migrationMode = sql.match(/^\s*--\s*migration-mode:\s*(expand|contract)\s*$/im)?.[1];

if (NON_TRANSACTIONAL && !isMigration) {
  console.error('--non-transactional is only supported for numbered migrations.');
  process.exit(1);
}
if (concurrentIndex && !NON_TRANSACTIONAL) {
  console.error('Concurrent index migrations require --non-transactional.');
  process.exit(1);
}
if (NON_TRANSACTIONAL) {
  if (!concurrentIndex || statements.length !== 1) {
    console.error('--non-transactional requires exactly one CREATE/DROP INDEX CONCURRENTLY statement.');
    process.exit(1);
  }
  const idempotent = /\bcreate\s+index\s+concurrently\s+if\s+not\s+exists\b/i.test(withoutComments)
    || /\bdrop\s+index\s+concurrently\s+if\s+exists\b/i.test(withoutComments);
  if (!idempotent) {
    console.error('A non-transactional index migration must use IF NOT EXISTS / IF EXISTS.');
    process.exit(1);
  }
}
// Both rules used to start at 0146, because migrations 0001 to 0145 predate
// them and no database was ever going to replay those files anyway. The chain
// is collapsed into schema.sql now and the numbering restarts at 0001, so there
// is no era to except.
if (isMigration && hasExplicitTransaction) {
  console.error('New migrations must let run-sql own the transaction; remove BEGIN/COMMIT from the file.');
  process.exit(1);
}
if (isMigration && !migrationMode) {
  console.error('New migrations require a header: -- migration-mode: expand|contract');
  process.exit(1);
}
if (migrationMode === 'contract' && !ALLOW_CONTRACT) {
  console.error('Contract migrations are never applied automatically; separately authorize --allow-contract.');
  process.exit(1);
}

async function ensureLedger(client: any) {
  await client.query(`create table if not exists schema_migrations (
    name        text primary key,
    applied_at  timestamptz not null default now(),
    checksum    text
  )`);
}

async function recordMigration(client: any) {
  await client.query(
    `insert into schema_migrations (name, checksum) values ($1, $2)`,
    [name, checksum],
  );
}

async function main() {
  const connectionString = resolveDbUrl();
  if (!connectionString) throw new Error('No database URL resolved for the selected DB_TARGET.');

  const client = new Client({
    connectionString,
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  console.log(`Connected (DB_TARGET=${target || 'default'}).`);

  let transactionOpen = false;
  try {
    if (isMigration) {
      await ensureLedger(client);
      const { rows } = await client.query(
        'select applied_at, checksum from schema_migrations where name = $1',
        [name],
      );
      const applied = rows[0];
      if (applied) {
        if (!applied.checksum && RECORD_ONLY) {
          await client.query(
            'update schema_migrations set checksum = $2 where name = $1 and checksum is null',
            [name, checksum],
          );
          console.log(`RECORDED checksum for previously applied ${name}.`);
          return;
        }
        if (applied.checksum !== checksum) {
          throw new Error(
            `${name} was already applied with checksum ${applied.checksum || '<missing>'}, `
            + `but the current file is ${checksum}. Never edit/replay an applied migration; add a new one.`,
          );
        }
        console.log(`SKIPPED ${name}: already applied at ${applied.applied_at.toISOString()} (checksum matches).`);
        return;
      }
    }

    if (RECORD_ONLY) {
      if (!isMigration) throw new Error('--record-only only applies to files under db/migrations.');
      await recordMigration(client);
      console.log(`RECORDED ${name} as applied without executing it.`);
      return;
    }

    if (isMigration && !NON_TRANSACTIONAL && !hasExplicitTransaction) {
      await client.query('begin');
      transactionOpen = true;
      await client.query(sql);
      await recordMigration(client);
      await client.query('commit');
      transactionOpen = false;
    } else {
      // Historical migrations with their own BEGIN/COMMIT retain their original
      // semantics. Concurrent indexes must run outside a transaction. In both
      // cases the SQL must be idempotent because the ledger write is separate.
      await client.query(sql);
      if (isMigration) await recordMigration(client);
    }

    console.log(`Applied ${file} (${isMigration ? `ledger checksum ${checksum}` : 'ad hoc SQL'}).`);
  } catch (error) {
    if (transactionOpen) await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: any) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});

export {};
