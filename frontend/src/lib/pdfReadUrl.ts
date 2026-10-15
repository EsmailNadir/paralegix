/**
 * Reading the two things a signed storage read url tells us about itself:
 * when it lapses, and which version of the object it points at.
 *
 * Both are already in the url the backend minted, so nothing extra has to be
 * carried alongside it and no request is needed to find them out.
 */

/**
 * How long before a read url lapses it is reminted.
 *
 * Far enough ahead that an in-flight range request finishes on the old url, and
 * short enough that a preview left open does not remint all afternoon.
 */
export const READ_URL_REFRESH_MARGIN_MS = 60_000;

/** setTimeout treats a delay past this as zero, firing immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

function params(url: string): URLSearchParams | null {
  const query = url.indexOf('?');
  if (query === -1) return null;
  return new URLSearchParams(url.slice(query + 1));
}

/**
 * Which version of the object this url reads.
 *
 * A generation-bound url names it outright. Null means the url does not say, in
 * which case no claim can be made either way about a replacement, and the
 * caller must not pretend the document is unchanged OR that it changed.
 */
export function readUrlGeneration(url: string | null | undefined): string | null {
  if (!url) return null;
  return params(url)?.get('generation') || null;
}

/**
 * When this url stops working, in epoch milliseconds, or null if it does not say.
 *
 * V4 signing states the moment it was issued and a lifetime in seconds; V2
 * states the expiry outright as epoch seconds.
 */
export function readUrlExpiresAt(url: string | null | undefined): number | null {
  if (!url) return null;
  const query = params(url);
  if (!query) return null;

  const issued = query.get('X-Goog-Date');
  const lifetime = Number(query.get('X-Goog-Expires'));
  if (issued && Number.isFinite(lifetime) && lifetime > 0) {
    // Basic ISO 8601, e.g. 20260909T120000Z, which Date cannot parse as-is.
    const parsed = issued.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      '$1-$2-$3T$4:$5:$6Z',
    );
    const at = Date.parse(parsed);
    if (Number.isFinite(at)) return at + lifetime * 1000;
  }

  const expires = Number(query.get('Expires'));
  if (Number.isFinite(expires) && expires > 0) return expires * 1000;

  return null;
}

/**
 * How long to wait before reminting a url, or null when it never needs it.
 *
 * Already lapsed, or lapsing inside the margin, means remint now.
 */
export function msUntilReadUrlRefresh(url: string | null | undefined, now: number): number | null {
  const expiresAt = readUrlExpiresAt(url);
  if (expiresAt == null) return null;
  const delay = expiresAt - READ_URL_REFRESH_MARGIN_MS - now;
  if (delay <= 0) return 0;
  return Math.min(delay, MAX_TIMEOUT_MS);
}

/**
 * Whether a reminted url reads a different version of the object.
 *
 * Only true when BOTH urls name a generation and the two differ. An url that
 * does not name one cannot be compared, and guessing "changed" there would put
 * a warning in front of every reader on a bucket that is not generation-bound.
 */
export function readUrlVersionChanged(current: string | null, next: string | null): boolean {
  const before = readUrlGeneration(current);
  const after = readUrlGeneration(next);
  return before != null && after != null && before !== after;
}
