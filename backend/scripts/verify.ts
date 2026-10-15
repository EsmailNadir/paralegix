// Quick schema sanity check against DATABASE_URL.
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
  const gen = await c.query("select table_name, column_name from information_schema.columns where is_generated='ALWAYS' order by 1,2");
  const rls = await c.query("select relname from pg_class where relrowsecurity = true and relnamespace = 'public'::regnamespace order by 1");
  const trg = await c.query("select tgname, relname from pg_trigger t join pg_class r on t.tgrelid = r.oid where not tgisinternal and relname in ('trust_transactions','invoices','cases') order by 2,1");
  const fk = await c.query("select count(*)::int n from pg_constraint where contype='f' and connamespace='public'::regnamespace");
  const tbl = await c.query("select count(*)::int n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'");
  console.log('Tables:', tbl.rows[0].n);
  console.log('Generated columns:');
  gen.rows.forEach((r: any) => console.log('  ' + r.table_name + '.' + r.column_name));
  console.log('RLS enabled on:', rls.rows.map((r: any) => r.relname).join(', ') || '(none)');
  console.log('Triggers:', trg.rows.map((r: any) => r.tgname + '@' + r.relname).join(', '));
  console.log('Foreign keys total:', fk.rows[0].n);
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
