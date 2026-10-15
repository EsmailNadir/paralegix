const { toIlikeTerm } = require('../../src/shared/database/searchTerm');

describe('toIlikeTerm', () => {
  it('wraps a plain term in wildcards', () => {
    expect(toIlikeTerm('smith')).toBe('%smith%');
  });

  it('trims surrounding whitespace', () => {
    expect(toIlikeTerm('  smith  ')).toBe('%smith%');
  });

  it('escapes LIKE wildcards so they match literally', () => {
    expect(toIlikeTerm('50%')).toBe('%50\\%%');
    expect(toIlikeTerm('a_b')).toBe('%a\\_b%');
    expect(toIlikeTerm('back\\slash')).toBe('%back\\\\slash%');
  });

  it('returns null for empty or non-string input', () => {
    expect(toIlikeTerm('')).toBeNull();
    expect(toIlikeTerm('   ')).toBeNull();
    expect(toIlikeTerm(undefined)).toBeNull();
    expect(toIlikeTerm(null)).toBeNull();
    expect(toIlikeTerm(42)).toBeNull();
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
