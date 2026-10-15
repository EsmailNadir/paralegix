/**
 * Fails if the number of .js files in the backend has increased.
 *
 * A part-converted codebase is worse than either end state: two idioms, two sets
 * of conventions, and no forcing function to finish. This is that forcing
 * function. It is a cheap script
 * the build runs, not a linter plugin.
 *
 * Lower the baseline as files convert. Raising it requires a deliberate edit and
 * shows up in review, which is the point.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const BASELINE_FILE = path.join(__dirname, 'js-file-baseline.json');

// This counted src/ alone until db/ and scripts/ were converted, which is how 25
// .js files sat outside the ratchet for the whole migration without it noticing.
// Every directory holding hand-written backend code belongs here.
const WATCHED = ['src', 'db', 'scripts', 'tests'];

const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).count;

const out = execFileSync('find', [...WATCHED, '-name', '*.js', '-type', 'f'], {
  cwd: BACKEND_DIR,
  encoding: 'utf8',
});
const count = out.trim().split('\n').filter(Boolean).length;

const where = WATCHED.map((d) => `${d}/`).join(', ');

if (count > baseline) {
  console.error(
    `[js-ratchet] FAIL: ${count} .js files under ${where}, baseline is ${baseline}.\n`
    + 'A new .js file was added. Write it in TypeScript, or raise the baseline\n'
    + 'deliberately in db/js-file-baseline.json if a .js file was genuinely required.\n'
    + 'Offenders:\n'
    + out.trim().split('\n').filter(Boolean).map((f: string) => `  ${f}`).join('\n')
  );
  process.exit(1);
}

if (count < baseline) {
  console.log(`[js-ratchet] ${count} .js files (baseline ${baseline}). Lower the baseline to lock in the progress.`);
} else {
  console.log(`[js-ratchet] OK: ${count} .js files under ${where}, at baseline.`);
}

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
