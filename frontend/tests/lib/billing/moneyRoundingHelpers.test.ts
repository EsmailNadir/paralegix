/**
 * The frontend percentOfCents and hoursTimesRateCents return the same cents as
 * the backend helpers, checked against the shared fixture the backend suite also
 * reads (backend/tests/billing/moneyRoundingHelpers.test.ts).
 *
 * RED IF: either helper goes back to a float product or the two sides diverge.
 */
import fs from 'fs';
import path from 'path';
import { percentOfCents, hoursTimesRateCents, hoursToHundredths } from '@/lib/utils/currency';

const cases = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../../backend/tests/fixtures/moneyRoundingCases.json'), 'utf8'),
) as { percentOfCents: number[][]; hoursTimesRateCents: number[][] };

it('percentOfCents matches the shared fixture', () => {
  expect(cases.percentOfCents.length).toBeGreaterThan(100);
  for (const [c, r, want] of cases.percentOfCents) expect([c, r, percentOfCents(c, r)]).toEqual([c, r, want]);
});

it('hoursTimesRateCents matches the shared fixture', () => {
  expect(cases.hoursTimesRateCents.length).toBeGreaterThan(100);
  for (const [h, r, want] of cases.hoursTimesRateCents) expect([h, r, hoursTimesRateCents(h, r)]).toEqual([h, r, want]);
});

it('keeps the documented half-cent cases', () => {
  expect(percentOfCents(3000, 7.25)).toBe(218);
  expect(percentOfCents(10000, 9.975)).toBe(998);
  expect(hoursTimesRateCents(hoursToHundredths(0.3), 12345)).toBe(3704);
});
