#!/usr/bin/env node
/**
 * Forbids inline date comparison and day-only parsing, so every one goes through
 * `lib/utils/dateUtils.ts`.
 *
 * The backend has an ESLint rule for this (`paralegix/explicit-date-timezone`).
 * The frontend cannot reuse it: the risky pattern here depends on whether a value
 * came from a `date` column or a `timestamptz` one, which a syntax rule cannot
 * tell. So this checks the two shapes that are wrong whichever column they came
 * from, and leaves the judgment calls to review.
 *
 * 1. `new Date(x) < new Date()` — an inline "has this passed" test. It was written
 *    four separate times. Three were comparing instants and correct; the fourth
 *    compared a day-only `dueDate`, where UTC midnight makes a task read as
 *    overdue a day early, AND it skipped the completed-task check that the shared
 *    `isTaskOverdue` performs. One spelling, four copies, one of them wrong is the
 *    exact failure mode a shared helper exists to prevent.
 *      instants  -> isPastInstant(value)
 *      day-only  -> isBeforeToday(value) / isTaskOverdue(task)
 *
 * 2. `new Date().toISOString().slice(0, 10)` — UTC today standing in for the
 *    viewer's today. Reads as the wrong day for part of every day on both sides of
 *    UTC. Use `todayLocalDate()`.
 *
 *   node scripts/check-date-helpers.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(appRoot, 'src');

/** The helpers themselves are where these expressions are allowed to live. */
const EXEMPT = [path.join('lib', 'utils', 'dateUtils.ts')];

const RULES = [
  {
    // `new Date(anything) < new Date()`, and the same test written the other way round.
    pattern: /new Date\([^)]*\)\s*[<>]=?\s*new Date\(\)|new Date\(\)\s*[<>]=?\s*new Date\([^)]+\)/,
    message: 'inline date comparison. Use isPastInstant (instants) or isBeforeToday / isTaskOverdue (day-only).',
  },
  {
    pattern: /new Date\(\)\s*\.toISOString\(\)\s*\.(slice|substring)\(\s*0\s*,\s*10\s*\)|new Date\(\)\s*\.toISOString\(\)\s*\.split\(/,
    message: 'UTC today standing in for the viewer\'s today. Use todayLocalDate().',
  },
];

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

const hits = [];
for (const file of sourceFiles(sourceRoot)) {
  const relative = path.relative(sourceRoot, file);
  if (EXEMPT.includes(relative)) continue;

  fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    // A line that is only a comment is documentation, not a call site.
    if (/^\s*(\*|\/\/)/.test(line)) return;
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        hits.push({ file: path.relative(appRoot, file), line: index + 1, text: line.trim(), why: rule.message });
        break;
      }
    }
  });
}

if (hits.length > 0) {
  console.error(`Inline date handling in ${hits.length} place(s):\n`);
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line}  ${hit.why}`);
    console.error(`    ${hit.text.slice(0, 140)}`);
  }
  process.exit(1);
}

console.log('check-date-helpers: all date comparisons go through dateUtils.');
