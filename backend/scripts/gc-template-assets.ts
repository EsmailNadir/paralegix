/**
 * Maintenance: reconcile orphaned template GCS objects.
 *
 * deleteTemplate / deleteTemplateAsset are best-effort and swallow GCS
 * failures, so objects under lawfirmids/{firm}/templates/ can be left behind
 * with no live template row referencing them. This script lists those objects
 * and (optionally) deletes the orphans.
 *
 * Usage:
 *   npx tsx backend/scripts/gc-template-assets.ts                 # dry-run, all firms (default)
 *   npx tsx backend/scripts/gc-template-assets.ts --delete        # actually delete orphans, all firms
 *   npx tsx backend/scripts/gc-template-assets.ts --firm <id>     # restrict to one firm
 *   npx tsx backend/scripts/gc-template-assets.ts --firm <id> --delete
 *
 * SAFE BY DEFAULT: without --delete nothing is removed; it only reports what
 * would be deleted. An object is only ever deleted when no live row references
 * its exact path.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { pool } = require('../src/shared/database/db');
const templatesService = require('../src/modules/templates/templates.service');

function parseArgs(argv: any) {
  const args = { delete: false, firm: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--delete') args.delete = true;
    else if (argv[i] === '--firm') { args.firm = argv[i + 1]; i += 1; }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !args.delete;
  console.log(`templates GC sweep — mode: ${dryRun ? 'DRY-RUN (no deletes)' : 'DELETE'}`);

  let results;
  if (args.firm) {
    results = [await templatesService.gcSweepLawFirm(args.firm, { dryRun })];
  } else {
    results = await templatesService.gcSweep({ dryRun });
  }

  let totalScanned = 0;
  let totalOrphans = 0;
  let totalDeleted = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`  firm ${r.lawFirmId}: ERROR ${r.error}`);
      continue;
    }
    totalScanned += r.scanned || 0;
    totalOrphans += r.orphanCount || 0;
    totalDeleted += r.deleted || 0;
    console.log(
      `  firm ${r.lawFirmId}: scanned=${r.scanned} referenced=${r.referenced} ` +
      `orphans=${r.orphanCount} deleted=${r.deleted}`
    );
    for (const orphan of r.orphans || []) {
      console.log(`      ${dryRun ? '[would delete]' : '[deleted]'} ${orphan}`);
    }
    for (const e of r.errors || []) {
      console.log(`      [delete failed] ${e.objectPath}: ${e.message}`);
    }
  }

  console.log(
    `\nTotals — firms: ${results.length}, scanned: ${totalScanned}, ` +
    `orphans: ${totalOrphans}, deleted: ${totalDeleted}` +
    (dryRun ? '  (re-run with --delete to remove orphans)' : '')
  );

  await pool.end();
  console.log('OK templates GC sweep complete.');
})().catch(async (e) => {
  console.error('FAIL', e.stack || e.message);
  try { await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
