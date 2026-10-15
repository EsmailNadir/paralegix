#!/usr/bin/env node
/**
 * Forbids hand-formatted currency.
 *
 * `${amount.toFixed(2)}` next to a literal `$` renders "$12500.00" where the rest
 * of the app renders "$12,500.00", because `toFixed` has no thousands separator
 * and `Intl.NumberFormat` does. The two spellings sat side by side on the invoice
 * pages, so the same total read differently depending on which line drew it.
 *
 * `formatCurrency` (dollars) and `formatCents` (integer cents) in
 * lib/utils/currency.ts are the only two ways to render money for a person.
 * `centsToDollars` stays available for CSV, where a spreadsheet has to parse the
 * cell back as a number and a separator would break it.
 *
 * This flags the `$` + `toFixed` pairing specifically, not `toFixed` itself: a
 * `toFixed(2)` feeding a form input's value is correct and must keep working.
 *
 *   node scripts/check-money-format.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(appRoot, 'src');

/**
 * A literal `$` immediately before a `.toFixed(2)` interpolation. The `$` is
 * spelled differently depending on where it sits, so both forms are matched:
 *
 *   template literal   `$${total.toFixed(2)}`      two `$`: one literal, one interpolation
 *   JSX text           <span>${total.toFixed(2)}</span>   one literal `$`, then an expression
 *
 * A single `$` inside a template literal is just interpolation and means nothing
 * about currency, so matching it would flag `${bytes.toFixed(2)} MB`. The
 * backtick test below separates the two: if a backtick opens before the match on
 * that line, a lone `$` is interpolation and is left alone.
 */
const DOUBLE_DOLLAR = /\$\$\{[^{}]*\.toFixed\(2\)[^{}]*\}/;
const SINGLE_DOLLAR = /\$\{[^{}]*\.toFixed\(2\)[^{}]*\}/;

function isHandFormattedMoney(line) {
  if (DOUBLE_DOLLAR.test(line)) return true;
  const match = SINGLE_DOLLAR.exec(line);
  if (!match) return false;
  return !line.slice(0, match.index).includes('`');
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

const hits = [];
for (const file of sourceFiles(sourceRoot)) {
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (isHandFormattedMoney(line)) {
      hits.push({ file: path.relative(appRoot, file), line: index + 1, text: line.trim() });
    }
  });
}

if (hits.length > 0) {
  console.error(`Hand-formatted currency in ${hits.length} place(s). Use formatCurrency or formatCents:\n`);
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line}`);
    console.error(`    ${hit.text.slice(0, 140)}`);
  }
  console.error('\ntoFixed(2) has no thousands separator, so these render "$12500.00" not "$12,500.00".');
  process.exit(1);
}

console.log('check-money-format: no hand-formatted currency.');
