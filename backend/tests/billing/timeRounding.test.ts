/**
 * The billing increment rounding, which had no test at all.
 *
 * Every time entry a firm records passes through `roundHoursUp` on the way in,
 * and the number it returns is what the client is billed for. Legal firms bill
 * in fixed increments and always round UP, so a wrong answer here is not a
 * display bug: it is over- or under-charging every client of the firm, on every
 * entry, silently.
 *
 * A pure function with a float boundary problem is exactly what unit tests are
 * for, so this file is exhaustive rather than representative.
 */
import { roundHoursUp, normalizeRoundingSettings, DEFAULT_INCREMENT_MINUTES }
  from '../../src/modules/billing/shared/timeRounding';

/** Six minutes, the legal-billing default and the most common firm setting. */
const SIX_MIN = { enabled: true, incrementMinutes: 6 };
const QUARTER_HOUR = { enabled: true, incrementMinutes: 15 };

describe('rounding is OFF by default', () => {
  it('passes hours through untouched when no settings exist', () => {
    // The default must be the safe one. A firm that never configured rounding
    // bills exactly what its people recorded.
    expect(roundHoursUp(0.11, null)).toBe(0.11);
    expect(roundHoursUp(0.11, undefined)).toBe(0.11);
    expect(roundHoursUp(0.11, {})).toBe(0.11);
  });

  it('passes hours through when rounding is explicitly disabled', () => {
    expect(roundHoursUp(1.234567, { enabled: false, incrementMinutes: 6 })).toBe(1.234567);
  });

  it('requires enabled to be the BOOLEAN true, not merely truthy', () => {
    // A settings blob round-tripped through JSON or a form can carry the string
    // "true". It does NOT enable rounding, and the firm sees unrounded hours
    // while its settings screen says rounding is on.
    //
    // Recorded as the behaviour that ships. The strict check is the safer
    // direction, since the alternative silently starts rounding every client's
    // bill on a value the firm never deliberately set.
    expect(roundHoursUp(0.11, { enabled: 'true' })).toBe(0.11);
    expect(roundHoursUp(0.11, { enabled: 1 })).toBe(0.11);
  });
});

describe('rounding UP to six-minute increments', () => {
  it('rounds a fraction of an increment up to a whole one', () => {
    // The core convention. Six minutes of work bills as six minutes; one minute
    // of work also bills as six.
    expect(roundHoursUp(0.01, SIX_MIN)).toBe(0.1);
    expect(roundHoursUp(0.05, SIX_MIN)).toBe(0.1);
  });

  it('rounds up, never to nearest', () => {
    // 0.11 is nearer 0.1 than 0.2. Nearest-rounding here would under-bill the
    // firm on roughly half of all entries.
    expect(roundHoursUp(0.11, SIX_MIN)).toBe(0.2);
    expect(roundHoursUp(0.15, SIX_MIN)).toBe(0.2);
    expect(roundHoursUp(0.99, SIX_MIN)).toBe(1);
  });

  it('leaves a value already ON an increment boundary alone', () => {
    expect(roundHoursUp(0.1, SIX_MIN)).toBe(0.1);
    expect(roundHoursUp(0.2, SIX_MIN)).toBe(0.2);
    expect(roundHoursUp(0.3, SIX_MIN)).toBe(0.3);
    expect(roundHoursUp(0.7, SIX_MIN)).toBe(0.7);
    expect(roundHoursUp(1, SIX_MIN)).toBe(1);
    expect(roundHoursUp(2.5, SIX_MIN)).toBe(2.5);
  });

  it('rounds a value just past a boundary to the next increment', () => {
    // The other side of the same boundary, so the epsilon cannot be widened
    // into a tolerance that swallows a real minute of work.
    expect(roundHoursUp(1.05, SIX_MIN)).toBe(1.1);
    expect(roundHoursUp(0.0001, SIX_MIN)).toBe(0.1);
  });

  it('does not bill an extra increment when float division overshoots', () => {
    // The case the `- 1e-9` in the implementation exists for, and it is NOT a
    // six-minute one. With a TEN-minute increment, fifty minutes of work is
    // exactly five increments, but in binary floats (50/60) / (10/60) evaluates
    // to 5.000000000000001. A bare `Math.ceil` reads that as six increments and
    // bills a full hour for fifty minutes of work.
    //
    // Verified by removing the epsilon and watching this go red. The six-minute
    // boundary values above do NOT distinguish the two implementations, so they
    // are coverage of the convention, not of this guard.
    //
    // The result is then rounded up to the hundredth the column stores
    // (0.8333 to 0.84). Without the epsilon it would be six increments, 1.00,
    // so the case still guards the epsilon.
    const TEN_MIN = { enabled: true, incrementMinutes: 10 };
    expect(roundHoursUp(50 / 60, TEN_MIN)).toBe(0.84);
    expect(roundHoursUp(170 / 60, TEN_MIN)).toBe(2.84);
  });

  it('returns a clean decimal, not float drift', () => {
    // `steps * incrementHours` produces values like 0.30000000000000004. That
    // number reaches the invoice, the PDF and the client.
    const result = roundHoursUp(0.25, SIX_MIN);
    expect(result).toBe(0.3);
    expect(String(result)).toBe('0.3');
  });
});

describe('other increments', () => {
  it('honours a quarter-hour firm', () => {
    expect(roundHoursUp(0.1, QUARTER_HOUR)).toBe(0.25);
    expect(roundHoursUp(0.26, QUARTER_HOUR)).toBe(0.5);
    expect(roundHoursUp(1.01, QUARTER_HOUR)).toBe(1.25);
  });

  it('leaves a quarter-hour boundary alone', () => {
    expect(roundHoursUp(0.25, QUARTER_HOUR)).toBe(0.25);
    expect(roundHoursUp(0.5, QUARTER_HOUR)).toBe(0.5);
  });

  it('falls back to six minutes for an unusable increment', () => {
    // A zero or negative increment divides by zero and returns Infinity hours.
    // Falling back to the convention is the only safe answer.
    for (const bad of [0, -5, 'abc', null, NaN]) {
      expect(roundHoursUp(0.11, { enabled: true, incrementMinutes: bad })).toBe(0.2);
    }
  });
});

describe('input the function must not mangle', () => {
  it('returns zero and negative hours unchanged', () => {
    // Rounding zero UP to a full increment would bill six minutes for an entry
    // of no work at all.
    expect(roundHoursUp(0, SIX_MIN)).toBe(0);
    expect(roundHoursUp(-1, SIX_MIN)).toBe(-1);
  });

  it('returns non-numeric input unchanged rather than producing a number', () => {
    // Validation upstream is what rejects these. This function inventing a
    // billable 0.1 out of a null would put a charge on an invoice that no
    // recorded entry supports.
    expect(roundHoursUp('abc', SIX_MIN)).toBe('abc');
    expect(roundHoursUp(null, SIX_MIN)).toBeNull();
    expect(roundHoursUp(undefined, SIX_MIN)).toBeUndefined();
  });

  it('returns NaN and Infinity unchanged', () => {
    expect(roundHoursUp(Number.NaN, SIX_MIN)).toBeNaN();
    expect(roundHoursUp(Number.POSITIVE_INFINITY, SIX_MIN)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('normalizeRoundingSettings', () => {
  it('reports the default increment when none is set', () => {
    expect(normalizeRoundingSettings({ enabled: true }))
      .toEqual({ enabled: true, incrementMinutes: DEFAULT_INCREMENT_MINUTES });
  });

  it('reports disabled for missing settings', () => {
    expect(normalizeRoundingSettings(null).enabled).toBe(false);
    expect(normalizeRoundingSettings(undefined).enabled).toBe(false);
  });

  it('keeps a valid custom increment', () => {
    expect(normalizeRoundingSettings({ enabled: true, incrementMinutes: 15 }).incrementMinutes)
      .toBe(15);
  });

  it('coerces a numeric string increment', () => {
    // Settings arrive from a jsonb column and a form, so "15" is a realistic
    // shape. Falling back to 6 here would quietly re-bill a quarter-hour firm
    // in six-minute units.
    expect(normalizeRoundingSettings({ enabled: true, incrementMinutes: '15' }).incrementMinutes)
      .toBe(15);
  });
});

describe('the billing consequence, stated in money', () => {
  it('never bills a client LESS than the recorded time', () => {
    // The property the convention exists to guarantee, checked across the range
    // rather than at hand-picked points.
    for (let minutes = 1; minutes <= 240; minutes += 1) {
      const hours = minutes / 60;
      const billed = roundHoursUp(hours, SIX_MIN) as number;
      expect(billed).toBeGreaterThanOrEqual(hours - 1e-9);
    }
  });

  it('never bills more than one increment beyond the recorded time', () => {
    // The other side. Rounding up is expected; rounding up TWICE, which is what
    // a missing epsilon does on boundary values, is over-charging.
    const incrementHours = 0.1;
    for (let minutes = 1; minutes <= 240; minutes += 1) {
      const hours = minutes / 60;
      const billed = roundHoursUp(hours, SIX_MIN) as number;
      expect(billed).toBeLessThan(hours + incrementHours);
    }
  });
});

describe('the result fits the stored precision', () => {
  // `activities.hours` is numeric(6,2). An increment that is not a whole number
  // of hundredths must be rounded UP to the hundredth, or Postgres rounds it to
  // nearest and stores less than the increment billed.
  const FIVE_MIN = { enabled: true, incrementMinutes: 5 };
  const TEN_MIN = { enabled: true, incrementMinutes: 10 };

  it('stores a five-minute increment as 0.09, never 0.08', () => {
    expect(roundHoursUp(3 / 60, FIVE_MIN)).toBe(0.09);
    expect(roundHoursUp(5 / 60, FIVE_MIN)).toBe(0.09);
    expect(roundHoursUp(25 / 60, FIVE_MIN)).toBe(0.42);
  });

  it('stores twenty minutes on a ten-minute increment as 0.34', () => {
    expect(roundHoursUp(20 / 60, TEN_MIN)).toBe(0.34);
  });

  it('leaves increments that are already whole hundredths exact', () => {
    expect(roundHoursUp(5 / 60, SIX_MIN)).toBe(0.1);
    expect(roundHoursUp(0.25, SIX_MIN)).toBe(0.3);
    expect(roundHoursUp(0.1, QUARTER_HOUR)).toBe(0.25);
  });

  it('never returns more than two decimals', () => {
    for (const inc of [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]) {
      for (let minutes = 1; minutes <= 180; minutes += 1) {
        const billed = roundHoursUp(minutes / 60, { enabled: true, incrementMinutes: inc }) as number;
        expect(Math.round(billed * 100) / 100).toBe(billed);
        expect(billed).toBeGreaterThanOrEqual(minutes / 60 - 1e-9);
      }
    }
  });
});
