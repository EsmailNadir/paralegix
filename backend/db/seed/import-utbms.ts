/**
 * Seed/refresh the global utbms_codes catalog from db/seed/utbms-codes.json.
 *
 *   npx tsx backend/db/seed/import-utbms.ts
 *   DB_TARGET=staging npx tsx backend/db/seed/import-utbms.ts
 *
 * The database is chosen the same way the server chooses it: DB_TARGET selects
 * DATABASE_URL_LOCAL / _STAGING / _PROD, falling back to DATABASE_URL.
 *
 * Idempotent: upserts on the unique `code`. Safe to re-run after editing the
 * JSON. Loads env from backend/.env. The utbms_codes table is global (no
 * law_firm_id) — this is the only writer.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Client } = require('pg');
const { resolveDbUrl, needsSsl } = require('../../src/shared/database/resolveDbUrl');

async function main() {
  const connectionString = resolveDbUrl();
  if (!connectionString) {
    console.error('No database URL: set DB_TARGET and DATABASE_URL_<TARGET>, or DATABASE_URL (backend/.env).');
    process.exit(1);
  }

  const raw = fs.readFileSync(path.join(__dirname, 'utbms-codes.json'), 'utf8');
  const { codes } = JSON.parse(raw);
  if (!Array.isArray(codes) || !codes.length) {
    console.error('utbms-codes.json has no codes.');
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  console.log(`Connected. Upserting ${codes.length} UTBMS codes …`);

  try {
    let inserted = 0;
    let updated = 0;
    for (const c of codes) {
      const { rows } = await client.query(
        `insert into utbms_codes (code, name, code_type, practice_set, is_active)
           values ($1, $2, $3, $4, true)
         on conflict (code) do update
           set name = excluded.name,
               code_type = excluded.code_type,
               practice_set = excluded.practice_set,
               is_active = true
         returning (xmax = 0) as is_insert`,
        [c.code, c.name, c.code_type, c.practice_set || null]
      );
      if (rows[0].is_insert) inserted++; else updated++;
    }
    console.log(`Done. ${inserted} inserted, ${updated} updated.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nUTBMS IMPORT FAILED:', err.message);
  process.exit(1);
});

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
