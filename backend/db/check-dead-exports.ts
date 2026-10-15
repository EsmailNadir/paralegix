/**
 * Ratchet for exports nothing outside their own file mentions.
 *
 * `ts-prune` alone is useless here and dangerously so: it follows ES imports,
 * and most of this tree reaches its services through `require()`. Run bare, it
 * calls about 1,500 exports dead, nearly all of which are live routes. Acting on
 * that list would delete the application.
 *
 * So this takes ts-prune's list only as CANDIDATES and confirms each one by
 * looking for the identifier anywhere else under `src/`, `tests/`, `db/` and
 * `scripts/`. A name destructured from a `require()`, referenced in a test, or
 * named in a string still counts as used. What survives both passes is an export
 * with no reader by any route.
 *
 * The generated Drizzle schema is exempt: it describes the whole database, so a
 * table no repository has needed yet is correct rather than dead.
 *
 * Usage:
 *   npx tsx db/check-dead-exports.ts
 *   npx tsx db/check-dead-exports.ts --list
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BACKEND_DIR = path.join(__dirname, '..');
const ROOTS = ['src', 'tests', 'db', 'scripts'];
const EXEMPT = ['src/shared/database/drizzle/schema.ts'];
const BASELINE = 0;
const args = new Set(process.argv.slice(2));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walk(absolute));
    } else if (entry.name.endsWith('.ts')) {
      out.push(path.relative(BACKEND_DIR, absolute));
    }
  }
  return out;
}

function candidates(): { file: string; name: string }[] {
  // ts-prune prints `path:line - name`, and marks a same-file use itself.
  const raw = execFileSync('npx', ['ts-prune', '-p', 'tsconfig.json'], {
    cwd: BACKEND_DIR, encoding: 'utf8', maxBuffer: 1 << 26,
  });
  return raw.split('\n')
    .filter((line) => line.trim() && !line.includes('(used in module)'))
    .map((line) => {
      const [location, name] = line.split(' - ');
      return { file: location.split(':')[0], name: (name || '').trim() };
    })
    .filter(({ file, name }) => name && !EXEMPT.includes(file));
}

const files = ROOTS.filter((r) => fs.existsSync(path.join(BACKEND_DIR, r)))
  .flatMap((r) => walk(path.join(BACKEND_DIR, r)));
const identifiers = new Map<string, Set<string>>();
for (const file of files) {
  const body = fs.readFileSync(path.join(BACKEND_DIR, file), 'utf8');
  identifiers.set(file, new Set(body.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []));
}

const dead = candidates().filter(({ file, name }) =>
  !files.some((other) => other !== file && identifiers.get(other)!.has(name)));

if (args.has('--list') || dead.length > BASELINE) {
  for (const { file, name } of dead) console.log(`${file} - ${name}`);
}
if (dead.length > BASELINE) {
  console.error(
    `\n[dead-exports] FAIL: ${dead.length} export(s) have no reader, baseline ${BASELINE}.`
    + '\n[dead-exports] Delete them, or wire them up if the caller is what is missing.'
    + '\n[dead-exports] An uncalled export is not automatically dead: check whether it is a UI gap first.',
  );
  process.exit(1);
}
console.log(`[dead-exports] OK: 0 exports without a reader, at baseline (${files.length} files scanned).`);

export {};
