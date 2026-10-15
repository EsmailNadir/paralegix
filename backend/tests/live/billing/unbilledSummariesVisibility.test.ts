/**
 * Firm-wide unbilled summaries visibility for owners/admins - real integration tests.
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 *
 * The bulk-invoicing screen builds its context list owner/admin-aware, but each
 * context used to be re-authorized by strict matter membership. A firm owner who is
 * not on a matter therefore saw that matter everywhere else and not here, so the
 * screen under-reported what the firm could bill.
 *
 * The fixture state (a firm owner with no membership row on one of the firm's
 * matters) cannot be reached over HTTP: matter-member removal refuses to strip a
 * matter's last member, and the seeded firm has one user. The row is removed with
 * SQL against the same database the server reads, and restored in teardown.
 */

const { pool } = require('../../../src/shared/database/db');
const { api } = require('../setup');
const { bootstrapFirm } = require('../helpers');

// A value that survives the summary's rounding exactly, so the assertion pins the
// matter's own hours rather than a rounding artifact.
const HOURS = 3.5;

let token: any;
let userId: any;
let lawFirmId: any;
let matterId: any;
let timeEntryId: any;
let isOwnerOrAdmin = false;

beforeAll(async () => {
  ({ token, userId, lawFirmId } = await bootstrapFirm());

  const created = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
    token,
    body: {
      name: `TESTUNBILLED${Date.now()}`,
      description: 'Created by automated test - safe to delete',
    },
  });
  expect(created.status).toBe(201);
  matterId = created.body.matterId;

  // Log the unbilled work while still a matter member: time entry creation is a
  // write and keeps requiring membership.
  const entry = await api.post(`/api/lawfirms/${lawFirmId}/billing/time-entries`, {
    token,
    body: {
      matterId,
      userId,
      hours: HOURS,
      date: new Date().toISOString(),
      name: 'TESTUNBILLED entry',
      description: 'Created by automated test - safe to delete',
    },
  });
  expect(entry.status).toBe(201);
  timeEntryId = entry.body.timeEntryId || entry.body.timeEntry?.id;

  await pool.query(
    `delete from matter_members where matter_id = $1 and user_id = $2`,
    [matterId, userId]
  );

  // The widening only fires for owners/admins. Probe the same signal the matters
  // list uses: a non-member matter appearing in the list means `seeAll` is on.
  const listed = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=500`, { token });
  isOwnerOrAdmin = listed.status === 200
    && (listed.body.matters || []).some((m: any) => m.id === matterId);
}, 60000);

afterAll(async () => {
  if (matterId) {
    // Teardown runs through the API so the delete cascades the way a real one
    // does, and that is a write path, so put the membership row back first.
    await pool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role)
       values ($1, $2, $3, 'lead')
       on conflict do nothing`,
      [lawFirmId, matterId, userId]
    );
    if (timeEntryId) {
      await api.delete(
        `/api/lawfirms/${lawFirmId}/billing/time-entries/matter/${matterId}/${timeEntryId}`,
        { token },
      );
    }
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${matterId}`, { token });
  }
  await pool.end();
}, 60000);

describe('GET /billing/invoices/firm/unbilled-summaries as a non-member owner', () => {
  test('the matter has no membership row for the acting user', async () => {
    if (!isOwnerOrAdmin) return console.warn('SKIP: test account is not a firm owner/admin');

    const { rows } = await pool.query(
      `select 1 from matter_members where matter_id = $1 and user_id = $2`,
      [matterId, userId]
    );
    expect(rows).toHaveLength(0);
  });

  // The regression: the owner's bulk-invoicing screen must report this matter's
  // unbilled work rather than silently dropping it from the firm total.
  test('the matter appears with its unbilled hours', async () => {
    if (!isOwnerOrAdmin) return console.warn('SKIP: test account is not a firm owner/admin');

    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/billing/invoices/firm/unbilled-summaries`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.summaries)).toBe(true);
    expect(res.body.totalItems).toBe(res.body.summaries.length);

    const row = res.body.summaries.find((s: any) => s.type === 'matter' && s.entityId === matterId);
    expect(row).toBeDefined();
    expect(row.unbilledHours).toBeCloseTo(HOURS, 2);
  });

  test('a firm-wide read still cannot reach another tenant\'s work', async () => {
    if (!isOwnerOrAdmin) return console.warn('SKIP: test account is not a firm owner/admin');

    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/billing/invoices/firm/unbilled-summaries`,
      { token },
    );
    expect(res.status).toBe(200);

    // Every returned matter context must belong to this firm.
    const matterIds = res.body.summaries.filter((s: any) => s.type === 'matter').map((s: any) => s.entityId);
    if (matterIds.length) {
      const { rows } = await pool.query(
        `select id from matters where law_firm_id = $1 and id = any($2::uuid[])`,
        [lawFirmId, matterIds]
      );
      expect(rows).toHaveLength(matterIds.length);
    }
  });
});

/**
 * `authorizeContext` splits a matter billing context by mode: a READ follows the
 * matter's read rule, so an owner or admin sees the billing records of any matter
 * in the firm, while a WRITE still requires real matter membership. The default
 * is the stricter gate, so a caller that says nothing gets write rules.
 *
 * The per-matter summary is a read, and reaches the same data the firm-wide
 * report above already shows that audience.
 */
describe('a matter billing context reads firm-wide for an owner', () => {
  test('the single-matter unbilled summary is allowed', async () => {
    if (!isOwnerOrAdmin) return console.warn('SKIP: test account is not a firm owner/admin');

    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/billing/invoices/matter/${matterId}/unbilled-summary`,
      { token },
    );
    expect(res.status).toBe(200);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
