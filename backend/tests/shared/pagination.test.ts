/**
 * Paging window bounds - pure unit tests, no database.
 *
 * A deep offset is not free. Postgres still produces and discards every row
 * ahead of the window, and an offset past the end returns an empty page, which
 * is exactly the case `resolveWindowTotal` answers with a second `count(*)`
 * query. So an unbounded `?page=` turned one cheap request into two full scans
 * of the filtered set, and the server-paged grids made that reachable from every
 * list endpoint at once.
 *
 * The bound has to leave real paging alone: a firm with a lot of matters, time
 * entries or trust transactions must still be able to reach its last page. These
 * tests pin both halves - that nonsense values are cut off, and that the depths
 * a real user can actually reach through the UI are untouched.
 *
 * `resolvePage` is where both the SQL reads (via `buildPageClause`) and the
 * in-memory billing windows resolve their window, so clamping there covers a
 * caller that assembles its own params and never sees the route schema.
 *
 *   __TEST_TOKEN__=offline npx jest tests/shared/pagination.test.js
 */

const { z } = require('zod');
const { MAX_PAGE_OFFSET, resolvePage, buildPageClause } = require('../../src/shared/database/pagination');
const { paging, pageParam, offsetParam, MAX_PAGE_NUMBER } = require('../../src/shared/validation/listQuery');

describe('resolvePage window bounds', () => {
  test('clamps an absurd page number to the ceiling', () => {
    expect(resolvePage({ limit: 200, page: 10_000_000 }).offset).toBe(MAX_PAGE_OFFSET);
  });

  test('clamps an absurd raw offset to the ceiling', () => {
    expect(resolvePage({ limit: 50, offset: 9e15 }).offset).toBe(MAX_PAGE_OFFSET);
  });

  test('the ceiling itself is honoured exactly, not rounded down', () => {
    expect(resolvePage({ limit: 50, offset: MAX_PAGE_OFFSET }).offset).toBe(MAX_PAGE_OFFSET);
  });

  // The point of the bound is that nobody paging a real list ever meets it.
  test.each([
    ['first page', { limit: 25, page: 1 }, 0],
    ['a middle page', { limit: 25, page: 3 }, 50],
    ['page 500 at the largest page size', { limit: 200, page: 500 }, 99_800],
    ['page 5,000 at the default UI page size', { limit: 10, page: 5000 }, 49_990],
    ['a raw offset well inside the ceiling', { limit: 50, offset: 250_000 }, 250_000],
  ])('leaves %s untouched', (_label, args, expected) => {
    expect(resolvePage(args).offset).toBe(expected);
  });

  test('offset still wins over page, and the page size is still clamped', () => {
    const { limit, offset } = resolvePage({ limit: 5000, offset: 40, page: 9, max: 200 });
    expect(offset).toBe(40);
    expect(limit).toBe(200);
  });

  test('buildPageClause carries the clamped offset into the SQL params', () => {
    const params = ['firm-id'];
    const { pageClause, pageOffset } = buildPageClause({ limit: 200, page: 10_000_000, params });
    expect(pageOffset).toBe(MAX_PAGE_OFFSET);
    expect(params[params.length - 1]).toBe(MAX_PAGE_OFFSET);
    expect(pageClause).toBe(' limit $2 offset $3');
  });

  test('the unpaginated contract is unaffected: no limit means no clause', () => {
    const params = ['firm-id'];
    expect(buildPageClause({ limit: null, params, optional: true })).toEqual({
      pageClause: '', pageOffset: 0,
    });
    expect(params).toEqual(['firm-id']);
  });
});

describe('list query schema bounds', () => {
  const schema = z.object(paging({ max: 200 }));

  test('accepts an ordinary query', () => {
    expect(schema.safeParse({ page: '3', limit: '25' }).success).toBe(true);
  });

  test('accepts a genuinely deep page a large firm could reach', () => {
    expect(schema.safeParse({ page: '40000', limit: '10' }).success).toBe(true);
  });

  test.each([
    ['page', { page: String(MAX_PAGE_NUMBER + 1) }],
    ['offset', { offset: String(MAX_PAGE_OFFSET + 1) }],
  ])('rejects an out-of-range %s with a 400 rather than clamping silently', (_label, query) => {
    expect(schema.safeParse(query).success).toBe(false);
  });

  test('the boundary values themselves are still valid', () => {
    expect(schema.safeParse({ page: String(MAX_PAGE_NUMBER) }).success).toBe(true);
    expect(schema.safeParse({ offset: String(MAX_PAGE_OFFSET) }).success).toBe(true);
  });

  // The modules that spell their paging params out inline rather than spreading
  // `paging()` import these directly, so they must carry the bound themselves.
  test('the exported params are bounded on their own', () => {
    expect(pageParam.safeParse(MAX_PAGE_NUMBER + 1).success).toBe(false);
    expect(offsetParam.safeParse(MAX_PAGE_OFFSET + 1).success).toBe(false);
    expect(pageParam.safeParse(undefined).success).toBe(true);
    expect(offsetParam.safeParse(undefined).success).toBe(true);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
