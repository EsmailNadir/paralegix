#!/usr/bin/env node
/**
 * Forbids sizing a dialog from the call site.
 *
 * `<Modal>` owns its width and its height. It renders one `max-w-*` chosen by
 * the `size` prop and one height class chosen by the `height` prop. A call site
 * that puts a `max-w-*`, `max-h-*`, `w-*` or `h-*` utility in `className` is
 * writing a second, competing utility onto the same element. Which one wins is
 * decided by the order Tailwind emitted them in the stylesheet, not by the order
 * they were written, so the same override behaved differently from one dialog to
 * the next. That is how the app ended up with fourteen different height
 * treatments and nine widths.
 *
 * The panel drops these utilities at render time, so a hand-passed one is
 * silently ignored rather than half-applied. This check exists so it is not
 * silent: the call site gets told to use `size` or `height` instead.
 *
 *   node scripts/check-modal-sizing.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(appRoot, 'src');

/** A width or height utility, with any variant prefixes such as `sm:`. */
const SIZING = /^(?:[\w-]+:)*(?:max-)?[wh]-/;
const NAME = /^[A-Za-z_$][\w$-]*/;

function skipString(text, index) {
  const quote = text[index];
  let i = index + 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (quote === '`' && text[i] === '$' && text[i + 1] === '{') { i = skipBraces(text, i + 1); continue; }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  throw new Error('unterminated string');
}

function skipComment(text, index) {
  if (text.startsWith('//', index)) {
    const newline = text.indexOf('\n', index);
    return newline === -1 ? text.length : newline;
  }
  if (text.startsWith('/*', index)) return text.indexOf('*/', index) + 2;
  return index;
}

function skipBraces(text, index) {
  let depth = 0;
  let i = index;
  while (i < text.length) {
    const c = text[i];
    if (c === '/') { const next = skipComment(text, i); if (next !== i) { i = next; continue; } }
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  throw new Error('unbalanced braces');
}

/**
 * The `className` string literal belonging to the tag that opens at `start`,
 * or null. Nested JSX inside another prop (an icon, a footer button) is skipped
 * whole, so its own `className` is never mistaken for the tag's.
 */
function ownClassName(text, start) {
  let i = start + 1 + NAME.exec(text.slice(start + 1))[0].length;
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
  while (i < text.length) {
    while (isSpace(text[i])) i += 1;
    if (text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) { i = skipComment(text, i); continue; }
    if (text[i] === '>') return null;
    if (text[i] === '/' && text[i + 1] === '>') return null;
    if (text[i] === '{') { i = skipBraces(text, i); continue; }
    const name = NAME.exec(text.slice(i));
    if (!name) throw new Error(`unexpected ${text.slice(i, i + 30)}`);
    i += name[0].length;
    let j = i;
    while (isSpace(text[j])) j += 1;
    while (text[j] === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) {
      j = skipComment(text, j);
      while (isSpace(text[j])) j += 1;
    }
    if (text[j] !== '=') continue;
    i = j + 1;
    while (isSpace(text[i])) i += 1;
    if (text[i] === '"' || text[i] === "'") {
      const end = skipString(text, i);
      if (name[0] === 'className') return text.slice(i + 1, end - 1);
      i = end;
    } else {
      i = skipBraces(text, i);
    }
  }
  throw new Error('unterminated tag');
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.name.endsWith('.tsx') ? [entryPath] : [];
  });
}

const hits = [];
for (const file of sourceFiles(sourceRoot)) {
  if (file.endsWith(path.join('ui', 'Modal.tsx'))) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/<Modal(?=[\s>])/g)) {
    const className = ownClassName(text, match.index);
    if (!className) continue;
    const offenders = className.split(/\s+/).filter((cls) => cls && SIZING.test(cls));
    if (offenders.length > 0) {
      hits.push({
        file: path.relative(appRoot, file),
        line: text.slice(0, match.index).split('\n').length,
        offenders,
      });
    }
  }
}

if (hits.length > 0) {
  console.error(`Dialog sized from the call site in ${hits.length} place(s):\n`);
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line}`);
    console.error(`    ${hit.offenders.join(' ')}`);
  }
  console.error('\nUse the size prop for width (sm to 5xl, or screen) and the height prop');
  console.error('for height (auto, fill, none). The panel drops these classes at render.');
  process.exit(1);
}

console.log('check-modal-sizing: every dialog is sized by its props.');
