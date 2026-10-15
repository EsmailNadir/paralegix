/**
 * GET /api/lawfirms/:lawFirmId/dashboard-summary: how many pool connections one
 * request holds at once.
 *
 * Every request on an instance shares one small pool (12 connections against a
 * Supabase session pooler that allows 15). The dashboard runs its sections in
 * parallel, so without a per-request cap a single dashboard load could take most
 * of the pool and leave other users' requests waiting behind it. This pins the
 * cap: the heaviest section (4 connections) plus the owner/admin probe (1).
 *
 * The peak is read from the app's own pool `acquire`/`release` events, so it
 * counts every checkout the request makes, including the auth and permission
 * middleware.
 */
import { createFirm, drainEvents, ownerOf, type Actor, type Firm } from '../support/setupInProcess';

// Loaded after the harness, which points DATABASE_URL at this worker's test
// database: `db.ts` reads the URL when it is first imported.
const { pool } = require('../../src/shared/database/db');

/** The heaviest dashboard section's weight plus the owner/admin probe. */
const MAX_CONNECTIONS_PER_DASHBOARD = 5;

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

async function peakConnectionsDuring(work: () => Promise<unknown>) {
  let active = 0;
  let peak = 0;
  const onAcquire = () => { active += 1; peak = Math.max(peak, active); };
  const onRelease = () => { active -= 1; };
  pool.on('acquire', onAcquire);
  pool.on('release', onRelease);
  try {
    const result = await work();
    return { result, peak };
  } finally {
    pool.off('acquire', onAcquire);
    pool.off('release', onRelease);
  }
}

describe('dashboard-summary connection use', () => {
  it('holds no more than the per-request cap at once, and still loads every section', async () => {
    const { result, peak } = await peakConnectionsDuring(() => owner.api
      .get(`/api/lawfirms/${firm.id}/dashboard-summary`)
      .set('x-timezone', 'America/New_York'));
    const res = result as any;

    expect(res.status).toBe(200);
    expect(res.body.sectionErrors).toEqual({});
    expect(res.body.permissions.billing).toBe(true);
    // Proves the listener sees the sections' parallel queries, so a peak within
    // the cap below is a real measurement rather than a detached pool.
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(MAX_CONNECTIONS_PER_DASHBOARD);
  });
});
