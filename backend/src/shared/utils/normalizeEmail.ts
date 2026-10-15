/**
 * The identity form of an email address: lowercased and trimmed, or null.
 *
 * `users.email` is deliberately NOT unique (the Firebase UID is the identity
 * key), so email comparisons happen in application
 * code rather than being enforced by a constraint. That makes it worth having
 * one definition of what "the same address" means: three copies is three chances
 * for an invite lookup and a membership check to disagree about ` Alice@Firm.com `.
 *
 * NOTE: `auth.service.js` keeps its OWN version, which returns '' rather than
 * null for absent input. That is not an oversight -- changing it would alter
 * comparison behaviour in authentication code, so the two are kept apart
 * deliberately.
 *
 * The body below is byte-identical to the three copies it replaces: null for a
 * falsy or non-string input, trimmed and lowercased otherwise. A whitespace-only
 * string yields '' here, NOT null, because the originals return
 * `email.trim().toLowerCase()` unguarded once the input is a truthy string.
 *
 * The parameter is `unknown` rather than `string`: callers pass values straight
 * off request bodies and database rows, and the non-string guard is load-bearing.
 */
export function normalizeEmail(email: unknown): string | null {
  if (!email || typeof email !== 'string') return null;
  return email.trim().toLowerCase();
}
