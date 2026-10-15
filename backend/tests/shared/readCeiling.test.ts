/**
 * The ceiling on an unpaged list read.
 *
 * The rule that matters is what happens AT the boundary. A ceiling implemented
 * as a plain `limit` would return a short array and every caller would read it
 * as the complete answer: an expense total missing its oldest entries, a
 * calendar missing a month, a dependency graph reporting a blocked deadline as
 * unblocked. None of those look wrong on screen, which is why this refuses
 * instead of truncating.
 */
import {
  READ_CEILING,
  ceilingLimit,
  withinCeiling,
  ReadCeilingExceededError,
} from '../../src/shared/database/readCeiling';

const rows = (n: number) => Array.from({ length: n }, (_, i) => i);

it('asks the database for one row past the ceiling', () => {
  // Without the extra row a full page and an overflowing one are identical,
  // so the read could not tell a complete answer from a truncated one.
  expect(ceilingLimit(10)).toBe(11);
  expect(ceilingLimit()).toBe(READ_CEILING + 1);
});

it('passes a read that stays inside the ceiling through untouched', () => {
  const input = rows(10);

  expect(withinCeiling(input, 'events', 10)).toBe(input);
});

it('accepts exactly the ceiling', () => {
  // The ceiling is the largest allowed answer, not the first refused one.
  expect(withinCeiling(rows(10), 'events', 10)).toHaveLength(10);
});

it('refuses rather than returning a short array', () => {
  // The whole point. Returning `rows(10)` here would be a wrong answer that
  // no caller can detect.
  expect(() => withinCeiling(rows(11), 'events', 10)).toThrow(ReadCeilingExceededError);
});

it('answers 400 and names what would not fit', () => {
  try {
    withinCeiling(rows(11), 'matter events', 10);
    throw new Error('expected a refusal');
  } catch (err: any) {
    // A 500 would read as a broken server. Nothing is broken: the request asked
    // for more than one answer holds, and the caller can narrow it.
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('READ_CEILING_EXCEEDED');
    expect(err.message).toContain('matter events');
    expect(err.message).toContain('10');
  }
});

it('has a real default ceiling', () => {
  expect(Number.isFinite(READ_CEILING)).toBe(true);
  expect(READ_CEILING).toBeGreaterThan(0);
});
