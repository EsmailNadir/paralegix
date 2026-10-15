/**
 * The source tree, for the inventory specs under `tests/config/` that scan
 * `src/` for a call shape and compare what they find against a reviewed list.
 *
 * Paths come back absolute and sorted, so a scan's output is stable across
 * machines. `relToSrc` gives the forward-slash, `src`-relative form those
 * reviewed lists are keyed on.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/** `backend/src`, absolute. */
export const SRC = path.join(__dirname, '..', '..', 'src');

/** Every `.ts` file under `dir` (default `src/`), at any depth. */
export function tsFilesUnder(dir: string = SRC): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** `full` relative to `src/`, with forward slashes on every platform. */
export const relToSrc = (full: string): string => path.relative(SRC, full).split(path.sep).join('/');

/** Parse one file with parent pointers set, which the AST walks rely on. */
export const parseTs = (full: string): ts.SourceFile => ts.createSourceFile(
  full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true,
);
