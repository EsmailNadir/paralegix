/**
 * Regenerate the introspected Drizzle schema from an explicit non-production
 * database target and fail if the checked-in representation changes.
 *
 * `db:pull` rewrites src/shared/database/drizzle/schema.ts, so the script reads
 * the file first, compares, and always writes the original contents back; run it
 * only with a fully migrated local or staging database.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = String(process.env.DB_TARGET || '').toLowerCase();
if (!['local', 'staging'].includes(target)) {
  console.error('db:drift requires explicit DB_TARGET=local or DB_TARGET=staging; production is forbidden.');
  process.exit(1);
}

// npm ships as npm.cmd on Windows, where spawnSync neither resolves PATHEXT the
// way a shell does (bare `npm` gives ENOENT) nor executes a batch file directly
// since Node 20 (`npm.cmd` gives EINVAL). The command is passed as one string
// rather than command-plus-args because the args form under `shell` concatenates
// without escaping, which Node deprecated in DEP0190. Every command here is a
// literal, so there is nothing for the shell to interpolate.
function runShell(commandLine: string): number {
  const result = spawnSync(commandLine, { cwd: process.cwd(), env: process.env, stdio: 'inherit', shell: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// The first lines that differ, positionally, so a failing check names what the
// regeneration would have changed without dumping the whole file.
function describeDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < 20; i += 1) {
    if (a[i] === b[i]) continue;
    out.push(`  line ${i + 1}:`);
    if (a[i] !== undefined) out.push(`    - ${a[i]}`);
    if (b[i] !== undefined) out.push(`    + ${b[i]}`);
  }
  return out.join('\n');
}

const schemaPath = resolve(process.cwd(), 'src/shared/database/drizzle/schema.ts');
const before = readFileSync(schemaPath, 'utf8');
let pullStatus = 0;
let after = before;
try {
  pullStatus = runShell('npm run db:pull');
  after = readFileSync(schemaPath, 'utf8');
} finally {
  // db:pull overwrites the working-tree file. Put the original back whether the
  // check passes or fails, so a failed check never leaves a rewritten schema.
  writeFileSync(schemaPath, before);
}
if (pullStatus !== 0) process.exit(pullStatus);
if (after !== before) {
  console.error(`[drizzle-drift] FAIL: regenerating from DB_TARGET=${target} changed the working-tree schema (file restored).`);
  console.error(describeDiff(before, after));
  process.exit(1);
}
console.log(`[drizzle-drift] OK: working-tree schema matches DB_TARGET=${target}.`);
