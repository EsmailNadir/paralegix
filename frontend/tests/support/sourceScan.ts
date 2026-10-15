/**
 * Walks the frontend source tree for the style guards in `tests/styles/`, which
 * read files as text the way a lint rule would.
 */
import { readdirSync } from 'fs';
import { join } from 'path';

/** Absolute path of `frontend/src`. */
export const SRC_ROOT = join(__dirname, '../../src');

export interface SourceFileOptions {
  /** Which file names to keep. Defaults to `.ts` and `.tsx`. */
  include?: RegExp;
  /** Directories to skip entirely, as absolute paths. */
  skipDirs?: string[];
}

/** Every file under `dir` whose name matches `include`, depth first. */
export function sourceFiles(dir: string = SRC_ROOT, { include = /\.tsx?$/, skipDirs = [] }: SourceFileOptions = {}): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return skipDirs.includes(path) ? [] : sourceFiles(path, { include, skipDirs });
    return include.test(entry.name) ? [path] : [];
  });
}

/**
 * The JSX opening tag that starts at `start` (e.g. the index of `<Modal`), with
 * braces and string literals respected so an arrow `=>` or a `>` inside a prop
 * expression does not end it early. Null when the source ends first.
 */
export function openingTag(source: string, start: number): { tag: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote && source[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return { tag: source.slice(start, i + 1), end: i + 1 };
  }
  return null;
}
