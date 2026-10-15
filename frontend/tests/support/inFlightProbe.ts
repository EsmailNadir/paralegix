/**
 * Measure how many requests a handler has in flight AT THE SAME MOMENT.
 *
 * A bulk action that hands every selected row to `Promise.all` opens one request
 * per row at once. Counting the requests afterwards cannot see that: a thousand
 * fired together and a thousand fired three at a time both end up as a thousand
 * recorded calls. The only place the difference is visible is INSIDE the
 * handler, between the moment it is entered and the moment it answers, which is
 * what this wraps.
 *
 *   const probe = inFlightProbe();
 *   api.delete('/billing/time-entries/matter/m1/e1', probe.respond({ status: 204 }));
 *   ...
 *   expect(probe.peak).toBe(MAX_ACTIVE_BULK_REQUESTS);
 *
 * The response is held for a macrotask so overlapping requests genuinely
 * overlap. Without the delay every request would resolve before the next one
 * started and the peak would read 1 even for an unbounded fan-out.
 */
import type { RecordedCall } from './apiMock';

export interface InFlightProbe {
  /** Highest number of wrapped requests open at once. */
  readonly peak: number;
  /** How many wrapped requests have been answered. */
  readonly count: number;
  /** Wrap a mock response (or a per-request function) so the probe counts it. */
  respond(
    response: unknown | ((call: RecordedCall) => unknown),
  ): (call: RecordedCall) => Promise<unknown>;
}

export function inFlightProbe(holdMs = 0): InFlightProbe {
  let active = 0;
  let peak = 0;
  let count = 0;

  return {
    get peak() { return peak; },
    get count() { return count; },
    respond(response) {
      return async (call: RecordedCall) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, holdMs));
          count += 1;
          return typeof response === 'function'
            ? (response as (c: RecordedCall) => unknown)(call)
            : response;
        } finally {
          active -= 1;
        }
      };
    },
  };
}
