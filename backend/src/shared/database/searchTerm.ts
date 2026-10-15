/**
 * Turn raw user input into a parameterized ILIKE term with LIKE wildcards
 * escaped, so a user typing `%` or `_` searches for that literal character
 * instead of matching everything. Always pair the result with `escape '\'` in
 * the SQL predicate:
 *
 *   where name ilike $2 escape '\'
 *
 * Returns null when there is nothing searchable, letting callers skip the
 * predicate entirely rather than filtering on '%%'.
 */
export function toIlikeTerm(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return `%${trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Escape the LIKE metacharacters in `input` WITHOUT adding wildcards of its own,
 * so the result can be embedded in a larger pattern the caller composes (for
 * example a `parent > %` subtree match over a stored path). `toIlikeTerm` is the
 * right helper for a plain "contains" search; this one is for the cases where
 * the caller owns the wildcard placement. Always pair with `escape '\'`.
 *
 * Returns null when there is nothing usable, letting callers skip the predicate.
 */
export function escapeLikeLiteral(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
