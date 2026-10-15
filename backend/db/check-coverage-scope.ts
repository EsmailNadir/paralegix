/**
 * Guard: prove the backend coverage denominator has not been silently narrowed.
 *
 * `jest.config.js`'s `collectCoverageFrom` is what makes an UNIMPORTED file (one no spec ever
 * requires) show up in a coverage report at 0% instead of being invisible to it. The B00.2
 * baseline in the test-expansion plan measured this once by hand and recorded three files that
 * prove it (`src/server.ts`, `src/document-worker.ts`, `src/shared/database/firebase.ts`), but
 * that was a one-time manual check, not something CI re-verifies. A later edit to
 * `collectCoverageFrom` -- adding `'!src/modules/whatever/**'` to make a hard-to-test module stop
 * dragging the percentage down, say -- would shrink the denominator, and every subsequently
 * measured "percentage covered" would go up with no test written and no coverage actually gained.
 * A coverage floor set against a silently narrowed denominator (B12.1) enforces nothing.
 *
 * This script re-derives "the documented scope" independently of jest.config.js (so an edit to
 * that file's excludes cannot also edit what this script expects), runs a real, cheap, no-DB
 * coverage pass through the SAME jest config CI uses, and diffs the two file lists. Any file this
 * script expects that the report does not contain has fallen out of the denominator. Any file the
 * report contains that this script does not expect means the scope grew and this script's own
 * exception list needs a deliberate update.
 *
 *   npx tsx db/check-coverage-scope.ts   (exit 1 on drift)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const BACKEND_DIR = path.join(__dirname, '..');
const SRC = path.join(BACKEND_DIR, 'src');

// A cheap, pure-function, no-DB spec (see the "Pure-function specs" note in
// .claude/rules/backend-tests.md) --
// chosen only to make Jest instrument the app once. `collectCoverageFrom` puts every matching
// source file in the report regardless of which spec runs, so the anchor test's own behavior is
// irrelevant; it only needs to exist and pass quickly.
const ANCHOR_TEST = 'tests/shared/searchTerm.test.ts';

// Restates, independently, the scope documented in the B00.2 coverage baseline: "all of
// src/**/*.ts minus declarations and the generated Drizzle schema". Deliberately NOT read from
// jest.config.js -- the whole point is to notice when that file's own excludes drift from this.
//
// Native V8 coverage also reports comment-only files, so the denominator
// includes every source TypeScript file except declarations and the generated schema.
const EXCLUDED_EXACT = new Set([
  'src/shared/database/drizzle/schema.ts',
]);
function isExcluded(relPath: string): boolean {
  return relPath.endsWith('.d.ts') || EXCLUDED_EXACT.has(relPath);
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
}

const allTsFiles: string[] = [];
walk(SRC, allTsFiles);

const expected = new Set(
  allTsFiles
    .map((f) => path.relative(BACKEND_DIR, f).split(path.sep).join('/'))
    .filter((rel) => !isExcluded(rel))
);

if (expected.size === 0) {
  console.error('[coverage-scope] FAIL: independent src/ walk found zero .ts files. Broken guard, not a real result.');
  process.exit(1);
}

const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plx-coverage-scope-'));

try {
  // Jest's own entry point under the current node binary, not `npx`. execFileSync
  // does not consult PATHEXT, so on Windows the bare name is ENOENT and the
  // `.cmd` shim is EINVAL (Node 20+); running the script directly needs no shell
  // and behaves identically on every platform.
  execFileSync(
    process.execPath,
    [
      path.join(BACKEND_DIR, 'node_modules', 'jest', 'bin', 'jest.js'),
      '--selectProjects', 'unit',
      '--coverage',
      '--coverageReporters=json-summary',
      `--coverageDirectory=${covDir}`,
      '--testPathPatterns', ANCHOR_TEST,
    ],
    { cwd: BACKEND_DIR, stdio: 'pipe', encoding: 'utf8' }
  );
} catch (err: any) {
  console.error('[coverage-scope] FAIL: the anchor coverage run itself failed.');
  console.error(`Anchor test: ${ANCHOR_TEST}. If it moved or was deleted, point ANCHOR_TEST at another`);
  console.error('fast, no-DB spec (.claude/rules/backend-tests.md calls these "pure-function specs").');
  console.error(err.stdout || err.message);
  process.exit(1);
}

const summaryPath = path.join(covDir, 'coverage-summary.json');
if (!fs.existsSync(summaryPath)) {
  console.error(`[coverage-scope] FAIL: ${summaryPath} was not written. --coverageReporters=json-summary`);
  console.error('may have been dropped from the invocation, or Jest ran the wrong project.');
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const reported = new Set(
  Object.keys(summary)
    .filter((k) => k !== 'total')
    .map((abs) => path.relative(BACKEND_DIR, abs).split(path.sep).join('/'))
);

fs.rmSync(covDir, { recursive: true, force: true });

const missing = [...expected].filter((f) => !reported.has(f)).sort();
const unexpected = [...reported].filter((f) => !expected.has(f)).sort();

if (missing.length > 0) {
  console.error(
    `[coverage-scope] FAIL: ${missing.length} source file(s) expected in the coverage denominator\n`
    + 'are absent from the report. Either collectCoverageFrom in jest.config.js gained a new\n'
    + 'exclusion, or one of these files was deleted without updating this guard. A file missing\n'
    + 'from the denominator cannot be caught by any coverage floor, and every percentage computed\n'
    + 'without it is inflated relative to what B00.2 documented.\n'
    + 'Missing:\n'
    + missing.map((f) => `  ${f}`).join('\n')
  );
  process.exit(1);
}

if (unexpected.length > 0) {
  console.error(
    `[coverage-scope] FAIL: ${unexpected.length} file(s) appear in the coverage report that this\n`
    + 'guard did not expect. Either jest.config.js\'s collectCoverageFrom widened (e.g. stopped\n'
    + 'excluding the generated Drizzle schema, or started matching outside src/), or this script\'s\n'
    + 'own EXCLUDED_EXACT list is stale after a deliberate scope change. Update whichever one is\n'
    + 'wrong -- silently, this would mean an intentionally-excluded file (like the 186KB generated\n'
    + 'Drizzle schema) started dragging coverage percentages around for no test-writing reason.\n'
    + 'Unexpected:\n'
    + unexpected.map((f) => `  ${f}`).join('\n')
  );
  process.exit(1);
}

console.log(`[coverage-scope] OK: ${expected.size} source files match the coverage report 1:1. Denominator is not narrowed.`);

export {};
