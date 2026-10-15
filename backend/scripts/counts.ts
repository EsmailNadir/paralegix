// Print row counts for every public table (validation / live progress check).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');
// DB_TARGET picks DATABASE_URL_LOCAL / _STAGING / _PROD, falling back to DATABASE_URL,
// the same way the server does. TLS only for a hosted database.
const { resolveDbUrl, needsSsl } = require('../src/shared/database/resolveDbUrl');

(async () => {
  const connectionString = resolveDbUrl();
  if (!connectionString) { console.error('No database URL: set DB_TARGET and DATABASE_URL_<TARGET>, or DATABASE_URL (backend/.env).'); process.exit(1); }
  console.log(`Database: ${process.env.DB_TARGET || 'DATABASE_URL (DB_TARGET unset)'}`);
  const c = new Client({ connectionString, ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  const { rows: tables } = await c.query(
    "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1"
  );
  let total = 0;
  for (const { table_name } of tables) {
    const { rows } = await c.query(`select count(*)::int n from "${table_name}"`);
    if (rows[0].n > 0) console.log(`  ${table_name.padEnd(34)} ${rows[0].n}`);
    total += rows[0].n;
  }
  console.log(`  ${'TOTAL'.padEnd(34)} ${total}`);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
