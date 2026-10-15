/**
 * percentOfCents and hoursTimesRateCents round half up on integers. The same
 * fixture drives the frontend mirror (frontend/tests/lib/billing/moneyRoundingHelpers.test.ts),
 * so a preview and a save cannot disagree by a cent.
 *
 * RED IF: either helper goes back to a float product (3000 x 7.25% reads 217)
 * or rounds half to even / down, or the frontend mirror diverges.
 */
import fs from 'fs';
import path from 'path';
import { percentOfCents, hoursTimesRateCents, hoursToHundredths } from '../../src/modules/billing/shared/money';

const cases = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/moneyRoundingCases.json'), 'utf8'),
) as { percentOfCents: number[][]; hoursTimesRateCents: number[][] };

describe('percentOfCents', () => {
  it.each([[3000, 7.25, 218], [10000, 9.975, 998], [6200, 7.25, 450], [1, 50, 1], [1, 49.999, 0]])(
    '%p cents at %p%% is %p cents',
    (cents, rate, want) => expect(percentOfCents(cents, rate)).toBe(want),
  );
  it('stays exact where cents x thousandths passes 2^53', () => {
    expect(percentOfCents(100_000_000_000, 99.999)).toBe(99_999_000_000);
  });
  it('matches the shared fixture', () => {
    for (const [c, r, want] of cases.percentOfCents) expect([c, r, percentOfCents(c, r)]).toEqual([c, r, want]);
  });
});

describe('hoursTimesRateCents', () => {
  it.each([[30, 12345, 3704], [6, 17525, 1052], [35, 2750, 963], [41, 2750, 1128]])(
    '%p hundredths of an hour at %p cents is %p cents',
    (h, rate, want) => expect(hoursTimesRateCents(h, rate)).toBe(want),
  );
  it('converts float hours to hundredths without drift', () => {
    expect(hoursToHundredths(0.29)).toBe(29);
    expect(hoursToHundredths(1.15)).toBe(115);
  });
  it('matches the shared fixture', () => {
    for (const [h, r, want] of cases.hoursTimesRateCents) expect([h, r, hoursTimesRateCents(h, r)]).toEqual([h, r, want]);
  });
});
