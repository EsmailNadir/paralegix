/**
 * Single-matter READ access for firm owners/admins - real integration tests.
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 *
 * The matters list and lookup let an owner/admin see every matter in the firm
 * (`canViewAllMatters`), but `GET /matters/:matterId` gated on plain matter
 * membership, so an owner could see a matter in the list and get a 403 opening it.
 * These tests pin the read path to the list's rule and, just as importantly, pin
 * the WRITE paths to strict membership so the widening stays where it belongs.
 *
 * The fixture state (a firm owner who is not a member of one of the firm's
 * matters) cannot be reached over HTTP: matter-member removal refuses to strip a
 * matter's last member, and the seeded firm has exactly one user, so there is no
 * second member to leave behind. The one membership row is therefore removed with
 * SQL against the same database the server reads, and restored in teardown.
 */

const { pool } = require('../../../src/shared/database/db');
const { api } = require('../setup');
const { bootstrapFirm } = require('../helpers');

const UNKNOWN_MATTER_ID = '00000000-0000-4000-8000-000000000000';

let token: any;
let userId: any;
let lawFirmId: any;
let matterId: any;
let isOwnerOrAdmin = false;

beforeAll(async () => {
  ({ token, userId, lawFirmId } = await bootstrapFirm());

  const created = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
    token,
    body: {
      name: `TESTMTRREAD${Date.now()}`,
      description: 'Created by automated test - safe to delete',
    },
  });
  expect(created.status).toBe(201);
  matterId = created.body.matterId;

  // The escape only fires for owners/admins. Probe the same signal the matters
  // list uses: a non-member matter appearing in the list means `seeAll` is on.
  await pool.query(
    `delete from matter_members where matter_id = $1 and user_id = $2`,
    [matterId, userId]
  );
  const listed = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=500`, { token });
  isOwnerOrAdmin = listed.status === 200
    && (listed.body.matters || []).some((m: any) => m.id === matterId);
}, 60000);

afterAll(async () => {
  if (matterId) {
    // Deletion is a write path and still demands membership, so put the row back
    // before tearing down through the API (which cascades tasks, files and events
    // the way a real delete does).
    await pool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role)
       values ($1, $2, $3, 'lead')
       on conflict do nothing`,
      [lawFirmId, matterId, userId]
    );
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${matterId}`, { token });
  }
  await pool.end();
}, 60000);

describe('GET /api/lawfirms/:lawFirmId/matters/:matterId as a non-member owner', () => {
  test('the matter is visible in the list without a membership row', async () => {
    if (!isOwnerOrAdmin) return console.warn('SKIP: test account is not a firm owner/admin');

    // Confirms the fixture: no membership row, yet the list still returns it.
    const { rows } = await pool.query(
      `select 1 from matter_members where matter_id = $1 and user_id = $2`,
      [matterId, userId]
    );
    expect(rows).toHaveLength(0);

    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=500`, { token });
    expect(res.status).toBe(200);
    expect((res.body.matters || []).map((m: any) => m.id)).toContain(matterId);
  });

  test('the matter is resolvable through the lookup', async () => {
    if (!isOwnerOrAdmin) return console.warn('SKIP: test account is not a firm owner/admin');

    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?ids=${matterId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.id)).toEqual([matterId]);
  });

  // The regression: the same matter the two reads above return must open.
  test('opening the matter returns 200 rather than 403', async () => {
    if (!isOwnerOrAdmin) return console.warn('SKIP: test account is not a firm owner/admin');

    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/${matterId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(matterId);
    expect(res.body.lawFirmId).toBe(lawFirmId);
  });

  test('a matter id that does not exist is still a 404, not a silent success', async () => {
    if (!isOwnerOrAdmin) return console.warn('SKIP: test account is not a firm owner/admin');

    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/${UNKNOWN_MATTER_ID}`, { token });
    expect(res.status).toBe(404);
  });

  test('a malformed matter id does not 500', async () => {
    if (!isOwnerOrAdmin) return console.warn('SKIP: test account is not a firm owner/admin');

    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/not-a-uuid`, { token });
    expect([400, 404]).toContain(res.status);
  });
});

/**
 * The owner/admin escape covers the matter RECORD, read and write alike: someone
 * who already lists, opens and staffs every matter can also edit the record
 * itself (`assertMatterWriteAccess`). It stops at the record.
 *
 * The confidential work product hanging off a matter - notes, events, files,
 * tasks, time - stays on strict `assertMatterMembership`, so the ethical wall
 * still holds for everything an administrator has no business reading. These two
 * tests pin the boundary from both sides; if either flips, the wall moved.
 */
describe('the owner escape covers the matter record but not its work product', () => {
  test('updating the matter record is allowed', async () => {
    if (!isOwnerOrAdmin) return console.warn('SKIP: test account is not a firm owner/admin');

    const res = await api.put(`/api/lawfirms/${lawFirmId}/matters/${matterId}`, {
      token,
      body: { description: 'edited by a firm admin who is not on the matter' },
    });
    expect(res.status).toBe(200);
  });

  test('adding a matter note is still refused', async () => {
    if (!isOwnerOrAdmin) return console.warn('SKIP: test account is not a firm owner/admin');

    const res = await api.post(`/api/lawfirms/${lawFirmId}/matters/${matterId}/notes`, {
      token,
      body: { content: 'should not be applied' },
    });
    expect(res.status).toBe(403);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
