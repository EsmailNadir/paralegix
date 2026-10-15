import { isDraftLineId, lineSourceId } from '@/lib/billing/lineSource';

describe('lineSourceId', () => {
  it('keeps the id of a saved activity', () => {
    expect(lineSourceId('7c1d3a52-1c63-4a53-9b66-1f0f5d3a8e11')).toEqual({ id: '7c1d3a52-1c63-4a53-9b66-1f0f5d3a8e11' });
  });

  it.each(['manual-te-1700000000000', 'flat-fee-1700000000000'])('omits the composer-local id %s', (id) => {
    expect(lineSourceId(id)).toEqual({});
    expect('id' in lineSourceId(id)).toBe(false);
  });

  it.each([undefined, null, ''])('omits an absent id (%p)', (id) => {
    expect(lineSourceId(id)).toEqual({});
  });
});

describe('isDraftLineId', () => {
  it('recognises only the prefixes the composers mint', () => {
    expect(isDraftLineId('manual-te-5')).toBe(true);
    expect(isDraftLineId('flat-fee-5')).toBe(true);
    expect(isDraftLineId('plan-abc-2026-03-01')).toBe(false);
    expect(isDraftLineId('ff-1')).toBe(false);
    expect(isDraftLineId(null)).toBe(false);
  });
});
