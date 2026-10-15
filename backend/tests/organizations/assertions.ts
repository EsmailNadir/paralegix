/**
 * Shared assertions for the organization batteries.
 *
 * These exist because the same two mistakes were made twice, once per battery,
 * and both produced red cells against correct code:
 *
 *   1. A list or aggregate endpoint does NOT refuse with 403. It returns an
 *      empty body. Asserting on the status alone marked six correctly-scoped
 *      endpoints red, three on the portal and five on the firm side.
 *
 *   2. Money is serialised in DOLLARS on some surfaces (`totalAmount: 7319`)
 *      while the column is `total_cents` (731900). Searching for one unit
 *      matched nothing and marked four more red.
 *
 * The property actually worth asserting is DISCLOSURE, not status: did this
 * response state a figure the caller is not entitled to. Everything below is
 * built around that.
 */

export interface HttpResponse {
  status: number;
  body: unknown;
}

/**
 * Every JSON number token in a body, so a figure can be matched without a
 * substring search.
 *
 * A plain `includes('7319')` finds that run of digits inside a uuid often
 * enough to produce a false positive, and uuids are in every one of these
 * responses.
 */
function numberTokens(body: unknown): Set<number> {
  const found = new Set<number>();
  const walk = (value: unknown) => {
    if (typeof value === 'number') {
      found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(walk);
      return;
    }
    // Money sometimes arrives as a bigint-safe string. Only whole numbers
    // count; a uuid or a date never parses cleanly here.
    if (typeof value === 'string' && /^\d+$/.test(value)) found.add(Number(value));
  };
  walk(body);
  return found;
}

/**
 * True when the response states any of the given cent amounts, in either unit.
 *
 * Pass the raw cent figures the world seeded. Both the cents and the dollar
 * rendering are checked, because the API is inconsistent about which it sends
 * and a test that assumed one silently stopped asserting anything.
 */
export function disclosesAmounts(res: HttpResponse, centsFigures: number[]): boolean {
  if (res.status !== 200) return false;
  const tokens = numberTokens(res.body);
  return centsFigures.some((cents) => tokens.has(cents) || tokens.has(cents / 100));
}

/**
 * True when the response carries no rows.
 *
 * An echoed request parameter does not count as data: the trust balance
 * endpoint returns the `clientId` it was asked about, which the caller already
 * knew. Only arrays and non-zero numbers count.
 */
export function carriesNoRows(res: HttpResponse): boolean {
  if (res.status !== 200) return false;
  const body = (res.body ?? {}) as Record<string, unknown>;
  const values = Object.values(body);
  if (!values.length) return true;
  return values.every((value) => {
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'number') return value === 0;
    return true;
  });
}

/**
 * A refusal, counting an empty answer as one.
 *
 * This is the shape a correctly-scoped list endpoint uses: the query is scoped
 * by `law_firm_id` or by the caller's associations, so a record they may not see
 * simply matches nothing.
 */
export function refusedOrEmpty(res: HttpResponse): boolean {
  if (res.status === 403 || res.status === 404) return true;
  return carriesNoRows(res);
}

/**
 * The assertion that matters on a money surface: the caller was not told any of
 * these figures, whether by refusal or by an empty answer.
 */
export function withheldAmounts(res: HttpResponse, centsFigures: number[]): boolean {
  if (res.status === 403 || res.status === 404) return true;
  return !disclosesAmounts(res, centsFigures);
}
