import {
  configuredRate,
  resolveRate,
  resolveRateFromRatesTable,
  resolveRateValue,
} from '../../src/modules/billing/shared/rateResolution';

describe('configuredRate', () => {
  it.each([
    [125, 125],
    ['125.50', 125.5],
    [0, 0],
    ['0', 0],
  ])('accepts %p as %p', (input, expected) => {
    expect(configuredRate(input)).toBe(expected);
  });

  it.each([undefined, null, '', '  ', 'not-a-rate', NaN, Infinity, true])(
    'treats %p as not configured',
    (input) => expect(configuredRate(input)).toBeNull(),
  );
});

describe('resolveRate', () => {
  const base = { entry: { userId: 'member-1' } };

  it.each([
    [{ entry: { userId: 'member-1', hourlyRate: 101 } }, 'time entry override', 101],
    [{ ...base, matterMembers: [{ userId: 'member-1', hourlyRate: '202.50' }] }, 'matter member rate', 202.5],
    [{ ...base, clientBillingRates: { memberRates: { 'member-1': 303 } } }, 'client member rate', 303],
    [{ ...base, clientBillingRates: { defaultRate: 404 } }, 'client default rate', 404],
    [{ ...base, chargeCode: { memberRates: { 'member-1': 505 } } }, 'charge code member rate', 505],
    [{ ...base, chargeCode: { defaultRate: '606.75' } }, 'charge code default', 606.75],
    [{ ...base, memberDefaultRates: { 'member-1': 707 } }, 'user default rate', 707],
    [{ ...base, firmDefaultRate: 808 }, 'firm default rate', 808],
  ])('uses the %s tier', (params, source, rate) => {
    expect(resolveRate(params as any)).toEqual({ rate, source });
  });

  it('uses the first configured tier and preserves a zero override', () => {
    expect(resolveRate({
      entry: { userId: 'member-1', hourlyRate: 0 },
      matterMembers: [{ userId: 'member-1', hourlyRate: 999 }],
      firmDefaultRate: 888,
    })).toEqual({ rate: 0, source: 'time entry override' });
  });

  it('skips invalid values and falls back to zero', () => {
    expect(resolveRate({
      entry: { userId: 'member-1', hourlyRate: 'invalid' },
      clientBillingRates: { defaultRate: NaN },
      chargeCode: { defaultRate: null },
      memberDefaultRates: { 'member-1': '' },
    })).toEqual({ rate: 0, source: 'none' });
  });

  it('returns only the number through the compatibility helper', () => {
    expect(resolveRateValue({ ...base, firmDefaultRate: '321.25' })).toBe(321.25);
  });
});

describe('resolveRateFromRatesTable', () => {
  const rates = [
    { scopeKind: 'matter', matterId: 'matter-1', userId: 'user-1', rateCents: 25000 },
    { scopeKind: 'client', clientId: 'client-1', userId: 'user-1', rateCents: 22000 },
    { scopeKind: 'client', clientId: 'client-1', userId: null, rateCents: 20000 },
    { scopeKind: 'billing_code', billingCodeId: 'code-1', userId: 'user-1', rateCents: 18000 },
    { scopeKind: 'billing_code', billingCodeId: 'code-1', userId: null, rateCents: 15000 },
    { scopeKind: 'member', userId: 'user-1', rateCents: 12000 },
    { scopeKind: 'firm', rateCents: 10000 },
  ];

  it('respects entry override first', () => {
    expect(resolveRateFromRatesTable({
      entryRateCents: 30000,
      userId: 'user-1',
      matterId: 'matter-1',
      rates,
    })).toEqual({ rateCents: 30000, source: 'time entry override' });
  });

  it('resolves matter member rate', () => {
    expect(resolveRateFromRatesTable({
      userId: 'user-1',
      matterId: 'matter-1',
      rates,
    })).toEqual({ rateCents: 25000, source: 'matter member rate' });
  });

  it('resolves client member rate when no matter rate exists', () => {
    expect(resolveRateFromRatesTable({
      userId: 'user-1',
      clientId: 'client-1',
      rates,
    })).toEqual({ rateCents: 22000, source: 'client member rate' });
  });

  it('resolves client default rate when no user override exists', () => {
    expect(resolveRateFromRatesTable({
      userId: 'user-2',
      clientId: 'client-1',
      rates,
    })).toEqual({ rateCents: 20000, source: 'client default rate' });
  });

  it('resolves billing code member rate', () => {
    expect(resolveRateFromRatesTable({
      userId: 'user-1',
      billingCodeId: 'code-1',
      rates,
    })).toEqual({ rateCents: 18000, source: 'charge code member rate' });
  });

  it('resolves billing code default rate', () => {
    expect(resolveRateFromRatesTable({
      userId: 'user-2',
      billingCodeId: 'code-1',
      rates,
    })).toEqual({ rateCents: 15000, source: 'charge code default' });
  });

  it('resolves user default rate', () => {
    expect(resolveRateFromRatesTable({
      userId: 'user-1',
      rates,
    })).toEqual({ rateCents: 12000, source: 'user default rate' });
  });

  it('resolves firm default rate as fallback', () => {
    expect(resolveRateFromRatesTable({
      userId: 'user-3',
      rates,
    })).toEqual({ rateCents: 10000, source: 'firm default rate' });
  });

  it('returns none and 0 cents when no rate matches', () => {
    expect(resolveRateFromRatesTable({
      userId: 'user-3',
      rates: [],
    })).toEqual({ rateCents: 0, source: 'none' });
  });
});
