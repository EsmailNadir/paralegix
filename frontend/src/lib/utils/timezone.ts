/**
 * The viewer's IANA timezone (e.g. "America/Los_Angeles"), used for the
 * `x-timezone` request header so the backend can render day-only dates and
 * day-window aggregates in the viewer's local time.
 *
 * Single source of truth: this was previously copy-pasted into a dozen service
 * files. `Intl.DateTimeFormat().resolvedOptions().timeZone` returns a valid IANA
 * zone in every supported browser, so the fallback is effectively unreachable and
 * exists only to guarantee a non-empty string.
 */
export function getUserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}
