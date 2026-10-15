import { assertSafeTarget, parseArgs } from '../../../scripts/stress-test/config';

describe('assertSafeTarget', () => {
  it('refuses the production API', () => {
    expect(() => assertSafeTarget('https://api.paralegix.com')).toThrow(/Refusing to stress api\.paralegix\.com/);
  });

  it('refuses a raw Cloud Run host, which could be any environment', () => {
    expect(() => assertSafeTarget('https://paralegix-api-abc123-uk.a.run.app')).toThrow(/Refusing/);
  });

  it('refuses staging over plain http', () => {
    expect(() => assertSafeTarget('http://api-staging.paralegix.com')).toThrow(/https/);
  });

  it('accepts staging over https and returns the bare origin', () => {
    expect(assertSafeTarget('https://api-staging.paralegix.com/api/')).toBe('https://api-staging.paralegix.com');
  });

  it('accepts a local backend over http', () => {
    expect(assertSafeTarget('http://localhost:5001')).toBe('http://localhost:5001');
  });
});

describe('parseArgs', () => {
  it('defaults to ten realistic users on staging for five minutes', () => {
    expect(parseArgs([], {})).toEqual({
      target: 'https://api-staging.paralegix.com',
      users: 10,
      durationSec: 300,
      profile: 'realistic',
      burstRounds: 3,
    });
  });

  it('reads every flag', () => {
    const argv = ['--target', 'http://localhost:5001', '--users', '2', '--duration', '30', '--profile', 'docs-burst', '--rounds', '5'];
    expect(parseArgs(argv, {})).toEqual({
      target: 'http://localhost:5001',
      users: 2,
      durationSec: 30,
      profile: 'docs-burst',
      burstRounds: 5,
    });
  });

  it('applies the production guard to STRESS_TARGET too', () => {
    expect(() => parseArgs([], { STRESS_TARGET: 'https://api.paralegix.com' })).toThrow(/Refusing/);
  });

  it('rejects an out-of-range user count and an unknown profile', () => {
    expect(() => parseArgs(['--users', '0'], {})).toThrow(/--users must be an integer from 1 to 50/);
    expect(() => parseArgs(['--profile', 'chaos'], {})).toThrow(/Unknown --profile chaos/);
  });
});
