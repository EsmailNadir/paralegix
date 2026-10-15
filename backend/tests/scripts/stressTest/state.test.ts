import { assertStateMatchesTarget, type StressState } from '../../../scripts/stress-test/state';

const state = (dbTarget: string): StressState => ({ runId: 'r1', dbTarget, lawFirmId: 'f1', users: [{ uid: 'u1', email: 'a@stress.paralegix.test' }] });

describe('assertStateMatchesTarget', () => {
  it('refuses staging users against a local API, and local users against staging', () => {
    expect(() => assertStateMatchesTarget(state('staging'), 'http://localhost:5001')).toThrow(/created against the staging database/);
    expect(() => assertStateMatchesTarget(state('local'), 'https://api-staging.paralegix.com')).toThrow(/created against the local database/);
  });

  it('accepts a matching pair', () => {
    expect(() => assertStateMatchesTarget(state('staging'), 'https://api-staging.paralegix.com')).not.toThrow();
    expect(() => assertStateMatchesTarget(state('local'), 'http://127.0.0.1:5001')).not.toThrow();
  });
});
