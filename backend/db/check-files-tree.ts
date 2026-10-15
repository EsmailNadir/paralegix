/**
 * Static guard: the files tree is addressed by id, and paths are not rebuilt.
 *
 * The tree used to live in the storage path. Every operation therefore took a
 * path, every caller built one from the folder on screen plus a name, and a
 * rename had to rewrite every object beneath a prefix. The tree lives in
 * `files.parent_id` now, and an object path is opaque: `objects/<uuid>`, decided
 * by the database, never parsed.
 *
 * The pull back toward the old shape is real, because a path reads as a natural
 * address for a file. This fails the build on the shapes that would restore it.
 *
 * Run: `npx tsx db/check-files-tree.ts`
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

/**
 * Every TypeScript file under `src/`.
 *
 * A filesystem walk rather than `git ls-files`: the Cloud Build image is
 * `node:22-slim`, which carries no git, so the git form threw there and this
 * guard checked nothing in the one place it was meant to gate. It went unnoticed
 * because the build step ran without `set -e` and reported only its last
 * command's status. A walk also sees a file that is not committed yet, which is
 * the file most likely to reintroduce the shape.
 */
function sourceFiles(dir = 'src'): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(relative));
    else if (entry.name.endsWith('.ts')) found.push(relative);
  }
  return found.sort();
}

interface Violation {
  file: string;
  line: number;
  text: string;
  why: string;
}

/**
 * What must not come back.
 *
 * Each pattern names a way the tree could be put back into the path, and each
 * is written to match the SHAPE rather than a spelling, so a rename of the
 * helper does not slip past it.
 */
const BANNED: Array<{ re: RegExp; why: string; allow?: RegExp }> = [
  {
    // A folder used to be an empty marker object at `<folder>/.folder`.
    re: /['"`]\.folder['"`]|\/\.folder/,
    why: 'a folder is a row, not a `.folder` marker object',
  },
  {
    // Building a scope prefix and appending to it is how a path became a tree.
    re: /lawfirmids\/\$\{[^}]+\}\/\$\{/,
    why: 'an object path is opaque; do not build one from ids',
  },
  {
    // Reading the tree back out of a path.
    re: /objectPath[^\n]*\.split\(['"`]\//,
    why: 'do not parse an object path; the row carries scope and parent',
  },
];

/**
 * Lines that legitimately mention a path.
 *
 * The archive and the scratch prefixes are storage the system owns, outside the
 * browsable tree, and they are still addressed by path because there is no row
 * to address instead.
 */
const EXEMPT_FILES = new Set([
  'src/shared/storage/recordArchive.ts',
  'src/modules/signatures/signingWorkspace.ts',
]);

function scan(): Violation[] {
  const violations: Violation[] = [];
  for (const file of sourceFiles()) {
    if (EXEMPT_FILES.has(file)) continue;
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
    lines.forEach((text, i) => {
      // A comment explaining what the old design did is not the old design.
      const code = text.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (!code.trim() || code.trim().startsWith('*')) return;
      for (const { re, why } of BANNED) {
        if (re.test(code)) violations.push({ file, line: i + 1, text: text.trim(), why });
      }
    });
  }
  return violations;
}

const found = scan();
if (found.length === 0) {
  console.log('[files-tree] OK: the tree is addressed by id, and no path is rebuilt.');
  process.exit(0);
}

console.error(`[files-tree] FAIL: ${found.length} line(s) put the tree back into the path.\n`);
for (const v of found) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.text}`);
  console.error(`    ^ ${v.why}\n`);
}
process.exit(1);
