/**
 * Re-sync built-in role permissions to their current canonical definitions.
 *
 * RBAC was disabled during the Postgres migration, so existing firms' built-in
 * roles were seeded against an OLDER permission set (e.g. Admin = 42 perms,
 * missing the trust / templates / etc. permissions added later). With RBAC now
 * restored (TD1), those stale
 * definitions would 403 admins/attorneys out of newer features. Because RBAC was
 * off, nobody meaningfully customized roles — so resetting built-in roles to the
 * canonical BUILT_IN_ROLES permissions is safe and prevents lockout.
 *
 * Custom (non-built-in) roles are left untouched. Idempotent — safe to re-run.
 * Run BEFORE/at the same time RBAC is re-enabled (and on prod cutover):
 *   npx tsx backend/scripts/resync-builtin-roles.ts
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { pool } = require('../src/shared/database/db');
const { BUILT_IN_ROLES } = require('../src/modules/lawfirms/roles/permissions');

(async () => {
  let updated = 0;
  for (const def of Object.values(BUILT_IN_ROLES) as any[]) {
    const { rowCount } = await pool.query(
      `update roles set permissions = $1, updated_at = now()
        where is_built_in = true and name = $2
          and permissions is distinct from $1`,
      [def.permissions, def.name]
    );
    console.log(`  ${def.name}: ${rowCount} role(s) updated -> ${def.permissions.length} perms`);
    updated += rowCount;
  }
  console.log(`\nOK re-synced ${updated} built-in role row(s) to canonical permissions.`);
  await pool.end();
})().catch(async (e) => { console.error('FAIL', e.message); try { await pool.end(); } catch (_) {} process.exit(1); });

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
