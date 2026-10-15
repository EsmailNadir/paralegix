// Round a time entry's hours UP to the firm's configured billing increment.
// Legal billing convention: firms bill in fixed increments (commonly 6 minutes,
// i.e. 0.1h) and always round up to the next whole increment. When rounding is
// disabled (the default) the hours pass through unchanged.
export const DEFAULT_INCREMENT_MINUTES = 6;

/**
 * Increments a firm may choose: those that divide the hour, so a whole hour
 * of work always bills as exactly one hour. The settings screen offers 6, 10,
 * 12, 15 and 30.
 */
export const ALLOWED_INCREMENT_MINUTES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60] as const;

export function normalizeRoundingSettings(timeRounding: any) {
  const cfg = timeRounding || {};
  const enabled = cfg.enabled === true;
  let incrementMinutes = Number(cfg.incrementMinutes);
  if (!Number.isFinite(incrementMinutes) || incrementMinutes <= 0) {
    incrementMinutes = DEFAULT_INCREMENT_MINUTES;
  }
  return { enabled, incrementMinutes };
}

// Round `hours` up to the next increment defined by `timeRounding`.
// Returns the value unchanged when rounding is off or the input is not a
// positive finite number.
export function roundHoursUp(hours: any, timeRounding: any) {
  const { enabled, incrementMinutes } = normalizeRoundingSettings(timeRounding);
  if (!enabled) return hours;
  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0) return hours;
  const incrementHours = incrementMinutes / 60;
  // Subtract a small epsilon so a value already sitting exactly on an increment
  // boundary (e.g. exactly 0.1h) is not bumped up to the next one by float noise.
  const steps = Math.ceil(value / incrementHours - 1e-9);
  const rounded = steps * incrementHours;
  // `activities.hours` is numeric(6,2), and `amount_cents` is generated from
  // the stored value. A 5- or 10-minute increment is not a whole number of
  // hundredths of an hour, and Postgres would round it to NEAREST on write,
  // storing less than the increment billed (5 minutes as 0.08h). Rounding UP
  // to the hundredth here makes the returned value the stored one; the epsilon
  // absorbs float noise on values already at a hundredth (0.30000000000000004).
  return Math.ceil(rounded * 100 - 1e-6) / 100;
}
