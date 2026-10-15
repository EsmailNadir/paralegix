/**
 * Tenant boundary - real integration tests.
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.ts).
 *
 * Two properties, both structural rather than per-route:
 *
 * 1. No firm-scoped read answers an unauthenticated caller. Every one of these
 *    is one forgotten `verifyToken` away from being public.
 *
 * 2. A signed-in member of firm A gets 403 on firm B, and specifically a 403
 *    rather than a 402. Two gates run ahead of every module router and both can
 *    answer with something private: `requireActiveBilling` returns 402
 *    BILLING_INACTIVE naming the firm's subscription state, and `requireFeature`
 *    returns 402 or a feature 403 naming which features its plan includes. Both
 *    deliberately fall through for a non-member so neither becomes an oracle for
 *    whether a firm exists, whether it is paying, and what tier it is on.
 *    Nothing pinned that, and the failure is silent: a 402 body is still a
 *    refusal, so it reads as working.
 *
 * The feature-gated surfaces are listed separately below, because they are the
 * ones where the second gate is what has to fall through. Both lists get the
 * same assertions.
 */

const { pool } = require('../../../src/shared/database/db');
const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

/** Firm-scoped reads, relative to `/api/lawfirms/:lawFirmId`. */
const PLAIN_FIRM_READS = [
  '/matters',
  '/tasks',
  '/clients',
  '/contacts',
  '/files',
  '/courts',
  '/practice-areas',
  '/members',
  '/roles',
  '/notifications',
  '/document-requests',
  '/billing/invoices/firm',
  '/billing/time-entries/firm',
  '/billing/charge-codes',
  '/calendar-events',
];

/**
 * The same, for mounts that also carry a `requireFeature` gate. One entry per
 * distinct feature flag, since the gate is per-flag and it is the gate, not the
 * router, being asserted.
 */
const FEATURE_GATED_FIRM_READS = [
  '/trust/accounts',          // trustAccounting
  '/templates',               // templates
  '/signature-links/sessions', // documentSigning
  '/signing-templates',       // documentSigning
  '/messaging/conversations', // messaging
  // flatFees has no collection route of its own, only per-matter and per-client
  // ones. The id need not exist: `requirePermission` runs ahead of `validate`,
  // so the membership answer never depends on the row.
  '/billing/flat-fees/matter/00000000-0000-4000-8000-000000000000', // flatFees
  '/billing/analytics/billing-summary', // analytics
  '/file-share-links',        // fileSharing
];

const FIRM_READS = [...PLAIN_FIRM_READS, ...FEATURE_GATED_FIRM_READS];

/** Unscoped reads that must still refuse an anonymous caller. */
const GLOBAL_READS = [
  '/api/users/profile',
  '/api/users/my-lawfirms',
  '/api/settings/user',
  '/api/auth/user-type',
  '/api/admin/lawfirms',
  '/api/google-calendar-sync/check-auth',
];

let token: any;
let userId: any;
let lawFirmId: any;
// A real firm this account has no `members` row in. Null when the database has
// no such firm, in which case the cross-tenant cases skip rather than assert
// against a firm id that does not exist (which proves nothing about membership).
let foreignFirmId: any = null;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  userId = auth.userId;
  lawFirmId = await getPrimaryLawFirmId(token);

  const { rows } = await pool.query(
    `select id from law_firms
      where id not in (select law_firm_id from members where user_id = $1)
      limit 1`,
    [userId],
  );
  foreignFirmId = rows[0]?.id || null;
}, 60000);

afterAll(async () => {
  await pool.end().catch(() => {});
});

describe('unauthenticated callers are refused', () => {
  test.each(GLOBAL_READS)('%s answers 401', async (path) => {
    const res = await api.get(path);
    expect({ path, status: res.status }).toEqual({ path, status: 401 });
  });

  test.each(FIRM_READS)('/api/lawfirms/:lawFirmId%s answers 401', async (suffix) => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}${suffix}`);
    expect({ suffix, status: res.status }).toEqual({ suffix, status: 401 });
  });
});

describe('a member of one firm cannot read another', () => {
  test('the fixture firm exists and the acting user is genuinely not a member', async () => {
    // Guards every case below from passing for the wrong reason.
    if (!foreignFirmId) return console.warn('SKIP: no second firm in this database');

    expect(foreignFirmId).not.toBe(lawFirmId);
    const { rows } = await pool.query(
      `select 1 from members where law_firm_id = $1 and user_id = $2`,
      [foreignFirmId, userId],
    );
    expect(rows).toHaveLength(0);
  });

  test.each(FIRM_READS)('%s answers 403, never data', async (suffix) => {
    if (!foreignFirmId) return console.warn('SKIP: no second firm in this database');

    const res = await api.get(`/api/lawfirms/${foreignFirmId}${suffix}`, { token });

    // 402 would mean the billing gate answered ahead of the membership check and
    // told a stranger this firm's subscription state; 200 would mean the tenant
    // boundary is gone entirely.
    expect({ suffix, status: res.status }).toEqual({ suffix, status: 403 });
    for (const key of ['matters', 'tasks', 'clients', 'invoices', 'timeEntries', 'items', 'events']) {
      expect({ suffix, key, leaked: key in (res.body || {}) })
        .toEqual({ suffix, key, leaked: false });
    }
  });

  test('the same reads DO succeed against the firm the user belongs to', async () => {
    // The control: the 403s above are the membership check firing, not every
    // request under this mount failing for an unrelated reason.
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters`, { token });
    expect(res.status).toBe(200);
  });

  test('a firm id that matches no firm is refused the same way', async () => {
    // A stranger must not be able to tell a real firm from an imaginary one by
    // the status code it answers with.
    const res = await api.get('/api/lawfirms/00000000-0000-4000-8000-000000000000/matters', { token });
    expect(res.status).toBe(403);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
