/**
 * Shared tuning for search inputs and option lists. Centralized so the
 * debounce a table uses and the debounce a picker uses can't drift apart.
 */

/** Delay before a typed search term is sent to the server. */
export const SEARCH_DEBOUNCE_MS = 350;

/** Rows a typeahead lookup request asks for. */
export const LOOKUP_PAGE_SIZE = 20;

/**
 * Hard ceiling the `/lookup` endpoints clamp `limit` to. Resolving more ids
 * than this in one request silently truncates, so callers chunk instead.
 */
export const LOOKUP_MAX_LIMIT = 50;

/**
 * Option count at which `Dropdown` starts showing its filter input. Below this
 * the list is short enough to scan, and the extra control is just noise.
 */
export const DROPDOWN_SEARCH_THRESHOLD = 12;

/**
 * Maximum option rows `Dropdown` puts in the DOM at once. Matches beyond this
 * are counted in a footer row prompting the user to narrow the search.
 */
export const DROPDOWN_MAX_RENDERED = 100;

/**
 * Note shown under a lookup-backed option list when the server reported more
 * rows than it returned, or `undefined` when the list is complete. `undefined`
 * rather than `null` so the result drops straight into `Dropdown`'s optional
 * `footerNote`, which is where most callers send it.
 *
 * The wording splits on whether a search term is active because the two states
 * mean different things to the reader. While browsing, the list is understood to
 * be a window onto everything, so the note is a hint that more exists further
 * down. While searching, the user reads the rows as "the things that match" and
 * has no way to tell that matches were cut off, so the note has to say the
 * result set itself is incomplete.
 */
export function lookupOverflowNote(hasMore: boolean | undefined, search: string): string | undefined {
  if (!hasMore) return undefined;
  return search.trim()
    ? "More matches than shown. Keep typing to narrow."
    : "More results available. Keep typing to narrow.";
}
