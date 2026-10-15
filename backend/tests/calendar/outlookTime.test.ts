/**
 * Microsoft Graph names a mailbox's zone the Windows way. Any name missing
 * from the table used to fall through to UTC, so a Singapore mailbox's
 * events were read and written as if it were in London in winter.
 */
const { normalizeIanaTimeZone, toGraphTimeZone, WINDOWS_ZONE_NAMES } = require('../../src/modules/calendar/outlook/outlookTime');

const resolves = (tz: string) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

describe('Windows zone names', () => {
  /** Goes red if a name falls through to UTC again. */
  test.each([
    ['Singapore Standard Time', 'Asia/Singapore'],
    ['Arabian Standard Time', 'Asia/Dubai'],
    ['SA Pacific Standard Time', 'America/Bogota'],
    ['Cen. Australia Standard Time', 'Australia/Adelaide'],
    ['Israel Standard Time', 'Asia/Jerusalem'],
    ['E. South America Standard Time', 'America/Sao_Paulo'],
  ])('%s is %s', (windows, iana) => {
    expect(normalizeIanaTimeZone(windows)).toBe(iana);
  });

  /** Goes red if an entry in the table names a zone the runtime cannot use (a typo, or a retired id). */
  test('every name in the table maps to a zone the runtime knows', () => {
    expect(WINDOWS_ZONE_NAMES.length).toBeGreaterThan(130);
    const unresolved = WINDOWS_ZONE_NAMES.filter((w: string) => {
      const iana = normalizeIanaTimeZone(w);
      return !resolves(iana) || (iana === 'UTC' && !['UTC', 'Coordinated Universal Time'].includes(w));
    });
    expect(unresolved).toEqual([]);
  });

  test('the zones that were already mapped keep their Windows name on the way out', () => {
    expect(toGraphTimeZone('America/Los_Angeles')).toBe('Pacific Standard Time');
    expect(toGraphTimeZone('Europe/Bucharest')).toBe('E. Europe Standard Time');
    expect(toGraphTimeZone('Asia/Singapore')).toBe('Singapore Standard Time');
  });
});

export {};
